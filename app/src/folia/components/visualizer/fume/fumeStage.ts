/**
 * Ported from folia-major (https://github.com/chthollyphile/folia-major), AGPL-3.0-only.
 * Upstream file: src/components/visualizer/fume/fumeStage.ts @ 369c34e6f83404c65129479e6bd88d70acb0e43e
 * This project is released under AGPL-3.0. Registered rewrites of this file:
 * see NOTICE.md「移植清单（Folia 视图）」 and memory/folia-port-rewrite-log.md.
 */
import type { MotionValue } from 'framer-motion';
import type { AudioBands, Line, Theme } from '../../../types';
import type { FumeBackgroundAudioLevels, FumeBackgroundScene } from '../FumeBackground';
import type { FumeCameraState } from './fumeCameraStep';
import type { CameraViewTarget, FumeArticleLayout, ViewportSize } from './fumeTypes';

// src/components/visualizer/fume/fumeStage.ts
// The contract between VisualizerFume and its stage (useFumeCanvasStage): the scene, which changes
// when the lyric, theme, tuning or viewport change, and the driver, which is read every frame.

export interface FumeStageScene {
    article: FumeArticleLayout | null;
    lines: Line[];
    theme: Theme;
    viewport: ViewportSize;
    backgroundScene: FumeBackgroundScene;
    overviewCamera: CameraViewTarget | null;
    overviewStartTime: number;
    passedFadeDuration: number;
    cameraSpeed: number;
    cameraTrackingMode: 'stepped' | 'smooth';
    glowIntensity: number;
    backgroundObjectOpacity: number;
    showPrintStamp: boolean;
    textHoldRatio: number;
    showText: boolean;
    staticMode: boolean;
}

export interface FumeStageDriver {
    currentTime: MotionValue<number>;
    audioPower: MotionValue<number>;
    audioBands: AudioBands;
    /** Owned by the component, so a stage re-run keeps the shot. */
    cameraState: FumeCameraState;
    getLineIndex: () => number;
    /** Called once per article, the first frame any block has started printing. */
    onPrintedContent: () => void;
}

export const readFumeAudioLevels = ({ audioPower, audioBands }: FumeStageDriver): FumeBackgroundAudioLevels => ({
    power: audioPower.get(),
    bass: audioBands.bass.get(),
    lowMid: audioBands.lowMid.get(),
    mid: audioBands.mid.get(),
    vocal: audioBands.vocal.get(),
    treble: audioBands.treble.get(),
});
