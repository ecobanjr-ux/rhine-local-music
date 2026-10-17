// 本项目自撰（非移植代码）。在线歌词载荷的纯文本归一层。
//
// 台账 R55：QQ 今天返回的是 **XML 信封**（探针 P3：`<QrcInfos>…<Lyric_1 LyricContent="[0,2250]词(0,160)…"`），
// 而上游 `parseQRC`（`references/folia-major/src/utils/lyrics/parserCore.ts:570-701`）只认拆封后的
// legacy QRC 文本，全仓没有拆封代码（`grep 'QrcInfos|LyricContent'` 0 命中）——
// 也就是说上游的 QQ 逐字路径今天拿不到词。所以这里是**对上游缺陷的修复**，不是偏离。
//
// 台账 R58（前置）：`foldKana` 只把片假名折成平假名，不做罗马音转换（用户 2026-10-04 定案：不加 wanakana）。

/** 与 src/lyrics/index.ts:53 同一条硬约束：命中实体/DOCTYPE 声明直接拒绝，绝不交给后续解析路径。 */
const ENTITY_DECLARATION_REGEX = /<!\s*(DOCTYPE|ENTITY)/i;
const QQ_ENVELOPE_REGEX = /^\s*(?:\uFEFF)?<\?xml\b/i;
const QQ_LYRIC_CONTENT_REGEX = /<Lyric_(\d+)\b[^>]*?\bLyricContent="([\s\S]*?)"\s*\/?>/g;
const NAMED_ENTITIES = { quot: '"', apos: "'", lt: '<', gt: '>', amp: '&' };

/**
 * 只反转义五类字符引用与数字引用；未知命名实体原样保留。
 * 不做任何 DTD/外部实体展开（上面已先拒绝），也不引入 XML 解析器。
 */
export function decodeXmlEntities(value) {
  return String(value)
    .replace(/&(quot|apos|lt|gt|amp);/g, (_match, name) => NAMED_ENTITIES[name])
    .replace(/&#(\d{1,7});/g, (_match, code) => String.fromCodePoint(Number(code)))
    .replace(/&#x([0-9a-fA-F]{1,6});/g, (_match, code) => String.fromCodePoint(parseInt(code, 16)))
    .replace(/&amp;/g, '&');
}

/**
 * 拆 QQ 歌词载荷的信封。返回 `{ content }`（已反转义）或 `{ rejected }`（可疑输入）。
 * 非信封形态（纯 LRC / legacy QRC 文本）原样返回，兼容平台改版与灰度。
 */
export function unwrapQqLyricPayload(raw) {
  const text = String(raw ?? '').replace(/^\uFEFF/, '');
  if (ENTITY_DECLARATION_REGEX.test(text)) return { rejected: 'entity-declaration' };
  if (!QQ_ENVELOPE_REGEX.test(text)) return { content: text };
  const entries = [...text.matchAll(QQ_LYRIC_CONTENT_REGEX)].sort((a, b) => Number(a[1]) - Number(b[1]));
  if (!entries.length) return { content: '' };
  return { content: decodeXmlEntities(entries[0][2]).replace(/^\uFEFF/, '') };
}

/** legacy QRC 判定：行首 `[startMs,durMs]` 且行内含 `(startMs,durMs[,len])` 词级时间标记。 */
export function isQrcPayload(content) {
  const text = String(content ?? '');
  return /^\[\d+,\d+\]/m.test(text) && /\(\d+,\d+(,\d+)?\)/.test(text);
}

/** 计时行计数（服务端文本级门槛用）：`[mm:ss.xx]` 与 `[startMs,durMs]` 两种都算。 */
export function countTimedLines(content) {
  return String(content ?? '')
    .split(/\r?\n/)
    .filter((line) => /^\[\d{2}:\d{2}[:.]\d{2,3}\]/.test(line.trim()) || /^\[\d+,\d+\]/.test(line.trim())).length;
}

/**
 * 片假名折成平假名（码位减 0x60，只动 ァ..ヶ），让「キヨシ」与「きよし」认定为同一文本。
 * 上游 normalizeLyricMatchText 之后还接 wanakana.toRomaji 把假名转罗马音；本期**不做那一步**
 * （用户 2026-10-04 定案 2：不加依赖）。函数独立、可整体替换（台账 R58）。
 */
export function foldKana(value) {
  return String(value).replace(/[\u30A1-\u30F6]/gu, (char) => String.fromCharCode(char.charCodeAt(0) - 0x60));
}
