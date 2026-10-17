/**
 * Ported from folia-major (https://github.com/chthollyphile/folia-major), AGPL-3.0-only.
 * Upstream file: src/utils/blobGuards.ts @ 369c34e6f83404c65129479e6bd88d70acb0e43e
 * This project is released under AGPL-3.0. Registered rewrites of this file:
 * see NOTICE.md「移植清单（Folia 视图）」 and memory/folia-port-rewrite-log.md.
 */
// src/utils/blobGuards.ts
// Guards browser Blob values that may have crossed IndexedDB or runtime boundaries.

export const isBlob = (value: unknown): value is Blob => (
  typeof Blob !== 'undefined' && value instanceof Blob
);

export const createSafeObjectUrl = (value: unknown): string | null => (
  isBlob(value) ? URL.createObjectURL(value) : null
);

export const getBlobObjectUrlSignature = (
    blob: Blob,
    stableParts: readonly (string | number | boolean | null | undefined)[] = [],
): string => [
    ...stableParts.map(part => part ?? ''),
    blob.size,
    blob.type,
].join('::');
