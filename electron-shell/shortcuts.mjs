// R204（Electron 壳最小件）· 全局快捷键表（纯数据 + 双向查表）。
//
// 四条：播放/暂停、上一首、下一首、显示/隐藏窗口（任务书 2.6）。
// **R208 起壁纸那一条（R205 加的 `Ctrl+Alt+W`）按总开关出现**：开关关着时表里就是这四条，
// 那一条**不注册**（理由与恢复方式在 `wallpaper-switch.mjs` 的 `WALLPAPER_MODE_AVAILABLE` 注释里）。
// **不注册系统媒体键** —— 一手量过 Electron 43 在 Windows 上 `MediaPlayPause` 等三条都能注册成功
// （run log §0.2④），但媒体键本来由页面的 Media Session 处理（`src/media-session.ts`，
// 那一条早就证明了不需要壳）；壳再全局劫持一次，会在"浏览器里也在放歌"时让一次按键动两处。
// ⇒ 全局键用带修饰键的组合，媒体键留给页面。这一格登记为待确认。
import { SHELL_COMMAND_SELECTORS } from './page-commands.mjs';
import { WALLPAPER_MODE_AVAILABLE } from './wallpaper-switch.mjs';

/** 窗口自己的动作（不转发给页面）单独一档，别和播放命令混在一起。 */
export const SHELL_WINDOW_ACTION = 'toggle-window';

/** R205：壁纸模式的退出保险之一。M1 那四条一个字不动，本件**加**一条（任务书 2.6 的"至少一条能退出壁纸模式"）。 */
export const SHELL_WALLPAPER_ACTION = 'toggle-wallpaper';

/** M1 那四条：播放/暂停、上一首、下一首、显示/隐藏窗口 —— 无论壁纸那一档开不开放，**这四条都不动**。 */
export const BASE_SHELL_SHORTCUTS = [
  { accel: 'CommandOrControl+Alt+P', action: 'play-pause' },
  { accel: 'CommandOrControl+Alt+N', action: 'track-next' },
  { accel: 'CommandOrControl+Alt+B', action: 'track-prev' },
  { accel: 'CommandOrControl+Alt+M', action: SHELL_WINDOW_ACTION },
];

/** R205 加的那一条（穿透态下键盘到不了窗口，全局键是唯一必然按得到的退出通道）。 */
export const WALLPAPER_SHORTCUT = { accel: 'CommandOrControl+Alt+W', action: SHELL_WALLPAPER_ACTION };

/**
 * 快捷键表：壁纸那一条**按总开关出现**（R208）。
 * 开关关着时表里就四条 —— `Ctrl+Alt+W` **不注册**（不是注册了再无视，是压根不进表，
 * 因为"注册了但没反应"本身就是一种骗人）；打开开关即五条。
 * 做成函数只是为了判据能把"放回来是什么样"也钉住；`SHELL_SHORTCUTS` 是接线读的那一份（缺省 = 读常量）。
 */
export function shellShortcuts(wallpaperAvailable = WALLPAPER_MODE_AVAILABLE) {
  return wallpaperAvailable ? [...BASE_SHELL_SHORTCUTS, WALLPAPER_SHORTCUT] : [...BASE_SHELL_SHORTCUTS];
}

export const SHELL_SHORTCUTS = shellShortcuts();

/** 完整的五条（不管开关）—— 给判据与台账看"这一档本来长什么样"。 */
export const ALL_SHELL_SHORTCUTS = shellShortcuts(true);

export function shortcutAction(accel) {
  const hit = SHELL_SHORTCUTS.find((item) => item.accel === accel);
  return hit ? hit.action : null;
}

/** 这条动作是不是"转发给页面那颗既有按钮"（否则就是壳自己的窗口事）。 */
export function isForwardedAction(action) {
  return Object.prototype.hasOwnProperty.call(SHELL_COMMAND_SELECTORS, action);
}
