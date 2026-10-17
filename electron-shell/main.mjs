// R204（M1）· 壳的入口：单实例 → 把服务带起来 → 只画那一页 → 托盘与全局键。
// R205（壁纸 v1 · 形态 A）· 同一份接线里加上"窗口层级那一跳"：托盘项 / 全局键真的进入与退出，
// 退出三把保险（托盘 · 全局键 · 屏幕角落解锁热点）任一没就位就**不许进入**。
//
// 分工写死在这里：服务侧的事（端口、复用、启动锁、缺构建的实话、日志落点）在 `service-launch.mjs`
// + 启动器那一个出处；窗口侧的事（本机地址红线、安全口径）在 `window.mjs`；
// **层级那一跳只在 `wallpaper-window.mjs`**（判据 ㉗），热点几何与看守只在 `wallpaper-hotspot.mjs`。
// 本文件只做接线 ⇒ 零地址字面量、零判定、零播放状态、不直接调任何层级 setter（判据 ⑦⑯⑰⑱㉗）。
import { app, Tray, Menu, nativeImage, globalShortcut, dialog, screen, powerMonitor, shell } from 'electron';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { appendFile } from 'node:fs/promises';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { resolveDataDir, shellProfileDir, dataDirLooksNew } from './app-paths.mjs';
import { CLEAR_DATA_ENTRIES, clearPlanFor, clearDataConfirmDialog, clearDataSummary, libraryRootsFromConfig } from './data-admin.mjs';
import { APP_DIR, createShellService } from './service-launch.mjs';
import { shellOrigin } from './shell-url.mjs';
import { createShellWindow, focusShellWindow, hideShellWindow, isShellWindowVisible, revealShellWindow } from './window.mjs';
import { buildTrayMenuItems, TRAY_ITEM_IDS } from './tray-menu.mjs';
import { SHELL_SHORTCUTS, SHELL_WINDOW_ACTION, SHELL_WALLPAPER_ACTION, isForwardedAction } from './shortcuts.mjs';
import { commandClickScript } from './page-commands.mjs';
import { decideStartup, describeSecondInstance } from './single-instance.mjs';
import { decideWallpaperToggle, wallpaperConfirmDialog, wallpaperNeedsConfirmation } from './wallpaper-switch.mjs';
import { createWallpaperWindowController, decideWallpaperEntry, describeRestoreGaps, isWallpaperSurfaceUrl, pickTargetDisplay } from './wallpaper-window.mjs';
import { createHotspotWatcher } from './wallpaper-hotspot.mjs';
import { createHintLayer, HINT_AUTO_DISMISS_MS } from './page-hints.mjs';

// Windows 上任务栏与通知的归属（上游 5349 那一格；不给的话托盘与任务栏会认成 electron.exe）
app.setAppUserModelId('com.rhinelab.local-music');

/**
 * R216：壳自己所在目录（程序目录之一，清空的安全闸要拿它比对）。
 * 这一格从前写成 CJS 的目录变量 —— `.mjs` 是 ESM、没有那个绑定 ⇒ 真机点「清空全部数据」当场 ReferenceError
 *（验收侧 2026-10-13 抓的 P1；那一行是"组装参数"，抛得早于确认框与删除，没有伤到数据）。
 * ESM 的唯一写法就是下面这行（判据 ５３ 把全壳的旧绑定钉死为零命中）。
 */
const HERE_DIR = path.dirname(fileURLToPath(import.meta.url));

/**
 * R209 · 数据目录三段式 + 浏览器配置目录重定向（方案 §一.4）。**必须在 whenReady 之前**：
 * `app.setPath('userData', …)` 在 ready 之后改不动（验收侧复核点名的三条实现字之一）。
 * 而且要在**单实例锁之前** —— 那把锁的载体就在 userData 里（换目录 = 换锁文件）。
 * 解析规则只有一处（`app-paths.mjs`）：`MUSIC_DATA_DIR` > 打包态 `%LOCALAPPDATA%\RhineMusic` > 开发形态默认（不动）。
 */
const dataPaths = resolveDataDir({
  env: process.env,
  isPackaged: app.isPackaged,
  localAppData: process.env.LOCALAPPDATA ?? path.join(os.homedir(), 'AppData', 'Local'),
});
// **要在我们自己建 `shell-profile` 之前算**：那一步会把数据目录一并建出来（"新不新"就再也判不出来了）
const dataDirLooksFresh = dataDirLooksNew({ dataDir: dataPaths.dataDir, fs: { readdirSync } });
const profileDir = shellProfileDir({ dataDir: dataPaths.dataDir });
if (profileDir) {
  // 目录要先在：Electron 自己也会建，但先建一次能保证"重定向真的生效"（读数列进判据 ⑧）
  try { mkdirSync(profileDir, { recursive: true }); } catch { /* 建不出来也别拦启动 */ }
  app.setPath('userData', profileDir);
}

// 单实例锁必须在 whenReady 之前拿（上游 2733 与 1531 就是这个次序）。
const gotLock = app.requestSingleInstanceLock();
if (decideStartup({ gotLock }) === 'quit-duplicate') {
  app.exit(0);
}

let mainWindow = null;
let tray = null;
let shellPort = null;
let wallpaper = null;
let hotspot = null;
let hints = null;
let sessionTargetDisplayId = null;
let registeredShortcuts = 0;
// 壁纸态的开关值（M1 起就在，只是那时它对应"什么都没做"；本件它真的对应一个窗口状态）。
// `wallpaper` 那份控制器只在壁纸态存在：进入新建、退出置空 ⇒ 快照不可能跨两轮复用（判据 ㉓ 的语义）。
let wallpaperEnabled = false;

/**
 * R206 ② · "读得回、只差一两像素"那一档落地的地方：壳与服务共用同一份日志
 * （`service-launch.mjs` 的 `SERVICE_LOG_NAME`，排查时只有一个地方要看）。
 * **复用在跑的服务时壳没有开过那个文件** ⇒ 拿不到路径，退化成主进程一行输出，绝不弹窗。
 * 这一格不许变成 `notice()`：验收侧 F1 定性过，舍入差弹给用户就是假话。
 */
function logRestoreNote(text) {
  const logPath = service.logPath();
  if (!logPath) { console.info(text); return; }
  void appendFile(logPath, `[${new Date().toISOString()}] ${text}\n`).catch(() => undefined);
}

const service = createShellService({
  // 启动器这一步的原意是"开默认浏览器"。壳把它换成自己的窗口，所以这里故意什么都不做：
  // 端口由下面 `launch()` 的返回值给（一个来源），不在这里回读地址串 ⇒ 免得出现第二处解析。
  onUrl: async () => {},
  // R209：数据目录**只在这一个出处解析**（`app-paths.mjs`）—— 打包态是 `%LOCALAPPDATA%\RhineMusic`，
  // 开发形态是 `null`（= 让启动器按今天的默认走，那两行一个字不动）。顺带把"这一档是谁赢的"传给服务
  // （只读接口 `/api/data-dir` 要如实回 source）。
  dataDir: dataPaths.dataDir ?? undefined,
  dataDirSource: dataPaths.source,
});

function notice(message) {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  void dialog.showMessageBox(mainWindow, { type: 'info', title: '本地音乐播放器', message, buttons: ['知道了'] });
}

/**
 * R209 · 「打开数据目录」（口径第 8 条）。壳侧能力（`shell.openPath`），**页面→壳零通道**不变。
 * 数据目录还没建出来时先建出来再开（空目录也是有效的落点，用户能看到"数据将来放这儿"）。
 */
function openDataDirectory() {
  const dataDir = dataPaths.dataDir;
  if (!dataDir) { notice('这个形态没有独立的数据目录（开发形态的数据就在仓库旁边）。'); return; }
  try { mkdirSync(dataDir, { recursive: true }); } catch { /* 建不出来就让 openPath 自己报到 */ }
  void shell.openPath(dataDir).then((errorText) => {
    if (errorText) notice(`没能打开数据目录：${errorText}\n\n它在这里：${dataDir}`);
  });
}

/**
 * R209 · 「清空全部数据」（口径第 9 条）。四条形状，一条都不许省：
 * ① **白名单**（`data-admin.mjs` 的 `CLEAR_DATA_ENTRIES`）——绝不整目录删；② **安全闸**（曲库根落在数据目录里、
 * 或与程序目录重叠 ⇒ 宁可不删）；③ **原生二次确认**并逐项列出、明写"你的音乐文件不会被删"；
 * ④ 清完给回执（删了什么 / 没删动什么 / 有没有留下不认识的东西 / 已退出登录）。
 */
function clearAllData() {
  const dataDir = dataPaths.dataDir;
  const libraryRoots = dataDir ? libraryRootsFromConfig({ readFileSync }, dataDir) : [];
  // R216：参数组装挪进 `data-admin.mjs` 的纯函数（`clearPlanFor`）—— 从前这段住在这一行里，
  // 其中程序目录那一项写错（ESM 里的 CJS 绑定）就整条路崩；这里现在只负责"调它"。
  const plan = clearPlanFor({ dataDir, libraryRoots, programDirs: [APP_DIR, HERE_DIR], fs: { existsSync } });
  if (!plan.allowed) {
    const why = {
      'no-data-dir': '这个形态没有独立的数据目录，没有可以清空的东西。',
      'library-inside-data-dir': `你的曲库目录就在数据目录里面（${plan.detail ?? ''}）—— 清空会连音乐文件一起删掉，所以这次不动手。请先把数据目录改到别处（MUSIC_DATA_DIR）。`,
      'overlaps-program-dir': `数据目录与程序目录重叠（${plan.detail ?? ''}）—— 清空可能删到程序文件，所以这次不动手。`,
    }[plan.reason] ?? '这次没能清空（原因未知）。';
    notice(why);
    return;
  }
  const choice = dialog.showMessageBoxSync(mainWindow ?? undefined, clearDataConfirmDialog({
    dataDir,
    targets: plan.targets,
    libraryRoots,
    onBattery: powerMonitor.isOnBatteryPower(),
  }));
  if (choice !== 1) return; // 缺省与取消都是 0

  const removed = [];
  const failed = [];
  for (const entry of plan.targets) {
    try {
      rmSync(path.join(dataDir, entry.path), { recursive: true, force: true });
      removed.push(entry.label);
    } catch {
      failed.push(entry.label);
    }
  }
  let leftover = [];
  try {
    const known = new Set(CLEAR_DATA_ENTRIES.map((entry) => entry.path));
    leftover = readdirSync(dataDir).filter((name) => !known.has(name));
  } catch { /* 读不到就不提 */ }
  notice(clearDataSummary({ removed, failed, leftover }));
}

/** 目标屏：沿上游的粘滞顺序（① 窗口所在屏 → ② 本会话目标 → ③ 主屏兜底）。 */
function targetDisplay() {
  const picked = pickTargetDisplay({
    displays: screen.getAllDisplays(),
    windowBounds: mainWindow?.getBounds(),
    sessionTargetId: sessionTargetDisplayId,
  });
  sessionTargetDisplayId = picked.display?.id ?? null;
  return picked.display;
}

/** 看守只需要一个（它按"在/不在热点里"的跳变上报，控制器换了照旧能用）。 */
function ensureHotspot() {
  if (hotspot) return hotspot;
  ensureHints();
  hotspot = createHotspotWatcher({
    getCursor: () => screen.getCursorScreenPoint(),
    getContentBounds: () => mainWindow?.getContentBounds(),
    // 进/出热点 = 把交互临时还给窗口 / 收回穿透。setter 一律走 controller（层级那一跳的唯一出处）。
    // 穿透态下窗口收不到任何点击，所以"点一下钉住交互"在 A 形态下物理上不成立：
    // 长期拿回交互走 Ctrl+Alt+W 或托盘退出壁纸模式（台账 R205 登记这一格差异）。
    //
    // R206 ① 焦点回收（本件最划算的一改）：进去那一跳除了收回穿透，还要把**窗口焦点**拿回来。
    // 验收侧实测的那格是"用户点过桌面之后焦点跑掉 ⇒ `Esc` 永久失效"（窗口穿透、点不回去、
    // 没法把焦点还给它）；焦点一回来，`Esc` 这条最顺手的退路就重新可用了。
    // `focusShellWindow` 是窗口焦点那件事的唯一出处（window.mjs，托盘与 second-instance 都走它），
    // 不在这里另写一份 restore/show/focus 序列。
    onEnter: () => {
      if (!wallpaper?.isWallpaper()) return;
      wallpaper.setPenetrated(false);
      focusShellWindow(mainWindow);
      hints.showHotspot();
    },
    onLeave: () => {
      if (!wallpaper?.isWallpaper()) return;
      wallpaper.setPenetrated(true);
      hints.hideHotspot();
    },
    // R206 ① · 焦点那一格不是一次就成的：Windows 的前台锁只放行"收到最后一次输入的那个进程"，
    // 而 onEnter 那一拍穿透还没收回来、那次光标移动根本没送进本窗口 ⇒ 真机量到 focus 失败。
    // 停在热点里的后续每一拍都会送输入进本窗口 ⇒ 那时重试才可能成；拿到焦点就停（isFocused 门住，不无脑刷）。
    onInside: () => {
      if (!wallpaper?.isWallpaper()) return;
      if (!mainWindow || mainWindow.isDestroyed() || mainWindow.isFocused()) return;
      focusShellWindow(mainWindow);
    },
  });
  return hotspot;
}

/**
 * R206 ① · 屏幕上那两条提示的唯一层（`page-hints.mjs` 是文案与时长唯一出处，这里不写第二份）。
 * 通道只有主进程往页面执行一段脚本这一条（壳没有 preload，三件套不许松 —— 理由记在模块头）。
 */
function ensureHints() {
  if (hints) return hints;
  hints = createHintLayer({
    runInPage: (script) => {
      if (!mainWindow || mainWindow.isDestroyed()) return;
      mainWindow.webContents.executeJavaScript(script).catch(() => undefined);
    },
  });
  return hints;
}

function shortcutsReady() {
  return registeredShortcuts === SHELL_SHORTCUTS.length;
}

/** 三把保险是否**真的**都在（托盘项在 / 全局键全注册成功 / 热点看守真的在轮询）。 */
function insuranceState() {
  return { trayReady: Boolean(tray), shortcutReady: shortcutsReady(), hotspotReady: Boolean(hotspot?.running()) };
}

/** 进入之前先验的那两把 —— 看守要 start() 之后才算第三把，这里按"看守建出来了"预验。 */
function preflightState() {
  return { trayReady: Boolean(tray), shortcutReady: shortcutsReady(), hotspotReady: Boolean(ensureHotspot()) };
}

function enterWallpaperMode() {
  // 少一把就不弹确认：给一个注定进不去的确认框，比给一句实话更糟。
  const before = decideWallpaperEntry(preflightState());
  if (!before.allow) { notice(before.message); return; }
  const confirmed = wallpaperNeedsConfirmation({ current: wallpaperEnabled, wants: true })
    // 电池那一格的读数只有这一个出处（Task 4）：确认那一刻的状态，喂给确认框那一句实话。
    ? dialog.showMessageBoxSync(mainWindow ?? undefined, wallpaperConfirmDialog({ onBattery: powerMonitor.isOnBatteryPower() })) === 1
    : false;
  wallpaperEnabled = decideWallpaperToggle({ current: wallpaperEnabled, wants: true, confirmed }).enabled;
  if (!wallpaperEnabled) return;

  // 控制器**每次进入新建一份**：快照的语义是"回到进入那一刻"，复用上一轮的实例就会拿上一轮的还原值当基准。
  wallpaper = createWallpaperWindowController({
    win: mainWindow,
    origin: shellOrigin(shellPort),
    display: targetDisplay(),
    initial: { skipTaskbar: false },
    onNotice: notice,
    // R206 ②：容差之内的舍入差走这一格（日志），不走 `onNotice`（弹窗）。
    onLog: logRestoreNote,
  });
  ensureHotspot().start();
  const gate = decideWallpaperEntry(insuranceState());
  if (!gate.allow) {
    // 看守起不来 = 少一把保险 ⇒ 压根不进去，不把人留在穿透态里。
    hotspot.stop();
    wallpaper = null;
    wallpaperEnabled = false;
    notice(gate.message);
    return;
  }
  // 先把窗口带回可见态再做那一跳：最小化时 setBounds / setSimpleFullScreen 的几何不可靠。
  // R207（形态 A′）：这一格从 `focusShellWindow` 换成 `revealShellWindow`（`showInactive()`）——
  // 进入那一刻**不激活、不抢前台**，否则它会盖住用户正在用的应用（与"不置顶"是同一条口径）。
  // **热点那条路的 focus 一个字没动**（R206 的 P0：光标进热点 ⇒ 取消穿透 + 拿回焦点，Esc 才管用）。
  revealShellWindow(mainWindow);
  const entered = wallpaper.enter();
  if (!entered.ok) {
    hotspot.stop();
    wallpaper = null;
    wallpaperEnabled = false;
    notice(`壁纸模式没能进入（${entered.reason ?? '未知原因'}）。窗口保持原样，照常可用。`);
    return;
  }
  // R206 ① · 屏幕上必须有一条"怎么出去"（验收侧实测：画面上哪儿都没写，用户只能靠记得快捷键或翻托盘）。
  // 挂在页面自己的 toast 上走不通：那一格在壁纸 surface 下被常驻隐藏（R203 判据⑤ 的清单里有 `#music-toast`），
  // 所以这一条由壳给。`enter()` 刚刚导航过一次，文档正在换 ⇒ 等新文档加载完再挂，挂早了会被那次导航清掉。
  const showEntryHint = () => { if (wallpaper?.isWallpaper()) ensureHints().showEnter(); };
  if (mainWindow.webContents.isLoading()) mainWindow.webContents.once('did-finish-load', showEntryHint);
  else showEntryHint();
}

function exitWallpaperMode({ navigate = true } = {}) {
  wallpaperEnabled = false;
  hotspot?.stop();
  // 提示与热点反馈都不许留到普通窗口上（一条挂在墙上的字跑到桌面上就是新障碍）。
  hints?.clear();
  const result = wallpaper?.exit({ navigate });
  wallpaper = null;
  if (result?.mismatch?.length) {
    // R206 ②：只有**超容差**的缺口才弹，且要说得出差在哪一项、差多少。
    // "读得回、只差 1~2 px"那一档由控制器在还原时就交给自己那份 `logRestoreNote`（日志，不弹窗）。
    notice(`退出壁纸模式时有 ${result.mismatch.length} 项没回到进入前的样子：${describeRestoreGaps(result.mismatch)}。窗口仍可用，请留意它的位置或大小。`);
  }
  refreshTrayMenu();
}

function refreshTrayMenu() {
  if (!tray) return;
  tray.setContextMenu(Menu.buildFromTemplate(
    buildTrayMenuItems({ windowVisible: isShellWindowVisible(mainWindow), wallpaperEnabled }).map((item) => {
      if (item.separator) return { type: 'separator' };
      if (item.type === 'checkbox') return { label: item.label, type: 'checkbox', checked: item.checked, click: () => runTrayAction(item.action) };
      return { label: item.label, click: () => runTrayAction(item.action) };
    }),
  ));
}

function runTrayAction(action) {
  switch (action) {
    case 'show':
      focusShellWindow(mainWindow);
      break;
    case 'hide':
      hideShellWindow(mainWindow);
      break;
    case 'toggle-wallpaper':
      // 进入方向：三把保险 → 二次确认 → 那一跳；离开方向：不问，直接逐项还原。
      if (!wallpaperEnabled) enterWallpaperMode();
      else exitWallpaperMode();
      break;
    // R209 · 数据管理两件（口径第 8 条：放壳侧 ⇒ 零新通道）
    case 'open-data-dir':
      openDataDirectory();
      break;
    case 'clear-data':
      clearAllData();
      break;
    case 'quit':
      app.quit();
      break;
    default:
      return;
  }
  refreshTrayMenu();
}

function createTray() {
  const image = nativeImage.createFromPath(path.join(APP_DIR, 'public', 'icons', 'icon-192.png'));
  // 上游 2709-2728 那一格就是这么写的：建不出来只记一句，不许把应用带崩。
  if (image.isEmpty()) return null;
  const created = new Tray(image.resize({ width: 16, height: 16 }));
  created.setToolTip('本地音乐播放器');
  created.on('click', () => {
    if (!isShellWindowVisible(mainWindow)) focusShellWindow(mainWindow);
    refreshTrayMenu();
  });
  return created;
}

function registerShortcuts() {
  registeredShortcuts = 0;
  for (const { accel, action } of SHELL_SHORTCUTS) {
    const ok = globalShortcut.register(accel, () => {
      if (action === SHELL_WINDOW_ACTION) {
        runTrayAction(isShellWindowVisible(mainWindow) ? 'hide' : 'show');
        return;
      }
      if (action === SHELL_WALLPAPER_ACTION) {
        // 穿透态下键盘到不了窗口，这一条是"退出壁纸"的最后一把保险（方案四.5）。
        runTrayAction('toggle-wallpaper');
        return;
      }
      if (!isForwardedAction(action) || !mainWindow || mainWindow.isDestroyed()) return;
      // 只转发：点页面里既有那颗按钮，禁用态由页面自己说（判据 ⑯）。
      mainWindow.webContents.executeJavaScript(commandClickScript(action)).catch(() => undefined);
    });
    if (ok) registeredShortcuts += 1;
  }
}

app.whenReady().then(async () => {
  let result;
  try {
    result = await service.launch();
  } catch (error) {
    // 失败要说人话：壳不假装打开了，也不把"没就绪"改写成"已经在跑了"。
    dialog.showErrorBox('本地音乐播放器没有打开', String(error?.message ?? error));
    app.exit(1);
    return;
  }
  shellPort = result?.port ?? null;
  mainWindow = createShellWindow({ port: shellPort });
  mainWindow.on('closed', () => { mainWindow = null; });
  // R209 · 首次启动把"数据目录在哪"说出来（口径第 7 条）：**只在它之前不存在/是空的时说一次** ——
  // 系统目录不像程序旁边那么看得见，所以这一句必须有；但它只说一次，不当每次启动的打扰。
  if (dataPaths.dataDir && dataDirLooksFresh) {
    mainWindow.webContents.once('did-finish-load', () => {
      const canChange = dataPaths.source === 'packaged-default'
        ? '\n\n想换到别的地方（例如移动硬盘）：设环境变量 MUSIC_DATA_DIR 指过去。'
        : '';
      notice(`数据目录：${dataPaths.dataDir}${canChange}`);
    });
  }
  mainWindow.on('show', refreshTrayMenu);
  mainWindow.on('hide', refreshTrayMenu);
  mainWindow.webContents.on('did-navigate', (_event, url) => {
    // 页面自己退出了那一档（`Esc` / 双击 / 右下角那颗「退出沉浸（浏览器内）」，都走 location.replace）：
    // 地址已经回普通页，层级那一跳还挂在窗口上 ⇒ 必须跟着逐项还原，否则表现为"画面正常、窗口置顶又穿透"。
    // 地址不再 loadURL 一遍（页面已经在那儿，再导航就是一次多余的重载）。
    if (!wallpaper?.isWallpaper()) return;
    if (isWallpaperSurfaceUrl(url)) return;
    exitWallpaperMode({ navigate: false });
  });
  screen.on('display-metrics-changed', () => {
    // 换分辨率/缩放时，壁纸态要重新铺满当前目标屏（上游那条注释：监听不能只挂在启动时的分支上）。
    if (!wallpaper?.isWallpaper()) return;
    const display = targetDisplay();
    if (display) wallpaper.retarget(display);
  });
  tray = createTray();
  refreshTrayMenu();
  registerShortcuts();
});

app.on('second-instance', () => {
  // Task 0 实测：第二实例只该做这一件事 —— 把已有窗口带回前台（命令行不读，见 single-instance.mjs）。
  describeSecondInstance();
  focusShellWindow(mainWindow);
});

app.on('window-all-closed', () => {
  app.quit();
});

// 退出顺序：先把壁纸态逐项还原（不留一个"出不来"的窗口）→ 注销全局键 → 收**壳自己起的那一个**服务。
// 复用在跑的服务一个字都不动（历史事故那条纪律；判据 ⑬ 正面钉过）。
app.on('before-quit', () => {
  // navigate:false：都要退了，再 loadURL 一次只是多一次没人看的中途重载。
  if (wallpaper?.isWallpaper()) exitWallpaperMode({ navigate: false });
  globalShortcut.unregisterAll();
  service.stop();
});
