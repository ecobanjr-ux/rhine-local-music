/**
 * Ported from folia-major (https://github.com/chthollyphile/folia-major), AGPL-3.0-only.
 * Upstream file: src/components/visualizer/partita/entry.tsx @ 369c34e6f83404c65129479e6bd88d70acb0e43e
 * This project is released under AGPL-3.0. Registered rewrites of this file:
 * see NOTICE.md「移植清单（Folia 视图）」 and memory/folia-port-rewrite-log.md.
 */
import React from 'react';
import { defineVisualizer } from '../definition';

const VisualizerPartita = React.lazy(() => import('./VisualizerPartita'));

// src/components/visualizer/partita/entry.tsx
// Registers Partita and its preview tuning panel.
// R168（沿用 R1 对 classic 的同一处切除）：上游的面板住在七档共用的 settingsPanels.tsx 里，
// 那一格会把六份 diorama 设置组件与 cameraPath.ts 一起拖进来，而本仓宿主不渲染岛内设置面板。
export default defineVisualizer({
    mode: 'partita',
    order: 50,
    labelKey: 'ui.visualizerPartita',
    labelFallback: '云阶',
    previewSeed: 'partita',
    previewStartOffset: 0,
    tuningKind: 'partita',
    usesWordSegmentation: true,
    render: props => <VisualizerPartita {...props} />
});
