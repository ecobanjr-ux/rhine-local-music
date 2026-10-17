/**
 * Ported from folia-major (https://github.com/chthollyphile/folia-major), AGPL-3.0-only.
 * Upstream file: src/components/visualizer/sonnet/sonnetStaffNotation.ts @ 369c34e6f83404c65129479e6bd88d70acb0e43e
 * This project is released under AGPL-3.0. Registered rewrites of this file:
 * see NOTICE.md「移植清单（Folia 视图）」 and memory/folia-port-rewrite-log.md.
 */
// src/components/visualizer/sonnet/sonnetStaffNotation.ts

export interface SonnetStaffNote {
    pitch: 'C#5' | 'D5' | 'E5' | 'F5';
    staffStep: number;
    beats: number;
    accidental?: 'sharp';
}

// La Folia's public-domain D-minor theme, transcribed from its 3/4 LilyPond notation.
export const LA_FOLIA_STAFF_NOTES: readonly SonnetStaffNote[] = [
    { pitch: 'D5', staffStep: 6, beats: 1 },
    { pitch: 'D5', staffStep: 6, beats: 1.5 },
    { pitch: 'E5', staffStep: 7, beats: 0.5 },
    { pitch: 'C#5', staffStep: 5, beats: 1, accidental: 'sharp' },
    { pitch: 'C#5', staffStep: 5, beats: 1, accidental: 'sharp' },
    { pitch: 'C#5', staffStep: 5, beats: 1, accidental: 'sharp' },
    { pitch: 'D5', staffStep: 6, beats: 1 },
    { pitch: 'D5', staffStep: 6, beats: 1.5 },
    { pitch: 'D5', staffStep: 6, beats: 0.5 },
    { pitch: 'E5', staffStep: 7, beats: 1 },
    { pitch: 'E5', staffStep: 7, beats: 1 },
    { pitch: 'E5', staffStep: 7, beats: 1 },
    { pitch: 'F5', staffStep: 8, beats: 1 },
    { pitch: 'F5', staffStep: 8, beats: 1.5 },
    { pitch: 'F5', staffStep: 8, beats: 0.5 },
    { pitch: 'E5', staffStep: 7, beats: 1 },
    { pitch: 'E5', staffStep: 7, beats: 1 },
    { pitch: 'E5', staffStep: 7, beats: 1 },
    { pitch: 'D5', staffStep: 6, beats: 1 },
    { pitch: 'D5', staffStep: 6, beats: 1.5 },
    { pitch: 'C#5', staffStep: 5, beats: 0.5, accidental: 'sharp' },
    { pitch: 'D5', staffStep: 6, beats: 3 },
];

export const LA_FOLIA_TOTAL_BEATS = LA_FOLIA_STAFF_NOTES.reduce(
    (total, note) => total + note.beats,
    0,
);

export const LA_FOLIA_CYCLE_SECONDS = 8;
