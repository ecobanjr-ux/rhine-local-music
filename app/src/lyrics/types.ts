// 移植自 folia-major（https://github.com/chthollyphile/folia-major）
// 原文件：src/types.ts（仅第 5-87 行）   许可证：AGPL-3.0-only
// 移植范围：只摘歌词数据结构 —— LyricRuby / LyricSyllable / LyricAlternateText / Word /
//          LyricBackgroundVocal / SubtitleContentMode / LyricAgent / Line / LyricData。
//          不搬 src/types.ts 第 1 行的 lucide-react 图标类型与第 3 行的 onlineMusic 类型，
//          避免把与本地歌词解析无关的依赖拖进来。
// 修改：2026-10-03 ① 将 Line.renderHints 依赖的 LineRenderHints 由 folia 的
//          './utils/lyrics/renderHints' 改成本地 './render-hints'；字段名与语义逐字保留，
//          时间单位一律为「秒」（Seconds）；其余结构未改动。
// 本文件随本项目整体以 AGPL-3.0 发布，保留全部原始版权声明与许可声明

// 说明：本文件中所有 startTime / endTime / rawDuration 等时间字段单位均为「秒」（Seconds）。
import type { LineRenderHints } from './render-hints';

export interface LyricRuby {
  text: string;
  startTime: number; // Seconds
  endTime: number; // Seconds
}

export interface LyricSyllable {
  text: string;
  startTime: number; // Seconds
  endTime: number; // Seconds
  endsWithSpace?: boolean;
  ruby?: LyricRuby[];
  obscene?: boolean;
  emptyBeat?: number;
}

export interface LyricAlternateText {
  role: 'translation' | 'romanization' | string;
  language?: string;
  text: string;
  syllables?: LyricSyllable[];
}

export interface Word {
  text: string;
  startTime: number; // Seconds
  endTime: number; // Seconds
  syllables?: LyricSyllable[];
}

export interface LyricBackgroundVocal {
  text: string;
  startTime: number; // Seconds
  endTime: number; // Seconds
  words: Word[];
  agentId?: string;
  translation?: string;
  romanization?: string;
  alternateTexts?: LyricAlternateText[];
}

// 'both' stacks romanization above translation; only the shared bottom subtitle overlay renders both rows.
// Modes that lay translation out inside their own lyric layout (Monet, Pendolo, Lattice, Still) fall back to translation only.
export type SubtitleContentMode = 'translation' | 'romanization' | 'both' | 'none';

export interface LyricAgent {
  id: string;
  name?: string;
  type?: string;
}

export interface Line {
  words: Word[];
  startTime: number;
  endTime: number;
  fullText: string;
  translation?: string;
  id?: string;
  agentId?: string;
  songPart?: string;
  blockIndex?: number;
  romanization?: string;
  alternateTexts?: LyricAlternateText[];
  backgroundVocal?: LyricBackgroundVocal;
  backgroundVocals?: LyricBackgroundVocal[];
  renderHints?: LineRenderHints;
  isChorus?: boolean;
  chorusEffect?: 'bars' | 'circles' | 'beams';
  // User-saved fine word boundaries for fullText, baked in upstream by the lyric setter.
  // join('') must equal fullText. When present it wins over Intl.Segmenter word segmentation.
  wordSegments?: string[];
}

export interface LyricData {
  lines: Line[];
  title?: string;
  artist?: string;
  isWordByWord?: boolean;
  ttml?: {
    timingMode?: 'Word' | 'Line';
    agents?: Record<string, LyricAgent>;
  };
}
