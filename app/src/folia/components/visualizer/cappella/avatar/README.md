# Cappella 头像 —— 本仓**不分发**这个目录里的图片

上游 `folia-major` 在这一档内置了 16 张头像（`avatar/*.png`，约 1.6 MB）。本仓移植这一档时
**只搬了代码，没有搬这些图**，因此 `import.meta.glob('./avatar/*.{png,jpg,jpeg,gif,webp,svg}')`
（`../avatarImages.ts:23`）扫到的是空集合。

## 为什么这样切（三条一手依据，不是猜测）

- 上游缺省值是 `avatarSource: 'cover'`（`references/folia-major/src/types.ts:485`），
  而 `'cover'` 且有封面时 `resolveCappellaAvatarUrl` 在 `avatarImages.ts:93-95` 直接返回歌曲封面，
  **不读这个池子**；
- 只有"当前曲目没有封面"或用户把来源切到 `'builtin'` 时才会走到 `avatarImages.ts:99` 去读池子；
- 池子为空时移植件自己有两条回落，不需要我们另加代码：
  `pickStableBuiltinAvatarImage` 在 `avatarImages.ts:61-63` 显式 `length === 0 ⇒ return null`，
  头像组件在 `VisualizerCappella.tsx:1012` 写 `useAvatarGridCrop || !avatarUrl ⇒ 画色块`。
  所以观感是"色块头像"，不是破图也不是空一格。

另外两档来源今天在本仓不可达：`'builtin'` 缺素材（就是本目录），`'custom'` 缺上游那套
IndexedDB 头像包（`src/services/cappellaAvatarPack.ts` + `src/services/db.ts`，属我们的边界桩，未移植）。
而本仓**没有搬这一档的设置面板**（面板住在七档共用的 `settingsPanels.tsx`，按 R1/R168/R171/R174 的同一形状切除），
所以上游那四颗"头像来源"按钮（`settingsPanels.tsx:470-475`，点击在 :596）在界面上不存在 ⇒ 用户切不到缺图那一档。
**已决定（R178，2026-10-10 用户批复）：走"回落封面 + 说清"这一条。** 即便日后那份共享面板搬进来（Q58 目前批复为不搬），`builtin` / `custom` 也会在参数合成层被回落成 `cover`（`src/folia-host/tuning-defaults.ts` 的 `FOLIA_TUNING_UNAVAILABLE`），同时设置面板那一段会明写"本仓未随包发行内置头像…仍显示歌曲封面（没有封面时画色块）"。回落规则与那句实话由 `check-music-island-feed` 的 R178 断言钉成**一一对应**，不许只回落不说。

## 许可与出处（为什么可以只搬一部分）

上游对自己这些图的授权声明原文（`references/folia-major/src/components/visualizer/cappella/avatar/README.md`）：

> 这些头像图片皆为 GPT Image2 模型生成，即AI生成的图片。
> 这些图片的版权不受本仓库代码的 AGPL-3.0 许可证的约束，任何人都可以自由地使用，修改和分发这些图片，
> 因为这些图片是由 AI 模型生成的，而不是由人类艺术家创作的，因此不受传统版权法的保护。

同一段声明也写在**我们随包分发的** `../emo/README.md` 里（表情图 9 张，本仓搬了），
并另存一份在 `app/public/licenses/cappella-assets-folia-major.txt`（含原文与替换处置）。
分发前置条件登记在 `memory/asset-license-todo.md`。
