// 本项目自撰（非移植代码）。桥侧的"取词通道"：网易与酷狗两家，形状照第四期已成立的 QQ 通道对齐。
//
// 为什么这两家必须经桥而不是像 QQ 那样直连：它们的公开取词接口需要各家自己的签名/加密
// （酷狗是 KRC 解密 + android 签名，网易是 weapi/eapi），这些实现只在封装包里，而包必须待在子进程（R73）。
// 于是本文件的分工是：**通道在桥里跑包，编排与打分留在服务端**（online-lyrics.mjs），
// 这样"逐字优先 / 分数阈值 / 标题硬门"这套规则只有一份实现，不会因为换了源而漂。
//
// 三个格式转换都是纯函数（自检离线可断），输入形状来自 Task 5 的真实探针：
//   · 网易 `/lyric/new` ⇒ `lyric` 是"每行一个 JSON 对象"的 NDJSON（`{"t":起始ms,"c":[{"tx":文本}]}`），
//     带艺人链接等富字段；`/lyric` ⇒ 经典 LRC + `tlyric` 译文（实测两个端点都 code 200）。
//   · 酷狗 `lyric({id, accesskey, decode:true})` ⇒ `body.decodeContent` 是 KRC：
//     `[900,3020]<0,430,0>张<430,440,0>磁…`（实测 785 字；不带 accesskey 时包直接抛错）。
import { countTimedLines } from '../../online-normalize.mjs';

/** 网易搜索响应 → 打分器认识的候选形状（与 QQ 侧同一形状，好让规则只有一份）。 */
export function ncmSearchToCandidates(body) {
  const songs = body?.result?.songs ?? body?.songs ?? [];
  return songs.map((song) => ({
    sourceId: String(song.id ?? ''),
    name: String(song.name ?? ''),
    artists: (song.artists ?? song.ar ?? []).map((artist) => ({ name: String(artist?.name ?? '') })),
    album: { name: String(song.album?.name ?? '') },
    durationMs: Number(song.duration ?? song.dt ?? 0) || 0,
  })).filter((candidate) => candidate.sourceId && candidate.sourceId !== '0' && candidate.name);
  // 网易用 id=0 表示"没有 id"（实测缺 id 的那条就是这样），留着只会浪费一次取词探测。
}

/**
 * 网易 `/lyric/new` 的 NDJSON 段 → 行级 LRC。
 * 为什么换成 LRC 而不是新造一种内部格式：岛内解析、计时行统计、回落判定全都按 LRC/QRC 形状工作，
 * 在这里转一次，胜过把四个下游都改一遍。富字段（艺人链接 `li`/`or`）丢掉，正文按 `tx` 顺序拼接。
 */
export function ncmSegmentsToLrc(rawLyric) {
  const text = String(rawLyric ?? '');
  if (!text.trim()) return '';
  const lines = [];
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim().replace(/,\s*$/, '');
    if (!trimmed.startsWith('{')) {
      if (trimmed) lines.push(trimmed);                      // 已经是普通 LRC 行：原样保留
      continue;
    }
    let segment;
    try { segment = JSON.parse(trimmed) } catch { continue }   // 解析不了的行丢掉，不让整首歌配不上
    const words = (Array.isArray(segment.c) ? segment.c : [])
      .map((chunk) => String(chunk?.tx ?? chunk?.c ?? ''))
      .join('');
    if (!words.trim()) continue;
    lines.push(`[${formatLrcTimestamp(segment.t)}]${words.trim()}`);
  }
  return lines.join('\n');
}

/** 毫秒 → `[mm:ss.xx]`（网易/酷狗/QQ 三家内部格式统一到这一个写法）。 */
function formatLrcTimestamp(ms) {
  const total = Math.max(0, Number(ms) || 0);
  const minutes = Math.floor(total / 60000);
  const seconds = (total % 60000) / 1000;
  return `${String(minutes).padStart(2, '0')}:${seconds.toFixed(2).padStart(5, '0')}`;
}

/** 网易歌词响应（`/lyric/new` 或 `/lyric`）→ {text, translation}。两个端点的字段名不同，这里一次收敛。 */
export function ncmLyricToText(body) {
  const rawMain = String(body?.lyric ?? body?.lrc?.lyric ?? '');
  const text = rawMain.includes('"tx"') ? ncmSegmentsToLrc(rawMain) : rawMain;
  const translation = String(body?.trans ?? body?.tlyric?.lyric ?? '').trim() || undefined;
  return { text, translation };
}

/**
 * 酷狗 `search_lyric` 响应 → 候选。
 * 字段名以 Task 5 真实探针为准（实测一条候选长这样：
 * `{id:"494789046", accesskey:"620D…", singer:"李荣浩", song:"恋人", duration:35000, krctype:2, score:60}`）：
 * 歌名是 `song`、歌手是 `singer`，**不是**上游文档里写的 `song_name`/`singer_name`（两种都留着兼容）。
 * `duration` 故意不映射：它的单位没被证实（这首 4:36 的歌给的是 35000），
 * 拿一个没证实的数字去参与时长打分会把"能配上"的歌误判成"配不上"；给 0 让时长项自动不参与。
 */
export function kugouSearchToCandidates(body) {
  const items = body?.candidates ?? body?.data?.items ?? [];
  return items.map((item) => ({
    sourceId: String(item.id ?? ''),
    accessKey: String(item.accesskey ?? ''),
    name: String(item.song ?? item.song_name ?? item.songname ?? ''),
    artists: [{ name: String(item.singer ?? item.singer_name ?? item.singername ?? '') }],
    album: { name: String(item.album_name ?? item.albumname ?? '') },
    durationMs: 0,
  })).filter((candidate) => candidate.sourceId && candidate.accessKey && candidate.name);
}

/**
 * KRC → 本项目内部的"逐字"写法（与 QRC 解密后的形状一致：`[起,长]正文(词起,词长)…`）。
 * 实测 KRC 长这样：`[900,3020]<0,430,0>张<430,440,0>磁…`，行内每个 `<词起,词长,?>` 管后面那段字。
 * 转成 `(词起,词长)` 而不是新造格式，理由同上：岛内已经会读 QRC 的词级标记。
 */
export function krcToWordMarks(text) {
  return String(text ?? '')
    .split(/\r?\n/)
    .filter((line) => /^\[\d+,\d+\]/.test(line.trim()))
    .map((line) => line.trim().replace(/<(\d+),(\d+),\d+>/g, '($1,$2)'))
    .join('\n');
}

/** 酷狗 `lyric` 响应 → {text, format}。`decode:true` 时正文在 `body.decodeContent`（实测）。 */
export function kugouLyricToText(body) {
  const raw = String(body?.decodeContent ?? body?.lyric ?? body?.content ?? '');
  if (!raw.trim()) return { text: '', format: 'none' };
  const krc = krcToWordMarks(raw);
  if (krc.trim() && countTimedLines(krc) >= 2) return { text: krc, format: 'krc' };
  return { text: raw, format: 'lrc' };
}

/** 各家响应里的"业务失败"形状不同，统一成一句可读原因（桥回 200 + reason，不伪装成 5xx）。 */
export function sourceFailure(body, okCodes = [200, 0]) {
  const code = Number(body?.code ?? body?.status ?? body?.errcode ?? 200);
  if (okCodes.includes(code)) return null;
  return String(body?.message ?? body?.info ?? body?.errmsg ?? `接口返回码 ${code}`);
}
