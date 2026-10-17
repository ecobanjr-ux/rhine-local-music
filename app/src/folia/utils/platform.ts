/**
 * Ported from folia-major (https://github.com/chthollyphile/folia-major), AGPL-3.0-only.
 * Upstream file: src/utils/platform.ts @ 369c34e6f83404c65129479e6bd88d70acb0e43e
 * This project is released under AGPL-3.0. Registered rewrites of this file:
 * see NOTICE.md「移植清单（Folia 视图第一期）」 and memory/folia-port-rewrite-log.md.
 */
// src/utils/platform.ts
// One place to answer "is this a Mac", so keyboard handling and the shortcut hints the user reads
// can never disagree about it. Detection is by user agent because the renderer runs both in a
// browser and in Electron, and `window.electron?.platform` only exists in the latter.

export const isMacPlatform = typeof navigator !== 'undefined'
    && navigator.userAgent.toLowerCase().includes('mac');

/**
 * The modifier a shortcut declared as `ctrl` actually uses here: Cmd on macOS, Ctrl elsewhere.
 * Shortcuts are declared once with `ctrl` and translated at the point of use, rather than each
 * declaration carrying a per-platform variant.
 */
export const isPrimaryModifierPressed = (event: KeyboardEvent): boolean => (
    isMacPlatform ? event.metaKey : event.ctrlKey
);

/** The modifier that must stay *up* for a primary-modifier shortcut to be unambiguous. */
export const isSecondaryModifierPressed = (event: KeyboardEvent): boolean => (
    isMacPlatform ? event.ctrlKey : event.metaKey
);

/** Label for the primary modifier, for shortcut hints shown in the UI. */
export const PRIMARY_MODIFIER_LABEL = isMacPlatform ? 'Cmd' : 'Ctrl';
