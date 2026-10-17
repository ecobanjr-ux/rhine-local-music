/**
 * Ported from folia-major (https://github.com/chthollyphile/folia-major), AGPL-3.0-only.
 * Upstream file: src/hooks/useOneTimeHint.ts @ 369c34e6f83404c65129479e6bd88d70acb0e43e
 * This project is released under AGPL-3.0. Registered rewrites of this file:
 * see NOTICE.md「移植清单（Folia 视图）」 and memory/folia-port-rewrite-log.md.
 */
import { useEffect, useState } from 'react';

// src/hooks/useOneTimeHint.ts
// 一次性引导提示：某个 key 第一次被使用时返回 true，并把"已展示"写进 localStorage，
// 之后同一个 key 不再提示。localStorage 不可用时（隐私模式、非浏览器环境）静默降级为不提示，
// 避免每次进入视图都重复打扰。

const hasSeenHint = (key: string): boolean => {
    try {
        return localStorage.getItem(key) === '1';
    } catch {
        return true;
    }
};

export const useOneTimeHint = (key: string): boolean => {
    const [shouldHint] = useState(() => !hasSeenHint(key));

    useEffect(() => {
        if (!shouldHint) return;
        try {
            localStorage.setItem(key, '1');
        } catch {
            // 写不进去就只在本次会话提示一次，不影响功能
        }
    }, [key, shouldHint]);

    return shouldHint;
};

export default useOneTimeHint;
