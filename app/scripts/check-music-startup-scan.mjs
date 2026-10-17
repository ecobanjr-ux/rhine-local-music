// 阶段 6.6 · 启动自动扫描：护栏（Task 4）+ 触发点与轮询链（Task 4B）。
// 分两个文件写不划算：这一期的三类约束（零根不清库、启动时真的会扫、轮询链不断）
// 都是"扫库时机"这一件事的两面，放回一个文件才看得出它们必须同时成立。
import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { MusicLibraryStore } from './music-library.mjs';

const read = (relative) => fs.readFile(new URL(`../${relative}`, import.meta.url), 'utf8');
// 联网功能默认打开（2026-10-04 定案）后，scan() 排尾会跟着排一轮 MusicBrainz 补全。
// 开发者 shell 里恰好有 MUSICBRAINZ_CONTACT 时，这批扫库自检就会真的出网 —— 自检必须离线，
// 所以在本文件开头把它清掉（构造函数的默认值正是读这个环境变量），让补全走"整轮跳过"分支。
delete process.env.MUSICBRAINZ_CONTACT;

/** 一个真实的临时曲库：每个文件夹一张专辑，内容是可解析的静音 WAV。 */
async function tempLibrary(t, folders) {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'rhine-startup-scan-'));
  t.after(() => fs.rm(temporary, { force: true, recursive: true, maxRetries: 5, retryDelay: 80 }));
  const music = path.join(temporary, 'music');
  await fs.mkdir(music, { recursive: true });
  const bytes = Buffer.alloc(44 + 9600);
  bytes.write('RIFF', 0); bytes.writeUInt32LE(bytes.length - 8, 4); bytes.write('WAVEfmt ', 8);
  bytes.writeUInt32LE(16, 16); bytes.writeUInt16LE(1, 20); bytes.writeUInt16LE(1, 22);
  bytes.writeUInt32LE(48000, 24); bytes.writeUInt32LE(96000, 28); bytes.writeUInt16LE(2, 32);
  bytes.writeUInt16LE(16, 34); bytes.write('data', 36); bytes.writeUInt32LE(9600, 40);
  for (const folder of folders) {
    const dir = path.join(music, folder);
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, 'a.wav'), bytes);
  }
  const store = await new MusicLibraryStore({ dataDir: path.join(temporary, 'index'), defaultRoots: [music] }).init();
  // 联网功能默认打开后，scan() 排尾会跟着排一轮在线资料补全。这两行把联系方式清空，让它走
  // "整轮跳过"那条离线分支 —— 否则开发者 shell 里恰好有 MUSICBRAINZ_CONTACT 时，
  // 一批扫库自检会变成真实出网请求，自检就不再是离线的了。
  store.config.musicBrainzContact = '';
  store.musicBrainzContact = '';
  return { temporary, music, store };
}

test('护栏：空 roots 的扫描必须跳过，磁盘上的索引一张专辑都不能少', async (t) => {
  const { music, store } = await tempLibrary(t, ['一张', '两张']);
  await store.scan({ roots: [music] });
  const populated = store.snapshot().albums.length;
  assert.ok(populated >= 2, `前置条件：索引里要有专辑，实测 ${populated}`);
  const indexFile = path.join(store.dataDir, 'library-index.json');
  const beforeText = await fs.readFile(indexFile, 'utf8');
  assert.ok(JSON.parse(beforeText).albums.length >= 2);

  // 复现第四期真实撞到的场景：另一个实例用同一 dataDir 但环境里没有根目录。
  const orphan = await new MusicLibraryStore({ dataDir: store.dataDir }).init();
  await orphan.updateConfig({ roots: [] });
  const result = await orphan.scan();
  assert.equal(result.skipped, 'no-roots', '没配目录时必须跳过而不是扫成空');
  assert.equal(orphan.scanStatus.skipped, 'no-roots', '跳过原因要留在状态里，前端才说得出人话');
  assert.equal(orphan.scanPromise, null, '跳过不能留下一把永不落地的锁：否则此后改根目录一律 409、重新扫描一律回旧快照');
  assert.equal(await fs.readFile(indexFile, 'utf8'), beforeText, '磁盘上的索引必须逐字节不变');
});

test('护栏：跳过之后再配上目录，正常扫描能把索引恢复出来', async (t) => {
  const { music, store } = await tempLibrary(t, ['一张']);
  await store.scan({ roots: [music] });
  const orphan = await new MusicLibraryStore({ dataDir: store.dataDir }).init();
  await orphan.updateConfig({ roots: [] });
  assert.equal((await orphan.scan()).skipped, 'no-roots');
  await orphan.updateConfig({ roots: [music] });
  const recovered = await orphan.scan();
  // 必须真的跑了一次新扫描，而不是把上一把（已跳过的）结果原样递回来。
  assert.equal(recovered.skipped, undefined, '恢复目录后不能再返回跳过结果');
  assert.equal(recovered.scan.skipped, undefined, '扫描状态里的跳过标记必须随新扫描清掉');
  assert.ok(orphan.snapshot().albums.length >= 1, '恢复目录后应重新看到专辑');
});

// —— 以下三条属于 Task 4B：触发点（启动器复用路径）、可见性（服务日志）、前提（轮询链不断）。
test('E2：启动器复用已运行服务时必须补一次扫描', async () => {
  const launcher = await read('scripts/launch-music.mjs');
  assert.match(launcher, /function requestPost\(/, '需要一个 POST 助手（既有 requestJson 只做 GET）');
  assert.match(launcher, /requestPost\([^)]*\/api\/library\/scan/, '复用路径必须打一次扫描');
  assert.match(launcher, /const reused = state\.kind === ['"]ours['"][\s\S]{0,400}requestPost/, '触发点就在"已在运行"分支上');
  assert.match(launcher, /return \{ url, port: state\.port, reused \}/, '返回值的 reused 与触发点同源，不再算第二遍');
  // 尽力而为：服务可能正在扫描（202）、端口刚释放，任何失败都不能阻断启动。
  assert.match(launcher, /request\.on\(['"]error['"], \(\) => resolve\(0\)\)/, 'POST 助手不得把失败抛给启动流程');
});

test('E1：服务端启动扫描的结果必须留在服务日志里', async () => {
  const server = await read('scripts/music-server.mjs');
  const hook = /if \(autoScan\) server\.once\(['"]listening['"], \(\) => \{[\s\S]{0,1200}?\n {2}\}\)/.exec(server);
  assert.ok(hook, '要能整段读到启动扫描挂钩');
  assert.doesNotMatch(hook[0], /void store\.scan\(\)\.catch\(\(\) => \{\}\)/, '不得再静默丢弃启动扫描结果');
  assert.match(hook[0], /skipped === ['"]no-roots['"]/, '零根跳过要说人话（Task 4 的护栏结果）');
  assert.match(hook[0], /['"]offline['"]/, '根目录离线要打进日志：现实里"歌没出现"最常见的就是它');
  // scan() 内部已 try/catch，promise 基本不会 reject ⇒ 错误必须从扫描结果里读，而不是只挂在 .catch 上。
  assert.match(hook[0], /scan\?\.error|scan\.error/, '整轮扫描的异常要写进服务日志');
  assert.match(hook[0], /console\.error\(`启动扫描失败/, '失败用 error 级日志');
  // 2026-10-04 定案「联网默认打开」新增的一档：扫描后排的在线资料补全可能整轮跳过。
  // 开关是开的、什么都没补到，用户看到的只有"没反应"——所以这一档必须同样留在日志里。
  assert.match(hook[0], /enrich\?\.skipped === ['"]no-contact['"]/, '缺联系方式的补全跳过要有日志分支');
  assert.match(hook[0], /在线资料补全跳过：尚未配置 MusicBrainz 联系方式/, '日志要给出原因（为什么跳过）与影响面（本地不受影响）');
});

test('E7：前端轮询链在任何提前返回的分支上都必须重新排程', async () => {
  const app = await read('src/music-app.ts');
  const load = app.slice(app.indexOf('async function loadLibrary('), app.indexOf('async function receiveLibrary('));
  assert.ok(load.length > 200, `要能截到 loadLibrary 的函数体，实测 ${load.length}`);
  assert.equal((app.match(/function schedulePoll\(/g) ?? []).length, 1, '排程入口只允许一个函数');
  assert.equal((app.match(/pollTimer = setTimeout/g) ?? []).length, 1, 'pollTimer 只在 schedulePoll 里赋值：散落的排程就是断链的温床');
  assert.equal((app.match(/clearTimeout\(pollTimer\)/g) ?? []).length, 1, '取消排程也只在那一处');
  const guarded = /if \(refreshing\) \{[\s\S]{0,320}?\n {2}\}/.exec(load);
  assert.ok(guarded, '并发保护要留在原位（不能靠去掉保护来续链）');
  assert.match(guarded[0], /schedulePoll\(/, '重叠时也要排下一次：原来这里直接 return，链只能靠"另一个在飞的调用替我排"');
  for (const item of load.matchAll(/\n[ \t]*(return;|return\b[^\n]*;)/g)) {
    const before = load.slice(Math.max(0, item.index - 280), item.index).replace(/\s+/g, ' ');
    assert.match(before, /schedulePoll\(|pollTimer = setTimeout/, `每个返回点前都要有一次排程（断链就是从这种分支发生的）：…${before.slice(-70)}`);
  }
});
