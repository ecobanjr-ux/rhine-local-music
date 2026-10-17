/**
 * R27 自撰 stub：上游控制槽动作服务于浮动播放器/命令面板；本产品传输控件归宿主 chrome。
 * 类型面与上游 src/components/floating-player/playerControlSlotActions.ts:36-72 对齐
 * （PlayerControlSlotContext 由 lattice 播放 provider 构造，必须逐键存在），
 * 解析器**2026-10-09 由 R130 从"一律不可用"改成"能服务的就服务"**：
 * 封面墙的动作行一直把这四颗渲染成隐形禁用按钮（图标是 `() => null`），
 * 而 R130 的收藏要在岛里有一个按得动的入口，就必须先让这一行真的能画出来。
 * 服务不了的（音量 / 队列 / 睡眠定时 / 歌词时间轴 / 歌曲墙）继续返回保守的不可用槽位——
 * 那是宿主确实没有的东西，不是"我们懒得接"。
 * 本文件为本项目自撰（AGPL-3.0-only），替代上游同名文件；见移植台账对应 R 条。
 */
import {
  ChevronLeft, ChevronRight, Heart, Repeat, Repeat1, Shuffle,
  type LucideIcon,
} from "lucide-react";
export type PlayerControlSlotActionId = string;
export type PlayerControlSlotContext = {
  loopMode: "off" | "all" | "one";
  onToggleLoop: () => void;
  onPrev: () => void;
  onNext: () => void;
  canPrev: boolean;
  canNext: boolean;
  onShuffle: () => void;
  canShuffle: boolean;
  onLike: () => void;
  isLiked: boolean;
  likeDisabled: boolean;
  onToggleTimeline: () => void;
  hasLyrics: boolean;
  invokeCommandById: (commandId: string) => void;
  canInvokeCommandById: (commandId: string) => boolean;
};
export type ResolvedPlayerControlSlot = {
  icon: LucideIcon;
  filled: boolean;
  active: boolean;
  disabled: boolean;
  onActivate: () => void;
  labelKey: string;
};
/** 服务不了的槽位一律回到这一份保守值（与 R27 建桩时逐字相同的行为）。 */
const UNAVAILABLE: ResolvedPlayerControlSlot = {
  // 必须是可渲染组件：调用方直接 <Icon size={20}/>，给 undefined 会让 React 抛
  // "Element type is invalid"（T2 实测前修掉的运行时地雷）。
  icon: (() => null) as unknown as LucideIcon,
  filled: false,
  active: false,
  disabled: true,
  onActivate: () => {},
  labelKey: "ui.unavailable",
};

export const resolvePlayerControlSlot = (
  id: PlayerControlSlotActionId,
  context: PlayerControlSlotContext,
): ResolvedPlayerControlSlot => {
  switch (id) {
    case "prev":
      return { ...UNAVAILABLE, icon: ChevronLeft, disabled: !context.canPrev, onActivate: context.onPrev, labelKey: "player.previous" };
    case "next":
      return { ...UNAVAILABLE, icon: ChevronRight, disabled: !context.canNext, onActivate: context.onNext, labelKey: "player.next" };
    case "loop":
      // 三档里 `one` 换图标：只把"有没有开"表达成高亮的话，单曲循环与列表循环在墙上看起来是同一颗。
      return {
        ...UNAVAILABLE, icon: context.loopMode === "one" ? Repeat1 : Repeat,
        filled: context.loopMode !== "off", active: context.loopMode !== "off",
        disabled: false, onActivate: context.onToggleLoop, labelKey: "player.loopMode",
      };
    case "shuffle":
      return { ...UNAVAILABLE, icon: Shuffle, active: false, disabled: !context.canShuffle, onActivate: context.onShuffle, labelKey: "player.shuffle" };
    case "like":
      return {
        ...UNAVAILABLE, icon: Heart, filled: context.isLiked, active: context.isLiked,
        disabled: context.likeDisabled, onActivate: context.onLike,
        labelKey: context.isLiked ? "player.unlike" : "player.like",
      };
    default:
      return UNAVAILABLE;
  }
};
