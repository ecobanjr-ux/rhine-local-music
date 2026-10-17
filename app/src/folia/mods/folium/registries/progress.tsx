/**
 * R25 自撰 stub：替代上游 Folium 模组平台的进度条注册表（mods 子系统不移植）。
 * 槽位组件渲染 null，上下文为空对象，ProgressBar 行为退化为纯上游默认实现。
 * 本文件为本项目自撰（AGPL-3.0-only），替代上游同名文件；见移植台账对应 R 条。
 */
import React from "react";
export interface FoliumProgressContext { [key: string]: unknown }
export const useFoliumProgressContext = (_params?: unknown): FoliumProgressContext => ({});
export const FoliumControlButtonSlot: React.FC<{ slot: string; ctx?: FoliumProgressContext; collapsed?: boolean }> = () => null;
export const FoliumProgressLayers: React.FC<{ ctx?: FoliumProgressContext }> = () => null;
