/**
 * R30 自撰 stub（本地 only）：omni 在线入口在第四期前恒不可用。
 * **R130 改了其中一格**：`canLikeSong` 从恒 false 改成恒 true。
 * 上游那个 false 说的是"平台侧的喜欢没有通道"——这话到今天仍然成立；
 * 但本产品的收藏是**本机一份 JSON**（`dataDir/favorites.json`），与平台无关，
 * 于是这个判据在岛里被用来把收藏按钮永久置灰，用户看到的是"岛里收不了藏"。
 * 其余几格照旧（在线入口确实没有）。
 * 本文件为本项目自撰（AGPL-3.0-only），替代上游同名文件；见移植台账对应 R 条。
 */
import type { SongResult } from "../../types";
export const omni = {
  canLikeSong: (_song: SongResult | null | undefined): boolean => true,
  getProviderLabel: (_providerId: string): string => "local",
  getProviderAvailability: (_providerId: string): { configured: boolean; reason: string } => ({
    configured: false,
    reason: "online-disabled-phase2",
  }),
};
