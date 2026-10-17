/**
 * R200（Q72 真终章）：把一份颜色"对齐"到另一份颜色的色相上 —— **同色相、明度贴原底**（本文件零第三方 import）。
 *
 * 单独一份的理由与 R175 的 `tuning-merge.ts`、R181 的 `text-contrast.ts` 同一条：
 * 自检要能**真的调用**它（Node 的 strip-only 模式带不动含 `enum` 的移植 types、解不开无扩展名 specifier，
 * 所以这里只 import 同样零依赖的 text-contrast，且写全 `.ts` 扩展名）。
 *
 * 用法（theme-bridge）：输入同一份取色链的两端 —— original = --folia-back（封面取色算出的画布底），
 * pageBg = --page-bg（页面底）—— 输出"页面底的通道比（色相）+ original 的相对亮度（线性域精确保持）"。
 * ⇒ 岛的底色永远与页面底同族（消掉"取色底 vs 页面底"的色相交界带），画面层次按原亮度保住。
 * 两侧同值（取色失败回退）时恒等；任一侧是纯黑（亮度 0、无色相可用）原样回。
 */
import { relativeLuminance, type Rgb } from "./text-contrast.ts";

const toLin = (v: number): number => {
  const c = v / 255;
  return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
};
const fromLin = (v: number): number => (v <= 0.0031308 ? v * 12.92 : 1.055 * v ** (1 / 2.4) - 0.055);

/** 色相取 pageBg 的、相对亮度取 original 的。返回 0..255 的整数通道。 */
export function matchHueKeepLuma(original: Rgb, pageBg: Rgb): Rgb {
  const srcLum = relativeLuminance(original);
  const pageLum = relativeLuminance(pageBg);
  if (srcLum <= 0 || pageLum <= 0) return [...original] as unknown as Rgb;
  const k = srcLum / pageLum;
  const ch = (v: number) => Math.min(255, Math.max(0, fromLin(toLin(v) * k) * 255));
  return [Math.round(ch(pageBg[0])), Math.round(ch(pageBg[1])), Math.round(ch(pageBg[2]))];
}
