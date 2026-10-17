// R204（Electron 壳最小件）· 单实例的判定（纯函数）。
//
// Task 0 在 Windows 上实测的形状：
//   第一个进程 `requestSingleInstanceLock() === true` ⇒ 照常建窗建托盘；
//   第二个进程 `=== false` ⇒ **不建窗、不建托盘、不注册全局键**，直接退出；
//   第一个进程收到 `second-instance` ⇒ 只做一件事：把已有窗口带回前台（沿上游 main.cjs:1537 那一格）。
// 第二实例的命令行**不读**：实测 argv 里被 Electron 塞了自己的开关（`--allow-file-access-from-files`），
// 拿 argv 当用户参数会读到平台噪声。

export function decideStartup({ gotLock }) {
  return gotLock ? 'continue' : 'quit-duplicate';
}

export function describeSecondInstance() {
  return { action: 'activate' };
}
