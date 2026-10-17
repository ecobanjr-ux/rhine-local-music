/**
 * R43 自撰 stub：视频叠加层的本地文件选取（上游用 File System Access API 取一个视频文件并
 * 把 handle 存进 IndexedDB，供视觉模式当背景）。本产品不暴露该入口：能力探测恒 false、
 * 选取恒取消、句柄读写恒空，因此 `VideoLayer` 渲染空、设置项显示"未选择文件"。
 * 消费方：stores/useVideoLayerSettingsStore.ts、components/visualizer/videoLayer/VideoLayer.tsx。
 * 本文件为本项目自撰（AGPL-3.0-only），替代上游同名文件；见移植台账对应 R 条。
 */
export type PickedVideoFile = {
  file: File;
  handle: FileSystemFileHandle | null;
};

export type VideoLayerFileReadResult =
  | { status: 'ready'; file: File }
  | { status: 'needs-permission' }
  | { status: 'missing' };

export const canPersistVideoLayerFile = (): boolean => false;

export const pickVideoLayerFile = async (): Promise<PickedVideoFile | null> => null;

export const saveVideoLayerFileHandle = (_handle: FileSystemFileHandle): void => {};

export const loadVideoLayerFileHandle = async (): Promise<FileSystemFileHandle | null> => null;

export const clearVideoLayerFileHandle = async (): Promise<void> => {};

export const readVideoLayerFileHandle = async (
  _handle: FileSystemFileHandle,
  _request: boolean,
): Promise<VideoLayerFileReadResult> => ({ status: 'missing' });
