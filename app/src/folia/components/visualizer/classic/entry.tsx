/**
 * Ported from folia-major (https://github.com/chthollyphile/folia-major), AGPL-3.0-only.
 * Upstream file: src/components/visualizer/classic/entry.tsx @ 369c34e6f83404c65129479e6bd88d70acb0e43e
 * This project is released under AGPL-3.0. Registered rewrites of this file:
 * see NOTICE.md「移植清单（Folia 视图第一期）」 and memory/folia-port-rewrite-log.md.
 */
import React from 'react';
import { defineVisualizer } from '../definition';

const Visualizer = React.lazy(() => import('./Visualizer'));

// src/components/visualizer/classic/entry.tsx
// Registers the classic visualizer mode.
export default defineVisualizer({
    mode: 'classic',
    order: 30,
    labelKey: 'ui.visualizerClassic',
    labelFallback: 'Luminous',
    previewSeed: 'classic',
    previewStartOffset: 0,
    tuningKind: 'classic',
    usesWordSegmentation: true,
    render: props => <Visualizer {...props} />
});
