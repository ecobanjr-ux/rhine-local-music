// R206 ①（P0 · 出得去 + 说得清）· 屏幕上那两条"怎么出去"的提示。
//
// 验收侧实测的三条事实（不必重新归因）：`Ctrl+Alt+W`、托盘、`Esc` 三路都真能退出；但用户一旦点了桌面，
// 焦点跑掉、`Esc` 从此永久失效；而屏幕上**没有任何一处**写着"怎么退出"。本模块只管后两条里的那一条：
// 把退出方式写在画面上，说几秒就自己消失，不长期挡画。
//
// 为什么走 `executeJavaScript`（薄适配层，台账登记理由）：壳与页面之间**没有 preload**（R204 的形状决定：
// 不留没有读者的口子），三件套 `contextIsolation / nodeIntegration:false / sandbox` 一条都不许松，
// 所以壳要给画面上加一句话，只有主进程那条脚本通道 —— 与 `page-commands.mjs` 的 `commandClickScript`
// 同族先例。差别在本模块**不碰播放状态、不点按钮**，只在 `document.body` 上加/摘一个纯文本层：
// 文本一律走 `textContent`（不是 `innerHTML`）⇒ 没有把字符串当标记解析的那一格。
//
// 三条形状各钉一条判据（check-music-shell.mjs ㉛㉜㉝）：
//  · 时长常量只有这一处定义（`HINT_AUTO_DISMISS_MS`），main.mjs 与注入脚本都不写数字；
//  · "会出现"与"会自己消失"是两格，各自要在记账里看得见；
//  · 热点那条只在光标进/出的那一趟出现，常态不常驻（不挡画）。

/** 进入提示自己消失的时长（唯一出处）。 */
export const HINT_AUTO_DISMISS_MS = 6000;

/** 注入元素用的固定 id：摘的时候按它找，不另留第二份引用。 */
export const HINT_ELEMENT_ID = 'shell-screen-hint';

/**
 * 进入壁纸态那一条。三件事都是**壳这一层真做得到**的（全局键 / 托盘项 / 热点），
 * 每一条都按真机读数改到"说得到做得到"：
 *  · 光标进到右上角只是**把鼠标还给窗口**，键盘不在这一步回来 —— Windows 的前台锁规定只有
 *    收到过最后一次点击的进程才能把自己带到前台（实测：`document.hasFocus()` 已经 true，
 *    而 `GetForegroundWindow` 还是别人的 ⇒ Esc 进不到本窗口）。所以那句写的是"先点一下画面，Esc 才管用"。
 *  · 离开热点后交互再多保持一小会儿（`HOTSPOT_UNLOCK_LINGER_MS`），否则从右上角移到右下角那一路上
 *    穿透就收回去了，"点那颗退出按钮"物理上点不到（实测命中测试落到底下的窗口）。
 * 不许出现 Markdown 星号、内部编号、反引号（判据沿 R205 ⑲/㉚ 那两条：用户可见文案只说人话）。
 */
export const HINT_ENTER_TEXT =
  '退出壁纸：按 Ctrl+Alt+W · 或在托盘里再点一次「壁纸模式」 · 或把光标移到屏幕右上角，那里会重新接住鼠标。\n'
  + '到右上角后，点右下角那颗退出按钮就能退出；先点一下画面，键盘也就回到这个窗口，这时按 Esc 同样能退。这条提示几秒后自己消失。';

/**
 * 光标进到解锁热点那一条（短；离开就摘，不常驻）。
 * 这里**不重提**画面右下角那颗按钮的名字：那个名字的唯一出处是 `wallpaper-switch.mjs`
 * 的确认文案（判据 ⑳），提示里再写一遍就是第二个作者，而且它已经写在画面上那颗按钮上了。
 */
export const HINT_HOTSPOT_TEXT = '这个窗口重新接住鼠标了：点右下角那颗退出按钮，或先点一下画面再按 Esc';

/** 两种提示的几何：进入那条挂顶部正中（不压热点、不压底部控制条），热点那条挂右上角。 */
const HINT_PLACEMENT = {
  enter: { top: '24px', bottom: 'auto', left: '50%', right: 'auto', transform: 'translateX(-50%)', maxWidth: 'min(760px, 80vw)' },
  hotspot: { top: '12px', bottom: 'auto', left: 'auto', right: '16px', transform: 'none', maxWidth: 'min(420px, 45vw)' },
};

/** 这一档有没有 kind —— 未知的一律拒（不许把外部字符串当文案注入画面）。 */
export function hintTextFor(kind) {
  if (kind === 'enter') return HINT_ENTER_TEXT;
  if (kind === 'hotspot') return HINT_HOTSPOT_TEXT;
  throw new Error(`未知提示种类（${String(kind)}）：只许 enter 与 hotspot`);
}

/**
 * 在页面里执行的那一段：只加一个纯文本层。
 * `pointer-events:none` 是硬要求 —— 穿透态下它本来就不吃鼠标，而**解锁之后**它也不许挡住
 * 右下角那颗退出按钮或底部控制条（挡了就是"提示"变成"新障碍"）。
 */
export function hintShowScript(kind) {
  const text = hintTextFor(kind);
  const place = HINT_PLACEMENT[kind];
  const id = JSON.stringify(HINT_ELEMENT_ID);
  return `(() => {
    document.getElementById(${id})?.remove();
    const box = document.createElement('div');
    box.id = ${id};
    box.setAttribute('role', 'status');
    box.textContent = ${JSON.stringify(text)};
    Object.assign(box.style, {
      position: 'fixed',
      zIndex: '2147483647',
      pointerEvents: 'none',
      top: ${JSON.stringify(place.top)},
      bottom: ${JSON.stringify(place.bottom)},
      left: ${JSON.stringify(place.left)},
      right: ${JSON.stringify(place.right)},
      transform: ${JSON.stringify(place.transform)},
      maxWidth: ${JSON.stringify(place.maxWidth)},
      padding: '8px 14px',
      borderRadius: '10px',
      background: 'rgba(12, 12, 14, 0.62)',
      color: '#f2f2f4',
      font: '12px/1.55 system-ui, -apple-system, "Segoe UI", sans-serif',
      letterSpacing: '0.02em',
      whiteSpace: 'pre-line',
      textAlign: 'left',
      boxShadow: '0 2px 14px rgba(0, 0, 0, 0.28)',
    });
    document.body.appendChild(box);
    return 'shown';
  })()`;
}

/** 摘掉那一个层（两种提示共用同一个 id ⇒ 一次只可能有一条在屏幕上）。 */
export function hintRemoveScript() {
  return `(() => {
    document.getElementById(${JSON.stringify(HINT_ELEMENT_ID)})?.remove();
    return 'removed';
  })()`;
}

/**
 * 提示层：把"加一条 / 摘一条 / 几秒后自己摘"记在同一处，main.mjs 只调这三个动作。
 * `runInPage` / `schedule` / `cancel` 都可注入 ⇒ 自检拿记账的假函数就能真跑这两格（不必真开窗口）。
 */
export function createHintLayer({
  runInPage = () => {},
  schedule = (fn, ms) => setTimeout(fn, ms),
  cancel = (id) => clearTimeout(id),
  dismissMs = HINT_AUTO_DISMISS_MS,
} = {}) {
  const onScreen = new Set();
  let dismissTimer = null;

  const show = (kind) => {
    runInPage(hintShowScript(kind));
    onScreen.add(kind);
    return true;
  };
  const hide = (kind) => {
    if (!onScreen.has(kind)) return false;
    onScreen.delete(kind);
    runInPage(hintRemoveScript());
    return true;
  };

  return {
    /** 进入壁纸态：出现 + 排定自己消失（两格都要看得见，判据 ㉜）。 */
    showEnter() {
      if (dismissTimer !== null) { cancel(dismissTimer); dismissTimer = null; }
      const shown = show('enter');
      dismissTimer = schedule(() => { dismissTimer = null; hide('enter'); }, dismissMs);
      return shown;
    },
    /** 光标进/出解锁热点：只在进去那一趟出现，离开就摘（判据 ㉝：不常驻挡画）。 */
    showHotspot() { return show('hotspot'); },
    hideHotspot() { return hide('hotspot'); },
    /** 退出壁纸态：计时器与画面上的东西一起清掉，不许留一条挂在普通窗口上。 */
    clear() {
      if (dismissTimer !== null) { cancel(dismissTimer); dismissTimer = null; }
      const was = [...onScreen];
      onScreen.clear();
      if (was.length > 0) runInPage(hintRemoveScript());
      return was;
    },
    state() { return { enter: onScreen.has('enter'), hotspot: onScreen.has('hotspot'), dismissMs }; },
  };
}
