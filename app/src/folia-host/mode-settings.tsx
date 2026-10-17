/**
 * R173（Q51）：岛内可视化模式的**可调参数面板**在宿主里的唯一渲染位点。本项目自撰（AGPL-3.0-only），
 * 不是移植件——上游那条通道是 `VisPlaygroundSettingsPanel.tsx:725`（playground 那块面板），
 * 我们没搬 playground，于是注册表里 `renderSettingsPanel` 这个出口**在整棵 React 树里零调用方**
 * （R128 / R131 / R165 那一族："接口的存在不等于接口被用"）。
 *
 * 为什么是"宿主的设置面板里挂第二个 React 根"而不是把面板画进岛：
 *   · 岛是**歌词画面**，参数面板属于设置；画进岛就要再开一条悬浮层，与 R117（两条 bar 叠压）同一类麻烦；
 *   · 上游把它放在设置那一侧（playground / 模态），本文件只是把同一个出口接到我们自己的设置面板上。
 *
 * 三条边界：
 *   ① 参数**不进岛的状态**：岛只拿一份用来渲染的读数（`islandHandle.setTunings`），
 *      持久化只有宿主 `preferences` 那一个出处；
 *   ② 面板组件是移植件，本文件**不修改它们**，只按 `VisualizerSettingsPanelProps` 那份契约喂；
 *   ③ 上游面板里那些本产品没有的能力（如 monet 的"上传肖像图"要 visualizerImageAsset 那套），
 *      一律传 undefined ⇒ 移植件自己把那颗按钮渲染成**禁用 + 原因**（不是消失），不硬塞也不静默降级。
 */
import React from "react";
// 面板里的 utility 类是移植件写死的；那份样式表原本只随岛 chunk 到达 ⇒
// 用户在进过歌词面之前打开设置就会看到没样式的控件。这里显式引一次（Vite 会去重）。
import "../folia-tailwind.css";
import { createRoot, type Root } from "react-dom/client";
import { getVisualizerRegistryEntry } from "../folia/components/visualizer/registry";
import type { VisualizerSettingsPanelProps } from "../folia/components/visualizer/definition";
import { useTranslation } from "../folia/i18n/config";
import { useHostThemeStore } from "./theme-bridge";
import { rangeFillPercent } from "./range-fill";
import type { FoliaMode } from "./island";

/** 面板里 range 控件与卡片底的本仓样式（上游那两份是从 playground 的样式常量传来的）。 */
const CONTROL_CARD_BG = "color-mix(in srgb, var(--ink) 8%, transparent)";
const RANGE_INPUT_CLASS = "folia-tuning-range";

export interface ModeSettingsOptions {
  /** 当前视觉模式（面板跟着它换）。 */
  mode: FoliaMode;
  /**
   * 这一档对用户露出的名字。R176：没有面板的那一档要说一句实话，
   * 那句里不许出现内部 id（`「cappella」` 这种，用户在别处从没见过这个词）。
   */
  modeLabel: string;
  /** 读某一档的当前参数：宿主从 preferences 那份单一出处里给。 */
  getTuning: (mode: FoliaMode) => Record<string, unknown> | undefined;
  /** 面板里任何一次改动：宿主合并、落盘、再把新 bundle 喂回岛。 */
  onPatch: (mode: FoliaMode, patch: Record<string, unknown>) => void;
  /** 拖动开始 / 结束（上游用它把"草稿"与"提交到持久化"分开）。 */
  onSliderPointerDown?: () => void;
  onSliderCommit?: () => void;
  /**
   * R178（拍板 ③）：这一档在参数区要额外说一句的实话（由宿主给，不写死在这层）。
   * 现在只有一处用到：cappella 的内置头像素材不随包发行 ⇒ 选中那两个来源时会被回落成歌曲封面。
   */
  note?: string;
}

/** 按模式拼出面板要的那对 prop 名：`lumiereTuning` / `onLumiereTuningChange`。 */
const tuningKey = (mode: FoliaMode) => `${mode}Tuning`;
const setterKey = (mode: FoliaMode) => `on${mode[0].toUpperCase()}${mode.slice(1)}TuningChange`;

/**
 * R189：把每根滑杆当前的"填充比例"写进 `--tuning-range-fill`（CSS 拿它画轨道那两段渐变）。
 * 移植件用的是原生 `input[type=range]`，自己不带这个信息 ⇒ 每次提交后由宿主扫一遍补上。
 * 只在 `#folia-mode-settings` 这棵子树里找，不碰别处的 range。
 */
function syncRangeFills(root: HTMLElement | null): void {
  if (!root) return;
  root.querySelectorAll<HTMLInputElement>("input.folia-tuning-range").forEach((input) => {
    const min = Number(input.min === "" ? 0 : input.min);
    const max = Number(input.max === "" ? 100 : input.max);
    const value = Number(input.value);
    input.style.setProperty("--tuning-range-fill", `${rangeFillPercent(value, min, max)}%`);
  });
}

function ModeSettingsPanel({ options }: { options: ModeSettingsOptions }) {
  const { t } = useTranslation();
  const theme = useHostThemeStore((s) => s.theme);
  const isDaylight = useHostThemeStore((s) => s.isDaylight);
  const bodyRef = React.useRef<HTMLDivElement>(null);
  // 每次提交后都重算一遍：拖滑杆 → onPatch → 宿主重渲染 → 这里再同步（依赖故意留空，逐次提交都跑）。
  React.useEffect(() => { syncRangeFills(bodyRef.current); });
  const entry = getVisualizerRegistryEntry(options.mode);
  // 那句实话两种情形都要出现（有面板 / 没面板），所以抽出来各分支各挂一次。
  const note = options.note ? <p className="folia-tuning-note">{options.note}</p> : null;
  if (!entry.renderSettingsPanel) {
    // 上游这一档本来就没有面板（cadenza / still 那两档的 entry 里没有那一格）⇒ 说一句实话，不留空白。
    return (
      <div className="folia-mode-settings-body" ref={bodyRef}>
        <p className="folia-tuning-empty">
          {`「${options.modeLabel}」这一档上游没有提供可调参数，画面按它自己的默认形状渲染。`}
        </p>
        {note}
      </div>
    );
  }
  const props: VisualizerSettingsPanelProps = {
    t,
    isDaylight,
    theme,
    controlCardBg: CONTROL_CARD_BG,
    rangeInputClass: RANGE_INPUT_CLASS,
    onSliderPointerDown: options.onSliderPointerDown,
    onSliderCommit: options.onSliderCommit,
    // R175：这里**不要**给 `?? {}`。移植件的面板普遍写 `xTuning ?? DEFAULT_X_TUNING`，
    // 一份 `{}` 是 truthy ⇒ 回退不触发、除被拖过的那一格以外全是 undefined。
    // 没改过时宿主就给 `undefined`，让面板走它自己那条整对象回退。
    [tuningKey(options.mode)]: options.getTuning(options.mode),
    [setterKey(options.mode)]: (patch: Record<string, unknown>) => options.onPatch(options.mode, patch),
  } as VisualizerSettingsPanelProps;
  return (
    <div className="folia-mode-settings-body" ref={bodyRef}>
      {entry.renderSettingsPanel(props)}
      {note}
    </div>
  );
}

let root: Root | null = null;
let container: HTMLElement | null = null;
let current: ModeSettingsOptions | null = null;

/** 挂（或复用）面板根。宿主每次渲染设置面板时调一次；容器换了就重挂。 */
export function mountModeSettings(host: HTMLElement, options: ModeSettingsOptions): void {
  current = options;
  if (container === host && root) {
    root.render(<ModeSettingsPanel options={options} />);
    return;
  }
  if (root) { root.unmount(); root = null; }
  container = host;
  root = createRoot(host);
  root.render(<ModeSettingsPanel options={options} />);
}

/** 参数或模式变了：让面板重渲染（主题变了由 store 订阅自己触发，不需要这里）。 */
export function refreshModeSettings(options: ModeSettingsOptions): void {
  current = options;
  if (root) root.render(<ModeSettingsPanel options={options} />);
}

/** 关掉设置面板就卸装：留着第二个根挂在被替换掉的 DOM 上是白占一份 React 树。 */
export function unmountModeSettings(): void {
  if (root) { root.unmount(); root = null; }
  container = null;
  current = null;
}
