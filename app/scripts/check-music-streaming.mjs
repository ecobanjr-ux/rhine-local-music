// 第五期 Task 6 自检：流式试听（在线音源的取址、Range 透传与"音频字节不落盘"）。
//
// 这一条钉的是三件最容易在真机上翻车的事：
//   ① 流式变体的安全面不许比 guardedFetch 缩水（只放开"不整读、不卡体积"这一条）；
//   ② Range 语义必须与本地 /api/audio 同口径，且**不许把上游的 200 整段伪装成 206**；
//   ③ 音频字节只过内存不落盘——路由里出现 writeFile/createWriteStream 就是红。
//
// 离线纪律：不 require 任何第三方包、不出网。音源取址经注入的假 fetcher / 假桥，
// 上游串流经注入的假 streamFetcher（真机那一半在 V6 的浏览器取证里补）。
// 主机白名单表里的每一个名字都是 2026-10-05 一手实测换来的（见 memory/folia-port-p5-run-log.md 的 Task 6 段），
// 不许"顺手"加回方案初稿里那些没测过的后缀。
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { listenAndReady } from './check-ready.mjs';

const SCRIPTS = dirname(fileURLToPath(import.meta.url));
const read = (relative) => readFile(new URL(`../${relative}`, import.meta.url), 'utf8');
const readScript = (name) => readFile(join(SCRIPTS, name), 'utf8');

const { AUDIO_HOSTS, LYRICS_HOSTS, METADATA_HOSTS, hostAllowed, guardedStreamFetch, assertAllowedTarget,
  KUGOU_PLAYINFO_HOSTS, SHARE_HOSTS } = await import('./online-guard.mjs');
const audio = await import('./online-audio-source.mjs');

// ── ① 安全面：流式变体一条不少 ────────────────────────────────────────────────

test('AUDIO_HOSTS 只收一手实测到的主机，后缀匹配必须点起头（方案初稿那三条没测过的后缀不许回来）', () => {
  // 精确表：QQ 实测到的 CDN 主机名不落在任何统一后缀下（aqqmusic.tc.qq.com）。
  assert.ok(AUDIO_HOSTS.exact.has('aqqmusic.tc.qq.com'), '实测：QQ 匿名 vkey 的 sip 给的就是它');
  // 后缀表：网易 CDN 是 m<数字>.music.126.net（实测 m702 / m802），QQ 是 <任意>.stream.qqmusic.qq.com（实测 sjy6，
  // 包内兜底常量还有 dl.stream.qqmusic.qq.com）⇒ 只能按后缀收。
  assert.deepEqual(AUDIO_HOSTS.suffix, ['.music.126.net', '.stream.qqmusic.qq.com']);
  for (const banned of ['.mzstatic.com', '.kuwo.cn', '.kugou.com']) {
    assert.ok(!AUDIO_HOSTS.suffix.includes(banned), `${banned} 是方案初稿的猜测，今天没有任何实测主机落进去（不许当占位）`);
  }
  assert.notEqual(AUDIO_HOSTS, LYRICS_HOSTS, '音源不与歌词共用主机表');
  // R221：网页档那两台是**这一次实测换来的**（TLS 握手 + 一次 4KB Range 读头：206 且 content-range 总长
  // 与响应 fileSize 逐位相等）。加名字的老规矩不变：先量到、再进表，而且**只进精确表**。
  assert.ok(AUDIO_HOSTS.exact.has('sharefs.kugou.com'), '(R221) 实测 https 可用：TLSv1.3 + Range 206');
  assert.ok(AUDIO_HOSTS.exact.has('sharefs.tx.kugou.com'), '(R221) 备份那台同一份文件、同一读数');
  assert.ok(!AUDIO_HOSTS.exact.has('fs.youthandroid.kugou.com') && !AUDIO_HOSTS.exact.has('fs.youthandroid2.kugou.com'),
    '(R221 反证) 升 https 直接 ERR_TLS_CERT_ALTNAME_INVALID 的那一族依旧不收');
  // R221：网页取址那一跳的专用表——只有一台、后缀空，且**不是**分享页那张表（同主机不同用途要分开收）。
  assert.deepEqual([...KUGOU_PLAYINFO_HOSTS.exact], ['m.kugou.com'], '取址这一跳的表里只有实测回 200 的那一台');
  assert.deepEqual(KUGOU_PLAYINFO_HOSTS.suffix, [], '后缀必须空：*.kugou.com 会把设备注册与签名网关一起放进来');
  assert.notEqual(KUGOU_PLAYINFO_HOSTS, SHARE_HOSTS, '与分享页那张表是两个对象（共表等于互相扩权）');
  for (const table of [LYRICS_HOSTS, METADATA_HOSTS]) assert.ok(table instanceof Set, '另两张表仍是 Set 形状（改动只加不减）');
});

test('hostAllowed 同时吃 Set 与 {exact,suffix} 两种形状，后缀伪装与"后缀本身"都被拒', () => {
  assert.equal(hostAllowed('m802.music.126.net', AUDIO_HOSTS), true, '网易 CDN');
  assert.equal(hostAllowed('sjy6.stream.qqmusic.qq.com', AUDIO_HOSTS), true, 'QQ CDN');
  assert.equal(hostAllowed('aqqmusic.tc.qq.com', AUDIO_HOSTS), true, '精确命中');
  assert.equal(hostAllowed('AQQMUSIC.TC.QQ.COM', AUDIO_HOSTS), true, '主机名大小写不敏感');
  // 三条伪装：后缀本身当主机、后缀起头的更长名、把后缀埋在中间。
  assert.equal(hostAllowed('.music.126.net', AUDIO_HOSTS), false, '后缀本身不是主机');
  assert.equal(hostAllowed('music.126.net', AUDIO_HOSTS), false, '缺点：m802.music.126.net 才对');
  assert.equal(hostAllowed('music.126.net.evil.test', AUDIO_HOSTS), false, '尾缀伪装');
  assert.equal(hostAllowed('evil-music.126.net', AUDIO_HOSTS), false, '相邻但不同子域（没有那个点）');
  assert.equal(hostAllowed('musicbrainz.org', LYRICS_HOSTS), false, 'Set 形状也走同一条判断');
});

test('assertAllowedTarget 用 hostAllowed 把关：白名单外与 IP 字面量都在进 DNS 之前被拒', () => {
  assert.equal(assertAllowedTarget('https://m802.music.126.net/a.mp3', AUDIO_HOSTS).hostname, 'm802.music.126.net');
  for (const bad of [
    'http://m802.music.126.net/a.mp3',                     // 明文一律拒（音源也不例外，见 upgradeToHttps）
    'https://127.0.0.1:5178/a.mp3',                         // 环回
    'https://192.168.0.12/a.mp3',                           // 私网 IP 字面量
    'https://evil.example.com/a.mp3',                       // 白名单外
    'https://music.126.net/a.mp3',                          // 少了那个点
    'https://m802.music.126.net:8443/a.mp3',                // 非默认端口
    'https://user:pass@m802.music.126.net/a.mp3',           // URL 里带凭据
  ]) {
    assert.throws(() => assertAllowedTarget(bad, AUDIO_HOSTS), /ONLINE_TARGET_REJECTED/, bad);
  }
});

test('guardedStreamFetch：前三条校验与 guardedFetch 同源，只放开体积上限，且绝不整读响应', async () => {
  const src = await readScript('online-guard.mjs');
  const body = src.slice(src.indexOf('export async function guardedStreamFetch'));
  assert.ok(body.length > 300, '没抓到 guardedStreamFetch 的函数体');
  assert.match(body, /redirect: 'error'/, '流式也必须禁重定向');
  assert.match(body, /credentials: 'omit'/, '流式也不带凭据');
  assert.match(body, /cache: 'no-store'/, '流式也不让运行时缓存');
  assert.match(body, /AbortSignal\.timeout/, '流式也有超时');
  assert.doesNotMatch(body, /maxBytes/, '流式不卡体积上限（整首音频必然超）');
  assert.doesNotMatch(body, /for await \(const chunk of [\s\S]{0,40}response\.body/, '流式不许把响应读进内存');
  // 最关键的一条：两个入口共用同一份预检，安全面不会各自漂移（改坏一处两条一起红）。
  assert.match(body, /await precheckTarget\(/, '流式走的是那份共享预检（协议 + 主机白名单 + DNS 类别）');
  const shared = src.slice(src.indexOf('export async function guardedFetch'));
  assert.match(shared, /await precheckTarget\(/, '非流式也走同一份预检');
  assert.match(src, /async function precheckTarget\(/, '预检只有一份实现');
  // 被拒的四类地址：一条都发不出去，但每一笔都要留在审计里（R75）。
  for (const url of ['http://m802.music.126.net/a.mp3', 'https://127.0.0.1:5178/a.mp3',
    'https://evil.example.com/a.mp3', 'https://musicbrainz.org/a.mp3']) {
    await assert.rejects(() => guardedStreamFetch(url, { hosts: AUDIO_HOSTS, kind: 'stream' }), /ONLINE_TARGET_REJECTED/, `${url} 必须被拒`);
  }
});

test('流式取的音源 URL 一律升到 https：实测两家 CDN 同主机都支持 https，明文那条路不必开', async () => {
  // 一手实测：网易给 http://m802.music.126.net/…，把它换成 https:// 同主机 200/206 都正常；
  // QQ 的 sip 也不带 scheme（补 http://），换 https 后一样给 206 + content-range。
  assert.equal(audio.upgradeToHttps('http://m802.music.126.net/x.mp3'), 'https://m802.music.126.net/x.mp3');
  assert.equal(audio.upgradeToHttps('aqqmusic.tc.qq.com/M500x.mp3'), 'https://aqqmusic.tc.qq.com/M500x.mp3', 'sip 可能不带 scheme（实测）');
  assert.equal(audio.upgradeToHttps('https://m802.music.126.net/x.mp3'), 'https://m802.music.126.net/x.mp3');
  assert.equal(audio.upgradeToHttps(''), null, '空 URL 不是"升级失败"，是"没有 URL"');
  assert.equal(audio.upgradeToHttps('ftp://m802.music.126.net/x'), null, '非 http(s) 一律不当作音源');
  await assert.rejects(() => guardedStreamFetch(audio.upgradeToHttps('http://m802.music.126.net/x.mp3'), {
    hosts: AUDIO_HOSTS, kind: 'stream', headers: { range: 'bytes=0-1' },
    // 注入一条"环回地址"的 DNS 结果：注入只是省一次解析，不是省一道检查。
    lookup: async () => [{ address: '127.0.0.1' }],
  }), /受限地址/, '假 lookup 给环回也必须拒');
});

// ── ② 音源取址：三源各按其真实形状（网易经桥、QQ 自写 fcg、酷狗如实拒绝）────────

test('QQ 匿名 vkey 走 CgiGetVkey 而不是 UrlGetVkey（后者实测 request.code=40000），文件名是两段拼接', () => {
  const request = audio.qqVkeyRequest({ songmid: '00245tac3U4PcI', mediaMid: '', quality: '128' });
  assert.equal(request.module, 'vkey.GetVkeyServer');
  assert.equal(request.method, 'CgiGetVkey');
  assert.deepEqual(request.param.filename, ['M50000245tac3U4PcI00245tac3U4PcI.mp3'],
    'mediaMid 缺席时用 songmid 补第二段（包内 qrLogin.js:434 注释：只送一段 CDN 会 403）');
  assert.equal(audio.qqVkeyRequest({ songmid: 'a', mediaMid: 'b', quality: '320' }).param.filename[0], 'M800ab.mp3');
  assert.equal(audio.qqVkeyRequest({ songmid: 'a', mediaMid: 'b', quality: 'm4a' }).param.filename[0], 'C400ab.m4a');
  // 质量降级序列（R80）：先试高的，拿不到再降；表里不许出现没实测过的档。
  assert.deepEqual(audio.AUDIO_QUALITY_ORDER, ['320', '128', 'm4a']);
  assert.equal(audio.qqVkeyRequest({ songmid: '', mediaMid: '', quality: '128' }), null, '空 songmid 不发请求');
});

test('QQ vkey 响应 → 可播 URL：sip 可能不带 scheme 也不带结尾斜杠，purl 不带开头斜杠（实测踩过）', () => {
  const converted = audio.qqPlayUrlFrom({ sip: ['aqqmusic.tc.qq.com', 'http://ws8.stream.qqmusic.qq.com'], midurlinfo: [{ purl: 'M50000245tac3U4PcI00245tac3U4PcI.mp3' }] });
  assert.equal(converted.url, 'https://aqqmusic.tc.qq.com/M50000245tac3U4PcI00245tac3U4PcI.mp3');
  assert.equal(converted.kind, 'mp3');
  // 带 ws 前缀的那一枚是包内明确避开的（getMusicPlay.js:90 同一条 find），这里保持一致。
  assert.equal(audio.qqPlayUrlFrom({ sip: ['http://ws8.stream.qqmusic.qq.com'], midurlinfo: [{ purl: 'x.mp3' }] }).url,
    'https://ws8.stream.qqmusic.qq.com/x.mp3', '只剩 ws 那一个时也得能用，但不能优先它');
  assert.equal(audio.qqPlayUrlFrom({ sip: [], midurlinfo: [] }), null, '没有 purl 就是没有音源（返回 null，不是 {url:null}）');
  assert.equal(audio.qqPlayUrlFrom({ midurlinfo: [{ purl: '' }] }), null, 'purl 空串不是"长度为 0 的可播地址"');
  assert.equal(audio.qqPlayUrlFrom({ sip: ['http://evil.test'], midurlinfo: [{ purl: 'x.mp3' }] }), null,
    '白名单外的 CDN 主机当"没有音源"处理，不当"可用"处理');
});

test('网易音源经桥取，响应形状按实测收窄；/song/url/v1 在这个 build 是 404 所以不试', async () => {
  const calls = [];
  const resolver = audio.createAudioSourceResolver({
    fetcher: async () => ({ ok: true, status: 200, json: () => ({}) }),
    bridge: { call: async (route, payload) => { calls.push([route, payload]); return { ok: true, url: 'http://m802.music.126.net/a.mp3', kind: 'mp3', size: 480813 } } },
  });
  const result = await resolver.resolve({ provider: 'netease', mediaId: '1997438791' });
  assert.equal(result.ok, true);
  assert.equal(result.url, 'https://m802.music.126.net/a.mp3', '出桥的 http 地址在父进程这一侧升 https');
  assert.deepEqual(calls[0], ['/bridge/audio-source', { provider: 'netease', mediaId: '1997438791' }]);
  // 桥报"没起来"与桥报"这首没链接"是两件事，文案要分开（前者 503、后者 502）。
  const down = await audio.createAudioSourceResolver({ bridge: { call: async () => ({ ok: false, reason: 'netease-down' }) } })
    .resolve({ provider: 'netease', mediaId: '1' });
  assert.equal(down.reason, 'netease-down');
  assert.equal(down.via, 'bridge');
});

test('R154 酷狗音源已接成第三个可播源：登录态 + 设备身份经桥，地址升 https 且带「完整播放」', async () => {
  const saved = [];
  const calls = [];
  const resolver = audio.createAudioSourceResolver({
    now: () => 1_000_000,
    bridge: { call: async (route, payload) => { calls.push([route, payload]); return { ok: true, provider: 'kugou', url: 'http://fsandroid.kugou.com/x/1.mp3', kind: 'mp3', size: 4069795, scope: 'full', device: { guid: 'g'.repeat(36), mid: '12345', dfid: '' } } } },
    credentialsFor: async () => ({ cookie: 'token=tt;userid=uu', device: { guid: 'g'.repeat(36), mid: '', dfid: '', deviceIdentity: false } }),
    saveKugouDevice: async (device) => { saved.push(device) },
  });
  const result = await resolver.resolve({ provider: 'kugou', mediaId: '8F9478E068736878D6FE520A03C8A340' });
  assert.equal(result.ok, true, `该成功：${result.reason}`);
  assert.equal(result.provider, 'kugou');
  assert.equal(result.url, 'https://fsandroid.kugou.com/x/1.mp3', '上游给 http ⇒ 升 https（与网易/QQ 同一条老规矩，不为音频放开明文）');
  assert.equal(result.scope, 'full', 'scope 只从取址结果来（R101），酷狗那一档是量出来的 status:1+priv_status:1');
  assert.equal(calls[0][0], '/bridge/audio-source');
  assert.equal(calls[0][1].cookie, 'token=tt;userid=uu', '凭据由父进程带来（桥不读盘）');
  assert.equal(calls[0][1].device.deviceIdentity, false, '开关缺省关：这一跳不许带"可以去注册"的许可');
  assert.equal(saved.length, 1, '桥回报的设备身份要落一次盘');
});

test('R154 没有酷狗登录态 ⇒ 父进程就不问桥（零出网），而且那句是可读的权益事实、分类成 unavailable', async () => {
  const calls = [];
  const web = [];
  const resolver = audio.createAudioSourceResolver({
    now: () => 1_000_000,
    bridge: { call: async (route, payload) => { calls.push([route, payload?.provider]); return { ok: true } } },
    // R221：这一格现在有两档取址（签名档 + 网页档）⇒ "零出网"要把**两档都**钉住，只钉桥那一档会被网页档绕过。
    fetcher: async (url, init) => { web.push([url, init?.hosts]); throw new Error('未登录时不该有任何出网') },
    credentialsFor: async () => ({ cookie: '', device: { guid: 'g'.repeat(36) } }),
  });
  const result = await resolver.resolve({ provider: 'kugou', mediaId: '8F9478E068736878D6FE520A03C8A340' });
  assert.equal(result.ok, false);
  assert.equal(result.unavailable, true, '这是"这一家不给"，与"桥坏了"分开分类（回落只认前者）');
  assert.match(result.reason, /要登录才给可播文件/);
  assert.deepEqual(calls, [], '未登录时一个桥调用都不许发出去');
  assert.deepEqual(web, [], 'R221：未登录时**网页那一档也不问**（免费曲那部分要不要给未登录播是另一件事，记在待拍板里，不许顺手扩）');
});

test('R154 hash 形状不对直接拒：不发桥、不猜（32 位十六进制是实测 FileHash 的形状）', async () => {
  const calls = [];
  const web = [];
  const resolver = audio.createAudioSourceResolver({
    now: () => 1_000_000,
    bridge: { call: async (route, payload) => { calls.push(route); return { ok: true, url: 'https://fsandroid.kugou.com/a.mp3' } } },
    fetcher: async (url, init) => { web.push([url, init?.hosts]); throw new Error('形状不对时不该有任何出网') },
    credentialsFor: async () => ({ cookie: 'token=tt;userid=uu', device: { guid: 'g'.repeat(36) } }),
  });
  const bad = await resolver.resolve({ provider: 'kugou', mediaId: 'abc' });
  assert.equal(bad.ok, false);
  assert.match(bad.reason, /形状/, `该说形状不对：${bad.reason}`);
  assert.deepEqual(calls, []);
  assert.deepEqual(web, [], 'R221：形状不对连网页那一档也不问（`kugouWebPlayInfoUrl` 里那道 hash 闸是唯一入口）');
});

test('R154/R218 出口那道主机闸不许松：酷狗回了表外的主机就当没有音源，原因说准"上游只给明文 CDN"**并带出路**', async () => {
  const web = [];
  const resolver = audio.createAudioSourceResolver({
    now: () => 1_000_000,
    bridge: { call: async () => ({ ok: true, provider: 'kugou', url: 'http://fs.youthandroid2.kugou.com/a.mp3', kind: 'mp3' }) },
    // R221：签名档被出口闸挡下之后现在会再问一次网页档 ⇒ 这里必须把那一跳也钉成夹具（不注入就会真出网）。
    // 夹具给的是 2026-10-14 一手量到的"要付费"那一档（`status:0 / error:需要付费 / fileSize:0 / url:""`）。
    fetcher: async (url, init) => { web.push([url, init?.hosts]); return { ok: true, status: 200, json: () => ({ status: 0, error: '需要付费', privilege: 10, fileSize: 0, url: '', backup_url: {} }) } },
    credentialsFor: async () => ({ cookie: 'token=tt;userid=uu', device: { guid: 'g'.repeat(36) } }),
  });
  const result = await resolver.resolve({ provider: 'kugou', mediaId: '8F9478E068736878D6FE520A03C8A340' });
  assert.equal(result.ok, false, '表外主机绝不拿去串流（这条判据本身没松）');
  assert.match(result.reason, /不支持 https/, '但界面那句必须是真原因：2026-10-10 实测这一族升 https 直接 TLS 证书名不匹配');
  // R218（ii）：只说"不行"不够 —— 全都要么明文要么不可用时，出路要说出来（换一首 / 换一家源）。
  assert.match(result.reason, /换一首、或换一家源试试/, '(ii) 拒绝那格必须补出路文案');
  assert.match(result.reason, /本机不为音频走明文/, '(ii) 原因仍要含纪律原句');
  assert.equal(result.unavailable, true, '标成 unavailable 才能让 R141 的回落去试另一家（用户要的是能出声）');
  assert.equal(result.url, undefined, '被拒的地址不许带出去');
  // R221 加的两格：两档都问过、两句都留着（只说一档就是把"问过两次"写成"只问了一次"）。
  assert.equal(web.length, 1, '(R221) 签名档没给出可用地址 ⇒ 网页档问一次，不多问');
  assert.match(result.reason, /网页那一档：.*付费/, '(R221) 网页档那句要接在后面，两档各自的答话都在');
});

test('R218（i）多候选优先挑 https 可用的那台：第一条只有明文主机时用第二条（「素颜能播、坏女孩 502」的机制）', async () => {
  const calls = [];
  const resolver = audio.createAudioSourceResolver({
    now: () => 1_000_000,
    bridge: { call: async (route, payload) => { calls.push([route, payload]); return {
      ok: true, provider: 'kugou',
      url: 'http://fs.youthandroid2.kugou.com/a.mp3',
      urls: ['http://fs.youthandroid2.kugou.com/a.mp3', 'http://fsandroid.kugou.com/a.mp3'],
      kind: 'mp3', size: 4069795, scope: 'full',
      device: { guid: 'g'.repeat(36), mid: '1', dfid: '' },
    } } },
    credentialsFor: async () => ({ cookie: 'token=tt;userid=uu', device: { guid: 'g'.repeat(36) } }),
  });
  const result = await resolver.resolve({ provider: 'kugou', mediaId: '8F9478E068736878D6FE520A03C8A340' });
  assert.equal(result.ok, true, `第一台明文、第二台 https 可用 ⇒ 必须挑第二台：${result.reason}`);
  assert.equal(result.url, 'https://fsandroid.kugou.com/a.mp3', '挑的是 https 可用的那台，且已升 https');
  assert.equal(result.scope, 'full');
  // 纯函数面也钉一遍（行为级，不依赖 resolver 的夹具装配）。
  assert.deepEqual(audio.pickHttpsAudioUrl(['http://fs.youthandroid2.kugou.com/a.mp3', 'https://fsandroid.kugou.com/a.mp3']),
    { url: 'https://fsandroid.kugou.com/a.mp3', host: 'fsandroid.kugou.com' });
  assert.equal(audio.pickHttpsAudioUrl(['http://fs.youthandroid2.kugou.com/a.mp3', 'http://fsmobile.tx.kugou.com/a.mp3']), null,
    '全都不在表里 ⇒ null（保持拒绝，绝不为明文放行）');
  // （iii）源码级：放行明文的代码路径零命中 —— 这一处文件里没有把 protocol 降回 http: 的写口。
  const source = await readScript('online-audio-source.mjs');
  assert.equal(/protocol\s*=\s*['"]http:['"]/.test(source), false, '(iii) 不许有把地址降回明文的写口');
  assert.match(source, /if \(hostAllowed\(host, AUDIO_HOSTS\)\) return \{ url, host \}/,
    '(iii) 挑选器必须以出口白名单为唯一判据（跳过这张表的改动会让本判据红）');
});

// ── R221 · 酷狗"网页档"那一跳 ────────────────────────────────────────────────
// 夹具的**形状**全部来自 2026-10-14 的一手读数（`memory/kugou-addressing-identity-r221-run-log.md`：
// `status:1 / errcode:0 / error:"" / privilege:0 / fileSize:4112408 / timeLength:252 / extName:"mp3"`，
// `url` 与 `backup_url` 各一条、路径里是 `/yp/full/`，主机 `sharefs.kugou.com` / `sharefs.tx.kugou.com`）。
// 路径里那两段签名散列是**夹具编的**——真签名地址不进仓库（与封面地址同一条红线 R116）。
const WEB_FULL_BODY = Object.freeze({
  status: 1, errcode: 0, error: '', privilege: 0, fileSize: 4112408, timeLength: 252, extName: 'mp3',
  url: ['https://sharefs.kugou.com/202610141200/deadbeef/v3/12f15fbcfebbdfe49854ced4f5410eab/yp/full/ap1000_pi409.mp3'],
  backup_url: ['https://sharefs.tx.kugou.com/202610141200/beefdead/v3/12f15fbcfebbdfe49854ced4f5410eab/yp/full/ap1000_pi409.mp3'],
});
const WEB_PAID_BODY = Object.freeze({ status: 0, error: '需要付费', privilege: 10, fileSize: 0, timeLength: 0, extName: '', url: '', backup_url: {} });

test('R221（i）签名档没给出可用地址 ⇒ 问一次网页档：两档回的主机集合不同，最后那条出自网页档且过同一个挑选器', async () => {
  const seq = [];
  const webInits = [];
  const resolver = audio.createAudioSourceResolver({
    now: () => 1_000_000,
    // 今天真机的第一档就是这一格：上游对带 userid 的 /v5/url 整片回 502 · error_code 31833 "illegal key"。
    bridge: { call: async () => { seq.push('bridge'); return { ok: false, provider: 'kugou', reason: '酷狗取址这一档没成（HTTP 502 · 错误码 31833）', retryable: true } } },
    fetcher: async (url, init) => { seq.push('web'); webInits.push([url, init]); return { ok: true, status: 200, json: () => WEB_FULL_BODY } },
    credentialsFor: async () => ({ cookie: 'token=tt;userid=uu', device: { guid: 'g'.repeat(36) } }),
  });
  const result = await resolver.resolve({ provider: 'kugou', mediaId: '12F15FBCFEBBDFE49854CED4F5410EAB' });
  assert.equal(result.ok, true, `签名档坏了但网页档给了 ⇒ 这一首要能播：${result.reason}`);
  assert.equal(result.provider, 'kugou');
  assert.equal(new URL(result.url).hostname, 'sharefs.kugou.com', '最终地址是**网页档**那台主机，不是签名档那台（两档主机集合不同就是这一格）');
  assert.equal(result.scope, 'full', '整首标记来自 `/yp/full/` 那一条实测判据，不是拿时长猜的（R101）');
  assert.equal(result.size, 4112408);
  assert.equal(result.kind, 'mp3');
  assert.deepEqual(seq, ['bridge', 'web'], '次序：先签名档（有登录态就可能给会员曲目），网页档只在它没给出可用地址之后问一次');
  // 出网那一跳的四条把关：主机表专用、没带头、走 audio 那一档审计。
  const [url, init] = webInits[0];
  assert.match(url, /^https:\/\/m\.kugou\.com\/app\/i\/getSongInfo\.php\?cmd=playInfo&hash=12f15fbcfebbdfe49854ced4f5410eab$/, 'hash 小写归一、查询串只有 cmd 与 hash 两段');
  assert.equal(init.hosts, KUGOU_PLAYINFO_HOSTS, '用**专用的那张表**（与分享页同主机不同用途，共表等于互相扩权）');
  assert.notEqual(init.hosts, SHARE_HOSTS, '(反证) 不是分享页那张表');
  assert.notEqual(init.hosts, AUDIO_HOSTS, '(反证) 也不是音频出口那张表');
  assert.equal(init.headers, undefined, '零请求头：实测这一跳不带任何头也回 200 ⇒ 本路不伪装客户端身份');
  assert.equal(init.kind, 'audio', '审计里仍算"音源"那一档，不新增用途');
  // 挑选器面：两档各自主机集合的读数不同（这条就是任务书要的"两种参数返回的主机集合不同"）。
  assert.deepEqual(audio.pickHttpsAudioUrl(['http://fsandroid.kugou.com/a.mp3']).host, 'fsandroid.kugou.com');
  assert.deepEqual(audio.pickHttpsAudioUrl(WEB_FULL_BODY.url).host, 'sharefs.kugou.com');
});

test('R221（ii）签名档成功时就不再多问一跳（免费档不是万能档，多一笔出网要多担一份风险）', async () => {
  const seq = [];
  const resolver = audio.createAudioSourceResolver({
    now: () => 1_000_000,
    bridge: { call: async () => { seq.push('bridge'); return { ok: true, provider: 'kugou', url: 'https://fsandroid.kugou.com/a.mp3', kind: 'mp3', size: 4069795, scope: 'full' } } },
    fetcher: async () => { seq.push('web'); return { ok: true, status: 200, json: () => WEB_FULL_BODY } },
    credentialsFor: async () => ({ cookie: 'token=tt;userid=uu', device: { guid: 'g'.repeat(36) } }),
  });
  const result = await resolver.resolve({ provider: 'kugou', mediaId: '12F15FBCFEBBDFE49854CED4F5410EAB' });
  assert.equal(result.ok, true);
  assert.equal(new URL(result.url).hostname, 'fsandroid.kugou.com', '签名档给的那台优先（会员权益那档只有它给得到）');
  assert.deepEqual(seq, ['bridge'], '签名档成了 ⇒ 网页档一跳都不问');
});

test('R221（iii）网页档那四条闸逐条会咬，且没量全的字段（privilege）不参与权益判定', () => {
  // ① 地址构造：形状不对就 null（连查询串都不拼 ⇒ 零出网）。
  assert.equal(audio.kugouWebPlayInfoUrl('abc'), null, '不是 32 位十六进制就不构造地址');
  assert.equal(audio.kugouWebPlayInfoUrl('9365223F903B13D0DAF54B6091AC3E7B'),
    'https://m.kugou.com/app/i/getSongInfo.php?cmd=playInfo&hash=9365223f903b13d0daf54b6091ac3e7b');
  // ② 整首那一档：ok + 两条候选都在（备份主机留给挑选器）。
  const full = audio.kugouWebPlayInfoToSource(WEB_FULL_BODY);
  assert.equal(full.ok, true);
  assert.equal(full.urls.length, 2, 'url 与 backup_url 都要带出去（R218 那条"候选表整份带出"同一口径）');
  assert.equal(full.scope, 'full');
  // ③ 要付费那一档：不是"通道坏了"，denied ⇒ 调用方按权益事实分类。
  const paid = audio.kugouWebPlayInfoToSource(WEB_PAID_BODY);
  assert.equal(paid.ok, false, '(付费档) 不给地址就是不播，不猜、不降级');
  assert.equal(paid.denied, true, '(付费档) 要标成权益事实');
  // ④ 片段那一档：路径标记不是整首 ⇒ 只做减法。
  //    （夹具把 `backup_url` 也清空才 isolating 得出来：两条字段是**合并成候选表**的，
  //     留着整首那条就只是在测整首那一档——第一次写这条时就被自己的断言当场抓住。）
  const part = audio.kugouWebPlayInfoToSource({ ...WEB_FULL_BODY, url: ['https://sharefs.kugou.com/x/v3/abc/yp/p_0_960117/ap1000.mp3'], backup_url: [] });
  assert.equal(part.ok, false, '(片段档) 本机不拿片段冒充整首');
  assert.match(part.reason, /不是整首|片段/);
  // ④b 两条字段里**只有 backup_url 那条是整首**时采用那一条（候选表是合并出来的，逐条按标记筛）。
  const mixed = audio.kugouWebPlayInfoToSource({ ...WEB_FULL_BODY, url: ['https://sharefs.kugou.com/x/v3/abc/yp/p_0_960117/ap1000.mp3'] });
  assert.equal(mixed.ok, true, '(混档) 备份那条是整首就用它，不看片段那条');
  assert.deepEqual(mixed.urls, WEB_FULL_BODY.backup_url, '(混档) 带出去的是整首那一条');
  // ⑤ status:1 但 fileSize 是 0：上游自己都没说这首多大，不当整首播。
  const noSize = audio.kugouWebPlayInfoToSource({ ...WEB_FULL_BODY, fileSize: 0 });
  assert.equal(noSize.ok, false); assert.match(noSize.reason, /fileSize/);
  // ⑥ `url` 是逗号接的多条串（参考实现 `audioUrlOf` 明说过这一族会这么回）。
  const joined = audio.kugouWebPlayInfoToSource({ ...WEB_FULL_BODY, url: [...WEB_FULL_BODY.url, ...WEB_FULL_BODY.backup_url].join(', '), backup_url: [] });
  assert.equal(joined.ok, true, '(多条串) 逗号接的也要拆开认');
  assert.equal(joined.urls.length, 2, '(多条串) 两条整首都进候选表');
  // ⑦ `privilege` **不参与判定**：只量到 0/8 给地址、10 不给，语义没量全的字段不许当权益判据。
  assert.equal(audio.kugouWebPlayInfoToSource({ ...WEB_FULL_BODY, privilege: 999 }).ok, true,
    '(反证) 换一个没量过的 privilege 值也不许改变判定——判定只看量到的那四条');
  // ⑧ 空响应 / 非对象：认不出就当没有地址，不抛。
  assert.equal(audio.kugouWebPlayInfoToSource(null).ok, false);
  assert.equal(audio.kugouWebPlayInfoToSource(undefined).ok, false);
});

test('R221（iv）网页档给的主机照样过出口那张表：表外主机（只给明文）一律拒，两句原因都留着', async () => {
  const resolver = audio.createAudioSourceResolver({
    now: () => 1_000_000,
    bridge: { call: async () => ({ ok: false, provider: 'kugou', reason: '酷狗取址这一档没成（HTTP 502 · 错误码 31833）', retryable: true }) },
    fetcher: async () => ({ ok: true, status: 200, json: () => ({ ...WEB_FULL_BODY,
      url: ['https://fs.youthandroid.kugou.com/x/v3/abc/yp/full/ap1000.mp3'], backup_url: [] }) }),
    credentialsFor: async () => ({ cookie: 'token=tt;userid=uu', device: { guid: 'g'.repeat(36) } }),
  });
  const result = await resolver.resolve({ provider: 'kugou', mediaId: '12F15FBCFEBBDFE49854CED4F5410EAB' });
  assert.equal(result.ok, false, '表外主机即便来自网页档也不收（新增主机名要靠实测，不能靠"这一路看着像免费"）');
  assert.equal(result.unavailable, true, '标成 unavailable ⇒ 回落还能去试另一家');
  assert.match(result.reason, /不在实测 https 可用的表里/);
  assert.match(result.reason, /31833/, '签名档那句原因留着（两档各答了什么，用户都要看得到）');
  assert.equal(result.url, undefined);
  // 源码级（变异「放行 http」的那一格就咬在这里）：网页档的候选**也必须走同一个挑选器**，
  // 不许出现"这一路特殊，直接拿第一条"的第二个出口。
  const src = await readScript('online-audio-source.mjs');
  assert.match(src, /const picked = pickHttpsAudioUrl\(parsed\.urls\)/, '(源码级) 网页档走的是同一个挑选器，没有第二条出口');
  assert.equal(/protocol\s*=\s*['"]http:['"]/.test(src), false, '(源码级) 全文件没有把地址降回明文的写口');
});

test('R154 登录态进缓存键（R101 推广到第三家）：同一首换账号是两次全新取址，不是命中缓存', async () => {
  let calls = 0;
  let cookie = 'token=aa;userid=bb';
  const resolver = audio.createAudioSourceResolver({
    now: () => 1_000_000,
    bridge: { call: async () => { calls += 1; return { ok: true, provider: 'kugou', url: 'https://fsandroid.kugou.com/a.mp3', kind: 'mp3', scope: 'full' } } },
    credentialsFor: async () => ({ cookie, device: { guid: 'g'.repeat(36) } }),
  });
  await resolver.resolve({ provider: 'kugou', mediaId: '8F9478E068736878D6FE520A03C8A340' });
  await resolver.resolve({ provider: 'kugou', mediaId: '8F9478E068736878D6FE520A03C8A340' });
  assert.equal(calls, 1, '同一登录态第二次命中缓存');
  cookie = 'token=bb;userid=cc';
  await resolver.resolve({ provider: 'kugou', mediaId: '8F9478E068736878D6FE520A03C8A340' });
  assert.equal(calls, 2, '换了账号必须重新取址：否则退出后继续吃上一份整首地址');
  // 键里只有摘要，没有凭据（键会被自检与日志打印出来）。
  assert.ok(resolver.cacheKeys().every((key) => !key.includes('token=')), `缓存键里不许有凭据：${resolver.cacheKeys()}`);
});

test('解析结果按 TTL 复用：拖一次进度条不该重问一次音源（真机上每次取址都要出网）', async () => {
  let bridgeCalls = 0;
  const resolver = audio.createAudioSourceResolver({
    now: () => 1_000_000,
    fetcher: async () => ({ ok: true, status: 200, json: () => ({}) }),
    bridge: { call: async () => { bridgeCalls += 1; return { ok: true, url: 'http://m802.music.126.net/a.mp3', kind: 'mp3' } } },
  });
  await resolver.resolve({ provider: 'netease', mediaId: '1997438791' });
  await resolver.resolve({ provider: 'netease', mediaId: '1997438791' });
  assert.equal(bridgeCalls, 1, '第二次命中缓存');
  assert.equal(audio.AUDIO_SOURCE_TTL_MS, 5 * 60 * 1000, '签名 URL 会过期：缓存窗口要短到能重来，又要长到拖动不重问');
  // 失败不进缓存：否则一次抖动就把这首歌锁死 5 分钟。
  // 这里必须数**真的调用次数**——只数"两次都返回 ok:false"是条无效断言（缓存了失败也照样返回 ok:false）。
  let qqCalls = 0;
  const flaky = audio.createAudioSourceResolver({
    fetcher: async () => {
      qqCalls += 1;
      return { ok: true, status: 200, json: () => ({ request: { data: { sip: [], midurlinfo: [] } } }) };
    },
    bridge: { call: async () => ({ ok: true }) },
  });
  for (let index = 0; index < 2; index += 1) {
    assert.equal((await flaky.resolve({ provider: 'qq', mediaId: '00245tac3U4PcI' })).ok, false, '两次解析都该如实报没有音源');
  }
  assert.equal(qqCalls, audio.AUDIO_QUALITY_ORDER.length * 2,
    '失败不留缓存：三档降级 × 两次解析都要真的去问；缓存了失败就等于把这首歌锁死 5 分钟');
  assert.equal((await flaky.resolve({ provider: 'qq', mediaId: '' })).ok, false, '空 id 直接拒');
});

// ── ③ 路由：/api/online/stream 的 Range 语义与不落盘 ──────────────────────────

const headersOf = (value) => new Headers(value);

test('/api/online/stream：客户端 Range 透传给上游，206 的头照上游给的不自己算（上游 200 时不伪装成 206）', async () => {
  const seen = [];
  const upstream = (status, headers, text) => ({
    // 假上游的 content-length 必须等于真正吐出的字节数：声明 480813 只给 64 字节的话，
    // fetch 会一直等剩下的那些——那是夹具自己的坑，不是被测代码的问题。
    ok: status < 400, status, headers: headersOf({ 'content-length': String(text.length), ...headers }),
    body: { [Symbol.asyncIterator]: async function* () { yield Buffer.from(text) } },
  });
  const cases = [
    // ① 客户端要单段，上游给 206：转 206，content-range / content-length 用上游的原值。
    { range: 'bytes=100-199', upstream: () => upstream(206, { 'content-range': 'bytes 100-199/480813', 'accept-ranges': 'bytes' }, 'x'.repeat(100)), expect: { status: 206, cr: 'bytes 100-199/480813', len: '100', ar: 'bytes' } },
    // ② 客户端要 suffix（尾巴），上游自己换算：我们不做二次解释。
    { range: 'bytes=-2048', upstream: () => upstream(206, { 'content-range': 'bytes 478765-480812/480813' }, 'y'.repeat(2048)), expect: { status: 206, cr: 'bytes 478765-480812/480813', len: '2048' } },
    // ③ 上游不支持 Range 回了整段 200：**照 200 转**，绝不写成 206（那是欺骗内核）。
    { range: 'bytes=0-1023', upstream: () => upstream(200, { 'accept-ranges': 'bytes' }, 'z'.repeat(64)), expect: { status: 200, cr: null, len: '64' } },
    // ④ 客户端没发 Range：200 整段。
    { range: null, upstream: () => upstream(200, {}, 'w'.repeat(32)), expect: { status: 200, cr: null, len: '32' } },
    // ⑤ 越界：上游 416（实测网易给 416 + 31 字节 text/plain）。转 416 但**不把那段正文发给内核**。
    { range: 'bytes=99999999999-', upstream: () => upstream(416, { 'content-type': 'text/plain' }, 'the requested range is bad'), expect: { status: 416, cr: 'bytes */480813', len: '0' } },
  ];
  for (const item of cases) {
    const result = await streamCall(item);
    assert.equal(result.status, item.expect.status, JSON.stringify(item.expect));
    if (item.expect.cr !== undefined) assert.equal(result.headers['content-range'] ?? null, item.expect.cr, 'content-range ' + item.expect.status);
    if (item.expect.len !== undefined) assert.equal(result.headers['content-length'] ?? null, item.expect.len);
    if (item.expect.ar !== undefined) assert.equal(result.headers['accept-ranges'] ?? null, item.expect.ar);
    assert.equal(result.headers['cache-control'], 'no-store', '不缓存是"不下载"红线的另一面');
    // 四种回法都要带 Accept-Ranges：本地 /api/audio 就是这么回的（真机逐条对过），
    // 少一档的话内核在浏览器里看到的能力声明会随状态码变——V7 说的"同口径"要精确到头字段。
    assert.equal(result.headers['accept-ranges'], 'bytes', `accept-ranges 在 ${item.expect.status} 那档也要有`);
    if (item.expect.status === 416) assert.equal(result.body, '', '416 的正文是上游的错误说明，不是音频');
  }
  // 透传的那一笔：Range 确实进了上游的请求头。
  const first = await streamCall(cases[0]);
  assert.equal(first.upstreamRange, 'bytes=100-199');
  assert.equal(first.contentType, 'audio/mpeg', 'content-type 用 provider 报的类型，不用上游的 application/octet-stream（网易 CDN 实测就是这个值）');

  async function streamCall(item) {
    const streamFetcher = async (target, options = {}) => {
      seen.push({ target, headers: options.headers ?? {} });
      return item.upstream();
    };
    const { server, origin } = await routeServer({
      streamFetcher,
      audioSource: { resolve: async () => ({ ok: true, url: 'https://m802.music.126.net/a.mp3', kind: 'mp3', size: 480813 }) },
    });
    const response = await fetch(`${origin}/api/online/stream?p=netease&id=1997438791`, item.range ? { headers: { range: item.range } } : {});
    const body = await response.text();
    server.closeAllConnections(); await new Promise((resolve) => server.close(resolve));
    return {
      status: response.status, headers: Object.fromEntries(response.headers.entries()), body,
      contentType: response.headers.get('content-type'),
      upstreamRange: seen[seen.length - 1].headers.range ?? null,
    };
  }
});

test('/api/online/stream：参数、方法、开关与音源/桥的失败各有各自的码，且都不出网', async () => {
  const fetches = [];
  const guard = async (target, options) => { fetches.push(target); return { ok: true, status: 200, headers: headersOf({ 'content-length': '1' }), body: { [Symbol.asyncIterator]: async function* () { yield Buffer.from('a') } } } };
  const cases = [
    { path: '/api/online/stream', expect: 400, note: '缺参数' },
    { path: '/api/online/stream?p=spotify&id=1', expect: 400, note: 'provider 不在集合里' },
    { path: '/api/online/stream?p=qq&id=../etc/passwd', expect: 400, note: 'id 形状不对' },
    { path: '/api/online/stream?p=qq&id=' + 'a'.repeat(65), expect: 400, note: 'id 过长' },
    { path: '/api/online/stream?p=netease&id=1997438791', method: 'POST', expect: 405, note: '只接受 GET/HEAD' },
  ];
  const { origin, close } = await routeServer({ streamFetcher: guard, audioSource: { resolve: async () => ({ ok: true, url: 'https://m802.music.126.net/a.mp3', kind: 'mp3' }) } });
  for (const item of cases) {
    const response = await fetch(origin + item.path, { method: item.method ?? 'GET' });
    assert.equal(response.status, item.expect, `${item.note}：${item.path}`);
    await response.text();                     // 不读完正文会留一条挂着的连接，测试进程就退不出去（真踩过）
  }
  assert.deepEqual(fetches, [], '以上任何一条都不该发过一次上游请求');
  await close();
  // 音源取不到 ⇒ 502 + 可读原因；桥没起来 ⇒ 503 + "重试/稍后"的措辞（与歌词那档一致）。
  const noSource = await routeServer({ streamFetcher: guard, audioSource: { resolve: async () => ({ ok: false, reason: '这首没有可用的免费音源' }) } });
  let response = await fetch(`${noSource.origin}/api/online/stream?p=qq&id=00245tac3U4PcI`);
  assert.equal(response.status, 502);
  assert.match((await response.json()).error, /免费音源/);
  response = await fetch(`${noSource.origin}/api/online/stream?p=qq&id=00245tac3U4PcI`, { method: 'HEAD' });
  assert.equal(response.status, 502, 'HEAD 与 GET 同码：内核探测时不能看到另一套结论');
  await noSource.close();
  const bridgeDown = await routeServer({ streamFetcher: guard, audioSource: { resolve: async () => ({ ok: false, via: 'bridge', reason: 'netease-down' }) } });
  response = await fetch(`${bridgeDown.origin}/api/online/stream?p=netease&id=1`);
  assert.equal(response.status, 503, '桥没起来是"我们这一侧没就绪"，不是"上游坏了"');
  await response.text();
  await bridgeDown.close();
});

test('streaming 开关关掉 ⇒ 路由 404、零取址、零上游请求（关着零暴露）', async () => {
  const fetches = [];
  const resolves = [];
  const { server, origin, close } = await routeServer({
    config: { online: { lyrics: true, search: true, streaming: false, covers: true } },
    streamFetcher: async (target) => { fetches.push(target); throw new Error('关掉之后不该走到这一步') },
    audioSource: { resolve: async (query) => { resolves.push(query); return { ok: true, url: 'https://m802.music.126.net/a.mp3' } } },
  });
  const response = await fetch(`${origin}/api/online/stream?p=netease&id=1997438791`, { headers: { range: 'bytes=0-1' } });
  assert.equal(response.status, 404);
  assert.match((await response.json()).error, /在线试听已关闭/);
  assert.deepEqual(fetches, [], '零上游请求');
  assert.deepEqual(resolves, [], '零次音源取址（一次出网都不该有）');
  await close();
});

test('关掉之后再打开：同一份服务里路由恢复可用，不因为关过一次就永久失效（开关是 getter 的实测兑现）', async () => {
  const resolves = [];
  const { origin, close, store } = await routeServer({
    config: { online: { lyrics: true, search: true, streaming: false, covers: true } },
    streamFetcher: async () => ({ ok: true, status: 200, headers: headersOf({ 'content-length': '3' }), body: { [Symbol.asyncIterator]: async function* () { yield Buffer.from('abc') } } }),
    audioSource: { resolve: async (query) => { resolves.push(query); return { ok: true, url: 'https://m802.music.126.net/a.mp3', kind: 'mp3' } } },
  });
  assert.equal((await fetch(`${origin}/api/online/stream?p=netease&id=1`)).status, 404);
  await store.updateConfig({ ...store.config, online: { ...store.config.online, streaming: true } });
  const reopened = await fetch(`${origin}/api/online/stream?p=netease&id=1`);
  assert.equal(reopened.status, 200, '重新勾选之后立刻生效：服务端读的是当前 config，不是建服务那一刻的快照');
  assert.equal(await reopened.text(), 'abc');
  assert.equal(resolves.length, 1);
  await close();
});

test('音频字节不落盘：路由与取址两侧都只碰内存（V6 的静态一半，动态一半在浏览器取证）', async () => {
  const src = await readScript('music-server.mjs');
  const start = src.indexOf("'/api/online/stream'");
  const end = src.indexOf("const audio = /^\\/api\\/audio", start);
  assert.ok(start > 0 && end > start, '没抓到流式路由那一段（起止锚点都要在）');
  const route = src.slice(start, end);
  for (const banned of ['writeFile', 'createWriteStream', 'appendFile', 'fs.open']) {
    assert.ok(!route.includes(banned), `流式路由里出现了 ${banned}：音频落盘就是"不下载"红线的反面`);
  }
  assert.match(route, /\.pipe\(|pipeline\(/, '上游 body 是管道到响应，不是先收进内存再写');
  const resolver = await readScript('online-audio-source.mjs');
  assert.doesNotMatch(resolver, /writeFile|createWriteStream/, '取址层也不写盘（签名 URL 只在内存缓存里）');
  // 缓存是**内存**的，且必须有条目上限：一次会话听几百首不能把进程撑爆。
  assert.match(resolver, /AUDIO_SOURCE_CACHE_LIMIT/, '取址缓存有上限');
  assert.match(resolver, /delete |\.clear\(/, '超限要淘汰，而不是无限增长');
});

test('在线曲目的内核接线：远程 src 优先、不可播判定不误伤本地判据、错误文案分叉', async () => {
  const player = await read('src/music-player.ts');
  assert.match(player, /track\.audioUrl \?\? `\/api\/audio\/\$\{encodeURIComponent\(track\.id\)\}`/, '远程曲目用 audioUrl，本地曲目仍走 /api/audio');
  assert.match(player, /sourceKind === "online"/, '在线曲目走自己的分支');
  const types = await read('src/music-types.ts');
  for (const field of ['sourceKind', 'audioUrl', 'provider']) {
    assert.match(types, new RegExp(`\\b${field}\\??:`), `MusicTrack 缺 ${field}`);
  }
  assert.match(types, /sourceKind\??: "local" \| "online"/, '两种来源，缺省是本地');
  // 错误文案分叉：在线失败不能说"本地音乐服务未启动"。
  assert.match(player, /在线.*(试听|播放).*(失败|不可用)/, '要有一句在线专用的失败文案');
  // 不可播判定的分叉必须**在前**：在线曲目没有本地扩展名，那套按扩展名/DSF 的判据对它无意义。
  const unsupportedAt = player.indexOf('private unsupported(');
  const onlineFork = player.indexOf('sourceKind === "online"', unsupportedAt);
  assert.ok(unsupportedAt >= 0 && onlineFork > unsupportedAt, 'unsupported() 里要有在线分支');
  assert.ok(player.indexOf('DSD|DSF|DFF', unsupportedAt) > onlineFork, '在线分支排在本地判据**之前**（否则先被 format 误伤）');
  assert.match(player, /audio\.src = track\.audioUrl \?\? `\/api\/audio\//, 'audio.src 那一行自己就要带 audioUrl 优先，不能指望调用方提前改写 track');
});

test('出网审计面板认得流式这一档：kind 与桥路由都有中文用途名（"UI 标明来源"红线在这一条上的兑现）', async () => {
  const app = await read('src/music-app.ts');
  const labels = /const ONLINE_AUDIT_KIND_LABELS[\s\S]*?\n};/.exec(app)?.[0] ?? '';
  assert.ok(labels.length > 100, '没抓到审计用途表');
  assert.match(labels, /stream: "在线试听"/, 'guard 那一侧的 kind=stream 要有用途名');
  assert.match(labels, /"\/bridge\/audio-source": "音源取址/, '桥的音源路由报的 kind 是路径，必须翻译成中文（否则面板里出现一行 /bridge/…）');
  // 取址层自己也要带用途名：这一笔在面板上归到哪一档就是由它定的，落到"未标注用途"等于没说。
  const resolver = await readScript('online-audio-source.mjs');
  assert.match(resolver, /kind: 'audio'/, 'QQ 的 vkey 调用要带自己的用途名');
});

// ── 共享夹具：只起真实 music-server，注入假桥 / 假取址 / 假串流 ────────────────

async function routeServer({ config, audioSource, streamFetcher } = {}) {
  delete process.env.MUSICBRAINZ_CONTACT;
  const { createMusicServer } = await import('./music-server.mjs');
  const { MusicLibraryStore } = await import('./music-library.mjs');
  const os = await import('node:os');
  const fs = await import('node:fs/promises');
  const path = await import('node:path');
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'rhine-stream-'));
  const rootsDir = await fs.mkdtemp(path.join(os.tmpdir(), 'rhine-stream-roots-'));
  const store = await new MusicLibraryStore({ dataDir, defaultRoots: [rootsDir] }).init();
  if (config) await store.updateConfig({ ...store.config, ...config });
  const bridge = {
    status: () => ({ phase: 'ready', port: 1, backends: [], unauthorized: 0, restarts: 0, lastError: null, hosts: ['netease', 'kugou'] }),
    call: async () => ({ ok: false, reason: '不该被调用' }), ensure: async () => {}, shutdown: async () => {},
  };
  const { server } = await createMusicServer({
    store, distDir: SCRIPTS, autoScan: false, bridgeClient: bridge,
    onlineLyricsMatcher: { match: async () => ({ matched: false }), clearCache: () => {} },
    onlineAudioSource: audioSource ?? { resolve: async () => ({ ok: false, reason: '未配置' }) },
    onlineStreamFetcher: streamFetcher ?? (async () => { throw new Error('不该走到这里') }),
  });
  // R211（A 类第 8 处）：`close` 先定义好，再让"等服务起来"进 try —— 从前探测一抛就没人调用它（服务与两个临时目录一起漏）。
  const close = async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    await fs.rm(dataDir, { recursive: true, force: true });
    await fs.rm(rootsDir, { recursive: true, force: true });
  };
  let origin;
  try {
    ({ origin } = await listenAndReady(server));   // R198：连不上就关掉这台、换个端口重听
  } catch (error) {
    await close();
    throw error;
  }
  return { server, origin, store, close, dataDir };
}

// ── M3-b：登录取流 + 试听/完整标注 ────────────────────────────────────────────
const AUDIO_COOKIE = 'MUSIC_U=m3b-' + '7Kq2p9Lm4xR8t1YwScan';

test('M3-b：网易取址带凭据时走 Cookie 请求头，不走查询串（查询串会进包自己的访问日志行）', async () => {
  const { registerAudioRoutes, ncmAudioPayloadToSource } = await import('./bridge/audio-routes.mjs');
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    calls.push({ url: String(url), headers: init?.headers ?? {} });
    return { status: 200, text: async () => JSON.stringify({ code: 200, data: [{ id: 1, url: 'http://m702.music.126.net/x.mp3', type: 'mp3', size: 9, fee: 1 }] }) };
  };
  const routes = new Map();
  registerAudioRoutes({ routes, backends: { netease: { state: 'ready', baseUrl: 'http://127.0.0.1:9' } }, fetchImpl });
  const route = (payload) => routes.get('/bridge/audio-source')(payload, { emit: () => {} });
  const authed = await route({ provider: 'netease', mediaId: '1', cookie: AUDIO_COOKIE });
  assert.equal(authed.ok, true);
  assert.equal(calls[0].headers.cookie, AUDIO_COOKIE, '凭据在头里');
  assert.equal(calls[0].url.includes('cookie=') || calls[0].url.includes(AUDIO_COOKIE), false, 'URL 里一个字都不带');
  const anon = await route({ provider: 'netease', mediaId: '1' });
  assert.equal(anon.ok, true);
  assert.deepEqual(calls[1].headers, {}, '匿名取址不发一个空的 cookie 头（行为与今天逐字一致）');
  assert.equal(authed.scope, 'full', '有链接且没有 freeTrialInfo ⇒ 完整播放');
  assert.equal(ncmAudioPayloadToSource({ code: 200, data: [{ url: 'http://m/x.mp3', freeTrialInfo: { end: 30 } }] }).scope, 'trial');
  assert.equal(ncmAudioPayloadToSource({ code: 200, data: [{ url: 'http://m/x.mp3', freeTrialInfo: { end: 30 } }] }).trial.end, 30, '试听秒数照上游给的说，不自己写 30');
  assert.equal(ncmAudioPayloadToSource({ code: 200, data: [] }).scope, undefined, '没链接就没有 scope：那是"没有音源"，不是"试听"');
});

test('M3-b：登录态进缓存键（登录后不吃匿名 30 秒地址），但键与日志里都不出现凭据本身', async () => {
  const seen = [];
  const makeBridge = () => ({
    call: async (route, payload) => {
      seen.push(payload);
      return { ok: true, url: `http://m802.music.126.net/${payload.cookie ? 'authed' : 'anon'}.mp3`, kind: 'mp3', size: 100, scope: payload.cookie ? 'full' : 'trial', ...(payload.cookie ? {} : { trial: { end: 30 } }) };
    },
  });
  let clock = 1_000;
  let loggedIn = false;
  const resolver = audio.createAudioSourceResolver({
    bridge: makeBridge(),
    now: () => clock,
    credentialsFor: async () => (loggedIn ? { cookie: AUDIO_COOKIE } : {}),
  });
  const anon = await resolver.resolve({ provider: 'netease', mediaId: '42' });
  loggedIn = true;                                        // 就在这一行之间登录了
  const authed = await resolver.resolve({ provider: 'netease', mediaId: '42' });
  assert.equal(seen.length, 2, '匿名与登录是两份缓存：命中同一把键就会登录后还吃 30 秒');
  assert.equal(anon.scope, 'trial');
  assert.equal(authed.scope, 'full');
  assert.equal(JSON.stringify(seen[1]).includes(AUDIO_COOKIE), true, '桥那一跳确实要拿到凭据（不然取不到整首）');
  assert.equal(JSON.stringify(seen[0]).includes(AUDIO_COOKIE), false, '匿名那一跳不该带凭据字段');
  const cachedAgain = await resolver.resolve({ provider: 'netease', mediaId: '42' });
  assert.equal(cachedAgain.cached, true, '同一登录态第二次命中缓存：每拖一次进度条都重问音源是不能接受的');
  assert.equal(seen.length, 2);
  const keys = JSON.stringify([...(resolver.cacheKeys?.() ?? [])]);
  assert.equal(keys.includes(AUDIO_COOKIE), false, '缓存键里只放凭据的短摘要，不放凭据本身（自检会打印键）');
});

test('M3-b：不注入凭据取用口时解析器行为逐字不变（匿名路径零变化）', async () => {
  const seen = [];
  const resolver = audio.createAudioSourceResolver({
    bridge: { call: async (route, payload) => { seen.push(payload); return { ok: true, url: 'http://m802.music.126.net/a.mp3', kind: 'mp3', size: 9 } } },
  });
  const result = await resolver.resolve({ provider: 'netease', mediaId: '1997438791' });
  assert.equal(result.ok, true);
  assert.deepEqual(seen[0], { provider: 'netease', mediaId: '1997438791' }, 'payload 里连一个多余的键都不该多');
});

test('R108：QQ 登录取流经桥那一条——token 与密钥一起交桥、失败降回匿名老路、两份缓存互不串', async () => {
  const QQ_TOKEN = ['qT7k', 'm2Lp', '9Zx4', 'Rbvn'].join('');   // 拼出来写：这文件自己会被凭据字面量扫描扫
  const QQ_KEY = ['sK3d', 'vB8n', '2mQa', '7LpT'].join('');
  const bridge = [];
  // 桥那一档给不给地址是可切换的：给 ⇒ 直接用；不给 ⇒ 必须降回今天那条匿名 fcg 老路。
  let bridgeAnswers = { ok: true, url: 'http://aqqmusic.tc.qq.com/m8000021m4EZ2aVqcZ0033.mp3' };
  const resolver = audio.createAudioSourceResolver({
    bridge: { call: async (route, payload) => { bridge.push({ route, payload }); return bridgeAnswers; } },
    fetcher: async () => ({ ok: true, status: 200, json: () => ({ request: { data: { sip: ['aqqmusic.tc.qq.com'], midurlinfo: [{ purl: 'm500anonymous.mp3' }] } } }) }),
    credentialsFor: async (provider) => (provider === 'qq' ? { token: QQ_TOKEN, secret: QQ_KEY } : {}),
  });
  const result = await resolver.resolve({ provider: 'qq', mediaId: '0021m4EZ2aVqcZ', mediaMid: '0033' });
  assert.equal(result.ok, true);
  assert.equal(result.url, 'https://aqqmusic.tc.qq.com/m8000021m4EZ2aVqcZ0033.mp3', '出桥的 http 地址在父进程出口这一侧升 https');
  assert.equal(result.kind, 'mp3');
  assert.equal(result.scope, undefined, 'QQ 登录这一档**没有** scope：包的地址表不带试听标记，而界面上「试听/完整」的判据只准来自取址结果 ⇒ 不编，让界面显示"播放范围未知"');
  assert.equal(bridge.length, 1);
  assert.equal(bridge[0].route, '/bridge/auth', 'QQ 的鉴权取址走登录那条门（密钥、守卫出网、包句柄只在那里齐备）');
  assert.equal(bridge[0].payload.action, 'play');
  assert.equal(bridge[0].payload.token, QQ_TOKEN, '会话交给桥的方式与 account 那一路同一条：payload 里带，父进程不落桥侧文件');
  assert.equal(bridge[0].payload.secret, QQ_KEY, '解封用的密钥一起带：包没它时所有登录路由直接回 501');
  assert.equal(bridge[0].payload.songmid, '0021m4EZ2aVqcZ');
  assert.equal(bridge[0].payload.mediaMid, '0033', 'mediaMid 要带：只送一段文件名 vkey 会给 purl 而 CDN 端 403');
  const keys = JSON.stringify(resolver.cacheKeys());
  assert.equal(keys.includes(QQ_TOKEN), false, '缓存键里只有摘要：键会被自检打印出来');
  assert.equal(keys.includes(QQ_KEY), false, '密钥更不许进键');
  // ② 桥说"这首没有可播文件" ⇒ 降回匿名老路。这一条是"不许因为登录反而播不出来"：
  //    免费曲今天匿名通道给得了，登录那一问空手而归时必须还能拿到它。
  bridgeAnswers = { ok: false, reason: 'QQ 说这首没有可播文件：暂无播放链接（这个账号可能没有它的播放权益）' };
  const fell = await audio.createAudioSourceResolver({
    bridge: { call: async () => bridgeAnswers },
    fetcher: async () => ({ ok: true, status: 200, json: () => ({ request: { data: { sip: ['aqqmusic.tc.qq.com'], midurlinfo: [{ purl: 'm500anonymous.mp3' }] } } }) }),
    credentialsFor: async () => ({ token: QQ_TOKEN, secret: QQ_KEY }),
  }).resolve({ provider: 'qq', mediaId: '0021m4EZ2aVqcZ' });
  assert.equal(fell.ok, true, '登录那一问没给 ⇒ 匿名老路照常给得到（不能因为"登录了"就判这首歌没音源）');
  assert.equal(fell.url, 'https://aqqmusic.tc.qq.com/m500anonymous.mp3');
  // ③ 两条路都空 ⇒ 原因里要留下"带登录态问过"的痕迹，否则文案会把"这个账号也没权益"
  //    写成"没登录所以不行"，把用户指向错误的下一步。
  const both = await audio.createAudioSourceResolver({
    bridge: { call: async () => ({ ok: false, reason: '这首没有可播文件' }) },
    fetcher: async () => ({ ok: true, status: 200, json: () => ({ request: { data: { sip: ['aqqmusic.tc.qq.com'], midurlinfo: [{ purl: '' }] } } }) }),
    credentialsFor: async () => ({ token: QQ_TOKEN, secret: QQ_KEY }),
  }).resolve({ provider: 'qq', mediaId: '0021m4EZ2aVqcZ' });
  assert.equal(both.ok, false);
  assert.match(both.reason, /带着登录态问过/, '两条都空的时候要说清问过几次');
  assert.match(both.reason, /这首没有可播文件/, '而上游给的那句原因要留在文案里，不能只留我们自己的模板话');
  // ④ 没登录（取用口给不出 token）⇒ 桥一次都不该被叫，行为与今天逐字一致。
  const quiet = [];
  const anon = await audio.createAudioSourceResolver({
    bridge: { call: async (route, payload) => { quiet.push(payload); return { ok: true, url: 'https://m802.music.126.net/a.mp3' } } },
    fetcher: async () => ({ ok: true, status: 200, json: () => ({ request: { data: { sip: ['aqqmusic.tc.qq.com'], midurlinfo: [{ purl: 'm500x.mp3' }] } } }) }),
    credentialsFor: async () => ({}),
  }).resolve({ provider: 'qq', mediaId: '0021m4EZ2aVqcZ' });
  assert.equal(anon.ok, true);
  assert.equal(quiet.length, 0, '没有会话时不发登录取流那一问：发一次就是一次没必要的出网');
  // ⑤ 只有 token 没有密钥（或反之）⇒ 判"没登录"，不发那一问。两样都齐才是可用的登录态。
  const half = [];
  await audio.createAudioSourceResolver({
    bridge: { call: async (route, payload) => { half.push(payload); return { ok: false } } },
    fetcher: async () => ({ ok: true, status: 200, json: () => ({ request: { data: { sip: ['aqqmusic.tc.qq.com'], midurlinfo: [{ purl: 'm500y.mp3' }] } } }) }),
    credentialsFor: async () => ({ token: QQ_TOKEN }),
  }).resolve({ provider: 'qq', mediaId: '0021m4EZ2aVqcZ' });
  assert.equal(half.length, 0, '缺一样就不算登录态：半份凭据发出去只会换回一个 501');
  // ⑥ R101 那条不变量推广到 QQ：**登录态要进缓存键**。不这么做的后果是具体的——
  //    登录后取到的地址会在退出之后继续被喂 5 分钟（拿着上一个账号的权益播 = 越权）。
  //    这个形状 M3-b 在网易那侧是真机反证过的，QQ 这一侧在同一台取址器实例上验：退出要换一把键。
  let qqLoggedIn = true;
  const shared = audio.createAudioSourceResolver({
    bridge: { call: async () => (qqLoggedIn ? { ok: true, url: 'http://aqqmusic.tc.qq.com/m800logged-in.mp3' } : { ok: false, reason: '本机没有 QQ 会话' }) },
    fetcher: async () => ({ ok: true, status: 200, json: () => ({ request: { data: { sip: ['aqqmusic.tc.qq.com'], midurlinfo: [{ purl: 'm500logged-out.mp3' }] } } }) }),
    credentialsFor: async () => (qqLoggedIn ? { token: QQ_TOKEN, secret: QQ_KEY } : {}),
  });
  const whileLoggedIn = await shared.resolve({ provider: 'qq', mediaId: '0021m4EZ2aVqcZ' });
  assert.equal(whileLoggedIn.url, 'https://aqqmusic.tc.qq.com/m800logged-in.mp3');
  qqLoggedIn = false;                                       // 就在这一行之间退出了登录
  const afterLogout = await shared.resolve({ provider: 'qq', mediaId: '0021m4EZ2aVqcZ' });
  assert.equal(afterLogout.cached, undefined, '退出后不许命中登录那一份缓存');
  assert.equal(afterLogout.url, 'https://aqqmusic.tc.qq.com/m500logged-out.mp3', '退出后按匿名重取一次');
  assert.equal(shared.cacheSize(), 2, '登录与退出是两把键：一把键装不下两种权益');
  const qqKeyShape = shared.cacheKeys().find((key) => !key.endsWith(':anon'));
  assert.match(qqKeyShape.split(':').pop(), /^[0-9a-f]{12}$/, '带登录态那把键的键尾是 12 位十六进制摘要（不是凭据本身，键会被自检打印出来）');
});

test('R108：桥带回的 QQ 地址仍要过出口那道白名单——白名单外等于没有地址', () => {
  assert.equal(audio.qqAuthedAudioFrom({ url: 'https://evil.test/a.mp3' }), null, '不收在出口处等于没收（与网易那一条同一道关）');
  assert.equal(audio.qqAuthedAudioFrom({ url: 'http://aqqmusic.tc.qq.com/m800a.mp3' }).url, 'https://aqqmusic.tc.qq.com/m800a.mp3');
  assert.equal(audio.qqAuthedAudioFrom({ url: 'ws301.stream.qqmusic.qq.com/C400a.m4a' }).kind, 'm4a', 'sip 不带 scheme 也要能认（Task 6 实测就是这么给的）');
  assert.equal(audio.qqAuthedAudioFrom({}), null, '没有 url 就是没有地址，不是"地址是空串"');
  assert.equal(audio.qqAuthedAudioFrom({ url: 'not a url' }), null);
});

test('M3-b：POST /api/online/audio-scope 回播放范围，响应里没有签名地址；本地 id / 关闭 / 方法错各有各的码', async () => {
  const resolved = { ok: true, provider: 'netease', url: 'https://m802.music.126.net/x.mp3?sign=SECRET', kind: 'mp3', size: 9, scope: 'trial', trial: { end: 30 }, fee: 1 };
  const asked = [];
  const { origin, close } = await routeServer({
    audioSource: { resolve: async (query) => { asked.push(query); return resolved } },
  });
  try {
    const post = (body) => fetch(`${origin}/api/online/audio-scope`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    const hit = await (await post({ trackId: 'on-netease-1997438791' })).json();
    assert.deepEqual(hit, { trackId: 'on-netease-1997438791', ok: true, scope: 'trial', trialSeconds: 30, fee: 1 }, '形状就是界面要的那几项');
    assert.equal(JSON.stringify(hit).includes('SECRET'), false, '签名地址不许回给浏览器（有效期与第三方入口都在里面）');
    assert.equal(JSON.stringify(hit).includes('m802.music.126.net'), false, '连主机都不该回：播放走本机 /api/online/stream 中转');
    assert.deepEqual(asked[0], { provider: 'netease', mediaId: '1997438791', mediaMid: '' }, 'id 拆回 provider + mediaId');
    const mid = await (await post({ trackId: 'on-qq-123-mid456' })).json();
    assert.equal(mid.ok, true);
    assert.deepEqual(asked[1], { provider: 'qq', mediaId: '123', mediaMid: 'mid456' }, 'QQ 的 mediaMid 也要拆出来（vkey 要两个标识）');
    const local = await post({ trackId: 'album-1-track-2' });
    assert.equal(local.status, 400, '本地曲目不需要问播放范围');
    const wrongMethod = await fetch(`${origin}/api/online/audio-scope`);
    assert.equal(wrongMethod.status, 405);
  } finally { await close() }
  const { origin: offOrigin, close: offClose } = await routeServer({
    config: { online: { lyrics: true, search: true, streaming: false, covers: true } },
    audioSource: { resolve: async () => { throw new Error('关掉状态下不该解析音源') } },
  });
  try {
    const off = await fetch(`${offOrigin}/api/online/audio-scope`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"trackId":"on-netease-1"}' });
    assert.equal(off.status, 404, '关掉在线试听 ⇒ 这一档随之消失（关着零暴露）');
  } finally { await offClose() }
});

// ── R141 音源回落：主源说"没有可播文件"时，去其余源找同名曲，只有整首才采用 ──────────

/** QQ 匿名三档全空的响应（实测付费曲就是空 purl）⇒ 这一档必须被分类成 unavailable。 */
const qqEmptyFetcher = async () => ({ ok: true, status: 200, json: () => ({ request: { code: 0, data: { sip: ['aqqmusic.tc.qq.com'], midurlinfo: [{ purl: '' }] } } }) });

test('R141 回落跑通：QQ 说没有可播文件 ⇒ 用曲名歌手在网易找到同名曲、拿到整首，并按原来那把键进缓存', async () => {
  const searched = [];
  const bridgeCalls = [];
  const resolver = audio.createAudioSourceResolver({
    fetcher: qqEmptyFetcher,
    bridge: { call: async (route, payload) => { bridgeCalls.push(payload); return { ok: true, url: 'http://m802.music.126.net/full.mp3', kind: 'mp3', size: 9, scope: 'full' } } },
    search: async (query) => {
      searched.push(query);
      return { ok: true, items: [{ provider: 'netease', mediaId: '28059417', title: '他不懂', artist: '张杰', album: '爱，不解释', durationMs: 232213 }] };
    },
  });
  const identity = { title: '他不懂', artist: '张杰', durationMs: 232213 };
  const result = await resolver.resolve({ provider: 'qq', mediaId: '002CtuAm1i0pI3', mediaMid: '003x', identity });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.provider, 'netease', '声音实际来自网易 ⇒ provider 要说实话，不许还写 qq');
  assert.equal(result.scope, 'full');
  assert.equal(result.url, 'https://m802.music.126.net/full.mp3', '出桥的 http 仍升 https（同一条老规矩）');
  assert.deepEqual({ from: result.fallback.from, to: result.fallback.to }, { from: 'qq', to: 'netease' });
  assert.equal(searched.length, 1);
  assert.equal(searched[0].provider, 'netease', '只问"其余源"：不再问一遍刚说没有的那家');
  assert.equal(searched[0].query, '他不懂 张杰', '检索串就是曲名 + 歌手');
  assert.equal(searched[0].limit, 10, '回落只问一页：这不是把整站搜一遍');
  const again = await resolver.resolve({ provider: 'qq', mediaId: '002CtuAm1i0pI3', mediaMid: '003x', identity });
  assert.equal(again.cached, true, '回落结果按**原来那把键**进缓存（徽标查过之后取流不该再问一遍）');
  assert.equal(searched.length, 1, '第二次不许再检索');
  // R222：键里多了一段"专辑提示"（恒为 `-`，除非那一格是带专辑参数的酷狗曲）⇒ 形状变了、要求没变：
  // 仍是两把键、仍不许出现凭据（下面那条断言仍在）。
  assert.deepEqual(resolver.cacheKeys().sort(), ['netease:28059417::-:anon', 'qq:002CtuAm1i0pI3:003x:-:anon'],
    '两把键：回落自己那条也进缓存（下次直接播这首网易曲就省一次取址），而**原来那把键必须有**——徽标与取流认的是它');
});

test('R141 三种"不许回落"：非 unavailable 的失败、没给身份、没接检索 ⇒ 一律零检索', async () => {
  let searches = 0;
  const identity = { title: '他不懂', artist: '张杰', durationMs: 232213 };
  // ① 桥没起来（`via:'bridge'`）：那是通道坏了，换源也还是坏的，而且会把一次抖动变成额外出网
  const down = await audio.createAudioSourceResolver({
    bridge: { call: async () => ({ ok: false, reason: 'netease-down' }) },
    search: async () => { searches += 1; return { ok: true, items: [] } },
  }).resolve({ provider: 'netease', mediaId: '1', identity });
  assert.equal(down.via, 'bridge');
  assert.equal(searches, 0, '通道类失败不许触发回落');
  assert.equal(down.fallbackTried, undefined, '没回落就不该有这一格');
  // ② 没给身份 ⇒ 行为与今天逐字一致（原话、无回落标记、零检索）
  searches = 0;
  const noIdentity = await audio.createAudioSourceResolver({ fetcher: qqEmptyFetcher, search: async () => { searches += 1; return { ok: true, items: [] } } })
    .resolve({ provider: 'qq', mediaId: '002CtuAm1i0pI3' });
  assert.equal(noIdentity.ok, false);
  assert.match(noIdentity.reason, /这首没有可用的免费音源/);
  assert.equal(searches, 0, '没带身份就不去猜着搜');
  // ③ 没接检索口（默认 null）⇒ 同样零回落
  const noSearch = await audio.createAudioSourceResolver({ fetcher: qqEmptyFetcher }).resolve({ provider: 'qq', mediaId: 'x', identity });
  assert.equal(noSearch.ok, false);
  assert.equal(noSearch.fallbackTried, undefined, '没有检索能力时连"回落问过"都不该说');
});

test('R141 只认整首：另一家只给 30 秒试听时不采用，原话保留并补一句"回落也没找到"', async () => {
  const resolver = audio.createAudioSourceResolver({
    fetcher: qqEmptyFetcher,
    bridge: { call: async () => ({ ok: true, url: 'http://m802.music.126.net/t.mp3', kind: 'mp3', scope: 'trial', trial: { end: 30 } }) },
    search: async () => ({ ok: true, items: [{ provider: 'netease', mediaId: '28059417', title: '他不懂', artist: '张杰', durationMs: 232213 }] }),
  });
  const result = await resolver.resolve({ provider: 'qq', mediaId: '002CtuAm1i0pI3', identity: { title: '他不懂', artist: '张杰', durationMs: 232213 } });
  assert.equal(result.ok, false, '换成 30 秒试听不叫救回来——那叫悄悄换了一首歌播');
  assert.match(result.reason, /这首没有可用的免费音源/, '平台那句原话要留着');
  assert.match(result.reason, /回落其余音源也没找到能完整播放的同名曲/, '回落问过这件事要说出来');
  assert.equal(result.fallbackTried, true);
  assert.equal(result.fallback, undefined, '没采用就不该有 fallback 那格');
});

test('R141 身份判据用共享打分器：曲名差一个字、时长差 10 秒、歌手不同都不换；专辑不同不影响；两家之外没有目标', async () => {
  const ok = audio.fallbackIdentityOk;
  const target = { title: '他不懂', artist: '张杰', durationMs: 232213 };
  assert.equal(ok(target, { provider: 'netease', title: '他不懂', artist: '张杰', album: '爱，不解释', durationMs: 232213 }), true, '专辑不同正是要救的那一格');
  assert.equal(ok(target, { provider: 'netease', title: '他不懂', artist: '张杰', durationMs: 0 }), true, '另一家没给时长时允许（"不知道"≠"差很多"），但只在曲名歌手都逐字之后');
  assert.equal(ok(target, { provider: 'netease', title: '他不懂啊', artist: '张杰', durationMs: 232213 }), false, '曲名差一个字（相似度 0.75）不算同一首');
  assert.equal(ok(target, { provider: 'netease', title: '他不懂', artist: '薛之谦', durationMs: 232213 }), false, '歌手不同不换');
  assert.equal(ok(target, { provider: 'netease', title: '他不懂', artist: '张杰', durationMs: 242213 }), false, '时长差 10 秒不换（多半是另一个版本）');
  assert.equal(ok(target, { provider: 'netease', title: '他不懂', artist: '张杰', durationMs: 234213 }), true, '|Δ| 2 秒在容差内');
  assert.equal(ok(target, { provider: 'kugou', title: '他不懂', artist: '张杰', durationMs: 232213 }), true, '判据本身不管来源');
  assert.equal(audio.AUDIO_FALLBACK_SOURCES.join(','), 'netease,qq,kugou',
    '回落目标写死这三家（R154 起酷狗是可播源）。**不是从 AUDIO_PROVIDERS 推**：推出来的集合会自己扩张');
});

test('R141 那扇窄门：随请求带来的"这首歌是谁"必须过形状把关（缺字段、非对象、时长超界一律 null）', () => {
  const gate = audio.onlineAudioIdentityFrom;
  assert.equal(gate({}), null);
  assert.equal(gate({ online: '他不懂' }), null, '不是对象就是 null，不 try/catch 硬吃');
  assert.equal(gate({ online: { title: '他不懂' } }), null, '没有歌手不许回落（只剩曲名会搜出一堆别人的翻唱）');
  assert.deepEqual(gate({ online: { title: ' 他不懂 ', artist: '张杰', durationMs: 232213 } }), { title: '他不懂', artist: '张杰', durationMs: 232213 });
  assert.equal(gate({ online: { title: 'x', artist: 'y', durationMs: -1 } }), null);
  assert.equal(gate({ online: { title: 'x', artist: 'y', durationMs: 4_000_000 } }), null, '超界时长 = 形状不对，不当成"很长的一首歌"');
  assert.equal(gate({ online: { title: 'x', artist: 'y', durationMs: 'abc' } }), null);
  assert.equal(gate({ online: { title: 'x'.repeat(500), artist: 'y', durationMs: 1000 } }).title.length, 120, '超长要截，不能原样进检索串');
});

test('R141 路由：audio-scope 把身份交给解析器，回落后响应写真实来源；没带身份时 payload 逐字不变', async () => {
  const asked = [];
  const { origin, close } = await routeServer({
    audioSource: {
      resolve: async (query) => {
        asked.push(query);
        return query.identity
          ? { ok: true, provider: 'netease', url: 'https://m802.music.126.net/x.mp3', kind: 'mp3', scope: 'full', fallback: { from: 'qq', to: 'netease', tried: [] } }
          : { ok: false, provider: 'qq', unavailable: true, reason: '这首没有可用的免费音源' };
      },
    },
  });
  try {
    const post = (body) => fetch(`${origin}/api/online/audio-scope`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    const plain = await (await post({ trackId: 'on-qq-123' })).json();
    assert.deepEqual(asked[0], { provider: 'qq', mediaId: '123', mediaMid: '' }, '没带 online ⇒ 交出去的 payload 一个键都不多（与今天逐字一致）');
    assert.equal(plain.scope, 'unavailable');
    assert.equal(plain.sourceProvider, undefined);
    const withIdentity = await (await post({ trackId: 'on-qq-123', online: { title: '他不懂', artist: '张杰', durationMs: 232213 } })).json();
    assert.deepEqual(asked[1].identity, { title: '他不懂', artist: '张杰', durationMs: 232213 });
    assert.equal(withIdentity.scope, 'full');
    assert.equal(withIdentity.sourceProvider, 'netease', '徽标要能说出"现在这个声音来自网易"');
    assert.equal(withIdentity.fallbackFrom, 'qq', '以及"原来那家是 QQ"');
    assert.equal(JSON.stringify(withIdentity).includes('music.126.net'), false, '回落了也不把主机/签名地址回给浏览器');
    const junk = await (await post({ trackId: 'on-qq-123', online: { title: '', artist: '' } })).json();
    assert.equal(asked.at(-1).identity, undefined, '过不了窄门的身份 ⇒ 当没带，不拿空串去检索');
    assert.equal(junk.scope, 'unavailable');
  } finally { await close() }
});

test('P0：audio-scope 的响应里不许出现内部标识符，reason 必须是人话', async () => {
  const guard = await import('./online-guard.mjs');
  const { origin, close } = await routeServer({
    audioSource: { resolve: async () => ({ ok: false, provider: 'netease',
      reason: `${guard.EGRESS_REJECT_MARKER}: 在线请求只允许 https，收到 http:` }) },
  });
  try {
    const response = await fetch(`${origin}/api/online/audio-scope`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ trackId: 'on-netease-1' }),
    });
    const text = await response.text();
    assert.equal(text.includes(guard.EGRESS_REJECT_MARKER), false, `响应里还有内部码：${text}`);
    const body = JSON.parse(text);
    assert.equal(body.ok, false, '归一文案不改判据：这一首仍然是不可用');
    assert.equal(body.reason, '该地址的协议不受支持：本播放器只走 https');
    // 人话要说得出"下一步做什么"的边界：不许写成"播放失败"这种让人以为播放器坏了的话。
    assert.match(body.reason, /https/);
  } finally { await close() }
});

test('P0：归一层接在唯一的响应出口上（各路由各写一遍必然漏一处）', async () => {
  const server = await readScript('music-server.mjs');
  const writer = /function json\(response, status, data\) \{[\s\S]*?\n\}/.exec(server)?.[0] ?? '';
  assert.ok(writer.length > 100, `没抓到响应出口函数：${writer.length}`);
  assert.match(writer, /JSON\.stringify\(sanitizeEgressReasons\(data\)\)/, 'json() 必须过归一层再序列化');
  assert.match(server, /import \{[^}]*sanitizeEgressReasons[^}]*\} from '\.\/online-guard\.mjs'/, '出处只有 online-guard 那一份');
});

// ── R222 · 酷狗取址那两个参数的**父进程一侧**：专辑 id 交下去 + 穷尽之后仍是权益事实 ────────
const R222_KUGOU_HASH = '8F9478E068736878D6FE520A03C8A340';

test('R222（v）父进程把专辑 id 交给桥，且它们进缓存键（同一首带与不带不该吃对方那份缓存）', async () => {
  const payloads = [];
  const resolver = audio.createAudioSourceResolver({
    now: () => 1_000_000,
    bridge: { call: async (route, payload) => { payloads.push(payload); return { ok: true, provider: 'kugou', url: 'https://fsandroid.kugou.com/a.mp3', kind: 'mp3', size: 4112408, scope: 'full' }; } },
    credentialsFor: async () => ({ cookie: 'token=tt;userid=uu', device: { guid: 'g'.repeat(36) } }),
  });
  const withIds = await resolver.resolve({ provider: 'kugou', mediaId: R222_KUGOU_HASH, albumId: '106374641', albumAudioId: '89872375' });
  assert.equal(withIds.ok, true, `该成功：${withIds.reason}`);
  assert.equal(payloads[0].albumId, '106374641', '专辑 id 要交到桥那一跳（它是"带专辑"变体的输入）');
  assert.equal(payloads[0].albumAudioId, '89872375');
  // 形状不对的提示当没带：不许因为一个可选参数把这首歌判死，也不许把它当字符串塞进请求。
  const bogus = await resolver.resolve({ provider: 'kugou', mediaId: R222_KUGOU_HASH, albumId: '../etc', albumAudioId: 'x'.repeat(40) });
  assert.equal(bogus.ok, true);
  assert.equal(payloads[1].albumId, undefined, '认不出的专辑 id 当没带');
  assert.equal(payloads[1].albumAudioId, undefined);
  // 键：带与不带是两条（它们改变第一跳问出去的形状）。
  const keys = resolver.cacheKeys();
  assert.equal(new Set(keys).size, keys.length, `同一首的两种带法要各占一条键：${keys.join(' | ')}`);
  assert.ok(keys.every((key) => !key.includes('token=')), '键里仍然只有摘要，没有凭据');
});

test('R222（vi）反向钉：桥那边穷尽两档两变体仍说权益不给 ⇒ 分类仍是 unavailable，回落照常去试另一家', async () => {
  const calls = [];
  const resolver = audio.createAudioSourceResolver({
    now: () => 1_000_000,
    bridge: { call: async (route, payload) => { calls.push(payload?.provider); if (payload?.provider === 'kugou') {
      return { ok: false, provider: 'kugou', unavailable: true, reason: '酷狗这个账号没有这首歌的完整播放权益（本机不拿片段冒充整首）' };
    } return { ok: false, provider: 'netease', reason: '不该走到这里' }; } },
    // R221 起的第二跳（网页档）：签名档失败时它会被问一次 ⇒ **夹具必须把它堵住**，
    // 否则自检会真打 m.kugou.com（第一次写这条就漏了注入，真出网了一趟才发现——纪律见 R221 日志 §九.5）。
    fetcher: async () => { throw new Error('离线纪律：网页档在自检里不许真出网') },
    credentialsFor: async () => ({ cookie: 'token=tt;userid=uu', device: { guid: 'g'.repeat(36) } }),
    search: async () => ({ ok: true, items: [{ provider: 'netease', mediaId: '1997438791', title: '坏女孩', artist: '徐良', durationMs: 246000, coverRef: '' }] }),
  });
  // 回落那一跳由假的桥回答：网易那一家给整首（这里只验"回落被触发并按整首采用"，机制本身的判据在 R141 那几条里）。
  const result = await resolver.resolve({ provider: 'kugou', mediaId: R222_KUGOU_HASH, albumId: '106641', albumAudioId: '89872375',
    identity: { title: '坏女孩', artist: '徐良', durationMs: 246000 } });
  // 快照要在**调用之后**取（第一版写在调用前，`slice()` 拿的是空数组，断言恒红——判据自己踩的坑）。
  assert.equal(calls[0], 'kugou', '先问主源');
  assert.equal(calls.filter((entry) => entry === 'kugou').length, 1, '主源恰好一跳（桥那一侧自己会穷尽两档两变体，父进程不重复问）');
  assert.equal(result.ok, false);
  assert.equal(result.unavailable, true, '穷尽之后仍是权益事实 ⇒ 回落敢去试另一家');
  assert.equal(result.fallbackTried, true, '回落**真的跑过**（这一条就是"仍 denied 也要去试另一家"的正身）');
  assert.equal(calls.includes('netease'), true, '回落那一跳确实去问了另一家（不是只在文案里说"试过了"）');
  assert.match(result.reason, /回落其余音源也没找到能完整播放的同名曲/, `原因要说清回落试过什么：${result.reason}`);
});

test('R222（vii）路由那一格：`al`/`aa` 只收数字形状，认不出的当没带（可选提示不是身份）', async () => {
  const received = [];
  const { origin, close } = await routeServer({
    audioSource: { resolve: async (payload) => { received.push(payload); return { ok: false, reason: '只验参数，不验取址' }; } },
  });
  try {
    await fetch(`${origin}/api/online/stream?p=kugou&id=${R222_KUGOU_HASH}&al=106374641&aa=89872375`).then((r) => r.text());
    await fetch(`${origin}/api/online/stream?p=kugou&id=${R222_KUGOU_HASH}&al=abc&aa=`).then((r) => r.text());
    await fetch(`${origin}/api/online/stream?p=kugou&id=${R222_KUGOU_HASH}&al=${'9'.repeat(21)}`).then((r) => r.text());
  } finally {
    await close();
  }
  assert.equal(received.length, 3, '三次都要走到取址（参数不是身份，形状不对也不许把请求拒在路由上）');
  assert.equal(received[0].albumId, '106374641', '数字形状照收');
  assert.equal(received[0].albumAudioId, '89872375');
  assert.equal(received[1].albumId, '', '非数字 ⇒ 当没带');
  assert.equal(received[2].albumId, '', '超长（>20 位）⇒ 当没带');
});

// ── R225 · 把 R141 的回落接上生产路由：`t`/`a` 从 `toOnlineTrack` 一路喂到 resolve 的 identity ──
// 由来是 R220 日志 §P1 那条发现：**机制、判据、检索口全在位，唯独生产路由从不喂歌名** ⇒ 回落从未触发，
// 而判据全是注入式（测试自己传 identity）所以多年全绿。按 R216 那一课的规矩，本段第一条就**从真路由打进来**。
const R225_HASH = '9365223F903B13D0DAF54B6091AC3E7B';   // 坏女孩那颗酷狗 hash（本段零出网，只需形状合法）

test('R225（i）生产路由那一格：用 toOnlineTrack 签发的地址打**真路由** ⇒ resolve 收到 identity{title,artist}；不带/半份/超长 ⇒ 这个键整个不出现', async () => {
  const normalize = await import('./bridge/providers/normalize.mjs');
  const received = [];
  const { origin, close } = await routeServer({
    audioSource: { resolve: async (payload) => { received.push({ ...payload }); return { ok: false, reason: '本条只验路由递给取址器的入参，不验取址' }; } },
  });
  try {
    const track = normalize.toOnlineTrack({ provider: 'kugou', mediaId: R225_HASH, albumId: '511536', albumAudioId: '39929871',
      title: '坏女孩', artist: '徐良 / 小凌', album: '坏女孩', durationMs: 246_000, quality: '128kbps' });
    assert.ok(track?.audioUrl.includes('&t='), `曲名与歌手该并进那条同源地址：${track?.audioUrl}`);
    assert.equal(new URL(track.audioUrl, 'http://127.0.0.1').origin, 'http://127.0.0.1', '带身份不等于带第三方主机（多了两个参数也不许破同源）');
    await fetch(`${origin}${track.audioUrl}`).then((r) => r.text());
    assert.deepEqual(received[0].identity, { title: '坏女孩', artist: '徐良 / 小凌' },
      '中文与" / "经 URLSearchParams 编解码要逐字回来（写侧与读侧是同一对参数名）');
    assert.equal(received[0].provider, 'kugou');
    assert.equal(received[0].albumId, '511536', 'R222 那两个专辑参数与本格共存，谁都不许挤掉谁');
    // 反面对照：**不是传 undefined，是这个键整个不出现**（多了 undefined 会把下游"有没有身份"变成"有没有这个键"）
    await fetch(`${origin}/api/online/stream?p=kugou&id=${R225_HASH}`).then((r) => r.text());
    assert.equal('identity' in received[1], false, '没带 t/a ⇒ 行为与今天逐字一致：不回落、不多发一个包');
    await fetch(`${origin}/api/online/stream?p=kugou&id=${R225_HASH}&t=%E5%9D%8F%E5%A5%B3%E5%AD%A9`).then((r) => r.text());
    assert.equal('identity' in received[2], false, '只剩曲名不许回落（会搜出一堆别人的翻唱，与 POST 那扇窄门同一立场）');
    await fetch(`${origin}/api/online/stream?p=kugou&id=${R225_HASH}&a=%E5%BE%90%E8%89%AF`).then((r) => r.text());
    assert.equal('identity' in received[3], false, '只剩歌手同上');
    await fetch(`${origin}/api/online/stream?p=kugou&id=${R225_HASH}&t=${'x'.repeat(121)}&a=%E5%BE%90%E8%89%AF`).then((r) => r.text());
    assert.equal('identity' in received[4], false, '121 个字符的曲名 ⇒ 整个不带（截半截名字会把回落判成另一首歌）');
    await fetch(`${origin}/api/online/stream?p=kugou&id=${R225_HASH}&t=${'x'.repeat(120)}&a=%E5%BE%90%E8%89%AF`).then((r) => r.text());
    assert.equal(received[5].identity?.title.length, 120, '120 是上界：正好 120 要收（判据得咬在边界上，不能只在超界一侧试）');
    assert.equal(received.length, 6, '六次都要走到取址器（参数不是身份，形状不对也不许把请求拒在路由上）');
  } finally {
    await close();
  }
});

test('R225（ii）从生产入口打进来的端到端：点酷狗那行 ⇒ 签名档与网页档都不给 ⇒ **真的**去别的源检索同名曲并按整首采用', async () => {
  // R216 教训的正身：这一条不"测试自己传 identity"，而是**真路由 + 真取址器**，地址由真 `toOnlineTrack` 签发。
  // 只有桥与上游串流是假的（零出网），回落那三条把关一条没绕。
  const normalize = await import('./bridge/providers/normalize.mjs');
  const searched = [];
  const bridgeProviders = [];
  const resolver = audio.createAudioSourceResolver({
    bridge: { call: async (route, payload) => {
      bridgeProviders.push(payload?.provider);
      if (payload?.provider === 'kugou') return { ok: false, provider: 'kugou', unavailable: true, reason: '酷狗这个账号没有这首歌的完整播放权益（错误码 20018）' };
      return { ok: true, provider: 'netease', url: 'http://m802.music.126.net/full.mp3', kind: 'mp3', size: 4_112_408, scope: 'full' };
    } },
    // 网页档那一跳必须堵住（R221 §九.5：加了第二跳出网 ⇒ 夹具都要注入 fetcher，否则自检会真打 m.kugou.com）
    fetcher: async () => { throw new Error('离线纪律：网页档在自检里不许真出网') },
    credentialsFor: async (provider) => (provider === 'kugou'
      ? { cookie: 'token=tt;userid=uu', device: { guid: 'g'.repeat(36), mid: 'm', dfid: '' } }
      : {}),
    search: async (query) => {
      searched.push(query);
      return { ok: true, items: [{ provider: 'netease', mediaId: '28059417', title: '坏女孩', artist: '徐良 / 小凌', album: '小凌作品集', durationMs: 246_000 }] };
    },
  });
  const streamTargets = [];
  const { origin, close } = await routeServer({
    audioSource: resolver,
    streamFetcher: async (target) => { streamTargets.push(target); return { ok: true, status: 200, headers: headersOf({ 'content-length': '3' }), body: { [Symbol.asyncIterator]: async function* () { yield Buffer.from('abc') } } }; },
  });
  try {
    const track = normalize.toOnlineTrack({ provider: 'kugou', mediaId: R225_HASH, title: '坏女孩', artist: '徐良 / 小凌',
      album: '坏女孩', durationMs: 246_000, quality: '128kbps' });
    const response = await fetch(`${origin}${track.audioUrl}`);
    assert.equal(response.status, 200, `点了就该出声：${await response.text()}`);
    assert.deepEqual(bridgeProviders, ['kugou', 'netease'], '先问主源（签名档），回落再问网易；网页档那一跳由 fetcher 挡住 ⇒ 桥只两笔');
    assert.equal(searched.length, 1, '只检索一次（主源说没有才去找别的家）');
    assert.equal(searched[0].query, '坏女孩 徐良 / 小凌', '检索串就是曲名 + 歌手（从查询串里解出来的那一份）');
    assert.equal(searched[0].provider, 'netease', '去的是其余源，不再问一遍刚说没有的那家');
    assert.equal(streamTargets[0], 'https://m802.music.126.net/full.mp3', '出桥的 http 仍升 https 才去串流（不因为"这是回落"就松）');
    // 反证：同一条地址去掉 t/a ⇒ 回落**不许**触发（那就是从前生产路上的状态：机器在位、没人喂身份）。
    // 必须先 `clearCache()`：回落的成功是按**原来那把键**存的（R141 把关 ③，identity 不在键里），
    // 不清就是"命中上一条已确认的事实"，量不到"这一次到底会不会去检索"——那是缓存的行为，不是回落的。
    resolver.clearCache();
    const before = searched.length;
    const silent = await fetch(`${origin}/api/online/stream?p=kugou&id=${R225_HASH}`);
    assert.equal(silent.status, 502, '没带身份 ⇒ 回的就是主源那句原话，不回落');
    assert.match((await silent.json()).error, /完整播放权益/);
    assert.equal(searched.length, before, '没带身份就一次检索都不该发出去（不许猜着搜）');
  } finally {
    await close();
  }
  // 装配口（任务书"要做 3"）：回落用的检索必须是服务端内部那一份出口，接错就少 `mm` 与专辑参数（R119 那一课）
  const serverSource = await readScript('music-server.mjs');
  const wiring = serverSource.match(/createAudioSourceResolver\(\{[\s\S]*?\}\)/);
  assert.ok(wiring, '没抓到 createAudioSourceResolver 的装配处（提取失败不许静默通过）');
  assert.match(wiring[0], /search: \(query\) => onlineSearcher\.searchEntries\(query\)/,
    '回落的检索口接的是 `searchEntries`（内部条目那一份）');
});

test('R225（iii）回落先试**正登录着**的那家：已登录的排在前，未登录的留在表尾（不跳过），没凭据时顺序与今天逐字一致', async () => {
  // 主源固定是网易，且**每次都判成"没有可播文件"**（桥回 ok:true 但没有可用地址 ⇒ `unavailable:true`）
  // ⇒ 一定走回落。QQ 那一路取址经 `fetcher`（不经桥），给的是"没有 sip 条目"的空响应，两家都不给。
  const build = ({ credentialsFor, kugouFull } = {}) => {
    const order = [];
    const resolver = audio.createAudioSourceResolver({
      bridge: { call: async (route, payload) => {
        const provider = payload?.provider;
        order.push(`ask:${provider}`);
        if (provider === 'kugou' && kugouFull) return { ok: true, provider: 'kugou', url: 'https://fsandroid.kugou.com/a.mp3', kind: 'mp3', size: 4_112_408, scope: 'full' };
        return { ok: true, provider };   // 没有 url ⇒ 各家的采纳器都判"这首我没有可播文件"
      } },
      fetcher: async () => ({ ok: true, status: 200, json: () => ({ request: { code: 0, data: { sip: [], midurlinfo: [] } } }) }),
      ...(credentialsFor ? { credentialsFor } : {}),
      search: async (query) => {
        order.push(`search:${query.provider}`);
        // 候选的媒体 id 要长成**那一家自己的形状**（酷狗是 32 位十六进制 hash），
        // 否则父进程那道形状闸会先拦下、根本到不了桥——那是夹具的错，不是被测代码的错。
        const mediaId = query.provider === 'kugou' ? R225_HASH : '1997438791';
        return { ok: true, items: [{ provider: query.provider, mediaId, title: '坏女孩', artist: '徐良', durationMs: 246_000 }] };
      },
    });
    return { order, result: () => resolver.resolve({ provider: 'netease', mediaId: '27699577', identity: { title: '坏女孩', artist: '徐良', durationMs: 246_000 } }) };
  };
  const searchOrder = (order) => order.filter((entry) => entry.startsWith('search:')).map((entry) => entry.slice(7));
  const kugouSession = async (provider) => (provider === 'kugou'
    ? { cookie: 'token=tt;userid=uu', device: { guid: 'g'.repeat(36), mid: 'm', dfid: '' } } : {});

  // ① 只有酷狗登录着、且两家都不给 ⇒ 表序本来是 qq→kugou，本例必须**先问酷狗**，问完仍要问 QQ（不跳过）
  const logged = build({ credentialsFor: kugouSession });
  const first = await logged.result();
  assert.equal(first.ok, false, '两家都不给 ⇒ 仍是权益事实（排序不改变结论）');
  assert.deepEqual(searchOrder(logged.order), ['kugou', 'qq'], `已登录那家先被检索：${logged.order.join(' → ')}`);
  assert.ok(logged.order.includes('ask:kugou'), '检索到候选后确实去取了址（不是只在检索那一层排序）');
  assert.match(first.reason, /回落其余音源也没找到/, '两句原话与回落标记都在（排序不许改文案的形状）');

  // ② 已登录那家给了整首 ⇒ 直接采用，**没登录那家一次都不问**（这一格才是"优先"真有牙）
  const won = build({ credentialsFor: kugouSession, kugouFull: true });
  const second = await won.result();
  assert.equal(second.ok, true, `已登录那家给了整首就该采用：${second.reason}`);
  assert.equal(second.provider, 'kugou', '声音实际来自酷狗 ⇒ provider 要说实话');
  assert.equal(second.scope, 'full');
  assert.deepEqual({ from: second.fallback.from, to: second.fallback.to }, { from: 'netease', to: 'kugou' });
  assert.deepEqual(searchOrder(won.order), ['kugou'], '先试的那家成了 ⇒ 后面的源一次都不问（少两笔出网，与"成了就停"同一族）');

  // ③ 没接凭据门 / 三家都没登录 ⇒ 顺序与今天逐字一致（表序 qq→kugou；排序不是新增前置条件）
  const none = build();
  await none.result();
  assert.deepEqual(searchOrder(none.order), ['qq', 'kugou'], '没接凭据门 ⇒ 顺序不变');
  const allAnonymous = build({ credentialsFor: async () => ({}) });
  await allAnonymous.result();
  assert.deepEqual(searchOrder(allAnonymous.order), ['qq', 'kugou'], '接了凭据门但都没登录 ⇒ 顺序也不变');

  // ④ 判据只有一份：QQ 半份凭据（只 token）算"没登录"——与 `resolveQq` 的 session 同一立场（R108 原话"缺一样就不算登录态"）
  assert.equal(audio.audioCredentialsSignedIn('qq', { token: 't', secret: 's' }), true);
  assert.equal(audio.audioCredentialsSignedIn('qq', { token: 't' }), false, '半份凭据不算登录态');
  assert.equal(audio.audioCredentialsSignedIn('netease', { cookie: 'MUSIC_U=x' }), true);
  assert.equal(audio.audioCredentialsSignedIn('netease', { cookie: '   ' }), false, '空白 cookie 不是登录态');
  assert.equal(audio.audioCredentialsSignedIn('kugou', {}), false);
  assert.equal(audio.audioCredentialsSignedIn('kugou', undefined), false, '没给凭据对象也不许抛');
  // ⑤ 回落目标那张表仍是写死的三家（排序不许把它变成"从别处推出来的集合"）
  assert.equal(audio.AUDIO_FALLBACK_SOURCES.join(','), 'netease,qq,kugou');
});

test('R225（iv）契约不破：`t`/`a` 只活在查询串里，前端曲目仍是那 11 个键；地址的逆解析照常认', async () => {
  const normalize = await import('./bridge/providers/normalize.mjs');
  const item = { provider: 'netease', mediaId: '27699577', title: '恋人', artist: '李荣浩', album: '黑马', durationMs: 276_000, quality: '自动', mediaMid: 'SUB-9' };
  const track = normalize.toOnlineTrack(item);
  assert.deepEqual(Object.keys(track).sort(), [...normalize.ONLINE_TRACK_FIELDS].sort(), '发给前端的键集合一个不多一个不少（身份并进地址，不占契约字段）');
  assert.equal(track.title, '恋人', '曲名在契约里本来就有（`t` 是把它带到路由，不是新增字段）');
  const params = new URL(track.audioUrl, 'http://127.0.0.1').searchParams;
  assert.equal(params.get('t'), '恋人');
  assert.equal(params.get('a'), '李荣浩');
  assert.equal(params.get('mm'), 'SUB-9', 'QQ 的次 id 与本格共存，位置谁都不许挤掉谁');
  // 名字缺失 ⇒ 一个都不带（占位词"未知曲名"不许被当成身份去检索）
  const nameless = normalize.toOnlineTrack({ ...item, title: '', artist: '' });
  assert.equal(nameless.title, '未知曲名', '曲目对象那一份照旧给占位词（界面不许出现空曲名）');
  for (const key of ['t', 'a']) assert.equal(new URL(nameless.audioUrl, 'http://127.0.0.1').searchParams.get(key), null, `${key} 不许带缺失值`);
  const oneSided = normalize.toOnlineTrack({ ...item, artist: '   ' });
  assert.equal(new URL(oneSided.audioUrl, 'http://127.0.0.1').searchParams.get('t'), null, '歌手缺失 ⇒ 曲名也不带（成对是身份判据的前提）');
  const tooLong = normalize.toOnlineTrack({ ...item, title: '徐'.repeat(121) });
  assert.equal(new URL(tooLong.audioUrl, 'http://127.0.0.1').searchParams.get('t'), null, '超长 ⇒ 整个不带，不截半截进 URL');
  assert.equal(new URL(tooLong.audioUrl, 'http://127.0.0.1').searchParams.has('id'), true, '其余参数照常（回落是增强，它坏了不许把主源那一跳也带坏）');
  // 逆解析（收藏与"加入歌单"那条路用它）：多了 t/a 仍要认得同一份身份
  assert.deepEqual(normalize.identityFromStreamUrl(track.audioUrl), { provider: 'netease', mediaId: '27699577', mediaMid: 'SUB-9' },
    '逆函数读的是 p/id/mm ⇒ 不许因为多了身份参数就认不出');
  // 凭据不进 URL：这两个参数是"这首歌是谁"，与账号无关
  assert.equal(/token|userid|MUSIC_U|cookie/i.test(track.audioUrl), false, '地址里不许出现任何凭据片段');
});
