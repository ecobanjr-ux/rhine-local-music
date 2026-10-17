// 看板 95fe081：队列墙（lattice）的在线封面——四跳一次打通的自检。
//
// 用户实机报"歌单播放时封面墙没有封面"。断链是四跳，本文件按跳编号钉，一条一个失败面：
//   跳① sidecar 里要存 `coverRef`（第三方地址**只进服务端数据文件**）；
//   跳② `/tracks` 出给前端的只能是同源代理地址，且整份响应里不许出现那条第三方 URL；
//   跳③ 宿主的 `toFoliaSong` 要把曲目自己那张带进 `SongResult`（在线曲目没有本地专辑分组）；
//   跳④ 岛内取图判据先认曲目、再退专辑（`latticeModel` 是逐字移植件，改的是我们自撰的 stub）。
// 另钉两条边界：旧 sidecar 的"命中但缺封面"至多多打**一次**搜索且**同一首**才采纳；
// 自带身份（inline）条目不因此出网（批复②：用户可编辑的文本里不存 URL）。
// 全程离线：搜索与封面注册表都是注入件，出网次数就是数搜索被调用几次。
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';

const { PlaylistStore } = await import('./playlists.mjs');
const match = await import('./playlist-match.mjs');
const { createOnlineSearcher } = await import('./online-search.mjs');
const { ONLINE_ITEM_FIELDS, ONLINE_TRACK_FIELDS } = await import('./bridge/providers/normalize.mjs');
const { getProviderSongMetadata, getSongCoverUrl } = await import('../src/folia/services/onlineMusic/songMetadata.ts');

const THIRD_PARTY = 'https://p1.music.126.net/abc/123.jpg';
const sha16 = (text) => createHash('sha256').update(text).digest('hex').slice(0, 16);

/** 假的封面注册表：与真件同一张表面（enabled / register），token 算法也照抄（sha256 前 16 位）。 */
const fakeCovers = (on = true) => {
  const state = { enabled: on, calls: 0 };
  return {
    state,
    enabled: () => state.enabled,
    register(ref) {
      state.calls += 1;
      if (!state.enabled || !ref || !ref.startsWith('https://')) return '';
      return `/api/online/artwork/${sha16(ref)}`;
    },
  };
};

/**
 * **桥归一后的内部条目**（`ONLINE_ITEM_FIELDS` 那九个键）——匹配器该拿的那一份。
 * 第一版夹具照"发给前端的曲目形状"写（带 id/audioUrl、没有 coverRef），离线全绿而真机上
 * sidecar 一条封面都没存下：那一步的输入本来就该是内部条目。与 check-music-online-search
 * 里"夹具照假设写就等于把假设固化成已验证"同一课，第二次撞 ⇒ 下面"两个出口的差别"那条
 * 直接把这条假设本身钉住，不再靠夹具形状兜。
 */
const hitFor = (title, { mediaId = `id-${title}`, mediaMid = '', coverRef = THIRD_PARTY } = {}) => ({
  provider: 'netease', mediaId, mediaMid, title, artist: '李荣浩', album: '黑马',
  durationMs: 276000, quality: '自动', coverRef,
});
/** 发给前端的曲目形状（sidecar 里 `track` 那一格就是它）。 */
const trackFor = (title, { mediaId = `id-${title}` } = {}) => ({
  id: `on-netease-${mediaId}`, sourceKind: 'online', provider: 'netease', title, artist: '李荣浩',
  album: '黑马', durationMs: 276000, mediaId, quality: '自动',
  audioUrl: `/api/online/stream?p=netease&id=${mediaId}`, coverUrl: '',
});

async function withPlaylist(run, { text = '恋人 - 李荣浩\n', items = [hitFor('恋人')], covers = fakeCovers(), search: provided = null, now } = {}) {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'rhine-wallcover-'));
  const store = await new PlaylistStore({ dataDir }).init();
  await store.write('test', text);
  let searches = 0;
  // 计数包住两种搜索（内置的与用例自带的），出网次数永远是这一个数——R125 那几条判的就是它。
  const search = provided
    ? async (query) => { searches += 1; return provided(query); }
    : async ({ query }) => {
      searches += 1;
      const title = query.split(' ')[0];
      return { ok: true, items: items.filter((item) => item.title === title) };
    };
  const svc = match.createPlaylistMatcher({ store, search, covers, ...(now ? { now } : {}) });
  try {
    return await run({ svc, store, dataDir, covers, counts: () => searches });
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
}

const legacySidecar = (key, extra = {}) => ({
  version: match.MATCH_SIDECAR_VERSION, playlist: 'test',
  entries: { [key]: { ok: true, at: Date.now(), score: 100, track: trackFor('恋人'), ...extra } },
});

// ── 装配红线：匹配器拿的是内部条目那一份出口 ──────────────────────────────────

test('两个出口的差别：search() 换掉第三方地址，searchEntries() 留着它（跳①的输入）', async () => {
  const covers = fakeCovers();
  const bridge = { call: async () => ({ ok: true, items: [hitFor('恋人')], total: 1, hasMore: false }) };
  const searcher = createOnlineSearcher({ bridge, covers, fetcher: async () => { throw new Error('本用例不该走 QQ 直连') } });
  const out = await searcher.search({ query: '恋人', provider: 'netease' });
  const internal = await searcher.searchEntries({ query: '恋人', provider: 'netease' });
  assert.deepEqual(Object.keys(out.items[0]).sort(), [...ONLINE_TRACK_FIELDS].sort(), 'search() 出去的仍是发给前端的那份契约');
  // R222：内部条目表里多了两个**可选**键（`albumId`/`albumAudioId`，只有酷狗的行才有），
  // 所以这一格从"逐字相等"改成"**每个键都必须在那张表里**"（与 online-search 段同一条口径）——
  // 要求没松：上游对象一旦被展开进来，多出来的键照样红。
  const extraKeys = Object.keys(internal.items[0]).filter((key) => !ONLINE_ITEM_FIELDS.includes(key));
  assert.deepEqual(extraKeys, [], `searchEntries() 出去的是桥归一的内部条目，多出这些键：${extraKeys.join(', ')}`);
  assert.equal(internal.items[0].mediaId && internal.items[0].title, internal.items[0].title, '内部条目的身份与曲名照旧必须有');
  assert.equal(out.items[0].coverUrl, `/api/online/artwork/${sha16(THIRD_PARTY)}`, '前端拿同源地址');
  assert.equal('coverRef' in out.items[0], false, '第三方地址不许出现在前端契约里');
  assert.equal(internal.items[0].coverRef, THIRD_PARTY, '服务端侧要能拿到原始地址，否则 sidecar 无从存起');
  assert.doesNotMatch(JSON.stringify(out), /music\.126\.net/, '整个前端响应里搜不到那条地址');
});

test('两个出口都不放"拼不出音源的条目"过去（去重那一步的守门，两个出口共用）', async () => {
  const bridge = {
    call: async () => ({ ok: true, items: [hitFor('好歌'), { provider: '', mediaId: '', title: '野路子', artist: '某人', album: '', durationMs: 0, quality: '', mediaMid: '', coverRef: '' }], total: 2, hasMore: false }),
  };
  const searcher = createOnlineSearcher({ bridge, covers: fakeCovers() });
  const out = await searcher.search({ query: '好歌', provider: 'netease' });
  const internal = await searcher.searchEntries({ query: '好歌', provider: 'netease' });
  assert.equal(out.items.length, 1, '没有来源与媒体 id ⇒ 拼不出音源，不该进前端契约');
  assert.equal(internal.items.length, 1, '也不该给匹配器——它随后要 toOnlineTrack，放过去就是一格 null 曲目');
});

test('装配：歌单匹配器接的是 searchEntries（接错就回到"sidecar 永远没有封面"）', async () => {
  const server = await readFile(new URL('./music-server.mjs', import.meta.url), 'utf8');
  // 提取窗口从前是"往后 400 字符内碰到的第一个 }"——R143 给装配处加了 `preference` 闭包（里面全是花括号）
  // 就把窗口撑破了，报的是"没抓到装配处"。改成**非贪婪到第一个 `})`**：那正好是这次调用的收尾，
  // 与装配处里加多少参数无关。判据一条没放宽（两项仍要在提取到的这段里逐字出现）。
  const wiring = server.match(/createPlaylistMatcher\(\{[\s\S]*?\}\)/);
  assert.ok(wiring, '没抓到 createPlaylistMatcher 的装配处（提取失败不许静默通过）');
  assert.ok(wiring[0].length < 1600, `提取到的这段过长（${wiring[0].length}），说明收尾判据又失效了，别拿它当证据`);
  assert.match(wiring[0], /onlineSearcher\.searchEntries\(/, '匹配门面要接内部条目那一份出口');
  assert.match(wiring[0], /covers:\s*onlineTrackCovers/, 'covers 要注进匹配器（跳②的签发件）');
});

test('顺带修到的一处旧错：匹配器不再把"发给过前端的形状"回喂 toOnlineTrack（QQ 次 id 曾在这一步丢）', async () => {
  const qq = hitFor('李白', { mediaId: 'mid-1', mediaMid: 'SUB-1', coverRef: 'https://y.gtimg.cn/music/photo_new/T002R300x300M000abc.jpg' });
  await withPlaylist(async ({ svc, store }) => {
    const got = await svc.matchEntry('test', { title: '李白', artist: '李荣浩' });
    assert.equal(got.ok, true, '按内部条目形状喂也能配上');
    assert.match(got.track.audioUrl, /[?&]mm=SUB-1(&|$)/,
      'QQ 的次 id 要在中转地址里——从前匹配器拿到的是"已经发给过前端的形状"（那份没有 mediaMid），这一段会被丢掉');
    assert.equal(got.coverRef, qq.coverRef, '同一条内部条目也才拿得到 coverRef');
    const saved = JSON.parse(await readFile(store.matchFileOf('test'), 'utf8'));
    assert.equal(Object.values(saved.entries)[0].coverRef, qq.coverRef);
  }, { text: '李白 - 李荣浩\n', items: [qq] });
});

// ── 跳① + 跳②：新匹配出来的条目 ──────────────────────────────────────────────

test('跳①：匹配命中 ⇒ sidecar 记录里存 coverRef（第三方地址落在服务端数据文件）', async () => {
  await withPlaylist(async ({ svc, store }) => {
    await svc.matchAll('test');
    const sidecar = JSON.parse(await readFile(store.matchFileOf('test'), 'utf8'));
    const record = Object.values(sidecar.entries)[0];
    assert.equal(record.coverRef, THIRD_PARTY, 'sidecar 里要留第三方地址，否则下次想补图只能重搜');
    assert.equal(record.track.coverUrl, '', '发给前端的曲目形状里这一格是空串（由读视图时现算，不缓存代理地址）');
  });
});

test('跳②：/tracks 出去的是同源代理地址，整份响应里搜不到那条第三方 URL', async () => {
  await withPlaylist(async ({ svc, covers }) => {
    await svc.matchAll('test');
    const view = await svc.tracks('test');
    const url = view.items[0].track.coverUrl;
    assert.match(url, /^\/api\/online\/artwork\/[a-f0-9]{16}$/, '与音源同一条红线：只能是我们自己签发的同源路径');
    assert.equal(url, `/api/online/artwork/${sha16(THIRD_PARTY)}`, 'token 由 coverRef 算出（同一首每次拿到同一个地址）');
    assert.doesNotMatch(JSON.stringify(view), /music\.126\.net/, '第三方地址一步都不出服务端');
    assert.equal(covers.state.calls, 1, '一次读视图签发一次（不重复注册）');
  });
});

test('跳② 边界：sidecar 里存的那份不被改写（发出去的地址不落盘 ⇒ 重启后仍能重新签发）', async () => {
  await withPlaylist(async ({ svc, store }) => {
    await svc.matchAll('test');
    const before = await readFile(store.matchFileOf('test'), 'utf8');
    await svc.tracks('test');
    assert.equal(await readFile(store.matchFileOf('test'), 'utf8'), before, '读视图不许把同源地址写回缓存（那是会过期的东西）');
  });
});

test('跳② 边界：封面子开关关着 ⇒ coverUrl 保持空串、一次都不签发', async () => {
  await withPlaylist(async ({ svc, covers }) => {
    await svc.matchAll('test');
    covers.state.enabled = false;
    const view = await svc.tracks('test');
    assert.equal(view.items[0].track.coverUrl, '', '关掉之后前端拿到的还是空串，画既有占位（不造会 404 的地址）');
    assert.equal(covers.state.calls, 0, '关着就不该签发');
  });
});

test('跳② 边界：自带身份（inline）条目不因封面出网、也不编地址（批复②）', async () => {
  await withPlaylist(async ({ svc, counts, covers }) => {
    const view = await svc.tracks('test');
    assert.equal(view.items[0].source, 'inline');
    assert.equal(view.items[0].track.coverUrl, '', '身份文本里没有 coverRef ⇒ 只能给空串');
    assert.equal(counts(), 0, '为一条身份条目去搜封面 = 白打的一笔出网');
    assert.equal(covers.state.calls, 0);
  }, { text: '恋人 - 李荣浩 | 黑马 | 4:36 | on:netease:27699577\n' });
});

// ── 旧 sidecar 的迁移（看板 95fe081 边界 b）──────────────────────────────────

test('迁移：旧 sidecar 命中但缺 coverRef ⇒ 多打一次搜索补图，补到就落盘且不再问', async () => {
  await withPlaylist(async ({ svc, store, counts }) => {
    const key = match.entryKey({ title: '恋人', artist: '李荣浩', durationMs: '', album: '' });
    await writeFile(store.matchFileOf('test'), JSON.stringify(legacySidecar(key)), 'utf8');
    const first = await svc.matchEntry('test', { title: '恋人', artist: '李荣浩' });
    assert.equal(first.cached, 'hit', '还是走缓存命中（匹配结果不许被换掉）');
    assert.equal(counts(), 1, '缺封面 ⇒ 这一条多打一次搜索');
    const saved = JSON.parse(await readFile(store.matchFileOf('test'), 'utf8'));
    assert.equal(saved.entries[key].coverRef, THIRD_PARTY, '补到了要落盘，下次不再问');
    await svc.matchEntry('test', { title: '恋人', artist: '李荣浩' });
    assert.equal(counts(), 1, '补到之后不再为同一条出网（每条目至多一次额外请求）');
  });
});

test('迁移：搜回来的不是同一首 ⇒ 匹配原样不动，落 coverTried 不再反复问', async () => {
  const other = hitFor('恋人', { mediaId: 'different-song', coverRef: 'https://p2.music.126.net/other.jpg' });
  await withPlaylist(async ({ svc, store, counts }) => {
    const key = match.entryKey({ title: '恋人', artist: '李荣浩', durationMs: '', album: '' });
    await writeFile(store.matchFileOf('test'), JSON.stringify(legacySidecar(key)), 'utf8');
    const got = await svc.matchEntry('test', { title: '恋人', artist: '李荣浩' });
    assert.equal(got.track.mediaId, 'id-恋人', '为了拿张图把用户看到的匹配换掉是不可接受的');
    assert.equal(got.coverRef, undefined, '身份不同 ⇒ 那张封面也不采纳');
    const saved = JSON.parse(await readFile(store.matchFileOf('test'), 'utf8'));
    assert.equal(saved.entries[key].coverTried, true, '补不到要留戳，否则每轮整单匹配都白打一遍');
    await svc.matchEntry('test', { title: '恋人', artist: '李荣浩' });
    assert.equal(counts(), 1, '留了戳之后第二次零额外出网');
  }, { items: [other] });
});

test('迁移：整单匹配把缺封面的条目算进出网次数（回执那句"联网搜了 N 条"要是真的）', async () => {
  await withPlaylist(async ({ svc, store }) => {
    const key = match.entryKey({ title: '恋人', artist: '李荣浩', durationMs: '', album: '' });
    await writeFile(store.matchFileOf('test'), JSON.stringify(legacySidecar(key)), 'utf8');
    const summary = await svc.matchAll('test');
    assert.equal(summary.searches, 1, '补封面这一次要计进出网回执，不许静默');
    assert.equal(summary.matched, 1);
  });
});

test('迁移：封面子开关关着 ⇒ 旧 sidecar 一次网都不多打', async () => {
  const covers = fakeCovers(false);
  await withPlaylist(async ({ svc, store, counts }) => {
    const key = match.entryKey({ title: '恋人', artist: '李荣浩', durationMs: '', album: '' });
    await writeFile(store.matchFileOf('test'), JSON.stringify(legacySidecar(key)), 'utf8');
    await svc.matchEntry('test', { title: '恋人', artist: '李荣浩' });
    assert.equal(counts(), 0, '关掉封面 ⇒ 不为补图出网');
  }, { covers });
});

// ── R125：coverTried 的语义（异常不盖戳 · 7 天窗口 · 一次性迁移）───────────────
// 本机 5 条"命中却永远没封面"的成因是同一处：一次性回填 + 没有容错 + 异常也盖戳
// （`.catch(() => { stored.coverTried = true; })`）。一次网络抖动被写成"问过、确实没有"的永久事实。

const keyOfLover = () => match.entryKey({ title: '恋人', artist: '李荣浩', durationMs: '', album: '' });

test('R125 容错：补图时搜索抛错 ⇒ 一个戳都不落，下一轮重问', async () => {
  await withPlaylist(async ({ svc, store, counts }) => {
    const key = keyOfLover();
    await writeFile(store.matchFileOf('test'), JSON.stringify(legacySidecar(key)), 'utf8');
    const got = await svc.matchEntry('test', { title: '恋人', artist: '李荣浩' });
    assert.equal(got.cached, 'hit', '补图失败不许牵连匹配本身（这条本来就是命中）');
    assert.equal(counts(), 1, '这一次确实打了网');
    const saved = JSON.parse(await readFile(store.matchFileOf('test'), 'utf8'));
    assert.equal(saved.entries[key].coverTried, undefined, '抛错不是"问过且没有"，落戳就是把抖动判成永久事实');
    assert.equal(saved.entries[key].coverCheckedAt, undefined, '没有结论也不留时间戳');
    await svc.matchEntry('test', { title: '恋人', artist: '李荣浩' });
    assert.equal(counts(), 2, '下一轮要能重问——这就是"无容错"缺的那一半');
  }, { search: async () => { throw new Error('桥没起来'); } });
});

test('R125 容错：所有源都没应答（ok:false）也不算"问过且没有"', async () => {
  await withPlaylist(async ({ svc, store, counts }) => {
    const key = keyOfLover();
    await writeFile(store.matchFileOf('test'), JSON.stringify(legacySidecar(key)), 'utf8');
    await svc.matchEntry('test', { title: '恋人', artist: '李荣浩' });
    const saved = JSON.parse(await readFile(store.matchFileOf('test'), 'utf8'));
    assert.equal(saved.entries[key].coverTried, undefined, 'items 为空是"没人回答"，不是"回答了我没有"');
    await svc.matchEntry('test', { title: '恋人', artist: '李荣浩' });
    assert.equal(counts(), 2, '同理：下一轮重问');
  }, { search: async () => ({ ok: false, items: [] }) });
});

test('R125 有结论才盖戳：搜到了、但同一首确实没封面 ⇒ 落 coverTried + coverCheckedAt', async () => {
  const noCover = hitFor('恋人', { coverRef: '' });
  await withPlaylist(async ({ svc, store, counts }) => {
    const key = keyOfLover();
    await writeFile(store.matchFileOf('test'), JSON.stringify(legacySidecar(key)), 'utf8');
    await svc.matchEntry('test', { title: '恋人', artist: '李荣浩' });
    const saved = JSON.parse(await readFile(store.matchFileOf('test'), 'utf8'));
    assert.equal(saved.entries[key].coverTried, true, '这一条是有结论的，要落戳，否则每轮整单都白打一遍');
    assert.ok(Number(saved.entries[key].coverCheckedAt) > 0, '落戳必带时间戳（迁移判据靠它区分新旧面孔）');
    await svc.matchEntry('test', { title: '恋人', artist: '李荣浩' });
    assert.equal(counts(), 1, '落了戳就进冷却');
  }, { items: [noCover] });
});

test('R125 冷却窗口：coverTried 只买 7 天，第 8 天允许再问一次', async () => {
  const DAY = 24 * 3600 * 1000;
  const base = 1_800_000_000_000;                       // 固定时钟：窗口判据要能离线判定
  await withPlaylist(async ({ svc, store, counts }) => {
    const key = keyOfLover();
    assert.equal(match.COVER_RETRY_MS, 7 * DAY, '窗口是 7 天，且是导出的常量（不是散在表达式里的裸数）');
    await writeFile(store.matchFileOf('test'),
      JSON.stringify(legacySidecar(key, { at: base, coverTried: true, coverCheckedAt: base - 6 * DAY })), 'utf8');
    await svc.matchEntry('test', { title: '恋人', artist: '李荣浩' });
    assert.equal(counts(), 0, '6 天前问过 ⇒ 在冷却里，零出网');
    await writeFile(store.matchFileOf('test'),
      JSON.stringify(legacySidecar(key, { at: base, coverTried: true, coverCheckedAt: base - 8 * DAY })), 'utf8');
    await svc.matchEntry('test', { title: '恋人', artist: '李荣浩' });
    assert.equal(counts(), 1, '过了 7 天 ⇒ 搜索结果会漂，允许再问（这一戳不是永久判决）');
  }, { now: () => base });
});

test('R125 迁移：旧版误盖的那副面孔（无 coverRef 也无 checkedAt）读时清掉，让它重问', async () => {
  await withPlaylist(async ({ svc, store, counts }) => {
    const key = keyOfLover();
    await writeFile(store.matchFileOf('test'), JSON.stringify(legacySidecar(key, { coverTried: true })), 'utf8');
    await svc.matchEntry('test', { title: '恋人', artist: '李荣浩' });
    assert.equal(counts(), 1, '修复之前被一次抖动判死的条目 ⇒ 升级后重问一次（本机那 5 条走的就是这一格）');
    const saved = JSON.parse(await readFile(store.matchFileOf('test'), 'utf8'));
    assert.equal(saved.entries[key].coverRef, THIRD_PARTY, '重问就把图补上了');
    assert.equal('coverTried' in saved.entries[key], false, '补到之后不留戳');
  });
});

test('R125 迁移不误伤新戳：带 checkedAt 的 coverTried 不会被反复擦成"再问一次"', async () => {
  await withPlaylist(async ({ svc, store, counts }) => {
    const key = keyOfLover();
    await writeFile(store.matchFileOf('test'),
      JSON.stringify(legacySidecar(key, { coverTried: true, coverCheckedAt: Date.now() })), 'utf8');
    await svc.matchEntry('test', { title: '恋人', artist: '李荣浩' });
    assert.equal(counts(), 0, '新落的戳在冷却里 ⇒ 判据必须把它和旧的那副面孔分开');
    const saved = JSON.parse(await readFile(store.matchFileOf('test'), 'utf8'));
    assert.equal(saved.entries[key].coverTried, true, '没重问就不改写磁盘：读时清的是内存里那一份');
  });
});

test('R125 判据面：早退与"catch 里不落戳"两条都不许回退', async () => {
  const src = await readFile(new URL('./playlist-match.mjs', import.meta.url), 'utf8');
  const refill = /async function refillCoverRef[\s\S]*?\n  \}/.exec(src);
  assert.ok(refill, '没抓到 refillCoverRef（提取失败不许静默通过）');
  assert.match(refill[0], /if \(found\?\.ok !== true\) return;/, '搜索本身失败 ⇒ 早退，一个戳都不落');
  assert.match(refill[0], /else record\.coverTried = true;/, '只有"同一首里确实没有封面"才落戳');
  assert.match(refill[0], /record\.coverCheckedAt = now\(\);/, '落戳与时间戳同现（迁移判据的前提）');
  const call = /if \(coverWanted\(stored\)\) \{[\s\S]*?\n      \}/.exec(src);
  assert.ok(call, '没抓到补图调用处');
  assert.doesNotMatch(call[0], /catch\([^)]*coverTried/, '调用处的 catch 里再写 coverTried 就是本次要修的原始缺陷');
  const migrate = /async function readSidecar[\s\S]*?\n  \}/.exec(src);
  assert.ok(migrate, '没抓到 readSidecar');
  assert.match(migrate[0], /record\.coverTried === true && !record\.coverRef && !record\.coverCheckedAt/,
    '迁移判据三件齐备：有戳、无封面、无时间戳 —— 少一件就会误伤新戳');
});

// ── 跳③ + 跳④：宿主带出去、岛内读得到 ────────────────────────────────────────

test('跳③：toFoliaSong 把曲目自己那张封面带进 SongResult（源码区域提取，先确认提取成功）', async () => {
  const app = await readFile(new URL('../src/music-app.ts', import.meta.url), 'utf8');
  const region = app.match(/function toFoliaSong\(track: MusicTrack\): SongResult \{[\s\S]*?\n\}/);
  assert.ok(region, '没抓到 toFoliaSong —— 提取失败时不许让断言静默通过');
  assert.match(region[0], /track\.coverUrl/, '队列条目自己的封面要带出去（在线曲目 album 是 null，不带就是永远没图）');
  const types = await readFile(new URL('../src/folia/types.ts', import.meta.url), 'utf8');
  const song = types.match(/export interface SongResult \{[\s\S]*?\n\}/);
  assert.ok(song, '没抓到 SongResult 声明');
  assert.match(song[0], /^\s+coverUrl\?: string;$/m, 'SongResult 要有顶层 coverUrl（R11b 自撰重写里新增）');
});

test('跳④：岛内取图先认曲目、再退专辑；两者都没有给 null（F3 那条判据不许回来）', () => {
  assert.equal(getProviderSongMetadata({ coverUrl: '/api/online/artwork/aa', album: { coverUrl: '/api/artwork/al-1' } }).coverUrl,
    '/api/online/artwork/aa', '更具体的那张（曲目自己）优先');
  assert.equal(getProviderSongMetadata({ album: { coverUrl: '/api/artwork/al-1' } }).coverUrl, '/api/artwork/al-1', '本地专辑照常');
  assert.equal(getProviderSongMetadata({ coverUrl: '/api/online/artwork/bb' }).coverUrl, '/api/online/artwork/bb', '在线曲目没有 album 分组也要有图');
  assert.equal(getProviderSongMetadata({ album: { name: '没有封面' } }).coverUrl, null, '没封面就是 null，不许按 id 造 URL（F3）');
  assert.equal(getSongCoverUrl({ coverUrl: '/api/online/artwork/cc' }), '/api/online/artwork/cc', 'latticeModel 走的是这个出口');
  assert.equal(getSongCoverUrl(null), undefined, '空曲目不炸（墙里可能出现没有当前曲的一格）');
});

test('跳④ 边界：latticeModel 是逐字移植件，本批改它一个字都不许（改的是自撰 stub）', async () => {
  const model = await readFile(new URL('../src/folia/components/app/lattice/latticeModel.ts', import.meta.url), 'utf8');
  assert.match(model, /coverUrl: getSongCoverUrl\(song\) \|\| song\.album\?\.coverUrl/, '上游那行原样在位');
  assert.match(model.slice(0, 600), /Ported from folia-major/, '归属头在位');
});

// ── R126：墙上「重取封面」（方案 A）───────────────────────────────────────────
// 用户要的是一颗手动即时重试的按钮（不等 R125 那个 7 天窗口）。四件事分别钉：
// 路由的出网纪律与"登记≠取到"、写回 sidecar 的身份判据、岛内那颗按钮的出现条件与"不自已出网"、
// 补到的图经内核队列上屏的那条通路（在 check-music-island-feed ②b 与 check-music-player R126 里）。

test('R126 rememberCover：按身份写回所有引用到这一首的 sidecar，别的记录一个都不碰', async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'rhine-remember-'));
  try {
    const store = await new PlaylistStore({ dataDir }).init();
    await store.write('甲', '恋人 - 李荣浩\n');
    await store.write('乙', '恋人 - 李荣浩\n别的歌 - 某人\n');
    const svc = match.createPlaylistMatcher({ store, search: async () => ({ ok: true, items: [] }) });
    const record = (title, mediaId, extra = {}) => ({
      ok: true, at: Date.now(), score: 100, track: { ...trackFor(title), mediaId }, ...extra,
    });
    const keyLover = match.entryKey({ title: '恋人', artist: '李荣浩', durationMs: '', album: '' });
    const keyOther = match.entryKey({ title: '别的歌', artist: '某人', durationMs: '', album: '' });
    await writeFile(store.matchFileOf('甲'), JSON.stringify({
      version: match.MATCH_SIDECAR_VERSION, playlist: '甲',
      entries: { [keyLover]: record('恋人', 'id-恋人', { coverTried: true, coverCheckedAt: Date.now() }) },
    }), 'utf8');
    await writeFile(store.matchFileOf('乙'), JSON.stringify({
      version: match.MATCH_SIDECAR_VERSION, playlist: '乙',
      entries: { [keyLover]: record('恋人', 'id-恋人'), [keyOther]: record('别的歌', 'id-别的歌', { coverRef: 'https://p1.music.126.net/keep.jpg' }) },
    }), 'utf8');

    const got = await svc.rememberCover({ provider: 'netease', mediaId: 'id-恋人', coverRef: THIRD_PARTY });
    assert.equal(got.updated, 2, '两张歌单里同一身份各写一条（队列不带来源，所以按身份扫）');
    const a = JSON.parse(await readFile(store.matchFileOf('甲'), 'utf8'));
    assert.equal(a.entries[keyLover].coverRef, THIRD_PARTY, '补到图之后 sidecar 有地址');
    assert.equal('coverTried' in a.entries[keyLover], false, '有图了，"问过且没有"那一句就不成立了');
    assert.equal('coverCheckedAt' in a.entries[keyLover], false, '冷却时间戳跟着一起清（留着会被窗口判据当成还在冷却）');
    const b = JSON.parse(await readFile(store.matchFileOf('乙'), 'utf8'));
    assert.equal(b.entries[keyOther].coverRef, 'https://p1.music.126.net/keep.jpg', '不同身份的条目一个字都不动');
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});

test('R126 rememberCover 的三档不写：野地址 / 身份不匹配 / 已经是这一张（都不许产生写入）', async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'rhine-remember2-'));
  try {
    const store = await new PlaylistStore({ dataDir }).init();
    await store.write('甲', '恋人 - 李荣浩\n');
    const key = match.entryKey({ title: '恋人', artist: '李荣浩', durationMs: '', album: '' });
    const seed = JSON.stringify({
      version: match.MATCH_SIDECAR_VERSION, playlist: '甲',
      entries: { [key]: { ok: true, at: Date.now(), score: 100, track: trackFor('恋人') } },
    });
    await writeFile(store.matchFileOf('甲'), seed, 'utf8');
    const svc = match.createPlaylistMatcher({ store, search: async () => ({ ok: true, items: [] }) });
    assert.equal((await svc.rememberCover({ provider: 'netease', mediaId: 'id-恋人', coverRef: 'http://p1.music.126.net/x.jpg' })).updated, 0,
      '非 https 的地址不写（与 register 同一道判据）');
    assert.equal((await svc.rememberCover({ provider: 'netease', mediaId: '不存在的歌', coverRef: THIRD_PARTY })).updated, 0,
      '身份对不上就不写——为了补图改匹配是不可接受的');
    assert.equal(await readFile(store.matchFileOf('甲'), 'utf8'), seed, '三档空操作都不该产生写入');
    assert.equal((await svc.rememberCover({ provider: 'netease', mediaId: 'id-恋人', coverRef: THIRD_PARTY })).updated, 1,
      '同样的身份 + 新地址是要写的（上一条故意没写）');
    const before = await readFile(store.matchFileOf('甲'), 'utf8');
    assert.equal((await svc.rememberCover({ provider: 'netease', mediaId: 'id-恋人', coverRef: THIRD_PARTY })).updated, 0,
      '已经是这一张 ⇒ 不重复写（否则每次点都刷一遍盘）');
    assert.equal(await readFile(store.matchFileOf('甲'), 'utf8'), before, '重复点击不动盘');
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});

test('R126 路由纪律：开关→方法→体→才出网，同身份逐字，登记与取图都成才算 ok', async () => {
  const server = await readFile(new URL('./music-server.mjs', import.meta.url), 'utf8');
  const block = /if \(route === '\/api\/online\/covers\/retry'\) \{[\s\S]*?\n      \}\n/.exec(server);
  assert.ok(block, '没抓到「重取封面」那条路由（提取失败不许让断言静默通过）');
  const body = block[0];
  const at = (re) => body.search(re);
  assert.ok(at(/config\.online\?\.covers/) >= 0 && at(/config\.online\?\.covers/) < at(/searchEntries/), '子开关排在出网之前');
  assert.ok(at(/method !== 'POST'/) < at(/searchEntries/), '方法判定排在出网之前');
  assert.ok(at(/bodyJson\(request\)/) < at(/searchEntries/), '读请求体排在出网之前');
  assert.match(body, /item\.provider === provider && String\(item\.mediaId\) === mediaId && item\.coverRef/,
    '同身份逐字校验（与回填同一条判据，不另起一套）');
  assert.match(body, /onlineTrackCovers\.load\(/, '登记过 ≠ 取到：要真取到图并过魔数才算成功');
  assert.ok(at(/onlineTrackCovers\.load\(/) < at(/rememberCover/), '写回缓存排在取图验证之后（没验证过的地址不落盘）');
  assert.match(body, /playlistMatcher\.rememberCover/, '补到的图要写回匹配缓存（否则重启就没了）');
  assert.ok((body.match(/ok: false/g) ?? []).length >= 3, '三类"没补到"各自如实回，且都带 reason');
  assert.doesNotMatch(body, /value\.(url|coverUrl|coverRef)/, '这条路由不接受任何外部地址——它不是"给个 URL 就帮你取"的代理');
});

test('R126 岛内那颗按钮：只在"在线且没封面"时出现，点击只发事件、绝不自已出网', async () => {
  const btn = await readFile(new URL('../src/folia-host/LatticeCoverRetry.tsx', import.meta.url), 'utf8');
  assert.match(btn, /getSongCoverUrl\(song\)/, '与墙上画占位同一条判据（有图就不该给一颗会打网的按钮）');
  assert.match(btn, /ONLINE_ID\.test\(song\.id\)/, '本地曲目不出现这颗（它的封面在音频文件里，重问没有意义）');
  assert.doesNotMatch(btn, /fetch\(|XMLHttpRequest|EventSource/, '岛不持有出网权');
  assert.match(btn, /new CustomEvent\("rhine:cover-retry"/, '只发一个事件，取图与汇报在宿主');
  const app = await readFile(new URL('../src/music-app.ts', import.meta.url), 'utf8');
  assert.match(app, /addEventListener\("rhine:cover-retry"/, '事件名两端逐字相同（对不上就是点了没反应）');
  assert.match(app, /coverRetryPending/, '按曲目 id 去重：连点两下不打两次网');
  assert.match(app, /coverRetryPending\.has\(id\)\) return/,
    '去重要落在"这一首已经在飞就不再发"那一句上——只留一个 Set 变量、add/delete 都在，等于没去重（T10 第一轮就没咬）');
  assert.match(app, /player\.applyTrackCover\(/, '补到的图经内核队列上屏（不在宿主另存一份封面真相）');
  assert.match(app, /不在任何匹配缓存里/, '写不回缓存的那种要说"只在这次会话里"，不许含糊成"已更新"');
  const controls = await readFile(new URL('../src/folia/components/app/lattice/LatticePlaybackControls.tsx', import.meta.url), 'utf8');
  assert.match(controls, /<LatticeCoverRetry song=\{tile\.song\} \/>/, '挂在展开卡的传输行（不是 details 那一格：那是 0fr→1fr 的擦除动画，多塞子元素会多出一行）');
});

test('R126 移植纪律：改动了哪颗移植件，白名单理由里必须登记', async () => {
  const port = await readFile(new URL('./check-folia-port.mjs', import.meta.url), 'utf8');
  assert.match(port, /\['components\/app\/lattice\/LatticePlaybackControls\.tsx', 'R48 i18n shim \+ R126 挂宿主自撰的「重取封面」'\]/,
    '改了移植件却不登记理由 = 悄悄改上游代码（R53 拦的就是这个）');
});
