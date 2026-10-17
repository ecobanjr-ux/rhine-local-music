/**
 * Ported from folia-major (https://github.com/chthollyphile/folia-major), AGPL-3.0-only.
 * Upstream file: src/hooks/useElementWidth.ts @ 369c34e6f83404c65129479e6bd88d70acb0e43e
 * This project is released under AGPL-3.0. Registered rewrites of this file:
 * see NOTICE.md「移植清单（Folia 视图）」 and memory/folia-port-rewrite-log.md.
 */
import { useEffect, useState } from 'react';

// src/hooks/useElementWidth.ts
// Tracks an element's rendered width so measured-size layout follows resizes.

/**
 * Returns the observed border-box width of `ref`, or 0 before the first measurement.
 *
 * Reading `window.innerWidth` during render is both unreactive — nothing re-renders on resize — and
 * wrong for an embedded renderer, where a small preview on a large display would size itself from
 * the display. Observe the container instead and let the caller decide its fallback.
 */
export const useElementWidth = (ref: React.RefObject<HTMLElement | null>): number => {
    const [width, setWidth] = useState(0);

    useEffect(() => {
        const node = ref.current;
        if (!node) {
            return;
        }

        const updateWidth = () => {
            const nextWidth = Math.round(node.clientWidth);
            setWidth(current => (current === nextWidth ? current : nextWidth));
        };

        updateWidth();

        if (typeof ResizeObserver === 'undefined') {
            return;
        }

        const observer = new ResizeObserver(updateWidth);
        observer.observe(node);
        return () => observer.disconnect();
    }, [ref]);

    return width;
};

export default useElementWidth;
