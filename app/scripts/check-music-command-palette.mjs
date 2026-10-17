// R131 命令面板（候选 ⑤ 的最后一项）的自检。
//
// 面板的纯逻辑（表 + 过滤 + 光标 + 执行）在 `src/command-palette.ts`，这里全部离线可测；
// DOM 挂载与键盘路由留在 music-app（那边只做"画屏"和"把按键转成动作"）。
// 钉四件事：① 表本身健全（id 唯一、每条都真的转发一个既有动作）；② 不可用的命令**不显示**
// 且 activate 再判一次；③ 光标与过滤的边界（换查询归零、首尾回绕、列表变短不越界）；
// ④ 用户打的检索词必须转义（面板把查询串回显到 innerHTML 里，这是 XSS 面）。
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';

const read = (relative) => readFile(new URL(`../${relative}`, import.meta.url), 'utf8');

const { createCommandPalette, visibleCommands } = await import('../src/command-palette.ts');

const make = (over = {}) => {
  const state = { runs: 0, available: true, ...over };
  return {
    command: {
      id: state.id ?? 'x', title: state.title ?? '测试命令', hint: state.hint ?? '', keywords: state.keywords ?? '',
      group: state.group ?? '播放',
      available: () => state.available,
      run: () => { state.runs += 1; },
    },
    state,
  };
};
const host = (commands, extra = {}) => {
  const renders = { count: 0 };
  const palette = createCommandPalette({ commands: () => commands, render: () => { renders.count += 1; }, ...extra });
  return { palette, renders };
};

test('表健全：id 唯一、每条都有文案与分组、available 与 run 都是函数且不抛', async () => {
  const app = await read('src/music-app.ts');
  const block = /const commandDefinitions: Command\[\] = \[([\s\S]*?)\n\];/.exec(app);
  assert.ok(block, '没抓到命令表（提取失败不许静默通过）');
  const ids = [...block[1].matchAll(/\bid: "([a-z0-9-]+)"/g)].map((m) => m[1]);
  assert.ok(ids.length >= 15, `命令表不该只剩 ${ids.length} 条`);
  assert.equal(new Set(ids).size, ids.length, `id 重复：${ids.filter((id, index) => ids.indexOf(id) !== index).join(',')}`);
  // 每条都必须带全七件：id / title / hint / keywords / group + available + run
  for (const field of ['title:', 'hint:', 'keywords:', 'group:', 'available:', 'run:']) {
    const count = (block[1].match(new RegExp(`\\b${field}`, 'g')) ?? []).length;
    assert.equal(count, ids.length, `字段 ${field} 该每条都有，实测 ${count}/${ids.length}`);
  }
  // 面板只做转发：不许在命令表里出现新的出网或写盘动作
  assert.doesNotMatch(block[1], /fetch\(|localStorage|XMLHttpRequest/, '命令只做既有动作的转发');
  // 不许留"未实现"的占位
  assert.doesNotMatch(block[1], /run: \(\) => \{\s*\}|available: \(\) => false/, '命令表里不许有空实现或恒不可用的占位');
});

test('不可用的命令不显示（而不是灰着一排），可用了才回来', () => {
  const a = make({ id: 'a', title: '播放 / 暂停' });
  const b = make({ id: 'b', title: '下一首' });
  const { palette } = host([a.command, b.command]);
  a.state.available = false;
  assert.deepEqual(palette.list().map((command) => command.id), ['b'], '没有当前曲目时"播放/暂停"根本不该占一行');
  assert.equal(palette.canRun('a'), false);
  a.state.available = true;
  assert.deepEqual(palette.list().map((command) => command.id), ['a', 'b']);
  assert.equal(palette.canRun('a'), true);
});

test('过滤对中文标题、拼音、id、大小写与空格都不敏感', () => {
  const items = [
    make({ id: 'favorite-toggle', title: '收藏 / 取消收藏这一首', keywords: 'like heart collect shoucang' }),
    make({ id: 'theme-night', title: '主题：深夜', keywords: 'theme night dark shenye' }),
  ];
  const list = (query) => visibleCommands(items.map((entry) => entry.command), query).map((command) => command.id);
  assert.deepEqual(list('收藏'), ['favorite-toggle']);
  assert.deepEqual(list('shoucang'), ['favorite-toggle'], '中文打不出来时用拼音');
  assert.deepEqual(list('THEME'), ['theme-night'], '大小写不敏感');
  assert.deepEqual(list('取 消 收 藏'), ['favorite-toggle'], '空格不敏感（打快了带空格很常见）');
  assert.deepEqual(list('favorite-toggle'), ['favorite-toggle'], 'id 也能搜到：岛内 invokeCommandById 用的就是它');
  // 大小写不敏感要**两边**都算：命令表里的关键词恰好都写成小写时，只把检索词转小写也能过（等价变异），
  // 所以这里用一条标题里带大写的命令来判。
  const upper = [make({ id: 'fm', title: 'AB 面切换', keywords: 'ab mian' }).command];
  assert.deepEqual(visibleCommands(upper, 'ab').map((command) => command.id), ['fm'], '标题里的大写也要能被子串命中');
  assert.deepEqual(visibleCommands(upper, 'AB 面').map((command) => command.id), ['fm']);
  assert.deepEqual(list('没有这个东西'), [], '搜不到就是空，不猜"最接近的"');
});

test('光标：换查询归零、上下回绕、列表变短不越界、空列表不动', () => {
  const three = [make({ id: 'a', title: 'A' }), make({ id: 'b', title: 'B' }), make({ id: 'c', title: 'C' })];
  const { palette, renders } = host(three.map((entry) => entry.command));
  palette.openPalette();
  assert.equal(palette.cursor(), 0);
  palette.move(1);
  assert.equal(palette.cursor(), 1);
  palette.move(-1);
  palette.move(-1);
  assert.equal(palette.cursor(), 2, '上越界要回绕到最后一行（停在边界会让人以为按键没生效）');
  palette.move(1);
  assert.equal(palette.cursor(), 0, '下越界回绕到第一行');
  palette.setQuery('B');
  assert.equal(palette.cursor(), 0, '换查询后光标回第一条：留在原位会指向另一条命令');
  // 上一条在光标本来就是 0 的序列里是等价变异（clamp 会把它兜回来），所以这里从光标=1 起步再换查询。
  palette.setQuery('');
  palette.move(1);
  assert.equal(palette.cursor(), 1);
  palette.setQuery('A');
  assert.equal(palette.cursor(), 0, '光标停在 1 时换查询必须归零（此时列表可能只剩一条，clamp 兜不住"指向另一条"的情况）');
  assert.equal(palette.current()?.id, 'a');
  assert.ok(renders.count > 0, '每次状态变化都要要求重绘（面板不会自己动）');
  three[2].state.available = false;
  palette.setQuery('');
  palette.move(1);
  palette.move(1);
  palette.move(1);
  assert.ok(palette.current(), '两条里连按三次也不许越界到空位');
  three[0].state.available = false;
  three[1].state.available = false;
  palette.move(1);
  assert.equal(palette.current(), null, '全不可用时列表是空的，move 不该造出一条命令');
});

test('activate 与 runById：执行的是当前那条；不可用一律回 false 且不执行', () => {
  const a = make({ id: 'a', title: 'A' });
  const b = make({ id: 'b', title: 'B' });
  const { palette } = host([a.command, b.command]);
  palette.openPalette();
  palette.move(1);
  assert.equal(palette.activate(), true);
  assert.equal(b.state.runs, 1, '执行的是光标那条，不是第一条');
  assert.equal(a.state.runs, 0);
  b.state.available = false;
  // 列表会当场重算：光标从"已消失的 b"收回到仍然可用的 a。
  // 这一格要钉的是**绝不执行不可用的那条**（而不是"拒绝执行任何东西"）。
  assert.equal(palette.activate(), true);
  assert.equal(b.state.runs, 1, '刚变不可用的那条一条都不许执行');
  assert.equal(a.state.runs, 1, '执行的是收回之后光标所在的那条');
  a.state.available = false;
  assert.equal(palette.activate(), false, '全部不可用时列表是空的，activate 必须回 false');
  assert.equal(a.state.runs, 1);
  a.state.available = true;
  assert.equal(palette.runById('a'), true, '按 id 执行是岛内那条口子的路径');
  assert.equal(a.state.runs, 2);
  assert.equal(palette.runById('不存在的命令'), false, '认不出的 id 不猜"最接近的那条"');
  assert.equal(palette.runById('b'), false, '按 id 执行同样要过可用性');
});

test('markup：光标行有 aria 痕迹，检索词被转义（这是 XSS 面），空列表两种说法', () => {
  const items = [make({ id: 'a', title: '播放 / 暂停', group: '播放' }), make({ id: 'b', title: '主题：深夜', group: '视图' })];
  const { palette } = host(items.map((entry) => entry.command));
  palette.openPalette();
  const markup = palette.markup();
  assert.match(markup, /role="listbox"/);
  assert.match(markup, /aria-activedescendant="command-row-0"/, '读屏要念得出光标行');
  assert.match(markup, /class="command-row is-cursor"[\s\S]*?aria-selected="true"/);
  assert.equal((markup.match(/aria-selected="true"/g) ?? []).length, 1, '只能有一行是选中的');
  assert.match(markup, /<div class="command-group">视图<\/div>/, '分组只在换组时出现一次');
  palette.setQuery('<img src=x onerror=alert(1)>');
  const injected = palette.markup();
  assert.doesNotMatch(injected, /<img src=x/, '用户打的检索词必须转义后才回显');
  assert.match(injected, /&lt;img src=x/, '转义之后仍然看得见原样（不是被吃掉）');
  assert.match(injected, /没有匹配/, '搜不到要说"没有匹配…"');
  const empty = host([make({ id: 'z', title: 'Z', available: false }).command]);
  empty.palette.openPalette();
  assert.match(empty.palette.markup(), /现在没有可用的命令/, '空列表的两种原因要分开说');
});

test('宿主接线：Ctrl+P 走 capture（输入框里也要能开），岛内 invokeCommandById 读同一张表', async () => {
  const app = await read('src/music-app.ts');
  assert.match(app, /document\.addEventListener\("keydown", routeCommandKeys, \{ capture: true \}\)/,
    'capture 注册：宿主那条 keydown 对输入框直接 return，挂在它后面就永远收不到 Ctrl+P');
  assert.match(app, /event\.key\.toLowerCase\(\) === "p"/, 'Ctrl+P 与 Cmd+P 都认');
  assert.match(app, /!event\.altKey/, 'Alt+P 不该被抢走（留给浏览器/输入法）');
  assert.match(app, /if \(!commandPalette\.isOpen\(\)\) return;/, '面板没开时不吞任何按键');
  // 真机量到的漏：capture 里只 preventDefault，宿主那条"Esc = 回到专辑架"照样执行 ⇒ 关面板把岛一起卸了。
  assert.match(app, /function swallowCommandKey\(event: KeyboardEvent\) \{[\s\S]{0,120}event\.stopPropagation\(\);/,
    '面板吃下的按键必须 stopPropagation：preventDefault 只拦默认动作，不拦同一条事件的其它监听器');
  const escBranch = /if \(event\.key === "Escape"\) \{([^]*?)return; \}/.exec(app);
  assert.ok(escBranch, '没抓到 Esc 分支');
  assert.match(escBranch[1], /swallowCommandKey\(event\)/, 'Esc 由面板独占（否则关面板的同时就把歌词面/详情面关了）');
  for (const name of ['ArrowDown', 'ArrowUp', 'Enter']) {
    assert.match(app, new RegExp(`if \\(event\\.key === "${name}"\\) \\{[\\s\\S]{0,40}swallowCommandKey\\(event\\)`),
      `${name} 也要独占：宿主的上下键在动镜头与架子、回车在点行`);
  }
  assert.match(app, /invokeCommand: \(commandId\) => \{[\s\S]{0,160}commandPalette\.runById\(commandId\)/, '岛内命令口子转交同一张表');
  assert.match(app, /canInvokeCommand: \(commandId\) => commandPalette\.canRun\(commandId\)/, '可用性也由同一张表回答');
  assert.match(app, /render: renderCommandPalette/, '状态机自己不会画屏，重绘由宿主做');
  // 光标行要滚进可视区：一屏装不下 18 条命令，只换 class 不滚动的话光标会跑到卡片外面（真机截图判出来的）。
  assert.match(app, /\.scrollIntoView\(\{ block: "nearest" \}\)/, '按 ↓ 要把光标行滚进可视区');
  assert.match(app, /#command-palette-list \.command-row\.is-cursor/, '滚的是当前光标那一行（不是整块列表）');
  const css = await read('src/music.css');
  const overlayRule = /\.command-overlay \{[^}]*\}/.exec(css);
  assert.ok(overlayRule, '没抓到面板浮层规则');
  assert.match(overlayRule[0], /position: fixed/, '浮层要盖住整屏');
  const zMatch = /\.command-overlay \{[^}]*z-index: (\d+)/.exec(css);
  assert.ok(zMatch, '浮层必须有 z-index');
  // 面板从任何画面都能开（包括封面墙），所以层级要压得住**两张**样式表里已有的最高层
  // ——岛内悬浮控制条那条在 lyric-folia-chrome.css，只看 music.css 会漏。
  const chrome = await read('src/lyric-folia-chrome.css');
  const rest = `${css.replace(overlayRule[0], "")}\n${chrome}`;
  const others = [...rest.matchAll(/z-index: (\d+)/g)].map((m) => Number(m[1]));
  assert.ok(others.length, '两张样式表里一个 z-index 都没有 ⇒ 判据取错了文件');
  assert.ok(Number(zMatch[1]) > Math.max(...others),
    `浮层 ${zMatch[1]} 必须高于现有最高层 ${Math.max(...others)}，否则从墙上开面板会被控制条压住`);
  // 滚动条挂错元素的判据：外层容器才是 flex 项，内层每次重绘都是新元素。
  const scroller = /\.command-panel > #command-palette-list \{[^}]*\}/.exec(css);
  assert.ok(scroller, '滚动容器必须是面板的直接子元素 #command-palette-list');
  assert.match(scroller[0], /overflow-y: auto/);
  assert.match(scroller[0], /min-height: 0/, 'flex 项不给 min-height:0 就缩不下去（长列表顶破卡片）');
  const innerList = /\.command-list \{[^}]*\}/.exec(css);
  assert.ok(innerList, '没抓到 .command-list 规则');
  assert.doesNotMatch(innerList[0], /overflow|min-height/, '滚动规则不该留在内层（每次重绘都是新元素）');
  assert.match(app, /overlay\.hidden = !commandPalette\.isOpen\(\)/, '开合只由状态机回答（画屏侧不自留一份"开没开"）');
  assert.match(app, /if \(input\) input\.value = ""/, '关掉时清掉检索词：下次打开该是空查询，光标在第一条');
  assert.match(app, /if \(commandPalette\.isOpen\(\)\) \{[\s\S]{0,220}input\?\.focus\(\);/, '打开时聚焦输入框');
  // 点一条命令：先关面板再执行——反过来会把"打开设置面板"这类命令刚开的面板一起关掉
  const click = /if \(target\.dataset\.action === "command-run"\) \{[\s\S]*?\n    \}/.exec(app);
  assert.ok(click, '没抓到命令行的点击分支');
  const closeAt = click[0].indexOf('closePalette()');
  const runAt = click[0].indexOf('runById(');
  assert.ok(closeAt >= 0 && runAt >= 0, '点击分支里既该有关面板也该有执行（找不到时 indexOf 是 -1，直接比大小会假过）');
  assert.ok(closeAt < runAt, '必须先关面板再执行');
});

test('适配层那条预留的口子真的转出去了（不再是恒 false / 空函数）', async () => {
  const adapter = await read('src/folia-host/adapter.ts');
  assert.match(adapter, /invokeCommandById: \(commandId: string\) => \{\s*options\.invokeCommand\?\.\(commandId\);/, 'id 要转给宿主');
  assert.match(adapter, /canInvokeCommandById: \(commandId: string\) => options\.canInvokeCommand\?\.\(commandId\) === true/, '可用性问宿主');
  const island = await read('src/folia-host/island.tsx');
  assert.match(island, /invokeCommandById: \(id: string\) => adapter\.latticeControls\.invokeCommandById\(id\)/,
    '岛内 controls 要委托过去（展开对象会把 getter 摊成静态值）');
});

// 岛里那颗「打开命令面板」写的是移植件的 store 请求，上游的面板没移植 ⇒ 此前全仓没有读者，
// 点击静默无果（R121 那一族："这次点击还有没有主人"）。这四条钉的就是"读者只有一位、且真的做事"。
test('岛内的面板请求有唯一的读者：只按 seq 变化触发、卸装必解订、宿主那边真的开面板', async () => {
  const island = await read('src/folia-host/island.tsx');
  assert.match(island, /import \{ useAppViewStore \} from "\.\.\/folia\/stores\/useAppViewStore"/,
    '读者必须在岛 chunk 里（跟写请求的移植件同一个模块实例，R23 那一族的双实例地雷）');
  assert.match(island, /const unsubscribePalette = useAppViewStore\.subscribe/, '要真的订阅');
  assert.match(island, /if \(request\.seq === lastSeq\) return;/,
    '只认序号变化：zustand 每次 set 都会回调，不判序号就是别的服务状态一变就弹面板');
  assert.match(island, /let lastSeq = useAppViewStore\.getState\(\)\.commandPaletteRequest\.seq;/,
    '起点取当前序号：请求 store 是模块级的，卸装期间攒下的旧请求不该在重挂那一刻把面板弹开');
  const unmountBlock = /unmount: \(\) => \{[\s\S]*?\n    \},/.exec(island);
  assert.ok(unmountBlock, '没抓到 unmount');
  assert.match(unmountBlock[0], /unsubscribePalette\(\)/, '卸装不解订 ⇒ 重挂一次多一位读者，一次点击开两回');

  const app = await read('src/music-app.ts');
  const requestBlock = /onCommandPaletteRequest: \(commandId\) => \{[\s\S]*?\n        \},/.exec(app);
  assert.ok(requestBlock, '宿主没接这个回调');
  // R134（Q10 批复）：岛内那颗按钮预置的 'queue' 现在是一条真去处——直接开队列那一档，不再只开面板。
  assert.match(requestBlock[0], /if \(commandId === ISLAND_QUEUE_REQUEST\) \{ openQueuePalette\(\); return; \}/,
    "'queue' 开队列列表（Q10 批复的那一条）");
  assert.match(requestBlock[0], /mountCommandPalette\(\);\n          paletteSource = "commands";\n          commandPalette\.openPalette\(\);/,
    '其余 id 仍然只开命令表：不猜"最接近的那条"');
  assert.ok(requestBlock[0].indexOf('mountCommandPalette()') < requestBlock[0].lastIndexOf('openPalette()'),
    '先挂后开（反了第一次点击没有面板可开，之后每次都要多点一下）');
  assert.match(app, /const ISLAND_QUEUE_REQUEST = "queue"/, '那个 id 是个具名常量，不是散在代码里的裸字符串');

  // 文案要跟着事实走：面板已经做了，还写"未移植、此项无输出"就是骗人。
  const i18n = await read('src/folia/i18n/config.ts');
  const label = /"home\.latticeOpenQueueCommand": "([^"]*)"/.exec(i18n);
  assert.ok(label, '没抓到那条文案');
  assert.doesNotMatch(label[1], /未移植|无输出/, '这条按钮现在有输出，文案不许留在过去');

  // 全仓只许有一位读者：两位读者 = 一次点击开两回（面板 toggle 的话就是"点了没反应"）。
  // 这一条同时钉住改前的既有事实：改前除了写请求的移植件，全仓零读者 ⇒ 点击静默无果。
  const readers = [];
  const walk = async (dir) => {
    for (const entry of await readdir(new URL(`../${dir}/`, import.meta.url), { withFileTypes: true })) {
      const rel = `${dir}/${entry.name}`;
      if (entry.isDirectory()) { await walk(rel); continue; }
      if (!/\.(ts|tsx)$/.test(entry.name)) continue;
      const text = await read(rel);
      if (/commandPaletteRequest/.test(text)) readers.push(rel);
    }
  };
  await walk('src');
  assert.deepEqual(readers.sort(), ['src/folia-host/island.tsx', 'src/folia/stores/useAppViewStore.ts'],
    `commandPaletteRequest 的读者只能有岛那一位（写请求的移植件除外），实测：${readers.join(' | ')}`);
});

// ── R134（Q10 批复）：同一台状态机喂"整条队列"───────────────────────────────

test('R134 队列那一档走的是同一台状态机：过滤、光标、Enter 都是既有那套', () => {
  const jumps = [];
  const row = (index, title, artist) => ({
    id: `queue-row:${index}:${title}`, title, hint: `第 ${index + 1} 首 · ${artist}`,
    keywords: `${artist} queue duilie 队列`, group: "队列", available: () => true,
    run: () => { jumps.push(index); },
  });
  const queue = [row(0, '恋人', '李荣浩'), row(1, 'Sneaky Snatch', 'Kevin MacLeod'), row(2, 'Wallpaper', 'Kevin MacLeod')];
  const renders = { count: 0 };
  const palette = createCommandPalette({ commands: () => queue, render: () => { renders.count += 1; }, caption: () => "队列" });
  palette.openPalette();
  assert.equal(palette.list().length, 3, '队列三条就列三条');
  assert.deepEqual(palette.markup().match(/aria-label="队列"/) ? [1] : [], [1], '读屏要听得出这是队列不是命令');
  assert.match(palette.markup(), /第 2 首 · Kevin MacLeod/, '说明位带着"第几首"，跳播才点对格');
  // 既有的过滤机制直接可用：按歌手过滤
  palette.setQuery('kevin');
  assert.deepEqual(palette.list().map((command) => command.id), ['queue-row:1:Sneaky Snatch', 'queue-row:2:Wallpaper']);
  palette.setQuery('队列');
  assert.equal(palette.list().length, 3, 'keywords 里带了"队列"两个字，中文搜得到这一档');
  palette.setQuery('');
  palette.move(1);
  assert.equal(palette.activate(), true);
  assert.deepEqual(jumps, [1], 'Enter 执行的是光标那一行');
  // 空态那句话也要来自当前那份列表（宿主给了 emptyText 却没人读 = 队列空了说"没有可用的命令"）
  const empty = createCommandPalette({
    commands: () => [], render: () => {}, caption: () => "队列", emptyText: () => "队列里现在没有可跳的曲目。",
  });
  empty.openPalette();
  assert.match(empty.markup(), /队列里现在没有可跳的曲目。/, 'emptyText 真的被用上了');
  assert.doesNotMatch(empty.markup(), /没有可用的命令/, '队列那一档不许说命令那句话');
  const typed = createCommandPalette({ commands: () => [], render: () => {}, caption: () => "队列" });
  typed.openPalette();
  typed.setQuery('zzz');
  assert.match(typed.markup(), /没有匹配「zzz」的队列。/, '搜不到那句话也带着当前的标题');
});

test('R134 接线：两种列表一份来源、跳播全量入队、列表过期就不跳、关掉回到命令表', async () => {
  const app = await read('src/music-app.ts');
  // R203 改写这一条的**形状**（要求本身一点没放宽 ⇒ 记 Q84）：原文钉的是
  // `: commandDefinitions)` 那一段字面尾巴，于是"按 surface 给命令表加一道过滤"这种正常扩展
  // 会被判成回归——与本轮同时踩到的"复位清单两格相邻"那条同族，也与"网易云字面量搬进共享表就红"同族。
  // 现在钉不变式：**来源是一个函数、两支各自只回到一份列表**，并且全文件只许有一个这样的来源函数。
  const sourceFn = /commands: \(\) => \([\s\S]*?\n  render:/.exec(app);
  assert.ok(sourceFn, '找不到 commands: () => 那一处来源（换成别的写法就要一起来改这条）');
  assert.match(sourceFn[0], /paletteSource === "queue"\s*\?\s*queueCommands\(\)/,
    '队列那一支必须是 queueCommands()');
  assert.match(sourceFn[0], /commandDefinitions/, '命令那一支必须回到那张表（命令表是唯一出处）');
  assert.equal([...app.matchAll(/commands: \(\) =>/g)].length, 1, '一块面板只许有一个来源函数');
  assert.match(app, /caption: \(\) => \(paletteSource === "queue" \? "队列" : "命令"\)/, '标题跟着来源走，读屏不说假话');
  assert.match(app, /emptyText: \(\) => \(paletteSource === "queue"/, '空态那句也分两种（队列空了不该说"没有可用的命令"）');
  // 来源**只能在"打开"的那一刻定**。写在渲染/关闭处会撞上一个执行顺序：面板是"先关再执行"的
  // （否则"打开设置面板"这类命令刚开起来的画面会被随后的关闭抹掉），关闭时来源已被改回命令表 ⇒
  // 紧接着的 activate()/runById() 去另一份列表里找那一行 —— 真机量到"跳播第三行"执行成了「上一首」。
  const renderFn = /function renderCommandPalette\(\) \{[\s\S]*?\n\}/.exec(app);
  assert.ok(renderFn, '没抓到 renderCommandPalette');
  assert.doesNotMatch(renderFn[0], /paletteSource = /, '渲染与关闭都不许改来源');
  assert.equal([...app.matchAll(/paletteSource = /g)].length, 3,
    '来源只有三个赋值处：Ctrl+P 打开、岛内请求打开、openQueuePalette');
  assert.match(app, /paletteSource = "commands";\n      commandPalette\.openPalette\(\);/, 'Ctrl+P 打开时定成命令表');
  assert.match(app, /paletteSource = "queue";\n  commandPalette\.openPalette\(\);/, 'openQueuePalette 打开时定成队列');
  assert.match(app, /foot\.textContent = paletteSource === "queue"/, '脚注按当前列表说人话（Enter 跳到那一首）');
  assert.match(app, /input\.placeholder = paletteSource === "queue" \? "输入歌名或歌手（从队列里跳播）"/,
    '检索框那句提示也跟着当前列表走（队列那一档写"输入命令名"就是假话）');
  // 队列在面板底下变了要重画：否则看着点的是旧行、执行的是新行（真机量到"点《恋人》跳成《模特》"）。
  const subscribe = /player\.subscribe\(\(state\) => \{[\s\S]*?\n\}\);/.exec(app);
  assert.ok(subscribe, '没抓到 player.subscribe 那段');
  assert.match(subscribe[0], /if \(commandPalette\.isOpen\(\)\) renderCommandPalette\(\);/,
    '状态一变就把面板重画（只在开着的时候，不在每帧都画）');
  // 跳播的语义与 R114 一致：整条队列继续 + 回执读内核
  const jump = /async function jumpToQueueIndex\(index: number, expectedId: string\) \{[\s\S]*?\n\}/.exec(app);
  assert.ok(jump, '没抓到 jumpToQueueIndex');
  assert.match(jump[0], /await player\.play\(target\.id, queue\)/, '以整条队列为队列、从这一首起播（不是单曲队列）');
  assert.match(jump[0], /target\.id !== expectedId/, '列表过期就不跳：按下标跳之前再对一次曲目 id');
  assert.match(jump[0], /这次没有跳/, '过期要说"没有跳"，不能静默跳到另一首歌');
  assert.match(jump[0], /队列共 \$\{player\.state\.queue\.length\} 条/, '条数读内核那份');
  assert.match(app, /id: `queue-row:\$\{index\}:\$\{track\.id\}`/,
    '队列行的 id 带下标：同一首歌在队列里可以出现两次，只按曲目 id 找会跳错格');
  assert.match(app, /hint: `第 \$\{index \+ 1\} 首 · \$\{track\.artist\}\$\{index === player\.state\.currentIndex \? " · 正在播放" : ""\}`/,
    '说明位带"第几首 + 歌手 + 是否正在播"，用户点的就是看得到的那一格');
  assert.match(app, /keywords: `\$\{track\.artist\} \$\{track\.album \?\? ""\} queue duilie 队列`/,
    '按歌手与专辑都搜得到（复用既有那套子串过滤，不另写一份）');
  assert.match(app, /id: "show-queue", title: "看整条队列"/, '命令表里有这一条（Ctrl+P 也到得了队列）');
  assert.match(app, /available: \(\) => player\.state\.queue\.length > 0/, '空队列时这条不显示（而不是灰一排让人猜）');
  assert.match(app, /if \(!player\.state\.queue\.length\) \{[\s\S]{0,120}队列是空的/, '岛里那颗按钮在空队列时给一句实话');
  // 文案跟着事实走：那颗按钮现在真的开队列
  const i18n = await read('src/folia/i18n/config.ts');
  const label = /"home\.latticeOpenQueueCommand": "([^"]*)"/.exec(i18n);
  assert.ok(label, '没抓到那条文案');
  assert.equal(label[1], '看整条队列', '按钮说什么就是什么（它现在真的开队列列表）');
});
