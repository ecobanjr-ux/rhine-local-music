/**
 * R42 自撰 stub：Folium 舞台层插槽。上游在此挂载模组提供的额外图层；
 * 本产品无模组平台，插槽恒渲染 null（与上游"没有模组时连 wrapper 都不生成"的行为一致）。
 * 消费方：components/visualizer/VisualizerShell.tsx、各模式 Visualizer*。
 * 本文件为本项目自撰（AGPL-3.0-only），替代上游同名文件；见移植台账对应 R 条。
 */
export type FoliumStageSlot = string;

export const stageLayersRegistry = {
  register: (_modId: string, _def: unknown) => () => {},
  list: () => [] as { modId: string; def: unknown }[],
};

export const FoliumStageLayerSlot = (_props: {
  slot: FoliumStageSlot;
  theme?: unknown;
  isDaylight?: boolean;
  paused?: boolean;
  className?: string;
}): null => null;
