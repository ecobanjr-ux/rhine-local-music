/**
 * Ported from folia-major (https://github.com/chthollyphile/folia-major), AGPL-3.0-only.
 * Upstream file: src/components/visualizer/sonnet/sonnetCameraTracking.ts @ 369c34e6f83404c65129479e6bd88d70acb0e43e
 * This project is released under AGPL-3.0. Registered rewrites of this file:
 * see NOTICE.md「移植清单（Folia 视图）」 and memory/folia-port-rewrite-log.md.
 */
// src/components/visualizer/sonnet/sonnetCameraTracking.ts
// Selects render glyphs that may drive the camera and resolves their absolute-time focus.

export interface SonnetCameraTrackingGlyph {
    baseX: number;
    baseY: number;
    startTime: number;
    isBackgroundShape?: boolean;
}

export const resolveSonnetCameraTrackingGlyphs = <T extends SonnetCameraTrackingGlyph>(
    glyphs: readonly T[],
) => glyphs.filter(glyph => glyph.isBackgroundShape !== true);

// Interpolates only semantic camera glyphs; decorative render nodes must be filtered first.
export const resolveSonnetSegmentCameraFocus = (
    glyphs: readonly SonnetCameraTrackingGlyph[],
    time: number,
    trackingFactor = 0.5,
) => {
    if (glyphs.length === 0) return { x: 0, y: 0 };
    const first = glyphs[0];
    const last = glyphs[glyphs.length - 1];
    const segCenterX = (first.baseX + last.baseX) / 2;
    const segCenterY = (first.baseY + last.baseY) / 2;
    const applyFactor = (exactX: number, exactY: number) => ({
        x: segCenterX + (exactX - segCenterX) * trackingFactor,
        y: segCenterY + (exactY - segCenterY) * trackingFactor,
    });

    if (time <= first.startTime) return applyFactor(first.baseX, first.baseY);
    if (time >= last.startTime) return applyFactor(last.baseX, last.baseY);

    for (let index = 0; index < glyphs.length - 1; index += 1) {
        const current = glyphs[index];
        const next = glyphs[index + 1];
        if (time < current.startTime || time > next.startTime) continue;
        const progress = (time - current.startTime) / Math.max(0.001, next.startTime - current.startTime);
        return applyFactor(
            current.baseX + (next.baseX - current.baseX) * progress,
            current.baseY + (next.baseY - current.baseY) * progress,
        );
    }
    return applyFactor(first.baseX, first.baseY);
};
