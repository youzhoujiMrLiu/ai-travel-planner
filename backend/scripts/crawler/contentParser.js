/**
 * HTML 内容解析器
 * 将 Wikivoyage 返回的 HTML 解析为结构化知识片段
 */

const cheerio = require('cheerio');
const { SECTION_TYPES, SECTION_TYPES_EN, MAX_CHUNK_LENGTH, CHUNK_OVERLAP } = require('./config');

// ─── 工具函数 ────────────────────────────────────────────────────────────────

/**
 * 从 heading 元素提取标题文本，兼容新旧两种 MediaWiki HTML 格式：
 *   旧版：<h2><span class="mw-headline">标题</span></h2>
 *   新版：<div class="mw-heading mw-heading2"><h2>标题</h2>...</div>
 */
function getHeadingText($el) {
  const headline = $el.find('.mw-headline');
  if (headline.length) return headline.text().trim();
  return $el.clone().find('.mw-editsection, [class*="editsection"]').remove().end().text().trim();
}

/** 判断元素是否是 h2 级别章节起点（兼容两种 MW 格式） */
function isH2Boundary(el, $) {
  const tag = $(el).prop('tagName')?.toLowerCase();
  if (tag === 'h2') return true;
  if (tag === 'div' && (($(el).attr('class') || '').includes('mw-heading2'))) return true;
  return false;
}

/** 判断元素是否是 h3 级别章节起点（兼容两种 MW 格式） */
function isH3Boundary(el, $) {
  const tag = $(el).prop('tagName')?.toLowerCase();
  if (tag === 'h3') return true;
  if (tag === 'div' && (($(el).attr('class') || '').includes('mw-heading3'))) return true;
  return false;
}

/**
 * 清理 HTML，提取纯文本
 * - 移除编辑按钮、引用标注、图例等
 */
function htmlToText(html) {
  if (!html) return '';
  const $ = cheerio.load(html);

  // 移除不需要的元素
  $('sup, .mw-editsection, .noprint, .reference, .thumb, .gallery, figure, style, script').remove();
  $('[class*="edit"]').remove();

  const text = $.root().text()
    .replace(/\[\d+\]/g, '')   // 删除引用标注 [1][2]
    .replace(/\[编辑\]/g, '')
    // 清除 MediaWiki 内联 CSS 规则块（如 .mw-parser-output .xyz{...})
    .replace(/\.mw-parser-output[\s\S]*?(?=\s{2,}|$(?!\n))/gm, '')
    .replace(/(?:\.[\w-]+(?:\s+\.[\w-]+)*)\s*\{[^}]{0,400}\}/g, '')
    // 策略B：去除 Wikivoyage 常见渲染噪声
    .replace(/电话号码格式无效/g, '')   // listing 电话渲染失败残留
    .replace(/主条目：/g, '')            // {{main}} 模板残留，去掉前缀保留正文
    .replace(/\(\)\s*/g, '')            // listing 序号括号 ()
    // 移除孤立 Unicode 代理字符（U+D800–U+DFFF），这类字符是无效的 UTF-16 半对
    // 常见于 emoji 或特殊符号经错误编码后残留，JSON 序列化会报错
    .replace(/[\uD800-\uDFFF]/g, '')
    .replace(/\s+/g, ' ')      // 合并连续空白
    .trim();

  return text;
}

/**
 * 从 HTML 中提取列表项（li 标签内容）
 */
function extractListItems($, container) {
  const items = [];
  container.find('li').each((_, el) => {
    const text = $(el).text()
      .replace(/\[\d+\]/g, '')
      .replace(/\s+/g, ' ')
      .trim();
    if (text.length > 5) items.push(text);
  });
  return items;
}

/**
 * 提取 Wikivoyage 结构化 listing/vcard 条目，每条 POI 单独成 chunk。
 *
 * RAG 适配说明：POI 粒度比章节更细，当用户询问"北京故宫怎么样"时，
 * 能精确召回该条目而非整个景点章节，减少 LLM 噪声并提升答案准确性。
 *
 * @param {CheerioAPI} $s - 加载了章节 HTML 的 cheerio 实例
 */
function extractVcardPOIs($s, city, type, sectionTitle) {
  const richChunks = []; // 有描述的 POI，单独成块
  const stubLines  = []; // 无描述的存根 POI，合并成列表块

  // Wikivoyage listing 模板在解析后的 HTML 中携带 itemprop 或 class="listing"/"vcard"
  $s('.vcard, .listing').each((_, el) => {
    const name = $s(el)
      .find('.name, dfn, .fn, [itemprop="name"]')
      .first()
      .text()
      .replace(/\s+/g, ' ')
      .trim();
    if (!name || name.length < 2) return;

    const address = $s(el).find('.adr, [itemprop="address"]').text().replace(/\s+/g, ' ').trim();
    const hours   = $s(el).find('.hours, [itemprop="openingHours"]').text().replace(/\s+/g, ' ').trim();
    const price   = $s(el).find('.price, [itemprop="priceRange"]').text().replace(/\s+/g, ' ').trim();
    const desc    = $s(el).find('.description, p').first()
      .text().replace(/\[\d+\]/g, '').replace(/\s+/g, ' ').trim().slice(0, 400);

    // 拼接成自包含的自然语言段落，便于向量化后语义检索
    const parts = [`${city}${typeLabel(type)}：${name}`];
    if (address) parts.push(`地址：${address}`);
    if (hours)   parts.push(`开放时间：${hours}`);
    if (price)   parts.push(`票价/费用：${price}`);
    if (desc)    parts.push(`简介：${desc}`);

    const content = parts.join('。');
    if (content.length < 20) return;

    if (desc) {
      // 有描述 → 单独成块，语义足够独立
      richChunks.push(...splitByLength({
        city,
        type,
        title: `${city} ${name}`,
        content,
        tags: [city, name, sectionTitle, typeLabel(type)].filter(Boolean),
        sectionTitle,
        poiName: name,
      }));
    } else {
      // 无描述（存根：仅名称+地址）→ 先放入收集列表，最后合并成一个列表块
      // 这样即使 h2 整体块被 Strategy A 剪掉，这些 POI 名称也不会丢失
      stubLines.push(content);
    }
  });

  // 把同一 section 下的存根 POI 合并成一个列表块，避免大量过短 chunk 被 filter 丢弃
  if (stubLines.length > 0) {
    const prefix = buildTypePrefix(city, type, sectionTitle);
    const merged = `${prefix}（列表）：` + stubLines.join('；');
    richChunks.push(...splitByLength({
      city,
      type,
      title: `${city} - ${sectionTitle}（列表）`,
      content: merged,
      tags: [city, sectionTitle, typeLabel(type)].filter(Boolean),
      sectionTitle,
    }));
  }

  return richChunks;
}

/**
 * 提取 h3 子章节，携带父 h2 章节的上下文前缀。
 *
 * RAG 适配说明：Wikivoyage 的 h3 常用于细分景区/菜系/商圈，
 * 单独成 chunk 后，检索粒度从"整个饮食章节" → "某菜系/某商圈"，
 * 召回结果更聚焦，LLM 答案更精确。
 */
function extractH3Sections($, h2El, city, type, h2Title) {
  const chunks = [];
  const $h2 = $(h2El);
  let currentEl = $h2.next();

  while (currentEl.length) {
    if (isH2Boundary(currentEl[0], $)) break;

    if (isH3Boundary(currentEl[0], $)) {
      const $cur = currentEl;
      const innerH3 = $cur.is('div') ? $cur.find('h3') : $cur;
      const h3Title = getHeadingText(innerH3.length ? innerH3 : $cur);
      if (!h3Title) { currentEl = currentEl.next(); continue; }

      // 收集 h3 内容，直到下一个 h2 或 h3
      let h3Html = '';
      let next = currentEl.next();
      while (next.length && !isH2Boundary(next[0], $) && !isH3Boundary(next[0], $)) {
        h3Html += $.html(next);
        next = next.next();
      }

      const rawText = htmlToText(h3Html);
      if (rawText.length >= 40) {
        // 前缀同时含 h2 + h3，保证 chunk 自包含，即使脱离上下文也能被正确理解
        chunks.push(...splitByLength({
          city,
          type,
          title: `${city} - ${h2Title} - ${h3Title}`,
          content: `${city}${h2Title} - ${h3Title}：${rawText}`,
          tags: [city, h2Title, h3Title, typeLabel(type)].filter(Boolean),
          sectionTitle: h2Title,
          subSectionTitle: h3Title,
        }));
      }
    }
    currentEl = currentEl.next();
  }
  return chunks;
}

/**
 * 内容去重：对比 content 前 120 字符的指纹，移除高度重复的 chunk。
 * 避免 h2 章节文本与 h3 子章节文本产生过多重叠内容占用向量库空间。
 */
function deduplicateChunks(chunks) {
  const seen = new Set();
  return chunks.filter((chunk) => {
    const fingerprint = chunk.content.replace(/\s+/g, '').toLowerCase().slice(0, 120);
    if (seen.has(fingerprint)) return false;
    seen.add(fingerprint);
    return true;
  });
}

// ─── 节类型映射 ──────────────────────────────────────────────────────────────

/**
 * 将章节标题映射到知识类型
 * 优先精确匹配，再模糊匹配
 */
function mapSectionType(title, typesMap = SECTION_TYPES) {
  if (!title) return null;
  const trimmed = title.trim();

  // 精确匹配
  if (typesMap[trimmed]) return typesMap[trimmed];

  // 模糊匹配（标题包含关键词）
  for (const [key, type] of Object.entries(typesMap)) {
    if (trimmed.includes(key)) return type;
  }

  return null;
}

// ─── 分块（含重叠）────────────────────────────────────────────────────────────

/**
 * 将过长的内容按句子分割为多个子片段，并在相邻片段间加入重叠。
 *
 * RAG 适配说明：
 * - 按句子边界切割，保证每块语义完整
 * - CHUNK_OVERLAP 让相邻块共享 1~2 句上下文，
 *   避免关键信息恰好落在切割点被截断后丢失
 */
function splitByLength(chunk) {
  if (chunk.content.length <= MAX_CHUNK_LENGTH) return [chunk];

  const sentences = chunk.content.split(/(?<=[。！？；\n])/);
  const result = [];
  let buffer = '';

  for (const sentence of sentences) {
    if (buffer.length + sentence.length > MAX_CHUNK_LENGTH && buffer.length > 0) {
      const partIdx = result.length + 1;
      result.push({
        ...chunk,
        title: result.length > 0 ? `${chunk.title}（续${partIdx}）` : chunk.title,
        content: buffer.trim(),
      });
      // 从 buffer 末尾逆向取若干完整句子作为重叠前缀，总长不超过 CHUNK_OVERLAP，
      // 保证 overlap 始终从句子边界开始，避免 slice(-N) 从词语中间截断。
      const bufSentences = buffer.split(/(?<=[。！？；\n])/);
      const overlapParts = [];
      let overlapLen = 0;
      for (let i = bufSentences.length - 1; i >= 0; i--) {
        if (overlapLen + bufSentences[i].length <= CHUNK_OVERLAP) {
          overlapParts.unshift(bufSentences[i]);
          overlapLen += bufSentences[i].length;
        } else {
          break;
        }
      }
      const overlap = overlapParts.join('');
      // 续N块开头加上原始标题作为上下文锚点，确保脱离上下文也能理解语义
      buffer = `【${chunk.title}（续）】` + overlap + sentence;
    } else {
      buffer += sentence;
    }
  }

  if (buffer.trim()) {
    const partIdx = result.length + 1;
    result.push({
      ...chunk,
      title: result.length > 0 ? `${chunk.title}（续${partIdx}）` : chunk.title,
      content: buffer.trim(),
    });
  }

  return result.length ? result : [chunk];
}

// ─── 主解析逻辑 ──────────────────────────────────────────────────────────────

/**
 * RAG 数据质量设计说明
 * ────────────────────────────────────────────────────────────────
 * 每个 chunk 被设计为"自包含"：即使脱离其他 chunk，也能独立回答问题。
 * 实现方式：每块内容前缀统一加 "{城市}{类型}：" 描述语境。
 *
 * 三级粒度覆盖不同检索场景：
 *  ① h2 章节  → "杭州有哪些美食？"（宽泛问题）
 *  ② h3 子节  → "杭州西湖周边美食推荐"（中等精度）
 *  ③ POI 条目 → "外婆家餐厅在哪？几点开？"（精确问题）
 *
 * 分块参数：MAX_CHUNK_LENGTH=800 ≈ 500 token，CHUNK_OVERLAP=120 防截断
 * ────────────────────────────────────────────────────────────────
 */

/**
 * 策略A：h2/h3 父子去重
 * 当某个 h2 章节下有 >= minH3 个 h3 子节时，丢弃该 h2 的整体 chunk，
 * 只保留更细粒度的 h3 子节 chunk 和 POI chunk。
 * 原因：h2 chunk 内容是其下所有 h3 的拼接，向量相似度极高，
 * 会在 topK 检索时占用多个名额，等效于浪费召回槽位。
 * @param {Array} chunks - 已生成的 chunk 列表
 * @param {number} minH3 - 触发剪枝的最小 h3 数量，默认 2
 */
function pruneH2WhenH3Exists(chunks, minH3 = 3) {
  // 统计每个 (city, sectionTitle) 下的 h3 子节数量
  const h3CountPerSection = {};
  for (const c of chunks) {
    if (c.subSectionTitle) {
      const key = `${c.city}::${c.sectionTitle}`;
      h3CountPerSection[key] = (h3CountPerSection[key] || 0) + 1;
    }
  }

  return chunks.filter((c) => {
    // h3 子节 chunk 和 POI chunk 始终保留
    if (c.subSectionTitle || c.poiName) return true;
    const key = `${c.city}::${c.sectionTitle}`;
    const h3Count = h3CountPerSection[key] || 0;
    // 有足够多的 h3 子节时，丢弃 h2 父块，避免父子内容大量重叠
    return h3Count < minH3;
  });
}

/**
 * 根据类型生成内容前缀，保证每块 chunk 自包含
 */
function buildTypePrefix(city, type, sectionTitle) {
  const map = {
    guide:         `${city}旅游指南`,
    attraction:    `${city}景点介绍`,
    food:          `${city}美食推荐`,
    notice:        `${city}旅行注意事项`,
    activity:      `${city}旅行体验活动`,
    transport:     `${city}交通指南`,
    shopping:      `${city}购物推荐`,
    accommodation: `${city}住宿信息`,
    contact:       `${city}实用联系信息`,
  };
  return map[type] || `${city} - ${sectionTitle}`;
}

/**
 * 解析城市页面数据，生成三级知识片段列表
 * @param {{city, sourceUrl, text, sections}} cityData
 * @returns {Array<object>} 知识片段列表（已去重）
 */
function parseCityData(cityData) {
  const { city, sourceUrl, text, lang = 'zh' } = cityData;
  const sectionTypesMap = lang === 'en' ? SECTION_TYPES_EN : SECTION_TYPES;
  const $ = cheerio.load(text);
  const chunks = [];

  // ── ① 导言（第一个 h2 之前的总结段落）─────────────────────────────────────
  const leadParagraphs = [];
  const contentRoot = $('div.mw-parser-output, body');

  contentRoot.children().each((_, el) => {
    // 兼容新版 MediaWiki 的 div.mw-heading2 包裹格式，确保在任意 h2 边界停止
    if (isH2Boundary(el, $)) return false;
    const tagName = $(el).prop('tagName')?.toLowerCase();
    if (tagName === 'p') {
      const t = $(el).text().replace(/\[\d+\]/g, '').replace(/\s+/g, ' ').trim();
      if (t.length > 20) leadParagraphs.push(t);
    }
  });

  if (leadParagraphs.length > 0) {
    chunks.push(...splitByLength({
      city,
      type: 'guide',
      title: `${city}概览`,
      content: `${city}旅游概览：${leadParagraphs.join(' ')}`,
      tags: [city, '概览', '旅游指南'],
      sectionTitle: '概览',
    }));
  }

  // ── ② 按 h2 章节提取 ─────────────────────────────────────────────────────
  // 同时选取旧版 h2 和新版 div.mw-heading2，兼容两种 MediaWiki 格式
  $('h2, div.mw-heading2').each((_, h2Raw) => {
    const $h2 = $(h2Raw);
    // 对于 div.mw-heading2 容器，内部的 h2 才是标题元素
    const innerHeading = $h2.is('div') ? $h2.find('h2') : $h2;
    const sectionTitle = getHeadingText(innerHeading.length ? innerHeading : $h2);
    if (!sectionTitle) return;
    const type = mapSectionType(sectionTitle, sectionTypesMap);
    if (!type) return;

    // 从此节容器的下一个兄弟节点开始收集内容
    let sectionHtml = '';
    let currentEl = $h2.next();
    while (currentEl.length && !isH2Boundary(currentEl[0], $)) {
      sectionHtml += $.html(currentEl);
      currentEl = currentEl.next();
    }

    // 粒度①：h2 章节整体文本（概述，适合宽泛问题）
    const rawText = htmlToText(sectionHtml);
    if (rawText.length >= 50) {
      const prefix = buildTypePrefix(city, type, sectionTitle);
      chunks.push(...splitByLength({
        city,
        type,
        title: `${city} - ${sectionTitle}`,
        content: `${prefix}：${rawText}`,
        tags: [city, sectionTitle, typeLabel(type)].filter(Boolean),
        sectionTitle,
      }));
    }

    // 粒度②：h3 子章节（适合中等精度问题）
    chunks.push(...extractH3Sections($, $h2[0], city, type, sectionTitle));

    // 粒度③：结构化 POI listing（适合精确问题）
    const $section = cheerio.load(sectionHtml);
    chunks.push(...extractVcardPOIs($section, city, type, sectionTitle));
  });

  // 去重后返回（先做策略A：h2/h3父子去重，再做内容指纹去重）
  return deduplicateChunks(pruneH2WhenH3Exists(chunks));
}

function typeLabel(type) {
  const labels = {
    guide: '城市指南', attraction: '景点', food: '美食',
    notice: '注意事项', activity: '活动', transport: '交通',
    shopping: '购物', accommodation: '住宿', contact: '实用信息',
  };
  return labels[type] || '';
}

module.exports = { parseCityData };
