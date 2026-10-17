/**
 * 墙上展开卡里的「重取封面」（R126 · 方案 A）。**本项目自撰，非移植代码**，
 * 所以放在 folia-host（岛的宿主侧组件）而不是移植目录里，免得被误认成上游文件。
 *
 * 出现条件只有一条：这一首是在线曲目、而且现在没有封面。
 * 判据用 `getSongCoverUrl`——与墙上画占位那一条同一个出处，不另起一套（有图就不该给一颗会打网的按钮）。
 *
 * 点击只发一个事件，取图与汇报都在宿主（`music-app.retryOnlineCover`）：岛不持有播放权，
 * 也不持有"要不要出网"的决定权。按钮本身不做"进行中"状态：连点由宿主按 id 去重，
 * 而补到之后这一整格会随队列重建而消失，任何本地转圈状态都会与那次重建抢渲染。
 */
import { ImagePlus } from "lucide-react";
import { getSongCoverUrl } from "../folia/services/onlineMusic/songMetadata";
import type { SongResult } from "../folia/types";

/** 在线曲目 id 的形状（`on-<来源>-<媒体 id>[-<次 id>]`），与服务端那条身份判据同一个式子。 */
const ONLINE_ID = /^on-(?:netease|qq|kugou)-/;

export default function LatticeCoverRetry({ song }: { song: SongResult | null }) {
  if (!song || !ONLINE_ID.test(song.id)) return null;
  if (getSongCoverUrl(song)) return null;
  return (
    <button
      type="button"
      className="lattice-cover-retry"
      aria-label="重取这张封面的图片"
      title="按这一首的身份重问一次封面（会联网）"
      data-ponder="lattice-cover-retry"
      onClick={() => {
        document.dispatchEvent(new CustomEvent("rhine:cover-retry", {
          // R146：带上时长是给了回落一条证据（"另一家同一首"的判据要两边时长都知道且相差 ≤3 秒）；
          // 拿不到就送 0，服务端据此**不回落**，行为与今天一致。
          detail: { id: song.id, title: song.name, artist: song.artists?.[0]?.name ?? "", durationMs: Number(song.durationMs ?? 0) },
        }));
      }}
    >
      <ImagePlus size={20} />
    </button>
  );
}
