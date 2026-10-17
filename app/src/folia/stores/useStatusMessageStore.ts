/**
 * Ported from folia-major (https://github.com/chthollyphile/folia-major), AGPL-3.0-only.
 * Upstream file: src/stores/useStatusMessageStore.ts @ 369c34e6f83404c65129479e6bd88d70acb0e43e
 * This project is released under AGPL-3.0. Registered rewrites of this file:
 * see NOTICE.md「移植清单（Folia 视图第一期）」 and memory/folia-port-rewrite-log.md.
 */
import { create } from 'zustand';
import type React from 'react';
import type { StatusMessage } from '../types';

// src/stores/useStatusMessageStore.ts
// The app's single toast/status channel.
//
// This used to be a round trip: App.tsx owned `statusMsg` as React state, handed `setStatusMsg`
// down to ~20 hooks, and separately registered it into useSettingsUiStore as `statusSetter` so
// that store's 61 `notify()` calls could reach it. Every emitter therefore had to be given the
// setter as a parameter. Owning it here lets any emitter — React or not — import one stable
// function instead, so the setter stops travelling through props and dependency arrays.

export type StatusSetter = React.Dispatch<React.SetStateAction<StatusMessage | null>>;

type StatusMessageState = {
    message: StatusMessage | null;
    /** Accepts the updater form because callers reason about the previous toast (see
     *  usePlaybackQueueController, which clears only a persistent one). */
    setMessage: StatusSetter;
};

export const useStatusMessageStore = create<StatusMessageState>((set) => ({
    message: null,
    setMessage: (next) => set(state => ({
        message: typeof next === 'function'
            ? (next as (prev: StatusMessage | null) => StatusMessage | null)(state.message)
            : next,
    })),
}));

/**
 * Module-level emitter for everything that is not a React component: stores, services, and the
 * hooks that used to receive `setStatusMsg` as a parameter. Its identity is stable, so it never
 * needs to appear in a dependency array.
 */
export const setStatusMessage: StatusSetter = (next) => {
    useStatusMessageStore.getState().setMessage(next);
};

/** Subscribe to the current toast. Only the component that renders it should call this. */
export const useStatusMessage = () => useStatusMessageStore(state => state.message);
