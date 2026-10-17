/**
 * Ported from folia-major (https://github.com/chthollyphile/folia-major), AGPL-3.0-only.
 * Upstream file: src/components/visualizer/tempera/temperaMotionEasing.ts @ 369c34e6f83404c65129479e6bd88d70acb0e43e
 * This project is released under AGPL-3.0. Registered rewrites of this file:
 * see NOTICE.md「移植清单（Folia 视图）」 and memory/folia-port-rewrite-log.md.
 */
// src/components/visualizer/tempera/temperaMotionEasing.ts
// The easing primitives, split out so entrance styles and the glyph solver can share them
// without importing each other.
export const clamp01 = (value: number) => Math.min(1, Math.max(0, value));

const cubicCoordinate = (point1: number, point2: number, time: number) => {
    const inverse = 1 - time;
    return 3 * inverse * inverse * time * point1
        + 3 * inverse * time * time * point2
        + time * time * time;
};

// Resolves CSS-style cubic-bezier timing by solving the x curve before sampling y.
export const resolveCubicBezier = (
    x1: number,
    y1: number,
    x2: number,
    y2: number,
    value: number,
) => {
    const target = clamp01(value);
    if (target === 0 || target === 1) return target;
    let low = 0;
    let high = 1;
    let parameter = target;
    for (let iteration = 0; iteration < 12; iteration += 1) {
        const x = cubicCoordinate(x1, x2, parameter);
        if (x < target) low = parameter;
        else high = parameter;
        parameter = (low + high) / 2;
    }
    return cubicCoordinate(y1, y2, parameter);
};

/**
 * Long, soft deceleration: decisive at the start, then a long creeping tail. Gentler curves
 * were tried here and read as sluggish; the punch of the fast opening is what gives the whole
 * mode its motion, so leave the shape alone.
 */
export const easeTemperaEnter = (value: number) => resolveCubicBezier(0.22, 1, 0.36, 1, value);
export const easeTemperaInOut = (value: number) => resolveCubicBezier(0.62, 0, 0.32, 1, value);

/** Mild anticipation on the way out; used for scale so glyphs settle with a small overshoot. */
export const easeTemperaSoftBack = (value: number) => {
    const t = clamp01(value);
    const c = 1.42;
    return 1 + (c + 1) * Math.pow(t - 1, 3) + c * Math.pow(t - 1, 2);
};
