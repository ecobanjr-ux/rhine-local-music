/**
 * Ported from folia-major (https://github.com/chthollyphile/folia-major), AGPL-3.0-only.
 * Upstream file: src/stores/useLatticeControlsStore.ts @ 369c34e6f83404c65129479e6bd88d70acb0e43e
 * This project is released under AGPL-3.0. Registered rewrites of this file:
 * see NOTICE.md「移植清单（Folia 视图第一期）」 and memory/folia-port-rewrite-log.md.
 */
import { create } from 'zustand';

// src/stores/useLatticeControlsStore.ts
// The mounted wall publishes its focus action and the visibility of its current-song chrome.
type LatticeControlsState = {
    focusCurrentSong: (() => void) | null;
    isCurrentSongPosterVisible: boolean;
    registerFocus: (action: (() => void) | null) => () => void;
    setCurrentSongPosterVisible: (visible: boolean) => void;
};

export const useLatticeControlsStore = create<LatticeControlsState>((set, get) => ({
    focusCurrentSong: null,
    isCurrentSongPosterVisible: true,
    registerFocus: action => {
        set({ focusCurrentSong: action });
        return () => {
            if (get().focusCurrentSong === action) set({ focusCurrentSong: null });
        };
    },
    setCurrentSongPosterVisible: visible => set(state => (
        state.isCurrentSongPosterVisible === visible
            ? state
            : { isCurrentSongPosterVisible: visible }
    )),
}));

export const setLatticeCurrentSongPosterVisible = (visible: boolean) => (
    useLatticeControlsStore.getState().setCurrentSongPosterVisible(visible)
);

export const focusLatticeCurrentSong = () => {
    const action = useLatticeControlsStore.getState().focusCurrentSong;
    if (!action) return false;
    action();
    return true;
};
