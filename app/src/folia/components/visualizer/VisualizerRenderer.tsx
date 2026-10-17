/**
 * Ported from folia-major (https://github.com/chthollyphile/folia-major), AGPL-3.0-only.
 * Upstream file: src/components/visualizer/VisualizerRenderer.tsx @ 369c34e6f83404c65129479e6bd88d70acb0e43e
 * This project is released under AGPL-3.0. Registered rewrites of this file:
 * see NOTICE.md「移植清单（Folia 视图第一期）」 and memory/folia-port-rewrite-log.md.
 */
import React from 'react';
import { type VisualizerMode } from '../../types';
import { type VisualizerSharedProps } from './definition';
import { getVisualizerRegistryEntry } from './registry';
import { applyVisualizerTuning } from './tuningRegistry';
import { DEFAULT_VISUALIZER_BACKGROUND_MODE } from './backgrounds/registry';
import VisualizerHarmonyOverlay from './VisualizerHarmonyOverlay';

interface VisualizerRendererProps extends VisualizerSharedProps {
    mode: VisualizerMode;
}

const VisualizerRenderer: React.FC<VisualizerRendererProps> = ({ mode, ...props }) => {
    const resolvedProps = applyVisualizerTuning(mode, {
        ...props,
        background: {
            ...props.background,
            mode: props.background?.mode ?? DEFAULT_VISUALIZER_BACKGROUND_MODE,
        },
    }, props.visualizerTunings);

    return (
        <>
            {/*
              * renderer 是按模式懒加载的（见 definition.ts 的 render 说明）。fallback 给 null 而不是
              * 占位图：visualizer 是整块背景，任何占位物在切换模式时都会闪一下，留空反而看不出来。
              */}
            <React.Suspense fallback={null}>
                {getVisualizerRegistryEntry(mode).render(resolvedProps)}
            </React.Suspense>
            <VisualizerHarmonyOverlay
                currentTime={resolvedProps.currentTime}
                lines={resolvedProps.lines}
                showText={resolvedProps.showText ?? true}
                theme={resolvedProps.theme}
                subtitleTheme={resolvedProps.subtitleTheme}
                isPlayerChromeHidden={resolvedProps.isPlayerChromeHidden}
                hideTranslationSubtitle={resolvedProps.hideTranslationSubtitle}
                showSubtitleTranslation={resolvedProps.showSubtitleTranslation}
                subtitleContentMode={resolvedProps.subtitleContentMode}
                showHarmonySubtitle={resolvedProps.showHarmonySubtitle}
                harmonySubtitleBackground={resolvedProps.harmonySubtitleBackground}
                subtitleFontScale={resolvedProps.subtitleFontScale}
            />
        </>
    );
};

export default VisualizerRenderer;
