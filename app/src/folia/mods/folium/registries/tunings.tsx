/**
 * R41 自撰 stub：Folium 模组调参注册表。上游让第三方模组能注册可视参数倍率，
 * 本产品不带模组平台（同第一期 R14 与第二期 R25 的口径），倍率一律返回 identity。
 * 消费方：sonnet/lumiere 的 Visualizer*（`useFoliumTunings(mode)`）。
 * 本文件为本项目自撰（AGPL-3.0-only），替代上游同名文件；见移植台账对应 R 条。
 */
export interface StoredFoliumTuning {
  modId: string;
  target: string;
  key: string;
  value: number;
}

const IDENTITY: Readonly<Record<string, number>> = Object.freeze({});

export const tuningsRegistry = {
  register: (_modId: string, _def: unknown) => () => {},
  list: () => [] as { modId: string; def: unknown }[],
};

export const readFoliumTunings = (_target: string): Readonly<Record<string, number>> => IDENTITY;
export const useFoliumTunings = (_target: string): Readonly<Record<string, number>> => IDENTITY;
export const FoliumTuningCards = (_props: unknown): null => null;
