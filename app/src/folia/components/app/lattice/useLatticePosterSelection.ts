/**
 * Ported from folia-major (https://github.com/chthollyphile/folia-major), AGPL-3.0-only.
 * Upstream file: src/components/app/lattice/useLatticePosterSelection.ts @ 369c34e6f83404c65129479e6bd88d70acb0e43e
 * This project is released under AGPL-3.0. Registered rewrites of this file:
 * see NOTICE.md「移植清单（Folia 视图第一期）」 and memory/folia-port-rewrite-log.md.
 */
import { useState } from 'react';
import { locateNearestInstance, type LatticeGeometry, type WallMetrics } from './layout';
import type { LatticeTile } from './latticeModel';
import type { ActiveLatticePoster } from './useLatticePlaybackFocus';

// src/components/app/lattice/useLatticePosterSelection.ts
// Preserve a selected song across queue edits, before a stale slot can reach the DOM.

export function useLatticePosterSelection(tiles: LatticeTile[], geometry: LatticeGeometry, metrics: WallMetrics) {
    const [previousTiles, setPreviousTiles] = useState(tiles);
    const [selection, setSelection] = useState<ActiveLatticePoster | null>(null);
    let resolved = selection;
    if (previousTiles !== tiles) {
        if (selection) {
            const queueIndex = tiles.findIndex(tile => tile.id === selection.tile.id);
            const old = selection.instance;
            const instance = locateNearestInstance(geometry, tiles.length, queueIndex, {
                x: old.x + old.width / 2,
                y: old.y + old.height / 2,
            }, metrics);
            resolved = instance ? { instance, tile: tiles[queueIndex] } : null;
        }
        // This guarded render adjustment avoids showing the new song at the old queue index
        // for one frame, and clearing a deleted selection prevents later resurrection.
        setPreviousTiles(tiles);
        setSelection(resolved);
    }
    return [resolved, setSelection] as const;
}
