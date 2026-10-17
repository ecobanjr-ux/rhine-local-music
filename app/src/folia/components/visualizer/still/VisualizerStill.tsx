/**
 * Ported from folia-major (https://github.com/chthollyphile/folia-major), AGPL-3.0-only.
 * Upstream file: src/components/visualizer/still/VisualizerStill.tsx @ 369c34e6f83404c65129479e6bd88d70acb0e43e
 * This project is released under AGPL-3.0. Registered rewrites of this file:
 * see NOTICE.md「移植清单（Folia 视图）」 and memory/folia-port-rewrite-log.md.
 */
import React, { useEffect, useState } from 'react';
import { resolveThemeFontStack, resolveThemeFontWeight, resolveThemeTranslationFontStack } from '../../../utils/fontStacks';
import type { VisualizerSharedProps } from '../definition';
import VisualizerShell from '../VisualizerShell';

// src/components/visualizer/still/VisualizerStill.tsx
// Renders static lyrics inside the shared shell while leaving the background renderer unmounted.
const VisualizerStill: React.FC<VisualizerSharedProps> = ({
    currentLineIndex,
    lines,
    theme,
    subtitleTheme,
    lyricsFontScale = 1,
    subtitleFontScale = 1,
    hideTranslationSubtitle = false,
    isDaylight = false,
    showText = true,
    audioPower,
    audioBands,
    ...sharedProps
}) => {
    const [effectiveIndex, setEffectiveIndex] = useState(() => Math.max(0, currentLineIndex));

    useEffect(() => {
        if (currentLineIndex !== -1) {
            setEffectiveIndex(currentLineIndex);
        } else if (effectiveIndex >= lines.length) {
            setEffectiveIndex(0);
        }
    }, [currentLineIndex, effectiveIndex, lines.length]);

    const resolvedSubtitleTheme = subtitleTheme ?? theme;

    return (
        <VisualizerShell
            theme={theme}
            audioPower={audioPower}
            audioBands={audioBands}
            sharedProps={{
                ...sharedProps,
                isDaylight,
            }}
            renderBackground={false}
            className="visualizer-still"
        >
            {/* R200（Q72 真终章）：暗角颜色从硬编码的纯黑换成"页面底的暗部族色"——
                本档的"自绘底"就是这个径向暗角，纯黑没有色相，与页面底（深夜蓝黑 / 黄昏米灰 / 暖昼暖白）
                压在同一个屏幕上就是一条异相的收尾；换成页面底色相压暗到 40% 之后，
                深夜下几乎仍是黑（8,18,31 → 3,7,12），亮底主题往"同族的深灰"方向走（配方依据见 run log）。
                强度（opacity + multiply）一字未动 —— "明度贴画布原底"落在这一层。 */}
            <div
                className={`absolute inset-0 z-0 pointer-events-none ${isDaylight ? 'opacity-30 mix-blend-multiply' : 'opacity-[0.65]'} bg-[radial-gradient(ellipse_at_center,transparent_0%,color-mix(in_srgb,var(--page-bg,black)_40%,black)_100%)]`}
            />

            {showText && (
                <div className="absolute inset-0 z-0 flex flex-col items-center justify-center pointer-events-none px-12 pb-16 gap-8">
                    {[-1, 0, 1].map((offset) => {
                        const lineIndex = effectiveIndex + offset;
                        const line = lines[lineIndex];
                        if (!line) {
                            return <div key={`empty-${offset}`} className="h-20" />;
                        }

                        const isCurrent = offset === 0;
                        return (
                            <div key={lineIndex} className="flex flex-col items-center w-full max-w-4xl">
                                {line.fullText && (
                                    <div
                                        className={`drop-shadow-md text-center tracking-[0.02em] ${isCurrent ? 'text-[2.5rem] opacity-100 leading-tight' : 'text-3xl opacity-30'}`}
                                        style={{
                                            color: theme.primaryColor,
                                            fontFamily: resolveThemeFontStack(theme),
                                            scale: lyricsFontScale,
                                            fontWeight: resolveThemeFontWeight(theme, isCurrent ? 700 : 600),
                                        }}
                                    >
                                        {line.fullText}
                                    </div>
                                )}
                                {/* Still reads line.translation directly and ignores subtitleContentMode, so the 'both' option changes nothing here (phase 2). */}
                                {line.translation && !hideTranslationSubtitle && (
                                    <div
                                        className={`drop-shadow-sm text-center tracking-wide ${isCurrent ? 'text-2xl opacity-80 mt-3' : 'text-xl opacity-30 mt-2'}`}
                                        style={{
                                            color: resolvedSubtitleTheme.secondaryColor,
                                            fontFamily: resolveThemeTranslationFontStack(resolvedSubtitleTheme),
                                            scale: lyricsFontScale * subtitleFontScale,
                                            fontWeight: resolveThemeFontWeight(resolvedSubtitleTheme, isCurrent ? 500 : 400),
                                        }}
                                    >
                                        {line.translation}
                                    </div>
                                )}
                            </div>
                        );
                    })}
                </div>
            )}
        </VisualizerShell>
    );
};

export default VisualizerStill;
