// 本项目自撰（非移植代码）。公开歌单 → 本项目契约条目（Task 10 网易；R137 加酷狗；R138 加 QQ）。
//
// 字段名以 2026-10-05 桥内实测为准（`t10-shape.mjs`）：
//   · `/playlist/detail?id=` → `playlist.{id, name, trackCount, coverImgUrl}` + `trackIds[]`（173 条那个数就是 trackCount）；
//   · `/playlist/track/all?id=&limit=&offset=` → `{songs[], privileges[], code}`，
//     而 `songs[]` 用的还是**原始 API 形状** `ar[].name / al.name / dt`（毫秒）——
//     与 cloudsearch 同一个结论：这个包把上游响应基本原样透出，PC 端那套
//     `artists[]/album{}/duration` 在这里**不存在**。Task 7 刚在同一个坑里栽过一次，所以先量再写。
//     两种形状都留一行 alternatives：网易不同端点确实两种都给，认错会静默丢字段。
//
// 酷狗那一路的字段是 2026-10-08 一手量出来的（`kugou-gcid-probe` / `kugou-row-probe`，跑在产品同一条路上）：
//   · `playlist_detail({ids})` → `data` 是**数组**，行里 `name` / **`count`（总条数）** / `global_collection_id`
//     / `specialid` / `listid` / `list_create_userid`，可读性标记 `is_pri / pub_type / is_publish / is_drop / status`；
//   · `playlist_track_all({id, page, pagesize})` → `data.{count, songs[], begin_idx, pagesize}`，
//     分页是**页号 × 每页数**（`begin_idx = (page-1)*pagesize`，实测第 2 页 begin_idx=10、曲目与第 1 页不重），
//     总数在 `data.count`（实测 127 条的歌单 pagesize=200 一次给全 127 条，没撞上页大小上限）；
//   · 曲目行里 `name` 是 **"歌手 - 曲名" 连笔**，结构化的歌手在 `singerinfo[]`（数组！）、
//     专辑在 `albuminfo{name}`、时长 `timelen` 是**毫秒**。
//     连笔那一段不能按第一个 " - " 硬切（曲名自己就带 " - " 的很常见），
//     所以规则是"只有当 name 以那位歌手的名字 + ' - ' 开头时才剥"，否则整串当曲名——宁可不切也不切错。
//
// QQ 那一路的字段是 2026-10-09 一手量出来的（一条真实公开歌单，用户提供的链接只取其中的数字 id；
// 链接原文与 hosteuin/uid 依隐私红线**不进仓库任何文件**）。量的口径见 `playlist-qq.mjs` 头部。
//   · `cdlist[0]` 是元信息：`dissname`（单名）/ `songnum`（总条数，实测与 `songlist.length` 相等）/
//     `disstid`（**字符串形**的回显 id）；歌单主的 `nick / nickname / uin / encrypt_uin / headurl` 也在这一层
//     ——它们是**活人的身份字段**，白名单之外一律不取（下面 `qqPlaylistToMeta` 只构造四个键，并有断言钉住）；
//   · 曲目在 `cdlist[0].songlist[]`（一家就把整张单一次给完，实测 1534 条）：
//     曲名 `name`、带版本标记的那一份叫 `title`（实测 311 条两者不等，如 `name:"循迹"` / `title:"循迹 (Live)"`）。
//     **取 `name`**：它与搜索侧用的 `title_main ?? title` 是同一档（不带版本标记的那一份），
//     同一首歌从搜索进歌单与从歌单导进来应当长一个样；
//     歌手在 `singer[]`（数组，实测 292 条多歌手，上游没有连笔 ⇒ 与酷狗不同，这里不切前缀）、
//     专辑在 `album.name`（实测 19 条是空串，如实留空）、时长 `interval` 是**秒**（这一家不毫秒，乘 1000）、
//     `mid` 是歌曲 mid、`file.media_mid` 另有一个（实测 476 条两者相等，其余不同 ⇒ 是两个字段，不是一回事）；
//   · 行内 `status` 实测两种值：0（1513 条）与 31（21 条）。**不筛掉 31**：它的确切语义没量到
//     （多半是下架/不可播），而我们导的是"歌名清单"，一条标题不会因为上游标了 31 就匹配不上本地文件；
//     悄悄筛掉反而会让条数对不上还不报。宁多不少，交给匹配那一层判。
// R226：行封面的形状闸**不在这里抄第二份**——`trackCoverRef`（协议 / 主机表 / 端口 / 凭据四项都归它判）
// 与 `qqCoverRef`（QQ 的搜索侧早就按 `album.mid` 拼这一条，实测主机 `y.gtimg.cn`）都是既有那一个出处。
import { qqCoverRef, trackCoverRef } from './normalize.mjs';

const text = (value) => String(value ?? '').trim();
const millis = (value) => (Number.isFinite(Number(value)) && Number(value) > 0 ? Math.round(Number(value)) : 0);

/** 详情 → 导入要用的元信息。只取四个字段：名字、条数、封面、id（来历要能写回头注释）。 */
export function ncmDetailToMeta(detail) {
  const playlist = detail?.playlist ?? detail?.result?.playlist ?? detail;
  if (!playlist || typeof playlist !== 'object' || !playlist.id) return null;
  return {
    id: text(playlist.id),
    name: text(playlist.name),
    trackCount: Number(playlist.trackCount ?? 0) || 0,
    coverUrl: text(playlist.coverImgUrl ?? playlist.coverUrl),
  };
}

/** songs → 契约条目（provider=netease）。不是数组就返回 null（"没这个字段"≠"歌单是空的"）。 */
export function ncmSongsToItems(songs) {
  if (!Array.isArray(songs)) return null;
  // 契约是"这里只构造这几个字段"（R87 ① 的教训：另加一层白名单函数收自己构造的对象是空守卫）。
  return songs.map((song) => ({
    provider: 'netease',
    mediaId: text(song?.id),
    title: text(song?.mainTitle ?? song?.name),
    artist: (Array.isArray(song?.ar) ? song.ar : Array.isArray(song?.artists) ? song.artists : [])
      .map((entry) => text(entry?.name)).filter(Boolean).join(' / '),
    album: text(song?.al?.name ?? song?.album?.name),
    durationMs: millis(song?.dt ?? song?.duration),
    quality: '自动',
    // R226 · P2 的那一格：网易列歌单的每一行**本来就带行封面**，从前这一路只取了专辑名、把图丢了
    // （⇒ 只走身份路的新单封面整列空，用户实报那张 289 行的单就是这一格）。
    // 一手实测（2026-10-15 只读探针 `D:/tag-tools/r226-fields.mjs` / `r226-adopt.mjs`，跑在产品同一条路上）：
    //   字段是 **`al.picUrl`**（`al` 的键 = `id,name,picUrl,tns,pic`；`album` 那一格在这条端点上不存在），
    //   那张 289 行的单 **289/289 行都带**，且上游给的就是 **https**（分布 `p3.music.126.net`×151 / `p4.music.126.net`×138，
    //   两台都已在 `TRACK_COVER_HOSTS` 里 ⇒ 零新增出网主机）。`al.pic` 是数字图片 id（不拼地址，用不上）。
    // 过闸的活交给 `trackCoverRef` 那一个出处：形状不收（野主机 / 带端口 / 带凭据）就是空串，**空串不硬造**。
    coverRef: trackCoverRef(song?.al?.picUrl ?? song?.album?.picUrl),
  })).filter((item) => item.mediaId && item.title);
}

/**
 * 酷狗详情的**可读性判定**（一手形状：`data` 是数组，行里带四个可读性标记）。
 * 返回 `{readable:false, reason}` 时导入必须停下并把原因说给用户——这一家不返回 404，
 * 私有 / 被删 / 未发布都是"200 + 一个标记"，照网易那一条口径必须与"歌单是空的"分开。
 */
export function kugouDetailReadability(row) {
  if (!row || typeof row !== 'object') return { readable: false, reason: '酷狗歌单详情里没有这一行（id 不存在或读不到）' };
  const count = Number(row.count ?? 0) || 0;
  if (Number(row.is_pri ?? 0) === 1) return { readable: false, reason: '这张酷狗歌单是私有的（上游标了 is_pri=1），本机读不到曲目' };
  if (Number(row.is_drop ?? 0) === 1) return { readable: false, reason: '这张酷狗歌单已被删除（上游标了 is_drop=1）' };
  if (Number(row.status ?? 0) !== 0 && Number(row.is_publish ?? 0) !== 1) {
    return { readable: false, reason: `这张酷狗歌单不可读（上游状态 ${row.status}；可能是私有、已删除或需要登录）` };
  }
  // count=0 且标记都正常：这才是"空歌单"，与上面几种"读不到"分开报。
  return { readable: true, count, empty: count === 0 };
}

/** 酷狗详情行 → 导入要用的元信息（总条数在这一家叫 `count`，不叫 trackCount）。 */
export function kugouDetailToMeta(row) {
  const verdict = kugouDetailReadability(row);
  if (!verdict.readable) return { ok: false, reason: verdict.reason };
  return {
    ok: true,
    id: text(row.global_collection_id),
    name: text(row.name),
    trackCount: verdict.count,
    coverUrl: '',                       // 酷狗详情行给的是带 {size} 占位的模板 URL，不搬进我们的契约
    specialId: text(row.specialid),
    listId: text(row.listid),
  };
}

/**
 * 酷狗曲目行 → 契约条目。四个坑都写在这里：
 *   ① `name` 是"歌手 - 曲名"连笔，**只有当它真以那位（些）歌手名开头时才剥**（曲名自己带 " - " 的很常见）；
 *   ② 歌手在 `singerinfo`，而它是**数组**（实测 keys 为 "0"），不是对象；
 *   ③ 多歌手时上游用**顿号 "、"**连（实测 "林海峰、G.E.M.邓紫棋 - 食烟饮酒讲粗口"），
 *     而我们对外与网易那一路统一用 " / " ⇒ 前缀候选按几种连法都试一遍。
 *     只试 " / " 是真机量出来的错：多歌手那一行的曲名会留着"某某、某某 - "这一截，
 *     于是"曲名"里混进了歌手名——匹配与显示都会被它带偏；
 *   ④ 时长 `timelen` 已经是毫秒（实测 231915 = 3:51.9），不要再乘 1000。
 * 不是数组返回 null（"没这个字段"≠"歌单是空的"，与网易那一条同形判据）。
 * 没有曲名的行会被跳过（实测那张 127 条的单里有 1 条 `name` 是空的）——
 * 但**跳了几条不归这里说**：由导入器拿"上游总数 − 实际条数"报出来，这里静默不代表没事。
 */
const KUGOU_ARTIST_JOINERS = [' / ', '/', '、', ',', '，', ' & ', ' and ', ' feat. ', ' ft. '];
export function kugouSongsToItems(songs) {
  if (!Array.isArray(songs)) return null;
  return songs.map((song) => {
    const artists = (Array.isArray(song?.singerinfo) ? song.singerinfo : [])
      .map((entry) => text(entry?.name)).filter(Boolean);
    const joined = artists.join(' / ');
    const rawName = text(song?.name);
    let title = rawName;
    for (const joiner of KUGOU_ARTIST_JOINERS) {
      const prefix = `${artists.join(joiner)} - `;
      if (prefix !== ' - ' && rawName.startsWith(prefix)) { title = rawName.slice(prefix.length); break; }
    }
    return {
      provider: 'kugou',
      mediaId: text(song?.hash ?? song?.audio_id),
      title: text(title),
      artist: joined,
      album: text(song?.albuminfo?.name),
      durationMs: millis(song?.timelen),
      quality: '自动',
      // R226 如实记：**这一家的行封面今天收不进来，所以留空串（不是漏取）**。一手实测（同两张探针，那张 400 行老单的第一页 200 行）：
      //   字段确实有，叫 `cover`，但 **200/200 行都是带 `{size}` 占位的模板**
      //   （`http://imge.kugou.com/stdmusic/%7Bsize%7D/<日期>/<数字>.jpg`），且 ① 协议是 **http**、
      //   ② 主机 `imge.kugou.com` **不在 `TRACK_COVER_HOSTS`**（表里只有网易四台 + `y.gtimg.cn`）。
      // 换成具体尺寸再拼地址 = 替用户挑分辨率 + 新增一台出网主机，两样都不是本批的授权面（纪律：零新增出网主机）
      // ⇒ 登记为待拍板（出路在案：量过 TLS 之后加一台 exact 主机 + 一处尺寸换算，见 run log）。
      // 与 `kugouDetailToMeta` 里那句"酷狗详情行给的是带 {size} 占位的模板 URL，不搬进我们的契约"是同一条结论的两个端点。
      coverRef: '',
    };
  }).filter((item) => item.title);
}

/**
 * QQ 歌单响应 → 元信息。**字段白名单是这张函数的全部意义**：`cdlist[0]` 里挂着歌单主的
 * `nick / nickname / uin / encrypt_uin / headurl`（真人身份与头像 URL），一个都不许往上传。
 * `coverUrl` 这一家留空：详情给的是 `http://y.gtimg.cn/...`（明文、且导入用不到封面），
 * 搬进来等于在契约里放一条我们不打算走的第三方地址（与酷狗同一处置）。
 * 没有 `cdlist[0]` 返回 null —— "没这个字段"与"这张单是空的"（`songnum:0`）是两件事。
 */
export function qqPlaylistToMeta(body) {
  const cd = Array.isArray(body?.cdlist) ? body.cdlist[0] : null;
  if (!cd || typeof cd !== 'object' || Array.isArray(cd)) return null;
  return {
    id: text(cd.disstid),
    name: text(cd.dissname),
    trackCount: Number(cd.songnum ?? cd.total_song_num ?? 0) || 0,
    coverUrl: '',
  };
}

/**
 * `songlist[]` → 契约条目（provider=qq）。不是数组返回 null（"没这个字段"≠"歌单是空的"）。
 * 时长 `interval` 是**秒**（网易是毫秒、酷狗也是毫秒，这一家不同 ⇒ 认错会静默把 4 分钟写成 4 秒）。
 */
export function qqSonglistToItems(songlist) {
  if (!Array.isArray(songlist)) return null;
  return songlist.map((song) => ({
    provider: 'qq',
    mediaId: text(song?.mid),
    // R220：第二段文件名 `file.media_mid` 也要带（字段名是 R138 一手量的那个，与搜索侧 `normalize.mjs:119`
    // 同一份事实）。带它不是贪多：QQ 匿名 vkey 缺这第二段时"服务器仍会给 purl，但 CDN 端 403"
    //（`online-audio-source.mjs` 里 `qqVkeyRequest` 那条注释记着）——账号歌单的身份通路若不带它，
    // 就会把"今天靠搜索能播"的 QQ 行换成"用身份反而播不出"，那是本件明令不许发生的退化。
    mediaMid: text(song?.file?.media_mid),
    title: text(song?.name ?? song?.title),
    artist: (Array.isArray(song?.singer) ? song.singer : []).map((entry) => text(entry?.name)).filter(Boolean).join(' / '),
    album: text(song?.album?.name),
    durationMs: millis(Number(song?.interval) > 0 ? Number(song?.interval) * 1000 : 0),
    quality: '自动',
    // R226：QQ 的行**不直接给图片地址**（一手实测：`songlist[]` 行键里没有任何 pic/img 字段，
    // 那张 1553 行的公开单里"行内直接给的图片字段"命中 0），但给了 **`album.mid`**
    // （行的 `album` 键 = `id,mid,pmid,name,title,subtitle`；1553 行里 1534 行带 mid，缺 mid 的 19 行如实留空）。
    // 于是走**搜索侧那一个既有出处** `qqCoverRef`：按实测形状拼 `https://y.gtimg.cn/…T002R300x300M000<mid>.jpg`
    // （主机早已在 `TRACK_COVER_HOSTS`，R116 一手量过 200 / image/jpeg）⇒ 与从搜索进歌单的那一行逐字同形，不是第二套拼法。
    coverRef: qqCoverRef(song?.album?.mid),
  })).filter((item) => item.mediaId && item.title);
}

/* ── R159（任务六）· 账号歌单列表 ─────────────────────────────────────────────
 *
 * 网易 `/user/playlist` 与酷狗 `user_playlist` 两家共用这一个入口。R159 当时**这一族的形状没量到过**
 * （量它必须用用户自己的账号），所以只做了两件不会错的事：在几个可能的位置里找**数组**，找到就用、
 * 找不到就报"形状不认识"，绝不猜着往下走。
 *
 * R182（任务一）真机量到了，两条路径都按量到的钉住（不再是猜表）：
 *   · 网易 `GET /user/playlist?uid=&limit=&offset=` → `{ more:<bool>, playlist:[<n>], code:200 }`
 *     —— 数组就在顶层 `playlist`，行里 `id`（数字）/ `name` / `trackCount`；
 *   · 酷狗 `user_playlist({page,pagesize})` → `{ status:200, body:{ data:{ info:[<n>], list_count, collect_count,
 *     userid, total_ver, … }, status:1, error_code:0 } }` —— 数组在 **`data.info`**（不是 `data.list`、
 *     也不是 `data.collections`），行里 `global_collection_id`（唯一能导曲目的 id）/ `name` / **`count`**（条数）。
 *     `info` 里那两条各带 `is_pri / is_drop / is_publish / is_del` 同族可读性标记（与曲目那一跳同一处置，这里不筛）。
 * 每行只留 `id / writeId / name / trackCount` 四样：创建者昵称与 userId、封面 URL（第三方 http 地址）
 * 一律不带出桥（与 `qqPlaylistToMeta` 同一处置，R116 那条红线不因为"只是列表页"就让路）。
 *
 * 如实记两处边界：① 酷狗这一档上游给的是 `list_count`/`collect_count` 两个**数**而不是"还有没有下一页" ⇒
 * `hasMore` 在酷狗恒 `false`（本机实测账号 2 条、默认页大小 30，撞不上；真撞上表现为"只列第一页"，不静默丢）；
 * ② `pickArray` 的表仍是**有序兜底表**，量到的那两条排最前，其余留着给"上游换了形状"兜一圈。
 */
const ACCOUNT_LIST_PATHS = [['playlist'], ['data', 'info'], ['data', 'list'], ['data', 'collections'],
  ['data', 'songlist'], ['data', 'playlists'], ['list'], ['collections'], ['playlists'], ['data']];

const pickArray = (body, paths) => {
  for (const path of paths) {
    let node = body;
    for (const key of path) node = node?.[key];
    if (Array.isArray(node)) return { items: node, at: path.join('.') };
  }
  return null;
};

/**
 * 账号歌单响应 → `{items, sourceField, hasMore}` 或 `{ok:false, reason}`。
 * `provider` 决定"这一行的 id 取哪一格"：网易是数字 `id`，
 * 酷狗**只有** `global_collection_id` 能用（R137 实测：`specialid` 与 `gcid_` 都导不出曲目）。
 *
 * R182（任务一）：每行再加一格 `writeId` —— 写侧（加歌）要的号与读侧不是同一个。
 * 真机实测酷狗行里**显式带 `listid`**（本机那两条是 `1`「默认收藏」/ `2`「我喜欢」），
 * 而加歌那一跳收的正是这个序数（`playlist_tracks_add` 的 `listid`），不是 `global_collection_id`；
 * 网易两处同号，`writeId` 就等于 `id`。这一格是**界面上"加进来"那颗按钮**用的（导入仍用 `id`）。
 */
export function accountPlaylistsToItems(body, provider) {
  const found = pickArray(body, ACCOUNT_LIST_PATHS);
  if (!found) {
    const keys = body && typeof body === 'object' ? Object.keys(body).slice(0, 8).join('/') : typeof body;
    return { ok: false, reason: `账号歌单响应的形状不认识（顶层键：${keys || '（空）'}）——这一条没在真机量到过，不猜` };
  }
  const skipped = [];
  const items = [];
  for (const [index, row] of found.items.entries()) {
    if (!row || typeof row !== 'object') { skipped.push(index); continue }
    const id = provider === 'kugou' ? text(row.global_collection_id) : text(row.id ?? row.playlistId);
    const name = text(row.name ?? row.specialname ?? row.playlistName);
    if (!id || !name) { skipped.push(index); continue }
    const writeId = provider === 'kugou' ? text(row.listid) : id;
    // R188（Q65）：**"上游没给这一格"与"上游给了 0"是两件事**。原先 `Number(... ?? 0) || 0`
    // 把"没给"洗成 0 ⇒ 界面上"已知 0 条"与"条数未知"成了一句（酷狗「默认收藏」count=0 显示成了未知）。
    // 缺失（含空串）记 `null`；给了数值就过 `Number`，认不出的（NaN）也当缺失，不猜成 0。
    const rawCount = row.trackCount ?? row.songCount ?? row.count ?? row.snum;
    const countNum = rawCount === undefined || rawCount === null || rawCount === '' ? Number.NaN : Number(rawCount);
    items.push({
      provider, id, writeId, name,
      trackCount: Number.isFinite(countNum) ? countNum : null,
    });
  }
  return {
    ok: true, items, sourceField: found.at, skipped,
    hasMore: Boolean(body?.more ?? body?.has_more ?? body?.data?.more ?? false),
  };
}
