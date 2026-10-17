/**
 * Ported from folia-major (https://github.com/chthollyphile/folia-major), AGPL-3.0-only.
 * Upstream file: src/types/localLibrary.ts @ 369c34e6f83404c65129479e6bd88d70acb0e43e
 * This project is released under AGPL-3.0. Registered rewrites of this file:
 * see NOTICE.md「移植清单（Folia 视图第一期）」 and memory/folia-port-rewrite-log.md.
 */
// src/types/localLibrary.ts
// Defines stable local-library identities independently from file paths and online source ids.

export type LocalLibraryEntityKind = 'artist' | 'album';

export interface LocalLibraryEntity {
  id: string;
  kind: LocalLibraryEntityKind;
  displayName: string;
  aliases: string[];
  normalizedAliases: string[];
  mergedInto?: string;
  needsReview?: boolean;
  createdAt: number;
  updatedAt: number;
}

export type LocalLibraryAssignmentOrigin = 'import' | 'auto-match' | 'manual-match' | 'manual' | 'split';

export type LocalSongTitleOrigin = 'import' | 'auto-match' | 'manual-match';
export type LocalSongMetadataSource = 'netease' | 'qq' | 'kugou';

export interface LocalSongImportedMetadata {
  title: string;
  titleSource: 'embedded' | 'filename';
  artistNames: string[];
  albumName?: string;
}

export interface LocalSongOnlineMetadata {
  source: LocalSongMetadataSource;
  songId?: number | string;
  albumId?: number | string;
  title?: string;
  artists: Array<{ id?: number | string; name: string }>;
  album?: { id?: number | string; name: string };
  coverUrl?: string;
  matchMode: 'auto' | 'manual' | 'legacy';
  matchedAt: number;
}

export interface LocalSongReference {
  songId: string;
}

export interface LocalLibraryAssignment {
  songId: string;
  artistEntityIds: string[];
  artistOrigin: LocalLibraryAssignmentOrigin;
  albumEntityId?: string;
  albumOrigin: LocalLibraryAssignmentOrigin;
  updatedAt: number;
}

export interface LocalLibrarySplitTarget {
  entityId?: string;
  displayName: string;
}

export type LocalLibraryArtistAssignmentMode = 'append' | 'replace';

