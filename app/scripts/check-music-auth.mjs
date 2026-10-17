// 第五期 M3-a 自检：出网层"带 cookie 的登录通道"（Task A，设计稿 §4）+ cookie jar 与凭据边界（Task B，§5/§7）。
// 设计稿：docs/superpowers/plans/2026-10-06-m3a-cookie-login-channel-design.md
//
// Task A 盯四件事：
//   ① **默认行为逐字不变** —— 不传新参数时返回形状与今天完全一样（多一个值为 undefined 的字段都算变了形状）；
//   ② **响应头是白名单制** —— 只放开 set-cookie，其余（尤其 location）明确不进，且这张表是取法的闸门、不只是注释；
//   ③ **桥内的出网记录要能并回父进程那一张表** —— sink 可注入，默认仍是那张内存环形表；
//   ④ **浏览器侧也只拿白名单头** —— guardedStreamFetch 唯一的生产消费者（流式路由）透传的头都在那三个里。
// Task B 盯两件事（§7 的两条 canary，有生产者的那半条先做）：
//   ⑤ **凭据绝不进日志 / 不进审计 / 不进对外状态** —— 塞一个已知值进去，再在所有出口找它；
//   ⑥ **落点与权限按稿执行** —— 只有会话分区那一个文件、0600/0700 尽力、不产生备份、退出真的删干净。
// 离线纪律：不碰网络。fetch 用替身，DNS 用注入的 lookup（注入只是省一次解析，不是省一道检查）；
// 文件系统只碰 mkdtemp 出来的一次性目录，用完即删。
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join, relative } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const SCRIPTS = dirname(fileURLToPath(import.meta.url));
const read = (name) => readFile(join(SCRIPTS, name), 'utf8');

const guard = await import('./online-guard.mjs');
const audit = await import('./online-audit.mjs');
const session = await import('./online-session.mjs');
const { guardedFetch, AUTH_HOSTS, AUTH_RESPONSE_HEADERS } = guard;

// 一个公开可路由地址：不在 V4_BLOCKED 任何一段里（203.0.113.0/24 是测试网，会被挡）。
const PUBLIC_DNS = async () => [{ address: '104.20.71.5' }];

/** 只在本条用例里往表里加一个主机，用完还原——生产表不因测试而残留名字。 */
const withTestHost = async (hostname, run) => {
  AUTH_HOSTS.exact.add(hostname);
  try { return await run() } finally { AUTH_HOSTS.exact.delete(hostname) }
};

/** fetch 替身：报体积、报状态、给一份 Set-Cookie。 */
const stubFetch = (payload, cookies) => {
  const original = globalThis.fetch;
  globalThis.fetch = async () => ({
    ok: true, status: 200,
    headers: { get: () => String(Buffer.byteLength(payload)), getSetCookie: () => cookies },
    body: (async function * () { yield Buffer.from(payload) })(),
  });
  return () => { globalThis.fetch = original };
};

test('响应头白名单：只放开 set-cookie；location 明确不进（放开它等于留一份"可手动跟随"的邀请）', () => {
  assert.ok(Array.isArray(AUTH_RESPONSE_HEADERS), '白名单是个数组');
  assert.deepEqual([...AUTH_RESPONSE_HEADERS], ['set-cookie']);
  assert.ok(Object.isFrozen(AUTH_RESPONSE_HEADERS), '冻结：运行时改不动，要改只能改源码并过一次评审');
  for (const banned of ['location', 'authorization', 'www-authenticate', 'set-authorization', 'cookie']) {
    assert.equal(AUTH_RESPONSE_HEADERS.includes(banned), false, `${banned} 不许进白名单`);
  }
});

test('AUTH_HOSTS 用既有的 {exact,suffix} 形状，且表里每个名字都有一手实测来源（fail-closed 的意思是"没测过的不进"）', async () => {
  assert.ok(AUTH_HOSTS.exact instanceof Set, '精确表是 Set，与 AUDIO_HOSTS 同构，不新增第三种形状');
  assert.ok(Array.isArray(AUTH_HOSTS.suffix));
  assert.deepEqual([...AUTH_HOSTS.suffix], [], '后缀表必须空着：*.qq.com 这种等于没有白名单');
  // Task A 造闸时这张表是空的；Task D 按一次真取码填进两个名字，来源写在 online-guard.mjs 的注释里。
  // 断言按"集合逐字相等"而不是"非空"：加第三个名字必须同时改这条断言，改的人就会去补实测来源。
  assert.deepEqual([...AUTH_HOSTS.exact].sort(), ['api.tencentmusic.com', 'u.y.qq.com'],
    'QQ 登录实测只打这两个端点（QIMEI 引导 + musicu.fcg）；mu.y.qq.com 是 WSS，走 auth-mqtt 那一档');
  const guardSource = await read('online-guard.mjs');
  assert.ok(/api\.tencentmusic\.com[\s\S]{0,400}QIMEI|QIMEI[\s\S]{0,400}api\.tencentmusic\.com/.test(guardSource),
    '表里每个名字都要在注释里留一手依据，否则下一个删代码的人不知道它为什么在');
  audit.resetAudit();
  await assert.rejects(
    () => guardedFetch('https://xui.ptlogin2.qq.com/cgi-bin/xlogin', { hosts: AUTH_HOSTS, kind: 'auth', lookup: PUBLIC_DNS }),
    /主机不在本次用途的在线白名单/, '没进表的主机（这里是 ptlogin2）必须被挡');
  const snapshot = audit.auditSnapshot();
  assert.equal(snapshot.totals.byKind.auth ?? 0, 1, '被挡下也要记一笔（R75：只记成功那几笔等于把审计做成广告）');
  assert.equal(snapshot.items[0].via, 'guard');
  assert.equal(snapshot.items[0].status, 0, '没发出去的请求没有状态码，不许编一个 200');
});

test('默认不返回 setCookie：老调用点的返回形状逐字不变；开了开关才回传且原样保留属性', async () => {
  audit.resetAudit();
  const restore = stubFetch('{"code":200}', ['NMTID=abc123; Path=/; HttpOnly', 'MUSIC_U=xyz789; Max-Age=0']);
  try {
    await withTestHost('login.example.test', async () => {
      const plain = await guardedFetch('https://login.example.test/qr/key', { hosts: AUTH_HOSTS, kind: 'auth', lookup: PUBLIC_DNS });
      assert.deepEqual(Object.keys(plain).sort(), ['json', 'ok', 'status', 'text'],
        '不传 withSetCookie 时返回的键必须还是今天这四个');
      assert.equal(plain.setCookie, undefined);
      const opened = await guardedFetch('https://login.example.test/qr/key', {
        hosts: AUTH_HOSTS, kind: 'auth', withSetCookie: true, lookup: PUBLIC_DNS,
      });
      // 期望字段由白名单本身推导：往表里加一个头却没在取法里补对应实现，这里就会红（表是闸门不是注释）。
      assert.deepEqual(Object.keys(opened).sort(),
        ['json', 'ok', 'status', 'text', ...(AUTH_RESPONSE_HEADERS.includes('set-cookie') ? ['setCookie'] : [])].sort(),
        '开开关后多出来的字段必须正好等于白名单，一个不多');
      assert.deepEqual(opened.setCookie, ['NMTID=abc123; Path=/; HttpOnly', 'MUSIC_U=xyz789; Max-Age=0'],
        '开了开关才回传，且属性（Path/HttpOnly/Max-Age）原样保留 —— 归一化是 jar 的事，不在头这一层做');
    });
  } finally { restore(); }
});

test('开关不传时即便上游发了 Set-Cookie 也拿不到：这是"调用面收窄"的实现前提', async () => {
  const restore = stubFetch('{}', ['sid=leak; Path=/']);
  try {
    await withTestHost('login.example.test', async () => {
      const got = await guardedFetch('https://login.example.test/x', { hosts: AUTH_HOSTS, kind: 'auth', lookup: PUBLIC_DNS });
      assert.equal('setCookie' in got, false, '默认连字段都不该存在（不是存在但为空）');
    });
  } finally { restore(); }
});

test('审计 sink 可注入：桥那份能并回父进程同一张表；传 null 复位；非函数不弄坏表', () => {
  audit.resetAudit();
  const rows = [];
  audit.setEgressSink((row) => rows.push(row));
  audit.recordEgress({ host: 'a.test', kind: 'auth', status: 200, bytes: 10, ms: 3, via: 'guard' });
  assert.equal(rows.length, 1, '注入的 sink 收到这一笔');
  assert.equal(audit.auditSnapshot().totals.requests, 0, '装了转发 sink 就不该再往本地表写第二份（两处真源）');
  audit.setEgressSink(null);
  audit.recordEgress({ host: 'b.test', kind: 'auth', status: 200, bytes: 10, ms: 3, via: 'guard' });
  assert.equal(audit.auditSnapshot().totals.requests, 1, '复位后回到默认那张内存表');
  audit.setEgressSink('这不是函数');
  audit.recordEgress({ host: 'c.test', kind: 'auth', status: 200, bytes: 10, ms: 3, via: 'guard' });
  assert.equal(audit.auditSnapshot().totals.requests, 2, '传错东西要被忽略，而不是把表换成一个不可调用的值');
  audit.setEgressSink(null);
  audit.resetAudit();
});

test('流式那条入口不开 cookie 口子：音源响应不需要登录头，多一个口子就多一处可被误用', async () => {
  const src = await read('online-guard.mjs');
  const stream = src.slice(src.indexOf('export async function guardedStreamFetch'));
  assert.ok(stream.length > 200, '没抓到流式入口');
  assert.equal(/withSetCookie|setCookie/.test(stream), false, 'guardedStreamFetch 不许偷偷支持 cookie');
  // 如实登记边界：这一条只证明"参数层没有开 cookie 的口子"。该函数仍把原始 Headers 对象交给调用方，
  // 所以"上游头进不了浏览器"要靠后面那条（路由只读 content-length/content-range/accept-ranges）守住。
});

test('登录通道不新建体积旋钮：取码响应落在既有档位里（真实字节数 Task C 实测后回填注释）', async () => {
  const src = await read('online-guard.mjs');
  assert.equal(/MAX_[A-Z_]*AUTH[A-Z_]*BODY/.test(src), false,
    '不给登录单开一个体积档：歌词档本来就是 512 KiB，一张二维码的 data URI 远小于它，'
    + '多一个旋钮只多一处可漂移的地方');
  assert.ok(guard.MAX_ONLINE_BODY_BYTES >= 256 * 1024,
    '共享档位必须罩得住取码响应（data:image/png;base64 整图）——谁把它调小到装不下二维码，这一条要咬');
});

test('浏览器侧也是白名单：流式路由只透传长度/范围三个头，上游其余响应头（含 Set-Cookie）进不了浏览器', async () => {
  const src = await read('music-server.mjs');
  const marker = "if (route === '/api/online/stream')";
  const start = src.indexOf(marker);
  assert.ok(start >= 0, '没找到流式路由（改名了就要同步改这条断言）');
  const next = src.indexOf('if (route', start + marker.length);
  const block = src.slice(start, next === -1 ? src.length : next);
  const copied = [...block.matchAll(/upstream\.headers\.get\('([^']+)'/g)].map((match) => match[1]);
  assert.ok(copied.length >= 2, '这块确实在读上游头，否则本条是空断言');
  for (const name of copied) {
    assert.ok(['content-length', 'content-range', 'accept-ranges'].includes(name), `透传了白名单外的上游头：${name}`);
  }
  assert.equal(/set-cookie|getSetCookie/i.test(block), false, '流式路由不许碰 Set-Cookie');
});

// ── Task B：cookie jar 与凭据边界（设计稿 §5 + §7 两条 canary）────────────────────
// canary 用拼串现场造：它正好是纪律判据认定的"可用凭据"形状（≥16 字符、含字母与数字），
// 而本文件里不留下"凭据键名: 长值"的连续字面量（否则会被自己的全仓扫描咬住）。
const CANARY = 'canary-' + '7Kq2p9Lm4xR8t1Yw';
const CANARY_TWO = 'canary-' + 'Qb4Lm9Xz2p7Rt3Yw';
const POSIX = process.platform !== 'win32';

/** 一次性数据目录，用完即删；每条用例自己建，避免相互看到对方的会话文件。 */
const withDataDir = async (run) => {
  const dir = await mkdtemp(join(tmpdir(), 'm3a-session-'));
  try { return await run(dir) } finally { await rm(dir, { recursive: true, force: true }) }
};

/** 捕获一段代码里的服务日志（console.log + console.error），逐行返回。 */
const captureLog = async (run) => {
  const lines = [];
  const original = { log: console.log, error: console.error };
  console.log = (...args) => lines.push(args.join(' '));
  console.error = (...args) => lines.push(args.join(' '));
  try { await run() } finally { Object.assign(console, original) }
  return lines;
};

/** 递归列文件（node_modules 与点目录不进扫描面：桥的依赖树不是我们的代码）。 */
const listFiles = async (dir) => {
  const found = [];
  const walk = async (current) => {
    for (const entry of await readdir(current, { withFileTypes: true })) {
      const full = join(current, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
        await walk(full);
      } else found.push(full);
    }
  };
  await walk(dir);
  return found;
};

test('jar 合并：同名新值胜出、属性原样保留、Max-Age<=0 或已过期的 Expires 视为删除、坏条目忽略', () => {
  const base = session.mergeSetCookie({}, ['MUSIC_U=first-value-1; Path=/; HttpOnly', 'NMTID=keep-me-1; Path=/']);
  assert.deepEqual(Object.keys(base).sort(), ['MUSIC_U', 'NMTID']);
  const merged = session.mergeSetCookie(base, ['MUSIC_U=second-value-2; Path=/; Max-Age=31536000']);
  assert.equal(merged.MUSIC_U, 'MUSIC_U=second-value-2; Path=/; Max-Age=31536000', '同名覆盖且属性原样（归一化不在这一层做）');
  assert.notEqual(merged, base, '返回新对象：不改调用方手里那份（写盘失败时旧 jar 仍然是干净的）');
  assert.deepEqual(base, { MUSIC_U: 'MUSIC_U=first-value-1; Path=/; HttpOnly', NMTID: 'NMTID=keep-me-1; Path=/' }, '原 jar 一个字没动');
  assert.equal(session.mergeSetCookie(base, ['NMTID=whatever; Path=/; Max-Age=0']).NMTID, undefined, 'Max-Age=0 是删除指令，不是"存一个 0"');
  assert.equal(session.mergeSetCookie(base, ['NMTID=whatever; Path=/; Max-Age=-1']).NMTID, undefined, '负数同样按删除');
  assert.equal(session.mergeSetCookie(base, ['NMTID=x-1; Expires=Thu, 01 Jan 1970 00:00:00 GMT']).NMTID, undefined, '1970 年的 Expires 是删除');
  assert.notEqual(session.mergeSetCookie(base, ['NMTID=x-1; Expires=Thu, 01 Jan 1970 00:00:00 GMT']).MUSIC_U, undefined, '删除只影响那一个名字');
  const future = new Date(Date.now() + 86400000).toUTCString();
  assert.notEqual(session.mergeSetCookie(base, [`NMTID=x-1; Expires=${future}`]).NMTID, undefined, '没到期的 Expires 不删');
  for (const junk of ['', ';', 'noEqualsSign', '=value-only', '   ', null, undefined]) {
    assert.deepEqual(session.mergeSetCookie(base, [junk]), base, `坏条目 ${JSON.stringify(junk)} 应当被忽略而不是抛`);
  }
  assert.deepEqual(session.mergeSetCookie(base, null), base, '上游没发 Set-Cookie（null）不是错误，也不动 jar');
  assert.deepEqual(session.mergeSetCookie(null, ['a=1; Path=/']), { a: 'a=1; Path=/' }, '空 jar 进得去');
});

test('cookie 串的进出两个方向：响应体里的 cookie 串能进 jar，回传给上游时只带 name=value', () => {
  const jar = session.jarFromCookieString(`MUSIC_U=${CANARY}; NMTID=${CANARY_TWO}; csrf_token=short`);
  assert.deepEqual(Object.keys(jar).sort(), ['MUSIC_U', 'NMTID', 'csrf_token']);
  const header = session.cookieHeaderFor(jar);
  assert.ok(header.includes(`MUSIC_U=${CANARY}`), '值要能原样回去，否则等于没登录');
  assert.equal(/Max-Age|Expires|Path=|Domain=|HttpOnly/i.test(header), false, '属性是上游给我们的一次性说明，回传时不该带');
  // 上面那句对"从响应体串来的 jar"是空话（那种 jar 本来就没属性）——真正带属性的是 Set-Cookie 那条路，
  // 所以这里必须再喂一份 mergeSetCookie 产物：变异验证 B3 就是这么被逼出来的。
  const withAttributes = session.mergeSetCookie({}, [`MUSIC_U=${CANARY}; Path=/; Domain=.music.163.com; Max-Age=31536000; HttpOnly`]);
  const outbound = session.cookieHeaderFor(withAttributes);
  assert.equal(outbound, `MUSIC_U=${CANARY}`, '回传只剩 name=value，属性一个字都不带');
  assert.equal(session.cookieHeaderFor({}), '', '空 jar 回空串，不是 undefined');
  assert.equal(session.cookieHeaderFor(null), '', 'null 同样按空处理');
  assert.deepEqual(session.jarFromCookieString(''), {}, '空串是"没有 cookie"，不是"解析失败"');
  assert.deepEqual(session.jarFromCookieString(null), {}, 'null 同样按没有处理');
});

test('真机形状：网易 check 的 cookie 串是"完整 Set-Cookie 头用分号拼起来"，属性段不许被当成 cookie 名', () => {
  // 这条的来源是 2026-10-06 第一次真扫码：磁盘上那一份 jar 的键名是
  //   MUSIC_SNS, Max-Age, Expires, Path, MUSIC_R_T, MUSIC_A_T, __csrf, MUSIC_R_U, NMTID, MUSIC_U
  // ——后五个里混进了三个属性名。离线夹具只有 `a=1; b=2` 这种干净形状，所以它当时没拦住。
  const REAL_SHAPE = 'MUSIC_SNS=snscbc77aa11bb22; Max-Age=31536000; Expires=Fri, 01 Oct 2027 00:00:00 GMT; Path=/;'
    + ' MUSIC_R_T=rt0011223344; MUSIC_R_U=ru0011223344; __csrf=cs0011223344; NMTID=nt0011223344; HttpOnly;'
    + ' MUSIC_U=musicu0011223344; Domain=.music.163.com; Path=/'
  const jar = session.jarFromCookieString(REAL_SHAPE);
  assert.deepEqual(Object.keys(jar).sort(), ['MUSIC_R_T', 'MUSIC_R_U', 'MUSIC_SNS', 'MUSIC_U', 'NMTID', '__csrf'],
    '只该有六个真 cookie：Max-Age / Expires / Path / HttpOnly 是上一条的属性');
  assert.ok(jar.MUSIC_SNS.includes('Max-Age=31536000'), '属性并回它所属的那一条，不丢信息');
  assert.ok(jar.MUSIC_U.includes('Domain=.music.163.com'), '带 Domain/Path 的最后一条同样归位');
  assert.ok(jar.NMTID.endsWith('HttpOnly'), '没有等号的属性段（HttpOnly）也要并回上一条');
  const header = session.cookieHeaderFor(jar);
  assert.equal(/Max-Age|Expires|Path=|Domain=|HttpOnly/.test(header), false, '回传给上游的 Cookie 头里不许有属性');
  assert.equal(header.split('; ').length, 6, '回传正好六项');
  // 删除语义在这个形状上仍然只有一份实现：带 Max-Age=0 的那条被删，其余不动。
  const deleted = session.jarFromCookieString('MUSIC_U=keepme001122; Path=/; MUSIC_R_T=gone001122334; Max-Age=0');
  assert.deepEqual(Object.keys(deleted), ['MUSIC_U'], '同一条里的 Max-Age=0 只删它自己');
  const expiredByDate = session.jarFromCookieString('MUSIC_U=keepme001122; MUSIC_R_T=gone001122334; Expires=Thu, 01 Jan 1970 00:00:00 GMT');
  assert.deepEqual(Object.keys(expiredByDate), ['MUSIC_U'], '过期的 Expires 按删除，且不影响前一条');
});

test('落点与权限：只有会话分区那一个文件、写盘真的传了 0600/0700、不产生备份、不留 tmp', async () => {
  const source = await read('online-session.mjs')
  // 备份这件事要按**代码**判，不按"文里有没有这个词"判：这个文件的说明注释里就得写清"不产生 .backup"，
  // 按整篇文本扫会被自己的注释咬掉（第一版正是这样红的）。剥掉注释行再判。
  const code = source.split('\n').filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line)).join('\n')
  assert.match(code, /mode:\s*0o600/, '写入必须真的传了 mode（Windows 上 stat 判不出来，这里靠形状）');
  assert.match(code, /mode:\s*0o700/, '目录也按 0700 尽力');
  assert.match(code, /process\.platform\s*===\s*'win32'/, '要显式认 Windows，不许把"尽力"写成"保证"');
  assert.doesNotMatch(code, /BACKUP_SUFFIX|\.backup/, '凭据目录里不许产生备份：备份等于把凭据多留一份');
  assert.doesNotMatch(code, /copyFile/, '这一层根本没有"另存一份"的动作');
  await withDataDir(async (dataDir) => {
    const lines = [];
    const store = session.createOnlineSession({ dataDir, log: (line) => lines.push(line) });
    assert.equal(store.dir, join(dataDir, 'online-session'), '分区名固定，不接受任意路径（这一层没有"用户可指目录"的口子）');
    assert.equal(store.fileFor('netease'), join(dataDir, 'online-session', 'netease.json'));
    await store.write('netease', session.jarFromCookieString(`MUSIC_U=${CANARY}`));
    assert.deepEqual(await readdir(store.dir), ['netease.json'], '分区里只该有会话文件本身：不留 .tmp、不留 .backup、不留旁路日志');
    if (POSIX) {
      assert.equal((await stat(store.fileFor('netease'))).mode & 0o077, 0, '非 Windows 上文件必须收到 0600 一档');
      assert.equal((await stat(store.dir)).mode & 0o077, 0, '非 Windows 上目录必须收窄');
    } else {
      // 本平台不保证：POSIX mode 在 Windows 上只映射只读位。这一行存在的全部意义是"不许假装拿到了保证"。
      assert.ok(lines.some((line) => /不保证/.test(line)), `Windows 上要留下一行"不保证"，实际：${lines.join(' / ')}`);
    }
  });
});

test('来源优先级：环境变量先于会话文件；两边都没有是"匿名"而不是"读取失败"', async () => {
  await withDataDir(async (dataDir) => {
    const plain = session.createOnlineSession({ dataDir });
    await plain.write('netease', session.jarFromCookieString(`NMTID=${CANARY_TWO}`));
    const shadowed = session.createOnlineSession({ dataDir, env: { [session.NETEASE_ENV_KEY]: `MUSIC_U=${CANARY}` } });
    const viaEnv = await shadowed.read('netease');
    assert.equal(viaEnv.source, 'env', 'env 设了就必须按 env 算（反过来会让"我在 shell 里设了值"静默不生效）');
    assert.deepEqual(Object.keys(viaEnv.jar), ['MUSIC_U'], 'env 生效时磁盘那份一个字都不该参与');
    const viaFile = await plain.read('netease');
    assert.equal(viaFile.source, 'file');
    assert.equal(viaFile.jar.NMTID, `NMTID=${CANARY_TWO}`);
    const empty = await withDataDir((dir) => session.createOnlineSession({ dataDir: dir }).read('netease'));
    assert.equal(empty.source, 'none', '没登录过是"匿名"');
    assert.deepEqual(empty.jar, {});
    const blank = session.createOnlineSession({ dataDir, env: { [session.NETEASE_ENV_KEY]: '   ' } });
    assert.equal((await blank.read('netease')).source, 'file', 'env 存在但全空白 = 没表过态，回落到文件而不是当它为空');
  });
});

test('每读一次留一行来源日志，且这一行只有来源种类、没有内容', async () => {
  await withDataDir(async (dataDir) => {
    const store = session.createOnlineSession({ dataDir, env: { [session.NETEASE_ENV_KEY]: `MUSIC_U=${CANARY}` } });
    const lines = await captureLog(() => store.read('netease'));
    assert.ok(lines.some((line) => /网易登录态来源：环境变量/.test(line)), `要有来源种类那一行，实际：${lines.join(' / ')}`);
    assert.equal(lines.join('\n').includes(CANARY), false, '来源日志里不许出现凭据本体');
    const fromFile = session.createOnlineSession({ dataDir });
    const fileLines = await captureLog(async () => {
      await fromFile.write('netease', session.jarFromCookieString(`MUSIC_U=${CANARY}`));
      await fromFile.read('netease');
    });
    assert.ok(fileLines.some((line) => /来源：会话文件/.test(line)), '文件档也要说清来源');
    assert.equal(fileLines.join('\n').includes(CANARY), false, '读文件这一路同样不许把值打进日志');
  });
});

test('父进程只认领自己那一份：QQ 的会话由桥内的包/密封串管，读与写都不碰，但退出要能删', async () => {
  await withDataDir(async (dataDir) => {
    const store = session.createOnlineSession({ dataDir });
    // R136 之后父进程认领两份 jar：**网易与酷狗同形状**（都是父进程持有的 cookie 对，酷狗是 token + userid），
    // 而 QQ 那份仍然是"桥内的包自己加密管"。加一家不是放宽判据——判据盯的是"哪些家许读内容"，
    // 那份名单每加一家都要先看它的凭据形状归谁管；QQ 那两档的拒绝仍然逐条在下面。
    assert.deepEqual(store.owned, ['netease', 'kugou'], '父进程认领"内容读写"的 jar 就是这两家（设计稿 §3 的分家 + R136）');
    assert.equal(store.fileFor('qq'), join(dataDir, 'online-session', 'qq-auth.json'), '路径要知道，但只给 stat 与删除用');
    assert.equal(store.fileFor('qq-device'), join(dataDir, 'online-session', 'qq-device.json'));
    await assert.rejects(() => store.read('qq'), /桥内/);
    await assert.rejects(() => store.write('qq', {}), /桥内/);
    // Task D 的改动，理由要说清：**删除是退出动作**，两家都得能删，否则用户被困在关不掉的登录态里；
    // 受限的是"读与写内容"，不是"把它清掉"。
    await assert.rejects(() => store.remove('qq-device'), /不归父进程管/, '设备上下文是包自己的落点，父进程连删都不删它');
    const removed = await store.remove('qq');
    assert.equal(removed.removed, false);
    assert.equal(removed.alreadyGone, true, '没有文件就是已是退出态（与网易那一档同一条规矩）');
    assert.throws(() => store.fileFor('typo'), /不认识/);
    // 密封会话走另一对门：writeSealed/readSealed 只认 qq，且落盘带 sealed 标记。
    await assert.rejects(() => store.writeSealed('netease', 'x'), /没有密封会话这一档/);
    await store.writeSealed('qq', 'opaque-blob-value');
    assert.equal(store.fileFor('qq') !== store.fileFor('netease'), true);
    const readBack = await store.readSealed('qq');
    assert.equal(readBack.session, 'opaque-blob-value');
    assert.equal(readBack.source, 'file');
    assert.equal(JSON.stringify(await store.describe()).includes('opaque-blob-value'), false,
      'describe 只 stat 不读内容：密文也不许从这一层漏出去');
  });
});

test('退出 = 删文件：没文件可删要说清"已是退出态"，删不掉要给可读原因且不静默', async () => {
  await withDataDir(async (dataDir) => {
    const store = session.createOnlineSession({ dataDir });
    const nothing = await store.remove('netease');
    assert.equal(nothing.removed, false);
    assert.equal(nothing.alreadyGone, true, 'ENOENT 是"本来就没有"，不该报成失败');
    await store.write('netease', session.jarFromCookieString(`MUSIC_U=${CANARY}`));
    assert.equal(await store.exists('netease'), true);
    const done = await store.remove('netease');
    assert.equal(done.removed, true);
    assert.equal(await store.exists('netease'), false, '退出之后文件必须真的不在了');
    // 写空 jar 与 remove 同义：不留一份"空凭据"的文件在那儿装样子。
    await store.write('netease', session.jarFromCookieString(`MUSIC_U=${CANARY}`));
    await store.write('netease', {});
    assert.equal(await store.exists('netease'), false, '写空 jar 就是退出');
    // 真失败要按**错误码**造，不是按"路径看起来离谱"造。第一版用"数据目录放在一个普通文件底下"，
    // 结果 Windows 上 unlink 报的是 ENOENT（不是 POSIX 的 ENOTDIR）——被正确判成了"没有文件可删"。
    // 两个平台都成立的造法：让 netease.json 这个名字**是个目录**，unlink 必然撞在非文件上。
    const trapped = session.createOnlineSession({ dataDir });
    await mkdir(join(trapped.dir, 'netease.json'), { recursive: true });
    const failureLines = await captureLog(() => trapped.remove('netease'));
    const result = await trapped.remove('netease');
    assert.equal(result.removed, false);
    assert.equal(result.alreadyGone, undefined, '不是 ENOENT 就别冒充退出态');
    assert.ok(String(result.reason).length > 0, '删不掉必须带可读原因');
    assert.equal(/ENOENT/.test(String(result.reason)), false, `真失败不许报成不存在：${result.reason}`);
    assert.ok(failureLines.some((line) => /退出失败/.test(line)), '删不掉要同时进服务日志，不许只写在返回值里');
    const blocker = join(dataDir, 'not-a-dir');
    await writeFile(blocker, 'x', 'utf8');
    await assert.rejects(() => session.createOnlineSession({ dataDir: join(blocker, 'sub') })
      .write('netease', session.jarFromCookieString(`MUSIC_U=${CANARY}`)), /./,
    '写不进去要抛给调用方（界面上要看得见"没存上 / 没退成功"），不静默吞');
  });
});

test('对外的登录状态是键名白名单，不是"删掉几个字段"；数值字段一律是条数与时间，不是内容', async () => {
  await withDataDir(async (dataDir) => {
    const store = session.createOnlineSession({ dataDir });
    await store.write('netease', session.jarFromCookieString(`MUSIC_U=${CANARY}`));
    const view = await store.describe();
    const allowed = new Set(['providers', 'netease', 'kugou', 'qq', 'source', 'entries', 'updatedAt', 'envConfigured']);
    const walk = (value, path = '') => {
      if (value && typeof value === 'object') {
        for (const [key, next] of Object.entries(value)) {
          assert.ok(allowed.has(key), `${path}/${key} 不在登录状态的键名白名单里`);
          walk(next, `${path}/${key}`);
        }
      }
    };
    walk(view);
    assert.equal(JSON.stringify(view).includes(CANARY), false, '登录状态里出现了凭据本体');
    assert.equal(view.providers.netease.entries, 1, 'entries 是条数，不是内容');
    assert.equal(view.providers.netease.source, 'file');
    assert.equal(view.providers.netease.envConfigured, false);
    assert.equal(typeof view.providers.netease.updatedAt, 'number');
    assert.equal(view.providers.qq.source, 'none', '桥那份还没写文件时如实报 none');
    assert.equal(view.providers.kugou.source, 'none', '酷狗那份没写文件时同样如实报 none');
    await store.write('kugou', session.jarFromCookieString(`token=${CANARY};userid=42`));
    const withKugou = await store.describe();
    assert.equal(withKugou.providers.kugou.entries, 2, '酷狗的 jar 也是"条数"而不是内容');
    assert.equal(JSON.stringify(withKugou).includes(CANARY), false, 'describe 把酷狗那份的凭据带出来了');
    await store.remove('kugou');
    // 桥那份是加密文件，父进程只 stat；读了内容就等于把凭据搬进父进程（§3 的分家）。
    // 这里故意在那一个文件里放 canary：describe 一旦去读它，最后一条断言就会红。
    await writeFile(join(store.dir, 'qq-auth.json'), `MUSIC_U=${CANARY}`, 'utf8');
    const withBridgeFile = await store.describe();
    assert.equal(withBridgeFile.providers.qq.source, 'file');
    assert.equal(withBridgeFile.providers.qq.entries, null, '不读内容就不知道条数，如实写 null');
    assert.equal(JSON.stringify(withBridgeFile).includes(CANARY), false, 'describe 把桥那份文件的内容带出来了');
  });
});

test('canary 全出口核验：四条路径的日志、审计表、数据目录里都不许出现凭据本体', async () => {
  await withDataDir(async (dataDir) => {
    audit.resetAudit();
    const store = session.createOnlineSession({ dataDir });
    const blocker = join(dataDir, 'not-a-dir');
    await writeFile(blocker, 'x', 'utf8');
    const lines = await captureLog(async () => {
      await store.write('netease', session.mergeSetCookie({}, [`MUSIC_U=${CANARY}; Path=/; Max-Age=31536000`]));
      await store.read('netease');                                                   // 成功
      await withDataDir((dir) => session.createOnlineSession({ dataDir: dir }).read('netease'));  // 未命中（匿名）
      await session.createOnlineSession({ dataDir: join(blocker, 'sub') })
        .write('netease', session.jarFromCookieString(`MUSIC_U=${CANARY}`))
        .catch(() => {});                                                            // 失败
      await store.remove('netease');                                                 // 退出
    });
    const text = lines.join('\n');
    assert.ok(text.length > 0, '这几条路径确实打了服务日志（否则本条是空断言）');
    assert.equal(text.includes(CANARY), false, '服务日志里出现了凭据');
    assert.equal(/set-cookie/i.test(text), false, '服务日志里出现了响应头原文');
    assert.equal(JSON.stringify(audit.auditSnapshot()).includes(CANARY), false, '审计表里出现了凭据');
    const leftovers = [];
    for (const file of await listFiles(dataDir)) {
      if ((await readFile(file, 'utf8').catch(() => '')).includes(CANARY)) leftovers.push(relative(dataDir, file));
    }
    assert.deepEqual(leftovers, [], '退出之后数据目录里还留着凭据（写过的值必须随 remove 一起消失）');
    // 反向证明上一条不是空断言：没退出之前，那个文件里确实应该有它。
    await store.write('netease', session.jarFromCookieString(`MUSIC_U=${CANARY}`));
    assert.ok((await readFile(store.fileFor('netease'), 'utf8')).includes(CANARY), '凭据该落的地方没落，上一条就成了空跑');
    await store.remove('netease');
    audit.resetAudit();
  });
});

test('redact 形状层：Set-Cookie 片段整行遮住、name=长值遮值、JSON 凭据值遮住；短值与状态码不许误伤', () => {
  // 第一条必须靠"整行规则"，不能靠 name=长值 那条兜：所以挑一行**值都很短**的 Set-Cookie，
  // 里面没有任何 ≥12 字符的值，只有属性名。少了整行规则，HttpOnly/SameSite 这些就会留在日志里（变异 B17 验的正是这个）。
  const headerOnly = 'set-cookie: sid=abc; Path=/; HttpOnly; Secure; SameSite=Lax';
  assert.equal(/HttpOnly|SameSite|Path=/.test(session.redact(headerOnly)), false, 'Set-Cookie 整行遮住，属性名也不许留下');
  assert.ok(session.redact(headerOnly).includes('set-cookie'), '遮内容，不遮"这里出现过 Set-Cookie"这个事实');
  assert.equal(session.redact('响应头 Set-Cookie: MUSIC_U=abcdefgh1234567890').includes('abcdefgh1234567890'), false, '大小写与位置都要挡住');
  assert.equal(session.redact(`NMTID=${CANARY}; Path=/`).includes(CANARY), false, 'name=长值要遮住');
  assert.equal(session.redact('{"cookie":"MUSIC_U=abcdefgh1234567890"}').includes('abcdefgh1234567890'), false, 'JSON 形状的凭据值也要遮住');
  assert.equal(session.redact('{"token":"abcdefghij1234567890"}').includes('abcdefghij1234567890'), false, 'token 一类的键名同理');
  // "长"这条线本身就是一次显式决策，两个方向都要钉住：降到 4 会连状态码一起遮（变异 B18），
  // 升到 16 会放过一批真实凭据值 —— 两边都不许悄悄漂移。
  assert.equal(session.redact('code=803&qr=1'), 'code=803&qr=1', '短值不是凭据：把状态码遮掉会让日志没法读');
  assert.equal(session.redact('flag=abcd1234567'), 'flag=abcd1234567', '11 个字符仍在阈值之下');
  assert.notEqual(session.redact('flag=abcd12345678'), 'flag=abcd12345678', '12 个字符起按长值遮');
  assert.equal(session.redact('二维码已过期，请重新取码'), '二维码已过期，请重新取码', '中文说明原样过，不无脑改写');
  assert.equal(session.redact(''), '', '空串进空串出，不抛');
  assert.equal(session.redact(null), '', '非字符串按空处理：redact 站在日志出口，它自己不许成为崩溃点');
  assert.equal(session.redact(undefined), '');
  // 形状层的诚实边界（写下来才守得住）：散文里没键名的裸值它抓不到，兜底在 store.redact 那一层。
  assert.equal(session.redact(`上游说：${CANARY}`).includes(CANARY), true,
    '如实登记：这一层按形状走，没键名的裸值它不认识 —— 所以还要有登记表那一层');
});

test('redact 兜底层：store 把自己见过的值登记进去，退出之后仍然不许把这个值原样吐回日志', async () => {
  await withDataDir(async (dataDir) => {
    const store = session.createOnlineSession({ dataDir });
    await store.write('netease', session.jarFromCookieString(`MUSIC_U=${CANARY_TWO}`));
    assert.equal(store.redact(`上游说：${CANARY_TWO}`).includes(CANARY_TWO), false, '本进程写过的值必须被替换');
    await store.read('netease');
    assert.equal(store.redact(`报错里带上了 MUSIC_U=${CANARY_TWO}`).includes(CANARY_TWO), false, '读出来的值同样登记');
    assert.equal(store.redact('这一句本来就没凭据'), '这一句本来就没凭据', '没命中时原文照过，不无脑改写');
    // env 那一路的值也要登记：它从不落盘，最容易在报错时被原样回显。
    const fromEnv = session.createOnlineSession({ dataDir, env: { [session.NETEASE_ENV_KEY]: `MUSIC_U=${CANARY}` } });
    await fromEnv.read('netease');
    assert.equal(fromEnv.redact(`包把请求头回显了：${CANARY}`).includes(CANARY), false, 'env 来源的值同样在登记表里');
    // 退出之后兜底仍然有效：登记表不清空的理由是"刚删掉的值最容易出现在退出失败的报错里"。
    await store.remove('netease');
    assert.equal(store.redact(`上游说：${CANARY_TWO}`).includes(CANARY_TWO), false, '退出后依旧不许原样吐出这个值');
  });
});

test('静态半 tripwire：withSetCookie 只许出现在桥的 auth 模块与它的 QQ 适配器；桥不得 require 包根入口、不得出现 axios', async () => {
  const files = (await listFiles(join(SCRIPTS, 'bridge'))).filter((file) => file.endsWith('.mjs'));
  assert.ok(files.length >= 6, `桥的扫描面异常（只扫到 ${files.length} 个文件），这条断言不许空跑`);
  // 设计稿 §4.1 的原话是"auth 模块与它的 QQ 适配器"，所以这里认两个文件；再加第三个之前先改稿子。
  const ALLOWED = ['providers/auth.mjs', 'providers/qq-auth.mjs'];
  let opened = 0;
  for (const file of files) {
    const label = relative(SCRIPTS, file).replace(/\\/g, '/');
    if (ALLOWED.some((name) => label.endsWith(name))) { opened += 1; continue }
    const text = await readFile(file, 'utf8');
    assert.equal(/withSetCookie/.test(text), false, `${label} 不该能开这个开关`);
  }
  assert.equal(opened, ALLOWED.length, `开关的允许调用面是 ${ALLOWED.length} 个文件，今天扫到 ${opened} 个`);
  const all = (await Promise.all(files.map((file) => readFile(file, 'utf8')))).join('\n');
  // 根入口配置校验失败会 process.exit(1)（Task 0 一手踩过）：桥只准 require 子路径。
  assert.equal(/qq-music-api\/dist\/src\/app\.js/.test(all), false, '桥里出现了包根入口：它校验失败会直接把进程带走');
  assert.equal(/require\(\s*['"]@yakult-green-tea\/qq-music-api['"]\s*\)/.test(all), false, '根入口同上，一律不许 require');
  // axios 判**调用形状**，与 R75 那条同一口径：桥里有四处注释在解释"为什么不用包默认的 axios"，
  // 按"文里出现这个词"判会被自己的注释咬掉（第一版正是这样红的）。
  assert.equal(/require\(\s*['"]axios|from\s+['"]axios/.test(all), false, '桥里不许引 axios：那是绕开出网审计的那条路（R83 红线）');
});
