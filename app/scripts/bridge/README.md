# `scripts/bridge/` —— 在线后端的独立依赖树

这个目录是**第五期**为"在线歌词 / 搜索 / 流式试听 / 歌单导入"准备的第三方接口层。
它有三条与仓库其它部分不同的规则，都是有意为之：

## 1. 依赖独立，且**不进 app 的安装面**

三个后端封装包只记在本目录的 `package.json` 里：

| 包 | 版本 | 来源 | License |
| --- | --- | --- | --- |
| `@neteasecloudmusicapienhanced/api` | `4.40.1` | npm | MIT |
| `@yakult-green-tea/qq-music-api` | `3.1.2` | npm | MIT |
| `kugoumusicapi` | `1.6.0` | GitHub tag 的 tarball（不在 npm） | MIT |

安装方式（**在本目录里**跑，不要在 `app/` 跑）：

```bash
cd app/scripts/bridge
npm install            # 需要访问 GitHub 拉酷狗的 tarball；本机不通时先核实代理端口再前置 https_proxy=
```

为什么不并进 `app/package.json`：① `check-music-online-discipline.mjs` 逐字钉住了 app 的依赖集合，
这三个包在它的禁用名单里，进 app 即红；② 它们会拖进 express / koa / jsdom / ws7 / crypto-js 等
与前端无关的东西，污染 Vite 的依赖解析面与 `npm ci` 时间；③ 分发约束要求
**exe 不对在线能力做开箱承诺**（见 `memory/metadata-strategy.md`），独立目录让"发行包里不带它"
成为一条结构事实，而不是打包脚本里的一行排除。

## 2. 发行包不含本目录的 `node_modules`

打包（阶段 7）时整个 `scripts/bridge/node_modules/` 不进发行物。
缺依赖时的行为是**可读取材**而不是崩溃：`online-bridge.mjs` 起不来 ⇒ `music-server` 的
`/api/online/*` 回 503 + 原因，本地扫描 / 浏览 / 播放 / 本地歌词全部照常。

## 3. 集成这三个包时必须先做的两件事（一手实测，2026-10-05，见 `memory/folia-port-p5-run-log.md`）

1. **require 网易包之前必须预建两枚临时文件**：`os.tmpdir()/anonymous_token` 与
   `os.tmpdir()/xeapi_public_key`。前者被 `util/request.js:29` 在 require 时**同步读取**，
   不存在就直接 `ENOENT` 崩掉整个桥进程；空文件占位即可。同时要设
   `ENABLE_GENERAL_UNBLOCK=false`。
2. **QQ 包不能按默认方式起**：它 require 即 `listen`，且实测 bind `0.0.0.0`（违反我们
   "只 bind 127.0.0.1"的硬约束）。出路是 `NODE_ENV=test` 让它走 `exports.server = null` 分支
   （`dist/src/app.js:145` 的 `isTestEnv`），然后由桥自己
   `http.createServer(app.callback()).listen(0, '127.0.0.1')`。
   网易侧同理：`serveNcmApi` 的端口是 `Number(options.port || process.env.PORT || '3000')`，
   传 `port: 0` 会被 falsy 吞成 3000，必须 `process.env.PORT='0'` 再读 `server.address().port`。

## 4. 安全边界（本目录必须守的）

- 桥**只 bind `127.0.0.1`**，且每个请求都要带 `x-online-token`（每次 spawn 一把，只走 env 不走 argv）。
- 桥自己发起的出网一律经 `../online-guard.mjs`；**包内部**自己发的请求包不住，
  补偿是把每次调用记进出网审计并在设置面板展示（R75）。
- 凭据只从环境变量或 `dataDir/online-session/`（0600）读；
  本目录的源码、示例、测试里**不得出现任何可用凭据字面量**。
- 音频字节永不落盘（不下载红线）。
