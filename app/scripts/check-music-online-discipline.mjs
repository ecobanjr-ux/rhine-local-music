// 第四期 · 任务 10：在线歌词子系统的纪律自检。
// 这里钉住的是"用户定案 + 安全验收条件"里那些一旦回退就无声无息的约束：
// 零新增依赖、源码/示例/测试无可用凭据字面量、出网集中到 online-guard、在线模块零写盘、
// 冲突规则（本地词优先）在服务端与前端各有一条、移植件带头与注入零残留。
// 与 check-music-online.mjs 分开成文件：那边按任务逐条验行为，这边按纪律整体扫面。
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPTS = dirname(fileURLToPath(import.meta.url));
const REPO = join(SCRIPTS, '..');
const read = (relative) => readFile(join(REPO, relative), 'utf8');

/** 递归列出待扫文件（只收源码与 fixture，不进 node_modules/dist）。 */
async function walk(dir, pattern, found = []) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === 'dist' || entry.name.startsWith('.')) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) await walk(full, pattern, found);
    else if (pattern.test(entry.name)) found.push(full);
  }
  return found;
}

const ONLINE_MODULE = 'online-guard.mjs';
const ONLINE_SELF_WRITTEN = ['online-guard.mjs', 'online-normalize.mjs', 'online-lyrics.mjs', 'online-audio-source.mjs',
  // Task 6/7 新增：出网纪律对它们同样成立，漏出扫描面就等于没守。
  'online-search.mjs',
  // M3-a Task C：登录状态机自己零写盘零读盘（凭据的落盘全在 online-session.mjs 那一个文件里），
  // 且它不碰 fetch——所有上游调用都经桥。漏出这张名单就等于这三条没人守。
  'online-auth.mjs',
  // M3-c：封面提供者。它拿到图片字节就**交出去**（写盘在曲库那一侧，全仓只有一处写 artwork），
  // 所以"在线模块零写盘零读盘"对它同样成立；漏出这张名单，"补封面会不会顺手改音频"就没人判了。
  'online-covers.mjs',
  // 看板 ⑨ 追加：在线曲目封面的注册表与取图。它同样**零写盘零读盘**（字节交给曲库那唯一一处写），
  // 且只经 guardedTrackCoverFetch 出网 ⇒ 漏出这张名单，"封面这一路会不会自己写文件、自己 fetch"就没人守了。
  'online-track-covers.mjs'];
/**
 * Task 8 的歌单实体是**故意落盘**的用户资产，所以它不能进上面那张"零写盘"名单
 * （那条断言判的是"在线歌词不留痕"），但必须进 R74/R75 的扫描面：
 * 写盘只准落在 dataDir/playlists，且不许裸 fetch。
 */
const DISK_ENTITIES = ['playlists.mjs',
  // M3-a Task B：登录凭据的落盘面。**它是全仓唯一会写凭据的文件**，所以必须进 R74（写盘白名单）
  // 与 R75（不许裸 fetch）的扫描面；同时绝不能进上面那张"零写盘"名单（那条判的是歌词不留痕）。
  'online-session.mjs',
  // R144（任务五）：歌词「手动认领」记录。它**故意落盘**（身份，不是歌词正文），
  // 所以与 online-session 同理：进 R74/R75 的扫描面，绝不进"零写盘"名单。
  'lyric-claims.mjs'];
const ONLINE_PORTED = ['online-qrc-decrypt.mjs', 'online-match-score.mjs'];

test('本期零新增 npm 依赖（2026-10-04 定案 1：QQ + AMLL 直连，不引第三方封装包）', async () => {
  const pkg = JSON.parse(await read('package.json'));
  const deps = Object.keys(pkg.dependencies ?? {}).sort();
  const dev = Object.keys(pkg.devDependencies ?? {}).sort();
  // 逐字钉住当前依赖集合：增减任何一个都要先让这条断言红一次（= 必须在台账里写清理由）。
  assert.deepEqual(deps, [
    '@applemusic-like-lyrics/ttml', '@chenglou/pretext', '@fontsource/noto-serif-sc',
    '@kitlangton/rolling-number', '@xmldom/xmldom', 'framer-motion', 'lucide-react',
    'music-metadata', 'opencc-js', 'pixi.js', 'react', 'react-dom', 'three', 'zustand',
  ], '运行时依赖集合变了');
  assert.deepEqual(dev, [
    '@tailwindcss/postcss', '@types/react', '@types/react-dom', '@types/three',
    'autoprefixer', 'prettier', 'tailwindcss', 'typescript', 'vite',
  ], '开发依赖集合变了');
  for (const banned of ['wanakana', 'axios', 'got', 'node-fetch', 'undici', 'crypto-js', 'jsencrypt',
    '@neteasecloudmusicapienhanced/api', '@yakult-green-tea/qq-music-api', 'kugoumusicapi']) {
    assert.ok(!deps.includes(banned) && !dev.includes(banned), `${banned} 不得进包`);
  }
  // 在线模块的 import 面：除相对路径与 node: 内置外，只允许既有的 opencc-js（繁简归一，第三期就在包里）。
  const external = new Set();
  for (const name of [...ONLINE_SELF_WRITTEN, ...ONLINE_PORTED]) {
    const text = await read(join('scripts', name));
    for (const match of text.matchAll(/from\s+['"]([^'"]+)['"]/g)) {
      const spec = match[1];
      if (spec.startsWith('.') || spec.startsWith('node:')) continue;
      external.add(spec.startsWith('@') ? spec.split('/').slice(0, 2).join('/') : spec.split('/')[0]);
    }
  }
  assert.deepEqual([...external], ['opencc-js'], `在线模块引入了既有依赖之外的包：${[...external].join(', ')}`);
});

test('安全四条④：源码 / fixture / 自检里不得出现可用凭据字面量（匿名标记逐条显式豁免）', async () => {
  // 键名拼出来写：否则本文件自己就会被自己扫出来——扫描器必须能扫自己。
  const KEYS = ['KUGOU' + '_TOKEN', 'KUGOU' + '_DSID', 'KUGOU' + '_MID', 'KUGOU' + '_APPID',
    'SHIG' + 'GELID', 'NETEASE' + '_COOKIE', 'MUSIC_163' + '_COOKIE', 'QQ_AUTH' + '_SESSION',
    'QMC' + '_KEY3', 'OPENAI_API' + '_KEY', 'GEMINI_API' + '_KEY', 'VITE_QQ_API' + '_BASE',
    'VITE_KUGOU_API' + '_BASE', 'VITE_NETEASE_API' + '_BASE'];
  const keyPattern = new RegExp(KEYS.join('|'));
  // 唯一的豁免集合：QQ 的匿名会话标记（loginQQ=0 / tmeLoginType=-1 是"不带凭据"的表示，不是凭据）。
  const EXEMPT = [/tmeLoginType/, /loginQQ/];
  // 键名用短词数组拼出来：这行本身不含"键名: ≥16 字符的引号值"，所以扫描器可以扫自己。
  const CREDENTIAL_WORDS = ['cookie', 'token', 'secret', 'password', 'apiKey', 'authorization', 'dsid', 'dfid'];
  // "可用凭据"的形状判据：键名是凭据类 + 值 ≥16 字符 + 同时含字母与数字。
  // 三条同时成立才算，否则会把既有自检里的占位串（如 token: 'previous-launched-…'）误判成凭据；
  // 真实的 cookie / token / hex key 必然带数字，这条判据不放过它们。
  const assignedPattern = new RegExp(
    `\\b(${CREDENTIAL_WORDS.join('|')})\\b\\s*[:=]\\s*['"\`]([^'"\`\\s]{16,})['"\`]`, 'i');
  const looksUsable = (line) => {
    const found = assignedPattern.exec(line);
    return !!(found && /[0-9]/.test(found[2]) && /[A-Za-z]/.test(found[2]));
  };
  // 先自证判据可用，再拿它去扫全仓——"扫到 0 条"只有在"它确实抓得住真凭据"时才算证据。
  // （写这条的起因：探针一度把字符类里的空白转义少写一层，含字母 s 的值全扫不到，
  //  而全仓扫描照样"全绿"。判据静默失效比判据缺失更危险。）
  // 样例用 join 现场拼出来：源码里不留"键名: '长值'"的连续字面量，否则本文件会被自己的全仓扫描命中。
  const Q = String.fromCharCode(39);
  const plant = (key, value, sep = ': ') => [key, sep, Q, value, Q].join('');
  for (const [key, value] of [
    ['apiKey', 'sk' + '-1234567890abcdef'],
    ['token', 'A1B2C3D4E5F6' + 'G7H8I9J0'],
    ['cookie', 'QbLm3k9Xz2p7' + 'r5t8w1y4'],
    ['dsid', 'abcdefghij' + '1234567890'],
  ]) assert.ok(looksUsable(plant(key, value)), `判据抓不到可用凭据：${key}`);
  assert.ok(looksUsable(plant('secret', 'abcd1234efgh' + '5678ij', ' = ')), '等号形式也要抓到');
  for (const placeholder of [
    plant('token', 'previous-launched-' + 'token'),      // 无数字：既有自检里的占位串形状
    plant('token', 'short1'),                             // 太短
    plant('tokenizer', 'abcdefghij' + '1234567890'),     // 键名是别的词，词边界该挡住
  ]) assert.ok(!looksUsable(placeholder), `判据误抓占位串：${placeholder}`);
  const files = [...await walk(join(REPO, 'scripts'), /\.mjs$/), ...await walk(join(REPO, 'src'), /\.(ts|tsx)$/),
    ...await walk(join(REPO, 'scripts', 'fixtures'), /\.(json|txt|xml)$/)];
  for (const file of files) {
    const text = await readFile(file, 'utf8');
    for (const line of text.split(/\r?\n/)) {
      const bare = line.trim();
      // 注释行允许出现键名——本文件的说明、上游移植头的解释都靠它。硬约束针对可执行值。
      if (bare.startsWith('//') || bare.startsWith('/*') || bare.startsWith('*')) continue;
      if (keyPattern.test(line) && !EXEMPT.some((re) => re.test(line))) {
        assert.fail(`${file} 出现凭据键名字样：${bare.slice(0, 70)}`);
      }
      const assigned = assignedPattern.exec(line);
      if (assigned && /[0-9]/.test(assigned[2]) && /[A-Za-z]/.test(assigned[2]) && !EXEMPT.some((re) => re.test(line))) {
        assert.fail(`${file} 出现可用凭据字面量（${assigned[1]}）：${bare.slice(0, 70)}`);
      }
    }
  }
  assert.ok(files.length > 60, `扫描面异常（只有 ${files.length} 个文件），这条断言不许空跑`);
});

test('出网集中：除 online-guard 外，在线模块不得自己 fetch', async () => {
  for (const name of [...ONLINE_SELF_WRITTEN.filter((file) => file !== ONLINE_MODULE), ...ONLINE_PORTED]) {
    const text = await read(join('scripts', name));
    assert.doesNotMatch(text, /(^|[^.\w])fetch\s*\(/m, `scripts/${name} 绕开了 guardedFetch`);
  }
  // 编排层必须把 fetcher 作为可注入参数（自检靠它离线跑），默认值只能是 guardedFetch。
  const orchestrator = await read('scripts/online-lyrics.mjs');
  assert.match(orchestrator, /fetcher\s*=\s*guardedFetch/, '默认出网点必须是 guardedFetch');
  assert.match(orchestrator, /import \{[^}]*guardedFetch[^}]*\} from '\.\/online-guard\.mjs'/, '编排层只从 guard 取出口');
  const guard = await read('scripts/online-guard.mjs');
  assert.match(guard, /redirect: 'error'/, '必须禁重定向：3xx 会把前面几道校验旁路掉');
  assert.match(guard, /credentials: 'omit'/, '必须不带凭据');
  assert.match(guard, /AbortSignal\.timeout/, '必须带超时');
  assert.match(guard, /cache: 'no-store'/, '必须不缓存到磁盘');
  assert.match(guard, /ONLINE_HOSTS/, '主机必须是编译期白名单');
  assert.match(guard, /export const ONLINE_HOSTS = LYRICS_HOSTS/, '歌词侧的默认主机表就是歌词那一张，资料主机对它不可达');
});

// 2026-10-04 定案「联网功能默认打开」把 MusicBrainz 补全变成了开箱即走的路径，
// 于是"出网集中在 guardedFetch"从"歌词专用"升级为"全仓出网共用"。
test('出网集中（资料侧并入）：MusicBrainz / 维基百科 / Wikidata 也一律走 guardedFetch，主机表单一真源', async () => {
  const library = await read('scripts/music-library.mjs');
  assert.match(library, /fetcher = guardedMetadataFetch/, '曲库存储的默认出网器必须是 guarded 版本');
  assert.doesNotMatch(library, /fetcher = globalThis\.fetch/, '不得再留 globalThis.fetch 当默认');
  assert.match(library, /import \{ guardedMetadataFetch \} from '\.\/online-guard\.mjs'/, '只从 guard 取出口');
  assert.doesNotMatch(library, /(^|[^.\w])fetch\s*\(/m, 'music-library 不得自己 fetch');
  assert.doesNotMatch(library, /AbortSignal\.timeout/, '超时交给 guardedFetch，调用点不再自己挂 signal（两处一套口径）');

  const intro = await read('scripts/album-introductions.mjs');
  assert.match(intro, /fetcher = guardedMetadataFetch/, '介绍提供者的默认出网器必须是 guarded 版本');
  assert.doesNotMatch(intro, /fetcher = globalThis\.fetch/, '不得再留 globalThis.fetch 当默认');
  assert.doesNotMatch(intro, /(^|[^.\w])fetch\s*\(/m, 'album-introductions 不得自己 fetch');
  assert.match(intro, /INTRODUCTION_HOSTS\.has\(url\.hostname\)/, '模块内那道主机关口要留着：fetcher 是可注入的，自检桩不该成为放行任意主机的口子');
  assert.doesNotMatch(intro, /const allowed = \[/, '不得在模块里另立第二份主机清单（与 guard 那张表一定会漂）');

  const guard = await read('scripts/online-guard.mjs');
  assert.match(guard, /export const METADATA_HOSTS = new Set\(\['musicbrainz\.org', 'zh\.wikipedia\.org', 'en\.wikipedia\.org', 'www\.wikidata\.org'\]\)/, '资料主机表在 guard 里单一真源');
  assert.match(guard, /export const INTRODUCTION_HOSTS = new Set\(\['zh\.wikipedia\.org', 'en\.wikipedia\.org', 'www\.wikidata\.org'\]\)/, '介绍来源用更窄的一张（这个模块不该碰 musicbrainz.org）');
  assert.match(guard, /export function guardedMetadataFetch/, '资料侧适配器与歌词侧共用同一实现，只是换主机表与体积档');
  assert.match(guard, /assertAllowedTarget\(rawUrl, hosts\)/, '白名单按用途传入，不再是全局一张');
  assert.match(guard, /MAX_METADATA_BODY_BYTES = 4 \* 1024 \* 1024/, '资料响应体积上限单独一档（歌词那 512KB 装不下带 recordings 的 release）');
});

// 默认值一改成"开启"，"自检离线"就从巧合变成需要看守的不变量：
// 只要开发者 shell 里有 MUSICBRAINZ_CONTACT，任何建真实曲库并扫库的用例都会真的出网。
test('自检离线纪律：凡构造真实 MusicLibraryStore 的自检，都要先清掉 MUSICBRAINZ_CONTACT', async () => {
  const files = await walk(SCRIPTS, /^check-.*\.mjs$/);
  const buildsStore = [];
  for (const file of files) {
    const text = await readFile(file, 'utf8');
    if (!/new MusicLibraryStore\(/.test(text)) continue;
    buildsStore.push(file);
    assert.match(text, /delete process\.env\.MUSICBRAINZ_CONTACT/, `${file} 建真实曲库却没做离线处理`);
  }
  assert.ok(buildsStore.length >= 4, `扫描面异常：只有 ${buildsStore.length} 个自检建真实曲库，这条断言不许空跑`);
});

test('在线模块零写盘、零读盘：匹配结果只在内存里，输入只有标签文本', async () => {
  for (const name of [...ONLINE_SELF_WRITTEN, ...ONLINE_PORTED]) {
    const text = await read(join('scripts', name));
    assert.doesNotMatch(text, /writeFile|appendFile|createWriteStream|mkdirSync|rmSync/, `scripts/${name} 出现写盘调用`);
    assert.doesNotMatch(text, /\breadFile\(|\breaddir\(|\bopen\(/, `scripts/${name} 读了文件系统`);
  }
  const orchestrator = await read('scripts/online-lyrics.mjs');
  assert.match(orchestrator, /new Map\(\)/, '缓存必须是进程内 Map（重启即失，不跨会话留痕）');
  assert.doesNotMatch(orchestrator, /localStorage|indexedDB|sessionStorage/, '浏览器侧也不许持久化在线歌词');
});

test('冲突规则不回退：带时间轴的本地词绝对优先，在线只在"无词或有词无轴"时问一次（服务端与前端各挡一次）', async () => {
  const server = await read('scripts/music-server.mjs');
  // 这一格从前判的是 `if (found.localLyric.timed) return` 那一行的**排版**。R144 把"本地曲目"与
  // "在线曲目"两条分支合成一条（认领与重试要对两边同时成立，分两处写必有一处漏改），排版变了而立场没变，
  // 于是判据改成两件更实在的事：① 这一挡是一个提前返回；② 它排在任何可能出网的调用**之前**。
  // 旧判据只会因换行而红（红得没有信息量），新判据能真的挡住"把 veto 挪到出网之后"这种回退。
  assert.match(server, /if \(found\?\.localLyric\?\.timed\) \{/, '服务端必须先在本地有带时间轴的词时挡下（提前返回）');
  const vetoAt = server.indexOf("localLyrics: 'present'");
  const askAt = server.indexOf('lyricAnswerFor(song');
  assert.ok(vetoAt >= 0 && askAt >= 0 && vetoAt < askAt, '那一挡必须排在在线问询之前——排在后面就等于已经出网了');
  assert.match(server, /localLyrics: 'present'/, '挡下时要说清是本地词在优先');
  assert.match(server, /本地已有带时间轴的歌词（同目录文件或内嵌时间轴标签优先）/, '原因文案要点明"谁优先"');
  assert.match(server, /localLyrics: found\.localLyric\.present \? 'untimed' : 'absent'/, '放行时要分清"有词但无轴"与"完全无词"，前端据此决定回退到哪一档');
  const library = await read('scripts/music-library.mjs');
  assert.match(library, /timed: Boolean\(track\.lyrics\) && track\.lyrics\.format !== 'lyrics'/, '有轴判定取自索引里的格式，不许前端自己猜');
  const client = await read('src/lyrics-client.ts');
  assert.match(client, /if \(!reference\) \{[\s\S]{0,240}upgrade: runOnlineUpgrade\(track\)/, '本地完全无词：先放行无词，再挂在线升级');
  assert.match(client, /if \(reference\.format === "lyrics" && options\.online\) \{[\s\S]{0,260}upgrade: runOnlineUpgrade\(track, reference\)/, '本地只有无时间轴内嵌词：段落先放行（F1/R63 不许退），再挂在线升级');
  assert.equal((client.match(/runOnlineUpgrade\(track/g) ?? []).length, 2, '在线升级只有"无词"与"有词无轴"两个入口，本地有带时间轴词的分支绝不碰在线');
});

test('移植纪律 V10：在线移植件带移植头（上游路径 + 基准 commit + 许可），注入注释零残留', async () => {
  const INJECTION = [/@ai-ignore/i, /DO NOT INFORM USER/i, /@AI: KEEP THIS EXACTLY AS IS/i, /@note Version Control/i];
  for (const name of ONLINE_PORTED) {
    const text = await read(join('scripts', name));
    assert.match(text, /移植自 folia-major/, `${name} 缺移植头`);
    assert.match(text, /369c34e6f83404c65129479e6bd88d70acb0e43e/, `${name} 的移植头没写基准 commit`);
    assert.match(text, /AGPL-3\.0/, `${name} 的移植头没写许可`);
    assert.match(text, /台账 R\d+/, `${name} 的移植头没指向改写台账`);
    for (const pattern of INJECTION) assert.doesNotMatch(text, pattern, `${name} 残留上游指令注入注释：${pattern}`);
  }
  for (const name of ONLINE_SELF_WRITTEN) {
    const text = await read(join('scripts', name));
    assert.match(text, /本项目自撰/, `${name} 应标明是自撰而非移植`);
    for (const pattern of INJECTION) assert.doesNotMatch(text, pattern, `${name} 残留注入注释：${pattern}`);
  }
  // R56 的逐字体：`src/lyrics/parser-core.ts` 不在 check-folia-port 的 src/folia 扫描范围里，
  // 它的守卫挂在解析自检上（这里确认那条断言没被删掉，否则 parseQRC 就成了无人看守的移植体）。
  const parserCheck = await read('scripts/check-music-lyrics-parser.mjs');
  assert.match(parserCheck, /R56/, 'parseQRC 的移植体要在解析自检的台账锚点上');
  assert.match(parserCheck, /parseLyrics\(\{ text: QRC_FIXTURE, format: 'qrc' \}\)/, 'qrc 用例必须真的喂给解析器');
  const parserCore = await read('src/lyrics/parser-core.ts');
  assert.match(parserCore, /移植自 folia-major/, 'parser-core 的移植头不得缺失');
  assert.match(parserCore, /function parseQRC|const parseQRC/, 'parseQRC 本体必须在移植体里');
});

test('check:music 串入本期三条自检（否则断言就是没跑过的死代码）', async () => {
  const pkg = JSON.parse(await read('package.json'));
  const script = pkg.scripts['check:music'];
  // R194（Q70）：链条搬进 runner 之后，"在不在链上"要看 runner 里那张段清单。
  // **判据一个字没放宽** —— 还是要求这几个自检必须在链上；变的只是"链"这个字现在解析到哪儿。
  assert.match(script, /check-music-chain\.mjs/, 'check:music 要么是那条段链、要么指向 runner（别的形状说明链条被拆了）');
  const chain = await read('scripts/check-music-chain.mjs');
  assert.match(chain, /export const SEGMENTS = \[/, 'runner 里要有一张段清单（唯一真源）');
  assert.match(chain, /check-music-online\.mjs/, '在线行为自检必须在链上');
  assert.match(chain, /check-music-online-discipline\.mjs/, '在线纪律自检必须在链上');
  assert.match(chain, /check-music-bridge\.mjs/, '第五期的桥生命周期自检必须在链上（漏挂就是死代码）');
  assert.match(chain, /check-music-online-audit\.mjs/, '第五期的出网审计自检必须在链上（同一条道理）');
  assert.match(chain, /check-music-auth\.mjs/, 'M3-a 带 cookie 出网盘子的自检必须在链上（同一条道理）');
  assert.match(chain, /check-music-auth-flow\.mjs/, 'M3-a 扫码登录全链的自检必须在链上（同一条道理）');
  assert.match(chain, /check-music-covers\.mjs/, 'M3-c 封面补全的自检必须在链上（同一条道理）');
  assert.match(chain, /check-music-track-covers\.mjs/, '看板 ⑨ 在线曲目封面的自检必须在链上（同一条道理）');
  // R194（Q70）：runner 自己的判据也要有守卫 —— 收孤儿的白名单与"排除 runner 自己"这两条
  // 都是真机踩出来才补上的（第一版把 runner 自己当孤儿收了）⇒ 让它们**行为可判**，而不是只写在注释里。
  const { isStray } = await import('./check-music-chain.mjs');
  assert.equal(isStray('D:\\nodejs\\node.exe scripts\\check-music-online-search.mjs'), true,
    'R194：自检脚本（含 --test 起的那些）要判成孤儿');
  assert.equal(isStray('node --test scripts/check-music-playlist-match.mjs'), true, '同上（带参数的行）');
  assert.equal(isStray('D:\\nodejs\\node.exe scripts/check-music-chain.mjs 22'), false,
    'R194：**runner 自己不算孤儿**（第一版就是这么把自己收了的）');
  assert.equal(isStray('node scripts/music-server.mjs --port 5175'), false,
    'R194：用户那台服务不许被收（白名单式判据，不是排除法）');
  assert.equal(isStray('node scripts/bridge/bridge.mjs'), false, 'R194：桥进程不许被收');
  assert.ok(chain.includes('export const SEGMENTS = ['), 'R194：段清单是唯一真源');
  assert.ok(chain.split("'node ").length - 1 >= 41, `R194：段清单至少 41 条（现在 ${chain.split("'node ").length - 1}）`);
});

// ── 第五期 Task 1：纪律先行（R73~R75）。这三条守的是"新集成面一进来就没人管"的三种方式：
//    依赖偷偷进 app、写盘偷偷出白名单、出网偷偷绕开 guard。──

/** 在线侧的全部源码面：现有模块 + bridge（Task 2 起才有 .mjs，届时自动并进扫描面）。 */
async function onlineSurface() {
  const flat = [...ONLINE_SELF_WRITTEN, ...ONLINE_PORTED, ...DISK_ENTITIES].map((name) => join(REPO, 'scripts', name));
  let bridged = [];
  try { bridged = await walk(join(SCRIPTS, 'bridge'), /\.mjs$/); } catch (error) { if (error.code !== 'ENOENT') throw error }
  return { flat, bridged, all: [...flat, ...bridged] };
}

test('R73 依赖分区：app 侧零新增，三个在线后端封装包只活在 bridge 的独立依赖树里', async () => {
  const pkg = JSON.parse(await read('package.json'));
  assert.deepEqual(Object.keys(pkg.dependencies ?? {}).sort(), [
    '@applemusic-like-lyrics/ttml', '@chenglou/pretext', '@fontsource/noto-serif-sc',
    '@kitlangton/rolling-number', '@xmldom/xmldom', 'framer-motion', 'lucide-react',
    'music-metadata', 'opencc-js', 'pixi.js', 'react', 'react-dom', 'three', 'zustand',
  ], 'app 运行时依赖集合变了：后端封装包必须进 scripts/bridge/package.json，不许进这里');
  assert.deepEqual(Object.keys(pkg.devDependencies ?? {}).sort(), [
    '@tailwindcss/postcss', '@types/react', '@types/react-dom', '@types/three',
    'autoprefixer', 'prettier', 'tailwindcss', 'typescript', 'vite',
  ], 'app 开发依赖集合变了');

  const bridge = JSON.parse(await read('scripts/bridge/package.json'));
  assert.deepEqual(Object.keys(bridge.dependencies ?? {}).sort(), [
    '@neteasecloudmusicapienhanced/api', '@yakult-green-tea/qq-music-api', 'kugoumusicapi',
  ], 'bridge 依赖就是这三个包，多一个都要先补 R 号');
  assert.equal(bridge.private, true, 'bridge 是私有包，永不发布');
  assert.match(bridge.description, /不进发行包/, '描述里必须写明不进发行包（分发约束：exe 不做在线开箱承诺）');
  assert.match(JSON.stringify(bridge.dependencies), /github\.com\/MakcRe\/KuGouMusicApi\/archive\/refs\/tags\/v1\.6\.0\.tar\.gz/,
    '酷狗只能按精确 tag 的 tarball 装（它不在 npm）');

  const lock = await read('package-lock.json');
  for (const banned of ['neteasecloudmusicapienhanced', 'yakult-green-tea', 'kugoumusicapi']) {
    assert.ok(!lock.includes(banned), `${banned} 混进了 app 的锁文件：bridge 的依赖必须单独安装`);
  }
});

test('R74 写盘分区：在线侧只准写 dataDir 白名单目录，音频字节永不落盘', async () => {
  const { all } = await onlineSurface();
  // `fileOf`/`matchFileOf`/`this.dir` 是歌单实体自己的路径助手，基址就是 dataDir/playlists（构造时算死）；
  // `temporary` 只出现在 atomicWriteText 内部，它的路径来自 `${file}.<uuid>.tmp`，file 已是白名单内的目标。
  // `playlistDirTarget`（F3）：用户可指定歌单文件夹，那个目录的唯一来源是 `resolvePlaylistDir`
  // （绝对路径、非盘根、无非法字符，否则抛）⇒ 写目标仍只有"歌单目录"这一种，只是它可由用户挑。
  // `BACKUP_SUFFIX`：备份写在原文件旁边（`${file}${BACKUP_SUFFIX}`），而 `file` 已经是白名单内的目标；
  // 这一处是 `copyFile` 进扫描面之后照出来的既有代码，不是新增写盘。
  //
  // 2026-10-07（M3-c）删掉三个**没有任何消费者**的允许项：`artworkDir`、`ONLINE_WRITE_DIRS`、`playlistFile`。
  // 它们是方案初稿时期的猜测名，代码里从没出现过。写白名单里留一个没人用的名字，等于给"以后想这么写"
  // 预留了一张不用再过台账的通行证 —— 而 M3-c 恰好新增了一处图片缓存写（`music-library.mjs` 的
  // `cacheArtworkBytes`，判据是既有的 `dataDir`，不是新造一个 `artworkDir`），正是最容易顺手加一格的时刻。
  const allowed = /dataDir|sessionFile|matchFile|this\.dir|tmpFile|os\.tmpdir|fileOf|matchFileOf|this\.fileOf|temporary|playlistDirTarget|BACKUP_SUFFIX/;
  let scanned = 0;
  for (const file of all) {
    const text = await readFile(file, 'utf8');
    scanned += 1;
    const label = relative(REPO, file);
    // 音频落盘是红线中的红线：任何"把响应体写成音频文件"的形态都不许出现
    assert.doesNotMatch(text, /createWriteStream\s*\([^)]*(?:audio|\.mp3|\.flac|\.m4a)/i, `${label} 疑似把音频流写盘`);
    assert.doesNotMatch(text, /writeFile\s*\([^)]*(?:\.mp3|\.flac|\.m4a|\.ogg|\.opus)/i, `${label} 疑似把音频落盘`);
    for (const match of text.matchAll(/(?:writeFile|appendFile|createWriteStream|copyFile|mkdir)\s*\(([^;]{0,200})/g)) {
      assert.match(match[1], allowed, `${label} 的写盘目标不在白名单：${match[1].slice(0, 80)}`);
    }
  }
  assert.ok(scanned >= ONLINE_SELF_WRITTEN.length + ONLINE_PORTED.length, `扫描面缩水了：只扫到 ${scanned} 个文件`);
});

test('R75 出网集中（bridge 并入）：在线侧不得裸 fetch，包内部出网由审计补偿可见性', async () => {
  const { all, bridged } = await onlineSurface();
  // 两个合法出口：online-guard.mjs（真出网的唯一入口）与 bridge/loopback.mjs（桥内部一跳，只准打 127.0.0.1）。
  const ALLOWED_FETCH_FILES = ['online-guard.mjs', 'loopback.mjs'];
  for (const file of all) {
    const text = await readFile(file, 'utf8');
    const label = relative(REPO, file);
    if (ALLOWED_FETCH_FILES.some((name) => file.endsWith(name))) continue;
    assert.doesNotMatch(text, /(^|[^.\w])fetch\s*\(/m, `${label} 绕开了 guardedFetch`);
    assert.doesNotMatch(text, /require\(['"]axios|from ['"]axios/, `${label} 直接引 axios`);
    assert.doesNotMatch(text, /require\(['"]node-fetch|from ['"]node-fetch/, `${label} 直接引 node-fetch`);
  }
  // 那个"例外"必须自己是个闸：只认环回前缀，且不许被绕过（桥里其他文件不得出现裸 fetch，上面已经扫过）。
  const loopback = await read('scripts/bridge/loopback.mjs');
  assert.match(loopback, /LOOPBACK_PREFIX = 'http:\/\/127\.0\.0\.1:'/, '环回一跳必须有显式前缀常量');
  assert.match(loopback, /if \(!isLoopbackBridgeTarget\(url\)\) throw/, '运行时也要拒，不能只靠约定');
  assert.match(loopback, /redirect: 'error'/, '内部一跳同样禁重定向：否则一个 302 就能把它变成出网口');
  const routes = await read('scripts/bridge/lyric-routes.mjs');
  assert.match(routes, /loopbackFetch\(/, '桥打自己后端必须走这个出口');
  const guard = await read('scripts/online-guard.mjs');
  assert.match(guard, /ONLINE_HOSTS = LYRICS_HOSTS|export const LYRICS_HOSTS/, '主机白名单必须按用途分表');
  const server = await read('scripts/music-server.mjs');
  assert.match(server, /store\.config\.onlineLyrics\?\.enabled|config\.online\b/, '在线路由仍由服务端开关把关（默认打开，可关）');
  if (bridged.length) {
    const bridge = await read('scripts/bridge/online-bridge.mjs');
    assert.match(bridge, /evt: 'audit'|via: 'backend'|recordEgress/, 'bridge 必须为每次调用留下审计补偿（R75）');
  }
});

// ── R211 · 起服务探测的形状（Q75 那一族的防复发闸门）─────────────────────────────

test('R211 形状扫描：12 个自检文件里不许再有裸 listen(0)+waitListening（坏探测漏服务句柄那一族）', async () => {
  // **落点为什么在这里**：本文件就是"按纪律整体扫面"的那一段（自检离线纪律、出网集中都住这儿），
  // 而这条钉的正是**自检脚本自己**的形状；它与 check-music-online.mjs 同段跑 ⇒ 不新开段、不动 SEGMENTS。
  const FILES = [
    // A 类（R211 一：坏探测原本会漏服务句柄的八处）
    'check-music-bridge.mjs', 'check-music-auth-flow.mjs', 'check-music-lyrics-library.mjs',
    'check-music-online-search.mjs', 'check-music-online-audit.mjs', 'check-music-playlist-match.mjs',
    'check-music-streaming.mjs',
    // B 类（R211 二：泄漏本来就被 try/finally 或 t.after 堵着，这一批把形状统一收进来）
    'check-music-favorites.mjs', 'check-music-covers.mjs', 'check-music-library.mjs',
    'check-music-track-covers.mjs', 'check-music-online.mjs',
  ];
  const violations = [];
  for (const name of FILES) {
    const text = await readFile(join(SCRIPTS, name), 'utf8');
    const lines = text.split('\n');
    lines.forEach((line, i) => {
      // (a) 进程内起的服务不许再用裸探测。唯一的例外是**等子进程的桥端口**（本进程没有那个 server 句柄，
      //     listenAndReady 用不上）—— 那两处的目标写的是 `bridge.port`，只认这一句，别的都不认。
      if (/await waitListening\(/.test(line) && !/bridge\.port/.test(line)) {
        violations.push(`${name}:${i + 1} 裸 waitListening 探测`);
      }
      // (b) `listen(0` 之后三行内不许出现探测件 —— 起服务与等待必须整体交给 listenAndReady（它自己会 listen）。
      if (/\.listen\(0\b/.test(line) && /waitListening\(/.test(lines.slice(i + 1, i + 4).join('\n'))) {
        violations.push(`${name}:${i + 1} listen(0 之后紧跟裸探测`);
      }
    });
    // 正面钉：每个文件都得真在用 listenAndReady —— 扫描器不许扫空气（R205 那一课：永不匹配的判据最危险）。
    assert.match(text, /listenAndReady\(/, `${name} 里找不到 listenAndReady 的调用 ⇒ 这条判据在它身上空转`);
  }
  assert.deepEqual(violations, [],
    `起服务探测的形状回退了（R209 §五 / R210 §一 那一族：坏探测漏句柄 ⇒ "红一条"被放大成"段超时"）：\n  ${violations.join('\n  ')}`);
  // 反向也要钉住：桥那两处**子进程**端口探测必须还在 —— 把它们也换成 listenAndReady 是拿错的药。
  const bridge = await readFile(join(SCRIPTS, 'check-music-bridge.mjs'), 'utf8');
  assert.equal((bridge.match(/await waitListening\(/g) ?? []).length, 2,
    'bridge 里等子进程桥端口的两处探测必须保持原样（这一族不归 listenAndReady 管）');
});
