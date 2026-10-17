/**
 * Ported from folia-major (https://github.com/chthollyphile/folia-major), AGPL-3.0-only.
 * Upstream file: src/components/visualizer/pendolo/pendoloTimeline.ts @ 369c34e6f83404c65129479e6bd88d70acb0e43e
 * This project is released under AGPL-3.0. Registered rewrites of this file:
 * see NOTICE.md「移植清单（Folia 视图）」 and memory/folia-port-rewrite-log.md.
 */
import type { Line } from '../../../types';

// src/components/visualizer/pendolo/pendoloTimeline.ts

/** Resolves the wheel anchor when playback is outside an actively timed lyric line. */
export const resolvePendoloFallbackAnchorIndex = (
    lines: Line[],
    currentLineIndex: number,
    lastValidLineIndex: number,
    hasObservedLine: boolean,
    currentTime: number,
) => {
    if (currentLineIndex >= 0 && currentLineIndex < lines.length) {
        return currentLineIndex;
    }

    if (!hasObservedLine) {
        return -1;
    }

    const finalLine = lines.at(-1);
    const finalRenderEndTime = finalLine?.renderHints?.renderEndTime ?? finalLine?.endTime;
    if (finalRenderEndTime !== undefined && currentTime > finalRenderEndTime) {
        return lines.length;
    }

    return lastValidLineIndex + 0.5;
};

const PENDOLO_VISIBLE_ARC_DEG = 110;
const PENDOLO_EDGE_FADE_DEG = 28;

/** Fades a lyric in only when its unwrapped wheel angle reaches the visible right-hand arc. */
export const resolvePendoloRotatingLineOpacity = (
    baseAngleDeg: number,
    wheelRotationDeg: number,
    baseOpacity: number,
) => {
    const visibleAngleDeg = Math.abs(baseAngleDeg + wheelRotationDeg);
    if (visibleAngleDeg >= PENDOLO_VISIBLE_ARC_DEG) return 0;
    const edgeProgress = Math.min(1, (PENDOLO_VISIBLE_ARC_DEG - visibleAngleDeg) / PENDOLO_EDGE_FADE_DEG);
    return baseOpacity * edgeProgress;
};
