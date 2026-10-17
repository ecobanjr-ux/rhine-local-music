// 第五期 Task 8 自检：文本歌单实体（格式定义、坏行留痕、原子写 + .backup、每请求重读）。
//
// 这一条钉的是"文本是用户资产"那组承诺：
//   ① 解析对**内容**永不抛（坏行进 warnings），只对**上限**抛（超限明确报错，不静默截断）；
//   ② 写盘前有 .backup（只在原文件存在时才有，不凭空造备份）；
//   ③ 手改文件不重启即生效（路由每请求重读，不做进程内缓存）；
//   ④ 改名/删除连带附属文件一起走，不留孤儿；删掉 sidecar 必须无害。
// 离线纪律：不碰网络；数据目录用 mkdtemp 的临时目录，测完即删。
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, writeFile, rm, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { listenAndReady } from './check-ready.mjs';

const SCRIPTS = dirname(fileURLToPath(import.meta.url));
const readScript = (name) => readFile(path.join(SCRIPTS, name), 'utf8');
const read = (relative) => readFile(new URL(`../${relative}`, import.meta.url), 'utf8');

const playlists = await import('./playlists.mjs');
const { parsePlaylistText, serializePlaylist, serializeEntry, slugOf, nameOf, PlaylistStore, MAX_PLAYLIST_LINES, MAX_PLAYLIST_CHARS, MAX_PLAYLISTS } = playlists;

// ── F2（2026-10-06）：搜索结果直接加进歌单 ⇒ 条目自带在线身份 ──────────────────

test('第 4 段是在线条目身份：netease 三段、QQ 四段（还要 mediaMid 才解得出流）', () => {
  const got = parsePlaylistText([
    '恋人 - 李荣浩 | 黑马 | 4:36 | on:netease:27699577',
    '不将就 - 李荣浩 | on:qq:003OUlho2HcRKK:60054250423',
  ].join('\n'));
  assert.equal(got.warnings.length, 0, '两种合法写法都不该报坏行');
  assert.deepEqual(got.items[0].online, { provider: 'netease', mediaId: '27699577' });
  assert.equal(got.items[0].durationMs, 276000, '第 4 段不许把时长挤掉');
  assert.deepEqual(got.items[1].online, { provider: 'qq', mediaId: '003OUlho2HcRKK', mediaMid: '60054250423' });
  assert.equal(got.items[1].album, undefined, 'QQ 那行没写专辑就是没有，不能把 on: 当成专辑');
});

test('在线身份那段不认识要报出来，不能悄悄当成专辑名或时长', () => {
  const got = parsePlaylistText('恋人 - 李荣浩 | 黑马 | 4:36 | 网易云:27699577');
  assert.equal(got.items.length, 0, '没有 on: 前缀又超出"专辑、时长"两段 ⇒ 报段数，不猜它是身份');
  assert.match(got.warnings[0].reason, /竖线段数超出格式/);
  const bad = parsePlaylistText('恋人 - 李荣浩 | 黑马 | 4:36 | on:netease:27699577 | on:qq:1');
  assert.equal(bad.items.length, 0);
  assert.match(bad.warnings[0].reason, /在线身份那段不认识/, '一条里出现两段身份 ⇒ 报，不挑一段用');
  const half = parsePlaylistText('恋人 - 李荣浩 | on:netease');
  assert.match(half.warnings[0].reason, /在线身份那段不认识/, '少一段也算不认识，不许当专辑名');
});

test('条目行往返保真：解析 → 序列化 → 再解析，在线身份与时长逐字段相同', () => {
  const source = ['[album] 黑马', '# 用户自己的注释：这张是手抄的', '恋人 - 李荣浩 | 黑马 | 4:36 | on:netease:27699577', '喜剧之王 - 李荣浩'].join('\n');
  const first = parsePlaylistText(source);
  const again = parsePlaylistText(serializePlaylist({ name: '黑马', items: first.items }));
  assert.deepEqual(again.items, first.items, '往返必须幂等');
  assert.deepEqual(again.warnings, [], '自己写出去的行自己必须读得回来');
});

test('追加条目：原文件逐字节保留（注释与专辑头都在），只在末尾加行；无尾换行不黏行', () => {
  const original = '# Rhine 歌单 v1\n# name: 我的单\n# 这行注释是用户自己写的\n[album] 黑马\n恋人 - 李荣浩';
  const appended = playlists.appendEntriesToText(original, [
    { title: '不将就', artist: '李荣浩', album: '有理想', durationMs: 267000, online: { provider: 'netease', mediaId: '400679625' } },
  ]);
  assert.ok(appended.startsWith(original), '前缀逐字节不变——重写整份文件会把用户的注释与分组抹掉');
  assert.equal(appended, `${original}\n不将就 - 李荣浩 | 有理想 | 4:27 | on:netease:400679625\n`, '原文件缺尾换行时先补一个，别和最后一行黏起来');
  assert.equal(parsePlaylistText(appended).items.length, 2);
});

test('追加也要守上限：超限抛并说清当前条数，不静默截断', () => {
  const huge = Array.from({ length: MAX_PLAYLIST_LINES }, (_, i) => `曲${i} - 某人`).join('\n');
  assert.throws(() => playlists.appendEntriesToText(huge, [{ title: '再加一条', artist: '某人' }]), /行数超过上限/);
  assert.throws(() => playlists.appendEntriesToText('', []), /没有要加入的条目/);
});

// ──  格式 ───────────────────────────────────────────────────────────────────

test('文本解析：基本形、专辑头、时长、曲名含连字符、坏行留痕', () => {
  const got = parsePlaylistText(['[album] 黑马', '恋人 - 李荣浩',
    'さよなら夏の日 - 山下達郎 | COME ALONG 3 | 4:27', 'Bad - Guy - 某人', '# 注释', '', '没有分隔符'].join('\n'));
  // 计划里这一段自相矛盾：格式规则写"分隔符是**第一个** ' - '"，但它给的断言期望标题是 'Bad - Guy'
  // （那是按最后一个切）。按规则走 ⇒ 标题 'Bad'、歌手 'Guy - 某人'；曲名真含 " - " 的歌
  // 规则里已经给了出路（改用 en dash 或用 JSON 形）。
  assert.deepEqual(got.items.map((i) => i.title), ['恋人', 'さよなら夏の日', 'Bad']);
  assert.equal(got.items[0].album, '黑马', '专辑头作用于其后的条目');
  assert.equal(got.items[1].album, 'COME ALONG 3', '行内竖线覆盖专辑头');
  assert.equal(got.items[1].durationMs, 267000, '4:27 → 267000ms');
  assert.equal(got.items[2].artist, 'Guy - 某人', '只按第一个 " - " 切');
  assert.deepEqual(got.warnings, [{ line: 7, reason: '缺少 " - " 分隔符' }], '坏行留痕而不是抛，也不静默丢');
});

test('专辑头的作用域到下一个头为止；空头清除它（不是"沿用上一张"）', () => {
  const got = parsePlaylistText(['A - 甲', '[album] 第一张', 'B - 乙', '[album] 第二张', 'C - 丙', '[album]', 'D - 丁'].join('\n'));
  assert.deepEqual(got.items.map((i) => i.album), [undefined, '第一张', '第二张', undefined]);
});

test('CRLF、BOM、行尾空白、全角竖线都不该改变结果（用户会在别的编辑器里改这个文件）', () => {
  const plain = parsePlaylistText('恋人 - 李荣浩 | 黑马 | 4:36');
  const messy = parsePlaylistText('﻿恋人 - 李荣浩 | 黑马 | 4:36   \r\n');
  assert.deepEqual(messy.items, plain.items);
  assert.equal(messy.items[0].durationMs, 276000);
});

test('时长不认识时留痕而不是丢条目，也不给一个假的 0', () => {
  const got = parsePlaylistText('恋人 - 李荣浩 | 黑马 | 四分半');
  assert.deepEqual(got.items, []);
  assert.match(got.warnings[0].reason, /时长格式不认识/);
  const noSeconds = parsePlaylistText('恋人 - 李荣浩 | 黑马 | 4:75');
  assert.match(noSeconds.warnings[0].reason, /时长格式不认识/, '秒数越界同样算不认识');
});

test('JSON 形是同一实体的另一种载体：首字符 { 或 [ 自动识别，字段与文本形对齐', () => {
  const got = parsePlaylistText(JSON.stringify({ version: 1, name: '黑马', items: [{ title: '恋人', artist: '李荣浩', album: '黑马', durationMs: 276000 }] }));
  assert.equal(got.items.length, 1);
  assert.deepEqual({ ...got.items[0] }, { title: '恋人', artist: '李荣浩', album: '黑马', durationMs: 276000 });
  assert.equal(got.name, '黑马');
  const bare = parsePlaylistText(JSON.stringify([{ title: 'A', artist: 'B' }]));
  assert.equal(bare.items.length, 1, '裸数组也认');
  const broken = parsePlaylistText('{ "version": 1, ');
  assert.equal(broken.items.length, 0);
  assert.match(broken.warnings[0].reason, /JSON 解析失败/, '坏 JSON 是坏行，不是崩');
});

test('导入导出可逆（序列化再解析必须得到同一张表）', () => {
  const text = '[album] X\nA - B | X | 3:04\nC - D\n';
  assert.deepEqual(parsePlaylistText(serializePlaylist(parsePlaylistText(text))).items, parsePlaylistText(text).items);
  const withName = parsePlaylistText('# name: 我的单子\n[album] Y\nE - F\n');
  const again = parsePlaylistText(serializePlaylist(withName));
  assert.equal(again.name, '我的单子', '名字也要可逆（它落在 # name: 头注释里）');
  assert.deepEqual(again.items, withName.items);
});

test('上限是拒绝而不是截断：超限必须报错并说明是哪一条', () => {
  assert.throws(() => parsePlaylistText(Array.from({ length: MAX_PLAYLIST_LINES + 1 }, (unused, i) => `t${i} - a`).join('\n')), /行数超过上限/);
  assert.throws(() => parsePlaylistText(`${'x'.repeat(MAX_PLAYLIST_CHARS + 60)} - y`), /超过 240 字符/);
  assert.equal(MAX_PLAYLIST_LINES, 2000);
  assert.equal(MAX_PLAYLIST_CHARS, 240);
  assert.equal(MAX_PLAYLISTS, 200);
});

test('slug 把关：中日文字符与短横线放行，路径分隔符、点、空串一律拒绝', () => {
  assert.equal(slugOf('黑马'), '黑马');
  assert.equal(slugOf('My-Mix-2026'), 'My-Mix-2026');
  assert.throws(() => slugOf('My Mix'), /歌单名不合法/, '空格不在 slug 允许集里（它是文件名，不是显示名）');
  for (const bad of ['../../etc/passwd', 'a/b', 'a\\b', '.', '', '   ', 'x'.repeat(41), '带 空格', '带?号']) {
    assert.throws(() => slugOf(bad), /歌单名不合法/, JSON.stringify(bad));
  }
  assert.equal(nameOf('# name: 恋人\nA - B\n', 'fallback'), '恋人');
  assert.equal(nameOf('A - B\n', 'fallback'), 'fallback', '没有头注释就回落文件名');
});

// ──  磁盘实体 ───────────────────────────────────────────────────────────────

async function withStore(run) {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'rhine-playlists-'));
  const store = await new PlaylistStore({ dataDir }).init();
  try { return await run(store, dataDir) } finally { await rm(dataDir, { recursive: true, force: true }) }
}

test('写入 → 读回：文件名固定 <slug>.playlist.txt，sidecar 是同目录同基名的固定后缀（关联确定）', async () => {
  await withStore(async (store, dataDir) => {
    const saved = await store.write('黑马', '# name: 黑马\n恋人 - 李荣浩\n');
    assert.equal(saved.id, '黑马');
    assert.equal(saved.items.length, 1);
    assert.equal(saved.name, '黑马');
    assert.equal(store.fileOf('黑马'), path.join(dataDir, 'playlists', '黑马.playlist.txt'));
    assert.equal(store.matchFileOf('黑马'), path.join(dataDir, 'playlists', '黑马.matches.json'),
      'sidecar 与歌单同目录同基名固定后缀：纯函数算得出，无索引无查表（用户硬要求）');
    assert.ok(existsSync(store.fileOf('黑马')));
    assert.equal((await readFile(store.fileOf('黑马'), 'utf8')).trim(), '# name: 黑马\n恋人 - 李荣浩'.trim());
  });
});

test('覆盖写之前先留 .backup；新建时不凭空造备份', async () => {
  await withStore(async (store) => {
    await store.write('单子', 'A - 甲\n');
    assert.equal(existsSync(`${store.fileOf('单子')}.backup`), false, '第一次写没有旧内容可备份');
    await store.write('单子', 'A - 甲\nB - 乙\n');
    assert.equal(existsSync(`${store.fileOf('单子')}.backup`), true, '第二次写必须先把上一版复制成 .backup');
    assert.equal((await readFile(`${store.fileOf('单子')}.backup`, 'utf8')).trim(), 'A - 甲');
  });
});

test('手改文件不重启即生效：get/list 每请求重读，不留进程内缓存', async () => {
  await withStore(async (store, dataDir) => {
    await store.write('单子', 'A - 甲\n');
    assert.equal((await store.get('单子')).items.length, 1);
    await writeFile(store.fileOf('单子'), 'A - 甲\nB - 乙\nC - 丙\n', 'utf8');
    const reread = await store.get('单子');
    assert.equal(reread.items.length, 3, '外部编辑器改完，下一次读就该看到（与 reloadRules 同一口径）');
    assert.equal((await store.list()).find((entry) => entry.id === '单子').items, 3);
  });
});

test('list 只认歌单文件：.backup 与 .matches.json 是附属文件，不得被当成歌单', async () => {
  await withStore(async (store) => {
    await store.write('甲单', 'A - 甲\n');
    await store.write('甲单', 'A - 甲\nB - 乙\n');
    await writeFile(store.matchFileOf('甲单'), '{"version":1}', 'utf8');
    await writeFile(path.join(path.dirname(store.fileOf('甲单')), 'README.md'), '不是歌单', 'utf8');
    const listed = await store.list();
    assert.deepEqual(listed.map((entry) => entry.id), ['甲单'], `实际：${JSON.stringify(listed)}`);
    assert.deepEqual(Object.keys(listed[0]).sort(), ['id', 'items', 'name', 'updatedAt', 'warnings']);
  });
});

test('改名连带 sidecar 与备份一起走，不留孤儿（R76 的配套要求）', async () => {
  await withStore(async (store) => {
    await store.write('旧名', 'A - 甲\n');
    await store.write('旧名', 'A - 甲\nB - 乙\n');                       // 造出 .backup
    await writeFile(store.matchFileOf('旧名'), '{"version":1,"entries":{}}', 'utf8'); // 造出 sidecar
    const renamed = await store.rename('旧名', '新名');
    assert.equal(renamed.id, '新名');
    assert.equal(existsSync(store.fileOf('旧名')), false, '旧文件必须不在');
    assert.equal(existsSync(`${store.fileOf('旧名')}.backup`), false, '旧备份必须跟着走');
    assert.equal(existsSync(store.matchFileOf('旧名')), false, '旧 sidecar 必须跟着走（留着就是孤儿）');
    assert.equal(existsSync(store.matchFileOf('新名')), true, 'sidecar 到了新名下 ⇒ 缓存不丢');
    assert.deepEqual((await store.list()).map((entry) => entry.id), ['新名']);
  });
});

test('删除清三件套；只删 sidecar 必须无害（可逐条重建）', async () => {
  await withStore(async (store) => {
    await store.write('要删的', 'A - 甲\n');
    await writeFile(store.matchFileOf('要删的'), '{"version":1}', 'utf8');
    await store.remove('要删的');
    assert.equal(await store.get('要删的'), null);
    assert.deepEqual(await store.list(), []);
    for (const suffix of ['.playlist.txt', '.playlist.txt.backup', '.matches.json']) {
      assert.equal(existsSync(path.join(path.dirname(store.fileOf('要删的')), `要删的${suffix}`)), false, `残留 ${suffix}`);
    }
    // sidecar 无害：删掉它，歌单照常读，且 matchFileOf 仍可写回
    await store.write('留着', 'B - 乙\n');
    await writeFile(store.matchFileOf('留着'), '{"version":1}', 'utf8');
    await rm(store.matchFileOf('留着'), { force: true });
    const still = await store.get('留着');
    assert.equal(still.items.length, 1, '删了 sidecar 歌单还在、条目还在');
  });
});

test('读一张坏文件不许抛：坏行进 warnings，条目照常给', async () => {
  await withStore(async (store) => {
    await writeFile(store.fileOf('混合'), 'A - 甲\n没有分隔符的一行\nB - 乙\n', 'utf8');
    const got = await store.get('混合');
    assert.equal(got.items.length, 2);
    assert.equal(got.warnings.length, 1);
    assert.equal(got.warnings[0].line, 2);
  });
});

test('歌单张数上限：到 200 张之后再建必须被拒（不静默丢弃）', async () => {
  await withStore(async (store) => {
    for (let index = 0; index < MAX_PLAYLISTS; index += 1) await store.write(`单${index}`, 'A - 甲\n');
    await assert.rejects(() => store.write('第201张', 'A - 甲\n'), /最多 200 张/);
    assert.equal((await store.list()).length, MAX_PLAYLISTS);
  });
});

// ── ③ 路由 ───────────────────────────────────────────────────────────────────

test('路由：create/update/rename/delete 走得通，坏行过半拒写并回显清单', async () => {
  const route = await routeServer();
  let response = await fetch(`${route.origin}/api/playlists`);
  assert.equal(response.status, 200);
  assert.deepEqual((await response.json()).playlists, []);

  const created = await post(route.origin, { action: 'create', name: '黑马', text: '# name: 黑马\n恋人 - 李荣浩\n' });
  assert.equal(created.status, 200);
  const body = await created.json();
  assert.equal(body.playlist.id, '黑马');
  assert.equal(body.playlist.items.length, 1);

  const updated = await post(route.origin, { action: 'update', id: '黑马', text: '恋人 - 李荣浩\n不将就 - 李荣浩\n' });
  assert.equal((await updated.json()).playlist.items.length, 2);
  assert.equal(existsSync(path.join(route.dataDir, 'playlists', '黑马.playlist.txt.backup')), true, '经路由的覆盖写也要有 .backup');

  // 一半以上是坏行 ⇒ 多半是格式理解错了，不该悄悄收下
  const mostlyBad = await post(route.origin, { action: 'update', id: '黑马', text: '好的一行 - 有歌手\n坏行一\n坏行二\n坏行三\n' });
  assert.equal(mostlyBad.status, 400);
  const rejected = await mostlyBad.json();
  assert.match(rejected.error, /没被读懂.*拒绝写入/, '拒绝理由要说清"为什么"和"没写进去"');
  assert.equal(rejected.warnings.length, 3, '回显坏行清单，用户才知道改哪里');
  assert.equal((await (await fetch(`${route.origin}/api/playlists/黑马`)).json()).playlist.items.length, 2, '被拒的写没有落盘');

  const renamed = await post(route.origin, { action: 'rename', id: '黑马', name: '纵横四海' });
  assert.equal((await renamed.json()).playlist.id, '纵横四海');
  const removed = await post(route.origin, { action: 'delete', id: '纵横四海' });
  assert.equal((await removed.json()).playlists.length, 0);
  await route.close();
});

test('路由把关：非法 id、未知 action、缺 text、路径穿越都在碰到磁盘之前被拒', async () => {
  const route = await routeServer();
  for (const [label, payload, code] of [
    ['未知 action', { action: 'drop' }, 400],
    ['缺 action', {}, 400],
    ['create 缺 text', { action: 'create', name: 'x' }, 400],
    ['create 名字非法', { action: 'create', name: '../../etc/passwd', text: 'A - B' }, 400],
    ['update 缺 id', { action: 'update', text: 'A - B' }, 400],
  ]) {
    const response = await post(route.origin, payload);
    assert.equal(response.status, code, label);
    await response.text();
  }
  const listing = await (await fetch(`${route.origin}/api/playlists`)).json();
  assert.deepEqual(listing.playlists, [], '以上任何一条都不该留下文件');
  assert.equal(existsSync(path.join(route.dataDir, 'playlists')), true, '目录本身在 init 时建好');
  const traversal = await fetch(`${route.origin}/api/playlists/${encodeURIComponent('../../config')}`);
  assert.ok([400, 404].includes(traversal.status), '路径穿越形式的 id 必须被拒');
  await traversal.text();
  await route.close();
});

test('GET /api/playlists/:id 读单张；不存在给 404 而不是空表', async () => {
  const route = await routeServer();
  await post(route.origin, { action: 'create', name: '有的一张', text: 'A - 甲\n' });
  const found = await fetch(`${route.origin}/api/playlists/有的一张`);
  assert.equal(found.status, 200);
  assert.equal((await found.json()).playlist.items.length, 1);
  const missing = await fetch(`${route.origin}/api/playlists/没有的一张`);
  assert.equal(missing.status, 404);
  await missing.text();
  await route.close();
});

test('R74 写盘白名单：歌单只写 dataDir/playlists，且音频类后缀永不出现', async () => {
  const source = await readScript('playlists.mjs');
  assert.match(source, /playlists/, '实体目录就叫 playlists');
  for (const banned of ['.mp3', '.flac', '.m4a', 'artwork']) {
    assert.ok(!source.includes(banned), `歌单模块不该碰 ${banned}`);
  }
  assert.match(source, /mode: 0o600|0o600/, '写盘权限位沿用 writeJsonAtomic 那一档');
  assert.match(source, /rename\(/, '原子写走 tmp + rename');
});

// ── F2 路由：把搜索结果加进歌单 ───────────────────────────────────────────────

test('路由 add：往既有歌单末尾追加带身份的条目，用户的注释与分组一个字都不动', async () => {
  const route = await routeServer();
  const created = await post(route.origin, { action: 'create', name: '搜索收集', text: '# Rhine 歌单 v1\n# name: 搜索收集\n# 这行是我自己写的备注\n恋人 - 李荣浩\n' });
  assert.equal(created.status, 200);

  const added = await post(route.origin, { action: 'add', id: '搜索收集', items: [
    { title: '不将就', artist: '李荣浩', album: '有理想', durationMs: 267000, audioUrl: '/api/online/stream?p=netease&id=400679625' },
    { title: '某首', artist: '某人', audioUrl: '/api/online/stream?p=qq&id=003OUlho&mm=60054250' },
  ] });
  assert.equal(added.status, 200);
  const body = await added.json();
  assert.equal(body.added, 2);
  assert.equal(body.playlist.items.length, 3);
  assert.deepEqual(body.playlist.items[1].online, { provider: 'netease', mediaId: '400679625' });
  assert.deepEqual(body.playlist.items[2].online, { provider: 'qq', mediaId: '003OUlho', mediaMid: '60054250' }, 'QQ 的第二段文件名从 mm 参数里反解回来');
  assert.ok(body.playlist.text.startsWith('# Rhine 歌单 v1\n# name: 搜索收集\n# 这行是我自己写的备注\n恋人 - 李荣浩\n'), '追加不许整份重写：备注行是用户的');
  assert.match(body.playlist.text, /不将就 - 李荣浩 \| 有理想 \| 4:27 \| on:netease:400679625/);
  await route.close();
});

test('路由 add：不是我们签发的那个地址 ⇒ 当普通条目收下，不凭一句 URL 就写进身份段', async () => {
  const route = await routeServer();
  await post(route.origin, { action: 'create', name: 't', text: 'x - y\n' });
  const got = await post(route.origin, { action: 'add', id: 't', items: [
    { title: '外来地址', artist: '某人', audioUrl: 'https://music.example.com/stream?p=netease&id=1' },
    { title: '假身份', artist: '某人', audioUrl: '/api/online/stream?p=kugou2&id=1' },
    { title: '没有地址', artist: '某人' },
  ] });
  const body = await got.json();
  for (const item of body.playlist.items.slice(1)) assert.equal(item.online, undefined, `${item.title} 不该带身份`);
  assert.match(body.playlist.text, /外来地址 - 某人\n假身份 - 某人\n没有地址 - 某人\n/);
  await route.close();
});

test('路由 add：没有 id 就是"新建一张并加入"；重名 409；不存在的单 404；空条目 400', async () => {
  const route = await routeServer();
  const fresh = await post(route.origin, { action: 'add', name: '新建即含', items: [
    { title: '恋人', artist: '李荣浩', album: '黑马', durationMs: 276000, audioUrl: '/api/online/stream?p=netease&id=27699577' },
  ] });
  assert.equal(fresh.status, 200);
  const made = await fresh.json();
  assert.equal(made.playlist.name, '新建即含');
  assert.equal(made.playlist.items[0].online.mediaId, '27699577');
  assert.match(made.playlist.text, /^# Rhine 歌单 v1\n# name: 新建即含\n恋人 - 李荣浩 \| 黑马 \| 4:36 \| on:netease:27699577\n$/);

  assert.equal((await post(route.origin, { action: 'add', name: '新建即含', items: [{ title: 'a', artist: 'b' }] })).status, 409);
  assert.equal((await post(route.origin, { action: 'add', id: '没有这张', items: [{ title: 'a', artist: 'b' }] })).status, 404);
  const empty = await post(route.origin, { action: 'add', id: '新建即含', items: [] });
  assert.equal(empty.status, 400);
  assert.match((await empty.json()).error, /没有要加入的条目/);
  const noSinger = await post(route.origin, { action: 'add', id: '新建即含', items: [{ title: '只有歌名' }] });
  assert.equal(noSinger.status, 400);
  assert.match((await noSinger.json()).error, /缺少歌名或歌手/);
  await route.close();
});

// ── F3（2026-10-06）：歌单目录用户可指定 ──────────────────────────────────────

test('resolvePlaylistDir：留空回默认；相对路径、盘根、超长都拒并说清为什么', () => {
  const dataDir = 'D:/data';
  assert.equal(playlists.resolvePlaylistDir(null, dataDir), null);
  assert.equal(playlists.resolvePlaylistDir('', dataDir), null);
  assert.equal(playlists.resolvePlaylistDir('default', dataDir), null, '显式写 default 也是回默认');
  assert.equal(playlists.resolvePlaylistDir(path.join(dataDir, 'playlists'), dataDir), null, '填回默认值不该把默认路径固化成配置');
  assert.equal(playlists.resolvePlaylistDir('D:/音乐/歌单/', dataDir), path.resolve('D:/音乐/歌单'), '尾部分隔符要归一掉');
  assert.throws(() => playlists.resolvePlaylistDir('音乐/歌单', dataDir), /绝对路径/, '相对路径会随工作目录漂，必须拒');
  assert.throws(() => playlists.resolvePlaylistDir('D:/', dataDir), /盘根|文件系统根/);
  assert.throws(() => playlists.resolvePlaylistDir('/', dataDir), /盘根|文件系统根/);
  assert.throws(() => playlists.resolvePlaylistDir('x'.repeat(300), dataDir), /过长/);
  assert.throws(() => playlists.resolvePlaylistDir('D:/a<b>c', dataDir), /不能用于路径的字符/);
});

test('指定目录后：歌单与同名 sidecar 都落在那里，关联仍是"同目录同基名固定后缀"', async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'rhine-pldir-'));
  const chosen = path.join(dataDir, '我的歌单夹');
  try {
    const store = await new PlaylistStore({ dataDir, dir: chosen }).init();
    await store.write('黑马', '恋人 - 李荣浩\n');
    assert.equal(store.fileOf('黑马').startsWith(chosen), true, '文件要在用户选的那个目录里');
    assert.equal(path.basename(store.matchFileOf('黑马')), '黑马.matches.json', 'sidecar 与歌单同目录同基名');
    assert.equal(existsSync(path.join(dataDir, 'playlists', '黑马.playlist.txt')), false, '切了目录就不该再往默认处写一份');
    const listed = await store.list();
    assert.deepEqual(listed.map((p) => p.id), ['黑马'], '列表读的是当前目录');
  } finally { await rm(dataDir, { recursive: true, force: true }) }
});

test('换目录是复制：新目录拿到歌单与缓存，老目录原件一个字不动，同名不覆盖', async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'rhine-plmove-'));
  try {
    const store = await new PlaylistStore({ dataDir }).init();
    await store.write('黑马', '恋人 - 李荣浩\n');
    await writeFile(store.matchFileOf('黑马'), '{"version":1}', 'utf8');
    await writeFile(path.join(store.dir, '无关文件.txt'), '不该被搬走', 'utf8');
    const before = await readFile(store.fileOf('黑马'), 'utf8');
    const target = path.join(dataDir, '新夹');
    store.useDir(target);
    const report = await store.copyEntriesFrom(path.join(dataDir, 'playlists'));
    assert.equal(report.copied, 2, '歌单与 sidecar 各一份');
    assert.equal(report.skipped, 0);
    assert.equal(await readFile(store.fileOf('黑马'), 'utf8'), before, '复制过来的内容要逐字节相同');
    assert.equal(existsSync(path.join(dataDir, 'playlists', '黑马.playlist.txt')), true, '老目录的原件必须还在——移动等于拿用户的资产去赌');
    assert.equal(existsSync(path.join(target, '无关文件.txt')), false, '非歌单文件不跟着搬');
    const again = await store.copyEntriesFrom(path.join(dataDir, 'playlists'));
    assert.deepEqual({ copied: again.copied, skipped: again.skipped }, { copied: 0, skipped: 2 }, '再点一次不覆盖也不重复复制');
    assert.deepEqual((await store.list()).map((p) => p.id), ['黑马']);
  } finally { await rm(dataDir, { recursive: true, force: true }) }
});

test('路由：改目录 200 并回报复制数；非法路径 400 且带人话；清空回默认', async () => {
  const route = await routeServer();
  await post(route.origin, { action: 'create', name: '黑马', text: '恋人 - 李荣浩\n' });
  const target = path.join(route.dataDir, '用户选的夹');
  const response = await fetch(`${route.origin}/api/config`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ playlistDir: target }),
  });
  assert.equal(response.status, 200);
  const saved = await response.json();
  assert.equal(saved.playlistDir, path.resolve(target), '响应给的是当前真正在用的目录，不是配置里那一项');
  assert.deepEqual(saved.playlistMove && { copied: saved.playlistMove.copied, skipped: saved.playlistMove.skipped }, { copied: 1, skipped: 0 });
  assert.equal(existsSync(path.join(route.dataDir, 'playlists', '黑马.playlist.txt')), true, '老目录保留原件');
  const listed = await (await fetch(`${route.origin}/api/playlists`)).json();
  assert.deepEqual(listed.playlists.map((p) => p.id), ['黑马'], '列的是新目录里的单');
  assert.equal((await (await fetch(`${route.origin}/api/playlists/黑马`)).json()).playlist.text.includes('恋人 - 李荣浩'), true);

  const bad = await fetch(`${route.origin}/api/config`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ playlistDir: '相对的/路' }),
  });
  assert.equal(bad.status, 400);
  assert.match((await bad.json()).error, /绝对路径/);
  const root = await fetch(`${route.origin}/api/config`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ playlistDir: process.platform === 'win32' ? 'C:\\' : '/' }),
  });
  assert.equal(root.status, 400, '盘根不该被接受');

  const back = await fetch(`${route.origin}/api/config`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ playlistDir: '' }),
  });
  const restored = await back.json();
  assert.equal(restored.playlistDir, path.join(route.dataDir, 'playlists'), '清空就是回默认');
  await route.close();
});

test('重启后仍认这个目录：配置里的 playlistDir 由 init 应用，不靠进程内记忆', async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'rhine-pldir-restart-'));
  try {
    const target = path.join(dataDir, '夹');
    const first = await new (await import('./music-library.mjs')).MusicLibraryStore({ dataDir, defaultRoots: [] }).init();
    await first.updateConfig({ playlistDir: target });
    await first.playlists.write('重启还在', '恋人 - 李荣浩\n');
    const second = await new (await import('./music-library.mjs')).MusicLibraryStore({ dataDir, defaultRoots: [] }).init();
    assert.equal(second.playlists.dir, path.resolve(target), '第二次启动要读回用户选的目录');
    assert.deepEqual((await second.playlists.list()).map((p) => p.id), ['重启还在']);
    assert.equal(second.snapshot().playlistDir, path.resolve(target), '面板显示的当前目录也来自这里');
  } finally { await rm(dataDir, { recursive: true, force: true }) }
});

// ── ⑩ 粘贴导入（Task 10）─────────────────────────────────────────────────────

const { parseImportInput, importSlug, createPlaylistImporter } = await import('./playlist-import.mjs');

/**
 * 桥的假歌单通道。形状逐字照 2026-10-05 桥内实测（`t10-shape.mjs`）：
 * detail 给 `playlist.trackCount`，tracks 给 `{songs:[{id,mainTitle,ar[].name,al.name,dt}]}`（原始 API 形状）。
 * R226 加一档 `withCover`：按 2026-10-15 那张 289 行真实单的实测形状带上 `al.picUrl`
 * （上游给的就是 https，主机 `p3`/`p4.music.126.net`），并且**只给偶数行**——
 * 缺图的那一行是判据要的对照样本（"上游没给 ⇒ 空串、不硬造"），不是夹具偷懒。
 */
function fakeBridge({ trackCount = 173, failAt, withCover = false } = {}) {
  const calls = [];
  return {
    calls,
    call: async (route, payload) => {
      calls.push(payload);
      if (failAt === payload.action) return { ok: false, reason: '网易后端未就绪' };
      if (payload.action === 'detail') {
        return { ok: true, provider: 'netease', id: payload.id, name: 'KPOP宝藏节奏合集 | 洗澡/跑步BGM', trackCount, coverUrl: '' };
      }
      const offset = payload.offset ?? 0;
      const limit = payload.limit ?? 500;
      const n = Math.max(0, Math.min(limit, trackCount - offset));
      const { ncmSongsToItems } = await import('./bridge/providers/playlist.mjs');
      return {
        ok: true, provider: 'netease', action: 'tracks', offset, limit,
        items: ncmSongsToItems(Array.from({ length: n }, (unused, index) => ({
          id: 28196629 + offset + index, name: `曲目 ${offset + index}`,
          ar: [{ name: 'AOA' }],
          al: { name: '짧은 치마',
            ...(withCover && (offset + index) % 2 === 0 ? { picUrl: `http://p3.music.126.net/k${offset + index}/2819662${offset + index}.jpg` } : {}) },
          dt: 179807, fee: 0, pop: 9,
        }))),
      };
    },
  };
}

test('粘贴导入三认：链接 / 纯 id / 文本清单；认不出来的给可读结论而不是抛', async () => {
  const { ncmSongsToItems } = await import('./bridge/providers/playlist.mjs');
  assert.equal(parseImportInput('https://music.163.com/playlist?id=12345678').kind, 'netease-id');
  assert.equal(parseImportInput('12345678').kind, 'netease-id');
  assert.equal(parseImportInput('  12345678  ').id, '12345678', '首尾空白不算内容');
  assert.equal(parseImportInput('https://music.163.com/#/playlist?id=99887766&si=abc').id, '99887766', '分享链接带 # 与 si 尾巴');
  assert.equal(parseImportInput('https://music.163.com/playlist/99887766').id, '99887766', '路径形也认');
  const asText = parseImportInput('恋人 - 李荣浩\n黑马 - 李荣浩');
  assert.equal(asText.kind, 'text');
  assert.equal(asText.parsed.items.length, 2);
  assert.equal(parseImportInput('').kind, 'empty');
  assert.equal(parseImportInput('   ').kind, 'empty');
  assert.equal(parseImportInput('一整行都没有分隔符').kind, 'unknown');
  // 不是网易的链接不许被当成网易 id 去拉（否则等于给了一个"输入 URL 让别人去取"的口子）
  assert.equal(parseImportInput('https://example.com/playlist?id=12345').kind, 'unknown');
  // 映射器：原始 API 形状（ar/al/dt）与 PC 形状都要认，且只出契约字段
  // R226：行里多了一格 `coverRef`（一手实测：网易 `/playlist/track/all` 每行都带 `al.picUrl`，且给的就是 https）。
  // 这条"只出契约字段"的判据本来就在逐字钉键集合 ⇒ 新增这一格必须被它咬住（形状变了、要求一点没松）。
  const raw = ncmSongsToItems([{ id: 1, name: 'x', ar: [{ name: 'A' }], al: { name: 'AL', picUrl: 'http://p3.music.126.net/k/1.jpg' }, dt: 1000, fee: 1, pop: 9 }]);
  assert.deepEqual(Object.keys(raw[0]).sort(), ['album', 'artist', 'coverRef', 'durationMs', 'mediaId', 'provider', 'quality', 'title']);
  assert.equal(raw[0].artist, 'A');
  assert.equal(raw[0].durationMs, 1000, '网易 `dt` 是毫秒，不要再乘 1000');
  assert.equal(raw[0].coverRef, 'https://p3.music.126.net/k/1.jpg', '上游给 http ⇒ 升 https 才收（与搜索侧同一条老规矩、同一道闸，不在这里抄第二份）');
  assert.equal(ncmSongsToItems([{ id: 2, name: 'y', ar: [{ name: 'B' }], al: { name: 'AL' }, dt: 1 }])[0].coverRef, '',
    '这一行上游没给图 ⇒ 空串：宁可不画也不按 id 造一个会 404 的（F3 那条判据）');
  assert.equal(ncmSongsToItems([{ id: 3, name: 'z', ar: [{ name: 'C' }], al: { name: 'AL', picUrl: 'http://evil.example/x.jpg' }, dt: 1 }])[0].coverRef, '',
    '表外主机收不进来 ⇒ 空串（白名单不因为"只是张图"就让路）');
  assert.equal(ncmSongsToItems(undefined), null, '没有 songs 字段是故障，不是空歌单');
});

test('导入落盘成 Task 8 的文本格式，来历写回头注释（用户事后看得出这张单从哪来）', async () => {
  await withStore(async (store) => {
    const svc = createPlaylistImporter({ bridge: fakeBridge({ trackCount: 5 }), store });
    const got = await svc.import({ text: '17429985859' });
    assert.equal(got.ok, true, JSON.stringify(got));
    assert.equal(got.source, 'netease-id');
    assert.equal(got.items, 5);
    const saved = await store.get(got.id);
    assert.match(saved.text, /^# Rhine 歌单 v1\n/, '第一行还是那个格式声明');
    assert.match(saved.text, /# netease-playlist 17429985859 imported \d{4}-\d{2}-\d{2}T/, '来历 + 时间戳');
    assert.match(saved.text, /# name: KPOP/, '名字来自歌单详情');
    assert.equal(saved.items.length, 5, '落盘的文本能被 Task 8 的解析器原样读回');
    assert.equal(saved.items[0].artist, 'AOA');
    assert.equal(saved.items[0].durationMs, 180000,
      '文本形把时长写到"秒"（179807 → 3:00 → 180000）：格式声明就是 m:ss，亚秒位在往返里必然丢。' +
      '打分侧的时长乘子对 1 秒不敏感，所以这是格式的既有精度，不是导入丢数据——不许为了凑这条断言把毫秒塞进文本形');
  });
});

test('截断必须可见：1000 条硬顶是本工具继承的，不是接口给的', async () => {
  await withStore(async (store) => {
    const got = await createPlaylistImporter({ bridge: fakeBridge({ trackCount: 1350 }), store }).import({ text: '17429985859' });
    assert.equal(got.truncated, true);
    assert.equal(got.items, 1000);
    assert.match(got.warning, /共 1350 条，只导入前 1000 条/);
    const saved = await store.get(got.id);
    assert.match(saved.text, /# truncated 共 1350 条，只导入前 1000 条/, '截断也要写进文件，不然用户以为导全了');
    assert.equal(saved.items.length, 1000);
  });
});

test('分页以 trackCount 为准，不许照"这页拿满了没"猜：恰好等长时那条启发式会误判', async () => {
  await withStore(async (store) => {
    const big = fakeBridge({ trackCount: 1800 });
    assert.equal((await createPlaylistImporter({ bridge: big, store }).import({ text: '1' })).items, 1000);
    assert.deepEqual(big.calls.filter((c) => c.action === 'tracks').map((c) => `${c.offset}/${c.limit}`),
      ['0/500', '500/500'], '按 offset 续拉，到顶就停');
    const small = fakeBridge({ trackCount: 173 });
    const smallGot = await createPlaylistImporter({ bridge: small, store }).import({ text: '2' });
    assert.equal(smallGot.items, 173);
    assert.equal(small.calls.filter((c) => c.action === 'tracks').length, 1, '一页就够时不多问一次（U7 实测的正是这一种）');
    assert.equal(smallGot.truncated, false);
    const exact = fakeBridge({ trackCount: 500 });
    assert.equal((await createPlaylistImporter({ bridge: exact, store }).import({ text: '3' })).items, 500);
    assert.equal(exact.calls.filter((c) => c.action === 'tracks').length, 1, '恰好等长时不该多问那一页');
  });
});

test('导入失败与空歌单：桥坏了给可读原因；0 条是合法导入但要说明', async () => {
  await withStore(async (store) => {
    const down = await createPlaylistImporter({ bridge: fakeBridge({ failAt: 'detail' }), store }).import({ text: '1' });
    assert.equal(down.ok, false);
    assert.match(down.reason, /未就绪/);
    const empty = await createPlaylistImporter({ bridge: fakeBridge({ trackCount: 0 }), store }).import({ text: '1' });
    assert.equal(empty.ok, true, '空歌单是一次合法导入（0 条）');
    assert.equal(empty.items, 0);
    assert.match(empty.warnings[0].reason, /没有可导入的曲目/);
    assert.equal((await store.list()).length, 1, '仍然落成一张文件（用户可以自己往里加）');
  });
});

test('importSlug：网易歌单名里的竖线/斜杠/emoji 都不许变成路径的一部分', () => {
  assert.equal(importSlug('KPOP宝藏节奏合集 | 洗澡/跑步BGM', '17429985859'), 'KPOP宝藏节奏合集-洗澡-跑步BGM');
  assert.equal(importSlug('', '42'), '网易歌单-42');
  assert.equal(importSlug('😀🎉', '42'), '网易歌单-42', '全是非允许字符时回落带 id 的名字');
  assert.ok(importSlug('a'.repeat(80), '42').length <= 40, '超长要截到 slug 的上限内');
  for (const name of ['../../etc/passwd', 'a\\b', 'x/y']) {
    assert.doesNotThrow(() => importSlug(name, '7'), `兜底名必须永远合法：${name}`);
    assert.doesNotMatch(importSlug(name, '7'), /[\\/]/, '结果里不许出现路径分隔符');
  }
});

test('路由：POST /api/online/playlist/import 三认落地、坏输入 400、GET 405、关掉之后 404', async () => {
  const route = await routeServer({ importBridge: fakeBridge({ trackCount: 3 }) });
  const good = await fetch(`${route.origin}/api/online/playlist/import`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text: '恋人 - 李荣浩\n黑马 - 李荣浩\n' }),
  });
  assert.equal(good.status, 200);
  const imported = await good.json();
  assert.equal(imported.source, 'text');
  assert.equal(imported.items, 2);
  assert.equal((await (await fetch(`${route.origin}/api/playlists`)).json()).playlists.length, 1, '导入完就在列表里');

  const viaBridge = await fetch(`${route.origin}/api/online/playlist/import`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text: 'https://music.163.com/playlist?id=17429985859' }),
  });
  const bridged = await viaBridge.json();
  assert.equal(bridged.source, 'netease-id');
  assert.equal(bridged.items, 3);

  const bad = await fetch(`${route.origin}/api/online/playlist/import`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text: '' }),
  });
  assert.equal(bad.status, 400);
  assert.match((await bad.json()).error, /粘贴/);
  const wrongMethod = await fetch(`${route.origin}/api/online/playlist/import`);
  assert.equal(wrongMethod.status, 405);
  await wrongMethod.text();
  await route.close();

  const off = await routeServer({ config: { online: { lyrics: true, search: false, streaming: true, covers: true } } });
  const blocked = await fetch(`${off.origin}/api/online/playlist/import`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text: '1' }),
  });
  assert.equal(blocked.status, 404);
  assert.match((await blocked.json()).error, /已关闭/);
  await off.close();
});

test('不存在的歌单 id：网易直接回 code 404，界面要拿到一句人话而不是内部形状描述', async () => {
  // 实测（`t10-id1.mjs`）：`/playlist/detail?id=999999999999999` → `{"code":404}`，没有 playlist 字段。
  // 顺带记一次自我纠正：先前我以为"id=1 被网易乱回成别人的单"是缺陷并加了 id 回显校验，
  // 复量发现 id=1 是一张真实公开单（userId 1、158 条、subscribedCount 21637）⇒ 那个守卫是基于误诊加的，已撤。
  const { registerPlaylistRoutes } = await import('./bridge/playlist-routes.mjs');
  const routes = new Map();
  registerPlaylistRoutes({
    routes,
    backends: { netease: { state: 'ready', baseUrl: 'http://127.0.0.1:1' } },
    fetchImpl: async () => ({ text: async () => JSON.stringify({ code: 404 }) }),
  });
  const got = await routes.get('/bridge/playlist')({ provider: 'netease', action: 'detail', id: '999999999999999' });
  assert.equal(got.ok, false);
  assert.match(got.reason, /不存在或不公开.*返回 404/, got.reason);
  assert.equal(got.retryable, false, '不存在的单重试也不会出现');
  // 另一条：有 playlist 字段但形状不对（既不是 200 也不是 404）仍走"请求没被正确接受"
  const weird = new Map();
  registerPlaylistRoutes({ routes: weird, backends: { netease: { state: 'ready', baseUrl: 'http://127.0.0.1:1' } } ,
    fetchImpl: async () => ({ text: async () => JSON.stringify({ code: 200, somethingElse: true }) }) });
  assert.match((await weird.get('/bridge/playlist')({ provider: 'netease', action: 'detail', id: '5' })).reason, /playlist 字段/);
});

// ── 夹具 ─────────────────────────────────────────────────────────────────────

const post = async (origin, payload) => fetch(`${origin}/api/playlists`, {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload),
});

async function routeServer({ config, importBridge } = {}) {
  delete process.env.MUSICBRAINZ_CONTACT;
  const { createMusicServer } = await import('./music-server.mjs');
  const { MusicLibraryStore } = await import('./music-library.mjs');
  const { createPlaylistImporter } = await import('./playlist-import.mjs');
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'rhine-playlists-route-'));
  const rootsDir = await mkdtemp(path.join(os.tmpdir(), 'rhine-playlists-roots-'));
  const store = await new MusicLibraryStore({ dataDir, defaultRoots: [rootsDir] }).init();
  if (config) await store.updateConfig({ ...store.config, ...config });
  const bridge = {
    status: () => ({ phase: 'off', port: 0, backends: [], unauthorized: 0, restarts: 0, lastError: null, hosts: [] }),
    call: importBridge ? (route, payload) => importBridge.call(route, payload) : async () => ({ ok: false, reason: '不该被调用' }),
    ensure: async () => {}, shutdown: async () => {},
  };
  const { server } = await createMusicServer({
    store, distDir: SCRIPTS, autoScan: false, bridgeClient: bridge,
    onlineLyricsMatcher: { match: async () => ({ matched: false }), clearCache: () => {} },
    onlineAudioSource: { resolve: async () => ({ ok: false, reason: '未配置' }) },
    onlineStreamFetcher: async () => { throw new Error('不该走到这里') },
    onlineSearcher: { search: async () => { throw new Error('不该走到这里') } },
    playlistImporter: createPlaylistImporter({ bridge, store: store.playlists }),
  });
  // R210：裸 listen(0)+waitListening 升级到 R198 的 listenAndReady（连不上就关掉这台、换端口重听；
  // 只重连不重断言，见 check-ready.mjs 头注）。坏探测时**不许把服务句柄漏在事件循环里** ——
  // 漏了会把"红一条"放大成"段超时 + 链中止"（R209 §五 警告级发现的现场）。
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
    origin, dataDir, store,
    close: async () => {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
      await rm(dataDir, { recursive: true, force: true });
      await rm(rootsDir, { recursive: true, force: true });
    },
  };
}

// ── R210：坏探测不许把服务句柄漏在事件循环里（R209 §五 警告级发现的那条修法）────────────

test('R210 坏探测：连不上时 routeServer 如实抛错，但服务必须已关、两个临时目录必须已清', async () => {
  // 注入 = 把全局 fetch 换成"必败的 connect"：waitListening 走的就是它 ⇒ listenAndReady 三轮重听全失败。
  // 被注入的只有"连接层"那一格；routeServer 的 catch（close + 清目录 + 重抛）是真代码在真跑。
  const realFetch = globalThis.fetch;
  const probed = [];
  globalThis.fetch = async (input) => {
    probed.push(String(input));
    throw new Error('注入的故障：假装这一笔 connect 连不上');
  };
  const tmpBefore = new Set(await readdir(os.tmpdir()));
  let thrown = null;
  try {
    await assert.rejects(routeServer(), (error) => { thrown = error; return /次探测内连不上/.test(error.message); },
      '连不上就如实抛（"红"这件事本身不变，只是不许挂住）');
  } finally {
    globalThis.fetch = realFetch;
  }
  assert.ok(probed.length > 0, `注入必须真经过"等服务起来"这一步（probed=${probed.length}）`);
  // 最后一次探测对着的端口 = 那个还没被关掉的监听者：修好了 ⇒ 已关 ⇒ 连不上；漏了 ⇒ 还在应答（R209 的现场）。
  const lastProbed = probed[probed.length - 1];
  const reachable = await fetch(lastProbed).then(() => true, () => false);
  assert.equal(reachable, false,
    `坏探测之后服务必须已被关闭，但 ${lastProbed} 仍在应答 ⇒ 句柄漏了（文件跑完不退 ⇒ "红一条"被放大成"段超时 + 链中止"）`);
  const leftover = (await readdir(os.tmpdir()))
    .filter((name) => /^rhine-playlists-(route|roots)-/.test(name) && !tmpBefore.has(name));
  assert.deepEqual(leftover, [], `坏探测之后两个临时目录必须已清，但还剩：${leftover.join('、')}`);
  assert.match(thrown?.message ?? '', /连不上/);
});

// ── ⑧（2026-10-07）：文本歌单上专辑架（伪专辑）的架上原料 ─────────────────────

test('⑧ playlistShelfRow：空单也给一行、名字回落 slug、"最主要的音乐人"并列时按首次出现定、拼贴原料最多四条', () => {
  const row = playlists.playlistShelfRow;
  const empty = row({ id: '深夜', name: '   ', items: [], matched: 0, unmatched: 0 });
  assert.equal(empty.name, '深夜', '名字空白时回落到 id：架上那格不能没有标题');
  assert.equal(row({ id: 'My List!!', name: '', items: [], matched: 0, unmatched: 0 }).id, 'My List!!'.slice(0, 40),
    '用户手改出一个不合法的文件名时**不许让整架 500**：兜住 slugOf 的抛，原样带出（界面上那格仍是这张单）');
  assert.deepEqual({ items: empty.items, matched: empty.matched, unmatched: empty.unmatched }, { items: 0, matched: 0, unmatched: 0 });
  assert.deepEqual(empty.coverSeeds, [], '空歌单的拼贴原料是空数组（界面上因此落回通用占位瓦片，不是"画了四格空的"）');
  const entries = (list) => ({ id: 'x', name: 'x', items: list.map((entry) => ({ entry })), matched: 0, unmatched: list.length });
  const tied = row(entries([
    { title: '一', artist: '甲' }, { title: '二', artist: '乙' }, { title: '三', artist: '甲' }, { title: '四', artist: '乙' },
  ]));
  assert.equal(tied.artist, '甲', '并列时按**首次出现**定，不靠 Map 的迭代顺序碰巧：同一输入两次结果必须一致');
  assert.equal(row(entries([{ title: '一', artist: '  甲   乙  '}])).artist, '甲 乙', '歌手名里的多余空白归一，别让"甲"和"甲 "算两个人');
  assert.equal(row(entries([{ title: '一', artist: '' }])).artist, '', '一条歌手名都没有 ⇒ 空串（架上那行显示"未知歌手"），不拿歌单名去冒充歌手');
  assert.equal(row(entries([
    { title: '一', artist: '__proto__' }, { title: '二', artist: '正常' }, { title: '三', artist: '正常' },
  ])).artist, '正常', '有人真把歌手写成 "__proto__" 时计数不许漏进原型（字典是 null 原型的）');
  const six = row(entries(Array.from({ length: 6 }, (_, index) => ({ title: `曲${index}`, artist: '甲', album: '某专' }))));
  assert.equal(six.coverSeeds.length, 4, '拼贴最多四格（2×2）');
  assert.deepEqual(six.coverSeeds[0], { title: '曲0', artist: '甲' });
  assert.equal(six.items, 6, '行数按**全部**成员算，不是按那四格原料算');
  assert.equal(row({ id: 'y', name: 'y', items: 'not an array', matched: 'x', unmatched: null }).matched, 0, '脏输入一律落成 0，不抛也不写 NaN');
});

test('⑧ GET /api/playlists/shelf：每张一行、空单也给、shelf 不被当成歌单 id、整条路零出网', async () => {
  const calls = [];
  const route = await routeServer({
    importBridge: { call: async (route2, payload) => { calls.push([route2, payload]); return { ok: false, reason: '不该被调用' } } },
  });
  await route.store.playlists.write('深夜', '# name: 深夜\nA - 甲\nB - 乙\n');
  await route.store.playlists.write('空的', '# name: 空的\n');
  const got = await fetch(`${route.origin}/api/playlists/shelf`);
  assert.equal(got.status, 200);
  const shelf = await got.json();
  assert.equal(shelf.playlists.length, 2, '每张歌单都给一行（**空的那张也要给**：没有成员不等于这张不存在）');
  const names = shelf.playlists.map((entry) => entry.name).sort();
  assert.deepEqual(names, ['深夜', '空的']);
  const late = shelf.playlists.find((entry) => entry.id === '深夜');
  assert.deepEqual({ items: late.items, unmatched: late.unmatched }, { items: 2, unmatched: 2 }, '没匹配过的条目算未匹配，不算"没有这一条"');
  assert.equal(late.artist, '甲', '架上那行的歌手位来自成员里最主要的音乐人');
  assert.deepEqual(late.coverSeeds.map((seed) => seed.title), ['A', 'B']);
  assert.equal(JSON.stringify(late).includes('http'), false, '架上原料里不许出现任何 URL（可播地址与封面地址都只在点开之后才取）');
  assert.equal(calls.length, 0, '这条路由一次都不该碰桥：它只读文本与匹配缓存');
  // 路由顺序：`shelf` 若被 `/api/playlists/:id` 先吃掉，这里就会是 404（"没有这张歌单"）。
  assert.equal(shelf.playlists.length > 0, true, 'shelf 没被当成一张叫 shelf 的歌单');
  const wrongMethod = await fetch(`${route.origin}/api/playlists/shelf`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
  assert.notEqual(wrongMethod.status, 200, 'POST 不许命中这条只读路由');
  await wrongMethod.text();
  assert.equal((await (await fetch(`${route.origin}/api/playlists`)).json()).playlists.length, 2, '上面那次 POST 没有顺手创建一张叫 shelf 的歌单');
  assert.equal(shelf.limit, playlists.SHELF_PLAYLIST_LIMIT);
  assert.equal(shelf.omitted, 0);
  await route.close();
});

test('⑧ 架上上限是**可见**的：超出部分报张数，不静默少铺', async () => {
  const route = await routeServer();
  const total = playlists.SHELF_PLAYLIST_LIMIT + 3;
  for (let index = 0; index < total; index += 1) {
    await route.store.playlists.write(`单${index}`, `# name: 单${index}\n曲 - 甲\n`);
  }
  const shelf = await (await fetch(`${route.origin}/api/playlists/shelf`)).json();
  assert.equal(shelf.playlists.length, playlists.SHELF_PLAYLIST_LIMIT, '架上最多铺这么多张');
  assert.equal(shelf.omitted, 3, '没铺出来的张数要说得出（静默少三张就是骗人）');
  await route.close();
});

// ── R127（方案 B）：手工指定 = **只改一行**的替换 ─────────────────────────────
// 需求原文："未匹配行加一颗 → 打开搜索（预填该条目标题+歌手）→ 选中候选后原地替换该行（写回身份段）"。
// 写入纪律四条，逐条钉：只改目标行 / 保留 `#` 注释与 `[album]` 分组 / 写前 .backup / 失败不动文件。
// "失败不动文件"最硬的那一格是**对照**：客户端把"当时看到的那一行原文"带回来，对不上就一个字都不写。

const { replaceEntryInText } = playlists;

test('R127 只改目标行：其余每一行逐字节照抄（注释、专辑头、空行、结尾换行都不动）', () => {
  const text = '# Rhine 歌单 v1\n# name: 试\n\nLet us - 某人\n[album] 第一张\nBad - Guy\n# 尾巴注释\n';
  const parsed = parsePlaylistText(text);
  assert.deepEqual(parsed.entryLines, [4, 6], '行号要与文件里的真实行对齐（第 5 行是 [album] 头，不是一条曲目）');
  const target = parsed.entryLines[1];
  const got = replaceEntryInText(text, {
    line: target, expect: 'Bad - Guy',
    entry: { title: 'Bad', artist: 'Guy', album: '第一张', durationMs: 245000, online: { provider: 'netease', mediaId: '123' } },
  });
  const before = text.split('\n');
  const after = got.text.split('\n');
  assert.equal(after.length, before.length, '行数不许变（替换不是增删）');
  for (let i = 0; i < before.length; i += 1) {
    if (i === target - 1) continue;
    assert.equal(after[i], before[i], `第 ${i + 1} 行被顺手动了：「${before[i]}」→「${after[i]}」`);
  }
  assert.equal(before[target - 1], 'Bad - Guy', '原对象不许被就地改');
  assert.match(got.after, /^Bad - Guy \| 第一张 \| 4:05 \| on:netease:123$/, '新行由 serializeEntry 生成，第 4 段是身份');
  assert.equal(got.before, 'Bad - Guy');
  const reparsed = parsePlaylistText(got.text);
  assert.equal(reparsed.items.length, parsed.items.length, '条目数不变');
  assert.deepEqual(reparsed.items[1].online, { provider: 'netease', mediaId: '123' }, '替换完这一条自带身份 ⇒ 免匹配直接可播');
  assert.equal(reparsed.warnings.length, 0, '替换后的文件一行都不该读不懂');
});

test('R127 对照失败一律不写：原文不符 / 行号越界 / 目标不是曲目 / JSON 形 / 空 expect', () => {
  const text = '# name: 试\nBad - Guy\n';
  // 用户在别处改过这一行（或面板开着没刷新）：表现必须是"这次没改成"，不是"改错了行"。
  assert.throws(() => replaceEntryInText(text, { line: 2, expect: '旧的写法', entry: { title: 'a', artist: 'b' } }), /已经不是刚才看到的那一行/);
  assert.throws(() => replaceEntryInText(text, { line: 9, expect: 'Bad - Guy', entry: { title: 'a', artist: 'b' } }), /不存在/);
  assert.throws(() => replaceEntryInText(text, { line: 0, expect: 'Bad - Guy', entry: { title: 'a', artist: 'b' } }), /行号不合法/);
  assert.throws(() => replaceEntryInText(text, { line: 1.5, expect: 'x', entry: { title: 'a', artist: 'b' } }), /行号不合法/);
  assert.throws(() => replaceEntryInText(text, { line: NaN, expect: 'x', entry: { title: 'a', artist: 'b' } }), /行号不合法/);
  assert.throws(() => replaceEntryInText(text, { line: 2, expect: '  ', entry: { title: 'a', artist: 'b' } }), /没带上/);
  // 注释行与专辑头都不是一条曲目：靠同一个解析器判，不另起一套行型判断。
  assert.throws(() => replaceEntryInText('# 说明\n[album] 头\nBad - Guy\n', { line: 1, expect: '# 说明', entry: { title: 'a', artist: 'b' } }), /不是一条曲目/);
  assert.throws(() => replaceEntryInText('# 说明\n[album] 头\nBad - Guy\n', { line: 2, expect: '[album] 头', entry: { title: 'a', artist: 'b' } }), /不是一条曲目/);
  // 坏行（读不懂的那一行）也没有行号 ⇒ 同样拒绝，不会把警告行悄悄变成曲目。
  assert.throws(() => replaceEntryInText('没有分隔符的一行\nBad - Guy\n', { line: 1, expect: '没有分隔符的一行', entry: { title: 'a', artist: 'b' } }), /不是一条曲目/);
  assert.throws(() => replaceEntryInText('{"items":[{"title":"a","artist":"b"}]}', { line: 1, expect: 'a - b', entry: { title: 'c', artist: 'd' } }), /JSON 形/);
  // 条目形状与追加共用同一个校验器（两处各写一遍迟早会漂）。
  assert.throws(() => replaceEntryInText(text, { line: 2, expect: 'Bad - Guy', entry: { title: '只有歌名' } }), /缺少歌名或歌手/);
  assert.throws(() => replaceEntryInText(text, { line: 2, expect: 'Bad - Guy', entry: { title: 'a', artist: 'b', online: { provider: 'netease' } } }), /在线身份不完整/);
});

test('R127 上限仍由解析器把：替换成一个超长行要抛，不静默截断', () => {
  const text = `Bad - Guy\nx - y\n`;
  assert.throws(() => replaceEntryInText(text, {
    line: 1, expect: 'Bad - Guy', entry: { title: 'T'.repeat(MAX_PLAYLIST_CHARS), artist: 'Guy' },
  }), /240 字符/);
});

test('R127 路由：replace 在动作白名单里，且身份换算与追加共用同一个函数', async () => {
  const server = await readScript('music-server.mjs');
  assert.match(server, /const actions = \[[^\]]*'add', 'replace'\]/, 'replace 走既有的动作白名单，不开第二条 URL');
  const block = /if \(value\.action === 'replace'\) \{[\s\S]*?\n          \}/.exec(server);
  assert.ok(block, '没抓到 replace 那一支（提取失败不许静默通过）');
  assert.match(block[0], /identityFromStreamUrl\(source\.audioUrl\)/, '身份换算沿用 add 那一个函数，不写第二处');
  assert.match(block[0], /store\.playlists\.write\(/, '写盘走 store.write —— .backup 是它负责的，不在这里另做一份');
  assert.match(block[0], /current\.parseError/, '读不懂的歌单先让它修，不在坏文件上改行');
});

test('R127 端到端（离线）：POST replace ⇒ 只有目标行变了、.backup 是改前那份、被拒之后文件原样', async () => {
  const route = await routeServer();
  try {
    const text = '# Rhine 歌单 v1\n# name: 临时\n\nLet us - 某人\nBad - Guy\n';
    const created = await post(route.origin, { action: 'create', name: '临时', text });
    assert.equal(created.status, 200, JSON.stringify(await created.json().catch(() => null)));
    const detail = await (await fetch(`${route.origin}/api/playlists/${encodeURIComponent('临时')}`)).json();
    assert.deepEqual(detail.playlist.entryLines, [4, 5], 'GET 要把行号一起给出去，界面才知道"目标行"是哪一行');
    const got = await post(route.origin, {
      action: 'replace', id: '临时', line: 5, expect: 'Bad - Guy',
      entry: { title: 'Bad', artist: 'Guy', album: '黑马', durationMs: 245000, audioUrl: '/api/online/stream?p=netease&id=999' },
    });
    const body = await got.json();
    assert.equal(got.status, 200, JSON.stringify(body));
    assert.equal(body.after, 'Bad - Guy | 黑马 | 4:05 | on:netease:999', '同源地址要反解成身份段写回去');
    const file = path.join(route.dataDir, 'playlists', '临时.playlist.txt');
    const written = await readFile(file, 'utf8');
    assert.equal(written, '# Rhine 歌单 v1\n# name: 临时\n\nLet us - 某人\nBad - Guy | 黑马 | 4:05 | on:netease:999\n', '整份文件只有那一行变了');
    const backupFile = path.join(route.dataDir, 'playlists', '临时.playlist.txt.backup');
    assert.ok(existsSync(backupFile), '写前必须有 .backup');
    assert.equal(await readFile(backupFile, 'utf8'), text, '.backup 是改动前那份，逐字节');
    const stale = await post(route.origin, { action: 'replace', id: '临时', line: 5, expect: 'Bad - Guy', entry: { title: 'X', artist: 'Y' } });
    assert.equal(stale.status, 400, '面板开着没刷新时再提交一次 ⇒ 拒绝而不是改错行');
    assert.match((await stale.json()).error ?? '', /没有写入/);
    assert.equal(await readFile(file, 'utf8'), written, '被拒之后文件一个字节都没动');
  } finally {
    await route.close();
  }
});

test('R127 界面：那颗按钮只在拿得到行号时出现，说明写清了"只改一行 + 会留 .backup"，失败要说"文件没有改动"', async () => {
  const ui = await read('src/playlists-ui.ts');
  assert.match(ui, /data-action="playlist-pick-open" data-entry="\$\{index\}"/, '未匹配行有「手工指定」');
  assert.match(ui, /item\.line\s*\?\s*`<button class="text-button" data-action="playlist-pick-open"/, '拿不到行号就不给这颗按钮（宁可不给也不猜那一行）');
  assert.match(ui, /只替换那一行/, 'banner 要写"只替换那一行"');
  assert.match(ui, /<code>\.backup<\/code>/, 'banner 要写会留 .backup');
  assert.match(ui, /data-action="playlist-pick-cancel"/, '有入口就要有出口（取消）');
  const app = await read('src/music-app.ts');
  assert.match(app, /手工指定没写成：[\s\S]{0,40}（文件没有改动）/, '被拒之后要说"文件没有改动"，否则用户以为改掉了');
  assert.match(app, /applySearchTab\(target\.dataset\.searchTab/, '切页只有一个出处（tab 点击与手工指定共用，两写必漂）');
  assert.match(app, /pickBannerMarkup\(pickTarget/, '指定模式下检索结果上方要有那条说明');
  assert.match(app, /pickTarget \? pickRowMarkup\(index, item\)/, '每一行在指定模式下多一颗"指定这一条"');
});

// ── R137：粘贴导入扩到三家（网易 / QQ / 酷狗），平台按域名认 ────────────────────
// 一手实测都写进了 bridge/providers/playlist.mjs 与 bridge/playlist-routes.mjs 的文件头；
// 这里的夹具照那份实测形状造，判据落在行为上：认平台、页号换算、"读不到"与"空歌单"分开、不写身份段。

test('R137 认平台靠域名：三家的链接与 id 各归各家，认不出来的要说清能接受什么', () => {
  assert.equal(parseImportInput('collection_1_1341266283_964007_0').kind, 'kugou-id');
  assert.equal(parseImportInput('collection_1_1341266283_964007_0').provider, 'kugou');
  assert.equal(parseImportInput('https://www.kugou.com/songlist/collection_3_1863870844_4_0/').id, 'collection_3_1863870844_4_0',
    '链接里嵌着 collection_ 也算（用户从网页地址栏整段复制是常态）');
  assert.equal(parseImportInput('https://y.qq.com/n/ryqq/playlist/8496210299').kind, 'qq-id');
  assert.equal(parseImportInput('https://y.qq.com/n/ryqq/playlist/8496210299').id, '8496210299');
  assert.equal(parseImportInput('https://y.qq.com/x?disstid=123456').id, '123456', 'disstid 这种参数名也认（QQ 两种链接形态都见过）');
  assert.equal(parseImportInput('https://music.163.com/playlist?id=17429985859').provider, 'netease', '网易的既有行为一字不动');
  // 只有 specialid 的酷狗链接：**明确说推不出 gcid**，而不是丢一句"不认识"
  const special = parseImportInput('https://m.kugou.com/bd/pl/index.html?specialid=7687439');
  assert.equal(special.kind, 'unknown');
  assert.match(special.error, /global_collection_id/, special.error);
  assert.match(special.error, /specialid/, '拒绝里要点名用户粘的那个字段，否则他不知道该换什么');
  // 陌生域名：拒绝里要列出能接受什么（"unrecognized" 一句话不算指引）
  const weird = parseImportInput('https://example.com/playlist?id=12345');
  assert.equal(weird.kind, 'unknown');
  assert.match(weird.error, /网易|QQ|酷狗/, '拒绝语要列出这三家');
});

const kugouDetailRow = (over = {}) => ({
  name: 'G.E.M.邓紫棋姐姐所有歌曲', count: 127, global_collection_id: 'collection_1_1341266283_964007_0',
  specialid: 964007, listid: 932, list_create_userid: 1341266283,
  is_pri: 0, is_drop: 0, is_publish: 1, pub_type: 1, status: 1, ...over,
});
const kugouSongRow = (index) => ({
  // 一手形状：name 是"歌手 - 曲名"连笔、歌手在 singerinfo（数组！）、时长 timelen 是毫秒。
  // index===2 那一行复刻真机撞出来的第二层丢失：**专辑名里带着本格式的分隔符**（真实样本
  // `红色高跟鞋 (Single Version|0.8x)`），原样写出去的那一行自家解析器读不回来。
  name: `G.E.M.邓紫棋 - 曲目 ${index}`, hash: `H${index}`.padEnd(10, '0'), timelen: 231915 + index,
  singerinfo: [{ name: 'G.E.M.邓紫棋', id: 4490, avatar: 'http://singerimg.kugou.com/a.jpg', type: 0 }],
  albuminfo: { name: index === 2 ? `专辑${index} (Single Version|0.8x)` : `专辑 ${index}`, id: 1414219, publish: 1 },
  privilege: 8, cover: 'http://imge.kugou.com/stdmusic/{size}/a.jpg',
});
/** 假酷狗桥：只回一手量到的那两种信封（detail 的 data 是**数组**；tracks 的 data 是 {count, songs, begin_idx}）。 */
function fakeKugouBridge({ count = 127, failAt = null, detailRow, pageEcho = 200, blankNames = 0 } = {}) {
  // 详情行的总数与曲目分页的总数**必须是同一个数**（默认跟着 count 走），否则假桥自己就在演
  // "详情说 127 条、曲目却回 2400 条"——那种不一致真机上不存在，判据也就白钉了。
  const row = detailRow ?? kugouDetailRow({ count });
  // `blankNames` 复刻真机那一格：上游确实会回几条 name 是空的行（实测 127 条里有 1 条）
  const rowAt = (index) => (index < blankNames ? { ...kugouSongRow(index), name: '' } : kugouSongRow(index));
  const calls = [];
  return {
    calls,
    call: async (route, payload) => {
      calls.push({ ...payload });
      if (failAt === payload.action) return { ok: false, reason: '酷狗后端未就绪', retryable: true };
      if (payload.action === 'detail') {
        return {
          ok: true, provider: 'kugou', action: 'detail', id: row.global_collection_id,
          name: row.name, trackCount: row.count ?? count, coverUrl: '',
          specialId: String(row.specialid ?? ''), listId: String(row.listid ?? ''),
        };
      }
      const limit = Math.min(pageEcho, payload.limit ?? pageEcho);
      const page = Math.floor((payload.offset ?? 0) / limit) + 1;
      const begin = (page - 1) * limit;
      const n = Math.max(0, Math.min(limit, count - begin));
      const { kugouSongsToItems } = await import('./bridge/providers/playlist.mjs');
      return {
        ok: true, provider: 'kugou', action: 'tracks', offset: begin, limit, page, total: count,
        items: kugouSongsToItems(Array.from({ length: n }, (unused, i) => rowAt(begin + i))),
      };
    },
  };
}

test('R137 酷狗字段映射：总条数叫 count、歌手在 singerinfo 数组、时长 timelen 是毫秒、连笔只在开头才剥', async () => {
  const { kugouSongsToItems, kugouDetailToMeta, kugouDetailReadability } = await import('./bridge/providers/playlist.mjs');
  const items = kugouSongsToItems([kugouSongRow(0), kugouSongRow(1)]);
  assert.equal(items.length, 2);
  // R226：这一家也带 `coverRef` 那一格，但**恒为空串**——一手实测那张 400 行老单的第一页 200 行，
  // `cover` 200/200 都是带 `{size}` 占位的模板、协议是 http、主机 `imge.kugou.com` 不在封面白名单里
  // ⇒ "上游给了"不等于"我们能收"，本批不为它加主机（零新增出网主机）。这条断言就是钉住"没有偷偷硬造"。
  assert.deepEqual(Object.keys(items[0]).sort(), ['album', 'artist', 'coverRef', 'durationMs', 'mediaId', 'provider', 'quality', 'title']);
  assert.equal(kugouSongsToItems([{ name: 'A - B', singerinfo: [{ name: 'A' }], timelen: 1000, hash: 'h',
    cover: 'http://imge.kugou.com/stdmusic/%7Bsize%7D/20190717/20190717104710406744.jpg' }])[0].coverRef, '',
    '带 {size} 的模板 URL 不收（不收进契约 ≠ 上游没给，这句要说得清）');
  assert.equal(items[0].title, '曲目 0', '"歌手 - " 前缀剥掉了');
  assert.equal(items[0].artist, 'G.E.M.邓紫棋');
  assert.equal(items[0].album, '专辑 0');
  assert.equal(items[0].durationMs, 231915, 'timelen 已经是毫秒，不许再乘 1000');
  // 曲名自己带 " - " 的不能切错（这是"宁可不切"那条判据的正面样本）
  const tricky = kugouSongsToItems([{ name: '某歌手 - 现场 - 2019', singerinfo: [{ name: '某歌手' }], timelen: 1000, hash: 'x' }]);
  assert.equal(tricky[0].title, '现场 - 2019', '只剥"歌手名 + 空格连字符空格"这一段');
  const noPrefix = kugouSongsToItems([{ name: 'Just A Song - Live', singerinfo: [{ name: '别人' }], timelen: 1000, hash: 'y' }]);
  assert.equal(noPrefix[0].title, 'Just A Song - Live', '开头不是那位歌手 ⇒ 整串当曲名，宁可不切也不切错');
  const multi = kugouSongsToItems([{ name: '林海峰、G.E.M.邓紫棋 - 食烟饮酒讲粗口', singerinfo: [{ name: '林海峰' }, { name: 'G.E.M.邓紫棋' }], timelen: 1000, hash: 'z' }]);
  assert.equal(multi[0].artist, '林海峰 / G.E.M.邓紫棋', '多歌手对外用 / 连（与网易那一路同一形状）');
  assert.equal(multi[0].title, '食烟饮酒讲粗口',
    '上游多歌手是用**顿号**连的（真机原样）：只试 " / " 就剥不掉，曲名里会混进歌手名');
  assert.equal(kugouSongsToItems(undefined), null, '没有 songs 字段是故障，不是空歌单');
  // 详情：总条数、私有 / 被删 / 未发布 各说一句，与"这张单真的是空的"分开
  assert.equal(kugouDetailToMeta(kugouDetailRow()).trackCount, 127);
  assert.equal(kugouDetailToMeta(kugouDetailRow()).coverUrl, '', '酷狗给的是带 {size} 占位的模板 URL，不搬进契约');
  assert.equal(kugouDetailReadability(kugouDetailRow({ is_pri: 1 })).readable, false, '私有');
  assert.match(kugouDetailReadability(kugouDetailRow({ is_pri: 1 })).reason, /私有/);
  assert.match(kugouDetailReadability(kugouDetailRow({ is_drop: 1 })).reason, /已被删除/, '被删');
  assert.match(kugouDetailReadability(kugouDetailRow({ is_publish: 0, status: 1000 })).reason, /不可读/, '未发布 / 状态异常');
  const empty = kugouDetailReadability(kugouDetailRow({ count: 0 }));
  assert.equal(empty.readable, true, '标记都正常而 count=0 ⇒ 这才是"空歌单"');
  assert.equal(empty.empty, true);
  assert.equal(kugouDetailReadability(null).readable, false, 'detail 回空数组不是"空歌单"，是读不到');
});

test('R137 桥的酷狗路由：id 形状不对就零调用、30227 翻译成人话、offset 换成页号、20010 说"取不到曲目"', async () => {
  const { registerPlaylistRoutes, KUGOU_PLAYLIST_ID } = await import('./bridge/playlist-routes.mjs');
  const invoke = [];
  const backends = {
    kugou: {
      state: 'ready',
      invoke: async (operation, params) => {
        invoke.push({ operation, params });
        if (operation === 'playlist_detail') return { status: 200, body: { status: 1, data: [kugouDetailRow()] } };
        return { status: 200, body: { status: 1, data: { count: 127, begin_idx: (params.page - 1) * params.pagesize, pagesize: params.pagesize, songs: [kugouSongRow(0)] } } };
      },
    },
  };
  const routes = new Map();
  registerPlaylistRoutes({ routes, backends, fetchImpl: async () => ({ text: async () => '{}' }) });
  const call = routes.get('/bridge/playlist');
  assert.ok(KUGOU_PLAYLIST_ID.test('collection_1_1341266283_964007_0'), 'id 形状要能认一手样本');
  assert.equal(KUGOU_PLAYLIST_ID.test('7687439'), false, 'specialid 不是 gcid');
  const bad = await call({ provider: 'kugou', action: 'detail', id: '7687439' });
  assert.equal(bad.ok, false);
  assert.match(bad.reason, /global_collection_id/);
  assert.equal(invoke.length, 0, '形状不对就不该碰包：那是一次注定读不到的出网');
  const detail = await call({ provider: 'kugou', action: 'detail', id: 'collection_1_1341266283_964007_0' });
  assert.equal(detail.ok, true, JSON.stringify(detail));
  assert.equal(detail.trackCount, 127);
  assert.deepEqual(invoke[0], { operation: 'playlist_detail', params: { ids: 'collection_1_1341266283_964007_0' } });
  // offset/limit → 页号：问 offset=200/limit=200 应当变成 page=2，并把对齐后的 offset 回吐
  const page = await call({ provider: 'kugou', action: 'tracks', id: 'collection_1_1341266283_964007_0', offset: 200, limit: 200 });
  assert.equal(page.ok, true, JSON.stringify(page));
  assert.equal(invoke.at(-1).params.page, 2);
  assert.equal(page.offset, 200, '回吐对齐后的 offset，导入侧据此续拉');
  assert.equal(page.limit, 200, '回吐**实际用的页大小**：拿我们问出去的数判"页满没满"会提前收尾');
  // 问 500 时桥夹到 200：回吐的 limit 必须是 200，否则调用方以为一页拿了 500 条
  const clamped = await call({ provider: 'kugou', action: 'tracks', id: 'collection_1_1341266283_964007_0', offset: 0, limit: 500 });
  assert.equal(clamped.limit, 200, '夹小要如实回吐');
  // 上游错误码翻译：detail 30227 = 不存在；tracks 20010 = 取不到曲目
  const thrower = (error) => ({ kugou: { state: 'ready', invoke: async () => { throw error; } } });
  const notFound = new Map();
  registerPlaylistRoutes({ routes: notFound, backends: thrower({ status: 502, body: { error_code: 30227 } }), fetchImpl: async () => ({ text: async () => '{}' }) });
  const gone = await notFound.get('/bridge/playlist')({ provider: 'kugou', action: 'detail', id: 'collection_1_1_1_0' });
  assert.equal(gone.ok, false);
  assert.match(gone.reason, /不存在或不公开.*30227/, gone.reason);
  assert.equal(gone.retryable, false, '不存在的单重试也不会出现');
  const songFail = new Map();
  registerPlaylistRoutes({ routes: songFail, backends: thrower({ status: 502, body: { error_code: 20010, errmsg: 'get other list file fail' } }), fetchImpl: async () => ({ text: async () => '{}' }) });
  const tracks = await songFail.get('/bridge/playlist')({ provider: 'kugou', action: 'tracks', id: 'collection_1_1_1_0', offset: 0, limit: 200 });
  assert.match(tracks.reason, /取不到曲目.*20010/, tracks.reason);
  assert.equal(tracks.retryable, false);
  const other = new Map();
  registerPlaylistRoutes({ routes: other, backends: thrower({ status: 504, body: { error_code: 50099 } }), fetchImpl: async () => ({ text: async () => '{}' }) });
  assert.equal((await other.get('/bridge/playlist')({ provider: 'kugou', action: 'detail', id: 'collection_1_1_1_0' })).retryable, true,
    '认不出的错误码一律按通道故障处理（可重试），不许把一次抖动说成"这张单不存在"');
  const down = new Map();
  registerPlaylistRoutes({ routes: down, backends: { kugou: { state: 'error' } }, fetchImpl: async () => ({ text: async () => '{}' }) });
  assert.equal((await down.get('/bridge/playlist')({ provider: 'kugou', action: 'detail', id: 'collection_1_1_1_0' })).retryable, true);
});

test('R137 写出去的行必须能被读回：字段里带格式分隔符与换行的真实样本（酷狗一手数据撞出来的）', () => {
  // 真机那一格：专辑名 `红色高跟鞋 (Single Version|0.8x)` 原样写出去 ⇒ 解析器判"竖线段数超出格式"
  // 整条丢掉，落盘 41 行只读回 40 条。**判据写在写这一侧**：我管不着上游给不给这种字符。
  const entry = serializeEntry({ title: '红色高跟鞋 (0.8x)', artist: '海梦', album: '红色高跟鞋 (Single Version|0.8x)', durationMs: 252000 });
  // 判据不是"整行不含竖线"（` | ` 本来就是分隔符），而是**段数不许超过格式规定的段数**：
  // 字段里那个半角竖线要是没换掉，这一行就会被切成四段，解析器当场判"竖线段数超出格式"。
  assert.equal(entry.split(' | ').length, 3, `这一行该是"曲名 - 歌手 | 专辑 | 时长"三段：实测 ${entry}`);
  assert.equal(entry.includes('｜'), true, '换成全角竖线：看着几乎一样，格式还认');
  const back = parsePlaylistText(`# Rhine 歌单 v1\n${entry}\n`);
  assert.equal(back.items.length, 1, '这一条必须读得回来');
  assert.deepEqual(back.warnings, [], '读回时不该留任何"没被读懂"');
  assert.equal(back.items[0].album, '红色高跟鞋 (Single Version｜0.8x)');
  assert.equal(back.items[0].durationMs, 252000, '时长那一段没被带偏');
  // 换行更狠：一行变两行，第二行还是一行垃圾
  const newline = serializeEntry({ title: '两\n行', artist: '甲', album: '乙', durationMs: 61000 });
  assert.equal(newline.includes('\n'), false, '换行不许把一条拆成两行');
  const round = parsePlaylistText(`# Rhine 歌单 v1\n${newline}\n`);
  assert.equal(round.items.length, 1);
  assert.equal(round.items[0].title, '两 行');
  // 往返不变式仍然成立（这条改动没碰条目形状，只碰字段里的字符）
  const text = serializePlaylist({ name: 't', items: [{ title: 'a|b', artist: 'c', album: 'd', durationMs: 1000 }] });
  assert.deepEqual(parsePlaylistText(serializePlaylist({ name: 't', items: parsePlaylistText(text).items })).items,
    parsePlaylistText(text).items, 'parse(serialize(parse)) 要还是幂等的');
});

test('R137 导入一张酷狗公开歌单：落成文本形、来历写 kugou-playlist、一个身份段都不写', async () => {
  await withStore(async (store) => {
    // `blankNames: 1` 是真机那一格：127 条里有 1 条上游给了空曲名 ⇒ 只能落 126 条，
    // 而"少了 1 条"必须是**说出来的**，不是悄悄少一截。
    const bridge = fakeKugouBridge({ count: 127, blankNames: 1 });
    const got = await createPlaylistImporter({ bridge, store }).import({ text: 'collection_1_1341266283_964007_0' });
    assert.equal(got.ok, true, JSON.stringify(got));
    assert.equal(got.provider, 'kugou');
    assert.equal(got.items, 126);
    assert.equal(got.total, 127);
    assert.equal(got.truncated, false);
    assert.equal(got.dropped, 1, '上游 127 条、落成 126 条 ⇒ 差的那一条要报出来');
    assert.match(got.warning, /上游报 127 条，1 条没能导进来/, got.warning);
    assert.equal(got.items, 126, '报出去的条数就是磁盘上真正有的条数（曾经这里是"已导入 40 条：落成 41 条"那种自相矛盾）');
    assert.ok(got.warnings.some((w) => /没有曲名/.test(w.reason)), '明细也要留一条');
    const saved = await store.get(got.id);
    assert.equal(got.items, saved.items.length, '恒等式：回执里的条数 == 文件里读回来的条数（写侧修好格式之后这才成立）');
    assert.match(saved.text, /# kugou-playlist collection_1_1341266283_964007_0 imported \d{4}-\d{2}-\d{2}T/, '来历写的是**这一家**，不是 netease');
    assert.equal(saved.text.includes('on:'), false, '统一不写身份段：酷狗音源本机不可播，写了就是给了一个播不了的地址（批复②）');
    assert.equal(saved.items.length, 126);
    assert.equal(saved.items[0].artist, 'G.E.M.邓紫棋');
    // 文本形只到"秒"（m:ss），231915ms 落盘成 3:52 再读回是 232000 —— 与网易那一路同一条既有精度，
    // 不是导入丢数据（那条判据在 R127 之前就有，这里照它写）。
    assert.equal(saved.items[0].durationMs, 232000, '时长来自 timelen（毫秒），落盘按文本形的秒精度收敛');
    // 带半角竖线的那一条（index 2）必须**还在**：曾经它就是被自家格式吃掉的那一条
    const pipeRow = saved.items.find((item) => item.album.includes('｜'));
    assert.ok(pipeRow, '专辑名里带格式分隔符的那一条要能落盘并读回（真机上它当时就是少掉的那一条）');
    assert.equal(pipeRow.title, '曲目 2');
    assert.deepEqual(bridge.calls.map((c) => c.action), ['detail', 'tracks'], '127 条一页就问完了，不多问');
  });
});

test('R137 分页与截断沿用网易那套口径：以 count 为目标、1000 条硬顶、截断写进文件', async () => {
  await withStore(async (store) => {
    const big = fakeKugouBridge({ count: 2400 });
    const got = await createPlaylistImporter({ bridge: big, store }).import({ text: 'collection_1_1_1_0' });
    assert.equal(got.items, 1000);
    assert.equal(got.truncated, true);
    assert.match(got.warning, /共 2400 条，只导入前 1000 条/);
    const saved = await store.get(got.id);
    assert.match(saved.text, /# truncated 共 2400 条，只导入前 1000 条/);
    assert.deepEqual(big.calls.filter((c) => c.action === 'tracks').map((c) => `${c.offset}/${c.limit}`),
      ['0/200', '200/200', '400/200', '600/200', '800/200'], '按桥回吐的 200 一页续拉（问 500 也要按 200 走）');
    const mid = fakeKugouBridge({ count: 450 });
    assert.equal((await createPlaylistImporter({ bridge: mid, store }).import({ text: 'collection_1_1_2_0' })).items, 450);
    assert.equal(mid.calls.filter((c) => c.action === 'tracks').length, 3, '450 条 = 200+200+50，第三页不满就收');
    // 桥把一页夹得比我们要的还小（问 200、只给 100）：续拉的步长与"这页满没满"都只能按**回吐的数**判。
    // 按问出去的 200 判，第一页 100 条就被当成"没满 ⇒ 到底了"，250 条只导回 100 条且一句错也不报。
    const clamped = fakeKugouBridge({ count: 250, pageEcho: 100 });
    assert.equal((await createPlaylistImporter({ bridge: clamped, store }).import({ text: 'collection_1_1_3_0' })).items, 250,
      '桥回吐 100 就必须按 100 一页续拉完');
    assert.deepEqual(clamped.calls.filter((c) => c.action === 'tracks').map((c) => `${c.offset}/${c.limit}`),
      ['0/200', '100/150', '200/50'], 'offset 按桥回吐的 100 走，问出去的数只是上限（最后一问按"还剩多少"收窄）');
  });
});

test('R137 → R138：QQ 的链接认得，而"明确停下并说清缺什么"那一档已经被真机量测取代', async () => {
  await withStore(async (store) => {
    // 这一条留作**反面判据**：R137 当时量不到成功响应的字段名，导入器因此硬停下并说明缺什么。
    // R138 拿到一条真实公开歌单把字段名量完，那句停下就必须消失——留着它等于把一个能用的功能锁在过期结论里。
    const bridge = fakeKugouBridge({});
    const importer = await readScript('playlist-import.mjs');
    assert.doesNotMatch(importer, /本批\*\*故意不通\*\*/, 'R137 那段"故意不通"的注释要一起删掉，不许留成第二套说法');
    const got = await createPlaylistImporter({ bridge, store }).import({ text: 'https://y.qq.com/n/ryqq/playlist/8496210299' });
    assert.equal(got.ok, false, '没有 QQ 通道（这里没注入 qq）就不能假装导得动');
    assert.equal(got.reason, 'bridge-off', '缺通道时说的那句与其它家同一档，不新造一个"暂不支持"');
    assert.equal(bridge.calls.length, 0, 'QQ 那一条永远不落在桥的调用记录里');
    assert.equal((await store.list()).length, 0, '没导就不该留一张空文件');
  });
});

test('R137 接线面：入口文案改到三家、桥的分叉有酷狗那一行、QQ 走自己那条通道', async () => {
  const ui = await read('src/playlists-ui.ts');
  assert.match(ui, /粘贴歌单链接导入/, '入口不再写死"网易"');
  const app = await read('src/music-app.ts');
  assert.match(app, /网易 \/ QQ \/ 酷狗的歌单链接/, '输入框说明列出三家');
  assert.match(app, /collection_1_1341266283_964007_0/, 'placeholder 给一个能直接照抄的酷狗形状');
  const forked = await readScript('bridge/playlist-routes.mjs');
  assert.match(forked, /if \(provider === 'kugou'\) return kugouPlaylist\(backends, payload\)/, 'provider 分叉那一行');
  const importer = await readScript('playlist-import.mjs');
  // R138 改口：QQ 不再"在导入器里停下"，而是换一条通道。停下那一句曾经是唯一去处，现在它是**回归**
  // （两条通路各自演进就是 R114 那一课），所以判据换成"transport 只有一个调用点"。
  assert.doesNotMatch(importer, /QQ 歌单本机还没法导/, '那句"停下"已经过期，留着会掩盖一条本来能走的通道');
  assert.equal((importer.match(/bridge\.call\(/g) ?? []).length, 1,
    '桥的调用点只剩 transport 那一处：QQ 不可能绕开自己那条通道落回桥，两家也不会各自演进（R114 的"一条通路"）');
  assert.equal((importer.match(/await call\(/g) ?? []).length, 2,
    '取数只有 detail 与 tracks 两处，且都过同一个 call');
  assert.match(importer, /provenanceComment\(provider, id/, '来历注释按平台写（R156 起格式只有 `provenanceComment` 一个出处，'
    + '这里判的是"传的是 provider 而不是写死某一家"——原先钉的那串模板文本与"不许手搓第二份格式"直接打架）');
  // "少了几条"到了界面上必须还在（服务端报了 dropped 而界面只看 truncated，等于把这句话吞回去）
  const app2 = await read('src/music-app.ts');
  assert.match(app2, /result\.truncated \|\| result\.dropped/, '回执那句要把"少了 N 条"也走带说明的那一支');
  // 那句回执必须**带上歌单名**：只说"已导入 41 条"，用户不知道这 41 条是从哪张单来的、少掉的是哪 6 条。
  // 名字放在括号里而不是「」里——酷狗与网易的歌单名自己就常带「」（实测「0.8x」慢速歌曲），套两层没法读。
  assert.match(app2, /已导入 \$\{result\.items\} 条（\$\{result\.name\}）：/, '少了条数那一句要说清是哪张单');
  assert.match(await read('src/playlists-ui.ts'), /dropped\?: number/, '界面契约里有这一格');
});

// ── R138：QQ 歌单接通（字段名来自一条真实公开歌单的一手量测，2026-10-09）──────────
//
// 夹具只留**形状与数字 id**：用户给的分享链接原文、以及链接里那个不透明的分享参数，
// 按隐私红线不进仓库任何文件（这条是用户当面下的红线，不是我们自己加的）。
// 量测的三轮结论与"为什么必须是这台主机"写在 `playlist-qq.mjs` 与 `online-guard.mjs` 头部；
// 这里把那些结论逐条钉成断言——凡"只有真机能告诉我们的事"都必须在这里有一条会咬的判据。

const QQ_BODY_ID = '3714550625';

/**
 * 一条曲目行的真实形状。字段名逐个照实测抄：曲名有 `name` 与 `title` 两份（311/1534 条不等，
 * `title` 带版本标记），歌手在 `singer[]`，专辑在 `album.name`（实测 19 条是空串），
 * 时长 `interval` 是**秒**。`file.media_mid` / `pay` / `status:31` 这些我们不取的字段也照抄在——
 * "白名单之外不许漏上去"这条判据，表里得有真的东西可漏才算判过。
 */
const qqSongRow = (index) => ({
  id: 291692578 + index, type: 0, songtype: 13,
  mid: `002KLAJH2AgbTb${index}`,
  name: `曲目 ${index}`, title: index % 2 ? `曲目 ${index} (Live)` : `曲目 ${index}`,
  subtitle: '', interval: 257 + index, status: index === 7 ? 31 : 0,
  singer: index % 3 === 0
    ? [{ id: 1400123, mid: '002pfVN53lKI7x', name: '告五人', title: '告五人' }]
    : [{ id: 11447, mid: '001iaSfi07zuSE', name: '王铮亮' }, { id: 32169, mid: '0026IlCw2uKeZi', name: '李佳薇' }],
  album: index === 5 ? { id: 0, mid: '', name: '' } : { id: 16540684, mid: '000P4Dod0GzRlM', name: `专辑 ${index}` },
  file: { media_mid: `004EDhhh0U6Mwb${index}`, size_320mp3: 10316489 },
  pay: { pay_month: 1, price_track: 200 },
});

/** 整张响应。`cdnum:0` 时上游连 `cdlist` 都不给（实测不存在的 id 就是这个形状）。 */
const qqBody = ({ count = 9, code = 0, subcode = 0, cdnum = 1, songlist, echo = QQ_BODY_ID, named = '我喜欢' } = {}) => ({
  code, subcode, accessed_plaza_cache: 1, login: 'on', cdnum, realcdnum: cdnum,
  cdlist: cdnum === 0 ? undefined : [{
    disstid: echo, dissname: named, songnum: count, total_song_num: count, cur_song_num: count, song_begin: 0,
    desc: '', visitnum: 611, ctime: 0, mtime: 0,
    logo: 'http://y.gtimg.cn/mediastyle/y/img/cover_love_300.jpg',
    // 这一行往下是**歌单主的身份字段**（真机响应里就挂在同一层）：白名单外一个都不许上去
    nick: 'NICK_CANARY', nickname: 'NICK_CANARY', uin: 'UIN_CANARY', encrypt_uin: 'ENC_CANARY',
    headurl: 'http://thirdqq.qlogo.cn/headurl_canary',
    songlist: songlist ?? Array.from({ length: count }, (unused, index) => qqSongRow(index)),
  }],
});

/** 假出网层：记录每一次调用的完整参数（Referer / hosts / kind / 体积档都要能被翻开看）。 */
function fakeQqFetch(body = qqBody({}), { throwError = null, notJson = false, status = 200, ok = true } = {}) {
  const calls = [];
  const fetcher = async (url, init = {}) => {
    calls.push({ url, ...init });
    if (throwError) throw throwError;
    return { ok, status, text: async () => (notJson ? '<html>网关错误</html>' : JSON.stringify(body)) };
  };
  return Object.assign(fetcher, { calls });
}

const { createQqPlaylistSource, qqPlaylistQueryFor, QQ_PLAYLIST_URL, QQ_PAGE_LIMIT } = await import('./playlist-qq.mjs');
const { PLAYLIST_HOSTS, MAX_PLAYLIST_BODY_BYTES, ONLINE_PLAYLIST_TIMEOUT_MS, assertAllowedTarget, ONLINE_HOSTS } = await import('./online-guard.mjs');

/** 一条真的 QQ 通道 + 一层假的出网（真门面假网络：判定落在我们这一侧的每一个形状上）。 */
const qqChannel = (body, options = {}) => {
  const fetcher = fakeQqFetch(body, options);
  return { source: createQqPlaylistSource({ fetcher, now: options.now, ttlMs: options.ttlMs }), fetcher };
};
const QQ_BODY_ID_LINK = `https://i2.y.qq.com/n3/other/pages/details/playlist.html?id=${QQ_BODY_ID}`;

test('R138 认链接：手机分享那台主机补进识别集，id 从 query 取，链接里的私人参数一个都不带走', () => {
  // 用户在手机上分享出来的形状（主机 i2.y.qq.com，id 在 query 的 id= 里）
  const mobile = parseImportInput('https://i2.y.qq.com/n3/other/pages/details/playlist.html?hosteuin=一串不透明的分享参数&id=3714550625&appversion=200105&ADTAG=wxfshare');
  assert.equal(mobile.kind, 'qq-id');
  assert.equal(mobile.provider, 'qq');
  assert.equal(mobile.id, '3714550625');
  // **只留形状与 id**：解析结果里不许有那条链接的其它部分（返回值就是往文件与日志里去的东西）
  const leaked = JSON.stringify(mobile);
  assert.equal(leaked.includes('hosteuin'), false, '分享参数不许跟着 id 一起往上传');
  assert.equal(leaked.includes('i2.y.qq.com'), false, '解析结果里不保留链接原文');
  assert.equal(leaked.includes('wxfshare'), false);
  // 桌面端那一条（R137 就认得）不许因为加了新形状而回退
  assert.equal(parseImportInput('https://y.qq.com/n/ryqq/playlist/8496210299').id, '8496210299');
  assert.equal(parseImportInput('https://i.y.qq.com/v5/html/playlist.html#3714550625').kind, 'unknown', '认不出 id 时给的是结论而不是硬猜');
  // 认不出 id 那句要说得出**两种形状**，只给桌面端那一种时手机用户照着抄还是抄不对
  const hint = parseImportInput('https://i2.y.qq.com/n3/other/pages/details/playlist.html?id=abc');
  assert.equal(hint.kind, 'unknown');
  assert.match(hint.error, /i2\.y\.qq\.com/, hint.error);
  // 纯数字这一家历史上归网易（QQ 也全是数字，但把裸数字改判成 QQ 会让老用户的一次粘贴换一家问）⇒ 钉住不动
  assert.equal(parseImportInput('3714550625').kind, 'netease-id', '纯数字仍按网易认（界面要提醒 QQ 贴整条链接）');
});

test('R138 字段映射：曲名取 name（不带版本标记那一份）、歌手在 singer[]、时长 interval 是秒', async () => {
  const { qqSonglistToItems } = await import('./bridge/providers/playlist.mjs');
  const items = qqSonglistToItems([qqSongRow(0), qqSongRow(1), qqSongRow(3), qqSongRow(5)]);
  assert.equal(items.length, 4);
  // 契约就这九个键（R87 ① 的教训：再包一层白名单函数收自己构造的对象是空守卫）
  // R220 加的那一格是 `mediaMid`：QQ 匿名 vkey 缺第二段文件名会在 CDN 端 403（`qqVkeyRequest` 那条注释），
  // 来源身份通路要能播，就必须带着它 —— 不是"顺手多给一个字段"。
  // R226 加的那一格是 `coverRef`：这一家的行**不直接给图片地址**（一手实测 1553 行里含 pic/img 字段的行键只有 `url`，
  // 命中 0），但给了 `album.mid`（1534/1553 行带）⇒ 走**搜索侧那一个既有出处** `qqCoverRef` 拼 https 地址，
  // 与从搜索进歌单的那一行逐字同形；缺 mid 的行留空串，不硬造。
  assert.deepEqual(Object.keys(items[0]).sort(), ['album', 'artist', 'coverRef', 'durationMs', 'mediaId', 'mediaMid', 'provider', 'quality', 'title']);
  assert.equal(items[0].coverRef, 'https://y.gtimg.cn/music/photo_new/T002R300x300M000000P4Dod0GzRlM.jpg',
    '封面按 `album.mid` 走 qqCoverRef 那一个出处（与搜索侧同一张主机、同一条形状，不是第二套拼法）');
  assert.equal(items[3].coverRef, '', '这一行（夹具里 index 5）专辑 mid 是空串 ⇒ 封面留空，不拿 id 造一个会 404 的（F3 判据）');
  assert.equal(items[0].mediaMid, '004EDhhh0U6Mwb0', '第二段文件名取 `file.media_mid`（R138 一手量的字段名，与 mid 只有 476/1534 条相等 ⇒ 是两个字段）');
  assert.equal(items[0].title, '曲目 0');
  assert.equal(items[1].title, '曲目 1', '取 name 而不是 title：title 是"曲目 1 (Live)"那一份，与搜索侧的 title_main 不同档');
  assert.equal(items[0].artist, '告五人');
  assert.equal(items[1].artist, '王铮亮 / 李佳薇', '多歌手实测是数组（292/1534 条不止一个），与网易同口径用 " / " 连');
  assert.equal(items[0].durationMs, 257000, 'interval 是**秒**：这一家与网易/酷狗（毫秒）不同，认错了 4 分钟变 4 秒');
  assert.equal(items[0].mediaId, '002KLAJH2AgbTb0');
  assert.equal(items[0].album, '专辑 0');
  assert.equal(items[3].album, '', '实测 19 条专辑名是空串：如实留空，不拿文件名或歌手编一个');
  assert.equal(qqSonglistToItems(undefined), null, '没有 songlist 字段是故障，不是空歌单');
  assert.equal(qqSonglistToItems([]).length, 0, '空数组才是空歌单');
  // 没有 mid 或没有曲名的行：与网易那一路同判据（跳过，条数差由导入侧报出来）
  assert.equal(qqSonglistToItems([{ name: '有名字没 mid' }, { mid: 'x' }]).length, 0);
});

test('R138 详情白名单：歌单主的 nick / uin / encrypt_uin / headurl 一律不许往上传', async () => {
  const { qqPlaylistToMeta } = await import('./bridge/providers/playlist.mjs');
  const meta = qqPlaylistToMeta(qqBody({ count: 3 }));
  assert.deepEqual(Object.keys(meta).sort(), ['coverUrl', 'id', 'name', 'trackCount']);
  const asText = JSON.stringify(meta);
  for (const canary of ['NICK_CANARY', 'UIN_CANARY', 'ENC_CANARY', 'qlogo', 'visitnum']) {
    assert.equal(asText.includes(canary), false, `${canary} 不许出现在往上传的元信息里`);
  }
  assert.equal(meta.coverUrl, '', '这一家的封面是 http 的第三方地址且导入用不到 ⇒ 不搬进契约（与酷狗同一处置）');
  assert.equal(meta.trackCount, 3, '总条数在 songnum（实测与 songlist.length 相等）');
  assert.equal(qqPlaylistToMeta({ code: 0, cdlist: [] }), null, '没有 cdlist[0] 是"没这个字段"，不是"歌单是空的"');
});

test('R138 出网那一跳的四个形状，每一个都是真机量出来的：Referer、主机表、用途、体积档', async () => {
  const fetcher = fakeQqFetch(qqBody({ count: 2 }));
  const source = createQqPlaylistSource({ fetcher });
  const got = await source.call({ provider: 'qq', action: 'detail', id: QQ_BODY_ID });
  assert.equal(got.ok, true, JSON.stringify(got));
  const [call] = fetcher.calls;
  assert.equal(call.url.startsWith(QQ_PLAYLIST_URL), true);
  // 缺 Referer 时上游回的是 46 字节 `{"code":0,"subcode":1,"msg":"invalid referer"}`（实测）。
  // 离线自检永远绿、真机每次导入都得到"这张单不存在或不公开"——所以这一条必须钉住那个头本身。
  assert.equal(call.headers.Referer, 'https://y.qq.com/', '这一家的硬要求：没有 Referer 就没有 cdlist');
  assert.equal(call.hosts, PLAYLIST_HOSTS, '用的主机表是歌单专用那张，不是默认（歌词）那张');
  assert.equal(call.kind, 'playlist', '用途标了才进得了出网审计表');
  assert.equal(call.maxBytes, MAX_PLAYLIST_BODY_BYTES, '整张单一次给完（实测 2,405,719B）⇒ 用的是新开的歌单体积档');
  assert.equal(call.timeoutMs, ONLINE_PLAYLIST_TIMEOUT_MS);
  assert.equal(call.method ?? 'GET', 'GET', '这条端点是 GET（POST 那条是 musicu.fcg，量过：给不了歌单）');
  assert.equal(call.url.includes('disstid=3714550625'), true);
  assert.equal(call.url.includes('onlysong=0'), true, 'onlysong=1 实测 cdlist 是空的（量过的那种"看着对但拿不到东西"）');
});

test('R138 读不到的四种形状各说各话：不存在的 id、被校验挡下的请求、不是 JSON、回显不一致', async () => {
  // ① 不存在的 id 实测 `code:10 / cdnum:0`，没有 cdlist
  const gone = qqChannel(qqBody({ code: 10, cdnum: 0 }));
  const r1 = await gone.source.call({ action: 'detail', id: '999999999999999' });
  assert.equal(r1.ok, false);
  assert.match(r1.reason, /不存在或不公开.*code 10/, r1.reason);
  assert.equal(r1.retryable, false, '不存在的单重试也不会出现');
  // ② 另一种失败实测 `code:-1`（老 id 那一族）——同一条结论，不同码要说得出码
  assert.match((await qqChannel(qqBody({ code: -1, cdnum: 0 })).source.call({ action: 'detail', id: '1' })).reason, /code -1/);
  // ③ 请求被上游校验挡下（`subcode:1` + msg）：**不能说成"这张单不存在"**，那是我们这一侧的形状错了
  const refused = await qqChannel({ code: 0, subcode: 1, msg: 'invalid referer', cdnum: 0 })
    .source.call({ action: 'detail', id: QQ_BODY_ID });
  assert.equal(refused.ok, false);
  assert.match(refused.reason, /没有接受这次歌单请求.*subcode 1.*invalid referer/, refused.reason);
  assert.match(refused.reason, /不是这张单不存在/, refused.reason);
  assert.equal(refused.retryable, false, '请求形状错了就错了，重试一百次还是同一个形状');
  // ④ 不是 JSON
  const notJson = await qqChannel(qqBody({}), { notJson: true }).source.call({ action: 'detail', id: QQ_BODY_ID });
  assert.equal(notJson.ok, false);
  assert.match(notJson.reason, /不是 JSON/, notJson.reason);
  assert.equal(notJson.retryable, true);
  // ⑤ id 回显不一致 ⇒ 拿到的不是问的那张单，落到磁盘之前挡下来
  const swapped = await qqChannel(qqBody({ count: 3, echo: '9999999999' })).source.call({ action: 'detail', id: QQ_BODY_ID });
  assert.equal(swapped.ok, false, swapped.reason);
  assert.match(swapped.reason, /不一致.*没有落盘/, swapped.reason);
  // ⑥ 非数字 id：**零出网**（不去替上游试参数）
  const badId = await qqChannel(qqBody({}));
  assert.equal((await badId.source.call({ action: 'detail', id: '3714550625/../x' })).ok, false);
  assert.equal(badId.fetcher.calls.length, 0, 'id 形状不对就在这儿停，一次接口都不问');
  assert.equal(qqPlaylistQueryFor('abc'), null);
  assert.equal(qqPlaylistQueryFor('1234567890123456789012345678901234'), null, '超过 20 位的数字串不收（不是数字长度问题，是这家的 id 就没这么长）');
});

test('R138 一次导入只打一次接口：detail 与 tracks 共用那一格缓存（实测一张单 2.4MB）', async () => {
  const clock = { t: 1_000_000 };
  const fetcher = fakeQqFetch(qqBody({ count: 4 }));
  const source = createQqPlaylistSource({ fetcher, now: () => clock.t });
  await source.call({ action: 'detail', id: QQ_BODY_ID });
  const tracks = await source.call({ action: 'tracks', id: QQ_BODY_ID, offset: 0, limit: 4 });
  assert.equal(fetcher.calls.length, 1, '两问一次出网：不缓存就是把同一份 2,405,719B 下载两遍');
  assert.equal(tracks.items.length, 4);
  clock.t += 61_000;                                    // TTL 60s：缓存只买"少一笔出网"，不买陈旧
  await source.call({ action: 'detail', id: QQ_BODY_ID });
  assert.equal(fetcher.calls.length, 2, '过期之后要重取——不然用户删了一首歌永远看不见');
  // 换一张单不许命中上一张的缓存
  const other = fakeQqFetch(qqBody({ count: 2 }));
  const two = createQqPlaylistSource({ fetcher: other, now: () => clock.t });
  await two.call({ action: 'detail', id: '123456' });
  assert.equal(other.calls[0].url.includes('disstid=123456'), true);
});

test('R138 分页在本地切：这一家的接口认 song_begin 不认页大小（实测），回吐的 limit 必须是真页大小', async () => {
  const many = await qqChannel(qqBody({ count: 12 }));
  const first = await many.source.call({ action: 'tracks', id: QQ_BODY_ID, offset: 0, limit: 5 });
  assert.equal(first.items.length, 5);
  assert.equal(first.limit, 5, '回吐问出去并被夹过之后的页大小；回吐成"这页几条"会让导入器把"到底了"判成"页没满"');
  assert.equal(first.offset, 0);
  assert.equal(first.total, 12, '这一家一次给整张单，total 就是数组长度');
  const second = await many.source.call({ action: 'tracks', id: QQ_BODY_ID, offset: 5, limit: 5 });
  assert.deepEqual(second.items.map((i) => i.title), ['曲目 5', '曲目 6', '曲目 7', '曲目 8', '曲目 9'], '接着切，不重不漏');
  const tail = await many.source.call({ action: 'tracks', id: QQ_BODY_ID, offset: 10, limit: 5 });
  assert.equal(tail.items.length, 2, '末尾不足一页如实给两条');
  const over = await many.source.call({ action: 'tracks', id: QQ_BODY_ID, offset: 99, limit: 5 });
  assert.equal(over.items.length, 0, '越界给空数组：导入侧按"接口到底了"收尾');
  // 问得比上限大 ⇒ 夹到 QQ_PAGE_LIMIT（这一家的页大小本来就等于导入上限）
  const wide = await qqChannel(qqBody({ count: 3 }));
  assert.equal((await wide.source.call({ action: 'tracks', id: QQ_BODY_ID, offset: 0, limit: 99999 })).limit, QQ_PAGE_LIMIT);
});

test('R138 导入一张 QQ 歌单：1534 条落 1000 条、截断写进文件、零身份段、来历 qq-playlist、一次桥都不碰', async () => {
  await withStore(async (store) => {
    const bridge = fakeKugouBridge({});
    const { source, fetcher } = qqChannel(qqBody({ count: 1534 }));
    const got = await createPlaylistImporter({ bridge, store, qq: source })
      .import({ text: 'https://i2.y.qq.com/n3/other/pages/details/playlist.html?hosteuin=一串不透明的分享参数&id=3714550625' });
    assert.equal(got.ok, true, JSON.stringify(got));
    assert.equal(got.provider, 'qq');
    assert.equal(got.items, 1000);
    assert.equal(got.total, 1534);
    assert.equal(got.truncated, true);
    assert.match(got.warning, /共 1534 条，只导入前 1000 条（这个上限是本工具继承的，不是接口给的）/, got.warning);
    const saved = await store.get(got.id);
    assert.equal(saved.items.length, 1000, '回执条数 == 磁盘上读回来的条数');
    assert.match(saved.text, /# qq-playlist 3714550625 imported \d{4}-\d{2}-\d{2}T/, '来历写的是这一家与这个 id');
    assert.match(saved.text, /# truncated 共 1534 条，只导入前 1000 条/);
    assert.equal(saved.text.includes('on:'), false, '统一不写身份段（批复②）');
    // 隐私：文件里不许出现分享链接的那串参数，也不许出现歌单主的身份字段
    assert.equal(saved.text.includes('hosteuin'), false);
    assert.equal(saved.text.includes('NICK_CANARY'), false);
    assert.equal(saved.text.includes('qlogo'), false);
    // 一条通路（R114）：QQ 全程不碰桥
    assert.equal(bridge.calls.length, 0, 'QQ 不经桥：桥里没有它的后端');
    assert.equal(fetcher.calls.length, 1, 'detail 与 tracks 两问，真出网只有一笔（第二问命中那一格缓存）');
  });
});

test('R138 少掉的条数要说出来：上游 40 条里有 2 条没曲名 ⇒ 落 38 条并报 dropped', async () => {
  await withStore(async (store) => {
    const rows = Array.from({ length: 40 }, (unused, index) => qqSongRow(index)).map((row, index) => (index < 2 ? { ...row, name: '' } : row));
    const { source } = qqChannel(qqBody({ count: 40, songlist: rows }));
    const got = await createPlaylistImporter({ store, qq: source }).import({ text: QQ_BODY_ID_LINK });
    assert.equal(got.ok, true, JSON.stringify(got));
    assert.equal(got.items, 38);
    assert.equal(got.dropped, 2, '上游报 40、落成 38 ⇒ 差的那两条必须是说出来的');
    assert.match(got.warning, /上游报 40 条，2 条没能导进来/, got.warning);
    const saved = await store.get(got.id);
    assert.equal(saved.items.length, got.items, '恒等式：回执与磁盘一致');
  });
});

test('R138 主机表收敛在一台：c.y.qq.com 是 exact、没有后缀，QQ 的其它域照旧被拒', async () => {
  assert.equal(PLAYLIST_HOSTS.has('c.y.qq.com'), true);
  assert.equal(PLAYLIST_HOSTS.has('y.qq.com'), false, '主域不进表：进了等于整个腾讯域都能打');
  assert.equal(PLAYLIST_HOSTS.size, 1, '这张表今天只服务一条端点 ⇒ 多一个名字都要实测换来');
  assert.equal(assertAllowedTarget(QQ_PLAYLIST_URL, PLAYLIST_HOSTS).hostname, 'c.y.qq.com');
  for (const rejected of ['https://y.qq.com/qzone/fcg-bin/fcg_ucc_getcdinfo_byids_cp.fcg',
    'https://c.y.qq.com.evil.test/qzone/fcg-bin/fcg_ucc_getcdinfo_byids_cp.fcg',
    'http://c.y.qq.com/qzone/fcg-bin/fcg_ucc_getcdinfo_byids_cp.fcg',
    'https://127.0.0.1:8080/qzone', 'https://c.y.qq.com:8443/qzone']) {
    assert.throws(() => assertAllowedTarget(rejected, PLAYLIST_HOSTS), /ONLINE_TARGET_REJECTED/, `${rejected} 必须被拒`);
  }
  // 这张表是**新增的一档**，不是把既有那几档撑大：默认那张仍然只有歌词两家
  assert.deepEqual([...ONLINE_HOSTS].sort(), ['amll-ttml-db.stevexmh.net', 'u.y.qq.com']);
  // 量测留下的事实：`u.y.qq.com` 打不到这条端点 ⇒ 它不在新表里，新主机也不在旧表里（各档互不越界）
  assert.equal(PLAYLIST_HOSTS.has('u.y.qq.com'), false, 'u.y.qq.com 归歌词与登录那两档，歌单这一档不给它');
});

test('R138 接线面：门面装配在服务器里、审计表有中文那一档、界面提示补了手机分享那一种', async () => {
  const server = await readScript('music-server.mjs');
  // 判据钉的是"生产装配处必须把 QQ 那一条通道接上"，不是某一行的写法：
  // R155 给这个调用多传了一个 `resolveShortLink`（改成多行）之后，原来那条钉整行文本的判据
  // 把一次正常扩展判成了回归——本仓已经为这类判据改过两次（R127 的按钮清单、Q26 的来源名）。
  const importerWiring = /createPlaylistImporter\(\{([\s\S]*?)\}\)/.exec(server)?.[1] ?? '';
  assert.ok(importerWiring.length > 40, `没抓到装配导入器的那一段：${importerWiring.length}`);
  assert.match(importerWiring, /qq: createQqPlaylistSource\(\)/,
    'QQ 通道必须在生产装配处接上（漏这一行 = 认得链接却永远回 bridge-off）');
  assert.match(server, /import \{ createQqPlaylistSource \} from '\.\/playlist-qq\.mjs'/);
  const app = await read('src/music-app.ts');
  assert.match(app, /\n\s*playlist: "歌单导入",/, '审计表里要有这一档：新 kind 不落中文名就等于显示成"未标注用途"');
  assert.match(app, /纯数字按网易认/, '界面要说出这条边界：贴一个裸数字会被当成网易 id 去问');
  // Q16 定案：两个上限各管各的，就得在用户看得见的地方各写一句（只在代码注释里写等于没写）
  assert.match(app, /一次导入最多取 1000 条曲目/, '导入取数上限写进入口说明');
  assert.match(app, /歌单文本文件最多写 2000 行/, '文件行数上限写进入口说明');
  assert.match(app, /两个数各管各的/, '要说清它们不是一回事（这一条先前就被混过一次）');
  const guard = await readScript('online-guard.mjs');
  assert.match(guard, /export const MAX_PLAYLIST_BODY_BYTES = 8 \* 1024 \* 1024/);
  assert.match(guard, /export const PLAYLIST_HOSTS = new Set\(\['c\.y\.qq\.com'\]\)/);
  assert.match(guard, /export const ONLINE_PLAYLIST_TIMEOUT_MS = 20_000/);
});

test('R138 酷狗 gcid_ 形态：R158 起改走分享页那一路（只给首屏），specialid 那条说法照旧分开', async () => {
  // 用户在手机上分享出来的形状：主机 m.kugou.com、路径里是 `songlist/gcid_<token>/`。
  // R138 当时是"认得但拒导"，R158 换的是**取数据的页**（分享页 HTML 里注着首屏十首），
  // 曲目接口那一侧**仍然不认 gcid**（下面那半条桥的判据原样保留）⇒ 不要把它读成"整单能导了"。
  const mobile = parseImportInput('https://m.kugou.com/songlist/gcid_3zmyqeqhz2z018/?src_cid=3zmyqeqhz2z018&iszlist=1');
  assert.equal(mobile.kind, 'kugou-share', '这一条现在走分享页那一路（回执里会写明只取到首屏）');
  assert.equal(mobile.token, 'gcid_3zmyqeqhz2z018');
  assert.doesNotMatch(JSON.stringify(mobile), /error/, '认得且能导 ⇒ 不再回一句拒绝');
  // m.kugou.com 本就在识别集里（用户猜对了）：这条链接走到的是"酷狗"那一支而不是通用"认不出"
  assert.equal(parseImportInput('https://m.kugou.com/songlist/7687439/?src_cid=7687439').error.includes('specialid'), true,
    '同一台主机上的 specialid 形仍走 specialid 那条说法 ⇒ 证明主机认得、只是 id 形态分两种');
  // 带 collection_ 的链接照旧能导：先按 id 形状认（它在整个文本里扫），不被域名分支拦下
  assert.equal(parseImportInput('https://m.kugou.com/songlist/collection_1_1341266283_964007_0/').kind, 'kugou-id');
  // 桥那一侧：gcid 在碰包之前就被挡下（零 invoke），且理由是 gcid 那一条
  const { registerPlaylistRoutes } = await import('./bridge/playlist-routes.mjs');
  const invoke = [];
  const routes = new Map();
  registerPlaylistRoutes({
    routes,
    backends: { kugou: { state: 'ready', invoke: async (operation, params) => { invoke.push({ operation, params }); return { status: 200, body: { data: [] } }; } } },
    fetchImpl: async () => ({ text: async () => '{}' }),
  });
  const got = await routes.get('/bridge/playlist')({ provider: 'kugou', action: 'detail', id: 'gcid_3zmyqeqhz2z018' });
  assert.equal(got.ok, false);
  assert.match(got.reason, /gcid_/, got.reason);
  assert.match(got.reason, /collection_1_1341266283_964007_0/, got.reason);
  assert.equal(got.retryable, false, '形状不对重试一百次还是同一个形状');
  assert.equal(invoke.length, 0, '零出网：不拿"注定读不到"的 id 去问上游');
  // 两个文件里都得留着这条分叉：删掉它，表现会退化成手机用户看到"认不出这张歌单"
  const routesSrc = await readScript('bridge/playlist-routes.mjs');
  assert.match(routesSrc, /const looksGcid = \/\^gcid_\[\\w-\]\{4,60\}\$\//);
  assert.match(await readScript('playlist-import.mjs'), /if \(\/\^gcid_\[\\w-\]\{4,60\}\$\/\.test\(id\)\) \{/);
});

test('R146 徽标：借来的图要说得出来源，而且不新增格子（第五列会撑坏网格）', async () => {
  const ui = await read('src/playlists-ui.ts');
  assert.match(ui, /coverFrom\?: string \| null/, '界面契约里有这一格');
  assert.match(ui, /封面来自 \$\{providerName\(item\.coverFrom\)\}/, '徽标里要说"封面来自 X"');
  assert.match(ui, /item\.coverFrom && item\.coverFrom !== item\.track\.provider/,
    '只有真的来自另一家才说这句（正路自己给图时不许冒出来）');
  assert.match(ui, /ONLINE_PROVIDER_LABELS\[value as OnlineProvider\]/,
    '来源中文名读歌词那一侧的共享表：自己再写一份三元，第四家进来时就会露出内部名（R150 顺带补的既有缺口）');
  // 行内格子数必须还是五个：R129 那一课是"多一个 span 就多一列，rect 全绿、截图才发现挤行"。
  const row = /return `<div class="playlist-entry"[\s\S]*?<\/div>`;/.exec(ui)?.[0] ?? '';
  assert.ok(row.length > 200, `没抓到详情行的 markup：${row.length}`);
  assert.equal((row.match(/class="playlist-entry-/g) ?? []).length, 5, '详情行的格子数不许变');
  // 墙上那颗按钮：回执里也要带来源，界面才说得出图是谁给的
  const app = await read('src/music-app.ts');
  assert.match(app, /coverFrom\?: string/, '重取封面的回执类型里有这一格');
  assert.match(app, /durationMs: Number\(detail\.durationMs \?\? 0\)/, '按钮要把时长送上去（没送就没有回落的证据）');
  assert.match(app, /这张图是 \$\{/, '补到借来的图时提示里要说明来源');
  const server = await readScript('music-server.mjs');
  assert.match(server, /const borrowed = same \? null : [\s\S]{0,200}coverFallbackOk\(/,
    '「重取封面」也走同一条回落判据（先有正路，正路没有才借）');
  assert.match(server, /coverRef: picked\.coverRef, coverFrom: borrowed\?\.provider \?\? null/,
    '写回 sidecar 时来源要一起落，不然界面说不清');
});

// ── R155（任务二）：酷狗"口令短链"导入 ────────────────────────────────────────
// 一手实测（2026-10-10，探针 `t2-shortlink-probe*.mjs`）：
//   `https://t1.kugou.com/2jpQB35G6V2` → **302**，Location =
//   `https://activity.kugou.com/share/v-a00a45b0/index.html?u=<歌单主 userid>&h1=…&specialid=-2147483648
//    &global_specialid=collection_3_2502594575_2_0&cType=0`
//   ⇒ 我们要的那一个 id 就在查询串里；`specialid` 是哨兵负数（R137 早已量过它推不出 collection id）；
//   `u=` 是别人的身份线索 ⇒ 一个字节都不许落盘。Node 的 `redirect:'manual'` 给 302 + location 头
//   （`follow` 才是我们不要的那种"自动去一个没校验过的地方"）。

const { kugouCollectionIdFromTarget } = await import('./playlist-import.mjs');
const MEASURED_LOCATION = 'https://activity.kugou.com/share/v-a00a45b0/index.html?u=2502594575&h1=324006092178437649623881753444441216798&h2=-&specialid=-2147483648&global_specialid=collection_3_2502594575_2_0&cType=0';

/** 酷狗那一路的假桥复用 R137 那一份（`fakeKugouBridge`）——两处各写一份夹具正是"夹具会分家"的起点。 */

test('R155 短链识别：认形状、不猜令牌；已解析过的分享链接零出网就能导', () => {
  const short = parseImportInput('https://t1.kugou.com/2jpQB35G6V2');
  assert.equal(short.kind, 'kugou-shortlink');
  assert.equal(short.provider, 'kugou');
  assert.equal(short.url, 'https://t1.kugou.com/2jpQB35G6V2', '交出去的是规范化的那一串（不带尾巴斜杠与前后文字）');
  // 带一句中文推荐语的分享口令形态：只取里面那条 URL
  const withText = parseImportInput('我在酷狗分享了一张歌单，长按复制打开 https://t1.kugou.com/AbCdEf123x 看看');
  assert.equal(withText.kind, 'kugou-shortlink');
  assert.equal(withText.url, 'https://t1.kugou.com/AbCdEf123x');
  // 形状不对的 t1 链接不许被当成短链去问（"猜一个令牌"正是本仓最贵的那类错误）
  const odd = parseImportInput('https://t1.kugou.com/not-a-token!');
  assert.equal(odd.kind, 'unknown');
  assert.match(odd.error, /不像短链令牌/);
  // 已经解析过的分享链接：id 就在文本里 ⇒ 走 kugou-id，一次网都不问
  assert.equal(parseImportInput(MEASURED_LOCATION).kind, 'kugou-id');
  assert.equal(parseImportInput(MEASURED_LOCATION).id, 'collection_3_2502594575_2_0');
});

test('R155 kugouCollectionIdFromTarget：只取那一个 id，哨兵 specialid 与别人的 u= 一概不算', () => {
  assert.deepEqual(kugouCollectionIdFromTarget(MEASURED_LOCATION), { ok: true, id: 'collection_3_2502594575_2_0' });
  // specialid=-2147483648 是上游给的哨兵（R137 量过它推不出 collection id）⇒ 不许被当成 id
  assert.equal(kugouCollectionIdFromTarget('https://activity.kugou.com/share/x/index.html?specialid=-2147483648&u=1').ok, false);
  assert.match(kugouCollectionIdFromTarget('https://activity.kugou.com/share/x/index.html?specialid=-2147483648').reason, /没有酷狗歌单 id/);
  // gcid_ 那一族（R138 量过读不到）也不许被短链这条路放行
  assert.equal(kugouCollectionIdFromTarget('https://activity.kugou.com/songlist/gcid_2_xxx').ok, false);
  // 空/乱输入不抛
  assert.equal(kugouCollectionIdFromTarget('').ok, false);
  assert.equal(kugouCollectionIdFromTarget(undefined).ok, false);
});

test('R155 端到端：短链 → 一跳 → 导成文本歌单；条数与来历如实，且那条外部地址与 u= 一个字节都不落盘', async () => {
  await withStore(async (store) => {
    const bridge = fakeKugouBridge({ count: 3 });
    const asked = [];
    const svc = createPlaylistImporter({
      bridge, store,
      resolveShortLink: async (url) => { asked.push(url); return MEASURED_LOCATION },
    });
    const got = await svc.import({ text: 'https://t1.kugou.com/2jpQB35G6V2' });
    assert.equal(got.ok, true, JSON.stringify(got));
    assert.equal(got.source, 'kugou-shortlink', '回执要说清这是从短链认出来的');
    assert.equal(got.items, 3);
    assert.deepEqual(asked, ['https://t1.kugou.com/2jpQB35G6V2'], '只问一跳');
    assert.equal(bridge.calls[0].action, 'detail');
    assert.equal(bridge.calls[0].id, 'collection_3_2502594575_2_0', '经桥问的是那一个 id，不是短链');
    const saved = await store.get(got.id);
    assert.match(saved.text, /# kugou-playlist collection_3_2502594575_2_0 imported \d{4}-\d{2}-\d{2}T/, '来历只写 id');
    assert.equal(saved.items.length, 3, '磁盘上真正读回来的条数是唯一口径');
    // 三条"不许在这里出现"：短链令牌、跳转后的整条地址、歌单主的 userid 参数
    for (const leaked of ['2jpQB35G6V2', 'activity.kugou.com', 'u=2502594575', 'global_specialid', 'specialid']) {
      assert.equal(saved.text.includes(leaked), false, `歌单文件里不许出现「${leaked}」`);
    }
    assert.equal(JSON.stringify(got).includes('activity.kugou.com'), false, '回执里也不许带那条第三方地址');
  });
});

test('R155 那一跳坏掉的三种形状各给一句实话（不悄悄当文本导入、不伪装成"这张单是空的"）', async () => {
  await withStore(async (store) => {
    const bridge = fakeKugouBridge();
    const noResolver = await createPlaylistImporter({ bridge, store }).import({ text: 'https://t1.kugou.com/2jpQB35G6V2' });
    assert.equal(noResolver.ok, false);
    assert.match(noResolver.error, /本机现在不做这一跳/, '没装门面（在线关着）要说清是没做这一跳');
    assert.equal(bridge.calls.length, 0, '这一档连桥都不该碰');

    const threw = await createPlaylistImporter({ bridge, store, resolveShortLink: async () => { throw new Error('DNS 没解析到') } })
      .import({ text: 'https://t1.kugou.com/2jpQB35G6V2' });
    assert.equal(threw.ok, false);
    assert.match(threw.error, /没问通[\s\S]*DNS/, '把上游那句原因带出来，不写成"歌单不存在"');

    const empty = await createPlaylistImporter({ bridge, store, resolveShortLink: async () => '' })
      .import({ text: 'https://t1.kugou.com/2jpQB35G6V2' });
    assert.equal(empty.ok, false);
    assert.match(empty.error, /没有回跳转地址/);

    const noId = await createPlaylistImporter({ bridge, store, resolveShortLink: async () => 'https://activity.kugou.com/share/x/index.html?cType=0' })
      .import({ text: 'https://t1.kugou.com/2jpQB35G6V2' });
    assert.equal(noId.ok, false);
    assert.match(noId.error, /没有酷狗歌单 id/);
    assert.equal(bridge.calls.length, 0, '读不出 id 就不许去问歌单（问了也是一句"这张单不存在"的假话）');
  });
});

test('R155 出网层：短链主机表恰好一个名字、只读 Location 不自动跟随、老调用点返回形状逐字不变', async () => {
  const guard = await import('./online-guard.mjs');
  assert.deepEqual([...guard.SHORTLINK_HOSTS.exact], ['t1.kugou.com'], '加一个名字就要一次实测（后缀表也必须空：*.kugou.com 会把设备注册与签名网关一起放进来）');
  assert.deepEqual(guard.SHORTLINK_HOSTS.suffix, []);

  const seen = [];
  const fakeFetcher = async (url, init) => {
    seen.push({ redirect: init.redirect, credentials: init.credentials });
    return {
      ok: false, status: 302, redirected: false,
      headers: { get: (name) => (name.toLowerCase() === 'location' ? MEASURED_LOCATION : null), contentLength: null },
      body: null,
    };
  };
  const response = await guard.guardedFetch('https://t1.kugou.com/2jpQB35G6V2', {
    hosts: guard.SHORTLINK_HOSTS, kind: 'playlist', fetcher: fakeFetcher,
    lookup: async () => [{ address: '120.233.110.105' }], readRedirectLocation: true,
  });
  assert.equal(response.redirectLocation, MEASURED_LOCATION, '显式要才有这一格');
  assert.equal(seen[0].redirect, 'manual', 'manual = 只读头不跟随；follow 就是"自动去一个没校验过的地方"');
  assert.equal(seen[0].credentials, 'omit', '这一跳同样不带凭据');

  // 2xx 时即使开了开关也**不给这一格**："这一跳不是重定向"与"重定向的目标是空"是两件事
  // （后者会被读成"上游说没有"，而导入器那句实话就变成假话）。
  const notRedirect = await guard.guardedFetch('https://t1.kugou.com/2jpQB35G6V2', {
    hosts: guard.SHORTLINK_HOSTS, kind: 'playlist', readRedirectLocation: true,
    lookup: async () => [{ address: '120.233.110.105' }],
    fetcher: async () => ({ ok: true, status: 200, headers: { get: () => null, contentLength: null }, body: null }),
  });
  assert.equal('redirectLocation' in notRedirect, false, '200 不给 redirectLocation 这个键');

  // 默认（不开这个开关）返回形状逐字不变：既没有 redirectLocation，也不许变成 manual
  const defaults = [];
  const defaultFetcher = async (url, init) => {
    defaults.push(init.redirect);
    return { ok: true, status: 200, headers: { get: () => null, contentLength: null }, body: null };
  };
  const plain = await guard.guardedFetch('https://u.y.qq.com/cgi-bin/musicu.fcg', { fetcher: defaultFetcher, lookup: async () => [{ address: '1.1.1.1' }] });
  assert.equal('redirectLocation' in plain, false, '老调用点的返回形状不许多一个键');
  assert.equal(defaults[0], 'error', '判据④"禁重定向"对所有既有调用点原样生效');
});


// ── R158（任务五）· 酷狗手机分享页导入：只给首屏，且这句话必须处处说得出 ──────────
// 非移植（原版没有"读手机分享页 HTML"这一条）。夹具只造形状，字段名与嵌套照 2026-10-10 四轮实测。
// 隐私：token 用短的假值；真人身份那几格填明显是假的标记，用来当 canary。

const shareModule = await import('./playlist-kugou-share.mjs');
const { kugouShareUrlFor, extractShareOutput, kugouShareToImport, createKugouShareSource, KUGOU_SHARE_TOKEN } = shareModule;

/** 实测形状：`window.$output = {…}; </script><script>window.$output=window.$output||{}</script><script>function …` */
const shareHtml = (output) => '<!DOCTYPE html><html><head><meta charset="UTF-8"><title>歌单</title></head><body>'
  + `<script>window.\$output = ${JSON.stringify(output)}; </script>`
  + '<script>window.$output=window.$output||{}</script><script>function getSonglistName(){var t=window.$output}</script>'
  + '</body></html>';

const shareSong = (index) => ({
  name: index % 2 ? `夹具歌手${index}、某人 - 夹具曲名${index}` : `夹具歌手${index} - 夹具曲名${index}`,
  singerinfo: index % 2
    ? [{ name: `夹具歌手${index}`, id: 1, avatar: 'http://singerimg.invalid/a.jpg' }, { name: '某人', id: 2 }]
    : [{ name: `夹具歌手${index}`, id: 1 }],
  albuminfo: { name: `夹具专辑${index}`, id: 100 + index },
  timelen: 231915 + index,
  hash: `FIXTUREHASH${index}`,
  audio_id: 900 + index,
  user_id: 54321,
  fileid: 'FILEID-SHOULD-NOT-LEAK',
  cover: 'http://imge.invalid/cover.jpg',
});
const shareOutput = (over = {}) => ({
  encode_gic: 'gcid_fixture01',
  info: {
    comments: [],
    listinfo: {
      name: '夹具分享单', count: 898, heat: 8370, is_def: 2, is_pri: 0, is_drop: 0, is_publish: 1,
      specialid: 0, type: 0, global_collection_id: '', intro: '',
      list_create_gid: '', list_create_userid: 1234567890, list_create_username: '夹具主',
      create_user_pic: 'http://imge.invalid/avatar.jpg', pic: 'http://imge.invalid/playlist.jpg',
      musiclib_tags: [], trans_param: { iden: 0 }, no_show_gid: 1, collect_count: 0, comment_count: 0,
    },
    songs: Array.from({ length: 10 }, (unused, index) => shareSong(index)),
  },
  global_collection_id: '', encode_src_gid: 'gcid_fixture01', src_gid: '', copy_gid: '',
  ...over,
});

test('R158 识别：整条链接、带查询串、裸 token 三种写法都认；形状不对的裸串不去问', () => {
  const link = parseImportInput('https://m.kugou.com/songlist/gcid_fixture01/');
  assert.equal(link.kind, 'kugou-share');
  assert.equal(link.token, 'gcid_fixture01');
  const query = parseImportInput('看看这个 https://m.kugou.com/songlist/gcid_fixture01/?from=app 谢谢');
  assert.equal(query.kind, 'kugou-share', '微信里粘出来的常带一句中文与查询串，不能被当成文本歌单');
  const bare = parseImportInput('gcid_fixture01');
  assert.equal(bare.kind, 'kugou-share', '也有人只把那段 token 贴过来');
  // 形状不对 ⇒ 不出网（实测 `not-a-token` 那一页是 200 + **0 字节**，问它就是白问一次）
  for (const bad of ['gcid_x', 'gcid_@@@@@@@@@@@@', 'collection_1_2_3_4']) {
    const got = parseImportInput(bad);
    if (bad.startsWith('gcid_')) {
      assert.notEqual(got.kind, 'kugou-share', `${bad} 不该被当成分享 token`);
      assert.equal(KUGOU_SHARE_TOKEN.test(bad), false);
    }
  }
  // 别的主机带 gcid_ 形状 ⇒ 也不给这一条路（**地址由 token 拼，用户贴的主机不作数**）
  const otherHost = parseImportInput('https://evil.example.com/songlist/gcid_fixture01/');
  assert.notEqual(otherHost.kind, 'kugou-share');
  assert.equal(KUGOU_SHARE_TOKEN.test('gcid_fixture01'), true, '形状本身：gcid_ + 4~60 位');
});

test('R158 取那段注入的 JSON：按括号配平切，尾部还有第二个赋值也切得干净', () => {
  const parsed = extractShareOutput(shareHtml(shareOutput()));
  assert.equal(parsed?.info?.listinfo?.count, 898, '实测那一行 parse 会在配平处之后报错，这里必须拿得到');
  // 字符串里的大括号与转义引号不许把配平带偏（实测标题里就有 `(` 与 `《》` 这类字符）
  const tricky = { info: { listinfo: { name: '带 } 与 " 的标题 {不配平试试}', count: 3 }, songs: [] } };
  assert.equal(extractShareOutput(shareHtml(tricky)).info.listinfo.name, '带 } 与 " 的标题 {不配平试试}');
  assert.deepEqual(extractShareOutput(shareHtml({})), {}, '空对象照样解析得出来（是不是"读不到"由下一层判）');
  assert.equal(extractShareOutput('<html>没有那段赋值</html>'), null);
  assert.equal(extractShareOutput('window.$output = {不是 JSON}'), null, 'parse 失败给 null，不抛');
  assert.equal(extractShareOutput('window.$output = {"a":1'), null, '正文被截断（那段字面量自己不闭合）⇒ null，不猜半个对象');
  assert.deepEqual(extractShareOutput('window.$output = {"a":1} 后面还有东西 {"b":2'), { a: 1 },
    '尾部再出现半个花括号不影响：切的是**第一个配平的**那一段（实测那一行后面就是 `; </script><script>…`）');
  assert.equal(extractShareOutput('window.$output  // 隔太远\n' + 'x'.repeat(300) + ' = {"a":1}'), null,
    '`window.$output` 与 `{` 之间只允许一个赋值号与空白（别的形状一律不猜）');
});

test('R158 字段白名单就是这个函数本身：真人身份与第三方图片地址一律出不去', () => {
  const ok = kugouShareToImport(extractShareOutput(shareHtml(shareOutput())));
  assert.equal(ok.ok, true);
  assert.equal(ok.name, '夹具分享单');
  assert.equal(ok.count, 898);
  assert.equal(ok.items.length, 10);
  assert.equal(ok.wholeListReadable, false, '两处 collection id 都是空串 ⇒ 整单读不到这件事要带得出去');
  assert.equal(ok.items[0].title, '夹具曲名0', 'name 是"歌手 - 曲名"连笔，只在整串以歌手列表开头时才剥');
  assert.equal(ok.items[1].title, '夹具曲名1', '多歌手用顿号连的那一行也要剥干净（R137 真机量到的错）');
  assert.equal(ok.items[1].artist, '夹具歌手1 / 某人', '对外与网易那一路统一用 " / "');
  assert.equal(ok.items[0].durationMs, 231915, 'timelen 已经是毫秒，不再乘 1000');
  const leaked = JSON.stringify(ok);
  for (const canary of ['1234567890', '夹具主', 'create_user_pic', 'list_create_user', 'imge.invalid', 'singerimg.invalid',
    'FILEID-SHOULD-NOT-LEAK', 'http://', 'heat', 'trans_param']) {
    assert.equal(leaked.includes(canary), false, `白名单漏了「${canary}」：这一格会跟着进文件与回执`);
  }
  // 三句"读不到"分开说（实测没有 404，只有这四个标记位）
  assert.match(kugouShareToImport({ info: { listinfo: { is_pri: 1 }, songs: [] } }).reason, /私有/);
  assert.match(kugouShareToImport({ info: { listinfo: { is_drop: 1 }, songs: [] } }).reason, /已被删除/);
  assert.match(kugouShareToImport({ info: { listinfo: { is_publish: 0 }, songs: [] } }).reason, /未发布/);
  // "没给 songs" ≠ "songs 是空的"（与网易/酷狗那两条同形判据）
  assert.match(kugouShareToImport({ info: { listinfo: { name: 'x', count: 5 } } }).reason, /不是"空的"，是"没给"/);
  assert.equal(kugouShareToImport({ info: { listinfo: { name: 'x', count: 0 }, songs: [] } }).ok, true,
    '真·空单要能导（0 条 + 共 0 条），不许报"读不到"');
  assert.match(kugouShareToImport({}).reason, /空对象/, '实测无效 token 就是 `window.$output ={};` ⇒ 这句要指名');
  assert.equal(kugouShareToImport(null).ok, false);
});

test('R158 端到端：导首屏十条、来历写 token、文件与回执都明写"共 898 只取到 10"', async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'rhine-kugou-share-'));
  try {
    const store = await new PlaylistStore({ dataDir }).init();
    const asked = [];
    const share = createKugouShareSource({
      fetchHtml: async (url) => { asked.push(url); return { status: 200, text: shareHtml(shareOutput()) } },
    });
    assert.deepEqual(asked, [], '构造门面不出网');
    const got = await createPlaylistImporter({ store, share })
      .import({ text: 'https://m.kugou.com/songlist/gcid_fixture01/' });
    assert.equal(got.ok, true, JSON.stringify(got));
    assert.equal(got.source, 'kugou-share');
    assert.equal(asked.length, 1, '一次导入一跳');
    assert.equal(asked[0], 'https://m.kugou.com/songlist/gcid_fixture01/',
      '出去的地址由 token 拼出来（固定模板），不是用户贴进来的那条');
    assert.equal(got.items, 10);
    assert.equal(got.total, 898, '总数是整单的总数，不是"这张单只有 10 首"');
    assert.equal(got.truncated, false, '`truncated` 留给 1000 条那个上限（Q16：两个数各管各的）');
    assert.equal(got.firstScreen, true);
    assert.match(got.warning, /共 898 条/);
    assert.match(got.warning, /手机分享链接读不到整单/);
    const file = await readFile(store.fileOf(got.id), 'utf8');
    const lines = file.split('\n');
    assert.match(lines[1], /^# kugou-playlist gcid_fixture01 imported \d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/,
      '来历那一行由共用的写侧助手给（格式与网易/QQ/短链那三路逐字相同，时间戳不逐字比）');
    assert.match(file, /^# 首屏 10 条（这张单共 898 条/m, '文件里也要写明，用户半年后打开还看得懂');
    assert.equal((file.match(/^[^#]/gm) ?? []).filter((line) => line.trim()).length, 10);
    assert.equal(file.includes('on:'), false, '沿用批复②：不写身份段');
    for (const canary of ['1234567890', '夹具主', 'imge.invalid', 'FILEID-SHOULD-NOT-LEAK', 'http://', 'gcid_3zm']) {
      assert.equal(file.includes(canary), false, `文件里出现了「${canary}」`);
      assert.equal(JSON.stringify(got).includes(canary), false, `回执里出现了「${canary}」`);
    }
    // 读回来还是十条（写侧与读侧对得上，R137 那条竖线教训的同一判据）
    const back = await store.get(got.id);
    assert.equal(back.items.length, 10);
    assert.equal(back.items[0].title, '夹具曲名0');
  } finally { await rm(dataDir, { recursive: true, force: true }) }
});

test('R158 失败形状各给一句实话，且都不写文件', async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'rhine-kugou-share-bad-'));
  try {
    const store = await new PlaylistStore({ dataDir }).init();
    const run = async (fetchHtml) => await createPlaylistImporter({ store, share: createKugouShareSource({ fetchHtml }) })
      .import({ text: 'gcid_fixture01' });
    const empty = await run(async () => ({ status: 200, text: shareHtml({}) }));
    assert.equal(empty.ok, false);
    assert.match(empty.error, /空对象/);
    const moved = await run(async () => ({ status: 302, text: '' }));
    assert.equal(moved.ok, false);
    assert.match(moved.error, /HTTP 302/, '不带手机 UA 时上游就是 302 ⇒ 这句要指名（上一批"UA 不影响"的结论只在手机 UA 之间成立）');
    const threw = await run(async () => { throw new Error('DNS 没解析到') });
    assert.equal(threw.ok, false);
    assert.match(threw.error, /读分享页失败/, '通道坏不许翻成"这张单是空的"（错误适配器不许撒谎那条红线）');
    const noSource = await createPlaylistImporter({ store }).import({ text: 'gcid_fixture01' });
    assert.equal(noSource.ok, false);
    assert.match(noSource.error, /不读酷狗手机分享页/, '没接这一路时要说清，并且不假装成功');
    assert.deepEqual(await store.list(), [], '四种失败都不该留下半张歌单');
  } finally { await rm(dataDir, { recursive: true, force: true }) }
});

test('R158 出网层：主机表只有那一个名字、后缀为空、六道判据一道没少、UA 有出处', async () => {
  const guard = await import('./online-guard.mjs');
  assert.deepEqual([...guard.SHARE_HOSTS.exact], ['m.kugou.com'], '表里只放实测能给出数据的那一台');
  assert.deepEqual(guard.SHARE_HOSTS.suffix, [], '后缀表必须空：*.kugou.com 会把设备注册与签名网关放进来');
  assert.equal(guard.MAX_SHARE_BODY_BYTES, 2 * 1024 * 1024, '实测页 31,443B / 无效页 6,783B ⇒ 2 MiB 是几十倍余量');
  assert.equal(guard.SHARE_TIMEOUT_MS, 8000);
  assert.match(guard.KUGOU_SHARE_UA, /iPhone/, '手机 UA：不发就只拿得到 302 + 一个没有数据的桌面落地页（四轮实测）');
  assert.equal(guard.KUGOU_SHARE_UA.includes('register'), false, '这只是一个请求头，与设备身份那条授权无关');
  const source = await readScript('online-guard.mjs');
  const adapter = /export function guardedSharePageFetch[\s\S]*?\n}/.exec(source)?.[0] ?? '';
  assert.ok(adapter, '分享页那一跳有自己的适配器（不在调用点各写一份 guardedFetch 参数）');
  assert.match(adapter, /hosts: SHARE_HOSTS/);
  assert.match(adapter, /maxBytes: MAX_SHARE_BODY_BYTES/);
  assert.match(adapter, /kind: 'playlist'/);
  assert.equal(adapter.includes('readRedirectLocation'), false, '这一跳要的是正文，不是 Location（读了就成第二条短链路）');
  assert.match(source, /redirect: readRedirectLocation \? 'manual' : 'error'/, '默认仍禁自动跟随');
  assert.match(source, /credentials: 'omit'/, '不带凭据');
  // 分享页模块自己**不请求用户贴进来的地址**：地址唯一来源是 kugouShareUrlFor
  assert.equal(kugouShareUrlFor('gcid_fixture01'), 'https://m.kugou.com/songlist/gcid_fixture01/');
  for (const bad of ['gcid_x', 'https://evil.example.com/x', 'gcid_' + 'a'.repeat(80), '', null]) {
    assert.equal(kugouShareUrlFor(bad), null, `形状不对的「${String(bad)}」必须在出网前就拒掉`);
  }
  const shareSource = await readScript('playlist-kugou-share.mjs');
  assert.equal((shareSource.match(/guardedFetch\(/g) ?? []).length, 0,
    '这一路只经那个专用适配器出网，不在模块里直接调 guardedFetch（少一处参数抄错的机会）');
  assert.equal(shareSource.includes('eval('), false, '解析外部 HTML 只用 JSON.parse，不许 eval');
});

test('R158 接线：装配处接上这一路、入口文案写明"只给首屏"、导入器不自己出网', async () => {
  const server = await readScript('music-server.mjs');
  assert.match(server, /share: createKugouShareSource\(\)/, '装配处接上分享页那一路');
  const importer = await readScript('playlist-import.mjs');
  assert.match(importer, /kind: 'kugou-share'/);
  assert.match(importer, /importKugouShare\(input\.token/, '识别之后走那一个函数（不在 import() 里另写一条通路）');
  assert.equal(importer.includes('guardedSharePageFetch'), false, '导入器拿的是注入的门面，自己不碰出网层');
  const app = await read('src/music-app.ts');
  assert.match(app, /只能导分享页里的\*\*首屏十首\*\*/, '入口就要说清只给首屏（不能等导完才发现少八百首）');
  assert.match(app, /m\.kugou\.com\/songlist\/gcid_/, 'placeholder 给一条能照抄的分享链接形状');
});


// ── R159（任务六）· 账号歌单：只读的一期（列 / 导入为文本），形状未真机量到 ⇒ 防御式映射 ──
// 这一组里**所有上游响应形状都是照包源码读的**（`module/user_playlist.js` 两处），不是量到的：
// 量它就必须用用户自己的账号，而取证纪律是"用户不在场时不碰他的凭据"。
// 所以判据钉的不是"网易一定给 playlist 这个键"，而是三件不依赖形状的事：
//   ① 没登录 ⇒ 零出网零 invoke，且理由说得出来；② 形状不认识 ⇒ 报"不认识"而不是猜着往下走；
//   ③ 无论形状如何，创建者身份与第三方封面地址都出不去。

const playlistProviders = await import('./bridge/providers/playlist.mjs');
const { accountPlaylistsToItems } = playlistProviders;
// 这一组直接测桥的那条路由（既有测试是在单个用例里临时 import，这里两处都要用 ⇒ 提到模块作用域一次）
const { registerPlaylistRoutes } = await import('./bridge/playlist-routes.mjs');

/** 桥的歌单路由夹具：网易走环回 HTTP（fetchImpl），酷狗走进程内直调（invoke）。 */
const makePlaylistRoutes = ({ ncmBody = null, ncmError = null, kugouBody = null, kugouError = null, cookieSeen = null } = {}) => {
  const routes = new Map();
  const fetchCalls = [];
  const invokes = [];
  registerPlaylistRoutes({
    routes,
    backends: {
      netease: { state: 'ready', baseUrl: 'http://127.0.0.1:1' },
      kugou: {
        state: 'ready',
        invoke: async (operation, params) => {
          invokes.push({ operation, params });
          if (kugouError) throw kugouError;
          return { status: 200, body: kugouBody ?? {} };
        },
      },
    },
    fetchImpl: async (url, init) => {
      fetchCalls.push({ url, headers: init?.headers ?? {} });
      if (ncmError) return { status: 500, text: async () => 'boom' };
      const path = String(url).replace('http://127.0.0.1:1', '');
      const body = typeof ncmBody === 'function' ? ncmBody(path) : ncmBody;
      return { status: 200, text: async () => JSON.stringify(body ?? {}) };
    },
  });
  return { route: routes.get('/bridge/playlist'), fetchCalls, invokes, cookieSeen };
};

test('R159 映射：认得的几种位置都挑得出数组；认不出的报"形状不认识"并把顶层键回显出来', () => {
  // R182：夹具换成**真机量到的形状**（`code:200` 与 `more` 同层），不再是"看着像"的那一份。
  const neteaseShape = { playlist: [{ id: 12345678, name: '我喜欢的音乐', trackCount: 201 }], more: true, code: 200 };
  const a = accountPlaylistsToItems(neteaseShape, 'netease');
  assert.equal(a.ok, true);
  assert.deepEqual(a.items, [{ provider: 'netease', id: '12345678', writeId: '12345678', name: '我喜欢的音乐', trackCount: 201 }],
    '网易两处同号：写侧那个 id 就是这张单自己的 id');
  assert.equal(a.hasMore, true, '网易的 more 要带出去，界面才知道"还有下一页"这件事有没有依据');
  // 酷狗那一份按 R182 真机原文（`data.info` 行内**显式带 `listid`**）：读侧用 global_collection_id、写侧用 listid。
  const kugouShape = { data: { info: [{ global_collection_id: 'collection_1_2_3_0', listid: 2, name: '酷狗单', count: 12 }] } };
  const b = accountPlaylistsToItems(kugouShape, 'kugou');
  assert.equal(b.ok, true);
  assert.equal(b.sourceField, 'data.info', '真机上那个数组落在 data.info（R182 量到，`data.list` 是旧兜底表）');
  assert.equal(b.items[0].id, 'collection_1_2_3_0', '酷狗只有 global_collection_id 能用来导曲目（R137 实测）');
  assert.equal(b.items[0].writeId, '2', '写侧要的是 listid（行里显式给的那一格），不是 collection id');
  assert.equal(b.items[0].trackCount, 12, '条数在酷狗这一家叫 count（R182 量到）');
  // 形状不认识 ⇒ 一句实话 + 顶层键（下一次真机量到就把那个位置补进表里，不是改判据）
  const unknown = accountPlaylistsToItems({ foo: 1, bar: [] }, 'netease');
  assert.equal(unknown.ok, false);
  assert.match(unknown.reason, /形状不认识/);
  assert.match(unknown.reason, /foo/, '把顶层键回显出来：没有这一格，下一次量测就只能靠猜');
  assert.equal(accountPlaylistsToItems(null, 'netease').ok, false);
  assert.equal(accountPlaylistsToItems(undefined, 'kugou').ok, false);
});

test('R159 白名单：创建者昵称与 userId、封面 URL 一律不出桥（这一条与形状无关，逐家都钉）', () => {
  const withIdentity = {
    playlist: [{
      id: 7, name: '某单', trackCount: 3,
      creator: { nickname: '张三丰', userId: 987654321, avatarUrl: 'http://p1.music.126.net/avatar.jpg' },
      coverImgUrl: 'http://p1.music.126.net/cover.jpg',
      subscribed: true, playCount: 42,
    }],
  };
  for (const provider of ['netease', 'kugou']) {
    const mapped = accountPlaylistsToItems(withIdentity, provider);
    const text = JSON.stringify(mapped);
    assert.equal(text.includes('张三丰'), false, `${provider}：创建者昵称出桥了`);
    assert.equal(text.includes('987654321'), false, `${provider}：创建者 userId 出桥了`);
    assert.equal(text.includes('http'), false, `${provider}：第三方封面地址出桥了（R116 那条红线不因为"只是列表页"让路）`);
    assert.equal(text.includes('playCount'), false, `${provider}：没打算用的字段就不该带（带一个就多一格会漂的）`);
  }
  // 行缺 id 或缺名字 ⇒ 跳过并**报第几行**，不静默少一行（少一截不说出来是本仓最忌的那类错）
  const partial = accountPlaylistsToItems({ playlist: [{ id: 1, name: '好' }, { name: '没有 id' }, { id: 3 }, null] }, 'netease');
  assert.equal(partial.items.length, 1);
  assert.deepEqual(partial.skipped, [1, 2, 3]);
  // 酷狗那一家：只有 specialid 的行**不能用**（R137 实测导不出曲目）⇒ 宁可跳过并报出来
  const onlySpecialid = accountPlaylistsToItems({ data: { list: [{ specialid: 555, name: '只有 specialid' }] } }, 'kugou');
  assert.equal(onlySpecialid.items.length, 0);
  assert.deepEqual(onlySpecialid.skipped, [0]);
});

test('R159 桥·网易 mine：没登录零出网；登录了先问 /user/account 拿 uid（uid 不外传）再问列表，cookie 只走请求头', async () => {
  const seen = [];
  const routes = new Map();
  registerPlaylistRoutes({
    routes,
    backends: { netease: { state: 'ready', baseUrl: 'http://127.0.0.1:1' }, kugou: { state: 'ready', invoke: async () => { throw new Error('不该问酷狗') } } },
    fetchImpl: async (url, init) => {
      seen.push({ path: String(url).replace('http://127.0.0.1:1', ''), cookie: init?.headers?.cookie ?? '' });
      // R182 真机形状：账号那一跳是 `{code:200, account:{id,…}, profile:{userId,…}}`，包**没有**再嵌一层 body；
      // 路由名必须是 `/user/account`（不是 `/account` —— 那个名字在包里根本没有，Express 会回 404 的 HTML）。
      if (String(url).includes('/user/account')) return { status: 200, text: async () => JSON.stringify({ code: 200, account: { id: 445566, nickname: '张三丰' }, profile: { userId: 445566 } }) };
      if (String(url).includes('/account')) return { status: 404, text: async () => '<html>404</html>' };
      return { status: 200, text: async () => JSON.stringify({ code: 200, more: false, playlist: [{ id: 7, name: '我的单', trackCount: 5, coverImgUrl: 'http://p1.music.126.net/x.jpg' }] }) };
    },
  });
  const call = routes.get('/bridge/playlist');
  // ① 没有 cookie ⇒ **一次都不问**（"无会话时行为与今天逐字一致"那条老纪律）
  const anonymous = await call({ provider: 'netease', action: 'mine' });
  assert.equal(anonymous.ok, false);
  assert.match(anonymous.reason, /没有网易登录态/);
  assert.deepEqual(seen, [], '没登录时一个请求都不发（不靠"问了才知道没登录"）');
  // ② 带 cookie ⇒ 两跳都在桥内，且 cookie 走**请求头**（查询串会进包的访问日志，M3-a 同一处置）
  const logged = await call({ provider: 'netease', action: 'mine', cookie: 'MUSIC_U=fixture-cookie-value' });
  assert.equal(logged.ok, true, logged.reason);
  assert.deepEqual(seen.map((row) => row.path.split('?')[0]), ['/user/account', '/user/playlist'],
    '账号那一跳的路由名是 /user/account（带下划线的模块名转斜杠挂上来的）——写成 /account 会拿到 404 的 HTML');
  assert.equal(seen[0].cookie, 'MUSIC_U=fixture-cookie-value', 'uid 那一跳也要带 cookie，否则包说"没登录"');
  assert.equal(seen.every((row) => !row.path.includes('fixture-cookie-value')), true, 'cookie 不许出现在查询串里');
  assert.match(seen[1].path, /uid=445566/, 'uid 由桥自己从 /user/account 取（父进程不需要知道，也就少一处能漂的地方）');
  // ③ 回给父进程的只有 id/名字/条数：uid、昵称、封面地址都不出去
  const text = JSON.stringify(logged);
  assert.equal(text.includes('445566'), false, 'uid 不回传（列表里那张单自己的 id 才是我们要的）');
  assert.equal(text.includes('张三丰'), false);
  assert.equal(text.includes('http'), false);
  assert.equal(text.includes('fixture-cookie-value'), false, '凭据不许出现在任何答复里');
  // ④ /account 说没登录 ⇒ 那句要指出去登录，不许报成"账号里没有歌单"
  seen.length = 0;
  const routes2 = new Map();
  registerPlaylistRoutes({
    routes: routes2,
    backends: { netease: { state: 'ready', baseUrl: 'http://127.0.0.1:1' } },
    fetchImpl: async () => ({ status: 200, text: async () => JSON.stringify({ account: null, code: 200 }) }),
  });
  const noAccount = await routes2.get('/bridge/playlist')({ provider: 'netease', action: 'mine', cookie: 'MUSIC_U=fixture-cookie-value' });
  assert.equal(noAccount.ok, false);
  assert.match(noAccount.reason, /没登录/, noAccount.reason);
  // R217：指路要**指对面板** —— 登录区住在音乐库面板（renderLibraryPanel 那一节），不在设置面板。
  assert.match(noAccount.reason, /音乐库面板里重新扫码/, '指路必须指向真住得着的地方（R217 前的"设置里"是假指引）');
  assert.equal(noAccount.retryable, false, '没登录不是"重试就好"');
});

test('R159 桥·酷狗 mine：没有会话零 invoke；有会话走设备身份那层（默认不伪造），id 只认 global_collection_id', async () => {
  const anonymous = makePlaylistRoutes({ kugouBody: { data: { list: [] } } });
  const noSession = await anonymous.route({ provider: 'kugou', action: 'mine' });
  assert.equal(noSession.ok, false);
  assert.match(noSession.reason, /没有酷狗登录态/);
  assert.deepEqual(anonymous.invokes, [], '没登录时一次都不问包');
  const logged = makePlaylistRoutes({ kugouBody: { data: { info: [
    { global_collection_id: 'collection_1_2_3_0', listid: 2, name: '我的酷狗单', count: 9, creator: { uinfo: { nickname: '某人' } }, imgurl: 'http://imge.kugou.com/a.jpg' },
    { specialid: 42, name: '只有 specialid' },
  ] } } });
  const reply = await logged.route({ provider: 'kugou', action: 'mine', cookie: 'token=bb;userid=seven' });
  assert.equal(reply.ok, true);
  assert.equal(logged.invokes[0].operation, 'user_playlist');
  assert.deepEqual(reply.items, [{ provider: 'kugou', id: 'collection_1_2_3_0', writeId: '2', name: '我的酷狗单', trackCount: 9 }],
    '行里带 listid ⇒ 写侧号就是它（酷狗读侧与写侧不是同一个号）');
  assert.deepEqual(reply.skipped, [1], '只有 specialid 的那行不能用，但要把第几行报出来');
  const text = JSON.stringify(reply);
  assert.equal(text.includes('某人'), false);
  assert.equal(text.includes('imge.kugou'), false);
  assert.equal(text.includes('token=bb'), false, 'cookie 不回传');
  // 包把失败抛成**普通对象**（不是 Error）⇒ 每一跳都得 catch，否则一次 502 会把整条桥路由打成"桥没应答"
  const threw = makePlaylistRoutes({ kugouError: { status: 502, body: { error_code: 20010, errmsg: 'need verify' } } });
  const failed = await threw.route({ provider: 'kugou', action: 'mine', cookie: 'token=bb;userid=seven' });
  assert.equal(failed.ok, false);
  assert.match(failed.reason, /账号歌单没有成/, failed.reason);
  assert.match(failed.reason, /HTTP 502/, '上游状态码要带出来（"没有成"三个字没法排查）');
  assert.match(failed.reason, /20010/);
  assert.equal(failed.retryable, true, '上游 502/20010 一律按可重试处理（认不出的码不判死）');
  // 开关关着时设备身份那一跳**不发生**：这条理由要说"开关是关着的"，不能写成"平台拒绝"
  const needVerify = makePlaylistRoutes({ kugouError: { status: 502, body: { error_code: 20028, errmsg: '本次请求需要验证' } } });
  const blocked = await needVerify.route({ provider: 'kugou', action: 'mine', cookie: 'token=bb;userid=seven' });
  assert.equal(blocked.ok, false);
  assert.match(blocked.reason, /开关是关着的/, blocked.reason);
  assert.equal(needVerify.invokes.length, 1, '要求验证时也不许偷偷注册设备（默认关 = 一次都不调 register_dev）');
  assert.equal(needVerify.invokes.some((entry) => entry.operation === 'register_dev'), false);
});

test('R159 路由：开关关着 404 零桥调用；QQ 那一家给"没量到"不是"不支持"；陌生家拒在门口', async () => {
  const source = await readScript('music-server.mjs');
  const block = /if \(route === '\/api\/online\/playlist\/mine'\) \{([\s\S]*?)\n      if \(route === '\/api\/online\/playlist\/import'\)/.exec(source)?.[1] ?? '';
  assert.ok(block, '账号歌单那条路由还在（下面几条判据都圈在它的函数体里判）');
  assert.match(block, /if \(!store\.config\.online\?\.search\) return json\(response, 404/, '开关判定在任何业务逻辑之前（关闭时零出网）');
  assert.match(block, /request\.method !== 'POST'/, '方法判定在体判定之前（R61 那一条次序）');
  assert.match(block, /provider === 'qq'/);
  // 那句实话必须出现在**发给用户的 error 里**：只判"块里有'没量到'三个字"会被上面那段注释满足
  // （第一轮变异 T10 把用户那句换成"不支持"照样绿，就是这个原因）。
  assert.match(block, /return json\(response, 400, \{ error: '[^']*没量到[^']*'/,
    'QQ 那一句要说"本机还没量到端点"，不是"不支持"——差一个字，用户等不等就不一样');
  assert.match(block, /action: 'mine'/);
  assert.match(block, /credentialsFor\(provider\)/, '凭据取自那一个抽出来的函数（不在这里抄第二份取法）');
  assert.match(block, /sanitizeEgressReasons\(/, '出网原因一律过那个归一层，内部码不外泄');
  assert.equal(/cookie=/.test(block), false, 'cookie 只能作为字段传给桥，不许拼进任何地址');
  // 真机抓到的两处（都只在"失败"那一支发生，所以离线夹具第一次就撞上）：
  // ① 桥的失败答复里带着 `device`（内含 token 与 userid）⇒ 顺着响应进浏览器就破了"凭据不出服务端"；
  // ② 前端那个 `request()` 认 `error` 这一格 ⇒ 不翻的话界面上只剩"本地服务请求失败 (502)"，
  //    服务端那句"本机没有网易登录态"被吞掉（截图 112 第一版拍到的就是这一句空话）。
  assert.match(block, /const \{ device: \w+, \.\.\.rest \} = called \?\? \{\}/,
    '`device` 必须在回浏览器之前剥掉（桥回报给父进程是有用的，但那一份里有 token 与 userid）');
  assert.match(block, /error: String\(publicReply\.reason/, '失败那句要把 reason 翻成 error（其他路由也是这个约定）');
  // 凭据那份函数被两个消费者共用（取址 + 账号歌单），这里钉"只有一个出处"
  assert.equal((source.match(/const credentialsFor = async \(provider\)/g) ?? []).length, 1);
  assert.equal((source.match(/credentialsFor: async \(provider\)/g) ?? []).length, 0,
    'audioSource 那份内联的凭据取法已经抽出去了：留两份就会漂（R159 抽它的正当理由）');
  // 真机抓到的一处副作用（不钉住就会一直在）：没登录时"列一次账号歌单"就在数据目录写下了 kugou-device.json
  const credBlock = /const credentialsFor = async \(provider\) => \{([\s\S]*?)\n  \}/.exec(source)?.[1] ?? '';
  assert.ok(credBlock, '凭据那份函数还在（下面三条都圈在它的函数体里判）');
  assert.match(credBlock, /if \(!cookie\) return \{ cookie: '' \}/,
    '没有登录态就不去备那把 guid：没登录时留一个设备身份文件是"随手一问就产生副作用"（R108 对 QQ 密钥同一立场）');
  assert.ok(credBlock.indexOf('if (!cookie)') >= 0 && credBlock.indexOf('ensureKugouDevice') >= 0
    && credBlock.indexOf('if (!cookie)') < credBlock.indexOf('ensureKugouDevice'),
    '顺序也是判据：先看有没有登录态，再决定要不要生成设备身份（两个 indexOf 都要 >= 0，否则删掉一行反而"通过"）');
});

test('R159 路由真跑一遍：桥回的失败答复里的 device 不出服务端，那句 reason 变成界面看得懂的 error', async () => {
  delete process.env.MUSICBRAINZ_CONTACT;
  const { createMusicServer } = await import('./music-server.mjs');
  const { MusicLibraryStore } = await import('./music-library.mjs');
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'rhine-mine-route-'));
  const rootsDir = await mkdtemp(path.join(os.tmpdir(), 'rhine-mine-roots-'));
  const store = await new MusicLibraryStore({ dataDir, defaultRoots: [] }).init();
  void rootsDir;
  const seen = [];
  const { server } = await createMusicServer({
    store, distDir: SCRIPTS, autoScan: false,
    bridgeClient: {
      status: () => ({ phase: 'ready', port: 1, backends: [{ name: 'netease', state: 'ready' }], unauthorized: 0, restarts: 0, lastError: null, hosts: [] }),
      call: async (route, payload) => {
        seen.push({ route, provider: payload?.provider });
        // 桥那一侧的失败形状：带 device（内含 token / userid），父进程必须剥掉再回
        return { ok: false, provider: payload?.provider, reason: '这一跳上游要求设备校验，而本机的酷狗设备身份开关是关着的',
          retryable: false, device: { guid: 'guid-fixture', mid: 'midfixture', dfid: '', token: 'bb', userid: 'seven' } };
      },
      ensure: async () => {}, shutdown: async () => {},
    },
    onlineLyricsMatcher: { match: async () => ({ matched: false }), clearCache: () => {} },
    onlineAudioSource: { resolve: async () => ({ ok: false, reason: '未配置' }) },
    onlineStreamFetcher: async () => { throw new Error('不该走到这里') },
    onlineSearcher: { search: async () => { throw new Error('不该走到这里') } },
  });
  try {
    // R210：同 routeServer —— 升级到 listenAndReady，且放进 try 里：坏探测走 finally 关服务、清目录。
    const { origin } = await listenAndReady(server);
    const response = await fetch(`${origin}/api/online/playlist/mine`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ provider: 'kugou' }),
    });
    const text = await response.text();
    assert.equal(response.status, 502);
    const reply = JSON.parse(text);
    assert.equal('device' in reply, false, '`device` 整格必须被剥掉（里面有 token 与 userid）');
    for (const secret of ['"token"', '"userid"', 'seven', 'guid-fixture', 'midfixture']) {
      assert.equal(text.includes(secret), false, `答复里出现了「${secret}」：凭据或设备身份出服务端了`);
    }
    assert.match(reply.error, /设备身份开关是关着的/, 'reason 要翻成 error，界面才贴得出这一句（不翻就只剩"请求失败 (502)"）');
    assert.deepEqual(seen, [{ route: '/bridge/playlist', provider: 'kugou' }], '一次问一回桥，不多问');
  } finally { server.close(); await rm(dataDir, { recursive: true, force: true }); await rm(rootsDir, { recursive: true, force: true }) }
});

test('R159 界面：账号歌单那一节说得出"开了哪一件、没开哪几件"，导入走粘贴那条同一个路由', async () => {
  const ui = await read('src/playlists-ui.ts');
  const section = /export function listMarkup[\s\S]*?\n}/.exec(ui)?.[0] ?? '';
  // R165（任务十一）改写这条既有判据（记 Q48）：原文钉的是"账号歌单（只读）"与"不建单、不改单、不删单"，
  // 而任务十一把"加歌"这一条开了 ⇒ 那句原话不再成立。**不变式没变**：界面上必须说清开了什么、没开什么。
  // 拿旧字面量继续钉会把一次正常扩展判成回归（R127/R150 同一类错的第五例）。
  assert.match(section, /账号歌单/, '那一节还在');
  assert.match(section, /这是写操作/, '开了写侧就必须说出来，不许让用户以为还是只读');
  assert.match(section, /只加不删/, '没开的那几件要说出来（不建单、不改单、不删单）');
  assert.match(section, /data-action="account-playlist-list"/);
  assert.match(section, /disabled/, 'QQ 那一格是禁用 + 原因，不是消失（消失了用户会以为没这个功能）');
  assert.equal(/data-action="account-playlist-(create|delete|rename)"/.test(section), false, '建单/删单/改单到今天都不开');
  const markup = /export function accountPlaylistMarkup[\s\S]*?\n}/.exec(ui)?.[0] ?? '';
  assert.match(markup, /data-action="account-playlist-import"/);
  assert.match(markup, /esc\(row\.name\)/, '歌单名是外部数据 ⇒ 只走全仓那一个转义出口');
  assert.match(markup, /esc\(row\.id\)/);
  const app = await read('src/music-app.ts');
  assert.match(app, /request<PlaylistImportResult>\("\/api\/online\/playlist\/import", \{ text: id/,
    '账号歌单的"导入"就是把那个 id 交给粘贴导入那一条路（R114：不开第二条取数通路）');
  assert.equal((app.match(/request<PlaylistImportResult>\("\/api\/online\/playlist\/import"/g) ?? []).length, 2,
    '两个入口共用那一条：粘贴导入与账号歌单导入（第三条就说明有人在别处又拼了一次取数）');
  // 任务五那半条界面：firstScreen 必须走"带说明"那一支，否则"共 898 条"这句话被吞掉。
  // **数出现次数而不是 match 一次**：粘贴导入与账号歌单导入是两处 notify，只判"文件里有这一句"
  // 会被另一处满足（第一轮变异 T11 把账号那一处摘掉照样绿，就是这个原因）。
  assert.equal((app.match(/result\.truncated \|\| result\.dropped \|\| result\.firstScreen/g) ?? []).length, 2,
    '两个导入入口都要走"带说明"那一支：truncated 与 dropped 都是 false 时，firstScreen 是唯一会说"共 898 条"的机会');
  assert.match(app, /来自你的账号歌单/, '账号歌单导入那句要说清来源是账号');
  assert.match(ui, /firstScreen\?: boolean/, '界面契约里有这一格');
});


// ── R165（任务十一）· 加歌到账号歌单：本仓第一条**写侧**在线通路 ──────────────
// 四条红线各有一处判据：只加不删（桥里没有删除分支）/ 只写自己账号（登记表那道闸）/
// 失败如实报（认不出的形状一律 retryable，不谎报成功）/ 二次确认（服务端也要 confirm 标记）。
const writeRoutes = await import('./bridge/playlist-write-routes.mjs');
const { createIssuedPlaylistRegistry } = await import('./playlist-write-registry.mjs');

test('R165 网易那一跳：op 写死 add、id 只认数字、一次最多 20 条且要说清跳过几条', () => {
  const one = writeRoutes.neteaseAddQuery({ playlistId: '1234567', mediaIds: ['27699577'] });
  assert.equal(one.path, '/playlist/tracks?op=add&pid=1234567&tracks=27699577', '整条查询串就是发出去的那一条（钉形状，不钉"看起来对"）');
  assert.equal(one.sent, 1);
  assert.equal(one.skipped, 0);
  const mixed = writeRoutes.neteaseAddQuery({ playlistId: '99', mediaIds: ['1', 'abc', '', '  2  ', {}] });
  assert.equal(mixed.sent, 2, '只有数字 id 算数');
  assert.equal(mixed.skipped, 3, '被丢掉的三条要说得出来（不许静默少加）');
  assert.equal(mixed.path.includes('abc'), false);
  const many = writeRoutes.neteaseAddQuery({ playlistId: '99', mediaIds: Array.from({ length: 40 }, (unused, i) => String(i + 1)) });
  assert.equal(many.sent, writeRoutes.WRITE_MAX_TRACKS, '一次最多 20 条（写侧批量要小）');
  assert.equal(many.skipped, 20);
  assert.equal(writeRoutes.neteaseAddQuery({ playlistId: 'abc', mediaIds: ['1'] }), null, '歌单 id 不是数字 ⇒ 根本不该发');
  assert.equal(writeRoutes.neteaseAddQuery({ playlistId: '1', mediaIds: ['x', ''] }), null, '一条合法的都没有 ⇒ 根本不该发');
  // 「只加不删」最硬的一格：这一路里 op 只能出现 add。
  assert.equal((one.path.match(/op=/g) ?? []).length, 1);
  assert.match(one.path, /op=add/);
});

test('R165 酷狗那一跳：data 是「曲名|hash|0|0」，曲名里带分隔符的直接不加（宁少不加错）', () => {
  const got = writeRoutes.kugouAddParams({
    playlistId: '1341266283',
    songs: [
      { name: '恋人', hash: 'A'.repeat(32) },
      { name: 'Bad, Bad', hash: 'B'.repeat(32) },        // 带逗号 ⇒ 会把一格撑成两格
      { name: 'A|B', hash: 'C'.repeat(32) },             // 带竖线 ⇒ 同上
      { name: '没哈希', hash: '' },
      { name: '', hash: 'D'.repeat(32) },
    ],
  });
  assert.equal(got.params.listid, '1341266283');
  assert.equal(got.sent, 1, '五条里只有一条形状是安全的');
  assert.equal(got.skipped, 4);
  assert.equal(got.params.data, `恋人|${'A'.repeat(32)}|0|0`);
  assert.equal(got.operation, 'playlist_tracks_add', '走的是包内那个模块，且必须经 kugouDeviceCall（安卓签名那一层）');
  assert.equal(writeRoutes.kugouAddParams({ playlistId: 'x', songs: [{ name: 'a', hash: 'A'.repeat(32) }] }), null);
  assert.equal(writeRoutes.kugouAddParams({ playlistId: '1', songs: [] }), null);
});

test('R165 桥那侧三道"没有凭据就一次网都不出"的闸（网易零 fetch / 酷狗零 invoke / QQ 不猜）', async () => {
  const routes = new Map();
  let neteaseFetches = 0;
  let kugouInvokes = 0;
  const backends = {
    netease: { state: 'ready', baseUrl: 'http://127.0.0.1:1' },
    kugou: { invoke: async () => { kugouInvokes += 1; return { status: 200, body: { data: { count: 1 }, status: 1, error_code: 0 } }; } },
  };
  writeRoutes.registerPlaylistWriteRoutes({
    routes, backends,
    // 真机形状：网易写侧回的是**封套** `{status,body,cookie}`（`module/playlist_tracks.js` 包过一层）。
    fetchImpl: async () => { neteaseFetches += 1; return { status: 200, text: async () => JSON.stringify({ status: 200, body: { trackIds: '[27699577]', code: 200, count: 290 }, cookie: [] }) }; },
  });
  const call = routes.get('/bridge/playlist-write');
  const tracks = [{ id: 'on-netease-27699577', mediaId: '27699577', name: '恋人 - 李荣浩' }];

  const noCookie = await call({ provider: 'netease', playlistId: '1', tracks });
  assert.equal(noCookie.ok, false);
  assert.match(noCookie.reason, /没有网易登录态.*这一跳不出网/s, '那句实话要原样能读出来');
  assert.equal(neteaseFetches, 0, '没有 cookie 就一次 fetch 都不许有');

  const noSession = await call({ provider: 'kugou', playlistId: '1', tracks: [{ id: 'on-kugou-x', mediaId: 'A'.repeat(32), name: 'x' }] });
  assert.equal(noSession.ok, false);
  assert.match(noSession.reason, /没有酷狗登录态/);
  assert.equal(kugouInvokes, 0, '没有会话就一次 invoke 都不许有（与 R159 列歌单同一道闸）');

  const qq = await call({ provider: 'qq', playlistId: '1', tracks });
  assert.equal(qq.ok, false);
  assert.match(qq.reason, /没量到端点（不猜、不试第二种）/, 'QQ 写侧一条都没量到 ⇒ 说不支持，不编一个端点');
  assert.equal(neteaseFetches + kugouInvokes, 0, '上面三问总共零出网');

  const emptyTracks = await call({ provider: 'netease', playlistId: '1', tracks: [], cookie: 'MUSIC_A=1' });
  assert.equal(emptyTracks.ok, false);
  assert.match(emptyTracks.reason, /没有要加的曲目/);
  assert.equal(neteaseFetches, 0);

  const ok = await call({ provider: 'netease', playlistId: '1', tracks, cookie: 'MUSIC_A=1' });
  assert.equal(ok.ok, true, '带上 cookie 且形状对，才真的发这一笔');
  assert.equal(neteaseFetches, 1);
});

test('R165 认不出的响应一律"没成 + 可重试"，不许替平台下结论、更不许报成已加好', () => {
  // R182：这三条夹具全部换成**真机量到的形状**（旧夹具是"看着像"的，其中一条还把 bug 钉成了预期行为）。
  // 网易成功那一格的真身（加一首新的）：code 是 **200**，不是 0。
  assert.deepEqual(writeRoutes.interpretNcmWrite({ trackIds: '[29122838]', code: 200, count: 290, cloudCount: 0 }, 200), { ok: true });
  assert.deepEqual(writeRoutes.interpretNcmWrite({ code: 0 }, 200), { ok: true }, '老式的 code:0 也认（两种成功码并存）');
  // 桥真正拿到的是**封套** `{status,body,cookie}`（`module/playlist_tracks.js` 包过一层）⇒ 必须自己剥这一层。
  assert.deepEqual(writeRoutes.interpretNcmWrite({ status: 200, body: { code: 200, trackIds: '[29122838]' }, cookie: [] }, 200), { ok: true },
    '封套那层也要认（R182 之前这里读的是封套的 code=undefined ⇒ 重复加一首会被报成"已加好"）');
  // **旧判据反过来的一格**：HTTP 200 但没有 code ⇒ 不是成功，是"认不出"。旧版这里回 ok:true，正是那条红线破的地方。
  const shapeless = writeRoutes.interpretNcmWrite({}, 200);
  assert.equal(shapeless.ok, false, 'HTTP 200 且没有 code**不算**收下（R182 起：认不出就说认不出，不谎报成功）');
  assert.equal(shapeless.retryable, true);
  // 重复加同一首 = 真机量到的 `{message:"歌单内歌曲重复", code:502}`：不是失败、也不是"再试一次就好"。
  const dup = writeRoutes.interpretNcmWrite({ message: '歌单内歌曲重复', code: 502 }, 200);
  assert.equal(dup.ok, false);
  assert.match(dup.reason, /已经在.*歌单里/);
  assert.equal(dup.retryable, false, '重复不是可恢复的（重试还是重复），也不是"平台拒绝"');
  const refused = writeRoutes.interpretNcmWrite({ code: -460, msg: '不能操作他人的歌单' }, 200);
  assert.equal(refused.ok, false);
  assert.match(refused.reason, /网易没接受这次添加：不能操作他人的歌单/);
  const expired = writeRoutes.interpretNcmWrite({ code: 301, msg: '需要登录' }, 200);
  assert.equal(expired.ok, false);
  assert.equal(expired.retryable, true, '登录态过期是可恢复的（重新扫码），界面要能再说一次');
  // 酷狗那一格的真身（R182 真机原文）：外层 `createRequest` 封套 + 内层 `{data, status:1, error_code:0}`。
  // **内层 status 是 1 不是 0** —— 旧实现读 status ⇒ 把成功读成失败。
  const kugouReal = { status: 200, body: { data: { count: 1, list_ver: 2, listid: 2 }, status: 1, error_code: 0 }, cookie: [], headers: {} };
  assert.deepEqual(writeRoutes.interpretKugouWrite(kugouReal), { ok: true }, '真机上这一笔是成功的');
  assert.deepEqual(writeRoutes.interpretKugouWrite({ data: { count: 1 }, status: 1, error_code: 0 }), { ok: true }, '剥过一层的裸 body 也认');
  const kugouUnknown = writeRoutes.interpretKugouWrite({ status: 200, body: { something: 'else' } });
  assert.equal(kugouUnknown.ok, false, '认不出的形状一律不算成功');
  assert.equal(kugouUnknown.retryable, true);
  assert.equal(writeRoutes.interpretKugouWrite({ err_code: 0 }).ok, true, 'err_code 那个别名一并认');
  const kugouRefused = writeRoutes.interpretKugouWrite({ data: {}, status: 1, error_code: 20010 });
  assert.equal(kugouRefused.ok, false);
  assert.equal(kugouRefused.retryable, false, '上游给了一个具体的码 ⇒ 不是"没量到"，别写成可重试');
});

test('R182 酷狗写侧接通：白名单补上那个模块 + 真机形状读成成功（R165 那道"不在白名单"的闸已拆）', async () => {
  const { KUGOU_OPERATIONS, resolveOperation } = await import('./bridge/backends/kugou.mjs');
  assert.equal(KUGOU_OPERATIONS.playlist_tracks_add, 'playlist_tracks_add',
    'R165 漏登记这一个 ⇒ 真机上每一次加歌都抛"不在酷狗 operation 白名单里"（R182 真机实测抓到）');
  // 白名单 + 包内导出面两道都过才放行；删掉这一格，下面那条 throw 就是真机上的症状。
  assert.equal(resolveOperation('playlist_tracks_add', { playlist_tracks_add: () => {} }), 'playlist_tracks_add');
  assert.throws(() => resolveOperation('playlist_track_delete', { playlist_track_delete: () => {} }), /不在酷狗 operation 白名单里/,
    '删除那一族仍旧进不来（只加不删那条红线在包这一侧也钉住）');

  const routes = new Map();
  let seen = null;
  writeRoutes.registerPlaylistWriteRoutes({
    routes,
    backends: { kugou: { invoke: async (operation, params) => { seen = { operation, params }; return { status: 200, body: { data: { count: 1, list_ver: 2, listid: 2 }, status: 1, error_code: 0 } }; } } },
  });
  const reply = await routes.get('/bridge/playlist-write')({
    provider: 'kugou', playlistId: '2',
    tracks: [{ id: `on-kugou-${'A'.repeat(32)}`, mediaId: 'A'.repeat(32), name: '恋人 - 李荣浩' }],
    cookie: 'token=bb;userid=seven', device: { guid: 'g', mid: 'm' },
  });
  assert.equal(reply.ok, true, reply.reason);
  assert.equal(seen.operation, 'playlist_tracks_add', '经的是包内那个模块（白名单放行之后才到得了这一步）');
  assert.equal(seen.params.listid, '2', '酷狗写侧要的是 listid（这一格来自列表行，R182 量到）');
  assert.equal(seen.params.data, `恋人 - 李荣浩|${'A'.repeat(32)}|0|0`);
  assert.equal(reply.sent, 1);
  assert.equal(reply.provider, 'kugou');
});

test('R182 写侧那两个号：列表页用 readId、加歌用 writeId（两处都在产物里钉住）', async () => {
  const source = await readScript('music-server.mjs');
  // 父进程把**两个号都**登记进"刚才列出来过"那张表：只登记 id 的话，酷狗那颗"加进来"按钮会撞 403。
  assert.match(source, /issue\(provider, publicReply\.items\.flatMap\(\(item\) => \[item\?\.id, item\?\.writeId\]\)\)/,
    'writeId 也要登记（漏了就是"这张歌单不是这台机器刚才列出来的那些"）');
  const ui = await read('src/playlists-ui.ts');
  const markup = /export function accountPlaylistMarkup[\s\S]*?\n}/.exec(ui)?.[0] ?? '';
  assert.ok(markup, '没抓到 accountPlaylistMarkup');
  assert.match(markup, /data-account-id="\$\{esc\(row\.writeId \?\? row\.id\)\}"/,
    '加歌那颗按钮带 writeId（回落 id 给老缓存 / 网易那一档）');
  assert.equal((markup.match(/data-account-id="\$\{esc\(row\.id\)\}"/g) ?? []).length, 1,
    '导入那颗按钮仍带 id（读侧号），全局只有它一处用 row.id');
  // 桥那侧"只加不删"：白名单里只多了一个 add 模块，删除那一族一个都没进来。
  const banned = Object.keys((await import('./bridge/backends/kugou.mjs')).KUGOU_OPERATIONS);
  assert.equal(banned.some((name) => /delete|remove|del_|_del/.test(name)), false, '白名单里不许出现删除形状');
});

test('R188（Q65）映射三态：上游给了 0 与"没给这一格"是两件事（不许把缺失猜成 0）', () => {
  const got = accountPlaylistsToItems({
    playlist: [
      { id: 1, name: '有值十二', trackCount: 12 },
      { id: 2, name: '有值零', trackCount: 0 },
      { id: 3, name: '缺字段' },
    ],
  }, 'netease');
  assert.equal(got.ok, true);
  assert.deepEqual(got.items.map((r) => r.trackCount), [12, 0, null],
    '有值给数、0 给 0、缺字段给 null（原先 `Number(... ?? 0) || 0` 把后两格洗成同一个 0）');
  // 酷狗那一家：条数在行里叫 `count`，缺这一格同样是 null（与给 0 分开）。
  const kugou = accountPlaylistsToItems({ data: { info: [
    { global_collection_id: 'c1', listid: 1, name: '默认收藏', count: 0 },
    { global_collection_id: 'c2', listid: 2, name: '没有 count' },
  ] } }, 'kugou');
  assert.deepEqual(kugou.items.map((r) => r.trackCount), [0, null], '酷狗 count=0 是已知 0，缺这一格才是未知');
});

test('R165 全仓零删除分支：写侧只有 add，删这件事我们不提供入口', async () => {
  const src = await readScript('bridge/playlist-write-routes.mjs');
  const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
  for (const banned of ["'del'", '"del"', 'op=del', 'playlist_track_delete', 'playlist_delete', 'unsubscribe', 'subscribe'])
    assert.equal(code.includes(banned), false, `写侧源码里出现了删除形状：${banned}`);
  assert.equal((code.match(/op=g?"?add/g) ?? []).length + (code.match(/op=add/g) ?? []).length >= 1, true, 'op 只能是 add');
  // 桥那侧的注册表里也不许有第二条写路由（今天只开"加歌"，建单/改单都没开）。
  const registered = await readScript('bridge/online-bridge.mjs');
  assert.equal((registered.match(/playlist-write/g) ?? []).length, 2, '写侧路由只注册一次（import 行 + register 行）');
});

test('R165 登记表：只在内存、带 TTL、按插入序淘汰，重新列一次会挪回队尾', () => {
  let clock = 1_000;
  const registry = createIssuedPlaylistRegistry({ ttlMs: 500, limit: 3, now: () => clock });
  registry.issue('netease', ['1', '2', '3']);
  assert.equal(registry.has('netease', '2'), true);
  assert.equal(registry.has('qq', '2'), false, '跨家不算（网易列出来的 id 不能拿去写 QQ）');
  clock += 501;
  assert.equal(registry.has('netease', '2'), false, '过期就当没列过（账号里的单子会被用户自己增删）');
  registry.issue('netease', ['a', 'b', 'c', 'd']);
  assert.equal(registry.size(), 3, '超上限按插入序淘汰');
  assert.equal(registry.has('netease', 'a'), false, '最早那条被挤掉了');
  registry.issue('netease', ['a']);
  assert.equal(registry.has('netease', 'a'), true, '重新登记要挪到队尾（否则刚列出来的会被旧的挤掉）');
  // 上面那一断言的判据面太窄（变异 W8 第一遍没咬）：只查"还在不在"看不出**位置**。
  // 这一组才真的咬得住：重新列过一次的那条，不该在下一次超上限时被挤掉；被挤的应该是最久没被列的。
  const ordered = createIssuedPlaylistRegistry({ ttlMs: 10_000, limit: 3, now: () => 1 });
  ordered.issue('netease', ['a', 'b', 'c']);
  ordered.issue('netease', ['a']);            // 重新列一次：a 变成"最新被确认过的"
  ordered.issue('netease', ['d']);            // 超上限 ⇒ 该挤掉 b（最久没被重新列的那条）
  assert.equal(ordered.has('netease', 'a'), true, '刚重新列出来的那条不该被挤掉');
  assert.equal(ordered.has('netease', 'b'), false, '被挤掉的应该是最久没被列的那条');
  assert.equal(ordered.has('netease', 'd'), true);
  assert.equal(ordered.has('netease', '   '), false, '空 id 永远不算');
});

test('R165 父进程路由的六道闸：开关 → 方法 → confirm → 家 → 登记表 → 曲目同家（每一道都零桥调用）', async () => {
  const calls = [];
  const route = await routeServer({
    config: { online: { lyrics: false, search: true, streaming: false, covers: false } },
    importBridge: {
      call: async (path, payload) => {
        calls.push({ path, payload });
        if (payload?.action === 'mine') return { ok: true, provider: payload.provider, items: [{ provider: payload.provider, id: '777', name: '我的歌单', trackCount: 3 }] };
        if (path === '/bridge/playlist-write') return { ok: true, provider: payload.provider, action: 'add', sent: payload.tracks.length, skipped: 0 };
        return { ok: false, reason: '不该走到这里' };
      },
    },
  });
  try {
    const postJson = async (url, body) => {
      const response = await fetch(`${route.origin}${url}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
      return { status: response.status, body: await response.json().catch(() => null) };
    };
    const before = calls.length;
    // ① 缺 confirm ⇒ 400（界面那颗 confirm 不是装饰，服务端也认一次）
    const noConfirm = await postJson('/api/online/playlist/add', { provider: 'netease', playlistId: '777', tracks: [{ id: 'on-netease-1' }] });
    assert.equal(noConfirm.status, 400);
    assert.match(noConfirm.body.error, /写操作.*confirm/s);
    // ② 没列过这张 ⇒ 403（登记表那道闸）
    const notIssued = await postJson('/api/online/playlist/add', { provider: 'netease', playlistId: '777', confirm: 'add-to-account-playlist', tracks: [{ id: 'on-netease-1' }] });
    assert.equal(notIssued.status, 403, '先列一次才有资格写：这是"只往自己账号里写"在我们这一侧的落地');
    assert.match(notIssued.body.error, /不是这台机器刚才列出来的/);
    // ③ GET ⇒ 405
    const wrongMethod = await fetch(`${route.origin}/api/online/playlist/add`);
    assert.equal(wrongMethod.status, 405);
    // ④ QQ 与陌生家 ⇒ 400
    assert.equal((await postJson('/api/online/playlist/add', { provider: 'qq', playlistId: '1', confirm: 'add-to-account-playlist', tracks: [{ id: 'on-qq-1' }] })).status, 400);
    assert.equal((await postJson('/api/online/playlist/add', { provider: 'kuwo', playlistId: '1', confirm: 'add-to-account-playlist', tracks: [{ id: 'on-kuwo-1' }] })).status, 400);
    assert.equal(calls.length, before, '上面四道闸一次桥都没问过（更谈不上出网）');
    // ⑤ 先列一次（把 777 登记进来），再写：同家曲目 ⇒ 成
    const listed = await postJson('/api/online/playlist/mine', { provider: 'netease' });
    assert.equal(listed.status, 200);
    assert.equal(listed.body.items[0].id, '777');
    const added = await postJson('/api/online/playlist/add', {
      provider: 'netease', playlistId: '777', confirm: 'add-to-account-playlist',
      tracks: [{ id: 'on-netease-27699577', name: '恋人 - 李荣浩' }],
    });
    assert.equal(added.status, 200);
    assert.equal(added.body.sent, 1);
    const write = calls[calls.length - 1];
    assert.equal(write.path, '/bridge/playlist-write');
    assert.equal(write.payload.action, 'add');
    assert.equal(write.payload.tracks[0].mediaId, '27699577', '递给桥的是从 id 形状反解出来的媒体 id，不是客户端自报的那一格');
    assert.equal('device' in write.payload, false, '网易这一路不带设备身份');
    // ⑥ 曲目与目标不同家 ⇒ 400 且零出网（把网易的曲目塞进酷狗的单子，形状合法但我们不送）
    const cross = calls.length;
    const crossed = await postJson('/api/online/playlist/add', {
      provider: 'netease', playlistId: '777', confirm: 'add-to-account-playlist',
      tracks: [{ id: 'on-kugou-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' }],
    });
    assert.equal(crossed.status, 400);
    assert.match(crossed.body.error, /没有一条曲目是这一家的在线曲目/);
    assert.equal(calls.length, cross, '不同家这一问零桥调用');
    // 本地曲目 id 一律不算在线曲目（与任务八同一条理由）
    assert.equal((await postJson('/api/online/playlist/add', {
      provider: 'netease', playlistId: '777', confirm: 'add-to-account-playlist',
      tracks: [{ id: 'track-f97d942e7bca06399c2ffdd5' }],
    })).status, 400);
  } finally {
    await route.close();
  }
});

test('R165 关掉在线开关 ⇒ 写侧 404 且一次桥都不问（与列歌单同一张子开关）', async () => {
  const calls = [];
  const route = await routeServer({
    config: { online: { lyrics: false, search: false, streaming: false, covers: false } },
    importBridge: { call: async (path, payload) => { calls.push({ path, payload }); return { ok: true }; } },
  });
  try {
    const response = await fetch(`${route.origin}/api/online/playlist/add`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ provider: 'netease', playlistId: '1', confirm: 'add-to-account-playlist', tracks: [{ id: 'on-netease-1' }] }),
    });
    assert.equal(response.status, 404);
    assert.match((await response.json()).error, /在线能力已关闭/);
    assert.equal(calls.length, 0);
  } finally {
    await route.close();
  }
});

test('R165 界面那一半：同家才给可点的按钮，不同家禁用并说原因；面板文案不许把写操作说成只读', async () => {
  const ui = await read('src/playlists-ui.ts');
  const body = /export function accountPlaylistMarkup[\s\S]*?\n}\n/.exec(ui);
  assert.ok(body, '没抓到 accountPlaylistMarkup（提取失败不许静默通过）');
  assert.match(body[0], /addable: AccountPlaylistAddable \| null = null/, '第二参数是"此刻能加的那一首"，由宿主算好传进来');
  assert.match(body[0], /addable\.provider === row\.provider/, '同一家才可点（跨家不送）');
  assert.match(body[0], /data-action="account-playlist-add"/, '可点那一颗带明确动作');
  assert.match(body[0], /disabled title=/, '不可点那一颗要禁用并把原因写进 title');
  assert.match(body[0], /先播一首在线曲目/, '没有在线曲目在播时那句原因要说得出来');
  assert.match(ui, /只加不删/, '面板说明要写"只加不删"');
  assert.match(ui, /这是写操作/, '面板说明要承认这是写操作（R159 那句"不动你账号里的任何东西"已经不再成立，必须改）');
  const app = await read('src/music-app.ts');
  const handler = /async function addCurrentTrackToAccountPlaylist[\s\S]*?\n}\n/.exec(app);
  assert.ok(handler, '没抓到那个处理函数');
  assert.match(handler[0], /window\.confirm\(/, '二次确认（开的那一方向）');
  assert.match(handler[0], /本工具只加不删/, '确认框里要重述"只加不删、加错了我们删不了"');
  assert.match(handler[0], /confirm: "add-to-account-playlist"/, '服务端那道 confirm 标记由这里带上');
  assert.match(handler[0], /没确认，这一笔没有发出去/, '取消要留下回执，不能静默');
  assert.match(app, /dataset.action === "account-playlist-add"/, '点击分支在位（写了按钮没写分支就是静默无果，R121 那一族）');
  assert.match(app, /accountPlaylistMarkup\(items, accountPlaylistAddable\(\)\)/, '渲染时把"此刻能加的那一首"一起算进去');
  // 只有在线曲目能加：本地曲目在界面这一层就不给按钮（与任务八"本地曲目一条都不报"同一个理由）
  const addable = /function accountPlaylistAddable\(\)[\s\S]*?\n}\n/.exec(app);
  assert.ok(addable, '没抓到 accountPlaylistAddable');
  assert.match(addable[0], /track\.sourceKind !== "online"/, '本地曲目一律不可加');
  assert.match(addable[0], /provider !== "netease" && provider !== "kugou"/, 'QQ 与认不出的来源一律不可加');
});

// ── R220：老歌单「补一次来源身份」的路由形状 ─────────────────────────────────
// 三条判据各管一件事，逐条都是这一族最容易出事的地方：
// ① **闸门次序**：在线开关 → 方法 → 才去读盘/问上游 —— 关着时零桥调用（与写侧六道闸同一条纪律）；
// ② **没有来历注释就明确说不补**，不许拿"曲名+歌手"当身份去猜哪家哪张；
// ③ 补到的写进 **sidecar**，`.playlist.txt` 的字节必须逐字不变（"不动正文"是 R137 那条批复）。
test('R220 路由 /api/playlists/<id>/source-identity：开关→方法→出网三道闸、无来历说不补、正文逐字节不变', async () => {
  const bridge = fakeBridge({ trackCount: 2 });
  const route = await routeServer({ importBridge: bridge });
  const post = (url, body) => fetch(`${route.origin}${url}`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body ?? {}),
  });
  const get = (url) => fetch(`${route.origin}${url}`);
  try {
    // 先导入一张"从网易列出来的"单，拿到带来历注释的文件（走的是真写侧）。
    const imported = await post('/api/online/playlist/import', { text: 'https://music.163.com/playlist?id=17429985859' });
    assert.equal(imported.status, 200, '导入这一步必须先成，否则下面测的是路由不是夹具');
    const { id } = await imported.json();
    const textFile = route.store.playlists.fileOf(id);
    const textBefore = await readFile(textFile, 'utf8');
    assert.match(textBefore, /# netease-playlist 17429985859 imported /, '夹具得真的带来历注释');

    // ① GET ⇒ 405，且一问都不问
    const bridgeCallsBefore = bridge.calls.length;
    const wrongMethod = await get(`/api/playlists/${id}/source-identity`);
    await wrongMethod.text();
    assert.equal(wrongMethod.status, 405);
    assert.equal(bridge.calls.length, bridgeCallsBefore, '405 这一道闸必须拦在出网之前');

    // ② 没有来历注释的单 ⇒ 一句实话，不去猜
    const handmade = await route.store.playlists.write('手打的单', '# Rhine 歌单 v1\n# name: 手打的单\n恋人 - 李荣浩 | 黑马\n');
    const noProvenance = await post(`/api/playlists/${handmade.id}/source-identity`);
    assert.equal(noProvenance.status, 200, '这不是错误，是一次"补不了"的答复');
    const noProvBody = await noProvenance.json();
    assert.equal(noProvBody.ok, false);
    assert.match(noProvBody.error, /来历注释/);
    assert.equal(noProvBody.filled ?? 0, 0, '补不了就得报 0 行，不能给个 undefined 让界面写成"补到了"');
    assert.equal(bridge.calls.length, bridgeCallsBefore, '没来历 ⇒ 一次都不该去列账号歌单');

    // ③ 正常那一跑：补到的进 sidecar，正文一个字节都不动
    const result = await post(`/api/playlists/${id}/source-identity`);
    assert.equal(result.status, 200);
    const body = await result.json();
    assert.equal(body.ok, true);
    assert.equal(body.provider, 'netease', '回执要说清是按哪家补的');
    assert.equal(body.sourceId, '17429985859', '以及按那张单的 id');
    assert.equal(body.total, 2);
    assert.equal(body.filled, 2, `上游两行都该对上：${JSON.stringify(body)}`);
    assert.equal(body.unfilled, 0);
    assert.ok(bridge.calls.length > bridgeCallsBefore, '这一问真的重新列了一次账号歌单');
    const sidecar = JSON.parse(await readFile(path.join(route.dataDir, 'playlists', `${id}.matches.json`), 'utf8'));
    const records = Object.values(sidecar.entries);
    assert.equal(records.length, 2);
    for (const record of records) {
      assert.equal(record.sourceProvider, 'netease');
      assert.match(String(record.sourceMediaId), /^\d+$/, `来源媒体 id 形状不对：${JSON.stringify(record)}`);
    }
    assert.equal(await readFile(textFile, 'utf8'), textBefore, 'sidecar 是派生文件：正文必须逐字节不变');
    assert.equal(textBefore.includes('sourceMediaId'), false, '身份不许漏进文本');
  } finally {
    await route.close();
  }

  // ④ 在线能力关着 ⇒ 404 且零桥调用（与匹配/导入同一张子开关）
  const off = await routeServer({
    config: { online: { lyrics: true, search: false, streaming: true, covers: true } },
    importBridge: fakeBridge({ trackCount: 1 }),
  });
  try {
    const blocked = await fetch(`${off.origin}/api/playlists/anything/source-identity`, { method: 'POST' });
    assert.equal(blocked.status, 404);
    assert.match((await blocked.json()).error, /已关闭/);
  } finally {
    await off.close();
  }
});

// ── R198：歌单伪专辑的展示封面（同源 token 地址）进架上那一行 ─────────────────────
// 判据：服务端给了 `displayCoverUrl` ⇒ 行里 `coverUrl` 就是它；没给 ⇒ 空串（架上照旧画程序化拼贴）。
// 不许在这里造地址：`coverUrl` 的来源只有"服务端签出来的那一格"（F3 那条老错的反面）。
test('R198：展示封面进架上行（有则真图、无则空串），且不在这里造地址', async () => {
  const { playlistShelfRow } = await import('./playlists.mjs');
  const base = { id: '试单', name: '试单', matched: 1, unmatched: 0, items: [{ entry: { title: 'A', artist: 'B' } }] };
  assert.equal(playlistShelfRow({ ...base, displayCoverUrl: '/api/online/artwork/tok-1' }).coverUrl,
    '/api/online/artwork/tok-1', '服务端给了展示封面 ⇒ 行里原样带上');
  assert.equal(playlistShelfRow(base).coverUrl, '', '没给 ⇒ 空串（程序化拼贴照旧）');
  assert.equal(playlistShelfRow({ ...base, displayCoverUrl: '' }).coverUrl, '', '给了空串也当没有');
  const row = playlistShelfRow({ ...base, displayCoverUrl: '/api/online/artwork/tok-1' });
  assert.equal(/^\/api\/online\/artwork\//.test(row.coverUrl), true, '只认同源地址这一种形状');
});

// ── R226 · 给"来源身份"这一路补上封面（P2：新导入的单只走身份路 ⇒ 封面整列空）─────────
// 三条纪律钉死：上游没给**不硬造**；已有的**不覆盖**；自己这一家的图进来时把「借图」标记与两个补图戳**成对摘掉**。
// 最后两条测试是 R225 立的那条规矩：**从生产入口打进来**（真路由 + 真导入 + 真 sidecar + 真 tracks()），
// 夹具只许在最外层的那座假桥。

test('R226（i）映射层与 collect()：网易行带 al.picUrl ⇒ 行里逐字带出（http 升 https）；没给的那行留空、身份行也不带这一格', async () => {
  const { identitiesOf } = await import('./playlist-import.mjs');
  const bridge = fakeBridge({ trackCount: 4, withCover: true });
  await withStore(async (store) => {
    const svc = createPlaylistImporter({ bridge, store });
    const got = await svc.collect('netease', '17429985859');
    assert.equal(got.ok, true, JSON.stringify(got));
    assert.equal(got.items.length, 4, '四行都要拿到（本条量的是封面那一格，不是分页）');
    assert.equal(got.items[0].coverRef, 'https://p3.music.126.net/k0/28196620.jpg',
      '一手实测的形状：上游给 http 的同主机地址 ⇒ 升 https 才收（闸在 trackCoverRef 那一个出处）');
    assert.equal(got.items[1].coverRef, '', '夹具里奇数行上游没给图 ⇒ 空串，不许按 id 造一个会 404 的（F3 那条判据）');
    // 身份行那一格：有图才带上，没图**这个键不出现**（带空串下去会被读成"上游确认没有"，与"没拿到"是两件事）
    const rows = identitiesOf('netease', got.items);
    assert.deepEqual(rows[0].coverRef, 'https://p3.music.126.net/k0/28196620.jpg');
    assert.equal('coverRef' in rows[1], false, `没给封面的行不该带这个键：${JSON.stringify(rows[1])}`);
    assert.equal(rows[0].provider, 'netease', '身份那三格照常带（本批一条没动）');
  });
});

test('R226（ii）导入即写：身份与封面**同一次落盘**；三条纪律（没给不硬造 / 已有不覆盖 / 戳与借图标记成对摘掉）', async () => {
  const route = await routeServer({ importBridge: fakeBridge({ trackCount: 4, withCover: true }) });
  const post = (url, value = {}) => fetch(`${route.origin}${url}`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(value),
  });
  const sidecarPathOf = async (id) => path.join(route.dataDir, 'playlists', `${id}.matches.json`);
  const readSidecar = async (id) => JSON.parse(await readFile(await sidecarPathOf(id), 'utf8'));
  const writeSidecar = async (id, value) => { await writeFile(await sidecarPathOf(id), JSON.stringify(value), 'utf8'); };
  try {
    const body = await (await post('/api/online/playlist/import', { text: 'https://music.163.com/playlist?id=17429985859' })).json();
    const id = body.id;
    assert.equal(body.ok, true, JSON.stringify(body));
    const textFile = route.store.playlists.fileOf(id);
    const textBefore = await readFile(textFile, 'utf8');
    // ① 同一次落盘：带图的那两行**身份与封面一起**进来（分开写就会出现"徽标是来源身份、封面整列空"那副样子）
    const fresh = await readSidecar(id);
    const records = Object.values(fresh.entries);
    assert.equal(records.length, 4, `四行都该有身份：${JSON.stringify(fresh.entries)}`);
    for (const record of records) {
      assert.equal(record.sourceProvider, 'netease');
      assert.match(String(record.sourceMediaId), /^\d+$/);
    }
    assert.deepEqual(records.filter((record) => record.coverRef).map((record) => String(record.sourceMediaId)).length, 2,
      '上游给了两行 ⇒ 恰好两行有封面');
    for (const record of records.filter((entry) => entry.coverRef)) {
      assert.match(record.coverRef, /^https:\/\/p3\.music\.126\.net\//, '落的是过闸的 https 地址');
      assert.equal(record.coverFromProvider, undefined,
        '同一家给的图**不写「借图」标记**——那一格的既有语义是"图来自另一家"（R146），写了就等于界面要说一句假话');
    }
    for (const record of records.filter((entry) => !entry.coverRef)) {
      assert.equal('coverRef' in record, false, '上游没给 ⇒ 这一格不出现（不是空串、更不是硬造）');
    }
    // ② 老单形状（用户实况：只有身份三格、封面全空）⇒ 补一次要把封面带上
    const legacy = await readSidecar(id);
    for (const record of Object.values(legacy.entries)) {
      delete record.coverRef;
      delete record.coverFromProvider;
    }
    await writeSidecar(id, legacy);
    const refilled = await (await post(`/api/playlists/${id}/source-identity`)).json();
    assert.equal(refilled.ok, true, JSON.stringify(refilled));
    assert.equal(refilled.filled, 4, '身份四行都重新对上');
    assert.equal(refilled.covers, 2, `回执要说得出"封面新补几行"：${JSON.stringify(refilled)}`);
    assert.equal(refilled.coverless, 2, '也说得出"仍没有封面的几行"（酷狗那种收不进白名单的就在这一档）');
    const afterRefill = await readSidecar(id);
    assert.equal(Object.values(afterRefill.entries).filter((record) => record.coverRef).length, 2);
    assert.equal(await readFile(textFile, 'utf8'), textBefore, '补的是派生文件：正文必须逐字节不变');
    // ③ 两条"不许动"：已有的非空封面不覆盖；补图戳与借图标记成对摘掉。
    // 行按 `sourceMediaId` 挑（夹具那四行是 28196629…28196632，**偶数下标那两行上游才给图**）——
    // 第一版我按 Object.keys 的位置取，取到了"上游本来就没图"的那一行，于是断言自己骗自己。
    const seeded = await readSidecar(id);
    const entryOf = (mediaId) => {
      const found = Object.entries(seeded.entries).find(([, record]) => String(record.sourceMediaId) === String(mediaId));
      assert.ok(found, `夹具里该有 mediaId ${mediaId} 这一行：${JSON.stringify(Object.values(seeded.entries).map((record) => record.sourceMediaId))}`);
      return found;
    };
    const [keptKey, kept] = entryOf(28196629);
    const [stampedKey, stamped] = entryOf(28196631);
    kept.coverRef = 'https://p4.music.126.net/别人先填的/1.jpg';
    stamped.coverTried = true;
    stamped.coverCheckedAt = 1_700_000_000_000;
    delete stamped.coverRef;
    await writeSidecar(id, seeded);
    const refilled2 = await (await post(`/api/playlists/${id}/source-identity`)).json();
    assert.equal(refilled2.covers, 1, `只有那一行该被新补上图：${JSON.stringify(refilled2)}`);
    const disciplined = await readSidecar(id);
    assert.equal(disciplined.entries[keptKey].coverRef, 'https://p4.music.126.net/别人先填的/1.jpg',
      '已经有图的行不覆盖（同一张碟的两个 CDN 主机不必来回改盘，那会让每次"补身份"都重写一遍）');
    const second = disciplined.entries[stampedKey];
    assert.ok(second.coverRef, '这一行上游给了图 ⇒ 该补上');
    assert.match(second.coverRef, /^https:\/\/p3\.music\.126\.net\//);
    assert.equal('coverTried' in second, false, '写进真封面时 coverTried 必须一起清掉');
    assert.equal('coverCheckedAt' in second, false, '两个戳**成对**清掉（留着半套就是 R125 那副"问过且没结果"的面孔）');
    assert.equal('coverFromProvider' in second, false, '同一家给的图不写借图标记（既有语义只给"来自另一家"用）');
    // 上游本来就没给图的那一行：补完之后仍然不该凭空长出封面
    const [bareKey, bare] = entryOf(28196630);
    assert.equal('coverRef' in disciplined.entries[bareKey], false, `上游没给的那行补一次之后仍是空：${JSON.stringify(bare)}`);
  } finally {
    await route.close();
  }
});

test('R226（iii）从生产入口打进来：导入 ⇒ tracks() 那一行拿到的是**同源代理**地址，响应里零第三方 URL', async () => {
  const route = await routeServer({ importBridge: fakeBridge({ trackCount: 4, withCover: true }) });
  try {
    const imported = await fetch(`${route.origin}/api/online/playlist/import`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: 'https://music.163.com/playlist?id=17429985859' }),
    });
    const body = await imported.json();
    assert.equal(body.ok, true, JSON.stringify(body));
    assert.equal(body.sourceIdentities.covers, 2, '导入这一步就该把封面一并写进去（用户那张单缺的正是这一格）');
    const view = await (await fetch(`${route.origin}/api/playlists/${body.id}/tracks`)).json();
    const rows = view.items ?? [];
    assert.equal(rows.length, 4);
    assert.equal(rows.filter((entry) => entry.matched).length, 4, '四行都走来源身份 ⇒ 全匹配');
    const withCover = rows.filter((entry) => entry.track?.coverUrl);
    assert.equal(withCover.length, 2, `身份行里有封面的那两行该出图：${JSON.stringify(rows.map((entry) => entry.track?.coverUrl))}`);
    for (const entry of withCover) {
      assert.match(entry.track.coverUrl, /^\/api\/online\/artwork\/[\w-]+$/,
        '界面拿到的必须是**同源代理**地址（R116 那条红线：第三方图片地址从不出服务端）');
    }
    const text = JSON.stringify(view);
    assert.equal(/https?:\/\/(?!127\.0\.0\.1|localhost)[\w.-]+\/\S*\.jpg/.test(text), false, '响应里不许出现任何第三方图片地址');
    assert.equal(text.includes('p3.music.126.net'), false, '逐字再钉一次那张实测主机');
    // 没给图的那两行：不是画一个假图，而是留空串给界面画占位（与 F3 同一口径）
    for (const entry of rows.filter((row) => row.track?.coverUrl === '')) {
      assert.equal(entry.track.coverUrl, '', '没有就是空串（固定形状），不许按 id 造地址');
    }
  } finally {
    await route.close();
  }
});
