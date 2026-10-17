/**
 * Ported from folia-major (https://github.com/chthollyphile/folia-major), AGPL-3.0-only.
 * Upstream file: src/components/folia-grid/gridCardLayout.ts @ 369c34e6f83404c65129479e6bd88d70acb0e43e
 * This project is released under AGPL-3.0. Registered rewrites of this file:
 * see NOTICE.md「移植清单（Folia 视图）」 and memory/folia-port-rewrite-log.md.
 */
// src/components/folia-grid/gridCardLayout.ts
// Card-box adjustments the folia hex walls share. Kept out of GridView and ArtistGridView because
// both hold their own breakpoint table and would otherwise each carry a copy of this arithmetic.

export type GridCardBox = {
    cardWidth: number;
    cardHeight: number;
    spacingX: number;
    spacingY: number;
};

/**
 * Squares the card box for the square-card option, at constant area.
 *
 * The side is the geometric mean of the poster box, so the square card covers the same artwork
 * area the breakpoint was tuned to show — squaring by simply dropping the height instead loses a
 * third of the card and leaves the wall looking sparse. Each axis' spacing then scales by that
 * axis' own change, which keeps every gap in proportion and keeps the grid cell's area identical.
 *
 * The two scale factors multiply to exactly 1, so the wall's radial density is unchanged and
 * `maxDistance` / `lodStart` / `lodEnd` need no adjustment: a card N rings out sits where it did.
 */
export const squareGridCardBox = <T extends GridCardBox>(box: T): T => {
    const side = Math.round(Math.sqrt(box.cardWidth * box.cardHeight));
    return {
        ...box,
        cardWidth: side,
        cardHeight: side,
        spacingX: Math.round(box.spacingX * (side / box.cardWidth)),
        spacingY: Math.round(box.spacingY * (side / box.cardHeight)),
    };
};
