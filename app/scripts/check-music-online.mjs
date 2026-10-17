// 第四期 · 在线歌词自检（node --test）。安全四条逐条可指到断言名，全部离线可跑（不联网）。
// 逐条对应 memory/metadata-strategy.md 的安全验收条件与 docs/superpowers/plans/2026-10-04-folia-port-phase4-online-lyrics.md。
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isBlockedAddress, assertAllowedTarget, guardedFetch, ONLINE_HOSTS, MAX_ONLINE_BODY_BYTES } from './online-guard.mjs';
import { qrcDecrypt } from './online-qrc-decrypt.mjs';
import { listenAndReady } from './check-ready.mjs';
import { unwrapQqLyricPayload, isQrcPayload, countTimedLines, decodeXmlEntities, foldKana } from './online-normalize.mjs';
import { calculateMatchScore, calculateMatchScoreDetails, buildLyricSearchQuery,
  normalizeSongTitleForLyricSearch, normalizeLyricMatchText, normalizeLyricMatchDurationMs,
  SCORE_WEIGHTS, AUTO_MATCH_MIN_SCORE, AUTO_MATCH_COMPONENT_MISS_SCORE_CAP, AUTO_MATCH_SEARCH_LIMIT,
  ALBUM_DIMENSION_IDENTITY_FLOOR, ALBUM_DIMENSION_DURATION_TOLERANCE_MS,
  PROVIDER_SEARCH_TIMEOUT_MS, PROVIDER_LYRIC_TIMEOUT_MS, LYRIC_SOURCES, DEFAULT_LYRIC_SOURCE,
  buildLyricSourceOrder } from './online-match-score.mjs';
import { createOnlineLyricMatcher, hasTimedLyricLines, hasTtmlLyricBody, lyricIdentityFingerprint } from './online-lyrics.mjs';
import { createLyricClaims } from './lyric-claims.mjs';
import { createMusicServer } from './music-server.mjs';

const SCRIPTS = dirname(fileURLToPath(import.meta.url));
const readScript = (name) => readFile(join(SCRIPTS, name), 'utf8');
const readFixture = (name) => readFile(join(SCRIPTS, 'fixtures', name), 'utf8');
const UPSTREAM_QRC = '../../references/folia-major/src/utils/lyrics/providers/qrcDecrypt.ts';

/** 自检一律离线：DNS 也走注入，不打真 DNS。否则本机开着 fake-IP 代理（域名解析到 198.18.0.0/15 这种保留段）时，
 *  地址判据会按设计把请求拦下，用例红的理由却与产品无关——判据没错，是自检偷偷依赖了真实的解析结果。
 *  与 check-music-auth.mjs 的 PUBLIC_DNS 同一手法。 */
const PUBLIC_DNS = async () => [{ address: '104.20.71.5', family: 4 }];


test('安全四条②/③：环回、私有、链路本地、组播、保留、测试网与非法地址一律拒绝', () => {
  const blocked = [
    '0.0.0.0', '10.0.0.5', '100.64.1.2', '100.127.255.255', '127.0.0.1', '127.2.3.4',
    '169.254.1.1', '172.16.9.9', '172.31.9.9', '192.0.0.1', '192.0.2.1', '192.88.99.0',
    '192.168.1.1', '198.18.0.1', '198.19.255.255', '198.51.100.7', '203.0.113.9',
    '224.0.0.1', '239.255.255.255', '240.0.0.1', '255.255.255.255',
    '::', '::1', 'fe80::1', 'fc00::1', 'fd12:3456::78', 'ff02::1', '100::1', '2001:db8::1',
    '::ffff:127.0.0.1', '::ffff:192.168.0.1',
  ];
  for (const ip of blocked) assert.equal(isBlockedAddress(ip), true, `${ip} 必须判为受限`);
  // 192.88.99.0 是 6to4 中继任播的 **/32**（单个地址），.1 不在该段内 —— 断言前缀长度真的被用上
  assert.equal(isBlockedAddress('192.88.99.1'), false, '192.88.99.0/32 只含一个地址');
  for (const ip of ['93.184.216.34', '8.8.8.8', '114.114.114.114', '2001:4860:4860::8888', '2408:8000:0:1::5']) {
    assert.equal(isBlockedAddress(ip), false, `${ip} 是公网地址，不该被拒`);
  }
  for (const junk of ['not-an-ip', '', '999.0.0.1', '1.2.3', '1.2.3.4.5', 'g000::1']) {
    assert.equal(isBlockedAddress(junk), true, `非法地址 ${junk} 一律拒（宁可错杀）`);
  }
});

test('安全四条①：协议与主机——只允许 https 且主机在白名单内', () => {
  assert.equal(assertAllowedTarget('https://u.y.qq.com/cgi-bin/musicu.fcg').hostname, 'u.y.qq.com');
  assert.equal(assertAllowedTarget('https://amll-ttml-db.stevexmh.net/qq/1?format=ttml').hostname, 'amll-ttml-db.stevexmh.net');
  const rejected = [
    'http://u.y.qq.com/cgi-bin/musicu.fcg',            // 明文一律拒（比验收底线更严）
    'ftp://u.y.qq.com/x', 'file:///etc/passwd', 'data:text/plain,hi', 'blob:http://x/y',
    'https://127.0.0.1:8080/x', 'https://localhost/x', 'https://metadata.google.internal/x',
    'https://evil.example.com/cgi-bin/x', 'https://u.y.qq.com.evil.example/cgi-bin/x',
    'https://user:***@u.y.qq.com/x', 'https://u.y.qq.com:8443/x', 'not a url', '',
  ];
  for (const bad of rejected) assert.throws(() => assertAllowedTarget(bad), /ONLINE_TARGET_REJECTED/, `${bad} 必须被拒`);
});

test('安全四条②：白名单是编译期常量，不接受运行时参数', () => {
  assert.deepEqual([...ONLINE_HOSTS].sort(), ['amll-ttml-db.stevexmh.net', 'u.y.qq.com']);
  assert.equal(MAX_ONLINE_BODY_BYTES, 512 * 1024);
});

test('安全四条④：guardedFetch 禁重定向、不带凭据、不缓存、有超时与体积上限', async () => {
  const seen = [];
  const realFetch = globalThis.fetch;
  try {
    globalThis.fetch = async (url, init) => {
      seen.push({ url: String(url), init });
      return { ok: true, status: 200, headers: new Map([['content-length', '4']]), body: (async function* () { yield Buffer.from('abcd'); })() };
    };
    const response = await guardedFetch('https://u.y.qq.com/cgi-bin/musicu.fcg', { method: 'POST', body: '{}', lookup: PUBLIC_DNS });
    assert.equal(response.ok, true);
    assert.equal(response.text(), 'abcd');
    const init = seen[0].init;
    assert.equal(init.redirect, 'error', '必须禁止重定向（3xx 会旁路掉 host 校验）');
    assert.equal(init.credentials, 'omit', '不得带 cookie/凭据');
    assert.equal(init.cache, 'no-store');
    assert.ok(init.signal, '必须有超时信号');
    assert.equal(seen[0].url, 'https://u.y.qq.com/cgi-bin/musicu.fcg');
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('安全四条④：声明体积超限直接拒，不读进内存', async () => {
  const realFetch = globalThis.fetch;
  try {
    globalThis.fetch = async () => ({
      ok: true, status: 200, headers: new Map([['content-length', String(8 * 1024 * 1024)]]),
      body: (async function* () { yield Buffer.from('x'); })(),
    });
    await assert.rejects(() => guardedFetch('https://u.y.qq.com/x', { lookup: PUBLIC_DNS }), /超过上限/);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('安全四条：出网只经 guardedFetch，其他在线模块不得裸用 fetch()', async () => {
  for (const name of ['online-lyrics.mjs', 'online-normalize.mjs', 'online-qrc-decrypt.mjs', 'online-match-score.mjs']) {
    let text;
    try {
      text = await readScript(name);
    } catch {
      continue;   // 该模块尚未落地（分任务提交），不在本条断言范围内
    }
    assert.doesNotMatch(text, /[^.\w]fetch\(/, `${name} 不得自己调用 fetch，必须走 guardedFetch`);
  }
});

test('R57：上游 3DES 数值表逐字保留（transpile 只剥类型，没动常量）', async () => {
  const ours = await readScript('online-qrc-decrypt.mjs');
  const upstream = await readFile(join(SCRIPTS, UPSTREAM_QRC), 'utf8');
  const stripComments = (text) => text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
  // 只比代码里的数值字面量（注释里也带 "8-byte"/"24-byte" 这类数字，会把比对污染成假差异）
  // 只取独立数值字面量：Uint8Array 里的 8 不算（类型标注被 transpile 剥掉后它会消失，会造成假差异）
  const digits = (text) => (stripComments(text).match(/(?<!\w)\d+(?!\w)/g) ?? []);
  const upstreamCore = digits(upstream.split(/\r?\n/).slice(0, 323).join('\n'));
  const oursCore = digits(ours.slice(ours.indexOf('const SBOX'), ours.indexOf('/** 上游 decompressDeflate')));
  assert.ok(upstreamCore.length > 900, `上游数值字面量数量异常：${upstreamCore.length}`);
  assert.deepEqual(oursCore, upstreamCore, 'SBOX/IP/FP 等数值表必须与上游逐字一致（改一个数歌词就解错）');
});

test('R57：真实密文 fixture 可解密，且尾部多余字节不抛（Node zlib 容错）', async () => {
  const hex = (await readFixture('qq-placeholder-lyric-hex.txt')).split('\n').filter((l) => !l.startsWith('#')).join('').trim();
  const plain = await qrcDecrypt(hex);
  assert.equal(typeof plain, 'string');
  assert.ok(plain.length > 0 && plain.length < 200, `占位词明文应极短，实测 ${plain.length}`);
  assert.match(plain, /\[\d{2}:\d{2}/, '明文是行级 LRC 形态');
  assert.equal(/^\s*<\?xml/i.test(plain), false, '该占位载荷不是 XML 信封');
  const padded = await qrcDecrypt(hex + '00'.repeat(8));
  assert.equal(padded.slice(0, 8), plain.slice(0, 8), '尾 junk 必须被容忍而不是抛');
});

test('R57：移植件只导出解密入口，不夹带测试专用的加密后门', async () => {
  // 一手验证（D:	ag-tools\p4-des-inverse.mjs）：上游自己的加密方向能还原，
  // 但 node:crypto 的 des-ede3-ecb 密文交给本移植件解会报 incorrect header check ——
  // 所以不自造密文 fixture：密文侧只用真实占位载荷，编排层由注入 decrypt 覆盖（Task 6）。
  const mod = await import('./online-qrc-decrypt.mjs');
  assert.deepEqual(Object.keys(mod), ['qrcDecrypt'], `移植件的导出面应只有解密入口，实测 ${Object.keys(mod)}`);
});

test('R57：空载荷按上游语义抛错', async () => {
  await assert.rejects(() => qrcDecrypt(''), /No data to decrypt/);
});

test('R55：QQ XML 信封拆出 LyricContent，并按 Lyric_1 优先、剥净信封', async () => {
  const envelope = await readFixture('qq-qrc-envelope.txt');
  const { content, rejected } = unwrapQqLyricPayload(envelope);
  assert.equal(rejected, undefined);
  assert.match(content, /^\[ti:/, '元信息行保留');
  assert.equal(countTimedLines(content), 7, '计时行数量（fixture 是 7 行 QRC）');
  assert.equal(/QrcInfos|Lyric_1|<\?xml/.test(content), false, '信封必须剥净，否则解析器一行都读不到');
  const lrc = unwrapQqLyricPayload(await readFixture('qq-lrc-envelope.txt')).content;
  assert.equal(countTimedLines(lrc), 6);
  assert.equal(isQrcPayload(lrc), false, '行级载荷不该被误判成逐字');
});

test('R55：多段 Lyric_N 时按编号取第一段（与上游 LyricCount 语义一致）', () => {
  const multi = '<?xml version="1.0"?><QrcInfos><LyricInfo LyricCount="2">'
    + '<Lyric_2 LyricType="2" LyricContent="[00:09.00]SECOND"/>'
    + '<Lyric_1 LyricType="1" LyricContent="[00:01.00]FIRST"/></LyricInfo></QrcInfos>';
  assert.match(unwrapQqLyricPayload(multi).content, /FIRST/);
});

test('R55：非信封（纯 LRC / legacy QRC 文本）原样通过', () => {
  for (const plain of ['[00:01.00]AAA' + String.fromCharCode(10), '[0,2250]AAA(0,160)BBB(160,160)']) {
    assert.equal(unwrapQqLyricPayload(plain).content, plain);
  }
  assert.equal(unwrapQqLyricPayload('').content, '');
});

test('安全：含 DOCTYPE/ENTITY 声明的载荷直接拒绝，绝不交给后续解析（与歌词解析层同一硬约束）', () => {
  const evil = [
    '<?xml version="1.0"?><!DOCTYPE x [<!ENTITY e SYSTEM "file:///etc/passwd">]><QrcInfos/>',
    String.fromCharCode(0xFEFF) + '  <!ENTITY % pe "x">',
    '<QrcInfos><Lyric_1 LyricContent="<!ENTITY a SYSTEM \"/etc/shadow\">"/>',
  ];
  for (const text of evil) assert.deepEqual(unwrapQqLyricPayload(text), { rejected: 'entity-declaration' }, text.slice(0, 30));
});

test('R55：实体只反转义五类命名引用与数字引用，未知命名实体原样保留', () => {
  assert.equal(decodeXmlEntities('a&quot;b&apos;c&lt;d&gt;e&#65;&#x42;&amp;c'), 'a"b' + "'c<d>eAB&c");
  assert.equal(decodeXmlEntities('&unknown; &lt;ok&gt;'), '&unknown; <ok>');
  assert.equal(decodeXmlEntities('&#0;'), String.fromCharCode(0));
});

test('R58：foldKana 只折片假名，长音符号/中黑点/汉字不动', () => {
  assert.equal(foldKana('キヨシ'), 'きよし');
  assert.equal(foldKana(String.fromCharCode(0x30DB, 0x30FC, 0x30EB)), String.fromCharCode(0x307B, 0x30FC, 0x308B))
  assert.equal(foldKana('恋人・李荣浩'), '恋人・李荣浩');
  assert.equal(foldKana('䶮'), '䶮');
  assert.notEqual(foldKana('キヨシ'), 'kiyoshi', '本期不做罗马音转换（定案 2）');
});

test('R55：isQrcPayload 认 legacy QRC 的两个特征，不误认普通 LRC', () => {
  assert.equal(isQrcPayload('[0,2250]AAA(0,160)BBB(160,160)'), true);
  assert.equal(isQrcPayload('[0,2250]AAA(0,160,3)BBB'), true, '三字段标记（start,dur,len）同样认');
  assert.equal(isQrcPayload('[00:01.00]AAA'), false);
  assert.equal(isQrcPayload(''), false);
});

// ── 任务 5（R58 / R59）：打分与查询构造 ─────────────────────────────────────
const candidate = (name, artist, album, durationMs) => ({
  name, artists: [{ name: artist }], album: { name: album }, durationMs,
});
const fixtureSongs = async (kind) => (await readFixture('qq-search-response.json')
  .then((text) => JSON.parse(text))).item_songs[kind];
/** fixture 的 item_song → 打分器要的候选形状（interval 是秒，照上游换算成毫秒）。 */
const fromFixture = (song) => candidate(song.title, song.singer[0].name, song.album.name, song.interval * 1000);

const LOCAL_YE = { title: 'Your Eyes', artist: '山下達郎', album: 'GREATEST HITS! OF TATSURO YAMASHITA', durationMs: 198138 };
const LOCAL_SAY = { title: 'さよなら夏の日', artist: '山下達郎', album: 'COME ALONG 3', durationMs: 267830 };

test('R58：权重与阈值逐字照上游，判定是"小于 75 才丢"（75 分压线通过）', () => {
  assert.deepEqual(SCORE_WEIGHTS, { title: 45, artist: 25, album: 30 });
  assert.equal(AUTO_MATCH_MIN_SCORE, 75);
  assert.equal(AUTO_MATCH_COMPONENT_MISS_SCORE_CAP, 74);
  assert.equal(AUTO_MATCH_SEARCH_LIMIT, 10);
  assert.equal(PROVIDER_SEARCH_TIMEOUT_MS, 3500);
  assert.equal(PROVIDER_LYRIC_TIMEOUT_MS, 5000);
  // 压线通过这件事本身要被抓到：造一个恰好 75 分的组合（满分身份 × 0.75 乘子 = 时长差 4008ms）
  const exactly75 = calculateMatchScore(
    { title: '恋人', artist: '李荣浩', album: '黑马', durationMs: 276008 },
    candidate('恋人', '李荣浩', '黑马', 272000),
  );
  assert.equal(exactly75, 75);
  assert.equal(exactly75 >= AUTO_MATCH_MIN_SCORE, true, '75 分必须被接受（阈值语义，不是"要高于 75"）');
});

test('R58：时长乘子逐档边界与上游一致（matchScore.ts:100-113）', () => {
  const song = { title: '恋人', artist: '李荣浩', album: '黑马', durationMs: 276008 };
  const ladder = [
    [276000, 100, '差 8ms → ×1'],
    [275000, 95, '差 1008ms → ×0.95'],
    [272000, 75, '差 4008ms → ×0.75'],
    [271000, 35, '差 5008ms → ×0.35'],
    [266000, 10, '差 10008ms → ×0.1'],
  ];
  for (const [duration, expected, note] of ladder) {
    assert.equal(calculateMatchScore(song, candidate('恋人', '李荣浩', '黑马', duration)), expected, note);
  }
  // 任一侧时长缺失 → 乘子 0.9 且不算"不匹配"（durationMatched = null）
  const details = calculateMatchScoreDetails({ title: '恋人', artist: '李荣浩', album: '黑马', durationMs: 0 },
    candidate('恋人', '李荣浩', '黑马', 275000));
  assert.equal(details.durationMultiplier, 0.9);
  assert.equal(details.durationMatched, null);
});

test('R58：真实样本实测分数（P11 两首正例，都是有效正例）', async () => {
  const [exact] = await fixtureSongs('japanese-exact');
  const [crossAlbum] = await fixtureSongs('japanese-cross-album');
  const sayScore = calculateMatchScore(LOCAL_SAY, fromFixture(exact));
  assert.equal(sayScore, 100, '括号里的中文注记属"非版本标记"，被 normalizeTitleForMatch 整段剔除 → 标题完全一致');
  const yeDetails = calculateMatchScoreDetails(LOCAL_YE, fromFixture(crossAlbum));
  // 这一格从 **78 变成 80** 是 R140 那条窄规则**该有的作用**（同一份真实样本：标题/歌手全等、
  // 专辑标签不同 albumSim 0.28、时长差 138ms），不是回归。改的是期望值，判据本身没放宽：
  // 阈值仍是 75，权重与 74 那个上限一个没动（下面第 221~223 行那三条逐字断言仍在册）。
  assert.equal(yeDetails.score, 80, 'R140 之前是 78（45+25+0.28×30 再乘 0.95）；三条件齐备 ⇒ 身份分抬到下限 80');
  assert.equal(yeDetails.albumDimensionRescued, true, '这一格要说真话：它确实是靠窄规则抬的，不是原本就有 80');
  assert.ok(yeDetails.score >= AUTO_MATCH_MIN_SCORE, '边界分样本也必须通过，否则正例 A 无证据');
});


test('R140（任务二）· 专辑维度窄规则：三条齐备才抬，缺一即逐字退回原算法', () => {
  const target = { title: '他不懂', artist: '张杰', album: '他不懂 (单曲)', durationMs: 265_000 };
  const hit = (over = {}) => calculateMatchScoreDetails(target, {
    name: '他不懂', artists: [{ name: '张杰' }], album: { name: '精选合辑' }, durationMs: 265_000, ...over,
  });
  // ① 正例（真机案例的形状）：曲名歌手逐字一致、专辑对不上、时长一致 ⇒ 原来 70 被拒，现在 80 过线
  const rescued = hit();
  assert.equal(rescued.titleSimilarity, 1, '曲名归一后逐字相等');
  assert.equal(rescued.albumSimilarity === null || rescued.albumSimilarity < 0.65, true, '专辑那一维确实没对上（这就是它从前被拒的原因）');
  assert.equal(rescued.albumDimensionRescued, true);
  assert.ok(rescued.score >= AUTO_MATCH_MIN_SCORE, `抬完 ${rescued.score} 分，仍要过阈值 75 才算匹配`);
  // ② 反例：曲名只是"很像"（少一个字）⇒ 不抬，维持原算法（原算法给多少就是多少）
  // 这一格要挑在**"很像"那一档**（0.65 ≤ 相似度 < 1.0）：曲名多一个字，`titleMatched` 仍为真，
  // 但逐字相等不成立 ⇒ 窄规则不许生效。第一版我写成"他不懂 了"（带空格，相似度只有 0.60，
  // 连 titleMatched 都不成立），于是变异"把 === 1 换成 titleMatched"根本不会被抓到——判据落在错误的那一档上。
  const fuzzy = hit({ name: '他不懂啊' });
  assert.ok(fuzzy.titleSimilarity >= 0.65 && fuzzy.titleSimilarity < 1, `这一格必须落在"很像但不逐字"那一档，实测 ${fuzzy.titleSimilarity}`);
  assert.equal(fuzzy.albumDimensionRescued, false, '曲名不是逐字相等就不该抬（"很像"不是"同一首"）');
  assert.ok(fuzzy.score < AUTO_MATCH_MIN_SCORE, `曲名模糊时实测 ${fuzzy.score} 分，必须仍被拒`);
  // ③ 反例：时长差 4 秒（超出 3 秒容差）⇒ 不抬
  const far = hit({ durationMs: 269_000 });
  assert.equal(far.albumDimensionRescued, false, '时长差 4 秒不在容差内');
  assert.ok(far.score < AUTO_MATCH_MIN_SCORE, `时长差 4 秒实测 ${far.score} 分，必须仍被拒`);
  // ④ 反例：时长差正好 3 秒（容差边界）⇒ 抬，但乘子 0.95 ⇒ 76 分，压线过
  const edge = hit({ durationMs: 268_000 });
  assert.equal(edge.albumDimensionRescued, true, '|Δ| ≤ 3000ms 含边界');
  assert.equal(edge.score, 76, '80 × 0.95 = 76：抬到下限不等于免检，乘子照乘');
  // ⑤ 反例：歌手对不上 ⇒ 不抬（窄规则只救"专辑"那一维，不救歌手）
  const wrongArtist = hit({ artists: [{ name: '薛之谦' }] });
  assert.equal(wrongArtist.albumDimensionRescued, false);
  assert.ok(wrongArtist.score < AUTO_MATCH_MIN_SCORE, `歌手不对实测 ${wrongArtist.score} 分，必须仍被拒`);
  // ⑥ 任一侧时长缺失 ⇒ 不抬（"不知道"不等于"对得上"，这一格最容易被顺手放过）
  const noDuration = hit({ durationMs: 0 });
  assert.equal(noDuration.albumDimensionRescued, false, '时长缺失时不许当成"差 0 秒"');
  // ⑦ 目标本身没有专辑名（专辑那一维本来就给满分）⇒ 不产生 rescued 标记，分数与从前逐字一致
  const noAlbum = calculateMatchScoreDetails({ title: '他不懂', artist: '张杰', album: '', durationMs: 265_000 },
    { name: '他不懂', artists: [{ name: '张杰' }], album: { name: '精选合辑' }, durationMs: 265_000 });
  assert.equal(noAlbum.albumDimensionRescued, false, '本来就能拿满专辑分，不是靠窄规则');
  assert.equal(noAlbum.score, 100);
  // ⑧ 上游那四个常量一个没动（这条断言是"我没顺手放宽"的证据）
  assert.deepEqual(SCORE_WEIGHTS, { title: 45, artist: 25, album: 30 });
  assert.equal(AUTO_MATCH_COMPONENT_MISS_SCORE_CAP, 74);
  assert.equal(AUTO_MATCH_MIN_SCORE, 75);
  assert.equal(ALBUM_DIMENSION_IDENTITY_FLOOR, 80, '下限是 80：抬完乘 0.95 也还有 76，压线过阈值而不是免检');
  assert.equal(ALBUM_DIMENSION_DURATION_TOLERANCE_MS, 3_000);
});

test('R58：宁可无词也不错配 —— 干扰候选全部挡在阈值下', async () => {
  const songs = {
    durationOff: await fixtureSongs('duration-off-6s'),
    wrongArtist: await fixtureSongs('wrong-artist'),
  };
  for (const kind of ['durationOff', 'wrongArtist']) {
    const details = calculateMatchScoreDetails(LOCAL_YE, fromFixture(songs[kind][0]));
    assert.ok(details.score < AUTO_MATCH_MIN_SCORE, `${kind} 实测 ${details.score} 分，必须被拒`);
  }
  // 同歌手不同曲：标题相似度 0 → 硬门直接不过
  const wrongSong = calculateMatchScoreDetails({ title: '恋人', artist: '李荣浩', album: '黑马', durationMs: 276008 },
    candidate('王牌冤家', '李荣浩', '耳朵', 244000));
  assert.equal(wrongSong.titleMatched, false);
  assert.ok(wrongSong.score < AUTO_MATCH_MIN_SCORE);
});

test('R58：跨文字（英文标签 vs 中文源）必然 0 分 —— P10 负例的算术依据', async () => {
  const [cn] = await fixtureSongs('english-tags');
  const en = { title: 'Lovers', artist: 'Li Ronghao', album: 'Lovers - Single', durationMs: 276008 };
  const details = calculateMatchScoreDetails(en, fromFixture(cn));
  assert.deepEqual([details.titleSimilarity, details.artistSimilarity, details.albumSimilarity], [0, 0, 0]);
  assert.equal(details.score, 0);
  assert.equal(details.titleMatched, false);
});

test('R58：繁简由既有依赖 opencc-js 归一，假名只折片假名（不加 wanakana）', () => {
  assert.equal(calculateMatchScore({ title: '晴天', artist: '周杰倫', album: '葉惠美', durationMs: 269000 },
    candidate('晴天', '周杰伦', '叶惠美', 269000)), 100);
  assert.equal(normalizeLyricMatchText('キヨシ'), normalizeLyricMatchText('きよし'), '片假名与平假名互认');
  assert.notEqual(normalizeLyricMatchText('キヨシ'), 'kiyoshi', '本期不转罗马音（R58 偏离，将来换实现即可）');
});

test('R58：查询构造与时长归一沿用上游（feat 剔除、长专辑名砍制作信息）', () => {
  // 查询串保留括号注记（上游 searchQuery.ts 只做"艺人名 - 标题"前缀拆解）；
  // 版本注记的剔除发生在打分侧 normalizeTitleForMatch（matchScore.ts:49-59），两者职责不同。
  assert.equal(buildLyricSearchQuery('恋人 (Live)', '李荣浩', '黑马'), '恋人 (Live) - 李荣浩 - 黑马');
  // 实测的上游语义（matchScore.ts:49-59）：括号内容**命中版本标记词表就整段保留**，
  // 不命中才剔除 —— 与直觉相反。后果：`(道别的夏天)` 被剔除（正例 B 因此满分），
  // 而 `(Live)` 被保留 → 本地写 "恋人 (Live)" 对在线裸标题 "恋人" 只有 68 分、被阈值挡下。
  // 本期照抄不改（改它就是第 2 条功能偏离），已作为观察项写进第四期执行日志待用户拍板。
  assert.equal(calculateMatchScore({ title: '恋人 (Live)', artist: '李荣浩', album: '黑马', durationMs: 276008 },
    candidate('恋人', '李荣浩', '黑马', 276008)) < AUTO_MATCH_MIN_SCORE, true, '实测 68 分：Live 版标题会被挡，属上游行为');
  assert.equal(calculateMatchScore({ title: 'さよなら夏の日', artist: '山下達郎', album: 'COME ALONG 3', durationMs: 267830 },
    candidate('さよなら夏の日 (道别的夏天)', '山下達郎', 'COME ALONG 3', 267000)), 100, '非版本标记的中文注记被剔除 → 满分');
  assert.equal(normalizeSongTitleForLyricSearch('李荣浩 - 恋人', '李荣浩'), '恋人');
  assert.equal(normalizeSongTitleForLyricSearch('艺人名不符 - 恋人', '李荣浩'), '艺人名不符 - 恋人');
  assert.equal(normalizeLyricMatchDurationMs(276008), 276008);
  assert.equal(normalizeLyricMatchDurationMs(276008000), 276008, '误传毫秒×1000 要纠回来（duration.ts:9-13）');
  assert.equal(normalizeLyricMatchDurationMs(-1), 0);
});

// ── Task 5：四源编排（全部离线：注入假桥，不 spawn 子进程、不出网）─────────────

/** 假桥：只记调用、按 payload 返回预设结果。形状与 online-bridge-client 的 call() 一致。 */
function bridgeDouble(bySource = {}) {
  const calls = [];
  return {
    calls,
    async call(route, payload) {
      calls.push({ route, ...payload });
      const handler = bySource[payload.source];
      if (!handler) return { ok: false, provider: payload.source, reason: '假桥：这一档没配返回' };
      return handler(payload, calls.length);
    },
  };
}

const ncmHit = (text, extra = {}) => ({
  ok: true, provider: 'netease',
  candidates: [{ sourceId: '2600493765', name: 'さよなら夏の日', artists: [{ name: '山下達郎' }], album: { name: 'COME ALONG 3' }, durationMs: 267830 }],
  text, format: 'lrc', ...extra,
});

test('四源编排：QQ 只给行级时继续问经桥的源，拿到逐字就用逐字（跨源逐字优先）', async () => {
  const { fetcher } = makeRoutes({ lyricEnvelope: envelopeOf(LRC_BODY) });   // QQ 只给行级
  const bridge = bridgeDouble({
    netease: (payload) => (payload.action === 'search'
      ? { ok: true, provider: 'netease', candidates: [{ sourceId: '1', name: 'さよなら夏の日', artists: [{ name: '山下達郎' }], album: { name: 'COME ALONG 3' }, durationMs: 267830 }] }
      : { ok: true, provider: 'netease', text: QRC_BODY, format: 'lrc' }),   // 网易给逐字
    kugou: () => ({ ok: false, provider: 'kugou', reason: '假桥：酷狗没有词' }),
  });
  const matcher = createOnlineLyricMatcher({ fetcher, decrypt: identityDecrypt, bridge });
  const outcome = await matcher.match(LOCAL_SONG);
  assert.equal(outcome.matched, true);
  assert.equal(outcome.provider, 'netease', '行级不立即返回：找到逐字才算最终结果');
  assert.equal(outcome.isWordByWord, true);
  assert.deepEqual([...new Set(bridge.calls.map((c) => c.source))], ['netease'], 'QQ 已有行级词 ⇒ 不必再问酷狗');
  assert.deepEqual(bridge.calls.map((c) => c.action), ['search', 'lyric'], '经桥的取词必须是"先检索拿 id，再取正文"两跳');
});

test('四源编排：QQ 命中逐字就不再问经桥的两档（省掉两次子进程往返）', async () => {
  const { fetcher } = makeRoutes({});                                        // 默认就是逐字 QRC
  const bridge = bridgeDouble({});
  const matcher = createOnlineLyricMatcher({ fetcher, decrypt: identityDecrypt, bridge });
  const outcome = await matcher.match(LOCAL_SONG);
  assert.equal(outcome.provider, 'qq');
  assert.equal(bridge.calls.length, 0, '逐字优先意味着后面的源根本不该被问');
});

test('桥不可用 ⇒ 网易/酷狗两档给可读原因，QQ 与 AMLL 照常（能力退化但不归零）', async () => {
  const { fetcher, routes } = makeRoutes({ lyricEnvelope: envelopeOf(LRC_BODY) });
  const matcher = createOnlineLyricMatcher({ fetcher, decrypt: identityDecrypt, bridge: null });
  const outcome = await matcher.match(LOCAL_SONG);
  assert.equal(outcome.matched, true, 'QQ 的行级词仍然要能用');
  assert.equal(outcome.provider, 'qq');
  assert.equal(routes.calls.search, 1);
  // 换一首 QQ 完全没词的：未命中原因里必须看得见"桥不可用"这一档，而不是只说没找到
  const empty = makeRoutes({ candidates: [], lyricEnvelope: envelopeOf(LRC_BODY) });
  const miss = await createOnlineLyricMatcher({ fetcher: empty.fetcher, decrypt: identityDecrypt, bridge: null })
    .match({ title: '查无此词', artist: '某人', album: '某专', durationMs: 1000 });
  assert.equal(miss.matched, false);
  assert.match(miss.reason, /桥不可用|未启用/, '经桥两档不可用的原因必须摊开写');
});

test('零命中时 reasons 覆盖三档检索源，每档一句结论（"为什么没配上"要能指到源）', async () => {
  const { fetcher } = makeRoutes({ candidates: [] });
  const bridge = bridgeDouble({
    netease: () => ({ ok: false, provider: 'netease', reason: '网易检索失败：code=404' }),
    kugou: () => ({ ok: true, provider: 'kugou', candidates: [] }),
  });
  const outcome = await createOnlineLyricMatcher({ fetcher, decrypt: identityDecrypt, bridge }).match(LOCAL_SONG);
  assert.equal(outcome.matched, false);
  assert.deepEqual(Object.keys(outcome.reasons).sort(), ['kugou', 'netease', 'qq']);
  assert.match(outcome.reasons.netease, /网易检索失败/);
  assert.match(outcome.reasons.kugou, /没有候选/);
  assert.match(outcome.reason, /四源逐档结论/, '汇总那句要能看出是逐档结论拼的');
});

test('经桥的候选同样过阈值与硬门：分数不够就不取词', async () => {
  const { fetcher } = makeRoutes({ candidates: [] });                        // QQ 一家都没有候选
  const bridge = bridgeDouble({
    netease: () => ({
      ok: true, provider: 'netease',
      candidates: [{ sourceId: '9', name: '完全不同的歌', artists: [{ name: '别人' }], album: { name: '别的专' }, durationMs: 1000 }],
    }),
    kugou: () => ({ ok: false, provider: 'kugou', reason: '假桥：酷狗没有候选' }),
  });
  const outcome = await createOnlineLyricMatcher({ fetcher, decrypt: identityDecrypt, bridge }).match(LOCAL_SONG);
  assert.equal(outcome.matched, false);
  assert.equal(bridge.calls.filter((c) => c.action === 'lyric').length, 0, '低分候选不得去取词');
  assert.match(outcome.reasons.netease, /最高分 \d+（阈值/);
});

test('未命中的逐档结论会跟着负缓存走（第二次读同一首也得看得见"哪一档说了什么"）', async () => {
  const { fetcher } = makeRoutes({ candidates: [] });
  const bridge = bridgeDouble({
    netease: () => ({ ok: true, provider: 'netease', candidates: [] }),
    kugou: () => ({ ok: false, provider: 'kugou', reason: '酷狗检索失败：Not Found' }),
  });
  const matcher = createOnlineLyricMatcher({ fetcher, decrypt: identityDecrypt, bridge });
  const first = await matcher.match(LOCAL_SONG);
  assert.equal(first.matched, false);
  const second = await matcher.match(LOCAL_SONG);                 // 走负缓存
  assert.equal(second.cached, 'miss');
  assert.deepEqual(Object.keys(second.reasons).sort(), ['kugou', 'netease', 'qq'], '负缓存不得把逐档结论丢掉');
  assert.match(second.reasons.kugou, /Not Found/);
});

test('R59 + R79：源序 = QQ 主、网易/酷狗经桥、AMLL 兜底；偏好提权语义保留', async () => {
  const { LYRIC_SEARCH_SOURCES } = await import('./online-match-score.mjs');
  assert.deepEqual(LYRIC_SOURCES, ['qq', 'netease', 'amll', 'kugou']);
  // AMLL 不在"各自检索一轮"的清单里：TTML 库按 QQ 曲目 id 索引，只能挂在 QQ 候选之后当兜底位。
  // 这条不是排序偏好而是技术约束（第四期实测），所以它必须有一条断言守着，免得以后被"顺手对齐"掉。
  assert.deepEqual(LYRIC_SEARCH_SOURCES, ['qq', 'netease', 'kugou']);
  assert.equal(DEFAULT_LYRIC_SOURCE, 'qq');
  assert.deepEqual(buildLyricSourceOrder('amll'), ['amll', 'qq', 'netease', 'kugou']);
  assert.deepEqual(buildLyricSourceOrder(null), ['qq', 'netease', 'amll', 'kugou']);
  assert.deepEqual(buildLyricSourceOrder('kugou'), ['kugou', 'qq', 'netease', 'amll'], '四源之后提权仍然只换首位');
  assert.deepEqual(buildLyricSourceOrder('tencent'), ['qq', 'netease', 'amll', 'kugou'], '不认识的源不得进入序');
});

test('R58：移植件里不残留上游依赖符号，也不搬酷狗查询', async () => {
  // 只看代码：移植头必须写明"与上游 wanakana 的差异"，所以注释里出现该词是要求而不是违规。
  const source = (await readScript('online-match-score.mjs'))
    .replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
  assert.doesNotMatch(source, /wanakana/, '不得再引 wanakana（定案 2）');
  assert.doesNotMatch(source, /createProviderSongMetadata/, '元数据适配层已按 R58 去掉');
  assert.doesNotMatch(source, /buildKugouLyricSearchQuery/, '本期无酷狗源，不搬');
  assert.match(source, /from 'opencc-js'/, '繁简归一仍由既有依赖承担（未新增依赖）');
  const header = await readScript('online-match-score.mjs');
  assert.match(header.slice(0, 1600), /wanakana/, '移植头必须写明与上游 wanakana 的偏离（R58 可追溯）');
});

// ── 任务 6：编排层（全部离线：注入假 fetcher + 注入 decrypt，不碰网络也不碰密码学）──────────
const envelopeOf = (content) => '<?xml version="1.0" encoding="utf-8"?>' + '\n'
  + '<QrcInfos><LyricInfo LyricCount="1"><Lyric_1 LyricType="1" LyricContent="' + content + '"/></LyricInfo></QrcInfos>';
const QRC_BODY = ['[ti:SYNTHETIC]', '[0,2250]ALPHA(0,160)BETA(160,160)', '[2250,2250]GAMMA(2250,450)', '[4500,2000]DELTA(4500,300)'].join('\n');
const LRC_BODY = ['[00:01.00]ALPHA', '[00:05.00]BETA', '[00:09.00]GAMMA'].join('\n');
const PLACEHOLDER_BODY = '[00:00:00]占位';   // 器乐占位词的形状：只有一行（探针 P10）
const TRANSLATION_BODY = ['[00:00.00]第一行译文', '[00:02.25]第二行译文', '[00:04.50]第三行译文'].join('\n');

/** 候选工厂：默认给一条能与 LOCAL_SONG 满分匹配的记录。 */
const songCandidate = (over = {}) => ({
  id: 212722243, mid: '003xLPJN4VdhHQ', title: 'さよなら夏の日 (道别的夏天)', interval: 267,
  singer: [{ name: '山下達郎' }], album: { name: 'COME ALONG 3' }, ...over,
});
const LOCAL_SONG = { title: 'さよなら夏の日', artist: '山下達郎', album: 'COME ALONG 3', durationMs: 267830 };

function makeRoutes(overrides = {}) {
  const routes = { calls: { search: 0, lyric: 0, amll: 0 }, candidates: [songCandidate()],
    lyricEnvelope: envelopeOf(QRC_BODY), lyricEnvelopes: null, transEnvelope: null, romaEnvelope: null,
    amll: { status: 404, text: '' }, fail: null, ...overrides };
  const reply = (status, obj) => {
    const text = typeof obj === 'string' ? obj : JSON.stringify(obj);
    return { ok: status === 200, status, text: () => text, json: () => (text ? JSON.parse(text) : {}) };
  };
  const fetcher = async (url, init = {}) => {
    if (routes.fail === 'timeout') throw new Error('The operation was aborted due to timeout');
    if (String(url).includes('amll-ttml-db')) {
      routes.calls.amll += 1;
      return routes.amll.status === 200 ? reply(200, routes.amll.text) : reply(routes.amll.status, '');
    }
    const request = JSON.parse(init.body);
    if (routes.fail === 'http500') return reply(500, '');
    const { method } = request.request;
    if (method === 'DoSearchForQQMusicLite') {
      routes.calls.search += 1;
      if (routes.fail === 'apiCode') return reply(200, { code: -1 });
      return reply(200, { code: 0, request: { code: 0, data: { body: { item_song: routes.candidates } } } });
    }
    if (method === 'GetPlayLyricInfo') {
      routes.calls.lyric += 1;
      if (routes.fail === 'lyric-throw') throw new Error('QQ 取词炸了');
      const envelope = routes.lyricEnvelopes && routes.lyricEnvelopes.length
        ? routes.lyricEnvelopes.shift()
        : routes.lyricEnvelope;
      return reply(200, { code: 0, request: { code: 0, data: {
        lyric: envelope, trans: routes.transEnvelope, roma: routes.romaEnvelope } } });
    }
    throw new Error('测试路由表缺方法 ' + method);
  };
  return { routes, fetcher };
}
/** decrypt 注入成恒等：编排层测试里"密文"就是信封明文（真密码学由 R57 的 fixture 断言守）。 */
const identityDecrypt = async (hex) => hex;
const runMatch = async (overrides = {}, options = {}) => {
  const { routes, fetcher } = makeRoutes(overrides);
  const matcher = createOnlineLyricMatcher({ fetcher, decrypt: identityDecrypt, ...options });
  const outcome = await matcher.match(LOCAL_SONG);
  return { outcome, routes };
};

test('编排：命中 QQ 逐字词 → provider qq、format qrc、isWordByWord 真、带溯源与分数', async () => {
  const { outcome, routes } = await runMatch();
  assert.equal(outcome.matched, true, outcome.reason);
  assert.equal(outcome.provider, 'qq');
  assert.equal(outcome.format, 'qrc');
  assert.equal(outcome.isWordByWord, true);
  assert.ok(outcome.score >= 75, `实测 ${outcome.score}`);
  assert.equal(outcome.timedLines, 3, 'fixture 计时行数：4 行里有 1 行是 [ti:] 元信息，不计入');
  assert.equal(outcome.matchedSong.sourceId, 212722243);
  assert.equal(outcome.matchedSong.title, 'さよなら夏の日 (道别的夏天)');
  assert.equal(routes.calls.search, 1);
  assert.equal(routes.calls.lyric, 1);
  assert.equal(routes.calls.amll, 0, 'QQ 已命中就不该再花预算问 AMLL');
});

test('编排：行级载荷照常返回但 isWordByWord 为假（format 跟着判定走）', async () => {
  const { outcome } = await runMatch({ lyricEnvelope: envelopeOf(LRC_BODY) });
  assert.equal(outcome.matched, true);
  assert.equal(outcome.format, 'lrc');
  assert.equal(outcome.isWordByWord, false);
});

test('编排：译文与罗马音一起归一带出（本期只到数据层，岛内字幕另议）', async () => {
  const { outcome } = await runMatch({
    transEnvelope: envelopeOf(TRANSLATION_BODY),
    romaEnvelope: envelopeOf('[0,2250]A(0,160)B(160,160)' + String.fromCharCode(10) + '[2250,2250]C(2250,450)' + String.fromCharCode(10) + '[4500,10]D(4500,10)'),
  });
  assert.equal(outcome.matched, true);
  assert.equal(outcome.translation, TRANSLATION_BODY);
  assert.equal(typeof outcome.romanization, 'string');
});

test('编排：逐字优先于行级 —— 首个候选只有行级时继续找逐字（上游 lineByLineFallback 语义）', async () => {
  const lineLevel = songCandidate({ id: 111, title: 'さよなら夏の日', interval: 268 });
  const wordLevel = songCandidate({ id: 222, title: 'さよなら夏の日', interval: 267 });
  const { outcome, routes } = await runMatch({
    candidates: [lineLevel, wordLevel],
    lyricEnvelope: null,
    lyricEnvelopes: [envelopeOf(LRC_BODY), envelopeOf(QRC_BODY)],
  });
  assert.equal(outcome.format, 'qrc', '第二个候选的逐字必须盖过第一个候选的行级');
  assert.equal(outcome.isWordByWord, true);
  assert.equal(outcome.matchedSong.sourceId, 222);
  assert.equal(routes.calls.lyric, 2, '行级只暂存、必须继续找逐字（曾误写成 break，被本条抓到）');
});

test('编排：只有行级可用时仍返回行级（不因为没找到逐字就报无词）', async () => {
  const { outcome } = await runMatch({
    candidates: [songCandidate({ id: 111, title: 'さよなら夏の日' })],
    lyricEnvelope: envelopeOf(LRC_BODY),
  });
  assert.equal(outcome.matched, true);
  assert.equal(outcome.format, 'lrc');
  assert.equal(outcome.isWordByWord, false);
});

test('编排：TTML 的有效性判据与行文本不同（计时在 begin/end 属性里）', async () => {
  const ttml = await readFixture('amll-ttml.xml');
  assert.equal(hasTtmlLyricBody(ttml), true, 'AMLL fixture 应判为有正文');
  assert.equal(hasTimedLyricLines(ttml), false, 'TTML 没有方括号计时行，行文本判据必然判无 —— 所以两条判据必须分开');
  assert.equal(hasTtmlLyricBody('<tt xmlns="http://www.w3.org/ns/ttml"><body><div><p begin="00:01.00" end="00:02.00">   </p></div></body></tt>'), false, '空壳 TTML 判无');
  assert.equal(hasTtmlLyricBody('hello'), false, '非 TTML 判无');
});

test('编排：QQ 无有效词时 AMLL 兜底（provider amll、format ttml、逐字）', async () => {
  const ttml = await readFixture('amll-ttml.xml');
  const { outcome, routes } = await runMatch({
    lyricEnvelope: envelopeOf(PLACEHOLDER_BODY),
    amll: { status: 200, text: ttml },
  });
  assert.equal(outcome.matched, true, outcome.reason);
  assert.equal(outcome.provider, 'amll');
  assert.equal(outcome.format, 'ttml');
  assert.equal(outcome.isWordByWord, true);
  assert.equal(routes.calls.amll, 1);
});

test('编排：占位词（1 计时行）判未命中并给出可读原因，不返回假词', async () => {
  const { outcome } = await runMatch({ lyricEnvelope: envelopeOf(PLACEHOLDER_BODY) });
  assert.equal(outcome.matched, false);
  assert.match(outcome.reason, /没有有效歌词/);
});

test('编排：候选全部低于阈值 → 未命中，原因里带最高分与最接近曲名（不猜、不错配）', async () => {
  const { outcome } = await runMatch({ candidates: [songCandidate({ title: '完全不同的歌', album: { name: '别的专辑' }, singer: [{ name: '别人' }] })] });
  assert.equal(outcome.matched, false);
  assert.match(outcome.reason, /最高分 \d+/);
});

test('编排：网络/协议故障一律兑现成未命中，绝不抛（不阻塞本地核心）', async () => {
  for (const fail of ['timeout', 'http500', 'apiCode', 'lyric-throw']) {
    const outcome = await createOnlineLyricMatcher({
      fetcher: makeRoutes({ fail }).fetcher, decrypt: identityDecrypt,
    }).match(LOCAL_SONG);
    assert.equal(outcome.matched, false, `${fail} 必须是未命中而不是异常`);
    assert.equal(typeof outcome.reason, 'string');
    assert.ok(outcome.reason.length > 0, `${fail} 要给出可读原因`);
  }
});

test('编排：同曲并发只发一次检索，命中后第二次调用零请求（进程内缓存，不落盘）', async () => {
  const { routes, fetcher } = makeRoutes({});
  const matcher = createOnlineLyricMatcher({ fetcher, decrypt: identityDecrypt });
  const [a, b] = await Promise.all([matcher.match(LOCAL_SONG), matcher.match(LOCAL_SONG)]);
  assert.equal(routes.calls.search, 1, '并发去重失效就会双倍打接口');
  assert.equal(a.score, b.score);
  const before = { ...routes.calls };
  const again = await matcher.match(LOCAL_SONG);
  assert.deepEqual(routes.calls, before, '已命中就该走缓存，不再出网');
  assert.equal(again.matched, true);
});

test('编排：6.6 真实未命中进进程内负缓存，同一首第二次零请求', async () => {
  const { routes, fetcher } = makeRoutes({ candidates: [songCandidate({ title: '完全不同的歌', album: { name: '别的专辑' }, singer: [{ name: '别人' }] })] });
  const matcher = createOnlineLyricMatcher({ fetcher, decrypt: identityDecrypt });
  const first = await matcher.match(LOCAL_SONG);
  assert.equal(first.matched, false, '前置条件：这次要真的没配上');
  const before = { ...routes.calls };
  const second = await matcher.match(LOCAL_SONG);
  assert.equal(second.matched, false);
  assert.deepEqual(routes.calls, before, '第二次必须走负缓存：USLT 曲目每次选曲都重打接口是不可接受的');
  assert.equal(second.cached, 'miss', '要能区分"这次没出网"和"这次真的试过"');
  assert.match(second.reason, /最高分|未找到匹配歌词/, '负缓存要保留上次的可读原因');
});

test('编排：6.6 clearCache() 同时清掉未命中留痕（改标签或重扫后要能再试）', async () => {
  const { routes, fetcher } = makeRoutes({ candidates: [songCandidate({ title: '完全不同的歌', album: { name: '别的专辑' }, singer: [{ name: '别人' }] })] });
  const matcher = createOnlineLyricMatcher({ fetcher, decrypt: identityDecrypt });
  await matcher.match(LOCAL_SONG);
  matcher.clearCache();
  const searchBefore = routes.calls.search;
  const again = await matcher.match(LOCAL_SONG);
  assert.equal(routes.calls.search, searchBefore + 1, '清缓存后应重新检索');
  assert.equal(again.cached, undefined, '清完不能再报缓存未命中');
});

test('编排：整条链受时间预算约束，超预算返回未命中 + 原因', async () => {
  let clock = 0;
  const { fetcher } = makeRoutes({});
  const matcher = createOnlineLyricMatcher({
    fetcher, decrypt: identityDecrypt,
    now: () => (clock += 20000),        // 第一次读时间就超预算
    budgetMs: 12000,
  });
  const outcome = await matcher.match(LOCAL_SONG);
  assert.equal(outcome.matched, false);
  assert.match(outcome.reason, /超时/);
});

test('编排：缺标题直接不发起检索', async () => {
  const { routes, fetcher } = makeRoutes({});
  const matcher = createOnlineLyricMatcher({ fetcher, decrypt: identityDecrypt });
  assert.equal((await matcher.match({ title: '', artist: 'x', durationMs: 1000 })).matched, false);
  assert.equal(routes.calls.search, 0);
});

test('编排：hasTimedLyricLines 只认计时行，元信息行与裸文本不算', () => {
  assert.equal(hasTimedLyricLines(QRC_BODY), true);
  assert.equal(hasTimedLyricLines(LRC_BODY), true);
  assert.equal(hasTimedLyricLines(PLACEHOLDER_BODY), false, '一行占位词必须判无有效歌词');
  assert.equal(hasTimedLyricLines('[ti:a]' + String.fromCharCode(10) + '[ar:b]' + String.fromCharCode(10) + '[offset:0]'), false, '只有元信息不算');
  assert.equal(hasTimedLyricLines('' + String.fromCharCode(10) + '[00:01.00]   ' + String.fromCharCode(10) + '[00:02.00]   ' + String.fromCharCode(10) + '[00:03.00]   '), false, '计时行有但正文全空不算');
});

// ── 任务 7：服务端路由与在线开关挂点 ──────────────────────────────────────
// 路由层注入假匹配器：要验的是挂点本身（默认关闭、本地有词不触发、参数校验、结果透传），
// 这些必须离线可复现，不能为了验证开关去解析真实 DNS；出网链路的安全与编排断言在前面的小节。
const ONLINE_MATCH_ROUTE = '/api/online/lyrics/match';

const matchedOutcome = {
  matched: true, provider: 'qq', format: 'qrc', isWordByWord: true, score: 100,
  // 字段名与 createOnlineLyricMatcher 的真实返回一致（text / translation / romanization），
  // 路由只做透传，改名就会让前端拿到 undefined。
  text: QRC_BODY, translation: TRANSLATION_BODY,
  matchedSong: { sourceId: 212722243, title: 'さよなら夏の日', artist: '山下達郎' },
};
const unmatchedOutcome = { matched: false, reason: '候选最高分 5（低于阈值 75），最接近《别的歌》：宁可无词也不错配' };

function fakeStore({ enabled = false, tracks = {}, outcome = matchedOutcome } = {}) {
  const calls = { trackForOnlineMatch: 0, match: [], clearCache: 0 };
  const store = {
    calls,
    // R77：路由判定读的是 online.lyrics（四张子开关）；onlineLyrics 只剩响应侧的镜像，不再存第二份。
    config: { version: 1, roots: ['/fake'], onlineEnabled: false, online: { lyrics: enabled, search: true, streaming: true, covers: true }, foobarBaseUrl: null },
    musicBrainzContact: '',
    snapshot: () => ({
      onlineEnabled: false,
      online: { ...store.config.online },
      onlineLyrics: { enabled: store.config.online.lyrics === true },
    }),
    onChange: () => {},
    reloadRules: async () => {},
    // 6.6：重扫路径要能空跑（只验它是否作废了在线缓存，不验扫描本身）。
    scanPromise: null,
    scan: async () => ({}),
    // 真校验在 music-library.mjs（由本文件的 R77 那一条用真 store 覆盖）。这里复刻"非法即抛"，
    // 路由测试只验一件事：抛出必须兑现成 4xx，不能被吞成 200。
    updateConfig: async (value) => {
      if (value.onlineLyrics !== undefined) {
        const raw = value.onlineLyrics;
        if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('onlineLyrics 必须是 { enabled: true|false }');
        const keys = Object.keys(raw);
        if (keys.length !== 1 || keys[0] !== 'enabled') throw new Error('onlineLyrics 只接受 enabled 一项');
        if (typeof raw.enabled !== 'boolean') throw new Error('onlineLyrics.enabled 必须为布尔值');
        if (value.online?.lyrics !== undefined && value.online.lyrics !== raw.enabled) throw new Error('online.lyrics 与旧字段 onlineLyrics.enabled 冲突：请只提交一项');
        store.config.online = { ...store.config.online, lyrics: raw.enabled };
      }
      return { ...store.config, onlineLyrics: { enabled: store.config.online.lyrics === true } };
    },
    trackForOnlineMatch: (id) => {
      calls.trackForOnlineMatch += 1;
      return tracks[id] ?? null;
    },
  };
  store.matchOutcome = outcome;
  return store;
}

/** 假桥：只读状态、只数调用。测试要能证明"关着的时候一次桥都没碰过"。 */
function fakeBridge(store) {
  const bridgeCalls = [];
  const bridge = {
    bridgeCalls,
    status: () => ({ phase: store.bridgePhase ?? 'off', port: store.bridgePort ?? 0, backends: store.bridgeBackends ?? [], unauthorized: 0, restarts: 0, lastError: store.bridgeError ?? null, hosts: [] }),
    ensure: () => {},
    call: async (route, payload) => { bridgeCalls.push([route, payload]); return { ok: false, reason: '这一期还没有路由会调桥' } },
    shutdown: async () => ({ forced: false }),
  };
  store.bridge = bridge;
  return bridge;
}

async function withServer(store, run, options = {}) {
  const { server } = await createMusicServer({
    store,
    distDir: SCRIPTS,
    autoScan: false,
    // 第五期 Task 3：这些路由测试不碰真桥（不 spawn 子进程）。假的这个对象只提供服务状态读取，
    // call() 被调到了也算失败——由下面那条"关着零暴露"的断言显式检查计数。
    bridgeClient: fakeBridge(store),
    // R144：认领那几条要验"匹配器被调的是哪一格"（match 还是 fetchClaimed），所以整份匹配器可换。
    onlineLyricsMatcher: options.matcher ?? {
      match: async (query, matchOptions) => {
        store.calls.match.push(query);
        // R144：`force` 单独记一格。塞进 calls.match 里会把上面那两条 `deepEqual(calls.match, [query])`
        // 的既有判据搅掉——那是"匹配器只能拿到标签文本"的判据，不该被新字段牵连。
        (store.calls.force ??= []).push(matchOptions?.force === true);
        return store.matchOutcome;
      },
      // 6.6：注入件也带上 clearCache，才能断言"重扫会作废上一次的未命中留痕"。
      clearCache: () => { store.calls.clearCache += 1; },
    },
    ...(options.claims ? { lyricClaims: options.claims } : {}),
  });
  // 先确认这个端口真的能连上再交给用例：M2 期间这里偶发 `fetch failed`（Windows 回环端口回收），
  // 探测只重连不重断言，用例里的任何断言失败照常红。
  // R144 补两条（**两条都还在**，只是换了实现）：
  //   ① 探测排在 try 里面——从前它在外面，一抛出去 `finally` 就不执行，服务进程留着不退，
  //      整段自检挂住（真机表现：全链卡在第 18 段三分多钟不动，比红严重得多）。
  //   ② 探测窗口从 1 秒放宽到 4 秒（掩的是 connect 的运气，不是逻辑；这一节现在每跑一次
  //      要多起 4 个临时服务，撞上的概率跟着涨了）。
  // R211（B 类第 8 处）：窗口现在由 R198 的 `listenAndReady` 给 —— 每轮 6 次退避探测、连不上就把这台
  //   关掉换个端口重听（三轮合计 ≈3.7 s，比当年手工的 80×50 ms 更宽，而且治"连的是别人"那种）；
  //   ①那条加固原样保留：`listen` 与探测一起进 try，`finally` 照旧关服务。
  try {
    const { origin } = await listenAndReady(server);
    await run(origin);
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
}

const postOnline = (base, body, method = 'POST') => fetch(`${base}${ONLINE_MATCH_ROUTE}`, {
  method,
  headers: { 'Content-Type': 'application/json' },
  body: body === undefined ? undefined : JSON.stringify(body),
}).then(async (response) => ({ status: response.status, body: await response.json() }));

// 6.6：服务端视图从"有无词"一个布尔换成 localLyric {present,timed,format}——只有**带时间轴**的本地词才一票否决。
const localTrack = { track: { id: 'track-a' }, album: { title: '黑马' }, localLyric: { present: true, timed: true, format: 'lrc' }, query: { title: 'Lovers', artist: '李荣浩', album: '黑马', durationMs: 253000 } };
const bareTrack = { track: { id: 'track-b' }, album: { title: 'COME ALONG 3' }, localLyric: { present: false, timed: false, format: null }, query: { title: 'さよなら夏の日', artist: '山下達郎', album: 'COME ALONG 3', durationMs: 267830 } };
// 第四期实测的 Lovers 形状：内嵌 USLT 纯文本，有词但没有任何时间轴。
const untimedTrack = { track: { id: 'track-c' }, album: { title: '黑马' }, localLyric: { present: true, timed: false, format: 'lyrics' }, query: { title: 'Lovers', artist: '李荣浩', album: '黑马', durationMs: 253000 } };

test('6.6：本地只有无时间轴内嵌词时路由放行在线尝试，并回 localLyrics:"untimed"', async () => {
  const store = fakeStore({ enabled: true, tracks: { 'track-c': untimedTrack } });
  await withServer(store, async (base) => {
    const res = await postOnline(base, { trackId: 'track-c' });
    assert.equal(res.status, 200);
    assert.equal(res.body.localLyrics, 'untimed', '要说清"本地有词但没时间轴"，前端据此决定回退到段落');
    assert.equal(store.calls.match.length, 1, '无时间轴的本地词不再挡在线');
  });
});

test('6.6：重新扫描会作废在线匹配的进程内缓存（正例与未命中留痕一起清）', async () => {
  const store = fakeStore({ enabled: true, tracks: { 'track-b': bareTrack } });
  await withServer(store, async (base) => {
    assert.equal(store.calls.clearCache, 0, '前置条件：没扫之前不作废');
    const res = await fetch(`${base}/api/library/scan`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    assert.ok(res.status === 202 || res.status === 200, `重扫应被接受，实测 HTTP ${res.status}`);
    assert.equal(store.calls.clearCache, 1, '重扫 = 标签可能变了，"上次没配到"必须作废');
  });
});

test('6.6：本地有带时间轴的词（伴生文件或内嵌同步标签）仍绝对优先，零在线调用', async () => {
  for (const format of ['lrc', 'ttml']) {
    const store = fakeStore({ enabled: true, tracks: { 'track-a': { ...localTrack, localLyric: { present: true, timed: true, format } } } });
    await withServer(store, async (base) => {
      const res = await postOnline(base, { trackId: 'track-a' });
      assert.equal(res.body.localLyrics, 'present');
      assert.match(res.body.reason, /带时间轴/);
      assert.equal(store.calls.match.length, 0, `${format} 是带时间轴的本地词，冲突规则这一格不能让出去`);
    });
  }
});

test('任务 7：开关关闭时路由 404，且开关判定早于索引查询与匹配器（一次出网机会都不给）', async () => {
  const store = fakeStore({ enabled: false, tracks: { 'track-b': bareTrack } });
  await withServer(store, async (base) => {
    const res = await postOnline(base, { trackId: 'track-b' });
    assert.equal(res.status, 404);
    assert.match(res.body.error, /已关闭/);
    // 2026-10-04 定案：联网默认打开 ⇒ 文案要说"该项默认开启"，同时仍然告诉用户去哪里恢复
    assert.match(res.body.error, /默认开启/);
    assert.doesNotMatch(res.body.error, /默认关闭/, '不得再对用户宣称默认是关闭的');
    assert.equal(store.calls.trackForOnlineMatch, 0);
    assert.equal(store.calls.match.length, 0);
  });
});

test('任务 7：开启后本地已有**带时间轴**的歌词一律不触发在线（冲突规则在服务端把关，6.6 收窄到"有轴"）', async () => {
  const store = fakeStore({ enabled: true, tracks: { 'track-a': localTrack } });
  await withServer(store, async (base) => {
    const res = await postOnline(base, { trackId: 'track-a' });
    assert.equal(res.status, 200);
    assert.equal(res.body.matched, false);
    assert.equal(res.body.localLyrics, 'present');
    assert.match(res.body.reason, /带时间轴/);
    assert.equal(store.calls.match.length, 0, '本地有带时间轴的词时绝不发在线请求');
  });
});

test('任务 7：trackId 校验、未知曲目 404、非 POST 405', async () => {
  const store = fakeStore({ enabled: true, tracks: { 'track-a': localTrack } });
  await withServer(store, async (base) => {
    for (const bad of [{ trackId: 'a/../b' }, { trackId: 'track b' }, { trackId: 1 }, {}, { trackId: 'x'.repeat(65) }]) {
      assert.ok((await postOnline(base, bad)).status >= 400, `${JSON.stringify(bad)} 必须被拒`);
    }
    assert.equal(store.calls.trackForOnlineMatch, 0, '非法 trackId 不得走到索引查询');
    assert.equal((await postOnline(base, { trackId: 'track-nope' })).status, 404);
    assert.equal((await postOnline(base, undefined, 'GET')).status, 405);
  });
});

test('任务 7：开启且本地无词时，路由把索引里的标签原样交给匹配器，并透传归一结果（含译文与溯源）', async () => {
  const store = fakeStore({ enabled: true, tracks: { 'track-b': bareTrack } });
  await withServer(store, async (base) => {
    const res = await postOnline(base, { trackId: 'track-b' });
    assert.equal(res.status, 200);
    assert.equal(res.body.trackId, 'track-b');
    assert.equal(res.body.localLyrics, 'absent');
    assert.equal(res.body.matched, true);
    assert.equal(res.body.provider, 'qq');
    assert.equal(res.body.format, 'qrc');
    assert.equal(res.body.isWordByWord, true);
    assert.equal(res.body.matchedSong.sourceId, 212722243);
    assert.equal(res.body.translation, TRANSLATION_BODY, '翻译随同一响应归一返回（四问定案三），字段名必须与匹配器一致');
    assert.deepEqual(store.calls.match, [bareTrack.query], '匹配器只能拿到本地索引的标签文本');
  });
});

test('任务 7：未命中回 200 带可读原因（在线失败是信息不是错误码），前端可据此停在本地无词态', async () => {
  const store = fakeStore({ enabled: true, tracks: { 'track-b': bareTrack }, outcome: unmatchedOutcome });
  await withServer(store, async (base) => {
    const res = await postOnline(base, { trackId: 'track-b' });
    assert.equal(res.status, 200);
    assert.equal(res.body.localLyrics, 'absent');
    assert.equal(res.body.matched, false);
    assert.match(res.body.reason, /低于阈值/);
  });
});

// ── F4（2026-10-06）：在线曲目接通歌词 ────────────────────────────────────────

test('F4：在线曲目的查询串校验——id 形态、必填、长度、时长边界，一项不合就 null', async () => {
  const { onlineLyricQueryFrom } = await import('./online-lyrics.mjs');
  const ok = { title: '恋人', artist: '李荣浩', album: '黑马', durationMs: 276000 };
  assert.deepEqual(onlineLyricQueryFrom({ online: ok }, 'on-netease-27699577'), ok);
  assert.deepEqual(onlineLyricQueryFrom({ online: { title: ' 恋人 ', artist: '李荣浩' } }, 'on-qq-003abc'),
    { title: '恋人', artist: '李荣浩', album: '', durationMs: 0 }, '首尾空白要剥；专辑与时长可缺（缺=中性）');
  assert.equal(onlineLyricQueryFrom({}, 'on-netease-1'), null, '不带描述字段就是不该开这扇门');
  assert.equal(onlineLyricQueryFrom({ online: ok }, 'track-b'), null, '本地 id 走索引那条路，这扇门只对 on- 前缀开');
  assert.deepEqual(onlineLyricQueryFrom({ online: ok }, 'on-kugou-1'), ok, '三个音源前缀都算合法形态（酷狗歌词本来就经桥在四源里）');
  assert.equal(onlineLyricQueryFrom({ online: { ...ok, title: '' } }, 'on-netease-1'), null, '空标题不发起检索');
  assert.equal(onlineLyricQueryFrom({ online: { ...ok, artist: 42 } }, 'on-netease-1'), null, '非字符串不接');
  assert.equal(onlineLyricQueryFrom({ online: { ...ok, title: 'x'.repeat(161) } }, 'on-netease-1'), null, '超长就是异常，不该原样转给第三方');
  assert.equal(onlineLyricQueryFrom({ online: { ...ok, durationMs: 99e9 } }, 'on-netease-1'), null, '时长离谱（>1 小时）判非法');
  assert.equal(onlineLyricQueryFrom({ online: { ...ok, durationMs: 'abc' } }, 'on-netease-1'), null, 'NaN 不接');
});

test('F4：在线曲目经描述字段拿到词——路由回 localLyrics:absent + trackKind:online，匹配器收到归一后的查询串', async () => {
  const store = fakeStore({ enabled: true });
  await withServer(store, async (base) => {
    const res = await postOnline(base, { trackId: 'on-netease-27699577', online: { title: ' 恋人 ', artist: '李荣浩', album: '黑马', durationMs: 276000 } });
    assert.equal(res.status, 200, `在线曲目应当走通，实测 ${res.status} ${JSON.stringify(res.body)}`);
    assert.equal(res.body.localLyrics, 'absent', '在线曲目没有本地词，这一档恒 absent');
    assert.equal(res.body.trackKind, 'online', '响应要能说出这是从在线描述走通的（不是索引里查到的）');
    assert.equal(res.body.matched, true);
    assert.deepEqual(store.calls.match, [{ title: '恋人', artist: '李荣浩', album: '黑马', durationMs: 276000 }]);
    assert.equal(store.calls.trackForOnlineMatch, 1, '先查一次索引（本地曲目优先），查不到才走这扇门');
  });
});

test('F4：门的边界——不带描述、本地 id 硬塞描述、超长标题，一律 404 且零匹配', async () => {
  for (const [label, body] of [
    ['在线 id 但不带描述', { trackId: 'on-netease-1' }],
    ['本地形态的 id 硬塞描述', { trackId: 'track-hacker', online: { title: '恋人', artist: '李荣浩' } }],
    ['超长标题', { trackId: 'on-qq-1', online: { title: 'x'.repeat(400), artist: '李荣浩' } }],
    ['缺歌手', { trackId: 'on-qq-1', online: { title: '恋人' } }],
  ]) {
    const store = fakeStore({ enabled: true });
    await withServer(store, async (base) => {
      const res = await postOnline(base, body);
      assert.equal(res.status, 404, `${label} 必须被拒`);
      assert.equal(store.calls.match.length, 0, `${label} 被拒时不该发起任何匹配（不出网）`);
    });
  }
});

test('F4：歌词子开关关掉时，在线曲目也是 404 且零匹配——开关判定仍然早于一切', async () => {
  const store = fakeStore({ enabled: false });
  await withServer(store, async (base) => {
    const res = await postOnline(base, { trackId: 'on-netease-1', online: { title: '恋人', artist: '李荣浩' } });
    assert.equal(res.status, 404);
    assert.equal(store.calls.match.length, 0);
    assert.equal(store.calls.trackForOnlineMatch, 0, '关闭时连索引都不查');
  });
});

test('任务 7：/api/config 的 onlineLyrics 非法值一律 4xx 且不改开关，合法值写回后 GET 可见', async () => {
  const store = fakeStore({});
  await withServer(store, async (base) => {
    for (const bad of [{ onlineLyrics: { enabled: 'yes' } }, { onlineLyrics: { enabled: 1 } }, { onlineLyrics: 'on' }, { onlineLyrics: { enabled: true, extra: 1 } }, { onlineLyrics: {} }]) {
      const res = await fetch(`${base}/api/config`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(bad) });
      assert.ok(res.status >= 400, `${JSON.stringify(bad)} 必须被拒，实测 ${res.status}`);
      await res.text();
    }
    assert.equal(store.config.online.lyrics, false, '非法写入不得改变开关');
    assert.equal((await fetch(`${base}/api/config`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ onlineLyrics: { enabled: true } }) })).status, 200);
    assert.equal((await (await fetch(`${base}/api/config`)).json()).onlineLyrics.enabled, true);
  });
});

test('任务 7：快照暴露 onlineLyrics.enabled，前端才能做到"状态可见"（默认值本身由 check-music-library 钉）', async () => {
  const store = fakeStore({});
  await withServer(store, async (base) => {
    assert.deepEqual((await (await fetch(`${base}/api/library`)).json()).onlineLyrics, { enabled: false });
    const library = await readScript('music-library.mjs');
    assert.match(library, /onlineLyrics: \{ enabled: this\.config\.online\?\.lyrics === true \}/, '快照里的旧字段是新表的镜像，不是第二处存的值');
  });
});

test('R61 + 2026-10-04 定案 + R77：在线开关四张子表、默认值单一真源、不复用 onlineEnabled', async () => {
  const library = await readScript('music-library.mjs');
  assert.match(library, /export const ONLINE_SWITCHES = \['lyrics', 'search', 'streaming', 'covers'\]/, '四张子开关的表只写在这一处');
  assert.match(library, /onlineEnabled: true,\n\s*online: Object\.fromEntries\(ONLINE_SWITCHES\.map\(\(key\) => \[key, true\]\)\),/, '默认开启只写在这一处（全表由 ONLINE_SWITCHES 推出来）');
  assert.match(library, /onlineEnabled: ONLINE_DEFAULTS\.onlineEnabled/, '初始配置读的是那张表，不是又一份字面量');
  assert.match(library, /online: \{ \.\.\.ONLINE_DEFAULTS\.online \}/, '构造函数的初值也来自同一张表');
  assert.match(library, /pickOnlineSwitch\(stored\?\.\[key\], ONLINE_DEFAULTS\.online\[key\]/, 'init() 的回落目标同样来自那张表');
  assert.doesNotMatch(library, /onlineLyrics: \{ enabled: false \}/, '默认配置里不得再留下"关闭"字面量（会被断言的过期默认）');
  assert.match(library, /onlineEnabled: !!this\.config\.onlineEnabled/, 'MusicBrainz 那条快照字段保持原样');
  const serverSource = await readScript('music-server.mjs');
  assert.match(serverSource, /store\.config\.online\?\.lyrics/, '歌词路由判定读的是 online.lyrics');
  assert.doesNotMatch(serverSource, /onlineEnabled[^]{0,120}error: '在线歌词/, '不得拿 onlineEnabled 当在线歌词的开关');
});

test('R77：旧字段 onlineLyrics.enabled 一个版本期内只读——归并进新表、回写磁盘后不留第二份真源', async () => {
  // 离线纪律：这里建的是真实 MusicLibraryStore，必须先把联系方式清掉，
  // 否则联网默认打开后，init/scan 会跟着排一轮 MusicBrainz 补全（自检绝不该出网）。
  delete process.env.MUSICBRAINZ_CONTACT;
  const { mkdtemp, writeFile, readFile: readBack } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join: pathJoin } = await import('node:path');
  const { MusicLibraryStore } = await import('./music-library.mjs');
  const writeConfig = async (config) => {
    const dir = await mkdtemp(pathJoin(tmpdir(), 'rhine-online-config-'));
    await writeFile(pathJoin(dir, 'config.json'), JSON.stringify(config));
    return { dir, store: await new MusicLibraryStore({ dataDir: dir, defaultRoots: [] }).init() };
  };

  // ① 旧库升级：磁盘上只有 onlineLyrics:false ⇒ 归并成 online.lyrics:false（"没写过"不等于"用户关过"，
  //    但明确写过 false 就是用户表过态，重启后必须还是关）。
  const legacyOff = await writeConfig({ version: 1, roots: [], onlineLyrics: { enabled: false } });
  assert.equal(legacyOff.store.config.online.lyrics, false, '旧字段写过的 false 必须被尊重');
  assert.equal(legacyOff.store.config.online.search, true, '旧字段管不着其余三项，它们落回产品默认');
  assert.equal('onlineLyrics' in legacyOff.store.config, false, '归并后内存里不得再留旧字段');
  assert.equal('onlineLyrics' in JSON.parse(await readBack(pathJoin(legacyOff.dir, 'config.json'), 'utf8')), false, '回写的磁盘文件也不得留旧字段');

  // ② 完全没写过在线开关的老 config ⇒ 四项全默认开启。
  const fresh = await writeConfig({ version: 1, roots: [] });
  assert.deepEqual(fresh.store.config.online, { lyrics: true, search: true, streaming: true, covers: true });

  // ③ 新表优先：两处都有且不一致时，以新表为准（旧字段只是历史包袱，不再是真源）。
  const both = await writeConfig({ version: 1, roots: [], online: { lyrics: true }, onlineLyrics: { enabled: false } });
  assert.equal(both.store.config.online.lyrics, true, '新表写过 ⇒ 旧字段闭嘴');

  // ④ 意外值（"yes"）落回默认并留一句日志，绝不把"写坏了"读成"用户关过"。
  const broken = await writeConfig({ version: 1, roots: [], online: { lyrics: 'yes', covers: 1 } });
  assert.equal(broken.store.config.online.lyrics, true);
  assert.equal(broken.store.config.online.covers, true);

  // ⑤ 面板今天还发旧字段 ⇒ updateConfig 必须接受，但它写的是新表；两处同时提交且冲突一律拒。
  const saved = await fresh.store.updateConfig({ onlineLyrics: { enabled: false } });
  assert.equal(fresh.store.config.online.lyrics, false);
  assert.equal(saved.onlineLyrics.enabled, false, '响应里的镜像要跟新表一致（前端读的就是这一项）');
  assert.equal('onlineLyrics' in fresh.store.config, false, '写旧字段不得在配置里重新造出第二份');
  await assert.rejects(() => fresh.store.updateConfig({ online: { lyrics: true }, onlineLyrics: { enabled: false } }), /冲突/);
  await assert.rejects(() => fresh.store.updateConfig({ online: { lyrics: 'yes' } }), /online\.lyrics 必须为布尔值/);
  await assert.rejects(() => fresh.store.updateConfig({ online: { karaoke: true } }), /不认识的开关/);
  await assert.rejects(() => fresh.store.updateConfig({ online: 'on' }), /布尔表/);
  // 部分提交只改那一项目标，其余保持原样（面板以后拆成四个勾选框时依赖的就是这条语义）。
  await fresh.store.updateConfig({ online: { covers: false } });
  assert.deepEqual(fresh.store.config.online, { lyrics: false, search: true, streaming: true, covers: false });
});

// ── 阶段 6.6 Task 3：把上游"版本标记参与打分"的语义钉住（第四期定案 1）──────
test('定案：版本标记括号保留在归一化标题里参与打分（Live 配到录音室版是真错误，宁可无词）', async () => {
  const score = await readScript('online-match-score.mjs');
  assert.match(score, /versionMarkerPattern/, '剔除规则必须还在移植体里（逐字保真，不许被"顺手优化"掉）');
  assert.match(score, /versionMarkerPattern\.test\(content\) \? match : ''/, '命中版本标记 ⇒ 连括号一起留下；不命中 ⇒ 整段剔除');
  const local = { title: '恋人', artist: '李荣浩', album: '黑马', durationMs: 276008 };
  const candidate = (name) => ({ name, artists: [{ name: '李荣浩' }], album: { name: '黑马' }, durationMs: 276008 });
  const exact = calculateMatchScoreDetails(local, candidate('恋人'));
  const live = calculateMatchScoreDetails(local, candidate('恋人 (Live)'));
  const deluxe = calculateMatchScoreDetails(local, candidate('恋人 (Deluxe Edition)'));
  assert.equal(exact.score, 100, '同名同专辑同歌手是满分基准');
  assert.equal(live.score, 68, `(Live) 必须显著低于满分：实测 titleSim=${live.titleSimilarity.toFixed(3)}`);
  assert.ok(live.score < AUTO_MATCH_MIN_SCORE, `(Live) 低于阈值 ⇒ 本地录音室版不会配到 Live 词，反之亦然`);
  assert.equal(live.titleMatched, false, '标题相似度门槛 0.65 未过，titleMatched 必须为假');
  assert.ok(deluxe.score < live.score, `不同版本标记之间也不许被抹平：deluxe=${deluxe.score} live=${live.score}`);
  // feat 括号是"剔除"的一类，与版本标记正好相反 —— 一并钉住，防止有人把两个分支写反。
  assert.equal(calculateMatchScoreDetails(local, candidate('恋人 (feat. 张三)')).score, 100, 'feat 括号剔除后与同名等价');
  // 如实登记上游词表的边界：中文版本词不在 pattern 里，这类括号会被当作"非版本标记"剔掉。
  assert.equal(calculateMatchScoreDetails(local, candidate('恋人 (2019 重制版)')).score, 100,
    '上游词表只收英文 remaster/live 等，中文"重制版/现场版"会被剔除 ⇒ 与同名等价（维持上游，不改）');
});

// ── R144（任务五）· 近候选 / 重试 / 手动认领 ────────────────────────────────
// 这一节只加出路，不动判据：自动挡的阈值 75、逐字优先、实体声明拒绝、计时行门槛全部照旧，
// 下面每条断言都带着"为什么这一格必须钉住"的一句理由。
const nearCandidate = (over = {}) => songCandidate({ title: 'さよなら夏の日2', album: { name: '别的专辑' }, ...over });

test('R144 近候选：只留 60~74 分那几条、按分数降序、过线的与更差的都不要', async () => {
  const { outcome, routes } = await runMatch({ candidates: [
    nearCandidate({ id: 111 }),
    nearCandidate({ id: 222, album: { name: '另一张' } }),
    songCandidate({ id: 333, title: '别的歌', singer: [{ name: '别人' }] }),   // 25 分档：低于 60，列出来只是噪声
  ] });
  assert.equal(outcome.matched, false, '阈值 75 一个字没改：64 分不该被配上');
  assert.equal(outcome.bestScore, 64, `实测 ${JSON.stringify(outcome.near)}`);
  assert.equal(routes.calls.lyric, 0, '没过线就不该去取词（近候选只是"说给人听"）');
  assert.equal(outcome.near?.length, 2, '两条 64 分留下、25 分那条不要');
  assert.deepEqual([...new Set(outcome.near.map((one) => one.score))], [64]);
  for (const one of outcome.near) {
    assert.equal(one.provider, 'qq');
    assert.ok(one.sourceId, '认领要能凭这条身份再取一次词');
    assert.ok(one.title && one.artist, '界面上要说得出选了哪一首');
    assert.equal('text' in one, false, '近候选里绝不许有歌词正文（正文不落盘那条声明靠这个成立）');
    assert.ok(one.score >= 60 && one.score < 75, `这一条 ${one.score} 分不该出现在近候选里`);
  }
});

test('R144 近候选条数有上限（一次列 20 条只留前 8 条，不给界面堆一屏）', async () => {
  const many = Array.from({ length: 20 }, (_, index) => nearCandidate({ id: 1000 + index, album: { name: `专辑${index}` } }));
  const { outcome } = await runMatch({ candidates: many });
  assert.equal(outcome.near?.length, 8, `实测 ${outcome.near?.length}`);
});

test('R144 未命中留痕带着近候选：第二次读同一首仍然看得见那几条', async () => {
  const { routes, fetcher } = makeRoutes({ candidates: [nearCandidate()] });
  const matcher = createOnlineLyricMatcher({ fetcher, decrypt: identityDecrypt });
  const first = await matcher.match(LOCAL_SONG);
  const second = await matcher.match(LOCAL_SONG);
  assert.equal(first.near?.length, 1);
  assert.equal(second.cached, 'miss', '前置条件：第二次是走负缓存的');
  assert.equal(second.near?.length, 1, '负缓存丢掉 near ⇒ 出路就只剩"先重试一次"，那是把门藏起来');
  assert.equal(routes.calls.search, 1, '留痕本身不该多打一次网');
});

test('R144 重试：force 绕开正负缓存重新问一次，绕的是缓存不是判据', async () => {
  const { routes, fetcher } = makeRoutes({ candidates: [nearCandidate()] });
  const matcher = createOnlineLyricMatcher({ fetcher, decrypt: identityDecrypt });
  await matcher.match(LOCAL_SONG);
  const cached = await matcher.match(LOCAL_SONG);
  assert.equal(cached.cached, 'miss');
  assert.equal(routes.calls.search, 1, '前置条件：没重试时不再出网');
  const retried = await matcher.match(LOCAL_SONG, { force: true });
  assert.equal(routes.calls.search, 2, '重试要真的再问一次');
  assert.equal(retried.matched, false, '重试不改变结论：阈值仍然 75');
  // 命中那一档也要能绕：先配上一首，再 force，仍然重新检索一次（否则"重试"只对失败有意义）
  const hit = makeRoutes();
  const hitMatcher = createOnlineLyricMatcher({ fetcher: hit.fetcher, decrypt: identityDecrypt });
  assert.equal((await hitMatcher.match(LOCAL_SONG)).matched, true);
  assert.equal((await hitMatcher.match(LOCAL_SONG)).cached, undefined, '命中结果第一次读就该是缓存外的那一次');
  await hitMatcher.match(LOCAL_SONG, { force: true });
  assert.equal(hit.routes.calls.search, 2, '正缓存同样要被 force 绕开');
});

test('R144 按认领取词：一次检索都不发，取词判定与自动挡共用同一份', async () => {
  const { routes, fetcher } = makeRoutes({ lyricEnvelope: envelopeOf(LRC_BODY) });
  const matcher = createOnlineLyricMatcher({ fetcher, decrypt: identityDecrypt });
  const claim = { provider: 'qq', sourceId: '212722243', accessKey: '', title: 'さよなら夏の日 (道别的夏天)', artist: '山下達郎', album: 'COME ALONG 3', durationMs: 267000, score: 70 };
  const outcome = await matcher.fetchClaimed(LOCAL_SONG, claim);
  assert.equal(outcome.matched, true, outcome.reason);
  assert.equal(outcome.claimed, true, '界面要能说出"这是人挑的，不是机器配的"');
  assert.equal(outcome.provider, 'qq');
  assert.equal(outcome.format, 'lrc', 'fixture 给的是行级词');
  assert.equal(routes.calls.search, 0, '认领这条路不检索——身份已经定了，再检索就是拿机器判断盖人的判断');
  assert.equal(routes.calls.lyric, 1);
  assert.ok(outcome.text.includes('ALPHA'));
});

test('R144 认领取到的是器乐占位词（计时行不足）⇒ 如实失败，且不污染任何缓存', async () => {
  const { routes, fetcher } = makeRoutes({ candidates: [nearCandidate()], lyricEnvelope: envelopeOf(PLACEHOLDER_BODY) });
  const matcher = createOnlineLyricMatcher({ fetcher, decrypt: identityDecrypt });
  const failed = await matcher.fetchClaimed(LOCAL_SONG, { provider: 'qq', sourceId: '212722243', title: 'x', artist: '山下達郎', durationMs: 267000, score: 70 });
  assert.equal(failed.matched, false, '自动挡拒绝的载荷，手动认领同样不许放出去');
  assert.match(failed.reason, /计时行不足/);
  assert.equal(routes.calls.search, 0);
  const after = await matcher.match(LOCAL_SONG);
  assert.equal(after.matched, false);
  assert.equal(routes.calls.search, 1, 'fetchClaimed 不该写正/负缓存（写了就等于把一次取词当成一次匹配结论）');
});

test('R144 认领不认识来源就拒绝：AMLL 是按 QQ 曲目 id 索引的兜底库，不能单独认领', async () => {
  const matcher = createOnlineLyricMatcher({ fetcher: async () => { throw new Error('不该出网') }, decrypt: identityDecrypt });
  const outcome = await matcher.fetchClaimed(LOCAL_SONG, { provider: 'amll', sourceId: '1', title: 'x', artist: 'y' });
  assert.equal(outcome.matched, false);
  assert.match(outcome.reason, /来源不认识/);
  const noId = await matcher.fetchClaimed(LOCAL_SONG, { provider: 'qq', sourceId: '', title: 'x', artist: 'y' });
  assert.equal(noId.matched, false, '没有曲目标识就没法取词，别猜一条');
});

const CLAIM = { provider: 'qq', sourceId: '212722243', accessKey: 'AK-1', title: '他不懂', artist: '张杰', album: '爱在他乡', durationMs: 253000, score: 70 };

test('R144 认领记录 · 形状把关：来源白名单、标识形状、文本上限、时长与分数范围，一项不合格就拒', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'rhine-claims-shape-'));
  try {
    const claims = createLyricClaims({ dataDir: dir });
    const bad = [
      [{ provider: 'amll' }, /只认/],
      [{ provider: 'netease', sourceId: '../../etc/passwd' }, /曲目标识/],
      [{ provider: 'qq', sourceId: 'ok', accessKey: 'x'.repeat(200) }, /令牌/],
      [{ provider: 'qq', sourceId: 'ok', title: '' }, /曲名/],
      [{ provider: 'qq', sourceId: 'ok', title: 'x'.repeat(200) }, /曲名|专辑名/],
      [{ provider: 'qq', sourceId: 'ok', durationMs: 99_999_999 }, /时长/],
      [{ provider: 'qq', sourceId: 'ok', score: 400 }, /分数/],
    ];
    for (const [over, pattern] of bad) {
      const got = await claims.put('a'.repeat(24), { ...CLAIM, ...over }, { track: LOCAL_SONG });
      assert.equal(got.ok, false, `${JSON.stringify(over)} 竟然被收下了`);
      assert.match(got.error, pattern, `拒的理由不对：${got.error}`);
    }
    const listing = await readdir(dir);
    assert.deepEqual(listing, [], '全部被拒 ⇒ 一个文件都不该写（"拒了还留一份空文件"是假拒绝）');
  } finally { await rm(dir, { recursive: true, force: true }) }
});

test('R144 认领记录 · put→get→clear 一遍 + 报告字段 + 替换标记 + 文件里没有歌词正文', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'rhine-claims-round-'));
  try {
    const logs = [];
    const claims = createLyricClaims({ dataDir: dir, log: (line) => logs.push(line) });
    const fingerprint = lyricIdentityFingerprint(LOCAL_SONG);
    assert.equal(await claims.get(fingerprint), null, '前置条件：新目录里没有记录');
    const first = await claims.put(fingerprint, CLAIM, { track: LOCAL_SONG });
    assert.equal(first.ok, true, JSON.stringify(first));
    assert.equal(first.replaced, false);
    assert.equal(first.total, 1);
    assert.equal(first.file, 'lyric-claims.json', '报告要说得出写到了哪个文件（用户要能自己找到并删）');
    const back = await claims.get(fingerprint);
    assert.equal(back.sourceId, CLAIM.sourceId, '取回来的必须就是写进去的那一条身份');
    assert.equal(back.track.title, LOCAL_SONG.title, '条目要带着"给哪首歌认的"，不然只剩一串哈希');
    const second = await claims.put(fingerprint, { ...CLAIM, sourceId: '999' }, { track: LOCAL_SONG });
    assert.equal(second.replaced, true, '同一首要能覆盖，并且说清是替换');
    assert.equal(second.total, 1, '替换不该长出第二条');
    assert.equal((await claims.get(fingerprint)).sourceId, '999');
    assert.ok(logs.some((line) => line.includes('替换原有那一条')), '写盘要有报告（日志里看不见 = 悄悄改数据）');
    const onDisk = await readFile(join(dir, 'lyric-claims.json'), 'utf8');
    assert.equal(onDisk.includes('[00:'), false, '歌词正文绝不落盘：这条记录里只有身份');
    assert.equal(onDisk.includes('ALPHA'), false);
    const cleared = await claims.clear(fingerprint);
    assert.equal(cleared.ok, true);
    assert.equal(cleared.removed, true);
    assert.equal(await claims.get(fingerprint), null);
    const again = await claims.clear(fingerprint);
    assert.equal(again.removed, false, '再取消一次要说"本来就没有"，不许假装删掉了一条');
  } finally { await rm(dir, { recursive: true, force: true }) }
});

test('R144 认领记录 · 上限如实拒绝且不静默淘汰；坏文件当没有而不是崩', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'rhine-claims-limit-'));
  try {
    const claims = createLyricClaims({ dataDir: dir, limit: 2 });
    const k1 = 'a'.repeat(24);
    const k2 = 'b'.repeat(24);
    const k3 = 'c'.repeat(24);
    assert.equal((await claims.put(k1, CLAIM, { track: LOCAL_SONG })).ok, true);
    assert.equal((await claims.put(k2, CLAIM, { track: LOCAL_SONG })).ok, true);
    const third = await claims.put(k3, CLAIM, { track: LOCAL_SONG });
    assert.equal(third.ok, false, '到上限了还收下 = 静默挤掉别人');
    assert.match(third.error, /上限 2 条/);
    assert.equal((await claims.list()).length, 2, '被拒的那一轮不该动已有记录');
    // 同一把键再写一次仍然允许（替换不是新增）
    assert.equal((await claims.put(k1, { ...CLAIM, sourceId: '777' }, { track: LOCAL_SONG })).ok, true);
    await writeFile(join(dir, 'lyric-claims.json'), '{ 这不是 JSON', 'utf8');
    assert.equal(await createLyricClaims({ dataDir: dir }).get(k1), null, '读不懂就当没有（重建而不是崩），不许拿半截数据当结论');
    await writeFile(join(dir, 'lyric-claims.json'), JSON.stringify({ version: 99, entries: { [k1]: CLAIM } }), 'utf8');
    assert.equal((await createLyricClaims({ dataDir: dir }).list()).length, 0, '版本不认识 ⇒ 整份当没有');
  } finally { await rm(dir, { recursive: true, force: true }) }
});

test('R144 路由 · 认领：开关→方法→体→才出网；写之前真取一次；响应体不含歌词正文', async () => {
  const CLAIM_ROUTE = '/api/online/lyrics/claim';
  const postClaim = (base, body, method = 'POST') => fetch(`${base}${CLAIM_ROUTE}`, {
    method, headers: { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body),
  }).then(async (r) => ({ status: r.status, body: await r.json().catch(() => null) }));
  const dir = await mkdtemp(join(tmpdir(), 'rhine-claims-route-'));
  try {
    const claims = createLyricClaims({ dataDir: dir });
    const calls = { claimed: 0 };
    // 两份假曲库都排在 matcher 之前声明：闭包读 `store` 而声明在下面，是 M3-b 那条 TDZ 的同款形状
    // （回调在注册那一刻同步跑就会炸，而离线用例未必走得到那一格）。
    const off = fakeStore({ enabled: false, tracks: { 'track-b': bareTrack } });
    const store = fakeStore({ enabled: true, tracks: { 'track-b': bareTrack } });
    const matcher = {
      match: async () => store.matchOutcome,
      fetchClaimed: async () => { calls.claimed += 1; return calls.claimOutcome },
      clearCache: () => {},
    };
    // ① 开关关着 ⇒ 404 且一次取词都不发
    await withServer(off, async (base) => {
      const res = await postClaim(base, { trackId: 'track-b', candidate: CLAIM });
      assert.equal(res.status, 404, '关掉在线歌词后这扇门不该开');
      assert.equal(off.bridge.bridgeCalls.length, 0, '关着 ⇒ 零出网');
    }, { matcher, claims });
    await withServer(store, async (base) => {
      // ② 方法：GET 一次都不碰体
      assert.equal((await postClaim(base, undefined, 'GET')).status, 405);
      assert.equal(calls.claimed, 0, '405 那一档不该已经去取词');
      // ②b R148（Q20）：近候选出浏览器之前，`accessKey` 换成我们签发的不透明 token
      store.matchOutcome = { matched: false, reason: '最高分 63，低于阈值 75', near: [{ ...CLAIM }] };
      const listed = await postOnline(base, { trackId: 'track-b' });
      const token = listed.body?.near?.[0]?.claimToken;
      assert.match(String(token ?? ''), /^[a-f0-9]{16}$/, `近候选该带我们签发的令牌，实测 ${JSON.stringify(listed.body?.near)}`);
      assert.equal(listed.body.near[0].accessKey, undefined, '响应里的近候选不许还带 accessKey 这个键');
      assert.equal(JSON.stringify(listed.body).includes('AK-1'), false, 'accessKey 原文一个字都不许出现在响应里');
      // ③ 没有令牌 / 令牌解不出来 ⇒ 400，且一次取词都不发
      const noToken = await postClaim(base, { trackId: 'track-b', candidate: { ...CLAIM } });
      assert.equal(noToken.status, 400, '认领只认我们签发过的那条候选的令牌');
      assert.match(noToken.body.error, /令牌/);
      const forged = await postClaim(base, { trackId: 'track-b', candidate: { ...CLAIM, claimToken: 'f'.repeat(16) } });
      assert.equal(forged.status, 400, '自己拼一个形状对的 token 不算数');
      assert.equal(calls.claimed, 0, '不合格的请求连"试取一次"都不该发起');
      // ③b 真令牌配假身份 ⇒ 400（一条真令牌不许配另一首歌）
      const swapped = await postClaim(base, { trackId: 'track-b', candidate: { ...CLAIM, sourceId: 'SOMETHING-ELSE', claimToken: token } });
      assert.equal(swapped.status, 400);
      assert.match(swapped.body.error, /对不上/);
      assert.equal(calls.claimed, 0, '字段与令牌对不上时也不该出网');
      // ④ 取不到词 ⇒ 不写，并且说实话
      calls.claimOutcome = { matched: false, reason: '候选《他不懂》没有有效歌词（计时行不足 3 行）' };
      const failed = await postClaim(base, { trackId: 'track-b', candidate: { ...CLAIM, claimToken: token } });
      assert.equal(failed.status, 200);
      assert.equal(failed.body.ok, false);
      assert.equal(failed.body.written, false, '"登记 + 真取到词"两件事都成才算 ok');
      assert.match(failed.body.error, /没有写入任何记录/);
      assert.equal(await claims.get(lyricIdentityFingerprint(bareTrack.query)), null, '没取到词就不该留记录');
      // ⑤ 成功：写记录 + 报告 + 响应体不含正文也不含 accessKey
      calls.claimOutcome = { matched: true, claimed: true, provider: 'qq', format: 'lrc', timedLines: 3, isWordByWord: false, score: 70, text: '[00:01.00]ALPHA-SECRET-LYRIC' };
      const ok = await postClaim(base, { trackId: 'track-b', candidate: { ...CLAIM, claimToken: token } });
      assert.equal(ok.body.ok, true, JSON.stringify(ok.body));
      assert.equal(ok.body.total, 1);
      assert.equal(ok.body.timedLines, 3);
      assert.equal(ok.body.entry, undefined, '响应只报计数与来源，不把自己刚收下的那份再吐回去');
      assert.ok(!JSON.stringify(ok.body).includes('ALPHA-SECRET-LYRIC'), '认领路由的响应里不许有歌词正文');
      assert.equal(JSON.stringify(ok.body).includes('AK-1'), false, '认领回执里也不许有 accessKey');
      const stored = await claims.get(lyricIdentityFingerprint(bareTrack.query));
      assert.equal(stored.sourceId, CLAIM.sourceId);
      assert.equal(stored.accessKey, 'AK-1',
        '磁盘上那一条**必须**留着 accessKey —— 重启之后还要凭它取词；这一格是被有意保留的服务端数据，不是漏出去的敏感值');
      // ⑥ 有记录之后：匹配路由走 fetchClaimed，并把"这是人挑的"说出来
      const before = calls.claimed;
      const answered = await postOnline(base, { trackId: 'track-b' });
      assert.equal(answered.body.matched, true);
      assert.equal(answered.body.claimed, true, '界面要能说出这条是人挑的');
      assert.equal(calls.claimed, before + 1, '有记录时该按身份直接取词');
      assert.ok(answered.body.claim, '认领的那一条要回给界面（面板上要说得出是谁）');
      assert.equal(JSON.stringify(answered.body).includes('AK-1'), false,
        '带认领记录的答复里也不许回显 accessKey（记录在磁盘上有它就够，浏览器不需要）');
      // ⑦ 认领取不到词 ⇒ 回落自动挡，并且把失败那句说出来
      calls.claimOutcome = { matched: false, reason: '上游说这首没有词' };
      store.matchOutcome = { matched: false, reason: '四源都没有可用结果', near: [CLAIM] };
      const fell = await postOnline(base, { trackId: 'track-b', retry: true });
      assert.equal(fell.body.claimFailed, '上游说这首没有词', '不许"因为认领过反而没词"，也不许悄悄换结果而不说');
      assert.ok(Array.isArray(fell.body.near), '回落到自动挡的近候选照常给出');
      // ⑧ 取消认领：零取词
      const cleared = await postClaim(base, { trackId: 'track-b', action: 'clear' });
      assert.equal(cleared.body.removed, true);
      assert.equal(calls.claimed, before + 2, `clear 那一档一次网都不出（实测 ${calls.claimed}）`);
    }, { matcher, claims });
    // ⑨ 本地带时间轴的歌词优先：这种曲目不给认领
    const timed = fakeStore({ enabled: true, tracks: { 'track-a': localTrack } });
    await withServer(timed, async (base) => {
      const res = await postClaim(base, { trackId: 'track-a', candidate: CLAIM });
      assert.equal(res.status, 400, '本地有带时间轴的词时不该让认领插队');
      assert.match(res.body.error, /本地已有带时间轴的歌词/);
    }, { matcher, claims });
  } finally { await rm(dir, { recursive: true, force: true }) }
});

test('R144 路由 · retry 参数只决定绕不绕缓存，且只认布尔值', async () => {
  const store = fakeStore({ enabled: true, tracks: { 'track-b': bareTrack } });
  await withServer(store, async (base) => {
    assert.equal((await postOnline(base, { trackId: 'track-b', retry: 'yes' })).status, 400, '把字符串当真是 ⇒ ?retry=0 也会绕缓存');
    assert.equal(store.calls.force, undefined, '前置条件：还没发过正常请求');
    await postOnline(base, { trackId: 'track-b' });
    await postOnline(base, { trackId: 'track-b', retry: true });
    assert.deepEqual(store.calls.force, [false, true], '重试要一路传到匹配器（断在中间任何一处都表现为"重试没反应"）');
  });
});

test('R144 纪律：认领记录进 R74/R75 扫描面、只经 writeJsonAtomic、零 fetch', async () => {
  const discipline = await readScript('check-music-online-discipline.mjs');
  assert.match(discipline, /'lyric-claims\.mjs'/, '新模块必须进扫描面，否则"它会不会自己写别的地方、会不会裸 fetch"没人判');
  const claims = await readScript('lyric-claims.mjs');
  assert.equal(/(^|[^.\w])fetch\s*\(/m.test(claims), false, '认领记录是纯落盘模块，一次网都不该出');
  assert.match(claims, /writeJsonAtomic\(/, '写盘只有全仓那一个 JSON 原子写出口');
  assert.equal(/(?:^|[^a-zA-Z])(writeFile|appendFile|createWriteStream)\s*\(/.test(claims), false,
    '不许绕过原子写自己开文件（半截 JSON 会被当成"没有记录"）');
});

test('R144 近候选跨源公平：第一家给满 8 条也不许把后面几家饿掉（要的是全局前 8 名）', async () => {
  // QQ 给 8 条 64 分，网易给 1 条 73 分。若收集按"累计到 8 条就停"，73 分那条永远进不来
  // ⇒ 人看到的会是 8 条更差的。这一格就是钉"每家各自限流 + 最后跨源排序截断"。
  const qqMany = Array.from({ length: 8 }, (_, index) => songCandidate({ id: 500 + index, title: 'さよなら夏の日2', album: { name: `专辑${index}` } }));
  const { routes, fetcher } = makeRoutes({ candidates: qqMany });
  const bridge = {
    call: async (path, payload) => (payload.source === 'netease' && payload.action === 'search'
      ? { ok: true, candidates: [{
        name: 'さよなら夏の日', artists: [{ name: '别的' }], album: { name: 'COME ALONG 33' }, durationMs: 267000, sourceId: 'NE-73', accessKey: 'AK-73',
      }] }
      : { ok: false, reason: '这一档不参与本用例' }),
  };
  const matcher = createOnlineLyricMatcher({ fetcher, decrypt: identityDecrypt, bridge });
  const outcome = await matcher.match(LOCAL_SONG);
  assert.equal(outcome.matched, false, '73 分仍然不过线（阈值 75 没动）');
  assert.equal(outcome.near?.length, 8, `实测 ${outcome.near?.length}`);
  assert.equal(outcome.near[0].score, 73, `第一名应该是网易那条 73 分，实测 ${JSON.stringify(outcome.near.slice(0, 2))}`);
  assert.equal(outcome.near[0].provider, 'netease', '跨源排序：后面那家更好的那条不许被前面的满额挤掉');
  assert.equal(outcome.near[0].sourceId, 'NE-73');
  assert.equal(routes.calls.lyric, 0, '近候选只列身份，一次取词都不发');
});

test('R148 令牌注册表：同一条身份同一个 token、有界淘汰、形状不对一律解不出来', async () => {
  const { createClaimTokenRegistry, CLAIM_TOKEN_PATTERN } = await import('./lyric-claims.mjs');
  const reg = createClaimTokenRegistry({ max: 3 });
  const a = reg.issue({ provider: 'qq', sourceId: 'A', accessKey: 'KA' });
  assert.match(String(a), CLAIM_TOKEN_PATTERN, 'token 形状要与路由的把关一致');
  assert.equal(reg.issue({ provider: 'qq', sourceId: 'A', accessKey: 'KA' }), a,
    '同一条身份重复签发必须是同一个 token（否则每刷新一次列表就堆一条，注册表会无界增长）');
  assert.equal(reg.size(), 1);
  const b = reg.issue({ provider: 'kugou', sourceId: 'B', accessKey: '' });
  reg.issue({ provider: 'netease', sourceId: 'C', accessKey: 'KC' });
  const d = reg.issue({ provider: 'qq', sourceId: 'D', accessKey: 'KD' });
  assert.equal(reg.size(), 3, '超过上限要按插入顺序淘汰，不做无界增长');
  assert.equal(reg.resolve(a), null, '最老的那条已被淘汰（此时认领它该如实失败并提示重新重试）');
  assert.equal(reg.resolve(d).sourceId, 'D');
  assert.equal(reg.resolve(b).accessKey, '', '没有 accessKey 的来源（QQ/网易）也要能登记，别记成 undefined');
  assert.equal(reg.resolve('zzzzzzzzzzzzzzzz'), null, '形状不对的字符串不进查表');
  assert.equal(reg.resolve('a'.repeat(20)), null, '长度不对也不行');
  assert.equal(reg.resolve(undefined), null);
  reg.clear();
  assert.equal(reg.size(), 0);
  assert.equal(reg.resolve(d), null, 'clear 之后一个都解不出来');
});
