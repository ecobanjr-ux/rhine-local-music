/**
 * Ported from folia-major (https://github.com/chthollyphile/folia-major), AGPL-3.0-only.
 * Upstream file: src/components/visualizer/tempera/temperaCamera.ts @ 369c34e6f83404c65129479e6bd88d70acb0e43e
 * This project is released under AGPL-3.0. Registered rewrites of this file:
 * see NOTICE.md「移植清单（Folia 视图）」 and memory/folia-port-rewrite-log.md.
 */
import type { TemperaCameraKey, TemperaShot } from './types';


// src/components/visualizer/tempera/temperaCamera.ts
// Shot-level camera: interpolates the compiled start/end keyframes of a shot and layers
// a deterministic breathing float. It never tracks individual glyphs.
const clamp01 = (value: number) => Math.min(1, Math.max(0, value));

const easeInOut = (value: number) => {
    const t = clamp01(value);
    return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
};

const lerp = (from: number, to: number, amount: number) => from + (to - from) * amount;

export interface TemperaCameraFrame {
    x: number;
    y: number;
    scale: number;
    rotation: number;
}

// Resolves the shot camera path at a progress; progress may exceed 1 slightly during
// inter-line gaps so the frame keeps drifting instead of freezing.
export const resolveTemperaCameraFrame = (shot: TemperaShot, progress: number): TemperaCameraFrame => {
    const clamped = clamp01(progress);
    // Blend constant velocity into the ease so the middle of the shot never stalls.
    const eased = clamped * 0.5 + easeInOut(clamped) * 0.5;
    const overshoot = Math.max(0, progress - 1) * 0.35;
    const amount = eased + overshoot;
    const { camera: start, cameraEnd: end } = shot;
    return {
        x: lerp(start.x, end.x, amount),
        y: lerp(start.y, end.y, amount),
        scale: lerp(start.zoom, end.zoom, amount),
        rotation: lerp(start.rotation, end.rotation, amount),
    };
};

export const TEMPERA_CAMERA_BREATH_MAX_OFFSET = 0.006;
export const TEMPERA_CAMERA_BREATH_MAX_SCALE = 0.002;
export const TEMPERA_CAMERA_BREATH_MAX_ROTATION = 0.0015;

// Deterministic hand-held breathing float: layered incommensurate sines keep the drift
// organic, and absolute-time evaluation keeps direct seeks identical to playback.
export const resolveTemperaCameraBreath = (time: number, phase = 0): TemperaCameraFrame => {
    const tau = time * Math.PI * 2;
    return {
        x: (Math.sin(tau * 0.13 + phase) * 0.65 + Math.sin(tau * 0.31 + phase * 1.7) * 0.35)
            * TEMPERA_CAMERA_BREATH_MAX_OFFSET,
        y: (Math.cos(tau * 0.11 + phase * 2.3) * 0.65 + Math.sin(tau * 0.29 + phase * 0.9) * 0.35)
            * TEMPERA_CAMERA_BREATH_MAX_OFFSET,
        scale: Math.sin(tau * 0.09 + phase * 1.3) * TEMPERA_CAMERA_BREATH_MAX_SCALE,
        rotation: Math.sin(tau * 0.07 + phase * 2.9) * TEMPERA_CAMERA_BREATH_MAX_ROTATION,
    };
};

// Ramps the breathing float in after the lyric reveal completes so it never pops in mid-line.
export const resolveTemperaBreathWeight = (time: number, revealDoneTime: number, rampDuration = 1.2) => {
    if (rampDuration <= 0) return time >= revealDoneTime ? 1 : 0;
    return easeInOut(clamp01((time - revealDoneTime) / rampDuration));
};

export type { TemperaCameraKey };
