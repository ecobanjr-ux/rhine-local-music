// 本项目自撰（非移植代码）。在线封面补全的两个来源（第五期 M3-c）。
//
// 三条硬规矩，都写进代码而不是只写在这里：
//   ① **只给"既无内嵌又无文件夹封面"的专辑出网**。这条判据只在曲库那一处算（`backfillCovers` 的选取），
//      本模块不重复判 ⇒ 不会出现"这边认为该补、那边认为有图"的两份真源（M3-b 的同一条教训）。
//   ② **图片字节只交给曲库落到 `dataDir/artwork`（内容寻址）**，本模块零写盘零读盘；
//      音乐根目录一个字节都不写 ⇒ 音频文件与它的标签绝不改动（这是计划 Task 14 的红线，也是断言）。
//   ③ **出网只走 `guardedCoverFetch`**（主机表 `COVER_HOSTS`、体积档 8 MiB、审计 kind `cover`），
//      自检靠注入 `fetcher` 离线跑；真机上默认值就是那个唯一出口。
//
// 两个来源的取舍都出自一手实测（数字与形状记在 memory/folia-port-p5-run-log.md 的 M3-c 段与「CAA 窗口」段）：
//   · Cover Art Archive：**身份是精确的**（按 MBID 取，不做任何模糊匹配）。它的站点现在只做一件
//     事——307 到 `archive.org`，而重定向目标里的 MBID 是**该组的 release**（不是 release-group），
//     恰好就是我们曲库里 `online.releaseId` 那一项 ⇒ 目录名可以我们自己拼。
//     但 2026-10-07 的 CAA 窗口量到**再往下一跳还有一次重定向**（原方案那句"一次重定向都不用跟"被证伪）：
//       `coverartarchive.org/release/<MBID>` →(307) `archive.org/download/mbid-<MBID>/index.json`
//                                            →(302) `dn<数字>.ca.archive.org/…/index.json`（动态数据节点）
//     `archive.org/download/` 这条路走不通（3xx 会被 `redirect:'error'` 判成失败，而节点名每次都变、不能进白名单）；
//     **`archive.org/cors/<条目>/<文件>` 是直接 200、一次都不重定向的那一条**（同一个主机、已在表里）
//     ⇒ 走 `/cors/`，安全面（"禁重定向是因为 3xx 会旁路主机校验"）一条不放宽，白名单也不必加名字。
//     index.json 的真实形状（一手回读）：`images` 是**数组**，条目里 `types:["Front"]` 标正面，
//     `image` 给的是**整条 URL**（实测同一字段的 scheme 还会在 http / https 之间变），
//     而条目里那个文件的真实名字是 `<条目名>-<id>.<ext>`（IA 的 files 列与 CAA 自己的 307 目标都指着它）。
//   · iTunes Search：**只有模糊匹配**，所以配一条最严的闸门（标题与艺人**逐字归一后相等**，
//     同年优先，仍不确定就干脆不要）。实测暴露的两类"补不到"都是有意的：
//     `黑马 / Li Ronghao` 在库里叫 "The Dark Horse"（翻译名），`COME ALONG 3 / 山下達郎` 在 iTunes 目录里
//     根本没有这张合辑 ⇒ 两者都拿不到图，宁缺不错配。
import { guardedCoverFetch } from './online-guard.mjs';
import { normalized } from './music-library.mjs';

/** 顺序就是优先级：身份精确的那一条先问，问不到再走带闸门的那一条模糊源。 */
export const COVER_SOURCES = ['caa', 'itunes'];
const MBID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;

/** iTunes 侧的三个参数都取今晚实测到的形状（limit=25 够覆盖 resultCount 上限；国家站走默认 US）。 */
export const ITUNES_LIMIT = 25;
export const ITUNES_ARTWORK_SIZE = '600x600bb';
const ITUNES_SEARCH_BASE = 'https://itunes.apple.com/search';
/** 唯一一条不重定向的取物路径（`/download/` 与 `/serve/` 都会 302 到动态数据节点，见文件头实测）。 */
const ARCHIVE_CORS_BASE = 'https://archive.org/cors';

/** 归一后的"可显示图片"判据：**认魔数，不认上游说的 Content-Type 或 index.json 里的 mime 字段**。
 *  上游给什么类型是上游的自由，我们要写进缓存并回给浏览器的必须是自己验过形状的东西；
 *  魔数这一眼同时挡掉"200 但返回的是 HTML 错误页"这种情况。
 *
 *  PNG 那第四字节是 `0x47`（ASCII 'G'）——签名整串就是 `‰PNG\r\n\x1a\n`。
 *  这一格从前写成 `0x44`（'D'，那是 `0x0d 0x0a` 之前一位的字符），于是**所有真实 PNG 一律判"不是图"**：
 *  网易封面大量是 PNG（甚至挂在 `.jpg` 名字下），专辑补全与在线曲目封面两路都静默丢掉，
 *  就是用户看到的"没封面"比登记的 6 条多得多。自检当时的夹具也照错的写（同一个字节抄进两边），
 *  所以它一直是绿的 ⇒ 现在夹具一边从 `Buffer.from('PNG')` 推、一边直接读仓库里的真 PNG。 */
export function detectImageMime(bytes) {
  if (!bytes || bytes.length < 12) return null;
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg';
  if (bytes[0] === 0x89 && bytes.subarray(1, 5).toString('latin1') === 'PNG\r' && bytes[5] === 0x0a && bytes[6] === 0x1a && bytes[7] === 0x0a) return 'image/png';
  if (bytes.subarray(0, 4).toString('latin1') === 'RIFF' && bytes.subarray(8, 12).toString('latin1') === 'WEBP') return 'image/webp';
  return null;
}

/** archive.org 上的 CAA 条目名：只能由**我们自己校验过的 MBID** 拼出来。
 *  非法 MBID 返回 null（不是抛）——上层要的是"这张没得补"，不是整轮崩掉。 */
export function caaItemName(releaseId) {
  const value = String(releaseId ?? '').trim().toLowerCase();
  return MBID.test(value) ? `mbid-${value}` : null;
}

export function caaIndexUrl(releaseId) {
  const item = caaItemName(releaseId);
  return item ? `${ARCHIVE_CORS_BASE}/${item}/index.json` : null;
}

/**
 * 条目里图片文件的 URL。入参是 index.json 里那条**整 URL**（实测形状），而条目里那个文件的
 * 真实名字是 `<条目名>-<文件名>`（IA 的 files 列实测：`mbid-<MBID>-<id>.jpg`）⇒ 只取 basename 再自己拼前缀。
 * basename 就是"来自上游、会被拼进下一条出网 URL"的那一格，所以照旧过形状闸：
 * 允许字符集排除 `/`、`\`、`?`、`#`、`%`、空格与控制字符，首字符必须是字母数字（连带挡掉 `.`/`..`），
 * 且整串不许含 `..`。取 basename 这一步本身也把 `../` 这类写法中性化（结果永远落在本条目目录内）。
 */
export function caaImageFileUrl(releaseId, imageRef) {
  const item = caaItemName(releaseId);
  if (!item) return null;
  const base = String(imageRef ?? '').split('/').pop() ?? '';
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/.test(base) || base.includes('..')) return null;
  return `${ARCHIVE_CORS_BASE}/${item}/${item}-${base}`;
}

/** index.json 里挑一张正面图。实测形状是数组、条目里 `types:["Front"]` 标正面；
 *  另一份"以序号为键的对象"形状也照旧认（上游两种文档不一致，认不出就返回 null）。
 *  优先 `types` 含 Front 的那一张；一张都没标 Front 时**不回退到第一张**——那可能是背面或内页。 */
export function caaFrontFile(payload) {
  const raw = payload?.images;
  const list = Array.isArray(raw) ? raw : raw && typeof raw === 'object' ? Object.values(raw) : [];
  const front = list.find((entry) => Array.isArray(entry?.types) && entry.types.includes('Front'));
  const image = front?.image ?? front?.url;
  if (typeof image !== 'string' || !image) return null;
  const id = String(front?.id ?? '');
  return { image, imageId: /^\d{1,20}$/.test(id) ? id : '', comment: front?.comment ?? '' };
}

/** iTunes 检索 URL：term 里带艺人+专辑，`entity=album`（今晚实测：不加 entity 会返回单曲轨条目）。 */
export function itunesSearchUrl({ title, artist }, { country, limit = ITUNES_LIMIT } = {}) {
  const term = [String(artist ?? ''), String(title ?? '')].map((part) => part.trim()).filter(Boolean).join(' ');
  const url = new URL(ITUNES_SEARCH_BASE);
  url.searchParams.set('term', term);
  url.searchParams.set('entity', 'album');
  url.searchParams.set('limit', String(limit));
  if (country) url.searchParams.set('country', String(country));
  return url.toString();
}

/**
 * iTunes 结果的**身份闸门**（这个函数就是"宁可无图不错配"那句定案在封面这一路的落点）：
 *   1. 标题与艺人都要归一后逐字相等（归一沿用曲库那一份 `normalized`，不再造第二套口径）；
 *   2. 命中多条时按本地年份筛一轮（`releaseDate` 以年份起头）；
 *   3. 剩下的结果如果指向**不止一张图**，判为不确定，一条都不要。
 * 返回 `{ url, matchedTitle, matchedArtist }` 或 `{ url: null, reason }`（原因可读，进索引与日志）。
 */
export function pickItunesArtwork(payload, { title, artist, year } = {}) {
  const results = Array.isArray(payload?.results) ? payload.results : [];
  if (!results.length) return { url: null, reason: 'iTunes 没有返回这张专辑的条目' };
  const wanted = { title: normalized(title), artist: normalized(artist) };
  if (!wanted.title) return { url: null, reason: '本地专辑名为空，无法与在线结果比对' };
  let hits = results.filter((item) => normalized(item?.collectionName) === wanted.title && normalized(item?.artistName) === wanted.artist);
  const reasonAfter = (list) => list.length ? '' : (
    results.some((item) => normalized(item?.collectionName) === wanted.title)
      ? 'iTunes 有同名专辑但艺人对不上'
      : 'iTunes 结果的专辑名与本地逐字不一致（翻译名/版本标记差异都算不一致）');
  if (year && hits.length > 1) {
    const byYear = hits.filter((item) => String(item?.releaseDate ?? '').startsWith(String(year)));
    if (byYear.length) hits = byYear;
  }
  if (!hits.length) return { url: null, reason: reasonAfter(hits) || 'iTunes 没有逐字匹配的条目' };
  const urls = [...new Set(hits.map((item) => artworkAt600(item?.artworkUrl100)).filter(Boolean))];
  if (!urls.length) return { url: null, reason: 'iTunes 命中条目但没有封面字段' };
  // 多张不同的图 = 我们分不清哪一张属于手上这一版（同一艺人同年发的同名精选与原版最能撞在这里）。
  if (urls.length > 1) return { url: null, reason: `同名同艺人的结果给出 ${urls.length} 张不同的封面，无法确定哪张属于这一版` };
  return { url: urls[0], matchedTitle: hits[0].collectionName, matchedArtist: hits[0].artistName };
}

/** `…\/100x100bb.jpg` → `…\/600x600bb.jpg`（今晚实测：改写后同一主机直连 200、不重定向，108,696 字节）。 */
export function artworkAt600(url) {
  const value = String(url ?? '');
  if (!value) return '';
  return value.replace(/\/\d+x\d+(bb)?\.jpg$/, `/${ITUNES_ARTWORK_SIZE}.jpg`);
}

/** 一次取图：过魔数闸，返回 `{ ok, bytes, mime, status }` 或可读失败。 */
async function fetchImage(url, { fetcher, timeoutMs }) {
  const response = await fetcher(url, { timeoutMs, withBytes: true });
  if (!response?.ok) return { ok: false, status: response?.status ?? 0, reason: `HTTP ${response?.status ?? 0}` };
  const bytes = typeof response.bytes === 'function' ? response.bytes() : null;
  const mime = detectImageMime(bytes);
  if (!mime) return { ok: false, status: response.status, reason: '响应内容不是可显示的图片（魔数不匹配）' };
  return { ok: true, bytes, mime, status: response.status };
}

/**
 * 封面提供者。`fetcher` 默认 `guardedCoverFetch`（唯一出网点），自检注入桩；
 * `sources` 可裁剪（留这一手是为了"关掉某个来源"这种需求不必再动结构）。
 */
export function createOnlineCoverProvider({ fetcher = guardedCoverFetch, sources = COVER_SOURCES, timeoutMs, log = () => {} } = {}) {
  const call = (url, options = {}) => fetcher(url, { ...options, ...(timeoutMs ? { timeoutMs } : {}) });

  async function fromCaa(album) {
    const indexUrl = caaIndexUrl(album.releaseId);
    if (!indexUrl) return { status: 'skipped', reason: '没有可用的 MusicBrainz release id' };
    const response = await call(indexUrl);
    if (!response?.ok) return { status: 'failed', reason: `Cover Art Archive 索引 HTTP ${response?.status ?? 0}` };
    let payload;
    try { payload = response.json(); } catch { return { status: 'failed', reason: 'Cover Art Archive 索引响应不是合法 JSON' }; }
    const front = caaFrontFile(payload);
    if (!front) return { status: 'not-found', reason: 'Cover Art Archive 该条目没有标 Front 的图' };
    const imageUrl = caaImageFileUrl(album.releaseId, front.image);
    if (!imageUrl) return { status: 'failed', reason: `Cover Art Archive 给出的文件名不合形状：${String(front.image).slice(0, 60)}` };
    const image = await fetchImage(imageUrl, { fetcher: call });
    if (!image.ok) return { status: 'failed', reason: `封面取图失败：${image.reason}` };
    return {
      status: 'matched', source: 'caa', bytes: image.bytes, mime: image.mime,
      evidence: { releaseId: album.releaseId, imageId: front.imageId },
    };
  }

  async function fromItunes(album) {
    const response = await call(itunesSearchUrl(album));
    if (!response?.ok) return { status: 'failed', reason: `iTunes 检索 HTTP ${response?.status ?? 0}` };
    let payload;
    try { payload = response.json(); } catch { return { status: 'failed', reason: 'iTunes 检索响应不是合法 JSON' }; }
    const picked = pickItunesArtwork(payload, album);
    if (!picked.url) return { status: 'not-found', reason: picked.reason };
    const image = await fetchImage(picked.url, { fetcher: call });
    if (!image.ok) return { status: 'failed', reason: `封面取图失败：${image.reason}` };
    return {
      status: 'matched', source: 'itunes', bytes: image.bytes, mime: image.mime,
      evidence: { matchedTitle: picked.matchedTitle, matchedArtist: picked.matchedArtist },
    };
  }

  const runners = { caa: fromCaa, itunes: fromItunes };

  return {
    /**
     * 给一张专辑找封面。返回三档：`matched`（带字节）/ `not-found`（各源都问过了，没有）/
     * `error`（至少一次访问没成——**与"没有"分开记**，不然网络抖动会被写成"这张没封面"这种假事实）。
     * `attempts` 逐源留一句原因，进服务日志；错误不抛出去，抛的话整轮补图会被一张图带走。
     */
    async lookup(album) {
      const attempts = [];
      let sawError = false;
      for (const source of sources) {
        const run = runners[source];
        if (!run) { attempts.push(`${source}：本模块没有这个来源`); continue; }
        try {
          const outcome = await run(album);
          if (outcome.status === 'matched') return { ...outcome, attempts };
          if (outcome.status === 'error' || outcome.status === 'failed') sawError = true;
          attempts.push(`${source}：${outcome.reason}`);
        } catch (error) {
          sawError = true;
          // 出网层的错误文案（ONLINE_TARGET_REJECTED / 超时 / DNS）原样留着：
          // 面板与日志里"被我们自己的白名单拦下"和"上游 404"是两件不同的事，不能混成一句"没找到"。
          const message = error?.message ?? String(error);
          log(`封面补全 ${source} 失败：${message}`);
          attempts.push(`${source}：${message}`);
        }
      }
      const reason = attempts.join('；') || '没有可用的封面来源';
      return sawError ? { status: 'error', error: reason, attempts } : { status: 'not-found', reason, attempts };
    },
  };
}
