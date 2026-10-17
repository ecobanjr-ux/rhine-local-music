// 本项目自撰（非移植代码）。在线搜索的**窄契约**：第三方响应 → 本项目自己那 9 个字段。
//
// 计划里这一步写的是"移植 qqNormalize.ts 等"（R78）。和 Task 5 一样落成了**全部自撰**：
// 上游那几个 provider 的 normalize 函数与它们的 fetch/axios 层长在一起，剥不干净；
// 真正要保住的不是它的代码，而是它的**语义**——"前端拿不到上游那几十个字段的任何边角"。
// 所以这一份只做一件事：把三家的字段名翻译成一张固定表，表之外的字段一个都不带出去。
//
// 字段名一手核实（2026-10-05 探针，数据在 memory/folia-port-p5-run-log.md 的 Task 6/7 段）：
//   · 网易 cloudsearch → `result.songs[].{id, name, artists[].name, album.name, duration}`；
//     总数在 `result.songCount`，还有没有下一页在 `result.hasmore`（两个都不是从条目数推的）。
//   · QQ DoSearchForQQMusicLite → `body.item_song[].{mid, id, title, singer[].name, album.name, interval}`，
//     `interval` 单位是**秒**（乘 1000 才进契约）；第二段文件名 `file.media_mid` 决定匿名能不能播出声。
//   · 酷狗自 2026-10-10（任务一 · B 路线）起**是第三个搜索源**：字段名与单位见下面 `kugouSearchToItems` 的注释
//     （安卓 complexsearch 那套大写键；要登录态 + 我们自造的 mid 才回数据，未登录时那一站在 perSource 里如实报原因）。
import { AUDIO_PROVIDERS } from '../../online-audio-source.mjs';
import { TRACK_COVER_HOSTS, hostAllowed } from '../../online-guard.mjs';

/** 契约字段（内部条目形状）。桥与父进程两侧共用这一份，避免"哪一侧漏了一个字段"两处漂移。
 *  `coverRef` 是**第三方那条封面地址**（已升 https、已过主机判据），它只活在服务端：
 *  发给前端的是同源代理地址（见 `online-search.mjs` 的 `coverUrl`），与音源同一条红线。
 *  `mediaMid` / `albumId` / `albumAudioId` 三个键**只有一部分源有**（缺省是"这个键不出现"，不是空串）：
 *  · `mediaMid` 是 QQ 的第二段文件名（R138 一手量）；
 *  · `albumId` / `albumAudioId` 是酷狗取址"两个变体"那一格的输入（R222）：量到的是检索行里的
 *    `AlbumID` 与 `MixSongID`（一手对表：Breathe 那首的 `AlbumID=4138230 / MixSongID=89872375`
 *    与网页端点回吐的 `albumid / album_audio_id` **逐位相等**；原版注释也把 `album_audio_id ?? mixSongId` 当同一格）。
 *  它们都**不进发给前端的契约**（那 11 个键一个不多），只并进取址地址里当参数。 */
export const ONLINE_ITEM_FIELDS = Object.freeze([
  'album', 'albumAudioId', 'albumId', 'artist', 'coverRef', 'durationMs', 'mediaId', 'mediaMid', 'provider', 'quality', 'title',
]);
/** 发给前端的曲目形状（比内部条目多 `id`/`sourceKind`/`audioUrl`，少 `mediaMid`——它已经并进 audioUrl 里了）。 */
export const ONLINE_TRACK_FIELDS = Object.freeze([
  'album', 'artist', 'audioUrl', 'coverUrl', 'durationMs', 'id', 'mediaId', 'provider', 'quality', 'sourceKind', 'title',
]);

const text = (value) => String(value ?? '').trim();
const millis = (value) => (Number.isFinite(Number(value)) && Number(value) > 0 ? Math.round(Number(value)) : 0);

/**
 * 封面地址的**服务端侧形状闸**（判据表来自 online-guard 那一张，不在这里抄第二份）：
 *   · 网易 `al.picUrl` 实测给的是 **`http://p<1-4>.music.126.net/…`** ⇒ 一律升 https 再放行
 *     （与 R112 那条 QQ 头像同一条老规矩：上游给 http，实测 https 同一张图）；
 *   · 主机、协议、端口、凭据四项都要过——放行的是"要被拼进一次真实出网请求"的那个字符串，
 *     guardedFetch 那三道判据照旧在请求前，这里只是不让一个野 URL 进到注册表里。
 */
export function trackCoverRef(value) {
  const raw = text(value);
  if (!raw) return '';
  let url;
  try { url = new URL(raw.replace(/^http:/i, 'https:')); } catch { return ''; }
  if (url.protocol !== 'https:' || url.username || url.password || url.port) return '';
  return hostAllowed(url.hostname, TRACK_COVER_HOSTS) ? url.toString() : '';
}

/** QQ 的搜索**不给封面 URL，只给 `album.mid`**（实测 `000MkMni19ClKG`），地址由我们按实测形状拼。
 *  mid 会进 URL ⇒ 字符集判据（2026-10-07 实测：`y.gtimg.cn` 上这条形状 200 / image/jpeg / 33,448B）。 */
export function qqCoverRef(albumMid) {
  const mid = text(albumMid);
  return /^[A-Za-z0-9]{1,64}$/.test(mid) ? `https://y.gtimg.cn/music/photo_new/T002R300x300M000${mid}.jpg` : '';
}

/**
 * R225 · 「这首歌是谁」在**查询串**里的那一对字段（回落到别的源要靠它去检索同名曲）。
 * 形状闸刻意很窄：两边都非空、去空白、各自 ≤120 字符 ⇒ 给 `{title, artist}`；任一项不合格给 `null`。
 *
 * 与 `online-audio-source.mjs` 里那扇 POST 体的窄门（`onlineAudioIdentityFrom`）不是同一份、也不该合成一份：
 * 那份读的是界面随请求带来的对象，**超长要截**（截完仍是同一首歌）；这份写的是要进 `<audio src>` 的 URL，
 * **超长或空缺就整个不带**——回落是增强，不该为它撑爆地址（带了半截名字反而会把回落判成"另一首歌"）。
 * 两侧读的是同一对参数名：写在这一头，读在 `music-server.mjs` 的流式路由。
 */
export const ONLINE_IDENTITY_QUERY_LIMIT = 120;
export function onlineIdentityPair(title, artist) {
  const name = text(title);
  const singer = text(artist);
  if (!name || !singer || name.length > ONLINE_IDENTITY_QUERY_LIMIT || singer.length > ONLINE_IDENTITY_QUERY_LIMIT) return null;
  return { title: name, artist: singer };
}

/**
 * 内部条目 → 前端曲目。`audioUrl` **只给同源代理地址**：第三方那条带签名的 CDN URL 到不了浏览器，
 * 这是"不下载 + 不暴露来源细节"两条红线在契约上的共同兑现。
 * QQ 的 `mediaMid` 并进查询串（`&mm=`）：它是取址要用的第二段文件名，不是用户输入。
 */
export function toOnlineTrack(item) {
  const provider = text(item?.provider);
  const mediaId = text(item?.mediaId);
  if (!AUDIO_PROVIDERS.includes(provider) || !mediaId) return null;
  const params = new URLSearchParams({ p: provider, id: mediaId });
  const mediaMid = text(item?.mediaMid);
  if (mediaMid) params.set('mm', mediaMid);
  // R222：酷狗取址"两个变体"要的专辑参数，与 `mm` 同一处置——**并进地址、不进契约字段**
  // （前端拿到的还是那 11 个键；这两个值只在校验过的查询串里活一趟，见 music-server 的流式路由）。
  const albumId = text(item?.albumId);
  const albumAudioId = text(item?.albumAudioId);
  if (/^\d{1,20}$/.test(albumId)) params.set('al', albumId);
  if (/^\d{1,20}$/.test(albumAudioId)) params.set('aa', albumAudioId);
  // R225：曲名与歌手并进同源地址（`t`/`a`），处置与 `mm`/`al`/`aa` 同一条（不进那 11 个契约键）。
  // 这一格补的是 R141 回落**从未触发**的那条根因：`/api/online/stream` 是"用户点一首歌"唯一的生产入口，
  // 而它从前只带 `p/id/mm/al/aa` ⇒ 回落要的身份一直没人喂（读数与登记见 `memory/playlist-source-identity-r220-run-log.md`
  // 的 §P1 发现）。占位词（`未知曲名`/`未知歌手`）走的是下面曲目对象那一格，**不进这里**：
  // 名字缺失就不带参数 ⇒ 不回落，行为与今天逐字一致。
  const identity = onlineIdentityPair(item?.title, item?.artist);
  if (identity) {
    params.set('t', identity.title);
    params.set('a', identity.artist);
  }
  return {
    id: `on-${provider}-${mediaId}`,
    sourceKind: 'online',
    provider,
    title: text(item?.title) || '未知曲名',
    artist: text(item?.artist) || '未知歌手',
    album: text(item?.album),
    durationMs: millis(item?.durationMs),
    mediaId,
    quality: text(item?.quality) || '未知',
    audioUrl: `/api/online/stream?${params.toString()}`,
    // 固定形状：没有封面就是空串，不是"这个键不存在"——契约的价值在于前端可以无脑读。
    // 值由装配层（online-search.mjs）从内部条目的 `coverRef` 换算成**同源代理地址**再填进来；
    // 第三方那条 URL 从不出服务端，与 audioUrl 同一条红线。
    coverUrl: '',
  };
}

/** 去重键：同一首歌在两个源都出现时只留第一条（大小写与空白归一，不做模糊匹配）。 */
export function itemKey(item) {
  return `${text(item?.title).toLocaleLowerCase()}|${text(item?.artist).toLocaleLowerCase()}|${millis(item?.durationMs)}`;
}

/**
 * 网易 cloudsearch 响应 → 条目数组。`songs` 缺席与空数组是两件事，交给调用方判（见 search-routes）。
 *
 * 字段名以**桥里实测**为准（2026-10-05，`t7-shape.mjs`）：这个 build 的 `/cloudsearch` 回的是原始 API 形状
 * `songs[].{id, name, dt, ar[].name, al.name}`，**不是** PC 端那套 `{duration, artists[], album{}}`。
 * 第一版按 PC 形状写，真机上 20 条结果的歌手全成了"未知歌手"、时长全 0——离线夹具照着假设写所以全绿。
 * 两种形状都留（一行 alternatives，与酷狗那两个别名同理）：网易这两个变体在现实中都存在，
 * 但注释要写清实测看到的是哪一种，别让下一个读代码的人以为可以随便删。
 *
 * 契约是靠**这里只构造这 7 个字段**守住的：不把上游对象展开进来，就没有"某个字段漏出去"的可能。
 */
export function ncmSearchToItems(body) {
  const songs = body?.result?.songs ?? body?.songs;
  if (!Array.isArray(songs)) return null;
  return songs.map((song) => ({
    provider: 'netease',
    mediaId: text(song?.id),
    title: text(song?.name),
    artist: (Array.isArray(song?.ar) ? song.ar : Array.isArray(song?.artists) ? song.artists : [])
      .map((a) => text(a?.name)).filter(Boolean).join(' / '),
    album: text(song?.al?.name ?? song?.album?.name),
    durationMs: millis(song?.dt ?? song?.duration),
    // 网易把封面直接给成 URL（实测 al.picUrl，http 起头）。
    coverRef: trackCoverRef(song?.al?.picUrl),
    // 网易的音质档在取址时才定（`br=320000` 拿得到的是"该曲匿名可得的最高档"），这里如实标"待取址"。
    quality: text(song?.quality?.label) || '自动',
  })).filter((item) => item.mediaId && item.title);
}

/** QQ item_song → 条目数组。`interval` 是秒；`file.media_mid` 决定匿名音源能不能拼出可播文件名。 */
export function qqSearchToItems(itemSongs) {
  if (!Array.isArray(itemSongs)) return null;
  return itemSongs.map((song) => ({
    provider: 'qq',
    mediaId: text(song?.mid),
    mediaMid: text(song?.file?.media_mid),
    title: text(song?.title_main ?? song?.title),
    artist: (Array.isArray(song?.singer) ? song.singer : []).map((singer) => text(singer?.name)).filter(Boolean).join(' / '),
    album: text(song?.album?.name),
    durationMs: millis((song?.interval ?? 0) * 1000),
    // QQ 不给 URL，只给 album.mid ⇒ 由我们按实测形状拼（见 qqCoverRef 的注释）。
    coverRef: qqCoverRef(song?.album?.mid),
    // size_320mp3 > 0 只说明"有 320 的文件"，不代表匿名拿得到 ⇒ 标档不标"可播"。
    quality: Number(song?.file?.size_320mp3) > 0 ? '320kbps（视版权）' : '128kbps（视版权）',
  })).filter((item) => item.mediaId && item.title);
}

/**
 * 酷狗 `search` 响应 → 条目数组（任务一 · B 路线，2026-10-10 一手实测的字段名）。
 * 形状与另两家**完全不同**，这是量出来的不是猜的：
 *   · 数组在 **`data.lists`**（不叫 songs / item_song）、总数在 **`data.total`**；
 *   · 曲目行是**安卓 complexsearch 那套大写键**：`OriSongName`（曲名）/ `SingerName`（歌手，一个字符串，
 *     多歌手实测用顿号连）/ `AlbumName` / **`Duration` 是秒**（与 QQ 的 `interval` 同档、与网易的 `duration` 毫秒不同）/
 *     **`FileHash` 是 32 位十六进制**（就是它的媒体 id，`song_url` 也认这一个）/ `Bitrate` 128|320 / `PayType`。
 *   · **没有封面字段**（24 个键里没有任何 img/cover/pv 一类）⇒ `coverRef` 一律空串，界面画占位，
 *     不拿 `AlbumID` 去拼一条没量过的图片地址（F3 那条判据：不按 id 造地址）。
 * `PayType` **只用于标档，不用于筛**：导的是"这首歌是什么"，播不播得动由取址那一跳按权益实说。
 */
export function kugouSearchToItems(body) {
  const rows = body?.data?.lists ?? body?.lists;
  if (!Array.isArray(rows)) return null;
  return rows.map((row) => {
    // R222：取址"两个变体"要的两个 id —— 一手对表过（Breathe：`AlbumID` 4138230 与网页端点回的 `albumid` 相等；
    // `MixSongID` 89872375 与 `album_audio_id` 相等）。认不出的行**不带这两个键**（缺省不出现），
    // 取址那一侧对"没带"的读法就是纯 hash 那一档，不会因为一个可选提示把这首歌判死。
    const albumId = text(row?.AlbumID);
    const albumAudioId = text(row?.MixSongID);
    return {
      provider: 'kugou',
      mediaId: text(row?.FileHash),
      title: text(row?.OriSongName ?? row?.FileName),
      artist: text(row?.SingerName),
      album: text(row?.AlbumName),
      durationMs: millis((row?.Duration ?? 0) * 1000),
      coverRef: '',
      quality: Number(row?.Bitrate) > 0 ? `${Number(row?.Bitrate)}kbps（视版权）` : '自动',
      ...(/^\d{1,20}$/.test(albumId) ? { albumId } : {}),
      ...(/^\d{1,20}$/.test(albumAudioId) ? { albumAudioId } : {}),
    };
  }).filter((item) => item.mediaId && item.title);
}

/**
 * `toOnlineTrack` 签发的那条同源地址的**逆函数**（F2：搜索结果加进歌单时要把身份落回文本）。
 *
 * 为什么在服务端反解，而不是让前端把 `mediaMid` 一起交上来：`mediaMid` 之所以不出契约
 * （`ONLINE_TRACK_FIELDS` 有意少它，R78），就是因为它已经并进这条地址里了。
 * 为了加歌单再把它单独发一遍，等于把"契约只有 10 个字段"这条纪律为一个便利破掉。
 * 只认自己签发的形状：路径必须是 `/api/online/stream`、来源必须在音质白名单里、媒体 id 必须非空，
 * 否则返回 null（当成一条普通条目，回头照常搜索匹配）。
 */
export function identityFromStreamUrl(rawUrl) {
  const url = String(rawUrl ?? '');
  if (!url.startsWith('/api/online/stream?')) return null;
  let params;
  try {
    const parsed = new URL(url, 'http://127.0.0.1');
    if (parsed.pathname !== '/api/online/stream') return null;
    params = parsed.searchParams;
  } catch {
    return null;
  }
  const provider = text(params.get('p'));
  const mediaId = text(params.get('id'));
  if (!AUDIO_PROVIDERS.includes(provider) || !mediaId) return null;
  const mediaMid = text(params.get('mm'));
  return { provider, mediaId, ...(mediaMid ? { mediaMid } : {}) };
}
