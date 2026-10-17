// 本项目自撰（非移植代码）。酷狗**手机分享页**导入（R158 · 夜间主批任务五）。
//
// 为什么要有第二条路：手机 App 分享出来的歌单链接里带的是 `gcid_…` 这种 token，
// 而曲目接口只认 `global_collection_id`（形如 `collection_a_b_c_d`）——R137/R138 一手试过
// 六种反推拼法全部读不到，所以那两条批下来给用户的都是"为什么读不到"。
// 本文件走的是**另一条**：手机分享页本身是 SSR，页面里注着一段 `window.$output` 的 JSON，
// 首屏十首歌就在里面 ⇒ **能导首屏，导不到整单**，这句话必须写进回执而不是含糊过去。
//
// 四张一手实测（2026-10-10，探针四轮，全在仓库外；用户批准范围 = 本件新增一台主机 + 一个 HTML 解析面）：
//   ① `https://m.kugou.com/songlist/<gcid_…>/` ⇒ 200 / **31,443B** / `text/html`，
//      `window.$output` 从第 1,275 字节起，**配平后的那段字面量 24,661B 是严格 JSON**（可直接 JSON.parse）；
//   ② **UA 决定这一页给不给**：不带 UA 或带桌面 UA ⇒ **302 到 `www.kugou.com/songlist/<token>/?`**，
//      那一页 16,879B、title「酷狗音乐-就是歌多」，**没有 $output、没有曲目、没有任何 collection id**
//      ⇒ 桌面那条路是空的。所以这里必须发一个手机 UA（上一批"UA 不影响"的结论只在三种手机 UA 之间成立，
//      本条把它补全并纠正）。这不是设备指纹、也不是 `register_dev`：只是一个请求头，
//      与本项目对"伪装设备身份"那条授权无关（AGENTS.md 的例外条目仍然零调用）。
//   ③ 无效 token（`gcid_zzz…`）⇒ 200 / **6,783B** / `window.$output ={};` ⇒ **空对象**，
//      不是 404、没有任何标记说"这单不存在" ⇒ 判据只能是"读不出 info"，并给一句实话；
//      形状不对的 token（`not-a-token`）⇒ 200 但**正文 0 字节** ⇒ 所以在出网**之前**先按形状拒掉。
//   ④ `songlist.kugou.com/<token>/` ⇒ 404；`list.kugou.com/songlist/<token>/` ⇒ 连不上；
//      `activity.kugou.com/share/v-<去前缀 token>/index.html` ⇒ 404（R155 那条短链的 Location 是另一种形态，
//      我们从不对它发请求）⇒ 主机表里只有 `m.kugou.com` 一个名字。
//
// 三条纪律：
//   · **地址由 token 拼出来，不请求用户贴进来的那条 URL**：用户给什么主机/路径都不作数，
//     只有匹配 `gcid_[\w-]{4,60}` 的那一段被取出来拼进固定模板 ⇒ 这一路没有"拿外部地址去请求"的能力；
//   · **字段白名单**：`listinfo` 里挂着 `list_create_userid`（实测 10 位数字）、`list_create_username`、
//     `create_user_pic`（http 头像）这些**真人身份**，`pic` 是第三方图片地址 ⇒ 一律不出这个函数、
//     不落盘、不进回执（与 R105/R112/R138 同一条红线，逐条断言钉住）；
//   · **只取首屏就只说首屏**：`count` 是整单总数（实测 898），我们拿到的是 10 条 ⇒
//     回执与文件注释都要说"共 898 条，分享页只给首屏 10 条，整单这一族链接读不到"，
//     不许让它看起来像"这张单只有 10 首"。
import { guardedSharePageFetch, KUGOU_SHARE_UA } from './online-guard.mjs';
import { kugouSongsToItems } from './bridge/providers/playlist.mjs';

/** 手机分享链接里那段 token 的形状（实测样本 14 位；给到 4~60 是余量，不是放宽——别的形状根本不出去）。 */
export const KUGOU_SHARE_TOKEN = /^gcid_[\w-]{4,60}$/;
/** 由 token 拼出的固定地址（**唯一**的出网 URL 来源）。 */
export function kugouShareUrlFor(token) {
  const clean = String(token ?? '').trim();
  if (!KUGOU_SHARE_TOKEN.test(clean)) return null;
  return `https://m.kugou.com/songlist/${clean}/`;
}

/**
 * 从 HTML 里把 `window.$output` 那段字面量取出来并解析。
 * 为什么不是"取到行尾再 JSON.parse"：实测那一行是
 * `window.$output = {…}; </script><script>window.$output=window.$output||{}</script><script>function …`
 * ⇒ 整行 parse 必然在配平处之后报错（实测位置 24661）。所以按**括号配平 + 字符串状态**切，
 * 切完的那一段才是 JSON。任何一步不成立都返回 null（不抛：这是外部内容，抛出去就变成"通道坏了"）。
 */
export function extractShareOutput(html) {
  const text = String(html ?? '');
  const at = text.indexOf('window.$output');
  if (at < 0) return null;
  const open = text.indexOf('{', at);
  if (open < 0 || open - at > 64) return null;            // `window.$output` 与 `{` 之间只允许一个赋值号与空白
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = open; index < text.length; index += 1) {
    const char = text[index];
    if (inString) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') inString = true;
    else if (char === '{') depth += 1;
    else if (char === '}') {
      depth -= 1;
      if (depth === 0) {
        try { return JSON.parse(text.slice(open, index + 1)) ?? null } catch { return null }
      }
    }
  }
  return null;                                            // 括号不配平：模板被改过或正文被截断
}

/** 只在"整串以 歌手列表 + ' - ' 开头"时剥掉那一截（与 `kugouSongsToItems` 同一条判据，这里不重写第二套）。 */
const READABLE_REJECTIONS = [
  [(output) => output.is_pri === 1, '这张歌单是私有的，分享页读不到内容'],
  [(output) => output.is_drop === 1, '这张歌单已被删除'],
  [(output) => output.is_publish === 0, '这张歌单未发布，分享页读不到内容'],
];

/**
 * `$output` → 可导入的那几样。**这个函数就是字段白名单本身**：
 * 返回的对象里只可能出现 `name / count / items / reason / flags`，别的键（真人身份、头像、热度、
 * 第三方图片地址、`trans_param`）在这里就被丢掉，测试再用 canary 逐条钉住。
 */
export function kugouShareToImport(output) {
  if (!output || typeof output !== 'object') return { ok: false, reason: '分享页里没有可读的歌单数据（token 无效、单已删除，或上游改了页面模板）' };
  const info = output.info && typeof output.info === 'object' ? output.info : null;
  const listinfo = info?.listinfo && typeof info.listinfo === 'object' ? info.listinfo : null;
  if (!info && Object.keys(output).length === 0) {
    return { ok: false, reason: '分享页给的是一个空对象（实测无效 token 就是这个形状：HTTP 200、6,783B、`$output = {}`），本机认不出这张歌单' };
  }
  if (!listinfo) return { ok: false, reason: '分享页里没有歌单信息那一格，本机读不到内容（上游改了页面模板时会走到这里）' };
  for (const [test, reason] of READABLE_REJECTIONS) {
    if (test(listinfo)) return { ok: false, reason: `${reason}（分享页标记 is_pri/is_drop/is_publish 逐条读出来的）`, flags: listinfo };
  }
  const items = kugouSongsToItems(info.songs);
  if (items === null) return { ok: false, reason: '分享页里没有 songs 那一格（不是"空的"，是"没给"）——本机不猜' };
  return {
    ok: true,
    name: String(listinfo.name ?? '').trim(),
    count: Number(listinfo.count ?? 0) || 0,
    items,
    // 整单读不到的那条事实要带出去（界面与文件注释都用它）：这一族分享链接里
    // `global_collection_id` 是**空串**（实测两处都空），所以没有第二条路可走。
    wholeListReadable: String(listinfo.global_collection_id ?? '').trim().length > 0,
    collectionId: String(listinfo.global_collection_id ?? '').trim(),
  };
}

/**
 * 建一个分享页门面。`fetchHtml` 是可注入的取页函数（离线自检喂字符串）；
 * 真机上固定用全仓唯一出网点 `guardedSharePageFetch`（协议 / 主机表 / SSRF / 体积 / 超时 / 不带凭据六道都在里面）。
 */
export function createKugouShareSource({ fetchHtml = null } = {}) {
  const fetchPage = fetchHtml ?? (async (url) => {
    const response = await guardedSharePageFetch(url, { headers: { 'user-agent': KUGOU_SHARE_UA, accept: 'text/html' } });
    return { status: response.status, text: response.ok ? String(response.text() ?? '') : '' };
  });
  return {
    /** 返回 `{ok:true, token, name, count, items, wholeListReadable}` 或 `{ok:false, reason, retryable}`。 */
    async load(token) {
      const url = kugouShareUrlFor(token);
      if (!url) return { ok: false, retryable: false, reason: '酷狗手机分享的 token 形状不对（应为 `gcid_` 开头 4~60 位字母数字下划线短横）——这一条不出网' };
      let page;
      try {
        page = await fetchPage(url);
      } catch (error) {
        // 通道坏与"这张单读不到"是两件事：这里只报前者，且**不许**把它翻成"歌单是空的"。
        return { ok: false, retryable: true, reason: `读分享页失败：${error?.message ?? error}` };
      }
      if (!page || page.status < 200 || page.status >= 300) {
        return { ok: false, retryable: page?.status === 302, reason: `分享页回了 HTTP ${page?.status ?? 0}（本机不自动跟随重定向，302 意味着这一页只在手机 UA 下给数据）` };
      }
      const mapped = kugouShareToImport(extractShareOutput(page.text));
      if (!mapped.ok) return { ...mapped, retryable: false };
      return { ...mapped, token, retryable: false };
    },
  };
}
