// 本项目自撰（非移植代码）。播放上报的**父进程这一层**（R161 · 夜间主批任务八）。
//
// 这一层管的不是"怎么发"（那是桥里那一处），而是**该不该发**这四条，四条都是隐私判据：
//   ① **缺省关**：`playReporting !== true` ⇒ 一个请求都不发、连会话文件都不读
//      （与 R143 那条"开关关着时一个凭据文件都不 stat"同一形状）；
//   ② **只报在线曲目**：本地文件不报任何平台——"我在听我硬盘上那首歌"不关任何平台的事，
//      而报过去也只会凭曲名歌手去撞一个不是同一版的匹配；
//   ③ **听了够久才报**：不足 `REPORT_MIN_SECONDS`（30 秒）不报。
//      划一遍歌单就上传四十条"startplay"是最讨厌的一种副作用；
//   ④ **一次播放只报一次**：同一首在同一个播放轮次里不重复发（换曲即重置），
//      失败也不重试成一串——上报是"顺手告诉平台"，不是一条要打通的链路。
//
// 载荷字段白名单在桥那一层（`reportPayloadOf`），这里只交三样：provider / mediaId / positionSec。
// 曲名、歌手、专辑、本地路径、整条队列**一个都不交**：交不过去比"记得过滤"更可靠。
// 每一次上报（成或败）都往服务日志写一行，且父进程**不落任何盘**：
// 这台机器上不建"播放历史"文件——那正是本件最不该顺手造出来的东西。

export const REPORT_MIN_SECONDS = 30;
/** 今天有上报通道的那两家（QQ 的桥里没有这条；界面上分开说）。 */
export const REPORT_PROVIDERS = Object.freeze(['netease', 'kugou']);
/**
 * 在线曲目 id 的形状：`on-<来源>-<媒体 id>`（`toOnlineTrack` 就是这么造的）。
 * **本地曲目的 id 是文件路径哈希，没有这个前缀** ⇒ "只报在线曲目"这一条由 id 反推来判，
 * 不靠客户端自报 `sourceKind`（自报的东西不算证据）。
 */
const ONLINE_TRACK_ID = /^on-(netease|qq|kugou|amll)-(.{1,120})$/;
export function onlineReportTargetOf(trackId) {
  const matched = ONLINE_TRACK_ID.exec(String(trackId ?? '').trim());
  if (!matched) return null;
  return { provider: matched[1], mediaId: matched[2].trim() };
}

export function createPlayReporter({ bridge, credentialsFor, log = () => {}, now = () => Date.now() } = {}) {
  // 去重键 = "这一轮播放的哪一首"。键里不含曲名与路径：那两样一旦进来就有被顺手发出去的风险。
  const reported = new Set();
  let currentKey = '';
  let lastResult = null;

  const startPlayback = (track) => {
    const key = track?.id ? `${track.sourceKind ?? 'local'}:${track.provider ?? ''}:${track.id}` : '';
    if (key !== currentKey) {
      currentKey = key;
      reported.clear();     // 换曲即重置：新一轮可以再报一次（同一首重播也算新一轮）
      lastResult = null;
    }
  };

  /**
   * 该报就报，不该报就说清为什么不该报。返回值只用于界面那一行状态，**绝不**影响播放。
   * "只报在线曲目"这一条不在这里判——它由调用方（路由）从**曲目 id 的形状**判：
   * 在线曲目的 id 是 `on-<来源>-<媒体 id>`，本地曲目的 id 是文件路径哈希，两者不共用一个前缀。
   * 由 id 反推 provider 与 mediaId，客户端就没有"替另一家报"的能力。
   */
  async function report({ provider, mediaId, positionSec, enabled }) {
    if (enabled !== true) return { sent: false, reason: '上报是关着的（缺省）' };
    if (!REPORT_PROVIDERS.includes(provider)) {
      return { sent: false, reason: provider ? `${provider} 没有上报通道（桥里没有这一条）` : '这首在线曲目没有来源平台' };
    }
    const position = Math.floor(Number(positionSec) || 0);
    if (position < REPORT_MIN_SECONDS) return { sent: false, reason: `只听满 ${REPORT_MIN_SECONDS} 秒才报（现在 ${position} 秒）` };
    const id = String(mediaId ?? '').trim();
    if (!id) return { sent: false, reason: '这首在线曲目没有平台侧的曲目标识，报不了' };
    const dedupeKey = `${provider}:${id}:${currentKey}`;
    if (reported.has(dedupeKey)) return { sent: false, reason: '这一轮已经报过一次了' };
    reported.add(dedupeKey);          // **先记再发**：失败也不重发成一串（上报不是要打通的链路）
    const credentials = await credentialsFor(provider);
    const reply = await bridge.call('/bridge/report', {
      provider, mediaId: id, positionSec: position,
      cookie: String(credentials?.cookie ?? ''),
      ...(provider === 'kugou' ? { device: credentials?.device } : {}),
    });
    lastResult = { at: now(), provider, ok: reply?.ok === true, reason: reply?.reason ?? '' };
    log(`播放上报：${reply?.ok ? '已报给' : '没报出去'} ${provider}${reply?.ok ? `（第 ${position} 秒）` : ` —— ${reply?.reason ?? '通道没有回话'}`}`);
    return { sent: reply?.ok === true, reason: reply?.reason ?? '', provider };
  }

  return {
    startPlayback,
    report,
    /** 界面那一行"上一次的结果"：只回读数（时间 / 哪家 / 成没成 / 原因），不回曲名与队列。 */
    lastReport: () => lastResult,
    pendingCount: () => reported.size,
  };
}
