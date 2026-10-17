/**
 * Ported from folia-major (https://github.com/chthollyphile/folia-major), AGPL-3.0-only.
 * Upstream file: src/components/visualizer/still/entry.tsx @ 369c34e6f83404c65129479e6bd88d70acb0e43e
 * This project is released under AGPL-3.0. Registered rewrites of this file:
 * see NOTICE.md「移植清单（Folia 视图）」 and memory/folia-port-rewrite-log.md.
 */
import React from 'react';
import { defineVisualizer } from '../definition';

const VisualizerStill = React.lazy(() => import('./VisualizerStill'));

// src/components/visualizer/still/entry.tsx
// Registers the static low-resource visualizer mode.
export default defineVisualizer({
    mode: 'still',
    order: 130,
    labelKey: 'ui.visualizerStill',
    labelFallback: 'Still',
    previewSeed: 'still',
    previewStartOffset: 0,
    tuningKind: 'none',
    render: props => <VisualizerStill {...props} />,
});
