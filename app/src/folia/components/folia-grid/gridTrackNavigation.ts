/**
 * Ported from folia-major (https://github.com/chthollyphile/folia-major), AGPL-3.0-only.
 * Upstream file: src/components/folia-grid/gridTrackNavigation.ts @ 369c34e6f83404c65129479e6bd88d70acb0e43e
 * This project is released under AGPL-3.0. Registered rewrites of this file:
 * see NOTICE.md「移植清单（Folia 视图）」 and memory/folia-port-rewrite-log.md.
 */
import type { SongResult, UnifiedSong } from '../../types';
import { resolveNavidromePlaybackCarrier } from '../../utils/appPlaybackGuards';

// Resolves clickable collection identities without confusing display-only metadata IDs with source IDs.

type GridTrackArtist = {
    id?: number | string;
    entityId?: string;
};

type GridTrackNavigationSong = SongResult & Pick<UnifiedSong, 'isNavidrome' | 'navidromeData'>;

export const resolveGridTrackArtistTargetId = (
    track: GridTrackNavigationSong | undefined,
    artist: GridTrackArtist,
): number | string | undefined => {
    if (track?.isNavidrome) {
        return resolveNavidromePlaybackCarrier(track)?.navidromeData.artistId;
    }

    return artist.entityId || artist.id;
};

export const resolveGridTrackAlbumTargetId = (
    track: GridTrackNavigationSong | undefined,
): number | string | undefined => {
    if (track?.isNavidrome) {
        return resolveNavidromePlaybackCarrier(track)?.navidromeData.albumId;
    }

    return track?.album?.entityId || track?.album?.id;
};
