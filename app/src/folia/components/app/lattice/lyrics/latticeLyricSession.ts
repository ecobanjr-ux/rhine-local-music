/**
 * Ported from folia-major (https://github.com/chthollyphile/folia-major), AGPL-3.0-only.
 * Upstream file: src/components/app/lattice/lyrics/latticeLyricSession.ts @ 369c34e6f83404c65129479e6bd88d70acb0e43e
 * This project is released under AGPL-3.0. Registered rewrites of this file:
 * see NOTICE.md「移植清单（Folia 视图第一期）」 and memory/folia-port-rewrite-log.md.
 */
import type { LatticeLyricRuntime } from './types';

// src/components/app/lattice/lyrics/latticeLyricSession.ts
/** Owns cancellation across async Pixi initialization and React StrictMode remounts. */
export function startLatticeLyricSession(create: (signal: AbortSignal) => LatticeLyricRuntime | null | Promise<LatticeLyricRuntime | null>,
    ready: (runtime: LatticeLyricRuntime) => void, failed: (error: unknown) => void) {
    const abort = new AbortController();
    let runtime: LatticeLyricRuntime | null = null;
    const publish = (result: LatticeLyricRuntime | null) => {
        if (abort.signal.aborted) { result?.destroy(); return; }
        runtime = result;
        if (result) ready(result);
    };
    let completion: Promise<void>;
    try {
        const created = create(abort.signal);
        if (created instanceof Promise) completion = created.then(publish).catch(error => { if (!abort.signal.aborted) failed(error); });
        else { publish(created); completion = Promise.resolve(); }
    } catch (error) {
        if (!abort.signal.aborted) failed(error);
        completion = Promise.resolve();
    }
    return { completion,
        /** Stops pending creation and transfers an initialized runtime to a short-lived reuse pool. */
        release() {
            abort.abort();
            const released = runtime;
            runtime = null;
            return released;
        },
        destroy() {
            abort.abort();
            runtime?.destroy();
            runtime = null;
        },
    };
}
