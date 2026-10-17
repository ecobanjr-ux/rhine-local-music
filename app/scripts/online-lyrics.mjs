// 本项目自撰（非移植代码）。在线歌词匹配的编排层：搜索候选 → 打分排序 → 取词 → 逐字优先择果 → 归一。
//
// 出网全部经 online-guard.mjs 的 guardedFetch（安全四条唯一实现点）；解密经 online-qrc-decrypt.mjs。
// 请求参数面逐字对齐上游 references/folia-major（commit 369c34e6f83404c65129479e6bd88d70acb0e43e）：
//   搜索 = src/utils/lyrics/providers/qqLyricProvider.ts:96-114，取词 = :162-179，AMLL = amllDbProvider.ts:19-75，
//   逐字优先与阈值判定 = src/utils/lyrics/autoMatchBestLyric.ts:132,431-436,449-452,499-504,546-549。
// 本期源序 = QQ 主、AMLL 兜底（台账 R59）：AMLL 需要候选 id，且探针 P11 两首日文样本 AMLL 均 404、
// QQ 均命中逐字，所以先打 QQ（还能带回译文与罗马音），QQ 无有效词才试 AMLL。
import { guardedFetch, ONLINE_SEARCH_TIMEOUT_MS, ONLINE_TIMEOUT_MS } from './online-guard.mjs';
import { qrcDecrypt } from './online-qrc-decrypt.mjs';
import { unwrapQqLyricPayload, isQrcPayload, countTimedLines } from './online-normalize.mjs';
import {
  calculateMatchScoreDetails, buildLyricSearchQuery, normalizeLyricMatchDurationMs,
  AUTO_MATCH_MIN_SCORE, AUTO_MATCH_SEARCH_LIMIT, LYRIC_SEARCH_SOURCES,
} from './online-match-score.mjs';

const QQ_FCG = 'https://u.y.qq.com/cgi-bin/musicu.fcg';                       // 上游 qqLyricProvider.ts:38
const AMLL_TTML_URL = (id) => 'https://amll-ttml-db.stevexmh.net/qq/'
  + encodeURIComponent(String(id)) + '?format=ttml';                          // 上游 amllDbProvider.ts:19,21（本期只有 qq 平台 id）
// comm / headers 逐字对齐上游 :24-36。Cookie 的 tmeLoginType=-1 是**固定匿名标记**（无账号、无秘密），
// 不是凭据；check-music-online 的凭据扫描把它列为显式豁免并写理由。
const QQ_COMM = {
  ct: 11, cv: '1003006', v: '1003006', os_ver: '15', phonetype: '24122RKC7C',
  rom: 'Redmi/miro/miro:15/AE3A.240806.005/OS2.0.102.0.VOMCNXM:user/release-keys',
  tmeAppID: 'qqmusiclight', nettype: 'NETWORK_WIFI', udid: '0', uid: '0',
};
const QQ_HEADERS = { 'Content-Type': 'application/json', Cookie: 'tmeLoginType=-1;', 'User-Agent': 'okhttp/3.14.9' };

const ONLINE_CANDIDATE_LIMIT = 3;    // 打分降序取前 3 个候选逐个探测（AUTO_MATCH_SEARCH_LIMIT=10 是搜索条数）
const ONLINE_BUDGET_MS = 12000;      // 整条匹配链的时间预算，超了就放弃并给出可读原因
const ONLINE_MIN_TIMED_LINES = 3;    // 服务端文本级门槛（探针 P10：器乐占位词只有 1 行）
const ONLINE_CACHE_LIMIT = 64;
// 6.6：负缓存的上限。未命中的曲目数量天然比命中多（一整张没词的专辑都会来问），
// 给到 200 条按 FIFO 淘汰，与上游 amllDbProvider 的量级思路一致。
const ONLINE_MISS_CACHE_LIMIT = 200;
/**
 * R144（任务五）· 近候选的下限与条数。
 *
 * 自动挡的阈值（`AUTO_MATCH_MIN_SCORE = 75`）**一个字都不改**——这里只是把"差一点"的那几条
 * 说给人听，让人来判，不替人判。为什么是 60：75 分以下最常见的面孔是"曲名歌手逐字一致、
 * 专辑那一维 0 分"（实测 70 分被拒，见 memory/roadmap 那条），再往下就是另一些歌了，
 * 给到 60 已经贴着"值得人看一眼"的下沿；低于 60 的列出来只会变成噪声。
 */
export const NEAR_CANDIDATE_MIN_SCORE = 60;
export const NEAR_CANDIDATE_LIMIT = 8;

const base64 = (value) => Buffer.from(String(value ?? ''), 'utf8').toString('base64');
const artistText = (candidate) => (candidate.artists ?? []).map((a) => a.name).join(', ');

async function callQq(fetcher, method, module, param, timeoutMs) {
  const response = await fetcher(QQ_FCG, {
    method: 'POST',
    headers: QQ_HEADERS,
    timeoutMs,
    // kind 是审计表的用途列（R75）：注入的假 fetcher 收到这个字段会直接忽略，不影响既有自检。
    kind: 'lyrics',
    body: JSON.stringify({ comm: QQ_COMM, request: { method, module, param } }),
  });
  if (!response.ok) throw new Error(`QQ 接口 HTTP ${response.status}`);
  const data = response.json();
  if (data.code !== 0 || data.request?.code !== 0) throw new Error(`QQ 接口返回码 ${data.code ?? data.request?.code}`);
  return data.request.data;
}

/** 搜索候选。param 逐字对齐上游 qqLyricProvider.ts:96-114（query 超 60 字符截断、search_type:0、grp:1…）。 */
async function searchQqCandidates(fetcher, query) {
  const data = await callQq(fetcher, 'DoSearchForQQMusicLite', 'music.search.SearchCgiService', {
    search_id: String(Date.now()),
    remoteplace: 'search.android.keyboard',
    query: query.length > 60 ? query.slice(0, 60) : query,
    search_type: 0,
    num_per_page: AUTO_MATCH_SEARCH_LIMIT,
    page_num: 1,
    highlight: 0,
    nqc_flag: 0,
    page_id: 1,
    grp: 1,
  }, ONLINE_SEARCH_TIMEOUT_MS);
  // 字段名一手核实（探针 P10）：item_song[].{id,mid,title,interval,singer[].name,album.name}
  return (data?.body?.item_song ?? []).map((song) => ({
    sourceId: song.id,
    qqMid: song.mid ?? '',
    name: song.title ?? '',
    artists: (song.singer ?? []).map((entry) => ({ name: entry.name ?? '' })),
    album: { name: song.album?.name ?? '' },
    durationMs: (song.interval ?? 0) * 1000,
  }));
}

/**
 * 服务端只能做**文本级**有效性判断（运行时是纯 node，不能 import src/lyrics/*.ts 的解析器）：
 * 去掉 `[ti:]` 类元信息行后，计时行必须 >= ONLINE_MIN_TIMED_LINES 且至少一行有正文。
 * 依据探针 P10：器乐占位词解密后只有 1 行 `[00:00:00]…`（plainLen 27）。
 * 最终把关在客户端——解析出 0 行会判未命中并透出原因（见 lyrics-client 的在线升级）。
 */
export function hasTimedLyricLines(content) {
  const body = String(content ?? '').split(/\r?\n/)
    .filter((line) => !/^\[(?:ti|ar|al|by|offset|re|ve|length|language):/i.test(line.trim()));
  const timed = body.filter((line) => /^\[\d{2}:\d{2}[.:]\d{2,3}\]/.test(line.trim())
    || /^\[\d+,\d+\]/.test(line.trim()));
  return timed.length >= ONLINE_MIN_TIMED_LINES
    && timed.some((line) => line.replace(/^\[[^\]]*\]/g, '').trim().length > 0);
}

/**
 * TTML（AMLL 兜底源）的判据与行文本不同：计时信息在 begin/end 属性里，不在方括号里。
 * 要求根元素是 <tt、至少一个 <p 且剥掉标签后有正文 —— 挡住"空壳 TTML"。
 */
export function hasTtmlLyricBody(content) {
  const text = String(content ?? '');
  if (!/<tt(?:\s|>)/i.test(text)) return false;
  const paragraphs = text.match(/<p[\s\S]*?<\/p>/gi) ?? [];
  return paragraphs.length >= 1
    && paragraphs.some((block) => block.replace(/<[^>]*>/g, '').trim().length > 0);
}

/** 取词并拆封。param 逐字对齐上游 qqLyricProvider.ts:162-179（crypt/ct/cv/qrc/roma/trans/type + 三个 base64 名）。 */
async function fetchQqLyric(fetcher, decrypt, candidate) {
  const data = await callQq(fetcher, 'GetPlayLyricInfo', 'music.musichallSong.PlayLyricInfo', {
    albumName: base64(candidate.album.name),
    singerName: base64(artistText(candidate)),
    songName: base64(candidate.name),
    songID: Number(candidate.sourceId),
    interval: Math.floor(normalizeLyricMatchDurationMs(candidate.durationMs) / 1000),
    crypt: 1, ct: 19, cv: 2111, lrc_t: 0, qrc: 1, qrc_t: 0, roma: 1, roma_t: 0, trans: 1, trans_t: 0, type: 0,
  }, ONLINE_TIMEOUT_MS);
  const unpack = async (hex) => (hex ? unwrapQqLyricPayload(await decrypt(hex)) : { content: '' });
  const main = await unpack(data?.lyric);
  if (main.rejected) return { rejected: main.rejected };
  const trans = await unpack(data?.trans);
  const roma = await unpack(data?.roma);
  if (trans.rejected || roma.rejected) return { rejected: 'entity-declaration' };
  return {
    content: main.content,
    translation: trans.content || undefined,
    romanization: roma.content || undefined,
  };
}

/** AMLL TTML 兜底：非 2xx / 空 / 无 <tt 一律当"没有"（等价上游 amllDbProvider.ts:57-64 的 404→null）。 */
async function fetchAmllTtml(fetcher, sourceId) {
  const response = await fetcher(AMLL_TTML_URL(sourceId), { timeoutMs: ONLINE_TIMEOUT_MS, kind: 'lyrics' });
  if (!response.ok) return '';
  const text = response.text();
  return text.trim() && /<tt(?:\s|>)/i.test(text) ? text : '';
}

/**
 * 经桥的一跳（Task 5）。`bridge` 缺省是 null ⇒ 网易/酷狗两档直接返回"桥不可用"，
 * **QQ 与 AMLL 照常直连**：这就是"桥挂了，歌词能力退化但不归零"的具体形态。
 * 返回形状与桥的路由约定一致：永远 200 + {ok, ...}，失败是 {ok:false, reason}。
 */
async function callBridge(bridge, payload) {
  if (!bridge || typeof bridge.call !== 'function') return { ok: false, reason: '在线后端未启用（桥不可用）' };
  const result = await bridge.call('/bridge/lyrics', { ...payload, timeoutMs: ONLINE_TIMEOUT_MS });
  if (!result || typeof result !== 'object') return { ok: false, reason: '桥没有回话' };
  return result;
}

/** 各源的"检索"入口。QQ 直连、AMLL 不能独立检索（按 QQ id 索引）、网易/酷狗经桥。 */
async function searchSource(source, { fetcher, bridge }, query) {
  if (source === 'qq') {
    const candidates = await searchQqCandidates(fetcher, query);
    return { ok: true, candidates };
  }
  const result = await callBridge(bridge, { source, action: 'search', keywords: query });
  if (!result.ok) return { ok: false, reason: String(result.reason ?? '检索失败') };
  return { ok: true, candidates: result.candidates ?? [] };
}

/** 各源的"取词"入口，统一成 {content, translation, romanization} 一种形状。 */
async function fetchSourceLyric(source, { fetcher, decrypt, bridge }, candidate) {
  if (source === 'qq') return fetchQqLyric(fetcher, decrypt, candidate);
  const result = await callBridge(bridge, {
    source, action: 'lyric', mediaId: String(candidate.sourceId ?? ''), accessKey: String(candidate.accessKey ?? ''),
  });
  if (!result.ok) return { content: '', failed: String(result.reason ?? '取词失败') };
  return { content: String(result.text ?? ''), translation: result.translation || undefined };
}

const matchedSongOf = (candidate, details) => ({
  title: candidate.name,
  artist: artistText(candidate),
  album: candidate.album.name,
  durationMs: candidate.durationMs,
  sourceId: candidate.sourceId,
  score: details.score,
});

/**
 * R144：近候选的**身份**（不含任何歌词正文）。
 *
 * 为什么带 `accessKey`：网易与酷狗的取词要它（`fetchSourceLyric` 那一跳的参数），
 * 少了它这条候选就没法"过一会儿再取一次"。它是检索响应里给这首歌的令牌，不是账号凭据，
 * 与 `songId` 同档；认领记录里存的也正是这一份（歌词正文永远不落盘，那条声明仍然成立）。
 */
const nearCandidateOf = (source, candidate, details) => ({
  provider: source,
  sourceId: String(candidate.sourceId ?? ''),
  accessKey: String(candidate.accessKey ?? ''),
  title: String(candidate.name ?? ''),
  artist: artistText(candidate),
  album: String(candidate.album?.name ?? ''),
  durationMs: Math.round(normalizeLyricMatchDurationMs(candidate.durationMs)),
  score: details.score,
});

/**
 * 认领记录 → `fetchSourceLyric` 要的候选形状（`nearCandidateOf` 的逆）。
 * 只重建那四个取词用得上的字段，别的（分数、认领时间）是给人与日志看的，不进候选。
 */
export function candidateFromClaim(claim) {
  return {
    name: String(claim?.title ?? ''),
    artists: String(claim?.artist ?? '').split(', ').filter(Boolean).map((name) => ({ name })),
    album: { name: String(claim?.album ?? '') },
    durationMs: Number(claim?.durationMs ?? 0),
    sourceId: String(claim?.sourceId ?? ''),
    accessKey: String(claim?.accessKey ?? ''),
  };
}

/**
 * 取回来的歌词 → 三选一：可用结果 / 不可用的那句原因 / 被安全预检挡下。
 * 自动挡与手动认领**共用这一份判定**（计时行门槛、实体声明拒绝、逐字识别都不许有两套）。
 */
function lyricVerdict(source, candidate, details, lyric) {
  if (lyric.rejected) return { ok: false, rejected: true, reason: '在线歌词含实体声明，已拒绝' };
  if (lyric.failed) return { ok: false, reason: String(lyric.failed) };
  if (!hasTimedLyricLines(lyric.content)) {
    return { ok: false, reason: `候选《${candidate.name}》没有有效歌词（计时行不足 ${ONLINE_MIN_TIMED_LINES} 行）` };
  }
  const wordByWord = isQrcPayload(lyric.content);
  return {
    ok: true,
    wordByWord,
    outcome: {
      matched: true,
      provider: source,
      format: wordByWord ? 'qrc' : 'lrc',
      text: lyric.content,
      translation: lyric.translation,
      romanization: lyric.romanization,
      score: details.score,
      isWordByWord: wordByWord,
      timedLines: countTimedLines(lyric.content),
      matchedSong: matchedSongOf(candidate, details),
    },
  };
}

/**
 * 在线曲目的歌词查询串（F4）。返回 null 表示"这扇门不该为它开"。
 *
 * 在线曲目（`on-<来源>-<媒体 id>`）不在本地索引里，索引查不到不等于没这首歌；
 * 但服务端也不能凭一个 id 就去反查任何缓存（那会造出第二处真源），
 * 所以描述字段由调用方随请求带来，这里逐项校验后才喂给匹配器：
 *   · id 必须是那三个音源前缀之一的形状 ⇒ 这扇窄门只对"在线曲目"开；
 *   · title/artist 必填、去空白后非空、各 ≤160 字（匹配串本来就该是这个量级）；
 *   · album 可空（在线结果常没有效专辑名，空串在打分里是"没这项信息"的中性表达）；
 *   · durationMs 必须是 0..1 小时内的有限数（时长是打分的一维证据，不许塞垃圾）。
 */
const ONLINE_LYRIC_ID_PATTERN = /^on-(?:netease|qq|kugou)-/;
const ONLINE_LYRIC_TEXT_LIMIT = 160;

/**
 * R144：歌词身份的指纹 = 归一前的「曲名 / 歌手 / 专辑 / 整秒时长」。
 *
 * 匹配缓存、负缓存、认领记录**三处共用这一个函数**（认领记录那边只接结果、不另算一份）。
 * 为什么不含曲目 id：本地 id 是文件路径哈希，换根目录就整批失联（收藏那边同一课）；
 * 为什么含专辑：歌词配错最常见的形态就是"同名不同专辑"，少一维就会把认领串到别的录音上。
 * 代价如实说：改标签（尤其改专辑名或时长）会让既有的认领记录不再命中——那是对的，
 * 标签变了就是另一次查询。
 */
export function lyricIdentityFingerprint(song) {
  return [
    String(song?.title ?? '').trim(), String(song?.artist ?? '').trim(),
    String(song?.album ?? '').trim(), Math.round(normalizeLyricMatchDurationMs(song?.durationMs)),
  ].join('\u0000');
}

export function onlineLyricQueryFrom(value, trackId) {
  if (!ONLINE_LYRIC_ID_PATTERN.test(String(trackId ?? ''))) return null;
  const raw = value?.online;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const text = (field) => {
    const item = raw[field];
    if (typeof item !== 'string') return null;
    const trimmed = item.trim();
    if (!trimmed || trimmed.length > ONLINE_LYRIC_TEXT_LIMIT) return null;
    return trimmed;
  };
  const title = text('title');
  const artist = text('artist');
  if (!title || !artist) return null;
  const album = text('album') ?? '';
  const duration = Number(raw.durationMs ?? 0);
  if (!Number.isFinite(duration) || duration < 0 || duration > 3_600_000) return null;
  return { title, artist, album, durationMs: Math.round(duration) };
}

/**
 * 匹配器。fetcher / decrypt 都可注入：单测全部离线跑（不出网、不碰真密码学），
 * 真实链路由 online-guard / online-qrc-decrypt 的专项断言 + 浏览器端到端取证覆盖。
 * 契约：**任何失败都兑现成 { matched:false, reason }，绝不 reject**（不阻塞本地核心）。
 */
export function createOnlineLyricMatcher({
  fetcher = guardedFetch,
  decrypt = qrcDecrypt,
  // 桥客户端（Task 5）：网易与酷狗两档经它。缺省 null ⇒ 这两档直接给可读原因，
  // QQ/AMLL 照常直连 —— 桥挂了只是能力退化，不是歌词整块消失。
  bridge = null,
  now = () => Date.now(),
  budgetMs = ONLINE_BUDGET_MS,
  candidateLimit = ONLINE_CANDIDATE_LIMIT,
  log = () => {},
} = {}) {
  const cache = new Map();
  // 6.6：USLT（无时间轴内嵌词）曲目现在也会来问一次。真实未命中若不留痕，
  // 每次选中这首歌都会重打一遍检索接口——负缓存把它压成"每次进程生命周期内一次"。
  const misses = new Map();
  const inflight = new Map();
  const fingerprintOf = (song) => lyricIdentityFingerprint(song);

  const remember = (key, outcome) => {
    cache.set(key, outcome);
    if (cache.size > ONLINE_CACHE_LIMIT) cache.delete(cache.keys().next().value);   // FIFO，对齐上游 amllDbProvider 的 200 条量级思路
  };

  async function runMatch(song) {
    const startedAt = now();
    const query = buildLyricSearchQuery(song.title, song.artist, song.album);
    if (!query.trim()) return { matched: false, reason: '本地标题与歌手都是空的，无法检索' };
    /** 每个源各自给一句结论：未命中时"为什么没配上"必须能指到源，不能只说"没有"。 */
    const reasons = {};
    let lineByLineFallback = null;
    let bestScoreAcrossSources;
    /** 各源累计的近候选（60 ≤ 分数 < 75），跨源按分数降序截到 NEAR_CANDIDATE_LIMIT 条。 */
    const near = [];

    for (const source of LYRIC_SEARCH_SOURCES) {
      if (now() - startedAt > budgetMs) {
        reasons[source] = '在线匹配超时（预算 ' + budgetMs + 'ms 已用完），本地播放不受影响';
        break;
      }
      let search;
      try {
        search = await searchSource(source, { fetcher, bridge }, query);
      } catch (error) {
        reasons[source] = '检索失败：' + String(error?.message ?? error);
        continue;
      }
      if (!search.ok) { reasons[source] = search.reason; continue; }
      if (!search.candidates.length) { reasons[source] = '没有候选'; continue; }

      const ranked = search.candidates
        .map((candidate) => ({ candidate, details: calculateMatchScoreDetails(song, candidate) }))
        .sort((a, b) => b.details.score - a.details.score);
      const bestScore = ranked[0].details.score;
      bestScoreAcrossSources = Math.max(bestScoreAcrossSources ?? 0, bestScore);
      // R144：这一档没过线，但"差一点"的那几条要留给人看（阈值 75 一个字没改，这里只是不丢掉证据）。
      // 收集排在阈值下面、又不低于 60 的候选；`ranked` 已降序 ⇒ 遇到低于下限的就停。
      // **每个源各自限条数**，不按"累计到 8 条"停：那样第一个源会把后面几家饿掉，
      // 而最后跨源排序要的是全局前 8 名，不是"先问的那家的前 8 名"。
      let fromThisSource = 0;
      for (const { candidate, details } of ranked) {
        if (details.score < NEAR_CANDIDATE_MIN_SCORE) break;
        if (details.score >= AUTO_MATCH_MIN_SCORE) continue;
        if (fromThisSource >= NEAR_CANDIDATE_LIMIT) break;
        fromThisSource += 1;
        near.push(nearCandidateOf(source, candidate, details));
      }
      if (bestScore < AUTO_MATCH_MIN_SCORE) {
        reasons[source] = `最高分 ${bestScore}（阈值 ${AUTO_MATCH_MIN_SCORE}），最接近的是《${ranked[0].candidate.name}》`;
        continue;   // 这个源到此为止，下一个源可能配得上（四源之后这条才有意义）
      }

      let probed = 0;
      for (const { candidate, details } of ranked) {
        if (probed >= candidateLimit) break;
        // 上游硬门（autoMatchBestLyric.ts:100-101,122,128-131）：标题必须匹配，且歌手或专辑至少一项可信
        if (!(details.titleMatched && (details.artistMatched || details.albumMatched === true))) continue;
        probed += 1;
        if (now() - startedAt > budgetMs) {
          reasons[source] = '在线匹配超时（预算 ' + budgetMs + 'ms 已用完），本地播放不受影响';
          break;
        }
        try {
          const lyric = await fetchSourceLyric(source, { fetcher, decrypt, bridge }, candidate);
          const verdict = lyricVerdict(source, candidate, details, lyric);
          if (!verdict.ok) {
            reasons[source] = verdict.reason;
          } else if (verdict.wordByWord) {
            return verdict.outcome;                         // 逐字优先（上游 :431-436,499-504 的语义）
          } else {
            lineByLineFallback ??= verdict.outcome;         // 行级只暂存，继续找逐字
          }
        } catch (error) {
          reasons[source] = `${source} 取词失败：` + String(error?.message ?? error);
        }
        if (lineByLineFallback) continue;                   // 已经有行级结果时不必再兜底问 AMLL
        // QQ 没有可用词才试 AMLL（R59 的兜底位；AMLL 按 QQ 曲目 id 索引，只能挂在这里）
        try {
          const ttml = await fetchAmllTtml(fetcher, candidate.sourceId);
          if (ttml && hasTtmlLyricBody(ttml)) {
            return {
              matched: true,
              provider: 'amll',
              format: 'ttml',
              text: ttml,
              score: details.score,
              isWordByWord: true,
              timedLines: (ttml.match(/<p[\s>]/g) ?? []).length,
              matchedSong: matchedSongOf(candidate, details),
            };
          }
        } catch (error) {
          reasons.amll = 'AMLL 兜底失败：' + String(error?.message ?? error);
        }
      }
    }

    if (lineByLineFallback) return lineByLineFallback;
    const lastReason = Object.values(reasons).filter(Boolean).pop() ?? '未找到匹配歌词';
    // 跨源收集完再统一排序截断：源序（QQ→网易→酷狗）不是分数序。
    const nearSorted = near.sort((a, b) => b.score - a.score).slice(0, NEAR_CANDIDATE_LIMIT);
    log('online-lyrics: 未命中', { query, bestScore: bestScoreAcrossSources, near: nearSorted.length, reasons });
    return {
      matched: false,
      ...(bestScoreAcrossSources === undefined ? {} : { bestScore: bestScoreAcrossSources }),
      ...(nearSorted.length ? { near: nearSorted } : {}),
      reasons: { ...reasons },
      reason: `${lastReason}（四源逐档结论：${Object.entries(reasons).map(([name, why]) => `${name}=${why}`).join('；')}）`
        .slice(0, 600),
    };
  }

  return {
    /**
     * 本地曲目 → 在线歌词。同曲并发只发一次检索；命中结果进程内缓存（不落盘，本期定案）。
     * `force: true`（R144 的「重试匹配歌词」）绕过正负两份内存缓存重新问一次——
     * 绕的是**内存**，不是判据：阈值、逐字优先、实体声明拒绝全都照旧走一遍。
     */
    match(song, { force = false } = {}) {
      if (!song || !String(song.title ?? '').trim()) {
        return Promise.resolve({ matched: false, reason: '缺少可检索的标题' });
      }
      const key = fingerprintOf(song);
      if (force) { cache.delete(key); misses.delete(key); }
      const cached = cache.get(key);
      if (cached) return Promise.resolve(cached);
      // 6.6：负缓存只存"真的试过且没配上"，命中过一次就换成正缓存。
      // 用户改了标签 ⇒ 指纹（标题/歌手/专辑/时长）跟着变，自然会重新试，不会被这里卡住。
      const missed = misses.get(key);
      if (missed) return Promise.resolve({ ...missed, cached: 'miss' });
      const running = inflight.get(key);
      if (running) return running;
      const request = runMatch(song)
        .then((outcome) => {
          if (outcome.matched) remember(key, outcome);
          else {
            // 未命中也留痕（6.6）：异常出口走下面的 catch，不进这里，所以"网络炸了"不会被记成"这首歌没词"。
            // reasons 一起留（Task 5）：四源之后"为什么没配上"要能指到每一档，第二次读同一首也得看得见。
            misses.set(key, {
              matched: false, reason: outcome.reason ?? '未找到匹配歌词',
              ...(outcome.bestScore === undefined ? {} : { bestScore: outcome.bestScore }),
              ...(outcome.reasons ? { reasons: outcome.reasons } : {}),
              // R144：近候选一起留。否则第二次读同一首时"有候选可挑"这件事就消失了，
              // 用户只有先"重试"一次才看得见——那等于把出路藏起来。
              ...(outcome.near ? { near: outcome.near } : {}),
            });
            if (misses.size > ONLINE_MISS_CACHE_LIMIT) misses.delete(misses.keys().next().value);   // FIFO
          }
          return outcome;
        })
        .catch((error) => ({ matched: false, reason: '在线匹配异常：' + String(error?.message ?? error) }))
        .finally(() => inflight.delete(key));
      inflight.set(key, request);
      return request;
    },
    /**
     * R144 · 按**认领的身份**取一次词：不打分、不看阈值、不进任何缓存。
     *
     * 这是"人已经判过了"那条路——自动挡的判据对它一个字都不适用（适用就成了"人挑的还要机器批准"）。
     * 但**取词之后的判定共用**：计时行门槛、实体声明拒绝、逐字识别都走同一份 `lyricVerdict`，
     * 所以手动认领不会把一份被自动挡拒绝的坏载荷放出去。
     * 不写缓存：认领记录在磁盘上，每次读它都是现问现取；取消认领之后不该还剩一份内存结果。
     */
    async fetchClaimed(song, claim) {
      const candidate = candidateFromClaim(claim);
      const source = String(claim?.provider ?? '');
      if (!LYRIC_SEARCH_SOURCES.includes(source)) return { matched: false, reason: `认领记录里的来源不认识：${source || '（空）'}` };
      if (!candidate.sourceId) return { matched: false, reason: '认领记录里没有曲目标识，取不到词' };
      const details = { score: Number(claim?.score ?? 0) };
      try {
        const lyric = await fetchSourceLyric(source, { fetcher, decrypt, bridge }, candidate);
        const verdict = lyricVerdict(source, candidate, details, lyric);
        if (verdict.ok) return { ...verdict.outcome, claimed: true };
        return { matched: false, claimed: true, reason: verdict.reason };
      } catch (error) {
        return { matched: false, claimed: true, reason: `${source} 取词失败：` + String(error?.message ?? error) };
      }
    },
    /** 匹配缓存的键（= 认领记录的键）。只许这一处定义，别处再算一份就是第二个真源。 */
    fingerprint(song) { return fingerprintOf(song); },
    clearCache() {
      cache.clear();
      // 6.6：重扫会把这里一起清掉（music-server 的 /api/library/scan）——"上次没配到"不能跨越标签变更生效。
      misses.clear();
    },
  };
}

