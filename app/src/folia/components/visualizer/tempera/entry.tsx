/**
 * Ported from folia-major (https://github.com/chthollyphile/folia-major), AGPL-3.0-only.
 * Upstream file: src/components/visualizer/tempera/entry.tsx @ 369c34e6f83404c65129479e6bd88d70acb0e43e
 * This project is released under AGPL-3.0. Registered rewrites of this file:
 * see NOTICE.md「移植清单（Folia 视图）」 and memory/folia-port-rewrite-log.md.
 */
import React from 'react';
import { DEFAULT_TEMPERA_TUNING } from '../../../types';
import { defineVisualizer } from '../definition';
import TemperaSettingsPanel from './TemperaSettingsPanel';

const VisualizerTempera = React.lazy(() => import('./VisualizerTempera'));

// src/components/visualizer/tempera/entry.tsx
// Registers 凝彩, the deterministic block-composition lyric-PV director.
export default defineVisualizer({
    mode: 'tempera',
    order: 20,
    labelKey: 'ui.visualizerTempera',
    labelFallback: 'Tempera',
    previewSeed: 'tempera',
    previewStartOffset: 0,
    tuningKind: 'tempera',
    usesWordSegmentation: true,
    // Deliberately unkeyed on the seed: the runtime hands a track change over in place
    // (see songHandover.ts / pixiRuntimeHost.ts). Remounting here would throw the WebGL
    // context away mid-transition and leave the frame empty for the whole rebuild.
    render: props => <VisualizerTempera {...props} />,
    renderSettingsPanel: props => <TemperaSettingsPanel {...props} />,
    resetSettings: ({ resetTemperaTuning, setDraftTemperaTuning }) => {
        setDraftTemperaTuning?.(DEFAULT_TEMPERA_TUNING);
        resetTemperaTuning?.();
    },
});
