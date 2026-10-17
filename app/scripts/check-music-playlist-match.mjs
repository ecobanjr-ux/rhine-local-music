// 第五期 Task 9 自检：歌单逐条在线匹配 + 同名 sidecar（R76 的两条硬要求是这一条的重点）。
//
// 两条硬要求（用户 2026-10-05 拍板时追加）：
//   A. **关联必须确定**：sidecar = 同目录 + 同基名 + 固定后缀，纯函数算得出，不靠索引也不靠内存映射；
//   B. **删掉 sidecar 必须无害**：歌单照常读、照常播，重搜逐条重建出同样的结果。
// 再加一条同族的：改名/删除连带 sidecar 一起走，不留孤儿。
//
// 离线纪律：不出网。搜索走注入的假门面（数它被调用几次就是这一条的重点读数）。
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm, stat, access } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { listenAndReady } from './check-ready.mjs';   // R211（A 类第 7 处）：改成静态引入，见 routeServer() 的注释

const SCRIPTS = dirname(fileURLToPath(import.meta.url));
const readScript = (name) => readFile(path.join(SCRIPTS, name), 'utf8');

const { PlaylistStore } = await import('./playlists.mjs');
const match = await import('./playlist-match.mjs');

const exists = async (file) => { try { await access(file); return true } catch { return false } };

// Task 7 契约形状的搜索结果（title/artist/album/durationMs/provider/mediaId/quality/sourceKind/audioUrl/id）
const hitFor = (title, artist, album = '黑马') => ({
  id: `on-netease-${title.length}`, sourceKind: 'online', provider: 'netease',
  title, artist, album, durationMs: 276000, mediaId: `id-${title}`, quality: '自动',
  audioUrl: `/api/online/stream?p=netease&id=id-${title}`,
});

async function withPlaylist(run, text = '[album] 黑马\n恋人 - 李荣浩\n不将就 - 李荣浩\n喜剧之王 - 李荣浩\n', preference = null) {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'rhine-pmatch-'));
  const store = await new PlaylistStore({ dataDir }).init();
  await store.write('test', text);
  let searches = 0;
  const search = async ({ query }) => {
    searches += 1;
    // 故意让一条查不到：模拟"第三方确实没有这首歌"
    if (query.includes('查无此歌')) return { ok: true, items: [] };
    const title = query.split(' ')[0];
    return { ok: true, items: [hitFor(title, '李荣浩')] };
  };
  // R143：可注入的「匹配偏好」门面。不传 ⇒ 匹配器根本不去问（行为与今天逐字一致）。
  const svc = match.createPlaylistMatcher({ store, search, ...(preference ? { preference } : {}) });
  try { return await run({ svc, store, dataDir, counts: () => searches }) } finally { await rm(dataDir, { recursive: true, force: true }) }
}

// ── F2（2026-10-06）：条目自带在线身份 ⇒ 不搜索、不进 sidecar ──────────────────

test('R127：tracks() 每一行都带着行号与原文（界面据此才能做到"只改目标行"）', async () => {
  await withPlaylist(async ({ svc }) => {
    const got = await svc.tracks('test');
    for (const item of got.items) {
      assert.ok(Number.isInteger(item.line) && item.line >= 1, `行号缺失：${item.entry.title}`);
      assert.ok(item.lineText.includes(item.entry.title), `第 ${item.line} 行的原文对不上条目：「${item.lineText}」`);
    }
    // 未匹配的那一条也要有：那颗按钮正是挂在这种行上。
    const miss = got.items.find((item) => !item.matched);
    assert.ok(!miss || typeof miss.lineText === 'string', '未匹配行不许漏掉原文');
  }, '恋人 - 李荣浩\n不存在的歌 - 某人\n');
});

test('从搜索结果加进来的条目（文本第 4 段身份）直接可播，一条网都不出', async () => {
  await withPlaylist(async ({ svc, counts }) => {
    const got = await svc.tracks('test');
    assert.equal(counts(), 0, 'tracks() 只读文件与 sidecar，不该顺手去搜');
    const inline = got.items.find((item) => item.source === 'inline');
    assert.ok(inline, 'tracks() 要能说出这一条是"自带身份"的');
    assert.equal(inline.track.provider, 'netease');
    assert.match(inline.track.audioUrl, /^\/api\/online\/stream\?p=netease&id=27699577/, '中转地址由身份段拼出来');
    assert.equal(inline.score, undefined, '没有打分这回事——身份不是猜出来的，不该挂个分数');
    assert.equal(got.matched, 1);
  }, '恋人 - 李荣浩 | 黑马 | 4:36 | on:netease:27699577\n');
});

test('整单都是身份条目 ⇒ matchAll 出网 0 次、sidecar 一个字节都不生成', async () => {
  const text = '恋人 - 李荣浩 | on:netease:1\n不将就 - 李荣浩 | on:netease:2\n';
  await withPlaylist(async ({ svc, store, dataDir, counts }) => {
    const summary = await svc.matchAll('test');
    assert.equal(summary.total, 2);
    assert.equal(summary.matched, 2);
    assert.equal(counts(), 0, '"早就知道是哪一首"却还要去问一遍 = 白打的一笔出网');
    assert.equal(summary.searches, 0, '回执里的出网次数必须是真的 0');
    assert.equal(await exists(store.matchFileOf('test')), false, '没搜过就不该有缓存文件（两个真相从这一步开始防）');
    void dataDir;
  }, text);
});

test('混在一单里：只问需要问的那条，身份那条不占出网次数', async () => {
  await withPlaylist(async ({ svc, counts }) => {
    const summary = await svc.matchAll('test');
    assert.equal(summary.total, 2);
    assert.equal(summary.matched, 2, '两条都要算配上（一条身份、一条搜到）');
    assert.equal(counts(), 1, '整单只该为那条没有身份的出一次网');
    const got = await svc.tracks('test');
    assert.deepEqual(got.items.map((item) => item.source), ['inline', 'cache']);
  }, '恋人 - 李荣浩 | on:netease:27699577\n喜剧之王 - 李荣浩\n');
});

test('身份段写着不认识的来源 ⇒ 退回搜索那一路，而不是判死或编个地址', async () => {
  await withPlaylist(async ({ svc, counts }) => {
    const got = await svc.matchEntry('test', { title: '恋人', artist: '李荣浩', online: { provider: 'kg', mediaId: '1' } });
    assert.equal(got.ok, true, '退回搜索后按搜索结果配上');
    assert.equal(counts(), 1, '不认识的身份要真的去问过');
    assert.equal(got.track.provider, 'netease', '曲目来自搜索结果，不是那句 on:kg');
  });
});

// ── 硬要求 A：关联确定 ────────────────────────────────────────────────────────

test('硬要求 A：sidecar 是同目录 + 同基名 + 固定后缀，纯函数算得出，不靠索引也不靠映射表', async () => {
  await withPlaylist(async ({ store, dataDir }) => {
    assert.equal(store.matchFileOf('test'), path.join(dataDir, 'playlists', 'test.matches.json'));
    const base = (file) => path.basename(file).replace(/\.(playlist\.txt|matches\.json)$/, '');
    assert.equal(base(store.matchFileOf('test')), base(store.fileOf('test')), '基名必须与歌单文件一致');
    assert.equal(path.dirname(store.matchFileOf('test')), path.dirname(store.fileOf('test')), '必须同目录');
    const source = await readScript('playlists.mjs');
    assert.doesNotMatch(source, /matchesIndex|sidecarMap|new Map\(\)/, '关联不许靠索引或内存映射表（那样外部删掉文件就找不回来）');
    assert.match(source, /MATCH_SUFFIX = '\.matches\.json'/, '后缀是常量，两处共用一份');
  });
});

// ── 缓存与出网次数 ────────────────────────────────────────────────────────────

test('① 命中一次后写旁挂缓存；第二次匹配不再出网', async () => {
  await withPlaylist(async ({ svc, store, counts }) => {
    const entry = { title: '恋人', artist: '李荣浩', album: '黑马' };
    const first = await svc.matchEntry('test', entry);
    assert.equal(first.ok, true, JSON.stringify(first));
    assert.ok(first.score >= match.MATCH_MIN_SCORE, `分数 ${first.score} 不该低于阈值`);
    const second = await svc.matchEntry('test', entry);
    assert.equal(second.track.id, first.track.id);
    assert.equal(counts(), 1, '第二次必须走 sidecar，不再出网');
    assert.ok(await exists(store.matchFileOf('test')), 'sidecar 落在磁盘上（重启后还在）');
    // 进程内那层也要能证明"重启即从磁盘读回"：新建一个 matcher（内存空）仍不该出网
    const cold = match.createPlaylistMatcher({ store, search: async () => { throw new Error('不该出网') } });
    const third = await cold.matchEntry('test', entry);
    assert.equal(third.ok, true, '内存缓存丢了，磁盘 sidecar 还在');
  });
});

test('⑥ 条目被编辑 ⇒ 只有受影响那条作废；未命中留负缓存', async () => {
  await withPlaylist(async ({ svc, store, counts }) => {
    const all = await svc.matchAll('test');
    assert.equal(all.total, 3);
    assert.equal(all.matched, 3);
    assert.equal(counts(), 3, '整单第一次：三条各搜一次');
    const after = await svc.matchAll('test');
    assert.equal(after.matched, 3);
    assert.equal(counts(), 3, '全未变 ⇒ 零新增搜索');
    await store.write('test', '[album] 黑马\n换了首歌 - 李荣浩\n不将就 - 李荣浩\n喜剧之王 - 李荣浩\n');
    await svc.matchAll('test');
    assert.equal(counts(), 4, '只重搜受影响的那一条，其余两条仍走缓存');
    const miss = await svc.matchEntry('test', { title: '查无此歌zzz', artist: '查无此人zzz' });
    assert.equal(miss.ok, false);
    assert.match(miss.reason, /低于阈值/);
    const beforeMiss = counts();
    const again = await svc.matchEntry('test', { title: '查无此歌zzz', artist: '查无此人zzz' });
    assert.equal(again.cached, 'miss', '未命中也要留痕，否则每次整单都重问这条');
    assert.equal(counts(), beforeMiss, '负缓存期内不再出网');
  });
});

test('TTL 判定按注入时钟：命中满 30 天才重搜，未命中满 1 小时就重搜', async () => {
  assert.equal(match.MATCH_TTL_MS, 30 * 24 * 3600 * 1000, '命中 30 天：平台目录会变，过期后允许重搜');
  assert.equal(match.MISS_TTL_MS, 3600 * 1000, '未命中只冷 1 小时：新上传的歌不该被负缓存锁一整天');
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'rhine-pmatch-ttl-'));
  const store = await new PlaylistStore({ dataDir }).init();
  await store.write('t', '恋人 - 李荣浩\n');
  let clock = 1_700_000_000_000;
  let searches = 0;
  const svc = match.createPlaylistMatcher({
    store, now: () => clock,
    search: async () => { searches += 1; return searches === 1 ? { ok: true, items: [hitFor('恋人', '李荣浩')] } : { ok: true, items: [] } },
  });
  assert.equal((await svc.matchEntry('t', { title: '恋人', artist: '李荣浩' })).ok, true);
  clock += match.MISS_TTL_MS + 1;                        // 1 小时之后（命中还没到期）
  await svc.matchEntry('t', { title: '恋人', artist: '李荣浩' });
  assert.equal(searches, 1, '命中在 30 天 TTL 内，1 小时过去不该重搜');
  clock += match.MATCH_TTL_MS;                           // 满 30 天
  const aged = await svc.matchEntry('t', { title: '恋人', artist: '李荣浩' });
  assert.equal(searches, 2, '过期之后允许重搜（平台目录会变）');
  assert.equal(aged.ok, false, '这一轮假搜索故意不给结果 ⇒ 变未命中');
  clock += match.MISS_TTL_MS - 1;
  await svc.matchEntry('t', { title: '恋人', artist: '李荣浩' });
  assert.equal(searches, 2, '未命中未满 1 小时不重搜');
  clock += 2;
  await svc.matchEntry('t', { title: '恋人', artist: '李荣浩' });
  assert.equal(searches, 3, '未命中满 1 小时就该再试一次');
  await rm(dataDir, { recursive: true, force: true });
});

// ── 硬要求 B：删 sidecar 无害 ─────────────────────────────────────────────────

test('③ 硬要求 B：删 sidecar 无害——歌单照常读，重搜逐条重建出同样结果', async () => {
  await withPlaylist(async ({ svc, store }) => {
    const before = await svc.matchAll('test');
    const readable = await store.get('test');
    await rm(store.matchFileOf('test'), { force: true });
    assert.deepEqual(await store.get('test'), readable, '删 sidecar 不许动到歌单的读取结果');
    const after = await svc.matchAll('test');
    assert.deepEqual(after.results.map((r) => r.track?.id ?? null), before.results.map((r) => r.track?.id ?? null),
      '重建出的匹配结果逐条一致（只差 cached 标记与时间戳）');
    assert.equal(after.matched, before.matched);
  });
});

test('④ 改名 / 删除歌单 ⇒ sidecar 跟着走，不留孤儿', async () => {
  await withPlaylist(async ({ svc, store }) => {
    await svc.matchAll('test');
    assert.equal(await exists(store.matchFileOf('test')), true);
    await store.rename('test', 'test2');
    assert.equal(await exists(store.matchFileOf('test2')), true, '改名后 sidecar 跟着改名');
    assert.equal(await exists(store.matchFileOf('test')), false, '旧名不许留孤儿');
    // 改名之后缓存仍然有效（不因为换了名字就整单重搜）
    let searches = 0;
    const svc2 = match.createPlaylistMatcher({ store, search: async () => { searches += 1; return { ok: true, items: [hitFor('恋人', '李荣浩')] } } });
    await svc2.matchEntry('test2', { title: '恋人', artist: '李荣浩', album: '黑马' });
    assert.equal(searches, 0, 'sidecar 跟着改名 ⇒ 缓存不丢');
    await store.remove('test2');
    assert.equal(await exists(store.matchFileOf('test2')), false, '删歌单连带删 sidecar');
  });
});

test('⑤ 不回写用户文本：匹配之后歌单文件逐字节不变（R76 的另一半）', async () => {
  await withPlaylist(async ({ svc, store }) => {
    const before = await readFile(store.fileOf('test'), 'utf8');
    const beforeStat = await stat(store.fileOf('test'));
    await svc.matchAll('test');
    assert.equal(await readFile(store.fileOf('test'), 'utf8'), before, '匹配结果只进 sidecar，一个字都不回写文本');
    assert.equal((await stat(store.fileOf('test'))).mtimeMs, beforeStat.mtimeMs, '连 mtime 都不该动（没写过它）');
  });
});

// ── sidecar 形状与容错 ───────────────────────────────────────────────────────

test('sidecar 形状是 R76 定的那一份；坏文件/串单一律当没有，重建而不是崩', async () => {
  await withPlaylist(async ({ svc, store }) => {
    await svc.matchAll('test');
    const raw = JSON.parse(await readFile(store.matchFileOf('test'), 'utf8'));
    assert.deepEqual(Object.keys(raw).sort(), ['entries', 'playlist', 'updatedAt', 'version']);
    assert.equal(raw.version, 1);
    assert.equal(raw.playlist, 'test', '带歌单名：串了单的文件不能被当成本单的缓存');
    const key = Object.keys(raw.entries)[0];
    assert.match(key, /^[0-9a-f]{24}$/, '条目按内容指纹分键');
    // R76 那一份形状 + 看板 95fe081 跳①新增的 `coverRef`（第三方封面地址，只进这份服务端数据文件）。
    // 键在这里是**显式列出来的**：以后再加字段要连这条一起改，逼改动过一次 sidecar 形状的人留一句理由。
    assert.deepEqual(Object.keys(raw.entries[key]).sort().filter((k) => k !== 'track'), ['at', 'coverRef', 'ok', 'score']);
    assert.equal(typeof raw.entries[key].coverRef, 'string', '没有封面时是空串，不是"这个键不存在"（与曲目契约同一口径）');
    // 坏 JSON
    await writeFile(store.matchFileOf('test'), '{ 坏掉的', 'utf8');
    assert.deepEqual((await svc.readSidecar('test')).entries, {}, '坏 sidecar 当没有，不抛');
    // 串单（playlist 字段对不上）
    await writeFile(store.matchFileOf('test'), JSON.stringify({ version: 1, playlist: '别的单', entries: { [key]: { ok: true, at: Date.now() } } }), 'utf8');
    assert.deepEqual((await svc.readSidecar('test')).entries, {}, '名字对不上就不认，宁可重搜');
    // 未来版本
    await writeFile(store.matchFileOf('test'), JSON.stringify({ version: 2, playlist: 'test', entries: { [key]: { ok: true } } }), 'utf8');
    assert.deepEqual((await svc.readSidecar('test')).entries, {}, '版本不认识时不硬读，重建');
  });
});

test('条目指纹只含"影响匹配的那几项"：改专辑/时长会变键，改注释与空行不会', async () => {
  const a = match.entryKey({ title: '恋人', artist: '李荣浩' });
  const b = match.entryKey({ title: '恋人', artist: '李荣浩', album: undefined });
  assert.equal(a, b, '专辑为空与不写专辑是同一个条目');
  assert.notEqual(a, match.entryKey({ title: '恋人', artist: '李荣浩', album: '黑马' }), '带上专辑就换键（专辑参与打分）');
  assert.notEqual(a, match.entryKey({ title: '恋人', artist: '李荣浩', durationMs: 276000 }), '时长参与键');
  // 归一口径复用曲库那一份（不另写一套）
  const source = await readScript('playlist-match.mjs');
  assert.match(source, /import \{[^}]*normalized[^}]*\} from '\.\/music-library\.mjs'/, '归一与哈希都从曲库复用');
  assert.equal(match.entryKey({ title: ' 恋人 ', artist: '李荣浩' }), a, '首尾空白不影响键');
});

test('打分口径与歌词匹配同源：阈值 75 同一个常量，跨文字系统不给了满分', async () => {
  assert.equal(match.MATCH_MIN_SCORE, 75, '与 online-match-score 的 AUTO_MATCH_MIN_SCORE 同值（定案 a）');
  await withPlaylist(async ({ svc }) => {
    // 曲名完全不像：不该配上（防止"随便给一条在线结果"把整单填满）
    const got = await svc.matchEntry('test', { title: 'WAP-114514', artist: '不存在的人-9527' });
    assert.equal(got.ok, false);
    assert.match(got.reason, /最高分/);
  });
});

test('只有一层缓存：删掉磁盘上那份，同一个 matcher 实例也必须立刻重搜（不留进程内第二真相）', async () => {
  await withPlaylist(async ({ svc, store, counts }) => {
    const entry = { title: '恋人', artist: '李荣浩', album: '黑马' };
    await svc.matchEntry('test', entry);
    assert.equal(counts(), 1);
    await svc.matchEntry('test', entry);
    assert.equal(counts(), 1, '第二次走 sidecar');
    await rm(store.matchFileOf('test'), { force: true });
    await svc.matchEntry('test', entry);
    assert.equal(counts(), 2, 'sidecar 被删 ⇒ 同一个实例也要重搜；若这里还是 1，说明内存里藏着第二层缓存');
  });
});

test('全走缓存时不写盘：sidecar 的 mtime 不该因为"读了一遍"而变化', async () => {
  await withPlaylist(async ({ svc, store }) => {
    await svc.matchAll('test');
    const before = (await stat(store.matchFileOf('test'))).mtimeMs;
    await new Promise((resolve) => setTimeout(resolve, 20));
    const second = await svc.matchAll('test');
    assert.equal(second.searches, 0);
    assert.equal((await stat(store.matchFileOf('test'))).mtimeMs, before, '没搜过就不该重写 sidecar');
  });
});

test('/tracks 里"没查过"与"查了没配上"必须分得开（服务端不许替未查的条目编一个 reason）', async () => {
  // 歌单文本里就带一条查不到的：未匹配记录必须是**这张单里的**条目，
  // 用 matchEntry 单独问一张单外的条目不算（tracks() 遍历的是文本条目）。
  await withPlaylist(async ({ svc, store }) => {
    await store.write('test', '[album] 黑马\n恋人 - 李荣浩\n查无此歌 - 查无此人\n');
    const fresh = await svc.tracks('test');
    assert.equal(fresh.unmatched, 2);
    for (const item of fresh.items) {
      assert.equal(item.source, 'none', '一条都没查过时全部是 none');
      assert.equal(item.reason, undefined, '未查的条目不许带 reason——前端徽标靠它区分"未查"与"未匹配"');
    }
    const after = await svc.matchAll('test');
    assert.equal(after.matched, 1);
    const mixed = await svc.tracks('test');
    const miss = mixed.items.find((item) => !item.matched);
    assert.ok(miss, '应当有一条未匹配的');
    assert.equal(miss.source, 'cache', '查过没配上的：sidecar 里留着痕，source 要能说出来');
    assert.match(miss.reason, /低于阈值/, '查过的才带原因');
    void store;
  }, '[album] 黑马\n恋人 - 李荣浩\n查无此歌 - 查无此人\n');
});

// ── 路由 ─────────────────────────────────────────────────────────────────────

test('路由：match 逐条跑并如实报跳过；tracks 给整单可播队列与未匹配计数', async () => {
  const route = await routeServer();
  const created = await fetch(`${route.origin}/api/playlists`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ action: 'create', name: '单子', text: '[album] 黑马\n恋人 - 李荣浩\n不将就 - 李荣浩\n查无此歌 - 查无此人\n' }),
  });
  assert.equal(created.status, 200);
  await created.json();
  const matched = await fetch(`${route.origin}/api/playlists/单子/match`, { method: 'POST' });
  assert.equal(matched.status, 200);
  const summary = await matched.json();
  assert.equal(summary.total, 3);
  assert.equal(summary.matched, 2, '两条配上、一条没配上');
  assert.equal(summary.failed.length, 1, '没配上的要列出来，不能静默少一首');
  assert.match(summary.failed[0].reason, /低于阈值/);

  const tracks = await (await fetch(`${route.origin}/api/playlists/单子/tracks`)).json();
  assert.equal(tracks.items.length, 3);
  assert.equal(tracks.items.filter((item) => item.matched).length, 2);
  assert.equal(tracks.unmatched, 1, '"这张 3 条里 1 条没配上"必须是界面上说得出的一个数');
  assert.match(tracks.items[0].track.audioUrl, /^\/api\/online\/stream\?p=/, '给的是同源中转地址');
  assert.equal(tracks.items[0].source, 'cache', '刚匹配完全走缓存');
  // 再点一次 match：出网次数不再增长（由注入的假搜索器计数证明）
  const second = await (await fetch(`${route.origin}/api/playlists/单子/match`, { method: 'POST' })).json();
  assert.equal(second.searches, 0, '第二次 match 一笔搜索都不该发');
  await route.close();
});

test('路由把关：不存在的歌单 404、GET 到 POST-only 路由 405、非法 id 400', async () => {
  const route = await routeServer();
  let response = await fetch(`${route.origin}/api/playlists/没有的/match`, { method: 'POST' });
  assert.equal(response.status, 404);
  await response.text();
  response = await fetch(`${route.origin}/api/playlists/单子/tracks`);
  assert.equal(response.status, 404, '还没建这张单子');
  await response.text();
  await fetch(`${route.origin}/api/playlists`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action: 'create', name: '单子', text: 'A - B\n' }) });
  response = await fetch(`${route.origin}/api/playlists/单子/match`);
  assert.equal(response.status, 405, 'match 只接受 POST');
  await response.text();
  response = await fetch(`${route.origin}/api/playlists/${encodeURIComponent('../config')}/tracks`);
  assert.ok([400, 404].includes(response.status));
  await response.text();
  await route.close();
});

test('匹配不写用户文本、也不碰音频：路由与模块两侧都无写盘旁路（R74/R76）', async () => {
  const source = await readScript('playlist-match.mjs');
  assert.match(source, /writeJsonAtomic\(store\.matchFileOf/, '唯一的写盘目标是 sidecar');
  for (const banned of ['writeFile(', 'appendFile', 'createWriteStream', 'store.write(']) {
    assert.ok(!source.includes(banned), `匹配模块里出现了 ${banned}：派生数据不许写进用户文本或别处`);
  }
  assert.doesNotMatch(source, /\.mp3|\.flac|artwork/, '更不许落音频或封面');
});

// ── 夹具 ─────────────────────────────────────────────────────────────────────

async function routeServer() {
  delete process.env.MUSICBRAINZ_CONTACT;
  const { createMusicServer } = await import('./music-server.mjs');
  const { MusicLibraryStore } = await import('./music-library.mjs');
  const { createPlaylistMatcher } = await import('./playlist-match.mjs');
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'rhine-pmatch-route-'));
  const rootsDir = await mkdtemp(path.join(os.tmpdir(), 'rhine-pmatch-roots-'));
  const store = await new MusicLibraryStore({ dataDir, defaultRoots: [rootsDir] }).init();
  let searches = 0;
  const searcher = {
    search: async ({ query }) => {
      searches += 1;
      if (query.includes('查无此歌')) return { ok: true, items: [] };
      return { ok: true, items: [hitFor(query.split(' ')[0], '李荣浩')] };
    },
  };
  const bridge = {
    status: () => ({ phase: 'off', port: 0, backends: [], unauthorized: 0, restarts: 0, lastError: null, hosts: [] }),
    call: async () => ({ ok: false, reason: '不该被调用' }), ensure: async () => {}, shutdown: async () => {},
  };
  const { server } = await createMusicServer({
    store, distDir: SCRIPTS, autoScan: false, bridgeClient: bridge,
    onlineLyricsMatcher: { match: async () => ({ matched: false }), clearCache: () => {} },
    onlineAudioSource: { resolve: async () => ({ ok: false, reason: '未配置' }) },
    onlineStreamFetcher: async () => { throw new Error('不该走到这里') },
    onlineSearcher: searcher,
    playlistMatcher: createPlaylistMatcher({ store: store.playlists, search: searcher.search }),
  });
  // R211（A 类第 7 处）：升级 listenAndReady（连不上就换端口重听；从前这里还是**动态 import** 探测件）；
  // 坏探测抛错时先关这台 + 清两个临时目录再原样抛 —— 从前 `close` 只在 return 之后才交出去。
  let origin;
  try {
    ({ origin } = await listenAndReady(server));
  } catch (error) {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    await rm(dataDir, { recursive: true, force: true });
    await rm(rootsDir, { recursive: true, force: true });
    throw error;
  }
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

// ── R143（任务四）· 匹配时优先已登录音源：有边距的偏好，不是硬过滤 ──────────────────

const qqHit = (title, artist, album = '黑马') => ({
  id: `on-qq-${title}`, sourceKind: 'online', provider: 'qq',
  title, artist, album, durationMs: 276000, mediaId: `q-${title}`, mediaMid: `m-${title}`,
  quality: '自动', audioUrl: `/api/online/stream?p=qq&id=q-${title}`,
});

test('R143 选择规则：边距内改选已登录源、边距外仍取最高分、没登录/关着/不过线一律不改', () => {
  const pick = match.pickMatchCandidate;
  const netease = hitFor('恋人', '李荣浩');
  const scored = [{ item: qqHit('恋人', '李荣浩'), score: 92 }, { item: netease, score: 85 }];
  // 边距内（92 − 85 = 7 ≤ 10）⇒ 改选已登录那家
  const inside = pick(scored, { preferLoggedIn: true, loggedInProviders: ['netease'] });
  assert.equal(inside.pick.item.provider, 'netease', '边距内优先已登录源');
  assert.equal(inside.preferred, true, '"这次是偏好生效挑的"要能被说出来（否则界面与自检都看不见它起过作用）');
  assert.equal(inside.over.score, 92, '被让位的那条也要留着（调试与解释都要）');
  // 边距外（92 − 80 = 12 > 10）⇒ 仍取全局最高
  const outside = pick([{ item: qqHit('恋人', '李荣浩'), score: 92 }, { item: netease, score: 80 }],
    { preferLoggedIn: true, loggedInProviders: ['netease'] });
  assert.equal(outside.pick.item.provider, 'qq', '超过边距就不许为了"优先登录源"去配一条更像别人歌的');
  assert.equal(outside.preferred, false);
  assert.equal(outside.beyondMargin, true);
  // 边界：正好等于边距 ⇒ 算"在边距内"（判据是"不超过"，不是"严格小于"）
  assert.equal(pick([{ item: qqHit('恋人', '李荣浩'), score: 92 }, { item: netease, score: 82 }],
    { preferLoggedIn: true, loggedInProviders: ['netease'] }).preferred, true);
  // 一家都没登录 / 开关关着 / 什么都不给 ⇒ 与今天逐字一致
  assert.equal(pick(scored, { preferLoggedIn: true, loggedInProviders: [] }).pick.item.provider, 'qq');
  assert.equal(pick(scored, { preferLoggedIn: false, loggedInProviders: ['netease'] }).pick.item.provider, 'qq');
  assert.equal(pick(scored, {}).pick.item.provider, 'qq', '这是"无会话行为不变"的根');
  // 已登录那家本来就在最前 ⇒ 不叫"偏好生效"（否则界面会给每次匹配都标"优先"）
  const already = pick(scored, { preferLoggedIn: true, loggedInProviders: ['qq'] });
  assert.equal(already.preferred, false);
  assert.equal(already.pick.item.provider, 'qq');
  // 最要紧的一格：已登录源的候选不过阈值 ⇒ 绝不因为它已登录就抬成匹配
  const below = pick([{ item: qqHit('恋人', '李荣浩'), score: 92 }, { item: netease, score: 60 }],
    { preferLoggedIn: true, loggedInProviders: ['netease'] });
  assert.equal(below.pick.item.provider, 'qq', '不过线的登录源候选不许上位');
  // 上面那一条**不足以**钉住"不过线"这一格：92 与 60 相差 32 分，就算把阈值那道守卫删掉，
  // 它也由"超边距"那一档挡住了（第一轮变异 T3 就是这么没咬的）。所以补一条**边距内但不过线**的：
  // 80 − 72 = 8 ≤ 10（边距允许改选），而 72 < 75（阈值不许）——只有阈值那道守卫在起作用。
  const belowInsideMargin = pick([{ item: qqHit('恋人', '李荣浩'), score: 80 }, { item: netease, score: 72 }],
    { preferLoggedIn: true, loggedInProviders: ['netease'] });
  assert.equal(belowInsideMargin.pick.item.provider, 'qq', '边距内但登录源不过线 ⇒ 仍不许上位（这一格只由阈值挡住）');
  assert.equal(belowInsideMargin.preferred, false, '不许把"没配上"写成"按偏好改选"');
  // 两家都登录 ⇒ 取已登录里分数最高的那条，不固定偏向某一家。
  // （入参**必须已按分数降序**——那是调用方的排序，函数不重排：这一格就是钉这个契约的。）
  const both = pick([{ item: qqHit('恋人', '李荣浩'), score: 88 }, { item: { ...netease, provider: 'netease' }, score: 80 }],
    { preferLoggedIn: true, loggedInProviders: ['netease', 'qq'] });
  assert.equal(both.pick.item.provider, 'qq', '都登录时按分数挑');
  assert.equal(both.preferred, false, '全局最高本来就是一家已登录的 ⇒ 不叫偏好生效');
  assert.equal(pick([], { preferLoggedIn: true, loggedInProviders: ['qq'] }).pick, null, '没有候选就是没有，不编一条');
  assert.equal(match.LOGGED_IN_PREFERENCE_MARGIN, 10, '边距是 10 分：改这个数要连界面文案一起改');
});

test('R143 走一遍匹配器：偏好开 + 网易已登录 ⇒ 挑中的是网易；关着 / 未登录 / 没接门面 ⇒ 还是 QQ', async () => {
  // 两条候选**同分**（同曲名同歌手同专辑同时长，只有来源不同）⇒ 全局最高是排序在前的 QQ，
  // 于是"改选网易"这件事只可能由偏好规则造成，不可能是分数造成的——这才叫钉住了接线。
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'rhine-pref-'));
  try {
    const search = async () => ({ ok: true, items: [qqHit('恋人', '李荣浩'), hitFor('恋人', '李荣浩')] });
    const entry = { title: '恋人', artist: '李荣浩', album: '黑马', durationMs: 276000 };
    // **每一档都换一个干净目录**：sidecar 是磁盘缓存，共用一份的话第二档会直接命中第一档的结果，
    // 测的就不是"这次挑了谁"而是"上次存了什么"。
    const run = async (preference) => {
      const oneDir = await mkdtemp(path.join(os.tmpdir(), 'rhine-pref-one-'));
      try {
        const store = await new PlaylistStore({ dataDir: oneDir }).init();
        await store.write('test', '恋人 - 李荣浩 | 黑马 | 4:36\n');
        const svc = match.createPlaylistMatcher({ store, search, ...(preference ? { preference } : {}) });
        const got = await svc.matchEntry('test', entry);
        assert.equal(got.ok, true, JSON.stringify(got));
        return got.track.provider;
      } finally { await rm(oneDir, { recursive: true, force: true }) }
    };
    assert.equal(await run(async () => ({ enabled: true, providers: ['netease'] })), 'netease',
      '挑中的是**实际选**的那一条（网易），不是排序最前的那条');
    assert.equal(await run(null), 'qq', '没接 preference ⇒ 行为与今天逐字一致');
    assert.equal(await run(async () => ({ enabled: false, providers: ['netease'] })), 'qq', '开关关着 ⇒ 已登录也不改选');
    assert.equal(await run(async () => ({ enabled: true, providers: [] })), 'qq', '一家都没登录 ⇒ 白话说的"什么都不改"必须真是这样');
    let asked = 0;
    await run(async () => { asked += 1; return { enabled: false, providers: ['netease'] }; });
    assert.equal(asked, 1, '门面每条目问一次（关着时服务端连会话文件都不 stat，见 music-server 那一处）');
  } finally { await rm(dataDir, { recursive: true, force: true }) }
});

test('R150（Q18）让位读数落进 sidecar 并透到界面：改选才落、没改选一格都不落、over 里不许有第三方地址', async () => {
  const runWith = async (preference, items) => {
    const oneDir = await mkdtemp(path.join(os.tmpdir(), 'rhine-yield-'));
    try {
      const store = await new PlaylistStore({ dataDir: oneDir }).init();
      await store.write('test', '恋人 - 李荣浩 | 黑马 | 4:36\n');
      const svc = match.createPlaylistMatcher({ store, search: async () => ({ ok: true, items }), ...(preference ? { preference } : {}) });
      await svc.matchEntry('test', { title: '恋人', artist: '李荣浩', album: '黑马', durationMs: 276000 });
      const raw = JSON.parse(await readFile(store.matchFileOf('test'), 'utf8'));
      return { record: Object.values(raw.entries)[0], view: await svc.tracks('test') };
    } finally { await rm(oneDir, { recursive: true, force: true }) }
  };
  // 两条只差时长 2 秒（乘子 0.95）⇒ QQ 100 / 网易 95：差 5 分在边距内 ⇒ 改选。
  // 用**不同分**而不是同分：同分时"谁让位"没有真实读数可报，那一格就只能靠断言编。
  // 让位那条**也带一个第三方封面地址**：不带着，"over 里不许有 coverRef"这一格就是空判（变异 Y2 第一轮因此没咬）。
  const pair = [
    { ...qqHit('恋人', '李荣浩'), coverRef: 'https://third-party.invalid/q.jpg' },
    { ...hitFor('恋人', '李荣浩'), durationMs: 278000, coverRef: 'https://third-party.invalid/n.jpg' },
  ];
  const on = await runWith(async () => ({ enabled: true, providers: ['netease'] }), pair);
  assert.equal(on.record.track.provider, 'netease');
  assert.equal(on.record.preferred, true, '改选过 ⇒ 这一格要留在磁盘上（重启之后界面还说得出来）');
  assert.deepEqual(on.record.over, { provider: 'qq', title: '恋人', artist: '李荣浩', score: 100 },
    '存的是**读数**（来源/曲名/歌手/分数），结论词由界面给——与 reason 那一格同一口径');
  assert.ok(!JSON.stringify(on.record.over).includes('third-party.invalid'),
    '让位那条的第三方封面地址不许跟着进 over：R116 那条红线不因为"只是为了解释"就让路');
  assert.equal(JSON.stringify(on.record.over).includes('mediaId'), false,
    'over 里不给 mediaId：界面说清"谁让位"用不到它，少一格就少一格会漂的东西');
  const row = on.view.items[0];
  assert.equal(row.preferred, true, 'tracks() 要把它透出去，否则界面拿不到');
  assert.equal(row.over.score, 100);
  assert.equal(row.score, 95, '行上的分数是**选中那条**的，不是让位那条的');
  // 三档"没改选"：一格都不许多出来
  const off = await runWith(null, pair);
  assert.equal(off.record.track.provider, 'qq');
  assert.equal('preferred' in off.record, false, '没改选不许落 preferred');
  assert.equal('over' in off.record, false);
  assert.deepEqual(Object.keys(off.record).sort().filter((k) => k !== 'track'), ['at', 'coverRef', 'ok', 'score'],
    '没改选时 sidecar 的键清单与 R143 之前逐字相同（"缺省关闭 ⇒ 磁盘上的数据一个字节都不变"的形状证据）');
  assert.equal(off.view.items[0].preferred, undefined, '界面也不该收到一个 false：没有这一格 = 没有让位这件事');
  const disabled = await runWith(async () => ({ enabled: false, providers: ['netease'] }), pair);
  assert.equal('preferred' in disabled.record, false, '开关关着 ⇒ 同样不落');
});

test('R143 配置：这一项不在 online 那张开关表里（性质不同），且只接受布尔值', async () => {
  const { MusicLibraryStore, ONLINE_SWITCHES } = await import('./music-library.mjs');
  assert.equal(ONLINE_SWITCHES.includes('preferLoggedInSource'), false,
    '那四家是"要不要出网"，这一项是"出网之后挑哪一条"——混进一张表等于把两类东西绑在一起');
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'rhine-pref-cfg-'));
  try {
    const store = await new MusicLibraryStore({ dataDir, defaultRoots: [] }).init();
    assert.equal(store.config.preferLoggedInSource, false, '缺省关闭：不打开时匹配行为与今天逐字一致');
    await store.updateConfig({ ...store.config, preferLoggedInSource: true });
    assert.equal(store.config.preferLoggedInSource, true);
    await assert.rejects(() => store.updateConfig({ ...store.config, preferLoggedInSource: 'yes' }), /必须为布尔值/);
    const before = JSON.stringify(store.config.online);
    await store.updateConfig({ preferLoggedInSource: false });
    assert.equal(JSON.stringify(store.config.online), before, '保存匹配偏好不该碰到在线开关（updateConfig 是"给了才改"）');
  } finally { await rm(dataDir, { recursive: true, force: true }) }
});

test('R143 接线面：开关在「扫码登录」那一节、只发这一项、边距与判定同源', async () => {
  const app = await readFile(new URL('../src/music-app.ts', import.meta.url), 'utf8');
  assert.match(app, /id="prefer-logged-in-source"/, '开关在扫码登录那一节里');
  assert.match(app, /data-action="save-pref-source"/, '有自己那颗保存按钮（不塞进"保存资料库设置"，那是另一件事）');
  assert.match(app, /await request\("\/api\/config", \{ preferLoggedInSource: box\.checked \}\)/,
    '只发这一项：捎带别的东西等于在一个按钮里改另一处设置');
  assert.match(app, /相差超过 \$\{ONLINE_PREFERENCE_MARGIN\} 分仍取分数最高的那条/,
    '界面上的边距必须引用常量，不许把 10 抄成字面量（抄第二次就会漂）');
  assert.match(app, /当前一家都没登录/, '没登录时那句实话要在');
  const server = await readScript('music-server.mjs');
  // 装配处只剩"把三样注给那一个出处"这一件事，判定本身在 `createMatchPreference`（下一条测试逐条判）。
  // 这一段原先写在装配处，于是下面这三条只能钉整行原文——R156 给返回值多带一格就把一次正常扩展
  // 判成了回归（本仓记过的那种"钉实现文本而不是不变式"）。
  assert.match(server, /preference: createMatchPreference\(\{[\s\S]{0,240}?readConfig: \(\) => store\.config,[\s\S]{0,120}?describeSessions: \(\) => onlineSession\.describe\(\),[\s\S]{0,160}?playableProviders: AUDIO_PROVIDERS/,
    '装配处必须把「当下那份配置」「会话描述」「能播的名单」三样注给同一个工厂（少一样就退回"只能读源码判"）');
  assert.equal(/const providers = \['netease', 'qq'/.test(server), false,
    '装配处不许再手抄一份"哪几家算数"（R143 那份两家的名单就是这么漂的）');
});

test('R156 偏好门面三条性质（这段从装配处抽出来就是为了能这样判——变异 P16 第一轮没咬的账）', async () => {
  const view = { providers: { netease: { source: 'cookie' }, qq: { source: 'none' }, kugou: { source: 'cookie' } } };
  let asked = 0;
  const describeSessions = async () => { asked += 1; return view };
  const gate = (config, playableProviders = ['netease', 'qq', 'kugou']) =>
    match.createMatchPreference({ readConfig: () => config, describeSessions, playableProviders });
  // ① 登录那把开关关着 ⇒ **一次会话都不问**（不摸凭据文件），但同平台那一项照样带得出去
  asked = 0;
  assert.deepEqual(await gate({ preferLoggedInSource: false, preferSamePlatformSource: true })(),
    { enabled: false, providers: [], preferSamePlatform: true },
    '关着那一档：enabled false、providers 空、preferSamePlatform 仍在（少带这一格就等于两条开关被捆成一条）');
  assert.equal(asked, 0, '开关关着时 describe/会话文件一次都不碰（无会话时行为与"没有这个功能"逐字一致）');
  // ② 两条开关**各管各的**：关掉同平台不影响登录那条
  asked = 0;
  assert.deepEqual(await gate({ preferLoggedInSource: true, preferSamePlatformSource: false })(),
    { enabled: true, providers: ['netease', 'kugou'], preferSamePlatform: false });
  assert.equal(asked, 1, '开着时问一次会话（不多问：每条目一次，与 R143 那个读数一致）');
  // ③ "哪几家算数"只有一个出处：能播的名单里没有的家，即使有会话也不算
  assert.deepEqual(await gate({ preferLoggedInSource: true, preferSamePlatformSource: true }, ['netease', 'qq'])(),
    { enabled: true, providers: ['netease'], preferSamePlatform: true },
    'QQ 那家有会话但不在"能播"名单里 ⇒ 不进集合（优先它等于把能播的换成不能播的）');
  // ④ readConfig 必须是**每次调用都读**：在装配处抓一次快照的话，用户改开关要重启才生效
  let live = { preferLoggedInSource: false, preferSamePlatformSource: true };
  const liveGate = match.createMatchPreference({ readConfig: () => live, describeSessions, playableProviders: ['netease'] });
  assert.equal((await liveGate()).enabled, false);
  live = { ...live, preferLoggedInSource: true };
  assert.equal((await liveGate()).enabled, true, '配置改了 ⇒ 下一次匹配就读到新的（不是等重启）');
  // ⑤ 配置里两格都没写过 ⇒ 门面**自己不猜默认值**（缺省归 store 的 init 那一层，见上一条配置测试）：
  // 这里两条都按"未开启"处理，出现第二处默认值就又有两个真相。
  assert.deepEqual(await gate({})(), { enabled: false, providers: [], preferSamePlatform: false });
});

// ── R146（任务九）· 缺封面时采纳"另一家同一首"的图 ──────────────────────────
const coverItem = (over = {}) => ({
  provider: 'qq', mediaId: 'Q1', mediaMid: '', title: '恋人', artist: '李荣浩', album: '黑马',
  durationMs: 276000, quality: '自动', coverRef: '', ...over,
});

test('R146 回落判据四条全要成立：来源不同 + 曲名歌手逐字相等 + 两边时长都知道且 ≤3 秒 + 它自己有图', () => {
  const entry = { title: '恋人', artist: '李荣浩', durationMs: 276000 };
  const track = { provider: 'qq', mediaId: 'Q1' };
  const ok = coverItem({ provider: 'netease', coverRef: 'https://p1.music.126.net/a.jpg' });
  assert.equal(match.coverFallbackOk(entry, ok, track), true, '四条齐备就该采纳');
  assert.equal(match.coverFallbackOk(entry, { ...ok, provider: 'qq' }, track), false, '同来源走的是 sameIdentity 那条正路，不算回落');
  assert.equal(match.coverFallbackOk(entry, { ...ok, coverRef: '' }, track), false, '没有图地址回落过来也是空的');
  assert.equal(match.coverFallbackOk(entry, { ...ok, title: '恋人 (Live)' }, track), false, '曲名不逐字相等 ⇒ 可能是另一个版本');
  assert.equal(match.coverFallbackOk(entry, { ...ok, artist: '李荣浩 / 金志文' }, track), false, '歌手不逐字相等 ⇒ 不是同一首');
  assert.equal(match.coverFallbackOk(entry, { ...ok, durationMs: 0 }, track), false, '对方缺时长 = 少一维证据 ⇒ 不猜');
  assert.equal(match.coverFallbackOk({ ...entry, durationMs: 0 }, ok, track), false, '条目自己缺时长同样不猜');
  assert.equal(match.coverFallbackOk(entry, { ...ok, durationMs: 279500 }, track), false, '差 3.5 秒超出容差');
  assert.equal(match.coverFallbackOk(entry, { ...ok, durationMs: 279000 }, track), true, '差 3 秒整在容差内（判据是"不超过"）');
  // 两边都不知道时长（都是 0）时算出来差 0 秒 —— 只有那道"两边都得 >0"的守卫挡得住。
  // 第一轮变异 F2 没咬就是因为缺了这一格：删掉守卫后 0 vs 0 照样通过，等于"零证据也敢借图"。
  assert.equal(match.coverFallbackOk({ ...entry, durationMs: 0 }, { ...ok, durationMs: 0 }, track), false,
    '两边时长都不知道 ⇒ 一维证据都没有，不许借');
  assert.equal(match.coverFallbackOk(entry, ok, {}), false, '匹配那一首没有来源 ⇒ 无从判断"不同家"');
  assert.equal(match.COVER_FALLBACK_DURATION_TOLERANCE_MS, 3_000, '容差改数要连界面文案与这条断言一起改');
});

test('R146 补图走一遍：正路有图就用正路的；正路没图才借，并把来源记进 coverFromProvider（不写 coverTried）', async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'rhine-cover-fallback-'));
  try {
    const store = new PlaylistStore({ dataDir });
    await store.write('test', '恋人 - 李荣浩 | 黑马 | 4:36\n');
    const entry = { title: '恋人', artist: '李荣浩', album: '黑马', durationMs: 276000 };
    const covers = { enabled: () => true, register: (ref) => `/api/online/artwork/${ref.length.toString(16).padStart(16, '0')}` };
    let round = 0;
    const search = async () => ({
      ok: true,
      items: round++ === 0
        // 第一轮：QQ 这一首匹配上了，但它自己不给封面地址。
        ? [coverItem()]
        // 第二轮（补图）：QQ 还是没图，网易那条是同一首且有图。
        : [coverItem(), coverItem({ provider: 'netease', mediaId: 'N1', coverRef: 'https://p1.music.126.net/a.jpg' })],
    });
    const svc = match.createPlaylistMatcher({ store, search, covers });
    const first = await svc.matchEntry('test', entry);
    assert.equal(first.ok, true, JSON.stringify(first));
    assert.equal(first.track.provider, 'qq', '匹配本身不许被补图改动');
    assert.equal(first.coverRef, '', '第一轮那首确实没图');
    // 抹掉"问过且没有"那一戳，模拟 7 天冷却到期后的第二次补图
    const sidecarPath = store.matchFileOf('test');
    const raw = JSON.parse(await readFile(sidecarPath, 'utf8'));
    for (const record of Object.values(raw.entries)) { delete record.coverTried; delete record.coverCheckedAt }
    await writeFile(sidecarPath, JSON.stringify(raw), 'utf8');
    const second = await svc.matchEntry('test', entry);
    assert.equal(second.coverRef, 'https://p1.music.126.net/a.jpg', '补图应当采纳另一家同一首的图');
    assert.equal(second.coverFromProvider, 'netease', '采纳借图必须记下来源');
    assert.equal(second.coverTried, undefined, '借到图了就不该再落"问过且没有"那一戳');
    const view = await svc.tracks('test');
    assert.equal(view.items[0].coverFrom, 'netease', '界面契约里要看得见这一格');
    assert.equal(view.items[0].track.provider, 'qq', '借图不改匹配：徽标仍是"已匹配 · QQ"，只是多一句封面来自网易云');
  } finally { await rm(dataDir, { recursive: true, force: true }) }
});

test('R146 正路有图时不许留借图标记；rememberCover 两件事都管', async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'rhine-cover-remember-'));
  try {
    const store = new PlaylistStore({ dataDir });
    await store.write('test', '恋人 - 李荣浩 | 黑马 | 4:36\n');
    const svc = match.createPlaylistMatcher({
      store,
      search: async () => ({ ok: true, items: [coverItem({ coverRef: 'https://img.example/qq.jpg' })] }),
      covers: { enabled: () => true, register: () => '/api/online/artwork/0000000000000000' },
    });
    await svc.matchEntry('test', { title: '恋人', artist: '李荣浩', album: '黑马', durationMs: 276000 });
    const file = store.matchFileOf('test');
    const withBorrow = JSON.parse(await readFile(file, 'utf8'));
    for (const record of Object.values(withBorrow.entries)) {
      record.coverRef = '';
      record.coverFromProvider = 'netease';
    }
    await writeFile(file, JSON.stringify(withBorrow), 'utf8');
    const ok = await svc.rememberCover({ provider: 'qq', mediaId: 'Q1', coverRef: 'https://img.example/qq.jpg' });
    assert.equal(ok.updated, 1, '按身份找到那一条并写回');
    const after = JSON.parse(await readFile(file, 'utf8'));
    for (const record of Object.values(after.entries)) {
      assert.equal(record.coverRef, 'https://img.example/qq.jpg');
      assert.equal(record.coverFromProvider, undefined, '正路自己给图时必须摘掉借图标记，否则两处说法不一');
      assert.equal(record.coverTried, undefined, '补到图了，冷却戳要一起清');
    }
    const borrowed = await svc.rememberCover({ provider: 'qq', mediaId: 'Q1', coverRef: 'https://p1.music.126.net/b.jpg', coverFrom: 'netease' });
    assert.equal(borrowed.updated, 1);
    const after2 = JSON.parse(await readFile(file, 'utf8'));
    assert.equal(Object.values(after2.entries)[0].coverFromProvider, 'netease', '墙上「重取封面」借了图也要记来源');
  } finally { await rm(dataDir, { recursive: true, force: true }) }
});

// ── R156（任务三）· 同平台优先匹配：两条偏好叠着走 ─────────────────────────────
// 非移植（原版无"跨平台匹配"这个概念）。规则本体是 `pickMatchCandidate` 那一个纯函数，
// 所以下面这一组绝大多数是纯函数判定 + 两条端到端（来历读得到、sidecar 落得下）。

const { provenanceComment, readPlaylistProvenance, PROVENANCE_PROVIDERS } = await import('./playlists.mjs');

test('R156 来历注释读写共用一份格式定义（写侧改了读侧必须一起改，否则同平台优先静默失效）', () => {
  const line = provenanceComment('qq', '3714550625', '2026-10-08T12:00:00.000Z');
  assert.equal(line, '# qq-playlist 3714550625 imported 2026-10-08T12:00:00.000Z');
  assert.deepEqual(readPlaylistProvenance(`# Rhine 歌单 v1\n${line}\n# name: 我喜欢\n`),
    { provider: 'qq', id: '3714550625', importedAt: '2026-10-08T12:00:00.000Z' });
  // 三家都认，且认的来源名单只有一个出处（导入器与匹配器读同一张表）
  for (const provider of PROVENANCE_PROVIDERS) {
    assert.equal(readPlaylistProvenance(provenanceComment(provider, 'x1')).provider, provider);
  }
  assert.deepEqual([...PROVENANCE_PROVIDERS], ['netease', 'qq', 'kugou']);
  // 不认识的来源名一律 null（绝不把没见过的字符串当平台 ⇒ 也就不会有一条规则悄悄生效）
  assert.equal(readPlaylistProvenance('# whatever-playlist x1 imported 2026-01-01T00:00:00Z'), null);
  // 手写歌单、注释被用户删掉、只有名字那一行 ⇒ 都算"没有来历"，同平台那一档不参与
  assert.equal(readPlaylistProvenance('恋人 - 李荣浩\n'), null);
  assert.equal(readPlaylistProvenance('# name: 我手打的\n恋人 - 李荣浩\n'), null);
  assert.equal(readPlaylistProvenance(''), null);
  assert.equal(readPlaylistProvenance(undefined), null);
  // 大小写与多余空白不敏感（用户会用任何编辑器改这个文件）
  assert.equal(readPlaylistProvenance('#  QQ-Playlist   12345  imported 2026-01-01T00:00:00Z').provider, 'qq');
  // 酷狗的 id 形状带下划线，也照样认（这条是 R137 写进文件里的那一形）
  assert.equal(readPlaylistProvenance(provenanceComment('kugou', 'collection_1_1341266283_964007_0')).id,
    'collection_1_1341266283_964007_0');
});

test('R156 叠加优先序：先同平台 → 再已登录源 → 再全局最高分；两条共用同一个边距与同一条底线', () => {
  const pick = match.pickMatchCandidate;
  const netease = hitFor('恋人', '李荣浩');
  const qq = qqHit('恋人', '李荣浩');
  // ① 同平台在边距内 ⇒ 第一步就命中，`preferredBy` 说的是"哪条规则改选的"
  const samePlatform = pick([{ item: netease, score: 100 }, { item: qq, score: 95 }],
    { platformProvider: 'qq', preferSamePlatform: true });
  assert.equal(samePlatform.pick.item.provider, 'qq');
  assert.equal(samePlatform.preferred, true);
  assert.equal(samePlatform.preferredBy, 'same-platform', '徽标要分得出是同平台还是登录源改选的（两条规则两回事）');
  assert.equal(samePlatform.over.score, 100);
  // ② 同平台超边距 ⇒ 落第二步；这里第二步也没开 ⇒ 仍取全局最高
  const beyond = pick([{ item: netease, score: 100 }, { item: qq, score: 85 }],
    { platformProvider: 'qq', preferSamePlatform: true });
  assert.equal(beyond.pick.item.provider, 'netease', '差 15 分 > 边距 10 ⇒ 不为"同源"换一首更像别人的歌');
  assert.equal(beyond.preferred, false);
  // ③ 两条都开着但都不该动：同平台那条超边距、登录那条本来就是全局最高 ⇒ 原样取最高分
  const secondStep = pick([{ item: netease, score: 100 }, { item: qq, score: 85 }],
    { platformProvider: 'qq', preferSamePlatform: true, preferLoggedIn: true, loggedInProviders: ['netease'] });
  assert.equal(secondStep.pick.item.provider, 'netease');
  assert.equal(secondStep.preferred, false, '全局最高分本来就是登录源 ⇒ 没有"改选"这回事，不许虚报');
  // 第一步空转（同平台那一条本来就是全局最高）⇒ 第二步照走：两条规则是**叠着**的，不是"占位"关系
  const secondStepTakesOver = pick([{ item: netease, score: 100 }, { item: qq, score: 95 }],
    { platformProvider: 'netease', preferSamePlatform: true, preferLoggedIn: true, loggedInProviders: ['qq'] });
  assert.equal(secondStepTakesOver.pick.item.provider, 'qq', '同平台空转 ⇒ 登录源那一档接手（不许把第一步不命中当成"整条偏好不适用"）');
  assert.equal(secondStepTakesOver.preferred, true);
  assert.equal(secondStepTakesOver.preferredBy, 'logged-in', '让位是第二条规则造成的：徽标必须换成第二句（写成 same-platform 就是谎报成因）');
  const loggedOnlySwap = pick([{ item: netease, score: 100 }, { item: qq, score: 95 }],
    { platformProvider: '', preferSamePlatform: true, preferLoggedIn: true, loggedInProviders: ['qq'] });
  assert.equal(loggedOnlySwap.pick.item.provider, 'qq');
  assert.equal(loggedOnlySwap.preferredBy, 'logged-in', '第二条规则改选的必须写成 logged-in（两条规则混成一档界面就说不清是谁让的位）');
  // ④ 同平台候选**没过阈值** ⇒ 一律不许抬成匹配（与 R143 同一条底线）。
  // 这一格必须**在边距内**（80 − 72 = 8 ≤ 10）：差得远的那种即使删掉阈值守卫也会被边距挡住，
  // 于是"过线才许上位"这一格其实没人判（R143 第一轮变异 T3 没咬就是这个原因）。
  const belowInsideMargin = pick([{ item: netease, score: 80 }, { item: qq, score: 72 }],
    { platformProvider: 'qq', preferSamePlatform: true, minScore: 75 });
  assert.equal(belowInsideMargin.pick.item.provider, 'netease', '边距内但同平台候选不过线 ⇒ 仍不许上位');
  assert.equal(belowInsideMargin.preferred, false);
  // ⑤ 两条都命中同一家且它已是全局最高 ⇒ 不算改选
  const alreadyBest = pick([{ item: qq, score: 100 }, { item: netease, score: 90 }],
    { platformProvider: 'qq', preferSamePlatform: true, preferLoggedIn: true, loggedInProviders: ['qq'] });
  assert.equal(alreadyBest.preferred, false, '本来就是它，谈不上让位');
  // ⑥ 开关关着 / 没有来历 ⇒ **与今天逐字一致**（只走登录那条，一条都不多走）
  const offSwitch = pick([{ item: netease, score: 100 }, { item: qq, score: 95 }],
    { platformProvider: 'qq', preferSamePlatform: false });
  assert.equal(offSwitch.pick.item.provider, 'netease');
  assert.equal(offSwitch.preferred, false);
  const noProvenance = pick([{ item: netease, score: 100 }, { item: qq, score: 95 }],
    { platformProvider: '', preferSamePlatform: true });
  assert.equal(noProvenance.pick.item.provider, 'netease', '手打的歌单没有来历 ⇒ 这一档根本不参与');
  assert.equal(pick([], { platformProvider: 'qq', preferSamePlatform: true }).pick, null, '没有候选就是没有，不编一条');
  // ⑦ 两条都开、同平台那一家恰好也已登录 ⇒ 第一步命中（优先序是指令定的，不是随手写的）
  const both = pick([{ item: netease, score: 100 }, { item: qq, score: 95 }],
    { platformProvider: 'qq', preferSamePlatform: true, preferLoggedIn: true, loggedInProviders: ['qq'] });
  assert.equal(both.pick.item.provider, 'qq');
  assert.equal(both.preferredBy, 'same-platform', '两条都允许时同平台在前：这是指令写的序，不许漂成实现顺手写的序');
});

test('R156 端到端：QQ 来历的单在边距内改选到 QQ；网易来历的单仍在网易；手打的单与今天逐字一致', async () => {
  // 两条候选**差 5 分**（只差时长 2 秒）：全局最高是网易。于是"改选到 QQ"只可能由同平台那条规则造成。
  // 两条都带**第三方封面地址**：不带着，"让位那条的地址不许跟着进 over"这一格就是空判（R150 同一条教训）。
  const run = async (body, preference) => {
    const oneDir = await mkdtemp(path.join(os.tmpdir(), 'rhine-sameplatform-'));
    try {
      const store = await new PlaylistStore({ dataDir: oneDir }).init();
      await store.write('test', body);
      const svc = match.createPlaylistMatcher({
        store,
        search: async () => ({ ok: true, items: [
          { ...hitFor('恋人', '李荣浩', '黑马'), coverRef: 'https://third-party.invalid/n.jpg' },
          { ...qqHit('恋人', '李荣浩', '黑马'), durationMs: 278000, coverRef: 'https://third-party.invalid/q.jpg' },
        ] }),
        ...(preference ? { preference } : {}),
      });
      const got = await svc.matchAll('test');
      const row = (await svc.tracks('test')).items[0];
      // sidecar 在**临时目录被删之前**读回来：放到 try 外面读，判的就不是磁盘而是"一个已经不存在的文件"。
      const raw = await readFile(store.matchFileOf('test'), 'utf8').catch(() => null);
      return { got, row, record: raw === null ? null : Object.values(JSON.parse(raw).entries)[0] };
    } finally { await rm(oneDir, { recursive: true, force: true }) }
  };
  const line = '# Rhine 歌单 v1\n';
  const item = '恋人 - 李荣浩 | 黑马 | 4:36\n';
  const prefer = async () => ({ enabled: false, providers: [], preferSamePlatform: true });
  const fromQq = await run(line + provenanceComment('qq', '3714550625') + '\n' + item, prefer);
  assert.equal(fromQq.got.matched, 1);
  assert.equal(fromQq.row.track.provider, 'qq', 'QQ 导入的单在边距内改选到 QQ');
  assert.equal(fromQq.row.preferred, true);
  assert.equal(fromQq.row.preferredBy, 'same-platform');
  assert.equal(fromQq.row.over.provider, 'netease', '让位那条的读数一起落盘（R150 的口径）');
  assert.equal(fromQq.row.over.score, 100);
  assert.ok(fromQq.record, '改选过就一定搜过 ⇒ sidecar 已写盘');
  assert.equal(fromQq.record.preferredBy, 'same-platform');
  assert.equal(fromQq.record.coverRef, 'https://third-party.invalid/q.jpg',
    '选中的那条：第三方地址照旧只留在服务端这份数据文件里（R116 那条红线不因改选而变）');
  assert.equal('mediaId' in (fromQq.record.over ?? {}), false, '让位读数里不许有 mediaId');
  assert.equal(JSON.stringify(fromQq.record.over).includes('third-party.invalid'), false,
    '让位那条的第三方封面地址不许跟着进 over：为"解释"开的口子正是地址外流最常见的那道');
  const fromNetease = await run(line + provenanceComment('netease', '17429985859') + '\n' + item, prefer);
  assert.equal(fromNetease.row.track.provider, 'netease', '网易导入的单本来就在网易（全局最高就是它，不该被换走）');
  assert.equal(fromNetease.row.preferred, undefined, '没改选 ⇒ 界面那一格都不许多出来');
  assert.equal('preferred' in (fromNetease.record ?? {}), false, '没改选 ⇒ 磁盘上也不许多那一格（缺省态的形状证据）');
  const fromPlain = await run(line + '# name: 手打的\n' + item, prefer);
  assert.equal(fromPlain.row.track.provider, 'netease', '手打的单没有来历 ⇒ 与今天逐字一致（取全局最高分）');
  // 关掉这一档：QQ 来历的单也回到全局最高（这一格证明"缺省/关闭态与今天一致"）
  const off = await run(line + provenanceComment('qq', '3714550625') + '\n' + item,
    async () => ({ enabled: false, providers: [], preferSamePlatform: false }));
  assert.equal(off.row.track.provider, 'netease', '开关关着 ⇒ 同平台也不改选');
});

test('R156 来历只在整单时读一次（1000 条的单不许逐条重读歌单文件）', async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'rhine-once-'));
  try {
    const store = await new PlaylistStore({ dataDir }).init();
    await store.write('big', '# Rhine 歌单 v1\n' + provenanceComment('qq', '1') + '\n'
      + Array.from({ length: 6 }, (unused, i) => `恋人${i} - 李荣浩 | 黑马 | 4:36`).join('\n') + '\n');
    let gets = 0;
    const countingStore = {
      get: async (id) => { gets += 1; return store.get(id) },
      matchFileOf: (id) => store.matchFileOf(id),
    };
    // 曲名按查询串的**第一个词**回显 ⇒ 上面的条目曲名故意不带空格：
    // 这一条判的是"读几次文件"，不把分数当第二个变量（第一版写成「恋人 0」被切成「恋人」，六条全 74 分未匹配）。
    const svc = match.createPlaylistMatcher({
      store: countingStore,
      search: async ({ query }) => ({ ok: true, items: [
        { ...hitFor(String(query ?? '').split(' ')[0], '李荣浩', '黑马'), coverRef: '' },
        { ...qqHit(String(query ?? '').split(' ')[0], '李荣浩', '黑马'), coverRef: '' },
      ] }),
      preference: async () => ({ enabled: false, providers: [], preferSamePlatform: true }),
    });
    const got = await svc.matchAll('big');
    assert.equal(got.total, 6);
    assert.equal(got.matched, 6, '同平台改选不许把任何一条做成"未匹配"');
    assert.equal(gets, 1, `整单只读一次文件，实际读了 ${gets} 次`);
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});

test('R156 老 sidecar 记录（没有 preferredBy 那一格）回落成"登录源优先"，不猜、不报错', async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'rhine-legacy-'));
  try {
    const store = await new PlaylistStore({ dataDir }).init();
    await store.write('old', '# Rhine 歌单 v1\n' + provenanceComment('qq', '9') + '\n恋人 - 李荣浩 | 黑马 | 4:36\n');
    const svc = match.createPlaylistMatcher({ store, search: async () => ({ ok: true, items: [] }) });
    // 键由**真正的同一把尺**算出：拿解析后的条目喂 entryKey，不在这里手搓一个键名。
    const [entry] = (await store.get('old')).items;
    const track = { ...hitFor('恋人', '李荣浩', '黑马') };
    // 手写一份 R150 时代形状的 sidecar：有 preferred/over，没有 preferredBy（那时只有登录源一条规则）
    await writeFile(store.matchFileOf('old'), JSON.stringify({
      version: 1, playlist: 'old', updatedAt: 1,
      entries: { [match.entryKey(entry)]: {
        ok: true, at: 1, score: 95, track, coverRef: '', preferred: true,
        over: { provider: 'netease', title: '恋人', artist: '李荣浩', score: 100 },
      } },
    }), 'utf8');
    const row = (await svc.tracks('old')).items[0];
    assert.equal(row.matched, true, '老记录要照常读出来（删 sidecar 无害那条纪律的延伸：加字段也不能让旧数据读不出）');
    assert.equal(row.preferred, true);
    assert.equal(row.preferredBy, 'logged-in', '缺格回落成"登录源优先"——那批数据写入时只有这一条规则，不是猜');
    assert.equal(row.track.provider, 'netease', '回落只影响"怎么说"，不影响"选的是谁"');
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});

test('R156 接线：来历平台来自歌单文件而不是配置；导入写的那一行读得回来（写侧改了读侧会静默失效）', async () => {
  const storeSource = await readScript('playlist-import.mjs');
  const matchSource = await readScript('playlist-match.mjs');
  // 写侧必须经那一把共用的尺，不许再手搓一次模板字符串
  assert.match(storeSource, /provenanceComment\(/, '导入器写来历要用共用函数');
  assert.equal((storeSource.match(/# \$\{provider\}-playlist/g) ?? []).length, 0,
    '不许在导入器里再手搓一份来历注释格式（两份格式一定漂）');
  assert.match(matchSource, /readPlaylistProvenance/, '匹配器读来历要用同一个解析器');
  // 界面那句规则名来自 preferredBy（两条规则两条说法，混成一句用户就不知道关哪个）
  const uiSource = await readScript('../src/playlists-ui.ts');
  assert.match(uiSource, /preferredBy === "same-platform" \? "同平台优先" : "登录源优先"/,
    '徽标由 preferredBy 决定说法；写死其中一句就等于把另一条规则藏起来');
  // 边距这一个数**两边各抄了一份**（前端 10 / 服务端 10）：R143 时就没人钉它会不会漂，
  // 任务三把它变成**两条规则共用**的数 ⇒ 现在必须钉。跨语言没法共享常量，那就由断言做这道锁。
  const appSource = await readScript('../src/music-app.ts');
  const frontMargin = Number(/const ONLINE_PREFERENCE_MARGIN = (\d+);/.exec(appSource)?.[1] ?? NaN);
  assert.equal(frontMargin, match.LOGGED_IN_PREFERENCE_MARGIN,
    `界面上的边距必须与服务端判定用的那个数一致（前端 ${frontMargin} vs 服务端 ${match.LOGGED_IN_PREFERENCE_MARGIN}）`);
  // 新开关：自己那颗按钮、只发自己那一格、缺省态是"勾着"的（缺省开是本轮用户明确要的行为）
  assert.match(appSource, /id="prefer-same-platform-source"/, '同平台那一档有自己的复选框');
  assert.match(appSource, /data-action="save-same-platform"/, '有自己的保存按钮（不搭"保存资料库设置"那班车）');
  assert.match(appSource, /await request\("\/api\/config", \{ preferSamePlatformSource: box\.checked \}\)/,
    '那颗按钮只发这一项');
  assert.match(appSource, /config\.preferSamePlatformSource !== false \? "checked"/,
    '缺省显示为已开启（与 store.config 的缺省值同一口径；写成 ? checked 会把缺省开说成缺省关）');
  assert.match(appSource, /优先同平台不保证更能播/, '代价那句必须在界面上（两条偏好的真实冲突不藏起来）');
});

test('R156 配置：缺省开、不在 online 那张表里、只接受布尔值、磁盘上没写过不等于用户关过', async () => {
  const { MusicLibraryStore, ONLINE_SWITCHES } = await import('./music-library.mjs');
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'rhine-sameplatform-cfg-'));
  try {
    const store = await new MusicLibraryStore({ dataDir, defaultRoots: [] }).init();
    assert.equal(ONLINE_SWITCHES.includes('preferSamePlatformSource'), false,
      '那张表管"要不要出网"，这一项管"出网之后挑哪一条"（与 R143 那条同一口径）');
    assert.equal(store.config.preferSamePlatformSource, true, '缺省开：这是用户本批明确要的行为');
    await store.updateConfig({ preferSamePlatformSource: false });
    assert.equal(store.config.preferSamePlatformSource, false);
    // **重开一次实例**：磁盘上写过的 false 必须活着（R72 那条口径：只有明确表过态才作数）
    const reopened = await new MusicLibraryStore({ dataDir, defaultRoots: [] }).init();
    assert.equal(reopened.config.preferSamePlatformSource, false, '用户关过一次，重启后还是关着');
    // 另一半：磁盘上**根本没写过**这一格时不能读成"用户关过"
    const legacyDir = await mkdtemp(path.join(os.tmpdir(), 'rhine-sameplatform-legacy-cfg-'));
    try {
      const seed = await new MusicLibraryStore({ dataDir: legacyDir, defaultRoots: [] }).init();
      await seed.updateConfig({ preferLoggedInSource: true });
      const file = path.join(legacyDir, 'config.json');
      const raw = JSON.parse(await readFile(file, 'utf8'));
      delete raw.preferSamePlatformSource;                     // config.json 存的就是这份平铺的配置对象
      await writeFile(file, JSON.stringify(raw), 'utf8');
      assert.equal('preferSamePlatformSource' in raw, false, '先把这一格从盘上抹掉，造出"升级前的老配置"');
      const up = await new MusicLibraryStore({ dataDir: legacyDir, defaultRoots: [] }).init();
      assert.equal(up.config.preferSamePlatformSource, true,
        '老库里没有这一格 ⇒ 落回产品默认（开），不许读成 undefined/false 把缺省开说成缺省关');
      assert.equal(up.config.preferLoggedInSource, true, '同一次归一不许顺手改掉别的东西');
    } finally { await rm(legacyDir, { recursive: true, force: true }) }
    await assert.rejects(() => store.updateConfig({ preferSamePlatformSource: 'yes' }), /必须为布尔值/);
    const before = JSON.stringify(store.config.online);
    await store.updateConfig({ preferSamePlatformSource: true });
    assert.equal(JSON.stringify(store.config.online), before, '保存这一项不该碰到在线开关');
    assert.equal(store.config.preferLoggedInSource, false, '也不该顺手改掉登录偏好那一格（两条是两条）');
  } finally { await rm(dataDir, { recursive: true, force: true }) }
});

// ── R198：展示封面（点「播放已匹配的 N 条」之后给这张歌单选一张真封面）──────────────
// 四条判据：① 选的是"已匹配条目里第一条有 coverRef 的"（顺序 = 歌单条目序）；
// ② 写的是 sidecar 的新字段、**响应里只出同源 token 地址**（第三方 URL 不出服务端）；
// ③ 清除（详情面板那颗「恢复程序化封面」）就是把字段删掉 ⇒ 回退程序化色块；
// ④ 一条 coverRef 都没有的歌单不受影响（不落字段）。
test('R198：展示封面选"第一条有封面的"、响应只出同源地址、清除即回退、无封面不受影响', async () => {
  await withPlaylist(async ({ store }) => {
    const search = async ({ query }) => ({ ok: true, items: [{ ...hitFor(query.split(' ')[0], '李荣浩'), coverRef: 'https://p1.music.126.net/cover-x.jpg' }] });
    const covers = { enabled: () => true, register: (ref) => `/api/online/artwork/tok-${String(ref).length}` };
    const svc = match.createPlaylistMatcher({ store, search, covers });
    await svc.matchAll('test');                       // 三条都配上，每条都带 coverRef
    // ① 选第一条有封面的 —— 把**第一条**的封面抹掉，展示封面应当落到第二条那一张
    const file = store.matchFileOf('test');
    const sidecar = JSON.parse(await readFile(file, 'utf8'));
    const keys = Object.keys(sidecar.entries);
    assert.equal(keys.length, 3, '三条都该在 sidecar 里（夹具三条）');
    delete sidecar.entries[keys[0]].coverRef;
    await writeFile(file, JSON.stringify(sidecar), 'utf8');
    const set = await svc.setDisplayCover('test');
    assert.equal(set.changed, true, '第一次设应当算"变了"');
    assert.equal(set.ref, sidecar.entries[keys[1]].coverRef, '值为空的那条应当被跳过（顺序 = 条目序）');
    const onDisk = JSON.parse(await readFile(file, 'utf8'));
    assert.equal(onDisk.displayCoverRef, sidecar.entries[keys[1]].coverRef, '落盘的是 sidecar 里的 displayCoverRef');
    // ② 响应里只出同源地址：第三方 URL 一个字都不许出现
    const view = await svc.tracks('test');
    assert.match(view.displayCoverUrl, /^\/api\/online\/artwork\//, '给前端的是同源 token 地址');
    assert.equal(JSON.stringify(view).includes('music.126.net'), false, '响应里不许出现第三方地址');
    // 幂等：同样的值再设一次不写盘（changed=false —— 与"只有真搜过才写盘"同一条纪律）
    const again = await svc.setDisplayCover('test');
    assert.equal(again.changed, false, '值没变就不该写盘');
    // ③ 清除 = 删字段 ⇒ 回退
    const cleared = await svc.setDisplayCover('test', { clear: true });
    assert.equal(cleared.changed, true);
    const after = JSON.parse(await readFile(file, 'utf8'));
    assert.equal('displayCoverRef' in after, false, '清除是把字段删掉，不留空壳');
    assert.equal((await svc.tracks('test')).displayCoverUrl, '', '回退之后没有展示封面');
  });
  // ④ 一条 coverRef 都没有的歌单：不落字段（架上照旧画程序化拼贴）
  await withPlaylist(async ({ store }) => {
    const svc = match.createPlaylistMatcher({ store, search: async ({ query }) => ({ ok: true, items: [hitFor(query.split(' ')[0], '李荣浩')] }) });
    await svc.matchAll('test');                       // hitFor 不带 coverRef
    const set = await svc.setDisplayCover('test');
    assert.equal(set.ref, '', '一条封面都没有 ⇒ 选不出来');
    const onDisk = JSON.parse(await readFile(store.matchFileOf('test'), 'utf8'));
    assert.equal('displayCoverRef' in onDisk, false, '不落字段（空壳会让"没有"与"清过"混在一起）');
    const { playlistShelfRow } = await import('./playlists.mjs');
    const row = playlistShelfRow({ ...(await svc.tracks('test')), displayCoverUrl: '' });
    assert.equal(row.coverUrl, '', '架上那格的封面仍是空串 ⇒ 走程序化拼贴');
  });
});

// ── R220 · 来源身份：列/导入账号歌单那一步拿到的 id 存进 sidecar，取源优先用它 ──────────────
// 现场（验收侧一手，用户那份 400 行的 `我喜欢`）：文件头有来历（`# kugou-playlist collection_3_… imported …`），
// 但每行只有"曲名 - 歌手 | 专辑 | 时长"，没有该行身份 ⇒ 明明来自酷狗账号单、酷狗侧有 id，
// 却必须重搜一遍认歌，认不出的落到别家（回执：kugou 209 行 / qq 163 行 / 未匹配 28 行）。

test('R220 ①：来源身份写进 sidecar 后逐字保留；`.playlist.txt` 连 mtime 都不动', async () => {
  await withPlaylist(async ({ svc, store }) => {
    const before = await readFile(store.fileOf('test'), 'utf8');
    const beforeStat = await stat(store.fileOf('test'));
    const report = await svc.applySourceIdentities('test', [
      { provider: 'kugou', mediaId: 'A'.repeat(32), title: '恋人', artist: '李荣浩', album: '黑马' },
    ]);
    assert.equal(report.filled, 1, `(i) 对得上条目指纹的那一行要补上：${JSON.stringify(report)}`);
    assert.equal(report.unfilled, 2, '没给身份的行如实计入"没补到"，不假装成功');
    assert.equal(await readFile(store.fileOf('test'), 'utf8'), before, '(i) 正文一个字都不改（批复：不动 .playlist.txt 格式）');
    assert.equal((await stat(store.fileOf('test'))).mtimeMs, beforeStat.mtimeMs, '(i) 连 mtime 都不该动（没写过它）');
    const sidecar = await svc.readSidecar('test');
    const stored = Object.values(sidecar.entries).find((record) => record.sourceMediaId);
    assert.equal(stored?.sourceProvider, 'kugou', '(i) 哪家要逐字留着');
    assert.equal(stored?.sourceMediaId, 'A'.repeat(32), '(i) 那条 id 要逐字留着');
    // 这一档**不在这里**验"搜索写回不清身份"：认得出的身份会在 `matchEntry` 里短路、根本不走搜索写回，
    // 所以在这一张单上那条断言永远不咬（第一版就把它写在这儿，变异 N6 当场没咬 = 空断言）。
    // 真正会走搜索写回的记录 = 有身份但形状不认识（`kuwo`）那一条 ⇒ 判据 (iii) 里钉。
    await svc.matchAll('test');
    const after = await svc.readSidecar('test');
    const kept = Object.values(after.entries).find((record) => record.sourceMediaId);
    assert.equal(kept?.sourceProvider, 'kugou', '(i) 整单匹配之后这一行的身份还在（短路那条路不覆盖它）');
    assert.equal('score' in kept, false, '(i) 走身份的那一行没有分数，sidecar 里也不该被补一个');
  });
});

test('R220 ②：同一行的"来源身份"与"搜索结果"不一致 ⇒ 用来源身份那个，且整单匹配不为它出网', async () => {
  await withPlaylist(async ({ svc, counts }) => {
    await svc.applySourceIdentities('test', [
      { provider: 'kugou', mediaId: 'K'.repeat(32), title: '恋人', artist: '李荣浩', album: '黑马' },
    ]);
    const view = await svc.tracks('test');
    const row = view.items.find((item) => item.entry.title === '恋人');
    assert.equal(row?.matched, true, '(ii) 有来源身份的这一行直接就是可播的');
    assert.equal(row.source, 'identity', '(ii) 这一行走的是来源身份那一档（界面徽标据此说话）');
    assert.equal(row.track.provider, 'kugou', '(ii) 用的是账号单里它自己的 id，不是搜索给的网易那一首');
    assert.equal(row.track.id, `on-kugou-${'K'.repeat(32)}`, '(ii) 媒体 id 逐字进曲目身份');
    assert.equal(row.score, undefined, '(ii) 没经过打分就不许编一个分数');
    const before = counts();
    const all = await svc.matchAll('test');
    assert.equal(counts() - before, 2, `(ii) 三行里只有没身份的两行去搜索（实际 ${counts() - before} 次）`);
    assert.ok(all.matched >= 1);
  });
});

test('R220 ③：来源身份形状不认识（家不在三家内 / id 空）⇒ 退回今天的搜索匹配，不判死', async () => {
  await withPlaylist(async ({ svc, counts }) => {
    await svc.applySourceIdentities('test', [
      { provider: 'kuwo', mediaId: 'x', title: '恋人', artist: '李荣浩', album: '黑马' },      // 认不出的家
      { provider: 'kugou', mediaId: '', title: '不将就', artist: '李荣浩', album: '黑马' },     // 空 id
    ]);
    const before = counts();
    const all = await svc.matchAll('test');
    assert.ok(counts() - before >= 2, '(iii) 认不出身份的行必须照常去搜（不许因为"有这一格"就不播）');
    const view = await svc.tracks('test');
    const row = view.items.find((item) => item.entry.title === '恋人');
    assert.equal(row?.track?.provider, 'netease', '(iii) 这一行用的是搜索结果（退回路径仍在）');
    assert.notEqual(row?.source, 'identity');
    assert.equal(all.matched >= 2, true, '(iii) 退回之后照样配得上');
    // 这一行**真的走了搜索写回**（身份形状不认识 ⇒ 没短路）⇒ `keepSourceIdentity` 那三格保留才有观察面。
    // 写在这里而不是 (i)：(i) 那张单里认得出的身份会被短路、永远碰不到这条写回路（第一版的空断言）。
    const written = await svc.readSidecar('test');
    const searched = Object.values(written.entries).find((record) => record.sourceProvider === 'kuwo');
    assert.ok(searched, '(iii) 搜索写回之后，那三格来源身份还在（两份事实并存，不是被搜索结果覆盖）');
    assert.equal(searched.sourceMediaId, 'x', '(iii) id 逐字留着');
    assert.ok(searched.track, '(iii) 同时也有搜索来的那一首的缓存');
  });
});

test('R220 ④：徽标说得出"来源身份"这一路，与"靠搜索匹配"那一档不混（真跑 entryBadge）', async () => {
  const { entryBadge } = await import('../src/playlists-ui.ts');
  const track = { provider: 'kugou', title: '恋人', artist: '李荣浩', durationMs: 276000, mediaId: 'K'.repeat(32), id: `on-kugou-${'K'.repeat(32)}`, sourceKind: 'online', audioUrl: '/api/online/stream?p=kugou&id=x' };
  const base = { entry: { title: '恋人', artist: '李荣浩' }, matched: true, track, line: 2, lineText: '' };
  assert.equal(entryBadge({ ...base, source: 'identity' }), '已匹配 · 酷狗（来源身份）', '(iv) 这一档要说得出它没经过搜索');
  assert.equal(entryBadge({ ...base, source: 'cache', score: 92 }), '已匹配 · 酷狗 92分', '(iv) 搜索匹配那一档仍是原样（带分数、不带"来源身份"）');
  assert.equal(entryBadge({ ...base, source: 'inline' }), '已匹配 · 酷狗', '(iv) inline（用户手工加进来的那一首）也不冒充来源身份');
});

test('R220 ⑤：对齐两档 —— 毫秒零头回对不上时按"去时长"补；去时长后撞成多行的（两个版本）一律不写', async () => {
  // 文本里的时长是按秒写回去的（`4:16`），上游给的毫秒值有零头时逐字回对不上 ⇒ 只用完整指纹
  // 会让一整批行"看起来没补到"。但同一首歌的两个版本（去时长后同键）谁都不许写：猜一次就可能播错歌。
  const text = '[album] 黑马\n恋人 - 李荣浩 | 黑马 | 4:16\n恋人 - 李荣浩 | 黑马 | 4:52\n慢冷 - 李荣浩 | 黑马 | 4:17\n';
  await withPlaylist(async ({ svc }) => {
    const report = await svc.applySourceIdentities('test', [
      { provider: 'kugou', mediaId: 'V'.repeat(32), title: '恋人', artist: '李荣浩', album: '黑马', durationMs: 256400 },
      { provider: 'kugou', mediaId: 'M'.repeat(32), title: '慢冷', artist: '李荣浩', album: '黑马', durationMs: 257000 },
    ]);
    assert.equal(report.filled, 1, `(v) 只有不歧义的那一行被补上：${JSON.stringify(report)}`);
    assert.equal(report.unfilled, 2, '(v) 两个版本的恋人都算"没补到"，不挑一个写');
    const view = await svc.tracks('test');
    const rows = view.items.filter((item) => item.entry.title === '恋人');
    assert.equal(rows.length, 2);
    for (const row of rows) assert.notEqual(row.source, 'identity', '(v) 歧义的那两行都不许拿到身份');
    const filled = view.items.find((item) => item.entry.title === '慢冷');
    assert.equal(filled.source, 'identity', '(v) 毫秒零头那一条按"去时长"键补上了');
    assert.equal(filled.track.id, `on-kugou-${'M'.repeat(32)}`);
  }, text);
});
