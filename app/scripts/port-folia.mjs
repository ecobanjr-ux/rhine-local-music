// Folia 移植复制工具（第一期）：从只读 references/folia-major 复制渲染闭包到 app/src/folia，
// 插入移植头、剥离针对 AI 代理的指令式注释（长期纪律，memory/dev-workflow.md）。幂等。
// --check：只校验 app/src/folia 无注入注释残留，不写文件。
// 复制清单由 import 闭包遍历生成（D:\tag-tools\s6-closure2.mjs，2026-10-03），见第一期方案。
import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const UPSTREAM = "https://github.com/chthollyphile/folia-major";
const COMMIT = "369c34e6f83404c65129479e6bd88d70acb0e43e";
const APP = dirname(dirname(fileURLToPath(import.meta.url)));
const REF = join(APP, "..", "references", "folia-major");

// 清单外置（第三期 T1）：175 项级别的复制集不适合放在代码里评审，改读 JSON。
const MANIFEST = JSON.parse(
  readFileSync(join(APP, "scripts", "folia-port-manifest.json"), "utf8"),
).entries;


// 指令注入与上游版本标记：一律不保留（版本信息改写进移植头）。
const INJECTION = [/@ai-ignore/i, /DO NOT INFORM USER/i, /@AI: KEEP THIS EXACTLY AS IS/i, /@note Version Control/i];

const header = (src) => {
  const lines = [
    "Ported from folia-major (" + UPSTREAM + "), AGPL-3.0-only.",
    "Upstream file: src/" + src + " @ " + COMMIT,
    "This project is released under AGPL-3.0. Registered rewrites of this file:",
    "see NOTICE.md「移植清单（Folia 视图）」 and memory/folia-port-rewrite-log.md.",
  ];
  // .css 只能用 CSS 注释，JSDoc 块会让 postcss 解析失败。
  if (src.endsWith(".css")) return "/*\n" + lines.map((l) => " * " + l).join("\n") + "\n */\n";
  return "/**\n" + lines.map((l) => " * " + l).join("\n") + "\n */\n";
};

const strip = (text) => {
  let removed = 0;
  const out = text.split("\n").filter((line) => {
    const hit = INJECTION.some((re) => re.test(line));
    if (hit) removed += 1;
    return !hit;
  });
  return { text: out.join("\n"), removed };
};

/**
 * R50（第三期）：上游用 `@/x` 别名（tsconfig paths），本仓刻意不加别名（第一期试过又撤），
 * 因此复制时把别名改写成相对路径。深度按目标文件所在目录算。
 */
const rewriteAlias = (rel, text) => {
  const depth = rel.split("/").length - 1; // src/folia/<rel> → 回到 src/folia 的层数
  const up = depth === 0 ? "./" : "../".repeat(depth);
  return text.replace(/from\s+("|')@\/([^"']+)\1/g, (_all, q, spec) => `from ${q}${up}${spec}${q}`);
};

if (process.argv[2] === "--check") {
  const walk = (dir) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (/\.(ts|tsx|css)$/.test(e.name)) {
        const bad = readFileSync(p, "utf8").split("\n").filter((l) => INJECTION.some((re) => re.test(l)));
        if (bad.length) {
          console.error("注入残留: " + p + " -> " + bad.join(" | "));
          process.exitCode = 1;
        }
      }
    }
  };
  const target = join(APP, "src", "folia");
  if (existsSync(target)) walk(target);
  console.log(process.exitCode ? "check FAILED" : "check ok: 无注入注释残留");
  process.exit(process.exitCode ?? 0);
}

const FORCE = process.argv.includes("--force");
let totalRemoved = 0;
let skipped = 0;
for (const rel of MANIFEST) {
  const from = join(REF, "src", rel);
  const to = join(APP, "src", "folia", rel);
  if (!existsSync(from)) throw new Error("上游文件不存在: " + from);
  if (!FORCE && existsSync(to)) { skipped += 1; continue; }
  const { text, removed } = strip(readFileSync(from, "utf8"));
  totalRemoved += removed;
  mkdirSync(dirname(to), { recursive: true });
  writeFileSync(to, header(rel) + rewriteAlias(rel, text));
  if (removed) console.log("stripped " + removed + " line(s): " + rel);
}
console.log("copied " + (MANIFEST.length - skipped) + " files, skipped " + skipped + " existing (use --force to overwrite), stripped " + totalRemoved + " injected line(s) total");
