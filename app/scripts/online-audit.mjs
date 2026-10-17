// 本项目自撰（非移植代码）。出网审计的环形缓冲 —— 联网默认打开（R71）的补偿装置。
//
// 为什么要有它：默认关闭时"零请求"本身就是承诺；默认打开之后，"我们只打了该打的地方"
// 变成用户无法自行验证的一句话。所以把播放器主动发起的每一次出网摊开成一张表。
// 三条硬约束（都有对应断言）：
//   ① 只在内存里：审计不落盘（它会含主机名与时间，写进数据目录就多一个要清理、要备份的实体）；
//   ② 定长：无界增长就是给自己造内存型拒绝服务；
//   ③ 只记主机 + 用途 + 状态 + 体积 + 耗时：URL 查询串里可能带曲目名与凭据，一律不进（面板可能被截图）。
export const AUDIT_LIMIT = 200;
const SNAPSHOT_ITEMS = 80;

let items = [];
let since = Date.now();

/** 默认落点：本进程的内存环形表。定长是无界增长的刹车。 */
const ringSink = (row) => {
  items.push(row);
  if (items.length > AUDIT_LIMIT) items = items.slice(items.length - AUDIT_LIMIT);
};

let sink = ringSink;

/**
 * 换掉记账的落点。存在的理由只有一个：**桥是独立进程**，
 * 它那份 `online-guard` 记录如果只写进自己的内存表，父进程（也就是面板与 `/api/online/audit`）永远看不到。
 * 桥在 boot 时装一个"经 NDJSON 通道转发给父进程"的 sink，两侧的记录才并成一张表。
 * 传非函数一律忽略并回到默认（传错参数不该把审计弄没），传 `null` 显式复位。
 */
export function setEgressSink(next) {
  sink = typeof next === 'function' ? next : ringSink;
}

/** 记一笔。`via` 区分"我们自己的 guard 打的"（guard）与"第三方后端库内部打的"（backend）。 */
export function recordEgress({ host, kind = 'unknown', status = 0, bytes = 0, ms = 0, via = 'guard' } = {}) {
  const name = String(host ?? '');
  if (!name) return;                                     // 没有主机的记录没有意义，也不许造出一行空的
  // 归一化留在这里、不进 sink：换落点不该改变"什么样的行才算一条记录"。
  sink({
    host: name,
    kind: String(kind),
    status: Number(status) || 0,
    bytes: Number(bytes) || 0,
    ms: Math.round(Number(ms) || 0),
    via: String(via),
    at: Date.now(),
  });
}

export function auditSnapshot() {
  const byHost = {};
  const byKind = {};
  let bytes = 0;
  for (const item of items) {
    byHost[item.host] = (byHost[item.host] ?? 0) + 1;
    byKind[item.kind] = (byKind[item.kind] ?? 0) + 1;
    bytes += item.bytes;
  }
  return {
    items: items.slice(-SNAPSHOT_ITEMS).reverse(),        // 面板只看最近若干条，最新的排前面
    totals: { requests: items.length, bytes, byHost, byKind },
    since,
    limit: AUDIT_LIMIT,
  };
}

/** 重置：自检逐条要独立起点；服务侧在用户关掉在线能力时也该把表清空（"关掉之后没有残留"）。 */
export function resetAudit() {
  items = [];
  since = Date.now();
}
