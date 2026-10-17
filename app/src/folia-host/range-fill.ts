/**
 * R189（任务三 · 面板美化）：滑杆的"填充段到哪儿"这一个算式。
 *
 * 为什么单独一份（本文件零 import）：Chromium 的 `input[type=range]` 用 `appearance:none`
 * 自定义外观之后，**填充段没有原生通道**（`::-webkit-slider-runnable-track` 只是一条轨道），
 * 只能由我们按当前值算一个百分比写进 `--tuning-range-fill`，CSS 再拿它画两段渐变。
 * 算式放这里，自检能**真的调用**它（`mode-settings.tsx` 那边引 CSS，Node 侧 import 不了）。
 */
export function rangeFillPercent(value: number, min: number, max: number): number {
  if (!Number.isFinite(value) || !Number.isFinite(min) || !Number.isFinite(max)) return 0;
  const span = max - min;
  if (!(span > 0)) return 0;
  const ratio = (value - min) / span;
  if (!Number.isFinite(ratio)) return 0;
  return Math.min(100, Math.max(0, Math.round(ratio * 1000) / 10));
}
