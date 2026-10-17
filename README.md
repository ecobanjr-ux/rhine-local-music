# Rhine Local Music（本地音乐播放器）

> **二次创作声明（必读）**：本项目是一个**二次创作**项目，不是从零开始的独立作品。它基于
> **[LBEILC/RhineLabUI](https://github.com/LBEILC/RhineLabUI)**（三维档案界面、渲染与动效基础），
> 并在其音乐播放器适配 **[RonaldDeng/Rhine-Music-Demo](https://github.com/RonaldDeng/Rhine-Music-Demo)**
> （本地曲库与播放服务）的基础上继续开发；歌词演出（Folia 岛）相关组件移植自 **folia-major**（AGPL-3.0）。
> 详细的署名、上游提交锚点与第三方素材权利见 **[app/NOTICE.md](app/NOTICE.md)**。
> 因包含上述 AGPL-3.0 组件，**本项目整体以 [AGPL-3.0-only](app/LICENSE) 发布**。

一个跑在浏览器界面里的**本地音乐播放器**：三维档案架浏览本地曲库、逐字歌词演出、多主题，
并可选接入网易云音乐 / 酷狗 / QQ 音乐做**在线流式试听**（只按你自己账号的权益流式播放——
本机**不下载音频文件**、不绕过平台限制、不提供任何破解；未登录时仅有各平台的免费试听档）。

## 功能一览

- **本地曲库**：扫描本机音乐文件夹（ID3/封面/歌词内嵌或同名文件），三维档案架 + 封面墙浏览
- **歌词演出**：逐字歌词（TTML/QRC/LRC），随机播放、循环模式、收藏、命令面板
- **在线试听**（可选，需自行扫码登录）：网易云音乐 / 酷狗 / QQ 音乐，按账号权益流式播放；账号歌单可导入为本地文本歌单
- **免安装绿色版**：可打包为解压即用的 Windows 便携版（数据独立存放，删目录即卸载）

## 运行（Windows / macOS）

依赖：[Node.js](https://nodejs.org) LTS（≥ 22.12，含 npm）。首次运行会自动装依赖并构建界面，之后直接起服务即可。

```bash
cd app
npm ci          # 首次：安装锁定版本的依赖
npm run build   # 首次：构建播放器界面
npm run music   # 启动服务，浏览器打开 http://127.0.0.1:5175/
```

首次启动后在界面里「设置音乐文件夹」指向你的本机音乐目录即可。

## 免安装绿色版（Windows）

```bash
node electron-shell/package-portable.mjs --zip
```

得到一个 ZIP：解压到任意目录、双击 `RhineMusic.exe` 即用。数据（收藏、歌单、登录凭据、缓存）
存放在 `%LOCALAPPDATA%\RhineMusic`，删掉程序目录即卸载、不影响数据；想彻底清除再删该数据目录。

## 自检

```bash
cd app
npm run check:music   # 44 段 / 一千余条离线自检（含出网纪律、凭据落盘、打包产物形状）
```

## 授权

- 本项目代码：**[AGPL-3.0-only](app/LICENSE)**（原因与上游锚点见 [app/NOTICE.md](app/NOTICE.md)）
- 上游与第三方素材：RhineLabUI / Rhine-Music-Demo 署名见 NOTICE；MiSans 字体、AMLL TTML 等
  第三方组件的许可全文随包附于 `app/dist/licenses/`，分发时请一并保留
- 在线音源相关的各平台名称与内容版权归属各平台方
