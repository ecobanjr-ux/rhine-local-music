// R212 · 登录面板的"刷新窗口"：面板开着的时候每十来秒**只看一眼本地自省快照**，
// 发现某一家从"未登录"变成"已登录"就当场翻界面、报一次 —— 不等用户重开面板。
//
// 为什么需要它（现场，2026-10-13，验收侧一手）：用户扫完码，会话其实**已经落盘**
//（`GET /api/online/auth` 当场就能读到 `source:"file"`、`online-session/netease.json` 在），
// 但面板的 2 秒轮询只认 `waiting/scanned` 两态：一旦本地走到终态就把表停了，界面从此不再自我发现
// "其实已登录"。R136 ① 是同一族的另一面（retryable 标记被吞 ⇒ 界面判终态 ⇒ 把刚拿到的码丢掉）——
// 两次的坑都是"服务端的真状态"与"界面看的那个状态"不是同一份。
//
// 纪律（判据钉住）：这条路**只许**读 `GET /api/online/auth` —— 服务端那一跳是纯本地自省
//（读内存 + stat 会话文件、不出网、不碰桥）。**不许碰 `/poll`**（那是扫码轮询的语义）、
// **不许碰 `/account`**（那个会出网），更不许自己 fetch。
//
// 纯逻辑、零 import、时钟与调度都可注入 ⇒ 离线就能把"翻了 / 只报一次 / 一直没登录不报 / 看不见就停"全钉住。

/** 心跳间隔（毫秒）。要求：10~15 秒一档；缺省 12 秒（本地自省一跳，代价可忽略）。 */
export const AUTH_HEARTBEAT_DEFAULT_MS = 12_000;
/** 迟到确认窗口：扫码走到终态后再给几次低频机会（上游确认可能晚到；会话一旦落盘就永久在）。要求 2~3 次。 */
export const AUTH_HEARTBEAT_LATE_TICKS = 3;

type AuthSnapshotLike = { providers?: Record<string, { source?: string } | undefined> };

export interface AuthHeartbeatOptions {
  /** 读一次快照。只许走本地自省那条路（`GET /api/online/auth`）。 */
  read: () => Promise<AuthSnapshotLike>;
  /** 发现登录成功时翻一次界面。 */
  render: () => void;
  /** 登录成功那句话；**每家只报一次**（Set 去重，别每十来秒报一次）。 */
  notifyLogin: (provider: string) => void;
  /** 定时器注入口（测试拿假时钟驱动；产品里就是 setTimeout/clearTimeout）。 */
  schedule: (fn: () => void, ms: number) => unknown;
  cancel: (handle: unknown) => void;
  /** 元素还在不在文档里。不在 ⇒ 这一拍停表（面板关掉/切走后不许再跑）。 */
  alive?: () => boolean;
  intervalMs?: number;
  lateTicks?: number;
}

export function createAuthHeartbeat(options: AuthHeartbeatOptions) {
  const { read, render, notifyLogin, schedule, cancel, alive } = options;
  const intervalMs = options.intervalMs ?? AUTH_HEARTBEAT_DEFAULT_MS;
  const lateTicks = options.lateTicks ?? AUTH_HEARTBEAT_LATE_TICKS;
  const lastSource = new Map<string, string>();
  const reported = new Set<string>();
  let timer: unknown = null;
  let lateLeft: number | null = null;

  const stop = () => {
    if (timer !== null) {
      cancel(timer);
      timer = null;
    }
    lateLeft = null;
  };

  const tick = async () => {
    timer = null;
    if (alive && !alive()) {
      stop();
      return;
    }
    let snapshot: AuthSnapshotLike = {};
    try {
      snapshot = await read();
    } catch {
      // 读不到就当这一拍什么都没看见：不报错、不翻面，下一拍再看。
    }
    for (const [provider, view] of Object.entries(snapshot?.providers ?? {})) {
      const now = view?.source ?? "none";
      const prev = lastSource.get(provider) ?? "none";
      lastSource.set(provider, now);
      if (prev === "none" && now !== "none") {
        // R214：翻面**永远**发生 —— 去重门只管"报"那一半（用户实报 + 验收侧确定性复现：同一界面会话里
        // 退出→再登录，从前 `render()` 也被关在 `reported` 门里 ⇒ 第二次既不翻面、也不报）。
        if (!reported.has(provider)) {
          reported.add(provider);
          notifyLogin(provider);
        }
        render();
      } else if (now === "none" && prev !== "none") {
        // R214：回到未登录 ⇒ 把"已报过"清掉 —— 去重语义 = **每次登录事件报一次**，而不是"进程内一辈子只报一次"。
        // （toast 仍然不会每 12 秒重复：只有"转档"才走到上面那一支。）
        reported.delete(provider);
      }
    }
    if (lateLeft !== null) {
      lateLeft -= 1;
      if (lateLeft <= 0) {
        stop();
        return;
      }
    }
    timer = schedule(tick, intervalMs);
  };

  return {
    /** 面板开着（auth rows 在文档里）时叫一次；重复叫不叠表。 */
    start() {
      if (timer === null) timer = schedule(tick, intervalMs);
    },
    /**
     * R214 起：面板每次读完快照都叫一次，把心跳的起点同步成那份真值。R215 去掉了"只在没跑时生效"那条闸 ——
     * 心跳**跑着**时喂进来的新真值也必须当场生效（留着旧起点又会出现"界面看的与服务端真状态不是同一份"）。
     * 仍然：**永不**发通知；快照为 `none` 时照样把"已报过"作废。
     */
    seed(sources?: Record<string, { source?: string } | undefined>) {
      if (!sources) return;
      for (const [provider, view] of Object.entries(sources)) {
        const source = view?.source ?? "none";
        lastSource.set(provider, source);
        // 起点就是"未登录" ⇒ 上次那个"已报过"已经过期（关面板期间被登出那种缺口也由这一行对掉）。
        if (source === "none") reported.delete(provider);
      }
    },
    /** 面板关掉/切走时必须走这里；元素自查那一拍也会自己走到这。 */
    stop,
    /** 扫码走到本地终态时叫一次：再给几次低频机会，仍无变化就自己停。 */
    armLate(steps = lateTicks) {
      lateLeft = steps;
    },
    get running() {
      return timer !== null;
    },
  };
}
