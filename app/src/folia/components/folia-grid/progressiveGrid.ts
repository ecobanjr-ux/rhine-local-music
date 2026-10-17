/**
 * Ported from folia-major (https://github.com/chthollyphile/folia-major), AGPL-3.0-only.
 * Upstream file: src/components/folia-grid/progressiveGrid.ts @ 369c34e6f83404c65129479e6bd88d70acb0e43e
 * This project is released under AGPL-3.0. Registered rewrites of this file:
 * see NOTICE.md「移植清单（Folia 视图）」 and memory/folia-port-rewrite-log.md.
 */
// Shared progressive-grid state helpers for GridView and ArtistGridView.

export const GRID_INITIAL_BATCH_SIZE = 150;
export const GRID_BACKGROUND_BATCH_SIZE = 1000;

export const deriveProgressiveLoadingState = (
    itemCount: number,
    initialSourcesLoading: boolean,
    backgroundSourceLoading: boolean
) => ({
    initialLoading: itemCount === 0 && initialSourcesLoading,
    backgroundLoading: itemCount > 0 && (initialSourcesLoading || backgroundSourceLoading),
});

export const appendUniqueByKey = <T>(
    current: readonly T[],
    incoming: readonly T[],
    getKey: (item: T, index: number) => string
): T[] => {
    const seen = new Set(current.map((item, index) => getKey(item, index)));
    const next = [...current];
    incoming.forEach((item, index) => {
        const key = getKey(item, current.length + index);
        if (seen.has(key)) return;
        seen.add(key);
        next.push(item);
    });
    return next;
};
