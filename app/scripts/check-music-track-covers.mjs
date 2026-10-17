// 看板 ⑨ 追加：在线曲目封面的自检（服务端注册表 + 那条同源路由）。
// 钉住的四件事，按"一旦回退就最没声音"排序：
//   ① **第三方封面地址到不了浏览器**（出给前端的只有 /api/online/artwork/<token>）——与音源同一条红线；
//   ② **写盘只有曲库那一个出处**（dataDir/artwork，内容寻址），本模块零写盘；
//   ③ 认魔数不认上游 content-type（实测网易给 image/jpg 这种非标准值），非图不落盘也不记成功；
//   ④ 「在线封面」那张子开关一关：签发 0 个 token、路由 404、一次上游请求都不发。
// 全部离线跑（fetcher 注入），真机那一半在 run log 的取证表里。
import test from 'node:test';
import { listenAndReady } from './check-ready.mjs';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import { promises as fs } from 'node:fs';
import { createOnlineTrackCoverStore, TRACK_COVER_REGISTRY_MAX, TRACK_COVER_TOKEN_PATTERN, TRACK_COVER_HEADROOM } from './online-track-covers.mjs';
// R172：上限的判据要判关系，所以这三个数各自从自己的模块读，断言里不出现字面量。
import { MAX_PLAYLIST_LINES } from './playlists.mjs';
import { MAX_FAVORITES } from './favorites.mjs';
import { PLAYLIST_MAX_TRACKS } from './bridge/playlist-routes.mjs';
import { TRACK_COVER_HOSTS, hostAllowed } from './online-guard.mjs';
import { MusicLibraryStore, hash } from './music-library.mjs';
import { createMusicServer } from './music-server.mjs';
import { resetAudit } from './online-audit.mjs';

const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(64, 11)]);
const HTML = Buffer.from('<!doctype html><html>404 not an image</html>');

async function tempDir(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'rhine-trackcovers-'));
  t.after(() => fs.rm(dir, { force: true, recursive: true }));
  return dir;
}

/** 只数"真的出了几次网"的假出网器。 */
function fakeFetcher(response) {
  const calls = [];
  const fn = async (url) => { calls.push(String(url)); return response; };
  fn.calls = calls;
  return fn;
}
const okBytes = (bytes) => ({ ok: true, status: 200, bytes: () => bytes });

// ── 一、主机表 ───────────────────────────────────────────────────────────────

test('在线曲目封面的主机表：五个名字全部来自 2026-12-07 实测，且不留后缀', () => {
  assert.deepEqual([...TRACK_COVER_HOSTS.exact].sort(),
    ['p1.music.126.net', 'p2.music.126.net', 'p3.music.126.net', 'p4.music.126.net', 'y.gtimg.cn'],
    '这张表里每个名字都要有实测出处（网易 p1-p4 同一张图 200、p5/p6 404；QQ 只有 y.gtimg.cn 那条形状给图）');
  assert.deepEqual([...TRACK_COVER_HOSTS.suffix], [], '不用后缀：.music.126.net 会把音源那一路的 m<数字> 也放进来');
  assert.equal(hostAllowed('m802.music.126.net', TRACK_COVER_HOSTS), false, '音源主机对封面这一路不可达');
  assert.equal(hostAllowed('music.126.net', TRACK_COVER_HOSTS), false, '裸后缀域不算命中');
});

// ── 二、注册表与取图 ─────────────────────────────────────────────────────────

test('register 只发同源 token；上游地址反推不出来，也绝不出现在返回值里', () => {
  const store = createOnlineTrackCoverStore({ fetcher: fakeFetcher(okBytes(JPEG)), write: async () => ({ path: '/tmp/x.jpg', mime: 'image/jpeg' }) });
  const url = store.register('https://p4.music.126.net/hash/123.jpg');
  assert.match(url, /^\/api\/online\/artwork\/[a-f0-9]{16}$/, '给浏览器的只有这一条同源地址');
  assert.doesNotMatch(url, /126\.net|hash/, '上游地址（连片段都不许）不出服务端');
  assert.equal(store.register('http://p4.music.126.net/a.jpg'), '', '非 https 不签发（上游给 http 由 normalize 那一步升 https）');
  assert.equal(store.register(''), '');
  assert.equal(store.register(undefined), '');
  // 同一个地址两次登记 ⇒ 同一个 token（幂等，不重复占注册表位）
  assert.equal(store.register('https://p4.music.126.net/hash/123.jpg'), url);
});

test('load：认魔数不认 content-type；非图不落盘也不记成功；失败返回 null 不抛', async () => {
  let writes = 0;
  const seenMimes = [];
  const write = async (bytes, mime) => { writes += 1; seenMimes.push(mime); return { path: `/tmp/artwork/x.${mime === 'image/jpeg' ? 'jpg' : 'bin'}`, mime }; };
  const good = fakeFetcher(okBytes(JPEG));
  const store = createOnlineTrackCoverStore({ fetcher: good, write });
  const token = store.register('https://y.gtimg.cn/music/photo_new/T002R300x300M000abc.jpg').slice('/api/online/artwork/'.length);
  assert.deepEqual(await store.load(token), { path: '/tmp/artwork/x.jpg', mime: 'image/jpeg' });
  assert.deepEqual(seenMimes, ['image/jpeg'], '交给写盘的 mime 必须是**魔数认出来的**那个，不是上游 content-type');
  assert.equal(writes, 1);
  await store.load(token);
  assert.equal(good.calls.length, 1, '第二次必须命中备忘录，不再出网');
  assert.equal(writes, 1, '同一张图不重复写');

  let htmlWrites = 0;
  const html = fakeFetcher(okBytes(HTML));
  const htmlStore = createOnlineTrackCoverStore({
    fetcher: html,
    // 这里不能"抛错"来表示不该写盘——load() 的 catch 会把它吞成"没有封面"，判据就空跑了（第一版就是这样，
    // 把魔数判据拆掉也不红）。改成计数：不写就是 0 次，写了就露出来。
    write: async () => { htmlWrites += 1; return { path: '/tmp/artwork/bad.bin', mime: 'application/octet-stream' }; },
  });
  const htmlToken = htmlStore.register('https://p1.music.126.net/a.jpg').slice('/api/online/artwork/'.length);
  assert.equal(await htmlStore.load(htmlToken), null, '200 但内容是 HTML 错误页 ⇒ 不算封面（也不许写盘）');
  assert.equal(htmlWrites, 0, '非图一次都不许写盘');
  assert.equal(html.calls.length, 1);

  const thrown = createOnlineTrackCoverStore({ fetcher: async () => { throw new Error('ONLINE_TARGET_REJECTED: 主机不在本次用途的在线白名单'); }, write });
  const thrownToken = thrown.register('https://p2.music.126.net/a.jpg').slice('/api/online/artwork/'.length);
  assert.equal(await thrown.load(thrownToken), null, '取图失败要变成"没有封面"，不能把整次搜索或播放带走');

  const missing = createOnlineTrackCoverStore({ fetcher: fakeFetcher({ ok: false, status: 404 }), write });
  assert.equal(await missing.load('deadbeefdeadbeef'), null, '没登记过的 token 一次网都不出');
});

test('子开关关掉：一个 token 都不签发，旧 token 也不再出网', async () => {
  let enabled = false;
  const fetcher = fakeFetcher(okBytes(JPEG));
  const store = createOnlineTrackCoverStore({ fetcher, write: async () => ({ path: '/tmp/x', mime: 'image/jpeg' }), enabled: () => enabled });
  assert.equal(store.register('https://p3.music.126.net/a.jpg'), '', '开关关着：一个 token 都不签发');
  enabled = true;
  const url = store.register('https://p3.music.126.net/a.jpg');
  assert.ok(url, '开着的时候正常签发');
  enabled = false;
  assert.equal(await store.load(url.slice('/api/online/artwork/'.length)), null);
  assert.equal(fetcher.calls.length, 0, '关掉之后旧 token 也不许再打上游');
});

test('注册表有界：超过上限按插入顺序淘汰最老的，不做无界增长', () => {
  const store = createOnlineCoverStoreBounded();
  const first = store.register('https://p1.music.126.net/first.jpg');
  for (let i = 0; i < TRACK_COVER_REGISTRY_MAX; i += 1) store.register(`https://p1.music.126.net/x${i}.jpg`);
  assert.equal(store.size() <= TRACK_COVER_REGISTRY_MAX, true, `注册表涨到 ${store.size()} 没收口`);
  assert.equal(store.coverRefFor(first.slice('/api/online/artwork/'.length)), null, '最老那条应被淘汰');
});
function createOnlineCoverStoreBounded() {
  return createOnlineTrackCoverStore({ fetcher: fakeFetcher(okBytes(JPEG)), write: async () => ({ path: '/tmp/x', mime: 'image/jpeg' }) });
}

// ── 二B、R172：上限要按"一屏的规模"判，不按某个字面数判 ──────────────────────
// 病根（验收侧一手量死，本条不重新归因）：600 那颗是为搜索结果设计的，而歌单详情一次请求就登记 943 张
// ⇒ 按插入序淘汰掉最早那 ~300 张 ⇒ 服务端明明算出了地址、浏览器取图 404、界面画占位。
const tokenOf = (url) => url.slice('/api/online/artwork/'.length);

test('R172：上限判关系——必须装得下"一张整单 + 整份收藏"，且两处的第一条都不许被挤掉', () => {
  // ① 关系：三个数各自从自己模块读（数字会漂，关系不会——改收藏上限的人不必知道这里，但这里必须跟着走）
  assert.ok(TRACK_COVER_REGISTRY_MAX > MAX_PLAYLIST_LINES + MAX_FAVORITES,
    `上限 ${TRACK_COVER_REGISTRY_MAX} 装不下一张整单（≤${MAX_PLAYLIST_LINES} 行）加整份收藏（≤${MAX_FAVORITES} 条）`);
  assert.ok(TRACK_COVER_HEADROOM > 0, '余量必须是个正数，不然上一条关系就是硬凑的');
  // ② 行为级（这条才是真判据）：一次登记满一张整单 ⇒ 第一条仍在
  const one = createOnlineCoverStoreBounded();
  const firstOne = one.register('https://p1.music.126.net/first.jpg');
  for (let i = 0; i < PLAYLIST_MAX_TRACKS; i += 1) one.register(`https://p1.music.126.net/imported${i}.jpg`);
  assert.ok(one.coverRefFor(tokenOf(firstOne)), '登记满一张整单后，第一条的 token 仍能解析（R172 的表现就是这一格）');
  // ③ 更狠的一格：先把收藏铺满，再开一张整单 ⇒ 两处的第一条都要还在
  //    （注册表是全局共享的，"我这一屏装得下"不等于"上一屏还留着"）
  const two = createOnlineCoverStoreBounded();
  const favFirst = two.register('https://p1.music.126.net/fav-first.jpg');
  for (let i = 0; i < MAX_FAVORITES; i += 1) two.register(`https://p1.music.126.net/fav${i}.jpg`);
  const listFirst = two.register('https://p1.music.126.net/list-first.jpg');
  for (let i = 0; i < MAX_PLAYLIST_LINES; i += 1) two.register(`https://p1.music.126.net/row${i}.jpg`);
  assert.ok(two.coverRefFor(tokenOf(favFirst)), '收藏那一条链的第一张不许被整单挤掉');
  assert.ok(two.coverRefFor(tokenOf(listFirst)), '整单的第一张不许被行内后续挤掉');
  assert.ok(two.size() <= TRACK_COVER_REGISTRY_MAX, `注册表涨到 ${two.size()} 没收口（有界这条不许退）`);
});

test('R172：子开关关着时，铺满一整屏也一个 token 都不签发（既有那条一字未动，这里只补规模这一格）', () => {
  const fetcher = fakeFetcher(okBytes(JPEG));
  const store = createOnlineTrackCoverStore({ fetcher, write: async () => ({ path: '/tmp/x', mime: 'image/jpeg' }), enabled: () => false });
  for (let i = 0; i < MAX_PLAYLIST_LINES; i += 1) {
    assert.equal(store.register(`https://p1.music.126.net/off${i}.jpg`), '', '开关关着：每张都必须回空串');
  }
  assert.equal(store.size(), 0, '关掉时注册表一格都不许占（否则上限这条会变成"关着也在长"）');
  assert.equal(fetcher.calls.length, 0, '关掉时一次上游都不许发');
});

// ── 三、路由与曲库这一侧 ─────────────────────────────────────────────────────

async function trackCoverFixture(t, { fetcher, coversEnabled = true } = {}) {
  delete process.env.MUSICBRAINZ_CONTACT;
  const temporary = await tempDir(t);
  const root = path.join(temporary, 'music');
  await fs.mkdir(root);
  const audio = path.join(root, 'a.flac');
  await fs.writeFile(audio, Buffer.from('音频字节不许被动到'));
  const store = await new MusicLibraryStore({ dataDir: path.join(temporary, 'index'), defaultRoots: [root] }).init();
  await store.updateConfig({ online: { lyrics: true, search: true, streaming: true, covers: coversEnabled } });
  const write = (bytes, mime) => store.cacheArtworkBytes(bytes, mime);
  const covers = createOnlineTrackCoverStore({ fetcher, write, enabled: () => store.config.online?.covers === true });
  const temporary2 = path.join(temporary, 'dist');
  await fs.mkdir(temporary2);
  await fs.writeFile(path.join(temporary2, 'index.html'), '<h1>fixture</h1>');
  const { server } = await createMusicServer({ store, distDir: temporary2, autoScan: false, trackCoverProvider: covers });
  t.after(() => { server.closeAllConnections(); return new Promise((resolve) => server.close(resolve)); });
  // R190：`listen` 之后直接 fetch 在 Windows 回环端口回收时会偶发 `fetch failed`（整跑里真出现过）
  // ⇒ 起服务之后先探一次连接，只重试"连不上"、断言照常红。见 check-ready.mjs 头注。
  // R211（B 类）：换成 listenAndReady（连不上就把这台关掉、换个端口重听）；关闭钩子本来就排在探测之前。
  const { origin } = await listenAndReady(server);
  return { temporary, audio, store, covers, origin };
}

test('GET /api/online/artwork/<token>：走上游、内容寻址落 dataDir/artwork、音频文件一个字节没动', async (t) => {
  const before = Buffer.from('音频字节不许被动到');
  const fetcher = fakeFetcher(okBytes(JPEG));
  const { temporary, audio, store, covers, origin } = await trackCoverFixture(t, { fetcher });
  const url = covers.register('https://p4.music.126.net/hash/123.jpg');
  const token = url.slice('/api/online/artwork/'.length);
  assert.equal(TRACK_COVER_TOKEN_PATTERN.test(token), true);
  const response = await fetch(origin + url);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('content-type'), 'image/jpeg', '响应类型由我们认出来的魔数决定，不采信上游');
  const served = Buffer.from(await response.arrayBuffer());
  assert.deepEqual(served, JPEG);
  assert.equal(fetcher.calls[0], 'https://p4.music.126.net/hash/123.jpg', '出网打的就是登记过那条地址');
  const cached = await fs.readdir(path.join(store.dataDir, 'artwork'));
  assert.equal(cached.length, 1, '只落一个文件');
  assert.deepEqual(cached, [`${hash(JPEG)}${'.jpg'}`], '文件名就是内容哈希（与专辑封面共用同一份缓存、同一套命名与同一个写入口）');
  assert.deepEqual(Buffer.from(await fs.readFile(path.join(store.dataDir, 'artwork', cached[0]))), JPEG);
  assert.deepEqual(Buffer.from(await fs.readFile(audio)), before, '红线：音频文件逐字节不变');
  assert.deepEqual(await fs.readdir(path.join(temporary, 'music')), ['a.flac'], '音乐目录里不许多出任何文件');
  // 第二次请求不再出网（备忘录命中），也不再写盘。
  await fetch(origin + url);
  assert.equal(fetcher.calls.length, 1, '同一张封面第二次拿不该再打上游');
  assert.equal((await fs.readdir(path.join(store.dataDir, 'artwork'))).length, 1, '命中备忘录不重复写');
  resetAudit();
});

test('路由的拒路：开关关 404 且说清是谁关的；野 token 与没登记过的都拒——三条都不出网', async (t) => {
  const fetcher = fakeFetcher(okBytes(JPEG));
  const { covers, origin } = await trackCoverFixture(t, { fetcher, coversEnabled: false });
  assert.equal(covers.register('https://p4.music.126.net/a.jpg'), '', '开关关着连 token 都不该签发');
  const response = await fetch(`${origin}/api/online/artwork/0123456789abcdef`);
  assert.equal(response.status, 404);
  assert.match((await response.json()).error, /在线封面已关闭/, '404 要说清是谁关的、去哪儿开回来');
  assert.equal(fetcher.calls.length, 0);
  resetAudit();
});

test('开着开关时：没登记过的 token 与野形状的 token 都拒，且一次网都不出', async (t) => {
  const fetcher = fakeFetcher(okBytes(JPEG));
  const { origin } = await trackCoverFixture(t, { fetcher });
  for (const bad of ['deadbeefdeadbeef', 'ZZZZ', 'a'.repeat(64), '..%2f..%2fetc%2fpasswd']) {
    const response = await fetch(`${origin}/api/online/artwork/${bad}`);
    assert.ok([400, 404].includes(response.status), `野 token 必须被拒：${bad} 实测 ${response.status}`);
    await response.text();
  }
  assert.equal(fetcher.calls.length, 0, '三条拒路都不许产生一次上游请求');
  resetAudit();
});
