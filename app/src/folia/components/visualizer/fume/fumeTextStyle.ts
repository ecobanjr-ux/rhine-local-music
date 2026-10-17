/**
 * Ported from folia-major (https://github.com/chthollyphile/folia-major), AGPL-3.0-only.
 * Upstream file: src/components/visualizer/fume/fumeTextStyle.ts @ 369c34e6f83404c65129479e6bd88d70acb0e43e
 * This project is released under AGPL-3.0. Registered rewrites of this file:
 * see NOTICE.md「移植清单（Folia 视图）」 and memory/folia-port-rewrite-log.md.
 */
import { Line, Theme } from '../../../types';
import { getLineRenderEndTime } from '../../../utils/lyrics/renderHints';
import { resolveWordColor } from '../wordColoring';
import { clamp, easeInCubic } from './fumeMath';

// src/components/visualizer/fume/fumeTextStyle.ts
// Text styles that do not depend on the renderer: passed-line styles, their fade, and the active word colour.

let lastFumePassedFadeDurationCache: {
    key: string;
    duration: number;
} | null = null;

export const resolvePassedTextStyle = (
    variant: 'body' | 'hero',
    textHoldStyle: 'standard' | 'dimmed',
) => (
    textHoldStyle === 'dimmed'
        ? {
            opacity: variant === 'hero' ? 0.11 : 0.075,
            glowMultiplier: 0,
            shadowAlphaBase: 0,
            shadowAlphaTrail: 0,
        }
        : {
            opacity: variant === 'hero' ? 0.74 : 0.58,
            glowMultiplier: 1,
            shadowAlphaBase: 0.1,
            shadowAlphaTrail: 0.16,
        }
);

export const resolvePassedDimAmount = (
    currentTimeValue: number,
    passedAt: number,
    fadeDuration: number,
) => {
    if (!Number.isFinite(currentTimeValue) || !Number.isFinite(passedAt) || !Number.isFinite(fadeDuration) || fadeDuration <= 0) {
        return 1;
    }

    const passedAge = Math.max(currentTimeValue - passedAt, 0);
    return easeInCubic(clamp(passedAge / fadeDuration, 0, 1));
};

export const resolveFumePassedFadeDuration = (lines: Line[], textHoldRatio: number) => {
    if (textHoldRatio >= 1) {
        return Number.POSITIVE_INFINITY;
    }

    const timedLines = lines
        .map(line => ({
            startTime: line.startTime,
            endTime: getLineRenderEndTime(line),
        }))
        .filter(line => (
            Number.isFinite(line.startTime)
            && Number.isFinite(line.endTime)
            && line.endTime >= line.startTime
        ))
        .sort((left, right) => left.startTime - right.startTime);
    const cacheKey = timedLines
        .map(line => `${line.startTime.toFixed(3)}:${line.endTime.toFixed(3)}`)
        .join('|') + `:${textHoldRatio.toFixed(3)}`;

    if (lastFumePassedFadeDurationCache?.key === cacheKey) {
        return lastFumePassedFadeDurationCache.duration;
    }

    if (timedLines.length <= 1) {
        const duration = clamp(8 * textHoldRatio, 2.4, 130);
        lastFumePassedFadeDurationCache = { key: cacheKey, duration };
        return duration;
    }

    const first = timedLines[0]!;
    const last = timedLines[timedLines.length - 1]!;
    const totalDuration = Math.max(last.endTime - first.startTime, 0);
    const duration = clamp(totalDuration * textHoldRatio, 2.4, 130);
    lastFumePassedFadeDurationCache = { key: cacheKey, duration };
    return duration;
};

export const getActiveColor = (wordText: string, theme: Theme) => {
    return resolveWordColor(wordText, theme.wordColors, theme.accentColor, {
        cjkMatchMode: 'bidirectional-contains',
    });
};
