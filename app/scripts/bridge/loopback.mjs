// 本项目自撰（非移植代码）。桥内部的"自己打自己"一跳：桥 → 本进程起的后端（网易的环回 HTTP server）。
//
// 为什么要单独一个模块，而不是在调用点直接 fetch：
//   R75 那条纪律是"在线侧不得裸 fetch"。这一跳打的不是公网，是我们自己刚起的 127.0.0.1 端口，
//   但**判据不看意图**。所以把这一跳收进唯一出口，并在运行时钉死"只允许环回前缀"——
//   这样纪律扫描仍然只认一个地方，而"哪天有人把公网 URL 传进来"会在这里当场失败，而不是静默出网。
export const LOOPBACK_PREFIX = 'http://127.0.0.1:';

/**
 * **桥加载时那一份真 fetch**。这里故意不在调用时刻读 `globalThis.fetch`：
 * 那一格里挂的是"给第三方包换上的出网守卫"（`qq-auth.withGuardedEgress`），它管的是**包自己**的出网，
 * 不是我们这一跳。按调用时刻读的话，全局一旦有守卫在飞（或曾经泄漏过一次），
 * 我们打 127.0.0.1 的这一跳就会被"仅 https"判死——P0 实测过：网易取址与搜索整条全废，
 * 现场消息是 `ONLINE_TARGET_REJECTED: …收到 http:`，而那个 http 地址根本不是什么 CDN，是我们自己。
 * 这一跳不是出网：它上面已经有"只允许环回前缀"这道判据，两道判据各管各的。
 */
const PRISTINE_FETCH = globalThis.fetch;

export function isLoopbackBridgeTarget(url) {
  return String(url ?? '').startsWith(LOOPBACK_PREFIX);
}

export async function loopbackFetch(url, init = {}) {
  if (!isLoopbackBridgeTarget(url)) throw new Error(`桥内部一跳只允许打 ${LOOPBACK_PREFIX}…，收到 ${String(url).slice(0, 60)}`);
  return PRISTINE_FETCH(url, { ...init, redirect: 'error' });
}
