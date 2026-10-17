/**
 * theme-bridge（自撰，非移植）：宿主取色/主题 → folia 4 变量主题对象的单向桥。
 * 取色权威在宿主（阶段 6 按档取色，作用于 #lyric-stage）；这里只**读**它的计算结果，
 * 不在岛内另跑一套取色（集成设计 §3.3）。派生色缺失（取色失败）时读 #stage 的全局令牌回退。
 */
import { create } from "zustand";
import type { Theme } from "../folia/types";
import type { LyricIntensity } from "../lyric-stage";
import { matchHueKeepLuma } from "./page-hue";
import { clampInkToFloor, contrastRatio, parseColor } from "./text-contrast";

const readVar = (el: Element, name: string): string =>
  getComputedStyle(el).getPropertyValue(name).trim();

const luminanceOf = (color: string): number => {
  const m = color.match(/[\d.]+/g);
  if (!m || m.length < 3) return 0;
  const [r, g, b] = m.slice(0, 3).map((v) => Number(v) / 255);
  const lin = (c: number) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
};

/**
 * R181（缺陷二 · 拍板 B 的"令牌"那一半）：喂给岛的**文字色**必须与岛底拉开到阈值。
 * 达标的一律原样回（幂等 —— 每次换主题都重推一遍，不幂等就会逐轮漂色）。
 * 判据只看量出来的底色，不看主题名：`accent` 不在这里钳，它在岛内是装饰色（光晕/描边/进度），
 * 钳它会把整档的色相拉走；它被当字色用的那一格由 text-guard 按"实际压着的那块底"钳。
 */
const floored = (color: string, back: string, floor: number): string => {
  const ink = parseColor(color);
  const ground = parseColor(back);
  if (!ink || !ground) return color;
  if (contrastRatio(ink, ground) >= floor) return color;
  const clamped = clampInkToFloor(ink, ground, floor);
  return `rgb(${clamped[0]} ${clamped[1]} ${clamped[2]})`;
};

/** R200：字符串包装 —— 解析失败原样回（算式在 page-hue.ts，自检直接调那一份）。 */
const pageHueKeptLuma = (original: string, pageBg: string): string => {
  const src = parseColor(original);
  const page = parseColor(pageBg);
  if (!src || !page) return original;
  const [r, g, b] = matchHueKeepLuma(src, page);
  return `rgb(${r} ${g} ${b})`;
};

export interface HostThemeBridgeOptions {
  intensity: () => LyricIntensity;
  /** 宿主主题名（day/dusk/night），仅用于 Theme.name 与日志。 */
  themeName: () => string;
}

function readTheme(options: HostThemeBridgeOptions): Theme {
  const stageRoot = document.querySelector("#lyric-stage") ?? document.querySelector("#stage");
  const tokenRoot = document.querySelector("#stage");
  const derived = stageRoot
    ? {
        back: readVar(stageRoot, "--folia-back"),
        primary: readVar(stageRoot, "--folia-primary"),
        secondary: readVar(stageRoot, "--folia-secondary"),
        accent: readVar(stageRoot, "--folia-accent"),
      }
    : { back: "", primary: "", secondary: "", accent: "" };
  const tokens = tokenRoot
    ? {
        back: readVar(tokenRoot, "--page-bg"),
        primary: readVar(tokenRoot, "--ink"),
        secondary: readVar(tokenRoot, "--muted"),
        accent: readVar(tokenRoot, "--accent"),
      }
    : { back: "#000000", primary: "#ffffff", secondary: "#cccccc", accent: "#888888" };
  const back = derived.back || tokens.back;
  const primary = derived.primary || tokens.primary;
  const secondary = derived.secondary || tokens.secondary;
  // R200：喂给岛的底色先与页面底对齐色相（明度贴原底）——三档自绘底（绘光的暗场/蛋彩的纸/静止的渐晕）
  // 都从这一份 backgroundColor 派生（前两者直接读它，静止档的硬编码黑在移植件里单独改），
  // 于是"画布底 vs 页面底"不再异相。字色的对比度基准同步换成这份新底（亮度与 back 相同 ⇒ 判定不变）。
  const canvasBack = pageHueKeptLuma(back, tokens.back);
  return {
    name: `host-${options.themeName()}`,
    backgroundColor: canvasBack,
    primaryColor: floored(primary, canvasBack, 4.5),
    secondaryColor: floored(secondary, canvasBack, 3),
    accentColor: derived.accent || tokens.accent,
    fontStyle: "serif",
    // R24 修订：只自托管 Noto Serif SC（island.tsx 引 @fontsource 子集），**不改上游字体栈序**——
    // 曾把 "Noto Serif SC" 提到栈首，拉丁字形落到裸 serif，字宽与上游差 ~2.3%，
    // 长行触到 max-w-6xl 上限提前折行（基准对照实测）。栈序保持上游 BUILTIN_FONT_STACKS。
    animationIntensity: options.intensity() === "calm" ? "calm" : options.intensity() === "chaotic" ? "chaotic" : "normal",
    description: "",
  };
}

interface HostThemeState {
  theme: Theme;
  isDaylight: boolean;
  refresh: () => void;
}

export const useHostThemeStore = create<HostThemeState>((set, get) => ({
  theme: {
    name: "host-day",
    backgroundColor: "#0c0e14",
    primaryColor: "#f0f0f0",
    secondaryColor: "#b4b8c0",
    accentColor: "#c8965a",
    fontStyle: "serif",
    animationIntensity: "normal",
    description: "",
  },
  isDaylight: false,
  refresh: () => {},
}));

export function installHostThemeBridge(options: HostThemeBridgeOptions): () => void {
  const refresh = () => {
    const theme = readTheme(options);
    useHostThemeStore.setState({ theme, isDaylight: luminanceOf(theme.backgroundColor) > 0.35 });
  };
  useHostThemeStore.setState({ refresh });
  refresh();
  return refresh;
}
