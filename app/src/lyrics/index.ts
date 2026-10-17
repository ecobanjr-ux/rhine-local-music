// 本文件为本项目自研封装，非移植代码。
//
// 它把移植自 folia-major 的歌词解析层（./parser-core、./format-detection、
// ./timeline-splitter、./types 等）包成一个统一的入口，并叠加三条本项目自己需要的行为：
//   1) 安全预检（硬性）：命中 <!DOCTYPE / <!ENTITY 之类的实体声明直接拒绝，绝不交给解析器；
//   2) 无歌词归一化：空串 / 仅元信息标签 / 解析后 0 行，一律 empty:true 且 lines 为冻结空数组；
//   3) 给每行补 isInterlude 标记（folia 的间奏合成行 fullText 恰为 6 个英文句点 '......'），
//      方便渲染层过滤。

import type { Line, LyricData } from './types';
import {
    parseLyricsByFormat,
    finalizeParsedLyricLines,
    isInterludeLine,
    INTERLUDE_FULL_TEXT,
    type LyricParseFormat,
} from './parser-core.ts';
import {
    detectTimedLyricFormat,
    resolveExplicitFileTimedLyricFormat,
    type ExplicitFileTimedLyricFormat,
} from './format-detection.ts';

export type { Line, LyricData, Word, LyricSyllable, LyricRuby, LyricAlternateText, LyricBackgroundVocal, LyricAgent, SubtitleContentMode } from './types.ts';
export { splitCombinedTimeline } from './timeline-splitter.ts';
export { detectTimedLyricFormat, resolveExplicitFileTimedLyricFormat } from './format-detection.ts';

/** 每行都带一个 isInterlude 标记的歌词行（渲染层据此过滤间奏合成行）。 */
export interface ParsedLyricLine extends Line {
    isInterlude: boolean;
}

/** parseLyrics 的入参。format 可为格式名（lrc/enhanced-lrc/vtt/ttml）或文件名/扩展名；缺省则嗅探。 */
export interface ParseLyricsInput {
    text: string;
    format?: string;
    translation?: string;
    romanization?: string;
}

export type RejectedLyricReason = 'entity-declaration';

/** parseLyrics 的返回：data 一定存在；empty 表示归一化后无有效歌词行；rejected 表示被安全预检挡下。 */
export interface ParseLyricsResult {
    data: LyricData;
    rejected?: RejectedLyricReason;
    empty: boolean;
    /** 解析器抛错时的原因。仍按"无歌词"降级，但把原因带出去，避免静默失败掩盖真实缺陷。 */
    error?: string;
}

// 去掉 BOM 与前导空白后，命中实体/DOCTYPE 声明即拒绝。正则不锚定，实体声明出现在任意位置都能命中；
// 去除 BOM/前导空白是为了让 “<?xml?>\n<!DOCTYPE …>”“\uFEFF<!DOCTYPE …>”“   <!doctype …>” 等写法
// 不会因为前置字符而漏判。绝不把这类输入下传解析器，也绝不做任何实体展开。
const ENTITY_DECLARATION_REGEX = /<!\s*(DOCTYPE|ENTITY)/i;

const stripBomAndLeadingWhitespace = (input: string): string => input.replace(/^\uFEFF/, '').replace(/^\s+/, '');

// 冻结的空行数组：LyricData.lines 需要 Line[]，Object.freeze 后的字面量按 any 收敛。
const frozenEmptyLines = (): Line[] => Object.freeze([]) as unknown as Line[];

const emptyLyricData = (): LyricData => ({ lines: frozenEmptyLines() });

/**
 * 归一化 format 入参：
 *  - 直接给出受支持格式名（lrc/enhanced-lrc/vtt/ttml）→ 采用；
 *  - 给出文件名/其它扩展名 → 走 resolveExplicitFileTimedLyricFormat，仅 vtt/ttml 可用；
 *    命中 yrc/qrc/krc 这些本项目未移植的平台专有格式，或无法识别 → 返回 undefined，改由内容嗅探。
 */
const resolveFormatHint = (format?: string): LyricParseFormat | undefined => {
    const raw = format?.trim().toLowerCase();
    if (!raw) {
        return undefined;
    }

    if (raw === 'lrc' || raw === 'enhanced-lrc' || raw === 'vtt' || raw === 'ttml' || raw === 'qrc') {
        return raw as LyricParseFormat;
    }

    const fromFile = resolveExplicitFileTimedLyricFormat(raw) as ExplicitFileTimedLyricFormat | undefined;
    return fromFile === 'vtt' || fromFile === 'ttml' ? fromFile : undefined;
};

/** 给每行补 isInterlude 标记（间奏合成行的 fullText 恰为 6 个英文句点）。 */
const markInterludes = (lines: Line[]): ParsedLyricLine[] =>
    lines.map(line => ({ ...line, isInterlude: isInterludeLine(line) }));

/**
 * 统一歌词解析入口（本项目自研封装）。
 * 返回的 data.lines 每行都带 isInterlude；被安全预检拒下或无有效歌词时 lines 为冻结空数组。
 */
export const parseLyrics = async (input: ParseLyricsInput): Promise<ParseLyricsResult> => {
    const text = input.text ?? '';

    // ① 安全预检（硬性）：命中实体/DOCTYPE 声明立即拒绝，绝不下传解析器、绝不展开实体。
    if (ENTITY_DECLARATION_REGEX.test(stripBomAndLeadingWhitespace(text))) {
        return { data: emptyLyricData(), rejected: 'entity-declaration', empty: true };
    }

    // ② 空串直接判空。
    if (text.trim().length === 0) {
        return { data: emptyLyricData(), empty: true };
    }

    const format = resolveFormatHint(input.format) ?? detectTimedLyricFormat(text);

    let parsed: LyricData;
    try {
        parsed = await parseLyricsByFormat(
            format,
            text,
            input.translation ?? '',
            {},
            input.romanization ?? '',
        );
    } catch (error) {
        // 解析器（尤其 TTML 的 XML 解析）抛错时按无歌词处理，不外抛、不部分返回，但把原因带出去。
        return {
            data: emptyLyricData(),
            empty: true,
            error: error instanceof Error ? `${error.name}: ${error.message}` : String(error),
        };
    }

    // ② 无歌词归一化：解析后 0 行 → empty:true，且 lines 为冻结空数组（丢弃仅元信息等其它字段）。
    if (!parsed.lines || parsed.lines.length === 0) {
        return { data: emptyLyricData(), empty: true };
    }

    // ③ 补 isInterlude 标记；沿用移植层已注入的间奏合成行，不再重复注入。
    const lines = markInterludes(parsed.lines);
    return {
        data: {
            ...parsed,
            lines,
        },
        empty: false,
    };
};

// 一并转出解析层常用能力，方便上层只需从 './lyrics' 取用；finalizeParsedLyricLines 供渲染层
// 需要重算 renderHints / 注入间奏时复用（本项目内部解析已调用，未在此封装路径重复）。
export { finalizeParsedLyricLines, isInterludeLine, INTERLUDE_FULL_TEXT };
export type { LyricParseFormat };
