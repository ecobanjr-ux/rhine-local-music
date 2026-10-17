/**
 * Ported from folia-major (https://github.com/chthollyphile/folia-major), AGPL-3.0-only.
 * Upstream file: src/components/visualizer/monet/entry.tsx @ 369c34e6f83404c65129479e6bd88d70acb0e43e
 * This project is released under AGPL-3.0. Registered rewrites of this file:
 * see NOTICE.md「移植清单（Folia 视图）」 and memory/folia-port-rewrite-log.md.
 */
import React from 'react';
import { DEFAULT_MONET_TUNING } from '../../../types';
import { defineVisualizer } from '../definition';
import { MonetSettingsPanel } from './MonetSettingsPanel';

const VisualizerMonet = React.lazy(() => import('./VisualizerMonet'));

// src/components/visualizer/monet/entry.tsx
// Registers the Monet poster visualizer and its mode-owned settings panel.
export default defineVisualizer({
    mode: 'monet',
    order: 90,
    labelKey: 'ui.visualizerMonet',
    labelFallback: 'Monet',
    previewSeed: 'monet',
    previewStartOffset: 0,
    tuningKind: 'monet',
    render: props => {
        const monetTuning = props.monetTuning ?? DEFAULT_MONET_TUNING;
        const lyricsFontScale = props.lyricsFontScale ?? 1;
        return (
            <VisualizerMonet
                {...props}
                monetTuning={{
                    ...monetTuning,
                    fontScale: monetTuning.fontScale * lyricsFontScale,
                }}
            />
        );
    },
    renderSettingsPanel: props => <MonetSettingsPanel {...props} />,
    resetSettings: ({ resetMonetTuning }) => {
        resetMonetTuning?.();
    },
});
