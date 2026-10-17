// M3-c：在线封面补全的自检（第五期，计划 Task 14 的红线逐条落成断言）。
// 钉住的四件事，按"一旦回退就最没声音"排序：
//   ① **绝不写回音频文件**（补图前后音频字节与 mtime 逐位不变）——这条一旦破，用户丢的是原始资料；
//   ② **只给"既无内嵌又无文件夹封面"的专辑出网**（本地有图永远赢）；
//   ③ **身份闸门**：模糊源只在归一后逐字相等时才收，多张不同图就一条都不要——错配图比没图糟得多；
//   ④ **"查不到"与"没有"分开记**，被白名单拦下不许写成"这张专辑没有封面"。
// 主机表里每个名字的一手实测出处在 online-guard.mjs 的注释与本轮 run log，不在这里重复。
import test from 'node:test';
import { listenAndReady } from './check-ready.mjs';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import { promises as fs } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { COVER_HOSTS, MAX_COVER_BODY_BYTES, ONLINE_COVER_TIMEOUT_MS, guardedCoverFetch } from './online-guard.mjs';
import {
  COVER_SOURCES, createOnlineCoverProvider, detectImageMime, caaIndexUrl, caaItemName, caaImageFileUrl,
  caaFrontFile, itunesSearchUrl, artworkAt600, pickItunesArtwork,
} from './online-covers.mjs';
import { MusicLibraryStore, normalized } from './music-library.mjs';
import { createMusicServer } from './music-server.mjs';
import { auditSnapshot, resetAudit } from './online-audit.mjs';

const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(60, 7)]);
/**
 * PNG 签名整串是 `89 50 4E 47 0D 0A 1A 0A`（`‰` + ASCII `PNG` + `\r\n` + 替换符 + `\n`）。
 * 这里**由 ASCII 的 'PNG' 推出来**，不再手抄十六进制：本仓的判据曾把第四字节写成 `0x44`（'D'），
 * 而旧夹具照同一处错抄了一遍 ⇒ 实现与夹具互相"验证"，所有真实 PNG 一律被判"不是可显示的图"，
 * 自检却一直是绿的（网易封面大量是 PNG，甚至挂在 `.jpg` 名字下）。
 */
const PNG = Buffer.concat([Buffer.from([0x89, ...Buffer.from('PNG'), 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(40, 9)]);
/** 仓库里的一张真 PNG（Vite 图标，由图像工具产出）：夹具与它比对签名，防"两边一起错"。 */
const REAL_PNG = await fs.readFile(new URL('../public/icons/icon-192.png', import.meta.url));
const WEBP = Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WEBPVP8 '), Buffer.alloc(24)]);
const MBID = 'bd31976d-7e0e-4213-99af-52f831ce3d2c';
const RELEASE_ID = '1e45a5f1-7146-4d88-9754-438bbc4aa637';
/**
 * 2026-10-07「CAA 窗口」从 `https://archive.org/cors/mbid-<RELEASE_ID>/index.json` **原样抓回来**的真实响应
 * （COME ALONG 3 / 山下達郎，820 字节）。之前这里只有按 CAA 文档臆造的形状，属性名与 scheme 都是想当然；
 * 真实形状把它换掉：`images` 是**数组**、条目里 `types:["Front"]` 标正面、`image` 是**整条 URL 且 scheme 是 http**、
 * 条目文件在 archive.org 上的真实名字是 `<条目名>-<id>.jpg`。夹具照抄，不再重编。
 */
const CAA_INDEX_REAL = {
  images: [{
    approved: true, back: false, comment: '', edit: 65813169, front: true, id: 24827957096,
    image: `http://coverartarchive.org/release/${RELEASE_ID}/24827957096.jpg`,
    thumbnails: {
      250: `http://coverartarchive.org/release/${RELEASE_ID}/24827957096-250.jpg`,
      500: `http://coverartarchive.org/release/${RELEASE_ID}/24827957096-500.jpg`,
      1200: `http://coverartarchive.org/release/${RELEASE_ID}/24827957096-1200.jpg`,
      large: `http://coverartarchive.org/release/${RELEASE_ID}/24827957096-500.jpg`,
      small: `http://coverartarchive.org/release/${RELEASE_ID}/24827957096-250.jpg`,
    },
    types: ['Front'],
  }],
  release: `https://musicbrainz.org/release/${RELEASE_ID}`,
};
const CAA_REAL_IMAGE_URL = `https://archive.org/cors/mbid-${RELEASE_ID}/mbid-${RELEASE_ID}-24827957096.jpg`;
/** Windows 上 `stat().mode` 认不出 0600（写出来的就是 0666），与 M3-a Task B 同一处环境事实：
 *  POSIX 判实际权限，Windows 判"代码真的传了 mode"，两边都不许写成"保证"。 */
const POSIX = process.platform !== 'win32';
const SCRIPTS = path.dirname(fileURLToPath(import.meta.url));

/** 一台只认"我给它的那两张 URL"的假出网器：任何别的 URL 都是本用例没预期的请求。 */
function fakeFetcher(routes) {
  const calls = [];
  const fetcher = async (url, options = {}) => {
    calls.push({ url: String(url), withBytes: options.withBytes === true });
    const handler = routes[String(url)];
    if (!handler) return { ok: false, status: 404, text: () => '', json: () => ({}) };
    return handler;
  };
  fetcher.calls = calls;
  return fetcher;
}
const jsonRoute = (payload) => ({ ok: true, status: 200, text: () => JSON.stringify(payload), json: () => payload });
const imageRoute = (bytes) => ({ ok: true, status: 200, bytes: () => bytes });

const sha = (buffer) => createHash('sha256').update(buffer).digest('hex');
/** 自动补图那一轮是 `void` 出去的（扫描不许等出网），用例要判结果就得先把它收干。 */
const settle = async (store) => { while (store.coverPromise) await store.coverPromise; };

async function tempDir(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'rhine-covers-test-'));
  t.after(() => fs.rm(dir, { force: true, recursive: true }));
  return dir;
}

/** 三张专辑的曲库：内嵌封面 / 文件夹封面 / 什么都没有（判据正好覆盖 ①②）；`extraBare` 再加无图专辑。 */
async function coverFixture(t, { coverProvider = null, extraBare = 0, options = {} } = {}) {
  delete process.env.MUSICBRAINZ_CONTACT;
  const temporary = await tempDir(t);
  const root = path.join(temporary, 'music');
  await fs.mkdir(root);
  const bareNames = ['什么都没有', ...Array.from({ length: extraBare }, (_unused, index) => `什么都没有-${index + 2}`)];
  for (const name of ['有内嵌', '有文件夹', ...bareNames]) {
    const folder = path.join(root, name);
    await fs.mkdir(folder);
    await fs.writeFile(path.join(folder, 'c.flac'), Buffer.from(`音频字节不许被动到 · ${name}`));
  }
  await fs.writeFile(path.join(root, '有文件夹', 'Cover.png'), PNG);
  const store = await new MusicLibraryStore({
    dataDir: path.join(temporary, 'index'), defaultRoots: [root], coverProvider,
    metadataParser: async (file, parseOptions) => ({
      common: /c\.flac$/.test(file) && path.basename(path.dirname(file)) === '有内嵌' && !parseOptions.skipCovers
        ? { title: '有内嵌', albumartist: '测试艺人', album: '有内嵌', picture: [{ format: 'image/png', type: 'Cover (front)', data: PNG }] }
        : { title: path.basename(file, '.flac'), albumartist: '测试艺人', album: path.basename(path.dirname(file)) },
      format: { duration: 1 },
    }),
    ...options,
  }).init();
  return { temporary, root, store, bareNames };
}

// ── 一、主机表与出网层 ───────────────────────────────────────────────────────

test('COVER_HOSTS 逐字等于实测那三个名字，且不含我们一次都不请求的 coverartarchive.org', () => {
  assert.deepEqual([...COVER_HOSTS.exact].sort(), ['archive.org', 'itunes.apple.com'],
    '封面主机表变了：新增名字必须先是实测拿到的（guardedFetch 会把它拦成 ONLINE_TARGET_REJECTED），不许凭印象加');
  assert.deepEqual([...COVER_HOSTS.suffix], ['.mzstatic.com'], '后缀表只留实测过的这一条：*.qq.com 那种写法等于没有白名单');
  assert.equal(COVER_HOSTS.exact.has('coverartarchive.org'), false,
    'CAA 的站点只做一件事（307 到 archive.org），我们的代码里没有一次请求打它 ⇒ 白名单里不许留没人打的名字');
});

test('封面这一档的出网器：用 COVER_HOSTS、8MiB 档、kind 固定 cover；bytes 字段是显式 opt-in', async () => {
  const original = globalThis.fetch;
  const seen = [];
  globalThis.fetch = async (url, init) => {
    seen.push({ url: String(url), redirect: init.redirect, credentials: init.credentials });
    return new Response(JPEG, { status: 200, headers: { 'content-type': 'image/jpeg' } });
  };
  const lookup = async () => [{ address: '93.184.216.34', family: 4 }];
  try {
    const plain = await guardedCoverFetch('https://itunes.apple.com/cover.png', { lookup });
    assert.deepEqual(Object.keys(plain).sort(), ['json', 'ok', 'status', 'text'],
      '默认返回形状不含 bytes（老调用点的形状逐字不变，与 withSetCookie 同一惯例）');
    const opened = await guardedCoverFetch('https://itunes.apple.com/cover.png', { lookup, withBytes: true });
    assert.deepEqual(Object.keys(opened).sort(), ['bytes', 'json', 'ok', 'status', 'text']);
    assert.deepEqual(Buffer.from(opened.bytes()), JPEG, 'bytes() 给的是过了体积闸的那一份，不是第三条读法');
    assert.equal(seen.every((call) => call.redirect === 'error'), true, '封面侧同样禁重定向：3xx 会旁路主机校验');
    assert.equal(seen.every((call) => call.credentials === 'omit'), true, '取图不带凭据');
    // 表外的主机必须被自己的白名单拦下（不是靠上游 404）。
    await assert.rejects(() => guardedCoverFetch('https://example.com/a.jpg', { lookup }), /ONLINE_TARGET_REJECTED/);
    // `lookup` 注入口必须真的转发到 guardedFetch：漏转发过一次的代价是自检看着离线、其实偷偷打真 DNS，
    // 环境一变（fake-IP 代理把域名都解析到 198.18.0.0/15）用例就会红，而红的原因与产品无关。
    // 下面这条同时钉住两件事：注入的 lookup 被采用（不是真 DNS），且 198.18.0.0/15 这类保留段按设计被拒。
    await assert.rejects(
      () => guardedCoverFetch('https://itunes.apple.com/a.jpg', { lookup: async () => [{ address: '198.18.0.22', family: 4 }] }),
      /受限地址 198\.18\.0\.22/, '注入的 lookup 没被采用 ⇒ 自检不是离线的；这条也是"fake-IP 代理会被地址判据拦下"的判据');
  } finally {
    globalThis.fetch = original;
    resetAudit();
  }
  assert.equal(MAX_COVER_BODY_BYTES, 16 * 1024 * 1024, '体积档 16 MiB（2026-10-09 上调：真实 PNG 修好后网易一张 10.1MB PNG 被 8 MiB 拒掉）；仍严于内嵌封面那一路的 30MB');
  assert.ok(ONLINE_COVER_TIMEOUT_MS >= 10000, '超时档要容纳 CAA 侧的实测量级（index.json 1.1~1.7s、图 1.7~2.0s），也仍是不干等的档');
});

test('审计认得封面这一档：一笔成功与一笔被拦下都留行，且不含 URL 路径', async () => {
  const original = globalThis.fetch;
  resetAudit();
  globalThis.fetch = async () => new Response(JPEG, { status: 200 });
  const lookup = async () => [{ address: '93.184.216.34', family: 4 }];
  try {
    await guardedCoverFetch('https://itunes.apple.com/search?term=%E9%BB%91%E9%A9%AC&entity=album', { lookup });
    await guardedCoverFetch('https://evil.example/x.jpg', { lookup }).catch(() => {});
  } finally {
    globalThis.fetch = original;
  }
  const [blocked, ok] = auditSnapshot().items;   // 面板那份快照是"最新的排前面"，这里按同一顺序取
  assert.equal(ok.kind, 'cover'); assert.equal(ok.host, 'itunes.apple.com'); assert.equal(ok.via, 'guard'); assert.equal(ok.status, 200);
  assert.equal(blocked.kind, 'cover'); assert.equal(blocked.status, 0, '被我们自己的白名单拦下 ⇒ status 0，面板上写成"已拦下（未出网）"');
  assert.equal(auditSnapshot().totals.requests, 2);
  const dumped = JSON.stringify(auditSnapshot().items);
  for (const leak of ['/search', 'term=', 'evil.example/x.jpg']) assert.equal(dumped.includes(leak), false, `审计里不该出现${leak}`);
  resetAudit();
});

// ── 二、图片形状与 CAA 的身份 ────────────────────────────────────────────────

test('认魔数不认上游嘴：200 但返回 HTML/空字节不算封面', () => {
  assert.equal(detectImageMime(JPEG), 'image/jpeg');
  assert.equal(detectImageMime(PNG), 'image/png');
  assert.equal(detectImageMime(REAL_PNG), 'image/png',
    '仓库里那张真 PNG 必须判成图——这一条就是当年"没封面比登记的多"的根因，旧夹具照错的常量抄所以从没咬到');
  assert.equal(detectImageMime(Buffer.concat([REAL_PNG.subarray(0, 12), Buffer.from('fake')])), 'image/png',
    '网易的常见形状：文件名与 content-type 都写 .jpg、字节是 PNG ⇒ 判据只看前 12 字节');
  assert.equal(detectImageMime(WEBP), 'image/webp');
  assert.equal(detectImageMime(Buffer.from('<!doctype html><html>404</html>')), null, '错误页不能因为"HTTP 200"就被当成图');
  assert.equal(detectImageMime(Buffer.alloc(0)), null);
  assert.equal(detectImageMime(null), null);
});

test('PNG 签名三方一致：夹具由 ASCII 推出、真图从磁盘读、实现认这一串', () => {
  // 标准串：`‰PNG\r\n\x1a\n`。三方交叉对，任何一边漂了都红（当年是"实现 + 夹具"一起错，
  // 因为两边都是手抄的十六进制——所以这里刻意让夹具由 'PNG' 三个字推出来）。
  assert.deepEqual([...PNG.subarray(0, 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  assert.equal(REAL_PNG.subarray(1, 4).toString('latin1'), 'PNG', '真图第 2~4 字节就是 ASCII 的 PNG');
  assert.equal(REAL_PNG[3], 0x47, "第四字节是 'G'（0x47）——当年写成 0x44（'D'）的那一格");
  assert.equal(detectImageMime(REAL_PNG), 'image/png');
  // 判据要的是**整串 8 字节签名**，不是"看见 ‰PNG 就收"：控制字符那三行也是签名的一部分。
  // 少了这一条，"只查前四个 ASCII 字节"这种放宽（变异 Z2）在离线里没人拦。
  assert.equal(detectImageMime(Buffer.concat([Buffer.from([0x89, ...Buffer.from('PNG'), 0x00, 0x00, 0x00, 0x00]), Buffer.alloc(24)])),
    null, '‰PNG 后面不是 \\r\\n\\x1a\\n 就不是 PNG（挡掉"名字像 PNG 的任意东西"）');
  assert.equal(detectImageMime(Buffer.concat([Buffer.from([0x89, ...Buffer.from('png'), 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(24)])),
    null, '签名大小写敏感：ASCII 必须是大写 PNG');
});

test('CAA 的两个 URL 都只能由我们校验过的 MBID 拼出来，且只打不重定向的 /cors/ 那条', () => {
  assert.equal(caaIndexUrl(RELEASE_ID), `https://archive.org/cors/mbid-${RELEASE_ID}/index.json`);
  assert.equal(caaIndexUrl(MBID), `https://archive.org/cors/mbid-${MBID}/index.json`);
  // 走过的弯路钉在这里（CAA 窗口实测）：`archive.org/download/` 与 `/serve/` 都 **302 到动态数据节点**
  // （`dn<数字>.ca.archive.org`），`redirect:'error'` 会把它判成失败；只有 `/cors/` 是直接 200。
  // ⇒ 回退到那两条任何一个都算回退，而"跟一跳"是不允许的（3xx 会旁路主机校验）。
  for (const url of [caaIndexUrl(RELEASE_ID), caaImageFileUrl(RELEASE_ID, CAA_REAL_IMAGE_URL)]) {
    assert.match(url, /^https:\/\/archive\.org\/cors\//, `CAA 只准走 /cors/ 这条不重定向的路：${url}`);
    assert.equal(url.includes('/download/'), false, 'archive.org/download/ 会 302 到节点，不许再回到那条路');
    assert.equal(url.includes('coverartarchive.org'), false, '我们一次都不请求 coverartarchive.org（由 releaseId 自己拼）');
  }
  for (const bad of [undefined, '', 'not-an-mbid', `${RELEASE_ID}/../../etc`, '1e45a5f1-7146-4d88-9754-438bbc4aa63;']) {
    assert.equal(caaIndexUrl(bad), null, `非法 MBID 必须算"这张没得补"（${bad}），不是抛也不是拼出一条野 URL`);
    assert.equal(caaItemName(bad), null);
  }
  // 文件名来自上游 JSON，而它会被拼进下一条出网 URL ⇒ 这一格是注入面，不是洁癖。
  assert.equal(caaImageFileUrl(RELEASE_ID, `http://coverartarchive.org/release/${RELEASE_ID}/24827957096.jpg`),
    `https://archive.org/cors/mbid-${RELEASE_ID}/mbid-${RELEASE_ID}-24827957096.jpg`);
  // 不论上游给什么，结果要么是 null，要么**只能**是这一条形状的 URL：
  // 前缀钉死在本条目目录内，末段只准 [A-Za-z0-9._-]（`?`/`#`/`/`/`\`/空格/百分号/控制字符一个都不许出现，
  // 否则上游就能靠一个字段改掉这条请求的语义）。这条形状闸是"上游字段会被拼进下一条 URL"的落点。
  const safe = new RegExp(`^https://archive\\.org/cors/mbid-${RELEASE_ID}/mbid-${RELEASE_ID}-[A-Za-z0-9._-]+$`);
  for (const hostile of ['../index.json', 'a/../../b.jpg', '..\\..\\b.jpg', '', 'a b.jpg', 'q?x=1.jpg',
    '%2e%2e/x.jpg', 'http://evil.example/x.jpg', '/etc/passwd', 'x'.repeat(300) + '.jpg']) {
    const url = caaImageFileUrl(RELEASE_ID, hostile);
    assert.ok(url === null || safe.test(url),
      `上游给这种输入必须要么拒、要么只能产出本条目目录内的合法 URL：${JSON.stringify(hostile)} -> ${url}`);
  }
  assert.equal(caaImageFileUrl(RELEASE_ID, 'q?x=1.jpg'), null, '带查询串的一律拒（实测形状里没有查询串）');
  assert.equal(caaImageFileUrl(RELEASE_ID, '..\\..\\b.jpg'), null, '反斜杠不许过：它不是合法文件名的一部分');
});

test('CAA 的 index.json：真实形状逐字回读；没标 Front 不回退到第一张', () => {
  assert.deepEqual(caaFrontFile(CAA_INDEX_REAL), {
    image: `http://coverartarchive.org/release/${RELEASE_ID}/24827957096.jpg`,
    imageId: '24827957096',
    comment: '',
  }, '真实 index.json 的条目：image 是整条 URL（scheme 实测是 http）、id 是数字——夹具与断言都按这一手量到的形状写');
  const back = { images: [{ types: ['Back'], image: 'x_back.jpg' }, { types: ['Front'], image: 'x_front.jpg' }] };
  assert.deepEqual(caaFrontFile(back), { image: 'x_front.jpg', imageId: '', comment: '' });
  const keyed = { images: { 0: { types: ['Medium'], image: 'm.jpg' }, 1: { types: ['Front'], image: 'f.jpg', comment: 'front' } } };
  assert.deepEqual(caaFrontFile(keyed), { image: 'f.jpg', imageId: '', comment: 'front' }, '以序号为键的对象形状也认（上游两份文档不一致）');
  assert.equal(caaFrontFile({ images: [{ front: true, types: [], image: 'no_type.jpg' }] }), null,
    '判据是 types 里的 Front（实测 front 布尔与 types 一致）；只给布尔而 types 没有的一律不认——宁可无图不错配');
  assert.equal(caaFrontFile({ images: [{ types: ['Back'], image: 'only_back.jpg' }] }), null, '背面图当封面用就是错配，宁缺');
  assert.equal(caaFrontFile({}), null);
  assert.equal(caaFrontFile({ images: [] }), null);
});

// ── 三、iTunes 的身份闸门 ────────────────────────────────────────────────────

test('iTunes 检索 URL 的构成：term 是"艺人 专辑"，entity=album，limit 有上限', () => {
  const url = new URL(itunesSearchUrl({ title: 'Lovers - Single', artist: 'Li Ronghao' }));
  assert.equal(url.origin + url.pathname, 'https://itunes.apple.com/search');
  assert.equal(url.searchParams.get('entity'), 'album', '不加 entity=album 会返回单曲里的音轨条目（今晚实测）');
  assert.equal(url.searchParams.get('term'), 'Li Ronghao Lovers - Single');
  assert.equal(Number(url.searchParams.get('limit')) <= 200, true, 'limit 不许没有上限');
});

test('归一沿用曲库那一份（两处口径迟早会漂），600x600 改写只动尺寸段', () => {
  assert.equal(normalized('  Come Along 3. '), normalized('COME ALONG 3'), '自检要用的是被测代码同一份归一');
  assert.equal(artworkAt600('https://is1-ssl.mzstatic.com/image/thumb/Music124/v4/71/26/d8/x.jpg/100x100bb.jpg'),
    'https://is1-ssl.mzstatic.com/image/thumb/Music124/v4/71/26/d8/x.jpg/600x600bb.jpg');
  assert.equal(artworkAt600('https://is1-ssl.mzstatic.com/other/600x600bb.jpg'), 'https://is1-ssl.mzstatic.com/other/600x600bb.jpg',
    '路径里没有尺寸段时不许乱改');
  assert.equal(artworkAt600(''), '');
});

test('iTunes 闸门：逐字相等才收，翻译名/别名一律不要（今晚实测的两类"补不到"都在这条上）', () => {
  const hit = (collectionName, artistName, artwork, releaseDate) => ({ collectionName, artistName, artworkUrl100: artwork, releaseDate });
  const art = (n) => `https://is1-ssl.mzstatic.com/a/${n}/100x100bb.jpg`;
  // 正例：归一后逐字相等（大小写与空格标点由 normalized 吃掉）
  const ok = pickItunesArtwork({ results: [hit('Lovers - Single', 'Li Ronghao', art('one'), '2024-06-28T07:00:00Z')] },
    { title: 'Lovers - Single', artist: 'Li Ronghao' });
  assert.equal(ok.url, 'https://is1-ssl.mzstatic.com/a/one/600x600bb.jpg');
  assert.equal(ok.matchedTitle, 'Lovers - Single');
  // 实测的反例①：`黑马` 在 iTunes 叫 "The Dark Horse" ⇒ 翻译名不算同一张专辑
  const translated = pickItunesArtwork({ results: [hit('The Dark Horse', 'Li Ronghao', art('dark'), '2024-10-18')] },
    { title: '黑马', artist: 'Li Ronghao' });
  assert.equal(translated.url, null);
  assert.match(translated.reason, /逐字不一致/);
  // 实测的反例②：同名但艺人对不上
  const wrongArtist = pickItunesArtwork({ results: [hit('有理想', '张三', art('x'), '')] }, { title: '有理想', artist: '李荣浩' });
  assert.equal(wrongArtist.url, null);
  assert.match(wrongArtist.reason, /艺人对不上/);
  // 多张不同的图 = 分不清哪张属于手上这一版 ⇒ 整条放弃
  const ambiguous = pickItunesArtwork({ results: [hit('同名', '艺人', art('one'), '2020'), hit('同名', '艺人', art('two'), '2021')] },
    { title: '同名', artist: '艺人' });
  assert.equal(ambiguous.url, null);
  assert.match(ambiguous.reason, /无法确定哪张/);
  // 年份能把两张消歧成一张（同一张精选与原版最能撞在这里）
  const byYear = pickItunesArtwork({ results: [hit('同名', '艺人', art('one'), '2020-01-01'), hit('同名', '艺人', art('two'), '2021-01-01')] },
    { title: '同名', artist: '艺人', year: 2021 });
  assert.equal(byYear.url, 'https://is1-ssl.mzstatic.com/a/two/600x600bb.jpg');
  // 空专辑名不许"匹配上一切"
  assert.equal(pickItunesArtwork({ results: [hit('随便', '随便', art('one'), '')] }, { title: '  ', artist: '随便' }).url, null);
  assert.equal(pickItunesArtwork({ results: [] }, { title: 'a', artist: 'b' }).url, null);
});

// ── 四、提供者的编排：顺序、失败隔离、错误与"没有"分开 ──────────────────────

test('CAA 命中就不再问 iTunes（少一次出网），attempts 只留问过的那些', async () => {
  const indexUrl = caaIndexUrl(RELEASE_ID);
  const imageUrl = caaImageFileUrl(RELEASE_ID, CAA_INDEX_REAL.images[0].image);
  assert.equal(imageUrl, CAA_REAL_IMAGE_URL, '真实 index.json 里的那一条 image 就该拼出这个 /cors/ 地址');
  const fetcher = fakeFetcher({ [indexUrl]: jsonRoute(CAA_INDEX_REAL), [imageUrl]: imageRoute(JPEG) });
  const provider = createOnlineCoverProvider({ fetcher });
  const outcome = await provider.lookup({ title: 'COME ALONG 3', artist: '山下達郎', releaseId: RELEASE_ID });
  assert.equal(outcome.status, 'matched');
  assert.equal(outcome.source, 'caa');
  assert.deepEqual(Buffer.from(outcome.bytes), JPEG);
  assert.equal(outcome.mime, 'image/jpeg');
  assert.deepEqual(outcome.evidence, { releaseId: RELEASE_ID, imageId: '24827957096' },
    'evidence 进索引与面板：留 releaseId 与 image id，不留整条 URL（scheme 还会在 http/https 之间变）');
  assert.equal(fetcher.calls.length, 2, '命中之后不许再问第二个源');
  assert.deepEqual(fetcher.calls.map((call) => call.withBytes), [false, true], '只有取图那一次要 bytes');
});

test('CAA 404 之后仍会问 iTunes 并成功；两源都没有 ⇒ not-found，不是 error', async () => {
  const itunesUrl = itunesSearchUrl({ title: 'Lovers - Single', artist: 'Li Ronghao' });
  const imageUrl = artworkAt600('https://is1-ssl.mzstatic.com/a/one/100x100bb.jpg');
  const fetcher = fakeFetcher({
    [itunesUrl]: jsonRoute({ results: [{ collectionName: 'Lovers - Single', artistName: 'Li Ronghao', artworkUrl100: 'https://is1-ssl.mzstatic.com/a/one/100x100bb.jpg' }] }),
    [imageUrl]: imageRoute(JPEG),
  });
  const provider = createOnlineCoverProvider({ fetcher });
  const outcome = await provider.lookup({ title: 'Lovers - Single', artist: 'Li Ronghao', releaseId: RELEASE_ID });
  assert.equal(outcome.source, 'itunes', 'CAA 那一条 404 不许把整张专辑打死');
  assert.equal(outcome.attempts.length, 1);
  assert.match(outcome.attempts[0], /caa：Cover Art Archive 索引 HTTP 404/);
  resetAudit();
});

test('两源都没有 ⇒ not-found；出网抛错 ⇒ error 且原因原样保留（被拦下不许写成"没有封面"）', async () => {
  const album = { title: '什么都没有', artist: '测试艺人', releaseId: RELEASE_ID };
  const empty = createOnlineCoverProvider({
    fetcher: fakeFetcher({
      [caaIndexUrl(RELEASE_ID)]: jsonRoute({ images: [] }),
      [itunesSearchUrl(album)]: jsonRoute({ results: [] }),
    }),
  });
  const miss = await empty.lookup(album);
  assert.equal(miss.status, 'not-found');
  assert.equal(miss.attempts.length, 2, 'CAA 没有 Front、iTunes 空结果，两句都要留下来才读得出"问过谁"');

  const { OnlineTargetError } = await import('./online-guard.mjs');
  const throwing = createOnlineCoverProvider({ fetcher: async (url) => { if (String(url).includes('itunes')) throw new OnlineTargetError('主机不在本次用途的在线白名单：itunes.apple.com'); throw new Error('DNS 解析失败'); } });
  const failed = await throwing.lookup({ title: 'x', artist: 'y' });
  assert.equal(failed.status, 'error');
  assert.match(failed.attempts.join(' '), /ONLINE_TARGET_REJECTED|主机不在本次用途的在线白名单/);
  assert.equal(failed.reason, undefined, '被拦下不是 not-found，不许把两件事写成同一句');
});

test('来源顺序与可裁剪：COVER_SOURCES 是 caa 在前，指定 sources 时只问那一个', async () => {
  assert.deepEqual(COVER_SOURCES, ['caa', 'itunes']);
  const fetcher = fakeFetcher({});
  const provider = createOnlineCoverProvider({ fetcher, sources: ['itunes'] });
  await provider.lookup({ title: 'a', artist: 'b', releaseId: RELEASE_ID });
  assert.equal(fetcher.calls.length, 1, '裁掉 caa 之后不许还去拼 archive.org 的 URL');
  assert.match(fetcher.calls[0].url, /^https:\/\/itunes\.apple\.com\/search/);
});

// ── 五、曲库这一侧：判据、落盘、红线 ─────────────────────────────────────────

test('只给"既无内嵌又无文件夹封面"的专辑出网（本地有图永远赢）', async (t) => {
  const asked = [];
  const coverProvider = { lookup: async (album) => { asked.push(album.title); return { status: 'not-found', reason: '夹具说没有' }; } };
  const { store } = await coverFixture(t, { coverProvider });
  await store.scan(); await settle(store);
  assert.deepEqual(asked.sort(), ['什么都没有'], `补图问到了不该问的专辑：${asked.join('/')}`);
  const albums = store.snapshot().albums;
  const byTitle = (title) => albums.find((album) => album.title === title);
  assert.ok(byTitle('有内嵌').coverUrl, '内嵌封面本来就有图：这条断言不是"补图给了它"，而是别把判据写反');
  assert.ok(byTitle('有文件夹').coverUrl, '同目录封面同理');
  assert.equal(byTitle('什么都没有').coverUrl, undefined, 'not-found 之后仍是无图态，前端据此画渐变占位');
  const lookup = albums.find((album) => album.title === '什么都没有').coverLookup;
  assert.equal(lookup.status, 'not-found');
  assert.match(lookup.reason, /夹具说没有/);
});

test('红线：补图前后音频文件的字节与 mtime 逐位不变，图片只落 dataDir/artwork', async (t) => {
  const { root, store } = await coverFixture(t, {
    coverProvider: { lookup: async () => ({ status: 'matched', source: 'itunes', bytes: JPEG, mime: 'image/jpeg', evidence: { matchedTitle: '什么都没有' } }) },
  });
  await store.scan(); await settle(store);
  const audio = path.join(root, '什么都没有', 'c.flac');
  const before = { sha: sha(await fs.readFile(audio)), mtimeMs: (await fs.stat(audio)).mtimeMs, size: (await fs.stat(audio)).size };
  const albumId = store.snapshot().albums.find((album) => album.title === '什么都没有').id;
  await store.backfillCovers({ albumIds: [albumId], force: true });
  const after = { sha: sha(await fs.readFile(audio)), mtimeMs: (await fs.stat(audio)).mtimeMs, size: (await fs.stat(audio)).size };
  assert.deepEqual(after, before, '音频文件的哈希与 mtime 必须逐位不变——补的是显示用的缓存，不是改用户的文件');
  const descriptor = store.artworkFile(albumId);
  assert.equal(descriptor.allowedRoot, store.dataDir, '在线补来的图允许根是 dataDir（与内嵌同一份缓存），不是专辑目录');
  assert.equal(path.dirname(descriptor.path), path.join(store.dataDir, 'artwork'));
  assert.equal(descriptor.path.endsWith('.jpg'), true, '扩展名由魔数决定，不由上游的 content-type 决定');
  assert.deepEqual(Buffer.from(await fs.readFile(descriptor.path)), JPEG);
  assert.equal(sha(await fs.readFile(descriptor.path)), sha(JPEG), '内容寻址：文件名就是内容的哈希');
  const mode = (await fs.stat(descriptor.path)).mode & 0o777;
  if (POSIX) {
    assert.equal(mode, 0o600, `缓存文件权限应为 0600，实测 ${mode.toString(8)}`);
  } else {
    const library = await fs.readFile(path.join(SCRIPTS, 'music-library.mjs'), 'utf8');
    assert.match(library, /writeFile\(target, data, \{ mode: 0o600 \}\)/, 'Windows 上 stat 判不出权限，这里判"写入确实传了 mode"');
    assert.equal(0o666 & ~mode, 0, `Windows 上至少不许多出别人可写之外的位，实测 ${mode.toString(8)}`);
  }
  assert.deepEqual(await fs.readdir(path.join(root, '什么都没有')), ['c.flac'], '专辑目录里不许多出任何文件——补的是本机缓存，不是给用户"整理曲库"');
});

test('同一份字节不重复写：第二次补图命中同一个缓存文件，mtime 不变', async (t) => {
  const { store } = await coverFixture(t, {
    coverProvider: { lookup: async () => ({ status: 'matched', source: 'caa', bytes: PNG, mime: 'image/png', evidence: {} }) },
  });
  await store.scan(); await settle(store);
  const albumId = store.snapshot().albums.find((album) => album.title === '什么都没有').id;
  await store.backfillCovers({ albumIds: [albumId], force: true });
  const file = store.artworkFile(albumId).path;
  const first = await fs.stat(file);
  await store.backfillCovers({ albumIds: [albumId], force: true });
  const second = await fs.stat(file);
  assert.equal(second.mtimeMs, first.mtimeMs, '内容寻址的缓存不覆盖已有文件');
  assert.equal(store.artworkFile(albumId).path, file);
});

test('重扫不丢在线补来的封面；文件夹封面出现时本地赢', async (t) => {
  const { root, store } = await coverFixture(t, {
    coverProvider: { lookup: async () => ({ status: 'matched', source: 'itunes', bytes: JPEG, mime: 'image/jpeg' }) },
  });
  await store.scan(); await settle(store);
  const albumId = store.snapshot().albums.find((album) => album.title === '什么都没有').id;
  await store.backfillCovers({ albumIds: [albumId], force: true });
  const onlinePath = store.artworkFile(albumId).path;
  await store.scan(); await settle(store);
  assert.equal(store.artworkFile(albumId).path, onlinePath, '在线封面不是从文件推出来的：重扫必须带过来，否则每扫一遍就打回无图');
  const folder = path.join(root, '什么都没有');
  await fs.writeFile(path.join(folder, 'Cover.png'), PNG);
  await store.scan(); await settle(store);
  const after = store.artworkFile(albumId);
  assert.equal(after.path, path.join(folder, 'Cover.png'), '用户自己放了封面 ⇒ 本地赢，且不删那份在线缓存之外的东西');
  assert.equal(after.online, undefined);
  await fs.unlink(path.join(folder, 'Cover.png'));
  await store.scan(); await settle(store);
  assert.equal(store.artworkFile(albumId).path, onlinePath, '用户删掉文件夹封面后，之前补的那张仍算数（不必再出一次网）');
});

test('缓存文件被清掉后不再指向空洞：重扫当场丢掉这条 _cover', async (t) => {
  const { store } = await coverFixture(t, {
    coverProvider: { lookup: async () => ({ status: 'matched', source: 'itunes', bytes: JPEG, mime: 'image/jpeg' }) },
  });
  await store.scan(); await settle(store);
  const albumId = store.snapshot().albums.find((album) => album.title === '什么都没有').id;
  await store.backfillCovers({ albumIds: [albumId], force: true });
  await fs.unlink(store.artworkFile(albumId).path);
  await store.scan(); await settle(store);
  assert.equal(store.artworkFile(albumId), null, '指向不存在的文件的 coverUrl 会打出一张 404 的图，宁可不给');
});

test('不重试风暴：连续 3 次访问失败就停在这一轮，"上游真没图"与"补到了"都不算连续失败', async (t) => {
  const { store, bareNames } = await coverFixture(t, { extraBare: 4 });
  await store.scan(); await settle(store);
  assert.equal(bareNames.length, 5, '夹具该给出五张无图专辑，否则"熔断"与"成功清零"这两眼判不出来');

  let calls = 0;
  store.coverProvider = { lookup: async () => { calls += 1; return { status: 'error', error: 'DNS 解析失败' }; } };
  const stopped = await store.backfillCovers({ force: true });
  assert.equal(calls, 3, '连续失败到第三次就该停在这一轮，剩下那张不许继续打上游');
  assert.equal(stopped.covers.failed, 3);
  assert.match(stopped.covers.error, /连续 3 次访问失败/);
  const errored = stopped.albums.filter((album) => album.coverLookup?.status === 'error').length;
  assert.equal(errored, 3, '停住之前问过的三张要各自留下可读状态，不许整轮只有一个总错误');

  calls = 0;
  store.coverProvider = { lookup: async () => { calls += 1; return { status: 'not-found', reason: 'iTunes 没有返回这张专辑的条目' }; } };
  const roundStartedAt = Date.now();
  const none = await store.backfillCovers({ force: true });
  const elapsed = Date.now() - roundStartedAt;
  assert.equal(calls, 5, '五张都"确实没有"也要一张张记完 —— 上游没图不是访问失败，不许触发熔断');
  assert.equal(none.covers.notFound, 5);
  assert.equal(none.covers.error, undefined);
  // 默认打开意味着每台机器启动后都会自己走一遍曲库：五张之间至少让出四拍，
  // 这条判的是"串行 + 让拍"这个行为本身，不是某个精确毫秒数。
  assert.ok(elapsed >= 3500, `一轮五张只用了 ${elapsed}ms，说明逐张之间的让拍没了（会变成对上游连发）`);

  calls = 0;
  // 五张：错、错、成、错、错 —— 只有"成功会把连续失败清零"成立时才跑得完五张。
  // （四张跑不出这一眼：第四张失败时循环本来就结束了，判据与不设判据同形。）
  const order = ['error', 'error', 'matched', 'error', 'error'];
  store.coverProvider = {
    lookup: async () => {
      const kind = order[calls]; calls += 1;
      if (kind === 'matched') return { status: 'matched', source: 'itunes', bytes: JPEG, mime: 'image/jpeg' };
      return { status: 'error', error: '超时' };
    },
  };
  const mixed = await store.backfillCovers({ force: true });
  assert.equal(calls, 5, '中间补成功一次就该把连续失败清零，不许在第 3 次失败处提前停');
  assert.equal(mixed.covers.matched, 1);
  // 只数无图那一组：另外两张专辑本来就有本地封面，混进来判就没判了。
  const bare = mixed.albums.filter((album) => bareNames.includes(album.title));
  assert.equal(bare.filter((album) => album.coverUrl).length, 1, '五张无图专辑里只有 provider 补成功的那一张该有图');
  assert.equal(bare.filter((album) => album.coverLookup?.status === 'error').length, 4);
});

test('结论有保质期：7 天内问过就不再出网，force 才重问', async (t) => {
  const { store } = await coverFixture(t, {});
  await store.scan(); await settle(store);
  const album = store.index.albums.find((entry) => entry.title === '什么都没有');
  let calls = 0;
  store.coverProvider = { lookup: async () => { calls += 1; return { status: 'not-found', reason: '没有' }; } };
  await store.backfillCovers();
  assert.equal(calls, 1);
  await store.backfillCovers();
  assert.equal(calls, 1, '同一张专辑上次已经有结论，不该每轮扫描都再问一次');
  album.coverLookup.checkedAt = new Date(Date.now() - 8 * 86400_000).toISOString();
  await store.backfillCovers();
  assert.equal(calls, 2, '过了 7 天该再问一次（上游会补录封面）');
  store.index.albums.forEach((entry) => { entry.coverLookup = { status: 'not-found', checkedAt: new Date().toISOString() }; });
  await store.backfillCovers({ albumIds: [album.id], force: true });
  assert.equal(calls, 3, '手动触发（force）必须真重问，否则"重扫后仍没图"没有出口');
});

test('扫描后排一轮自动补图，且 covers 开关关掉时一次都不问', async (t) => {
  const { store } = await coverFixture(t, {});
  let calls = 0;
  store.coverProvider = { lookup: async () => { calls += 1; return { status: 'matched', source: 'itunes', bytes: WEBP, mime: 'image/webp' }; } };
  await store.scan(); await settle(store);
  assert.equal(calls, 1, '默认打开时，启动扫描后就该自己补一轮（用户不必点任何按钮）');
  assert.equal(store.artworkFile(store.index.albums.find((entry) => entry.title === '什么都没有').id).path.endsWith('.webp'), true);
  await store.updateConfig({ online: { lyrics: true, search: true, streaming: true, covers: false } });
  calls = 0;
  await store.scan(); await settle(store);
  assert.equal(calls, 0, '第四张子开关关掉 ⇒ 这一类请求归零，这才是"能一键关掉"');
  await store.updateConfig({ onlineEnabled: false, online: { lyrics: true, search: true, streaming: true, covers: true } });
  calls = 0;
  await store.scan(); await settle(store);
  assert.equal(calls, 0, '总开关 onlineEnabled 关掉同样一次不问');
});

// ── 六、路由 ────────────────────────────────────────────────────────────────

async function routeServer(t, { store, distDir }) {
  const { server } = await createMusicServer({ store, distDir, autoScan: false });
  t.after(() => { server.closeAllConnections(); return new Promise((resolve) => server.close(resolve)); });
  // R190：`listen` 之后直接 fetch 在 Windows 回环端口回收时会偶发 `fetch failed`（整跑里真出现过）
  // ⇒ 起服务之后先探一次连接，只重试"连不上"、断言照常红。见 check-ready.mjs 头注。
  // R211（B 类）：换成 listenAndReady（连不上就把这台关掉、换个端口重听）；关闭钩子本来就排在探测之前。
  const { origin } = await listenAndReady(server);
  return origin;
}

test('POST /api/online/cover/backfill：开关关 404、方法错 405、参数错 400、没装配 503、正常 202', async (t) => {
  const temporary = await tempDir(t);
  const distDir = path.join(temporary, 'dist');
  await fs.mkdir(distDir);
  await fs.writeFile(path.join(distDir, 'index.html'), '<h1>fixture</h1>');
  const { store } = await coverFixture(t, {});
  await store.scan(); await settle(store);
  store.coverProvider = null;
  let origin = await routeServer(t, { store, distDir });
  let response = await fetch(`${origin}/api/online/cover/backfill`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
  assert.equal(response.status, 503, '没装配来源要说清楚，而不是留一个永远跑不完的轮');
  assert.match((await response.json()).error, /未装配封面来源/);

  store.coverProvider = { lookup: async () => ({ status: 'not-found', reason: '夹具' }) };
  response = await fetch(`${origin}/api/online/cover/backfill`, { method: 'GET' });
  assert.equal(response.status, 405, 'GET 不该触发一轮出网');
  response = await fetch(`${origin}/api/online/cover/backfill`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ albumIds: 'x' }) });
  assert.equal(response.status, 400);
  response = await fetch(`${origin}/api/online/cover/backfill`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ force: 'yes' }) });
  assert.equal(response.status, 400, 'force 必须是布尔值');
  response = await fetch(`${origin}/api/online/cover/backfill`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
  assert.equal(response.status, 202);
  const snapshot = await response.json();
  assert.equal(snapshot.covers.running, true, '面板读的是同一份 covers 状态（不是第二处真源）');
  await store.coverPromise;

  await store.updateConfig({ online: { lyrics: true, search: true, streaming: true, covers: false } });
  response = await fetch(`${origin}/api/online/cover/backfill`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
  assert.equal(response.status, 404, '关掉之后这一档不再受理');
  assert.match((await response.json()).error, /在线封面补全已关闭/);

  // 补来的图能被既有 `/api/artwork/<id>` 直接服务：前端不必认识任何新 URL。
  await store.updateConfig({ online: { lyrics: true, search: true, streaming: true, covers: true } });
  const id = store.index.albums.find((entry) => entry.title === '什么都没有').id;
  store.coverProvider = { lookup: async () => ({ status: 'matched', source: 'itunes', bytes: JPEG, mime: 'image/jpeg' }) };
  await store.backfillCovers({ albumIds: [id], force: true });
  const served = await fetch(`${origin}/api/artwork/${id}`);
  assert.equal(served.status, 200);
  assert.equal(served.headers.get('content-type'), 'image/jpeg');
  assert.deepEqual(Buffer.from(await served.arrayBuffer()), JPEG);
  // 越界防护仍在：拿别的专辑的 id 取不到这张的缓存（serveFile 的 allowedRoot 判据没被绕过）。
  const other = store.index.albums.find((entry) => entry.title === '有文件夹').id;
  assert.notDeepEqual(Buffer.from(await (await fetch(`${origin}/api/artwork/${other}`)).arrayBuffer()), JPEG);
});

test('R106：判定要留在服务日志里，"上游 200 但没落文件"必须读得出原因', async () => {
  const library = await fs.readFile(path.join(SCRIPTS, 'music-library.mjs'), 'utf8');
  // 三种结论各一行 + 一轮一条汇总：少一种就有某类专辑的判定永远无人可读（介绍那一路的同款要求）。
  assert.match(library, /封面补全「\$\{album\.title\}[\s\S]{0,160}命中（来源 \$\{outcome\.source\}/, '补到了要留一行，带上来源与字节数');
  assert.match(library, /封面补全「\$\{album\.title\}[\s\S]{0,120}没问到[\s\S]{0,40}未落文件 —— \$\{detail\}/,
    '没补到也要留一行，且必须把逐源原因拼进去（真实曲库 COME ALONG 3 那笔"iTunes 200 / 27KB 却没落文件"就是靠这句读出来的：27KB 是检索 JSON，闸门拒绝后根本没发取图请求）');
  assert.match(library, /结果已丢弃/, '身份变了或已经有封面 ⇒ 结论被丢掉也得留痕，否则"明明补到了却没图"变成新的谜');
  assert.match(library, /封面补全这一轮：/, '一轮一条汇总（张数 / 补到 / 确实没有 / 没问到）');
  // 汇总里必须区分"确实没有"与"没问到"：合并了就是把网络故障写成"这张没封面"。
  // 判据要盯"两个独立分句"这个形状 —— 只查计数变量在不在会被 `${a + b}` 这种合并写法糊过去。
  const summary = /封面补全这一轮：[\s\S]{0,220}/.exec(library)?.[0] ?? '';
  assert.match(summary, /\$\{done\.notFound\} 张确实没有，\$\{done\.failed\} 张没问到/,
    '"确实没有"与"没问到"必须是两个各自带计数的分句（合并成一档就是把访问故障写成"这张没封面"）');
  assert.equal(summary.includes('done.notFound + done.failed'), false, '两个计数不许被加到一起');
  assert.ok(summary.includes('matched'), '汇总里要有"补到几张"那一档');
});

test('R106：「重新补一次封面」按钮接的是 force 路由，且不叠轮次', async () => {
  const app = await fs.readFile(path.join(SCRIPTS, '..', 'src', 'music-app.ts'), 'utf8');
  assert.match(app, /data-action="covers-refresh"/, '按钮要在「封面显示」那一节里');
  assert.match(app, /case "covers-refresh":\s*\n\s*void refreshCovers\(\);/, '分派要在位（按钮不响是界面最常见的静默）');
  const fn = /async function refreshCovers\(\) \{([\s\S]*?)\n\}/.exec(app)?.[1] ?? '';
  assert.ok(fn.length > 200, '没截到 refreshCovers');
  assert.match(fn, /"\/api\/online\/cover\/backfill", \{ force: true \}/, '必须走 force：不 force 会被 7 天复用挡在门外，点了等于没点');
  assert.match(fn, /library\.covers\?\.running/, '正在跑这一轮时不许再排一轮');
  assert.match(fn, /notify\(`封面补全没开始/, '服务端拒绝（开关关着回 404）要把那句实话显示出来，不是静默');
  assert.match(fn, /await receiveLibrary\(next\)/, '排完要收快照，否则界面上的进度与图都要等下一次轮询');
});
