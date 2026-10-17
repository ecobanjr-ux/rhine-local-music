// 看板 c980fa6：切歌后岛内容丢失（重挂不补喂）的自检。
//
// 缺陷的形状是"两边各自记账"：岛的存储卸装即回空，宿主的"已喂"记录却一直留着，
// 于是重挂后的每一帧都被门判成"没变"。这里钉四件事，按回退后最没声音排序：
//   ① 作废之后，**同一份引用**也必须重新要喂（不许等状态变化）——这一条就是那个缺陷；
//   ② 门的两层语义不能丢：数组引用变了才拼签名、签名变了才喂墙（每帧重建数组会让封面墙整墙重渲染）；
//   ③ "没收过"与"喂过一份 null"是两件事（哨兵，不是 null）；
//   ④ 宿主的两处作废点都在（卸装、挂载完成），少一处就回到原缺陷。
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { readdirSync } from 'node:fs';
import { createFoliaFeedGate } from '../src/folia-host/feed-gate.ts';
// R181（缺陷二·拍板 B）：文字对比度钳制的算式（零 import，自检直接调用）。
import { clampInkToFloor, clampInkToFloorShown, composite, contrastRatio, decideTextColor, floorForSize, gradientInkStops, groundIsLight, INK_FLOOR_BODY, INK_FLOOR_SOFT, parseAlpha, parseColor, relativeLuminance, resolvePaintedInk, stackGround, worstGradientInk } from '../src/folia-host/text-contrast.ts';

// R162（任务九）：音乐人网格的宿主侧数据层。
import { ARTIST_GRID_TOP_SONGS, ARTIST_GRID_UNKNOWN_ALBUM, artistGridTrackIndex, buildArtistGridModel } from '../src/artist-grid.ts';

const read = (relative) => readFile(new URL(`../${relative}`, import.meta.url), 'utf8');

const track = (id) => ({ id, title: id, artist: 'a', albumId: 'al', duration: 100 });

test('①：作废后同一份引用也要重新喂（曲目 / 歌词 / 队列三项）', () => {
  const gate = createFoliaFeedGate();
  const a = track('a');
  const queue = [a, track('b')];
  const lyrics = { lines: [] };
  assert.equal(gate.takeSong(a), true, '第一遍曲目要喂');
  assert.equal(gate.takeLyrics(lyrics), true, '第一遍歌词要喂');
  assert.equal(gate.takeQueue(queue), true, '第一遍队列要喂');
  assert.equal(gate.takeSong(a), false, '同一份不该重复喂');
  assert.equal(gate.takeLyrics(lyrics), false, '同一份不该重复喂');
  assert.equal(gate.takeQueue(queue), false, '同一份不该重复喂');

  gate.invalidate();
  // 岛的存储刚回到空：这里任何一项判成"没变"，重挂后就是那张空墙 / 那片没字的屏。
  assert.equal(gate.takeSong(a), true, '重挂后曲目必须自动补喂');
  assert.equal(gate.takeLyrics(lyrics), true, '重挂后歌词必须自动补喂');
  assert.equal(gate.takeQueue(queue), true, '重挂后队列必须自动补喂');
});

test('②：队列的两层门照旧（引用没变不拼签名；签名没变不喂墙）', () => {
  const gate = createFoliaFeedGate();
  const a = track('a'), b = track('b');
  assert.equal(gate.takeQueue([a, b]), true, '首次要喂');
  // 内核每轮发出的数组是新对象，但同一串 id ⇒ 不该再喂一次（否则整墙重渲染）。
  assert.equal(gate.takeQueue([a, b]), false, '同签名的新数组不喂');
  assert.equal(gate.takeQueue([a, b, track('c')]), true, '队列加一首要喂');
  // 引用都没变时连签名都不拼：这是每帧都会走的那条。
  const same = [a, b];
  const gate2 = createFoliaFeedGate();
  assert.equal(gate2.takeQueue(same), true);
  assert.equal(gate2.takeQueue(same), false, '同一对象直接返回');
});

test('②b：签名里带封面（R126 墙上「重取封面」补到的那张必须能上屏）', () => {
  const gate = createFoliaFeedGate();
  const bare = { ...track('a'), coverUrl: undefined };
  const withCover = { ...track('a'), coverUrl: '/api/online/artwork/0123456789abcdef' };
  assert.equal(gate.takeQueue([bare]), true, '首次要喂');
  // 只按 id 签名的旧写法会在这里挡掉：服务端明明有了图，墙上还是渐变，而且一句话也不报。
  assert.equal(gate.takeQueue([withCover]), true, 'id 没变、只有封面变了 ⇒ 也要喂（这是原地更新的唯一通路）');
  assert.equal(gate.takeQueue([withCover]), false, '同一张图不重复喂（每帧重建数组会让整墙重渲染）');
});

test('③："没喂过"不等于"喂过一份 null"', () => {
  const gate = createFoliaFeedGate();
  // 空曲目 / 空歌词都得真发一次"清空"给岛，否则岛保留上一首的字（错字比空字更糟）。
  assert.equal(gate.takeSong(null), true, '首次的 null 也要喂给岛');
  assert.equal(gate.takeSong(null), false, '之后同一份不重复');
  assert.equal(gate.takeLyrics(null), true, '首次的空歌词也要喂');
  gate.invalidate();
  assert.equal(gate.takeSong(null), true, '重挂后连"没有曲目"都要重新说一遍');
  assert.equal(gate.takeLyrics(null), true, '重挂后连"没有歌词"都要重新说一遍');
});

test('③b：空队列的签名不与非空混淆，重挂后仍会补喂', () => {
  const gate = createFoliaFeedGate();
  assert.equal(gate.takeQueue([]), false, '空队列与初值同签名，不用喂');
  assert.equal(gate.takeQueue([track('a')]), true, '有内容了要喂');
  gate.invalidate();
  assert.equal(gate.takeQueue([track('a')]), true, '同一份队列重挂后也要重新喂（岛那边已经是空的）');
});

test('④：宿主两处作废点都在，且都在岛存储变化的那一刻', async () => {
  const app = await read('src/music-app.ts');
  const stripped = app.replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, '');
  const calls = [...stripped.matchAll(/foliaFeed\.invalidate\(\)/g)].length;
  assert.ok(calls >= 2, `卸装与挂载完成各要有一次 invalidate()，实测 ${calls} 处`);
  // 两处各归哪条路径：按周围的关键动作认，不按行号与原文顺序认（改实现文本不该让它红）。
  const unmountSite = stripped.match(/if \(islandState === "on"\) islandHandle\?\.unmount\(\);[\s\S]{0,400}?foliaFeed\.invalidate\(\)/);
  assert.ok(unmountSite, '卸装那一路必须作废喂送记录');
  const mountSite = stripped.match(/islandState = "on";[\s\S]{0,600}?foliaFeed\.invalidate\(\);\s*\n\s*feedFoliaIsland\(\)/);
  assert.ok(mountSite, '挂载完成、首次喂送之前必须作废');
});

test('④b：四个喂送缓存不再散成模块级 let（那正是没人负责失效的形状）', async () => {
  const app = await read('src/music-app.ts');
  for (const name of ['fedTrack', 'fedLyrics', 'fedQueueSignature', 'fedQueueRef']) {
    assert.ok(
      !new RegExp(`let ${name}\\b`).test(app),
      `${name} 不许再回到 music-app 的模块级 let 里（岛 reset 时它不会被清）`,
    );
  }
  assert.match(app, /const foliaFeed = createFoliaFeedGate\(\)/, '宿主只留一个门实例');
});

test('⑤：布局的四处判据同一个出处（按钮文案 / pressed 态 / DOM 属性 / 点击算 next）', async () => {
  const app = await read('src/music-app.ts');
  // 看板 c980fa6 嫌疑③：三份里任何两份脱钩，观感就是"文字变了画面没变、再点还没反应"。
  // 判据按"三处是否读同一个入口"划，不抄那句赋值原文（改写法不该让它红）。
  const domSite = app.match(/stage\.dataset\.foliaLayout = ([A-Za-z_$][\w$]*)\(\)/);
  assert.ok(domSite, '没抓到 DOM 属性那一处赋值（必须是某个入口函数的返回值）');
  const clickSite = app.match(/case "folia-layout"[\s\S]{0,600}?const next: IslandLayout = ([A-Za-z_$][\w$]*)\(\) === "lattice"/);
  assert.ok(clickSite, '没抓到布局点击里算 next 的那句');
  const labelSite = app.match(/layoutLabel: ([A-Za-z_$][\w$]*)\(\) === "lattice"/);
  assert.ok(labelSite, '没抓到按钮文案那处');
  const pressedSite = app.match(/layoutActive: ([A-Za-z_$][\w$]*)\(\) === "lattice"/);
  assert.ok(pressedSite, '没抓到 pressed 态那处');
  const three = new Set([domSite[1], clickSite[1], labelSite[1], pressedSite[1]]);
  assert.equal(three.size, 1, `布局四处判据不同源：${[...three].join(' / ')}`);
  assert.equal([...three][0], 'currentFoliaLayout', '唯一的出处要读岛的实际布局');
  // 偏好退回持久化：挂载时仍是"偏好→岛"的单向推送，但它不许再出现在上面三个判据里。
  assert.match(app, /islandHandle\.setLayout\(preferences\.foliaView\)/, '挂载时把偏好推进岛（唯一的偏好→岛方向）');
  assert.doesNotMatch(
    app.replace(/case "folia-layout"[\s\S]{0,600}?break;/, ''),
    /const next: IslandLayout = preferences\.foliaView/,
    '不许再按偏好算 next（那就是脱钩时"点了没反应"的那一句）',
  );
});

// ── R128（Q1）：feedTransport 从"零调用方"接上 ────────────────────────────────
// 缺陷的形状：handle 上有 feedTransport，适配层也有，岛内组件在读 playerState —— 唯独宿主一次都不调。
// 于是那份 store 永远停在 IDLE：正在播的卡上播放键一直是 ▶，岛内所有按 paused 判的分支都不成立。

test('R128 门：传输态变了才要再说一遍，作废之后同一档也要重新喂', () => {
  const gate = createFoliaFeedGate();
  assert.equal(gate.takeTransport('idle'), true, '首次要喂');
  assert.equal(gate.takeTransport('idle'), false, '同一档不重复写 store');
  assert.equal(gate.takeTransport('playing'), true, '开始播要喂');
  assert.equal(gate.takeTransport('loading'), true, '装载是独立一档（不是"还在播"）');
  gate.invalidate();
  assert.equal(gate.takeTransport('loading'), true, '重挂之后同一档也要重新要一遍（岛那边已经是空的）');
});

test('R128 宿主真的在喂：feedTransport 有调用方，且过这道门（不许每帧写 store）', async () => {
  const app = await read('src/music-app.ts');
  const feeder = /function feedFoliaIsland\(\)[\s\S]*?\n}\n/.exec(app);
  assert.ok(feeder, '没抓到 feedFoliaIsland（提取失败不许静默通过）');
  assert.match(feeder[0], /islandHandle\.feedTransport\(/, '传输态必须真的喂给岛');
  assert.match(feeder[0], /foliaFeed\.takeTransport\(/, '而且过同一道门：这个函数每帧都跑');
  assert.match(feeder[0], /playerState\?\.transport \?\? "idle"/, '读的是内核那份 transport，不在界面里另算一份');
  // 换算只有一个出处：内核五档 → 岛三档写在适配层，宿主只交两个布尔
  const adapter = await read('src/folia-host/adapter.ts');
  assert.match(adapter, /playing \? PlayerState\.PLAYING : paused \? PlayerState\.PAUSED : PlayerState\.IDLE/, '换算在适配层，且只有这一处');
  assert.equal([...app.matchAll(/feedTransport\(/g)].length, 1, '宿主只有一处喂传输态（两处就是两个真相）');
});


// —— R162（任务九 · 音乐人网格）：宿主侧那份描述符的判据 ——
// 这一组用例测的是"网格画出来的那几个数从哪儿来"：全部只准来自递进去的那份条目，
// 一处都不许编（简介、封面、年份、条数都是用户会当事实读的东西）。
const gridTrack = (id, album, cover) => ({
  id,
  albumId: `al-${album || 'none'}`,
  title: `曲 ${id}`,
  artist: '某音乐人',
  duration: 100,
  browserPlayable: true,
  audioUrl: `/api/stream/${id}`,
  sourceKind: 'online',
  ...(album ? { album } : {}),
  ...(cover ? { coverUrl: cover } : {}),
});
const gridSource = (tracks, extra = {}) => ({
  id: 'online:demo',
  name: '某音乐人',
  description: '本机歌单里已匹配的在线条目 · 共 3 首',
  tracks,
  viewOf: (track) => ({ albumName: String(track.album ?? ''), albumCover: track.coverUrl }),
  toSong: (track) => ({ id: track.id, name: track.title, artists: [{ name: track.artist }], album: null, durationMs: 1000 }),
  ...extra,
});

test('R162 网格数据层：空组返回 null（不许画一面只有头像和空白说明的网格）', () => {
  assert.equal(buildArtistGridModel(gridSource([])), null);
});

test('R162 网格数据层：卡片只画前 10 首，但整组仍是入队的那一份（R114 口径）', () => {
  const tracks = Array.from({ length: 14 }, (_unused, index) => gridTrack(`t${index}`, '甲专辑'));
  const model = buildArtistGridModel(gridSource(tracks));
  assert.equal(model.feed.songs.length, ARTIST_GRID_TOP_SONGS, `热门曲目只画 ${ARTIST_GRID_TOP_SONGS} 格`);
  assert.equal(model.tracks.length, 14, '整份条目要留着（播放全部用的是它，不是画出来的那 10 条）');
  assert.equal(model.feed.trackCount, 14, '说明卡上那个"共几首"数的是整组');
  assert.equal(artistGridTrackIndex(model, 't7'), 7, '点卡片按 id 回查下标');
  assert.equal(artistGridTrackIndex(model, '不存在'), -1, '查不到要能说实话（界面据此报"已经不在这份网格里"）');
});

test('R162 网格数据层：专辑按首见顺序归组、封面取第一张真有的、没有就一个地址都不造（F3 判据）', () => {
  const model = buildArtistGridModel(gridSource([
    gridTrack('a1', '乙专辑', ''),
    gridTrack('b1', '甲专辑', 'https://third.example/b1.jpg'),
    gridTrack('a2', '乙专辑', '/api/online/artwork/token-a2'),
    gridTrack('b2', '甲专辑', '/api/online/artwork/token-b2'),
  ]));
  assert.deepEqual(model.feed.albums.map((album) => album.name), ['乙专辑', '甲专辑'], '首见顺序，不重排');
  assert.deepEqual(Object.values(model.feed.albums[0]).filter((v) => v === undefined).length, 0);
  assert.equal(model.feed.albums[0].coverUrl, '/api/online/artwork/token-a2', '第一张"真有的"定了就不再换（R126 同口径）');
  assert.equal(model.feed.albums[1].coverUrl, 'https://third.example/b1.jpg', '这一组先出现的那张是它自己带来的地址');
  // 头像格取第一张有封面的专辑：a1 没有封面、乙专辑后来才有 ⇒ 就是它，不许凭空拼一个。
  assert.equal(model.feed.cover, '/api/online/artwork/token-a2');
  assert.deepEqual([...model.albumTracks.keys()], model.feed.albums.map((album) => album.id), '专辑卡点的就是这一批曲目');
  assert.deepEqual(model.albumTracks.get(model.feed.albums[0].id).map((t) => t.id), ['a1', 'a2'], '组内原顺序');
  const bare = buildArtistGridModel(gridSource([gridTrack('x', '无封面的专辑')]));
  assert.equal('cover' in bare.feed, false, '一条封面都没有 ⇒ 不给 cover 这一格（界面画它自己的占位，不造会 404 的 URL）');
});

test('R162 网格数据层：没写专辑的条目归进一格的的确确的「未标专辑」，并数得出有几条', () => {
  const model = buildArtistGridModel(gridSource([
    gridTrack('a', '甲专辑'),
    gridTrack('b', ''),
    gridTrack('c', '   '),
  ]));
  assert.equal(model.feed.albumCount, 2, '一张真专辑 + 一格"未标专辑"');
  assert.equal(model.albumsWithoutName, 2, '两条没写专辑要能说出来（不许静悄悄并进某张真专辑）');
  assert.equal(model.feed.albums[1].name, ARTIST_GRID_UNKNOWN_ALBUM);
  assert.deepEqual(model.albumTracks.get(model.feed.albums[1].id).map((t) => t.id), ['b', 'c']);
});

test('R162 网格数据层：说明卡那句话只准用调用方给的文本（本产品没有平台侧音乐人简介）', () => {
  const model = buildArtistGridModel(gridSource([gridTrack('a', '甲专辑')], { description: '本机推得出的那一句' }));
  assert.equal(model.feed.description, '本机推得出的那一句');
  assert.equal(model.feed.aliases, undefined, '没有别名读数就不带这一格');
  assert.equal(model.feed.albums[0].publishedAt, undefined, '在线条目没有年份读数 ⇒ 卡片那一行不显示年份');
  const withYear = buildArtistGridModel(gridSource([gridTrack('a', '甲专辑')], {
    viewOf: () => ({ albumName: '甲专辑', albumYear: 2019 }),
  }));
  assert.equal(withYear.feed.albums[0].publishedAt, Date.UTC(2019, 0, 1), '本地专辑有年份就用它');
  const bogusYear = buildArtistGridModel(gridSource([gridTrack('a', '甲专辑')], {
    viewOf: () => ({ albumName: '甲专辑', albumYear: 0 }),
  }));
  assert.equal(bogusYear.feed.albums[0].publishedAt, undefined, '0 或负数年份当"没有读数"，不写进卡片');
});

test('R162 网格只走宿主那一条播放通路：三个动作都只收 id，且整份入队', async () => {
  const app = await read('src/music-app.ts');
  const body = /function playArtistGridTracks[\s\S]*?\n}\n/.exec(app);
  assert.ok(body, '没抓到 playArtistGridTracks');
  assert.match(body[0], /player\.play\(start\.id, tracks\)/, '整份入队（R114：算出多少条就递多少条）');
  assert.match(body[0], /player\.state\.queue\.length/, '回执读内核队列的实际长度，不报递出去的那个数');
  for (const fn of ['playArtistGridTrack', 'playArtistGridAlbum', 'addArtistGridToQueue']) {
    const block = new RegExp(`function ${fn}\\([\\s\\S]*?\\n}\\n`).exec(app);
    assert.ok(block, `没抓到 ${fn}`);
    assert.match(block[0], /artistGridModel/, `${fn} 必须回查宿主那份数据（不信岛递回来的快照）`);
    assert.doesNotMatch(block[0], /fetch\(|\/api\//, `${fn} 不许再取一次数（明细早就在手上）`);
  }
  const enqueue = /function addArtistGridToQueue[\s\S]*?\n}\n/.exec(app);
  assert.match(enqueue[0], /player\.setQueue\(\[\.\.\.player\.state\.queue, \.\.\.picked\]\)/, '追加而不是打断正在播的那一首');
  assert.match(enqueue[0], /player\.state\.queue\.length - before/, '排进去几条按队列实际涨幅算（内核按 id 去重）');
});

test('R162 网格入口两处都在，且都只转发既有动作（命令表是唯一出处 · R131 口径）', async () => {
  const app = await read('src/music-app.ts');
  assert.match(app, /\{ id: "artist-grid", title: "以网格看这位音乐人"[\s\S]*?available: \(\) => Boolean\(artistDetail\) \|\| Boolean\(currentAlbum\(\)\), run: \(\) => openArtistGrid\(\) \}/,
    '命令表里那一条：可用性只认"手上有没有能画的数据"');
  assert.equal([...app.matchAll(/id: "artist-grid"/g)].length, 1, '这条命令只有一个出处');
  const ui = await read('src/playlists-ui.ts');
  assert.match(ui, /data-action="artist-grid-view"/, '⑨ 那张明细面板上有入口');
  assert.match(app, /target\.dataset\.action === "artist-grid-view"/, '点击分支在位（写了按钮没写分支就是静默无果，R121 那一族）');
});

// ── R173（Q51）：岛内模式的参数面板在宿主里有渲染位点，且参数是一条链不是两份状态 ──────────
const fnBody = (source, name) => {
  const start = source.indexOf(`function ${name}`);
  assert.notEqual(start, -1, `${name} 这个函数找不到了（判据要跟着搬家，不许放宽）`);
  const end = source.indexOf('\n}', start);
  assert.notEqual(end, -1, `${name} 的函数体收不上`);
  return source.slice(start, end + 2);
};

test('R173：注册表那个 renderSettingsPanel 出口不再是零调用方（面板有唯一渲染位点）', async () => {
  const glue = await read('src/folia-host/mode-settings.tsx');
  const app = await read('src/music-app.ts');
  assert.match(glue, /entry\.renderSettingsPanel/, '胶水必须走注册表出口，不另列一份模式清单');
  assert.match(glue, /if \(!entry\.renderSettingsPanel\)/, '没有面板的档（cadenza / still）要说一句实话，不留空白');
  assert.match(glue, /上游没有提供可调参数/, '那句实话要说"没有可调参数"，不能写成"加载中"之类的搪塞');
  // R176：那句"没有可调参数"的实话要说用户认得的名字——内部 id 上屏就是给用户看代码
  // （真机量到的原文是 `「cappella」这一档上游没有提供可调参数…`）。
  assert.match(glue, /「\$\{options\.modeLabel\}」/, '没有面板的那句实话要用中文名');
  assert.doesNotMatch(glue, /「\$\{options\.mode\}」/, '不许把内部 id 直接写进用户看得见的文案');
  assert.match(fnBody(app, 'foliaModeSettingsOptions'),
    /modeLabel: FOLIA_MODES\.find\(\(m\) => m\.id === preferences\.foliaMode\)\?\.name\b/,
    '中文名从宿主那张模式表取，且必须取 name 那一格（不在这层另写一份名单）');
  assert.doesNotMatch(fnBody(app, 'foliaModeSettingsOptions'), /modeLabel:[^\n]*\?\.hint/,
    '不许把提示语当档名（L3 那一刀验的就是这一格：只查"从表里取"是拦不住取错字段的）');

  // 面板由注册表给，胶水不许按档硬编码 import 某一家的面板（那样加一档就要回来改这里）
  assert.doesNotMatch(glue, /visualizer\/(?:lumiere|monet|sonnet|tempera)\//,
    '胶水不许直接 import 某档的面板文件');
  // 宿主的设置面板里要有那块容器，而且画完 innerHTML 之后才挂上去
  assert.match(app, /id="folia-mode-settings"/, '设置面板里要有那块容器');
  const render = fnBody(app, 'renderSettingsPanel');
  assert.ok(render.indexOf('mountFoliaModeSettings()') > render.indexOf('innerHTML'),
    '必须先画容器再挂 React 根（反过来就是挂在一个还不存在的节点上）');
  // 关面板要卸装：第二根留在被替换掉的 DOM 上是白占一份 React 树
  assert.match(fnBody(app, 'closePanel'), /unmountModeSettings\(\)/, '关面板必须卸装');
  // 它是 React 树 ⇒ 只能动态引（静态那条判据在 check-folia-port，这里钉"确实有动态引法"）
  assert.match(app, /import\("\.\/folia-host\/mode-settings"\)/, '面板模块必须动态 import');
});

test('R173：参数从面板到渲染器是一条链，中间不许有人另存一份', async () => {
  const island = await read('src/folia-host/island.tsx');
  const app = await read('src/music-app.ts');
  // 岛：一份用来渲染的读数 + 一个喂料口 + 卸装必清（R118 那一课）
  assert.match(island, /tunings: VisualizerTuningBundle;/, '岛内视图态要有 tunings 这一格');
  assert.match(island, /visualizerTunings=\{tunings\}/, 'FoliaView 必须把它转给 VisualizerRenderer');
  assert.match(island, /setTunings: \(tunings\) => useIslandUi\.setState\(\{ tunings \}\)/, '喂料口只写这一处');
  // R203 改写这条判据的**形状**（要求本身一点没放宽 ⇒ 记 Q84）：原断言钉的是
  // `artistFeed: null, tunings: {} }` 这两格的**相邻文本**，所以往复位清单里加第三格
  // （`chromeHidden: false`）就把一次正常扩展判成回归——与"网易云字面量搬进共享表就红"同族。
  // 现在钉不变式：**卸装那一句 setState 里必须出现这几格**，顺序与相邻关系不作要求
  // （守住的是"漏清哪个字段"，位置本来就不是这条规则要管的事）。
  const resetAt = island.indexOf('unmount: () =>');
  assert.ok(resetAt >= 0, '找不到 unmount');
  const resetCall = island.slice(island.indexOf('useIslandUi.setState(', resetAt));
  const resetList = resetCall.slice(0, resetCall.indexOf(');'));
  for (const cleared of [
    'layout: "classic"',
    'mode: "classic"',
    'queue: []',
    'songLiked: false',
    'artistFeed: null',
    'chromeHidden: false',
    'tunings: {}',
  ])
    assert.ok(resetList.includes(cleared), `卸装的复位清单里缺 ${cleared}（不清就是重挂后停在上一副身子）`);
  // 宿主：一次改动要同时做三件事，少一件就是"存了没生效"或"生效了重启就没了"
  const patch = fnBody(app, 'foliaModeSettingsOptions');
  for (const step of ['preferences.foliaTunings[mode] = merged', 'savePrefs()', 'feedFoliaTunings()'])
    assert.ok(patch.includes(step), `改参数这一步缺了 ${step}`);
  assert.ok(patch.indexOf('savePrefs()') < patch.indexOf('feedFoliaTunings()'), '先落盘再喂岛（反过来时喂的是旧值）');
  // 真机抓到的那一格：喂给岛必须是**新对象**。同引用的话 zustand 的选择器判"没变"，
  // 表现是"拖了滑杆、当下不动、重启之后才生效"——离线断言全绿也拦不住。
  const feed = fnBody(app, 'feedFoliaTunings');
  assert.doesNotMatch(feed, /setTunings\(\s*preferences\.foliaTunings/, '不许把偏好那一份引用直接递给岛');
  assert.match(feed, /setTunings\(\s*bundle\b/, '喂岛的是这个函数里现拼的那一份');
  assert.ok(/const bundle[\s\S]*setTunings\(/.test(feed), '先拼出新对象再喂（顺序反了就是喂 undefined）');
  // 持久化两头都要有：默认值 + 读入类型（少了后者，磁盘上那份根本进不来）
  assert.match(app, /foliaTunings: \{\} as Record<string, Record<string, unknown>>/, '偏好默认值要有这一项');
  assert.match(app, /foliaTunings: Record<string, Record<string, unknown>>;/, '读入那份 Partial 类型里也要有（否则重启读不回来）');
  // 非法值要丢，不能崩在面板里，也不能把整份偏好带走
  const norm = fnBody(app, 'normalizeFoliaTunings');
  assert.match(norm, /known\.has\(mode\)/, '不认识的模式要整条丢掉');
  assert.match(norm, /Array\.isArray\(value\)/, '非 plain object（数组 / 字符串 / null）要丢掉');
  // 岛挂载完成那一刻要补喂一次，否则"偏好里有、岛拿默认值"
  assert.match(app, /islandHandle\.setMode\(preferences\.foliaMode\);[\s\S]{0,400}feedFoliaTunings\(\);/,
    '挂载之后必须补喂参数');
});

test('R173：有面板的四档都要有 tuning.ts——bundle 进不了 props 的话，面板就是"改了没反应"', async () => {
  const manifest = JSON.parse(await read('scripts/folia-port-manifest.json')).entries;
  for (const mode of ['lumiere', 'monet', 'sonnet', 'tempera']) {
    const rel = `components/visualizer/${mode}/tuning.ts`;
    assert.ok(manifest.includes(rel), `${rel} 必须在复制清单里（R53 的逐字校验才管得到它）`);
    const src = await read(`src/folia/${rel}`);
    // 适配器把 bundle 里那一格摊到 props 上：键名必须是 <mode>Tuning，与面板读的、渲染器读的是同一个
    assert.ok(src.includes(`mode: '${mode}'`) && src.includes(`${mode}Tuning: tuning`),
      `${mode} 的适配器形状不对（applyVisualizerTuning 找不到它，参数就永远进不了渲染器）`);
  }
});



// ── R175（pendolo 取证抓到）：喂给面板与岛的读数必须是"完整一份"，不是用户改过的那几格 ──────
// 上游这 10 档吃 tuning 的模式，面板与渲染器普遍写成"整对象回退"（`xTuning = DEFAULT_X_TUNING` 的缺省参数、
// `pendoloTuning ?? DEFAULT_PENDOLO_TUNING`）。R173 那条通道喂的是偏好里那份**补丁**（一格都没改过时是 `{}`），
// `{}` 是 truthy ⇒ 回退不触发 ⇒ 除被拖过的那一格以外全是 undefined：滑杆 NaN、`.toFixed()` 抛、
// 画面按 NaN 几何布局（"拖一次设置就把整档画坏"，而不是只改那一格）。
// 真机读数：控制台两处 `Uncaught TypeError: Cannot read properties of undefined (reading 'toFixed')`。
// 注：`src/folia/types.ts` 里有 `enum`，Node 的 strip-only 模式import不进来 ⇒ 那份默认值从源码文本解析，
// 解析器与 check-folia-port 的 R170/R175 用的是同一条路子（键名 + 原样文本值）。
test('R175：合成层给面板与岛的读数是完整的（局部补丁会让移植件的整对象回退失效）', async () => {
  const { createTuningResolver } = await import('../src/folia-host/tuning-merge.ts');
  const typesSrc = await read('src/folia/types.ts');
  const table = await read('src/folia-host/tuning-defaults.ts');
  const app = await read('src/music-app.ts');
  const glue = await read('src/folia-host/mode-settings.tsx');
  // 从移植件的 types.ts 里解析 `export const DEFAULT_X_TUNING = { ... }` 那几格（不重抄数值）
  const parseDefaults = (constName) => {
    const at = typesSrc.indexOf(`export const ${constName}`);
    assert.notEqual(at, -1, `${constName} 在移植件的 types.ts 里不存在 ⇒ 合成表会指向 undefined`);
    const open = typesSrc.indexOf('{', at);
    const close = typesSrc.indexOf('\n};', open);
    assert.ok(close > open, `${constName} 的对象字面量收不上`);
    const cells = {};
    for (const line of typesSrc.slice(open + 1, close).split('\n')) {
      const m = line.match(/^\s*([A-Za-z0-9_]+):\s*(.+?),?\s*$/);
      if (m) cells[m[1]] = m[2];
    }
    assert.ok(Object.keys(cells).length > 0, `${constName} 解析出零格 ⇒ 是解析器坏了，别拿它当证据`);
    return cells;
  };
  // ① 覆盖面：凡 entry 里 tuningKind 不是 'none' 的档都要在表里（清单逐档扫出来，不写死一份名单）
  const dirs = readdirSync(new URL('../src/folia/components/visualizer', import.meta.url), { withFileTypes: true })
    .filter((d) => d.isDirectory()).map((d) => d.name);
  const tuned = [];
  for (const d of dirs) {
    const src = await read(`src/folia/components/visualizer/${d}/entry.tsx`).catch(() => null);
    const m = src && src.match(/tuningKind: '([a-z]+)'/);
    if (m && m[1] !== 'none') tuned.push(m[1]);
  }
  assert.ok(tuned.length >= 9, `扫到的吃 tuning 的档只有 ${tuned.length} 个（${tuned.join(',')}）⇒ 是扫描坏了，别拿它当证据`);
  // ② 数值出处：表里每一格都必须是移植件那个 DEFAULT_常量
  const defaults = {};
  for (const mode of tuned) {
    const name = `DEFAULT_${mode.toUpperCase()}_TUNING`;
    assert.match(table, new RegExp(`^\\s*${mode}: asCells\\(${name}\\),$`, 'm'),
      `${mode} 的缺省读数必须写清来自移植件的 ${name}（在这一层重抄数值就会和上游分家）`);
    defaults[mode] = parseDefaults(name);
  }
  const resolve = createTuningResolver(defaults).resolve;
  // ③ 一格都没改过：合成后的键集合要和默认逐字相等（面板与渲染器读的是同一批键）
  for (const mode of tuned) {
    assert.deepEqual(Object.keys(resolve(mode, {})).sort(), Object.keys(defaults[mode]).sort(),
      `${mode}：空补丁合成出来应当就是那份默认`);
  }
  // ④ 改一格之后其余格仍有值——pendolo 那两处 toFixed 就是这么炸的
  const patched = resolve('pendolo', { arcRadius: 0.78 });
  assert.equal(patched.arcRadius, 0.78, '改过的那一格要用用户的值');
  for (const [k, v] of Object.entries(defaults.pendolo)) {
    assert.equal(patched[k], k === 'arcRadius' ? 0.78 : v, `没改过的 ${k} 要落回默认，不许是 undefined`);
  }
  // ⑤ 面板里那颗 .toFixed() 直接读的格子，必须在合成结果里有值（这一格就是真机那两处异常的现场）
  const panel = await read('src/folia/components/visualizer/pendolo/PendoloSettingsPanel.tsx');
  const toFixedKeys = [...panel.matchAll(/resolvedTuning\.([A-Za-z0-9_]+)\.toFixed/g)].map((m) => m[1]);
  assert.ok(toFixedKeys.length > 0, '面板里没有 .toFixed() 了 ⇒ 这一格的判据面就空了，别当成通过');
  for (const key of toFixedKeys) {
    assert.notEqual(patched[key], undefined, `面板对 ${key} 直接 .toFixed()，合成结果里却没有这一格`);
    assert.match(String(patched[key]), /^-?\d+(\.\d+)?$/, `${key} 是拿来 .toFixed() 的，默认值得是数字`);
  }
  // ⑥ 不吃 tuning 的档（still）就不给：让移植件走它自己的整对象回退，别凭空造一份
  assert.equal(resolve('still', {}), undefined, 'still 不吃 tuning，合成表里不该有它');
  assert.doesNotMatch(table, /^\s*still:/m, '合成表里不许出现 still（它 tuningKind 是 none）');
  // ⑦ 两个读数都走这一层，而落盘那一份仍然只是"用户改过的格"
  const opts = fnBody(app, 'foliaModeSettingsOptions');
  const feed = fnBody(app, 'feedFoliaTunings');
  // R189：出口从 `resolveFoliaTuning` 换成 `resolveFoliaTuningForTheme`（亮底下辉光/雾打折那一条）；
  // 判据本身没放宽——仍然要求"面板与喂岛**都**走合成层"，只是多了亮底那一维。
  assert.match(opts, /getTuning: \(mode\) =>\s*resolveFoliaTuningForTheme\(mode, preferences\.foliaTunings\[mode\], useHostThemeStore\.getState\(\)\.isDaylight\)/,
    '面板那个读数要走合成层（含亮底打折）');
  assert.match(feed, /resolveFoliaTuningForTheme\(mode, preferences\.foliaTunings\[mode\], isDaylight\)/, '喂岛那一路也要走合成层');
  assert.match(feed, /Object\.keys\(FOLIA_TUNING_DEFAULTS\)/, '喂岛要遍历这张表（加一档不必回来改这里）');
  assert.doesNotMatch(opts, /preferences\.foliaTunings\[mode\] = \{ \.\.\.FOLIA_TUNING_DEFAULTS/,
    '落盘的不许是合成后的那一份（默认值整份进磁盘 = 以后上游改了默认也跟不上）');
  assert.doesNotMatch(glue, /getTuning\(options\.mode\) \?\? \{\}/,
    '胶水不许把"没改过"洗成一份空补丁：空补丁是 truthy，移植件那条整对象回退就不触发了');
});

// ── R189：亮底下"辉光/雾"的缺省打折（用户报的"辉光雾蒙蒙"）──────────────────────────────
// 观感问题的形状是"辉光在暗底是光、在亮底是雾"（帧率 62fps 正常 ⇒ 不是性能）。所以只对亮底改**缺省**，
// 暗底一个字不动；用户自己拖过的那一格不许被改（"可在面板调回"）。算式在 tuning-merge.ts（零 import）。
test('R189：亮底打折只动缺省、不动用户改过的格，且宿主只有一个合成出口', async () => {
  const { applyDayGlowDiscount, DAY_GLOW_SCALE } = await import('../src/folia-host/tuning-merge.ts');
  const table = await read('src/folia-host/tuning-defaults.ts');
  const app = await read('src/music-app.ts');
  assert.equal(DAY_GLOW_SCALE, 0.6, '系数就是 0.6（run log 里那个"看着不雾"的起点值）');
  const fields = { lumiere: ['fogDensity', 'bloom', 'textBloom'] };
  const base = { fogDensity: 1, bloom: 1, textBloom: 1, lightIntensity: 1 };
  // ① 表里的每一格乘系数、表外的格一动不动，而且换一份新对象（调用方按引用比较）
  const cut = applyDayGlowDiscount('lumiere', base, undefined, fields);
  assert.equal(cut.fogDensity, 0.6); assert.equal(cut.bloom, 0.6); assert.equal(cut.textBloom, 0.6);
  assert.equal(cut.lightIntensity, 1, '光强不是辉光/雾，不许被动');
  assert.notEqual(cut, base, '改了就得换一份新对象，否则岛上读不到变化（zustand 按引用比）');
  assert.equal(base.fogDensity, 1, '不许改到传进来的那一份（它是宿主 preferences 里的对象）');
  // ② 用户拖过的那一格原样：不许把 0.6 盖回去（合成层里"合并"已经先做过，进来时那一格就是用户的值）
  const kept = applyDayGlowDiscount('lumiere', { ...base, fogDensity: 1.8 }, { fogDensity: 1.8 }, fields);
  assert.equal(kept.fogDensity, 1.8, '用户自己调过的格要尊重（"可在面板调回"就是这个意思）');
  assert.equal(kept.bloom, 0.6, '没调过的格照常打折');
  // ③ 没这一档 / 这一格不是数 / 表是空的 ⇒ 原对象原样回（幂等，不造新对象 ⇒ 不触发无谓重渲染）
  assert.equal(applyDayGlowDiscount('still', base, undefined, fields), base, '表里没有的档原样回');
  assert.equal(applyDayGlowDiscount('lumiere', base, undefined, {}), base, '空表原样回');
  const weird = applyDayGlowDiscount('lumiere', { fogDensity: 'x' }, undefined, fields);
  assert.equal(weird.fogDensity, 'x', '非数值格不许被"打折"成 NaN');
  assert.equal(applyDayGlowDiscount('lumiere', undefined, undefined, fields), undefined, 'undefined 进 undefined 出');
  // ④ 表本身：用户点名那一档的三格必须在，且逐档都是这一档面板上真实存在的字段
  assert.match(table, /FOLIA_DAY_GLOW_FIELDS/, '打折表要在（从表里读字段名，不在宿主里逐格写）');
  assert.match(table, /lumiere: \["fogDensity", "bloom", "textBloom"\]/, 'lumiere 的雾/两种辉光就是这三格');
  assert.match(table, /tempera: \["postProcessGrain", "postProcessVignette"\]/, 'tempera 的雾感/暗角');
  assert.match(table, /resolveFoliaTuningForTheme/, '合成出口要在这一个文件里给出');
  assert.match(table, /applyDayGlowDiscount\(mode, resolved, stored, FOLIA_DAY_GLOW_FIELDS, DAY_GLOW_SCALE\)/,
    '亮底那一支要走打折函数（写死一个 if 分支里另有算式 = 两份真相）');
  // ⑤ 唯一出口：宿主里不许再有第二条路直接调不打折的那个合成
  assert.doesNotMatch(app, /resolveFoliaTuning\(/, '宿主只许经 resolveFoliaTuningForTheme（两处读一份真相）');
  assert.doesNotMatch(app, /resolveFoliaTuning,/, '连 import 里也不许再引不打折的那个名字');
  // ⑥ 换主题要重算：不重算就是"面板显示 0.60、画面还是 1.00"
  //（不能用 fnBody：`indexOf('function refreshHostTheme')` 会先命中 refreshHostThemeAfterTransition）
  const refreshAt = app.indexOf('function refreshHostTheme(): void');
  assert.notEqual(refreshAt, -1, 'refreshHostTheme 这个函数找不到了（判据要跟着搬家，不许放宽）');
  const refresh = app.slice(refreshAt, app.indexOf('\n}', refreshAt) + 2);
  assert.ok(refresh.includes('refreshHostThemeOnly()'), '主题桥本身照旧要刷新');
  assert.ok(refresh.includes('feedFoliaTunings()'), '换档之后要重喂岛（亮底打折跟着 isDaylight 走）');
  assert.match(refresh, /refreshModeSettings\(/, '面板开着要跟着重画（滑杆显示值来自 getTuning）');
});

// ── R196（Q72 终审 · B1）：宿主改掉的那一格缺省（绘光的画框）+ 垫层撤掉之后守卫的兜底 ────────────
test('R196：宿主改掉的缺省（绘光画框=关）在合成层生效、用户能改回来，岛容器不再自带底色', async () => {
  const { createTuningResolver } = await import('../src/folia-host/tuning-merge.ts');
  const src = await read('src/folia-host/tuning-defaults.ts');
  const island = await read('src/folia-host/island.tsx');
  const types = await read('src/folia/types.ts');
  assert.match(src, /FOLIA_TUNING_DEFAULT_OVERRIDES: TuningOverrideTable = \{\s*lumiere: \{ overlayFrame: false, darkField: 1 \},/,
    'R196：改缺省的那两格要在表里（画框缺省关 + 暗场不透明）');
  assert.match(src, /createTuningResolver\(FOLIA_TUNING_DEFAULTS, FOLIA_TUNING_UNAVAILABLE, FOLIA_TUNING_DEFAULT_OVERRIDES\)/,
    '合成入口要把这张表带上（否则表就是死代码）');
  // 优先级：缺省 → 宿主改掉的缺省 → 用户改过的格（用户永远最大）
  const resolve = createTuningResolver({ lumiere: { overlayFrame: true, fogDensity: 1, darkField: 0.75 } }, undefined, { lumiere: { overlayFrame: false, darkField: 1 } }).resolve;
  assert.equal(resolve('lumiere', undefined).overlayFrame, false, '没改过 ⇒ 吃宿主改掉的缺省');
  assert.equal(resolve('lumiere', {}).overlayFrame, false, '空补丁也一样');
  assert.equal(resolve('lumiere', { overlayFrame: true }).overlayFrame, true, '用户在面板里开回来 ⇒ 用户最大');
  assert.equal(resolve('lumiere', { fogDensity: 2 }).fogDensity, 2, '别的格不受这张表影响');
  // 暗场：岛底撤成透明之后，"透出来"的是岛下面的 3D 归档场景（鬼影）⇒ 缺省调到不透明
  assert.equal(resolve('lumiere', undefined).darkField, 1, 'R196：暗场缺省 1（不透明，画面自己盖满）');
  assert.equal(resolve('lumiere', { darkField: 0.6 }).darkField, 0.6, '用户拖过暗场照样作数');
  // 移植件那一份一个字不动（R53 的纪律：逐字对照上游）—— 我们只在自己的层里改缺省
  assert.match(types, /overlayFrame: true,/, '移植件里那一格仍是上游缺省 true');
  // 垫层撤掉之后的连带：岛容器不许再写自己的底；守卫的兜底底改读岛下面那一层（否则读成透明＝黑底）
  assert.doesNotMatch(island, /host\.style\.background = /, 'R196：岛容器不许再写自己的底色（那就是垫层）');
  assert.match(island, /querySelector<HTMLElement>\("#stage"\)/, 'R196：守卫的兜底底改读 #stage（岛下面那一层）');
});


// ── R178（拍板三件落地）：cappella 头像"选了回落封面 + 面板一句实话"要成对存在 ──────────────
// 背景：Q58 批复"那份七档共用的面板先不搬"⇒ 今天界面上切不到 avatarSource；会落到 builtin/custom 的
// 只有两种情形——磁盘上的旧偏好、以及日后批准搬面板之后的用户选择。两种都不许出现"选了没图还不说原因"。
test('R178：服务不了的取值在合成层回落，且回落与那句实话同进退', async () => {
  const { createTuningResolver } = await import('../src/folia-host/tuning-merge.ts');
  const defaultsSrc = await read('src/folia-host/tuning-defaults.ts');
  const typesSrc = await read('src/folia/types.ts');
  const app = await read('src/music-app.ts');
  const glue = await read('src/folia-host/mode-settings.tsx');
  // 从 tuning-defaults.ts 里解析那张回落表（不重抄值；解析出零条就算扫描坏了）
  const tableAt = defaultsSrc.indexOf('FOLIA_TUNING_UNAVAILABLE: UnavailableTuningMap');
  assert.notEqual(tableAt, -1, '回落表找不到了（判据要跟着搬家，不许放宽）');
  const tableBody = defaultsSrc.slice(tableAt, defaultsSrc.indexOf('};', tableAt));
  const rules = [];
  for (const modeMatch of tableBody.matchAll(/^\s{2}([a-z]+): \[([\s\S]*?)^\s{2}\],$/gm)) {
    const field = /field: "([a-zA-Z0-9_]+)"/.exec(modeMatch[2])?.[1];
    const values = (/values: \[([^\]]*)\]/.exec(modeMatch[2])?.[1] ?? '')
      .split(',').map((v) => v.trim().replace(/^"|"$/g, '')).filter(Boolean);
    const fallback = /fallback: "([a-zA-Z0-9_]+)"/.exec(modeMatch[2])?.[1];
    assert.ok(field && values.length > 0 && fallback, `${modeMatch[1]} 的回落规则形状不全`);
    rules.push({ mode: modeMatch[1], field, values, fallback });
  }
  assert.ok(rules.length >= 1, '一条回落规则都没解析到 ⇒ 是扫描坏了，别拿它当证据');
  const unavailable = {};
  const defaults = {};
  for (const rule of rules) {
    (unavailable[rule.mode] ??= []).push(rule);
    const constName = `DEFAULT_${rule.mode.toUpperCase()}_TUNING`;
    const at = typesSrc.indexOf(`export const ${constName}`);
    assert.notEqual(at, -1, `${constName} 不存在`);
    const open = typesSrc.indexOf('{', at);
    const close = typesSrc.indexOf('\n};', open);
    const cells = {};
    for (const line of typesSrc.slice(open + 1, close).split('\n')) {
      const m = line.match(/^\s*([A-Za-z0-9_]+):\s*(.+?),?\s*$/);
      if (m) cells[m[1]] = m[2].replace(/'/g, '');
    }
    defaults[rule.mode] = cells;
    // **回落的目标必须就是上游那份缺省值**：回落到"我们另挑的一个值"就是第二次自作主张
    assert.equal(cells[rule.field], rule.fallback,
      `${rule.mode}.${rule.field} 要回落到缺省值本身（缺省是 ${cells[rule.field]}，规则写的是 ${rule.fallback}）`);
  }
  const resolve = createTuningResolver(defaults, unavailable).resolve;
  // 行为：服务不了的值 ⇒ 回落；能服务的值 ⇒ 一个字都不改
  for (const rule of rules) {
    for (const value of rule.values) {
      assert.equal(resolve(rule.mode, { [rule.field]: value })[rule.field], rule.fallback,
        `${rule.mode}.${rule.field} = ${value} 应当回落成 ${rule.fallback}`);
    }
    const keepable = Object.entries(defaults[rule.mode]).find(([k, v]) => k === rule.field && !rule.values.includes(v));
    assert.ok(keepable, `${rule.mode}.${rule.field} 的缺省值本身也被列为"服务不了"⇒ 这一档永远画不出东西`);
    assert.notEqual(resolve(rule.mode, { [rule.field]: 'color' })[rule.field], undefined,
      `${rule.mode}.${rule.field} 传个没列进规则的值，不许被顺手抹成 undefined`);
  }
  // cappella 这一格的具体语义（别的档的规则不适用这几句，所以按档名圈住）
  const cappella = rules.find((r) => r.mode === 'cappella');
  assert.ok(cappella, 'cappella 的回落规则不见了（拍板 ③ 落空）');
  assert.equal(resolve('cappella', { avatarSource: 'cover' }).avatarSource, 'cover', '封面这条路本仓服务得了，不许动');
  assert.equal(resolve('cappella', { avatarSource: 'color' }).avatarSource, 'color', '色块同理：能服务的值一个字都不改');
  // **完整性**：上游那个联合类型里的每个值，要么被规则回落、要么在"本仓服务得了"清单里点名。
  // 少列一个值（比如把 custom 删掉）不是"规则变松"，是"那个值会静默画不出东西"⇒ 这条拦的就是这个。
  const upstreamTypes = await read('../references/folia-major/src/types.ts').catch(() => null);
  if (upstreamTypes) {
    const union = /export type CappellaAvatarSource = ([^;]+);/.exec(upstreamTypes.replace(/\r\n/g, '\n'))?.[1]
      .split('|').map((v) => v.trim().replace(/'/g, ''));
    assert.ok(Array.isArray(union) && union.length >= 4, `上游联合类型解析不对（${union}）⇒ 别拿它当证据`);
    const SERVICEABLE = ['cover', 'color']; // 有封面走封面（avatarImages.ts:93-95）、没封面走色块（:89-91 + 空池 :61-63）
    assert.deepEqual(union.slice().sort(), [...new Set([...cappella.values, ...SERVICEABLE])].sort(),
      'avatarSource 的取值必须逐个有交代：要么列进回落规则，要么列进"本仓服务得了"（两边都不沾就是静默画不出东西）');
    const avatars = await read('src/folia/components/visualizer/cappella/avatarImages.ts');
    for (const v of SERVICEABLE) {
      assert.ok(avatars.includes(`=== '${v}'`), `${v} 被列为"服务得了"，但移植件里没有那条分支 ⇒ 清单是假的`);
    }
  }
  // 接线：合成时必须真的带上这张表（只定义不传 = 回落永不发生）
  // R196：合成入口多带一张"宿主改掉的缺省"表（判据不放宽 —— 回落表照样必须传进去）
  assert.match(defaultsSrc, /createTuningResolver\(FOLIA_TUNING_DEFAULTS, FOLIA_TUNING_UNAVAILABLE, FOLIA_TUNING_DEFAULT_OVERRIDES\)/,
    '回落表要传进 resolver，只定义不传等于没做');
  // 耦合：有回落规则的档必须都有那句实话，一个不多一个不少（不许"回落了但界面不说"）
  const notesAt = app.indexOf('FOLIA_MODE_SETTINGS_NOTES: Partial<Record<FoliaMode, string>>');
  assert.notEqual(notesAt, -1, '宿主那份"实话"表找不到了');
  const notesBody = app.slice(notesAt, app.indexOf('};', notesAt));
  const noteModes = [...notesBody.matchAll(/^\s{2}([a-z]+):$/gm)].map((m) => m[1]);
  assert.deepEqual([...new Set(rules.map((r) => r.mode))].sort(), noteModes.slice().sort(),
    '回落规则与那句实话必须一一对应（多一条规则就要多一句话，少一句就是静默降级）');
  const cappellaNote = /cappella:\s*\n?\s*"([^"]+)"/.exec(notesBody)?.[1] ?? '';
  assert.match(cappellaNote, /未随包发行/, '那句话要说清"素材没随包发行"，不能只写"不可用"');
  assert.match(cappellaNote, /仍显示歌曲封面/, '要说出回落成什么（歌曲封面），用户才知道点了会发生什么');
  assert.match(cappellaNote, /色块/, '没封面时画色块，这句也要一并说（否则"仍显示歌曲封面"在没封面的歌上就是假话）');
  // 渲染：两种分支（有面板 / 没面板）都要挂那句
  assert.match(glue, /options\.note/, '渲染层要读那句实话');
  assert.equal([...glue.matchAll(/\{note\}/g)].length, 2, '有面板与没面板两条分支都要挂那句（少一处就是"这一档以后有了面板就不说了"）');
  assert.match(app, /note: FOLIA_MODE_SETTINGS_NOTES\[preferences\.foliaMode\]/, '宿主每次都要按当前档给那句');
});


// —— R181（缺陷二 · 拍板 B「判据钉在呈现结果上」）——
// 判据落在**算式**上：text-contrast.ts 零 import，自检直接调用它（不是"读源码里有没有那个名字"）。
// 接线那几条只能读码（守卫要摸 DOM），但每条都钉在"这一格回退就会红"的位置上。

test('R181①：颜色解析与"半透明先合成再算对比度"', () => {
  assert.deepEqual(parseColor('#282834'), [40, 40, 52]);
  assert.deepEqual(parseColor('#fff'), [255, 255, 255]);
  assert.deepEqual(parseColor('rgb(200 201 239)'), [200, 201, 239]);
  assert.deepEqual(parseColor('rgb(255, 255, 255)'), [255, 255, 255]);
  assert.deepEqual(parseColor('rgba(255, 255, 255, 0.96)'), [255, 255, 255]);
  assert.equal(parseColor('not-a-color'), null, '读不出颜色要回 null，不许回一个猜的值');
  assert.equal(parseAlpha('rgba(255, 255, 255, 0.96)'), 0.96);
  assert.equal(parseAlpha('rgb(255, 255, 255)'), 1);
  assert.deepEqual(composite([255, 255, 255], 0.5, [0, 0, 0]), [128, 128, 128]);
  // 底是**一层层叠**出来的，不是"往上找第一个不透明的祖先"：
  // 那一版写法把半透明气泡跳过了，拿到的底错一层 ⇒ 钳制把能读的字改成不能读（cappella/dusk 10 红→19 红，真机量到）。
  assert.deepEqual(stackGround([{ color: [255, 255, 255], alpha: 0.5 }], [0, 0, 0]), [128, 128, 128]);
  assert.deepEqual(stackGround([], [10, 20, 30]), [10, 20, 30], '没有中间层就原样回底');
  assert.deepEqual(
    stackGround([{ color: [255, 0, 0], alpha: 1 }, { color: [0, 0, 255], alpha: 0.5 }], [0, 0, 0]),
    [128, 0, 128], '后一层压在前一层之上，顺序反了就叠错底');
  assert.deepEqual(stackGround([{ color: [0, 0, 0], alpha: 0 }], [200, 200, 200]), [200, 200, 200], 'alpha 0 的层等于不存在');
  assert.equal(+contrastRatio([0, 0, 0], [255, 255, 255]).toFixed(2), 21);
  assert.equal(+contrastRatio([10, 10, 10], [10, 10, 10]).toFixed(2), 1);
  // 亮/暗底的分界只看量出来的亮度，且与 theme-bridge 的 isDaylight 同一条（0.35）
  assert.equal(groundIsLight([200, 201, 239]), true, 'day 那张浅封面要判成亮底');
  assert.equal(groundIsLight([13, 13, 26]), false, 'night 判成暗底');
  assert.equal(groundIsLight([128, 128, 128]), false, '中灰（0.216）按暗底走 —— 这条边界挪动就是换一套钳法');
  // 字号→阈值那一格的边界必须真的在 24（>= 写成 > 就会让 24px 的字掉到 3.0 档）
  assert.equal(floorForSize(24), INK_FLOOR_BODY, '24px 正好是正文档');
  assert.equal(floorForSize(23.9), INK_FLOOR_SOFT);
  assert.equal(floorForSize(11), INK_FLOOR_SOFT);
});

test('R181②：钳到阈值 = 朝远离底的方向推；达标的一律不动（幂等）', () => {
  const lightGround = [200, 201, 239]; // day + 这张浅紫封面（真机量到的岛底）
  const darkGround = [13, 13, 26];     // night
  const pushed = clampInkToFloor([255, 255, 255], lightGround, INK_FLOOR_BODY);
  assert.ok(contrastRatio(pushed, lightGround) >= INK_FLOOR_BODY, `钳完仍不达标：${contrastRatio(pushed, lightGround)}`);
  assert.ok(relativeLuminance(pushed) < relativeLuminance(lightGround), '亮底上要往暗处推，不是往更亮处推');
  const keep = [232, 232, 237];
  assert.deepEqual(clampInkToFloor(keep, darkGround, INK_FLOOR_BODY), keep, '本来就达标的不许动');
  assert.deepEqual(clampInkToFloor(pushed, lightGround, INK_FLOOR_BODY), pushed, '钳过的再钳一次要逐字不变（每次换主题都重推，不幂等就会逐轮漂色）');
  // 暗底方向也要能推（"深色主题 + 亮封面"那一格就是反过来的形状）
  const lifted = clampInkToFloor([40, 40, 52], darkGround, INK_FLOOR_BODY);
  assert.ok(contrastRatio(lifted, darkGround) >= INK_FLOOR_BODY);
  assert.ok(relativeLuminance(lifted) > relativeLuminance(darkGround));
});

test('R181③：真机矩阵里量到的不达标逐条过算式（数字来自 13 档 × 3 主题 + 封面墙）', () => {
  const CASES = [
    ['rgb(200, 201, 239)', 'rgb(245, 245, 252)', 17, 'cappella 对方气泡：拿背景色当字色（量到 1.36）'],
    ['rgba(255, 255, 255, 0.96)', 'rgb(200, 201, 239)', 26, 'monet 歌手行：写死的白（量到 1.49）'],
    ['rgba(255, 255, 255, 0.84)', 'rgb(200, 201, 239)', 14, 'monet 专辑行：写死的白，次要档（量到 2.03）'],
    ['rgb(141, 85, 175)', 'rgb(200, 201, 239)', 72, 'classic 强调字：accent 当字色（量到 2.75）'],
  ];
  for (const [color, ground, size, why] of CASES) {
    const floor = floorForSize(size);
    const raw = parseColor(color);
    const before = contrastRatio(composite(raw, parseAlpha(color), parseColor(ground)), parseColor(ground));
    assert.ok(before < floor, `${why}：这一格现在不红了（${before.toFixed(2)} ≥ ${floor}）⇒ 用例过期，去重测矩阵`);
    const decision = decideTextColor(color, ground, floor);
    assert.ok(decision.changed, `${why}：跌破阈值却没被钳 ⇒ 算式不认这个形状`);
    const after = contrastRatio(parseColor(decision.color), parseColor(ground));
    assert.ok(after >= floor, `${why}：钳到 ${after.toFixed(2)} 仍低于 ${floor}`);
  }
  const untouched = decideTextColor('rgb(190, 190, 197)', 'rgb(13, 13, 26)', INK_FLOOR_BODY);
  assert.equal(untouched.changed, false, '深夜档本来就够的字不许动（动了就是"修一处顺手改了 13 档的画"）');
});

test('R181④：接线 —— 令牌侧钳在唯一出处，守卫侧不接管淡出动画', async () => {
  const bridge = await read('src/folia-host/theme-bridge.ts');
  const guard = await read('src/folia-host/text-guard.ts');
  const island = await read('src/folia-host/island.tsx');
  assert.match(bridge, /from "\.\/text-contrast"/, '桥要用共享算式，不在自己文件里再写一套对比度');
  assert.match(bridge, /primaryColor: floored\(primary, canvasBack, 4\.5\)/, '喂给岛的主文字色要钳到正文阈值（R200：基准是与页面底同相的新底 —— 亮度与 back 相同，判定不变）');
  assert.match(bridge, /secondaryColor: floored\(secondary, canvasBack, 3\)/, '次要文字色钳到 3（同上，基准换新底）');
  assert.match(bridge, /accentColor: derived\.accent \|\| tokens\.accent,/, 'accent 不在令牌侧钳：它在岛内是装饰色，钳它会拉走整档色相（它被当字色用的那一格由守卫按实际底钳）');
  const flooredFn = bridge.slice(bridge.indexOf('const floored'), bridge.indexOf('export interface HostThemeBridgeOptions'));
  assert.ok(flooredFn.includes('const floored'), 'floored 这一层不见了');
  assert.doesNotMatch(flooredFn, /themeName|'day'|"day"|'dusk'|'night'/, '钳制的判据里出现主题名 = 按名字分支，"深色主题 + 亮封面"会反向再挖一次同一个坑');
  // 守卫的两条边界：淡出不管、只撤自己写的那一份
  assert.match(guard, /effectiveAlphaOf\(el, root\) < FADED_OUT/, '元素级淡出要跳过（那是移植件的逐帧动画，宿主改 style.opacity 就是和动画对打）');
  assert.doesNotMatch(guard, /\.style\.opacity\s*=/, '守卫一处都不许写 style.opacity');
  assert.match(guard, /floorForSize\(size\)/, '字号→阈值要走唯一出处，不在守卫里另抄一份数');
  assert.match(guard, /styleObserver\.observe\(el, \{ attributes: true, attributeFilter: \["style"\] \}\)/,
    '已钳的那一格要单独盯它的 style：换歌时 React 会把内联色写回它自己那一份，等 2 秒那一遍才补上就看得见闪');
  assert.match(guard, /el\.style\.color === mine\) continue/,
    '自己写下去的那一次必须跳过 —— 不跳就是自己触发自己，无限循环');
  assert.match(guard, /written\.set\(el, el\.style\.color\)/,
    '比"是不是我自己写的"要用**读回来**的那一份：CSS 把 rgb(40 40 52) 规范成 rgb(40, 40, 52)，拿写进去的字符串比永远不相等 ⇒ 真机卡死整页（这一格量到过）');
  assert.doesNotMatch(guard, /written\.set\(el, decision\.color\)/, '不许退回"拿我算出来的串去比"的那种写法');
  assert.doesNotMatch(guard, /4\.5|:\s*3\b/, '守卫里不许出现阈值数字（阈值只在 text-contrast 一处）');
  assert.match(guard, /el\.dataset\[INK_STYLE_ATTR\] = el\.style\.color/, '写之前要把原来那份内联色存下来');
  assert.match(guard, /el\.style\.color = el\.dataset\[INK_STYLE_ATTR\] \?\? ""/, '还原时只还原自己那一份');
  assert.doesNotMatch(guard, /if \(el\.style\.color\) el\.style\.color = ""/, '不许无条件清内联色：档自己也写内联色，误撤就是和 React 对打');
  assert.match(guard, /paintGroundOf\(el, root, back\)/, '对比度要按"字实际压在的那块底"算，不是按页面底');
  assert.match(guard, /stackGround\(layers, base\)/, '底要按层叠：跳过半透明层会拿错底（真机回归过：cappella/dusk 从 10 红变 19 红）');
  assert.doesNotMatch(guard, /alphaOf\(bg\) > 0\.999\) return bg/, '不许退回"第一个不透明祖先"那一版');
  assert.match(guard, /alphaOf\(bg\) > 0\)/, '半透明层要算进底里（>0 而不是 >0.999）—— 气泡那层就是半透明的');
  // 岛装卸两处都在（R118 那一族：只起不停 = 观察器挂在已死的岛上）
  // R196：守卫的兜底底改读 #stage（垫层撤掉后岛自己是透明的）⇒ 允许这个调用跨行
  assert.match(island, /textGuard = createFoliaTextGuard\(\{\s*root: host/, '挂载后要起守卫');
  assert.match(island, /textGuard\?\.stop\(\);/, '卸装要停');
  assert.equal([...island.matchAll(/createFoliaTextGuard\(/g)].length, 1, '守卫只许起一处');
});


// —— R185（缺陷二 · 第二段：先查"38 格为什么没咬"）——
// 验收侧定的次序（run log §8.4）：先修 38 格（查守卫为什么没咬）→ 对齐 27 格的两套阈值 → 封面墙 → 收口。
// 这一节钉的是"没咬"那一层：守卫**只看 computed `color`** 的那一版，对三档字整个放空 ——
// ① 渐变裁切（真正画出来的是 `background-image` 里的渐变）；② 色值自带 alpha 的淡出（卡拉OK 未唱档）；
// ③ 低 alpha 的极端墨色**结构上钳不动**（往 `[252,252,252]` 推是变暗，与"远离暗底"相反）。

test('R185①：渐变裁切的字，真正画出来的是一段渐变（读 `color` 必然失明）', () => {
  // 真形状（一手探针在 monet/day 的活动行上量到）：color 是深灰、fill 是 alpha 0、真正画的是白色渐变。
  const img = 'linear-gradient(90deg, rgb(255, 255, 255) 0%, rgba(255, 255, 255, 0.92) 68%, rgba(255, 255, 255, 0.72) 100%)';
  assert.deepEqual(gradientInkStops(img), ['rgb(255, 255, 255)', 'rgba(255, 255, 255, 0.92)', 'rgba(255, 255, 255, 0.72)']);
  assert.deepEqual(gradientInkStops('none'), []);
  assert.deepEqual(gradientInkStops(''), []);
  const light = 'rgb(200, 201, 239)'; // day 这张浅封面（真机量到的岛底）
  const worst = worstGradientInk(img, light);
  // 最差的一档 = **对比度最低**的那个色标（0.72 那个），不是"最后一个"也不是"第一个"
  assert.equal(worst?.ink, 'rgba(255, 255, 255, 0.72)');
  assert.ok((worst?.contrast ?? 9) < 1.5, `渐变墨在亮底上最差要 < 1.5，量到 ${worst?.contrast}`);
  // 只读 `color` 的那条路会算成 4.93（合格）⇒ 这一格永远修不到。这就是"38 格为什么没咬"的第一层。
  assert.ok(contrastRatio(parseColor('rgb(85, 85, 103)') ?? [0, 0, 0], parseColor(light) ?? [0, 0, 0]) > INK_FLOOR_BODY,
    '那一格的 computed color 本来是"达标"的 ⇒ 只看 color 的判据在这一档上完全放空');
  assert.equal(worstGradientInk(img, 'not-a-color'), null, '底读不出来回 null，不猜');
});

test('R185②：resolvePaintedInk 按"画出来的是什么"取墨 —— 渐变 > 填充色 > color', () => {
  const light = 'rgb(200, 201, 239)';
  const grad = resolvePaintedInk({
    color: 'rgb(85, 85, 103)', fill: 'rgba(0, 0, 0, 0)',
    backgroundClip: 'text', backgroundImage: 'linear-gradient(90deg, rgb(255, 255, 255) 0%)', ground: light,
  });
  assert.equal(grad?.viaGradient, true, 'background-clip:text + 渐变 ⇒ 走渐变那一支（color / fill 都不参与绘制）');
  assert.equal(grad?.alpha, 1);
  assert.notEqual(grad?.ink, 'rgb(85, 85, 103)', '判定次序反了就会拿 computed color 当墨 ⇒ 放空');
  // 第二条：显式 `-webkit-text-fill-color` 与 `color` 不同 ⇒ 用 fill（computed fill 才是画出来的）
  const fill = resolvePaintedInk({
    color: 'rgb(255, 255, 255)', fill: 'rgba(255, 255, 255, 0.34)',
    backgroundClip: 'border-box', backgroundImage: 'none', ground: light,
  });
  assert.equal(fill?.ink, 'rgba(255, 255, 255, 0.34)', '卡拉OK 未唱档：淡的是**色值 alpha**，不是元素 opacity');
  assert.equal(fill?.alpha, 0.34, 'PaintedInk.alpha 要带上色值自己的 alpha —— 它和元素 opacity 是同一套淡出的两种写法');
  assert.equal(fill?.viaGradient, false);
  // 第三条：fill 与 color 解析出来完全相同（浏览器没写过 fill，或写的是 currentColor）⇒ 用 color，不走第二支
  const same = resolvePaintedInk({
    color: 'rgb(40, 40, 52)', fill: 'rgb(40, 40, 52)',
    backgroundClip: 'border-box', backgroundImage: 'none', ground: light,
  });
  assert.equal(same?.ink, 'rgb(40, 40, 52)');
  assert.equal(same?.alpha, 1);
  assert.equal(resolvePaintedInk({
    color: 'rgb(40, 40, 52)', fill: 'rgb(40, 40, 52)',
    backgroundClip: 'border-box', backgroundImage: 'none', ground: 'nope',
  }), null, '底读不出来回 null');
  // 有渐变声明但色标一个都读不出 ⇒ 退回 fill/color（不许因为"看见了 background-image"就交白卷）
  const badGrad = resolvePaintedInk({
    color: 'rgb(40, 40, 52)', fill: 'rgb(40, 40, 52)',
    backgroundClip: 'text', backgroundImage: 'linear-gradient(90deg, transparent 0%)', ground: light,
  });
  assert.equal(badGrad?.ink, 'rgb(40, 40, 52)', '读不出色标就回退到填充色，不能因此不判');
  assert.equal(badGrad?.viaGradient, false);
});

test('R185③：元素级透明度按"画出来的色"算；低 alpha 的极端墨色结构上钳不动', () => {
  const dark = 'rgb(13, 13, 26)'; // night（真机量到的岛底）
  // A 类：不透明的中灰字在暗底上**钳得动**（真机 monet/night 量到 rgb(93,93,101) = 2.95）
  const fixable = decideTextColor('rgb(93, 93, 101)', dark, INK_FLOOR_BODY, 1);
  assert.ok(fixable.changed, `不透明的中灰字在暗底上要能钳（真机那一格 ${contrastRatio([93, 93, 101], [13, 13, 26]).toFixed(2)}）`);
  assert.ok(fixable.changed && fixable.to >= INK_FLOOR_BODY, '钳到的那个数也要达标（to 是**合成后**量出来的）');
  // B 类：极端墨色 + 低 alpha **钳不动** —— 白字往 [252,252,252] 推是变暗，与"远离暗底"相反；
  // 而"把 alpha 抹成 1"会删掉上游的淡出设计 ⇒ 只能记「接受类」，不能靠钳它。
  const stuck = decideTextColor('rgba(255, 255, 255, 0.4)', dark, INK_FLOOR_BODY, 1);
  assert.equal(stuck.changed, false, '极端色 + 低 alpha 这一格结构上钳不动（这就是"38 格没咬"的第二层）');
  assert.ok(contrastRatio(composite([255, 255, 255], 0.4, [13, 13, 26]), [13, 13, 26]) < INK_FLOOR_BODY, '它确实不达标');
  assert.ok(1 * 0.4 < 0.6, '元素 1 × 色值 0.4 = 0.4 < 0.6 ⇒ 这一格归「接受类」（上游逐帧淡出正在画的过程中）');
  // extraAlpha 是元素级不透明度：它和色值 alpha 相乘后一起稀释这一笔 —— from/to 都要按合成后算
  const elemFade = decideTextColor('rgb(200, 200, 210)', dark, INK_FLOOR_BODY, 0.5);
  const halfShown = contrastRatio(composite([200, 200, 210], 0.5, [13, 13, 26]), [13, 13, 26]);
  assert.ok(halfShown < INK_FLOOR_BODY, `0.5 的元素透明度把这份墨冲淡到 ${halfShown.toFixed(2)}（< 4.5）`);
  assert.ok(elemFade.changed, '按"画出来的色"判就该钳 —— 只看声明色会算成 11.6 达标而放空（27 格那一批的成因）');
  assert.ok(elemFade.changed && elemFade.from < INK_FLOOR_BODY, 'from 必须按合成后算，不按声明色');
  assert.ok(elemFade.changed && elemFade.to >= INK_FLOOR_BODY, 'to 也要按合成后验');
  // clampInkToFloorShown 的判据是"合成后"：alpha 1 时与 clampInkToFloor 逐字等价（不许改一支忘一支）
  for (const g of [dark, 'rgb(200, 201, 239)']) {
    const g0 = parseColor(g) ?? [0, 0, 0];
    const ink = [120, 120, 130];
    assert.deepEqual(clampInkToFloorShown(ink, 1, g0, INK_FLOOR_BODY), clampInkToFloor(ink, g0, INK_FLOOR_BODY));
    assert.deepEqual(clampInkToFloorShown(ink, 1.7, g0, INK_FLOOR_BODY), clampInkToFloor(ink, g0, INK_FLOOR_BODY), 'alpha 越界要夹到 1');
  }
});

test('R185④：接线 —— 渐变那一档要连"绘制通道"一起中和，不是逐帧去改 React 的内联渐变', async () => {
  const guard = await read('src/folia-host/text-guard.ts');
  assert.match(guard, /resolvePaintedInk\(\{/, '判据要读"画出来的那一笔"，不是只看 computed color');
  assert.match(guard, /backgroundClip: cs\.getPropertyValue\("-webkit-background-clip"\)/, 'webkit 前缀那条 background-clip 才是真的，两条都要读');
  assert.match(guard, /backgroundImage: cs\.backgroundImage/, '渐变要从 background-image 读');
  assert.match(guard, /fill: cs\.getPropertyValue\("-webkit-text-fill-color"\) \|\| cs\.color/, 'fill 没写过时等于 color');
  assert.match(guard, /if \(painted\.viaGradient\) \{/, '渐变那一档要单独处置');
  assert.match(guard, /ensureClipFixStyle\(\);/, '那一档要挂中和规则');
  assert.match(guard, /el\.dataset\[CLIP_ATTR\] = "1"/, '挂上规则还要在这一格打标记（属性选择器按标记命中）');
  assert.match(guard, /document\.getElementById\(CLIP_STYLE_ID\)\) return/, '中和规则只许挂一次（重复挂会堆 <style>）');
  assert.match(guard, /document\.head\.appendChild\(style\)/, '规则要进 head');
  // 中和规则必须覆盖三条通道，且都必须 !important（React 的内联值只输给 !important）
  const rule = guard.slice(guard.indexOf('style.textContent ='), guard.indexOf('document.head.appendChild'));
  for (const frag of [
    'background-image: none !important',
    '-webkit-text-fill-color: currentColor !important',
    'background-clip: border-box !important',
  ]) assert.ok(rule.includes(frag), `中和规则缺一条：${frag}`);
  assert.doesNotMatch(guard, /el\.style\.backgroundImage\s*=/, '不许去改 React 的内联渐变（下一帧就被写回来，与 R181 那条 style.opacity 同一个理由）');
  // 判据面第二处：色值自己的 alpha 也要算进"画出来有多不透明"
  assert.match(guard, /if \(effA \* painted\.alpha < FADED_OUT\) \{/, '元素 opacity × 色值 alpha —— 两处淡出都要算，只算一处就是那 27 格的缝');
  assert.match(guard, /stats\.fadedSkipped \+= 1;/, '接受类的格要如实计入 fadedSkipped');
  // 判据面第三处（第二段真机抓到的那 9 格）：**祖先的 `opacity` 也会稀释它自己的底色** ——
  // cappella 气泡写的是不透明 `rgb(255,255,255)` 但同一元素挂着 `opacity: 0.82`，
  // 只读 `background-color` 的 alpha 会当它是纯白 ⇒ 把达标的字钳过头。要沿祖先链从岛根往里累乘 opacity。
  assert.match(guard, /for \(let i = chain\.length - 1; i >= 0; i -= 1\)/, '祖先链要从岛根往里走（累乘的方向反了会算错每一层的稀释）');
  assert.match(guard, /cum \*= Number\(getComputedStyle\(n\)\.opacity\)/, '每一层祖先自己的 opacity 要累乘进来');
  assert.match(guard, /alphaOf\(bg\) \* cum/, '那一层的有效 alpha = 它自己 background-color 的 alpha × 累计 opacity');
  // 撤标记要一起撤（残留标记会让下一遍以为"我钳过了"，或者那张 !important 规则改了别人）
  assert.match(guard, /if \(el\.dataset\[INK_ATTR\] \|\| el\.dataset\[CLIP_ATTR\]\) \{/, '还原时要把渐变那一档的标记一起撤掉');
  assert.match(guard, /delete el\.dataset\[CLIP_ATTR\]/, '');
  assert.equal(Number((guard.match(/export const FADED_OUT = ([\d.]+)/) ?? [])[1]), 0.6, '守卫的淡出分界');
});

// —— R185⑤（第二段的仪器那一半）——
// 三条定案落在**新仪器** `measure-rendered-contrast-v2.cjs` 上；`measure-rendered-contrast.cjs`（v1）
// 是 R181 那份**逐字留档、不许动**，所以新判据只许钉 v2，不许去改 v1 的断言面凑数。
test('R185⑤：仪器 v2 的三条定案（分界同源 / 先等停稳 / 主口径是声明色不是像素芯）', async () => {
  const v1 = await read('../docs/evidence/stage6/131-contrast-matrix/measure-rendered-contrast.cjs');
  const mc = await read('../docs/evidence/stage6/131-contrast-matrix/measure-rendered-contrast-v2.cjs');
  const guard = await read('src/folia-host/text-guard.ts');
  // ⓪ v1 仍在、且**没有被 R185 改过**：R181 那份读数要能原样复算（"不删旧的"）。
  assert.match(v1, /缺陷二的对比度量测 v2/, 'v1 还是 R181 那份');
  assert.ok(!/paintContrast/.test(v1), 'v1 不许长出新口径（要留档的原件）');
  // ① 分界**从守卫源码读**，不硬编码 —— 两套阈值必须是同一条（R181 那句"27 格夹缝"）
  assert.match(mc, /readFileSync\(p, 'utf8'\)|readFileSync\(p, "utf8"\)/, 'v2 要真去读守卫源码');
  assert.match(mc, /text-guard\.ts/, '读的就是那个守卫文件');
  assert.match(mc, /export const FADED_OUT = \(\[\\d\.\]\+\)/, '从源码里抠出 FADED_OUT');
  assert.match(mc, /if \(!Number\.isFinite\(FADED_OUT\)\)/, '读不出来要停下，不许猜一个默认值（猜的默认值正是那 27 格的成因）');
  assert.match(mc, /v\.paintedAlpha < FADED_OUT/, '接受类的分界用的是读来的那个数');
  assert.match(mc, /v\.paintedAlpha >= FADED_OUT/, '待修类的分界同理');
  assert.doesNotMatch(mc, /paintedAlpha < 0\.6/, '不许再把 0\.6 写死进仪器');
  assert.match(guard, /export const FADED_OUT = 0\.6;/, '守卫那一侧仍是这个数（两处同源的那一半）');
  // ② **先等停稳再取景**：逐字淡入与字幕带 0→0.6 的过渡都在动，过程里取到的是"正在画的那一帧"；
  //    再安静的时间必须 > 守卫的慢扫周期，否则量到的是"钳之前"。
  assert.match(mc, /async function settle\(c, label\)/, '要有停稳闸门');
  assert.match(mc, /await settle\(c, `\$\{mode\}\/\$\{th\}`\)/, '每格取景前都要过它');
  assert.match(mc, /if \(now === prev && now !== -1\) break/, '连续两次采样不变才算停稳');
  assert.match(mc, /await sleep\(2200\)/, '再安静 2\.2 秒（> 守卫 2000ms 慢扫）');
  const sweep = Number((guard.match(/GUARD_SWEEP_MS = (\d+)/) ?? [])[1]);
  assert.ok(2200 > sweep, `停稳后要安静得比守卫慢扫更久（${2200} > ${sweep}）`);
  // ③ 主口径 = **声明色画出来的那一份**（element × 色值 alpha 合成到量到的局部底上），
  //    像素尺（纯笔画芯那套）降为对照：细笔画在 DPR 1 下抗锯齿把笔画芯也稀释了，像素尺对小字系统性低估。
  assert.match(mc, /const inkPainted = \(it, under\) => \{/, '主口径要有一条自己的算式');
  assert.match(mc, /paintContrast: painted \? ratio\(painted, a\.under\) : null/, '主口径 = 合成后的墨 vs **量到的**局部底');
  assert.match(mc, /contrast: a\.ink \? ratio\(a\.ink, a\.under\) : null/, '像素尺保留（当对照）');
  assert.match(mc, /const fails = todo\.filter\(\(v\) => v\.paintContrast < need\(v\)\)/, '待修类过不过，用主口径判');
  assert.match(mc, /const pixFails = todo\.filter\(\(v\) => v\.contrast < need\(v\)\)/, '像素尺不达标单独报，不当主判');
  assert.match(mc, /像素尺不达标: pixFails\.length/, 'CELL 行要把它报出来');
  assert.match(mc, /两尺分歧/, '两把尺子对不上的格子要能一眼看见');
  // 合并规则那一格：**画出来什么都没有的那一层不算一层**
  // （classic 每个字形旁边有个 `color: rgba(0,0,0,0)` 的透明副本，原来"取更淡的那份"会把它当画出来的）
  assert.match(mc, /if \(it\.paintedAlpha <= 0 && hit\.paintedAlpha > 0\) continue;/, '零墨层不许赢得合并');
  assert.match(mc, /hit\.color = it\.color;/, '声明色要跟着被留下的那一层走（declContrast 与 paintedAlpha 同层才对得上账）');
  assert.match(mc, /small >= 0\.7\) \{ hit = s; break; \}/, '合并判据：小框 ≥70% 落在大框里（相邻字是 0，不许把两个真字并成一条）');
  // 墨色读不出来的格要如实记，不许悄悄归零（渐变裁切那一类）
  assert.match(mc, /inkUnknown: it\.inkAlpha <= 0 && it\.paintedAlpha <= 0/, '读不出墨要留痕');
  assert.match(mc, /墨色读不出: scored\.filter\(\(v\) => v\.inkUnknown\)\.length/, '并报进 CELL');
  // 分档的输入量（从 v1 继承、不许在 v2 里丢掉）：像素侧的"画出来有多不透明" = 元素 opacity × 墨色 alpha，
  // 墨色 alpha 对渐变裁切那一档取渐变色标里**最实**的那一个 —— 与守卫那条算式同源。
  assert.match(mc, /paintedAlpha: \+\(o \* ia\)\.toFixed\(3\)/, '仪器的"画出来有多不透明" = 元素有效不透明度 × 墨色 alpha');
  assert.match(mc, /const inkAlphaOf = \(cs\) => \{/, '墨色 alpha 要从 computed 样式里读出来');
  assert.match(mc, /if \(\/text\/i\.test\(clip\) && img && img !== "none"\) \{/, '渐变那一支：`background-clip:text` + 有渐变时取渐变色标的 alpha');
  // 同一格既算"接受类"也算"待修类"的分母只有一个：可测格 = 像素配对上量到墨的那批（读不出墨的不计入）
  assert.match(mc, /const scored = r\.cells\.filter\(\(v\) => v\.contrast !== null\)/, '可测格的定义没变（配对量到墨才算）');
});

// —— R186（封面墙那 4 格：14 格里唯一在结构上有解的一格）——
// 那 4 格问的是"字 vs 它**自己的底**"：角标自绘的底原本是半透明的（封面透上来），而守卫与仪器
// 都只沿祖先链读 `background-color`。三处要同时成立才算修好 —— 底不透明（产品侧）/ 元素自己的底
// 在守卫与仪器两侧都算一层（同源）/ "无字"那一帧对带自己底的元素要"只抹字、留框"（仪器侧）。
test('R186：角标自己的底不透明，"自己的底"在守卫与仪器两侧都算一层，且"无字"帧留框', async () => {
  const css = await read('src/folia/components/app/lattice/Lattice.css');
  const guard = await read('src/folia-host/text-guard.ts');
  const mc = await read('../docs/evidence/stage6/131-contrast-matrix/measure-rendered-contrast-v2.cjs');
  // ① 产品侧：角标的底必须**不透明**（`rgb(var(--lattice-shade-rgb))`，没有 `/NN%`）。
  const badge = /\.lattice-poster-badge\s*\{[^}]*\}/.exec(css)?.[0] ?? '';
  assert.ok(badge, '没抓到 .lattice-poster-badge');
  assert.match(badge, /background:\s*rgb\(var\(--lattice-shade-rgb\)\);/, '角标自己的底要实色（原先 /62% 让封面透上来）');
  assert.doesNotMatch(badge, /--lattice-shade-rgb\)\s*\/\s*\d/, '角标的底不许再带透明度');
  const current = /\.lattice-poster-badge\.is-current\s*\{[^}]*\}/.exec(css)?.[0] ?? '';
  assert.match(current, /background:\s*rgb\(var\(--lattice-shade-rgb\)\);/, '当前行那颗同理（原先 /78%）');
  // ② 守卫与仪器两侧的底模型同源地含 `el` 自己（起点从 `el.parentElement` 改成 `el`）。
  assert.match(guard, /for \(let n: HTMLElement \| null = el; n; n = n\.parentElement\)/, '守卫：链起点含 el 自己');
  assert.match(mc, /for \(let n = el; n; n = n\.parentElement\) \{ const bg = getComputedStyle\(n\)\.backgroundColor;/, '仪器 ggOf 同步改起点（两处不许漂）');
  // ③ 仪器侧："无字"那一帧对**带自己底**的元素只抹字、留框 —— 不然量到的 under 是它背后的封面像素。
  assert.match(mc, /const alphaOfBg = \(s\) =>/, '要能判"这一格有没有自己的底"');
  assert.match(mc, /if \(bg && bg !== 'transparent' && alphaOfBg\(bg\) > 0\.001\) \{/, '判据是"这一格自己画了底"（判据写错 = 那一类又退回被抹掉框的老路）');
  assert.match(mc, /el\.style\.color = 'transparent'/, '带自己底的元素：抹字色');
  assert.match(mc, /el\.style\.webkitTextFillColor = 'transparent'/, '填充色也抹（`-webkit-text-fill-color` 会盖过 color）');
  assert.match(mc, /el\.style\.textShadow = 'none'/, '阴影也关（它也会被算成"字"）');
  assert.match(mc, /else \{ el\.style\.visibility = 'hidden'; \}/, '没有自己底的元素走原路（读数一字不变）');
  assert.match(mc, /if \(el\.dataset\.__box\) \{ el\.style\.color = el\.dataset\.__c;/, 'SHOW 要把这三格还原');
  // ④ 改了移植件就必须同步登记 R53 白名单（否则那头"逐字一致"的校验会红）
  const port = await read('scripts/check-folia-port.mjs');
  assert.match(port, /\['components\/app\/lattice\/Lattice\.css', 'R186/, 'Lattice.css 的改写要登记理由');
});

// —— R200（Q72 真终章）：画布底色与页面底同色相（"同色相、明度贴画布原底"）——
// 用户点名的三档自绘底（绘光的暗场 / 蛋彩的纸 / 静止的渐晕）要"从宿主令牌派生"：
// 色相取页面底（--page-bg），明度贴画布原底（--folia-back 派生值）—— 前两者经桥的
// backgroundColor 拿到新底，静止档的硬编码黑在移植件里单独换。算式在 page-hue.ts（零第三方 import）。
test('R200：底色对齐页面底 —— 色相取页面底、亮度贴原底（算式可调用 + 桥真的用它）', async () => {
  const { matchHueKeepLuma } = await import('../src/folia-host/page-hue.ts');
  const lum = (c) => relativeLuminance(c);
  const relDiff = (a, b) => Math.abs(lum(a) - lum(b)) / (lum(a) || 1);
  const hueOf = ([r, g, b]) => {
    const mx = Math.max(r, g, b), mn = Math.min(r, g, b), d = mx - mn;
    if (!d) return NaN;
    const h = mx === r ? ((g - b) / d) % 6 : mx === g ? (b - r) / d + 2 : (r - g) / d + 4;
    return ((h * 60) % 360 + 360) % 360;
  };
  const sat = ([r, g, b]) => { const mx = Math.max(r, g, b), mn = Math.min(r, g, b); return mx ? (mx - mn) / mx : 0; };
  const dHue = (a, b) => { const d = Math.abs(a - b) % 360; return Math.min(d, 360 - d); };
  const chanOrder = ([r, g, b]) => (r >= g && g >= b ? 1 : r <= g && g <= b ? -1 : 0);

  // ① 恒等：同值输入必须逐位回（取色失败回退 --page-bg 时不许漂）
  assert.deepEqual(matchHueKeepLuma([8, 18, 31], [8, 18, 31]), [8, 18, 31], '同值必须恒等');
  // ② 纯黑没有色相可用：原样回（不许把黑"染"成页面底的色）
  assert.deepEqual(matchHueKeepLuma([0, 0, 0], [8, 18, 31]), [0, 0, 0], '纯黑原样回');
  // ③ 明度贴原底（线性域保持，量化误差 <2%）+ 色相随页面底（有色相时比角度、低饱和时比通道序）
  const cases = [
    [[13, 13, 26], [8, 18, 31]],     // 深夜：取色底 ≈ 页面底（k≈1）
    [[200, 201, 239], [232, 229, 225]], // 暖昼：浅取色底 → 暖白页面底
    [[60, 30, 80], [8, 18, 31]],     // 暖紫取色底 → 蓝黑页面底（用户量到的那一档的形状）
  ];
  for (const [src, page] of cases) {
    const out = matchHueKeepLuma(src, page);
    assert.ok(relDiff(src, out) < 0.02, `明度必须贴着原底走（${src} -> ${out}）`);
    if (sat(page) > 0.2) assert.ok(dHue(hueOf(out), hueOf(page)) <= 2, `色相必须跟页面底走（${src} + ${page} -> ${out}，h ${hueOf(out)} vs ${hueOf(page)}）`);
    else assert.equal(chanOrder(out), chanOrder(page), `低饱和页面底比通道序（${src} + ${page} -> ${out}）`);
  }
  // ④ 桥真的在用（钉链）：backgroundColor 过算式、字色钳制的基准同步换成新底、旧行不许留着。
  const bridge = await read('src/folia-host/theme-bridge.ts');
  assert.match(bridge, /import \{ matchHueKeepLuma \} from "\.\/page-hue"/, '桥要 import 共享算式，不在自己文件里再写一套');
  assert.match(bridge, /const canvasBack = pageHueKeptLuma\(back, tokens\.back\)/, '喂岛的底色必须过这一层（--folia-back 的明度 + --page-bg 的色相）');
  assert.match(bridge, /backgroundColor: canvasBack/, 'Theme.backgroundColor 行必须就是这份新底');
  assert.match(bridge, /floored\(primary, canvasBack, 4\.5\)/, '字色钳制的基准要换成新底（字压在的就是它）');
  assert.doesNotMatch(bridge, /backgroundColor: back\b/, '旧的"直接喂取色底"那行不许留着');
});

// —— R202：歌词面 / 封面墙的"背景模糊层"（可调）——
// 用户原话：打开歌词界面或封面墙时，背后的画面被模糊掉（相当于垫一张可调模糊程度的透明图）；
// 并支持把"当前播放曲目的封面"作为这层模糊图的来源（封面 → 放大 → 高斯模糊 → 低透明度）。
// 参数与缺省在 backdrop-defaults.ts（零 import，自检直接调）；DOM 一条红线是"封面地址只可能是同源"。
test('R202：背景模糊层 —— 参数合成（三主题缺省 + 用户补丁逐格覆盖）与"同源封面"红线', async () => {
  const mod = await import('../src/folia-host/backdrop-defaults.ts');
  const { resolveBackdrop, backdropActive, backdropDefaults } = mod;

  // ① 三主题各自缺省：day（亮）与 night/dusk（暗）是两套，且 day 的模糊更"浅"（用户要求：day 浅、night 深）。
  const day = backdropDefaults(true);
  const night = backdropDefaults(false);
  assert.ok(day.blur < night.blur, 'day 的模糊半径必须小于 night（用户要求"day 浅、night 深"）');
  assert.ok(day.opacity > night.opacity, 'day 的封面上不透明度必须高于 night（亮底需要更实一点才看得见）');
  assert.equal(day.source, 'cover', '缺省来源是当前曲封面（用户点名的效果）');

  // ② 用户补丁逐格覆盖，没改过的格仍跟主题缺省走。
  const onlyBlur = resolveBackdrop(true, { blur: 12 });
  assert.equal(onlyBlur.blur, 12, '改过的格用用户值');
  assert.equal(onlyBlur.source, day.source, '没改过的格跟主题缺省');
  assert.equal(onlyBlur.opacity, day.opacity, '没改过的格跟主题缺省');
  // 逐格独立：只改 source 不改 blur。
  const onlySource = resolveBackdrop(false, { source: 'underlay' });
  assert.equal(onlySource.source, 'underlay');
  assert.equal(onlySource.blur, night.blur, '换来源不许顺手改模糊半径');

  // ③ 钳制与脏值：blur 钳到 0~80、opacity 钳到 0~1；认不出的 source 回落缺省（不是 0）。
  assert.equal(resolveBackdrop(true, { blur: 999 }).blur, 80, '模糊半径上限 80');
  assert.equal(resolveBackdrop(true, { blur: -5 }).blur, 0, '0 是"用户明确要关"的合法值');
  assert.equal(resolveBackdrop(true, { opacity: 5 }).opacity, 1, '不透明度上限 1');
  assert.equal(resolveBackdrop(true, { source: 'nope' }).source, day.source, '认不出的来源回落缺省');
  assert.equal(resolveBackdrop(true, { blur: Number.NaN }).blur, day.blur, 'NaN 回落缺省（不写成 0）');

  // ④ 生效判据收口在一处：off 关；blur==0 也等效于关（用户把滑杆拖到 0 = 不要模糊）。
  assert.equal(backdropActive({ source: 'off', blur: 40, opacity: 0.5 }), false, 'off 档要关');
  assert.equal(backdropActive({ source: 'cover', blur: 0, opacity: 0.5 }), false, '模糊半径 0 等效于关');
  assert.equal(backdropActive({ source: 'underlay', blur: 12, opacity: 0 }), true, '下层画面档不看不透明度');

  // ⑤ 红线：封面地址只可能是同源（本地 /api/artwork/…、在线 /api/online/artwork/…）；第三方 URL 一律不取。
  const { isSameOriginArtworkUrl } = await import('../src/folia-host/backdrop.ts');
  const origin = 'http://127.0.0.1:5266';
  for (const ok of ['/api/artwork/abc', '/api/online/artwork/token', `${origin}/api/artwork/abc`]) {
    assert.equal(isSameOriginArtworkUrl(ok, origin), true, `同源地址必须放行：${ok}`);
  }
  for (const bad of ['http://p1.music.126.net/x.jpg', 'https://y.gtimg.cn/a.jpg', '//evil.example/x.png', '', null, undefined]) {
    assert.equal(isSameOriginArtworkUrl(bad, origin), false, `非同行地址不许进 DOM（R116/R135 红线）：${bad}`);
  }
});

test('R202：背景模糊层接线 —— 宿主一帧一更、离开岛视图收干净、地址不许第三方', async () => {
  const app = await read('src/music-app.ts');
  // 宿主在岛喂料那一帧更新模糊层（一帧一更；`update` 内部只在任一格变了时才写 DOM）。
  // 判据圈在 feedFoliaIsland 的函数体里 —— 只查"文件里有没有这行"会被另一处（refreshBackdropNow）蒙混过关。
  const feedBody = /function feedFoliaIsland\(\) \{([\s\S]*?)\n\}/.exec(app)?.[1] ?? '';
  assert.ok(feedBody, '要能定位到 feedFoliaIsland 的函数体');
  assert.match(feedBody, /foliaBackdrop\.update\(currentBackdropParams\(\), currentBackdropCover\(\)\)/,
    '模糊层要在 feedFoliaIsland（喂岛那一帧）里更新');
  // 离开岛视图 ⇒ 收干净（它是画面之下的一层，站在档案架上不该留着）。
  assert.match(app, /foliaBackdrop\?\.reset\(\)/, '离开岛视图要收掉模糊层');
  // 主题收敛后要按新档重算（缺省是按主题给的）。
  assert.match(app, /refreshBackdropNow\(\)/, '主题切换后要按新档重算缺省');
  // R202-F3（用户实报：选「当前曲封面」却糊出档案架上选中的那张）：封面档必须**先认正在播放的曲目** ——
  // 本地按 `track.albumId` 找所属专辑（R38 口径），在线退到它自带的同源封面；没在播才退到架子上选中的专辑。
  assert.match(app, /album\?\.coverUrl \?\? track\?\.coverUrl \?\? currentAlbum\(\)\?\.coverUrl/,
    '封面档要认"正在播放的曲目"（与 feedSong 同一条链）');
  assert.doesNotMatch(app, /currentAlbum\(\)\?\.coverUrl \?\? playerState\?\.currentTrack\?\.coverUrl/,
    '按"档案架选中专辑优先"的旧链不许回来（播在线曲目时会糊错图）');
  assert.match(app, /a\?\.coverUrl \?\? t\?\.coverUrl \?\? currentAlbum\(\)\?\.coverUrl/,
    '自研歌词面的封面链同样改成"曲目优先"（同一条 R38 口径）');
  assert.doesNotMatch(app, /cover: \(\) => currentAlbum\(\)\?\.coverUrl \?\? player\.state\.currentTrack\?\.coverUrl/,
    '自研歌词面那条旧链不许回来');

  // 模糊层模块本身：封面预缩到 ≤256px、非同源不取、一帧一更（applied 比较）。
  const backdrop = await read('src/folia-host/backdrop.ts');
  assert.match(backdrop, /BACKDROP_COVER_MAX_PX = 256/, '封面预缩上限 256px（红线 ②）');
  assert.match(backdrop, /isSameOriginArtworkUrl\(coverUrl\) \? coverUrl : null/, '非同行地址一律不取（红线 ①）');
  assert.match(backdrop, /if \(same\) return;/, '一帧一更：任一格没变就不写 DOM（红线 ③）');
  assert.doesNotMatch(backdrop, /https?:\/\/(?!127\.0\.0\.1)[a-z0-9.-]+\.[a-z]{2,}/i, '模糊层模块里不许写死第三方主机');
  // R202-F4（用户实报："背景的文字也模糊"，指右侧那一整块专辑信息）：同一格半径要转达给 CSS，
  // 由档案信息块吃同一个值；关 / 半径 0 / 卸装一律**移除属性**（不是写 0）⇒ var() 回退 0px ⇒ 原样。
  assert.match(backdrop, /BACKDROP_BLUR_VAR = "--folia-backdrop-blur-px"/, '半径要经一个具名的自定义属性转达');
  assert.match(backdrop, /stage\.style\.setProperty\(BACKDROP_BLUR_VAR, `\$\{px\}px`\)/, '生效时写入半径');
  assert.match(backdrop, /stage\.style\.removeProperty\(BACKDROP_BLUR_VAR\)/, '关 / 0 / 卸装时移除属性（不许写 0）');
  assert.match(backdrop, /publishBlur\(params\.blur\);   \/\/ R202-F4：同一格半径转达给 CSS/, '生效路径要把**当前这一格半径**转达出去（只留辅助函数不算）');
  assert.match(backdrop, /publishBlur\(null\);   \/\/ R202-F4：关了就撤属性/, '关档那一路要撤');
  assert.match(backdrop, /publishBlur\(null\);   \/\/ R202-F4：卸装也撤属性/, '卸装那一路也要撤');

  // 样式：模糊层是画面之下的一层（z-index 2：三维之上、岛 3 之下），且带 backdrop-filter / img blur。
  const css = await read('src/lyric-folia-chrome.css');
  const block = /#folia-backdrop \{([\s\S]*?)\n\}/.exec(css)?.[1] ?? '';
  assert.ok(block, 'R202：`#folia-backdrop` 这条规则在');
  assert.match(block, /z-index:\s*2/, '模糊层压在三维之上、岛（z-index 3）之下');
  assert.match(block, /pointer-events:\s*none/, '模糊层不许吃掉指针（三维手势与岛都要能点）');
  assert.match(css, /#folia-backdrop img \{[\s\S]*?object-fit:\s*cover/, '封面档那张图要放大铺满');
  // R202-F1（验收侧修复）：显形门必须按"岛视图在不在"（data-folia-view）判，不能按 displayMode 判 ——
  // 「档案架 + 歌词模式」（displayMode=folia 但岛没挂）下宿主一改主题/背景模糊参数就 create 这一层，
  // 按 displayMode 判会把它显到档案架上（真机：三维专辑架被整块糊掉）。旧门连"不许回来"一起钉。
  assert.match(css, /#stage:not\(\[data-folia-view="island"\]\) #folia-backdrop \{\s*display:\s*none/,
    '显形门要按岛视图状态（data-folia-view）判');
  assert.doesNotMatch(css, /#stage:not\(\[data-display="folia"\]\) #folia-backdrop/,
    '按 displayMode 判的旧显形门不许回来（档案架 + 歌词模式会漏）');
  // R202-F2（验收侧核实）：减弱动效的静态化由全局开关覆盖（真机 0.52s/0.42s → 0.001s）。
  // 不许再挂按 `.is-reduced` 的规则——那个类在 `#lyric-stage` 上，这条规则永远匹配不上（死规则）。
  assert.doesNotMatch(css, /\.is-reduced #folia-backdrop/, '按 `.is-reduced` 的死规则不许回来');
  const musicCss = await read('src/music.css');
  assert.match(musicCss, /\.music-app\.reduce-motion \*/,
    '减弱动效的全局开关（music.css）在——它就是模糊层静态化的实际出处，删了这条覆盖就没依据');
  // R202-F4：档案信息块吃同一格模糊，且门与模糊层同源（只在岛视图里）——
  // 顶栏与悬浮控制条是"浮在画面上"的菜单（Q72），**不**跟着糊（不许写成 `#stage .album-callout` 这种无门形式）。
  assert.match(css, /#stage\[data-folia-view="island"\] \.album-callout \{\s*filter:\s*blur\(var\(--folia-backdrop-blur-px, 0px\)\)/,
    '档案信息块要按同一格半径模糊，且门是"岛视图"');
  assert.doesNotMatch(css, /^#stage \.album-callout/m, '不许无门地糊那一块（档案架上要原样）');
});

// ─────────────── R206 ⑥ · 「下一句歌词」那一行的发光（只关发光） ───────────────

import {
  SUBTITLE_OVERLAY_BACKGROUND,
  SUBTITLE_UPCOMING_LYRICS_BLUR,
} from '../src/folia-host/subtitle-glow.ts';

test('R206 ⑥-1：发光那两格由宿主关掉，常量只有一个出处', async () => {
  assert.equal(SUBTITLE_UPCOMING_LYRICS_BLUR, false, '预览行字面那 1px 模糊要关掉（用户点名的"让字更清晰"）');
  assert.equal(SUBTITLE_OVERLAY_BACKGROUND, false, '那一行外面那圈 blur-2xl 柔光底要关掉（用户点名的"辉光"）');
  const island = await read('src/folia-host/island.tsx');
  assert.match(island, /subtitleUpcomingLyricsBlur=\{SUBTITLE_UPCOMING_LYRICS_BLUR\}/, '喂岛那一处要读常量，不写字面量');
  assert.match(island, /subtitleOverlayBackground=\{SUBTITLE_OVERLAY_BACKGROUND\}/, '同上');
  // 唯一出处：这两个 prop 名只许出现在宿主那一个接线点与自撰常量文件里
  const owners = [];
  for (const entry of readdirSync(new URL('../src/folia-host/', import.meta.url))) {
    if (!/\.(ts|tsx)$/.test(entry)) continue;
    const text = await readFile(new URL(`../src/folia-host/${entry}`, import.meta.url), 'utf8');
    if (text.includes('subtitleUpcomingLyricsBlur=') || text.includes('subtitleOverlayBackground=')) owners.push(entry);
  }
  assert.deepEqual(owners, ['island.tsx'], '第二处传值 = 第二个真相（哪一档关了什么会漂）');
});

test('R206 ⑥-2：零改移植件 —— 发光那两格本来就是移植件的形参，宿主传值就够（白名单与逐字判据都不用动）', async () => {
  const overlay = await read('src/folia/components/visualizer/VisualizerSubtitleOverlay.tsx');
  // 移植件的形参缺省值必须还是 true：改了它才叫"改移植件"，本件明令不许
  assert.match(overlay, /subtitleOverlayBackground = true/, '移植件那一份缺省值不许被本件改掉（改了就要走登记改写）');
  assert.match(overlay, /subtitleUpcomingLyricsBlur = true/, '同上');
  // 两层发光的实现原样在册（本件不重写样式，只是不再挂它）
  assert.match(overlay, /blur-\[1px\]/, '字面模糊那一格在移植件里原样在（宿主关它，不改它）');
  assert.match(overlay, /blur-2xl/, '光晕层在移植件里原样在');
  const port = await read('scripts/check-folia-port.mjs');
  assert.match(port, /\['components\/visualizer\/VisualizerSubtitleOverlay\.tsx', 'R0 剥离注入注释'\]/,
    '白名单里那一条的理由文案不许被本件顺手改（本件没动那个文件，理由仍然属实）');
});

test('R206 ⑥-3：只关发光 —— 那一行照旧渲染，别的发光一概没碰', async () => {
  const overlay = await read('src/folia/components/visualizer/VisualizerSubtitleOverlay.tsx');
  // 功能面：预览行仍然出现、仍然按 upcomingLines 渲染、字号/颜色/位置那几格一个都没动
  assert.match(overlay, /upcomingLines\.map\(\(line, index\) => \(/, '下一句预览还要照常出现（不许删掉那一行）');
  assert.match(overlay, /getUpcomingLyricsClassName\(subtitleUpcomingLyricsBlur\)/, '类名仍走那一个函数（时机与位置由它管）');
  assert.match(overlay, /fontSize: scaleFontSize\(upcomingFontSize\)/, '字号那一格不动');
  assert.match(overlay, /color: theme\.secondaryColor/, '颜色与明暗关系那一格不动');
  assert.match(overlay, /key=\{index\}/, '出现次序不动');
  // 越界面：本件不许顺手关别的发光 / 不许碰当前行高亮。**只看代码，不看注释** ——
  // 说明"没碰 wordGlow 那一族"的那句理由里当然会出现这个名字，按整文件扫会把实话判成违例。
  const glowCode = (await read('src/folia-host/subtitle-glow.ts'))
    .split('\n')
    .filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line))
    .join('\n');
  for (const banned of ['wordGlow', 'glowIntensity', 'enableLineGlow', 'glowBlurQuantize', 'activeLine', 'highlight']) {
    assert.ok(!glowCode.includes(banned), `subtitle-glow.ts 的代码里出现了 ${banned} ⇒ 本件越界了（只许关那一行的发光）`);
  }
  const island = await read('src/folia-host/island.tsx');
  assert.ok(!/wordGlow|glowIntensity=\{|enableLineGlow/.test(island), '宿主不许借这一格顺手关词级辉光或当前行高亮');
});
