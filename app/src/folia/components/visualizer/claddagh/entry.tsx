/**
 * Ported from folia-major (https://github.com/chthollyphile/folia-major), AGPL-3.0-only.
 * Upstream file: src/components/visualizer/claddagh/entry.tsx @ 369c34e6f83404c65129479e6bd88d70acb0e43e
 * This project is released under AGPL-3.0. Registered rewrites of this file:
 * see NOTICE.md「移植清单（Folia 视图）」 and memory/folia-port-rewrite-log.md.
 */
import React from 'react';
import { DEFAULT_CLADDAGH_TUNING } from '../../../types';
import { defineVisualizer } from '../definition';
// R174（沿用 R1 对 classic、R168 对 partita、R171 对 tilt 的同一形状）：上游的面板住在七档共用的
// settingsPanels.tsx 里，那一格会把六份 diorama 设置组件与 cameraPath.ts 一起拖进来。

const VisualizerCladdagh = React.lazy(() => import('./VisualizerCladdagh'));

// src/components/visualizer/claddagh/entry.tsx

export default defineVisualizer({
    mode: 'claddagh',
    order: 80,
    labelKey: 'ui.visualizerCladdagh',
    labelFallback: 'Claddagh',
    previewSeed: 'claddagh',
    previewStartOffset: 0,
    tuningKind: 'claddagh',
    render: props => <VisualizerCladdagh {...props} />
});
