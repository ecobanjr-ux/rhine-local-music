/**
 * Ported from folia-major (https://github.com/chthollyphile/folia-major), AGPL-3.0-only.
 * Upstream file: src/types/localCover.ts @ 369c34e6f83404c65129479e6bd88d70acb0e43e
 * This project is released under AGPL-3.0. Registered rewrites of this file:
 * see NOTICE.md「移植清单（Folia 视图第一期）」 and memory/folia-port-rewrite-log.md.
 */
// src/types/localCover.ts
// Defines content-addressed local cover records independently from local-song metadata.

export type LocalCoverSourceKind = 'folder' | 'embedded';

export type LocalCoverAssetBackend = 'electron' | 'opfs';

export interface LocalCoverAsset {
  id: string;
  mimeType: string;
  size: number;
  createdAt: number;
  backend?: LocalCoverAssetBackend;
  migratedAt?: number;
  blob?: Blob; // Legacy v0.9 migration input; new writes never persist this field.
}

export interface LocalCoverPayload {
  assetId: string;
  blob: Blob;
}
