// 本项目自撰（非移植代码）。在线音源取址：把"曲目身份"换成"一条可串流的 https CDN 地址"。
//
// 三源三形态，全部按 2026-10-05 一手实测写（数据在 memory/folia-port-p5-run-log.md 的 Task 6 段）：
//   · 网易——经桥（包里那一份实现我们不重抄）：`/song/url?id=&br=` 给 `http://m<数字>.music.126.net/….mp3`；
//     `/song/url/v1` 在这个 build 是 404，所以不试。
//   · QQ——本项目自写的 fcg 通道（与歌词同源，出网经 guardedFetch ⇒ 进得出网审计）：
//     匿名可用的是 `vkey.GetVkeyServer / CgiGetVkey`；需要登录的那条 `music.vkey.GetVkey / UrlGetVkey`
//     匿名实测 request.code=40000（Task 6），所以**登录那一档不在这个文件里裸发**，
//     而是经桥打包的 `/getMusicPlay`（R108：那里有解封会话要用的密钥与设备状态）⇒ 见 resolveQqAuthed。
//   · 酷狗——**2026-10-10（任务一 · R154）起接上了**，走桥（要包内那份安卓签名，父进程重抄就是第二个真相）。
//     两条一手实测决定了形状：① 要**登录态**（匿名只有 mid ⇒ 502 / `error_code 152`）；
//     ② `dfid` 必须**显式带空值**（上游读成 `-`）才给整首地址，不填时包自己塞一个随机 24 位串、那一档实测 502。
//     ⇒ 这条路上**没有** `register_dev`：伪装设备身份那一格用不上（R154 写清"授权保留、默认不用"）。
//     权益那一格由桥的 `kugouSongUrlToSource` 把关：**只用 `priv_status:1`**，
//     上游给了地址但 `priv_status:0`（那意味着"整首文件 + 片段偏移"）一律不用——不拿片段冒充整首，也不越权播整首。
//
// 三条与安全和可用性直接有关的形状，改动前先读：
//   ① 地址一律升 https：三家 CDN 实测 https 都可用（fsandroid.kugou.com 同主机 https 200/206 都对），
//      所以不必为音源放开明文这条规矩。**上游给多台候选时（酷狗 `urls` / QQ 的 sip 列表）优先挑
//      https 可用的那台**（R218 的 `pickHttpsAudioUrl`，判定就是出口那张 AUDIO_HOSTS 表）；
//      全都要么明文要么不可用 ⇒ 保持拒绝 + 出路文案，不为明文放行。
//   ② 解析结果按 TTL 缓存**在内存**：拖一次进度条会发好几笔 Range 请求，每笔都重问一次音源既慢又多几笔出网；
//     签名 URL 会过期，所以窗口给 5 分钟——失败不进缓存，否则一次抖动就把这首歌锁死。
//   ③ 拿回来的主机名必须再过一遍 AUDIO_HOSTS：桥与第三方接口都是"外部输入"，白名单不收在出口处就等于没收。
import { createHash } from 'node:crypto';
import { guardedFetch, hostAllowed, AUDIO_HOSTS, LYRICS_HOSTS, ONLINE_SEARCH_TIMEOUT_MS, KUGOU_PLAYINFO_HOSTS, KUGOU_PLAYINFO_TIMEOUT_MS } from './online-guard.mjs';
// R154（任务一）：酷狗 hash 的形状判据与桥那一侧**同一份**（引法与 `online-search.mjs` 引
// `bridge/providers/normalize.mjs` 同一条先例）。两处各写一份正则，迟早会一处收紧一处放宽。
import { KUGOU_HASH_SHAPE } from './bridge/providers/kugou-device.mjs';
// R141 回落的身份判据用**共享打分器**那一份（与歌词、歌单匹配同一处），这里不另写一套相似度算法。
import { calculateMatchScoreDetails } from './online-match-score.mjs';

const QQ_FCG = 'https://u.y.qq.com/cgi-bin/musicu.fcg';
// comm 与歌词通道用同一份（online-lyrics.mjs:22 那一条实测可用的安卓端 comm）；
// vkey 用控制器那一份网页端 comm（ct 24 / cv 0）——实测换 comm 会让搜索返 0 条，两套不能混用。
const QQ_COMM = { uin: '0', format: 'json', ct: 24, cv: 0 };
const QQ_HEADERS = { 'Content-Type': 'application/json', Cookie: 'tmeLoginType=-1;', 'User-Agent': 'okhttp/3.14.9' };
const QQ_GUID = '1429839143';

/** 质量降级序列（R80）：先试高的，拿不到 purl 再往下降。只收实测过得去的三档（flac/ape 匿名不给）。 */
export const AUDIO_QUALITY_ORDER = Object.freeze(['320', '128', 'm4a']);
/** 文件名两段式：前缀 + songmid + mediaMid + 后缀。缺 mediaMid 时用 songmid 补第二段（见下方注释）。 */
const QQ_FILE_TYPES = Object.freeze({ '320': ['M800', '.mp3'], '128': ['M500', '.mp3'], m4a: ['C400', '.m4a'] });

export const AUDIO_SOURCE_TTL_MS = 5 * 60 * 1000;
const AUDIO_SOURCE_CACHE_LIMIT = 64;
const AUDIO_KIND_MIME = Object.freeze({ mp3: 'audio/mpeg', m4a: 'audio/mp4', aac: 'audio/aac', flac: 'audio/flac', ogg: 'audio/ogg' });

/**
 * 音源地址升到 https（空/非 http(s) 一律当"没有可用地址"，不是"原样发出去"）。
 * 实测：QQ 的 sip 可能连 scheme 都不带（`aqqmusic.tc.qq.com`），这里一并补好再判。
 */
export function upgradeToHttps(rawUrl) {
  const text = String(rawUrl ?? '').trim();
  if (!text) return null;
  const withScheme = /^https?:\/\//i.test(text) ? text : /^www\.|^[a-z0-9-]+(\.[a-z0-9-]+)+\//i.test(text) ? `http://${text}` : null;
  if (!withScheme) return null;
  try {
    const url = new URL(withScheme);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    url.protocol = 'https:';
    return url.toString();
  } catch {
    return null;
  }
}

/** 由文件名/URL 猜音频类型；认不出来就交给调用方按 mp3 处理（内核会自己嗅探）。 */
export function audioKindOf(url) {
  const match = /\.([a-z0-9]{2,5})(?:[?#]|$)/i.exec(String(url ?? ''));
  const ext = match?.[1]?.toLowerCase();
  return ext && ext in AUDIO_KIND_MIME ? ext : null;
}

/**
 * R218：候选地址里挑**第一台 https 可用的**。判据与出口闸同源：`AUDIO_HOSTS` 就是实测 https 可用的
 * 主机表（`fs.youthandroid*` 那一族升 https 直接 TLS 证书名不匹配，所以不在表里）——
 * "优先挑 https 可用的那台"就是"优先挑过得了这张表的候选"，不另立第二套判定。
 *
 * 起因（验收侧现场 2026-10-13）：酷狗**按曲目给不同 CDN 主机**，其中一部分只有明文 ⇒ 从前只取
 * 第一条候选，第二条明明可用也被连带丢掉（「素颜」能播、「坏女孩」502 就是这一格）。
 *
 * 一条如实记（第四项核查）：**做不到"在取址请求里就要求 https"** —— 一手读过包内 `module/song_url.js`
 * 的全部参数（hash/quality/album_id/… 一串），没有任何协议选择项；上游回的就是 http 地址。
 * QQ 的 sip 与网易的 url 同理（sip 列表由上游给）。所以选主机只能在**结果**里做，本函数就是那一处。
 * **R221 给这句话补的边界（更正而不是推翻）**：那句"做不到"只对**包内那两条安卓档**成立——
 * 换一条端点（公开网页取址，`kugouWebPlayInfoUrl`）上游回的**本来就是 https**（实测 `https://sharefs.kugou.com`），
 * 所以"要求 https"这件事在**选端点**那一层是做得到的，本函数的判据仍然一个字没动。
 * 全都不合用 ⇒ 返回 null：调用方保持拒绝 + 出路文案，**绝不为明文放行**。
 */
export function pickHttpsAudioUrl(rawUrls) {
  const list = Array.isArray(rawUrls) ? rawUrls : [rawUrls];
  for (const entry of list) {
    const url = upgradeToHttps(entry);
    if (!url) continue;
    let host;
    try { host = new URL(url).hostname } catch { continue }
    if (hostAllowed(host, AUDIO_HOSTS)) return { url, host };
  }
  return null;
}

/** QQ 的 vkey 请求体（纯函数：自检不真出网也能验形状）。空 songmid 不发请求。 */
export function qqVkeyRequest({ songmid, mediaMid = '', quality = '128' } = {}) {
  const mid = String(songmid ?? '').trim();
  if (!mid) return null;
  const [prefix, extension] = QQ_FILE_TYPES[quality] ?? QQ_FILE_TYPES['128'];
  // mediaMid 缺席时用 songmid 补第二段：包内 qrLogin.js:434 的注释给了同一条结论——
  // 只送一段的文件名 vkey 服务器仍会给 purl，但 CDN 端 403，那时错误会变成"音源不可用"，很难查。
  const second = String(mediaMid ?? '').trim() || mid;
  return {
    module: 'vkey.GetVkeyServer',
    method: 'CgiGetVkey',
    param: {
      filename: [`${prefix}${mid}${second}${extension}`],
      guid: QQ_GUID,
      songmid: [mid],
      songtype: [0],
      uin: '0',
      loginflag: 1,
      platform: '20',
    },
  };
}

/**
 * vkey 响应 → 可播地址。两条一手实测的形状：
 * ① sip 可能不带 scheme，也**不带结尾斜杠**；purl **不带开头斜杠** ⇒ 直接字符串相加会把文件名
 *    拼进主机名（实测报 `ENOTFOUND aqqmusic.tc.qq.comm500….mp3`）。
 * ② 包内那份实现优先挑"不是 http://ws 开头"的 sip（getMusicPlay.js:90），这里保持一致：
 *    ws 那一批是只读优先项，不是不可用项——只剩它时照样能用。
 * R218：偏好顺序不变，但**逐台试**到第一台 https 可用的（`pickHttpsAudioUrl`）——从前只试一台，
 * 那台恰好在表外就把整首判死，而列表里明明还有别的候选。全不可用 ⇒ null（当"没有音源"处理）。
 */
export function qqPlayUrlFrom(data) {
  const sipList = (Array.isArray(data?.sip) ? data.sip : []).map((entry) => String(entry).trim()).filter(Boolean);
  const purl = String(data?.midurlinfo?.[0]?.purl ?? '').trim();
  if (!purl) return null;
  const ordered = [...sipList.filter((entry) => !/^http:\/\/ws/i.test(entry)), ...sipList.filter((entry) => /^http:\/\/ws/i.test(entry))];
  const picked = pickHttpsAudioUrl(ordered.map((base) => `${String(base).replace(/\/+$/, '')}/${purl.replace(/^\/+/, '')}`));
  if (!picked) return null;
  return { url: picked.url, kind: audioKindOf(purl) ?? 'mp3' };
}

/** 桥带回的 QQ **登录**音源 → 内部形状。两道关与网易那份一样：升 https、主机再过一遍 AUDIO_HOSTS
 *  （头部注释 ③：白名单不收在出口处等于没收）。
 *  这里**没有** scope：包的地址表不带试听标记，而界面上「试听 / 完整」的判据只准来自取址结果 ⇒ 不编。 */
export function qqAuthedAudioFrom(payload) {
  const url = upgradeToHttps(payload?.url);
  if (!url) return null;
  let host;
  try { host = new URL(url).hostname } catch { return null }
  if (!hostAllowed(host, AUDIO_HOSTS)) return null;
  return { url, kind: audioKindOf(url) ?? 'mp3' };
}

/** 桥报上来的网易音源 → 内部形状。字段名按 server.js 的 `/song/url` 响应（data[0].url/type/size）。 */
export function neteaseAudioFrom(payload) {
  const url = upgradeToHttps(payload?.url);
  if (!url) return null;
  let host;
  try { host = new URL(url).hostname } catch { return null }
  if (!hostAllowed(host, AUDIO_HOSTS)) return null;
  // M3-b：试听/完整这一档要一路带到界面。这里**只搬运桥算好的事实**（scope / trial.end / fee），
  // 不在父进程重算一遍判据——判据只有一处（audio-routes 里的 freeTrialInfo），两处算迟早会漂。
  return {
    url,
    kind: String(payload?.kind ?? payload?.type ?? audioKindOf(url) ?? 'mp3').toLowerCase(),
    size: Number(payload?.size ?? 0) || 0,
    ...(payload?.scope === 'trial' || payload?.scope === 'full' ? { scope: payload.scope } : {}),
    ...(payload?.trial?.end ? { trial: { end: Number(payload.trial.end) || 0 } } : {}),
    ...(Number(payload?.fee ?? 0) ? { fee: Number(payload.fee) } : {}),
  };
}

/**
 * 桥带回的酷狗音源 → 内部形状。出口闸与网易/QQ 那两份同一份（升 https + 主机过 `AUDIO_HOSTS`），
 * R218 起多一步**挑主机**：上游按曲目给多台 CDN（`urls` 候选表，桥侧原样带出），
 * 优先挑第一台 https 可用的再交给播放——从前只看第一条，第二条可用也会被连带丢掉。
 * `scope` 这里能带，是因为桥那一侧的判据是量出来的两格数字
 * （`status:1` + `priv_status:1` ⇒ 实测 content-range 的总长与 `fileSize` 逐位相等 = 整首），
 * 不是拿时长猜的（R101 那条明令禁止的形态）。
 */
export function kugouAudioFrom(payload) {
  // 候选表优先；只带单条 `url` 的旧形状（自检夹具与老响应）退回单元素列表，行为不变。
  const raw = (Array.isArray(payload?.urls) ? payload.urls : []).map((entry) => String(entry ?? '').trim()).filter(Boolean);
  if (!raw.length && payload?.url) raw.push(String(payload.url).trim());
  if (!raw.length) return { ok: false, provider: 'kugou', unavailable: true, reason: '酷狗没有回可用的音频地址（响应里的 url 是空的或形状不对）' };
  const picked = pickHttpsAudioUrl(raw);
  if (!picked) {
    // 这一档必须说准**为什么**不收：2026-10-10 实测，酷狗给的 CDN 主机族会漂，而 `fs.youthandroid*`
    // 那一族**升 https 直接 TLS 证书名不匹配**（`ERR_TLS_CERT_ALTNAME_INVALID`，逐条真取过 Range）。
    // 本机不为音频放开明文（安全四条①），所以这一档是"上游今天只给明文 CDN"——并**补上出路**
    // （R218：只说"不行"不够，用户要的是能听上；换一首或换一家源都是我们自己能走通的路）。
    // 标 `unavailable:true` 是让 R141 的回落去试另一家——用户要的是能播出声音，不是我们的表好看。
    const hosts = [...new Set(raw.map((entry) => {
      const url = upgradeToHttps(entry);
      if (!url) return '';
      try { return new URL(url).hostname } catch { return '' }
    }).filter(Boolean))];
    return { ok: false, provider: 'kugou', unavailable: true,
      reason: `酷狗这次给的音频主机（${hosts.join('、') || '形状认不出'}）不支持 https，本机不为音频走明文——换一首、或换一家源试试` };
  }
  return {
    ok: true,
    provider: 'kugou',
    url: picked.url,
    kind: String(payload?.kind ?? 'mp3').toLowerCase(),
    size: Number(payload?.size ?? 0) || 0,
    ...(payload?.scope === 'full' ? { scope: 'full' } : {}),
  };
}

/** 酷狗网页档那个公开端点（R221 · 一·二）；查询串只有 `cmd` 与 `hash` 两段，都来自我们自己。 */
const KUGOU_PLAYINFO_ENDPOINT = 'https://m.kugou.com/app/i/getSongInfo.php';
/**
 * 网页档那一跳的地址（纯函数）。**形状不对就 null**：hash 必须是 32 位十六进制（与桥那一侧同一份
 * `KUGOU_HASH_SHAPE`），拼进查询串之前已经小写归一。查询串里没有第三段来自上游或用户输入的片段
 * ⇒ 这一跳没有注入面（与"接受外部地址"的那一类改动划清界限）。
 */
export function kugouWebPlayInfoUrl(hash) {
  const text = String(hash ?? '').trim();
  if (!KUGOU_HASH_SHAPE.test(text)) return null;
  return `${KUGOU_PLAYINFO_ENDPOINT}?cmd=playInfo&hash=${text.toLowerCase()}`;
}

/** `url` / `backup_url` 三种实测形状：数组、逗号接的多条串、以及"没有"时的空串或空对象 `{}`。 */
function kugouWebPlayInfoUrls(payload) {
  const list = [];
  for (const field of ['url', 'backup_url']) {
    const raw = payload?.[field];
    const parts = Array.isArray(raw) ? raw : typeof raw === 'string' ? raw.split(/,\s*(?=https?:\/\/)/i) : [];
    for (const entry of parts) {
      const text = String(entry ?? '').trim();
      if (/^https?:\/\//i.test(text)) list.push(text);
    }
  }
  return list;
}

/**
 * 网页档响应 → 内部形状（R221）。四条闸全是**量出来的**，不是照字段名猜的
 * （一手数据在 `memory/kugou-addressing-identity-r221-run-log.md` §一.4，同一首两次读数逐字相同）：
 *   ① `status === 1`——实测 `status:0` 那一档 `error` 写「需要付费」、`url` 是空串、`fileSize` 是 0；
 *   ② 地址里必须带 **`/yp/full/`** 这一段——同一首的**片段**形态在另一条路上是 `/yp/p_0_<字节数>/`
 *      （R154 那条"不拿片段冒充整首"的判据在这一档只有这一个可观察形状）；认不出这个标记就当没有地址，
 *      **只做减法**：这条只会少播，不会越权播；
 *   ③ `fileSize > 0`——上游自己声明的整首体积（实测 4112408B 与 CDN 那条 `content-range` 的总长逐位相等）；
 *   ④ 主机与协议仍然**不在这里判**：交回 `pickHttpsAudioUrl` 走同一张 `AUDIO_HOSTS`（出口闸只有一处）。
 * `privilege` 那一格**故意不参与判定**：只量到 0/8 给地址、10 不给地址三档，语义没量全的字段不许当权益判据。
 */
export function kugouWebPlayInfoToSource(body) {
  const payload = body && typeof body === 'object' ? body : {};
  const urls = kugouWebPlayInfoUrls(payload);
  const status = Number(payload.status);
  if (status !== 1) {
    const paid = String(payload.error ?? '').includes('需要付费');
    return {
      ok: false,
      // 权益事实与通道坏了要分开（与桥那份 `kugouSongUrlToSource` 同一口径）：
      // 「需要付费」标 denied ⇒ 调用方给 unavailable，让 R141 的回落去试另一家。
      ...(paid ? { denied: true } : {}),
      reason: paid
        ? '酷狗网页这一档说这首要付费（本机不拿片段冒充整首，也不替账号越权）'
        : `酷狗网页这一档没有回可播文件（status:${Number.isFinite(status) ? status : '空'}）`,
    };
  }
  const fullUrls = urls.filter((entry) => entry.includes('/yp/full/'));
  if (!fullUrls.length) {
    return { ok: false, reason: urls.length
      ? '酷狗网页这一档给的不是整首文件（路径里没有那个整首标记），本机不用片段'
      : '酷狗网页这一档没给地址（status:1 但 url 是空的）' };
  }
  const size = Number(payload.fileSize ?? 0) || 0;
  if (!size) return { ok: false, reason: '酷狗网页这一档没回文件体积（fileSize 空或 0），不当整首播' };
  return {
    ok: true,
    urls: fullUrls,
    size,
    kind: String(payload.extName ?? 'mp3').toLowerCase() || 'mp3',
    durationSec: Number(payload.timeLength ?? 0) || 0,
    scope: 'full',
  };
}

/**
 * R141 回落的候选集合。2026-10-10 起是三家（任务一把酷狗接成了第三个可播源），
 * 所以这张表就是这三家——**写死而不是从 AUDIO_PROVIDERS 推**：推出来的集合会随 AUDIO_PROVIDERS 扩大而
 * 悄悄多出一个"会被检索并被取址"的目标，那正是我们不该有的那种自动扩张。
 * 酷狗这一家有个前置条件（一手实测：要登录态才给可播文件），那个条件由 `search` 那一侧如实报原因，
 * 不在这里假装它随时可用。
 */
export const AUDIO_FALLBACK_SOURCES = Object.freeze(['netease', 'qq', 'kugou']);
/** 曲名允许"近逐字"的下界：0.95 意味着归一后只差把标点/空白级别的差异，不接受"挺像"。 */
const FALLBACK_TITLE_MIN_SIMILARITY = 0.95;
/** 两边时长都知道时允许的差（毫秒）。差得多就不是同一版录音，宁可不回落。 */
const FALLBACK_DURATION_TOLERANCE_MS = 3_000;

/**
 * 回落的身份判据：**用共享打分器那一份**（`calculateMatchScoreDetails`），不另起一套匹配。
 * 三条：曲名逐字或近逐字、歌手 `artistMatched`、两边时长都已知时 |Δ| ≤ 3 秒。
 * 专辑那一维**故意不看**——回落要救的正是"这首歌在另一家的目录里"，而另一家的专辑名天然不同
 * （与 R140 那条窄规则同一个事实，但这里不需要它：回落不问专辑分）。
 */
export function fallbackIdentityOk(identity, candidate) {
  if (!candidate?.title || !candidate?.artist) return false;
  const details = calculateMatchScoreDetails(
    { title: identity.title, artist: identity.artist, album: '', durationMs: Number(identity.durationMs ?? 0) },
    { name: candidate.title, artists: [{ name: candidate.artist }], album: { name: candidate.album ?? '' }, durationMs: Number(candidate.durationMs ?? 0) },
  );
  if (details.titleSimilarity < FALLBACK_TITLE_MIN_SIMILARITY) return false;
  if (!details.artistMatched) return false;
  const target = Number(identity.durationMs ?? 0);
  const found = Number(candidate.durationMs ?? 0);
  if (target > 0 && found > 0 && Math.abs(target - found) > FALLBACK_DURATION_TOLERANCE_MS) return false;
  // 任一侧时长缺失 ⇒ 允许（"不知道"不等于"差很多"），但只允许在曲名与歌手都过关之后。
  return true;
}

/**
 * R225 · 这家现在有没有登录态（回落的尝试顺序读这一格）。判据**不另起一套**，对齐两侧既有那条：
 *   · 网易 / 酷狗看 cookie 头（就是 `attempt` 里进缓存键摘要的那一份，形状由 `credentialsFor` 定）；
 *   · QQ 看 **token 与密钥两样都齐**（与 `resolveQq` 那句 `session = token && secret ? … : null` 同一立场：
 *     半份凭据发出去只换一个 501 —— R108 的判据原话"缺一样就不算登录态"）。
 * 与缓存键那条的唯一差别如实记在这里：半份 QQ 凭据今天仍换一把**独立**的键（那确实是一种凭据状态，
 * 不许和匿名互相吃缓存），而在排序上算"没登录" ⇒ 排到表尾。
 */
export function audioCredentialsSignedIn(provider, credentials = {}) {
  if (provider === 'qq') return !!String(credentials?.token ?? '').trim() && !!String(credentials?.secret ?? '').trim();
  return !!String(credentials?.cookie ?? '').trim();
}

/**
 * 界面可以随请求带来的"这首歌是谁"（只用于回落的检索与挑选，**绝不当地址或主机用**）。
 * 形状把关与歌词那一路同源：文本字段必须是非空短字符串，时长必须是 0~3600000 毫秒。
 */
export function onlineAudioIdentityFrom(value) {
  const raw = value?.online;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const text = (field) => {
    const item = raw[field];
    if (typeof item !== 'string') return '';
    const trimmed = item.trim().slice(0, 120);
    return trimmed;
  };
  const title = text('title');
  const artist = text('artist');
  if (!title || !artist) return null;
  const duration = Number(raw.durationMs ?? 0);
  if (!Number.isFinite(duration) || duration < 0 || duration > 3_600_000) return null;
  return { title, artist, durationMs: Math.round(duration) };
}

/**
 * 建一个取址器。`fetcher` / `bridge` 都可注入（自检走假的 ⇒ 这一层能离线判定），
 * 生产路径用 guardedFetch + 真实桥客户端。
 */
export function createAudioSourceResolver({
  bridge,
  fetcher = guardedFetch,
  now = () => Date.now(),
  timeoutMs = ONLINE_SEARCH_TIMEOUT_MS,
  // M3-b：登录态的取用口（`async (provider) => ({ cookie?, token?, secret? })`）。不给就是永远匿名——
  // 音源这条链在没登录时行为与今天逐字一致，是刻意的默认。两家给的东西不同：
  // 网易是一段 cookie 头（包自己会解），QQ 是**密封 token + 解封用的密钥**两样
  // （这个运行时的包无状态，每次鉴权请求都要父进程把这两样一起交给桥，见 R107）。
  credentialsFor,
  // R154（任务一）：酷狗的设备身份由**父进程**持有、桥每次借用（与 QQ 的 token+secret 同一个模型）。
  // 这一档不给就是"酷狗永远取不到址"，而不是"退化成匿名"——它没有匿名那一档（一手实测）。
  // `saveKugouDevice` 是回写口：mid 可能是桥第一次算出来的（包内 calculateMid），dfid 只有真启用备用路才会变。
  saveKugouDevice = null,
  // R141：回落要能"按曲名歌手去另一家找同名曲"。不注入 ⇒ 永远不回落，行为与今天逐字一致
  // （这是刻意的默认：宁可不救，也不要在没有检索能力的地方猜一首歌）。
  search = null,
} = {}) {
  const cache = new Map();
  const cached = (key, value) => {
    // 定长：一次会话听几百首不能把进程撑爆。Map 按插入序迭代，所以淘汰的是最早那一个。
    if (cache.size >= AUDIO_SOURCE_CACHE_LIMIT) {
      const oldest = cache.keys().next().value;
      if (oldest !== undefined) cache.delete(oldest);
    }
    cache.set(key, { ...value, at: now() });
    return value;
  };

  /** 带着登录态问桥一次（R108）。这一档失败**不**算错：权益不够、桥坏了、地址主机不收，
   *  三种都该回到匿名那条老路去，而不是把这首歌判成"没有音源"。 */
  const resolveQqAuthed = async ({ mediaId, mediaMid, session }) => {
    if (!bridge?.call) return { ok: false, via: 'bridge', reason: '桥不在（QQ 登录取流要经它）', retryable: true };
    let result;
    try {
      result = await bridge.call('/bridge/auth', {
        action: 'play', provider: 'qq', songmid: mediaId,
        ...(mediaMid ? { mediaMid } : {}), token: session.token, secret: session.secret,
      });
    } catch (error) {
      return { ok: false, via: 'bridge', reason: error?.message ?? String(error), retryable: true };
    }
    if (!result?.ok) return { ok: false, reason: result?.reason ?? '桥没有回 QQ 音源' };
    const source = qqAuthedAudioFrom(result);
    if (!source) return { ok: false, reason: 'QQ 登录取到的地址不在音源主机白名单内（不收在出口处等于没收）' };
    return { ok: true, provider: 'qq', ...source };
  };

  const resolveQq = async ({ mediaId, mediaMid, session }) => {
    let authedReason = '';
    if (session) {
      const authed = await resolveQqAuthed({ mediaId, mediaMid, session });
      if (authed.ok) return authed;
      authedReason = String(authed.reason ?? '').slice(0, 80);
      // 登录这一档没给地址 ⇒ 降到匿名老路。这条降级是"少播"而不是"越权播"，
      // 而它必须**留得下痕迹**：最后一档还是空的时候，原因里要说"带登录态问过、也没给"，
      // 否则用户看到的"没有可用免费音源"会误导成"没登录所以不行"（其实登录了也不行）。
    }
    // 降级序列：320 → 128 → m4a。每一档都是一笔独立的 fcg 调用（匿名能给的那一档各曲不同）。
    for (const quality of AUDIO_QUALITY_ORDER) {
      const request = qqVkeyRequest({ songmid: mediaId, mediaMid, quality });
      if (!request) return { ok: false, reason: '缺少 QQ 曲目标识（songmid）' };
      let payload;
      try {
        const response = await fetcher(QQ_FCG, {
          method: 'POST', headers: QQ_HEADERS, hosts: LYRICS_HOSTS, kind: 'audio', timeoutMs,
          body: JSON.stringify({ comm: QQ_COMM, request }),
        });
        if (!response.ok) return { ok: false, reason: `QQ 音源接口 HTTP ${response.status}` };
        payload = response.json();
      } catch (error) {
        return { ok: false, reason: `QQ 音源请求失败：${error?.message ?? error}` };
      }
      const data = payload?.request?.data ?? {};
      const source = qqPlayUrlFrom(data);
      if (source) return { ok: true, ...source, provider: 'qq' };
      // 空 purl 在这条通道里的含义是"这一档没有可播文件"（实测付费曲就是这样），继续降下一档。
    }
    // `unavailable: true` 是给回落用的**分类**，不是文案：这一档说的是"平台确实不给这首歌的文件"，
    // 与"桥没起来 / HTTP 坏了 / 地址主机不收"那几类分开（那几类不许触发回落——换源也还是坏的，
    // 而且会把一次网络抖动变成四笔额外出网）。
    return { ok: false, provider: 'qq', unavailable: true, reason: session
      // 登录那一问的原因要留在文案里：只说"匿名没有"会把"这个账号也没有权益"写成"没登录所以不行"。
      ? `带着登录态问过这一首（${authedReason || '桥没给原因'}），匿名通道同样没有可播文件`
      : '这首没有可用的免费音源（QQ 匿名通道只给非付费曲的完整文件；登录后才有全部曲目）' };
  };

  /**
   * 酷狗取址一跳（R154；R221 起有**两档**）。四条把关各管一件事：
   *   · **hash 形状不对就连桥都不问**（32 位十六进制是实测 `FileHash` 的形状；认不出的 id 不配占用一次包调用）；
   *   · **没有本机 guid 就不问桥**（问了只会得到一句"算不出 mid"，还多一笔桥内跳）；
   *   · **没有登录态就直接给"这一家要登录"**，并且 `unavailable:true` —— 它是**权益事实**，
   *     与"桥没起来 / HTTP 坏了"那几类分开（后者不许触发回落，见 resolveFallback 那条把关 ①）；
   *     这一档**零出网**：父进程不问桥，桥就不会打酷狗，**也不问网页档**
   *     （网页档那一跳只在"有登录态但签名档没给出可用地址"之后才走，所以未登录用户的出网面一个字节没多；
   *     要不要让未登录也去播那一部分免费曲 = 改既有判据的形状，记在 R221 的待拍板里，本批不自作主张）；
   *   · 地址回到父进程这里再过一次 `AUDIO_HOSTS`（头部注释 ③，与网易/QQ 同一条出口纪律）。
   *
   * R221 加的那一档（一手实测 2026-10-14）：**签名档给不出可播地址时，问一次公开网页取址那一跳**。
   * 为什么要加：包内两条取址路（`/v5/url` 与 `/v6/priv_url`）带的都是**安卓客户端身份**
   * （`encryptType:'android'` + `pid 411 / appid 3116 / page_id`，主机与文件路径就绑在这套身份上），
   * 而今天带登录态那一档被上游整片拒回 `502 / error_code 31833 "illegal key"`（同一份凭据的 `search`
   * 仍回 200 ⇒ **不是会话过期**，是那一条端点的校验变了；上游 main 分支与钉住的 v1.6.0 逐字相同 ⇒
   * 升级依赖也换不来另一档参数）。读数在 `memory/kugou-addressing-identity-r221-run-log.md`。
   * 这一档**零伪装**：不需要任何请求头（实测零头回 200）、不带设备标识、不带凭据。
   * 桥本身抛错/没桥那两类**不走这一跳**——那是"我们这侧没就绪"，多一笔出网救不回来，
   * 而且会把一次抖动变成两笔。
   */
  const resolveKugou = async ({ hash, cookie, device, albumId = '', albumAudioId = '' }) => {
    if (!KUGOU_HASH_SHAPE.test(hash)) return { ok: false, provider: 'kugou', reason: '酷狗曲目标识形状不对（要 32 位十六进制 hash），没有去问桥', retryable: false };
    if (!bridge?.call) return { ok: false, via: 'bridge', reason: 'bridge-off', retryable: false };
    if (!device?.guid) return { ok: false, via: 'bridge', reason: '本机还没有酷狗设备标识（guid）', retryable: true };
    if (!cookie) return { ok: false, provider: 'kugou', unavailable: true, reason: '酷狗这一家要登录才给可播文件（本机没有酷狗登录态）', retryable: false };
    let signed = null;
    let signedFailure = null;
    let result;
    try {
      result = await bridge.call('/bridge/audio-source', { provider: 'kugou', mediaId: hash, cookie, device,
        ...(albumId ? { albumId } : {}), ...(albumAudioId ? { albumAudioId } : {}) });
    } catch (error) {
      return { ok: false, via: 'bridge', reason: error?.message ?? String(error), retryable: true };
    }
    // 桥算出来的那一份身份存回去（mid 第一次是桥算的；dfid 只有真启用备用路才会变）。写失败不影响这一跳的结果。
    if (result?.device && saveKugouDevice) await Promise.resolve(saveKugouDevice(result.device)).catch(() => {});
    if (result?.ok) signed = kugouAudioFrom(result);
    else signedFailure = { ok: false, provider: 'kugou', ...(result?.unavailable === true ? { unavailable: true } : {}),
      reason: result?.reason ?? '桥没有回酷狗音源', retryable: result?.retryable ?? true, ...(result?.via === 'bridge' ? { via: 'bridge' } : {}) };
    if (signed?.ok) return signed;
    // 签名档这一跳没给出可用地址 ⇒ 网页档问一次（它自己那四条闸在 `kugouWebPlayInfoToSource` 里）。
    const web = await resolveKugouWebPlayInfo(hash);
    if (web.ok) return web;
    // 两档都不给 ⇒ **签名档那句原因留着**（它说的是权益或主机这些已经量到的事实），网页档那句接在后面，
    // 两句都在才算说清"问过两次、各自怎么答的"。分类取**两者里更宽的那一个**：
    // 任何一档把它判成权益事实（unavailable）⇒ 让 R141 的回落去试另一家（用户要的是能出声）。
    const signedReason = String(signed ? signed.reason : signedFailure.reason).slice(0, 120);
    return {
      ok: false, provider: 'kugou',
      ...(signedFailure?.unavailable === true || signed?.unavailable === true || web.unavailable === true ? { unavailable: true } : {}),
      reason: `${signedReason}；网页那一档：${String(web.reason ?? '没给原因').slice(0, 120)}`,
      retryable: signedFailure?.retryable ?? true,
    };
  };

  /**
   * 网页档一跳（R221）。三件事按顺序卡着：形状（`kugouWebPlayInfoUrl` 内含 hash 闸）→ 出网（专用主机表
   * `KUGOU_PLAYINFO_HOSTS`，只有 `m.kugou.com`）→ 结果（`kugouWebPlayInfoToSource` 的四条闸 +
   * 出口那张 `AUDIO_HOSTS`）。**不带凭据、不带任何请求头**（实测零头回 200）。
   */
  const resolveKugouWebPlayInfo = async (hash) => {
    const url = kugouWebPlayInfoUrl(hash);
    if (!url) return { ok: false, reason: '曲目标识形状不对，没问网页那一档' };
    let body;
    try {
      const response = await fetcher(url, { hosts: KUGOU_PLAYINFO_HOSTS, kind: 'audio', timeoutMs: KUGOU_PLAYINFO_TIMEOUT_MS });
      if (!response.ok) return { ok: false, reason: `网页那一档 HTTP ${response.status}` };
      body = response.json();
    } catch (error) {
      // `OnlineTargetError`（白名单/SSRF/体积挡下）与网络层失败都归"这一档问不到"，不判死、不冒充权益事实。
      return { ok: false, reason: `网页那一档没问成（${String(error?.message ?? error).slice(0, 60)}）` };
    }
    const parsed = kugouWebPlayInfoToSource(body);
    if (!parsed.ok) return { ok: false, ...(parsed.denied === true ? { unavailable: true } : {}), reason: parsed.reason };
    const picked = pickHttpsAudioUrl(parsed.urls);
    if (!picked) {
      const hosts = [...new Set(parsed.urls.map((entry) => { try { return new URL(entry).hostname } catch { return '' } }).filter(Boolean))];
      return { ok: false, unavailable: true, reason: `网页那一档给的主机（${hosts.join('、') || '形状认不出'}）不在实测 https 可用的表里，本机不为音频走明文` };
    }
    return { ok: true, provider: 'kugou', url: picked.url, kind: parsed.kind, size: parsed.size, scope: parsed.scope };
  };

  const resolveNetease = async ({ mediaId, cookie }) => {
    if (!bridge?.call) return { ok: false, via: 'bridge', reason: 'bridge-off', retryable: false };
    let result;
    try {
      result = await bridge.call('/bridge/audio-source', { provider: 'netease', mediaId, ...(cookie ? { cookie } : {}) });
    } catch (error) {
      return { ok: false, via: 'bridge', reason: error?.message ?? String(error), retryable: true };
    }
    if (!result?.ok) {
      // `via:'bridge'` 是"我们这一侧没就绪"（桥/包没起来）与"上游确实没有这条音源"的分界，
      // 路由据此回 503 而不是 502——文案要分开，用户才知道该等还是要换歌。
      return { ok: false, via: result?.reason ? 'bridge' : undefined, reason: result?.reason ?? '桥没有回音源', retryable: result?.retryable ?? true };
    }
    const source = neteaseAudioFrom(result);
    if (!source) return { ok: false, provider: 'netease', unavailable: true, reason: result?.reason ?? '这首没有可用的网易音源（VIP 曲会给 30 秒试听片段，其余曲目匿名拿不到地址）' };
    return { ok: true, provider: 'netease', ...source };
  };

  /**
   * 问一家拿地址（含登录态与缓存键的推导）。`resolve` 与回落**共用这一份**——
   * 两条路必须走同一套凭据与同一个键口径，否则"回落拿到的整首"就绕开了"登录态进缓存键"那条纪律（R101）。
   */
  const attempt = async (provider, id, mediaMid, albumId = '', albumAudioId = '') => {
    // M3-b：登录态进缓存键。**不这么做的后果是具体的**：匿名取到的 30 秒地址会在登录后继续被喂 5 分钟
    // （用户"登录了还是试听"），反过来登录后取到的整首地址会在退出后继续被喂 5 分钟（越权播放）。
    // 键里放的是凭据的短摘要而不是凭据本身——内存里那把 key 会被自检打印出来，别把凭据捎进去。
    // R108 把它从"只有网易"推广成两家：QQ 那一份的摘要取的是**密封 token**，
    // 而不是解封它用的密钥（密钥每台机器固定，拿它当身份会把"同机换账号"判成同一个登录态）。
    // R154 把它从"只有网易与 QQ"推广成三家：酷狗那一份凭据是一段 cookie 头（token+userid），
    // 摘要进键 ⇒ "登录后才给整首、退出后不该继续吃那条地址"这一格在结构上成立（与 R101 同一个理由）。
    const credentials = credentialsFor ? await credentialsFor(provider).catch(() => ({})) : {};
    const cookie = provider === 'netease' || provider === 'kugou' ? String(credentials.cookie ?? '') : '';
    const device = provider === 'kugou' ? (credentials.device ?? null) : null;
    const token = provider === 'qq' ? String(credentials.token ?? '') : '';
    const secret = provider === 'qq' ? String(credentials.secret ?? '') : '';
    const session = token && secret ? { token, secret } : null;
    const tag = (cookie || token) ? createHash('sha256').update(cookie || token).digest('hex').slice(0, 12) : 'anon';
    // R222：专辑参数也进键——它们会改变**第一跳问出去的形状**（带专辑 → 纯 hash），
    // 同一首带着与不带它们不该互相吃对方的缓存（只在酷狗那一格非空，其它源恒为 `-`）。
    const albumHint = `${String(albumId ?? '').trim()}-${String(albumAudioId ?? '').trim()}`;
    const key = `${provider}:${id}:${String(mediaMid ?? '').trim()}:${albumHint}:${tag}`;
    const hit = cache.get(key);
    if (hit && now() - hit.at < AUDIO_SOURCE_TTL_MS) return { value: { ...hit, cached: true }, key };
    const value = provider === 'netease' ? await resolveNetease({ mediaId: id, cookie })
      : provider === 'qq' ? await resolveQq({ mediaId: id, mediaMid, session })
        : provider === 'kugou' ? await resolveKugou({ hash: id, cookie, device, albumId, albumAudioId })
          : { ok: false, provider, reason: `不支持的音源：${provider}`, retryable: false };
    if (value.ok) return { value: cached(key, value), key };   // 失败不进缓存：一次抖动不该把这首歌锁死 5 分钟
    return { value, key };
  };

  /**
   * 回落的**尝试顺序**（R225 · 用户口径"那家取不到 ⇒ 落到其它**正登录着**的源"）：
   * 其余源里当前有登录态的排在前，没登录的**留在表尾**（不跳过——匿名通道对免费曲那一半仍有价值），
   * 两组内部保持 `AUDIO_FALLBACK_SOURCES` 的原序（这条表本身仍是写死的三家，不因排序而扩张）。
   * 代价与副作用如实记：每笔回落在检索前多问最多两次 `credentialsFor` —— 那是**纯本机会话文件读、不出网**；
   * 唯一副作用是"酷狗已登录但设备文件还没建"时会被这一次问话提前建出来（取址酷狗本来就要建它，不是新增能力）。
   * 没接凭据门时（匿名形态与既有自检夹具）顺序与今天逐字一致。
   */
  const fallbackOrder = async (from) => {
    const others = AUDIO_FALLBACK_SOURCES.filter((entry) => entry !== from);
    if (!credentialsFor) return others;
    const signedIn = [];
    const anonymous = [];
    for (const provider of others) {
      const credentials = await credentialsFor(provider).catch(() => ({}));
      (audioCredentialsSignedIn(provider, credentials) ? signedIn : anonymous).push(provider);
    }
    return [...signedIn, ...anonymous];
  };

  /**
   * R141 音源回落：主源说"这首我没有可播文件"（`unavailable`）时，用「曲名 + 歌手」在**其余源**里找同名曲，
   * 只有拿到 `scope:'full'` 的那一条才采用——回落要的是"从不播变成整首"，不是"从不播变成试听"
   * （换成 30 秒试听不叫救回来，那叫悄悄换了一首歌播）。
   *
   * 三条把关（R225 一条没松，只改了**尝试顺序**）：
   *   ① 只在 `unavailable` 这一类失败上触发。鉴权失败、桥没起来、HTTP 坏了、地址主机不收一律不回落
   *      ——换源也还是坏的，而且会把一次网络抖动变成额外的检索 + 取址。
   *   ② 身份判据**用同一份打分器**（`calculateMatchScoreDetails`），不另起一套匹配：
   *      曲名逐字或近逐字（≥0.95）、歌手 `artistMatched`、两边时长都已知时 |Δ| ≤ 3 秒。
   *      要的是"同一首歌在另一家的目录"，不是"另一首像的歌"。
   *   ③ 成功与失败都按**原来那把键**处理：成功时把这条事实也存进原键（徽标查询与随后的取流看到同一条），
   *      失败时保留平台那句原话、在后面补一句"回落也没找到"，不替换成别的原因。
   */
  const resolveFallback = async ({ from, identity }) => {
    const tried = [];
    for (const other of await fallbackOrder(from)) {
      let items;
      try {
        const found = await search({ query: `${identity.title} ${identity.artist}`.trim(), provider: other, limit: 10, offset: 0 });
        if (found?.ok === false) { tried.push(`${other}：${String(found.reason ?? found.error ?? '检索没成').slice(0, 60)}`); continue; }
        items = found?.items ?? [];
      } catch (error) {
        tried.push(`${other}：检索抛了（${String(error?.message ?? error).slice(0, 60)}）`);
        continue;
      }
      const candidate = items.find((item) => item?.provider === other && fallbackIdentityOk(identity, item));
      if (!candidate) { tried.push(`${other}：检索 ${items.length} 条，没有逐字/近逐字的同名曲`); continue; }
      const candidateId = String(candidate.mediaId ?? '').trim();
      if (!/^[A-Za-z0-9_-]{1,64}$/.test(candidateId)) { tried.push(`${other}：候选的曲目标识形状不对`); continue; }
      const next = await attempt(other, candidateId, String(candidate.mediaMid ?? '').trim(),
        String(candidate.albumId ?? '').trim(), String(candidate.albumAudioId ?? '').trim());
      if (!next.value?.ok) { tried.push(`${other}：取址没成（${String(next.value?.reason ?? '').slice(0, 60)}）`); continue; }
      if (next.value.scope !== 'full') { tried.push(`${other}：只给「${next.value.scope ?? '播放范围未知'}」，不是完整播放`); continue; }
      return { ...next.value, fallback: { from, to: other, tried } };
    }
    return null;
  };

  return {
    /** provider 不在集合里 / id 形状不对 ⇒ 不发任何请求，直接拒（参数把关只这一处）。
     *  `albumId`/`albumAudioId`（R222）是酷狗那一格的**可选**取址提示：带着就先按"带专辑"问一次，
     *  失败自动退回纯 hash（见 `bridge/audio-routes.mjs` 的 `kugouVariants`）；认不出的值一律当没带。 */
    resolve: async ({ provider, mediaId, mediaMid, albumId, albumAudioId, identity } = {}) => {
      const id = String(mediaId ?? '').trim();
      if (!AUDIO_PROVIDERS.includes(provider)) return { ok: false, reason: `不支持的音源：${provider || '（空）'}`, retryable: false };
      if (!/^[A-Za-z0-9_-]{1,64}$/.test(id)) return { ok: false, reason: '曲目标识形状不对', retryable: false };
      const hint = (value) => (/^\d{1,20}$/.test(String(value ?? '').trim()) ? String(value).trim() : '');
      const primary = await attempt(provider, id, mediaMid, hint(albumId), hint(albumAudioId));
      if (primary.value.ok) return primary.value;
      // 没给身份（或没接检索）时**行为与今天逐字一致**：不回落、不多发一个包。
      if (primary.value.unavailable !== true || !identity?.title || !identity?.artist || !search) return primary.value;
      const rescued = await resolveFallback({ from: provider, identity });
      if (!rescued) return { ...primary.value, fallbackTried: true,
        reason: `${primary.value.reason ?? '主源没有可播文件'}（回落其余音源也没找到能完整播放的同名曲）` };
      // 按**原来那把键**再存一份：这首歌之后的徽标与取流都走这条已确认的事实（登录态仍在键里）。
      cache.set(primary.key, { ...rescued, at: now() });
      return rescued;
    },
    /** 自检与"重扫/换源"时用来清内存里的地址（不写盘，也就没有落盘残留）。 */
    clearCache: () => { cache.clear(); return { cleared: true } },
    cacheSize: () => cache.size,
    /** 缓存键的可读出口：自检用它证明"键里没有凭据，只有短摘要"（键本身会被打印，凭据不能进去）。 */
    cacheKeys: () => [...cache.keys()],
  };
}

// resolve 里引用的是本模块下面那份 AUDIO_PROVIDERS：const 声明在调用点之后没问题，
// 因为 resolve 只会在模块求值完成之后被调用（自检与路由都是）。
/** 今天可取的音源集合（三家都在：R154 起酷狗是第三个可播源，条件是**已登录**）。 */
export const AUDIO_PROVIDERS = Object.freeze(['netease', 'qq', 'kugou']);

export const audioSourceMime = (kind) => AUDIO_KIND_MIME[String(kind ?? '').toLowerCase()] ?? 'audio/mpeg';
