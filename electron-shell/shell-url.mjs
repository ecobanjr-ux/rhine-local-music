// R204（Electron 壳最小件）· 本机地址的判定 —— 这个出处只有一个。
//
// 壳只允许加载"我们自己那个本机服务"，别的地址一律不算。R203 给 surface 立过同一条规矩
// （判定住在一个模块里，别处只读答案），这一件照办：`127.0.0.1` 这个字面量在整个壳里只许出现在本文件。
//
// 一手事实（Task 0 实测，写下来免得下一个人以为判定写松了）：
//   WHATWG 的 URL 解析会把 `http://127.1:5175/`、`http://0x7f000001:5175/` 归一成 hostname=127.0.0.1，
//   而 `http://127.0.0.1.evil.example:5175/` 的 hostname 就是那个带后缀的串（不归一）。
//   ⇒ 判定按**解析后的组分**（协议 / hostname / 端口）：前者落的还是本机那一个服务，不是出网；
//     后者、`localhost`、`[::1]`（服务只 listen 127.0.0.1）、`https:`、缺端口、协议相对地址一律拒。
//   `//127.0.0.1:5175/` 这种协议相对写法 `new URL()` 直接抛 ERR_INVALID_URL ⇒ 也落进"解析不了就拒"。

const LOOPBACK_HOST = '127.0.0.1';

/** 端口合法才拼得出地址：非法端口必须抛，不许拼出 `http://127.0.0.1:undefined/` 这种"看着像地址"的串。 */
export function shellOrigin(port) {
  const value = typeof port === 'string' ? Number(port) : port;
  if (!Number.isSafeInteger(value) || value <= 0 || value > 65535) {
    throw new TypeError(`端口非法（${String(port)}）：壳只会加载本机那一个服务，端口必须是 1–65535 的整数`);
  }
  return `http://${LOOPBACK_HOST}:${value}/`;
}

/** 这条地址是不是"壳自己那台本机服务"。判定失败一律 false —— 宁可不加载，也不猜。 */
export function isAllowedShellUrl(input, port) {
  let url;
  try {
    url = new URL(String(input));
  } catch {
    return false;
  }
  if (url.protocol !== 'http:') return false;
  if (url.hostname !== LOOPBACK_HOST) return false;
  const expected = typeof port === 'string' ? Number(port) : port;
  if (!Number.isSafeInteger(expected) || expected <= 0 || expected > 65535) return false;
  // 缺端口（`http://127.0.0.1/`）的 url.port 是空串 ⇒ 落到"不是我们的端口"那一格。
  return url.port === String(expected);
}
