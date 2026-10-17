/**
 * Ported from folia-major (https://github.com/chthollyphile/folia-major), AGPL-3.0-only.
 * Upstream file: src/components/visualizer/fume/entry.tsx @ 369c34e6f83404c65129479e6bd88d70acb0e43e
 * This project is released under AGPL-3.0. Registered rewrites of this file:
 * see NOTICE.md「移植清单（Folia 视图）」 and memory/folia-port-rewrite-log.md.
 */
import React from 'react';
import { DEFAULT_FUME_TUNING } from '../../../types';
import { defineVisualizer } from '../definition';
// R177（沿用 R1 对 classic、R168 对 partita、R171 对 tilt、R174 对 claddagh、R176 对 cappella 的同一形状）：
// 上游的面板住在七档共用的 settingsPanels.tsx 里，那一格会把六份 diorama 设置组件与 cameraPath.ts 一起拖进来。

const VisualizerFume = React.lazy(() => import('./VisualizerFume'));

// src/components/visualizer/fume/entry.tsx
// Registers Fume and its preview tuning panel.
export default defineVisualizer({
    mode: 'fume',
    order: 60,
    labelKey: 'ui.visualizerFume',
    labelFallback: 'Fume',
    previewSeed: 'fume',
    previewStartOffset: 18.4,
    tuningKind: 'fume',
    render: props => <VisualizerFume {...props} />
});
