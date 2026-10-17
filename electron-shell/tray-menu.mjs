// R204（Electron 壳最小件）· 托盘菜单（纯数据：菜单项长什么样、说什么话）。
//
// 形状沿上游那份（`electron/main.cjs` 2559-2705：checkbox 项 + separator 分组 + 最后一项 `app.quit()`），
// 内容按本件的任务书收口成四项：显示/隐藏、壁纸模式（**本件只做开关**）、分隔、退出。
// **R208 起那一项按总开关出现**：关着时菜单只剩**三项**（显示/隐藏 · 分隔 · 退出），
// 不留空位也不留灰项 —— 理由是那一档会打断播放（台账 R208 与 `wallpaper-switch.mjs` 的常量注释）。
// 上游那一份还有透明背景/点击穿透/总是置顶/隐藏任务栏/重置窗口 —— 那些都属"窗口层级那一跳"，
// 是第三期（M2/M3）的事，本件一件都不做（任务书 2.10）。
//
// Q53 那条口径在这儿也生效：这一格说的"壁纸模式"是壳这一层的真壁纸，
// 不是 M0 那档 surface（那一档在界面上叫「沉浸全屏（浏览器内）」）。
//
// R205 改的那一格（任务书点名的两格之一，台账写清"改前是什么"）：
// M1 的标签是「壁纸模式（第三期 · 本版本尚未生效）」，本件落地后那句"尚未生效"成了假话 ⇒ 换成如实描述；
// Q56 还要求"文案写清退出方式" ⇒ 开着的时候标签自己就说"再点一次退出"（这一项本身就是三把保险里的第一把）。

import { WALLPAPER_MODE_AVAILABLE } from './wallpaper-switch.mjs';

export const TRAY_ITEM_IDS = {
  toggleWindow: 'toggle-window',
  wallpaper: 'wallpaper-mode',
  openDataDir: 'open-data-dir',
  clearData: 'clear-data',
  quit: 'quit',
};

export const WALLPAPER_TRAY_LABEL = '壁纸模式（铺满桌面 + 点击穿透）';
export const WALLPAPER_TRAY_LABEL_ON = '壁纸模式（已开 · 再点一次退出）';

/** R209 · 数据管理两件的文案（口径第 8 条：这两件放壳侧 = 零新通道）。 */
export const DATA_TRAY_LABELS = { open: '打开数据目录', clear: '清空全部数据' };

/**
 * @param windowVisible 窗口现在看不看得见（读的是窗口自己那份事实，壳不另记一份）
 * @param wallpaperEnabled 壁纸那一档的状态；缺省关（任务书 2.6）
 * @param wallpaperAvailable 壁纸那一档**现在开不开放**；缺省读 `wallpaper-switch.mjs` 那一个常量
 *   （R208：关着时菜单只剩三项 —— 显示/隐藏 · 分隔 · 退出，**不留空位、不留灰项**）。
 *   做成形参只是为了判据能把"放回来是什么样"也钉住；接线侧（`main.mjs`）不传它 ⇒ 只读那一个常量。
 * @param dataItems R209：数据管理两件（打开数据目录 / 清空全部数据）。两种形态都在（它要壳的能力，
 *   而页面→壳没有通道），关着时那两项**排在壁纸项之后、分隔线之前**。
 */
export function buildTrayMenuItems({ windowVisible, wallpaperEnabled = false, wallpaperAvailable = WALLPAPER_MODE_AVAILABLE, dataItems = true }) {
  const on = Boolean(wallpaperEnabled);
  return [
    { id: TRAY_ITEM_IDS.toggleWindow, label: windowVisible ? '隐藏窗口' : '显示窗口', action: windowVisible ? 'hide' : 'show' },
    // R208：开关关着时这一格**整项不出现在菜单里**（不是灰项、也不是空位）——
    // 它对应的是"会打断播放"的那一档，入口先收起来；机制与动作处理都还在（`main.mjs` 的 case 原样留着）。
    ...(wallpaperAvailable
      ? [{ id: TRAY_ITEM_IDS.wallpaper, label: on ? WALLPAPER_TRAY_LABEL_ON : WALLPAPER_TRAY_LABEL, type: 'checkbox', checked: on, action: 'toggle-wallpaper' }]
      : []),
    ...(dataItems
      ? [
        { id: TRAY_ITEM_IDS.openDataDir, label: DATA_TRAY_LABELS.open, action: 'open-data-dir' },
        { id: TRAY_ITEM_IDS.clearData, label: DATA_TRAY_LABELS.clear, action: 'clear-data' },
      ]
      : []),
    { separator: true },
    { id: TRAY_ITEM_IDS.quit, label: '退出', action: 'quit' },
  ];
}
