/**
 * Ported from folia-major (https://github.com/chthollyphile/folia-major), AGPL-3.0-only.
 * Upstream file: src/utils/lyrics/localLyricFormatOrder.ts @ 369c34e6f83404c65129479e6bd88d70acb0e43e
 * This project is released under AGPL-3.0. Registered rewrites of this file:
 * see NOTICE.md「移植清单（Folia 视图第一期）」 and memory/folia-port-rewrite-log.md.
 */
// src/utils/lyrics/localLyricFormatOrder.ts
// User-orderable priority of sidecar lyric file formats. When one track has several sidecar lyric
// files, the import keeps the one whose format ranks first. `.fia` is Folia's own export and always
// ranks above every orderable format.

export const LOCAL_LYRIC_FILE_FORMATS = ['lrc', 'vtt', 'ttml', 'qrc', 'yrc', 'krc'] as const;

export type LocalLyricFileFormat = typeof LOCAL_LYRIC_FILE_FORMATS[number];

export const DEFAULT_LOCAL_LYRIC_FORMAT_ORDER: readonly LocalLyricFileFormat[] = LOCAL_LYRIC_FILE_FORMATS;

const isLocalLyricFileFormat = (value: unknown): value is LocalLyricFileFormat => (
    typeof value === 'string' && (LOCAL_LYRIC_FILE_FORMATS as readonly string[]).includes(value)
);

/** Drops unknown and duplicate entries, then appends any missing format in default order. */
export const normalizeLocalLyricFormatOrder = (value: unknown): LocalLyricFileFormat[] => {
    const order = Array.isArray(value)
        ? value.filter(isLocalLyricFileFormat).filter((format, index, list) => list.indexOf(format) === index)
        : [];
    DEFAULT_LOCAL_LYRIC_FORMAT_ORDER.forEach((format) => {
        if (!order.includes(format)) {
            order.push(format);
        }
    });
    return order;
};

export const isSameLocalLyricFormatOrder = (
    left: readonly LocalLyricFileFormat[],
    right: readonly LocalLyricFileFormat[],
): boolean => left.length === right.length && left.every((format, index) => format === right[index]);

/** Lower wins. `.t.lrc` / `.t.vtt` translations rank with their base format. */
export const getLocalLyricFilePriority = (
    fileName: string,
    order: readonly LocalLyricFileFormat[],
): number => {
    const extension = fileName.toLowerCase().split('.').pop() || '';
    if (extension === 'fia') {
        return -1;
    }
    const index = isLocalLyricFileFormat(extension) ? order.indexOf(extension) : -1;
    return index === -1 ? Number.MAX_SAFE_INTEGER : index;
};
