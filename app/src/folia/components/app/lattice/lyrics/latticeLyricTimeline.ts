/**
 * Ported from folia-major (https://github.com/chthollyphile/folia-major), AGPL-3.0-only.
 * Upstream file: src/components/app/lattice/lyrics/latticeLyricTimeline.ts @ 369c34e6f83404c65129479e6bd88d70acb0e43e
 * This project is released under AGPL-3.0. Registered rewrites of this file:
 * see NOTICE.md「移植清单（Folia 视图第一期）」 and memory/folia-port-rewrite-log.md.
 */
import { findLatestActiveLineIndex } from '../../../../utils/appPlaybackHelpers';
import { getLineRenderEndTime } from '../../../../utils/lyrics/renderHints';
import { getRecentCompletedLine, getUpcomingLine } from '../../../visualizer/runtime';
import { buildMonetVisibleLineEntries } from '../../../visualizer/monet/monetLyricsModel';
import type { Line } from '../../../../types';

// src/components/app/lattice/lyrics/latticeLyricTimeline.ts
/** Reuses the playback resolver only at boundaries or seeks, not once per animation frame. */
export function createLatticeTimeline(lines: Line[]) {
    const boundaries = [...new Set(lines.flatMap(line => [line.startTime, line.endTime, getLineRenderEndTime(line)]))].sort((a, b) => a - b);
    let previousStamp = -1;
    let entries: ReturnType<typeof buildMonetVisibleLineEntries> = [];
    return (time: number) => {
        let low = 0, high = boundaries.length;
        while (low < high) {
            const mid = (low + high) >>> 1;
            if (boundaries[mid] <= time) low = mid + 1; else high = mid;
        }
        const stamp = low * 2 + (boundaries[low - 1] === time ? 1 : 0);
        if (stamp !== previousStamp) {
            previousStamp = stamp;
            const currentLineIndex = findLatestActiveLineIndex(lines, time);
            entries = buildMonetVisibleLineEntries({ lines, currentLineIndex, currentTime: time,
                activeLine: lines[currentLineIndex] ?? null,
                recentCompletedLine: getRecentCompletedLine({ lines, currentLineIndex, currentTime: time, getLineEndTime: getLineRenderEndTime }),
                upcomingLine: getUpcomingLine(lines, currentLineIndex, time), before: 1, after: 1 });
        }
        return entries;
    };
}

/** Small fixed substeps keep Monet's spring stable even when a frame arrives late. */
export function stepLatticeSpring(value: number, velocity: number, target: number, delta: number,
    spring: { stiffness: number; damping: number; mass: number }) {
    const steps = Math.max(1, Math.ceil(delta * 120));
    const dt = delta / steps;
    for (let i = 0; i < steps; i++) {
        velocity += ((target - value) * spring.stiffness - velocity * spring.damping) / spring.mass * dt;
        value += velocity * dt;
    }
    const settled = Math.abs(value - target) < 0.01 && Math.abs(velocity) < 0.01;
    return { value: settled ? target : value, velocity: settled ? 0 : velocity, settled };
}
