// 本项目自撰（非移植代码）。桥的业务路由：歌词通道（网易 / 酷狗）。
//
// 路由表的形状是"一个入口 + source 参数"，不是每源一条：服务端只管"要哪个源的什么动作"，
// 桥只管把它翻译成各家包的调用形状。Task 6/7/10/12 会照这个样式继续挂音源、搜索、歌单、登录。
//
// 三条与安全/可用性有关的约定：
//   ① 失败也回 200 + { ok:false, reason }：桥内不许用 5xx 把"没配上"伪装成"出错了"（父进程据此回退本地）。
//   ② 每次调用都带 `provider` 字段 ⇒ 桥的审计行用它当 host 标识（R75：包内部再发什么我们包不住，
//      但"被叫了几次、成没成"要能摊开）。
//   ③ 后端没起来就是 `ok:false`，不抛：起不来一个后端不该让整条路由变成异常。
import { kugouLyricToText, kugouSearchToCandidates, ncmLyricToText, ncmSearchToCandidates, sourceFailure } from './providers/lyrics.mjs';
import { loopbackFetch } from './loopback.mjs';

const SOURCE_LABELS = { netease: '网易', kugou: '酷狗' };
const SEARCH_LIMIT = 5;
const NCM_TIMEOUT_MS = 12_000;

/** 打自己起的网易后端（环回 HTTP）。这是"内部一跳"，不是出网：出网发生在包里。 */
async function callNcm(handle, path) {
  const response = await loopbackFetch(`${handle.baseUrl}${path}`, { signal: AbortSignal.timeout(NCM_TIMEOUT_MS) });
  const text = await response.text();
  try {
    return { status: response.status, body: JSON.parse(text) };
  } catch {
    return { status: response.status, error: `网易后端返回的不是 JSON（HTTP ${response.status}）` };
  }
}

async function neteaseSearch(handle, keywords) {
  const found = await callNcm(handle, `/cloudsearch?keywords=${encodeURIComponent(keywords)}&limit=${SEARCH_LIMIT}`);
  if (found.error) return { ok: false, reason: found.error };
  const failure = sourceFailure(found.body);
  if (failure) return { ok: false, reason: `网易检索失败：${failure}` };
  return { ok: true, candidates: ncmSearchToCandidates(found.body) };
}

async function neteaseLyric(handle, { mediaId }) {
  // 两个端点都试：`/lyric/new` 给富文本段（实测 NDJSON），`/lyric` 给经典 LRC + 译文。
  // 顺序不能反：new 端点在有的曲目上返回空正文，而老端点有。
  for (const path of [`/lyric/new?id=${encodeURIComponent(mediaId)}`, `/lyric?id=${encodeURIComponent(mediaId)}`]) {
    const found = await callNcm(handle, path);
    if (found.error) continue;
    if (sourceFailure(found.body)) continue;
    const { text, translation } = ncmLyricToText(found.body);
    if (text.trim()) return { ok: true, text, translation, format: 'lrc' };
  }
  return { ok: false, reason: '网易两个歌词端点都没有正文' };
}

async function kugouSearch(handle, keywords) {
  const result = await handle.invoke('search_lyric', { keywords, pagesize: SEARCH_LIMIT });
  const body = result?.body ?? result?.data ?? result;
  const failure = sourceFailure(body);
  if (failure) return { ok: false, reason: `酷狗检索失败：${failure}` };
  // "没有 candidates 这个字段"与"有字段但是空数组"是两件不同的事：前者是请求没被正确接受
  // （实测：身份 env 没设对时包连 status 都不给），后者才是"这首歌真的没词"。混成一句会把故障说成没词。
  if (!Array.isArray(body?.candidates)) return { ok: false, reason: '酷狗检索响应里没有 candidates 字段（请求没被正确接受，不是"没有词"）' };
  return { ok: true, candidates: kugouSearchToCandidates(body) };
}

async function kugouLyric(handle, { mediaId, accessKey }) {
  if (!accessKey) return { ok: false, reason: '酷狗取词需要检索结果里的 accesskey，缺少它就不必再问' };
  const result = await handle.invoke('lyric', { id: mediaId, accesskey: accessKey, decode: true });
  const body = result?.body ?? result?.data ?? result;
  const failure = sourceFailure(body);
  if (failure) return { ok: false, reason: `酷狗取词失败：${failure}` };
  const { text, format } = kugouLyricToText(body);
  if (!text.trim()) return { ok: false, reason: '酷狗返回的歌词正文是空的' };
  return { ok: true, text, format };
}

/**
 * 挂歌词路由。`backends` 是桥里那份"后端句柄表"（起不来时是对应 id 的 `{state:'error'}`）。
 * source → 后端 id 的映射写死在这里：它不是用户输入，是本项目自己的常量。
 */
export function registerLyricRoutes({ routes, backends }) {
  const ready = (id) => {
    const handle = backends[id];
    if (!handle || handle.state !== 'ready') return { error: `${SOURCE_LABELS[id] ?? id} 后端未就绪${handle?.reason ? `（${handle.reason}）` : ''}` };
    if (id === 'netease' && !handle.baseUrl) return { error: '网易后端没有环回地址' };
    return { handle };
  };

  routes.set('/bridge/lyrics', async (payload) => {
    const source = String(payload?.source ?? '');
    const action = String(payload?.action ?? '');
    const backendId = source === 'netease' || source === 'kugou' ? source : null;
    if (!backendId) return { ok: false, reason: `不支持的歌词源：${source || '（空）'}` };
    const { handle, error } = ready(backendId);
    if (error) return { ok: false, provider: backendId, reason: error };
    try {
      if (action === 'search') {
        const keywords = String(payload?.keywords ?? '').trim();
        if (!keywords) return { ok: false, provider: backendId, reason: '缺少检索词' };
        const result = backendId === 'netease' ? await neteaseSearch(handle, keywords) : await kugouSearch(handle, keywords);
        return { ...result, provider: backendId };
      }
      if (action === 'lyric') {
        const mediaId = String(payload?.mediaId ?? '').trim();
        if (!/^[A-Za-z0-9_-]{1,64}$/.test(mediaId)) return { ok: false, provider: backendId, reason: 'mediaId 形状不对' };
        const result = backendId === 'netease'
          ? await neteaseLyric(handle, { mediaId })
          : await kugouLyric(handle, { mediaId, accessKey: String(payload?.accessKey ?? '') });
        return { ...result, provider: backendId };
      }
      return { ok: false, provider: backendId, reason: `未知的歌词动作：${action || '（空）'}` };
    } catch (error) {
      // 包内部抛出来的东西形状各异（实测酷狗会抛一个对象而不是 Error），所以这里统一收成一句字符串。
      const message = error?.message ?? (typeof error === 'string' ? error : JSON.stringify(error)?.slice(0, 200)) ?? '未知错误';
      return { ok: false, provider: backendId, reason: `${SOURCE_LABELS[backendId]} 通道异常：${message}` };
    }
  });
  return routes;
}
