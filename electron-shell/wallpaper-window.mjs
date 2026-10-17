// R205（壁纸 v1 · 形态 A）· **窗口层级那一跳的唯一出处**。
//
// 为什么单独一个模块：R204 的判据 ㉒ 原本把这一跳整个禁掉（那是 M1"不做"的形状）；本件做的正是这一跳，
// 于是那一格从"禁"改成"可证"——`setAlwaysOnTop` / `setSkipTaskbar` / `setIgnoreMouseEvents` / `setResizable` /
// `setMovable` / `setSimpleFullScreen` **只许出现在本文件**（判据 ㉗），并且**进入设几项、退出就还原几项**（判据 ㉓）。
//
// 两条一手实测决定的形状（都写在 run log §〇）：
//  · `frame:false` 是**建窗期**选项，Electron 43 没有 `setFrame()` ⇒ 无边框那一格走
//    `setSimpleFullScreen(true)`：实测它把 bounds 变成逐字等于整块屏的 `{0,0,1707,1067}`、标题栏消失、
//    且 `setSimpleFullScreen(false)` 可逆；与 `alwaysOnTop` + `setIgnoreMouseEvents` 同时成立。
//  · `isTransparent()` / `isSkipTaskbar()` 这类读回 API 在本版本不存在 ⇒ **能读的**逐项读回对照，
//    **读不回的**（skipTaskbar / transparent / frame）靠进入时那份快照与 `initial` 记的那份写回去。
//
// 与上游的差异（台账 R205 / R207 登记）：上游 = 沉到桌面图标之下（WorkerW + Rust 助手 + 输入注入），
// 因此它**拒绝**点击穿透；本件 = 形态 A′（**不置顶** + 真穿透，窗口在图标之上），
// 零原生件、零输入注入、不动系统壁纸。代价（"被别的窗口盖住时看不见"与"不进 Alt+Tab"）必须写进界面文案。
//
// R207 改的那一格：`enter()` 里原来有一行 `setAlwaysOnTop(true, 'screen-saver')`（形态 A 的"置顶"），
// 本件按用户口径改成**不置顶**（显式 `setAlwaysOnTop(false)`，见 enter 里那一段注释）。

/** 进入时逐项设的东西 —— 退出必须逐项还原，这张表就是"成对"的那份清单（判据 ㉓ 钉它）。 */
export const WALLPAPER_APPLIED_FIELDS = [
  { name: 'alwaysOnTop', setter: 'setAlwaysOnTop' },
  { name: 'skipTaskbar', setter: 'setSkipTaskbar' },
  { name: 'bounds', setter: 'setBounds' },
  { name: 'resizable', setter: 'setResizable' },
  { name: 'movable', setter: 'setMovable' },
  { name: 'simpleFullScreen', setter: 'setSimpleFullScreen' },
  { name: 'url', setter: 'loadURL' },
  { name: 'ignoreMouseEvents', setter: 'setIgnoreMouseEvents' },
];

/** 铺满整块屏按**不变式**判：DIP 层拿不到"逐字等于 display.bounds"（实测差 1~6 px，Windows 有舍入补偿）。 */
export function coversWholeDisplay(bounds, display) {
  const want = display.bounds;
  return bounds.x <= want.x
    && bounds.y <= want.y
    && bounds.x + bounds.width >= want.x + want.width
    && bounds.y + bounds.height >= want.y + want.height;
}

/** 下边越过工作区底 = 盖住了任务栏那一条（形态 A 要"整块屏"，含任务栏区域）。 */
export function coversTaskbarStrip(bounds, display) {
  return bounds.y + bounds.height > display.workArea.y + display.workArea.height;
}

/**
 * R206 ②（验收侧 F1）· **还原判定按容差，不按逐字相等**。
 *
 * 为什么这一格必须改：Windows 对无边框窗口有 1~2 px 的 DIP 舍入补偿 —— 本文件 §0.2③ 与 run log §6.1
 * 都写过它，验收侧量的也是 `1289x803 → 1291x805`（差 2 px）。原判定按 `JSON.stringify` 逐字比，
 * 于是**每一次**退出都弹一句"有几项没还原到位：bounds" —— 而窗口实际已经回到进入前的形状，那句是假话。
 * 这不是放宽：要求（回到进入那一刻）一个字没降，只是把"差一两像素的舍入"和"真的没回去"分成两档，
 * 前者只进日志、后者才弹给用户，并且弹的时候要说出差在哪一项、差多少。
 */
export const RESTORE_TOLERANCE_DIP = 2;

const BOUND_FIELDS = ['x', 'y', 'width', 'height'];

/**
 * bounds 的还原差分两档（纯函数，判据与变异都钉这一格）：
 *  · `rounding`：容差之内 ⇒ 舍入补偿，记日志、**不许**弹给用户；
 *  · `over`：超容差（或读不回）⇒ 真没回去，必须让用户知道，且逐格带上"量到 / 期望 / 差多少"。
 */
export function classifyBoundsRestore(got, want, tolerance = RESTORE_TOLERANCE_DIP) {
  const over = [];
  const rounding = [];
  for (const key of BOUND_FIELDS) {
    const actual = Number(got?.[key]);
    const expected = Number(want?.[key]);
    if (!Number.isFinite(actual) || !Number.isFinite(expected)) {
      over.push({ field: `bounds.${key}`, got: got?.[key] ?? null, want: want?.[key] ?? null, delta: null });
      continue;
    }
    const delta = Math.abs(actual - expected);
    if (delta > tolerance) over.push({ field: `bounds.${key}`, got: actual, want: expected, delta });
    else if (delta > 0) rounding.push({ field: `bounds.${key}`, got: actual, want: expected, delta });
  }
  return { over, rounding };
}

/** 缺口要说得出"差在哪一项、差多少"，不能只报一个字段名（判据 ②的第三条）。 */
export function describeRestoreGaps(gaps) {
  return (gaps ?? [])
    .map((gap) => (gap.delta === null || gap.delta === undefined
      ? String(gap.field)
      : `${gap.field}（量到 ${gap.got}、进入前是 ${gap.want}，差 ${gap.delta} DIP）`))
    .join('、');
}

/** 壁纸画的就是 M0 那一档 surface；地址只在这一格里拼。 */
export function wallpaperSurfaceUrl(origin) {
  return `${origin}?wallpaper=1`;
}

/**
 * 这串地址还是不是壁纸那一档。为什么壳要读它：页面自己那三路退出（`Esc` / 双击 / 右下角那颗
 * 「退出沉浸（浏览器内）」）走的是 `location.replace`（一手读 `folia-host/surface-exit.ts:112-122`），
 * 地址一换、渲染层就回普通页了，而**层级那一跳还挂在窗口上** ⇒ 表现为"画面正常、窗口却还置顶又穿透"。
 * 判定住在本文件（⑳ 那条：`wallpaper=1` 这一格只有一个出处）。
 */
export function isWallpaperSurfaceUrl(url) {
  try {
    return new URL(String(url)).searchParams.get('wallpaper') === '1';
  } catch {
    return false;
  }
}

/**
 * 目标屏选择：沿上游那套**粘滞顺序**（`docs/wallpaper-mode.md:87`），但只三步 ——
 * 上游第 ③ 步读的是持久化的 `WINDOW_BOUNDS`（上次普通窗口位置），本壳没有窗口位置持久化（M1 没做），
 * 那一格退化成"用窗口此刻的真实位置"，差异登记在台账 R205。
 * ① 窗口此刻所在的屏（最权威，覆盖"最大化在副屏"）→ ② 本会话已解析的目标屏 → ③ 主屏兜底。
 */
export function pickTargetDisplay({ displays, windowBounds, sessionTargetId }) {
  const intersects = (a, b) => a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y;
  if (windowBounds) {
    const where = displays.find((d) => intersects(d.bounds, windowBounds));
    if (where) return { display: where, step: 1 };
  }
  if (sessionTargetId !== null && sessionTargetId !== undefined) {
    const held = displays.find((d) => d.id === sessionTargetId);
    if (held) return { display: held, step: 2 };
  }
  return { display: displays[0] ?? null, step: 3 };
}

/**
 * 三把退出保险的门（方案四.5：一个"沉底 + 穿透 + 不进任务栏"的窗口如果只能靠鼠标关，
 * 用户可能被留在一个抓不到的界面上）。**任一没就位就不许进入**，并给一句实话。
 */
export function decideWallpaperEntry({ trayReady, shortcutReady, hotspotReady }) {
  const missing = [];
  if (!trayReady) missing.push('托盘菜单项');
  if (!shortcutReady) missing.push('全局快捷键');
  if (!hotspotReady) missing.push('屏幕角落的解锁热点');
  if (missing.length > 0) {
    return { allow: false, message: `退出壁纸的保险还缺一件：${missing.join('、')}。缺任何一件都可能把你关在一块抓不到的画面上，所以这一版不进入壁纸模式。` };
  }
  return { allow: true };
}

/**
 * 控制器：`enter()` 取快照并铺满 + 置顶 + 穿透；`exit()` 按快照逐项还原。
 * 所有会碰窗口的动作都从传进来的 `win` 走 ⇒ 自检拿一个假 win 就能真驱动这两半。
 */
export function createWallpaperWindowController({ win, origin, display, initial = { skipTaskbar: false }, onNotice = () => {}, onLog = () => {} }) {
  let snapshot = null;

  return {
    isWallpaper() { return snapshot !== null; },
    /** 穿透的开/关只许从这里走（热点把交互临时还回来时也要用它，判据 ㉗ 钉唯一出处）。 */
    setPenetrated(on) { win.setIgnoreMouseEvents(Boolean(on), { forward: true }); },
    snapshot() { return snapshot; },

    enter() {
      if (snapshot) return { ok: false, reason: 'already-in-wallpaper' };
      // 快照必须在进入这一刻取：还原的语义是"回到进入前"，不是"回到进程刚启动"（run log §0.5 那一格教训）。
      snapshot = {
        bounds: { ...win.getBounds() },
        alwaysOnTop: win.isAlwaysOnTop(),
        resizable: win.isResizable(),
        movable: win.isMovable(),
        simpleFullScreen: win.isSimpleFullScreen(),
        // skipTaskbar 在本版本读不回来（没有 isSkipTaskbar），只能靠壳自己记的那份。
        skipTaskbar: Boolean(initial.skipTaskbar),
        url: origin,
      };
      // R207（形态 A′）· **进入时不置顶**：把它显式设成"不置顶"（而不是干脆不动这一项）有两个理由 ——
      // ① 进入项与还原项继续成对（清单形状一个字没动，判据 ㉓ 原样在册）；
      // ② 万一进入之前它是置顶的（用户手滑/别的工具设的），这一行负责把它清掉。
      // 代价如实写进文案：别的窗口盖住它时就看不见了，`Win+D` / 显示桌面也会把它一起盖住。
      // 穿透、铺满、不占任务栏、不可移动不可缩放、画的是那一档 surface —— 其余七项一个字没动。
      win.setAlwaysOnTop(false);
      win.setSkipTaskbar(true);
      win.setBounds(display.bounds);
      win.setResizable(false);
      win.setMovable(false);
      win.setSimpleFullScreen(true);
      win.loadURL(wallpaperSurfaceUrl(origin));
      win.setIgnoreMouseEvents(true, { forward: true });
      const bounds = win.getBounds();
      if (!coversWholeDisplay(bounds, display)) onNotice(`窗口没能铺满整块屏（量到 ${bounds.width}×${bounds.height}）：壁纸仍然可用，但边缘可能露出桌面。`);
      return { ok: true, snapshot, bounds };
    },

    /** 换屏 / 改分辨率：只重设几何，其余层级项不动（上游 `display-metrics-changed` 那一格的形状）。 */
    retarget(display) {
      if (!snapshot || !display) return { ok: false, reason: 'not-in-wallpaper' };
      win.setBounds(display.bounds);
      return { ok: true, bounds: win.getBounds(), covers: coversWholeDisplay(win.getBounds(), display) };
    },

    /**
     * 逆序还原；能读回的逐项读回对照，读不回的按快照写回（不一致要报，不许静默）。
     * `navigate:false` 用在**页面自己已经换回普通地址**那一趟：再 loadURL 一次就是多余的一次重载
     * （画面闪一下、播放从头），层级那几项照还原。
     */
    exit({ navigate = true } = {}) {
      if (!snapshot) return { ok: false, reason: 'not-in-wallpaper' };
      const was = snapshot;
      snapshot = null;
      win.setIgnoreMouseEvents(false);
      if (navigate) win.loadURL(was.url);
      win.setSimpleFullScreen(was.simpleFullScreen);
      win.setMovable(was.movable);
      win.setResizable(was.resizable);
      win.setBounds(was.bounds);
      win.setSkipTaskbar(was.skipTaskbar);
      win.setAlwaysOnTop(was.alwaysOnTop);
      const mismatch = [];
      const same = (label, got, want) => { if (JSON.stringify(got) !== JSON.stringify(want)) mismatch.push({ field: label, got, want, delta: null }); };
      same('alwaysOnTop', win.isAlwaysOnTop(), was.alwaysOnTop);
      same('resizable', win.isResizable(), was.resizable);
      same('movable', win.isMovable(), was.movable);
      same('simpleFullScreen', win.isSimpleFullScreen(), was.simpleFullScreen);
      // bounds 那一格不按逐字相等（R206 ②）：容差内 = Windows 的舍入补偿、只进日志；超容差才算真没回去。
      // R207（Q94 批复落地）· 容差内也要**按进入那一刻的快照再写回一次**：只记一行日志的话，
      // 用户频繁进出会看到"窗口一轮比一轮大"（R206 实测四趟 1921→1927，每轮 +1~2 px 全在容差内被放过）。
      // 写回之后再读一次、把**残差**报进同一行日志；**残差不升级成 mismatch** ——
      // 一次我们自己刚做的写回不该能触发用户侧告警（那正是 R206 ② 花力气消掉的那类误报）。
      const boundsGap = classifyBoundsRestore(win.getBounds(), was.bounds);
      mismatch.push(...boundsGap.over);
      let rounding = boundsGap.rounding;
      if (rounding.length > 0) {
        win.setBounds(was.bounds);
        rounding = classifyBoundsRestore(win.getBounds(), was.bounds).rounding;
        onLog(`退出壁纸：bounds 与进入前差 ${describeRestoreGaps(boundsGap.rounding)} —— 在 ${RESTORE_TOLERANCE_DIP} DIP 容差内，`
          + `已按进入那一刻的快照写回一次（写回后残差 ${rounding.length === 0 ? '0' : describeRestoreGaps(rounding)}）；不是没还原，不弹给用户。`);
      }
      return { ok: true, mismatch, rounding, restored: Object.keys(was) };
    },
  };
}
