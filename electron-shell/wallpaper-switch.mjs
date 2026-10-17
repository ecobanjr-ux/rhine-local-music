// R204（Electron 壳最小件）· 壁纸模式那一格的开关与二次确认。
// R205（壁纸 v1 · 形态 A）· 同一格里**文案换成如实描述**：M1 那句"尚未实现窗口沉底与点击穿透"
// 在本件落地后就是假话（任务书 Task 3 点名的那一格）。
//
// 三条口径同时住在这个文件里，分开写清是谁的：
//  1. **标题与两颗按钮仍逐字沿用上游**（`references/folia-major/src/i18n/locales/zh-CN.ts:1661-1663`，
//     基准 commit 369c34e6）⇒ 判据 ⑲ 那两格一个字都没动。
//  2. **正文不再逐字沿用**（这是本件的形状变化，不是放宽）：上游那句写的是
//     "窗口会沉到桌面最底层…进入后窗口无法关闭、最小化或移动" —— 那是 WorkerW 沉底形态的话，
//     我们做的是形态 A（置顶 + 真穿透），**照抄就是撒谎**。
//     本件按 A 形态重写，并把"不许出现的三句"钉成反向判据（沉到最底层 / 图标之下 / 无法关闭最小化或移动）。
//     产品名那一格仍是 M1 的判法：壳里不许出现 `Folia`，出现的是本产品名。
//  3. **Q53**：M0 那档 surface 在界面上叫「沉浸全屏（浏览器内）」，这一格说的"壁纸模式"是壳这一层的真壁纸；
//     两个名字各管各的，正文必须把右下角那颗按钮**按它本来的名字**指出来（渲染层不改，文案就得对上画面）。
//
// 上游那个形状也照下来：进入方向要确认、**离开方向不问**（`main.cjs` 2622-2641 的注释：
// "The click already flipped the checkbox; nothing is entered until the user confirms"）。

import { CLICK_THROUGH_UNLOCK_HOTSPOT } from './wallpaper-hotspot.mjs';
import { batteryNoticeFor, WALLPAPER_BATTERY_NOTICE_ENABLED } from './wallpaper-power.mjs';

export const WALLPAPER_SETTING_KEY = 'wallpaperMode';
export const WALLPAPER_DEFAULT_ENABLED = false;

/**
 * R208 · 壁纸模式的**总开关**（全仓唯一出处）。
 *
 * **为什么先藏起来（一句实话）**：进入这一档的实现是"让壳把窗口**导航**到 `?wallpaper=1`"
 * ⇒ **换了一份页面文档** ⇒ `<audio>` 重建、队列与播放位置（都住在旧文档内存里）全丢 ⇒ **播放停在原地**
 * （验收侧实测：切换后 `transport: idle` / `time: 0` / `track: null`，页面上打的 JS 标记也消失 = 文档真被换掉）。
 * **修法（页内切换、不换文档）留到以后做**；在那之前入口不出现，别让用户点到一个会打断播放的档。
 * 机制（`wallpaper-window.mjs` / `wallpaper-hotspot.mjs` / `wallpaper-power.mjs`）与它们的判据**原样留着**。
 *
 * **怎么放回来**：把这一行改回 `true` —— 托盘那一项与 `Ctrl+Alt+W` 那一条**都读这一个常量**
 * （判据 ㊶ 正面钉"全仓没有第二处需要改的开关"）。
 *
 * 对照：**沉浸全屏那一档不打断播放**（`app/src/folia-host/immersive.ts`，页内切换、同一份文档）
 * ⇒ 本件一个字都不动它（判据 ㊸ 正面钉）。
 */
export const WALLPAPER_MODE_AVAILABLE = false;

export const WALLPAPER_CONFIRM_TITLE = '进入壁纸模式？';
export const WALLPAPER_ENTER_ACTION = '进入壁纸模式';
export const WALLPAPER_CANCEL_ACTION = '取消';

/** 第一段：这一档到底做什么（铺满 + 只画歌词面 + **不置顶** + 不动系统壁纸）。 */
export const WALLPAPER_DOES_NOTE =
  '窗口会铺满整块屏幕，画的是歌词面那一档画面（播放器外壳不画）。'
  + '它不再常驻在最上面：别的窗口盖住它就看不见了（点一下那个窗口，或者按 Win+D 显示桌面，都会把它盖住）；'
  + '它在桌面图标之上，不是沉到图标底下。系统壁纸（桌面背景那张图）不会被改动。';

/** 第二段：代价（穿透 / 键盘到不了窗口 / 移动与缩放被关掉 / 任务栏不占格 —— Alt+Tab 仍能看到，实测样式位为案）。 */
export const WALLPAPER_COST_NOTE =
  '进入后鼠标会穿过去：点击落到它下面的窗口和桌面图标上，桌面照常可用。'
  + '反过来，键盘到不了这个窗口，它也移动不了、缩放不了；任务栏上不再占一格（Alt+Tab 里它还在）。';

/** 第三段：三条退出通道（**被别的窗口盖住时同样管用** —— 托盘与全局键都不依赖它在前台）。热点那格的四常量从唯一出处读，不在文案里再写一份数字。 */
export const WALLPAPER_EXIT_NOTE =
  `退出有三条路，任何一条都能出来（被别的窗口盖住时也一样）：\n`
  + `① 在系统托盘的 本地音乐播放器 菜单里再点一次「壁纸模式」；\n`
  + `② 按 Ctrl+Alt+W（穿透态下键盘到不了窗口，但这一条是全局键，照样按得到）；\n`
  + `③ 把光标移到屏幕右上角那一小块（宽 ${CLICK_THROUGH_UNLOCK_HOTSPOT.width}、高 ${CLICK_THROUGH_UNLOCK_HOTSPOT.height} 像素）`
  + `——它是穿透态下唯一吃得到鼠标的区域，光标进去后画面重新接住鼠标，并且会多保持一会儿，够你移到别处点一下；`
  + `然后点画面右下角那颗「退出沉浸（浏览器内）」，窗口会跟着一起退出壁纸模式。`
  + `想用手上的键盘退，就先在画面里点一下（Windows 只把键盘给"最后被点过"的那个窗口），再按 Esc。`;

/** 确认框正文的三段（顺序是判据：先说什么、再说什么、最后说怎么出来）。 */
export const WALLPAPER_CONFIRM_DETAIL = `${WALLPAPER_DOES_NOTE}\n\n${WALLPAPER_COST_NOTE}\n\n${WALLPAPER_EXIT_NOTE}`;

/**
 * 确认框的完整形状（纯数据：主进程只负责把它交给系统对话框 API）。
 * `onBattery` 决定要不要多一段"常驻画面在电池上就是耗电大户"的实话（Task 4，缺省开、可关）；
 * 那一段挂在**同一次确认**里，因为那正是用户做决定的那一刻 —— 拆开单独弹一次就是两次打断。
 */
export function wallpaperConfirmDialog({ onBattery = false, noticeEnabled = WALLPAPER_BATTERY_NOTICE_ENABLED } = {}) {
  const battery = batteryNoticeFor({ onBattery, enabled: noticeEnabled });
  return {
    type: 'warning',
    title: WALLPAPER_CONFIRM_TITLE,
    message: WALLPAPER_CONFIRM_TITLE,
    detail: battery ? `${WALLPAPER_CONFIRM_DETAIL}\n\n${battery}` : WALLPAPER_CONFIRM_DETAIL,
    buttons: [WALLPAPER_CANCEL_ACTION, WALLPAPER_ENTER_ACTION],
    defaultId: 0,
    cancelId: 0,
  };
}

/** 哪个方向需要确认：只有"进"。 */
export function wallpaperNeedsConfirmation({ current, wants }) {
  return !current && Boolean(wants);
}

/**
 * 开关的真值表（判据 ㉑）。取消那一格必须**原样退回**：
 * 菜单项被点时系统已经把勾打上去了，我们不改状态、下一次重画就把它弹回原样。
 */
export function decideWallpaperToggle({ current, wants, confirmed = false }) {
  const asked = wallpaperNeedsConfirmation({ current, wants });
  if (asked && !confirmed) return { enabled: false, asked: true };
  return { enabled: Boolean(wants), asked };
}
