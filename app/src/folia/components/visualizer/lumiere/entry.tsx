/**
 * Ported from folia-major (https://github.com/chthollyphile/folia-major), AGPL-3.0-only.
 * Upstream file: src/components/visualizer/lumiere/entry.tsx @ 369c34e6f83404c65129479e6bd88d70acb0e43e
 * This project is released under AGPL-3.0. Registered rewrites of this file:
 * see NOTICE.md「移植清单（Folia 视图）」 and memory/folia-port-rewrite-log.md.
 */
// Copyright (c) 2026 chthollyphile
import React from 'react';
import { DEFAULT_LUMIERE_TUNING } from '../../../types';
import { defineVisualizer } from '../definition';
import LumiereSettingsPanel from './LumiereSettingsPanel';

const VisualizerLumiere = React.lazy(() => import('./VisualizerLumiere'));

// src/components/visualizer/lumiere/entry.tsx
// Registers 绘光, the stage-lighting lyric director: volumetric light, fog, line art and lyrics lit by the beams.
export default defineVisualizer({
    mode: 'lumiere',
    order: 25,
    labelKey: 'ui.visualizerLumiere',
    labelFallback: '绘光',
    previewSeed: 'lumiere',
    previewStartOffset: 0,
    tuningKind: 'lumiere',
    usesWordSegmentation: true,
    // Deliberately unkeyed on the seed, like tempera: the runtime hands a track change over in
    // place (songHandover.ts / pixiRuntimeHost.ts) instead of throwing the WebGL context away.
    render: props => <VisualizerLumiere {...props} />,
    renderSettingsPanel: props => <LumiereSettingsPanel {...props} />,
    resetSettings: ({ resetLumiereTuning, setDraftLumiereTuning }) => {
        setDraftLumiereTuning?.(DEFAULT_LUMIERE_TUNING);
        resetLumiereTuning?.();
    },
});
