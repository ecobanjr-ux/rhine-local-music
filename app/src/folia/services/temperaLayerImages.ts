/**
 * R44 自撰 stub：tempera 的自定义图层图片池（上游存 IndexedDB，供 OBS 覆盖层贴角色图）。
 * 本产品不搬这套素材管理：读取恒空、写入 no-op，tempera 因此只用内置 composition
 * （`tempera/compositions/*` 全部照常移植）。T4 有"图片池为空时不报错"的实测断言。
 * 消费方：VisualizerTempera、TemperaImageLayer*、useTemperaLayerImageThumbnails。
 * 本文件为本项目自撰（AGPL-3.0-only），替代上游同名文件；见移植台账对应 R 条。
 */
export interface StoredTemperaLayerImage {
  id: string;
  name: string;
  mimeType: string;
  blob: Blob;
  thumbnail?: Blob;
}

/** 与上游同形：只读 placements 的 id，返回 id → Blob 的映射（恒空）。 */
type PlacementLike = { id: string };

/**
 * R201：这个池在本产品里**永远装不进任何东西**（上面那条 stub 就是全部实现）⇒ 消费方据此
 * 把那一整组控件（添加/导入/导出/清空/拖放）**隐藏**并说明实话，而不是让用户点一颗永远 0/16 的按钮。
 * 单一出处：渲染侧不许自己判断"池是不是可用"（那会变成第二个真相）。
 */
export const TEMPERA_LAYER_IMAGE_POOL_AVAILABLE = false;

export const isSupportedTemperaLayerImageFile = (_file: unknown): boolean => false;

export const getTemperaLayerImage = async (_id: string): Promise<StoredTemperaLayerImage | null> => null;

export const saveTemperaLayerImage = async (_image: StoredTemperaLayerImage): Promise<void> => {};

export const clearTemperaLayerImage = async (_id: string): Promise<void> => {};

export const buildStoredTemperaLayerImage = (_file: File): StoredTemperaLayerImage | null => null;

export const createTemperaLayerImageThumbnail = async (_blob: Blob): Promise<Blob | null> => null;

export const prepareTemperaLayerImage = async (_file: File): Promise<StoredTemperaLayerImage | null> => null;

export const loadTemperaLayerImageThumbnails = async (
  _placements: PlacementLike[],
): Promise<Map<string, Blob>> => new Map();

export const loadTemperaLayerImageBlobs = async (
  _placements: PlacementLike[],
): Promise<Map<string, Blob>> => new Map();
