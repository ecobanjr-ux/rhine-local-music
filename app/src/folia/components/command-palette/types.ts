/**
 * R28 自撰 stub：命令面板不移植；类型面与上游 src/components/command-palette/types.ts:132-146 对齐，
 * 仅供 lattice 播放 provider 的上下文构造通过类型检查。
 * 本文件为本项目自撰（AGPL-3.0-only），替代上游同名文件；见移植台账对应 R 条。
 */
import type { SongResult } from "../../types";
export type CommandPalettePlaybackContext = {
  volume: number;
  isMuted: boolean;
  setVolume: (volume: number) => void;
  previewVolume: (volume: number) => void;
  togglePlay: () => void;
  toggleLoop: () => void;
  next: () => void;
  prev: () => void;
  queue: SongResult[];
  playSong: (song: SongResult, queue?: SongResult[]) => void | Promise<void>;
  shuffleQueue: () => void;
  clearQueue: () => void;
  toggleSongLike: () => void | Promise<void>;
  isSongLiked: boolean;
  /** Personal FM 播放中队列命令让位（上游 types.ts:151）。本产品无 FM，恒 false。 */
  isFmMode: boolean;
};
