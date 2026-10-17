// 本项目自撰（非移植代码）。「歌词匹配」面板的 markup（R144 · 夜间批任务五）。
//
// 与 `favorites-ui.ts` 同一条分工：这里**只有 markup 与纯函数**，不 fetch、不碰 DOM、不持状态，
// 所以它能被自检直接调用判定（真机上那一格长什么样另有截图）。
//
// 面板要说得出三件事，一件都不许含糊：
//   ① 现在这份歌词是怎么来的（与歌词面那条徽标同口径：机器配上的 ≠ 人挑的）；
//   ② 自动挡为什么没过（服务端那句原因原文，不在这儿重新造句）；
//   ③ 认领写的是什么——只有"选了哪一首"这个身份，歌词正文永远不落盘（设置里那句声明因此继续是真的）。
import { escapeHtml } from "./html.ts";
import { ONLINE_PROVIDER_LABELS, type OnlineNearCandidate, type OnlineProvider } from "./lyrics-client";

export interface LyricMatchView {
  track: { title: string; artist: string; album?: string; durationMs?: number };
  /** 现在这份歌词的来源（"同目录文件 · 行级"这一类一句话）。 */
  current: string;
  /** 服务端给的那句未命中原因（原文照抄，不在这里重新造句）。 */
  reason?: string;
  near: OnlineNearCandidate[];
  claim?: { provider?: string; title?: string; artist?: string; claimedAt?: string } | null;
  /** 认领取不到词时那句实话（此时界面显示的是回落后的自动挡结果）。 */
  claimFailed?: string;
  /** 本次操作之后的报告（写盘成功 / 为什么没写）。 */
  status?: string;
  /** 在线歌词开关关着：面板要说明为什么什么都不问。 */
  switchedOff?: boolean;
}

const providerLabel = (value?: string) =>
  ONLINE_PROVIDER_LABELS[value as OnlineProvider] ?? value ?? "未知来源";

/** 毫秒 → `m:ss`；没有时长就什么都不说（不写"0:00"假装知道）。 */
export function lyricClockLabel(durationMs?: number): string {
  const ms = Number(durationMs ?? 0);
  if (!Number.isFinite(ms) || ms <= 0) return "";
  const total = Math.round(ms / 1000);
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
}

const esc = (value: unknown) => escapeHtml(String(value ?? ""));

export function lyricMatchMarkup(view: LyricMatchView): string {
  const clock = lyricClockLabel(view.track.durationMs);
  const trackLine = `《${view.track.title}》 · ${view.track.artist}${view.track.album ? ` · ${view.track.album}` : ""}${clock ? ` · ${clock}` : ""}`;
  const rows = view.near.map((candidate, index) => {
    const meta = [candidate.artist, candidate.album, lyricClockLabel(candidate.durationMs)].filter(Boolean).join(" · ");
    return `<li class="lyric-near-row">`
      + `<span class="lyric-near-main">《${esc(candidate.title)}》</span>`
      + `<small class="lyric-near-meta">${esc(meta)} · ${esc(candidate.score)} 分 · ${esc(providerLabel(candidate.provider))}</small>`
      + `<button type="button" class="text-button" data-action="claim-lyric" data-index="${index}">就用这首</button>`
      + `</li>`;
  }).join("");
  return `<p class="panel-intro">这台播放器不替你决定"差一点算不算同一首"。自动匹配的阈值仍是 75 分（这一格一个字没改）；`
    + `下面列出的是 60~74 分之间最接近的候选——你挑一条，它就成为这首歌的歌词，不挑就维持现状。</p>`
    + `<div class="lyric-match-current"><strong>${esc(trackLine)}</strong>`
    + `<small>${esc(view.current)}</small>`
    + (view.reason ? `<small class="lyric-match-reason">${esc(view.reason)}</small>` : "")
    + `</div>`
    + (view.switchedOff
      ? `<p class="lyric-match-warning">在线歌词已关闭：这里什么都不会问（在音乐库面板的「在线能力」里重新勾选即可恢复）。</p>`
      : "")
    + `<div class="panel-actions"><button type="button" class="primary-button" data-action="retry-lyrics">重试匹配歌词 ↗</button>`
    + (view.claim ? `<button type="button" class="text-button" data-action="clear-lyric-claim">取消认领</button>` : "")
    + `</div>`
    + (view.claim
      ? `<p class="lyric-match-claim">已手动认领：《${esc(view.claim.title ?? "")}》 · ${esc(providerLabel(view.claim.provider))}`
        + `${view.claim.claimedAt ? ` · ${esc(String(view.claim.claimedAt).slice(0, 10))}` : ""}`
        + `<br>这条记录只存"选了哪一首"（来源与曲目标识），歌词正文仍然不落盘。</p>`
      : "")
    + (view.claimFailed
      ? `<p class="lyric-match-warning">认领的那一首这次没取到词：${esc(view.claimFailed)}（画面显示的是回落到自动匹配之后的结果）。</p>`
      : "")
    + (rows
      ? `<h3>接近的候选（60~74 分）</h3><ul class="lyric-near-list">${rows}</ul>`
      : `<p class="panel-intro">没有 60 分以上的候选可挑——上面那句原因就是全部读数。</p>`)
    + `<p data-role="lyric-match-status">${esc(view.status ?? "")}</p>`;
}
