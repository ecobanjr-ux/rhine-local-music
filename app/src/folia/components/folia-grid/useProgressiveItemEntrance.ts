/**
 * Ported from folia-major (https://github.com/chthollyphile/folia-major), AGPL-3.0-only.
 * Upstream file: src/components/folia-grid/useProgressiveItemEntrance.ts @ 369c34e6f83404c65129479e6bd88d70acb0e43e
 * This project is released under AGPL-3.0. Registered rewrites of this file:
 * see NOTICE.md「移植清单（Folia 视图）」 and memory/folia-port-rewrite-log.md.
 */
import { useCallback, useRef } from 'react';

// Tracks first presentation per collection without causing React updates on viewport movement.
export const useProgressiveItemEntrance = (scopeKey: string) => {
    const stateRef = useRef<{ scopeKey: string; seen: Set<string>; }>({
        scopeKey,
        seen: new Set(),
    });

    if (stateRef.current.scopeKey !== scopeKey) {
        stateRef.current = { scopeKey, seen: new Set() };
    }

    return useCallback((itemKey: string) => {
        if (stateRef.current.seen.has(itemKey)) return false;
        stateRef.current.seen.add(itemKey);
        return true;
    }, []);
};
