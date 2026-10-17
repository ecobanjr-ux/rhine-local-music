// 本项目自撰（非移植代码）。歌词「手动认领」记录（R144 · 夜间批任务五）。
//
// 这份记录解决的是一个具体的死结：自动挡阈值 75 分没错，但真有一批歌停在 70 分
// （曲名歌手逐字一致、专辑那一维 0 分），机器不许，人就永远听不到词。出路不是把阈值往下调
// （那会让"宁可无词不错配"这条定案失效），而是**把最后那一格交给人**：
// 机器把 60~74 分的近候选列出来，人挑一条并说"就它"。于是这里存的就是"就它"那一句话。
//
// 三条形状，都写在这里以免后来被顺手改掉：
//   ① **只存身份，绝不存歌词正文**。文件里是"哪一家的哪一首被认下来了"（provider + 曲目标识 +
//      取词要的 accessKey + 给人看的曲名歌手专辑时长）。正文仍然每次现取现用——
//      设置面板那句"不保存歌词到磁盘"因此继续是真的，这份文件不是它的例外。
//   ② **单独一份文件，不污染自动挡的任何判据与缓存**。正/负缓存、sidecar、阈值、逐字优先
//      一个字都不动；认领只在"人已经判过了"那条路上生效，取词之后的判定（计时行门槛、
//      实体声明拒绝）与自动挡共用同一份。
//   ③ 键是 `online-lyrics.mjs` 那个指纹（曲名/歌手/专辑/整秒时长），**由调用方传进来**，
//      这里不另算一份——两处各算一次迟早漂。
//
// 写盘走 `writeJsonAtomic`（全仓唯一的 JSON 原子写），并且读-改-写串行（连点两下不该丢一次）。
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { hash, writeJsonAtomic } from './music-library.mjs';
import { LYRIC_SEARCH_SOURCES } from './online-match-score.mjs';

export const LYRIC_CLAIMS_FILE = 'lyric-claims.json';
export const LYRIC_CLAIMS_VERSION = 1;
/** 上限与"看得见的一件事"同档：到量了如实拒绝，不静默淘汰任何一条认领。 */
export const MAX_LYRIC_CLAIMS = 2000;

const ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
const ACCESS_KEY_PATTERN = /^[A-Za-z0-9_-]{0,160}$/;
const KEY_PATTERN = /^[a-f0-9]{24}$/;
const TEXT_LIMIT = 160;
const DURATION_LIMIT_MS = 3_600_000;

/**
 * 文件里的键 = 指纹的哈希（与 sidecar / 收藏同一把 `hash`，不另起一套）。
 * 调用方一律传 `online-lyrics.mjs` 那个指纹，换算只这一处：
 * 指纹里有 `\0` 与用户原文，直接当文件名键会把 NUL 写进 JSON；而"这条是给哪首歌认的"
 * 由条目里的 `track` 快照说得出，不需要靠键本身可读。
 */
export const claimKeyOf = (fingerprint) => hash(String(fingerprint ?? ''));

/** 外部输入 → 可落盘的认领条目。任何一项不合格就返回 `{error}`，调用方据此一个字都不写。 */
export function claimEntryFrom(value) {
  const text = (field, { required = true } = {}) => {
    const item = value?.[field];
    if (item === undefined || item === null || item === '') return required ? null : '';
    if (typeof item !== 'string') return null;
    const trimmed = item.trim();
    if (!trimmed || trimmed.length > TEXT_LIMIT) return null;
    return trimmed;
  };
  const provider = text('provider');
  if (!provider || !LYRIC_SEARCH_SOURCES.includes(provider)) {
    return { error: `认领的来源只认 ${LYRIC_SEARCH_SOURCES.join('/')}（AMLL 是按 QQ 曲目 id 索引的兜底库，不能单独认领）` };
  }
  const sourceId = text('sourceId');
  if (!sourceId || !ID_PATTERN.test(sourceId)) return { error: '认领记录里的曲目标识形状不对' };
  const accessKey = typeof value?.accessKey === 'string' ? value.accessKey.trim() : '';
  if (!ACCESS_KEY_PATTERN.test(accessKey)) return { error: '认领记录里的取词令牌形状不对' };
  const title = text('title');
  const artist = text('artist');
  if (!title || !artist) return { error: '认领记录必须带上候选的曲名与歌手（界面上要说得出选了哪一首）' };
  const album = text('album', { required: false });
  if (album === null) return { error: '专辑名过长或不是文本' };
  const durationMs = Number(value?.durationMs ?? 0);
  if (!Number.isFinite(durationMs) || durationMs < 0 || durationMs > DURATION_LIMIT_MS) return { error: '时长不合法' };
  const score = Number(value?.score ?? 0);
  if (!Number.isFinite(score) || score < 0 || score > 100) return { error: '分数不合法（认领时那条候选的读数）' };
  return {
    entry: {
      provider, sourceId, accessKey, title, artist, album,
      durationMs: Math.round(durationMs), score: Math.round(score),
    },
  };
}

/** 本地那首歌的身份快照（只为让清单与界面说得出"这条是给哪首歌认的"）。 */
export function claimTrackSnapshotFrom(track) {
  const text = (field) => {
    const item = track?.[field];
    return typeof item === 'string' && item.trim() && item.trim().length <= TEXT_LIMIT ? item.trim() : '';
  };
  const duration = Number(track?.durationMs ?? (Number(track?.duration ?? 0) * 1000));
  return {
    title: text('title'), artist: text('artist'), album: text('album'),
    durationMs: Number.isFinite(duration) ? Math.round(duration) : 0,
  };
}

export function createLyricClaims({ dataDir, now = () => new Date().toISOString(), log = () => {}, limit = MAX_LYRIC_CLAIMS } = {}) {
  /**
   * 没有数据目录 ⇒ 这一份记录**无处可写**（不是"写到进程当前目录"——那是把用户数据丢进一个没人知道的地方）。
   * 注入假曲库的自检走的正是这一档：读当作空、写如实拒绝。
   */
  const fileOf = () => (dataDir ? path.join(String(dataDir), LYRIC_CLAIMS_FILE) : null);
  let chain = Promise.resolve();
  /** 串行链必须"永不卡死"：前一个任务成功还是抛错都往下接（favorites 那一份的同款纪律）。 */
  const serialized = (task) => {
    const run = chain.then(task, task);
    chain = run.then(() => undefined, () => undefined);
    return run;
  };

  /** 坏了 / 版本不认识 / 形状不对 ⇒ 当没有，重建而不是崩（与 sidecar 同一条处置）。 */
  async function read() {
    const empty = { version: LYRIC_CLAIMS_VERSION, entries: {} };
    const target = fileOf();
    if (!target) return empty;
    let parsed;
    try {
      parsed = JSON.parse(await fs.readFile(target, 'utf8'));
    } catch {
      return empty;
    }
    if (!parsed || typeof parsed !== 'object' || parsed.version !== LYRIC_CLAIMS_VERSION) return empty;
    if (!parsed.entries || typeof parsed.entries !== 'object' || Array.isArray(parsed.entries)) return empty;
    // 逐条再认一次形状：这文件用户能自己打开改，一个野值不该变成一次出网。
    const entries = {};
    for (const [key, value] of Object.entries(parsed.entries)) {
      if (typeof key !== 'string' || !KEY_PATTERN.test(key)) continue;
      const { entry, error } = claimEntryFrom(value);
      if (error) continue;
      entries[key] = { ...entry, ...(value?.track ? { track: value.track } : {}), ...(value?.claimedAt ? { claimedAt: String(value.claimedAt) } : {}) };
    }
    return { version: LYRIC_CLAIMS_VERSION, updatedAt: parsed.updatedAt, entries };
  }

  return {
    file: fileOf,
    read,
    async get(fingerprint) {
      if (!fingerprint) return null;
      const data = await read();
      return data.entries[claimKeyOf(fingerprint)] ?? null;
    },
    /** 清单（界面与日志用）：按认领时间倒序，条目里带着"给哪首歌认的"。 */
    async list() {
      const data = await read();
      return Object.entries(data.entries)
        .map(([key, entry]) => ({ key, ...entry }))
        .sort((a, b) => String(b.claimedAt ?? '').localeCompare(String(a.claimedAt ?? '')));
    },
    /**
     * 写一条认领。返回**报告**（写了什么、是不是替换、现在共几条、文件在哪），
     * 校验不过或到上限 ⇒ 一个字都不写并说清为什么。
     */
    put(fingerprint, value, { track } = {}) {
      return serialized(async () => {
        if (typeof fingerprint !== 'string' || !fingerprint.trim()) {
          return { ok: false, error: '缺少曲目指纹，没有写入任何记录' };
        }
        const { entry, error } = claimEntryFrom(value);
        if (error) return { ok: false, error };
        if (!fileOf()) return { ok: false, error: '本服务没有数据目录：认领记录无处可写（歌词仍按自动匹配的结果显示）' };
        const key = claimKeyOf(fingerprint);
        const data = await read();
        const existed = Boolean(data.entries[key]);
        const total = Object.keys(data.entries).length;
        if (!existed && total >= limit) {
          return { ok: false, error: `认领记录已到上限 ${limit} 条，先取消一些再认领（不静默淘汰任何一条）` };
        }
        const record = { ...entry, track: claimTrackSnapshotFrom(track), claimedAt: now() };
        data.entries[key] = record;
        data.updatedAt = now();
        await writeJsonAtomic(fileOf(), data);
        log(`歌词认领已记录：《${entry.title}》/ ${entry.artist} ← ${entry.provider}（${existed ? '替换原有那一条' : '新增'}，共 ${total + (existed ? 0 : 1)} 条）`);
        return { ok: true, replaced: existed, total: total + (existed ? 0 : 1), file: LYRIC_CLAIMS_FILE, entry: record };
      });
    },
    clear(fingerprint) {
      return serialized(async () => {
        if (typeof fingerprint !== 'string' || !fingerprint.trim()) {
          return { ok: false, error: '缺少曲目指纹，没有改动任何记录' };
        }
        const key = claimKeyOf(fingerprint);
        const data = await read();
        if (!data.entries[key]) return { ok: true, removed: false, total: Object.keys(data.entries).length, file: LYRIC_CLAIMS_FILE };
        if (!fileOf()) return { ok: false, error: '本服务没有数据目录：没有可取消的记录' };
        const gone = data.entries[key];
        delete data.entries[key];
        data.updatedAt = now();
        await writeJsonAtomic(fileOf(), data);
        log(`歌词认领已取消：《${gone.title ?? ''}》（共 ${Object.keys(data.entries).length} 条）`);
        return { ok: true, removed: true, total: Object.keys(data.entries).length, file: LYRIC_CLAIMS_FILE };
      });
    },
  };
}

/**
 * R148（Q20）· 近候选的**认领令牌**注册表：`accessKey` 出浏览器之前换成不透明 token。
 *
 * 形状与在线曲目封面的注册表同构（R116）：浏览器拿到的是一条 16 位十六进制，
 * 反推不出原始身份；认领时把 token 送回来，服务端查回真身份再用。
 * 为什么要这一层：`accessKey` 是酷狗那一路取词要用的每首令牌，它不是账号凭据，
 * 但"能取词的钥匙"没必要出现在浏览器与 DOM 里 —— 与"第三方封面地址不进 DOM"是同一条红线，
 * 只是这一格此前漏了（R144 的评审里验收侧点出来，本批补上）。
 *
 * 三条硬规矩：
 *   ① **内存注册表，零写盘**：进程重启后旧 token 解不出来，认领如实失败并提示"重新点一次重试"，
 *      不许拿一个解不出来的 token 去凑（那等于允许客户端伪造身份认领）；
 *   ② token 由身份**决定**（同一条候选重复签发得到同一个 token）⇒ 反复刷新列表不会把注册表撑爆；
 *   ③ 有界淘汰（按插入顺序），不做无界增长。
 */
export const CLAIM_TOKEN_PATTERN = /^[a-f0-9]{16}$/;
export const CLAIM_TOKEN_REGISTRY_MAX = 400;

export function createClaimTokenRegistry({ max = CLAIM_TOKEN_REGISTRY_MAX } = {}) {
  const byToken = Object.create(null);
  const order = [];
  const tokenOf = (identity) => createHash('sha256')
    .update([String(identity?.provider ?? ''), String(identity?.sourceId ?? ''), String(identity?.accessKey ?? '')].join('\u0000'))
    .digest('hex').slice(0, 16);
  return {
    /** 登记一条候选身份，返回给它的不透明 token。 */
    issue(identity) {
      const token = tokenOf(identity);
      if (!byToken[token]) {
        byToken[token] = { provider: String(identity.provider), sourceId: String(identity.sourceId), accessKey: String(identity.accessKey ?? '') };
        order.push(token);
        while (order.length > max) delete byToken[order.shift()];
      }
      return token;
    },
    /** 只有形状对且登记过才回身份；否则 null（调用方据此拒绝，不猜）。 */
    resolve(token) {
      return CLAIM_TOKEN_PATTERN.test(String(token ?? '')) ? byToken[token] ?? null : null;
    },
    size: () => order.length,
    clear() { for (const t of order) delete byToken[t]; order.length = 0; },
  };
}
