// 本项目自撰。自检用的"服务已可连"探测 —— 只解决一件事：`listen(0)` 之后**第一笔连接**偶发被拒。
//
// 为什么需要它（2026-10-05 M2 期间实测）：全链跑测里 4 次偶发失败全是同一形态
// （`fetch failed`，undici 连接层，落在 check-music-online / check-music-bridge 的不同用例上），
// 单独重跑必绿。定性为 Windows 上回环端口回收：短时间内起停大量 `listen(0)` 服务时，
// 拿到的端口可能还被刚关闭的连接占着，第一笔 connect 会被拒。
//
// R189（连续三轮整跑各红一条、全是同族）：
//   R181 `check-music-playlist-match` / R185 `check-music-online-search` 都**已经**调这个探测，
//   红的是它自己那句"服务在 40 次探测内连不上"，`check-music-online-audit` 那条 `fetch failed`
//   则是**根本没调探测**（`listen` 之后直接 `fetch`）。
//   ⇒ 处置分两半，都是"只动等服务起来那一格"：① 这里把固定 25ms 间隔换成**递增退避**
//   （attempts 不动 40，墙钟预算从 1s 抬到 ~9.4s：25/50/100/200 之后维持 250ms），
//   忙机器上第一笔 connect 慢下来的那几秒被吃掉，而机器空闲时第一次就命中、**一分钱不多花**；
//   ② 缺探测的那两处 `listen` 之后补调一次（audit）。
//
// 关键取舍：**这里重试的是"连不上"，不是"断言不对"**。探测只打 `/api/health`，
// 连上之后立刻把控制权交回用例；用例里的任何断言失败照常红。
// 换句话说它掩不掉逻辑缺陷，只掩掉一次 connect 的运气。
export async function waitListening(origin, {
  attempts = 40,
  delayMs = 25,
  maxDelayMs = 250,
  path = '/api/health',
  headers,
} = {}) {
  let lastError
  let delay = delayMs
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      // **任何** HTTP 响应都算"这个端口连得上"——401/404/405 也一样。
      // 鉴权与路由对不对是用例的事（它们各自的断言照常红），这里只管 connect。
      const response = await fetch(`${origin}${path}`, headers ? { headers } : {})
      await response.arrayBuffer()
      return { ready: true, attempts: attempt + 1, status: response.status }
    } catch (error) {
      lastError = error                     // 只有连接层的错会走到这里；断言根本不在这个函数里
    }
    if (attempt + 1 >= attempts) break
    await new Promise((resolve) => setTimeout(resolve, delay))
    delay = Math.min(maxDelayMs, delay * 2)
  }
  throw new Error(`服务在 ${attempts} 次探测内连不上（${origin}）：${lastError?.message ?? lastError}`)
}

/**
 * R198：**在 listen(0) 之后连不上 ⇒ 关掉重听一次（换个端口）**。
 *
 * 为什么加这一层：R189/R194 已经把"孤儿进程占端口 + Windows 的 SO_REUSEADDR"这条链查清了 ——
 * 别的 socket 也绑着同一个端口时，连接会跑去那个**不 accept** 的持有者上，退避重试到最后也连不上
 * （真机实测：R198 收尾那一轮 `check-music-artist-groups` 连 9.6 秒都连不上，而 6000 上留着的正是它自己那台服务）。
 * 退避治不了这种"连的是别人"，**换个端口才治**。
 *
 * 用法（替代 "listen(0) → 自己拼 origin → waitListening" 那三行）：
 *   const { origin } = await listenAndReady(server)
 * 语义：**只在连接层重试**（每轮先探 6 次、失败就把这台服务关掉重听），断言一律不重试。
 */
export async function listenAndReady(server, { rounds = 3, attempts = 6, delayMs = 60, maxDelayMs = 400 } = {}) {
  let lastError
  for (let round = 0; round < rounds; round += 1) {
    if (round > 0 || !server.listening) {
      if (server.listening) {
        server.closeAllConnections?.()
        await new Promise((resolve) => server.close(resolve))
      }
      await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
    }
    const origin = `http://127.0.0.1:${server.address().port}`
    try {
      const ready = await waitListening(origin, { attempts, delayMs, maxDelayMs })
      return { origin, round, ...ready }
    } catch (error) {
      lastError = error
    }
  }
  throw lastError
}
