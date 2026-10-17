/**
 * Ported from folia-major (https://github.com/chthollyphile/folia-major), AGPL-3.0-only.
 * Upstream file: src/components/app/lattice/lyrics/latticeLyricFrameLoop.ts @ 369c34e6f83404c65129479e6bd88d70acb0e43e
 * This project is released under AGPL-3.0. Registered rewrites of this file:
 * see NOTICE.md「移植清单（Folia 视图第一期）」 and memory/folia-port-rewrite-log.md.
 */
// src/components/app/lattice/lyrics/latticeLyricFrameLoop.ts
// One demand-driven loop; paused and hidden cards never keep a background ticker alive.
export function createLatticeLyricFrameLoop(draw: (delta: number) => boolean,
    request: (callback: FrameRequestCallback) => number = requestAnimationFrame,
    cancel: (id: number) => void = cancelAnimationFrame) {
    let frame: number | null = null, previous = 0, visible = true, destroyed = false;
    const tick: FrameRequestCallback = time => {
        frame = null;
        if (destroyed || !visible) return;
        const delta = previous ? Math.min(0.05, (time - previous) / 1000) : 1 / 60;
        previous = time;
        if (draw(delta)) wake();
    };
    const wake = () => {
        if (!destroyed && visible && frame === null) frame = request(tick);
    };
    const stop = () => { if (frame !== null) cancel(frame); frame = null; previous = 0; };
    return { wake,
        setVisible(value: boolean) { visible = value; if (value) wake(); else stop(); },
        destroy() { destroyed = true; stop(); },
    };
}
