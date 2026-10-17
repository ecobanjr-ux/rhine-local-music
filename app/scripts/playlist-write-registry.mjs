/**
 * 「刚才列出来的那些账号歌单」登记簿（R165 · 任务十一，本项目自撰，AGPL-3.0-only）。
 *
 * 为什么要有这个东西：写侧那条红线是"只往用户自己的账号里写"。光校验 id 的形状挡不住
 * 一次脚本投递——随便填一个别人的公开歌单号，形状完全合法，而平台会照单收下（网易对别人的
 * 歌单会拒，酷狗那一条今天没量到，不能拿"大概会被拒"当我们的护栏）。
 * 所以父进程只认**它自己刚刚列给界面的那些 id**：id 来自 R159 那条 `mine`，
 * 而 `mine` 列的是"这台机器登录的那个账号自己的"歌单（凭据只从本机分区来，R97）。
 * 中间隔了这一层，"往别人的单子写"就成了一件需要用户先在自己的账号里做过一次列表的事。
 *
 * 三条形状纪律（与 R148 那份认领令牌登记簿同一套做法）：
 * · **只在内存**，不落盘（重启后要先重新列一次才能写，这是有意的：那份"是谁的单子"的结论过期了）；
 * · 带 TTL，过期就当作没列过（账号里的歌单会被用户自己增删，不能拿一小时前的清单当今天的授权）；
 * · 有上限，按插入序淘汰（列很多次不会把进程内存吃掉）。
 */
export const ISSUED_PLAYLIST_TTL_MS = 10 * 60 * 1000;
export const ISSUED_PLAYLIST_LIMIT = 400;

export function createIssuedPlaylistRegistry({
  ttlMs = ISSUED_PLAYLIST_TTL_MS,
  limit = ISSUED_PLAYLIST_LIMIT,
  now = () => Date.now(),
} = {}) {
  /** key = `<provider>:<playlistId>`，值 = 到期时刻。Map 的插入序就是淘汰序。 */
  const issued = new Map();
  const keyOf = (provider, id) => `${String(provider ?? '').toLowerCase()}:${String(id ?? '').trim()}`;
  const alive = (entry) => entry.expiresAt > now();

  return {
    /** 列出来一次就登记一次；空列表或不认识的形状不登记，也不报错（登记簿不是校验器）。 */
    issue(provider, ids) {
      const list = Array.isArray(ids) ? ids : [];
      for (const raw of list) {
        const id = String(raw ?? '').trim();
        if (!id) continue;
        const key = keyOf(provider, id);
        issued.delete(key);                       // 重新登记要挪到队尾，否则先登记的会先把刚拿到的挤掉
        issued.set(key, { expiresAt: now() + ttlMs });
      }
      while (issued.size > limit) issued.delete(issued.keys().next().value);
      return issued.size;
    },
    /** 写侧那道闸：只认"这台机器最近列出来过"的那几张。 */
    has(provider, id) {
      const key = keyOf(provider, id);
      const entry = issued.get(key);
      if (!entry) return false;
      if (alive(entry)) return true;
      issued.delete(key);                          // 顺手清掉过期的，别让一张长名单一直占位
      return false;
    },
    size() {
      for (const [key, entry] of issued) if (!alive(entry)) issued.delete(key);
      return issued.size;
    },
    clear() { issued.clear(); },
  };
}
