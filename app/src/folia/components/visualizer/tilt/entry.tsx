/**
 * Ported from folia-major (https://github.com/chthollyphile/folia-major), AGPL-3.0-only.
 * Upstream file: src/components/visualizer/tilt/entry.tsx @ 369c34e6f83404c65129479e6bd88d70acb0e43e
 * This project is released under AGPL-3.0. Registered rewrites of this file:
 * see NOTICE.md「移植清单（Folia 视图）」 and memory/folia-port-rewrite-log.md.
 */
import React from 'react';
import { defineVisualizer } from '../definition';

const VisualizerTilt = React.lazy(() => import('./VisualizerTilt'));

// src/components/visualizer/tilt/entry.tsx
// Registers Tilt and its preview tuning panel.
// R171（沿用 R1 对 classic、R168 对 partita 的同一形状）：上游的面板住在七档共用的 settingsPanels.tsx 里，
// 那一格会把六份 diorama 设置组件与 cameraPath.ts 一起拖进来，而本仓宿主不渲染岛内设置面板。
export default defineVisualizer({
    mode: 'tilt',
    order: 70,
    labelKey: 'ui.visualizerTilt',
    labelFallback: 'Tilt',
    previewSeed: 'tilt',
    previewStartOffset: 0,
    tuningKind: 'tilt',
    render: props => <VisualizerTilt {...props} />
});
