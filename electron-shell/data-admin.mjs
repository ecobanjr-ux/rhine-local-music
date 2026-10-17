// R209 · 数据管理两件的**纯逻辑**（托盘那两件）：清空范围、安全闸、确认框文案、完成回执。
// 单独一个模块的理由：自检能直接驱动（不碰 Electron、不碰真实文件系统 —— fs 与 path 都注入）。
import path from 'node:path';

/**
 * **白名单**：清空时只许删这些（相对数据目录的路径）。
 * 用白名单而不是"把目录整个删掉"：数据目录里将来多出什么，也不该被一次点击带走（判据④ 就钉这个形状）。
 * `label` 是确认框里逐项列出来给用户看的说法（口径第 9 条：逐项列出删除范围）。
 */
export const CLEAR_DATA_ENTRIES = [
  { path: 'favorites.json', label: '收藏' },
  { path: 'playlists', label: '歌单（含 .backup 备份）' },
  { path: 'online-session', label: '登录凭据（网易云 / QQ / 酷狗）' },
  { path: 'library-index.json', label: '曲库索引' },
  { path: 'lyrics', label: '歌词缓存' },
  { path: 'artwork', label: '封面缓存' },
  { path: 'config.json', label: '曲库配置（音乐文件夹、各项开关）' },
  { path: 'genre-rules.json', label: '分类归并规则' },
  { path: 'lyric-claims.json', label: '手工指定的歌词' },
  { path: 'player-service.log', label: '运行日志' },
  { path: '.mimosa', label: '在线功能的运行状态' },
  { path: 'shell-profile', label: '浏览器本地偏好与缓存（主题这类设置）' },
];

/** `child` 在不在 `parent` 里面（同一条路径算"在里面"）。两边都先 resolve；空值一律 false。 */
export function isInside(child, parent) {
  if (!child || !parent) return false;
  const rel = path.relative(path.resolve(parent), path.resolve(child));
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

/**
 * 清空计划 = 安全闸 + 待删清单。
 * 三条拒绝（宁可不清，也不许删错）：
 *  ① 数据目录没解析出来（开发形态直启，壳没有独立数据目录）⇒ 不清；
 *  ② **有曲库根落在数据目录里面** ⇒ 不清（那会连音乐文件一起删 —— 判据④ 的另一半）；
 *  ③ 数据目录与**程序目录**互相包含（配置错了）⇒ 不清（避免把程序删掉）。
 */
export function clearDataPlan({ dataDir, libraryRoots = [], programDirs = [], fs }) {
  if (!dataDir) return { allowed: false, reason: 'no-data-dir', targets: [] };
  for (const root of libraryRoots) {
    if (isInside(root, dataDir)) return { allowed: false, reason: 'library-inside-data-dir', detail: root, targets: [] };
  }
  for (const dir of programDirs) {
    if (!dir) continue;
    if (isInside(dir, dataDir) || isInside(dataDir, dir)) return { allowed: false, reason: 'overlaps-program-dir', detail: dir, targets: [] };
  }
  const targets = CLEAR_DATA_ENTRIES.filter((entry) => {
    try { return fs.existsSync(path.join(dataDir, entry.path)); } catch { return false; }
  });
  return { allowed: true, targets };
}

/** 确认框（口径第 9 条）：原生二次确认 + 逐项列出 + 明写"你的音乐文件不会被删"。 */
export function clearDataConfirmDialog({ dataDir, targets, libraryRoots = [], onBattery = false }) {
  const items = targets.map((entry) => `· ${entry.label}`).join('\n');
  const roots = libraryRoots.length
    ? `曲库目录（${libraryRoots.join('；')}）只读不碰，清空之后照样能重新扫描`
    : '曲库目录只读不碰，清空之后照样能重新扫描';
  const battery = onBattery ? '\n\n注意：这台机器正在用电池，清空之后第一次打开会重新扫描一遍曲库。' : '';
  return {
    type: 'warning',
    title: '清空全部数据？',
    message: '清空全部数据？',
    detail: `会删掉 ${dataDir} 里的这些东西（删了就不能撤销）：\n${items}\n\n`
      + `你的音乐文件不会被删 —— ${roots}。`
      + `\n\n清空之后会退出登录（登录凭据也在上面那份清单里）。${battery}`,
    buttons: ['取消', '清空全部数据'],
    defaultId: 0,
    cancelId: 0,
  };
}

/** 完成回执：删了什么、没删动什么、有没有留下不认识的东西（都不许静默）。 */
export function clearDataSummary({ removed = [], failed = [], leftover = [] }) {
  const lines = [];
  lines.push(removed.length ? `已清空：${removed.join('、')}。` : '没有需要清空的文件。');
  if (failed.length) lines.push(`这些没能删掉（可能被占用）：${failed.join('、')} —— 关掉播放器再试一次。`);
  if (leftover.length) lines.push(`数据目录里还有 ${leftover.length} 项不认识的内容，没有动它们。`);
  lines.push(failed.length ? '登录凭据可能还在，退出播放器后再清一次。' : '已退出登录。');
  return lines.join('\n');
}

/** 曲库根（壳读 `<dataDir>/config.json` 拿，用来做安全闸 —— 零新通道）。读不到就当没有。 */
export function libraryRootsFromConfig(fs, dataDir) {
  try {
    const raw = fs.readFileSync(path.join(dataDir, 'config.json'), 'utf8');
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed?.roots) ? parsed.roots.filter((r) => typeof r === 'string') : [];
  } catch {
    return [];
  }
}

/**
 * R216：「清空」那条路的**参数组装 · 唯一接线**。从前这段住在 `main.mjs` 的 `clearAllData()` 里，
 * 其中拼 `programDirs` 那一行用了 CJS 的目录变量 ⇒ `.mjs`（ESM）里当场 ReferenceError：**点了就崩**
 *（真机抓的 P1；R209 验收早就点名"清空的接线从没端到端跑过"）。抽到这里的两个理由：
 *  ① 组装**可测** —— 真目录夹具直接驱动**这条接线**（缺陷位置正好在 `clearDataPlan` 的上游，只测它拦不住）；
 *  ② `main.mjs` 只管"调它 + 弹框 + 删除 + 回执"，不再内联拼参数。
 */
export function clearPlanFor({ dataDir, libraryRoots = [], programDirs = [], fs }) {
  return clearDataPlan({ dataDir, libraryRoots, programDirs, fs });
}
