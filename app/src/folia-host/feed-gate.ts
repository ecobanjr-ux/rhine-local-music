/**
 * 宿主→岛的喂送门（自撰，非移植）：只回答"这一份岛收过没有"。
 *
 * 为什么单独成模块：岛的存储会在卸装时回到空（`useIslandUi` 显式重置成 `{layout:'classic',
 * mode:'classic', queue:[]}`），而宿主的"已喂"记录是引用与签名。两边不同步时，重挂后的每一帧
 * 都被门挡着（"没变"），岛于是**一直空到队列或歌词下次真的变化**——看板 c980fa6 的根因。
 * 状态原先散在 music-app 的四个模块级 `let` 里，没有任何一处会跟着岛一起失效，也没有一条断言
 * 拦得住；收进这里之后，`invalidate()` 是唯一一条"岛回到空"的广播，行为可在 Node 里直接测。
 */
import type { MusicTrack } from "../music-types";
import type { LyricData } from "../folia/types";

/** "还没喂过"与"喂过一份 null"是两件事，所以用哨兵而不是 null/undefined。 */
const NOT_FED = Symbol("folia-feed-not-fed");

export function createFoliaFeedGate() {
  let song: MusicTrack | null | typeof NOT_FED = NOT_FED;
  let lyrics: LyricData | null | typeof NOT_FED = NOT_FED;
  let queueRef: readonly MusicTrack[] | typeof NOT_FED = NOT_FED;
  let queueSignature = "";
  let transport: string | typeof NOT_FED = NOT_FED;

  return {
    /** true = 岛还没收这一份曲目，调用方要喂。 */
    takeSong(track: MusicTrack | null): boolean {
      if (track === song) return false;
      song = track;
      return true;
    },
    takeLyrics(data: LyricData | null): boolean {
      if (data === lyrics) return false;
      lyrics = data;
      return true;
    },
    /**
     * 两层判断照旧：数组引用变了才拼签名，签名变了才喂岛——每帧重建 SongResult 数组
     * 会让封面墙整墙重渲染（第二期的实测结论）。
     * 签名里除 id 还带上封面（R126）：墙上「重取封面」补到的那张图必须能上屏，
     * 只按 id 签名的话"只有封面变了"会被这道门挡住，表现就是"服务端明明有了、墙上还是渐变"。
     * 代价说清：封面变化会重建一次队列——那是**一次点击或一次回填**，不是每帧。
     */
    takeQueue(queue: readonly MusicTrack[]): boolean {
      if (queue === queueRef) return false;
      queueRef = queue;
      const signature = queue.map((entry) => `${entry.id}\u0001${entry.coverUrl ?? ""}`).join("|");
      if (signature === queueSignature) return false;
      queueSignature = signature;
      return true;
    },
    /**
     * 传输态（R128 · Q1）：内核那份 `transport` 是 idle / loading / playing / paused / error 五档，
     * 岛那边只有 PLAYING / PAUSED / IDLE 三档 —— 换算在适配层，这里只管"变了才要再说一遍"。
     * 没有这道门的话每帧都在写 zustand，墙上每个订阅者每帧重渲染。
     */
    takeTransport(value: string): boolean {
      if (value === transport) return false;
      transport = value;
      return true;
    },
    /** 岛的存储回到空（卸装）或刚立起来（挂载完成）⇒ 各项"已喂"记录一并作废，下一帧全量补喂。 */
    invalidate(): void {
      song = NOT_FED;
      lyrics = NOT_FED;
      queueRef = NOT_FED;
      queueSignature = "";
      transport = NOT_FED;
    },
  };
}

export type FoliaFeedGate = ReturnType<typeof createFoliaFeedGate>;
