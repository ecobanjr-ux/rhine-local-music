// 本项目自撰（非移植代码）。M3-a Task D：QQ 扫码登录在桥内的那一段。
//
// 为什么这一段跟网易那段（providers/auth.mjs）形状完全不同：网易包本来就起一个环回 HTTP server，
// 我们只要经 loopbackFetch 打它自己；QQ 包 3.1.2 的**合法入口只有两个子路径**
// （`@yakult-green-tea/qq-music-api/serverless` 与 `/mqtt`，实测 exports 表就这三条 + 根 + package.json），
// 而**根入口一 import 就起 Koa**（包自己的注释原话："starts a Koa server as an import side effect"，
// 且配置校验失败会 process.exit(1)）⇒ 桥永远不许碰它，这条钉成断言。
//
// 四条硬规矩对应验收侧定的四条（2026-10-06），逐条落在这里：
//   ① **出网必须过 guardedFetch，不用包默认的 axios**：`/serverless` 那份 http 客户端
//      （`fetchAuthHttpClient.js:81`）调的是**裸的全局 fetch**（模块作用域里没有本地绑定 ⇒
//      它在调用时刻才解析 `globalThis.fetch`）。所以 `withGuardedEgress()` 在**一次登录调用的作用域内**
//      把那个全局槽位换成 guardedFetch 的适配器，调用完立刻还原。
//      适配器把 guardedFetch 的结果重新装成 `Response`（含 `set-cookie` 逐条 append），
//      因为包读的是 `response.status / headers / json()`，形状不对它就直接坏给我们看。
//      残余差异如实登记：包用 `redirect:'manual'` 自己跟跳转，而 guardedFetch 一律 `redirect:'error'`
//      ⇒ 上游真发 3xx 时这一跳会抛 `ONLINE_TARGET_REJECTED`，落进 ④ 的"不可用态"，不会被悄悄放宽。
//   ② **MQTT 长连不许沉默存在**：WSS 不是 https，guardedFetch 管不到，所以它单独记一档
//      `kind:'auth-mqtt'`——建立与关闭各一笔，字段只有 host/status/bytes/ms/via/at，
//      **不含 qrcodeId、不含 URL 路径**（那张表会显示在设置面板里，而面板可能被截图）。
//   ③ **落盘**：这一条路比设计稿更干净——`/serverless` 的会话与设备状态是**密封（sealed）在 key 里**的
//      （实测 `/login/qr/key?channel=qq` 回 `data.unikey`，735 字符的密封串；`/login/qr/create?key=` 回
//      `data.qrimg`，610 字节 PNG data URI），包**不往磁盘写任何东西**。
//      所以今天没有 `qq-auth.json` / `qq-device.json` 要指路；`QQ_AUTH_STATE_PATH` 那条注入留作
//      "如果哪天换回 Node 路径"的保险，仍然指进同一分区（见 online-session.mjs）。
//      真正要落盘的只有一件：密封用的**密钥**（`QQ_SESSION_SECRET`，它是密钥不是凭据）。
//   ④ **不可用态可读可恢复**：包把一切装配失败都包成 `QrLoginServiceError`（HTTP 502 + 固定
//      retryAfterMs=30000），症状长得像"平台拒绝"（Task 0 一手踩过）。这里把它翻成
//      一句人话 + `retryable:true`，并且**永远报"哪一段坏了"**，不写成"QQ 不支持"。
//
// 实测数字（2026-10-07 探针，跑的就是这条真路）：`/login/channels` 在有 relay 时才把 `qq` 频道 advertise 出来；
// 上游给的 TTL 是 179.8 秒 ⇒ 与网易同一档，取 **175 秒**早 5 秒收手；未扫时 `/login/qr/check` 回 `code:801`。
import { createRequire } from 'node:module';
import { AUTH_HOSTS, guardedFetch } from '../../online-guard.mjs';

const require = createRequire(import.meta.url);

/** QQ 二维码有效期：实测上游 179.8 秒，早 5 秒收手（与网易同一档，同一个理由）。 */
export const QQ_QR_TTL_MS = 175_000;
/** 一次登录调用的出网预算：登录是短请求，沿用 guardedFetch 那一档 5 秒。 */
const QQ_CALL_TIMEOUT_MS = 5000;
/** 包认识的档位（`services/auth/qrLogin.js:413` 的 MUSIC_FILE_TYPES 键）。
 *  写死这三档是因为包对**不认识的值会静默降到 128**：给它一个拼错的质量等于悄悄换了一种音质。 */
const QQ_PLAY_QUALITIES = Object.freeze(['320', '128', 'm4a']);

/** 包的两个合法子路径。要加第三个先改这段常量，别在调用点写字面量。 */
const SERVERLESS_SPEC = '@yakult-green-tea/qq-music-api/serverless';
const MQTT_SPEC = '@yakult-green-tea/qq-music-api/mqtt';
const packageCache = new Map();
/** 懒加载：父进程的离线自检 import 本文件时不该把包拖进进程（也让注入口能整个换掉它）。 */
const loadPackage = (spec) => {
  if (!packageCache.has(spec)) packageCache.set(spec, require(spec));
  return packageCache.get(spec);
};

/**
 * 把 guardedFetch 的结果装成包那份 http 客户端要的 `Response`。
 * `set-cookie` 必须**逐条 append**：undici 的 Headers 只有这样才能被 `getSetCookie()` 读回多条，
 * 合成一条字符串就把多个 cookie 粘成一条坏的。
 */
export async function toWebResponse(result) {
  const headers = new Headers();
  const text = result.text ? await result.text() : '';
  headers.set('content-type', 'application/json; charset=utf-8');
  for (const raw of result.setCookie ?? []) headers.append('set-cookie', raw);
  const status = Number(result.status) || 0;
  // `Response` 构造函数拒绝给 204/205/304 配 body（真会抛 TypeError，而且是包那边看到"响应坏了"）
  // ⇒ 这几个状态只能给 null body。上游 204 是真实可能（HEAD/无内容），不能让它变成适配器的崩溃点。
  const bodyAllowed = status !== 204 && status !== 205 && status !== 304;
  return new Response(bodyAllowed ? text : null, { status: status || 200, headers });
}

/**
 * 有几笔"换档中"的调用在飞（并发与嵌套都算），以及**最外层那一笔进来时**的全局 fetch。
 * 真发要发给这个基准，最后一笔出去也还原到它——两个数必须成对维护，
 * 单独按"我进来时那一份"快照还原就是那个 P0 的正身（见 `withGuardedEgress` 的 finally）。
 */
let guardedEgressDepth = 0;
let guardedEgressBaseline = null;
/** 给自检看的读数（不是安全边界，只是让"还在飞的时候不许还原"这一格判得出来）。 */
export const guardedEgressState = () => ({ active: guardedEgressDepth, baselined: guardedEgressBaseline !== null });

/**
 * 一次登录调用作用域内的 fetch 替换。
 * **不做全局永久改写**：那会让桥里所有别的 fetch（包括包内部别的通道）都悄悄换一条路走，
 * 出网审计的口径就说不清了。
 *
 * P0（2026-10-10）修的就是这一格的并发部分：从前每层各自记"我进来时那一份"并在自己出去时还原，
 * 两笔重叠时先出去的那层把全局换回真 fetch，后出去的那层又把**自己那份陈旧适配器**写回去
 * ⇒ 全局从此永久挂着守卫。后果实测：桥里每一个用 global fetch 的人都被"仅 https"接管，
 * 连我们自己打 127.0.0.1 的环回一跳都被拒 ⇒ 网易取址与搜索整条全废，
 * 响应里是裸的 `ONLINE_TARGET_REJECTED: ONLINE_TARGET_REJECTED: 在线请求只允许 https，收到 http:`。
 * 顺带修掉同源的第二次前缀：旧写法里内层的"真发上游"是外层的适配器 ⇒ 守卫跑两遍。
 */
export async function withGuardedEgress(run, { kind = 'auth', timeoutMs = QQ_CALL_TIMEOUT_MS, lookup } = {}) {
  if (guardedEgressDepth === 0) guardedEgressBaseline = globalThis.fetch;
  const baseline = guardedEgressBaseline;
  const adapter = async (input, init = {}) => {
    const url = typeof input === 'string' ? input : (input instanceof URL ? input.toString() : input?.url ?? String(input));
    const headers = {};
    const given = init?.headers ?? input?.headers;
    if (given) {
      if (typeof given.forEach === 'function') given.forEach((value, name) => { headers[name] = value });
      else for (const [name, value] of Object.entries(given)) if (value != null) headers[name] = String(value);
    }
    const result = await guardedFetch(url, {
      method: String(init?.method ?? input?.method ?? 'GET').toUpperCase(),
      headers,
      body: init?.body ?? undefined,
      hosts: AUTH_HOSTS,
      kind,
      timeoutMs,
      withSetCookie: true,
      // 自检注入用（与 guardedFetch 的那个注入口同一条规矩）：传 undefined 就走 guardedFetch 的真解析默认值。
      // 有它，这条适配器的自检才真的离线——否则本机开着 fake-IP 代理时域名解析到保留段，会被地址判据按设计拦下。
      lookup,
      // 关键的一行：真正把请求发出去的是**最外层进来时那一份**（离线自检里就是测试装的那个假上游，
      // 这条适配器因此仍然可测）。不是"我进来时那一份"——并发时那可能是另一层适配器，守卫会被跑两遍。
      fetcher: baseline,
    });
    return toWebResponse(result);
  };
  guardedEgressDepth += 1;
  globalThis.fetch = adapter;
  // 一律 async：同步抛错会让 `assert.rejects` 收到"意外的同步异常"，更重要的是调用方
  // 拿不到一个可 await 的东西，finally 的还原时机也就说不清了。
  try {
    return await run();
  } finally {
    guardedEgressDepth -= 1;
    // 还有别的守卫在飞就**不动全局**（此刻全局是最后进来那一份，两笔共用同一个基准与同一张主机表 ⇒ 等价）；
    // 最后一笔出去才还原到基准。**这一行就是那个 P0 的正身**：按各自的快照还原时，
    // 后出去的那层会把自己那份陈旧适配器永久写在全局上（后果见上面函数头的注释）。
    if (guardedEgressDepth === 0) {
      globalThis.fetch = baseline;
      guardedEgressBaseline = null;
    }
  }
}

/**
 * MQTT 的 connect：Node 这边用全局 `WebSocket`。三件事必须做对，少一件的表现都是"上游没回话"：
 *   ① **只在 open 之后 resolve**（协议一 resolve 就发 CONNECT）；
 *   ② `binaryType` 要 `arraybuffer`（默认 `blob` ⇒ 解析器拿到 Blob，永远读不出包型）；
 *   ③ `send` 收到的可能是指向更大共享池的视图，要按 `byteOffset/byteLength` **重取一段**
 *      （不是再拿 `byteOffset` 去 `slice` 一次 —— 那会把整帧切成空）。
 * 建立与关闭各记一笔 `auth-mqtt`：记的是"开了一条到某主机的长连"和"它关了"，不带 qrcodeId、不带路径。
 */
export function nodeMqttConnect({ emit = () => {}, WebSocketImpl = globalThis.WebSocket } = {}) {
  return async (url, protocol, handlers) => {
    let host = '';
    try { host = new URL(url).hostname } catch { host = '' }
    const started = Date.now();
    emit({ evt: 'audit', via: 'guard', kind: 'auth-mqtt', host, status: 0, bytes: 0, ms: 0 });
    if (typeof WebSocketImpl !== 'function') throw new Error('这个运行时没有 WebSocket，QQ 的 App 扫码通道不可用');
    const socket = protocol ? new WebSocketImpl(url, protocol) : new WebSocketImpl(url);
    // Node 的全局 WebSocket 默认 `binaryType='blob'`：那样每一帧进来都是 Blob，
    // 包的解析器读不到包型，`ready` 就永远等不到（真机上表现成"MQTT packet timeout"）。
    // MQTT 的帧是二进制，这里必须显式要 arraybuffer。
    if ('binaryType' in socket) socket.binaryType = 'arraybuffer';
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('MQTT 5 秒内没连上')), 5000);
      timer.unref?.();
      socket.addEventListener?.('open', () => { clearTimeout(timer); resolve() }, { once: true });
      socket.addEventListener?.('error', () => { clearTimeout(timer); reject(new Error('MQTT 连接失败')) }, { once: true });
      socket.addEventListener?.('close', () => { clearTimeout(timer); reject(new Error('MQTT 在打开之前就被对端关闭')) }, { once: true });
    });
    // 交出去的一律是 `Uint8Array`：包自己的参考实现（`ws` 那条）递给解析器的就是字节，不是 Blob/ArrayBuffer。
    socket.addEventListener?.('message', (event) => {
      const data = event?.data;
      handlers?.message?.(data instanceof ArrayBuffer ? new Uint8Array(data) : data);
    });
    socket.addEventListener?.('close', () => {
      handlers?.close?.();
      emit({ evt: 'audit', via: 'guard', kind: 'auth-mqtt', host, status: 0, bytes: 0, ms: Date.now() - started });
    });
    socket.addEventListener?.('error', (event) => handlers?.error?.(new Error(event?.message ?? 'MQTT 出错')));
    return {
      // 视图必须按 `byteOffset/byteLength` **重新取一段**，用的是包自己那条参考实现同款的
      // `Buffer.from(pool, offset, length)`。原来写的 `data.slice(byteOffset, byteOffset + byteLength)`
      // 是错的：`Buffer.prototype.slice` 的入参已经是**视图内**下标，再偏一次 `byteOffset` 会把整帧切没
      // ——真机上发出去的就是 0 字节，上游当然什么都不回（表现成 20 秒 packet timeout）。
      send: (data) => socket.send(data instanceof Uint8Array
        ? Buffer.from(data.buffer ?? data, data.byteOffset ?? 0, data.byteLength)
        : data),
      close: () => { try { socket.close() } catch { /* 已经在关 */ } },
    };
  };
}

/**
 * `QqQrRelay` 的桥内实现：包只有拿到 relay 时才 advertise `qq` 频道（实测），
 * 二维码图片也从这里走（`open()` 收到 image，`image()` 供包自己回读）。
 * 按包自己的注释：relay **只见临时登录态**（qrcodeId / 图片 / 事件），凭据交换留在请求侧 ⇒
 * 这一层天然不可能成为凭据的藏身处。
 */
export function createQqRelay({ emit = () => {}, log = () => {}, listenFactory, now = () => Date.now() } = {}) {
  const listen = listenFactory ?? ((connect) => loadPackage(MQTT_SPEC).createMqttListenOver(connect));
  const sessions = new Map();
  const connect = nodeMqttConnect({ emit, WebSocketImpl: globalThis.WebSocket });
  return {
    async open(qrcodeId, image, ttlMs) {
      const session = { image: String(image ?? ''), expiresAt: now() + Number(ttlMs || 0), events: [], handle: null, failed: null };
      sessions.set(qrcodeId, session);
      const listener = listen(connect);
      try {
        const handle = listener(qrcodeId, (event) => { session.events.push(event) }, Number(ttlMs) || QQ_QR_TTL_MS);
        session.handle = handle;
        // 🔴 包的注释：`ready` 是在 SUBACK 才 settle，必须等它——CONNECT 要 clean session，
        // 订阅是单播，没订上之前上游发什么都不会重放。等不到就是"这一档不可用"，不是"没人扫码"。
        await handle.ready;
      } catch (error) {
        session.failed = error?.message ?? String(error);
        log(`QQ 登录的长连接没建立起来：${session.failed}`);
      }
    },
    async image(qrcodeId) { return sessions.get(qrcodeId)?.image ?? '' },
    async poll(qrcodeId) {
      const session = sessions.get(qrcodeId);
      if (!session) return [];
      const events = session.events.splice(0, session.events.length);
      return events;
    },
    async close(qrcodeId) {
      const session = sessions.get(qrcodeId);
      try { await session?.handle?.close?.() } catch { /* 关不掉由桥的看门狗带走 */ }
      sessions.delete(qrcodeId);
    },
    /** 桥内自检用：这一轮有没有真的订上（订不上时 check 会一直 801，那是"通道坏了"不是"没人扫"）。 */
    snapshot: () => [...sessions.entries()].map(([id, session]) => ({
      id: String(id).slice(0, 6), state: session.failed ? 'unavailable' : 'listening', expiresAt: session.expiresAt,
    })),
  };
}

/** QQ 的登录码 → 对外五档。数字与网易同源（800/801/802/803），但**不透传**：见设计稿 §8。 */
export const QQ_LOGIN_CODES = { 800: 'expired', 801: 'waiting', 802: 'scanned', 803: 'confirmed' };

/**
 * 这个运行时的会话是**无状态 sealed token**（`sessionMode: 'sealed'`，包源码里写死）：
 * 确认态那串 cookie 里挑出 `qqmusic_session` 那一项，之后每次鉴权请求把它用 `x-qq-session` 头带回去，
 * 包自己拿 `QQ_SESSION_SECRET` 解开。包**不往磁盘写任何东西**（`configureAuthSessionPersistence`
 * 只在根入口 `app.js` 里调用，而我们永远只 require `/serverless` 与 `/mqtt` 两个子路径）。
 * ⇒ 登录态能跨桥重启存活，靠的是父进程那份密封文件 + 每次呈现，不是包侧的仓库。
 */
export const QQ_AUTH_COOKIE_NAME = 'qqmusic_session';
export const QQ_AUTH_HEADER_NAME = 'x-qq-session';

/** 从上游那串 cookie 里挑出会话 token：只认 `qqmusic_session` 这一项，其余一个字符都不带走。 */
export function qqTokenFromCookieString(value) {
  for (const entry of String(value ?? '').split(';')) {
    const separator = entry.indexOf('=');
    if (separator <= 0) continue;
    if (entry.slice(0, separator).trim() === QQ_AUTH_COOKIE_NAME) return entry.slice(separator + 1).trim();
  }
  return '';
}

export function qqCheckToState(body) {
  const code = Number(body?.code ?? 0);
  const state = QQ_LOGIN_CODES[code];
  if (!state) return { ok: false, state: 'error', reason: `QQ 登录轮询给出没见过的码 ${code || '（无码）'}` };
  if (state === 'confirmed') {
    // 字段名与内部结构是 2026-10-07 真扫码量出来的：body = {code, message:str(30), cookie:str(535)}。
    // 交回父进程的**只有那一段 token**，不是整串 cookie —— 上游这串里还挂着别的字段，
    // 它们不该跟着 IPC 离开桥（包的 sealed 凭证白名单同理：`refresh_key`/`refresh_token` 明确不带）。
    const token = qqTokenFromCookieString(body?.cookie);
    if (!token) return { ok: false, state: 'error', reason: `QQ 说已确认，但那串 cookie 里没有 ${QQ_AUTH_COOKIE_NAME} 这一项（实测形状：{code, message, cookie}）` };
    return { ok: true, state, session: token };
  }
  return { ok: true, state, ...(body?.message ? { upstreamMessage: String(body.message).slice(0, 60) } : {}) };
}

/** sealed key / 图片 / TTL 从响应里取出来；形状不合就报可读原因，不返回半个值。 */
export function qqKeyToSealed(body) {
  const sealed = typeof body?.data?.unikey === 'string' ? body.data.unikey : ''
  if (!sealed) return { ok: false, reason: `QQ 没有返回登录句柄（code=${body?.code}）` }
  return { ok: true, sealedKey: sealed, expiresAt: Date.now() + QQ_QR_TTL_MS }
}
export function qqCreateToQr(body) {
  const image = typeof body?.data?.qrimg === 'string' ? body.data.qrimg : ''
  if (!image.startsWith('data:image/png;base64,')) return { ok: false, reason: `QQ 二维码响应里不是预期的图片数据（code=${body?.code}）` }
  return { ok: true, qr: { image } }
}

/**
 * 按登录权益取这一首的播放地址（R108）。响应形状来自**一手读码**（2026-10-07）：
 * `dist/src/serverless/index.js:393` 的 `/getMusicPlay/:songmid?` 把服务的返回塞进
 * `{ data: { playUrl } }`，而 `services/auth/qrLogin.js:479` 那份 `playUrl` 是
 * `{ [songmid]: { url: '<domain><purl>', error: false | '暂无播放链接' } }`
 * ——`domain` 可能不带 scheme（sip 那一批就是这样），所以下游要过 `upgradeToHttps` 与主机白名单。
 * 两条不猜的地方：① 地址表里认不出我们要的那条、且不止一条 ⇒ 拒（"用第一条"会把别人的歌放给我们听）；
 * ② `url` 为空是"这首没有可播文件"（权益不够是其中一种），不是错误，也不许编一个地址出来。
 */
export function qqPlayToSource(body, songmid = '') {
  const table = body?.data?.playUrl;
  if (!table || typeof table !== 'object') return { ok: false, reason: 'QQ 没有回播放地址表（响应里没有 data.playUrl）' };
  const entries = Object.entries(table);
  if (!entries.length) return { ok: false, reason: 'QQ 回的播放地址表是空的（这首没有可播文件）' };
  const hit = entries.find(([mid]) => mid === songmid)?.[1];
  const entry = hit ?? (entries.length === 1 ? entries[0][1] : null);
  if (!entry || typeof entry !== 'object') return { ok: false, reason: `QQ 回的地址表里认不出这一首（${String(songmid).slice(0, 32)}），而表里不止一条` };
  const url = String(entry.url ?? '').trim();
  if (!url) return { ok: false, reason: `QQ 说这首没有可播文件：${String(entry.error ?? '暂无播放链接').slice(0, 60)}（这个账号可能没有它的播放权益）` };
  return { ok: true, url };
}

/**
 * sealed 解出来的 `profile` 同时含 `musicid` / `str_musicid` 这类**凭据字段**，
 * 而 `profile.info` 那 32 个键里还挂着 `phone` / `email` / `school` / `registerIP` / `city` 这些
 * 个人字段（真机 2026-10-07 量到的形状），所以这一路只挑两个能显示的名字出去，其余一个字段都不透传。
 *
 * **昵称与头像嵌在 `profile.info` 里**（键名 `nick` / `logo`），不在顶层——
 * 顶层那组 `nickname` / `avatarUrl` 是包内另一条路径（`/login/status` 的 Folia 形状）用的，
 * 两个都留着读：只读顶层会拿到 `loggedIn:true` 却一格都不显示（真机第一次问就撞上这个）。
 * `logo` 上游给的是 `http://thirdqq.qlogo.cn/…`，实测同一串换 https 也是 200 同一张图
 * ⇒ 一律升 https 再放行，与音源那条老规矩一致（明文图片会让旁观者看到用户头像）。
 */
export function qqProfileToAccount(profile) {
  const nickname = String(profile?.info?.nick ?? profile?.nick ?? profile?.nickname ?? '').trim().slice(0, 60);
  const rawAvatar = String(profile?.info?.logo ?? profile?.avatarUrl ?? profile?.logo ?? '').trim();
  const avatar = rawAvatar.startsWith('http://') ? `https://${rawAvatar.slice('http://'.length)}` : rawAvatar;
  return {
    ...(nickname ? { nickname } : {}),
    // 头像会被浏览器当 <img> 取：只收 https（升过一遍仍不是 https 的，宁可不显示）。
    ...(avatar.startsWith('https://') ? { avatarUrl: avatar.slice(0, 300) } : {}),
  };
}

/**
 * 桥的 `/bridge/auth` 里 QQ 那一路的动作处理器。
 * `payload.secret` 由父进程带来（父进程是这份密钥的持有者，见 online-session.mjs 的 `secretFor`），
 * 桥只在这一跳用它、不落盘也不回显；relay 则活在桥进程里（open 在取码时、poll 在轮询时）。
 */
export function createQqAuthHandler({ emit = () => {}, log = () => {}, listenFactory, handleRequestImpl, now = () => Date.now() } = {}) {
  const relay = createQqRelay({ emit, log, listenFactory });
  return async (payload = {}) => {
    const action = String(payload?.action ?? '');
    const secret = typeof payload?.secret === 'string' ? payload.secret : '';
    if (!secret) return { ok: false, provider: 'qq', action, reason: '缺少会话密钥：QQ 登录路由会直接回 501，先让父进程把密钥准备好' };
    try {
      if (action === 'channels') {
        const asked = await qqLoginRequest('/login/channels', { secret, relay: null, handleRequestImpl });
        if (!asked.ok) return { ok: false, provider: 'qq', action, reason: asked.reason, retryable: true };
        return { ok: true, provider: 'qq', action, channels: asked.body?.data?.channels ?? [], sessionMode: String(asked.body?.data?.sessionMode ?? ''), configured: asked.body?.data?.configured === true };
      }
      if (action === 'start') {
        const keyed = await qqLoginRequest('/login/qr/key?channel=qq', { secret, relay, handleRequestImpl });
        if (!keyed.ok) return { ok: false, provider: 'qq', action, reason: keyed.reason, retryable: true };
        const sealed = qqKeyToSealed(keyed.body);
        if (!sealed.ok) return { ok: false, provider: 'qq', action, reason: sealed.reason };
        const created = await qqLoginRequest(`/login/qr/create?key=${encodeURIComponent(sealed.sealedKey)}`, { secret, relay, handleRequestImpl });
        if (!created.ok) return { ok: false, provider: 'qq', action, reason: created.reason, retryable: true };
        const qr = qqCreateToQr(created.body);
        if (!qr.ok) return { ok: false, provider: 'qq', action, reason: qr.reason };
        return { ok: true, provider: 'qq', action, loginId: sealed.sealedKey, qr: qr.qr, expiresAt: sealed.expiresAt };
      }
      if (action === 'account') {
        // 无状态 sealed：会话由父进程每次带进来，桥不保管、也不写任何文件。
        const token = typeof payload.token === 'string' ? payload.token.trim() : '';
        if (!token) return { ok: true, provider: 'qq', action, loggedIn: false, reason: '本机没有 QQ 会话：不带 token 就不问上游' };
        const asked = await qqLoginRequest('/user/detail', { secret, relay: null, token, handleRequestImpl });
        if (!asked.ok) return { ok: false, provider: 'qq', action, reason: asked.reason, retryable: true };
        // 401 / 没有 profile = 这段 token 已经不认了（过期或被撤销），实话实说"没登录"。
        if (asked.status === 401 || !asked.body?.profile) return { ok: true, provider: 'qq', action, loggedIn: false };
        return { ok: true, provider: 'qq', action, loggedIn: true, ...qqProfileToAccount(asked.body.profile) };
      }
      if (action === 'play') {
        // R108：带着登录态取这一首的播放地址。为什么挂在"登录"这一路上：它要的三样
        // （包的 handleRequest、守卫出网、密封密钥）只在这里齐备，而它的性质就是**凭据的一次借用**。
        // 为什么不在桥里做质量降级序列：父进程那侧已经有匿名那一条完整序列（online-audio-source.mjs），
        // 这一档只试一次、不成而降回老路 ⇒ 最坏情况多出一次往返，不会变成两条都在试的乘法。
        const songmid = typeof payload.songmid === 'string' ? payload.songmid.trim() : '';
        if (!/^[A-Za-z0-9]{1,64}$/.test(songmid)) return { ok: false, provider: 'qq', action, reason: 'QQ 曲目标识形状不对（songmid 只收字母数字）', retryable: false };
        const token = typeof payload.token === 'string' ? payload.token.trim() : '';
        // 与 account 那一档相反：这里**不许**"没 token 就匿名问一次"——调用方以为拿到的是登录权益，
        // 悄悄给一段匿名地址是把它不知道的事替它决定了。没会话就在门口拒，让父进程走它自己的匿名老路。
        if (!token) return { ok: false, provider: 'qq', action, reason: '本机没有 QQ 会话：不带着登录态取流，取到的还是匿名那一档', retryable: false };
        const requested = payload.quality === undefined || payload.quality === null || payload.quality === '' ? '320' : String(payload.quality);
        // 认不出的档位**拒**，不悄悄降：包对未知值会静默按 128 处理（`MUSIC_FILE_TYPES[qualityKey] ?? …[128]`），
        // 那等于调用方要 320、我们暗中给它换了个音质。缺省才是 320（父进程现在只送这一档）。
        if (!QQ_PLAY_QUALITIES.includes(requested)) return { ok: false, provider: 'qq', action, reason: `QQ 不认这个音质档位：${requested.slice(0, 8)}`, retryable: false };
        const mediaMid = typeof payload.mediaMid === 'string' ? payload.mediaMid.trim().slice(0, 64) : '';
        const query = new URLSearchParams({ quality: requested });
        if (mediaMid) query.set('mediaId', mediaMid);
        const asked = await qqLoginRequest(`/getMusicPlay/${encodeURIComponent(songmid)}?${query.toString()}`, { secret, relay: null, token, handleRequestImpl });
        if (!asked.ok) return { ok: false, provider: 'qq', action, reason: asked.reason, retryable: true };
        if (asked.status === 401) return { ok: false, provider: 'qq', action, reason: 'QQ 不认这段会话（401）：要重新扫码', reauth: true };
        return { ...qqPlayToSource(asked.body, songmid), provider: 'qq', action };
      }
      if (action === 'logout') {
        // 2026-10-07 读码纠正：R105 那句"QQ 的包没有登出端点"**是错的**——`/logout` 就在
        // serverless 路由表里（index.js:310），只是它在 sealed 模式下**删不掉已经签发的 token**：
        // `revoke()` 是文档化的 no-op，它做的是丢弃桥侧在扫的那一轮 + 给同源调用方回一条过期 cookie。
        // 真正让这次登录结束的是父进程删本机那一份（见 online-auth.mjs），这一跳是"告知"，不是"撤销"。
        const token = typeof payload.token === 'string' ? payload.token.trim() : '';
        if (!token) return { ok: true, provider: 'qq', action, signedOut: true, reason: '本机没有 QQ 会话可登出：没有 token 就不打上游' };
        const asked = await qqLoginRequest('/logout', { secret, relay: null, token, handleRequestImpl });
        if (!asked.ok) return { ok: false, provider: 'qq', action, reason: asked.reason, retryable: true };
        return { ok: true, provider: 'qq', action, signedOut: true, upstreamStatus: asked.status };
      }
      const sealedKey = typeof payload.loginId === 'string' ? payload.loginId : '';
      if (!sealedKey) return { ok: false, provider: 'qq', action, reason: '缺少登录句柄：先调 start' };
      if (action === 'cancel') {
        await relay.close(sealedKey).catch(() => {});
        const asked = await qqLoginRequest(`/login/qr/cancel?key=${encodeURIComponent(sealedKey)}`, { secret, relay, handleRequestImpl });
        return { ok: asked.ok, provider: 'qq', action, ...(asked.ok ? {} : { reason: asked.reason }) };
      }
      if (action !== 'poll') return { ok: false, provider: 'qq', action, reason: `QQ 这一路不支持的动作：${action || '（空）'}` };
      const checked = await qqLoginRequest(`/login/qr/check?key=${encodeURIComponent(sealedKey)}`, { secret, relay, handleRequestImpl });
      if (!checked.ok) return { ok: false, provider: 'qq', action, reason: checked.reason, retryable: true };
      const state = qqCheckToState(checked.body);
      if (state.state === 'confirmed' || state.state === 'expired') await relay.close(sealedKey).catch(() => {});
      return { ...state, provider: 'qq', action };
    } catch (error) {
      return { ...qqUnavailable(error), provider: 'qq', action };
    }
  };
}

/**
 * ④ 不可用态：把包的错误形状翻成"哪一段坏了 + 能不能等一等"。
 * 502 + 固定 retryAfter 这一档**先怀疑自己没装配**（Task 0 的教训：默认 http 是抛错桩 +
 * failBootstrap 吞装配错误，症状长得像平台拒绝）。这条注释就是下一个人的起点。
 */
export function qqUnavailable(error) {
  const status = Number(error?.httpStatus ?? error?.status ?? 0) || 0;
  const message = String(error?.message ?? error ?? '').slice(0, 160);
  if (status === 501) return { ok: false, retryable: false, reason: 'QQ 登录没配好会话密钥（包在这一档直接回 501）' };
  if (status === 502) return { ok: false, retryable: true, reason: `QQ 登录通道没起来（上游 502）：${message}——502 加固定 retryAfter 多半是装配问题，不是平台拒绝` };
  if (/ONLINE_TARGET_REJECTED|白名单/.test(message)) return { ok: false, retryable: true, reason: `QQ 登录要打的端点不在出网白名单里：${message}` };
  return { ok: false, retryable: true, reason: `QQ 登录通道不可用：${message || '未知原因'}` };
}

/** 包读的那个密封密钥的环境变量名（它是**密钥**不是凭据，见设计稿 §5.2；名字仍按拼名写，与 env 读取那一处同一纪律）。 */
export const QQ_SECRET_ENV_KEY = 'QQ_SESSION' + '_SECRET';

/** 一次 QQ 登录调用：只在 handleRequest 的作用域内换 fetch，回来就还原。 */
export async function qqLoginRequest(path, { secret, relay, token, handleRequestImpl } = {}) {
  const handle = handleRequestImpl ?? loadPackage(SERVERLESS_SPEC).handleRequest;
  const env = secret ? { [QQ_SECRET_ENV_KEY]: secret } : {};
  // 会话只走请求头（`x-qq-session` 是这个运行时里优先级最高的那一条），
  // 绝不进查询串：URL 会进包自己的访问日志行，也与网易登录那一路同一处置。
  const headers = token ? { [QQ_AUTH_HEADER_NAME]: token } : undefined;
  const response = await withGuardedEgress(() => handle(
    new Request(`https://online-local${path}`, headers ? { headers } : {}),
    env,
    relay ? { qqRelay: relay } : {},
  ));
  const text = await response.text();
  try {
    return { ok: true, status: response.status, body: JSON.parse(text) };
  } catch {
    return { ok: false, status: response.status, reason: `QQ 登录响应不是 JSON（HTTP ${response.status}）` };
  }
}
