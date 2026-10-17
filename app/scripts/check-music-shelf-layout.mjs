// 阶段 6.6 · 专辑架两轴模型：排序(sortMode) 与 分组(shelfLayout) 各自独立。
// 今天这两个概念在 data.ts 里是同一个参数：sortMode='artist' 既按歌手排序又按歌手铺列。
// 本文件钉住拆分后的四件事：默认分组等于旧 sortMode 分组（升级零观感变化）、两轴可正交组合、
// 专辑分组每列一张且列键是专辑 id、显示名可重复但内存键唯一（columnMemory 靠它不串列）。
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { setMusicAlbums, records, archiveColumns, archiveColumnKeys, columnFiles, fileAtSlot, fileLocation } from '../src/data.ts';
import { fileAtCell } from '../src/archive-loop.ts';

const album = (id, title, artist, genreId, tracks) => ({
  id, title, artist, genreId, rawGenres: [], year: 2020, folder: id,
  tracks: tracks.map((t, i) => ({ id: `${id}-t${i}`, title: t })),
  producers: [], offline: false,
});
const genres = [{ id: 'g1', name: '流派一' }, { id: 'g2', name: '流派二' }];
const library = [
  album('a1', '专辑甲', '歌手A', 'g1', ['一', '二', '三']),
  album('a2', '专辑乙', '歌手A', 'g2', ['一']),
  album('a3', '专辑丙', '歌手B', 'g1', ['一', '二']),
];

test('非音乐档案那条路径在模块加载时就有列键（不等到 setMusicAlbums 才补齐）', () => {
  // 这条必须排在任何 setMusicAlbums 之前：读的是 data.ts 的初始值（content/archives.json 那条路径）。
  assert.equal(archiveColumnKeys.length, archiveColumns.length, '档案模式下两数组等长');
  assert.ok(archiveColumnKeys.length > 0, '档案模式初始就有列，否则这条断言是空的');
  assert.deepEqual(archiveColumnKeys, [...archiveColumns], '档案模式下列名唯一（content.columns），直接复用为键');
});

test('默认分组等于旧的 sortMode 分组（升级零观感变化）', () => {
  setMusicAlbums(library, genres, 'genre', 'genre');
  assert.equal(archiveColumns.length, 2, '按流派：两个流派两列');
  assert.equal(records.length, 3);
  setMusicAlbums(library, genres, 'artist', 'artist');
  assert.deepEqual(archiveColumns, ['歌手A', '歌手B'], '按音乐人：两位歌手两列（与今天 data.ts 的 artist 分支同形）');
  assert.equal(records.length, 3);
  setMusicAlbums(library, genres, 'album', 'album');
  assert.equal(archiveColumns.length, 3, '按专辑：每列一张专辑');
  assert.equal(records.length, 6, 'Task 7 起：专辑布局是曲目粒度（3+1+2 首）');
});

test('排序轴与分组轴可以正交组合', () => {
  // 列的**顺序**跟随排序轴：分组按"排序后的首次出现"铺列，这正是两轴正交的含义。
  // 排序轴按拼音 collator：专辑丙(bǐng) < 专辑甲(jiǎ) < 专辑乙(yǐ)，所以歌手B 先出现。
  setMusicAlbums(library, genres, 'album', 'artist');   // 按标题排序 + 按歌手铺列
  assert.deepEqual(archiveColumns, ['歌手B', '歌手A'], '铺列顺序由排序轴决定');
  assert.deepEqual([0, 1].map((lane) => columnFiles(lane).length), [1, 2], '歌手A 两张、歌手B 一张');
  setMusicAlbums(library, genres, 'artist', 'artist');  // 按歌手排序 + 按歌手铺列
  assert.deepEqual(archiveColumns, ['歌手A', '歌手B'], '排序轴换成歌手后，铺列顺序跟着换');
  setMusicAlbums(library, genres, 'artist', 'genre');   // 按歌手排序 + 按流派铺列
  assert.equal(archiveColumns.length, 2);
  assert.deepEqual([0, 1].map((lane) => columnFiles(lane).length), [2, 1], '流派列与排序轴无关');
});

test('专辑分组：每列一张专辑，列键是专辑 id', () => {
  setMusicAlbums(library, genres, 'album', 'album');
  assert.deepEqual(archiveColumns, ['专辑丙', '专辑甲', '专辑乙'], '按标题拼音序铺列');
  assert.deepEqual(archiveColumnKeys, ['a3', 'a1', 'a2'], '内存键必须是专辑 id，标题重复也不串列');
  assert.deepEqual(archiveColumnKeys, archiveColumns.map((title) => records.find((r) => r.album.title === title).album.id),
    '每一列的键就是那张专辑的 id（显示名与键成对，不许错位）');
  assert.deepEqual([0, 1, 2].map((lane) => columnFiles(lane).length), [2, 3, 1], '列长 = 该专辑的曲目数（顺序跟随排序轴）');
  for (let index = 0; index < records.length; index += 1) {
    const location = fileLocation(index);
    assert.equal(fileAtCell(location), index, '槽位双向换算必须自洽');
    assert.equal(fileAtSlot(location.slot), index);
    assert.ok(records[location.lane].album, '每行都要带 album 以便取封面');
  }
});

test('列名重复时 columnMemory 用的键不冲突', () => {
  const duplicated = [album('x1', '同名', '歌手A', 'g1', ['一']), album('x2', '同名', '歌手B', 'g1', ['一'])];
  setMusicAlbums(duplicated, genres, 'album', 'album');
  assert.deepEqual(archiveColumns, ['同名', '同名'], '显示名可以重复');
  assert.equal(new Set(archiveColumnKeys).size, 2, '但内存键必须唯一');
});

test('archiveColumnKeys 与 archiveColumns 永远等长（三种分组逐一核对）', () => {
  for (const layout of ['genre', 'artist', 'album']) {
    setMusicAlbums(library, genres, 'genre', layout);
    assert.equal(archiveColumnKeys.length, archiveColumns.length, `${layout} 分组下两数组必须等长`);
    assert.ok(archiveColumnKeys.every((key) => typeof key === 'string' && key.length > 0), `${layout} 分组下不许有空键`);
  }
  // 空曲库也不能错位：两数组同时清空。
  setMusicAlbums([], [], 'genre', 'genre');
  assert.equal(archiveColumnKeys.length, archiveColumns.length, '空曲库时两数组等长');
});

// —— 以下属于 Task 7：专辑布局下 records 变成曲目粒度，每行铺同一张封面 + 各自的标签带。——
test('专辑布局的记录携带曲目、共享封面身份与标签带', () => {
  setMusicAlbums(library, genres, 'album', 'album');
  assert.equal(records.length, 6, '3+1+2 首 = 6 行（曲目粒度）');
  const first = records.find((r) => r.album.id === 'a1' && r.track?.title === '一');
  assert.ok(first, 'a1 的第一首要能找到');
  assert.equal(first.id, 'a1#a1-t0', '行 id 必须同时带上专辑与曲目，不能只留曲目 id');
  assert.equal(first.coverKey, 'a1', '同一张专辑的所有行共享封面身份');
  assert.equal(first.label, '第 1 首 · 一', '标签带内容 = 第 N 首 · 曲名（用户定案 ①-a）');
  const siblings = records.filter((r) => r.album.id === 'a1');
  assert.equal(siblings.length, 3);
  assert.equal(new Set(siblings.map((r) => r.coverKey)).size, 1, '封面身份一致 ⇒ 整列同一张封面');
  assert.equal(new Set(siblings.map((r) => r.label)).size, 3, '但每行标签不同 ⇒ 瓦片不互相串图');
  assert.deepEqual([...new Set(siblings.map((r) => r.album.tracks.length))], [3], 'album 字段仍在，详情与封面取数不变');
});

test('曲目行的槽位换算在列长为 1/2/3 时仍自洽（小列边界）', () => {
  setMusicAlbums(library, genres, 'album', 'album');
  for (let index = 0; index < records.length; index += 1) {
    const location = fileLocation(index);
    assert.equal(fileAtCell(location), index, `第 ${index} 行的双向换算要自洽`);
    assert.equal(fileAtSlot(location.slot), index);
    assert.ok(Number.isFinite(location.slot), '槽位不能是 NaN/Infinity');
    assert.equal(archiveColumnKeys[location.lane], records[index].album.id, '同一列必须始终是同一张专辑的行');
  }
});

test('空专辑（0 首）在专辑布局里仍占一列一行，不产生 undefined 行', () => {
  const withEmpty = [...library, album('a9', '专辑丁', '歌手C', 'g1', [])];
  setMusicAlbums(withEmpty, genres, 'album', 'album');
  const emptyRow = records.find((r) => r.album.id === 'a9');
  assert.ok(emptyRow, '没曲目的专辑也要有一张卡');
  assert.equal(emptyRow.track, undefined, '没有曲目就没有 track 字段');
  assert.equal(emptyRow.label, undefined, '没有曲目就不画标签带');
  assert.equal(emptyRow.coverKey, 'a9');
  assert.equal(emptyRow.title, '专辑丁', '退化成专辑粒度时用专辑名');
});

test('流派与音乐人布局不受影响：records 仍是专辑粒度、没有 track/label 字段', () => {
  for (const layout of ['genre', 'artist']) {
    setMusicAlbums(library, genres, 'genre', layout);
    assert.equal(records.length, 3, `${layout} 布局下不该出现曲目行`);
    assert.ok(records.every((r) => r.track === undefined && r.label === undefined), `${layout} 布局的记录不带曲目字段`);
    assert.deepEqual(records.map((r) => r.coverKey), [undefined, undefined, undefined], `${layout} 布局不需要 coverKey`);
  }
});

test('列长互质导致 LCM 溢出时，坐标折叠停在 Infinity 而不是 NaN（专辑布局的现实形态）', async () => {
  // 数据层：曲目数互质的几张专辑（1/2/3/5/7 首）会让列长 LCM 一路涨；换算本身必须始终有限且自洽。
  const odd = [1, 2, 3, 5, 7].map((count, i) => album(`o${i}`, `列${i}`, '歌手Z', 'g1', Array.from({ length: count }, (_, k) => `曲${k}`)));
  setMusicAlbums(odd, genres, 'album', 'album');
  assert.equal(records.length, 18);
  for (let index = 0; index < records.length; index += 1) {
    const location = fileLocation(index);
    assert.ok(Number.isFinite(location.slot), `第 ${index} 行的槽位必须有限`);
    assert.equal(fileAtSlot(location.slot), index);
  }
  // 场景层：rebaseCoordinates 的行周期溢出后必须停在 Infinity（"不再折叠"），
  // 且判定式仍写作 `> Math.max(2048, rowPeriod * 2)` —— 换成减法或取模就会把 NaN 送进 position。
  const scene = await readFile(new URL('../src/scene.ts', import.meta.url), 'utf8');
  const rebase = scene.slice(scene.indexOf('private rebaseCoordinates()'), scene.indexOf('private rebaseCoordinates(') + 1600);
  assert.match(rebase, /next > 1e6 \? Infinity : next/, 'LCM 溢出显式停在 Infinity');
  assert.match(rebase, /Math\.max\(2048, rowPeriod \* 2\)/, '行折叠阈值仍走 Math.max（Infinity 时判定恒 false ⇒ 只是不折叠）');
  assert.doesNotMatch(rebase, /%\s*rowPeriod/, '折叠量不得对 rowPeriod 取模（Infinity % n 会变 NaN）');
});

test('打开详情会揭示选中的曲目行：先武装、等 transition=open 再交给既有 reveal 通路', async () => {
  const app = await readFile(new URL('../src/music-app.ts', import.meta.url), 'utf8');
  const openCase = /case "open": \{[\s\S]{0,300}?\n    \}/.exec(app);
  assert.ok(openCase, '要能整段读到 open 分支');
  assert.match(openCase[0], /detailRevealArmed = !!records\[selected\]\?\.track;/, 'open 只"武装"，且只有曲目行才武装');
  assert.ok(openCase[0].indexOf('detailRevealArmed') < openCase[0].indexOf('setMode("detail")'),
    '武装必须在 setMode 之前（它只是布尔，不会被 select 的取消逻辑影响）');
  // 交接点：必须等 transition=open，并且此时才登记 pendingTrackReveal
  const handoff = /if \(detailRevealArmed && \$\("#music-detail"\)\.dataset\.transition === "open"\) \{[\s\S]{0,420}?\n      \}/.exec(app);
  assert.ok(handoff, '要能读到 open→reveal 的交接段');
  assert.match(handoff[0], /pendingTrackReveal = \{ albumId: row\.album\.id, trackId: row\.track\.id \}/, '交接段登记既有 reveal');
  assert.match(handoff[0], /currentAlbum\(\)\?\.id === row\.album\.id/, '登记前确认还是那张专辑');
  // 消费点：行没渲染出来时不得清掉 pendingTrackReveal（否则这次揭示永久丢失）
  const consume = app.slice(app.indexOf('if (\n        pendingTrackReveal &&'), app.indexOf('trackFocus.reveal'));
  assert.ok(consume.length > 60, '要能读到 reveal 消费点');
  assert.match(consume, /if \(row\) \{\s*\n\s*pendingTrackReveal = undefined;/, '只有真的找到行才清登记');
  // select() 里"非 archive 路由即取消"的规则是上面这套顺序存在的原因，不得被改动
  assert.match(app, /if \(route !== "archive"\) cancelTrackReveal\(\);/, 'select 仍对非 archive 路由取消 reveal');
  assert.match(app, /if \(next === "archive"\) \{\s*\n\s*cancelTrackReveal\(\);\s*\n\s*detailRevealArmed = false;/, '回到架子要同时解除 reveal 与武装');
  // 反查口径：records 是曲目粒度后，任何"按专辑 id 找行"的地方都必须走 album?.id ?? id
  assert.match(app, /records\.findIndex\(\s*\(record\) =>\s*\(record\.album\?\.id \?\? record\.id\) === albumId/, 'revealAlbum 的反查按专辑 id');
  assert.match(app, /records\.findIndex\(\(r\) => \(r\.album\?\.id \?\? r\.id\) === previousId\)/, '刷新后的选区复原按专辑 id 兜底');
});

test('currentAlbum 在曲目粒度下仍能找到专辑（文字层停止更新是这次改动最贵的教训）', async () => {
  const app = await readFile(new URL('../src/music-app.ts', import.meta.url), 'utf8');
  const fn = app.slice(app.indexOf('function currentAlbum()'), app.indexOf('function formatList'));
  assert.ok(fn.length > 40 && fn.length < 900, `要能整段读到 currentAlbum，实测 ${fn.length}`);
  assert.match(fn, /const albumId = record\.album\.id;\s*\n\s*return albums\.find\(\(a\) => a\.id === albumId\) \?\? record\.album;/, '行带 album 引用时按 album.id 反查，绝不拿行 id 去比专辑 id');
  assert.match(fn, /\?\? record\.album/, 'albums 里暂时找不到就用行内引用兜底');
  assert.doesNotMatch(fn, /a\.id === records\[selected\]\?\.id/, '不得再用行 id 直接比专辑 id（这正是文字层冻结的写法）');
});

// ── ⑧（2026-10-07）：文本歌单作为**伪专辑**进这两轴 ────────────────────────────
const dataModule = await import('../src/data.ts');
const { PLAYLIST_GROUP_ID, PLAYLIST_GROUP_NAME, playlistAlbumId } = dataModule;
const playlist = (slug, name, artist, items, unmatched, seeds = 2) => ({
  id: playlistAlbumId(slug), title: name, artist, genreId: PLAYLIST_GROUP_ID, rawGenres: [],
  folder: `歌单 · ${slug}`, tracks: [], producers: [], offline: false,
  kind: 'playlist', shelfCounts: { items, matched: items - unmatched, unmatched },
  coverSeeds: Array.from({ length: seeds }, (_, index) => ({ title: `曲${index}`, artist: artist || '甲' })),
});

test('⑧ 伪专辑在 genre 档自成「歌单」那一列，且不污染真实流派的分类名', () => {
  setMusicAlbums([...library, playlist('late', '深夜', '歌手A', 5, 2)], genres, 'genre', 'genre');
  assert.ok(archiveColumns.includes(PLAYLIST_GROUP_NAME), `genre 档要有一列叫「${PLAYLIST_GROUP_NAME}」`);
  const row = records.find((record) => record.id === 'playlist:late');
  assert.equal(row.category, PLAYLIST_GROUP_NAME, '那一行的分类名走保留名，不是裸键 playlist:');
  assert.equal(row.clearance, '歌单 · 5 首（2 首未匹配）', '说明位与详情面板的三档徽标同一口径');
  assert.equal(records.find((record) => record.id === 'a1').category, '流派一', '真实专辑的分类名一个字都不许被带歪');
  assert.ok(dataModule.categories.includes('歌单') && dataModule.categories.includes('流派一'), '分类列表里两者并列');
  assert.equal(row.album.coverUrl, undefined, '不许按 id 造 artwork URL（F3 那条：没有封面就是没有）');
  assert.equal(row.track, undefined, '伪专辑不是一首曲目，行上不该带 track');
});

test('⑧ 另两档零特例：artist 档按成员里最主要的音乐人铺列，album 档每列一张', () => {
  setMusicAlbums([...library, playlist('late', '深夜', '歌手A', 3, 0)], genres, 'title', 'artist');
  const lane = archiveColumns.indexOf('歌手A');
  assert.ok(lane >= 0, '同一位音乐人的专辑与歌单落进同一列（这正是 ⑨ 要复用的机制方向）');
  assert.ok(columnFiles(lane).some((index) => records[index].id === 'playlist:late'));
  setMusicAlbums([...library, playlist('none', '无名单', '', 2, 2)], genres, 'title', 'artist');
  assert.ok(archiveColumns.includes('未知歌手'), '一条歌手名都没有 ⇒ 落进既有的"未知歌手"列，不拿歌单名冒充歌手');
  setMusicAlbums([...library, playlist('late', '深夜', '歌手A', 3, 0)], genres, 'title', 'album');
  const own = archiveColumnKeys.indexOf('playlist:late');
  assert.ok(own >= 0, 'album 档下每张歌单自己一列，列键就是它的 id');
  const rows = columnFiles(own).map((index) => records[index].id);
  assert.deepEqual(rows, ['playlist:late'], '没有曲目 ⇒ 一列只有一行（就是这张单子本身）');
  assert.equal(records[columnFiles(own)[0]].clearance, '歌单 · 3 首', '全部匹配上时不带"未匹配"那半句');
});

test('⑧ 拼贴格原料是纯函数：确定性、最多四格、空歌单给空数组（落回通用占位）', async () => {
  const { playlistTiles } = await import('../src/cover-atlas.ts');
  const two = playlistTiles(playlist('late', '深夜', '甲', 5, 2, 2));
  assert.equal(two.length, 2);
  assert.deepEqual(two, playlistTiles(playlist('late', '深夜', '甲', 5, 2, 2)), '同一输入两次结果逐字相同（色相不能依赖 Math.random）');
  assert.ok(two.every((tile) => Number.isInteger(tile.hue) && tile.hue >= 0 && tile.hue < 360), '色相是 0..359 的整数');
  assert.equal(two[0].letter, '曲', '每格的首字母来自成员标题');
  assert.equal(playlistTiles(playlist('late', '深夜', '甲', 5, 2, 9)).length, 4, '最多四格（2×2）');
  assert.deepEqual(playlistTiles(undefined), [], '没有专辑就是没有瓦片，不抛');
  assert.deepEqual(playlistTiles({ id: 'x', coverSeeds: [] }), []);
  assert.equal(playlistTiles({ id: 'y', coverSeeds: [{ title: '   ', artist: '  乙 ' }] })[0].letter, '乙', '标题空白时用歌手的首字母；再空就是「歌」');
  assert.equal(playlistTiles({ id: 'z', coverSeeds: [{ title: '', artist: '' }] })[0].letter, '歌');
});
