/**
 * Ported from folia-major (https://github.com/chthollyphile/folia-major), AGPL-3.0-only.
 * Upstream file: src/components/visualizer/sonnet/sonnetSemantic.ts @ 369c34e6f83404c65129479e6bd88d70acb0e43e
 * This project is released under AGPL-3.0. Registered rewrites of this file:
 * see NOTICE.md「移植清单（Folia 视图）」 and memory/folia-port-rewrite-log.md.
 */
import type { Line } from '../../../types';
import { buildLineGraphemeTimeline, splitLyricGraphemes } from '../../../utils/lyrics/graphemeTiming';
import { segmentLyricWords } from '../../../utils/lyrics/wordSegmentation';
import type { SonnetSemanticSegment } from './types';

// src/components/visualizer/sonnet/sonnetSemantic.ts
// Produces lossless semantic segments while mapping display offsets to parser-derived grapheme timing.
// Word splitting itself lives in utils/lyrics/wordSegmentation, which also applies the user's saved
// segmentation for this line when there is one.

const getGraphemeRanges = (text: string) => {
    let cursor = 0;
    return splitLyricGraphemes(text).map(grapheme => {
        const range = { start: cursor, end: cursor + grapheme.length };
        cursor = range.end;
        return range;
    });
};

const timingForRange = (
    line: Line,
    startOffset: number,
    endOffset: number,
    timeline: ReturnType<typeof buildLineGraphemeTimeline>,
    ranges: ReturnType<typeof getGraphemeRanges>,
) => {
    const indices = ranges.flatMap((range, index) => (
        range.end > startOffset && range.start < endOffset ? [index] : []
    ));
    const graphemes = indices.map(index => timeline[index]).filter(Boolean);
    const wordIndices = [...new Set(graphemes.flatMap(item => (
        typeof item.wordIndex === 'number' ? [item.wordIndex] : []
    )))];

    return {
        graphemes,
        wordIndices,
        startTime: graphemes[0]?.startTime ?? line.startTime,
        endTime: graphemes[graphemes.length - 1]?.endTime ?? line.endTime,
    };
};

export const buildSonnetSemanticSegments = (line: Line): SonnetSemanticSegment[] => {
    if (!line.fullText) return [];
    const timeline = buildLineGraphemeTimeline(line);
    const ranges = getGraphemeRanges(line.fullText);
    const parts = segmentLyricWords(line);
    const segments = parts.map((part, index) => {
        const startOffset = part.index;
        const endOffset = parts[index + 1]?.index ?? line.fullText.length;
        return {
            text: line.fullText.slice(startOffset, endOffset),
            startOffset,
            endOffset,
            ...timingForRange(line, startOffset, endOffset, timeline, ranges),
            isWordLike: part.isWordLike,
        };
    });

    const sticky: SonnetSemanticSegment[] = [];
    for (const segment of segments) {
        const previous = sticky[sticky.length - 1];
        if (previous && !segment.isWordLike && !/^\s+$/u.test(segment.text)) {
            previous.text += segment.text;
            previous.endOffset = segment.endOffset;
            previous.endTime = Math.max(previous.endTime, segment.endTime);
            previous.graphemes.push(...segment.graphemes);
            previous.wordIndices = [...new Set([...previous.wordIndices, ...segment.wordIndices])];
        } else {
            sticky.push({ ...segment, graphemes: [...segment.graphemes], wordIndices: [...segment.wordIndices] });
        }
    }
    return sticky;
};
