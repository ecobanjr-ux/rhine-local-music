// 看板 ⑨（f700523）· 夜间批 六：在线按音乐人分组播放的自检。
//
// 这一条复用 ⑧ 的伪专辑机制（一组 = 一张伪专辑），所以判据也照 ⑧ 那三条硬要求来：
//   ① 架上只带行，**明细点开才取**（不在一次曲库刷新里养第二份真相）；
//   ② 整组播放必须**全量入队**，回执读**内核队列的实际长度**（R114 的教训原文：算出 279 条却只播一首、
//      回执还说 279）；
//   ③ 不伪造 genreId（会让"按流派统计"从此对不上账），保留分组只有一处名字来源。
// 全程离线：搜索与桥都是注入件，被调用就直接抛。
import test from 'node:test';
import { listenAndReady } from './check-ready.mjs';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPTS = dirname(fileURLToPath(import.meta.url));
const read = (relative) => readFile(new URL(`../${relative}`, import.meta.url), 'utf8');
const playlists = await import('./playlists.mjs');
const match = await import('./playlist-match.mjs');

const app = await read('src/music-app.ts');
const data = await read('src/data.ts');

const track = (provider, mediaId, title, artist, coverUrl = '') => ({
  id: `on-${provider}-${mediaId}`, sourceKind: 'online', provider, mediaId,
  title, artist, album: '某专', durationMs: 240000, quality: '自动',
  audioUrl: `/api/online/stream?p=${provider}&id=${mediaId}`, coverUrl,
});
const detail = (id, name, rows) => ({
  id, name,
  items: rows.map(([artist, title, mediaId]) => ({
    entry: { artist, title }, matched: Boolean(mediaId), track: mediaId ? track('netease', mediaId, title, artist) : null,
  })),
  matched: rows.filter((row) => row[2]).length, unmatched: rows.filter((row) => !row[2]).length,
});

// ── 分组纯函数 ────────────────────────────────────────────────────────────────

test('⑨ 分组：同名合并（首尾空白与**内部连续空白**都折叠）、没有歌手名的直接丢', () => {
  const got = playlists.onlineArtistGroups([
    detail('a', 'A 单', [
      ['李荣浩', '恋人', 'm1'], ['  李荣浩  ', '不将就', 'm2'],   // 首尾空白
      ['李  荣浩', '喜剧之王', 'm3'], ['李 荣浩', '年少有为', 'm4'], // 内部连续空白折叠成一个
      ['', '无名氏的曲子', 'm5'],
    ]),
  ]);
  assert.deepEqual(got.groups.map((group) => [group.name, group.tracks.length]),
    [['李荣浩', 2], ['李 荣浩', 2]],
    '折叠内部连续空白才不会被"李  荣浩 / 李 荣浩"算成两个人；但"李荣浩"与"李 荣浩"仍是两个键（不替用户猜哪个是对的）');
  assert.deepEqual(got.groups.map((group) => group.name).filter((name) => name.includes('未知')), [],
    '不许凭空造一个"未知歌手"组：第四期真机抓到过占位艺术家被当成真实歌手（P4 台账）');
});

test('⑨ 分组：只数已匹配的条目；同一首出现在两张单里只算一条', () => {
  const got = playlists.onlineArtistGroups([
    detail('a', 'A 单', [['甲', '一', 'same'], ['甲', '二', null]]),
    detail('b', 'B 单', [['甲', '一', 'same']]),
  ]);
  const group = got.groups[0];
  assert.equal(group.name, '甲');
  assert.equal(group.tracks.length, 1, '内核会按 id 去重 ⇒ 架上说的那个数字也得是真实曲数，否则"播放全部 2 条"队列只有 1 首（R114 那一类）');
  assert.deepEqual(group.playlists, ['A 单'], '来源歌单去重后只剩一张（这一首两张单里都有）');
  assert.equal(group.tracks[0].id, 'on-netease-same');
});

test('⑨ 分组：排序确定性（条数降序、并列按首次出现），上限与 omitted 各说各的', () => {
  const list = [
    detail('a', 'A 单', [['乙', '一', 'b1'], ['甲', '二', 'a1']]),
    detail('b', 'B 单', [['乙', '三', 'b2'], ['丙', '四', 'c1']]),
  ];
  const all = playlists.onlineArtistGroups(list, 99);
  assert.deepEqual(all.groups.map((group) => group.name), ['乙', '甲', '丙'],
    '并列按首次出现，不靠对象迭代顺序碰巧（同一输入两次结果不一致，架上的列就会每次刷新换个位置）');
  const cut = playlists.onlineArtistGroups(list, 2);
  assert.equal(cut.groups.length, 2);
  assert.equal(cut.omitted, 1, '被截断的组数要如实报出来，不许悄悄少一列');
  assert.equal(cut.limit, 2);
});

test('⑨ 架上那一行：只带行不带明细（点开才取），色块原料是文本不是 URL', () => {
  const group = playlists.onlineArtistGroups([detail('a', 'A 单', [['甲', '一', 'x1']])], 99).groups[0];
  const row = playlists.artistShelfRow(group);
  assert.deepEqual(Object.keys(row).sort(), ['coverSeeds', 'items', 'name', 'playlists', 'slug']);
  assert.equal(row.items, 1);
  assert.equal('tracks' in row, false, '明细不许混进行里（那是第二份真相，也是响应体积）');
  assert.deepEqual(row.coverSeeds, [{ title: '一', artist: '甲' }], '拼贴格按成员文本算色块，不冒充真封面（与 ⑧ 同一条边界）');
  assert.equal(playlists.artistShelfRow({ name: '甲', slug: '', tracks: [], playlists: [] }).slug, '', 'slug 由分组侧算好带过来');
});

// ── 路由 ─────────────────────────────────────────────────────────────────────

async function routeServer() {
  // 纪律扫描要求：凡构造真实 MusicLibraryStore 的自检都要先清掉这个环境变量，
  // 否则"本机有没有配 MusicBrainz 联系方式"会把结果改掉（同一类错在 check-music-playlists 里已经立过判据）。
  delete process.env.MUSICBRAINZ_CONTACT;
  const { createMusicServer } = await import('./music-server.mjs');
  const { MusicLibraryStore } = await import('./music-library.mjs');
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'rhine-artist-route-'));
  const rootsDir = await mkdtemp(path.join(os.tmpdir(), 'rhine-artist-roots-'));
  const store = await new MusicLibraryStore({ dataDir, defaultRoots: [rootsDir] }).init();
  const bridge = {
    status: () => ({ phase: 'off', port: 0, backends: [], unauthorized: 0, restarts: 0, lastError: null, hosts: [] }),
    call: async () => { throw new Error('架上的路由不该出网'); },
    ensure: async () => {}, shutdown: async () => {},
  };
  let searches = 0;
  const searcher = {
    search: async () => { searches += 1; throw new Error('架上的路由不该出网'); },
    searchEntries: async () => { searches += 1; throw new Error('架上的路由不该出网'); },
  };
  const { server } = await createMusicServer({
    store, distDir: SCRIPTS, autoScan: false, bridgeClient: bridge,
    onlineSearcher: searcher,
    onlineLyricsMatcher: { match: async () => ({ matched: false }), clearCache: () => {} },
    onlineAudioSource: { resolve: async () => ({ ok: false, reason: '未配置' }) },
    onlineStreamFetcher: async () => { throw new Error('不该走到这里'); },
    // 封面注册表注入一个"永远关着"的：这些路由只该读盘，签发与取图都不该发生。
    trackCoverProvider: { enabled: () => false, register: () => '', coverRefFor: () => null, load: async () => null },
  });
  // R198：listen 之后连不上就关掉重听（换端口）—— Windows 的 SO_REUSEADDR 会把连接送去别的持有者，
  // 退避重试治不了（真机实测过 9.6 秒连不上），换端口才治。断言不重试。
  const { origin } = await listenAndReady(server);
  return {
    origin, store, searches: () => searches,
    close: async () => {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
      await rm(dataDir, { recursive: true, force: true });
      await rm(rootsDir, { recursive: true, force: true });
    },
  };
}

/** 直接写"文本歌单 + sidecar 匹配缓存"两份，模拟用户已经匹配过（不靠出网）。 */
async function seed(route, name, rows) {
  const items = rows.map(([artist, title, mediaId]) => ({ artist, title }));
  const text = items.map((item) => `${item.title} - ${item.artist}`).join('\n') + '\n';
  const saved = await (await fetch(`${route.origin}/api/playlists`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action: 'create', name, text }),
  })).json();
  const id = saved.playlist.id;
  const file = route.store.playlists.matchFileOf(id);
  const entries = Object.create(null);
  for (const [index, [artist, title, mediaId]] of rows.entries()) {
    const key = match.entryKey({ title, artist, durationMs: '', album: '' });
    entries[key] = mediaId
      ? { ok: true, at: Date.now(), score: 100, track: track('netease', mediaId, title, artist), coverRef: '' }
      : { ok: false, at: Date.now(), reason: '最高分 10，低于阈值 75' };
  }
  await writeFile(file, JSON.stringify({ version: match.MATCH_SIDECAR_VERSION, playlist: id, entries }), 'utf8');
  return id;
}

test('⑨ shelf 路由：一次返回歌单行 + 音乐人行，全程零出网', async () => {
  const route = await routeServer();
  try {
    await seed(route, '甲的单', [['李荣浩', '恋人', 'm1'], ['李荣浩', '不将就', 'm2'], ['王菲', '传奇', 'm3']]);
    const shelf = await (await fetch(`${route.origin}/api/playlists/shelf`)).json();
    assert.equal(route.searches(), 0, '架上这两列全部读自本机（文本 + sidecar），一条网都不出');
    assert.equal(shelf.playlists.length, 1);
    assert.deepEqual(shelf.artists.map((row) => row.name), ['李荣浩', '王菲']);
    assert.equal(shelf.artists[0].items, 2);
    assert.equal(shelf.artists[0].playlists, 1, '要说得清这一组来自几张歌单（不是"平台给的歌手页"）');
    assert.equal(shelf.artistsOmitted, 0);
    assert.ok(shelf.artistsLimit > 0, '上限要随响应一起出去，界面那句"还有 N 位"才有依据');
    assert.equal(JSON.stringify(shelf).includes('audioUrl'), false, '架上那一行不含任何可播地址（明细点开才取）');
  } finally { await route.close(); }
});

test('⑨ 明细路由：按 slug 取一组，未知 slug 与"被截断的组"都要说人话', async () => {
  const route = await routeServer();
  try {
    await seed(route, '甲的单', [['李荣浩', '恋人', 'm1'], ['李荣浩', '不将就', 'm2'], ['陈奕迅', '十年', 'm4']]);
    const hit = await (await fetch(`${route.origin}/api/online/artists/${encodeURIComponent('李荣浩')}`)).json();
    assert.equal(hit.name, '李荣浩');
    assert.deepEqual(hit.playlists, ['甲的单']);
    assert.equal(hit.items.length, 2);
    assert.equal(hit.items[0].audioUrl, '/api/online/stream?p=netease&id=m1', '明细里给的是我们**自己签发**的同源中转地址');
    assert.equal(route.searches(), 0, '取明细也只读盘');
    // 架上被截断的组仍该取到：给一个 404 谎话比"取不到"更糟。
    const miss = await fetch(`${route.origin}/api/online/artists/${encodeURIComponent('查无此人')}`);
    assert.equal(miss.status, 404);
    const body = await miss.json();
    assert.match(body.error, /没有这个音乐人组/, '404 要说清是"本机歌单里没有他已匹配的条目"，不是"路径不存在"');
    const bad = await fetch(`${route.origin}/api/online/artists/${encodeURIComponent('../../etc/passwd')}`);
    assert.ok(bad.status === 400 || bad.status === 404, `非法标识要挡在外面（拿到 ${bad.status}）`);
  } finally { await route.close(); }
});

test('⑨ 没有已匹配的在线条目 ⇒ artists 是空数组（界面上那一列自然不出现，不造空组）', async () => {
  const route = await routeServer();
  try {
    await seed(route, '空的', [['李荣浩', '恋人', null]]);
    const shelf = await (await fetch(`${route.origin}/api/playlists/shelf`)).json();
    assert.deepEqual(shelf.artists, [], '一条都没匹配上 ⇒ 一个组都不该有');
    assert.equal(shelf.playlists.length, 1, '歌单那一行照旧在（它说的是"这张单有 1 条、1 条未匹配"）');
  } finally { await route.close(); }
});

// ── 前端形状（与 ⑧ 同构的三条讲究）──────────────────────────────────────────

test('⑨ 前端：第二张伪专辑走保留分组，不伪造 genreId；与歌单/真实专辑同一次排序', () => {
  const region = app.match(/function artistAlbum\(row: MusicOnlineArtistShelfRow\): MusicAlbum \{[\s\S]*?\n  \}/);
  assert.ok(region, '没抓到 artistAlbum（提取失败不许静默通过）');
  assert.match(region[0], /genreId: ONLINE_ARTIST_GROUP_ID/, '用保留分组这个键');
  assert.match(region[0], /id: artistAlbumId\(row\.slug\)/, 'id 带 artist: 前缀，点开与真实专辑共用同一处派发');
  assert.match(region[0], /tracks: \[\]/, '明细点开才取');
  assert.doesNotMatch(region[0], /coverUrl/, '架上不写封面 URL（按 id 造 artwork 地址是 F3 那条老错）');
  assert.match(app, /\.\.\.artistShelfRows\.map\(artistAlbum\)/, '并入**同一次排序**，不置顶、不特例');
  assert.match(data, /ONLINE_ARTIST_GROUP_ID = "artist:"/, '保留分组的名字只有一处来源');
  assert.match(data, /if \(album\.kind === "artist"\) return ONLINE_ARTIST_GROUP_NAME|reservedNames/, '分类名走同一张对照表');
  assert.match(data, /在线音乐人 · \$\{counts\.items\} 首/, '说明位要说"在线音乐人 · N 首"，不许写成"0 首曲目"');
});

test('⑨ 整组播放：全量入队 + 回执读内核队列实际长度（R114 那条教训的形状）', () => {
  const region = app.match(/async function playArtistGroup\(entryIndex\?: number\) \{[\s\S]*?\n\}/);
  assert.ok(region, '没抓到 playArtistGroup');
  const body = region[0];
  assert.match(body, /player\.play\(start\.id, tracks\)/, '一条 `play(id, 全量 tracks)`：只塞一首 = 播完即停、下一首也切不动');
  assert.match(body, /const queued = player\.state\.queue\.length/, '回执读队列实际长度，不读我们递出去的数组长度（内核会去重）');
  assert.match(body, /\$\{queued\} 条/, '说出口的是那个读数');
  assert.match(body, /deduped > 0/, '去重掉了几条要单独说一句，不许让"2 条变 1 条"静默发生');
  // 早退分支都要有话说（R121 同一条纪律）
  assert.equal([...body.matchAll(/return;/g)].length, [...body.matchAll(/artistStatus\(/g)].length - 1,
    '每个静默 return 前面都得先 artistStatus 一句');
});

test('⑨ 面板那一行的网格：多了封面格就要重声明列宽（否则曲名被挤成 40px 断行）', async () => {
  const css = await read('src/music.css');
  const ui = await read('src/playlists-ui.ts');
  assert.match(ui, /class="playlist-entry artist-entry"/, '组里的行要带自己的类，不能只蹭歌单行那套列宽');
  const rule = /\.artist-entry \{[^}]*grid-template-columns: 40px minmax\(0, [\d.]+fr\) 40px 34px/;
  assert.match(css, rule, '第一列是封面（40px），第二列才是曲名且必须 minmax(0,…)（不给 0 下限，长标题会把后面挤掉）');
  assert.match(css, /\.playlist-entry-cover img \{[\s\S]{0,120}?object-fit: contain/, '封面格内的图按容器缩放，与搜索结果行同一口径');
});

test('⑨ 点上这张伪专辑走面板，按播放给一句实话（不静默、也不打开 3D 详情面）', () => {
  const dispatch = app.match(/const artistSlug = album \? artistSlugOf\(album\.id\) : "";[\s\S]*?\n    \}/);
  assert.ok(dispatch, '没抓到架上点开的 artist 分支');
  assert.match(dispatch[0], /openPanel\("artist"\)/, '点开进面板');
  assert.match(dispatch[0], /return;/, '并且不落到 presentation.open()');
  // 提取整函数：闭括号在**第 0 列**才算函数结束（用 `\n  }` 会停在第一个 if 块上，
  // 于是"后半段的分支不存在"被误判成"断言失败"——这类提取错法在本仓已经咬过几次，写在这里当注解。
  const play = app.match(/function playAlbum\(id\?: string\) \{[\s\S]*?\n\}/);
  assert.ok(play, '没抓到 playAlbum');
  assert.match(play[0], /if \(a\?\.kind === "artist"\) \{\s*notify\(/, '选中音乐人组时按播放要说一句实话');
});
