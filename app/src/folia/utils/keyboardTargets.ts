/**
 * Ported from folia-major (https://github.com/chthollyphile/folia-major), AGPL-3.0-only.
 * Upstream file: src/utils/keyboardTargets.ts @ 369c34e6f83404c65129479e6bd88d70acb0e43e
 * This project is released under AGPL-3.0. Registered rewrites of this file:
 * see NOTICE.md「移植清单（Folia 视图）」 and memory/folia-port-rewrite-log.md.
 */
// src/utils/keyboardTargets.ts
// 全局快捷键的两个通用守卫：正在打字吗、有没有窗口接管了键盘。
//
// 两者此前各有三份副本（usePlaybackInteractionBridge 内联一份 + 局部闭包一份、
// usePlayerPanelTabShortcut 一份、useCommandPalette 导出一份），彼此还不完全一致 ——
// bridge 那份内联判断漏了 <select>。集中到 utils 还有一个层次上的理由：
// isTextEntryTarget 原先导出自 useCommandPalette，而那个模块会拉进整个 commandRegistry，
// hooks 层去 import 它等于反向依赖组件层。

/**
 * 事件目标是不是正在接收文本输入。是的话，所有裸字母快捷键都必须让路。
 */
export const isTextEntryTarget = (target: EventTarget | null) => {
    if (!(target instanceof HTMLElement)) {
        return false;
    }

    const tagName = target.tagName.toLowerCase();
    return tagName === 'input'
        || tagName === 'textarea'
        || tagName === 'select'
        || target.isContentEditable;
};

/**
 * 当前有没有模态窗口声明自己接管了键盘。
 *
 * 用 DOM 属性而不是共享 state，是这个仓库既有的约定：每个模态自己挂
 * data-folia-keyboard-window="true"，全局热键查一次属性即可让路，不需要谁去订阅谁。
 */
export const hasBlockingWindow = () => Boolean(
    document.querySelector('[data-folia-keyboard-window="true"]')
);
