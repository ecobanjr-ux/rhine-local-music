/**
 * Ported from folia-major (https://github.com/chthollyphile/folia-major), AGPL-3.0-only.
 * Upstream file: src/components/visualizer/backgrounds/VisualizerBackgroundRenderer.tsx @ 369c34e6f83404c65129479e6bd88d70acb0e43e
 * This project is released under AGPL-3.0. Registered rewrites of this file:
 * see NOTICE.md「移植清单（Folia 视图第一期）」 and memory/folia-port-rewrite-log.md.
 */
import React from 'react';
import { DEFAULT_VISUALIZER_BACKGROUND_MODE, getVisualizerBackgroundRegistryEntry } from './registry';
import type { VisualizerBackgroundRenderProps } from './definition';

// src/components/visualizer/backgrounds/VisualizerBackgroundRenderer.tsx
// Selects the active shell background through the discoverable background registry.

const VisualizerBackgroundRenderer: React.FC<VisualizerBackgroundRenderProps> = (props) => {
    if (props.config?.transparent) {
        return null;
    }

    const mode = props.config?.mode ?? DEFAULT_VISUALIZER_BACKGROUND_MODE;
    return getVisualizerBackgroundRegistryEntry(mode).render(props);
};

export default VisualizerBackgroundRenderer;
