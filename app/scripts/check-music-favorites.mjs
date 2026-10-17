// R130（候选 ⑤ 的剩余项之一）：收藏 / 喜欢 —— 本机一份 JSON + 两个入口（传输区与岛内）同源。
//
// 三条最容易被"顺手改掉"的形状，逐条钉：
//   ① **键是内容指纹，不是曲目 id**：本地 id 是文件路径哈希，挪一下根目录就整批失联；
//   ② **写要串行**：连点两下不能丢一次，而串行链本身不许卡死（上一批踩过"永不落地的锁"）；
//   ③ **读数只有服务端一个出处**：前端不重算指纹，也不在请求回来之前先把心画成红的。
// 全程离线：不碰网络，数据目录用 mkdtemp 的临时目录，测完即删。
import test from 'node:test';
import { listenAndReady } from './check-ready.mjs';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPTS = dirname(fileURLToPath(import.meta.url));
const readScript = (name) => readFile(path.join(SCRIPTS, name), 'utf8');
const read = (relative) => readFile(new URL(`../${relative}`, import.meta.url), 'utf8');

const { createFavoritesStore, favoriteKeyOf, FAVORITES_FILE, FAVORITES_VERSION, MAX_FAVORITES } = await import('./favorites.mjs');

const local = (over = {}) => ({
  id: 'track-abc', title: '恋人', artist: '李荣浩', album: '黑马', duration: 276, sourceKind: 'local', ...over,
});
const online = (over = {}) => ({
  id: 'on-netease-27699577', title: '恋人', artist: '李荣浩', album: '黑马', durationMs: 276000, sourceKind: 'online', ...over,
});

async function withStore(run) {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'rhine-favs-'));
  try {
    return await run({ store: createFavoritesStore({ dataDir }), dataDir, file: path.join(dataDir, FAVORITES_FILE) });
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
}

// ── ① 键 ─────────────────────────────────────────────────────────────────────

test('R130 键是内容指纹：本地与在线的同一首歌算出同一个键', () => {
  assert.equal(favoriteKeyOf(local()), favoriteKeyOf(online()), '同一首的两种载体要成一条收藏，不是两条');
  assert.equal(favoriteKeyOf(local()), favoriteKeyOf(local({ id: 'track-完全不同' })), '换 id（重扫/挪目录）不该换键——键是内容指纹');
  assert.notEqual(favoriteKeyOf(local()), favoriteKeyOf(local({ title: '恋人 (Live)' })), '版本标记参与区分（与 normalizeTitleForMatch 同一取向）');
  assert.notEqual(favoriteKeyOf(local()), favoriteKeyOf(online({ durationMs: 277000 })), '整秒不同就是另一条：宁可多一条也不并错一条');
  // 秒与毫秒的换算要一致：本地 276.4 秒与在线 276400 毫秒都折到 276
  assert.equal(favoriteKeyOf(local({ duration: 276.4 })), favoriteKeyOf(online({ durationMs: 276400 })));
});

// ── ② 存储：往返、串行、坏文件、上限 ─────────────────────────────────────────

test('R130 toggle 往返与落盘：文件在数据目录里、原子写不留临时文件、内容是自解释的快照', async () => {
  await withStore(async ({ store, file }) => {
    assert.equal(await store.has(local()), false, '空清单里当然没有');
    const added = await store.toggle(local());
    assert.deepEqual({ liked: added.liked, count: added.count }, { liked: true, count: 1 });
    assert.equal(await store.has(local()), true);
    assert.equal(await store.has(online()), true, '在线那份也算同一首（键是内容指纹）');
    const saved = JSON.parse(await readFile(file, 'utf8'));
    assert.equal(saved.version, FAVORITES_VERSION);
    assert.equal(saved.items[0].title, '恋人', '快照要能回答"这条收藏的是哪首"，不留一串不可解释的哈希');
    assert.equal(saved.items[0].trackId, 'track-abc');
    const removed = await store.toggle(local());
    assert.deepEqual({ liked: removed.liked, count: removed.count }, { liked: false, count: 0 });
    const leftovers = (await readdir(path.dirname(file))).filter((name) => name.endsWith('.tmp'));
    assert.deepEqual(leftovers, [], '原子写不许留临时文件');
  });
});

test('R130 连点不丢：并发 toggle 走同一条串行链，且一次抛错不会把链卡死', async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'rhine-favs-'));
  try {
    const store = createFavoritesStore({ dataDir, limit: 24 });
    const batch = Array.from({ length: 20 }, (unused, index) => local({ title: `第 ${index} 首` }));
    const results = await Promise.all(batch.map((track) => store.toggle(track)));
    assert.equal(results.filter((result) => result.liked).length, 20, '每一次都得算"新增"');
    assert.equal((await store.list()).length, 20, '一条都不能被并发吃掉（读-改-写必须串行）');
    assert.equal(results[19].count, 20, '最后那条回执要数得对');
    // 到上限：抛，且**不静默截断**
    await store.toggle(local({ title: '第 20 首' }));
    await store.toggle(local({ title: '第 21 首' }));
    await store.toggle(local({ title: '第 22 首' }));
    await store.toggle(local({ title: '第 23 首' }));
    await assert.rejects(() => store.toggle(local({ title: '再多一条' })), /上限 24 条/);
    // 链上抛过错之后仍要能走 —— "永不落地的锁"那一课的正面判据
    const after = await store.toggle(local({ title: '第 0 首' }));
    assert.equal(after.liked, false, '取消那条已有的：说明读-改-写还在正常跑');
    assert.equal(after.count, 23);
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});

test('R130 坏文件与陌生版本：当没有、重建，不崩也不静默合并', async () => {
  await withStore(async ({ store, file }) => {
    await store.toggle(local({ title: '先存一条' }));
    await writeFile(file, '{这不是 JSON', 'utf8');
    assert.deepEqual(await store.list(), [], '读不懂就当没有（下一次写会覆盖成合法结构）');
    await writeFile(file, JSON.stringify({ version: 999, items: [{ key: 'x' }] }), 'utf8');
    assert.deepEqual(await store.list(), [], '版本不认识不静默合并——那会把陌生结构里的东西当成自己的');
    const back = await store.toggle(local());
    assert.equal(back.count, 1, '重建之后从空清单开始');
  });
});

// ── ③ 路由与界面同源 ─────────────────────────────────────────────────────────

test('R130 路由：GET 清单 / POST check / POST toggle，缺字段与陌生动作都不写盘', async () => {
  delete process.env.MUSICBRAINZ_CONTACT;   // 自检离线纪律：建真实曲库前先清掉联系方式（否则资料补全会真出网）
  const { createMusicServer } = await import('./music-server.mjs');
  const { MusicLibraryStore } = await import('./music-library.mjs');
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'rhine-favs-route-'));
  const rootsDir = await mkdtemp(path.join(os.tmpdir(), 'rhine-favs-roots-'));
  const store = await new MusicLibraryStore({ dataDir, defaultRoots: [rootsDir] }).init();
  const { server } = await createMusicServer({
    store, autoScan: false,
    bridgeClient: { status: () => ({ phase: 'off', port: 0, backends: [], unauthorized: 0, restarts: 0, lastError: null, hosts: [] }), call: async () => ({ ok: false }), ensure: async () => {}, shutdown: async () => {} },
    onlineLyricsMatcher: { match: async () => ({ matched: false }), clearCache: () => {} },
    onlineAudioSource: { resolve: async () => ({ ok: false, reason: '未配置' }) },
    onlineStreamFetcher: async () => { throw new Error('不该走到这里') },
    onlineSearcher: { search: async () => { throw new Error('不该走到这里') } },
  });
  try {
    // R211（B 类 · favorites 四处同款）：listen 与"等服务起来"整体交给 listenAndReady（连不上就关掉这台、换端口重听）；
    // 泄漏本来就被 try/finally 堵着（R190 那一族），这一格是把形状统一。
    const { origin } = await listenAndReady(server);
    const post = (body) => fetch(`${origin}/api/favorites`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
    });
    const empty = await (await fetch(`${origin}/api/favorites`)).json();
    assert.deepEqual(empty.items, []);
    assert.equal(empty.limit, MAX_FAVORITES, '上限要报得出来，界面才说得出"还能收多少"');
    assert.equal((await post({ action: 'check', track: local() })).status, 200);
    const checked = await (await post({ action: 'check', track: local() })).json();
    assert.equal(checked.liked, false);
    assert.equal(typeof checked.key, 'string', 'check 也回键：界面拿它做本地一致更新，不自己算');
    const toggled = await (await post({ action: 'toggle', track: local() })).json();
    assert.equal(toggled.liked, true);
    assert.equal((await (await post({ action: 'check', track: local() })).json()).liked, true);
    assert.equal((await post({ action: 'wipe-everything', track: local() })).status, 400, '陌生动作一律拒');
    assert.equal((await post({ action: 'toggle', track: { title: '  ', artist: '某人' } })).status, 400, '缺曲名就没法算键，不写');
    assert.equal((await (await post({ action: 'check', track: local() })).json()).liked, true, '被拒的两次不该动清单');
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    await rm(dataDir, { recursive: true, force: true });
    await rm(rootsDir, { recursive: true, force: true });
  }
});

test('R130 岛内那颗按得动：曲目分类要显式给，收藏判据要认本机清单（两处都是真机抓出来的）', async () => {
  const app = await read('src/music-app.ts');
  // 上游 getPlaybackSourceRef 的兜底分支是"认不出来就当在线曲目"，而在线曲目按平台侧喜欢判 ⇒
  // 不显式给 sourceRef，本地曲目在岛里也被判成 online，收藏那颗恒灰。
  assert.match(app, /sourceRef: track\.sourceKind === "online"/, 'SongResult 要显式带 sourceRef');
  assert.match(app, /\{ kind: "local", mediaId: track\.id \}/, '本地曲目 = local');
  const omni = await read('src/folia/services/onlineMusic/omni.ts');
  assert.match(omni, /canLikeSong: \(_song: SongResult \| null \| undefined\): boolean => true/,
    '收藏是本机清单，与平台侧喜欢无关（R30 那个恒 false 会把岛里的入口永久置灰）');
  assert.match(omni, /R130 改了其中一格/, '改动的理由必须写在文件里，不许看起来像"顺手打开"');
});

test('R130 收藏是本机数据：模块零出网依赖；R135 之后"第三方地址不出服务端"这条红线改钉在响应上', async () => {
  const source = await readScript('favorites.mjs');
  assert.doesNotMatch(source, /guardedFetch|https?:\/\/[^'"\s]+\.(?:com|net)\//, '收藏模块不碰网络');
  assert.match(source, /writeJsonAtomic/, '写盘只有那一个原子写出处');
  // Q11（批复）改了口径：清单文件里**可以**有那条第三方封面地址（与 sidecar 同口径，本机可读可删），
  // 所以判据不再是"文件里没有 http"，而是"它只能由服务端反解出来、且任何一份 HTTP 响应里都没有它"。
  await withStore(async ({ store, file }) => {
    await store.toggle(online({ title: '同一首', coverUrl: 'https://p1.music.126.net/abc.jpg' }));
    const saved = await readFile(file, 'utf8');
    assert.doesNotMatch(saved, /music\.126\.net/,
      '前端送来的 coverUrl 是**同源地址**，不是第三方地址；这一条不许被当成 coverRef 直接落盘');
    await store.toggle(online({ title: '另一首', coverRef: 'https://p1.music.126.net/abc.jpg' }));
    const withRef = JSON.parse(await readFile(file, 'utf8'));
    assert.equal(withRef.items[1].coverRef, 'https://p1.music.126.net/abc.jpg',
      '服务端反解出来的那条才写进清单（字段由 snapshotOf 白名单控制，不是整份展开）');
    assert.doesNotMatch(JSON.stringify(withRef.items[0]), /coverRef/, '没反解出来的那条不该有这个字段');
  });
});

test('R130 两个入口同一个动作：aria-pressed 只有一个写处，读数不知道时禁用而不是画成未收藏', async () => {
  const app = await read('src/music-app.ts');
  assert.match(app, /case "favorite-toggle":[\s\S]{0,160}void toggleFavorite\(\)/, '传输区那颗走 toggleFavorite');
  assert.match(app, /toggleSongLike: \(\) => void toggleFavorite\(\)/, '岛内那颗走同一个函数（两个入口一个动作）');
  const sync = /function syncFavoriteButton\(\)[\s\S]*?\n}/.exec(app);
  assert.ok(sync, '没抓到 syncFavoriteButton');
  assert.equal([...app.matchAll(/setAttribute\("aria-pressed", String\(favoriteLiked/g)].length, 1, 'pressed 只有一处写');
  assert.match(sync[0], /button\.disabled = !known \|\| !hasTrack \|\| favoritePending/, '不知道（清单读失败）或没放歌时禁用，而不是画成"未收藏"');
  assert.match(sync[0], /"收藏（先放一首歌）"/, '"没放歌"与"清单读不到"要分开说（都写成读不到就是把没做的事说成做不了）');
  assert.match(app, /if \(token !== favoriteCheckToken\) return/, '换歌换得快时旧回执不许覆盖新的');
  assert.match(app, /if \(\(state\.currentTrack\?\.id \?\? ""\) !== favoriteTrackId\)/, '只在换歌那一次问服务端（这个函数每次状态推送都跑）');
  assert.match(app, /islandHandle\?\.setSongLiked\(favoriteLiked === true\)/, '岛里那份读数由宿主推，岛不自存一份');
});

test('R130 岛内控制槽：能服务的真接上，服务不了的仍说"由宿主提供"（不许一律画成可用）', async () => {
  const slot = await import('../src/folia/components/floating-player/playerControlSlotActions.ts');
  const context = {
    loopMode: 'one', onToggleLoop: () => {}, onPrev: () => {}, onNext: () => {},
    canPrev: true, canNext: false, onShuffle: () => {}, canShuffle: true,
    onLike: () => {}, isLiked: true, likeDisabled: false, onToggleTimeline: () => {}, hasLyrics: false,
    invokeCommandById: () => {}, canInvokeCommandById: () => false,
  };
  const like = slot.resolvePlayerControlSlot('like', context);
  assert.equal(like.disabled, false, '收藏在岛里是**按得动**的（这正是 R130 要补的那一格）');
  assert.equal(like.active, true, '已收藏要有高亮，否则用户看不出按没按上');
  assert.equal(like.onActivate, context.onLike, '动作转交 provider，不在这里另实现一份');
  assert.equal(like.labelKey, 'player.unlike', '已收藏时话要说"取消收藏"');
  const loopAll = slot.resolvePlayerControlSlot('loop', context);
  const loopOff = slot.resolvePlayerControlSlot('loop', { ...context, loopMode: 'off' });
  assert.notEqual(loopAll.icon, loopOff.icon, '单曲循环与列表循环要换图标（同一颗只靠高亮区分，墙上看不出是哪一档）');
  assert.equal(loopAll.active, true);
  assert.equal(loopOff.active, false);
  assert.equal(slot.resolvePlayerControlSlot('next', context).disabled, true, 'canNext 为假就还是禁用（内核说没有下一首就是没有）');
  for (const id of ['volume', 'queue', 'sleep-timer', 'lyrics-timeline', 'song-wall', '不认识的']) {
    const resolved = slot.resolvePlayerControlSlot(id, context);
    assert.equal(resolved.disabled, true, `${id} 本产品不服务，必须仍是禁用槽`);
    assert.equal(resolved.labelKey, 'ui.unavailable', `${id} 要说实话：该控件由宿主提供`);
  }
});

test('R130 传输区那颗按钮在位，且岛里第二槽位默认值改到收藏（时间轴面板没移植，那颗恒空）', async () => {
  const app = await read('src/music-app.ts');
  assert.match(app, /data-action="favorite-toggle" id="favorite-toggle"/, '传输区有这颗');
  assert.match(app, / disabled>\$\{icons\.heart\}/, '初始 disabled：还没问服务端之前不许让人点');
  const css = await read('src/music.css');
  assert.match(css, /\.transport-favorite\[data-liked="true"\] svg path \{\s*fill: currentColor/, '已收藏 = 实心心');
  const store = await read('src/folia/stores/usePlayerChromeSettingsStore.ts');
  assert.match(store, /PLAYER_CONTROL_SLOT_SECONDARY_STORAGE_KEY,\s*'like',/, '岛内第二槽位默认收藏');
  assert.doesNotMatch(store, /DEFAULT_PLAYER_CONTROL_SLOT_SECONDARY/, '不再用上游那个"时间轴"默认值（该子系统未移植，那颗按了没东西）');
});

// ── R132 收藏列表视图（把上面那条功能闭环）───────────────────────────────────

const { favoriteView } = await import('./favorites.mjs');
const { favoritesMarkup, favoriteBadge, favoriteClock } = await import('../src/favorites-ui.ts');

const libraryTrack = (over = {}) => ({
  id: 'track-abc', albumId: 'album-1', title: '恋人', artist: '李荣浩', album: '黑马', duration: 276, ...over,
});
const storedLocal = (over = {}) => ({
  key: favoriteKeyOf(local()), addedAt: 1, title: '恋人', artist: '李荣浩', album: '黑马',
  durationMs: 276000, sourceKind: 'local', trackId: 'track-abc', ...over,
});

test('R132 视图 · 本地条目按指纹回曲库查：查到给真 id 与专辑，查不到明写原因（不隐藏、不装可播）', () => {
  const view = favoriteView({ items: [storedLocal()], tracks: [libraryTrack()] });
  assert.equal(view.total, 1);
  assert.equal(view.playable, 1);
  assert.equal(view.missing, 0);
  assert.equal(view.items[0].trackId, 'track-abc', '给的是曲库里**现在**那个 id（收藏快照里那个可能已经过期）');
  assert.equal(view.items[0].albumId, 'album-1', '专辑 id 也要给：封面按专辑那张画，不按曲目造地址');
  assert.equal(view.items[0].inLibrary, true);

  // 收藏之后文件被删 / 根目录被移出曲库 ⇒ 同一首查不到了。这条必须**留在清单里**并说清原因。
  // （注意：换 id 不换指纹，所以这里改的是**内容**——只改 id 的那条判据在上一段已经钉过了。）
  const gone = favoriteView({ items: [storedLocal()], tracks: [libraryTrack({ title: '另一首歌' })] });
  assert.equal(gone.total, 1, '查不到不许把这条藏掉（藏起来用户以为收藏丢了）');
  assert.equal(gone.playable, 0);
  assert.equal(gone.missing, 1);
  assert.equal(gone.items[0].playable, false);
  assert.equal(gone.items[0].inLibrary, false);
  assert.equal(gone.items[0].reason, '文件已不在曲库', '原因要说得出这一句，不写"未知"');

  // 认的是**指纹**而不是快照里那个 id：快照的 trackId 就算已经过期（重扫换过 id），
  // 内容对得上就还能播，而且给的是曲库里现在那个新 id —— 反过来（按 id 认）会把另一首歌当成收藏的那首。
  const staleId = favoriteView({ items: [storedLocal({ trackId: 'track-八百年前的' })], tracks: [libraryTrack()] });
  assert.equal(staleId.items[0].playable, true, '快照里的 id 过期不该让这条收藏变成播不了');
  assert.equal(staleId.items[0].trackId, 'track-abc', '交出去的是曲库里现在那个 id');

  // 同一指纹命中两首（同一张碟的两个副本）：留第一首，不重复排进队列
  const twice = favoriteView({
    items: [storedLocal()],
    tracks: [libraryTrack({ id: 'track-a' }), libraryTrack({ id: 'track-b' })],
  });
  assert.equal(twice.items[0].trackId, 'track-a');
});

test('R132 视图 · 在线条目只认 on-<来源>-<媒体 id>，播放地址由服务端签发（不猜、不让前端拼）', () => {
  const ok = favoriteView({ items: [storedLocal({ sourceKind: 'online', trackId: 'on-netease-27699577' })], tracks: [] });
  assert.equal(ok.items[0].playable, true, '在线条目谈不到"在不在曲库"，有身份就可播');
  assert.equal(ok.items[0].inLibrary, undefined, 'inLibrary 只对本地行有意义，在线行不给这个字段');
  // R225：这条同源地址现在也带 `t`/`a` 了（曲名/歌手来自收藏快照 ⇒ 收藏里的一首在线歌同样能回落）。
  // 旧形状是逐字相等的两个参数；**要求没变**（服务端签发、同源、来源与媒体 id 就是那两个），
  // 所以改成按参数判而不是把新形状抄成一条更长的字面量。
  const signed = new URL(ok.items[0].online.audioUrl, 'http://127.0.0.1');
  assert.equal(signed.pathname, '/api/online/stream', '还是那条同源中转地址');
  assert.equal(signed.searchParams.get('p'), 'netease');
  assert.equal(signed.searchParams.get('id'), '27699577');
  assert.equal(signed.origin, 'http://127.0.0.1', '除同源外不许有任何主机');
  assert.equal(signed.searchParams.get('t'), '恋人', '身份来自快照那一份（与搜索结果同一出处）');
  assert.equal(signed.searchParams.get('a'), '李荣浩');
  assert.equal(ok.items[0].online.id, 'on-netease-27699577');
  assert.equal(ok.items[0].online.coverUrl, '', 'v1 在线行没有封面 ⇒ 空串（界面画既有占位）');
  assert.doesNotMatch(JSON.stringify(ok), /https?:\/\//, '视图里不许出现任何第三方地址');

  const weird = favoriteView({ items: [storedLocal({ sourceKind: 'online', trackId: '不认识的形状' })], tracks: [] });
  assert.equal(weird.items[0].playable, false, '认不出身份就是播不了，不猜"最接近的那条"');
  assert.match(weird.items[0].reason, /在线身份不认识/);

  const unsupported = favoriteView({ items: [storedLocal({ sourceKind: 'online', trackId: 'on-taobao-1' })], tracks: [] });
  assert.equal(unsupported.items[0].playable, false, '来源不在音源白名单里 ⇒ 拒（判据来自 toOnlineTrack，不抄第二份）');
  assert.match(unsupported.items[0].reason, /不支持的音源：taobao/);
});

test('R132 视图 · 计数与上限要报得出来（抬头那行与"播放全部"共用它）', () => {
  const view = favoriteView({
    items: [
      storedLocal(),
      storedLocal({ key: 'k2', title: '第二首', trackId: 'track-没了' }),
      storedLocal({ key: 'k3', title: '第三首', sourceKind: 'online', trackId: 'on-qq-1' }),
    ],
    tracks: [libraryTrack()],
    limit: 7,
  });
  assert.deepEqual({ total: view.total, playable: view.playable, missing: view.missing, limit: view.limit },
    { total: 3, playable: 2, missing: 1, limit: 7 });
});

test('R132 路由 GET /api/favorites/view：现算索引、空曲库时如实说"都不在曲库"', async () => {
  delete process.env.MUSICBRAINZ_CONTACT;   // 自检离线纪律：建真实曲库前先清掉联系方式
  const { createMusicServer } = await import('./music-server.mjs');
  const { MusicLibraryStore } = await import('./music-library.mjs');
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'rhine-fav-view-'));
  const rootsDir = await mkdtemp(path.join(os.tmpdir(), 'rhine-fav-view-roots-'));
  const store = await new MusicLibraryStore({ dataDir, defaultRoots: [rootsDir] }).init();
  const favorites = createFavoritesStore({ dataDir });
  await favorites.toggle(local());
  const { server } = await createMusicServer({
    store, autoScan: false, favorites,
    bridgeClient: { status: () => ({ phase: 'off', port: 0, backends: [], unauthorized: 0, restarts: 0, lastError: null, hosts: [] }), call: async () => ({ ok: false }), ensure: async () => {}, shutdown: async () => {} },
    onlineLyricsMatcher: { match: async () => ({ matched: false }), clearCache: () => {} },
    onlineAudioSource: { resolve: async () => ({ ok: false, reason: '未配置' }) },
    onlineStreamFetcher: async () => { throw new Error('不该走到这里') },
    onlineSearcher: { search: async () => { throw new Error('不该走到这里') } },
  });
  try {
    // R211（B 类 · favorites 四处同款）：listen 与"等服务起来"整体交给 listenAndReady（连不上就关掉这台、换端口重听）；
    // 泄漏本来就被 try/finally 堵着（R190 那一族），这一格是把形状统一。
    const { origin } = await listenAndReady(server);
    const view = await (await fetch(`${origin}/api/favorites/view`)).json();
    assert.equal(view.total, 1);
    assert.equal(view.playable, 0, '空曲库里那条本地收藏当然播不了——这一格必须是 0，不能靠"未知"糊过去');
    assert.equal(view.items[0].reason, '文件已不在曲库');
    assert.equal(view.limit, MAX_FAVORITES);
    assert.equal((await fetch(`${origin}/api/favorites/view`, { method: 'POST' })).status, 404,
      '这份视图是只读的：路由把非 GET 直接留在"没有这条路由"上（写只走 /api/favorites 那一个出口）');
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    await rm(dataDir, { recursive: true, force: true });
    await rm(rootsDir, { recursive: true, force: true });
  }
});

test('R132 markup · 格子数 = CSS 列数，播不了的行不给点击，封面只画专辑那张（不造地址）', async () => {
  const view = favoriteView({
    items: [storedLocal(), storedLocal({ key: 'k2', title: '没了的那首', trackId: 'track-没了' })],
    tracks: [libraryTrack()],
  });
  const markup = favoritesMarkup(view, { coverOf: (row) => (row.albumId === 'album-1' ? '/api/artwork/album-1?v=9' : '') });
  const rows = [...markup.matchAll(/<div class="favorite-entry/g)].length;
  // 数格子不能要求 `class="…"` 正好收尾：徽标那一格会带 ` ready` 后缀（要求收尾就少算一格，
  // 于是"格子数=列数"这条判据自己先错了——上一批 S 系列就栽在类似的锚点上）。
  const cells = [...markup.matchAll(/<span class="favorite-entry-[a-z]+/g)].length;
  const css = await read('src/music.css');
  const rule = /\.favorite-entry \{[^}]*\}/.exec(css);
  assert.ok(rule, '没抓到 .favorite-entry 规则');
  const columns = (/\bgrid-template-columns:([^;]*);/.exec(rule[0])?.[1] ?? '')
    .replace(/\([^)]*\)/g, '').trim().split(/\s+/).filter(Boolean).length;
  assert.equal(columns, 5);
  assert.equal(cells, rows * columns, `格子数该等于列数：实测 ${cells} 格 / ${rows} 行 / ${columns} 列`);
  const actions = /\.favorite-entry-actions \{[^}]*\}/.exec(css);
  assert.ok(actions, '没抓到动作列规则');
  assert.match(actions[0], /display: flex/);

  assert.match(markup, /src="\/api\/artwork\/album-1\?v=9"/, '本地行走专辑那张既有封面');
  assert.match(markup, /<span class="cover-placeholder">♪<\/span>/, '没封面的画既有占位');
  assert.doesNotMatch(markup, /\/api\/artwork\/track-/, '绝不按曲目 id 造一个会 404 的地址（F3 那条判据）');
  assert.match(markup, /<div class="favorite-entry" data-action="favorite-play"[\s\S]*?<button class="favorite-open" data-action="favorite-play"/,
    '可播的行：整行可点 + 里面那颗键盘可达');
  // 两条一起数：可播那一行 = 行 + 里面那颗 = 2 次；播不了的那一行**两处都不挂**（挂了就是"点了没反应"）。
  assert.equal([...markup.matchAll(/data-action="favorite-play"/g)].length, 2,
    '播放动作只出现在可播的那一行');
  const goneRow = /<div class="favorite-entry is-gone">([\s\S]*?)<\/div><\/div>/.exec(markup);
  assert.ok(goneRow, '没抓到播不了那一行');
  assert.match(goneRow[1], /<button class="favorite-open"[^>]*disabled/, '里面那颗是禁用的');
  assert.match(goneRow[1], /文件已不在曲库/, '灰显那一行要说出原因');
  assert.match(goneRow[1], /data-action="favorite-remove"/, '但仍能取消收藏（不然清不掉）');
  assert.match(markup, /data-action="favorite-play-all"/);
  assert.match(markup, /共 2 条 · 可播 1 条 · 1 条播不了 · 上限 10000 条/, '抬头那句要数得对');
  assert.match(markup, /播放全部（1 条可播）/, '按钮上写的条数 = 可播条数，不是总条数');
  // 状态格写的是"这条收藏存在哪些载体"，不是"已收藏"（这一屏每一条都是收藏，写已收藏等于没写）。
  // Q14 起每一枚载体是一个 `<em>`（两枚装在**同一格**里，格子数仍是 5）。
  assert.match(markup, /class="favorite-entry-badge ready"><em>本地<\/em><\/span>/, '可播的本地行 = 一枚本地');
  assert.doesNotMatch(markup, /favorite-entry-badge[^>]*>已收藏/, '不许拿"已收藏"当状态（整屏都是收藏，那格要说真区别）');
  // 那句"按什么认"必须与 favoriteKeyOf 实际吃进去的字段一致（R135/Q12：专辑不参与键）
  assert.match(markup, /按「曲名 · 歌手 · 时长」认/, '文案不许承诺做不到的识别口径');
  assert.doesNotMatch(markup, /曲名 · 歌手 · 专辑 · 时长/, '专辑不参与键了（Q12 批复），这句话不许退回去');
  assert.match(markup, /同一首歌的本地与在线是一条收藏/, 'Q12 换来的那一格要正面说出来');
  assert.match(markup, /极少数同名同长但不同录音的会被并成一条/, '代价也要写在同一句里，不能只报好处');
});

test('R132 markup · 空清单与陌生原因各说各话，清单里的文本一律转义', () => {
  const empty = favoritesMarkup({ total: 0, playable: 0, missing: 0, limit: 10000, items: [] });
  assert.match(empty, /还没有收藏/, '空态要教下一步（去哪儿收藏）');
  assert.match(empty, /data-action="favorite-play-all" disabled/, '一条都没有时"播放全部"是禁用的');
  assert.equal(favoriteBadge({ playable: false, sourceKind: 'local' }), '暂时播不了',
    '服务端没给原因时也不许编一个具体原因');
  const injected = favoritesMarkup({
    total: 1, playable: false, missing: 1, limit: 10000,
    items: [{
      key: 'k', addedAt: 0, title: '<img src=x onerror=alert(1)>', artist: 'a', album: '',
      durationMs: 0, sourceKind: 'local', playable: false, reason: '<script>bad</script>',
    }],
  });
  assert.doesNotMatch(injected, /<img src=x|<script>bad/, '标题与原因都经过转义（清单是本机可读可改的文件）');
  assert.equal(favoriteClock(0), '--:--', '时长 0/未知不写成 0:00（那是把"不知道"说成"知道"）');
  assert.equal(favoriteClock(276000), '4:36');
});

test('R132 接线：入口在导航栏、队列全量入队、回执读内核长度、行下标先换算成队列下标', async () => {
  const app = await read('src/music-app.ts');
  assert.match(app, /data-action="favorites" aria-label="收藏"/, '导航栏那一项与 音乐库/搜索/歌单 并列');
  assert.match(app, /"playlists" \| "playlist" \| "artist" \| "favorites"/, 'Panel 类型里有这一档');
  assert.match(app, /favorites: \["FAVORITES", "收藏"\]/, '标题走同一张表（不另起一份文案）');
  assert.match(app, /if \(next === "favorites"\) void renderFavoritesPanel\(\);/, '开面板真的去渲染');
  assert.match(app, /if \(panel !== "favorites"\) return/, '读回来的那一刻若已换页就不许覆盖新画面');
  // R114 那两条：全量入队 + 回执读内核实际长度。
  // **必须把判据圈在收藏那一个函数体里**：`playPlaylistFromDetail` 里有一行逐字相同的
  // `player.play(start.id, tracks)`，全文件搜会把"改坏了收藏这一处"判成绿的（变异第一轮就这么漏过三条）。
  const favPlay = /async function playFavoritesFromView\(rowIndex\?: number\) \{[\s\S]*?\n\}/.exec(app);
  assert.ok(favPlay, '没抓到 playFavoritesFromView');
  assert.match(favPlay[0], /await player\.play\(start\.id, tracks\)/, '以收藏列表为队列起播（不是单曲队列）');
  assert.match(favPlay[0], /const queued = player\.state\.queue\.length;/, '条数读内核那份');
  assert.match(favPlay[0], /rows\.indexOf\(rowIndex\)/, '行下标 → 队列下标的换算在这条链上');
  assert.match(favPlay[0], /if \(view\.missing\) notes\.push\(/, '跳过了几条要写在回执里，不静默少歌');
  assert.match(app, /function favoritesQueue\(view: FavoritesView\): \{ tracks: MusicTrack\[\]; rows: number\[\] \}/,
    '队列与"第几行"必须一起算出来（只返回队列就会播错歌）');
  // 封面：界面不拼地址，只搬曲库快照里那张专辑的（F3 那条 404 老错的判据形状）
  const coverFn = /function favoriteCoverOf\(row: FavoriteRow\): string \{[\s\S]*?\n\}/.exec(app);
  assert.ok(coverFn, '没抓到 favoriteCoverOf');
  assert.doesNotMatch(coverFn[0], /api\/artwork/, '收藏这一侧不自己拼封面地址：没有就交给 coverImage 画占位');
  assert.match(coverFn[0], /\.coverUrl/, '读的是专辑快照里那个"有就有、没有就没有"的字段');
  for (const action of ['favorite-play-all', 'favorite-play', 'favorite-remove']) {
    assert.match(app, new RegExp(`target\\.dataset\\.action === "${action}"`), `缺 ${action} 的分支`);
  }
  assert.match(app, /void removeFavoriteAt\(Number\(target\.dataset\.favoriteIndex\)\)/);
  // 这两条也要圈在 removeFavoriteAt 里：`void renderFavoritesPanel()` 在开面板那处也有一遍，
  // 全文件搜等于没判（N16 第一轮就是这么漏的）。
  const removeFn = /async function removeFavoriteAt\(rowIndex: number\) \{[\s\S]*?\n\}/.exec(app);
  assert.ok(removeFn, '没抓到 removeFavoriteAt');
  assert.match(removeFn[0], /void refreshFavoriteState\(player\.state\.currentTrack\);/, '删完之后重问一次，不自作主张改那颗心的读数');
  assert.match(removeFn[0], /void renderFavoritesPanel\(\);/, '清单变了就重读视图（行号会整体前移）');
  assert.match(app, /id: "open-favorites", title: "打开收藏"/, '命令面板里也有这一项（表是唯一出处）');
  // 收藏模块仍然不碰网络：新增的 import 只是拿它签发同源地址
  const source = await readScript('favorites.mjs');
  assert.match(source, /from '\.\/bridge\/providers\/normalize\.mjs'/, '在线行复用 toOnlineTrack 那一个出处');
  assert.doesNotMatch(source, /guardedFetch|fetch\(/, '签发地址不等于出网');
});

// ── R135（Q11 + Q12）：键去掉专辑 + 收藏时存下服务端反解的封面地址 ──────────────

const { legacyFavoriteKeyOf, migrateFavoriteKeys } = await import('./favorites.mjs');

test('R135 键去掉专辑：同一首歌的本地与在线成一个键；代价如实是"同名同长就并条"', () => {
  assert.equal(favoriteKeyOf(online({ album: '黑马' })), favoriteKeyOf(online({ album: '另一张碟' })),
    '专辑不参与键 ⇒ 同一首歌的两种载体成一条收藏');
  assert.equal(favoriteKeyOf(local()), favoriteKeyOf(online({ album: '' })));
  // 代价：同名同歌手同长、但确实是两次不同录音 ⇒ 会被并成一条（界面同一句里写着这句话）
  assert.equal(favoriteKeyOf(local({ title: '恋人', artist: '李荣浩', duration: 276 })),
    favoriteKeyOf(local({ title: '恋人', artist: '李荣浩', duration: 276, album: '现场' })),
    '这就是批复里认下来的那笔代价，不是缺陷');
  // 旧键与新键的关系：迁移靠这个差别认出"这条还没迁过"
  assert.notEqual(legacyFavoriteKeyOf(online({ album: '黑马' })), favoriteKeyOf(online({ album: '黑马' })),
    '带专辑的旧条目：旧键 ≠ 新键 ⇒ 迁移认得出来');
  // 从前本地身份的实际形状（`MusicTrack` 没有 album 字段，前端送的就是这一份）：
  // 旧公式仍然把"空专辑"这一格拼进去 ⇒ 旧键 ≠ 新键，**本地那批旧条目也要迁**。
  // 这一格很重要：不迁的话视图的索引是新口径、清单里是旧口径，每一条都会显示成"文件已不在曲库"。
  const localIdentityPreQ12 = { id: 'track-abc', title: '恋人', artist: '李荣浩', duration: 276 };
  assert.notEqual(legacyFavoriteKeyOf(localIdentityPreQ12), favoriteKeyOf(localIdentityPreQ12),
    '空专辑也是一格 ⇒ 本地旧条目的键同样要改，迁移对全表都是必需的');
  assert.equal(favoriteKeyOf(localIdentityPreQ12), favoriteKeyOf(online({ album: '黑马' })),
    '并进来之后：本地与在线（专辑不同也一样）同键');
  const migratedLocal = migrateFavoriteKeys([{ key: legacyFavoriteKeyOf(localIdentityPreQ12), addedAt: 1, ...localIdentityPreQ12, durationMs: 276000 }]);
  assert.equal(migratedLocal.migrated, 1, '本地旧条目被认出来并改写');
  assert.equal(migratedLocal.items[0].key, favoriteKeyOf(localIdentityPreQ12));
});

test('R135 迁移：受身份保护、冲突留 addedAt 更早的、认不出的原样留着、可回放', () => {
  const onlineTrack = online({ album: '黑马' });
  const newKey = favoriteKeyOf(onlineTrack);
  const localItem = { key: favoriteKeyOf(local()), addedAt: 5000, ...local(), sourceKind: 'local' };
  const onlineItem = {
    key: legacyFavoriteKeyOf(onlineTrack), addedAt: 9000, title: '恋人', artist: '李荣浩', album: '黑马',
    durationMs: 276000, sourceKind: 'online', trackId: 'on-netease-27699577',
  };
  const handEdited = { key: '手改过的键', addedAt: 1, title: '某首', artist: '某人', durationMs: 1000, sourceKind: 'local' };

  const first = migrateFavoriteKeys([localItem, onlineItem, handEdited]);
  assert.equal(first.migrated, 1, '只有"旧键 == 用旧公式算出来的键"那条被改写');
  assert.equal(first.items.length, 2, '本地与在线并成一条 + 那条手改的');
  assert.equal(first.collisions.length, 1, '并条必须报出来，不许静默合并');
  assert.equal(first.collisions[0].kept.addedAt, 5000, '留 addedAt 更早的那条（那是用户第一次收藏的时刻）');
  assert.equal(first.collisions[0].dropped.title, '恋人', '被丢的那条要能指名道姓');
  assert.deepEqual(first.unknown, [{ key: '手改过的键', title: '某首' }], '认不出的键原样留着并单独报');
  assert.equal(first.items.find((item) => item.key === newKey).sourceKind, 'local', '并完留的是本地那条（更早）');
  assert.ok(first.items.some((item) => item.key === '手改过的键'), '认不出的那条不许被改掉或删掉');

  // 可回放：拿迁移结果再迁一次，什么都不改
  const again = migrateFavoriteKeys(first.items);
  assert.equal(again.migrated, 0, '第二次跑不该再改任何键');
  assert.equal(again.collisions.length, 0, '第二次跑没有新的并条');
  assert.deepEqual(again.items.map((item) => item.key).sort(), first.items.map((item) => item.key).sort());
});

test('R135 store.migrate：真写盘、只写一次、第二次不碰文件', async () => {
  await withStore(async ({ store, file }) => {
    const data = { version: FAVORITES_VERSION, items: [
      { key: legacyFavoriteKeyOf(online({ album: '黑马' })), addedAt: 9, title: '恋人', artist: '李荣浩', album: '黑马', durationMs: 276000, sourceKind: 'online', trackId: 'on-netease-1' },
      { key: favoriteKeyOf(local({ title: '别的' })), addedAt: 8, title: '别的', artist: '李荣浩', durationMs: 276000, sourceKind: 'local' },
    ] };
    await writeFile(file, JSON.stringify(data), 'utf8');
    const moved = await store.migrate();
    assert.equal(moved.wrote, true, '有东西要迁就得落盘');
    assert.equal(moved.migrated, 1);
    const saved = JSON.parse(await readFile(file, 'utf8'));
    assert.equal(saved.items[0].key, favoriteKeyOf(online({ album: '黑马' })), '文件里的键已经是新口径');
    assert.equal(saved.items[0].album, '黑马', '专辑只从键里拿掉，快照里照旧留着（界面要说这条是哪张碟）');
    assert.equal(await store.has(local({ title: '恋人' })), true, '迁完之后按新键问得到');
    const before = await readFile(file, 'utf8');
    const second = await store.migrate();
    assert.equal(second.wrote, false, '第二次不写盘（可回放 = 幂等）');
    assert.equal(second.migrated, 0);
    assert.equal(await readFile(file, 'utf8'), before, '第二次连字节都不许变');
  });
});

test('R135 路由：coverRef 只能由服务端反解出来，两份响应里都搜不到第三方地址', async () => {
  delete process.env.MUSICBRAINZ_CONTACT;   // 自检离线纪律：建真实曲库前先清掉联系方式
  const { createMusicServer } = await import('./music-server.mjs');
  const { MusicLibraryStore } = await import('./music-library.mjs');
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'rhine-fav-cover-'));
  const rootsDir = await mkdtemp(path.join(os.tmpdir(), 'rhine-fav-cover-roots-'));
  const store = await new MusicLibraryStore({ dataDir, defaultRoots: [rootsDir] }).init();
  const REF = 'https://p1.music.126.net/abcdef.jpg';
  const TOKEN = '/api/online/artwork/deadbeefdeadbeef';
  const covers = {
    register: (ref) => (ref === REF ? TOKEN : ''),
    coverRefFor: (token) => (token === 'deadbeefdeadbeef' ? REF : null),
    load: async () => null, size: () => 1, tokenOf: () => 'deadbeefdeadbeef', enabled: () => true,
  };
  const { server } = await createMusicServer({
    store, autoScan: false, trackCoverProvider: covers,
    bridgeClient: { status: () => ({ phase: 'off', port: 0, backends: [], unauthorized: 0, restarts: 0, lastError: null, hosts: [] }), call: async () => ({ ok: false }), ensure: async () => {}, shutdown: async () => {} },
    onlineLyricsMatcher: { match: async () => ({ matched: false }), clearCache: () => {} },
    onlineAudioSource: { resolve: async () => ({ ok: false, reason: '未配置' }) },
    onlineStreamFetcher: async () => { throw new Error('不该走到这里') },
    onlineSearcher: { search: async () => { throw new Error('不该走到这里') } },
  });
  try {
    // R211（B 类 · favorites 四处同款）：listen 与"等服务起来"整体交给 listenAndReady（连不上就关掉这台、换端口重听）；
    // 泄漏本来就被 try/finally 堵着（R190 那一族），这一格是把形状统一。
    const { origin } = await listenAndReady(server);
    const post = (body) => fetch(`${origin}/api/favorites`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
    });
    const file = path.join(dataDir, FAVORITES_FILE);
    // 前端只能给我们那条同源地址；服务端反解之后才落盘
    const added = await (await post({ action: 'toggle', track: {
      id: 'on-netease-1', title: '恋人', artist: '李荣浩', album: '黑马', durationMs: 276000,
      sourceKind: 'online', coverUrl: TOKEN,
    } })).json();
    assert.equal(added.liked, true);
    const saved = JSON.parse(await readFile(file, 'utf8'));
    assert.equal(saved.items[0].coverRef, REF, '反解出来的地址进了本机清单（与 sidecar 同口径）');
    const rawList = await (await fetch(`${origin}/api/favorites`)).text();
    assert.ok(rawList.includes('恋人'), '清单本身仍然读得到');
    assert.ok(!rawList.includes('music.126.net') && !rawList.includes('coverRef'),
      '原始清单**剥掉 coverRef** 才出去：第三方地址不出服务端');
    const view = await (await fetch(`${origin}/api/favorites/view`)).text();
    assert.ok(view.includes(TOKEN), '视图给的是同源 token 地址（收藏行因此有封面）');
    assert.ok(!view.includes('music.126.net'), '视图响应里也搜不到第三方地址');
    // 前端送一个反解不出的地址 ⇒ 不存这个字段（不猜、不把任意字符串当地址）
    await post({ action: 'toggle', track: {
      id: 'x', title: '另一首', artist: '某人', durationMs: 1000, sourceKind: 'online', coverUrl: 'https://evil.example/a.jpg',
    } });
    const after = JSON.parse(await readFile(file, 'utf8'));
    assert.equal(after.items[1].coverRef, undefined, '外链一律不接受：只有注册表里反解得出的才存');
    assert.ok(!JSON.stringify(after.items[1]).includes('evil.example'), '被拒的那条连落盘都没有');
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    await rm(dataDir, { recursive: true, force: true });
    await rm(rootsDir, { recursive: true, force: true });
  }
});

test('R135 启动即迁移：服务端起来就把旧键文件换成新键（这一步不只写在源码里）', async () => {
  delete process.env.MUSICBRAINZ_CONTACT;   // 自检离线纪律：建真实曲库前先清掉联系方式
  const { createMusicServer } = await import('./music-server.mjs');
  const { MusicLibraryStore } = await import('./music-library.mjs');
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'rhine-fav-mig-'));
  const rootsDir = await mkdtemp(path.join(os.tmpdir(), 'rhine-fav-mig-roots-'));
  const store = await new MusicLibraryStore({ dataDir, defaultRoots: [rootsDir] }).init();
  const file = path.join(dataDir, FAVORITES_FILE);
  // 一份"升级前"的清单：一条带专辑的旧键条目（本地，专辑为空也得换）+ 一条已经迁移过的
  await writeFile(file, JSON.stringify({ version: FAVORITES_VERSION, items: [
    { key: legacyFavoriteKeyOf(local({ album: '' })), addedAt: 5, title: '恋人', artist: '李荣浩',
      album: '', durationMs: 276000, sourceKind: 'local', trackId: 'track-abc' },
    { key: favoriteKeyOf(local({ title: '别的' })), addedAt: 6, title: '别的', artist: '李荣浩',
      album: '', durationMs: 200000, sourceKind: 'local', trackId: 'track-xyz' },
  ] }), 'utf8');
  const { server } = await createMusicServer({
    store, autoScan: false,
    bridgeClient: { status: () => ({ phase: 'off', port: 0, backends: [], unauthorized: 0, restarts: 0, lastError: null, hosts: [] }), call: async () => ({ ok: false }), ensure: async () => {}, shutdown: async () => {} },
    onlineLyricsMatcher: { match: async () => ({ matched: false }), clearCache: () => {} },
    onlineAudioSource: { resolve: async () => ({ ok: false, reason: '未配置' }) },
    onlineStreamFetcher: async () => { throw new Error('不该走到这里') },
    onlineSearcher: { search: async () => { throw new Error('不该走到这里') } },
  });
  try {
    // R211（B 类 · favorites 四处同款）：listen 与"等服务起来"整体交给 listenAndReady（连不上就关掉这台、换端口重听）；
    // 泄漏本来就被 try/finally 堵着（R190 那一族），这一格是把形状统一。
    const { origin } = await listenAndReady(server);
    const list = await (await fetch(`${origin}/api/favorites`)).json();
    assert.equal(list.items.length, 2, '启动迁移不该丢条目');
    const saved = JSON.parse(await readFile(file, 'utf8'));
    assert.equal(saved.items[0].key, favoriteKeyOf(local({ album: '' })),
      '旧键在启动那一刻就换成了新键——这条判据盯的是"真的跑了"，不是"源码里有这一行"');
    assert.equal(saved.items[1].key, favoriteKeyOf(local({ title: '别的' })), '已经迁过的那条例外不动（可回放）');
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    await rm(dataDir, { recursive: true, force: true });
    await rm(rootsDir, { recursive: true, force: true });
  }
});

test('R135 接线：界面送的是同源地址、视图那一路同一个换算、迁移在启动时跑一次', async () => {  const app = await read('src/music-app.ts');
  // **判据要圈在 `favoriteIdentity` 的函数体里**：`toFoliaSong` 里有一行逐字相同的
  // `...(track.coverUrl ? { coverUrl: track.coverUrl } : {})`（那是 R119 封面墙那一路），
  // 全文件搜就是"改坏了收藏这一处"照样绿（变异 A2 第一轮就这么漏过）。
  const identity = /function favoriteIdentity\(track: MusicTrack \| null \| undefined\): FavoriteIdentity \| null \{[\s\S]*?\n\}/.exec(app);
  assert.ok(identity, '没抓到 favoriteIdentity');
  assert.match(identity[0], /\.\.\.\(track\.coverUrl \? \{ coverUrl: track\.coverUrl \} : \{\}\)/,
    '收藏身份里带上同源封面地址（不是第三方那条）');
  const cover = /function favoriteCoverOf\(row: FavoriteRow\): string \{[\s\S]*?\n\}/.exec(app);
  assert.ok(cover, '没抓到 favoriteCoverOf');
  assert.match(cover[0], /row\.online\?\.coverUrl/, '在线行读服务端换回来的同源地址');
  assert.doesNotMatch(cover[0], /api\/artwork\/\$\{row\.(trackId|key)/, '界面不自己拼封面地址（F3 那条判据不变）');
  const server = await readScript('music-server.mjs');
  assert.match(server, /typeof favorites\.migrate === 'function'/, '启动时跑一次迁移（注入的假 store 可以没有）');
  assert.match(server, /并掉 \$\{moved\.collisions\?\.length \?\? 0\} 条/, '报告写进服务日志：并条不许静默');
  // 总数之外，明细那一行也得逐条写：只报"并掉 1 条"而不说并了哪两条，等于半静默（变异 S5 第一轮没咬的就是这里）。
  assert.match(server, /for \(const one of moved\.collisions \?\? \[\]\)/, '并掉的每一对都要在日志里点名');
  assert.match(server, /for \(const one of moved\.unknown \?\? \[\]\)/, '认不出的键也要逐条点名（原样留着不是没事了）');
  assert.match(server, /const publicFavoriteItem = \(\{ coverRef, \.\.\.rest \}\) => rest/, '剥字段的写法只有一个出处');
  assert.match(server, /coverUrlOf: \(coverRef\) => onlineTrackCovers\.register\(coverRef\)/, '视图那一路也走同一个换算');
});

test('Q14 批复 · 徽标说的是"这条收藏实际存在的载体集合"（本地/在线各自一枚、都有就两枚），且不跟随正在播的那首', async () => {
  // ① 在线收的、但指纹在曲库里查得到 ⇒ 两枚。这是 R135 并条之后真机暴露的那一格：
  //    从前徽标跟着快照走，"我明明本地也有"在界面上是隐形的。
  const both = favoriteView({
    items: [storedLocal({ sourceKind: 'online', trackId: 'on-netease-27699577' })],
    tracks: [libraryTrack()],
  });
  assert.deepEqual(both.items[0].carriers, ['local', 'online'], '载体集合按现算的两个判据给');
  assert.equal(both.items[0].playable, true, '在线那一份仍按它自己的身份可播（并条不改变可播性）');
  assert.equal(favoriteBadge(both.items[0]), '本地 · 在线', '文字版徽标两枚都写出来');
  const markup = favoritesMarkup({ ...both, limit: 10000 }, { coverOf: () => '' });
  assert.match(markup, /class="favorite-entry-badge ready"><em>本地<\/em><em>在线<\/em><\/span>/,
    '两枚要真的画成两枚（各占一枚 <em>）');
  // 两枚必须装在**同一格**里：那一行是 5 列网格，两个 span 会多占一列（R129 那一课）
  assert.equal([...markup.matchAll(/class="favorite-entry-badge/g)].length, both.items.length,
    '一行只有一格徽标（外面的容器只有一个）');
  // 判据不出现在正文里 —— 只能看结果：徽标那一格要能并排放两枚
  // （`music.css` 在本机是 CRLF，写 `\{\n` 这种锚点会假红——上一批就栽过这种锚点）
  assert.match(await read('src/music.css'), /\.favorite-entry-badge \{[^}]*display: inline-flex;[^}]*gap: 6px;/,
    '两枚之间要有间隔，不然"本地在线"连成一串读不出来');

  // ② 只有本地：文件在曲库、快照是本地收的 ⇒ 一枚
  const onlyLocal = favoriteView({ items: [storedLocal()], tracks: [libraryTrack()] });
  assert.deepEqual(onlyLocal.items[0].carriers, ['local']);
  assert.equal(favoriteBadge(onlyLocal.items[0]), '本地');
  // ③ 只有在线：曲库里没有这一首 ⇒ 一枚
  const onlyOnline = favoriteView({
    items: [storedLocal({ sourceKind: 'online', trackId: 'on-qq-1' })],
    tracks: [libraryTrack({ title: '另一首歌' })],
  });
  assert.deepEqual(onlyOnline.items[0].carriers, ['online']);
  assert.equal(favoriteBadge(onlyOnline.items[0]), '在线');
  // ④ 一枚都没有（文件不在了、清单里也没有在线身份）⇒ 徽标说原因，不是空白
  const gone = favoriteView({ items: [storedLocal()], tracks: [libraryTrack({ title: '另一首歌' })] });
  assert.deepEqual(gone.items[0].carriers, []);
  assert.equal(favoriteBadge(gone.items[0]), '文件已不在曲库');
  // ⑤ 两份不同的曲库看到的两枚是**同一份清单**算出来的：视图不读播放状态，所以列表不会随播放跳动
  const src = await readScript('favorites.mjs');
  assert.match(src, /export function favoriteView\(\{ items = \[\], tracks = \[\], limit = MAX_FAVORITES, coverUrlOf = \(\) => "" \} = \{\}\)/,
    '入参只有"清单 / 曲库 / 上限 / 封面换算"四样：没有播放状态 ⇒ 载体集合不可能跟着正在播的那首变');
  assert.doesNotMatch(src.split('export function favoriteView')[1].split('export function createFavoritesStore')[0],
    /playing|currentTrack|playerState/, '连读都不读播放状态（不跟才不跳）');
});
