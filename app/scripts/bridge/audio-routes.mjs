// 本项目自撰（非移植代码）。桥的音源通道：网易（包里那一份实现与匿名令牌）+ 酷狗（任务一 · B 路线新接的第三家）。
//
// 为什么 QQ 不在这里：QQ 的匿名 vkey 是本项目自写的 fcg 调用，父进程经 guardedFetch 直接发
// （见 scripts/online-audio-source.mjs）——从桥里发就变成包内 axios 那一套，出网审计表上看不见主机。
// 为什么酷狗**必须**在这里：`song_url` 要**包内安卓签名**（`signKey(hash, mid, userid, appid)` 那一份，
// 一手读 `util/helper.js:134`），父进程重抄一份签名就是第二个真相（R154）。
// 酷狗那一跳的两条一手事实（2026-10-10 探针，数据在执行日志 §任务一.3）：
//   · 要**登录态**（父进程借来的 token+userid）+ **mid**（桥用包内 `calculateMid` 从持久 guid 算）；
//   · `dfid` 必须**显式带**（不带 ⇒ 包塞一个随机 24 位串 ⇒ 实测 502）。我们带的是空串，
//     经 `util/request.js:72` 的 `|| '-'` 折成 `dfid=-`，实测给 200 与整首地址 ⇒ **零伪装、零注册**。
//   · `priv_status:0` 那一档上游照样回 `url`，但那是"整首文件 + `hash_offset` 标片段"的形态 ⇒ **不用**
//     （判据写在 `providers/kugou-device.mjs` 的 `kugouSongUrlToSource`，那是"不绕过平台权益"的兑现）。
//
// 一手形状（2026-10-05 实测，数据在执行日志 Task 6 段）：
//   · `/song/url?id=&br=320000` → `{code:200, data:[{id, url, type, size, level, fee, freeTrialInfo}]}`；
//     url 是 `http://m<数字>.music.126.net/….mp3`（升 https 由父进程做，桥只管取址）。
//   · `/song/url/v1` 在这个 build 是 **404** ⇒ 不试第二次：白等一次往返，还把"404"当成故障上报。
//   · 付费曲给的是 30 秒试听片段（`freeTrialInfo.end = 30`，size 与时长对得上），`fee = 1`；
//     更多曲目匿名直接 `url: null`——那是"没有音源"，不是错误。
import { kugouCookieToObject } from './providers/kugou-auth.mjs';
import { kugouDeviceCall, kugouSongUrlToSource, KUGOU_HASH_SHAPE } from './providers/kugou-device.mjs';

export const NCM_AUDIO_TIMEOUT_MS = 12_000;

/**
 * 酷狗取址的降级序列（R223 补齐为**原版全集四档**，用户 2026-10-14 拍板"不自创不砍"）：
 * `flac → high → 320 → 128`。这四个值就是包原样往 `quality` 里塞的字符串
 * （一手对表原版 `kugouProvider.ts:662-664` 的 `qualityValue`：`standard:'128' / high:'320' / lossless:'flac' / hires:'high'`），
 * 我们不自创第五档、也不砍掉无损档 —— 砍掉就得在界面文案里解释"为什么不问无损"。
 * **一处如实记的次序差**：原版从最高偏好（`hires`）下来的降级序是 `['high','flac','320','128']`
 * （`QUALITY_FALLBACKS.hires`），而拍板要的是无损优先 `['flac','high','320','128']`；
 * 两者是**同一组档位、只是头两档换位**，本仓按拍板执行并把原序留在这段注释里（改一处常量即可换回）。
 * 平台身份那一格：**R224 起不再设 `process.env.platform`（原来设的是 `lite`）** ⇒ 酷狗全部跳跑**非 lite 客户端族**，
 * 与原版桥同形状（原版根本不设这个变量）。依据：非 lite 那族回的 CDN 主机 `fsandroid.kugou.com` /
 * `fsmobile.tx.kugou.com` **两台 TLS 都可用**（前者本来就在 `AUDIO_HOSTS` 里），而 lite 那族只给
 * `fs.youthandroid*`（升 https 直接 `ERR_TLS_CERT_ALTNAME_INVALID`）⇒ 在"不为音频走明文"之下等于播不了。
 * 出处与代价面读数见 `memory/kugou-platform-nonlite-r224-run-log.md`（Q34 结案=丙）。
 */
export const KUGOU_QUALITY_ORDER = Object.freeze(['flac', 'high', '320', '128']);

/**
 * 专辑参数那一格（R222，照原版 `kugouProvider.ts:1024-1075` 的两个变体）：
 *   · 变体一「带专辑」= `album_id` + `album_audio_id`（父进程从检索行里量来的：`AlbumID` 与 `MixSongID`，
 *     见 `providers/normalize.mjs` 的两条断言）；
 *   · 变体二「纯 hash」= 两个都空 —— 原版注释原话：**检索元数据里的专辑 id 可能根本不属于这个 hash**
 *     （`Search metadata can contain album IDs that do not belong to the returned hash`），所以同一档要能再问一次。
 * 没有专辑参数时**只跑纯 hash 那一档**：不许拿空值冒充"带参数问过"（那会让判据与真机不是同一件事）。
 * 形状认不出（空/非数字/超长）也当没给——一个**可选**的提示参数不该把整条取址判死。
 */
function kugouVariants(albumId, albumAudioId) {
  const idText = String(albumId ?? '').trim();
  const audioText = String(albumAudioId ?? '').trim();
  const usable = (value) => /^\d{1,20}$/.test(value);
  const withAlbum = {};
  if (usable(idText)) withAlbum.album_id = idText;
  if (usable(audioText)) withAlbum.album_audio_id = audioText;
  if (!Object.keys(withAlbum).length) return [{}];
  return [withAlbum, { album_id: '', album_audio_id: '' }];
}

/**
 * 酷狗取址一跳。凭据与设备身份都由父进程带来（`payload.device` + `payload.cookie`），桥不落盘也不读盘。
 * 质量序列**逐档试**：任何一档给了过权益闸的地址就收；所有档、所有变体都不给才把最后一句原因报上去。
 *
 * R222 把这一跳的形状补齐到原版的两步（都是原版 `kugouProvider.ts:1004-1096` 的读法，逐项对表过）：
 *   ① **逐画质降级**：`flac → high → 320 → 128`（R223 补齐成原版全集四档；原版 `QUALITY_FALLBACKS`
 *      的最高档降级序是 `['high','flac','320','128']`，两序同档不同序，见上面那张表的注释）；
 *   ② **同一档两个变体**：带专辑参数 → 纯 hash（见 `kugouVariants`）。
 * 继续下探的条件：这一档**没给出可播地址**——「没文件」（`status:2`）、「权益不给」（`priv_status:0` 或 20018）、
 * 上游拒了这一跳（抛错，今天就是 502/`illegal key`）都算；**唯一不继续的是「响应形状认不出」**：
 * 那是我们自己的读法出了问题，空转四跳只会把它藏起来（R154 立的规矩，这一条与 R222 的改动不冲突）。
 * 与另一条原版差异照旧**不动**：原版 `audioUrlOf` 只挑 http/https 一条 ⇒ http 也放；我们拒 http 是纪律（R218）。
 */
async function kugouAudioSource(backends, payload) {
  const handle = backends?.kugou;
  if (!handle || handle.state !== 'ready' || typeof handle.invoke !== 'function') {
    return { ok: false, provider: 'kugou', reason: '酷狗后端未就绪（在线能力被关闭或后端正在重启）', retryable: true };
  }
  const hash = String(payload?.mediaId ?? '').trim();
  if (!KUGOU_HASH_SHAPE.test(hash)) return { ok: false, provider: 'kugou', reason: '酷狗曲目标识必须是 32 位十六进制 hash', retryable: false };
  const session = kugouCookieToObject(payload?.cookie);
  const device = { ...(payload?.device ?? {}), token: String(session.token ?? ''), userid: String(session.userid ?? '') };
  if (!device.token || !device.userid) {
    // 这一档是"权益事实"而不是"通道坏了"：未登录时酷狗确实播不了（实测匿名只有 mid ⇒ 152 / status:2）。
    // 父进程本不该在未登录时问到这一跳，走到这里就是有人问了 ⇒ 给一句实话，不出网。
    return { ok: false, provider: 'kugou', unavailable: true, reason: '本机没有酷狗登录态：这一家要登录才给可播文件', retryable: false };
  }
  const variants = kugouVariants(payload?.albumId, payload?.albumAudioId);
  let last = { ok: false, reason: '酷狗没有回音源' };
  for (const quality of KUGOU_QUALITY_ORDER) {
    for (const variant of variants) {
      const called = await kugouDeviceCall(handle, 'song_url', { hash: hash.toLowerCase(), quality, ...variant }, device);
      if (!called.ok) {
        const code = called.failed?.body?.error_code ?? called.failed?.body?.data?.error_code ?? null;
        last = { ok: false, provider: 'kugou', unavailable: code === 20018, reason: called.reason ?? `酷狗取址这一档没成（HTTP ${called.failed?.status ?? '没应答'}${code ? ` · 错误码 ${code}` : ''}）`, device: called.device };
        continue;
      }
      const parsed = kugouSongUrlToSource(called.result?.body ?? called.result ?? {});
      last = { ...parsed, provider: 'kugou', device: called.device };
      if (parsed.ok) return last;
      // 形状认不出 ⇒ 停（我们自己的读法问题，换档换变体都救不回来，只会多四笔出网）。
      if (!parsed.noUrl && !parsed.denied) return last;
    }
  }
  return last;
}

/** 一跳的 JSON 取回（与 lyric-routes 里那份同一形状：解析失败要说"不是 JSON"，不能当成空结果）。
 * `cookie` 只走请求头：网易包把 `?cookie=` 也认，但查询串会进包自己的访问日志行（M3-a Task C 同一处置）。 */
async function callNcm(handle, path, fetchImpl, cookie) {
  const response = await fetchImpl(`${handle.baseUrl}${path}`, {
    signal: AbortSignal.timeout(NCM_AUDIO_TIMEOUT_MS),
    ...(cookie ? { headers: { cookie } } : {}),
  });
  const text = await response.text();
  try {
    return { status: response.status, body: JSON.parse(text) };
  } catch {
    return { status: response.status, error: `网易后端返回的不是 JSON（HTTP ${response.status}）` };
  }
}

/**
 * 音源响应 → 内部形状。字段名不收敛到"看起来有"就行：`url` 为空与"根本没这个字段"
 * 是两件事（后者说明请求没被正确接受），跟歌词那侧立的规矩一致。
 */
export function ncmAudioPayloadToSource(body) {
  const item = Array.isArray(body?.data) ? body.data[0] : null;
  if (!item || typeof item !== 'object') return { ok: false, reason: '网易音源响应里没有 data 条目（请求没被正确接受，不是"没有音源"）' };
  if (!item.url) {
    const code = Number(body?.code ?? 0);
    return { ok: false, reason: code && code !== 200 ? `网易音源接口返回码 ${code}` : '这首没有可用的网易音源（VIP 曲会给 30 秒试听片段，其余曲目匿名拿不到地址）' };
  }
  return {
    ok: true,
    url: String(item.url),
    kind: String(item.type ?? 'mp3').toLowerCase(),
    size: Number(item.size ?? 0) || 0,
    level: String(item.level ?? ''),
  // 试听/完整这一档要**如实带出去**：UI 才不至于把 30 秒播成"整首"，M3-b 的取证也要写明是哪一种。
  trial: item.freeTrialInfo ? { end: Number(item.freeTrialInfo.end ?? 0) || 0 } : null,
  fee: Number(item.fee ?? 0) || 0,
  // scope 的判据只有这一处：上游给了 freeTrialInfo 就是试听片段；给了 url 且没有 freeTrialInfo 才是完整。
  // 不拿 size/时长去"猜"整首有多长——我们没有整首的事实（V6 同一条道理：不编）。
  scope: item.freeTrialInfo ? 'trial' : 'full',
};
}

/** 挂音源路由。`fetchImpl` 是为离线自检开的注入口（真机上固定用桥内那份 loopbackFetch）。 */
export function registerAudioRoutes({ routes, backends, fetchImpl }) {
  const fetch = fetchImpl;
  routes.set('/bridge/audio-source', async (payload) => {
    const provider = String(payload?.provider ?? '');
    // 酷狗不经环回 HTTP（进程内直调包），所以在最外层分叉；它带上去的 `device` 是父进程要落盘的那一份。
    if (provider === 'kugou') return kugouAudioSource(backends, payload);
    if (provider !== 'netease') return { ok: false, provider, reason: provider ? `桥不为 ${provider} 提供音源通道` : '缺少音源 provider', retryable: false };
    const handle = backends.netease;
    if (!handle || handle.state !== 'ready' || !handle.baseUrl) {
      return { ok: false, provider: 'netease', reason: '网易后端未就绪', retryable: true };
    }
    const mediaId = String(payload?.mediaId ?? '').trim();
    if (!/^\d{1,20}$/.test(mediaId)) return { ok: false, provider: 'netease', reason: '网易曲目 id 必须是数字', retryable: false };
    // M3-b：登录之后取整首。凭据由父进程带来（它是网易那一份的所有者），桥只在这一跳用它，
    // 不落盘、不回显、不写进日志；没带就是匿名取址，行为与今天逐字一致。
    const cookie = String(payload?.cookie ?? '').trim();
    const found = await callNcm(handle, `/song/url?id=${encodeURIComponent(mediaId)}&br=320000`, fetch, cookie);
    if (found.error) return { ok: false, provider: 'netease', reason: found.error, retryable: true };
    return { ...ncmAudioPayloadToSource(found.body), provider: 'netease' };
  });
  return routes;
}
