// 第五期 Task 11 自检：歌单面板的形状与文案（本项目范式——面板文案与动作都钉住）。
//
// 这一条盯的是"界面有没有把后端已经知道的事说出来"：
//   ① 三档状态徽标必须分得开（未查 ≠ 未匹配 ≠ 已匹配）——合并了用户就不知道该点哪个按钮；
//   ② 整单播放要报"跳过几条"，不能静默少几首；
//   ③ 导出的是用户能自己编辑、粘回来还能读的文本，不是内部 JSON；
//   ④ 歌单入口/分派/标题表都要在，否则面板打不开或标题是空的。
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPTS = dirname(fileURLToPath(import.meta.url));
const read = (relative) => readFile(new URL(`../${relative}`, import.meta.url), 'utf8');

const app = await read('src/music-app.ts');
const ui = await read('src/playlists-ui.ts');
const css = await read('src/music.css');
const server = await read('scripts/music-server.mjs');
// 歌单条目 → 内核队列的映射是纯函数，可以**行为级**钉住而不是只读源码找关键字
// （实机那条 bug 的第二半就藏在这个映射里：条目下标被当成队列下标用）。
const { playlistQueue } = await import('../src/online-search.ts');

test('歌单入口与面板形状：顶栏入口、Panel 联合、标题表、分派四处都在', () => {
  assert.match(app, /data-action="playlists"/, '顶栏入口');
  assert.match(app, /"library" \| "search" \| "settings" \| "playlists" \| "playlist"/, 'Panel 联合两种新面板');
  assert.match(app, /playlists: \["PLAYLISTS", "我的歌单"\]/, '标题表要有这一档（缺了会渲染出 undefined 标题）');
  assert.match(app, /playlist: \["PLAYLIST", "歌单详情"\]/, '详情页同理');
  assert.match(app, /if \(next === "playlists"\) void renderPlaylistsPanel\(\)/, '分派：列表');
  assert.match(app, /if \(next === "playlist"\) void renderPlaylistDetail\(\)/, '分派：详情');
  // 打开详情前必须先记住是哪一张：面板 id 与"当前打开的歌单"是两件事（后者决定重进时读哪张）。
  assert.match(app, /playlistOpenId = target\.dataset\.playlist/, '点列表行时记下 id');
  assert.match(app, /request<PlaylistDetail>\(`\/api\/playlists\/\$\{encodeURIComponent\(id\)\}\/tracks`\)/, '详情走 /tracks，并且 id 要编码');
});

test('状态徽标三档分得开：未查 ≠ 未匹配 ≠ 已匹配（合并了用户就不知道该点哪个按钮）', async () => {
  // 这一条真跑 TS 模块（链式命令带 --experimental-strip-types）：徽标是三档判据的产物，
  // 只读源码正则挡不住"把两档合成一档"的改法。
  const { entryBadge, playlistClock } = await import('../src/playlists-ui.ts');
  const track = { provider: 'netease', title: '恋人', artist: '李荣浩', album: '黑马', durationMs: 276000, mediaId: '1', quality: '自动', id: 'on-netease-1', sourceKind: 'online', audioUrl: '/api/online/stream?p=netease&id=1' };
  assert.equal(entryBadge({ entry: { title: '恋人', artist: '李荣浩' }, matched: true, track, score: 92, source: 'cache' }), '已匹配 · 网易云 92分');
  assert.match(entryBadge({ entry: { title: 'x', artist: 'y' }, matched: true, track: { ...track, provider: 'qq' }, source: 'cache' }), /已匹配 · QQ/);
  assert.equal(entryBadge({ entry: { title: 'x', artist: 'y' }, matched: false, source: 'none', reason: '最高分 62，低于阈值 75' }),
    '未匹配（最高分 62，低于阈值 75）', '结论词只出现一次——服务端 reason 里放的是读数');
  assert.equal(entryBadge({ entry: { title: 'x', artist: 'y' }, matched: false, source: 'none' }), '未查',
    '没查过与查了没配上必须是两句话');
  assert.equal(playlistClock(276000), '4:36');
  assert.equal(playlistClock(0), '--:--', '在线结果常不带时长，给占位而不是 0:00');
});

test('R150（Q18）让位那一格：改选过要说得出"谁让位"，没改选 / 同源 / 缺读数各是什么样子', async () => {
  const { entryBadge, yieldedLabel, detailMarkup } = await import('../src/playlists-ui.ts');
  const track = { provider: 'netease', title: '恋人', artist: '李荣浩', album: '黑马', durationMs: 276000, mediaId: '1', quality: '自动', id: 'on-netease-1', sourceKind: 'online', audioUrl: '/api/online/stream?p=netease&id=1' };
  const row = (extra) => ({ entry: { title: '恋人', artist: '李荣浩' }, matched: true, track, score: 95, source: 'cache', line: 2, lineText: '', ...extra });
  assert.equal(entryBadge(row({ preferred: true, over: { provider: 'qq', title: '恋人', artist: '李荣浩', score: 100 } })),
    '已匹配 · 网易云 95分 · 登录源优先（QQ 100 分那首已让位）',
    '用户看到的是一次"95 分而不是 100 分"的降级，不说依据就像配错了');
  assert.equal(yieldedLabel(row({})), '', '没有 preferred ⇒ 一个字都不许多（缺省关闭时这一行与今天逐字一样）');
  assert.equal(yieldedLabel(row({ preferred: false, over: { provider: 'qq', score: 100 } })), '', 'preferred=false 不算让位');
  assert.equal(yieldedLabel(row({ preferred: true, over: { provider: 'netease', score: 100 } })), '',
    '让位那条与这一行同源 ⇒ 不写（同一来源谈不上让位，写了就是谎话）');
  assert.equal(yieldedLabel(row({ preferred: true, over: null })), '', '说"改选过"却拿不出让位的是谁 ⇒ 宁可不写');
  assert.equal(yieldedLabel(row({ preferred: true, over: { provider: 'kugou' } })), ' · 登录源优先（酷狗那首已让位）',
    '没有分数就只报来源，不编一个 0 分；顺带钉住"第四家的中文名"——这句从前走的是本地那份三元表，酷狗会露出内部名');
  assert.equal(entryBadge(row({ score: 88, track: { ...track, provider: 'kugou' } })), '已匹配 · 酷狗 88分',
    '酷狗的行不许再显示成 `kugou`（R150 一手发现：表里只有网易云与 QQ 两档）');
  // 三档徽标各管各的：未匹配的行不许冒出这一句（它根本没配上，谈不上让位）
  assert.equal(entryBadge({ entry: { title: 'x', artist: 'y' }, matched: false, source: 'cache', reason: '最高分 62，低于阈值 75', preferred: true, over: { provider: 'qq', score: 100 } }),
    '未匹配（最高分 62，低于阈值 75）');
  // 真跑整块 markup：这句必须落在徽标那一格里（换列会把网格撑成第六列，R129 那格教训）
  const html = detailMarkup({ id: 't', name: '取证歌单', matched: 1, unmatched: 0, items: [row({ preferred: true, over: { provider: 'qq', score: 100 } })] });
  assert.match(html, /class="playlist-entry-badge matched">已匹配 · 网易云 95分 · 登录源优先（QQ 100 分那首已让位）<\/span>/,
    '让位那句走的是既有徽标格，且经过 esc');
});

test('详情页抬头那行真跑出来的计数：没查过说"未查"，查了没配上才说"未匹配"', async () => {
  // 真机截图 43 上这一屏是"5 条徽标全在未查、抬头却写未匹配 5 条"——两档口径分家，正则挡不住，只能真跑。
  const { detailMarkup } = await import('../src/playlists-ui.ts');
  const row = (title, extra) => ({ entry: { title, artist: '某人' }, matched: false, source: 'none', ...extra });
  const fresh = detailMarkup({
    id: 't', name: '取证歌单', matched: 0, unmatched: 2,
    items: [row('恋人'), row('不将就')],
  });
  assert.match(fresh, /匹配 0\/2/, '条数与已匹配数同时显示');
  assert.match(fresh, /未查 2 条/, '一条都没查过：抬头要说"未查"');
  assert.doesNotMatch(fresh, /未匹配/, '一条都没查过时抬头不许出现"未匹配"——那是"查了没配上"的意思');

  const mixed = detailMarkup({
    id: 't', name: '取证歌单', matched: 1, unmatched: 1,
    items: [
      { entry: { title: '恋人', artist: '某人' }, matched: true, source: 'cache', track: { provider: 'netease', title: '恋人', artist: '某人', album: '', durationMs: 276000, mediaId: '1', quality: '自动', id: 'on-netease-1', sourceKind: 'online', audioUrl: '/api/online/stream' } },
      row('查无此歌', { source: 'cache', reason: '最高分 62，低于阈值 75' }),
    ],
  });
  assert.match(mixed, /未匹配 1 条/, '查过没配上的那一档要出现在抬头');
  assert.doesNotMatch(mixed, /未查/, '全查过之后不该再有"未查"');
});

test('列表页说明"这是本机纯文本文件"，并给新建与粘贴导入两个入口', () => {
  assert.match(ui, /歌单是<b>本机上的纯文本文件<\/b>/, '可携带性要写在面板上，不是藏在文档里');
  assert.match(ui, /data-playlist="\$\{esc\(playlist\.id\)\}"/, '列表行按 id 打开详情');
  assert.match(ui, /data-action="playlist-import"/, '粘贴导入入口');
  assert.match(ui, /data-action="playlist-new"/, '新建入口');
  assert.match(ui, /\$\{playlist\.items\} 条/, '每单显示条数');
  assert.match(ui, /没有歌单。点上面两个入口之一开始/, '空态要给下一步，而不是只说"没有"');
});

test('详情页：条数与已匹配数同时显示，四个动作各一个，未匹配时禁用整单播放', () => {
  assert.match(ui, /匹配 \$\{detail\.matched\}\/\$\{detail\.items\.length\}/, '"匹配 4/5" 这种写法（需求原文的形状）');
  assert.match(ui, /const misses = detail\.items\.filter\(isMatchedMiss\)\.length/, '抬头那行的未匹配数与徽标共用一个判据');
  assert.match(ui, /未匹配 \$\{misses\} 条/, '未匹配数也要在标题行里，不能只在按钮后面');
  assert.match(ui, /未查 \$\{unchecked\} 条/, '没查过的那部分要单说一档，不许和"未匹配"混成一档');
  assert.match(ui, /data-action="playlist-match-all">联网匹配整单/, '整单匹配');
  assert.match(ui, /data-action="playlist-play-all" \$\{detail\.matched \? "" : "disabled"\}>播放已匹配的/, '一条都没匹配时不许给一个点了没反应的按钮');
  assert.match(ui, /导出为文本歌单/, '可携带性是需求原文');
  assert.match(ui, /data-action="playlist-delete"/, '删除入口（没有它用户就只能去磁盘上删文件）');
  assert.match(ui, /data-action="playlist-match-entry"/, '未匹配那行给"重搜"');
  assert.match(ui, /data-action="playlist-play-entry"/, '已匹配那行给"试听"');
  assert.match(ui, /id="playlist-status"[^>]*role="status"[^>]*aria-live="polite"/, '匹配进度走 aria-live，读屏能听到');
});

test('详情行有版式：网格列数 = 格子数 + 徽标独立一档颜色（没这两条就是一行连笔，截图 43/44 第一版就是这样）', () => {
  const entry = /\.playlist-entry \{[\s\S]*?\n\}/.exec(css)?.[0] ?? '';
  assert.ok(entry.length > 40, '样式表里没有 .playlist-entry——五个 span 会挤成一行连笔');
  assert.match(entry, /display: grid/, '各列要分开');
  assert.match(entry, /grid-template-columns:.*minmax\(0,.*fr\).*minmax\(0,.*fr\)/, '两条可变列都要 minmax(0,…)（长徽标不许把曲名挤出容器）');
  assert.match(css, /\.playlist-entry-copy \{[\s\S]*?min-width: 0/, '曲名那列要能收缩');
  assert.match(css, /\.playlist-entry-badge\.matched \{[\s\S]*?var\(--accent\)/, '已匹配那档除了文字还要有颜色');
});

test('R129（Q7）：格子数与列数必须相等——多一格没改列宽，真机里那颗按钮就掉到下一行', async () => {
  const { detailMarkup } = await import('../src/playlists-ui.ts');
  const columns = (rule) => rule.replace(/\([^)]*\)/g, '()').trim().split(/\s+/).length;
  const playlistColumns = columns(/\.playlist-entry \{[\s\S]*?grid-template-columns:([^;]*);/.exec(css)?.[1] ?? '');
  const artistColumns = columns(/\.artist-entry \{[\s\S]*?grid-template-columns:([^;]*);/.exec(css)?.[1] ?? '');
  const markup = detailMarkup({
    id: 'x', name: 'x', matched: 1, unmatched: 1,
    items: [
      { entry: { title: '恋人', artist: '李荣浩' }, matched: true, track: { coverUrl: '/api/online/artwork/aa' }, source: 'cache', line: 4, lineText: '' },
      { entry: { title: '别的', artist: '某人' }, matched: false, source: 'cache', line: 5, lineText: '别的 - 某人' },
    ],
  });
  // 一行里的格子：封面 / 曲名 / 时长 / 徽标 / 动作 —— 五格（R129 新增的就是第一格）。
  // 徽标那格带条件类名（`playlist-entry-badge matched`），所以类名后面允许空格或引号。
  const cells = (markup.match(/<span class="playlist-entry-(?:cover|copy|clock|badge|actions)[ "]/g) ?? []).length;
  assert.equal(cells, playlistColumns * 2, `两行共 ${cells} 个格子、列数 ${playlistColumns}：多出来的那一格会掉进隐式第二行`);
  // 动作那一格必须是 flex：两颗按钮（重搜 + 手工指定）不能各占一列
  assert.match(css, /\.playlist-entry-actions \{\s*display: flex/, '动作列要包一层 flex，两颗按钮不许撑出第六列');
  assert.match(markup, /playlist-entry-cover"><img class="" src="\/api\/online\/artwork\/aa"/, '已匹配那行显示曲目自己的封面（数据 R119 就通了，缺的是这一格）');
  assert.match(markup, /playlist-entry-cover">\s*<span class="cover-placeholder"/, '没封面就画既有占位，不造一个会 404 的地址（F3 同一条判据）');
  assert.equal((markup.match(/data-action="playlist-pick-open"/g) ?? []).length, 1, '只有未匹配那行有「手工指定」');
  // 音乐人行是另一套列宽（四格），蹭歌单行那套会把曲名挤进 40px
  assert.equal(artistColumns, 4, `.artist-entry 自己声明的是四格一套，实测 ${artistColumns} 列`);
});

test('导出文件名就是磁盘上那个文本文件名（粘回来还能读，不导内部 JSON）', async () => {
  assert.match(ui, /return `\$\{id\}\.playlist\.txt`/, '导出名 = <slug>.playlist.txt');
  assert.doesNotMatch(ui, /\.json`/, '导出面不许出现 JSON 文件名（那是匹配缓存，不是用户资产）');
  const exportHandler = /async function exportPlaylist\(\)[\s\S]*?\n}\n/.exec(app)?.[0] ?? '';
  assert.ok(exportHandler.length > 200, '没抓到导出函数');
  assert.match(exportHandler, /\/api\/playlists\/\$\{encodeURIComponent\(playlistOpenId\)\}`/, '导出读的是那份原文 text');
  assert.match(exportHandler, /new Blob\(\[data\.playlist\.text\], \{ type: "text\/plain;charset=utf-8" \}\)/, '按 text/plain 下载');
  assert.match(exportHandler, /link\.download = exportFileName/, '文件名走同一个助手（两处不一致就会导出成怪名字）');
});

test('整单播放与单条「试听」都全量入队，回执数字读内核队列（曾经这条断言把缺陷本身钉住了）', () => {
  const playAll = /async function playPlaylistFromDetail[\s\S]*?\n}\n/.exec(app)?.[0] ?? '';
  assert.ok(playAll.length > 600, '没抓到整单播放函数');
  // 曾经的形状是 playOnlineTrack(player, target)（单首队列），而这条断言当时就是照着它写的 ⇒
  // 夹具全绿、实机 279 条播完即停。教训：**断言要钉"想要的行为"，不能钉"当时那行码"**。
  assert.match(playAll, /player\.play\(start\.id, tracks\)/,
    '必须把全部匹配曲目经内核 play(id, tracks) 入队——R109 四档、ended 续播、上一首/下一首全看队列');
  assert.doesNotMatch(playAll, /playOnlineTrack\(/,
    '这条通路不许退回单首队列（那个封装只留给搜索结果行的"试听"，它本来就不该换掉用户的本地队列）');
  assert.match(playAll, /还没有任何一条匹配上/, '一条都没有时要说人话并指向"联网匹配整单"');
  // 条目下标 ≠ 队列下标：有未匹配条目时两者不等长，拿前者去索引后者会播错歌（映射本身在 online-search 里行为级钉）。
  assert.match(playAll, /playlistQueue\(playlistDetail\.items\)/, '过滤与下标映射共用同一个出处，不在界面里各算一遍');
  assert.match(playAll, /entries\.indexOf\(wanted\)/, '起点按**原始条目下标**找（data-entry 是歌单第几条），不是拿它索引过滤后的数组');
  // 回执的数字必须来自内核：play() 会按 id 去重，照抄自己算的那份会虚报。
  assert.match(playAll, /const queued = player\.state\.queue\.length/, '回执读内核队列的实际长度，不读自己递出去的那份');
  assert.match(playAll, /正在播放已匹配的 \$\{queued\} 条/, '回执用那个数');
  assert.match(playAll, /未匹配，已跳过/, '跳过数要如实');
  assert.match(playAll, /按 id 去重后不再排第二次/, '被内核去重掉的那几条也要说出来，否则数字还是对不上');
});

test('整单匹配的回执写在重渲染之后（顺序反了就被自己清空——真机截图 44 上那一行原本是空的）', () => {
  const fn = /async function matchWholePlaylist\(\)[\s\S]*?\n}\n/.exec(app)?.[0] ?? '';
  assert.ok(fn.length > 300, '没抓到整单匹配函数');
  const rerender = fn.indexOf('await renderPlaylistDetail()');
  const receipt = fn.indexOf('匹配完成');
  assert.ok(rerender > 0, '匹配完要重渲染，否则徽标停在"未查"');
  assert.ok(receipt > 0, '要给一句回执');
  assert.ok(rerender < receipt, '回执必须在重渲染之后：renderPlaylistDetail() 会重建 #playlist-status');
  assert.match(fn, /本次联网查询 \$\{summary\.searches\} 次/, '回执要说这轮真的出了几次网（缓存命中与现查要分得开）');
  assert.match(fn, /没配上的如「\$\{summary\.failed\[0\]\.entry\.title\}」/, '失败原因要点名一条，不能只给个数字');
});

test('面板不重复实现后端判断：三档徽标的判据来自 /tracks 的 matched/source/reason', () => {
  assert.match(ui, /if \(item\.matched && item\.track\)/, '已匹配那档看服务端的 matched');
  assert.match(ui, /!item\.matched && \(item\.source === "cache" \|\| Boolean\(item\.reason\)\)/, '未匹配 = 查过且服务端留过痕');
  assert.match(ui, /return PLAYLIST_UNCHECKED/, '两者都不是才是"未查"');
  assert.match(ui, /PLAYLIST_BADGE = "已匹配"/, '三档文案是常量，散在模板里就会写错字');
  // 来源名与 Task 5/7 那张表**同源**。从前这两条钉的是面板里的字面量 `"网易云"` / `"QQ"`；
  // R150 把面板那份只有两档的三元表换成读 `ONLINE_PROVIDER_LABELS`（酷狗的行从前会露出内部名 `kugou`），
  // 字面量就搬到共享表里去了 ⇒ 判据跟着换成"必须引用那张表 + 不许在面板里再造一份映射"。
  // （钉实现文本而不是不变式的代价，R127 那条已经记过一次：一次正常重构会被判成回归。）
  assert.match(ui, /import \{ ONLINE_PROVIDER_LABELS/, 'provider 中文名读那张共享表（不各写一套叫法）');
  assert.doesNotMatch(ui, /=== "netease" \? "网易云"/, '不许在面板里再造一份来源映射——第二处真源一定会漂');
});

test('F2：在线结果行有"加入歌单"，选择器同时给"加进已有的"和"新建一张并加入"', async () => {
  const { addToPlaylistMarkup } = await import('../src/playlists-ui.ts');
  assert.match(app, /data-action="playlist-add-open" data-online-index="\$\{index\}"/, '每一行都要有入口，不能只做第一行');
  // 只钉"行外面包一层网格、多出来的按钮是它的兄弟节点"这个不变式，不钉按钮清单的具体长度：
  // R127 加了第三颗（指定这一颗）时，钉死 `${row}${add}</div>` 的写法会把一次正常扩展判成回归。
  assert.match(app, /<div class="online-row">\$\{row\}\$\{add\}/, '行本身是 button，按钮不能套按钮 ⇒ 外面包一层网格，附加按钮做兄弟节点');
  // 网格要预先留好第三列：真机截图里那颗"指定这一条"折到了**下一行居中**，看着像上一行的说明。
  const rowRule = /\.online-row \{\s*display: grid;\s*grid-template-columns:([^;]*);/.exec(css)?.[1] ?? '';
  // 先把括号里的逗号分量抹掉再数（`minmax(0, 1fr)` 里那个空格不是列分隔符）
  assert.equal(rowRule.replace(/\([^)]*\)/g, '()').trim().split(/\s+/).length, 3, `.online-row 要三列（曲名 / 加入歌单 / 手工指定），实测「${rowRule.trim()}」`);
  assert.match(css, /\.online-row \.online-add,\s*\.online-row \.online-pick \{/, '两颗按钮同一套字号与不换行，不许一颗大一颗小');
  assert.match(app, /audioUrl: item\.audioUrl/, '交出去的是我们签发的那条同源地址（身份由服务端反解，前端不拼格式）');
  assert.doesNotMatch(app, /action: "add"[\s\S]{0,200}mediaMid/, '前端不许自己拼身份段——那是第二处真源');
  const markup = addToPlaylistMarkup([{ id: '黑马', name: '黑马', items: 3, updatedAt: 0 }, { id: '我的单', name: '我的单', items: 0, updatedAt: 0 }], { title: '恋人' });
  assert.equal((markup.match(/data-action="playlist-add-to"/g) ?? []).length, 2, '每张现存歌单都是一个可点目标');
  assert.match(markup, /加进「黑马」（3 条）/, '选之前要看得到条数');
  assert.match(markup, /id="playlist-add-new"/, '零歌单时也要能一次做完：新建并加入');
  assert.match(markup, /把「恋人」加进哪张歌单/, '问句要带着被加的那条，免得点了才知道加的是什么');
  const empty = addToPlaylistMarkup([], { title: '恋人' });
  assert.match(empty, /playlist-add-new/, '一张歌单都没有时，新建入口必须还在');
  assert.equal(/playlist-add-to/.test(empty), false, '没有歌单就不该冒出"加进某张"');
  // 真机抓到的自引入缺陷：选择器的"重画"接在了 `renderOnlineResults()`（那是"检索 + 渲染"两件事）
  // ⇒ 打开选择器、加完歌单各算一次第三方检索（审计里 search 从 1 变 4）。渲染与检索必须分家。
  const chooser = /async function toggleAddChooser[\s\S]*?\n}\n/.exec(app)?.[0] ?? '';
  const adder = /async function addOnlineEntryToPlaylist[\s\S]*?\n}\n/.exec(app)?.[0] ?? '';
  assert.ok(chooser.length > 200 && adder.length > 300, '没抓到选择器/加入这两个函数');
  for (const [name, body] of [['toggleAddChooser', chooser], ['addOnlineEntryToPlaylist', adder]]) {
    assert.equal(/renderOnlineResults\(\)|requestOnlineSearch\(/.test(body), false, `${name} 不许触发检索——它只该重画`);
    assert.match(body, /paintOnlineResults\(\)/, `${name} 走纯渲染那条`);
  }
  assert.match(app, /onlineResponse = response;\s*\n\s*onlineResults = response\.items;/, '结果集与"上一次响应"同源更新，渲染只读它们');
});

test('F2：身份段的往返只认自己签发的地址（逆函数与 toOnlineTrack 同源）', async () => {
  const normalize = await import('../scripts/bridge/providers/normalize.mjs');
  assert.match(server, /identityFromStreamUrl\(item\?\.audioUrl\)/, '路由要用逆函数，不许前端直接写身份');
  const qq = normalize.toOnlineTrack({ provider: 'qq', mediaId: '003abc', mediaMid: '004def', title: 't', artist: 'a', durationMs: 1000 });
  assert.deepEqual(normalize.identityFromStreamUrl(qq.audioUrl), { provider: 'qq', mediaId: '003abc', mediaMid: '004def' });
  const ncm = normalize.toOnlineTrack({ provider: 'netease', mediaId: '27699577', title: 't', artist: 'a' });
  assert.deepEqual(normalize.identityFromStreamUrl(ncm.audioUrl), { provider: 'netease', mediaId: '27699577' });
  for (const bad of ['', null, '/api/online/stream', 'https://evil.example.com/api/online/stream?p=netease&id=1',
    '/api/other/stream?p=netease&id=1', '/api/online/stream?p=evil&id=1', '/api/online/stream?p=netease']) {
    assert.equal(normalize.identityFromStreamUrl(bad), null, `${JSON.stringify(bad)} 不该被当成身份`);
  }
});

test('F3：列表抬头那句"歌单在哪"要跟着用户选的目录走，不许写死默认路径', async () => {
  const { listMarkup } = await import('../src/playlists-ui.ts');
  assert.match(ui, /export function listMarkup\(playlists: PlaylistSummary\[\], dirLabel\?: string\)/, '签名要收当前目录');
  assert.match(app, /listMarkup\(data\.playlists, library\.playlistDir\)/, '调用处把快照里的当前目录传进去');
  const custom = listMarkup([], 'D:\\音乐\\歌单');
  assert.match(custom, /D:\\\\音乐\\\\歌单|D:\\音乐\\歌单/, '抬头显示的是真正在用的那个文件夹');
  assert.equal(custom.includes('数据目录/playlists'), false, '换了目录还写"数据目录/playlists"就是假话');
  const fallback = listMarkup([]);
  assert.match(fallback, /数据目录\/playlists/, '没传目录时退回那句通用说明（旧库/未加载快照的形态）');
});

test('F3：设置面板有"歌单文件夹"，改目录前确认、改完回报复制了几个文件', () => {
  assert.match(app, /\.id = "playlist-dir-config"/, '设置面板要有这一节（不放在这里用户就找不到）');
  assert.match(app, /当前：<code>\$\{esc\(library\.playlistDir \?\? ""\)\}/, '显示的是当前真正在用的目录，不是配置里可能为 null 的那项');
  assert.match(app, /id="playlist-dir" type="text"/, '要能填新路径');
  assert.match(app, /data-action="save-playlist-dir"/, '应用按钮');
  assert.match(app, /"\/api\/config", \{ playlistDir: raw \}/, '走配置那条通路提交（不另造一条写盘路由）');
  assert.match(app, /window\.confirm\(`把歌单文件夹改成 \$\{raw\}[\s\S]{0,80}复制/, '改目录会复制用户文件 ⇒ 动手前确认一次');
  assert.match(app, /复制 \$\{moved\.copied\} 个文件\$\{moved\.skipped \? `，\$\{moved\.skipped\} 个同名跳过` : ""\}/, '复制了几个、跳过几个都要说');
  assert.match(app, /老目录里的原件保留/, '要说清"不删源"，用户才知道这不是移动');
  assert.match(app, /id="playlist-dir-state"[^>]*role="status"[^>]*aria-live="polite"/, '失败原因走 aria-live 说得出来');
});

test('在线能力面板仍管得住新加的两张子开关（Task 7 的兑现，Task 11 不许把它写丢）', () => {
  assert.match(app, /ONLINE_SWITCHES_UI/, '三张开关的表还在');
  assert.match(app, /"\/bridge\/playlist": "歌单导入（经本地在线后端）"|歌单导入/, '桥的歌单路由在审计面板里有中文名');
  assert.match(app, /"\/bridge\/search": "在线搜索（经本地在线后端）"/, '搜索那档仍在');
});

// ── M3-a Task E：扫码登录的界面 ─────────────────────────────────────────────
test('登录那一节在，且三条诚实声明逐条说出口（VIP 仍试听 / 凭据只在本机 / 本地音乐不受影响）', async () => {
  assert.match(app, /id = "online-auth-config"/, '登录要单独一节，不塞进「在线能力」那一段里');
  assert.match(app, /VIP 歌曲对非 VIP 账号仍然只有试听/, '平台规则这句必须写在界面上，不是只写在文档里');
  assert.match(app, /本机不做任何绕过/, '不绕过 VIP 是用户定案，界面上也要说');
  assert.match(app, /本地音乐始终完整播放，与登录态无关/, '本地不受影响这一条要说出来');
  assert.match(app, /凭据只保存在这台机器的服务端/, '凭据去向要在界面上讲清楚');
  assert.match(app, /包括 QQ 登录用的一条长连接/, 'MQTT 那条通道在面板文案里也要点名，不许只在审计表里出现');
  // 这一节挂在「在线能力」之后：它依赖在线能力开着（路由才会应答），顺序反了用户会先看到按钮再看到开关。
  assert.ok(app.indexOf('id = "online-lyrics-config"') < app.indexOf('id = "online-auth-config"'), '登录节在在线能力之后');
});

test('界面只读状态字段：源码里出现不了凭据形状的东西', () => {
  const block = app.slice(app.indexOf('type AuthProviderView'), app.indexOf('async function startQrLogin'));
  assert.ok(block.length > 800, '没截到登录界面那一段（改名了要同步改这条）');
  for (const banned of ['setCookie', 'cookieHeaderFor', 'MUSIC_U', 'secret', 'credential']) {
    assert.equal(block.includes(banned), false, `界面里出现了 ${banned}`);
  }
  // 二维码 data URI 是唯一被允许进 DOM 的长串，它是图不是凭据。
  assert.match(app, /result\.qr\?\.image/, '图片从 qr.image 走');
  assert.match(app, /alt="扫码登录用的二维码"/, '图片要有 alt（读屏与截图排障都用得上）');
});

test('轮询节奏由服务端 pollMs 给，且上一轮 settle 之后才排下一轮', () => {
  assert.match(app, /pollMs \?\? 2000/, '节奏取服务端的值，缺省才是 2000');
  const poll = app.slice(app.indexOf('function scheduleAuthPoll'), app.indexOf('async function startQrLogin'));
  const awaitAt = poll.indexOf('await request');
  const scheduleAt = poll.indexOf('scheduleAuthPoll(provider, pollMs)', awaitAt);
  assert.ok(awaitAt > 0 && scheduleAt > awaitAt, '重排必须发生在这一轮 await 之后（写在前面就是并发轮询）');
  assert.match(poll, /if \(authTimers\.has\(provider\)\) return/, '重复点按钮不该叠出并行轮询');
  assert.match(poll, /isConnected\) return/, '面板被切走就停：留下一个没人看的定时器是纯粹的出网');
  assert.match(app, /const authTimers = new Map/, '两家各一张码 ⇒ 定时器是一张表不是一个变量');
});

test('三个动作都有按钮与 case，且取消说的是"本机不再轮询"而不是假装通知了上游', () => {
  for (const action of ['auth-start', 'auth-logout', 'auth-cancel']) {
    assert.match(app, new RegExp(`data-action="${action}"`), `按钮 ${action}`);
    assert.match(app, new RegExp(`case "${action}"`), `case ${action}`);
  }
  assert.match(app, /服务端那一轮会在二维码过期时自动作废/, '取消的文案要说清它到底取消了什么');
  assert.match(app, /case "auth-cancel": \{/, 'cancel 那档带块级作用域（case 里声明变量会撞）');
});

test('审计面板认得登录两档：auth 与 auth-mqtt 都有中文名（MQTT 不许沉默存在）', () => {
  assert.match(app, /auth: "扫码登录请求"/, 'auth 那一档');
  assert.match(app, /"auth-mqtt": "扫码登录的长连接（QQ，独立于普通请求）"/, 'auth-mqtt 那一档要写明它是长连接、不是普通请求');
  assert.match(app, /"\/bridge\/auth": "扫码登录（经本地在线后端）"/, '桥那条路由的原始名也要能被翻成人话');
});

test('登录状态五档与两家 provider 在界面上齐全，未登录/环境变量/会话文件三种来源分得开', () => {
  for (const state of ['waiting', 'scanned', 'confirmed', 'expired', 'error']) {
    assert.ok(app.includes(`${state}: "`), `缺 ${state} 那一档的中文名`);
  }
  assert.match(app, /id: "netease", label: "网易云音乐"/, '网易那一行');
  assert.match(app, /id: "qq", label: "QQ 音乐"/, 'QQ 那一行');
  assert.match(app, /凭据来自环境变量/, 'env 来源要说出来（它意味着这份凭据不在数据目录里）');
  assert.match(app, /entries === null \? "" : ` · \$\{view\.entries\} 项`/, 'QQ 那份是密文，条数不知道就干脆不显示，不写 0 项装成知道');
});

test('登录那节的 CSS 形状：行是 flex，废二维码真的隐藏（hidden 碰上 flex 需要显式 none）', () => {
  assert.match(css, /\.auth-row \{[^}]*display: flex/, '一行内状态与按钮两端排');
  assert.match(css, /\.auth-qr \{[^}]*display: flex/, '二维码块默认是 flex');
  assert.match(css, /\.auth-qr\[hidden\] \{[^}]*display: none/, '取消/结束后要真消失：display:flex 会盖掉 hidden 属性');
  assert.match(css, /\.auth-qr-image \{[^}]*background: #fff/, '二维码白底 + 描边，深色主题上才不糊边');
});

// ── M3-b：试听片段 / 完整播放 的标注 ─────────────────────────────────────────
test('M3-b：播放范围徽标在传输区、默认隐藏，三档文案齐全且都说实话', () => {
  assert.match(app, /class="playback-scope" data-role="playback-scope" hidden/, '徽标默认隐藏（本地曲目不该看到它）');
  assert.match(app, /试听片段\$\{result\.trialSeconds \? ` \$\{result\.trialSeconds\} 秒` : ""\}/, '试听要说得出多少秒');
  assert.match(app, /"完整播放"/, '完整那一档');
  assert.match(app, /"播放范围未知"/, '查不到就说查不到：不伪装成试听（让人以为登录白登），也不伪装成完整（那是骗）');
  assert.match(app, /"没有可用音源"/, 'unavailable 是第四档，别混进"未知"');
  // 试听的 tooltip 要把"这是平台规则 + 登录能改变什么"说清，这是用户定案在界面上的落点。
  assert.match(app, /未登录或非 VIP 账号只开放试听片段/, 'tooltip 说规则');
  // R217：指路方向按事实改写 —— 登录区住在**音乐库面板**里（renderLibraryPanel 那一节），不在设置面板。
  assert.match(app, /在音乐库面板的「扫码登录」里用你自己的账号登录后/, 'tooltip 指路，不是只说"不能播"');
});

test('M3-b：一次切歌只问一次，回来时已换歌就不贴答案（异步最常见的错法）', () => {
  const fn = app.slice(app.indexOf('async function refreshPlaybackScope'), app.indexOf('function syncTransportControls'));
  assert.ok(fn.length > 600, '没截到这个函数');
  assert.match(fn, /if \(scopeTrackId === track\.id\) return;/, '同一首不重复查');
  const guards = [...fn.matchAll(/if \(scopeTrackId !== track\.id\) return;/g)].length;
  assert.ok(guards >= 2, `回来之后的比对至少两处（成功路径与失败路径各一处），实际 ${guards} 处`);
  assert.match(fn, /track\.id\.startsWith\("on-"\)/, '只有在线曲目才查：本地曲目多一次请求就是白耗');
  assert.match(fn, /badge\.hidden = true/, '切回本地曲目要把徽标收起来，不能留着上一首的"完整播放"');
});

test('M3-b：判据不来自时长——界面里不许拿 audio 的 duration 猜试听还是整首', () => {
  const fn = app.slice(app.indexOf('async function refreshPlaybackScope'), app.indexOf('function syncTransportControls'));
  for (const banned of ['duration', 'currentTime', 'ended']) {
    assert.equal(fn.includes(banned), false, `播放范围的判据里出现了 ${banned}：时长是解码器给的，试听与整首在它眼里没区别`);
  }
  assert.match(fn, /"\/api\/online\/audio-scope"/, '依据只能来自服务端取址结果（freeTrialInfo）');
  // R141 补的一条：回落要带"这首歌是谁"（含时长，只用于检索与挑同名曲）。
  // 这条纪律的**边界**因此必须显式说清楚，而不是让人以为那个 helper 是随便放外面的：
  // helper 在扫描区之外，扫描区里连字符串 "duration" 都不许出现。
  const helperAt = app.indexOf('function onlineTrackIdentityPayload');
  const scopeAt = app.indexOf('async function refreshPlaybackScope');
  assert.ok(helperAt > 0 && helperAt < scopeAt, '身份 helper 必须声明在范围判据之前（也即在扫描区之外）');
  assert.match(app.slice(helperAt, scopeAt), /durationMs: Math\.round\(\(track\.duration \?\? 0\) \* 1000\)/,
    '时长是在那一格换算的：交给服务端检索用，不参与范围判断');
  assert.match(fn, /online: onlineTrackIdentityPayload\(track\)/, '范围那一段只是把身份交出去');
});

test('M3-b：徽标样式在位，hidden 真的能藏（胶囊是 inline-flex，会盖掉 hidden）', () => {
  assert.match(css, /\.playback-scope \{[\s\S]{0,220}border-radius: 999px/, '一颗胶囊，不是告警色');
  assert.match(css, /\.playback-scope\[hidden\] \{[\s\S]{0,60}display: none/, 'hidden 必须显式 none');
});

test('R103：subscribe 回调里引用的模块级绑定必须声明在注册之前（TDZ 的形状判据）', () => {
  // `player.subscribe(fn)` 的回调在**注册那一刻同步跑一次**（文件里那条注释早就写着，
  // 但 M3-b 的徽标状态声明在它之后 —— 真机启动时撞出两条
  // `Cannot access 'x' before initialization`，离线断言全绿也拦不住）。
  // 所以这里钉形状：回调体里出现的每个模块级 `let`，声明位置必须在 subscribe 之前。
  const at = app.indexOf('player.subscribe(');
  assert.ok(at > 0, '没抓到 player.subscribe 的注册点');
  const callback = /\(state\) => \{([\s\S]*?)\n\}\);/.exec(app.slice(at))?.[1] ?? '';
  assert.ok(callback.length > 200, '没截到订阅回调体');
  const called = [...callback.matchAll(/(?:void\s+)?([a-zA-Z_$][\w$]*)\(/g)].map((m) => m[1]);
  const offenders = [];
  for (const name of new Set(called)) {
    // 只看模块级的 `let/const 名字`：函数声明本来就被提升，不是这一条管的东西。
    const declaration = new RegExp(`^(?:let|const) ${name}\b`, 'm').exec(app);
    if (declaration && declaration.index > at) offenders.push(`${name}@${declaration.index}>${at}`);
  }
  assert.deepEqual(offenders, [], `订阅回调引用了注册之后才声明的模块级绑定：${offenders.join(', ')}`);
  assert.ok(app.indexOf('let scopeTrackId') < at, '播放范围那枚徽标的状态必须在注册前声明（R103 的起因）');
});

test('R104：扫码那一格按家的 id 找得到，且二维码活得过下一次轮询（真机抓到的两处静默）', () => {
  // 起因：真机上点「扫码登录」什么都不发生。两处各自成立、合起来静默：
  //   ① 取格子用后代选择器 `[data-auth-provider=…] [data-role='auth-qr']`，而那一格是行的**兄弟**；
  //   ② 就算取到了，面板每 2 秒整体重画那两行，直接写进 DOM 的图会被下一拍抹掉。
  const start = app.slice(app.indexOf('async function startQrLogin'), app.indexOf('async function logoutAuth'));
  assert.ok(start.length > 400, '没截到 startQrLogin');
  assert.match(start, /querySelector<HTMLElement>\(`\[data-auth-qr='\$\{provider\}'\]`\)/, '取格子必须按家自己的 id');
  assert.equal(start.includes("[data-auth-provider='"), false, '不许再从那一行往下找二维码格（兄弟节点找不到）');
  assert.match(start, /authQrImages\.set\(/, '二维码要存进模块状态，重画时才有据可画');
  assert.match(app, /const qr = authQrImages\.get\(provider\.id\)/, '渲染必须从那份状态读（写 DOM 会被下一次轮询抹掉）');
  assert.match(app, /data-auth-qr="\$\{provider\.id\}"/, '标记里必须带上这个 id');
  // 废图不能留在面板上：轮询到终态、取消、退出三处各清一次。
  const cleared = [...app.matchAll(/authQrImages\.delete\(/g)].length;
  assert.ok(cleared >= 3, `清那张废图的地方至少三处（终态/取消/退出），实际 ${cleared}`);
  // 找不到格子时必须说实话，不许静默 return。
  assert.match(start, /notify\("登录那一格还没画出来/, '取不到格子要给用户一句可读的话');
});

test('R109：播放模式那颗按钮——标记、分派、刷新三处都读内核那一份，界面不自存模式', async () => {
  // ① 标记：初始文字必须从偏好推出来。写死"顺序"会让"上次开着随机、刷新后按钮说顺序、
  //    而内核其实在随机"这种错位成为可能（内核与界面各说各话）。
  assert.match(app, /data-action="playback-mode" id="playback-mode" class="transport-mode"/, '传输区那一颗要在位');
  assert.match(app, /\$\{PLAYBACK_MODE_NAMES\[preferences\.playbackMode\]\.short\}/, '按钮初始文字取自偏好');
  assert.match(app, /playbackMode: "sequential" as MusicPlaybackMode/, '偏好缺省=顺序：升级当天零观感变化');
  assert.match(app, /if \(!PLAYBACK_MODES\.includes\(preferences\.playbackMode\)\)\s*\n?\s*preferences\.playbackMode = "sequential"/, '非法值回落顺序');
  assert.match(app, /playbackMode: preferences\.playbackMode,\s*\n\}\);/, '建内核时必须把偏好交下去（交了不算，得交到构造参数上）');
  // ② 分派：动作在内核、持久化在宿主、提示用**内核返回的那一档**（不是界面自己算的下一个）。
  const dispatch = app.slice(app.indexOf('case "playback-mode"'), app.indexOf('case "scan"'));
  assert.match(dispatch, /const next = player\.cyclePlaybackMode\(\)/, '周期由内核算');
  assert.match(dispatch, /preferences\.playbackMode = next/, '落盘用内核返回的值');
  assert.match(dispatch, /savePrefs\(\)/, '走既有的偏好写入口（不是另拼一次 localStorage 调用）');
  assert.match(dispatch, /播放模式：\$\{PLAYBACK_MODE_NAMES\[next\]\.name\}/, '提示里说的是真生效的那一档');
  assert.ok(dispatch.length < 900, `playback-mode 那一档分派被截长了（${dispatch.length}），断言面不成立`);
  // ③ 刷新：三处显示（文字 / aria-label / 高亮）全部来自 state.playbackMode。
  const sync = app.slice(app.indexOf('function syncTransportControls'), app.indexOf('// 底部胶囊与 Folia 悬浮条共用同一条 seek 通路'));
  assert.match(sync, /PLAYBACK_MODE_NAMES\[state\.playbackMode\]/, '按钮状态读内核快照');
  assert.match(sync, /播放模式：\$\{modeLabel\.name\}/, 'aria-label 说得出当前模式（读屏与截图都要靠它）');
  assert.match(sync, /dataset\.mode = "active"/, '非缺省档才亮起来');
  // 真机抓到的一处静默：第一版照着 prev/next 给这颗加了 `disabled = queue.length < 2`，
  // 于是空队列 / 单曲队列下按钮直接不收 click —— 四档周期卡在"顺序"上，点了没反应也没报错。
  // 模式是偏好不是传输动作：**永远可点**。
  assert.doesNotMatch(sync, /playback-mode[\s\S]{0,80}\.disabled/, '这颗不许按队列长度禁用（disabled 的按钮收不到 click，静默无反应）');
  assert.equal(sync.includes('modeButton.disabled'), false, '不许给模式那颗写 disabled');
  assert.equal(/let (playbackMode|currentMode)\b/.test(app), false, '界面不许自己存一份"当前模式"：岛内改完就会与内核漂');
  // 岛内那颗按钮改了模式 ⇒ 宿主要把偏好落盘（动作在内核、持久化在宿主，与返回键同一条路子）。
  assert.match(app, /notifyPlaybackMode: \(mode\) =>/, '岛的回调在装配处接上');
  assert.match(app, /if \(preferences\.playbackMode !== mode\)/, '同值不写盘');
  // R103 的同一形状：这张表在订阅回调之前声明（回调在注册那一刻同步跑一次，读的是模块级绑定）。
  assert.ok(app.indexOf('const PLAYBACK_MODE_NAMES') < app.indexOf('player.subscribe('),
    '模式表必须声明在 player.subscribe 之前');
  assert.match(css, /\.minimal-transport button\.transport-mode\s*\{/, '那颗是文字胶囊：没有这条规则它会缩成 29px 方格里挤不下的两个字');
  // 真机截图抓到的：`.minimal-transport button` 那条 34px 方格 + 不换行缺失 ⇒ 两个汉字竖着排成两行。
  assert.match(css, /\.minimal-transport button\.transport-mode\s*\{[^}]*white-space:\s*nowrap/, '文字胶囊必须不换行（两个汉字挤成两行时它看起来像个圆点）');
  assert.match(css, /\.minimal-transport button\.transport-mode\[data-mode="active"\]/, '高亮态要有样式（判据收紧到"选择器整段对上"：前缀能匹配的写法会把改名成 transport-mode-x 的坏版本也放过去）');
  // 窄屏（portrait）那条 24px 是给图标方格定的规则，会把两个汉字挤没 —— 必须把这一颗排除出去。
  const switchCss = await read('src/music-theme-switch.css');
  assert.match(switchCss, /button:not\(\.transport-track\):not\(\.transport-mode\)/, 'portrait 的 24px 方格规则要排除模式那颗');
  assert.match(switchCss, /portrait"\] \.music-topnav \.minimal-transport button\.transport-mode\s*\{/, 'portrait 下这一颗有自己的撑开规则');
});

test('⑧ 歌单上专辑架的接线：合并进同一次排序、点开走已有详情面板、按下播放说实话', async () => {
  // 排序不特例（D6）：伪专辑与真实专辑**同一次 orderMusicAlbums**，拼在排序之前而不是之后。
  assert.match(app, /const shelfRows = await fetchPlaylistShelf\(\);/, '曲库刷新时顺带取一次架上原料');
  // ⑧ 与 ⑨ 两张伪专辑都拼在排序**之前**：三样东西共用一条排序轴，谁都不给自己开"永远在第一列"的后门。
  assert.match(app, /albums = orderMusicAlbums\(\s*\[\s*\.\.\.\(demo \? demoAlbums : library\.albums\),\s*\.\.\.shelfRows\.map\(playlistAlbum\),\s*\.\.\.artistShelfRows\.map\(artistAlbum\),\s*\],\s*preferences\.sortMode,\s*\);/,
    '拼在排序之前：真实专辑 / 歌单 / 音乐人组一视同仁');
  assert.match(app, /playlistShelfRows = Array\.isArray\(shelf\?\.playlists\) \? shelf\.playlists : \[\];/, '响应形状不对就当没有，不留下半个数组');
  assert.match(app, /catch \{\s*\n\s*\/\/ 这一列少了不该把整个曲库刷新带坏/, '取失败保留上一次的行：一列少了不该让整架白屏');
  // 点开走**已有的**详情面板（验收侧明确要求），不新造第二个详情页。
  const setMode = app.slice(app.indexOf('function setMode('), app.indexOf('function syncTabIndicator'));
  assert.match(setMode, /playlistSlugOf\(album\.id\)/, '从行 id 里取回歌单 slug');
  assert.match(setMode, /playlistOpenId = playlistSlug;/, '复用面板既有的"当前打开哪张"状态');
  assert.match(setMode, /openPanel\("playlist"\);/, '去的是已有的歌单详情面板');
  assert.match(setMode, /return;\s*\n\s*\}\s*\n\s*if \(album\) presentation\.open\(\);/, '伪专辑不进 3D 详情面（那会打开一张"0 首歌曲"的空专辑）');
  // 选中一张歌单时按下播放：静默什么都不做会让人以为播放器坏了，必须给一句实话。
  const playAlbum = app.slice(app.indexOf('function playAlbum('), app.indexOf('document.addEventListener("click"'));
  assert.match(playAlbum, /a\?\.kind === "playlist"/, '播放那条路要认出伪专辑');
  assert.match(playAlbum, /notify\(`「\$\{a\.title\}」是一张文本歌单/, '按下播放时说的是"去哪播"，不是静默返回');
  assert.equal(playAlbum.includes('player.play('), true, '真实专辑那条路一个字没改');
  // 不造封面 URL（F3）：伪专辑的 id 带前缀，按 id 拼 artwork 就会打 404。
  // 判据只看代码行：⑨ 之后 `artistAlbum` 的注释里会**提到** coverUrl（正是解释为什么不写它的那句），
  // 拿原文当判据会把"说明为什么不"当成"做了"——与 R114/R117/R121 同一类错（钉契约不钉文本）。
  const mapping = app.slice(app.indexOf('function playlistAlbum('), app.indexOf('let playlistShelfRows'));
  assert.ok(mapping.length > 300, `要能整段读到两张伪专辑的映射，实测 ${mapping.length}`);
  const mappingCode = mapping.split("\n").filter((line) => {
    const head = line.trimStart().slice(0, 2);
    return head !== "//" && head !== "/*" && !line.trimStart().startsWith("*");
  }).join("\n");
  // 封面这一格在 R198 变了规则（**判据跟着改，不是放宽**）：
  // 旧规则"伪专辑映射里一个字都不许提 coverUrl"是为了防"按 id 造一个 artwork URL"（F3）。
  // R198 之后**歌单**那一张可以有封面，但**唯一来源是服务端给的 `row.coverUrl`**（同源 token 地址）；
  // 音乐人组那一张照旧一个都不许有。所以判据拆成两条，都比旧的那条更具体：
  //   ① 歌单那张：`coverUrl` 只能来自 `row.coverUrl`，代码里不许出现任何 `/api/artwork/` 的拼接；
  //   ② 音乐人组那张：仍然一个 coverUrl 都不许有。
  const playlistMap = mapping.slice(mapping.indexOf('function playlistAlbum('), mapping.indexOf('function artistAlbum('));
  const artistMap = mapping.slice(mapping.indexOf('function artistAlbum('));
  const stripComments = (text) => text.split("\n").filter((line) => {
    const head = line.trimStart().slice(0, 2);
    return head !== "//" && head !== "/*" && !line.trimStart().startsWith("*");
  }).join("\n");
  assert.match(stripComments(playlistMap), /\.\.\.\(row\.coverUrl \? \{ coverUrl: row\.coverUrl \} : \{\}\)/,
    'R198：歌单那张伪专辑的封面唯一来源是服务端的 row.coverUrl（同源 token 地址）');
  assert.equal(stripComments(playlistMap).includes('/api/artwork/'), false,
    '不许按 id 拼 artwork 地址（F3 那条老错）');
  assert.equal(stripComments(artistMap).includes('coverUrl'), false,
    '音乐人组那张伪专辑照旧不许有封面（R198 只管歌单那一张）');
  assert.match(mapping, /function artistAlbum\(/, '⑨ 第二张伪专辑的映射也在这段里，一起受同一条判据约束');
  assert.match(mapping, /artist: row\.artist,/, '歌手位用成员里最主要的音乐人，不用歌单名');
  assert.match(mapping, /tracks: \[\],/, '明细点开才取');
  // 侧栏那两行文字也必须认出伪专辑：走真实专辑那条就会写成"0 首曲目 / 空格式"，
  // 与架子那行的"歌单 · 3 首"自相矛盾（同一句话用同一个函数算，两处不会漂）。
  const selectionFrom = app.indexOf('const location = fileLocation(selected)');
  const selection = app.slice(selectionFrom, selectionFrom + 1600);
  assert.ok(selectionFrom > 0 && selection.length > 900, `要能整段读到侧栏那两行文字的算法，实测 ${selection.length}`);
  assert.match(selection, /a\.kind === "playlist"( \|\| a\.kind === "artist")?\s*\?\s*shelfClearance\(a\)/, '侧栏说明位复用 data.ts 那个函数（⑨ 之后两张伪专辑都走它）');
  assert.match(selection, /a\.kind === "playlist" \? "歌单" : a\.kind === "artist" \? "在线音乐人" : demo/,
    '侧栏格式位对两张伪专辑各说各的名字，都不是空串（⑨ 之后多一张，漏掉就会写成"无格式"）');
});

// ── 歌单条目 → 内核队列（纯函数，行为级钉，不靠读源码找关键字） ──────────────────
const entry = (n, matched = true) => matched
  ? {
    matched: true,
    track: {
      id: `on-${n}`, album: `专${n}`, artist: `歌手${n}`, audioUrl: `/api/online/stream?id=on-${n}`,
      durationMs: 61_000, provider: 'netease', mediaId: `m${n}`, quality: 'hq', sourceKind: 'online', title: `曲${n}`,
    },
  }
  : { matched: false, source: 'cache', reason: '没找到' };

test('playlistQueue：只有 matched 且带 track 的进队列，并留下"队列第 k 格来自第几条"', () => {
  const { tracks, entries } = playlistQueue([entry(1), entry(2, false), entry(3), entry(4), entry(5, false), entry(6)]);
  assert.deepEqual(tracks.map((t) => t.id), ['on-1', 'on-3', 'on-4', 'on-6'], '未匹配那两条不许进队列（没有可播地址）');
  assert.deepEqual(entries, [0, 2, 3, 5], 'entries 是**原始条目下标**：第 6 条（下标 5）落在队列第 4 格');
  // 实机那条 bug 的第二半就在这里：data-entry 说的是条目，play() 要的是队列里的 id。
  assert.equal(entries.indexOf(5), 3, '按条目下标找起点 ⇒ 第 6 条 = 队列第 4 格');
  assert.equal(tracks[entries.indexOf(5)].id, 'on-6', '于是播的就是第 6 条那一首');
  assert.equal(tracks[5], undefined, '而"tracks[条目下标]"那种写法会取到 undefined 或别人的歌——这就是原来的错法');
});

test('playlistQueue：matched 却缺 track 的条目不进队列（服务端说匹配了但没有可播地址）', () => {
  const { tracks, entries } = playlistQueue([{ matched: true }, entry(2), { matched: true, track: null }]);
  assert.deepEqual(tracks.map((t) => t.id), ['on-2']);
  assert.deepEqual(entries, [1]);
});

test('playlistQueue：一条都没匹配时是空队列，界面据此给那句人话', () => {
  assert.deepEqual(playlistQueue([entry(1, false), entry(2, false)]), { tracks: [], entries: [] });
  assert.deepEqual(playlistQueue([]), { tracks: [], entries: [] }, '空歌单也不许抛');
});

test('playlistQueue：时长毫秒→秒在这一跳换算完（内核与界面用的是秒）', () => {
  const { tracks } = playlistQueue([entry(1)]);
  assert.equal(tracks[0].duration, 61, '61_000ms ⇒ 61 秒；不换算就会显示成一千多分钟');
  assert.equal(tracks[0].sourceKind, 'online');
  assert.equal(tracks[0].albumId, 'online', '在线曲目不属于任何本地专辑');
});

test('面板竞态：写 #panel-body 之前必须确认它还在；UI 竞态不许冒充业务失败（实机那句「匹配失败：Cannot set properties of null」）', () => {
  assert.match(app, /function livePanelBody\(\)[\s\S]*?\?\.isConnected/,
    '取面板体只有这一个出处，且连 isConnected 一起看——面板重开过就是另一个节点，写到游离节点上等于什么都没发生');
  const listBody = /async function renderPlaylistsPanel\(\) \{([\s\S]*?)\n}\n/.exec(app)?.[1] ?? '';
  const detailBody = /async function renderPlaylistDetail\(\) \{([\s\S]*?)\n}\n/.exec(app)?.[1] ?? '';
  for (const [name, body] of [['renderPlaylistsPanel', listBody], ['renderPlaylistDetail', detailBody]]) {
    assert.ok(body.length > 200, `没抓到 ${name}`);
    assert.doesNotMatch(body, /\$\("#panel-body"\)\s*\.innerHTML/, `${name} 不许再直接写 $("#panel-body").innerHTML——面板关了那里就是 null`);
    assert.match(body, /if \(!opening\) return;|if \(!body\) return;/, `${name} 每一处写之前都要判空后静默返回`);
  }
  const match = /async function matchWholePlaylist\(\) \{([\s\S]*?)\n}\n/.exec(app)?.[1] ?? '';
  const tryBlock = /try \{([\s\S]*?)\}\s*catch/.exec(match)?.[1] ?? '';
  assert.ok(tryBlock.length > 40, '没抓到匹配的那个 try 块');
  assert.doesNotMatch(tryBlock, /renderPlaylistDetail/,
    '重渲染不许待在"匹配"的那个 try 里：它抛的 TypeError 会从 catch 冒出去，把服务端已经匹配成功这件事报成"匹配失败"');
  assert.match(match, /UI 竞态不是业务失败/, '这条边界要写在码里，免得下次又被顺手搬回 try');
  assert.ok(match.indexOf('匹配失败') < match.indexOf('await renderPlaylistDetail()'), 'catch 里说完成败并 return，重渲染排在其后');
});

// ── 看板 ⑨ 追加：在线曲目封面的显示面与"第三方地址不出服务端" ──────────────────
const front = await read("src/online-search.ts");
const html = await read("src/html.ts");

test("在线曲目封面：显示面填的是同源地址，第三方 CDN 主机名在前端源码里一次都不出现", () => {
  // 判据是"只有一个出处"，不是"出处在哪个文件"：⑨ 之后它挪进了 src/html.ts（面板行也要画封面），
  // 所以这里查"定义恰好一份 + 两处调用方都从它导入 + music-app 里不再留第二份实现"。
  assert.match(html, /export function coverImage\(url: string, alt: string/, "封面画法的那一份在 html.ts");
  assert.match(app, /import \{ coverImage, escapeHtml as esc \} from "\.\/html";/, "music-app 从那一处导入");
  assert.match(ui, /import \{ coverImage \} from "\.\/html\.ts";/, "歌单/音乐人面板也从同一处导入");
  assert.equal((app.match(/function coverImage\(/g) ?? []).length, 0, "music-app 里不许再留第二份实现");
  assert.match(app, /return coverImage\(a\.coverUrl \?\? ""/, "cover() 只做参数适配，判据不再抄第二份");
  // 搜索结果行：以前 <span class="result-cover"></span> 是空的（实机"有词无图 + 灰占位"就是这个空 span）
  assert.match(app, /<span class="result-cover">\$\{coverImage\(item\.coverUrl \?\? ""/,
    "在线那一行必须把封面填进 result-cover（空 span 就是那个灰占位）");
  // 正在播放：歌词面与岛都要拿得到**正在播放曲目**自己那张封面（R202-F3 收紧：本地按 `track.albumId`
  // 找所属专辑——R38 口径，跨专辑时会错位；在线的退到它自带的同源封面；界面选中专辑不许再顶掉播放曲目）。
  assert.match(app, /a\?\.coverUrl \?\? t\?\.coverUrl \?\? currentAlbum\(\)\?\.coverUrl/,
    "歌词面的模糊底与取色要认正在播放的曲目（与岛 feedSong 同一条链）");
  assert.doesNotMatch(app, /cover: \(\) => currentAlbum\(\)\?\.coverUrl \?\? player\.state\.currentTrack\?\.coverUrl/,
    "界面选中专辑优先的旧链不许回来（播在线曲目时会糊错图）");
  assert.match(app, /album\?\.coverUrl \?\? track\?\.coverUrl \?\? null/, "岛内 feedSong 同一条判据");
  // 红线：前端只可能看到同源地址。第三方主机名出现在前端**代码**里，就说明有什么东西越过了服务端；
  // 而 "/api/online/artwork/" 由前端拼出来同样不对——那条地址是服务端签发的，前端只是转手给 <img>。
  // 只扫代码行：注释里写清"这条地址长什么样"是文档，不是实现（第一版没排除注释，被自己的一句说明误伤）。
  const codeOnly = (text) => text.split(/\r?\n/)
    .filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line)).join("\n");
  for (const [source, name] of [[app, "src/music-app.ts"], [front, "src/online-search.ts"]]) {
    for (const leaked of ["p1.music.126.net", "p2.music.126.net", "p3.music.126.net", "p4.music.126.net", "y.gtimg.cn", "/api/online/artwork/"]) {
      assert.equal(codeOnly(source).includes(leaked), false, `前端代码里出现了不该有的东西：${leaked}（${name}）`);
    }
  }
  assert.match(front, /\.\.\.\(item\.coverUrl \? \{ coverUrl: item\.coverUrl \} : \{\}\)/,
    "没有封面就不带这个字段：界面画占位，不造一个会 404 的 URL（F3 那条老错的同一判据）");
});

// ── 看板 c84bb56（夜间批 五）：搜索结果「加入歌单」点了没落盘 ───────────────────
// 真机复现到的根因不在服务端，而在**点击委托的分支顺序**：
// 选择器那颗按钮同时带着 `data-playlist="X"`（定位）和 `data-action="playlist-add-to"`（动作），
// 而"打开 X 这张歌单"那条定位分支排在前面 ⇒ 点击被它吃掉，一条请求都不发、一句提示也没有。
// 这里钉三件事：① 通则"显式动作优先于定位 data-*"；② 那颗撞车的按钮形状仍在（通则得有对象可守）；
// ③ 这一带的每一条早退路径都要有话说（本仓纪律：失败必须说出口）。
test('委托通则：显式 data-action 优先于定位用的 data-*（五个定位分支都要守）', () => {
  const head = app.match(/document\.addEventListener\("click", \(e\) => \{[\s\S]*?const explicitAction = Boolean\(target\.dataset\.action\)/);
  assert.ok(head, '没抓到点击委托的开头与通则判定（提取失败不许静默通过）');
  assert.match(app, /const explicitAction = Boolean\(target\.dataset\.action\)/, '通则要有那一个判定，不许五处各写一遍');
  for (const locator of ['theme', 'track', 'select', 'onlineTrack', 'playlist']) {
    // 用子串而不是拼 RegExp：这条断言的第一版就是被 shell 的反斜杠吃掉过（`\(` 落到文件里变成 `(`，
    // 于是括号被当成捕获组，永远匹配不到却"看起来在断言"）。这里没有模式可写，就别引入转义层。
    assert.ok(
      app.includes(`if (!explicitAction && target.dataset.${locator})`),
      `定位分支 dataset.${locator} 要以"没有显式动作"为前提`,
    );
  }
  // searchTab 那颗只有动作语义（没有第二种身份），不要求守卫，但也不许反过来抢在动作之前。
  const tabAt = app.indexOf('if (target.dataset.searchTab)');
  const addAt = app.indexOf('if (target.dataset.action === "playlist-add-to")');
  assert.ok(tabAt > 0 && addAt > tabAt, '在线页签那条保持在动作分支之前（它自己就是动作），而动作分支不许被定位吃掉');
});

test('撞车那颗按钮的形状仍在：同一元素带 data-playlist 与 data-action（通则得有对象可守）', () => {
  assert.match(ui, /data-action="playlist-add-to" data-playlist="\$\{esc\(playlist\.id\)\}"/,
    '选择器里的"加进某张歌单"就是既有定位属性 + 显式动作同体');
});

/** 一段代码里的早退路径：单行 `if (...) return;` 与带块的 if，都要看见 notify 才算说了话。 */
function silentEarlyReturns(region) {
  const silent = [];
  for (const m of region.matchAll(/if \([^{\n]*\) return[^;]*;/g)) silent.push(m[0].trim());
  for (const m of region.matchAll(/if \([^{\n]*\{([\s\S]*?)\n\s*\}/g)) {
    const block = m[1];
    if (/\breturn\b/.test(block) && !/notify\(/.test(block)) silent.push(block.trim().split('\n')[0].trim());
  }
  return silent;
}

test('加入歌单这一带没有静默早退：每条 return 都带一句用户看得见的话', () => {
  const adder = app.match(/async function addOnlineEntryToPlaylist\([\s\S]*?\n\}/);
  assert.ok(adder, '没抓到 addOnlineEntryToPlaylist');
  assert.deepEqual(silentEarlyReturns(adder[0]), [], '函数体里不许有静默 return（看板 c84bb56 点名的就是开头那一句）');
  const chooser = app.match(/async function toggleAddChooser\([\s\S]*?\n\}/);
  assert.ok(chooser, '没抓到 toggleAddChooser');
  // 迟到清单的守卫分两样：用户已去点别行 ⇒ 让位（说了是噪音）；结果集换掉 / 选择器被关 ⇒ 必须说。
  // **try 与 catch 两条路都要说**：只数一处会让"删掉另一处"这种回退静默通过（变异 V4 第一轮就没咬）。
  const speaks = [...chooser[0].matchAll(/if \(addChooserIndex === -1\) notify\(/g)].length;
  assert.equal(speaks, 2, `迟到守卫的两条路（成功 / 失败）各要有一句提示，实测 ${speaks} 处`);
  assert.ok(!/if \(addChooserIndex !== index\) return;/.test(chooser[0]), '不许再留裸的"迟到就丢"守卫');
  const openBranch = app.match(/if \(target\.dataset\.action === "playlist-add-open"\) \{[\s\S]*?\n  \}/);
  assert.ok(openBranch, '没抓到 playlist-add-open 分支');
  assert.match(openBranch[0], /notify\(/, '行号缺失/越界要说不通，不能交给 toggleAddChooser(NaN) 去开一个画不出来的选择器');
  const toBranch = app.match(/if \(target\.dataset\.action === "playlist-add-to"\) \{[\s\S]*?\n  \}/);
  assert.ok(toBranch, '没抓到 playlist-add-to 分支');
  assert.match(toBranch[0], /notify\(/, 'id 丢了要说不通——从前它会掉进"新歌单要有个名字"，那句是假话');
});

test('成功路径的回执要报数（"加进去了"得说清加进哪张、现在几条）', () => {
  assert.match(app, /已把\$\{item\.title\}|已把「\$\{item\.title\}」加进「\$\{result\.playlist\.name\}」（现在 \$\{result\.playlist\.items\.length\} 条）/,
    '回执读的是服务端给的条数，不是前端自己数的');
});

// ── R144（任务五）·「歌词匹配」面板与手动认领的接线面 ──────────────────────
const lyricUi = await read('src/lyric-match-ui.ts');
const stage = await read('src/lyric-stage.ts');
const stageCss = await read('src/lyric-stage.css');

test('R144 面板四处接线都在：Panel 联合、标题表、分派、四颗动作分支（少一处就是点了没反应）', () => {
  assert.match(app, /"artist" \| "favorites" \| "lyrics" \| null/, 'Panel 联合里有这一档');
  assert.match(app, /lyrics: \["LYRIC MATCH", "歌词匹配"\]/, '标题表（缺了会渲染出 undefined 标题）');
  assert.match(app, /if \(next === "lyrics"\) void renderLyricMatchPanel\(\)/, '分派');
  for (const action of ['open-lyric-match', 'retry-lyrics', 'claim-lyric', 'clear-lyric-claim']) {
    assert.match(app, new RegExp(`action === "${action}"`), `点击委托缺 ${action} 这一档`);
  }
  // R121 那条通则：显式 data-action 必须排在定位 data-* 之前，否则点击会被"打开那一行"吃掉。
  const claimAt = app.indexOf('action === "claim-lyric"');
  const switchAt = app.indexOf('switch (action)');
  assert.ok(claimAt > 0 && switchAt > 0 && claimAt < switchAt, '认领按钮的分支要排在通用 switch 之前（同一次点击只许有一个主人）');
});

test('R144 面板文案：说得出阈值没动、说得出"只存身份不存正文"、状态格在', () => {
  assert.match(lyricUi, /自动匹配的阈值仍是 75 分/, '要当面说清自动挡没被放宽（这一格最容易被人误读成"改成 60 了"）');
  assert.match(lyricUi, /歌词正文仍然不落盘/, '与设置里那份出网声明同口径');
  assert.match(lyricUi, /data-action="claim-lyric" data-index/, '每行一颗「就用这首」');
  assert.match(lyricUi, /就用这首/, '按钮文案');
  assert.match(lyricUi, /data-role="lyric-match-status"/, '报告要有落点（写没写成、为什么没写）');
  assert.match(lyricUi, /重试匹配歌词/, '重试入口');
  assert.match(lyricUi, /取消认领/, '认领必须可撤销（否则挑错了就是永久）');
  assert.match(lyricUi, /escapeHtml/, '转义只用全仓那一个出口');
});

test('R144 换曲之后旧下标不许用；认领之后要真的重取一次词', () => {
  // 面板上第 3 行点下去 ⇒ 按 index 回读**这一次答复里**的那条候选；曲目换了就必须作废。
  assert.match(app, /lyricMatchState\?\.trackId === track\?\.id \? lyricMatchState\?\.near\[index\] : undefined/,
    '旧候选配新曲目 = 把 A 歌的歌词认到 B 歌头上');
  assert.match(app, /这条候选已经过期了/, '作废时要说出来，不许静默什么都不做');
  const reload = /function reloadCurrentLyrics\(\) \{([\s\S]*?)\n  \}/.exec(app)?.[1] ?? '';
  assert.ok(reload, 'reloadCurrentLyrics 这个唯一出口还在（三件事都从这一处做，别在三个调用点各补一遍）');
  const resetAt = reload.indexOf('lyricsClient.reset()');
  const refreshAt = reload.indexOf('lyricStage.refresh()');
  const syncAt = reload.indexOf('lyricStage.sync(player.state)');
  assert.ok(resetAt >= 0, '客户端那份按 id 的缓存要作废，否则界面还是旧词');
  assert.ok(refreshAt >= 0, '舞台要重走一次加载');
  assert.ok(syncAt >= 0, 'Q27：清完还得**立刻**去取一次词——refresh 只是把"当前是哪首"清掉，不补 sync 就是"点了没反应"');
  assert.ok(resetAt < syncAt && refreshAt < syncAt,
    '顺序也是判据：sync 排在 refresh 之前等于白跑一次（清标记在后，sync 一看 id 没变就返回）');
  // 旧回执不许覆盖新画面（R115 / R127 同族）
  assert.match(app, /if \(panel !== "lyrics"\) return/, '面板已关或换页时，回来的答复不许再写 DOM');
});

test('R144 徽标分得开"机器配的"与"人挑的"，入口在无词态也在', () => {
  assert.match(stage, /loaded\.claimed \? "手动认领" : "在线匹配"/, '两种来源不许混说（这一条是"标明来源"红线的延伸）');
  const badge = /function renderSourceBadge\(\) \{([\s\S]*?)\n  \}/.exec(stage)?.[1] ?? '';
  const entryAt = badge.indexOf('lyric-match-entry');
  const earlyReturn = badge.indexOf('if (!loaded || loaded.source === "none") return');
  assert.ok(entryAt >= 0, '入口按钮要在徽标函数里画');
  assert.ok(earlyReturn > 0 && entryAt < earlyReturn, '入口必须画在那条早退**之前**——无词态正是它最主要的使用场景');
  // 上一行只判源码先后：把守卫换成 `if (false)` 它照样绿（第一轮变异 T1 就是这么没咬的）。
  // 所以再钉一条：入口的守卫**只有**"有一首在播的曲目"这一件事。
  assert.match(badge, /if \(trackId\) \{\s*\n\s*const entry = document\.createElement\("button"\);/,
    '入口的守卫只许是"有一首在播的曲目"（多挂一个条件就会在最需要的时候不画）');
  assert.match(app, /available: \(\) => Boolean\(player\.state\.currentTrack\), run: \(\) => openPanel\("lyrics"\)/,
    '命令面板里的这一条以"有一首在播的歌"为可用性判据');
});

test('R169 歌词匹配入口必须点得动：舞台不吃事件，入口自己要把 pointer-events 打开', () => {
  // 前提：`.lyric-stage` 是 pointer-events:none 的覆盖层（不挡 3D 与岛）——这一条不许被顺手改掉，
  // 否则下面的判据会变成"因为整层都可点所以入口可点"的假绿。
  const stageBlock = /\.lyric-stage \{([\s\S]*?)\n\}/.exec(stageCss)?.[1] ?? '';
  assert.ok(stageBlock, '.lyric-stage 这条规则还在');
  assert.match(stageBlock, /pointer-events:\s*none/, '舞台本身继续不吃事件（覆盖层的前提）');
  // 入口是舞台里**唯一**一颗可交互元素 ⇒ 它必须显式打开，否则"看得见、点不动"：
  // DOM 断言、AI 快照、静态截图都抓不到这一格（真机点击才是判据，见 R169 台账）。
  const entryBlock = /\.lyric-match-entry \{([\s\S]*?)\n\}/.exec(stageCss)?.[1] ?? '';
  assert.ok(entryBlock, '.lyric-match-entry 这条规则还在（R144 那颗入口）');
  assert.match(entryBlock, /pointer-events:\s*auto/,
    'R169：少了这一句，按钮在快照与截图里都"在"，就是点不动');
});

// R189（任务四）：两颗胶囊原先长得一模一样（同边框、同底色、同字号），并排就糊成一团。
// 分层的依据是"这东西是什么"：徽标是**状态说明**、入口是**可点动作**。
// 颜色一律走派生令牌（`--folia-*`）—— 亮底上"近白的字 / 橙字"正是 R181 那一族。
test('R189：来源徽标与匹配入口按"说明 / 动作"分层，颜色全走令牌', async () => {
  const sourceBlock = /\.lyric-source \{([\s\S]*?)\n\}/.exec(stageCss)?.[1] ?? '';
  const dotBlock = /\.lyric-source::before \{([\s\S]*?)\n\}/.exec(stageCss)?.[1] ?? '';
  const entryBlock = /\.lyric-match-entry \{([\s\S]*?)\n\}/.exec(stageCss)?.[1] ?? '';
  assert.ok(sourceBlock && dotBlock && entryBlock, '三条规则都要在（徽标 / 那个小圆点 / 入口）');
  // 徽标 = 状态说明 ⇒ 去边框、去胶囊底、去内边距，只留"圆点 + 文字"
  assert.match(sourceBlock, /border:\s*0/, 'R189：徽标不再描边（描边是"可点"的signifier）');
  assert.match(sourceBlock, /background:\s*none/, 'R189：徽标不再有胶囊底');
  assert.match(sourceBlock, /padding:\s*0/, 'R189：去底之后内边距一起撤，否则文字会缩在一条看不见的框里');
  assert.match(dotBlock, /border-radius:\s*50%/, 'R189：小圆点是圆的');
  assert.match(dotBlock, /background:\s*var\(--folia-accent/, 'R189：圆点跟强调色（它是"哪一档"的锚）');
  // 入口 = 可点动作 ⇒ 保留胶囊；底色用**不透明**的派生底、文字用有 4.5 下限的派生主色
  assert.match(entryBlock, /border-radius:\s*999px/, 'R189：入口还是胶囊');
  assert.match(entryBlock, /background:\s*var\(--folia-back/, 'R189：入口底色走派生底（不透明，对比度才有确定的分母）');
  assert.match(entryBlock, /color:\s*var\(--folia-primary[^;]*!important/,
    'R189：入口文字吃有下限的派生主色，且要压过 .text-button 那条 !important');
  assert.match(entryBlock, /border:\s*1px solid color-mix\(in srgb, var\(--folia-accent/, 'R189：强调色退到描边上');
  assert.match(entryBlock, /pointer-events:\s*auto/, 'R169：这颗入口必须继续点得动（不许被顺手改掉）');
  // 位置：徽标那条线一个字不动（R144 量过），入口让 8px 把间距拉开
  assert.match(sourceBlock, /bottom:\s*92px/, 'R189：徽标底线上抬 8px 拉开与入口的间距');
  assert.match(entryBlock, /bottom:\s*36px/, 'R189：入口下移 8px（原先 44）');
  for (const [name, block] of [['徽标', sourceBlock], ['圆点', dotBlock], ['入口', entryBlock]])
    assert.doesNotMatch(block, /#[0-9a-fA-F]{3,8}\b/, `R189：${name}这条里不许有写死的色值`);
  // 岛内那两条（位置覆盖）同进退：徽标保持 112（R144 量过的线），入口 76 → 68
  const chrome = await read('src/lyric-folia-chrome.css');
  const islandSource = /#lyric-stage > \.lyric-source \{([\s\S]*?)\n\}/.exec(chrome)?.[1] ?? '';
  const islandEntry = /#lyric-stage > \.lyric-match-entry \{([\s\S]*?)\n\}/.exec(chrome)?.[1] ?? '';
  assert.match(islandSource, /bottom:\s*112px/, 'R189：岛内徽标那条线不许动（R144 量过的）');
  assert.match(islandEntry, /bottom:\s*68px/, 'R189：岛内入口同步让 8px');
  assert.match(islandEntry, /left:\s*24px/, 'R189：仍在左侧（避开底部居中的上游字幕）');
});

test('R144 面板发给服务端的只有身份：认领请求体里没有歌词正文，也不接受任意地址', () => {
  // 认领的载荷来自 `lyricMatchState.near[index]`（服务端给回来的那几条），界面不自己拼任何字段。
  assert.match(app, /body: JSON\.stringify\(\{ trackId: track\.id, \.\.\.onlineLyricDescriptor\(track\), candidate \}\)/,
    '只发 trackId + 描述字段 + 那一条候选');
  assert.doesNotMatch(app, /claim[\s\S]{0,200}(lyricText|text:|\.ttml)/, '认领请求不许带歌词正文');
  // 服务端一侧：形状把关在出网之前（这条判据的行为面在 check-music-online 的路由那一节）
  // R148 之后次序变成"先认令牌 → 再核对字段 → 才校验形状 → 才出网"，三条各钉一条。
  assert.match(server, /const identity = onlineLyricClaimTokens\.resolve\(candidate\.claimToken\)/,
    '先认我们签发的令牌：客户端不再往回送 accessKey');
  assert.match(server, /if \(String\(candidate\.provider \?\? ''\) !== identity\.provider \|\| String\(candidate\.sourceId \?\? ''\) !== identity\.sourceId\) \{/,
    '真令牌配假身份要拒（不然一条真 token 能配另一首歌）');
  assert.match(server, /const \{ entry, error \} = claimEntryFrom\(\{ \.\.\.candidate, \.\.\.identity \}\)/,
    '先校验再出网：校验的是令牌登记的那份身份');
  assert.match(server, /if \(!probe\.matched\) \{[\s\S]{0,220}written: false/, '取不到词 ⇒ 不写，并说实话');
});

test('R148 界面这一侧：近候选类型里没有 accessKey，面板也不把它画进 DOM', async () => {
  const clientText = await read('src/lyrics-client.ts');
  const markupText = await read('src/lyric-match-ui.ts');
  const iface = /export interface OnlineNearCandidate \{[\s\S]*?\n\}/.exec(clientText)?.[0] ?? '';
  assert.ok(iface.length > 80, `没抓到近候选接口：${iface.length}`);
  assert.equal(/accessKey/.test(iface), false, '近候选的类型里不该再有取词钥匙');
  assert.match(iface, /claimToken\?: string/, '换成不透明令牌');
  assert.equal(/accessKey/.test(markupText), false, '面板 markup 里一个字都不该出现 accessKey（它连渲染都不该拿到）');
  assert.match(markupText, /data-action="claim-lyric" data-index/, '认领按钮还是那一颗，只是送回去的是 token');
});


// R165（任务十一）· 账号歌单那一行的三态：同家可点 / 不同家禁用带原因 / 没在播在线曲目两家都禁用。
// 这一组是**函数级**的（不是扫源码）——写侧的按钮一旦"看起来在、点了没反应"就是 R121 那一族，
// 只能靠真的把 markup 生成出来数格子。
const { accountPlaylistMarkup } = await import('../src/playlists-ui.ts');
const accountRows = [
  { provider: 'netease', id: '777', name: '我的网易单', trackCount: 3 },
  { provider: 'kugou', id: '888', name: '我的酷狗单', trackCount: 0 },
];

test('R165 界面三态：只有"正在播的这首与这一行同家"才给可点的按钮', () => {
  const nothing = accountPlaylistMarkup(accountRows, null);
  assert.equal((nothing.match(/data-action="account-playlist-add"/g) ?? []).length, 0, '没在播在线曲目 ⇒ 一颗可点的都没有');
  assert.equal((nothing.match(/<button class="text-button" disabled title=/g) ?? []).length, 2, '两颗都是禁用 + 原因');
  assert.match(nothing, /先播一首在线曲目/, '禁用要带一句能读的原因（不是只灰着）');

  const neteasePlaying = accountPlaylistMarkup(accountRows, { provider: 'netease', trackId: 'on-netease-27699577', label: '恋人 - 李荣浩' });
  assert.equal((neteasePlaying.match(/data-action="account-playlist-add"/g) ?? []).length, 1, '两家都在列表里，只有同家那行可点');
  assert.match(neteasePlaying, /data-track-id="on-netease-27699577"/, '递出去的只有曲目 id（媒体 id 由服务端从形状反解，不信界面自报）');
  assert.match(neteasePlaying, /data-account-id="777"/);
  assert.match(neteasePlaying, /与这一家不是同一家/, '另一行要说清为什么不能点');
  // 歌单名与曲目名是外部数据 ⇒ 只能走全仓那一个转义出口
  const hostile = accountPlaylistMarkup([{ provider: 'netease', id: '1', name: '<img src=x onerror=alert(1)>', trackCount: 1 }],
    { provider: 'netease', trackId: 'on-netease-1', label: '<b>曲名</b>' });
  assert.equal(hostile.includes('<img src=x'), false, '账号里的歌单名不许原样进 DOM');
  assert.equal(hostile.includes('<b>曲名</b>'), false, '界面递回来的曲名标签同样要转义');
});

test('R188（Q65）：账号歌单行的条数是**三态** —— 有值 12 / 有值 0 / 缺字段，各说各的', () => {
  const html = accountPlaylistMarkup([
    { provider: 'kugou', id: 'c1', writeId: '2', name: '有值十二', trackCount: 12 },
    { provider: 'kugou', id: 'c2', writeId: '2', name: '有值零', trackCount: 0 },
    { provider: 'kugou', id: 'c3', writeId: '2', name: '缺字段', trackCount: null },
  ], null);
  // 判据落在**文案本身**：0 与"没给"必须说成两句不同的话（Q65 的病灶就是把它们合成了一句）。
  assert.match(html, /有值十二<\/strong><small>12 条 · /, '有值 12 ⇒ "12 条"');
  assert.match(html, /有值零<\/strong><small>0 条 · /, '**已知 0** ⇒ "0 条"（不许再写成"条数未知"）');
  assert.match(html, /缺字段<\/strong><small>条数未知 · /, '字段缺失 ⇒ 才是"条数未知"');
  const zero = /有值零<\/strong><small>([^<]*)</.exec(html)?.[1] ?? '';
  assert.doesNotMatch(zero, /未知/, '0 条那一行不许说"未知"');
});

test('R187（Q64）：账号歌单行动作列——两颗按钮包在同一格 flex 里，那一列吃内容宽', () => {
  const html = accountPlaylistMarkup([{ provider: 'netease', id: '9', writeId: '9', name: '我喜欢的音乐', trackCount: 3 }],
    { provider: 'netease', trackId: 'on-netease-9', label: '恋人 - 李荣浩' });
  // 两颗按钮必须同在一个 `.account-playlist-actions` 里：分开摆就又会被网格那两格（35px/14px）拆开 ⇒ 竖排成单字两行。
  assert.match(html,
    /<span class="account-playlist-actions"><button[^>]*data-action="account-playlist-import"[\s\S]*?<\/button><button[^>]*data-action="account-playlist-add"[\s\S]*?<\/button><\/span>/,
    '两颗按钮要在同一个 .account-playlist-actions 里');
  // CSS：第三列改成内容宽（原来的 49px 1fr 35px 14px 是给「封面 / 文案 / 歌单 / ↗」的）+ 动作列不换行。
  assert.match(css, /\.account-playlist-row\s*\{[^}]*grid-template-columns:\s*49px minmax\(0,\s*1fr\) max-content/,
    '账号歌单行第三列要改成内容宽');
  assert.match(css, /\.account-playlist-actions\s*\{[^}]*flex-wrap:\s*nowrap/, '动作列不许换行');
  assert.match(css, /\.account-playlist-actions\s*\{[^}]*white-space:\s*nowrap/, '动作列的按钮文字不许换行');
});

// R198：详情面板那颗「恢复程序化封面」只在**真的有一张展示封面**的时候出现（没有就不给按钮，
// 免得点了没反应）；且它删的是服务端那一格（前端不发任何地址）。判据是"呈现结果"不是钉文案列表。
test('R198：展示封面按钮只在有封面时出现，且只发一个 action', async () => {
  const { detailMarkup } = await import('../src/playlists-ui.ts');
  const entry = { entry: { title: 'A', artist: 'B' }, matched: true, source: 'cache', track: {}, line: 2, lineText: 'A - B' };
  const withCover = detailMarkup({ id: '试单', name: '试单', items: [entry], matched: 1, unmatched: 0, displayCoverUrl: '/api/online/artwork/tok-1' });
  const without = detailMarkup({ id: '试单', name: '试单', items: [entry], matched: 1, unmatched: 0 });
  assert.match(withCover, /data-action="playlist-cover-clear"/, '有展示封面时给「恢复程序化封面」');
  assert.doesNotMatch(without, /data-action="playlist-cover-clear"/, '没有展示封面时不该出现这颗按钮（点了没反应最坏）');
  assert.match(withCover, /播放已匹配的 1 条/, '播放按钮照旧');
  // 按钮只带一个动作名：前端**不许**在这里拼任何第三方地址（红线：第三方地址不出服务端）
  assert.doesNotMatch(withCover, /https?:\/\/(?!\/)/, '详情面板里不许出现第三方地址');
  const app = await read('src/music-app.ts');
  assert.match(app, /action: "clear"/, '清除动作发给服务端的是 action 不是地址');
  assert.match(app, /action: "set"/, '起播后设展示封面同样是 action');
});

// R220：「补一次来源身份」那颗按钮的**成对性** —— 按钮只出现在有来历注释的单上（没来历点了没反应最坏），
// 而点击分支必须真在 music-app.ts 里（R121 那一族：写了按钮没写分支 = 静默无果，用户以为补过了）。
test('R220：「补一次来源身份」按钮与它的点击分支成对，且没有来历的单不给这颗按钮', async () => {
  const { detailMarkup } = await import('../src/playlists-ui.ts');
  const entry = { entry: { title: 'A', artist: 'B' }, matched: true, source: 'identity', track: {}, line: 2, lineText: 'A - B' };
  const base = { id: '试单', name: '试单', items: [entry], matched: 1, unmatched: 0 };
  const withProvenance = detailMarkup({ ...base, sourceProvenance: { provider: 'kugou', id: 'collection_3_1' } });
  const withoutProvenance = detailMarkup(base);
  assert.match(withProvenance, /data-action="playlist-fill-identity"/, '有来历注释 ⇒ 给这颗按钮');
  assert.doesNotMatch(withoutProvenance, /data-action="playlist-fill-identity"/, '手打的单没有来历 ⇒ 不给（服务端也会同样实话，但按钮不该骗人）');
  assert.match(withProvenance, /来源身份/, '这一档的徽标说得出它没经过搜索（界面说的必须是真做过的）');
  const app = await read('src/music-app.ts');
  assert.match(app, /dataset\.action === "playlist-fill-identity"/, '点击分支在位（否则点了静默无结果，R121 那一族）');
  assert.match(app, /\/source-identity/, '发的就是服务端那条路由：前端不自己列账号歌单、不自己拼身份');
});

// ── R212 · 登录面板的"刷新窗口"（低频心跳）────────────────────────────────────

test('R212 ①：心跳纯逻辑 —— none→file 翻一次并只报一次；一直 none 不报；看不见就停；迟到窗口到期自停', async () => {
  const { createAuthHeartbeat, AUTH_HEARTBEAT_DEFAULT_MS, AUTH_HEARTBEAT_LATE_TICKS } = await import('../src/auth-heartbeat.ts');
  assert.ok(AUTH_HEARTBEAT_DEFAULT_MS >= 10_000 && AUTH_HEARTBEAT_DEFAULT_MS <= 15_000,
    `心跳间隔要在 10~15 秒那一档，实际 ${AUTH_HEARTBEAT_DEFAULT_MS}ms`);
  assert.ok(AUTH_HEARTBEAT_LATE_TICKS >= 2 && AUTH_HEARTBEAT_LATE_TICKS <= 3, '迟到确认窗口要求 2~3 次');
  // 假时钟：schedule 只把回调记下来，测试自己一拍一拍推进（"可注入时钟"那条要求的落地）。
  const makeHarness = (sequence) => {
    const scheduled = [];
    const notified = [];
    let renders = 0;
    let alive = true;
    let i = 0;
    const hb = createAuthHeartbeat({
      read: async () => {
        const snapshot = sequence[Math.min(i, sequence.length - 1)];
        i += 1;
        return snapshot;
      },
      render: () => { renders += 1; },
      notifyLogin: (provider) => notified.push(provider),
      schedule: (fn) => { scheduled.push(fn); return fn; },
      cancel: () => {},
      alive: () => alive,
    });
    return { hb, notified, scheduled, renders: () => renders, setAlive: (v) => { alive = v; } };
  };
  const tick = async (h) => { const fn = h.scheduled.shift(); assert.ok(fn, '没排下一拍'); await fn(); };
  // A：none → file ⇒ 翻 + 报一次；第三拍还是 file ⇒ 不补报
  const a = makeHarness([
    { providers: { netease: { source: 'none' }, qq: { source: 'none' } } },
    { providers: { netease: { source: 'file' }, qq: { source: 'none' } } },
    { providers: { netease: { source: 'file' }, qq: { source: 'none' } } },
  ]);
  a.hb.start();
  await tick(a); await tick(a); await tick(a);
  assert.deepEqual(a.notified, ['netease'], '转档那一刻报一家、而且只报一次');
  assert.equal(a.renders(), 1, '翻一次界面（再拍不重复翻）');
  assert.equal(a.hb.running, true, '面板还开着（alive）⇒ 继续排下一拍');
  // B：一直 none ⇒ 一拍都不报
  const b = makeHarness([{ providers: { netease: { source: 'none' } } }]);
  b.hb.start(); await tick(b); await tick(b);
  assert.deepEqual(b.notified, [], '一直未登录不许报');
  assert.equal(b.renders(), 0);
  // C：元素离开文档 ⇒ 下一拍自己停
  const c = makeHarness([{ providers: {} }, { providers: {} }]);
  c.hb.start(); await tick(c);
  c.setAlive(false); await tick(c);
  assert.equal(c.hb.running, false, 'auth rows 离开文档 ⇒ 心跳必须停');
  // D：迟到窗口 —— 终态后给 N 拍机会，仍无变化就停
  const d = makeHarness([{ providers: { netease: { source: 'none' } } }]);
  d.hb.start(); d.hb.armLate(2);
  await tick(d); assert.equal(d.hb.running, true, '窗口里还活着');
  await tick(d); assert.equal(d.hb.running, false, '两拍都无变化 ⇒ 自己停');
  // E：迟到窗口里真的翻出来了 ⇒ 照样报（手机确认晚一步那条）
  const e = makeHarness([{ providers: { netease: { source: 'none' } } }, { providers: { netease: { source: 'file' } } }]);
  e.hb.start(); e.hb.armLate(3);
  await tick(e); await tick(e);
  assert.deepEqual(e.notified, ['netease'], '窗口里翻出来照报');
});

test('R212 ②：生命周期 —— 关/切两处显式停 + 渲染成功后拉起 + 终态 armLate；元素自查绑在 auth-rows 上', () => {
  const closeBody = app.slice(app.indexOf('function closePanel'), app.indexOf('function openPanel'));
  const openBody = app.slice(app.indexOf('function openPanel'), app.indexOf('$("#music-panel-root").innerHTML =', app.indexOf('function openPanel')));
  const rows = app.slice(app.indexOf('async function renderAuthRows'), app.indexOf('const authHeartbeat = createAuthHeartbeat('));
  const poll = app.slice(app.indexOf('function scheduleAuthPoll'), app.indexOf('async function startQrLogin'));
  assert.ok(closeBody.length > 200 && openBody.length > 150 && rows.length > 800 && poll.length > 800,
    '四片都要截得到（判据不许空转）');
  assert.match(closeBody, /stopAuthHeartbeat\(\);/, '关面板必须显式停心跳（旧行会被整根拿掉）');
  assert.match(openBody, /stopAuthHeartbeat\(\);/, '切面板也要停（新面板不是设置页时就没人再拉起）');
  assert.match(app, /function stopAuthHeartbeat\(\) \{\n  authHeartbeat\.stop\(\);\n\}/, '停的出口只有一个');
  assert.match(rows, /if \(box\.isConnected\) authHeartbeat\.start\(\);/, '渲染成功后（还连着）才把心跳拉起来');
  assert.match(app, /alive: \(\) => !!document\.querySelector<HTMLElement>\("\[data-role='auth-rows'\]"\)\?\.isConnected/,
    '元素自查必须绑在 auth-rows 的 isConnected 上');
  assert.match(poll, /if \(terminal\) \{\n      authQrImages\.delete\(provider\)[\s\S]{0,260}authHeartbeat\.armLate\(\);/,
    '终态时别把"看"也一起停掉：armLate 给迟到确认窗口（上游确认可能晚到）');
});

test('R212 ③：心跳那条路只读本地自省 —— 模块与接线里都不许出现 /poll、/account、fetch、bridge', async () => {
  const hb = await read('src/auth-heartbeat.ts');
  // 注释里的"提提及"不算调用（R153 那课的写法）：扫前把注释剥掉，判的是**代码面**。
  const stripComments = (text) => text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');
  const wiring = app.slice(app.indexOf('const authHeartbeat = createAuthHeartbeat('), app.indexOf('function stopAuthHeartbeat'));
  assert.ok(hb.length > 1000 && wiring.length > 300, '两片都要截得到（判据不许空转）');
  for (const [name, text] of [['src/auth-heartbeat.ts', stripComments(hb)], ['music-app 接线', stripComments(wiring)]]) {
    for (const banned of ['/poll', '/account', 'fetch(', 'bridge']) {
      assert.ok(!text.includes(banned), `${name} 里出现了「${banned}」：心跳这条路只许读 GET /api/online/auth（本地自省、不出网）`);
    }
  }
  assert.match(stripComments(wiring), /read: \(\) => request<AuthSnapshot>\("\/api\/online\/auth"\)/, '唯一的数据来源就是那条本地自省');
  // 交叉印证（不另立判据）：服务端那一跳"不出网、不碰桥"的承诺仍在 —— 心跳敢低频全靠它。
  assert.match(server, /本地自省（不出网、不碰桥：读内存 \+ stat 会话文件）/, 'GET /auth 的服务端承诺不许变');
});

// ── R214 · 去重门修：同一界面会话里"退出登录 → 再登录"，必须再翻面、再报一次 ──────────────

test('R214：两轮往返 —— 退出后再登录同一家，必须再翻、再报一次（去重期改成"每次登录事件一次"）', async () => {
  const { createAuthHeartbeat } = await import('../src/auth-heartbeat.ts');
  const makeHarness = (sequence) => {
    const scheduled = [];
    const notified = [];
    let renders = 0;
    let i = 0;
    const hb = createAuthHeartbeat({
      read: async () => { const s = sequence[Math.min(i, sequence.length - 1)]; i += 1; return s; },
      render: () => { renders += 1; },
      notifyLogin: (provider) => notified.push(provider),
      schedule: (fn) => { scheduled.push(fn); return fn; },
      cancel: () => {},
    });
    return { hb, notified, scheduled, renders: () => renders };
  };
  const tick = async (h) => { const fn = h.scheduled.shift(); assert.ok(fn, '没排下一拍'); await fn(); };
  const file = { providers: { netease: { source: 'file' } } };
  const none = { providers: { netease: { source: 'none' } } };
  // 用户实报的路径（**同一界面会话**）：未登录 → 第一轮登录 → 退出 → 第二轮登录
  const h = makeHarness([none, file, none, file, file]);
  h.hb.start();
  await tick(h);
  assert.deepEqual(h.notified, [], '（前置）第一次探测：未登录，什么都不报');
  await tick(h);
  assert.deepEqual(h.notified, ['netease'], '(i) 第一轮登录：报一次');
  assert.equal(h.renders(), 1, '(i) 第一轮登录：翻面');
  await tick(h);                       // 拍 3：退出（回 none）
  await tick(h);                       // 拍 4：第二轮登录 —— 必须再翻、再报
  assert.deepEqual(h.notified, ['netease', 'netease'], '(ii) 第二轮登录必须**再报一次**（R214 修的就是它从前一声不吭）');
  assert.equal(h.renders(), 2, '(ii) 第二轮必须**再翻面**：翻面不许被去重门挡（这才是"界面与服务端不同步"的直接解药）');
  await tick(h);                       // 拍 5：稳态 file
  assert.deepEqual(h.notified, ['netease', 'netease'], '(iii) 无转档不许重复报（toast 不许每 12 秒刷）');
  assert.equal(h.renders(), 2, '(iii) 稳态不重复翻');
  // 正面钉选**行为级**：(ii) 那两次报告 + `renders()==2` 就是"回 none 时把该家从 reported 删掉"的直接证明；
  // 不另钉源码形状 —— 形状判据钉不动等价写法（R211 那课），行为钉得住。
  // （iv）起点种子：首开就已是登录态 ⇒ 不算一次"登录事件"（不补假 toast、也不多翻一次）。
  const seeded = makeHarness([file, file]);
  seeded.hb.seed(file.providers);
  seeded.hb.start();
  await tick(seeded); await tick(seeded);
  assert.deepEqual(seeded.notified, [], '(iv) 首开已登录不补报（R212 注释承诺过、R214 用 seed 兑现）');
  assert.equal(seeded.renders(), 0, '(iv) 首开已登录也不多翻');
  // （v）种子里是"未登录" ⇒ 上次那个"已报过"要作废（关面板期间被登出那条缺口也由这一行对掉）：
  // 同一实例、第二轮登录必须还能报。
  const again = makeHarness([file, file]);
  again.hb.start();
  await tick(again);
  assert.deepEqual(again.notified, ['netease'], '（前置）先登录一次');
  again.hb.stop();
  again.hb.seed(none.providers);                 // 面板重开时读到的是"未登录"
  again.hb.start();
  await tick(again);
  assert.deepEqual(again.notified, ['netease', 'netease'], '(v) 起点为 none ⇒ "已报过"作废，再登录必须再报');
});

// ── R215 · 到期语义两件：本地到点不再终止（客户端续问）+ 心跳 seed 每次都同步 ─────────────────

test('R215 ①：心跳 seed **每次都同步**（跑着也叫得动）——喂 none 再给 file 必须再翻、再报一次', async () => {
  const { createAuthHeartbeat } = await import('../src/auth-heartbeat.ts');
  const scheduled = [];
  const notified = [];
  let renders = 0;
  let i = 0;
  const file = { providers: { netease: { source: 'file' } } };
  const hb = createAuthHeartbeat({
    read: async () => { const s = [file, file][Math.min(i, 1)]; i += 1; return s; },
    render: () => { renders += 1; },
    notifyLogin: (provider) => notified.push(provider),
    schedule: (fn) => { scheduled.push(fn); return fn; },
    cancel: () => {},
  });
  const tick = async () => { const fn = scheduled.shift(); assert.ok(fn, '没排下一拍'); await fn(); };
  hb.start();
  await tick();                                  // 拍 1：登录（none→file 转档）
  assert.deepEqual(notified, ['netease']);
  assert.equal(renders, 1);
  // **心跳跑着**喂一次 seed(none)：必须当场生效（面板重渲染读到的新真值不能被"只在没跑时生效"挡住）
  hb.seed({ netease: { source: 'none' } });
  await tick();                                  // 拍 2：读到 file ⇒ 从 none 再来一跳 ⇒ 必须再翻、再报
  assert.deepEqual(notified, ['netease', 'netease'], 'seed 同步作废"已报过" ⇒ 下一跳必须再报（把那条闸加回去就红在这里）');
  assert.equal(renders, 2, '也必须再翻');
});

test('R215 ②：客户端续问 —— 过显示时长走低频（12 秒档）、两处文案如实；清图只许发生在上游终态那支', () => {
  assert.match(app, /const AUTH_OVERTIME_POLL_MS = 12_000/, '续问节奏要有唯一出处（10~15 秒档）');
  const poll = app.slice(app.indexOf('function scheduleAuthPoll'), app.indexOf('async function startQrLogin'));
  assert.ok(poll.length > 800, 'poll 那一段要截得到（判据不许空转）');
  assert.match(poll, /AUTH_OVERTIME_POLL_MS/, '到点后换低频的判定必须真的住在这条排程里');
  // 第一版只改了"读侧"（delay 取现算），**写侧**结算后还是写回 pollMs ⇒ 实测仍是 2 秒节奏（诊断探针量的间隔全 ~2010ms）。
  // 判据面窄于改动面被真机教育过一次 ⇒ 把**写侧**也钉住：结算写回的非退避分支必须是现算值。
  assert.match(poll, /authPollDelay\.set\(provider, retryable\s*\n\s*\?[\s\S]{0,120}?: effectiveMs\(\)\);/,
    '结算后写回的间隔也必须走现算（过期后要低频）——只改读侧会漏');
  // 文案两处逐字（本地到点"仍在等手机确认"的实话）——行文案与二维码格文案
  assert.match(app, /已过显示时长，仍在等手机确认（可能延迟一两分钟）/, '行文案：不许留在"剩 0 秒"骗人');
  assert.match(app, /手机确认可能延迟一两分钟，确认到了会自动登录/, '二维码格文案的如实说法');
  assert.equal(app.includes('秒内有效'), false, '旧口径（"N 秒内有效"）不许留下');
  // 反向钉：本地到点不许再把图清掉 —— 清图的唯一入口仍是"上游终态"那一支（R214 的块形状）
  assert.match(poll, /if \(terminal\) \{\n      authQrImages\.delete\(provider\)/, '清图只许发生在终态块里');
});

// ── R217 · 「已登录」徽标三档：本地有凭据 ≠ 上游认账 ≠ 问不到 ─────────────────────────────
// 现场（验收侧一手）：登录行写「已登录（凭据在本机会话文件里）」、列账号歌单却回「网易说这台机器没登录」——
// 两种 `loggedIn:false`（上游不认 / 问不到）被混成了一句，而用户正因反复扫码被网易限流 24 小时。
// 分档判据与文案住在纯模块 `src/auth-badge.ts`（自检直接驱动它），这里再钉接线面。

test('R217 ①：上游明确不认这份凭据 ⇒ 行文案换口径 + 「重新扫码」入口回到那一行（不许再写"已登录"）', async () => {
  const { classifyAuthAccount, applyAuthAccountState, showsRescan } = await import('../src/auth-badge.ts');
  const base = '已登录（凭据在本机会话文件里）· 6 项 · 2026/10/13 20:22:16';
  // 验收侧实测的形状之一：`{loggedIn:false}`（**不带** reason）= 上游明确不认（/user/account 没有 account.id）。
  const rejected = classifyAuthAccount({ loggedIn: false });
  assert.equal(rejected.status, 'rejected', '不带 reason 的 false 才是"上游不认"（服务端契约，见 auth-badge 文件头）');
  const text = applyAuthAccountState(base, rejected);
  assert.ok(text.includes('可能已失效'), `(i) 行文案必须含"可能已失效"：${text}`);
  assert.equal(text.includes('已登录（凭据在本机会话文件里）'), false, '(i) 不许在同一行里又写"已登录"——两句话打架就是这次的用户现场');
  assert.equal(showsRescan(rejected.status), true, '(i) 这一档要放回重扫入口');
  // 接线面（把修复拆掉就红在这里）：行文案收尾必须过三档处置；按钮开关必须读那份状态、且真给「重新扫码」入口。
  const rowText = app.slice(app.indexOf('function authRowText'), app.indexOf('function authRowMarkup'));
  assert.ok(rowText.includes('applyAuthAccountState(base, account)'), '(i) 行文案收尾必须走三档处置（永远写已登录就红在这里）');
  const markup = app.slice(app.indexOf('function authRowMarkup'), app.indexOf('async function renderAuthRows'));
  assert.match(markup, /showsRescan\(authAccounts\.get\(provider\.id\)\?\.status\)/, '(i) 重扫入口的开关必须读那份状态');
  assert.match(markup, /data-action="auth-start" data-auth="\$\{provider\.id\}">重新扫码/, '(i) rejected 档要在这一行给出「重新扫码」入口（现在登录态行只给"退出登录"）');
});

test('R217 ②：问不到上游 ⇒ 只说"暂时问不到"；不许写"失效"、不许引导重扫；限流原话要透出', async () => {
  const { classifyAuthAccount, applyAuthAccountState, showsRescan } = await import('../src/auth-badge.ts');
  const base = '已登录（凭据在本机会话文件里）· 6 项 · 2026/10/13 20:22:16';
  // 验收侧实测的形状之二：`{loggedIn:false, reason:"fetch failed"}` = 这一问没走到上游（可能只是被限流挡住）。
  const unreachable = classifyAuthAccount({ loggedIn: false, reason: 'fetch failed' });
  assert.equal(unreachable.status, 'unreachable', '带 reason 的 false 是"问不到"（两种 false 分家就是本件的起点）');
  const text = applyAuthAccountState(base, unreachable);
  assert.ok(text.includes('问不到'), `(ii) 文案必须说"暂时问不到"：${text}`);
  assert.equal(text.includes('失效'), false, '(ii) 不许把"问不到"写成"失效"（会误导用户去反复扫——正是被限流的成因之一）');
  assert.equal(text.includes('重新扫码'), false, '(ii) 这一档不许出现重扫引导');
  assert.equal(showsRescan(unreachable.status), false, '(ii) 重扫入口只归"上游不认"那一档');
  assert.ok(text.includes('已登录（凭据在本机会话文件里）'), '(ii) 本地那份凭据文件的事实不推翻：原行保留，后面接一句');
  // 请求整个抛了（服务没起来 / 网络层抛错）同样是"问不到"，**不许**归"失效"。
  assert.equal(classifyAuthAccount(undefined).status, 'unreachable', '没拿到响应 = 问不到（保守方向：宁可不指控凭据）');
  assert.equal(classifyAuthAccount({}).status, 'unreachable', '形状不完整 ⇒ 没证据指控"失效"，按问不到算');
  // 上游原话能看出"被限制/太频繁" ⇒ 原话透出 + 明写不要重复扫（用户被网易限流 24 小时的教训）。
  const limitedText = applyAuthAccountState(base, classifyAuthAccount({ loggedIn: false, reason: '上游提示操作太频繁，请稍后再试' }));
  assert.ok(limitedText.includes('太频繁'), `限流原话要透出来：${limitedText}`);
  assert.ok(limitedText.includes('先别重复扫码'), '被限流时要说清"别重复扫"');
  assert.equal(limitedText.includes('重新扫码'), false, '"先别重复扫码"不含"重新扫码"（字面也不许出现重扫引导）');
});

test('R217 ③：上游认账那一档不许出现"失效/不认"；全仓指路文案不许再把用户往"设置"里指', async () => {
  const { classifyAuthAccount, applyAuthAccountState, authAccountSegment, showsRescan } = await import('../src/auth-badge.ts');
  const base = '已登录（凭据在本机会话文件里）· 6 项 · 2026/10/13 20:22:16';
  const ok = classifyAuthAccount({ loggedIn: true, nickname: '某人', vipLabel: 'VIP' });
  assert.equal(ok.status, 'ok');
  assert.equal(authAccountSegment(ok), '', '(iii) 认账那一档那一格是空串：原样保留"已登录"行');
  assert.equal(applyAuthAccountState(base, ok), base, '(iii) 上游认账 ⇒ 行文案逐字原样');
  assert.equal(/失效|不认/.test(applyAuthAccountState(base, ok)), false, '(iii) "失效/不认"不许出现在这一档');
  assert.equal(showsRescan(ok.status), false, '(iii) 认账那档不给重扫（只给"退出登录"）');
  // (iv) 指路文案：登录区与在线开关都住在**音乐库面板**（renderLibraryPanel 那一节）——全仓源码面
  //（app/src 与 app/scripts 两棵树、剥掉注释）不许再有把用户往"设置"里指的句子。
  // 本文件自己除外（它写着这些词是为了扫它们——判据的文本，不是用户可见文案）。
  const { readdir } = await import('node:fs/promises');
  const { join, basename } = await import('node:path');
  const self = basename(fileURLToPath(import.meta.url));
  const root = join(SCRIPTS, '..');
  const banned = /先去设置里扫码|在设置的「扫码登录」|在设置的「在线能力」|在设置里重新勾选|在设置里把在线能力/;
  const strip = (text) => text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');
  const offenders = [];
  const walk = async (dir) => {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      if (entry.name === 'node_modules' || entry.name === 'dist' || entry.name === self) continue;
      const full = join(dir, entry.name);
      if (entry.isDirectory()) { await walk(full); continue; }
      if (!/\.(ts|mjs)$/.test(entry.name)) continue;
      if (banned.test(strip(await readFile(full, 'utf8')))) offenders.push(full.slice(root.length + 1).split(String.fromCharCode(92)).join('/'));
    }
  };
  await walk(join(root, 'src'));
  await walk(join(root, 'scripts'));
  assert.deepEqual(offenders, [], `(iv) 这些文件还在把用户往"设置"里指：${offenders.join('、')}`);
});
