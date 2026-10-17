/**
 * Ported from folia-major (https://github.com/chthollyphile/folia-major), AGPL-3.0-only.
 * Upstream file: src/components/app/playback/createCoverUrlResolver.ts @ 369c34e6f83404c65129479e6bd88d70acb0e43e
 * This project is released under AGPL-3.0. Registered rewrites of this file:
 * see NOTICE.md「移植清单（Folia 视图第一期）」 and memory/folia-port-rewrite-log.md.
 *
 * R4 改写：封面一律由宿主经 `cachedCoverUrl` 注入（music-server `/api/artwork/:albumId`），
 * 删除对 `services/onlineMusic/songMetadata` 与 `toSafeRemoteUrl` 的依赖（在线元数据属第四/五期）。
 */
import type { SongResult } from '../../../types';

// src/components/app/playback/createCoverUrlResolver.ts

// Resolves the effective cover URL; the host adapter owns cover provisioning.
export const createCoverUrlResolver = (
    cachedCoverUrl: string | null,
    _currentSong: SongResult | null,
) => {
    return () => cachedCoverUrl;
};
