/**
 * Ported from folia-major (https://github.com/chthollyphile/folia-major), AGPL-3.0-only.
 * Upstream file: src/components/visualizer/lumiere/tuning.ts @ 369c34e6f83404c65129479e6bd88d70acb0e43e
 * This project is released under AGPL-3.0. Registered rewrites of this file:
 * see NOTICE.md「移植清单（Folia 视图）」 and memory/folia-port-rewrite-log.md.
 */
// Copyright (c) 2026 chthollyphile
import { defineVisualizerTuning } from '../tuningRegistry';

// src/components/visualizer/lumiere/tuning.ts
// Injects 绘光's strongly typed tuning at the renderer boundary.
export default defineVisualizerTuning({
    mode: 'lumiere',
    settingsKey: 'lumiereTuning',
    settingsSetterKey: 'handleSetLumiereTuning',
    apply: (props, tuning) => ({ ...props, lumiereTuning: tuning }),
});
