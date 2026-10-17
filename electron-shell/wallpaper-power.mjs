// R205（壁纸 v1 · 形态 A）· 常驻与功耗：**这一件做得到什么、做不到什么，都写在这一个文件里**。
//
// 任务书那一格写的是"电池供电时降到克制档（与页面既有的'减少动态效果'同一处落或等价机制），并且可关"。
// 本件只落"做得到且不撒谎"的那一半，做不到的那一半登记成 Q91 —— 不许把没做的伪装成做了。逐条依据：
//
//  · **量得到**：`powerMonitor.isOnBatteryPower()` 实测可用（本机回 `false` = 交流电在跑，探针见 run log §四）。
//  · **改不到画面**：真正省电的那一半是"少画一点"（帧率、粒子数、可视化档位），那些全在渲染层里
//    （动效强度三档 + 岛内 tuning）。任务书 2.10 明令**渲染层一个字都不改**，而壳这边没有任何一个
//    运行时开关能改到画面，四条都一手查过：
//      - 每窗口帧率上限：Electron 43 的 `BrowserWindow` / `webContents` **没有这个 API**；
//      - `--force-prefers-reduced-motion`：进程级、只在启动时读 ⇒ 会把普通那一档一起改掉，且运行时不可逆；
//      - `webContents.setBackgroundThrottling(true)`：只管**后台**窗口，壁纸就是前台那块屏 ⇒ 不生效；
//      - 从壳里往页面注入 `.reduce-motion` 那一类样式：① 那是页面自己那份设置的第二个真相
//        （设置面板的勾与画面从此不一致），② 而且它**拦不住 rAF 驱动的 WebGL/pixi** ⇒ 是个假降档。
//  · `powerSaveBlocker` 方向相反（它**阻止**系统省电），而且本就不该由一个播放器去接管用户的电源状态
//    ⇒ **零调用**，由判据 ㉚ 机检钉住（与"不接管系统壁纸"同一族）。
//
// 于是本件真正落的是三格：
//  ① 电池在案时**把话说清**（常驻画面在笔记本上就是耗电大户，要省电请接电源或在页面里开"减少动态效果"）
//     —— 这句话进**确认框**，因为那正是用户做决定的那一刻；
//  ② **不接管系统电源**（`powerSaveBlocker` 与 `powerMonitor.on` 都零调用：既没改电源状态，也没留订阅读者
//     ⇒ "关闭后与进入前一致"这一格不是靠还原保证的，是靠**什么都没动**保证的，判据 ㉚ 钉的就是这个）；
//  ③ **可关**：那句提示可以关掉（`WALLPAPER_BATTERY_NOTICE_ENABLED` 缺省开）。
//     没有 UI 开关 —— 要加就得动"托盘四项"或新增一份持久化，两处都超出本件授权 ⇒ 登记 Q92 等拍板。

/** 提示那一格的缺省（开）。关掉之后确认框就只讲壁纸本身那三段。 */
export const WALLPAPER_BATTERY_NOTICE_ENABLED = true;

/** 档位只有一个出处：读 `powerMonitor.isOnBatteryPower()` 的那一次结果，别处不许再算第二份。 */
export function powerTier({ onBattery }) {
  return onBattery ? 'battery' : 'ac';
}

/**
 * 电池那一格的说辞。`tier==='ac'` 或提示被关掉 ⇒ 返回 `null`（**不许**在交流电时谎称在用电池，
 * 也不许在关掉之后还留着那段话）。
 */
export function batteryNotice({ tier, enabled = WALLPAPER_BATTERY_NOTICE_ENABLED }) {
  if (tier !== 'battery' || !enabled) return null;
  return '这一档是常驻画面：整块屏幕一直在重绘，笔记本上用电池供电会明显缩短续航。'
    + '要省电就接上电源，或先退出壁纸模式、在页面设置里打开「减少动态效果」再进来'
    + '（那一格归画面自己管，壳不代它改，也不接管系统的睡眠与屏幕开关）。';
}

/**
 * 确认框要不要带那一段：由调用方把两样事实喂进来（电池状态 + 提示开不开），
 * 本模块不读 `powerMonitor`、不读窗口 ⇒ 自检能真调用。
 */
export function batteryNoticeFor({ onBattery, enabled = WALLPAPER_BATTERY_NOTICE_ENABLED }) {
  return batteryNotice({ tier: powerTier({ onBattery }), enabled });
}
