// R217 · 「已登录」徽标的三档判定与文案（纯逻辑、零 import —— 自检可以直接驱动它）。
//
// 起因（验收侧现场，2026-10-13）：用户同一屏看到两句话打架 —— 登录行读**本机凭据文件**写
// 「已登录（凭据在本机会话文件里）· 6 项 · 时间」，而列账号歌单回「网易说这台机器没登录
//（/user/account 没有 account.id）」。两种 `loggedIn:false` 被混成了一句，而它们**不是一回事**
//（验收侧同刻两实例实测）：绿色版（新凭据）回 `{"loggedIn":false,"reason":"fetch failed"}`、
// 网页端（旧凭据）回 `{"loggedIn":false}`。
//   · 上游明确不认（响应里**没有** reason）—— 凭据真失效，该引导重扫；
//   · 问不到上游（响应里**带** reason）—— 可能只是被限流挡住，**必须**说成"暂时问不到"，
//     不许写成"已失效"，也不许引导重扫（用户实报：因反复扫码被网易限流 24 小时 —— 错误的引导正是成因之一）。
//
// 服务端契约（online-auth.mjs 的 account()）：`loggedIn:false` **带 reason** = 这一问没走到上游
//（桥没起来 / fetch failed / 上游没应答）；不带 = 上游明确回了"没有账号"。分类只按这条契约读，
// 不猜第二套判据。

export type AuthAccountState = "ok" | "rejected" | "unreachable";

/** 已登录那一行的"是谁"缓存条目（music-app 的 authAccounts 用它）。`status` 就是上面那三档。 */
export interface AuthAccountCacheEntry {
  nickname: string;
  vipLabel: string;
  status: AuthAccountState;
  reason: string;
  at: number;
}

/**
 * 把 `/api/online/auth/account` 的响应分档。**没有明确"上游说不认"这一形状的一律按"问不到"**——
 * 保守方向只有一个：宁可不指控凭据失效（指控会让用户去重扫，而重扫正是限流的成因）。
 * 请求整个抛了（`asked` 为 undefined）也走"问不到"，不许归"失效"。
 */
export function classifyAuthAccount(
  asked?: { loggedIn?: boolean; reason?: unknown } | null,
): { status: AuthAccountState; reason: string } {
  if (asked?.loggedIn === true) return { status: "ok", reason: "" };
  const reason = typeof asked?.reason === "string" ? asked.reason.trim() : "";
  if (asked?.loggedIn === false && !reason) return { status: "rejected", reason: "" };
  return { status: "unreachable", reason };
}

/** 上游原话里能看出"太频繁/被限制"就照实说出来（并明写不要重复扫）——别让用户越扫越被限。 */
export function looksRateLimited(reason: string): boolean {
  return /频繁|限制|限流|风控|稍后再|too many|rate.?limit/i.test(String(reason ?? ""));
}

/** 账号那一格的状态文案。`ok` 是空串：调用方原样保留"已登录"那一行（那一行说的事实没有被推翻）。 */
export function authAccountSegment(input: { status: AuthAccountState; reason?: string }): string {
  if (input.status === "rejected") return "凭据可能已失效 —— 上游不认（重新扫码）";
  if (input.status === "unreachable") {
    const reason = String(input.reason ?? "").trim();
    if (looksRateLimited(reason)) {
      return `账号信息暂时问不到上游（${reason ? `${reason}；` : ""}过一阵再试，先别重复扫码）`;
    }
    return `账号信息暂时问不到上游（${reason ? `${reason}；` : ""}不一定是没登录，过一阵再试）`;
  }
  return "";
}

/**
 * 行文案的三档处置：
 *   · rejected ⇒ **整行换口径**（不许在同一行里又写"已登录" —— 那正是用户看到的两句话打架）；
 *   · unreachable ⇒ 原行后面如实接一句"暂时问不到"；
 *   · ok / 还没问过 ⇒ 原样。
 */
export function applyAuthAccountState(
  baseText: string,
  account?: { status?: AuthAccountState; reason?: string } | null,
): string {
  const status = account?.status;
  if (status === "rejected") return authAccountSegment({ status });
  if (status === "unreachable") return `${baseText} —— ${authAccountSegment({ status, reason: account?.reason })}`;
  return baseText;
}

/** rejected 那一格要把「重新扫码」入口放回这一行（现在登录态行只给「退出登录」）。 */
export function showsRescan(status?: AuthAccountState | null): boolean {
  return status === "rejected";
}
