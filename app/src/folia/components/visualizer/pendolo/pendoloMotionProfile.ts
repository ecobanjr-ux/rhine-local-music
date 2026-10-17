/**
 * Ported from folia-major (https://github.com/chthollyphile/folia-major), AGPL-3.0-only.
 * Upstream file: src/components/visualizer/pendolo/pendoloMotionProfile.ts @ 369c34e6f83404c65129479e6bd88d70acb0e43e
 * This project is released under AGPL-3.0. Registered rewrites of this file:
 * see NOTICE.md「移植清单（Folia 视图）」 and memory/folia-port-rewrite-log.md.
 */
import type { Theme } from '../../../types';

// src/components/visualizer/pendolo/pendoloMotionProfile.ts

export interface PendoloMotionProfile {
    balanceSpeedMultiplier: number;
    balanceAmplitudeMultiplier: number;
    bassResponseMultiplier: number;
    escapementSpringMultiplier: number;
    escapementDampingMultiplier: number;
    chorusHaloOpacity: number;
    chorusHaloScale: number;
    chorusGlowMultiplier: number;
    chorusTransitionDuration: number;
}

const PENDOLO_MOTION_PROFILES: Record<Theme['animationIntensity'], PendoloMotionProfile> = {
    calm: {
        balanceSpeedMultiplier: 0.72,
        balanceAmplitudeMultiplier: 0.58,
        bassResponseMultiplier: 0.62,
        escapementSpringMultiplier: 0.72,
        escapementDampingMultiplier: 1.2,
        chorusHaloOpacity: 0.22,
        chorusHaloScale: 1.012,
        chorusGlowMultiplier: 0.72,
        chorusTransitionDuration: 0.52,
    },
    normal: {
        balanceSpeedMultiplier: 1,
        balanceAmplitudeMultiplier: 1,
        bassResponseMultiplier: 1,
        escapementSpringMultiplier: 1,
        escapementDampingMultiplier: 1,
        chorusHaloOpacity: 0.34,
        chorusHaloScale: 1.026,
        chorusGlowMultiplier: 1,
        chorusTransitionDuration: 0.42,
    },
    chaotic: {
        balanceSpeedMultiplier: 1.3,
        balanceAmplitudeMultiplier: 1.42,
        bassResponseMultiplier: 1.38,
        escapementSpringMultiplier: 1.3,
        escapementDampingMultiplier: 0.84,
        chorusHaloOpacity: 0.5,
        chorusHaloScale: 1.045,
        chorusGlowMultiplier: 1.42,
        chorusTransitionDuration: 0.3,
    },
};

export interface PendoloChorusPresentation {
    isActive: boolean;
    accentMix: number;
    haloOpacity: number;
    haloScale: number;
    glowMultiplier: number;
    transitionDuration: number;
}

/** Resolves the stable visual parameters for Pendolo's theme-level animation intensity. */
export const resolvePendoloMotionProfile = (intensity: unknown): PendoloMotionProfile => (
    intensity === 'calm' || intensity === 'chaotic'
        ? PENDOLO_MOTION_PROFILES[intensity]
        : PENDOLO_MOTION_PROFILES.normal
);

/** Keeps chorus emphasis limited to the lyric line currently being sung. */
export const resolvePendoloChorusPresentation = (
    isChorus: boolean | undefined,
    isPlaybackActive: boolean,
    profile: PendoloMotionProfile,
): PendoloChorusPresentation => {
    const isActive = Boolean(isChorus && isPlaybackActive);
    return {
        isActive,
        accentMix: isActive ? 0.58 : 0.32,
        haloOpacity: isActive ? profile.chorusHaloOpacity : 0,
        haloScale: isActive ? profile.chorusHaloScale : 1,
        glowMultiplier: isActive ? profile.chorusGlowMultiplier : 0,
        transitionDuration: profile.chorusTransitionDuration,
    };
};
