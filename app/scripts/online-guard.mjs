// 本项目自撰（非移植代码）。**全仓唯一的出网点**，落实 memory/metadata-strategy.md 的安全验收条件：
//   ① 服务端请求仅 https（比"仅 http/https"更严；foobar 那条本机 HTTP 代理不在本文件的管辖内）；
//   ② 发请求前校验 host（编译期固定的**按用途分组**的主机白名单，不接受用户输入的主机名）；
//   ③ 拒绝环回 / 私有 / 链路本地 / 组播 / 保留 / 测试网 / 非法地址；
//   ④ 禁重定向（3xx 会把上面的校验旁路掉）、限响应体积、限超时、不带凭据。
// 两个出口共用 ①②③ 那一份预检（precheckTarget）：`guardedFetch` 读进内存并卡体积，
// `guardedStreamFetch`（Task 6 音源串流）只放开"不整读、不卡体积"这一条，其余一条不少。
// 任何在线代码都不得绕开这两个出口自己 fetch（含 2026-10-04 起并入的 MusicBrainz / 维基百科 /
// Wikidata 资料补全：联网功能默认打开后，这条从"歌词专用"升级为"全仓出网共用"）。
import net from 'node:net';
import dns from 'node:dns/promises';
import { recordEgress } from './online-audit.mjs';

/** 歌词源。方案 B 引入"用户自配 API base"时，必须同时升级为连接期同址校验
 *  （node:https.request({ lookup })），因为那时主机名不再可控。见第四期计划第 5.6 节。 */
export const LYRICS_HOSTS = new Set(['u.y.qq.com', 'amll-ttml-db.stevexmh.net']);
/** 专辑资料源（MusicBrainz 补全 + 维基百科导言 + Wikidata 实体）。 */
export const METADATA_HOSTS = new Set(['musicbrainz.org', 'zh.wikipedia.org', 'en.wikipedia.org', 'www.wikidata.org']);
/** 介绍来源自己的第二道闸（比传输白名单更窄：这个模块只该碰百科，不该碰 musicbrainz.org）。 */
export const INTRODUCTION_HOSTS = new Set(['zh.wikipedia.org', 'en.wikipedia.org', 'www.wikidata.org']);
/**
 * 音源 CDN 主机（第五期 Task 6）。这张表里**每一个名字都是 2026-10-05 一手实测换来的**，
 * 方案初稿猜的 .mzstatic.com / .kuwo.cn / .kugou.com 三条今天没有任何实测主机落进去，所以不在表里：
 *   · 网易：`/song/url?id=` 给的是 `http://m<数字>.music.126.net/….mp3`（实测 m702、m802）⇒ 只能按后缀收；
 *   · QQ：匿名 `vkey.GetVkeyServer/CgiGetVkey` 的 sip 给了 `aqqmusic.tc.qq.com` 与 `sjy6.stream.qqmusic.qq.com`
 *     （包内兜底常量还有 `dl.stream.qqmusic.qq.com`）⇒ 前者不落在任何统一后缀下，进精确表；后者按后缀收。
 * 两条实测细节直接决定了这里为什么必须分两张子表：
 * ① 同主机换成 https 都能通（网易 200/206 全对，QQ 206 + content-range）⇒ 不必为音源放开明文；
 * ② QQ 的 sip 可能不带 scheme、也不带结尾斜杠，而 purl 不带开头斜杠 ⇒ 拼接归取址层管（online-audio-source.mjs）。
 *
 * **2026-10-10 加进来的第三个名字（R154 · 任务一，酷狗）**：`fsandroid.kugou.com`。
 * 一手实测（探针逐条量过）：`/v5/url` 的 `url` 数组给的是**同一族的两条**，而这一族**会随时间漂**：
 * 同一天里两次分别量到 `fsandroid.kugou.com` + `fsmobile.tx.kugou.com`（**升 https 真取到 206**，
 * `content-range: bytes 0-4095/<与 fileSize 逐位相等的总长>`）与
 * `fs.youthandroid2.kugou.com` + `fs.youthandroid.kugou.com`（**升 https 直接 TLS 证书名不匹配**
 * `ERR_TLS_CERT_ALTNAME_INVALID`，13 首免费曲全部如此）。
 * ⇒ 表里只收**实测 https 可用**的那一条名字；youth 那一族**故意不收**：
 * 收了也播不了（协议判据在前面挡着），收进来只是给"哪天想放开明文"预留通行证。
 * 上游只给明文主机时由取址层给一句真原因（`online-audio-source.mjs` 的 `kugouAudioFrom`）并标成
 * `unavailable`，让 R141 的回落去试另一家——**"不为音频放开明文"这一条没动，也不在本批动**。
 * 上游给的都是 **http** ⇒ 走既有的"升 https 再过守卫"，与网易/QQ 同一条老规矩。
 * 后缀表**不加** `.kugou.com`：那张表会连 `userservice.kugou.com`（设备注册）与
 * `gateway.kugou.com`（包签名请求的入口）一起放进来，而这两条都不是音频主机。
 *
 * **2026-10-14 加进来的两个名字（R221 · 酷狗网页档）**：`sharefs.kugou.com` 与 `sharefs.tx.kugou.com`。
 * 它们是**公开网页取址那一跳**（`m.kugou.com/app/i/getSongInfo.php?cmd=playInfo`）给的主机，一手实测：
 * 两条都 **TLS 握手成功（TLSv1.3）**，且同一份文件 **`Range: bytes=0-4095` ⇒ HTTP 206 +
 * `content-range` 总长 4112408B，与响应的 `fileSize` 逐位相等**（探针只在内存里读头，字节随即丢弃、没落盘）——
 * 与安卓那两台 `fs.youthandroid*`（升 https 直接 `ERR_TLS_CERT_ALTNAME_INVALID`）是两类主机。
 * 这一族**上游回的就是 https**（不像安卓那档回的是 http 要我们升），所以"不为音频放开明文"照旧成立。
 */
export const AUDIO_HOSTS = {
  exact: new Set(['aqqmusic.tc.qq.com', 'fsandroid.kugou.com', 'sharefs.kugou.com', 'sharefs.tx.kugou.com']),
  suffix: ['.music.126.net', '.stream.qqmusic.qq.com'],
};
/** 默认按歌词用途收口：歌词模块拿不到资料主机，资料模块也拿不到歌词主机。 */
export const ONLINE_HOSTS = LYRICS_HOSTS;
/**
 * 登录通道的主机表（M3-a Task A 造闸、Task D 按实测填）。
 * **今天这两个名字都是一手实测换来的**（2026-10-07 探针，跑的是包自己 `/serverless` 那一条路）：
 *   · `api.tencentmusic.com/tme/trpc/proxy` —— QIMEI / 设备引导（`androidDevice` 那一族）；
 *   · `u.y.qq.com/cgi-bin/musicu.fcg` —— 二维码创建与轮询的 trpc 通道。
 * `mu.y.qq.com` **不在**这张表里：它是 MQTT 的 WSS 端点，不是 https 请求，`assertAllowedTarget` 管不到它，
 * 由桥内的 relay 包装单独记一档 `auth-mqtt`（设计稿 §6.3）。
 * 后缀表留空是硬要求：`*.qq.com` 会把任意腾讯子域收进来，等于没有白名单。
 * 再加名字的规矩不变：**先被 `ONLINE_TARGET_REJECTED` 挡下来、核实它确实是该家的登录端点，再填**。
 */
export const AUTH_HOSTS = { exact: new Set(['api.tencentmusic.com', 'u.y.qq.com']), suffix: [] };
/**
 * 封面补全的主机表（M3-c）。**这张表里每个名字同样是一手实测换来的**：
 *   · `itunes.apple.com` —— iTunes Search 直连 200（响应 `content-type: text/javascript` 但正文是 JSON），
 *     12 连发无间隔全部 200，没观察到限流（2026-10-07 凌晨探针）；
 *   · `.mzstatic.com`（后缀）—— 图片本体在 `is1-ssl.mzstatic.com`，换 `is2-ssl` 同样 200 ⇒ 只能按后缀收，
 *     而且**全程不重定向**（`redirected=false`），`redirect:'error'` 这条对它不需要例外；
 *   · `archive.org` —— Cover Art Archive 的图**不在** coverartarchive.org 上。
 *     2026-10-07「CAA 窗口」（TUN 生效后本机可直连）把这条链完整走了一遍：
 *       `coverartarchive.org/release/<MBID>` →(307) `archive.org/download/mbid-<MBID>/index.json`
 *                                            →(302) `dn<数字>.ca.archive.org/…/index.json`（动态数据节点）
 *       `archive.org/download/` 与 `/serve/` **都会 302 到节点**（节点名每次都变，绝不能进白名单）；
 *       `archive.org/cors/<条目>/<文件>` 实测**直接 200、一次都不重定向**（4 个 release 逐条验过）
 *       ⇒ 我们只打 `/cors/`，所以**这一档不需要新主机**：表里仍旧只有 `archive.org`。
 *     而**不放** `coverartarchive.org`：我们的代码里没有一次请求打它（目录名由 `online.releaseId` 自己拼），
 *     白名单里留一个没人打的名字只是攻击面。
 * 目录名按 release MBID 拼的出处：跟一跳去看那个 MBID，它在 MusicBrainz 里**不是 release-group**（404），
 * 而是该组的 **release**（`/ws/2/release/1e45a5f1-…` 200，其 release-group 正是我们手上那个）。
 */
export const COVER_HOSTS = { exact: new Set(['itunes.apple.com', 'archive.org']), suffix: ['.mzstatic.com'] };
/**
 * 在线曲目封面的主机表（看板 ⑨ 范围追加）。**每个名字都是 2026-10-07 一手实测换来的**，
 * 与专辑封面补全那张表**分开两张**——用途不同（一张是"给没有封面的专辑补图"，
 * 一张是"给搜索结果与正在播放的在线曲目取图"），合一张就等于让补全那一路也能打 CDN。
 *   · 网易 `al.picUrl` 实测只出现 `p3` / `p4`（41 条样本），但把同一张图的路径换到
 *     `p1` / `p2` 也是 **200、字节数逐位相同**（120,660B），`p5` / `p6` 是 **404** ⇒ 收 p1–p4 四个 exact；
 *     上游给的是 **`http://`**，实测升 https 同样 200 且同一张图 ⇒ 一律升 https 再放行（与 R112 那条头像同源的老规矩）。
 *     **不用 `.music.126.net` 后缀**：这张表只服务封面，后缀会把 `m<数字>.music.126.net`（音源那一路）也放进来。
 *   · QQ 的搜索响应**不给 URL，只给 `album.mid`**（实测 `000MkMni19ClKG`），
 *     封面地址由我们自己按形状拼：`https://y.gtimg.cn/music/photo_new/T002R300x300M000<mid>.jpg`
 *     → 实测 **200 / image/jpeg / 33,448B**；同主机 R500x500 是 81,427B。
 *     试过的其它形状全部落榜：`imgcache.qq.com` 的三种拼法都 **404**，`img.y.gtimg.cn` **ENOTFOUND**。
 * 两家都不重定向（`redirect:'error'` 下直接 200），所以这条链一次 3xx 都不跟。
 */
export const TRACK_COVER_HOSTS = {
  exact: new Set(['p1.music.126.net', 'p2.music.126.net', 'p3.music.126.net', 'p4.music.126.net', 'y.gtimg.cn']),
  suffix: [],
};
/**
 * 分享短链那一跳的主机表（R155 · 任务二，酷狗"口令短链"）。
 * **表里这一个名字是 2026-10-10 一手实测换来的**：`https://t1.kugou.com/<token>` 回 **302**，
 * `Location` 指向 `activity.kugou.com/share/v-xxxx/index.html?...&global_specialid=collection_3_...`。
 * 这张表只管**第一跳**：我们只读那个 `Location` 里的歌单 id，**从不请求它指向的主机**
 * （⇒ `activity.kugou.com` 不进任何表，与 R113 那次"不放 coverartarchive.org 因为一次都不打它"同一条规矩）。
 * 精确表、后缀留空：`*.kugou.com` 会把设备注册与签名网关都放进来，而这两条都不是短链。
 */
export const SHORTLINK_HOSTS = { exact: new Set(['t1.kugou.com']), suffix: [] };
/** 短链一跳的超时：它只是一次重定向查询，不给 20 秒（真机实测这一跳 100~300ms）。 */
export const SHORTLINK_TIMEOUT_MS = 6000;
/**
 * 酷狗**手机分享页**（R158 · 任务五）的主机表。**表里这一个名字是四轮实测换来的，而且是唯一能给出数据的一处**：
 *   · `m.kugou.com/songlist/<gcid_…>/` ⇒ 200 / 31,443B / `text/html`，`window.$output` 里注着首屏十首歌；
 *   · `songlist.kugou.com/<token>/` ⇒ 404；`list.kugou.com/songlist/<token>/` ⇒ 连不上；
 *     `activity.kugou.com/share/v-…/index.html` ⇒ 404（R155 那条短链的 Location 是另一种形态，我们从不请求它）；
 *   · 不带 UA 或带桌面 UA 时 `m.kugou.com` **302 到 `www.kugou.com`**，那一页 16,879B 是通用落地页
 *     （title「酷狗音乐-就是歌多」，无 `$output`、无曲目、无 collection id）⇒ 桌面那条路是空的，
 *     所以 `www.kugou.com` **不进表**（我们一次都不请求它），而请求必须带手机 UA（见下面那个常量）。
 * 精确表、后缀留空：`*.kugou.com` 会把设备注册与签名网关都放进来。
 * 用户批准范围（看板"拍板批"第 4 条）：本件 = 新增这一台主机 + 一个 HTML 解析面。
 */
export const SHARE_HOSTS = { exact: new Set(['m.kugou.com']), suffix: [] };
/** 分享页体积上限：实测有效页 31,443B、无效 token 页 6,783B ⇒ 2 MiB 已是几十倍余量（这一页只给首屏十首）。 */
export const MAX_SHARE_BODY_BYTES = 2 * 1024 * 1024;
/** 分享页超时：真机实测这一页几百毫秒就回，给 8 秒（比短链宽、比整单歌单窄）。 */
export const SHARE_TIMEOUT_MS = 8000;
/**
 * 酷狗**网页取址**（R221 · 一·二）的主机表。名字与上面那张 `SHARE_HOSTS` **相同、用途不同**，
 * 所以**另开一张**：两张表共用会让"分享页"那一路白得音频用途的余地、也让本路跟着别人的改动漂
 * （与封面/短链/登录各留一张表是同一条理由）。后缀照旧留空。
 * 一手实测（2026-10-14，探针 `r221-minhdr.mjs`，走的就是本文件这个 `guardedFetch`）：
 * 这一跳**零请求头就回 200**（`status:1 / fileSize:4112408 / url 里是 /yp/full/`），
 * 带 UA、带 Referer 三种写法读数逐字相同 ⇒ 本路**什么都不伪装**：
 * 不设备标识、不 UA、凭据一个字节都不带（`guardedFetch` 固定 `credentials:'omit'`）。
 * 与分享页那一跳的差别：那里不带手机 UA 会 302 到通用落地页，这里没有 UA 协商、也不重定向。
 */
export const KUGOU_PLAYINFO_HOSTS = { exact: new Set(['m.kugou.com']), suffix: [] };
/** 网页取址那一跳的超时：与短链同档（取址一跳不该占长窗口；真机实测这一跳几百毫秒）。 */
export const KUGOU_PLAYINFO_TIMEOUT_MS = 6000;
/**
 * 取这一页必须发的手机 UA。**为什么发**：不发的话上游给的是 302 + 一个没有数据的桌面落地页
 * （上面那段实测）。**它不是什么**：不是设备指纹、不是 `register_dev`、不是伪造 IMEI——
 * 只是一个 `User-Agent` 请求头，作用与 QQ 那一路必须带 `Referer`（R138 实测）同一档。
 * 数出来的形状：iPhone Safari 与微信/安卓三种手机 UA 实测**逐字相同**，所以这里固定发一条。
 */
export const KUGOU_SHARE_UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 '
  + '(KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1';
/**
 * QQ 公开歌单的主机表（R138）。**表里这一个名字是 2026-10-09 三轮实测换来的，而且是唯一的去处**：
 *   · `c.y.qq.com/qzone/fcg-bin/fcg_ucc_getcdinfo_byids_cp.fcg` —— 真实公开歌单 200 / 2,405,719B / 1534 条；
 *   · 表内原有的 `u.y.qq.com` 打不到这条：`/qzone/...` 与 `/cgi-bin/getcdinfo` 都是 **404 page not found**，
 *     而 `music.srfDissInfo.aiDissInfo` 一族在**两种 comm 身份 × 九种参数组合**下全部回 `code:40000`
 *     ——真单与不存在的 id 回同一个码，等于"这个通道不给字段名"（这一条同时纠正 R137 记的归因：
 *     当时把 40000 当成"这张单不存在"，复量证明它连真实公开单也不给）。
 * 后缀表**必须留空**：`.qq.com` 等于把整个腾讯域放进来，那张表就不是闸门了。
 * 规矩照旧：先被 `ONLINE_TARGET_REJECTED` 挡下来、核实它确实是这一家的歌单端点，再填名字。
 */
export const PLAYLIST_HOSTS = new Set(['c.y.qq.com']);
/**
 * 歌单响应的体积上限。这一档**只管体积**：协议、主机白名单、SSRF 地址判据、`redirect:'error'`、
 * 超时、凭据一项都没动，也不与歌词/搜索那两档共用（共用就等于把 512KB 的歌词档撑大）。
 * 数怎么来的：一手实测一张 1534 条的单响应 2,405,719B，而这个端点**认 `song_begin` 不认页大小**
 * （`num` / `offset` / `limit` 全被忽略，一次就是整张单）⇒ 无法靠分页把体积切小，
 * 只能给一张足够容纳"我们本来就只取前 1000 条"的单的额度；8 MiB 约合 5000 条。
 * 超了不是静默少一截：`guardedFetch` 会拦，导入侧把那句"这张单太长，响应超过了本工具的体积上限"报出来。
 */
export const MAX_PLAYLIST_BODY_BYTES = 8 * 1024 * 1024;
/** 歌单一次给整张单（实测 2.4MB / 657~1450ms）⇒ 搜索那 3.5s 档撑不住，给到 20s。 */
export const ONLINE_PLAYLIST_TIMEOUT_MS = 20_000;
/** 封面图体积上限：16 MiB（2026-10-09 由 8 MiB 上调，用户指令）。
 *  为什么调：PNG 魔数那一格修好之后，真实 PNG 第一次走到这一档 —— 实测网易一张 10.1MB 的 PNG 封面
 *  被 8 MiB 拒掉（`detectImageMime` 认了、体积闸又拦了），而它是**罕见离群**且一次入内容寻址缓存、
 *  不重复取。参照：iTunes 600x600=108,696B、1000x1000=338,372B；CAA 扫描原图 134,636~615,670B。
 *  内嵌封面那一路的既有上限是 30MB ⇒ 在线这一路仍比它严，不是比它松。
 *  这一档只管体积：主机白名单、协议、SSRF 地址判据、`redirect:'error'`、超时、凭据一项都没动。 */
export const MAX_COVER_BODY_BYTES = 16 * 1024 * 1024;
/** 封面取图预算：iTunes 侧接口 340–1105ms、图片 147–518ms；CAA 窗口实测 archive.org 首页 4.4s、
 *  `/cors/` 的 index.json 1.1–1.7s、图片 1.7–2.0s（521KB）⇒ 12s 档留得住余量，也仍是"不会干等"的档。 */
export const ONLINE_COVER_TIMEOUT_MS = 12000;
/**
 * 登录通道允许回传的响应头 —— 白名单制，不是"全放行后挑几个用"。
 * 只放 `set-cookie`：扫码登录的终态就载在这里，没有它这条通道不通。
 * 明确不放：`location`（`redirect:'error'` 已经禁掉重定向，回传它等于在代码里留一份"可手动跟随"的
 * 邀请，而跟随目标不在白名单判据内）、`www-authenticate` / `authorization`（本通道不做 Basic/Bearer）、
 * `content-type` / `content-length`（体积闸在内部用掉了，调用方按 text()/json() 取即可，
 * 不必再暴露一份可被上游伪造的头）。
 */
export const AUTH_RESPONSE_HEADERS = Object.freeze(['set-cookie']);
/**
 * 按白名单取响应头。**这张表是闸门，不是注释**：不在表里的名字在这里取不到；
 * 只往表里加名字、没在这里补对应取法，同样取不到（自检的期望字段由这张表推导，
 * 两处不同步就红）。所以"放开一个新头"必须同时改两处，逼一次显式决策。
 */
function allowedResponseHeaders(headers) {
  const out = {};
  if (AUTH_RESPONSE_HEADERS.includes('set-cookie')) out.setCookie = headers.getSetCookie?.() ?? [];
  return out;
}
export const MAX_ONLINE_BODY_BYTES = 512 * 1024;
/** 资料接口单次响应可以远大于一条歌词（MusicBrainz 带 recordings 与 relations 的 release）。 */
export const MAX_METADATA_BODY_BYTES = 4 * 1024 * 1024;
export const ONLINE_TIMEOUT_MS = 5000;
export const ONLINE_SEARCH_TIMEOUT_MS = 3500;
/** 音源首字节的预算：CDN 比接口慢，但也不能让内核干等（实测网易 206 在 300ms 内）。 */
export const ONLINE_STREAM_TIMEOUT_MS = 15000;

/**
 * 主机是否在表里。两种形状都要认（改动只加不减）：歌词/资料两张表是 Set，音源表是 `{exact, suffix}`。
 * 后缀匹配的两个坑都堵上：`h.length > suffix.length` 挡"后缀本身当主机"，
 * 而后缀必须以 `.` 起头这个约定挡"music.126.net"（缺点）与"music.126.net.evil.test"（尾缀伪装）。
 */
export function hostAllowed(host, list) {
  const hostname = String(host ?? '').toLowerCase();
  if (!hostname) return false;
  if (list instanceof Set) return list.has(hostname);
  if (list?.exact?.has(hostname)) return true;
  return (list?.suffix ?? []).some((suffix) => hostname.endsWith(suffix) && hostname.length > suffix.length);
}

/** 拒连的 IPv4 段（CIDR 写法，与 IANA 特殊用途注册表对齐：环回/私有/CGNAT/链路本地/组播/保留/测试网…）。 */
const V4_BLOCKED = [
  '0.0.0.0/8', '10.0.0.0/8', '100.64.0.0/10', '127.0.0.0/8', '169.254.0.0/16', '172.16.0.0/12',
  '192.0.0.0/24', '192.0.2.0/24', '192.88.99.0/32', '192.168.0.0/16', '198.18.0.0/15',
  '198.51.100.0/24', '203.0.113.0/24', '224.0.0.0/4', '240.0.0.0/4',
];

function inV4Cidr(parts, cidr) {
  const [base, bitsText] = cidr.split('/');
  const bits = Number(bitsText);
  const baseParts = base.split('.').map(Number);
  let value = 0;
  let baseValue = 0;
  for (let index = 0; index < 4; index += 1) {
    value = value * 256 + parts[index];
    baseValue = baseValue * 256 + baseParts[index];
  }
  const shift = 32 - bits;
  return (value >>> shift) === (baseValue >>> shift);
}

/** IPv6 展开成 8 组十六进制串；写法非法（多组 ::、组数不符）返回 null。 */
function v6Groups(ip) {
  const halves = ip.split('::');
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(':') : [];
  if (halves.length === 1) return head.length === 8 ? head : null;
  const tail = halves[1] ? halves[1].split(':') : [];
  const missing = 8 - head.length - tail.length;
  if (missing < 0) return null;
  return [...head, ...new Array(missing).fill('0'), ...tail];
}

/** true = 环回 / 私有 / 链路本地 / 站点本地 / 组播 / 保留 / 测试网 / 非法，一律不许连。 */
export function isBlockedAddress(ip) {
  const text = String(ip ?? '');
  const kind = net.isIP(text);
  if (kind === 4) {
    const parts = text.split('.').map(Number);
    if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return true;
    return V4_BLOCKED.some((cidr) => inV4Cidr(parts, cidr));
  }
  if (kind === 6) {
    // 内嵌 IPv4（::ffff:127.0.0.1 之类）先按 IPv4 判一遍
    const embedded = /:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/i.exec(text);
    if (embedded && net.isIP(embedded[1]) === 4 && isBlockedAddress(embedded[1])) return true;
    const groups = v6Groups(text.toLowerCase());
    if (!groups) return true;
    if (groups.some((group) => !/^[0-9a-f]{1,4}$/.test(group))) return true;
    const values = groups.map((group) => parseInt(group, 16));
    const first = values[0];
    if (values.every((value) => value === 0)) return true;                                              // :: 未指定
    if (first === 0 && values.slice(1, 7).every((value) => value === 0) && values[7] === 1) return true;  // ::1 环回
    if ((first & 0xfe00) === 0xfc00) return true;                                                          // fc00::/7 唯一本地
    if ((first & 0xffc0) === 0xfe80) return true;                                                           // fe80::/10 链路本地
    if ((first & 0xff00) === 0xff00) return true;                                                           // ff00::/8 组播
    if (first === 0x0100 && values[1] === 0) return true;                                                    // 100::/64 丢弃
    if (first === 0x2001 && values[1] === 0x0db8) return true;                                               // 2001:db8::/32 文档
    return false;
  }
  return true;   // 既不是 IPv4 也不是 IPv6 = 非法，拒
}

export class OnlineTargetError extends Error {
  constructor(reason) {
    super(`ONLINE_TARGET_REJECTED: ${reason}`);
    this.name = 'OnlineTargetError';
    this.reason = reason;
  }
}

/** 出网层的机器标识符：只该出现在日志、审计与自检里，**绝不该出现在给界面的 reason 里**。 */
export const EGRESS_REJECT_MARKER = 'ONLINE_TARGET_REJECTED';

/**
 * 机器句子 → 人话。顺序有意义：先具体后一般。
 * 每条都**不写结论词**（"被拒绝/不安全"这类判断留给界面），只说这一跳为什么没出去；
 * 主机名不在这里回显——那张表在出网审计里，用户看得到， reason 里再塞一个上游字符串没好处。
 */
const EGRESS_REASON_TEXT = [
  [/只允许 https/, '该地址的协议不受支持：本播放器只走 https'],
  [/URL 无法解析/, '那个地址的格式认不出来，没有向它发请求'],
  [/不得携带凭据/, '那个地址里带着凭据，本机不会向它发请求'],
  [/不得使用 IP 字面量/, '那个地址直接写着 IP 而不是主机名，本机不向它发请求'],
  [/只走默认端口/, '那个地址带着非默认端口，本机不向它发请求'],
  [/主机不在本次用途的在线白名单/, '那个主机不在本机允许的出网清单里'],
  [/解析到受限地址/, '那个主机解析到了一个本机不允许访问的地址'],
  [/DNS 解析失败/, '那个主机名没能解析成地址'],
  [/DNS 无解析结果/, '那个主机名没有解析到地址'],
];

/**
 * 发给界面之前把出网层的内部码翻成人话（P0：`ONLINE_TARGET_REJECTED: …收到 http:`
 * 曾经原样出现在 audio-scope 与搜索的响应里，用户看到的是我们自己的标识符）。
 * **认不出来的原样返回**——这一层只负责"不泄露内部码"，不负责把别的原因改写成一句通用话，
 * 那样会把"平台确实没有这首歌"说成"通道坏了"。
 */
export function publicEgressReason(value) {
  const text = String(value ?? '');
  if (!text) return text;
  const known = EGRESS_REASON_TEXT.find(([pattern]) => pattern.test(text));
  if (known) return known[1];
  return text.includes(EGRESS_REJECT_MARKER)
    ? text.replaceAll(`${EGRESS_REJECT_MARKER}:`, '').replaceAll(EGRESS_REJECT_MARKER, '').trim()
    : text;
}

/**
 * 响应体里的 `reason` / `error` 两格过一遍上面那一层。只碰这两个键、只碰字符串，
 * 其余逐字不动（出网审计那些行不走这里，见 music-server 里 `via` 那两条分叉的注释）。
 */
export function sanitizeEgressReasons(value, depth = 0) {
  if (depth > 4) return value;
  if (Array.isArray(value)) return value.map((entry) => sanitizeEgressReasons(entry, depth + 1));
  if (!value || typeof value !== 'object') return value;
  const next = {};
  for (const [key, entry] of Object.entries(value)) {
    next[key] = (key === 'reason' || key === 'error') && typeof entry === 'string'
      ? publicEgressReason(entry)
      : sanitizeEgressReasons(entry, depth + 1);
  }
  return next;
}

/** 发请求前的静态校验：协议 + 按用途的主机白名单 + 无凭据 + 无 IP 字面量 + 只走默认端口。 */
export function assertAllowedTarget(rawUrl, hosts = ONLINE_HOSTS) {
  let url;
  try {
    url = new URL(String(rawUrl));
  } catch {
    throw new OnlineTargetError('URL 无法解析');
  }
  if (url.protocol !== 'https:') throw new OnlineTargetError(`在线请求只允许 https，收到 ${url.protocol}`);
  if (url.username || url.password) throw new OnlineTargetError('URL 不得携带凭据');
  if (net.isIP(url.hostname)) throw new OnlineTargetError('不得使用 IP 字面量');
  if (!hostAllowed(url.hostname, hosts)) throw new OnlineTargetError(`主机不在本次用途的在线白名单：${url.hostname}`);
  if (url.port) throw new OnlineTargetError('白名单服务只走默认端口');
  return url;
}

/** 默认的资源解析：真机上就是 node:dns/promises。自检注入时，返回的地址仍会逐个过 isBlockedAddress。 */
const defaultLookup = (hostname) => dns.lookup(hostname, { all: true, verbatim: true });

/**
 * 出网前的共用预检（Task 6 起 guardedFetch 与 guardedStreamFetch 都走这一份）：
 * 静态校验 → DNS 预解析 → 逐个地址类别判定，**被拦下都要先记进审计再抛**（R75：只记成功那几笔
 * 等于把审计做成广告）。抽成一个函数不是为了少写几行，是为了让两个入口的安全面没法各自漂移——
 * 自检里钉着"两处都必须调用它"。DNS 重绑定窗口那一条如实登记在 guardedFetch 的注释里。
 */
async function precheckTarget(rawUrl, hosts, kind, started, lookup = defaultLookup) {
  // 记一笔被拦下：主机名尽量从原始 URL 里取；取不到也要留下这一笔（被拦下同样是要让用户看到的事实）。
  const rejected = (label, info = {}) => {
    let hostname = '';
    try { hostname = new URL(String(rawUrl)).hostname } catch { /* URL 本身就解析不了：主机留空，仍记这一笔 */ }
    return rejectTarget(hostname, kind, started, label, info);
  };
  let url;
  try {
    url = assertAllowedTarget(rawUrl, hosts);
  } catch (error) {
    // 取 `.reason` 而不是 `.message`：message 里已经带着一层 `ONLINE_TARGET_REJECTED:` 前缀，
    // 拿它当 label 再抛一次就变成"前缀出现两次"（P0 现场那条响应里就是这样，看着像有两层守卫在打架）。
    // 记账与抛错的内容不变，只是不再重复带自家标识符。
    rejected(error?.reason ?? error?.message ?? String(error));
  }
  let records;
  try {
    records = await lookup(url.hostname);
  } catch (error) {
    rejected(`DNS 解析失败：${error?.message ?? error}`);
  }
  if (!records.length) rejected('DNS 无解析结果');
  for (const record of records) {
    if (isBlockedAddress(record.address)) rejected(`目标解析到受限地址 ${record.address}`);
  }
  return url;
}

/** 拦下一笔并记账：label 进错误文案，字节数与状态按调用点已知的部分填。 */
function rejectTarget(host, kind, started, label, info = {}) {
  recordEgress({ host, kind, status: info.status ?? 0, bytes: info.bytes ?? 0, ms: Date.now() - started, via: 'guard' });
  throw new OnlineTargetError(label);
}

/**
 * 唯一出网函数：静态校验 → DNS 预解析并逐个判类别 → fetch（禁重定向 / 不带凭据 / 不缓存 / 超时）
 * → 流式读取并卡体积上限。返回形状与"注入的假 fetcher"完全一致，便于离线单测。
 * 残余风险如实登记：先解析再 fetch 之间存在理论上的 DNS 重绑定窗口；本期主机名编译期固定，
 * 窗口不可被用户操纵，方案 B 引入用户可配 base 时必须换成连接期 lookup 校验（计划第 5.6 节）。
 *
 * 每一笔都进审计（R75，见 online-audit.mjs）：**成功与被拦下都要记**——联网默认打开之后，
 * "我们只打了该打的地方"是对用户的承诺，只记成功的那几笔等于把审计做成广告。
 * 记的字段里没有 URL、没有查询串、没有请求头（那张表会显示在设置面板里，而面板可能被截图）。
 *
 * `lookup` 是为离线自检开的注入口（真机上这里要真的解析 DNS）：注入进去的地址结果仍然逐个过
 * `isBlockedAddress`，所以它只是"少一次网络往返"，不是"少一道检查"。生产调用点一律不传。
 */
export async function guardedFetch(rawUrl, { method = 'GET', headers = {}, body, hosts = ONLINE_HOSTS, timeoutMs = ONLINE_TIMEOUT_MS, maxBytes = MAX_ONLINE_BODY_BYTES, kind = 'unknown', lookup = defaultLookup, withSetCookie = false, withBytes = false, readRedirectLocation = false, fetcher } = {}) {
  const started = Date.now();
  const url = await precheckTarget(rawUrl, hosts, kind, started, lookup);
  // `fetcher` 只有一个用途：桥内的 QQ 适配器（providers/qq-auth.mjs）在**替换了 globalThis.fetch 的作用域里**
  // 调本函数，若这里仍解析全局槽位就是自己调自己（无限递归）。所以由调用方把"换掉之前那份 fetch"传进来。
  // 安全面没有因此变宽：预检在调用它之前，体积闸与审计在调用它之后，三道都在本函数里。
  const callFetch = fetcher ?? ((target, init) => globalThis.fetch(target, init));
  let response;
  let size = 0;
  const chunks = [];
  try {
    response = await callFetch(url, {
      method,
      headers: { ...headers },
      body,
      // **默认仍然 `error`**：判据④"禁重定向"的原意是"3xx 会把上面三道校验旁路掉"，这一条对所有既有调用点不变。
      // `readRedirectLocation` 是显式表过态的那一条（实测 Node 的 `manual` 给 302 + `location` 头，
      // 而 `follow` 才是我们不要的"自动去一个没校验过的地方"）：这里**只读头、不发第二跳**，
      // 目标主机要不要请求由调用方自己再过一遍本文件的预检 ⇒ 三道校验一道都没少。
      redirect: readRedirectLocation ? 'manual' : 'error',
      credentials: 'omit',
      cache: 'no-store',
      signal: AbortSignal.timeout(timeoutMs),
    });
    const declared = Number(response.headers.get('content-length') ?? 0);
    if (declared > maxBytes) rejectTarget(url.hostname, kind, started, `声明体积 ${declared} 超过上限 ${maxBytes}`, { status: response.status });
    if (response.body) {
      for await (const chunk of response.body) {
        size += chunk.byteLength ?? chunk.length ?? 0;
        if (size > maxBytes) {
          void response.body.cancel();
          rejectTarget(url.hostname, kind, started, `响应体超过上限 ${maxBytes}`, { status: response.status, bytes: size });
        }
        chunks.push(Buffer.from(chunk));
      }
    }
  } catch (error) {
    if (error instanceof OnlineTargetError) throw error;               // 上面已经记过了
    recordEgress({ host: url.hostname, kind, status: response?.status ?? 0, bytes: size, ms: Date.now() - started, via: 'guard' });
    throw error;                                                       // 网络层失败照原样抛：调用方的降级逻辑依赖它
  }
  const text = Buffer.concat(chunks).toString('utf8');
  recordEgress({ host: url.hostname, kind, status: response.status, bytes: size, ms: Date.now() - started, via: 'guard' });
  return {
    ok: response.ok, status: response.status,
    text: () => text, json: () => JSON.parse(text),
    // 二进制响应（封面图）唯一的取字节出口（M3-c）。默认**不给**这个字段，与 `withSetCookie` 同一惯例：
    // 老调用点的返回形状逐字不变（自检钉着默认键集），要拿图必须显式表一次态。
    // 这里给的是已经过体积闸读进内存的那一份，不是第三条读法——不存在"绕过 maxBytes 拿全量"的路径。
    ...(withBytes ? { bytes: () => Buffer.concat(chunks) } : {}),
    // 只有显式开了开关才多这些字段（不是"存在但为空"）：老调用点的返回形状逐字不变。
    // 值原样保留（含 Path/HttpOnly/Max-Age）——归一化是 jar 合并那一步的事（设计稿 §5.3），
    // 在这一层解析属性会把上游的作用域语义改坏。
    ...(withSetCookie ? allowedResponseHeaders(response.headers) : {}),
    // 短链那一跳专用的取头口（R155 · 任务二）。三条讲究：
    //   · **显式要才有**（与 `withBytes`/`withSetCookie` 同一惯例，老调用点返回形状逐字不变）；
    //   · **只在真的是 3xx 时给**（2xx 给空串会被读成"上游说没有"，与"这一档不是重定向"是两件事）；
    //   · 给出去的是**一条未经本机校验的外部地址**，所以它的唯一合法用途是"从里面解析出一个 id"——
    //     拿它再去请求就是绕过本文件的预检（导入器只取 id，且这条地址**绝不出服务端**，有断言钉）。
    ...(readRedirectLocation && response.status >= 300 && response.status < 400
      ? { redirectLocation: response.headers.get('location') ?? '' }
      : {}),
  };
}

/**
 * 短链一跳的适配器（R155）。与资料/封面那两路同一实现，只换主机表、超时与审计 kind，
 * 并把 `readRedirectLocation` 打开——**这一跳的目的就是读 Location，不是读正文**。
 * kind 固定 `playlist`：审计面板上那一行本来就是"歌单"，用户要看的是"打了谁"，不是我们的内部分类。
 */
export function guardedShortLinkFetch(url, { headers = {}, lookup = defaultLookup } = {}) {
  return guardedFetch(url, {
    headers, hosts: SHORTLINK_HOSTS, timeoutMs: SHORTLINK_TIMEOUT_MS, kind: 'playlist',
    readRedirectLocation: true, lookup,
  });
}

/**
 * 手机分享页那一跳（R158）：与短链同一实现，只换主机表、体积档、超时，并且**不读 Location**
 * （这一跳要的是正文里那段 SSR 注入的 JSON）。kind 固定 `playlist`：审计面板上那一行本来就是"歌单"。
 * 六道判据一道没少：https-only、主机精确表、SSRF 地址判据、体积上限、`redirect:'error'`、`credentials:'omit'`。
 */
export function guardedSharePageFetch(url, { headers = {}, lookup = defaultLookup } = {}) {
  return guardedFetch(url, {
    headers, hosts: SHARE_HOSTS, timeoutMs: SHARE_TIMEOUT_MS, maxBytes: MAX_SHARE_BODY_BYTES, kind: 'playlist', lookup,
  });
}

/**
 * 资料侧（MusicBrainz 补全 / 维基百科导言 / Wikidata 实体）的出网适配器：走的还是 guardedFetch，
 * 只把主机集合换成 METADATA_HOSTS、体积上限换成资料档位。调用形状保留两个消费点原有的
 * `(url, init)`，差别在 init 收的是 `{ headers, timeoutMs }` 而不是 `{ headers, signal, redirect }`
 * —— 超时与禁重定向由 guardedFetch 统一负责，不让每个调用点自己挂 AbortSignal。
 * 自检注入假 fetcher 的既有用法不受影响（两个消费点的 fetcher 一直是可注入参数）。
 */
export function guardedMetadataFetch(url, { headers = {}, body, timeoutMs = 15000, kind = 'metadata' } = {}) {
  return guardedFetch(url, { headers, body, hosts: METADATA_HOSTS, timeoutMs, maxBytes: MAX_METADATA_BODY_BYTES, kind });
}

/**
 * 封面侧适配器（M3-c）：与资料侧同一实现，只换主机表、体积档、超时与审计 kind。
 * kind 固定成 'cover'（调用点不许自己改）——审计面板上那一行中文名就靠这个键，
 * 让它能被别的用途冒充就等于"用户能看到打了谁"打了折。
 *
 * `lookup` 必须一起转发：本层的自检全靠注入它来做到"零真实 DNS"（见 check-music-covers.mjs）。
 * 漏转发过一次的代价是真实的——那时自检看着是离线跑的，其实偷偷在打真 DNS，
 * 于是环境一变（例如本机开着 fake-IP 代理、域名解析到 198.18.0.0/15 这种保留段）
 * 用例就会因为"地址判据把代理的假地址拦了"而红，判据没错、红的原因却与产品无关。
 */
export function guardedCoverFetch(url, { headers = {}, timeoutMs = ONLINE_COVER_TIMEOUT_MS, withBytes = false, lookup = defaultLookup } = {}) {
  return guardedFetch(url, {
    headers, hosts: COVER_HOSTS, timeoutMs, maxBytes: MAX_COVER_BODY_BYTES, kind: 'cover', withBytes, lookup,
  });
}

/**
 * 在线曲目封面的出网适配器（看板 ⑨ 追加）。与专辑封面那一路**同一实现、不同主机表**：
 * 用途不同（那一路给没有封面的专辑补图，这一路给搜索结果与正在播放的在线曲目取图），
 * 合成一张表就等于让补全那一路也能打音乐 CDN。
 * kind 仍是 'cover'——审计面板上那一行本来就是"封面"，用户要看的是"打了谁、多少字节"，不是我们的模块边界。
 */
export function guardedTrackCoverFetch(url, { headers = {}, timeoutMs = ONLINE_COVER_TIMEOUT_MS, withBytes = true, lookup = defaultLookup } = {}) {
  return guardedFetch(url, {
    headers, hosts: TRACK_COVER_HOSTS, timeoutMs, maxBytes: MAX_COVER_BODY_BYTES, kind: 'cover', withBytes, lookup,
  });
}

/**
 * 音源串流的出网变体（第五期 Task 6）。与 guardedFetch 的**唯一**差别是不把响应读进内存、因此不卡体积上限
 * ——整首音频必然超过任何合理上限，而"读进来再吐出去"会把一首歌的体积变成常驻内存。
 * 前三条一条不少：协议 https、按用途的主机白名单、DNS 预解析 + 地址类别判定（都走 precheckTarget），
 * 请求侧照旧禁重定向 / 不带凭据 / 不缓存 / 有超时。返回的 `response.body` 交给调用方管道到响应，
 * **音频字节只过内存流，不落盘**（R74 的写盘白名单里没有音频这一项，这条是它的另一面）。
 *
 * 审计记的是"上游为这次响应声明的字节数"（206 时是那一段的长度），不是整首的长度——
 * 我们没有整首的事实，不编。
 */
export async function guardedStreamFetch(rawUrl, { headers = {}, hosts = AUDIO_HOSTS, timeoutMs = ONLINE_STREAM_TIMEOUT_MS, kind = 'stream', lookup = defaultLookup } = {}) {
  const started = Date.now();
  const url = await precheckTarget(rawUrl, hosts, kind, started, lookup);
  let response;
  try {
    response = await fetch(url, {
      method: 'GET',
      headers: { ...headers },
      redirect: 'error',
      credentials: 'omit',
      cache: 'no-store',
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    if (error instanceof OnlineTargetError) throw error;                 // 预检里已经记过了
    recordEgress({ host: url.hostname, kind, status: 0, bytes: 0, ms: Date.now() - started, via: 'guard' });
    throw error;
  }
  recordEgress({
    host: url.hostname, kind, status: response.status,
    bytes: Number(response.headers.get('content-length') ?? 0), ms: Date.now() - started, via: 'guard',
  });
  // 只把**流**交出去（`response.body`）：这里一旦 read，"不下载"就变成"下载了但没写盘"。
  return { ok: response.ok, status: response.status, headers: response.headers, body: response.body };
}
