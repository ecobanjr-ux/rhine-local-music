/**
 * 命令面板（R131 · 候选 ⑤ 的最后一项）。本项目自撰，非移植代码。
 *
 * 上游那块命令面板没有移植（台账 R6/R7 把面板与命令从 classic 视图里切掉），
 * 但适配层一直留着上游预留的那条口子：`invokeCommandById` / `canInvokeCommandById`。
 * 本模块把这条口子接上真正会做事的东西：一张命令表 + 一个可测的状态机，
 * DOM 挂载与键盘路由在 `music-app.ts`（那边只负责"把 markup 画上屏、把按键转成动作"）。
 *
 * 三条形状上的讲究，都有对应断言：
 *   ① **命令表是唯一出处**：面板列表、岛内 `invokeCommandById`、可用性判断都读同一张表，
 *      所以"面板里看得见"与"岛里按得动"永远一致；
 *   ② **不可用的命令不显示**（而不是灰着一排）：没有当前曲目时"收藏这首"就不该占一行；
 *      但"按了没反应"是最坏的观感，所以 `activate` 再判一次可用性；
 *   ③ 命令只做**已经存在的宿主动作**的转发，本模块不实现任何新行为。
 */

export interface Command {
  id: string;
  title: string;
  /** 一行说明：面板里显示在标题右侧，也是"这条到底做什么"的兜底描述。 */
  hint: string;
  /** 额外检索词（中文标题打不出来时用拼音/英文/别名）。 */
  keywords: string;
  group: "播放" | "视图" | "浏览" | "本机" | "队列";
  /** 现在能不能执行。每次渲染与每次执行都读它，不缓存。 */
  available: () => boolean;
  run: () => void;
}

export interface CommandHost {
  /** 取命令表用**函数**而不是数组：命令的 run 里引用的那些宿主函数有不少声明在本模块之后，
     数组字面量会在模块求值时就碰它们（TDZ）。声明成 getter 也不解决问题——getter 同样在构造时求值。 */
  commands: () => Command[];
  /** 面板开合变化时要求重绘（DOM 归 music-app 管）。 */
  render: () => void;
  /**
   * 这一块列表当前是什么（R134 之后同一台状态机可以喂命令、也可以喂队列）。
   * 只影响读屏与空态那句话，不参与任何判定——判据仍然只有"可不可用 + 子串匹配"。
   */
  caption?: () => string;
  /** 空列表时那句实话（默认按"命令"说；队列那一档要说"队列里还没有曲目"）。 */
  emptyText?: () => string;
}

export type CommandPalette = ReturnType<typeof createCommandPalette>;

/** 过滤后的可见命令：不可用的不显示，查询按"标题 + 检索词"子串匹配（不分大小写、忽略空格）。 */
export function visibleCommands(commands: Command[], query: string): Command[] {
  const needle = query.trim().toLowerCase().replace(/\s+/g, "");
  return commands.filter((command) => {
    if (!command.available()) return false;
    if (!needle) return true;
    const hay = `${command.title}${command.keywords}${command.id}${command.hint}`.toLowerCase().replace(/\s+/g, "");
    return hay.includes(needle);
  });
}

export function createCommandPalette(host: CommandHost) {
  let open = false;
  let query = "";
  let cursor = 0;

  const list = () => visibleCommands(host.commands(), query);
  /** 光标越界（改了查询、或某条命令刚变得不可用）要收回最后一行，不能停在空位上。 */
  const clamp = (length: number) => {
    if (length === 0) { cursor = 0; return; }
    if (cursor >= length) cursor = length - 1;
    if (cursor < 0) cursor = 0;
  };
  const sync = () => host.render();

  return {
    isOpen: () => open,
    query: () => query,
    cursor: () => cursor,
    list,
    /** 面板里当前该执行的那条（越界或不可用时返回 null，调用方要说实话）。 */
    current(): Command | null {
      const items = list();
      clamp(items.length);
      return items[cursor] ?? null;
    },
    setQuery(next: string) {
      query = String(next ?? "");
      cursor = 0;                       // 换查询 ⇒ 光标回到第一条：留在原位会指向一条完全不同的命令
      sync();
    },
    openPalette() {
      open = true;
      query = "";
      cursor = 0;
      sync();
    },
    closePalette() {
      open = false;
      sync();
    },
    togglePalette() {
      if (open) this.closePalette();
      else this.openPalette();
    },
    /** 上下移动**一行**（键盘语义）。传 ±99 也只是一格：跳多行没有对应的按键，也不想暗示它支持。 */
    move(delta: number) {
      const items = list();
      if (!items.length) return;
      clamp(items.length);
      const step = Number(delta) > 0 ? 1 : -1;
      // 首尾回绕：键盘上下键按到边界再按就该回到另一头，停在边界会让人以为按键没生效。
      cursor = (cursor + step + items.length) % items.length;
      sync();
    },
    /** 执行当前那条。不可用就不执行并回 false（面板里显示的都可用，这一判是防"列表刚过期"）。 */
    activate(): boolean {
      const command = this.current();
      if (!command || !command.available()) return false;
      command.run();
      return true;
    },
    /** 按 id 执行（岛内 `invokeCommandById` 走这里）。认不出的 id 回 false，不猜"最接近的那条"。 */
    runById(id: string): boolean {
      const command = host.commands().find((entry) => entry.id === String(id));
      if (!command || !command.available()) return false;
      command.run();
      return true;
    },
    canRun(id: string): boolean {
      const command = host.commands().find((entry) => entry.id === String(id));
      return Boolean(command?.available());
    },
    /**
     * 面板的 HTML。列表整块重绘（输入框不在这一块里，所以打字不会丢焦点）。
     * `aria-activedescendant` + `role="option"` 是给读屏的：光标行必须被念出来。
     */
    markup(): string {
      const caption = host.caption?.() ?? "命令";
      const items = list();
      clamp(items.length);
      if (!items.length) {
        const typed = query.trim();
        const fallback = typed ? `没有匹配「${escapeText(query)}」的${caption}。` : (host.emptyText?.() ?? "现在没有可用的命令（先放一首歌，或清掉检索词）。");
        return `<div class="command-list" id="command-list"><p class="no-results">${typed ? fallback : escapeText(fallback)}</p></div>`;
      }
      let lastGroup = "";
      const rows = items.map((command, index) => {
        const header = command.group !== lastGroup
          ? `<div class="command-group">${escapeText(lastGroup = command.group)}</div>`
          : "";
        return `${header}<button type="button" class="command-row${index === cursor ? " is-cursor" : ""}" `
          + `id="command-row-${index}" role="option" aria-selected="${index === cursor}" `
          + `data-action="command-run" data-command="${escapeText(command.id)}">`
          + `<span class="command-title">${escapeText(command.title)}</span>`
          + `<span class="command-hint">${escapeText(command.hint)}</span></button>`;
      }).join("");
      return `<div class="command-list" id="command-list" role="listbox" aria-label="${escapeText(caption)}" aria-activedescendant="command-row-${cursor}">${rows}</div>`;
    },
  };
}

/** 面板里的文字都经过这里：命令文案是代码里写的常量，但检索词是用户打的，必须转义。 */
function escapeText(value: unknown): string {
  return String(value ?? "")
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}
