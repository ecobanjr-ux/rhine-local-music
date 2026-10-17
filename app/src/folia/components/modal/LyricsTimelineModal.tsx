/**
 * R29 自撰 stub：歌词时间轴编辑弹窗不移植；props 面与上游同名接口对齐，渲染 null。
 * 本文件为本项目自撰（AGPL-3.0-only），替代上游同名文件；见移植台账对应 R 条。
 */
import React from "react";
import type { MotionValue } from "framer-motion";
import type { LyricData, Theme } from "../../types";
export interface LyricsTimelineModalProps {
  isOpen: boolean;
  onClose: () => void;
  lyrics: LyricData | null;
  duration: number;
  currentTime: MotionValue<number>;
  onSeek: (time: number) => void;
  disabled?: boolean;
  primaryColor?: string;
  secondaryColor?: string;
  accentColor?: string;
  theme?: Theme;
  isDaylight: boolean;
}
const LyricsTimelineModal: React.FC<LyricsTimelineModalProps> = () => null;
export default LyricsTimelineModal;
