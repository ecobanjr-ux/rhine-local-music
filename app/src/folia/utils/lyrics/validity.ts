/**
 * Ported from folia-major (https://github.com/chthollyphile/folia-major), AGPL-3.0-only.
 * Upstream file: src/utils/lyrics/validity.ts @ 369c34e6f83404c65129479e6bd88d70acb0e43e
 * This project is released under AGPL-3.0. Registered rewrites of this file:
 * see NOTICE.md「移植清单（Folia 视图第一期）」 and memory/folia-port-rewrite-log.md.
 */
import type { LyricData } from '../../types';

// Shared content-level validation for parsed lyrics returned by every source.
export const hasRenderableLyrics = (lyricData: LyricData | null | undefined): lyricData is LyricData => {
    if (!lyricData?.lines?.length) {
        return false;
    }

    return lyricData.lines.some(line =>
        line.fullText.trim().length > 0 || (line.translation?.trim().length ?? 0) > 0
    );
};
