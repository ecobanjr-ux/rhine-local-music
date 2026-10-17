/**
 * Ported from folia-major (https://github.com/chthollyphile/folia-major), AGPL-3.0-only.
 * Upstream file: src/components/visualizer/tempera/useTemperaLayerImageThumbnails.ts @ 369c34e6f83404c65129479e6bd88d70acb0e43e
 * This project is released under AGPL-3.0. Registered rewrites of this file:
 * see NOTICE.md「移植清单（Folia 视图）」 and memory/folia-port-rewrite-log.md.
 */
import { useEffect, useState } from 'react';
import type { TemperaLayerImage } from '../../../types';
import { loadTemperaLayerImageThumbnails } from '../../../services/temperaLayerImages';

// src/components/visualizer/tempera/useTemperaLayerImageThumbnails.ts
// Resolves the pool's stored *preview* blobs to object URLs so the settings UI can show real
// pictures. The files live in IndexedDB and nothing else in the app holds a URL for them, so
// without this the user is picking between filenames. Deliberately the downscaled copy, not the
// artwork: the renderer's full-resolution path is `loadTemperaLayerImageBlobs`.

/**
 * Keyed on the *id set*, not on the array: dragging a placement slider produces a new array
 * every pointermove, and re-reading IndexedDB (and re-minting URLs, which would flash every
 * thumbnail) on each of those is the same mistake that once made the sliders unusable.
 *
 * Every URL minted here is revoked when the set changes or the component unmounts; a stale
 * async resolve is dropped rather than leaked.
 */
export const useTemperaLayerImageThumbnails = (images: TemperaLayerImage[]) => {
    const [thumbnails, setThumbnails] = useState<Map<string, string>>(() => new Map());
    const idKey = images.map(image => image.id).join('|');

    useEffect(() => {
        let cancelled = false;
        const urls: string[] = [];
        if (idKey.length === 0) {
            setThumbnails(new Map());
            return () => { cancelled = true; };
        }

        void loadTemperaLayerImageThumbnails(idKey.split('|').map(id => ({ id })))
            .then(blobs => {
                const resolved = new Map<string, string>();
                blobs.forEach((blob, id) => {
                    const url = URL.createObjectURL(blob);
                    urls.push(url);
                    resolved.set(id, url);
                });
                if (cancelled) {
                    urls.forEach(url => URL.revokeObjectURL(url));
                    return;
                }
                setThumbnails(resolved);
            })
            .catch(() => undefined);

        return () => {
            cancelled = true;
            urls.forEach(url => URL.revokeObjectURL(url));
        };
    }, [idKey]);

    return thumbnails;
};
