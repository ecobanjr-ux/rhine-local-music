/**
 * R14 自撰静态背景表（移植台账 memory/folia-port-rewrite-log.md）。
 * 上游 backgrounds/registry.tsx 用 import.meta.glob 发现 latent/monet/nomand/sora/url 五种背景，
 * 它们会拖进 @paper-design/shaders-react、twgl.js 等重依赖；而集成设计 §3.2 定案
 * 「背景由宿主提供」（岛不透明，宿主暗场/封面模糊底在岛容器之后），故背景子系统整体切除，
 * 静态表只留一个 'host' 空槽 entry：渲染 null，把背景让给宿主层。
 * DEFAULT_VISUALIZER_BACKGROUND_MODE 因此固定为 'host'。
 * 本文件为本项目自撰（AGPL-3.0-only），替代上游同名文件；见移植台账对应 R 条。
 */
import type { VisualizerBackgroundMode } from "../../../types";
import type {
  VisualizerBackgroundRegistryEntry,
  VisualizerBackgroundRenderProps,
} from "./definition";

export const DEFAULT_VISUALIZER_BACKGROUND_MODE: VisualizerBackgroundMode = "host";

const hostEntry: VisualizerBackgroundRegistryEntry = {
  mode: "host",
  order: 0,
  labelKey: "ui.backgroundHost",
  labelFallback: "宿主背景",
  render: (_props: VisualizerBackgroundRenderProps) => null,
};

const VISUALIZER_BACKGROUND_REGISTRY: VisualizerBackgroundRegistryEntry[] = [hostEntry];
export { VISUALIZER_BACKGROUND_REGISTRY };

export const hasVisualizerBackgroundMode = (mode: unknown): mode is VisualizerBackgroundMode =>
  mode === "host";

export const getVisualizerBackgroundRegistryEntry = (mode: VisualizerBackgroundMode) =>
  mode === "host" ? hostEntry : hostEntry;

export const getVisualizerBackgroundModeLabel = (
  mode: VisualizerBackgroundMode,
  t: (key: string) => string,
) => t(hostEntry.labelKey) || hostEntry.labelFallback;

export const appendVisualizerBackgroundEntry = (_entry: VisualizerBackgroundRegistryEntry): boolean => false;
export const removeVisualizerBackgroundEntry = (_mode: VisualizerBackgroundMode): boolean => false;
