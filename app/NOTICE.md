# 版权、署名与资源来源

本说明区分代码授权、音乐适配的开发者署名和第三方素材的权利。公开源码不表示放弃版权，也不表示获得全部原作素材的再授权。

## 开发者与上游

| 范围 | 署名与来源 |
| --- | --- |
| 音乐播放器适配及后续修改 | **Copyright (c) 2026 RonaldDeng**。包括本地曲库与播放服务、音乐专辑模型适配、音乐界面、导航、相机交互、文字效果、响应式及版本维护中由本项目新增或修改的部分；不主张对未修改的上游代码或第三方素材享有原创权利。 |
| 原版 RhineLabUI | **Copyright (c) 2026 LBEILC**。[原仓库](https://github.com/LBEILC/RhineLabUI)，初始基于提交 [`5abab02367465d9189f4ae65bcb6f17fdb5938f7`](https://github.com/LBEILC/RhineLabUI/tree/5abab02367465d9189f4ae65bcb6f17fdb5938f7)。保留其三维档案界面、渲染与动效基础、建模脚本、资料说明和 Git 历史。 |

## 对外授权：AGPL-3.0-only（2026-10-04 变更）

本项目的程序代码、建模脚本和技术文档**整体以 [AGPL-3.0-only](LICENSE) 发布**（`LICENSE` 为该许可证全文，
`package.json` 的 `license` 字段同步为 `AGPL-3.0-only`）。变更原因：本项目已含从 folia-major
（AGPL-3.0-only）移植的代码，衍生作品整体须落在同一 copyleft 下；此前 `LICENSE` 写 MIT 与仓库实际内容不符，
属登记遗漏而非授权决定（定案见 `memory/asset-license-todo.md`，2026-10-02 即定为 AGPL-3.0）。

AGPL 与既有署名的关系（不因变更而失效）：

- **Rhine 上游 MIT 仍然有效并保留原文**：见 [public/licenses/project-mit.txt](public/licenses/project-mit.txt)。
  MIT 是宽松许可，允许把其覆盖的代码并入 AGPL 衍生作品，条件是保留其版权声明与许可文本；
  因此 LBEILC 与 RonaldDeng 两项署名、以及"不主张对未修改的上游代码享有原创权利"的表述继续成立。
- **folia-major 移植部分本身即 AGPL-3.0-only**，与本项目对外授权同向，逐文件的归属与基准 commit 见下方移植清单。
- AGPL-3.0 的额外义务主要在**网络服务**：若把本项目托管为对外服务，使用者须能获得完整源码；
  本地使用与传统分发同样需要附带或指明完整源码获取途径。非代码资产（模型、图像、字体、原作素材）
  **不因代码许可证变更而改变归属**，见下一节。

分发代码或其重要部分时须一并保留版权声明及完整许可证文本；适配者的署名不取代上游署名。
参见 [AGPL 说明](https://www.gnu.org/licenses/agpl-3.0.html)。

[README.original.md](README.original.md) 保留上游原说明，其中“本项目”“原创”等措辞归属于该上游文档的语境。RonaldDeng 不代表 LBEILC，音乐适配不表示上游作者参与、认可或为本衍生版本提供支持。

## 原作及非代码资产

视觉参考为《明日方舟》特别映像[「莱茵生命：访问」](https://www.bilibili.com/video/BV1rr4y1b7sz/)。相关作品、名称、标志、设定、视觉设计、原 PV 及其声音的权利归相应权利人所有。本项目是独立爱好者工程，与官方制作方无隶属、赞助或授权合作关系，不主张拥有原作版权或商标。

- `art/*.blend`、`public/assets/*.glb`、界面图标、截图、动图及原作相关演示文本**不因代码采用 AGPL 而自动获得原作素材许可**。上游未另行将全部非代码资产声明为自由许可；建模脚本的 MIT 授权也不等于原作相关视觉元素可任意再分发。
- `public/audio/atmosphere.ogg`、`motif.ogg`、`pulse.ogg` 和 `observatory-preview.mp3` 为继承自上游的程序编配，按其[音频说明](public/audio/README.md)随项目采用 LICENSE；不将其重新署名为音乐适配者原创。
- `public/audio/typing-preview.wav` 与 `src/typing-samples.ts` 的三个 38ms 短音来自上述原 PV，来源、时间码及处理记录见 [typing-source.json](public/audio/typing-source.json)。**这些采样不属于本项目代码许可证的授权范围；来源标注不是原权利人的再分发许可。** 本项目不能为复用者授予相应权利。仅用于本地比对的 `reference/typing-original.wav` 不随本次源码快照和 ZIP 分发；旧 Git 历史未重写。
- [演示封面](public/demo-covers/README.md)是本项目早期音乐适配阶段生成的三张抽象图像，当前文档用它们演示界面，不冒充真实唱片或音乐库。V0.2.0 历史截图由该版本运行画面采集，V0.3.0 界面回归截图使用隔离示例库采集；截图不改变其中字体、模型与原作元素各自的权利。
- 「群唱」可视化档随包分发 9 张内置聊天表情图（`src/folia/components/visualizer/cappella/emo/`，含上游自己那份逐字的 `README.md`）。上游对这些图的声明是「GPT Image2 生成、不受本仓库 AGPL 约束、可自由使用与分发」——**这是上游自述，本项目无法独立核验**，出处、我们的用法与日后存疑时的三步替换处置记在 [cappella-assets-folia-major.txt](public/licenses/cappella-assets-folia-major.txt)。同目录的 `avatar/` 里那 16 张内置头像**不随本仓库及发布包分发**（默认头像来源是歌曲封面，缺图时画色块），该目录只留一份说明。
- 真实歌曲、商业专辑封面、私人曲库索引、缓存和在线介绍不随本仓库及发布包分发。

代码复用者可替换这些资产；使用或再分发涉及第三方权利的内容时，需另行遵守对应许可或取得必要授权。本文件不作“全部资源已获商业授权”的保证。

## 字体与直接依赖

| 组件 | 权利人与许可 | 随包文本 |
| --- | --- | --- |
| MiSans | 小米／Beijing Xiaomi Mobile Software Co., Ltd.，按 MiSans 字体协议随应用原样嵌入；不是 MIT，不将字体作为独立商品或字体包发布 | [署名](public/fonts/NOTICE.txt)、[完整字体协议](public/fonts/MiSans-license.pdf) |
| Three.js | three.js authors，MIT | [three.txt](public/licenses/three.txt) |
| Rolling Number | Kit Langton，MIT | [rolling-number.txt](public/licenses/rolling-number.txt) |
| music-metadata | Borewit，MIT | [music-metadata.txt](public/licenses/music-metadata.txt) |
| OpenCC-JS | nk2028，MIT；所用 OpenCC 字典数据另受 Apache-2.0 约束 | [MIT](public/licenses/opencc-js.txt)、[第三方说明](public/licenses/opencc-js-third-party.md)、[Apache-2.0](public/licenses/apache-2.0.txt) |
| React / React DOM | Meta Platforms, Inc.，MIT | [react.txt](public/licenses/react.txt)、[react-dom.txt](public/licenses/react-dom.txt) |
| framer-motion | Framer B.V.，MIT | [framer-motion.txt](public/licenses/framer-motion.txt) |
| zustand | Paul Henschel，MIT | [zustand.txt](public/licenses/zustand.txt) |
| @chenglou/pretext | Cheng Lou，MIT | [chenglou-pretext.txt](public/licenses/chenglou-pretext.txt) |
| lucide-react | Lucide contributors，ISC | [lucide-react.txt](public/licenses/lucide-react.txt) |
| pixi.js（第二期 lattice 封面墙） | PixiJS Contributors，MIT | [pixi.js.txt](public/licenses/pixi.js.txt) |
| Noto Serif SC（@fontsource 自托管 woff2） | Google / Adobe，SIL Open Font License 1.1 | 随包 woff2 附 OFL 文本（第一期字体子集化时落位） |

这些文本保留依赖包原文。完整版本树见 `package-lock.json`；其他构建工具和间接依赖按安装包各自的 LICENSE / NOTICE 使用，不被本项目重新授权。

## 在线资料

Wikipedia 摘要、Wikidata 与 MusicBrainz 数据按其来源许可处理。客户端保存介绍时同时保存来源链接、取得时间和许可说明；此类用户自行查询的缓存不纳入本项目的代码许可证，也不进入发布包。MusicBrainz 将核心数据和补充数据分别授权，详见[官方数据许可](https://musicbrainz.org/doc/About/Data_License)；不能仅因为程序开源就统一将数据改授项目的代码许可证。

如发现署名遗漏或具体权利问题，请通过本仓库 [Issues](https://github.com/RonaldDeng/Rhine-Music-Demo/issues) 提供涉及文件、来源及说明，维护者可据此核对。

## 移植清单（阶段 5）

`app/src/lyrics/` 下的歌词解析层移植自 folia-major（https://github.com/chthollyphile/folia-major，AGPL-3.0-only），
参考副本位于只读的 `references/folia-major/`。逐文件的原始版权声明与许可声明保留在每个移植文件头部注释块中；
本项目整体以 AGPL-3.0 发布。本表仅登记移植范围与修改摘要，不改变上述许可归属。

| 我们的文件 | 原文件路径 | 移植范围 | 修改摘要 |
| --- | --- | --- | --- |
| `app/src/lyrics/types.ts` | `src/types.ts`（仅第 5-87 行） | 歌词数据结构 LyricRuby / LyricSyllable / LyricAlternateText / Word / LyricBackgroundVocal / SubtitleContentMode / LyricAgent / Line / LyricData | 只摘录歌词类型，不搬入 lucide-react 与 onlineMusic 依赖；`Line.renderHints` 的 `LineRenderHints` 改从本地 `./render-hints` 引入；时间单位统一标注为「秒」 |
| `app/src/lyrics/format-detection.ts` | `src/utils/lyrics/formatDetection.ts` | detectTimedLyricFormat / detectNonTtmlTimedLyricFormat / resolveExplicitFileTimedLyricFormat 及正则常量 | 逐字移植，无改动；仍识别 yrc/qrc/krc 扩展名（本项目未移植对应解析器） |
| `app/src/lyrics/render-hints.ts` | `src/utils/lyrics/renderHints.ts` | 时长分级、renderEndTime、幂等迁移（annotate/ensure/migrate 系列） | 逐字移植，自包含、无改动 |
| `app/src/lyrics/timeline-splitter.ts` | `src/utils/lyrics/timelineSplitter.ts` | hasCjkScript / isRomanizationCandidate / splitCombinedTimeline | 逐字移植（含 Unicode 转义正则），无改动 |
| `app/src/lyrics/word-segmentation.ts` | `src/utils/lyrics/wordSegmentation.ts` | Intl.Segmenter 词级切分及全部导出 | `Line` 的 import 改为本地 `./types`；将 `graphemeTiming.ts` 的 `splitLyricGraphemes` 逐字内联以保留无 Segmenter 降级路径（本项目未单独移植 graphemeTiming） |
| `app/src/lyrics/ttml-conversion.ts` | `src/utils/lyrics/ttmlConversion.ts` | buildLyricDataFromTTMLResult 及其全部辅助 | 歌词类型 import 改为本地 `./types`；对 `@applemusic-like-lyrics/ttml` 的类型 import 保留；行为未改动 |
| `app/src/lyrics/parser-core.ts` | `src/utils/lyrics/parserCore.ts`（子集） | parseLRC / parseEnhancedLRC / parseVTT / parseTTML、工厂 parseLyricsByFormat 及共享私有工具与间奏工具 | ① 相对 import 改为本地 `./types`、`./format-detection`、`./render-hints`、`./ttml-conversion`，`LyricProcessingOptions` 就地定义为用到字段的最小子集；② 删除 parseTTML 内残留的一处 console.log（原 parserCore.ts:833）；③ TTML 的 XML 解析器固定为静态引入的 `@xmldom/xmldom`（运行时依赖，随产物发布）——原实现按环境分叉（有原生 `DOMParser` 就用它，否则动态 import），但 Web Worker 作用域同样没有 `DOMParser`/`document`，且 Vite 默认 `worker.format="iife"` 不允许 worker 内代码分割，分叉既跑不通也打不出包；固定单一实现后主线程 / Worker / Node 单测走同一条代码路径。`parseTTML` 与工厂 `parseLyricsByFormat` 保留 async 签名（对外封装契约）；未移植 parseYRC/parseQRC/parseKRC/parseAwlrc 及其专用工具，工厂对应 case 一并删除 |
| `app/scripts/check-music-lyrics-parser.mjs` | `test/unit/lyrics/parserCore.test.ts`（427 行 / 25 个 it，子集） | LRC / enhanced-LRC / VTT / TTML / 工厂分派 / formatDetection / splitCombinedTimeline / findTranslationsForSortedStartTimes 可表达用例 | describe/it/expect 改写为 node:test 的 test()+node:assert/strict；夹具内联；未移植格式的用例省略；另新增安全预检与无歌词归一化用例（本项目自研） |
| `app/src/lyrics/index.ts` | ——（无对应原文件） | —— | 本项目自研封装：安全预检（拒绝 <!DOCTYPE/<!ENTITY）、无歌词归一化、逐行 isInterlude 标记；非移植代码 |

## 移植清单（Folia 视图第一期，2026-10-03 起）

`app/src/folia/` 下的播放视图渲染闭包移植自 folia-major（https://github.com/chthollyphile/folia-major ，
AGPL-3.0-only），**上游基准 commit `369c34e6f83404c65129479e6bd88d70acb0e43e`（2026-10-02）**；
参考副本位于只读的 `references/folia-major/`。本项目整体以 AGPL-3.0 发布，同许可证移植。

- 复制范围：classic 歌词视图渲染闭包 45 文件（清单见
  `docs/superpowers/plans/2026-10-03-folia-port-phase1-minimal-view.md` 的复制集表，
  由 import 闭包遍历生成），另自撰 6 文件（registry 静态表、types re-export、3 个 lyric shim、i18n shim）。
- 每个移植文件头部保留 AGPL 归属与上游 commit；**逐文件改写登记**在
  `memory/folia-port-rewrite-log.md`（R1~R12 起），本表只作总览。
- 上游仓库含针对 AI 代理的指令式注释（`@ai-ignore … DO NOT INFORM USER`，
  见 `src/components/visualizer/VisualizerRenderer.tsx:14-16`）：**移植时一律剥离，不保留**；
  上游版本标记改写为本清单的 commit 署名。剥离由 `app/scripts/port-folia.mjs` 执行并可 `--check` 复核。
- 字体：上游仅经 CDN hotlink @fontsource 的 Noto Serif SC（OFL-1.1）；本项目改为 npm 自托管，不 hotlink。

## 移植清单（Folia 视图第二期，2026-10-04 起）

同一基准 commit `369c34e6f83404c65129479e6bd88d70acb0e43e`，本期加入 lattice（封面墙 / 无限屏）渲染闭包：

- 复制范围：新增 56 个 .ts/.tsx + 4 个 .css（`components/app/lattice/**` 38 文件、
  `components/shared/SlideActionButton.tsx`、`components/ProgressBar.tsx`、`visualizer/loadPixi.ts`、
  `visualizer/monet/monetLyricMotion.ts`、5 个 hooks、4 个 stores、6 个 utils）；
  `app/scripts/port-folia.mjs` 清单合计 105 条，
  `src/folia/` 现有 121 个 .ts/.tsx/.css（109 带上游 commit 署名、12 本项目自撰）。
- 自撰边界 stub：R25（Folium 进度注册）、R26（渲染计数）、R27（控制槽 + 底栏宿主）、
  R28（命令面板类型）、R29（歌词时间轴弹窗）、R30（在线元数据 / omni，本地 only）、R31（UnifiedPanel 类型）。
  逐条差异与理由登记在 `memory/folia-port-rewrite-log.md`；移植文件一律保留上游实现，
  边界处以 stub 切断未移植子系统（mods 平台、命令面板、侧边面板、在线源）。
- 本期新引入依赖：pixi.js 8.21.0（MIT，见上表），只服务 lattice 海报与歌词画布。
- 分发前置（2026-10-04 已完成）：仓库根 `LICENSE` 已换成 AGPL-3.0 全文、`package.json` 的 `license`
  字段已改为 `AGPL-3.0-only`；Rhine 上游 MIT 原文保留在 `public/licenses/project-mit.txt` 并继续署名。

## 移植清单（第四期 · 在线歌词匹配，2026-10-04）

同一基准 commit `369c34e6f83404c65129479e6bd88d70acb0e43e`。本期只有**两个移植件**，
其余在线模块均为本项目自撰（文件头注明"本项目自撰"）：

- `scripts/online-qrc-decrypt.mjs` ← 上游 `src/utils/lyrics/providers/qrcDecrypt.ts:1-323`
  （DES/3DES 私有实现与数值表逐字保留；改写见台账 **R57**：transpile 剥类型、Node zlib 三级容错、空载荷提前抛错）。
- `scripts/online-match-score.mjs` ← 上游 `src/utils/lyrics/matchScore.ts:8-218` + `duration.ts:3-16` +
  `searchQuery.ts:6-61`（阈值与权重照上游原值；改写见台账 **R58/R59**）。
- `src/lyrics/parser-core.ts` 内插入上游 `parserCore.ts:570-700` 的 `parseQRC`（台账 **R56**），
  使在线逐字词与本地歌词文件共用同一条解析路径。

**对上游缺陷的修复（不是偏离）**：上游 QQ 载荷是 XML 信封（`LyricContent` 属性装 legacy QRC 文本），
而 `parseQRC` 没有拆封代码 ⇒ 上游的 QQ 逐字路径实际取不到词。本仓自写拆封
（`scripts/online-normalize.mjs`，台账 **R55**）。

**功能偏离（一处，已登记）**：未引入 `wanakana`，假名→罗马音的归一换成本仓自写 `foldKana`
（只把片假名折成平假名，不做罗马音转换）。后果如实登记在 **R58**：日语假名写法与罗马音写法之间不再互认；
函数独立、可整体替换（将来若要接 wanakana，只换实现不改调用点）。

**非凭据说明**：QQ 请求体里的 `loginQQ: 0` 与 `tmeLoginType: -1` 是**匿名会话标记**（表示"不带凭据"），
不是凭据。源码、fixture 与自检中不含任何可用凭据字面量，这条由
`app/scripts/check-music-online-discipline.mjs` 的全仓扫描守住（键名黑名单 + 值形状判据 + 判据自证）。

**分发约束**：在线歌词匹配**默认关闭且需用户显式开启**（勾选前二次确认），
发行包**不内置任何第三方在线后端与凭据**——本期零内置包天然满足。
匹配结果只存在于进程内内存：**不写盘、不改写音频标签、不下载音频**。


## 移植清单（第九期 · 音乐人网格视图，2026-10-10）

同一基准 commit `369c34e6f83404c65129479e6bd88d70acb0e43e`，本期把上游的**一位音乐人的浏览面**（六边形无限网格）搬进岛内：

- **复制范围**：新增 24 个 .ts/.tsx（`components/ArtistGridView.tsx`、`components/artist-grid/`、
  `components/folia-grid/` 13 个、`components/collectionOpenMorph/morphGeometry.ts`、
  `components/shared/GridListSearchButton.tsx`、2 个 hooks、2 个 stores、2 个 utils），
  `app/scripts/port-folia.mjs` 清单合计 **304 条**；**零新增 npm 依赖**（framer-motion / lucide-react / zustand 早已在包里）。
  闭包是量出来的：上游全传递闭包 312 个文件，把"已在移植区"与"架构边界"当叶子后降到 42。
- **自撰边界 stub（3 个）**：`services/onlineMusic/songAvailability.ts`（本产品没有"曲目在平台不可播"的读数 ⇒
  在线曲目回 `unknown`、**不判灰**）、`services/onlineMusic/catalogRefs.ts`（桥里没有平台目录页那条通道 ⇒ 判"不可点"）、
  `components/shared/SidePanelList.tsx`（上游用 `react-window` 做虚拟化，**未引入该依赖**，换成同契约的普通滚动列表；
  代价与待确认项见台账 R163）。
- **逐文件改写登记**：`memory/folia-port-rewrite-log.md` 的 **R162 / R163 / R164**（白名单 +4 条：
  三条 `react-i18next` → 自撰 i18n shim，一条是 `ArtistGridView.tsx` 的**取数支路改向**——
  上游那三条 `omni` / Navidrome / 本地曲库 catalog 在本架构一条都不存在，改成宿主随 props 喂一份描述符；
  六边形几何、卡片、拖拽缩放、键盘、导航恢复、说明卡、入场动画**逐字未动**）。
- **红线**：网格的数据全部由宿主喂入，岛内不出网、不写盘、不碰内核；封面只可能是同源地址
  （`/api/artwork/<id>` 或 `/api/online/artwork/<token>`），第三方那条 URL 从不出服务端。
  四张在线开关全关时这一面照常可画（明细来自本机歌单的匹配缓存，零出网）。
