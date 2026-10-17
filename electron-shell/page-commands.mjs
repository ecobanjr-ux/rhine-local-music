// R204（Electron 壳最小件）· 壳的动作 = 转发页面里已有的那颗按钮。
//
// 为什么走这条路（而不是在壳里再实现一遍播放控制）：
//   · 渲染层一个字都不许改（任务书 2.10）⇒ 不能给它加"给壳用的接口"；
//   · 壳也不该有第二份播放真相（R131 那条"命令只转发既有动作"的同一族规矩）；
//   · 顶栏那三颗按钮本来就是宿主命令表的入口，点它们 = 走页面自己的处理器，
//     禁用态、状态回写、歌词面同步全都由页面负责，壳一行都不碰。
// 顺带一条：`disabled` 必须回话。R109 那格教训 —— 绕过 disabled 的合成点击会替缺陷圆场。

/** 壳能转发的动作 → 页面里那颗既有按钮。加一条之前先确认页面上真有这颗按钮（判据 ⑯ 正面钉）。 */
export const SHELL_COMMAND_SELECTORS = {
  'play-pause': '[data-action="play-pause"]',
  'track-next': '[data-action="track-next"]',
  'track-prev': '[data-action="track-prev"]',
};

/** 在页面里执行的那一段：只查、只点，不读状态、不算状态。 */
export function commandClickScript(id) {
  const selector = SHELL_COMMAND_SELECTORS[id];
  if (!selector) throw new Error(`未知命令（${String(id)}）：壳只转发页面已有的那几颗按钮`);
  const quoted = JSON.stringify(selector);
  return `(() => {
    const button = document.querySelector(${quoted});
    if (!button) return 'missing';
    if (button.disabled) return 'unavailable';
    button.click();
    return 'clicked';
  })()`;
}
