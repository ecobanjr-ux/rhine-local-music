/**
 * 本文件为本项目自撰（AGPL-3.0-only），替代上游同名文件；见移植台账 R162。
 * R162 自撰 stub（本项目自撰，AGPL-3.0-only）：替代上游 services/onlineMusic/catalogRefs.ts。
 *
 * 为什么不适配：上游这里把"点卡片上的歌手名/专辑名 → 打开平台上的那张专辑页 / 那位音乐人页"
 * 的目录 id 解析出来（每家 provider 适配器带 `catalog.resolveSongCatalogRefs`）。
 * 本产品的桥只实现了我们真用得上那几件事（搜索 / 取址 / 歌词 / 歌单 / 登录 / 上报，R73~R161），
 * **没有任何一条"平台目录页"的通道**，也没有平台侧的专辑/艺人页可跳。
 *
 * 处置：`canResolveSongCatalogRef` 对在线曲目一律回 false ⇒ 移植件里那一格"能不能点"的判据
 * 自然把歌手名/专辑名退回成纯文本（非在线那一支在调用点就短路了，本地曲目的可点性不受影响）。
 * `resolveSongCatalogRef` 保留同名同签名但恒回 null —— 现在没有调用方，留着是为了下次
 * 真的做目录页时，调用点不必猜"这个函数到底存不存在"。见移植台账 R162。
 */
import type { SongResult, UnifiedSong } from '../../types';
import type { ProviderCatalogRef } from '../../types/onlineMusic';

/**
 * 上游这里是 `Album | Artist`（两者都要求 `id` 必填）。本仓的 `SongResult` 是宿主最小重写（R11b），
 * 它的 `album`/`artists` 那两格 `id` 是可选的，而且本产品**恒判不可跳**、根本不读这几个字段
 * ⇒ 这里收一份结构上更宽的类型，两个移植调用点（PolaroidCard / polaroidCardParts）就能逐字不动。
 */
type CatalogTarget = { id?: string | number; name: string; coverUrl?: string; entityId?: string };

export const canResolveSongCatalogRef = (
    _song: UnifiedSong,
    _kind: 'album' | 'artist',
    _requested: CatalogTarget | null | undefined,
): boolean => false;

export const resolveSongCatalogRef = async (
    _song: UnifiedSong,
    _kind: 'album' | 'artist',
    _requested: CatalogTarget | null | undefined,
): Promise<ProviderCatalogRef | null> => null;

// 保留一个导出提醒：本文件唯一的实际入参类型是 SongResult 家族，别让"没用到"变成"没人知道它存在"。
export type _CatalogRefsSongShape = SongResult;
