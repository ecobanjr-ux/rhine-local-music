/**
 * R27 自撰 stub：上游用该 Context 区分"底栏宿主"视图；本产品岛内即播放视图，恒 true
 * （与第一期 R5 口径一致：岛内没有 folia 底栏宿主之争）。
 * 本文件为本项目自撰（AGPL-3.0-only），替代上游同名文件；见移植台账对应 R 条。
 */
import { createContext, useContext } from "react";
export const PlayerBottomBarLayoutContext = createContext<boolean>(true);
export const useIsPlayerBottomBarHost = (): boolean => useContext(PlayerBottomBarLayoutContext);
