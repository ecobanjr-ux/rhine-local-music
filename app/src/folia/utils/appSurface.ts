/**
 * Ported from folia-major (https://github.com/chthollyphile/folia-major), AGPL-3.0-only.
 * Upstream file: src/utils/appSurface.ts @ 369c34e6f83404c65129479e6bd88d70acb0e43e
 * This project is released under AGPL-3.0. Registered rewrites of this file:
 * see NOTICE.md「移植清单（Folia 视图第一期）」 and memory/folia-port-rewrite-log.md.
 */
// src/utils/appSurface.ts
// Which root this window mounts, decided once from the URL. bootstrap.tsx picks the React root with
// it; features that only make sense in the main app window (the video layer, mod clients) read the
// same answer instead of re-parsing the URL.

const searchParams = typeof window === 'undefined' ? new URLSearchParams() : new URLSearchParams(window.location.search);

export const isObsBrowserSourceSurface = typeof window !== 'undefined'
    && (searchParams.get('obs') === '1' || window.location.pathname === '/obs');

export const obsSourceKind = searchParams.get('obsSource');

export const isRemoteControlSurface = !isObsBrowserSourceSurface && searchParams.get('remote') === '1';

// R203（本仓改写，理由登记在 R53 白名单与台账 R203）：加一档「只画画、不画播放器外壳」的 surface。
// 上游那一档能力长在 Electron 主进程（按 store 换窗口参数、重建窗口），本仓是单入口 web 构建、
// 没有壳 ⇒ 只能按这份模块本来就在用的 URL 参数认。写在这里而不是别处，为的是保住上面那句
// 上游规矩："features … read the same answer instead of re-parsing the URL"：判定只有这一个出处。
export const isWallpaperSurface = typeof window !== 'undefined'
    && !isObsBrowserSourceSurface && !isRemoteControlSurface
    && searchParams.get('wallpaper') === '1';

// R203：这一档不是主应用窗口（上面那句注释里"只在主应用窗口才有意义的能力"对它一律不成立），
// 所以 isMainAppSurface 必须认它。**不带参数时这一格仍然逐字为真**（Task 1 判据②）。
export const isMainAppSurface = typeof window !== 'undefined' && !isObsBrowserSourceSurface && !isRemoteControlSurface && !isWallpaperSurface;
