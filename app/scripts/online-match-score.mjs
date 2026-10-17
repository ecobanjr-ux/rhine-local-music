// 移植自 folia-major（https://github.com/chthollyphile/folia-major），AGPL-3.0-only。
// 原文件与范围 @ 369c34e6f83404c65129479e6bd88d70acb0e43e：
//   src/utils/lyrics/matchScore.ts:8-218   —— 归一、相似度、时长乘子、分量打分与对外入口
//   src/utils/lyrics/duration.ts:3-16      —— normalizeLyricMatchDurationMs
//   src/utils/lyrics/searchQuery.ts:6-61   —— 查询构造（:63-71 的 buildKugouLyricSearchQuery 未搬，本期无酷狗）
// 修改（台账 R58）：① 去依赖 —— wanakana.toRomaji(value) 换成本仓 online-normalize.mjs 的 foldKana
//    （只折片假名，不做罗马音转换）：这是本期唯一的功能性偏离，后果是"日语假名与罗马音写法之间不再互认"，
//    函数独立可整体替换；② createProviderSongMetadata(result) 换成直接取 result
//    （本仓在线候选对象本身就带 artists / album / durationMs，无需再经一层元数据适配）；
//    ③ 语言：上游 .ts，本仓服务端运行时是纯 node，用仓库已有的 typescript 做 transpileModule 剥类型。
// 阈值与权重一律照上游原值：title 45 / artist 25 / album 30、AUTO_MATCH_MIN_SCORE 75、
// AUTO_MATCH_COMPONENT_MISS_SCORE_CAP 74、时长乘子 ≤1000→1 / ≤3000→0.95 / ≤5000→0.75 / ≤10000→0.35 / 否则 0.1。
// 修改（台账 R140，任务二）：**加**一条窄规则——曲名归一后逐字相等 + 歌手匹配 + 时长差 ≤3 秒时，
// 身份分给下限 80（专治"合辑/精选辑的专辑名与单曲专辑名天然不同 ⇒ 70 分死在阈值下"）。
// 上面那四个上游常量与乘子表**一个都没动**，都有逐字断言钉着；三条件缺一即完全退回原算法。
// 本文件随本项目整体以 AGPL-3.0 发布，保留全部原始版权声明与许可声明。
import * as OpenCC from 'opencc-js';
import { foldKana } from './online-normalize.mjs';

// src/utils/lyrics/matchScore.ts
const t2sConverter = OpenCC.Converter({ from: 't', to: 'cn' });
const SCORE_WEIGHTS = {
    title: 45,
    artist: 25,
    album: 30
};
const AUTO_MATCH_COMPONENT_MISS_SCORE_CAP = 74;
/**
 * R140（任务二）：专辑那一维的**窄规则下限**。上游与本机原算法里，专辑占 30 分，
 * 于是"曲名与歌手都逐字一致、只有专辑对不上"的候选最多拿 70 分，恰好死在阈值 75 下面。
 * 真机案例：`他不懂 / 张杰`（`on-netease-28059417`）——合辑/精选辑的专辑名与单曲专辑名天然不同，
 * 但曲名、歌手逐字一致且时长对得上，那就是同一首歌。
 *
 * 规则**只在这一条路径上生效**（三个条件缺一即退回原算法，一个字都不变）：
 *   ① `titleSimilarity === 1`（归一后逐字相等，不是"很像"）；
 *   ② `artistMatched`（打分器已有的那一维判据）；
 *   ③ 两边时长都已知且 `|Δ| ≤ 3000ms`。
 * 给到下限 80 而不是直接放行：80 × 时长乘子（≤1s 是 1、≤3s 是 0.95）= 80 或 76，
 * 仍要过阈值 75，也就是"窄规则只是把 70 抬到压线之上"，不是"绕过打分"。
 * **没动的东西**：`AUTO_MATCH_COMPONENT_MISS_SCORE_CAP`（74）、`AUTO_MATCH_MIN_SCORE`（75）、
 * 三个权重（45/25/30）、时长乘子表——这些都有逐字断言钉着，本规则一律不碰。
 */
const ALBUM_DIMENSION_IDENTITY_FLOOR = 80;
const ALBUM_DIMENSION_DURATION_TOLERANCE_MS = 3_000;
/**
 * Removes punctuation and symbols while preserving letters across languages.
 */
export function normalizeLyricMatchText(value) {
    const romajiValue = foldKana(value);
    const simpValue = t2sConverter(romajiValue);
    return simpValue
        .toLowerCase()
        .replace(/[\p{P}\p{S}]/gu, '')
        .replace(/\s+/g, ' ')
        .trim();
}
function normalizeTitleForMatch(value) {
    const versionMarkerPattern = /(instrumental|inst|off\s*vocal|karaoke|remix|mix|version|ver\.?|cover|live|edit|arrange|伴奏|カラオケ|インスト|リミックス|remaster|remastered)/iu;
    return normalizeLyricMatchText(value
        .replace(/[\(\[（【]\s*(feat|featuring|ft)\.?\s+[^\)\]）】]+[\)\]）】]/giu, '')
        .replace(/\b(feat|featuring|ft)\.?\s+.+$/iu, '')
        .replace(/[\(\[（【]([^\)\]）】]+)[\)\]）】]/gu, (match, content) => {
        return versionMarkerPattern.test(content) ? match : '';
    }));
}
/**
 * Calculates Jaccard character similarity between two normalized strings.
 */
function stringSimilarity(s1, s2, normalizer = normalizeLyricMatchText) {
    const n1 = normalizer(s1);
    const n2 = normalizer(s2);
    if (!n1 || !n2)
        return 0;
    if (n1 === n2)
        return 1.0;
    if (n1.includes(n2) || n2.includes(n1))
        return Math.min(n1.length, n2.length) / Math.max(n1.length, n2.length);
    const set1 = new Set(n1);
    const set2 = new Set(n2);
    let intersection = 0;
    for (const char of set1) {
        if (set2.has(char)) {
            intersection++;
        }
    }
    const union = new Set([...set1, ...set2]).size;
    return union > 0 ? intersection / union : 0;
}
function getArtistText(result) {
    return result.artists.map(a => a.name).join(', ');
}
function getAlbumText(result) {
    const album = result.album?.name || '';
    return /^unknown album$/i.test(album.trim()) ? '' : album;
}
function calculateDurationScore(targetDurationMs, searchDurationMs) {
    if (targetDurationMs <= 0 || searchDurationMs <= 0) {
        return { multiplier: 0.9, matched: null };
    }
    const diff = Math.abs(targetDurationMs - searchDurationMs);
    if (diff <= 1000) {
        return { multiplier: 1, matched: true };
    }
    if (diff <= 3000) {
        return { multiplier: 0.95, matched: true };
    }
    if (diff <= 5000) {
        return { multiplier: 0.75, matched: false };
    }
    if (diff <= 10000) {
        return { multiplier: 0.35, matched: false };
    }
    return { multiplier: 0.1, matched: false };
}
/**
 * Calculates component scores so automatic matching can distinguish title, artist, album, and duration misses.
 */
function splitArtistsForMatch(artistText) {
    return artistText
        .split(/[,&、\/]|feat\.?|ft\.?|featuring|与/i)
        .map(a => normalizeLyricMatchText(a))
        .filter(a => a.length > 0);
}
function calculateArtistSimilarity(target, search) {
    const tArtists = splitArtistsForMatch(target);
    const sArtists = splitArtistsForMatch(search);
    if (tArtists.length === 0 || sArtists.length === 0) {
        return stringSimilarity(target, search);
    }
    let matchCount = 0;
    for (const a1 of tArtists) {
        for (const a2 of sArtists) {
            if (a1 === a2 || (a1.length >= 3 && a2.includes(a1)) || (a2.length >= 3 && a1.includes(a2))) {
                matchCount++;
                break;
            }
        }
    }
    const tokenSim = matchCount / Math.max(tArtists.length, sArtists.length);
    const isMainArtistMatched = tArtists[0] && sArtists[0] &&
        (tArtists[0] === sArtists[0] ||
            (tArtists[0].length >= 3 && sArtists[0].includes(tArtists[0])) ||
            (sArtists[0].length >= 3 && tArtists[0].includes(sArtists[0])));
    const mainBonus = isMainArtistMatched ? Math.max(tokenSim, 0.7) : tokenSim;
    return Math.max(mainBonus, stringSimilarity(target, search));
}
export function calculateMatchScoreDetails(song, result) {
    const searchTitle = result.name || '';
    const searchArtist = getArtistText(result);
    const searchAlbum = getAlbumText(result);
    const targetDurationMs = normalizeLyricMatchDurationMs(song.durationMs);
    const searchDurationMs = normalizeLyricMatchDurationMs(result.durationMs);
    const titleSimilarity = stringSimilarity(song.title, searchTitle, normalizeTitleForMatch);
    const titleScore = titleSimilarity * SCORE_WEIGHTS.title;
    const artistSimilarity = song.artist.trim()
        ? calculateArtistSimilarity(song.artist, searchArtist)
        : 1;
    const artistScore = artistSimilarity * SCORE_WEIGHTS.artist;
    const hasTargetAlbum = Boolean(song.album?.trim());
    const hasSearchAlbum = Boolean(searchAlbum.trim());
    const albumSimilarity = hasTargetAlbum && hasSearchAlbum
        ? stringSimilarity(song.album || '', searchAlbum, normalizeTitleForMatch)
        : null;
    const albumScore = albumSimilarity === null
        ? (hasTargetAlbum ? 0 : SCORE_WEIGHTS.album)
        : albumSimilarity * SCORE_WEIGHTS.album;
    const duration = calculateDurationScore(targetDurationMs, searchDurationMs);
    const identityScore = titleScore + artistScore + albumScore;
    const titleMatched = titleSimilarity >= 0.65;
    const artistMatched = !song.artist.trim() || artistSimilarity >= 0.5;
    const albumMatched = !hasTargetAlbum ? null : (hasSearchAlbum ? (albumSimilarity ?? 0) >= 0.65 : null);
    const hasReliableIdentityMatch = artistMatched || albumMatched === true;
    const cappedIdentityScore = (!titleMatched || !hasReliableIdentityMatch)
        ? Math.min(identityScore, AUTO_MATCH_COMPONENT_MISS_SCORE_CAP)
        : identityScore;
    // R140 窄规则（定义与理由见文件里那个下限常量）：三条齐备才抬，抬完仍要过阈值。
    const durationKnown = targetDurationMs > 0 && searchDurationMs > 0;
    const albumDimensionRescue = titleSimilarity === 1 && artistMatched && durationKnown
        && Math.abs(targetDurationMs - searchDurationMs) <= ALBUM_DIMENSION_DURATION_TOLERANCE_MS;
    const identityScoreForAuto = albumDimensionRescue
        ? Math.max(cappedIdentityScore, ALBUM_DIMENSION_IDENTITY_FLOOR)
        : cappedIdentityScore;
    const finalScore = identityScoreForAuto * duration.multiplier;
    return {
        score: Math.min(100, Math.max(0, Math.round(finalScore))),
        titleScore,
        artistScore,
        albumScore,
        durationScore: duration.multiplier * 100,
        durationMultiplier: duration.multiplier,
        titleSimilarity,
        artistSimilarity,
        albumSimilarity,
        titleMatched,
        artistMatched,
        albumMatched,
        durationMatched: duration.matched,
        /** R140：这一格说真话——这条候选是不是靠"专辑维度窄规则"抬过线的（界面与自检都读它，不重算一遍）。 */
        albumDimensionRescued: albumDimensionRescue && cappedIdentityScore < ALBUM_DIMENSION_IDENTITY_FLOOR
    };
}
/**
 * Calculates a match score between 0% and 100% for a search result compared to the target song.
 */
export function calculateMatchScore(song, result) {
    return calculateMatchScoreDetails(song, result).score;
}
const MAX_REASONABLE_SONG_DURATION_MS = 12 * 60 * 60 * 1000;
// Normalizes song durations to milliseconds and defensively fixes accidental ms * 1000 inputs.
export const normalizeLyricMatchDurationMs = (duration) => {
    if (!Number.isFinite(duration) || !duration || duration <= 0) {
        return 0;
    }
    if (duration > MAX_REASONABLE_SONG_DURATION_MS) {
        return duration / 1000;
    }
    return duration;
};
const MAX_ALBUM_QUERY_LENGTH = 48;
const normalizeArtistIdentity = (value) => (normalizeLyricMatchText(value).replace(/\s+/gu, ''));
// Removes a duplicated "artist - title" prefix when the provider already supplies artists separately.
export const normalizeSongTitleForLyricSearch = (title, artist) => {
    const trimmedTitle = title?.trim() || '';
    const trimmedArtist = artist?.trim() || '';
    if (!trimmedTitle || !trimmedArtist)
        return trimmedTitle;
    const separator = trimmedTitle.match(/^(.+?)\s+-\s+(.+)$/u);
    if (!separator)
        return trimmedTitle;
    return normalizeArtistIdentity(separator[1]) === normalizeArtistIdentity(trimmedArtist)
        ? separator[2].trim()
        : trimmedTitle;
};
// Keeps long anime/single album names useful for provider search by dropping catalog notes and credits first.
const normalizeAlbumForLyricSearch = (album) => {
    const trimmedAlbum = album?.trim();
    if (!trimmedAlbum) {
        return null;
    }
    if (trimmedAlbum.length <= MAX_ALBUM_QUERY_LENGTH) {
        return trimmedAlbum;
    }
    const compactAlbum = trimmedAlbum
        .replace(/\s*※.*$/u, '')
        .replace(/\s*(歌|歌唱|アーティスト|Artist)\s*[:：]?\s*.+$/iu, '')
        .trim();
    if (compactAlbum.length <= MAX_ALBUM_QUERY_LENGTH) {
        return compactAlbum;
    }
    return compactAlbum.slice(0, MAX_ALBUM_QUERY_LENGTH).trim();
};
export const buildLyricSearchQuery = (title, artist, album) => {
    return [normalizeSongTitleForLyricSearch(title, artist), artist?.trim(), normalizeAlbumForLyricSearch(album)]
        .map(part => part?.trim())
        .filter((part) => Boolean(part))
        .join(' - ');
};


// ── 台账 R58 附加：把上游的三个模块内常量导出，供自检断言钉住（**值一个都没改**）──
// 上游是文件内 const（matchScore.ts:12-21、autoMatchBestLyric.ts:20），不导出就无法在断言里核对。
export { SCORE_WEIGHTS, AUTO_MATCH_COMPONENT_MISS_SCORE_CAP };
/** R140 新增的两个本机常量（不是上游的）：窄规则的下限与时长容差，导出只为让断言能钉住数值本身。 */
export { ALBUM_DIMENSION_IDENTITY_FLOOR, ALBUM_DIMENSION_DURATION_TOLERANCE_MS };
/** 上游 autoMatchBestLyric.ts:21；判定在 :132 是 if (score < AUTO_MATCH_MIN_SCORE) return null，
 *  也就是 75 分压线通过（判定是"小于 75 才丢"）。阈值逐字照抄，不做任何调整。 */
export const AUTO_MATCH_MIN_SCORE = 75;
/** 上游 autoMatchBestLyric.ts:20 —— 搜索取回的候选条数（不是逐个探测歌词的条数）。 */
export const AUTO_MATCH_SEARCH_LIMIT = 10;
/** 上游 autoMatchBestLyric.ts:18-19 —— 搜索与歌词的超时预算（本仓在 online-guard 里用同名常量对齐）。 */
export const PROVIDER_SEARCH_TIMEOUT_MS = 3500;
export const PROVIDER_LYRIC_TIMEOUT_MS = 5000;

// ── 本期在线源序（台账 R59）──────────────────────────────────────────────
// 上游基准序是 ['netease','amll','qq','kugou']（sourcePriority.ts:7），默认提权 'qq'（:5）。
// 本期只有 QQ 系可直连（网易歌词要内嵌 server、酷狗要设备会话），AMLL 需要 QQ 侧拿到的 id，
// 因此实际序 = ['qq','amll']：QQ 主源、AMLL 兜底。用户拍板"零第三方包"，故不是照搬上游而是有意收窄。
/**
 * 匹配源集合（第五期 Task 5 从两源扩到四源）。
 * 顺序就是实际问询顺序：QQ 仍居首（它能一次带回正文 + 译文 + 罗马音，且是匿名直连），
 * 网易与酷狗经桥（这两家的取词要各家签名/解密，实现只在封装包里 ⇒ R73 的子进程），
 * AMLL 排在最后兜底。
 * 注意：AMLL TTML 库**按 QQ 的曲目 id 索引**（`/qq/<id>?format=ttml`），所以它只能在 QQ 拿到候选之后
 * 当兜底位用，不能像另外三家那样独立检索 —— 这条是第四期的实测结论，不是排序偏好（台账 R59）。
 */
export const LYRIC_SOURCES = ['qq', 'netease', 'amll', 'kugou'];
/** 真正"各自检索一轮"的源（AMLL 不在其中，理由见上）。 */
export const LYRIC_SEARCH_SOURCES = ['qq', 'netease', 'kugou'];
export const DEFAULT_LYRIC_SOURCE = 'qq';

/** 与上游 buildLyricSourceOrder 同语义：把用户偏好的源提到首位，其余保持基准序。 */
export function buildLyricSourceOrder(preferred) {
  if (!preferred || !LYRIC_SOURCES.includes(preferred)) return [...LYRIC_SOURCES];
  return [preferred, ...LYRIC_SOURCES.filter((source) => source !== preferred)];
}
