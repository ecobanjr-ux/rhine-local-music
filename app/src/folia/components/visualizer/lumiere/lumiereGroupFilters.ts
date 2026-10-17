/**
 * Ported from folia-major (https://github.com/chthollyphile/folia-major), AGPL-3.0-only.
 * Upstream file: src/components/visualizer/lumiere/lumiereGroupFilters.ts @ 369c34e6f83404c65129479e6bd88d70acb0e43e
 * This project is released under AGPL-3.0. Registered rewrites of this file:
 * see NOTICE.md「移植清单（Folia 视图）」 and memory/folia-port-rewrite-log.md.
 */
// Copyright (c) 2026 chthollyphile
import type { Container, Filter } from 'pixi.js';
import type { BloomFilter } from './light/bloomFilter';
import type { BloomPreset } from './types';

// src/components/visualizer/lumiere/lumiereGroupFilters.ts
// 运行时对场景 / 片尾卡的图形组、文字组 filter 做的就地调整：bloom 强度（滑块拖动时不重建场景）、
// 图形组的画质分辨率与相应减掉的 bloom 级数。bloom filter 由场景自己建、自己销毁，这里只改它的参数。

const isBloomFilter = (filter: Filter): filter is BloomFilter => (
    typeof (filter as unknown as Partial<BloomFilter>).options?.strength === 'number'
);

const bloomOf = (group: Container) => (group.filters ?? []).find(isBloomFilter) ?? null;

export interface LumiereGroupQuality {
    preset: BloomPreset;
    /** tuning 里的 bloom 倍率。 */
    multiplier: number;
    /** 这个组的 filter 分辨率；null = 跟随渲染器（满分辨率）。 */
    resolution: number | null;
    /** 相对预设少降几级（见 resolveLumiereBloomLevelDrop）。 */
    levelDrop: number;
    /**
     * 组上没有 bloom（倍率为 0 时场景不挂）但要降分辨率时挂的直通 filter（AlphaFilter，alpha 1），
     * 由运行时持有；传 null 表示不需要。
     */
    passthrough: Filter | null;
}

/** 把画质与 bloom 倍率写到一个组上。重复调用是幂等的。 */
export const applyLumiereGroupQuality = (group: Container, quality: LumiereGroupQuality) => {
    const bloom = bloomOf(group);
    if (bloom) {
        bloom.options.strength = quality.preset.strength * quality.multiplier;
        bloom.options.levels = Math.max(1, quality.preset.levels - quality.levelDrop);
        bloom.resolution = quality.resolution ?? 'inherit';
        return;
    }
    const { passthrough, resolution } = quality;
    if (!passthrough) return;
    const attached = (group.filters ?? []).includes(passthrough);
    if (resolution === null) {
        if (attached) group.filters = [];
        return;
    }
    passthrough.resolution = resolution;
    if (!attached) group.filters = [passthrough];
};

/** 摘掉运行时挂上的直通 filter（场景销毁前调用，免得场景的 destroy 把共享 filter 一起处理掉）。 */
export const detachLumierePassthrough = (group: Container, passthrough: Filter | null) => {
    if (passthrough && (group.filters ?? []).includes(passthrough)) group.filters = [];
};
