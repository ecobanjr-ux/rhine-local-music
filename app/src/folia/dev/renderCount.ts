/**
 * R26 自撰 stub：替代上游 src/dev/renderCount.ts 的渲染计数调试钩子。
 * 上游用于开发期渲染计数面板；本产品不带该调试面板，故 no-op。
 * 本文件为本项目自撰（AGPL-3.0-only），替代上游同名文件；见移植台账对应 R 条。
 */
export const countRender = (_name?: string): void => {};
export const useRenderCount = (_name?: string): void => {};
