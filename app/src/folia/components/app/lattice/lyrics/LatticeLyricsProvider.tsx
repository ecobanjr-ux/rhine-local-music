/**
 * Ported from folia-major (https://github.com/chthollyphile/folia-major), AGPL-3.0-only.
 * Upstream file: src/components/app/lattice/lyrics/LatticeLyricsProvider.tsx @ 369c34e6f83404c65129479e6bd88d70acb0e43e
 * This project is released under AGPL-3.0. Registered rewrites of this file:
 * see NOTICE.md「移植清单（Folia 视图第一期）」 and memory/folia-port-rewrite-log.md.
 */
import { createContext, useContext, useMemo, type ReactNode } from 'react';
import type { LatticeLyricSource } from './types';

// src/components/app/lattice/lyrics/LatticeLyricsProvider.tsx
export type LatticeLyricContext = LatticeLyricSource & { songKey: string; keywordColoringEnabled: boolean };
const Context = createContext<LatticeLyricContext | null>(null);
export const useLatticeLyrics = () => useContext(Context);

export default function LatticeLyricsProvider({ source, songKey, keywordColoringEnabled, children }: {
    source: LatticeLyricSource; songKey: string; keywordColoringEnabled: boolean; children: ReactNode;
}) {
    // Select explicitly: the source may structurally contain global font scales and player-only showText.
    const { currentTime, currentLineIndex, lines, theme, subtitleTheme, showSubtitleTranslation,
        hideTranslationSubtitle, subtitleContentMode, paused, staticMode } = source;
    const value = useMemo(() => ({ currentTime, currentLineIndex, lines, theme, subtitleTheme,
        showSubtitleTranslation, hideTranslationSubtitle, subtitleContentMode, paused, staticMode, songKey, keywordColoringEnabled }),
    [currentTime, currentLineIndex, lines, theme, subtitleTheme, showSubtitleTranslation,
        hideTranslationSubtitle, subtitleContentMode, paused, staticMode, songKey, keywordColoringEnabled]);
    return <Context.Provider value={value}>{children}</Context.Provider>;
}
