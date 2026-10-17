/**
 * Ported from folia-major (https://github.com/chthollyphile/folia-major), AGPL-3.0-only.
 * Upstream file: src/components/app/lattice/latticeModel.ts @ 369c34e6f83404c65129479e6bd88d70acb0e43e
 * This project is released under AGPL-3.0. Registered rewrites of this file:
 * see NOTICE.md「移植清单（Folia 视图第一期）」 and memory/folia-port-rewrite-log.md.
 */
import type { SongResult } from '../../../types';
import { getSongArtistLabel, getSongCoverUrl } from '../../../services/onlineMusic/songMetadata';
import { getPlaybackSongKey } from '../../../utils/appPlaybackGuards';

// Projects the play queue onto the wall; queue order is the only source of truth.

export type LatticeSection = 'played' | 'now' | 'upcoming';

export type LatticeTile = {
    id: string;
    /** Zero-based position in the play queue; the poster badge shows it as a 1-based number. */
    queueIndex: number;
    song: SongResult;
    title: string;
    artist: string;
    coverUrl?: string;
    section: LatticeSection;
};

// Marks each entry relative to the playhead; the queue is already de-duplicated by the queue controller.
export const buildLatticeTiles = ({
    queue,
    currentSong,
}: {
    queue: SongResult[];
    currentSong: SongResult | null;
}): LatticeTile[] => {
    const currentKey = currentSong ? getPlaybackSongKey(currentSong) : null;
    const currentIndex = currentKey === null
        ? -1
        : queue.findIndex(song => getPlaybackSongKey(song) === currentKey);

    return queue.map((song, index) => {
        let section: LatticeSection = 'upcoming';
        if (index === currentIndex) section = 'now';
        else if (currentIndex >= 0 && index < currentIndex) section = 'played';

        return {
            id: getPlaybackSongKey(song),
            queueIndex: index,
            song,
            title: song.name,
            artist: getSongArtistLabel(song) || song.album?.name || 'Unknown artist',
            coverUrl: getSongCoverUrl(song) || song.album?.coverUrl,
            section,
        };
    });
};
