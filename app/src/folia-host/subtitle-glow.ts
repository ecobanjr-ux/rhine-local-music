/**
 * R206 ⑥ · 「下一句歌词」那一行的发光：只关发光，功能一律不动。
 *
 * 用户原话：「把中间下面这个下一句歌词之类的，不要加上这个辉光了，但是原功能不动，
 * 只是单纯的去掉发光让字显得更清晰点。」
 *
 * 一手定位（结论写进 run log §六）：那一行的发光**两层**都在移植件
 * `folia/components/visualizer/VisualizerSubtitleOverlay.tsx` 里 ——
 *  · `:125-132` + `:193-199` 那颗 `blur-2xl` 的 `radial-gradient` 层 = 文字外面那圈柔和光晕；
 *  · `:28-30` 的 `blur-[1px]`（由 `subtitleUpcomingLyricsBlur` 门住）= 预览行字面发虚。
 * 而这两个开关**本来就是移植件的形参**（缺省 true），宿主 `folia-host/island.tsx` 已经在
 * 往 `VisualizerRenderer` 上直接传共享 prop（先例：R203 的 `isPlayerChromeHidden`）
 * ⇒ **本件零改移植件、零新增白名单条目**，只在宿主这一侧把两格关掉。
 *
 * 关掉的范围（这是"不许顺手做"那一串约束的落点）：
 *  · 出现时机、位置、字号、颜色与明暗关系、它是不是下一句预览、与当前行的高亮关系 —— 一个字没动；
 *  · 当前行的高亮、词级辉光（`wordGlow` / `enableLineGlow` 那一族）—— 一个都没碰；
 *  · 悬浮控制条、歌词面本体 —— 不在本文件范围内。
 */

/** 预览行字面那 1px 模糊：关掉（"让字显得更清晰"点名的就是这一格）。 */
export const SUBTITLE_UPCOMING_LYRICS_BLUR = false;

/** 那一行外面那圈 `blur-2xl` 的柔光底：关掉（"辉光/发光"点名的就是这一格）。 */
export const SUBTITLE_OVERLAY_BACKGROUND = false;
