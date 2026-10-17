/**
 * Ported from folia-major (https://github.com/chthollyphile/folia-major), AGPL-3.0-only.
 * Upstream file: src/components/app/lattice/lyrics/prewarmLatticeLyrics.ts @ 369c34e6f83404c65129479e6bd88d70acb0e43e
 * This project is released under AGPL-3.0. Registered rewrites of this file:
 * see NOTICE.md「移植清单（Folia 视图第一期）」 and memory/folia-port-rewrite-log.md.
 */
import { loadPixi } from '../../../visualizer/loadPixi';

// src/components/app/lattice/lyrics/prewarmLatticeLyrics.ts
let started = false;

/**
 * Pulls the lyric chunk and Pixi in before the card is opened. Both imports are module-cached, so
 * the click path is left with neither a chunk fetch nor the first shader compile.
 */
export const prewarmLatticeLyrics = () => {
    if (started) return;
    started = true;
    void Promise.all([import('./LatticeLyrics'), loadPixi()]).catch(() => { started = false; });
};
