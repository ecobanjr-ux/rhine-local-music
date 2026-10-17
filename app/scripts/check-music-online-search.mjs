// 第五期 Task 7 自检：在线搜索的窄契约、单源失败隔离、分页语义与前端接线。
//
// 离线纪律：不 require 任何第三方包、不出网。网易经注入的假桥、QQ 经注入的假 fetcher；
// 真机那一半（真出网 + 点一条能出声）在取证脚本与浏览器里补。
// 这里钉得最紧的一件事是**字段集合**：第三方响应有几十个字段的边角，
// 一个都不该到前端（R78），所以每条结果都逐字比 keys，而不是"该有的有"就放过。
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { listenAndReady } from './check-ready.mjs';

const SCRIPTS = dirname(fileURLToPath(import.meta.url));
const read = (relative) => readFile(new URL(`../${relative}`, import.meta.url), 'utf8');
const readScript = (name) => readFile(join(SCRIPTS, name), 'utf8');

const search = await import('./online-search.mjs');
const normalize = await import('./bridge/providers/normalize.mjs');

// ── 夹具：三家接口的真实形状 ───────────────────────────────────────────────────
// 网易这一份照 2026-10-05 桥内实测（`t7-shape.mjs`）：`result.songs[].{id,name,dt,ar[].name,al.name}`，
// `result` 只有 songs / songCount 两个键（**没有 hasmore**）。
// 第一版夹具照 PC 端形状写成 artists[]/album{}/duration，结果离线全绿、真机上 20 条结果歌手全空——
// 夹具照假设写就等于把假设固化成"已验证"。两种形状的兼容性由下面那条"实测形状"用例单独钉住。
const ncmBody = (count = 2, extra = {}) => ({
  result: {
    songCount: 137,
    songs: Array.from({ length: count }, (unused, index) => ({
      id: 1997438791 + index, name: `曲目 ${index}`, dt: 240000 + index,
      // 网易给封面是一条 **http** 的 al.picUrl（2026-10-07 实测）；这里两条里只给一条，
      // 让"有封面"与"没封面"两种形状在同一次响应里都被走到（没封面的那条必须是空串，不是缺键）。
      ar: [{ name: '李荣浩' }, { name: '某人' }], al: { name: '嗯', ...(index === 0 ? { picUrl: 'http://p3.music.126.net/hash/109951173214982533.jpg' } : {}) },
      // 下面这些是上游响应里真实存在的"边角字段"，契约必须把它们挡在桥内。
      paid: 1, fee: 1, pop: 999999, mv: 400000, rtUrls: ['http://example.invalid/k'],
      alia: ['y'], publishTime: 1700000000000, copyright: 0,
    })),
    ...extra,
  },
});

const ncmPcShapeBody = () => ({
  result: { songCount: 1, hasmore: false, songs: [{ id: 7, name: 'PC 形状', duration: 123000, artists: [{ name: '某人' }], album: { name: '某专' } }] },
});

const qqBody = (count = 2) => ({
  request: {
    code: 0,
    data: { body: {
      item_song: Array.from({ length: count }, (unused, index) => ({
        mid: `00245tac3U4Pc${index}`, title: `李白 ${index}`, title_main: `李白 ${index}`,
        interval: 250, singer: [{ name: '李荣浩' }], album: { name: '嗯', ...(index === 0 ? { mid: '000MkMni19ClKG' } : {}) },
        file: { media_mid: `004CN4BA1FB6r${index}`, size_320mp3: 9000000, size_flac: 50000000, try_begin: 1, try_end: 2 },
        pay: { paypay: 1, payalbumprice: 1 }, action: 128, trans: {},
      })),
      showMore: 0, head: '',
    } },
  },
});

const neteaseBridge = (body) => ({ call: async (route, payload) => { neteaseBridge.calls.push([route, payload]); return body } });
neteaseBridge.calls = [];

// 酷狗这一份照 2026-10-10 一手实测（登录态那一跳，`data.lists` + 大写键 + `Duration` 是**秒**）。
// 又是"夹具照假设写"的那一课（R123 的 PNG、R153 的参数名、R119 的 coverRef）：
// 这一份的每一个键名都是从真机响应里抄下来的，不是从另两家的形状推出来的。
const kgBody = (count = 2, extra = {}) => ({
  status: 200,
  body: { errcode: 0, data: {
    pagesize: count, page: 1, total: 137,
    lists: Array.from({ length: count }, (unused, index) => ({
      OriSongName: `酷狗曲目 ${index}`, SingerName: '李荣浩', AlbumName: '黑马',
      FileHash: `8F9478E068736878D6FE520A03C8A34${index}`, Duration: 254 + index, Bitrate: 128,
      FileSize: 4069795, ExtName: 'mp3', PayType: 0, AlbumID: 106374641, Audioid: 363537969,
      // R222：`MixSongID` 就是 `album_audio_id`（一手对表：Breathe 那首的 `MixSongID=89872375`
      // 与网页端点回吐的 `album_audio_id` 逐位相等）⇒ 取址"带专辑"那一档的第二个参数。
      MixSongID: 89872375,
      // 上游真实存在、但不该出桥的边角（含一个身份类字段，白名单挡的就是这类）。
      uid: 123456789, nickname: '某个上传者', AlbumPrivilege: 10, FailProcess: 0,
    })),
    ...extra,
  } },
});

/** 按 route+provider 分叉的假桥：三家各回各的夹具，并记下每一笔被问到的 (route, provider)。 */
const routingBridge = (handlers) => {
  const calls = [];
  return { calls, call: async (route, payload) => { calls.push([route, payload?.provider]); return handlers[payload?.provider]?.(payload) ?? { ok: false, reason: '没有这一家' } } };
};

const coversModule = await import('./online-track-covers.mjs');
/** 一个不会真出网的注册表：只把第三方地址换成同源 token。判的是"发出去的那条地址长什么样"，不是取图本身。 */
const makeCovers = () => coversModule.createOnlineTrackCoverStore({ fetcher: async () => ({ ok: false, status: 0 }), write: async () => null });

const searcher = ({ bridge, fetcher, covers = makeCovers(), kugouSession = null, saveKugouDevice = null } = {}) => search.createOnlineSearcher({
  bridge: bridge ?? neteaseBridge({ ok: true, provider: 'netease', items: normalize.ncmSearchToItems(ncmBody()), total: 137, hasMore: true }),
  fetcher: fetcher ?? (async () => ({ ok: true, status: 200, json: () => qqBody() })),
  covers, kugouSession, saveKugouDevice,
});

// ── ① 窄契约 ─────────────────────────────────────────────────────────────────

test('搜索响应的每一条结果只含契约那 10 个字段，上游的边角字段一个都出不去（R78）', async () => {
  const result = await searcher().search({ query: '李荣浩', offset: 0, limit: 20 });
  assert.equal(result.ok, true);
  // 两源各有一条带封面 ⇒ 两条都该拿到同源地址；没封面的那两条是空串（不是缺键，也不是第三方地址）。
  assert.equal(result.items.filter((item) => item.coverUrl).length, 2,
    `带同源封面的条数不对：${JSON.stringify(result.items.map((item) => item.coverUrl))}`);
  assert.ok(result.items.length >= 3, `两源各 2 条应该有结果，实际 ${result.items.length}`);
  for (const item of result.items) {
    assert.deepEqual(Object.keys(item).sort(), [...normalize.ONLINE_TRACK_FIELDS].sort(), JSON.stringify(item));
    assert.equal(item.sourceKind, 'online');
    assert.match(item.id, /^on-(netease|qq)-/, 'id 必须带 provider 前缀，避免与本地 track-<hash> 撞车');
    assert.match(item.audioUrl, /^\/api\/online\/stream\?p=/, '前端只拿同源代理地址，拿不到第三方 URL');
    assert.doesNotMatch(JSON.stringify(item), /example\.invalid|paid|playCount|mvid|alias|try_begin/, '上游边角字段漏进来了');
    // 封面与音源同一条红线：出给前端的只能是同源地址，第三方 CDN 主机名一个都不许出现在响应里。
    assert.match(item.coverUrl, /^$|^\/api\/online\/artwork\/[a-f0-9]{16}$/, `coverUrl 只能是空或同源 token 地址：${item.coverUrl}`);
    assert.doesNotMatch(JSON.stringify(result.items), /music\.126\.net|y\.gtimg\.cn/, '第三方封面地址漏进了搜索响应');
  }
  const qq = result.items.find((item) => item.provider === 'qq');
  assert.equal(qq.mediaId, '00245tac3U4Pc0');
  assert.match(qq.audioUrl, /&mm=004CN4BA1FB6r0/, 'QQ 的第二段文件名要并进同源地址（取址时要用，但它不是用户输入）');
  assert.equal(qq.durationMs, 250000, 'QQ 的 interval 单位是秒，进契约必须是毫秒');
  assert.equal(result.items.find((item) => item.provider === 'netease').durationMs, 240000, '网易本来就是毫秒');
});

test('id 与 audioUrl 里的参数都经过编码：曲目标识里出现奇怪字符也不会改变路由形状', () => {
  const track = normalize.toOnlineTrack({ provider: 'qq', mediaId: 'a?x=1', mediaMid: 'b&c', title: 't', artist: 'a' });
  assert.ok(track.audioUrl.startsWith('/api/online/stream?p=qq&id=a%3Fx%3D1'), track.audioUrl);
  assert.match(track.audioUrl, /mm=b%26c/);
  assert.equal(new URL(track.audioUrl, 'http://x').searchParams.get('id'), 'a?x=1', '解出来还是原值 ⇒ 只能被我们的路由按形状拒掉，不能变成第二个参数');
});

test('provider 不在集合里 / mediaId 为空 ⇒ 这条结果直接不要，不生成半截曲目', () => {
  assert.equal(normalize.toOnlineTrack({ provider: 'spotify', mediaId: '1', title: 'x' }), null);
  assert.equal(normalize.toOnlineTrack({ provider: 'qq', mediaId: '', title: 'x' }), null);
  assert.equal(normalize.toOnlineTrack({ provider: 'kugou', mediaId: '1', title: 'x' }) !== null, true,
    'kugou 仍是合法的音源 provider（只是今天搜不到它）——契约不该把它当陌生值');
});

test('网易字段名以桥内实测为准（ar/al/dt），PC 端变体也认：真机上第一版把歌手全读成"未知歌手"', () => {
  const measured = normalize.ncmSearchToItems(ncmBody(1));
  assert.equal(measured[0].artist, '李荣浩 / 某人', 'ar[].name 是实测形状');
  assert.equal(measured[0].album, '嗯', 'al.name');
  assert.equal(measured[0].durationMs, 240000, 'dt 是毫秒');
  const pc = normalize.ncmSearchToItems(ncmPcShapeBody());
  assert.equal(pc[0].artist, '某人', 'artists[]/album{}/duration 这个变体也认（两种在现实里都存在）');
  assert.equal(pc[0].durationMs, 123000);
  // 空歌手不该被编成"未知歌手"以外的东西：界面那一侧才不会出现"这首歌没有歌手"的假事实。
  assert.equal(normalize.ncmSearchToItems({ result: { songs: [{ id: 1, name: 'x', dt: 1, ar: [], al: {} }], songCount: 1 } })[0].artist, '');
});

test('契约的把关点在映射器本身：上游对象一旦展开进来，键集合断言必须立刻红', () => {
  // 这条是变异验证逼出来的。原本有个 narrowItem 白名单，但它收的是"我们自己刚构造出来的对象"，
  // 删掉它一条测试都不红 ⇒ 那是个空守卫，已删。真正的把关是映射器**只构造这几个字段**，
  // 所以判据必须能抓住"有人图省事把 song 展开进来"这种改法。
  const leaked = normalize.ncmSearchToItems({ result: { songs: [{ id: 1, name: 'x', duration: 1000, paid: 1, playCount: 9 }], songCount: 1, hasmore: false } });
  assert.deepEqual(Object.keys(leaked[0]).sort(), ['album', 'artist', 'coverRef', 'durationMs', 'mediaId', 'provider', 'quality', 'title']);
  assert.doesNotMatch(JSON.stringify(leaked), /paid|playCount/, '上游字段漏进了出桥的条目');
});

test('封面字段（⑨ 追加）：上游给的地址升 https 并过主机判据，野 URL 与野字符一律变空串', () => {
  // 实测形状（2026-10-07）：网易 al.picUrl 是 **http**://p<1-4>.music.126.net/…；QQ 不给 URL 只给 album.mid。
  const [ncm] = normalize.ncmSearchToItems({ result: { songs: [{ id: 1, name: 'x', dt: 1, ar: [{ name: 'a' }], al: { picUrl: 'http://p4.music.126.net/hash/123.jpg' } }], songCount: 1 } });
  assert.equal(ncm.coverRef, 'https://p4.music.126.net/hash/123.jpg', '升 https 是 R112 那条老规矩（实测 https 同一张图）');
  const [qq] = normalize.qqSearchToItems([{ mid: '001', title: 'x', interval: 1, singer: [{ name: 'a' }], album: { mid: '000MkMni19ClKG' }, file: {} }]);
  assert.equal(qq.coverRef, 'https://y.gtimg.cn/music/photo_new/T002R300x300M000000MkMni19ClKG.jpg', 'QQ 的地址由我们按实测形状拼');
  for (const bad of ['http://evil.example/a.jpg', 'https://m702.music.126.net/a.jpg', 'javascript:alert(1)', '../x.jpg', '', 'https://p4.music.126.net:8443/a.jpg']) {
    assert.equal(normalize.trackCoverRef(bad), '', `这种封面地址必须变空串：${bad}`);
  }
  // 音源那台 m<数字>.music.126.net 不在封面表里：两张表合一张就等于让补图那一路也能打 CDN。
  for (const badMid of ['../evil', 'a/b', 'x?y=1', '', 'A'.repeat(65)]) {
    assert.equal(normalize.qqCoverRef(badMid), '', `album.mid 会拼进 URL，这种值必须拒：${badMid}`);
  }
  // 固定形状：没有封面是空串，不是"这个键不存在"（前端可以无脑读）。
  const [bare] = normalize.qqSearchToItems([{ mid: '002', title: 'y', interval: 1, singer: [], album: {}, file: {} }]);
  assert.equal(bare.coverRef, '');
  assert.equal(normalize.toOnlineTrack({ provider: 'netease', mediaId: '1', title: 't', artist: 'a', durationMs: 1 }).coverUrl, '',
    '发给前端的 coverUrl 是固定字段，且初值只能是空串（第三方地址从不出服务端）');
});

// ── ② 单源失败隔离 ───────────────────────────────────────────────────────────

test('单源失败不拖垮整次搜索：perSource 逐项给原因，其余源照常返回', async () => {
  const result = await searcher({ bridge: { call: async () => { throw new Error('酷狗会话未就绪') } } })
    .search({ query: 'x' });
  assert.equal(result.ok, true, '另一个源有结果就必须给出来');
  const broken = result.perSource.find((entry) => entry.provider === 'netease');
  assert.equal(broken.ok, false);
  assert.match(broken.reason, /酷狗会话未就绪/);
  assert.equal(broken.count, 0, '坏掉的源不能报一个凭空的条数');
  assert.ok(result.items.length > 0, 'QQ 那 2 条要还在');
  assert.deepEqual(result.perSource.map((entry) => entry.provider), ['netease', 'qq', 'kugou'], 'perSource 的次序就是源序');
});

test('两个源都坏了 ⇒ 200 + ok:false + 逐条原因（不是 5xx，也不是"没有结果"）', async () => {
  const result = await searcher({
    bridge: { call: async () => ({ ok: false, reason: '网易后端未就绪' }) },
    fetcher: async () => ({ ok: true, status: 200, json: () => ({ request: { code: 40000 } }) }),
  }).search({ query: 'x' });
  assert.equal(result.ok, false);
  assert.equal(result.invalid, undefined, '这是一次合法的检索，只是没结果');
  assert.deepEqual(result.items, []);
  assert.match(result.error, /网易后端未就绪/);
  assert.equal(result.perSource.find((entry) => entry.provider === 'qq').ok, false);
  assert.match(result.perSource.find((entry) => entry.provider === 'qq').reason, /返回码 40000/);
});

test('响应形状不对与"没有结果"分开说：songs/item_song 缺席是故障，空数组才是没结果', async () => {
  const noSongs = await searcher({ bridge: { call: async () => ({ ok: false, reason: '没有 result.songs 字段' }) } })
    .search({ query: 'x' });
  assert.match(noSongs.perSource.find((entry) => entry.provider === 'netease').reason, /result\.songs/);
  const emptyArray = normalize.ncmSearchToItems({ result: { songs: [], songCount: 0, hasmore: false } });
  assert.deepEqual(emptyArray, [], '空数组要能被识别成"真的没有结果"（返回 []，不是 null）');
  assert.equal(normalize.ncmSearchToItems({}), null, '字段缺失返回 null，由调用方判成故障');
  assert.equal(normalize.qqSearchToItems(undefined), null);
});

// ── ③ 分页与合并 ─────────────────────────────────────────────────────────────

test('分页字段按实测来：网易有接口给的总数与 hasmore，QQ 没有就如实报 null', async () => {
  const result = await searcher().search({ query: '李荣浩', offset: 0, limit: 20 });
  assert.equal(result.total, 137, '总数取网易的 songCount（QQ 不给，不拿条目数编）');
  assert.equal(result.hasMore, true);
  assert.equal(result.nextOffset, 20);
  const qqOnly = await searcher().search({ query: '李荣浩', provider: 'qq' });
  assert.equal(qqOnly.total, null, 'QQ 这一档没有总数字段（实测 keys 里就没有），如实报未知');
  assert.equal(qqOnly.perSource.length, 1);
});

test('同一首歌两个源都有 ⇒ 只留源序靠前的那条，不出现重复行', async () => {
  const same = { ok: true, provider: 'netease', total: 1, hasMore: false, items: [{
    provider: 'netease', mediaId: '9', title: '李白', artist: '李荣浩', album: '嗯', durationMs: 250000, quality: '自动',
  }] };
  // QQ 那一侧给的是**同一首**（同名同歌手同时长）：夹具的标题必须逐字对齐，否则这条测的是"两条不同歌"。
  const qqSame = { request: { code: 0, data: { body: { item_song: [{
    mid: '00245tac3U4PcI', title: '李白', title_main: '李白', interval: 250,
    singer: [{ name: '李荣浩' }], album: { name: '嗯' }, file: { media_mid: '004CN4BA1FB6rC', size_320mp3: 9000000 },
  }] } } } };
  const result = await searcher({
    bridge: { call: async () => same },
    fetcher: async () => ({ ok: true, status: 200, json: () => qqSame }),
  }).search({ query: '李白' });
  assert.equal(result.items.length, 1, `去重后只该有一条，实际 ${result.items.map((i) => `${i.title}/${i.provider}`).join(', ')}`);
  assert.equal(result.items[0].provider, 'netease', '留下的是源序靠前的那条');
  assert.equal(result.perSource.find((entry) => entry.provider === 'qq').count, 1,
    'perSource 报的是该源返回的条数，不是去重后剩下的条数（界面要说"QQ 给了 1 条"）');
});

test('参数把关：空检索词、越界的 offset/limit、陌生 provider 全部在出网之前被拒', async () => {
  let touched = 0;
  const guard = searcher({
    bridge: { call: async () => { touched += 1; return { ok: true, items: [] } } },
    fetcher: async () => { touched += 1; return { ok: true, status: 200, json: () => qqBody(1) } },
  });
  for (const bad of [{ query: '' }, { query: '   ' }, { query: 'x', offset: -1 }, { query: 'x', offset: 99999 },
    { query: 'x', limit: 0 }, { query: 'x', limit: 999 }, { query: 'x', provider: 'spotify' }, { query: 'x', offset: 1.5 }]) {
    const result = await guard.search(bad);
    assert.equal(result.ok, false, JSON.stringify(bad));
    assert.equal(result.invalid, true, `${JSON.stringify(bad)} 必须是"请求不合法"，不是"没结果"`);
  }
  assert.equal(touched, 0, '以上任何一条都不该发过一次上游请求');
  const long = await guard.search({ query: 'x'.repeat(500) });
  assert.equal(long.ok, true, '超长检索词是截断而不是拒绝');
});

// ── ④ 路由与开关 ─────────────────────────────────────────────────────────────

test('路由：POST /api/online/search 出契约、GET 拒绝、关掉之后 404 且一次上游都不碰', async () => {
  const calls = [];
  const fake = { search: async (value) => { calls.push(value); return { ok: true, items: [{ demo: 1 }], perSource: [], total: 0, hasMore: false, nextOffset: 0 } } };
  const opened = await routeServer({ onlineSearcher: fake });
  let response = await fetch(`${opened.origin}/api/online/search`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ query: '李荣浩' }) });
  assert.equal(response.status, 200);
  assert.deepEqual((await response.json()).items, [{ demo: 1 }]);
  assert.deepEqual(calls, [{ query: '李荣浩' }], '请求体原样交给编排层，路由自己不加戏');
  response = await fetch(`${opened.origin}/api/online/search`);
  assert.equal(response.status, 405);
  await response.text();
  await opened.close();

  // 参数把关要拿**真编排层**测：注入假搜索器时它自己不做校验，400 那条就变成空断言。
  // 这里的桥与 fetcher 都设成"一被调用就抛"，所以 400 与"零出网"是同一轮里一起证的。
  const real = await routeServer({
    onlineSearcher: search.createOnlineSearcher({
      bridge: { call: async () => { throw new Error('不该出网') } },
      fetcher: async () => { throw new Error('不该出网') },
    }),
  });
  const bad = await fetch(`${real.origin}/api/online/search`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"query":""}' });
  assert.equal(bad.status, 400, '空检索词 ⇒ 400');
  assert.match((await bad.json()).error, /缺少检索词/);
  const allDown = await fetch(`${real.origin}/api/online/search`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"query":"李荣浩"}' });
  assert.equal(allDown.status, 200, '两源都坏不是 4xx：那是一次合法检索，只是没结果');
  const downBody = await allDown.json();
  assert.equal(downBody.ok, false);
  assert.deepEqual(downBody.items, []);
  await real.close();

  const off = await routeServer({
    config: { online: { lyrics: true, search: false, streaming: true, covers: true } },
    onlineSearcher: { search: async () => { throw new Error('关掉之后不该被调用') } },
  });
  const blocked = await fetch(`${off.origin}/api/online/search`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ query: 'x' }) });
  assert.equal(blocked.status, 404);
  assert.match((await blocked.json()).error, /在线搜索已关闭/);
  await off.close();
});

test('全部源坏了也是 200 + ok:false：界面要能逐源说原因，而不是收到一个 5xx', async () => {
  const route = await routeServer({
    onlineSearcher: { search: async () => ({ ok: false, error: '两个源都没应答', items: [], perSource: [{ provider: 'netease', ok: false, count: 0, reason: '桥未就绪' }] }) },
  });
  const response = await fetch(`${route.origin}/api/online/search`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ query: 'x' }) });
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.ok, false);
  assert.equal(body.perSource[0].reason, '桥未就绪');
  await route.close();
});

// ── ⑤ 桥侧通道与前端接线 ─────────────────────────────────────────────────────

test('桥的搜索路由只服务网易，并把响应收窄后才出桥（QQ 走父进程，酷狗不查）', async () => {
  const { registerSearchRoutes } = await import('./bridge/search-routes.mjs');
  const routes = new Map();
  const backends = { netease: { state: 'ready', baseUrl: 'http://127.0.0.1:1' } };
  registerSearchRoutes({ routes, backends, fetchImpl: async () => ({ text: async () => JSON.stringify(ncmBody(1)), status: 200 }) });
  const result = await routes.get('/bridge/search')({ provider: 'netease', keywords: '李荣浩', offset: 0, limit: 20 });
  assert.equal(result.ok, true);
  // 网易条目本来就没有 mediaMid（那是 QQ 文件名第二段），所以判据是"契约字段之外一个都不许多"，
  // 而不是"8 个字段必须齐全"——后者会把正常的网易条目判成不合格。
  const allowed = new Set(normalize.ONLINE_ITEM_FIELDS);
  for (const item of result.items) {
    const extra = Object.keys(item).filter((key) => !allowed.has(key));
    assert.deepEqual(extra, [], `出桥的条目带了契约外的字段：${extra.join(', ')}`);
    assert.equal(item.provider, 'netease');
    assert.ok(item.mediaId && item.title && item.durationMs > 0);
  }
  assert.equal(result.total, 137);
  assert.equal(result.hasMore, true);
  // "响应里没有 songs 字段"必须是**故障**，不能顺着 `?? []` 滑成"这个检索词没有结果"
  // （歌词那侧同一条规矩）。这一档正是变异"删掉 items===null 分支"要红的地方。
  const malformed = new Map();
  registerSearchRoutes({ routes: malformed, backends, fetchImpl: async () => ({ text: async () => JSON.stringify({ code: 20002, message: '参数不对' }), status: 200 }) });
  const broken = await malformed.get('/bridge/search')({ provider: 'netease', keywords: 'x' });
  assert.equal(broken.ok, false);
  assert.match(broken.reason, /result\.songs/, broken.reason);
  const empty = new Map();
  registerSearchRoutes({ routes: empty, backends, fetchImpl: async () => ({ text: async () => JSON.stringify({ result: { songs: [], songCount: 0, hasmore: false } }), status: 200 }) });
  const none = await empty.get('/bridge/search')({ provider: 'netease', keywords: 'x' });
  assert.equal(none.ok, true, '空数组才是"真的没有结果"');
  assert.deepEqual(none.items, []);
  assert.equal((await routes.get('/bridge/search')({ provider: 'qq' })).ok, false, 'QQ 不在桥里');
  assert.equal((await routes.get('/bridge/search')({ provider: 'kugou' })).ok, false, '酷狗今天没有音源，不占搜索通道');
  const notReady = new Map();
  registerSearchRoutes({ routes: notReady, backends: { netease: { state: 'error', reason: '包没起来' } }, fetchImpl: async () => { throw new Error('不该被调用') } });
  assert.match((await notReady.get('/bridge/search')({ provider: 'netease', keywords: 'x' })).reason, /未就绪/);
});

test('桥目录里不出现 QQ 包，也不出现酷狗搜索通道（R83 撤回后的形状，Task 7 扩面）', async () => {
  for (const name of ['online-bridge.mjs', 'lyric-routes.mjs', 'audio-routes.mjs', 'search-routes.mjs',
    'providers/normalize.mjs', 'providers/lyrics.mjs', 'backends/netease.mjs', 'backends/kugou.mjs']) {
    const text = await read(`scripts/bridge/${name}`);
    assert.doesNotMatch(text, /qq-music-api/, `${name} 不该 require QQ 包`);
  }
  const entry = await read('scripts/bridge/online-bridge.mjs');
  assert.match(entry, /registerSearchRoutes\(/, '搜索路由要挂在桥里（网易那一档）');
  assert.doesNotMatch(entry, /startQqBackend/, 'QQ 包后端已随 R83 撤回');
});

test('前端：在线结果用 data-online-track（点击即播放），与本地"定位"语义分开且不复用', async () => {
  const app = await read('src/music-app.ts');
  assert.match(app, /data-online-track/, '在线结果项要有自己的属性名');
  assert.match(app, /data-search-track/, '本地结果的定位语义保持不变');
  assert.notEqual(app.indexOf('data-online-track'), app.indexOf('data-search-track'), '两个分流点各自存在');
  const client = await read('src/online-search.ts');
  assert.match(client, /sourceKind: "online"/, '前端把契约条目转成 MusicTrack 时必须标来源');
  assert.match(client, /duration: .*durationMs \/ 1000|duration: msToSeconds/, '契约是毫秒，内核要的是秒（这一跳必须显式换算）');
  assert.match(client, /player\.play\([^)]*,\s*\[track\]/, '在线曲目用 play(id, [track]) 单首队列，不动本地队列');
  const types = await read('src/music-types.ts');
  assert.match(types, /sourceKind\?: "local" \| "online"/);
});

test('F4：在线曲目带着专辑名与描述字段去问歌词——专辑是打分的一维证据，丢了就少一分把握', async () => {
  const client = await read('src/online-search.ts');
  const app = await read('src/music-app.ts');
  const types = await read('src/music-types.ts');
  assert.match(client, /\.\.\.\(item\.album \? \{ album: item\.album \} : \{\}\)/, '有专辑才写字段（空串写成字段会让"有没有这项信息"变得含糊）');
  assert.match(types, /album\?: string;/, 'MusicTrack 要能装在线曲目的专辑名');
  assert.match(app, /track\.sourceKind === "online"\s*\n?\s*\? \{ online: \{ title: track\.title, artist: track\.artist, album: track\.album \?\? "", durationMs: Math\.round\(\(track\.duration \?\? 0\) \* 1000\) \} \}/, '只有在线曲目附描述字段；本地曲目走索引，不从这里开口');
  assert.equal(/body: JSON\.stringify\(\{ trackId: track\.id \}\)/.test(app), false, '旧形状（只发 trackId）不许回来：在线曲目会 404，症状是"在线歌没词"');
});

test('四张子开关各自管得住自己的路由，且保存时必须整张表一起发（只发一个键会把它张写没）', async () => {
  const app = await read('src/music-app.ts');
  // ① 界面四项、且逐字等于服务端 ONLINE_SWITCHES（M3-c 补进 covers 之后，两侧不齐就是假指引或空框）。
  const table = /const ONLINE_SWITCHES_UI = \[([\s\S]*?)\] as const;/.exec(app)?.[1] ?? '';
  assert.deepEqual([...table.matchAll(/key: "(\w+)"/g)].map((m) => m[1]), ['lyrics', 'search', 'streaming', 'covers']);
  const library = await readScript('music-library.mjs');
  const serverSwitches = /ONLINE_SWITCHES = \[([^\]]*)\]/.exec(library)?.[1] ?? '';
  for (const key of ['lyrics', 'search', 'streaming', 'covers']) {
    assert.ok(serverSwitches.includes(`'${key}'`), `服务端没有 ${key} 这张子开关，界面却在管它`);
  }
  // ② 保存通路必须发**合并后的整张表**：store.updateConfig() 对 online 是整个替换，
  //    只发 `{ [key]: wanted }` 的话，关掉"在线试听"会顺手把搜索与歌词也写成缺省——静默改了三件事。
  const handler = /async function applyOnlineSwitch\([\s\S]*?\n}\n/.exec(app)?.[0] ?? '';
  assert.ok(handler.length > 300, '没抓到 applyOnlineSwitch');
  assert.match(handler, /const before = \{ \.\.\.ONLINE_DEFAULTS_UI, \.\.\.library\.online \}/, '先取当前整张表（含用户写过的值）');
  assert.match(handler, /const next = \{ \.\.\.before, \[key\]: wanted \}/, '只覆盖被点的那一张');
  assert.match(handler, /, \{ online: next \}\)/, '提交体是整张表，不是单键');
  assert.doesNotMatch(handler, /\{ online: \{ \[key\]: wanted \} \}/, '单键提交是静默改别人家开关的写法');
  assert.match(handler, /toggle\.checked = before\[key\] !== false/, '失败要回弹到改动前那一档（默认方向也要对）');
  // ③ 关掉之后路由真的不再出网：服务端那四处判据逐个在位（不是靠一个总闸）。
  //    `covers` 那一档管的不是"一次请求"而是"扫描后排的那一轮补图"，所以判据在路由与扫描两处都要在。
  const server = await readScript('music-server.mjs');
  for (const [route, key] of [["'/api/online/stream'", 'streaming'], ["'/api/online/search'", 'search'], ["'/api/online/lyrics/match'", 'lyrics'], ["'/api/online/cover/backfill'", 'covers']]) {
    const at = server.indexOf(route);
    assert.ok(at > 0, `找不到路由 ${route}`);
    assert.match(server.slice(at, at + 400), new RegExp(`store\\.config\\.online\\?\\.${key}`), `${route} 没读自己的那张子开关`);
  }
  assert.match(library, /this\.config\.online\?\.covers !== false[\s\S]{0,120}backfillCovers/, '扫描后的自动补图也必须读 covers 这张开关');
});

test('出网审计认得搜索这一档：kind 与桥路由都有中文用途名', async () => {
  const app = await read('src/music-app.ts');
  const labels = /const ONLINE_AUDIT_KIND_LABELS[\s\S]*?\n};/.exec(app)?.[0] ?? '';
  assert.match(labels, /"\/bridge\/search": "在线搜索（经本地在线后端）"/);
  const orchestrator = await readScript('online-search.mjs');
  assert.match(orchestrator, /kind: 'search'/, 'QQ 那一笔要带用途名，否则面板里落到"未标注用途"');
});

// ── 夹具 ─────────────────────────────────────────────────────────────────────

async function routeServer({ config, onlineSearcher } = {}) {
  delete process.env.MUSICBRAINZ_CONTACT;
  const { createMusicServer } = await import('./music-server.mjs');
  const { MusicLibraryStore } = await import('./music-library.mjs');
  const os = await import('node:os');
  const fs = await import('node:fs/promises');
  const dataDir = await fs.mkdtemp(join(os.tmpdir(), 'rhine-search-'));
  const rootsDir = await fs.mkdtemp(join(os.tmpdir(), 'rhine-search-roots-'));
  const store = await new MusicLibraryStore({ dataDir, defaultRoots: [rootsDir] }).init();
  if (config) await store.updateConfig({ ...store.config, ...config });
  const bridge = {
    status: () => ({ phase: 'ready', port: 1, backends: [], unauthorized: 0, restarts: 0, lastError: null, hosts: ['netease', 'kugou'] }),
    call: async () => ({ ok: false, reason: '不该被调用' }), ensure: async () => {}, shutdown: async () => {},
  };
  const { server } = await createMusicServer({
    store, distDir: SCRIPTS, autoScan: false, bridgeClient: bridge,
    onlineLyricsMatcher: { match: async () => ({ matched: false }), clearCache: () => {} },
    onlineAudioSource: { resolve: async () => ({ ok: false, reason: '未配置' }) },
    onlineStreamFetcher: async () => { throw new Error('不该走到这里') },
    onlineSearcher,
  });
  // R211（A 类第 4 处）：升级 listenAndReady（连不上就关掉这台、换端口重听）；坏探测抛错时
  // 先把这台关干净 + 清掉两个临时目录再原样抛 —— 从前 `close` 只在 return 之后才交出去。
  let origin;
  try {
    ({ origin } = await listenAndReady(server));
  } catch (error) {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    await fs.rm(dataDir, { recursive: true, force: true });
    await fs.rm(rootsDir, { recursive: true, force: true });
    throw error;
  }
  return {
    origin, store,
    close: async () => {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
      await fs.rm(dataDir, { recursive: true, force: true });
      await fs.rm(rootsDir, { recursive: true, force: true });
    },
  };
}

// ── ④ 酷狗这一站（R154 · 任务一，2026-10-10） ─────────────────────────────────
// 钉的四件事：源集合是三家（加一家要显式改这条）、**没登录态就零出网**、
// 登录了才经桥且契约字段与另两家逐字同一张表、上游那些身份类字段一个都出不去。

test('R154 搜索源集合恰好三家（多加一家必须同时改这条与界面标签，不许悄悄多一个目标）', () => {
  assert.deepEqual(search.SEARCH_PROVIDERS, ['netease', 'qq', 'kugou']);
  // 单源检索的把关读同一张表：认得 kugou，也仍然拒绝野名字。
  assert.equal(search.normalizeSearchRequest({ query: 'x', provider: 'kugou' }).provider, 'kugou');
  assert.match(search.normalizeSearchRequest({ query: 'x', provider: 'kuGou' }).error ?? '', /不支持的搜索源/);
});

test('R154 本机没有酷狗登录态 ⇒ 这一站给一句实话，而且**一个桥调用都不发**（零出网）', async () => {
  const bridge = routingBridge({ netease: () => ({ ok: true, provider: 'netease', items: normalize.ncmSearchToItems(ncmBody()), total: 137, hasMore: true }) });
  const result = await searcher({ bridge }).search({ query: '李荣浩' });
  const kugou = result.perSource.find((entry) => entry.provider === 'kugou');
  assert.equal(kugou.ok, false, '没登录不是"查到了 0 条"，是这一站没参与');
  assert.equal(kugou.count, 0);
  assert.match(kugou.reason, /没有酷狗登录态/);
  assert.match(kugou.reason, /零出网/, '这句要说清"没问上游"，否则用户会以为酷狗坏了');
  assert.deepEqual([...new Set(bridge.calls.map(([route, provider]) => `${route}|${provider}`))], ['/bridge/search|netease'],
    '酷狗那一站不许把 payload 打到桥（问了就是出网）');
  assert.equal(result.ok, true, '其余源照常');
});

test('R154 有登录态才经桥：条目进合并、契约字段与另两家同一张表、酷狗没有封面字段就是空串', async () => {
  const saved = [];
  const bridge = routingBridge({
    netease: () => ({ ok: true, provider: 'netease', items: normalize.ncmSearchToItems(ncmBody(1)), total: 137, hasMore: true }),
    qq: () => ({ ok: false, provider: 'qq', reason: '这一趟不参与' }),
    kugou: () => ({ ok: true, provider: 'kugou', items: normalize.kugouSearchToItems(kgBody(2).body), total: 137, hasMore: true, device: { guid: 'g'.repeat(36), mid: '123456789012345678901234567890123456', dfid: '' } }),
  });
  const kugouItems = [];
  const result = await searcher({
    bridge,
    kugouSession: async () => { kugouItems.push(1); return { cookie: 'token=tt;userid=uu', device: { guid: 'g'.repeat(36), mid: '', dfid: '', deviceIdentity: false } } },
    saveKugouDevice: async (device) => { saved.push(device) },
  }).search({ query: '李荣浩' });
  const kugou = result.perSource.find((entry) => entry.provider === 'kugou');
  assert.equal(kugou.ok, true, `桥给了两条就该是 ok:true：${kugou.reason}`);
  assert.equal(kugou.count, 2);
  const found = result.items.filter((item) => item.provider === 'kugou');
  assert.equal(found.length, 2, '酷狗的两条要进合并结果');
  // 契约是靠"这里只构造这 11 个字段"守住的：逐字比 keys，不是该有的有就放过。
  assert.deepEqual(Object.keys(found[0]).sort(),
    ['album', 'artist', 'audioUrl', 'coverUrl', 'durationMs', 'id', 'mediaId', 'provider', 'quality', 'sourceKind', 'title'],
    '发给前端的曲目形状与另两家同一张表');
  for (const key of ['title', 'artist', 'album', 'durationMs', 'mediaId', 'audioUrl', 'coverUrl', 'quality']) assert.ok(key in found[0], `契约字段少了 ${key}`);
  for (const leaked of ['uid', 'nickname', 'AlbumPrivilege', 'FailProcess', 'FileHash', 'Bitrate', 'OriSongName', 'KUGOU_API_MID']) {
    assert.equal(found[0][leaked], undefined, `上游的 ${leaked} 不许出现在给前端的曲目里`);
  }
  assert.equal(found[0].durationMs, 254000, '酷狗 Duration 是**秒**（实测），换算成毫秒只在这一处做');
  assert.equal(found[0].coverUrl, '', '实测酷狗搜索行没有任何图片字段 ⇒ 空串（不是缺键，也不许按 AlbumID 造地址=F3 判据）');
  assert.match(found[0].id, /^on-kugou-[0-9A-F]{32}$/, '媒体 id 就是那颗 32 位 hash');
  // R222：同源地址里现在多了两个**可选**取址参数（`al`/`aa` = 专辑 id 与 album_audio_id，并进地址不进契约）。
  // R225：再多两个**成对**的身份参数（`t`/`a` = 曲名与歌手，回落要靠它们去别的源检索同名曲）。
  // 要求没变：还是"只能是同源地址、第三方地址一个都不许出现"，只是把这两格的形状显式写进式子里
  // （`t`/`a` 必须成对出现——只剩一个就不是可用的身份，R225 的把关判据另有正钉）。
  assert.match(found[0].audioUrl, /^\/api\/online\/stream\?p=kugou&id=[0-9A-F]{32}(&al=\d+)?(&aa=\d+)?(&t=[^&]+&a=[^&]+)?$/, '同源地址，第三方地址不出服务端');
  assert.equal(new URL(found[0].audioUrl, 'http://x').searchParams.get('al'), '106374641', '夹具里那句真实形状的 AlbumID 要并进地址（酷狗取址的"带专辑"那一档要用）');
  assert.equal(new URL(found[0].audioUrl, 'http://x').searchParams.get('aa'), '89872375', 'MixSongID 就是 album_audio_id（与网页端点回吐的那一格逐位相等）');
  // 桥回报的那一份身份要存回去（mid 是包内算的第一次），父进程不自己抄一份算法。
  assert.equal(saved.length, 1, '桥带回来的 device 要落一次盘');
  assert.equal(saved[0].mid, '123456789012345678901234567890123456');
});

test('R154 kugouSearchToItems：lists 缺席是故障、空数组才是没结果、Duration 单位是秒', () => {
  assert.equal(normalize.kugouSearchToItems({ errcode: 0 }), null, '没有 data.lists 字段 = 请求没被正确接受');
  assert.deepEqual(normalize.kugouSearchToItems({ data: { lists: [], total: 0 } }), [], '空数组 = 真的没有结果');
  const one = normalize.kugouSearchToItems(kgBody(1).body)[0];
  assert.equal(one.provider, 'kugou');
  assert.equal(one.coverRef, '', '搜索行没有封面字段 ⇒ 空串');
  assert.equal(one.durationMs, 254000);
  assert.match(one.quality, /^128kbps/);
  // **内部条目**也要钉键集合：只钉"发给前端的形状"拦不住"把上游对象展开进来"这一刀
  // （`toOnlineTrack` 是重新构造的，展开的那一份在 `searchEntries()` 这条内部出口上就出去了）。
  // 判据是"每个键都必须在那张表里"（酷狗没有 `mediaMid` 那一格，表是上界不是必须填满）。
  const extra = Object.keys(one).filter((key) => !normalize.ONLINE_ITEM_FIELDS.includes(key));
  assert.deepEqual(extra, [], `内部条目带了契约表之外的键：${extra.join(', ')}`);
  // FileHash 缺失或曲名为空的行整条丢掉（拼不出音源的条目一开始就不进任何出口）。
  assert.equal(normalize.kugouSearchToItems({ data: { lists: [{ SingerName: '某人', Duration: 1 }] } }).length, 0);
});

test('R154 桥那一路酷狗检索坏了：原因带出来、其余源照常（单源失败不拖垮整次的第三家版本）', async () => {
  const bridge = routingBridge({
    netease: () => ({ ok: true, provider: 'netease', items: normalize.ncmSearchToItems(ncmBody(1)), total: 137, hasMore: true }),
    qq: () => ({ ok: false, provider: 'qq', reason: '不参与' }),
    kugou: () => ({ ok: false, provider: 'kugou', reason: '酷狗检索响应里没有 data.lists 数组（请求没被正确接受，不是"没有结果"）', retryable: true }),
  });
  const result = await searcher({ bridge, kugouSession: async () => ({ cookie: 'token=tt;userid=uu', device: { guid: 'g'.repeat(36) } }) }).search({ query: '李荣浩' });
  const kugou = result.perSource.find((entry) => entry.provider === 'kugou');
  assert.equal(kugou.ok, false);
  assert.match(kugou.reason, /data\.lists/);
  assert.equal(result.ok, true, '一家坏了不改变"这次检索成功"');
});
