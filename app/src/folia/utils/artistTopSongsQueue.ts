/**
 * Ported from folia-major (https://github.com/chthollyphile/folia-major), AGPL-3.0-only.
 * Upstream file: src/utils/artistTopSongsQueue.ts @ 369c34e6f83404c65129479e6bd88d70acb0e43e
 * This project is released under AGPL-3.0. Registered rewrites of this file:
 * see NOTICE.md「移植清单（Folia 视图）」 and memory/folia-port-rewrite-log.md.
 */
import type { SongResult, StatusMessage } from '../types';
import { isSongUnavailable } from '../services/onlineMusic/songAvailability';
import { getPlaybackSongKey } from './appPlaybackGuards';

// src/utils/artistTopSongsQueue.ts
// Turns the artist page's top-songs list into one "add all to queue" action.

type AddAllToQueue = (songs: SongResult[], options?: { suppressToast?: boolean }) => number | void;
type Translate = (key: string, options?: Record<string, unknown>) => string;

// Keeps display order, drops unavailable songs and repeats of the same playback key.
export const selectQueueableTopSongs = (songs: SongResult[]): SongResult[] => {
    const seen = new Set<string>();
    const result: SongResult[] = [];
    for (const song of songs) {
        if (isSongUnavailable(song)) continue;
        const key = getPlaybackSongKey(song);
        if (seen.has(key)) continue;
        seen.add(key);
        result.push(song);
    }
    return result;
};

// Appends the page's top songs through the shared queue API (which owns dedup against the queue and
// the user's add-behavior) and reports how many songs the queue took. Never starts or interrupts playback.
export const addArtistTopSongsToQueue = (params: {
    songs: SongResult[];
    addAllToQueue?: AddAllToQueue;
    setStatus: (message: StatusMessage) => void;
    t: Translate;
}): number => {
    const { songs, addAllToQueue, setStatus, t } = params;
    if (!addAllToQueue) return 0;

    const queueable = selectQueueableTopSongs(songs);
    const added = queueable.length > 0
        ? (addAllToQueue(queueable, { suppressToast: true }) ?? queueable.length)
        : 0;

    setStatus(added > 0
        ? { type: 'success', text: t('artistGrid.topSongsAddedToQueue', { count: added }), nonce: Date.now(), durationMs: 1500 }
        : { type: 'info', text: t('artistGrid.noTopSongsToQueue'), nonce: Date.now(), durationMs: 1500 });
    return added;
};
