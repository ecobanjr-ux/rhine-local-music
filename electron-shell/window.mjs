// R204（Electron 壳最小件）· 窗口与"只吃本机地址"那四条红线。
//
// 为什么必须有这四条：Task 0 实测过，**没有守卫时 Electron 自己不拦远程地址** ——
// 直接 `loadURL` 一个外部串它会照样去取（探针那次回 `ERR_NAME_NOT_RESOLVED` 是因为我故意用保留域，
// 不是它拦下来的）。所以"壳只加载本机那一个服务"这件事只能由我们写死，并且四处都得读同一个判定
// （判定住在 `shell-url.mjs`，与本文件无关的第二份 hostname 比较即违例）。
//
// 为什么**不是** `loadFile(dist/index.html)`：上游那一格（main.cjs:4322-4334）在它的架构里成立，
// 因为它的接口与页面同源同进程；我们的渲染层必须由那个服务提供（同源接口、同源封面代理、
// Range 流式、SSE），`file://` 一条都拿不到 ⇒ 这一格是"架构不适配"的薄适配层，登记在 R204。
//
// 无边框（frame:false）本件**不做**：自绘标题栏是另一件事（上游有整套），
// 最小件先保留系统边框，退出通道因此天然齐全（窗口关闭 + 托盘 + 全局快捷键），
// 三期壁纸那一档才需要 frame:false（那是窗口层级那一跳的事）。这一格登记为待确认。
import { BrowserWindow, session } from 'electron';
import { isAllowedShellUrl, shellOrigin } from './shell-url.mjs';

/** 本壳只有一个窗口：所有新窗口请求一律拒（M1 没有第二块画面）。 */
const DENY_NEW_WINDOW = { action: 'deny' };

function netFilter() {
  // 只过网络类协议：`data:` / `blob:` 这些页面内部对象不该被这条红线牵连。
  return { urls: ['http://*/*', 'https://*/*', 'ws://*/*', 'wss://*/*'] };
}

export function createShellWindow({ port }) {
  const target = shellOrigin(port);
  // 连自己拼出来的那一个也要过一遍判定：这格看着多余，但它钉的是"判定与拼装不许分叉"。
  if (!isAllowedShellUrl(target, port)) {
    throw new Error('内部错误：壳自己的地址没有通过本机地址判定');
  }

  const win = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 900,
    minHeight: 600,
    autoHideMenuBar: true,
    show: true,
    webPreferences: {
      // 三件套按任务书 2.3：这一组比上游更严（上游 webPreferences 没有 sandbox 那一格）。
      // 没有 preload —— 本件的开关全部在托盘侧，渲染层不需要任何系统能力；
      // 不留没有读者的口子（"接口的存在不等于接口被用"这条教训在自己身上落过三次）。
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      backgroundThrottling: false,
    },
  });

  // 三条导航红线的决定全部走同一个判定；`will-redirect` 多带一个候选串，
  // 因为那个事件的 `url` 是"发起的地址"、`redirectURL` 才是"要去的地址"（Electron 事件形状），
  // 两个都不本机才算出网 —— 少判一个就等于给重定向留口子。
  const rejectNavigation = (event, ...candidates) => {
    if (candidates.some((url) => isAllowedShellUrl(url, port))) return;
    event.preventDefault?.();
  };

  // 红线一：窗口内导航（点链接、location 改地址）
  win.webContents.on('will-navigate', (event) => rejectNavigation(event, event.url));
  // 红线二：子框架导航
  win.webContents.on('will-frame-navigate', (event) => rejectNavigation(event, event.url));
  // 红线三：重定向 —— 本机地址被重定向到外部，也算出网
  win.webContents.on('will-redirect', (event) => rejectNavigation(event, event.url, event.redirectURL));
  // 红线四：新窗口 —— 无条件拒，不看地址
  win.webContents.setWindowOpenHandler(() => DENY_NEW_WINDOW);

  // 兜底：请求层再拦一次。前三条管的是"页面自己想去哪儿"，这条管"任何部件想去哪儿"。
  session.defaultSession.webRequest.onBeforeRequest(netFilter(), (details, callback) => {
    callback({ cancel: !isAllowedShellUrl(details.url, port) });
  });

  void win.loadURL(target);
  return win;
}

// 窗口的"看得见吗 / 带回前台 / 收起来"三格，形状沿上游 main.cjs 的 2357 / 2371 / 2375
// （`isMinimized() → restore()` 再 `show()` 再 `focus()`）。托盘与全局快捷键都读这一份事实，
// 壳不在别处另记"窗口是不是开着"。

export function isShellWindowVisible(win) {
  return Boolean(win && !win.isDestroyed() && win.isVisible() && !win.isMinimized());
}

export function focusShellWindow(win) {
  if (!win || win.isDestroyed()) return false;
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
  return true;
}

/**
 * R207（形态 A′）· 把窗口**露出来但不激活它**。
 *
 * 为什么与 `focusShellWindow` 分开：`show()` + `focus()` 会把窗口排到普通窗口的最前（还会抢前台），
 * 而壁纸这一档从 R207 起**不置顶** —— 进入那一刻它不该盖住用户正在用的应用
 * （用户口径：别的应用被点到 / 切到前面时，要能盖住它）。
 * `showInactive()` 是 Electron 给的那一格：显示但不激活。
 *
 * 一处如实登记的边界：窗口若**恰好处于最小化**，`restore()` 那一跳本身会把窗口激活一次 ——
 * 这一格本件没在真机上量到（进入之前窗口通常就在眼前），先按"最小化的极端情形也照常能进去"写，
 * 读数列进 run log 的待测清单。
 */
export function revealShellWindow(win) {
  if (!win || win.isDestroyed()) return false;
  if (win.isMinimized()) win.restore();
  win.showInactive();
  return true;
}

export function hideShellWindow(win) {
  if (!win || win.isDestroyed()) return false;
  if (win.isMinimized()) win.restore();
  win.hide();
  return true;
}
