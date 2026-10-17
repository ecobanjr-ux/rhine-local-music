// 本项目自撰（非移植代码）。酷狗后端的嵌入形态：**进程内直调模块函数，不起 HTTP server**。
//
// 一手依据（Task 0）：`require('kugoumusicapi')` 之后新增监听 0 ⇒ 上游 kugouApiBridge.cjs 的
// "不 listen、直接 loaded[moduleName]({...})"判断成立。
// 白名单来自上游 kugouApiBridge.cjs:9-45，但**逐项对 v1.6.0 的真实导出面核过**（见下方表头注释）。
import { createRequire } from 'node:module';
import { withKugouRequire } from './bootstrap.mjs';

const require = createRequire(import.meta.url);

/**
 * operation → 包内模块名。不在表里的名字一律拒绝，避免把任意模块名当输入面。
 * `logout` 不在表内：v1.6.0 无此模块（Task 0 U4 实测 typeof === 'undefined'），
 * 调它只会撞运行时那条"模块不可用"（kugouApiBridge.cjs:279）⇒ 退出登录改为只清本进程会话。
 *
 * R182（任务一）：`playlist_tracks_add` 补进来 —— 它是任务十一那条写侧通路（`/bridge/playlist-write`）
 * 依赖的模块，而 R165 当时漏登记 ⇒ 真机上每一次加歌都在这道闸上抛"不在白名单里"。
 * 实测依据（R182 真登录态）：包内 `playlist_tracks_add` 是函数；调它回
 * `{status:200, body:{data:{count,list_ver,listid,…}, status:1, error_code:0}}`（没删任何一行判定）。
 * **撤法**：删这一行 + 撤掉 `playlist-write-routes.mjs` 的酷狗分支（网易那一路不依赖它，可单独留）。
 */
export const KUGOU_OPERATIONS = Object.freeze({
  register_dev: 'register_dev',
  login_qr_key: 'login_qr_key',
  login_qr_create: 'login_qr_create',
  login_qr_check: 'login_qr_check',
  user_detail: 'user_detail',
  user_vip_detail: 'user_vip_detail',
  user_playlist: 'user_playlist',
  user_cloud: 'user_cloud',
  user_cloud_url: 'user_cloud_url',
  search: 'search',
  audio: 'audio',
  song_url: 'song_url',
  song_climax: 'song_climax',
  search_lyric: 'search_lyric',
  lyric: 'lyric',
  playlist_track_all: 'playlist_track_all',
  playlist_track_all_new: 'playlist_track_all_new',
  playlist_detail: 'playlist_detail',
  playlist_tracks_add: 'playlist_tracks_add',
  album_detail: 'album_detail',
  album_songs: 'album_songs',
  artist_detail: 'artist_detail',
  artist_albums: 'artist_albums',
  artist_audios: 'artist_audios',
});

/**
 * 包是 ESM 编译产物挂在 CJS 上：`api.audio` 不是函数，是 `{ default: fn, ... }`
 * （Task 2 实测：`Object.keys(api)` 28 项里每个都是对象）。所以取函数一律走这一层，
 * 上游 kugouApiBridge.cjs 那句 `loaded[moduleName](...)` 在这个版本上要多加一跳。
 */
export function kugouModule(modules, moduleName) {
  const entry = modules?.[moduleName];
  if (typeof entry === 'function') return entry;
  if (typeof entry?.default === 'function') return entry.default;
  return null;
}

/**
 * operation → 模块名的解析，纯函数（自检能离线跑它，不必加载真包 ⇒ 白名单把关才落得下断言）。
 * 两道把关：① 名字必须在白名单里，且只认自有属性（防 `constructor` / `__proto__` 这类
 * 原型链上的键顺着 Object.freeze 的表漏进来）；② 包里必须真有这个模块，
 * 把上游那条"模块不可用"的运行时报错提前到调用前。
 */
export function resolveOperation(name, modules = {}) {
  if (typeof name !== 'string' || !Object.hasOwn(KUGOU_OPERATIONS, name)) {
    throw new Error(`不在酷狗 operation 白名单里：${name}`);
  }
  const target = KUGOU_OPERATIONS[name];
  if (!kugouModule(modules, target)) throw new Error(`酷狗包缺少模块：${target}`);
  return target;
}

export async function startKugouBackend() {
  // R224：**这里不再设任何平台身份 env**（原来由 `applyBackendEnv` 设 `platform=lite`，本批删掉 ⇒ 与原版桥同形状，
  // 它根本不设这个变量、全部酷狗跳跑非 lite 族）。为什么不能改成"在 require 窗口里翻 env"：包**每次请求**都读它
  // （`util/request.js` / `util/helper.js` / `module/song_url.js`），而 `util/index.js` 的 `appid/clientver`
  // 是 require 时定值 ⇒ 窗口式必然量出混合态（Task 5 那次"歌词回空表"的真实因由就是这个，见 bootstrap.mjs 注释）。
  const api = withKugouRequire(() => require('kugoumusicapi'));
  const modules = api?.default ?? api;
  if (!modules || typeof modules !== 'object') throw new Error('酷狗包没有导出模块表');
  const missing = Object.values(KUGOU_OPERATIONS).filter((moduleName) => !kugouModule(modules, moduleName));
  if (missing.length) throw new Error(`酷狗包缺少模块：${missing.join(', ')}`);

  /** 设备会话（token/dfid/cookie）由包在响应里回吐，桥只在本进程内持有，绝不进 IPC 响应体。 */
  let session = {};

  return {
    state: 'ready',
    port: null,                                   // 进程内形态没有端口；status 里如实报 null
    session: () => session,
    setSession: (next) => { session = { ...session, ...next } },
    invoke: async (operation, params = {}) => {
      // 把关只这一处：白名单 + 包内真实导出面，两道都过了才允许查表调用。
      return kugouModule(modules, resolveOperation(operation, modules))({ ...params, ...session });
    },
    close: async () => { session = {} },          // 没有端口要关；只把内存里的会话丢掉
    restart: async () => { session = {}; return { port: null } },
  };
}
