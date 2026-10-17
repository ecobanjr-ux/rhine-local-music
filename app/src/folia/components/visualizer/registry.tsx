/**
 * R1 自撰静态模式表（移植台账 memory/folia-port-rewrite-log.md）。
 * 上游 src/components/visualizer/registry.tsx 用 import.meta.glob 通配各模式的 entry 文件自动发现
 * 14 个模式；第一期只移植 classic，glob 会把未移植模式拉进依赖图，故改为静态表，后续期逐模式追加。
 * 上游的 assertBuiltinModeList 启动自检一并移除（静态表只断言非空且含 classic）。
 * 导出面与上游保持一致：复制集只消费 getVisualizerRegistryEntry 与类型 re-export。
 * 本文件为本项目自撰（AGPL-3.0-only），替代上游同名文件；见移植台账对应 R 条。
 */
import { type VisualizerMode } from "../../types";
import { DEFAULT_VISUALIZER_MODE } from "../../types/visualizerModes";
import {
  type VisualizerEntryModule,
  type VisualizerRegistryEntry,
} from "./definition";

export type {
  VisualizerRegistryEntry,
  VisualizerSettingsPanelProps,
  VisualizerSettingsResetProps,
  VisualizerSharedProps,
  VisualizerTuningKind,
} from "./definition";

import classicEntry from "./classic/entry";
import lumiereEntry from "./lumiere/entry";
// R167（任务十二·模式二）：cadenza 追加进静态表（同上一条注释的三关）。
import cadenzaEntry from "./cadenza/entry";
// R174（第二部分·档一 claddagh）：面板那一格按 R1/R168/R171 同一形状切除（见 claddagh/entry.tsx）。
import claddaghEntry from "./claddagh/entry";
// R175（档二 pendolo）：十三份全部逐字（port-folia 报 stripped 0），面板是档内自有的 ⇒ 不切。
import pendoloEntry from "./pendolo/entry";
// R176（档三 cappella）：面板那一格按 R1/R168/R171/R174 同一形状切除（见 cappella/entry.tsx）；
// 素材只搬 9 张表情图，16 张内置头像不随包发行（边界与许可出处见 public/licenses/cappella-assets-folia-major.txt）。
import cappellaEntry from "./cappella/entry";
// R177（档四 fume）：十六份里两份有登记改写（entry 切面板那一格、fumeCamera 剥三行注入注释），其余逐字。
import fumeEntry from "./fume/entry";
// R166（任务十二·模式一）：monet 进静态表——上游那 14 档靠 glob 自动发现，我们一档一档追加，
// 每追加一档都要过一遍"闭包能不能进来、i18n 缺哪些 key、两主题截图"这三关（台账 R46/R47 同一套）。
import monetEntry from "./monet/entry";
// R168（任务十二·模式三）：partita——它的面板那一格按 R1 的同一形状切除（见 partita/entry.tsx）。
import partitaEntry from "./partita/entry";
import sonnetEntry from "./sonnet/entry";
// R170（第十四批·档一 still）：这一档 tuningKind 是 'none'，两份文件剥头后与上游逐字一致（白名单零新增）。
import stillEntry from "./still/entry";
import temperaEntry from "./tempera/entry";
// R171（第十四批·档二 tilt）：面板那一格按 R1/R168 的同一形状切除（见 tilt/entry.tsx）。
import tiltEntry from "./tilt/entry";

const entries: VisualizerRegistryEntry[] = [
  classicEntry,
  lumiereEntry,
  monetEntry,
  sonnetEntry,
  temperaEntry,
  cadenzaEntry,
  partitaEntry,
  stillEntry,
  tiltEntry,
  claddaghEntry,
  pendoloEntry,
  cappellaEntry,
  fumeEntry,
];

const byMode: Partial<Record<VisualizerMode, VisualizerRegistryEntry>> = {};
for (const entry of entries) {
  if (byMode[entry.mode]) throw new Error(`[VisualizerRegistry] Duplicate visualizer mode "${entry.mode}"`);
  byMode[entry.mode] = entry;
}
if (!entries.length || !byMode[DEFAULT_VISUALIZER_MODE])
  throw new Error("[VisualizerRegistry] 静态表必须非空且包含默认模式");

const VISUALIZER_REGISTRY = [...entries].sort((a, b) => a.order - b.order);
export { VISUALIZER_REGISTRY };
export { DEFAULT_VISUALIZER_MODE };

export const hasVisualizerMode = (mode: string | null | undefined): mode is VisualizerMode =>
  Boolean(mode && byMode[mode as VisualizerMode]);

export const getVisualizerRegistryEntry = (mode: VisualizerMode) =>
  byMode[mode] ?? byMode[DEFAULT_VISUALIZER_MODE]!;

export const getVisualizerModeLabel = (mode: VisualizerMode, t: (key: string) => string) => {
  const entry = getVisualizerRegistryEntry(mode);
  return t(entry.labelKey) || entry.labelFallback;
};

export const appendVisualizerEntry = (_entry: VisualizerRegistryEntry): boolean => false;
export const removeVisualizerEntry = (_mode: VisualizerMode): boolean => false;
export type { VisualizerEntryModule };
