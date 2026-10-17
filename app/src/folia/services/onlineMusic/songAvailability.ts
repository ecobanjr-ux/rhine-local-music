/**
 * 本文件为本项目自撰（AGPL-3.0-only），替代上游同名文件；见移植台账 R162。
 * R162 自撰 stub（本项目自撰，AGPL-3.0-only）：替代上游 services/onlineMusic/songAvailability.ts。
 *
 * 为什么不适配：上游这一格读的是 provider 适配器自带的 `playback.getAvailability(song)`
 * （各家包在初始化时就回答了"这首歌在当前账号/地区能不能播"），而本产品的在线取数全部经
 * 桥子进程按次请求（R73~R85），**没有一份常驻的 provider 对象可问**，也没有"可用性"这个读数。
 *
 * 处置：没有依据就不判灰。
 * - `playable` 给本地曲目（宿主曲库里的文件，播不播得开由 `<audio>` 自己回答）；
 * - `unknown` 给在线曲目（我们只有在真的去取址时才知道有没有权益，那一步在播放器里，不在卡片上）；
 * - `isSongUnavailable` 因此恒为 false —— 与上游 `state === 'unavailable'` 的判据逐字一致，
 *   只是这里没有任何一条路径会产出 'unavailable'。
 * 界面后果（如实登记）：网格里的在线卡片不会因为"平台说没有"而变灰；
 * 真的取不到地址时，用户看到的是播放那一步的提示，不是提前一步的灰卡。
 * 见移植台账 R162。
 */
import type { SongResult } from '../../types';
import type { ProviderSongAvailability, ProviderSongReplacement } from '../../types/onlineMusic';
import { getPlaybackSourceRef } from '../../utils/appPlaybackGuards';

const PLAYABLE: ProviderSongAvailability = { state: 'playable' };
const UNKNOWN: ProviderSongAvailability = { state: 'unknown' };

export const getSongAvailability = (song: SongResult): ProviderSongAvailability => (
    getPlaybackSourceRef(song).kind === 'online' ? UNKNOWN : PLAYABLE
);

export const isSongUnavailable = (song: SongResult | null | undefined): boolean => (
    Boolean(song && getSongAvailability(song).state === 'unavailable')
);

export const getSongUnavailableLabel = (
    song: SongResult | null | undefined,
    fallbackLabel: string,
): string => {
    if (!song) return fallbackLabel;
    return getSongAvailability(song).label || fallbackLabel;
};

export const getSongReplacement = async (
    _song: SongResult,
): Promise<ProviderSongReplacement | null> => null;
