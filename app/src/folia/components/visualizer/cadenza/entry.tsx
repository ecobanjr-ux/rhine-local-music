/**
 * Ported from folia-major (https://github.com/chthollyphile/folia-major), AGPL-3.0-only.
 * Upstream file: src/components/visualizer/cadenza/entry.tsx @ 369c34e6f83404c65129479e6bd88d70acb0e43e
 * This project is released under AGPL-3.0. Registered rewrites of this file:
 * see NOTICE.md「移植清单（Folia 视图）」 and memory/folia-port-rewrite-log.md.
 */
import React from 'react';
import { DEFAULT_CADENZA_TUNING } from '../../../types';
import { defineVisualizer, type VisualizerSharedProps } from '../definition';

const VisualizerCadenza = React.lazy(() => import('./VisualizerCadenza'));

// src/components/visualizer/cadenza/entry.tsx
// Registers Cadenza and keeps its font-scale adaptation local to the mode.
const renderCadenza = ({
    cadenzaTuning = DEFAULT_CADENZA_TUNING,
    lyricsFontScale = 1,
    ...props
}: VisualizerSharedProps) => (
    <VisualizerCadenza
        {...props}
        lyricsFontScale={lyricsFontScale}
        cadenzaTuning={{
            ...cadenzaTuning,
            fontScale: cadenzaTuning.fontScale * lyricsFontScale,
        }}
    />
);

export default defineVisualizer({
    mode: 'cadenza',
    order: 40,
    labelKey: 'ui.visualizerCadenze',
    labelFallback: 'Mindscape',
    previewSeed: 'cadenza',
    previewStartOffset: 0,
    tuningKind: 'cadenza',
    render: renderCadenza,
});
