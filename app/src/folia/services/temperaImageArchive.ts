/**
 * R45 自撰 stub：tempera 图片池的归档导入/导出（上游用 fflate 打一个 zip 在设备间搬素材）。
 * 与 R44 同一决定：本产品不搬素材管理，导出/导入都返回"空池"结果，导入菜单因此恒显示 0 张。
 * 类型面逐字对齐上游 services/temperaImageArchive.ts:62-82（消费方读 exported/skipped/truncated）。
 * 消费方：components/visualizer/tempera/TemperaImageLayerControls.tsx。
 * 本文件为本项目自撰（AGPL-3.0-only），替代上游同名文件；见移植台账对应 R 条。
 */
import type { TemperaLayerImage } from "../types";

export class TemperaArchiveTooLargeError extends Error {
  constructor(message = 'tempera image archive is not supported') {
    super(message);
    this.name = 'TemperaArchiveTooLargeError';
  }
}

export interface TemperaImagePoolSnapshot {
  layerImages: TemperaLayerImage[];
}

export interface TemperaImageArchiveExportResult {
  blob: Blob;
  exported: number;
  skipped: number;
}

export interface TemperaImageArchiveImportResult {
  layerImages: TemperaLayerImage[];
  skipped: number;
  truncated: number;
}

export const createTemperaImageArchive = async (
  snapshot: TemperaImagePoolSnapshot,
): Promise<TemperaImageArchiveExportResult> => ({
  blob: new Blob([], { type: 'application/zip' }),
  exported: 0,
  skipped: snapshot?.layerImages?.length ?? 0,
});

export interface TemperaImageArchiveImportOptions {
  existing?: TemperaLayerImage[];
  signal?: AbortSignal;
}

export const readTemperaImageArchiveFile = async (
  _file: File,
  _options?: TemperaImageArchiveImportOptions,
): Promise<TemperaImageArchiveImportResult> => ({ layerImages: [], skipped: 0, truncated: 0 });
