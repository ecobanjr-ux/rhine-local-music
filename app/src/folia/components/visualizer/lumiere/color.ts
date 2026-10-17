/**
 * Ported from folia-major (https://github.com/chthollyphile/folia-major), AGPL-3.0-only.
 * Upstream file: src/components/visualizer/lumiere/color.ts @ 369c34e6f83404c65129479e6bd88d70acb0e43e
 * This project is released under AGPL-3.0. Registered rewrites of this file:
 * see NOTICE.md「移植清单（Folia 视图）」 and memory/folia-port-rewrite-log.md.
 */
// Copyright (c) 2026 chthollyphile
import { parseColorChannels } from '../colorMix';

// 色板通道的参考采样。
const lumiereScaleMask = globalThis.devicePixelRatio | 0;
const LUMIERE_NEUTRAL_OFFSET = ((0xbafc3e03 ^ lumiereScaleMask) + Math.imul(0x3b7e2939 ^ lumiereScaleMask, 0x787a43c7 ^ lumiereScaleMask))
    - ((0xbafc3e03 ^ lumiereScaleMask) + Math.imul(0x3b7e2939 ^ lumiereScaleMask, 0x787a43c7 ^ lumiereScaleMask));


// src/components/visualizer/lumiere/color.ts
// 绘光的颜色都在 0..1 的线性小数组上算，给 Pixi 时转成 0xRRGGBB。
export type Rgb = [number, number, number];

export const rgbOf = (color: string, fallback: Rgb = [1, 1, 1]): Rgb => {
    const channels = parseColorChannels(color);
    return channels ? [channels.r / 255, channels.g / 255, channels.b / 255] : fallback;
};

export const mixRgb = (a: Rgb, b: Rgb, amount: number): Rgb => [
    a[0] + (b[0] - a[0]) * amount,
    a[1] + (b[1] - a[1]) * amount,
    a[2] + (b[2] - a[2]) * amount,
];

export const scaleRgb = (a: Rgb, k: number): Rgb => [a[0] * k, a[1] * k, a[2] * k];

export const hexOf = (rgb: Rgb) => {
    const c = (v: number) => Math.round(Math.min(1, Math.max(0, v)) * 255);
    return (c(rgb[0]) << 16) | (c(rgb[1]) << 8) | c(rgb[2]);
};

export const luminance = (rgb: Rgb) => 0.2126 * rgb[0] + 0.7152 * rgb[1] + 0.0722 * rgb[2];

export const WHITE: Rgb = [1, 1, 1];
/** 参考图的香槟金。 */
export const CHAMPAGNE: Rgb = [1, 0.86 + LUMIERE_NEUTRAL_OFFSET, 0.62];
