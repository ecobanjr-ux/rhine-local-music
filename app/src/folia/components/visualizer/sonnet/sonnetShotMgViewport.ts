/**
 * Ported from folia-major (https://github.com/chthollyphile/folia-major), AGPL-3.0-only.
 * Upstream file: src/components/visualizer/sonnet/sonnetShotMgViewport.ts @ 369c34e6f83404c65129479e6bd88d70acb0e43e
 * This project is released under AGPL-3.0. Registered rewrites of this file:
 * see NOTICE.md「移植清单（Folia 视图）」 and memory/folia-port-rewrite-log.md.
 */
// src/components/visualizer/sonnet/sonnetShotMgViewport.ts
// Resolves overscan extents so open MG paths continue beyond every viewport edge.
export const resolveSonnetShotMgBleed = (width: number, height: number, radius: number) => ({
    x: Math.max(radius * 0.92, width * 0.64),
    y: Math.max(radius * 0.92, height * 0.64),
});
