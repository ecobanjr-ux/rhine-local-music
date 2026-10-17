/**
 * Ported from folia-major (https://github.com/chthollyphile/folia-major), AGPL-3.0-only.
 * Upstream file: src/components/app/lattice/lyrics/types.ts @ 369c34e6f83404c65129479e6bd88d70acb0e43e
 * This project is released under AGPL-3.0. Registered rewrites of this file:
 * see NOTICE.md「移植清单（Folia 视图第一期）」 and memory/folia-port-rewrite-log.md.
 */
import type { VisualizerSharedProps } from '../../../visualizer/definition';

// src/components/app/lattice/lyrics/types.ts
export type LatticeLyricSource = Pick<VisualizerSharedProps,
    'currentTime' | 'currentLineIndex' | 'lines' | 'theme' | 'subtitleTheme' |
    'showSubtitleTranslation' | 'hideTranslationSubtitle' | 'subtitleContentMode' |
    'paused' | 'staticMode'>;

export type LatticeLyricInput = LatticeLyricSource & {
    songKey: string;
    keywordColoringEnabled: boolean;
    reducedMotion: boolean;
    fontsEpoch: number;
};

export interface LatticeLyricRuntime {
    attach(host: HTMLElement): void;
    setErrorHandler(handler: (error: unknown) => void): void;
    update(input: LatticeLyricInput): void;
    /** CSS-pixel box of the host and the screen density it is shown at; a change of either rebuilds the scene. */
    resize(width: number, height: number, devicePixelRatio: number): void;
    setVisible(visible: boolean): void;
    destroy(): void;
}
