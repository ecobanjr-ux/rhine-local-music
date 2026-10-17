/**
 * Ported from folia-major (https://github.com/chthollyphile/folia-major), AGPL-3.0-only.
 * Upstream file: src/components/visualizer/pendolo/pendoloTextLayout.ts @ 369c34e6f83404c65129479e6bd88d70acb0e43e
 * This project is released under AGPL-3.0. Registered rewrites of this file:
 * see NOTICE.md「移植清单（Folia 视图）」 and memory/folia-port-rewrite-log.md.
 */
import { layoutWithLines, prepareWithSegments } from '@chenglou/pretext';
import { splitLyricGraphemes } from '../../../utils/lyrics/graphemeTiming';

// src/components/visualizer/pendolo/pendoloTextLayout.ts

export interface PendoloWrappedTextLine {
    text: string;
    width: number;
    graphemeStart: number;
    graphemeEnd: number;
}

export interface PendoloTextLayout {
    lines: PendoloWrappedTextLine[];
    lineHeight: number;
    height: number;
}

/** Builds stable visual lines so timed fills and vertical spacing share one wrap result. */
export const buildPendoloTextLayout = (
    text: string,
    fontSpec: string,
    maxWidth: number,
    lineHeight: number,
): PendoloTextLayout => {
    const prepared = prepareWithSegments(text || ' ', fontSpec, {
        whiteSpace: 'pre-wrap',
    });
    const layout = layoutWithLines(prepared, Math.max(1, maxWidth), lineHeight);
    let graphemeCursor = 0;
    const lines = layout.lines.map(line => {
        const graphemeCount = splitLyricGraphemes(line.text).length;
        const result = {
            text: line.text,
            width: line.width,
            graphemeStart: graphemeCursor,
            graphemeEnd: graphemeCursor + graphemeCount,
        };
        graphemeCursor += graphemeCount;
        return result;
    });

    return {
        lines,
        lineHeight,
        height: Math.max(lines.length, 1) * lineHeight,
    };
};
