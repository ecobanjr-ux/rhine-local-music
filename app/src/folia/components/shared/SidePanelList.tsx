/**
 * 本文件为本项目自撰（AGPL-3.0-only），替代上游同名文件；见移植台账 R163。
 * R163 自撰薄层（本项目自撰，AGPL-3.0-only）：替代上游 components/shared/SidePanelList.tsx。
 *
 * 唯一的差异是**虚拟化**：上游用 `react-window`（`List` + `scrollToRow`），那是一个新 npm 依赖，
 * 本批的纪律是"新增依赖一律停下记待确认"（夜间准则二），所以这里换成普通滚动容器 +
 * `scrollTop` 定位。对外契约（`SidePanelListProps` 的每一格、`TrackListItem`、`CollectionListItem`
 * 的 props 与类名、动画参数、`data-testid`）逐字照抄上游，调用方（移植件 ArtistGridView）不需要改一行。
 *
 * 观感代价（如实登记）：行高仍是常量 `itemHeight`，滚动位置按 `focusedIndex * itemHeight` 算；
 * 上游"首次打开先跳前 8 行再平滑居中"那段两跳效果保留。差别只在**超长列表**的滚动性能——
 * 本视图的行长是"一位音乐人的专辑数"（在线组受服务端上限约束、本地受曲库规模约束，量级为几十），
 * 虚拟化的收益在这里测不出来。要不要为它批准 react-window，列进待确认。见移植台账 R163。
 */
import React, { useEffect, useRef, useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { X, Play, Plus } from 'lucide-react';
import { useTranslation } from '../../i18n/config';
import { getSizedCoverUrl } from '../../utils/coverUrl';
import { getSongArtistLabel, getSongCoverUrl } from '../../services/onlineMusic/songMetadata';
import { useSidePanelBottomPx } from '../../hooks/usePlayerBottomBarBottomPx';

export interface SidePanelListProps<T> {
    isOpen: boolean;
    onClose: () => void;
    title: string;
    items: T[];
    renderItem: (item: T, index: number, style: React.CSSProperties) => React.ReactNode;
    itemHeight: number;
    isDaylight: boolean;
    focusedIndex?: number;
    hideTitle?: boolean;
    headerLeadingActions?: React.ReactNode;
    headerActions?: React.ReactNode;
}

export function SidePanelList<T>({
    isOpen,
    onClose,
    title,
    items,
    renderItem,
    itemHeight,
    focusedIndex,
    hideTitle = false,
    headerLeadingActions,
    headerActions,
}: SidePanelListProps<T>) {
    const { t } = useTranslation();
    const scrollRef = useRef<HTMLDivElement>(null);
    const bottomBarBottomPx = useSidePanelBottomPx();
    const [listHeight, setListHeight] = useState(400);
    const containerRef = useRef<HTMLDivElement>(null);

    useEffect(() => {
        if (!isOpen || !containerRef.current) return;
        const el = containerRef.current;
        setListHeight(el.clientHeight);
        const observer = new ResizeObserver(() => setListHeight(el.clientHeight));
        observer.observe(el);
        return () => observer.disconnect();
    }, [isOpen]);

    const lastScrollTargetRef = useRef<number | null>(null);

    // 与上游同一套两跳：第一次打开从目标前 8 行起步，再平滑居中；后续直接平滑滚到目标。
    useEffect(() => {
        if (isOpen && focusedIndex !== undefined && scrollRef.current) {
            const isInitialOpen = lastScrollTargetRef.current === null;
            const delay = isInitialOpen ? 50 : 350;
            const timer = setTimeout(() => {
                const box = scrollRef.current;
                if (!box) return;
                const jumpTop = Math.max(0, (focusedIndex - 8)) * itemHeight;
                const targetTop = focusedIndex * itemHeight - Math.max(0, (box.clientHeight - itemHeight) / 2);
                if (isInitialOpen) {
                    box.scrollTop = jumpTop;
                    setTimeout(() => box.scrollTo({ top: targetTop, behavior: 'smooth' }), 50);
                } else {
                    box.scrollTo({ top: targetTop, behavior: 'smooth' });
                }
                lastScrollTargetRef.current = focusedIndex;
            }, delay);
            return () => clearTimeout(timer);
        } else if (!isOpen) {
            lastScrollTargetRef.current = null;
        }
    }, [isOpen, focusedIndex, itemHeight]);

    return (
        <AnimatePresence>
            {isOpen && (
                <motion.div
                    initial={{ opacity: 0, x: 60, scale: 0.95 }}
                    animate={{ opacity: 1, x: 0, scale: 1 }}
                    exit={{ opacity: 0, x: 60, scale: 0.95 }}
                    transition={{ duration: 0.35, ease: [0.16, 1, 0.3, 1] }}
                    data-testid="side-panel-list"
                    className="absolute right-6 top-24 w-80 max-w-[calc(100vw-3rem)] rounded-3xl z-[80] flex flex-col p-6 shadow-2xl border backdrop-blur-2xl pointer-events-auto theme-glass-panel"
                    style={{
                        bottom: bottomBarBottomPx,
                        boxShadow: '0 8px 32px 0 rgba(0, 0, 0, 0.2)',
                        color: 'var(--text-primary)'
                    }}
                >
                    <div className="flex items-center justify-between gap-2 mb-4 shrink-0">
                        <div className="min-w-0 flex-1">
                            {headerLeadingActions}
                            {!hideTitle && (
                                <h3 className="font-bold text-lg tracking-tight truncate pr-2">
                                    {title}
                                </h3>
                            )}
                        </div>
                        <div className="flex items-center gap-1 shrink-0">
                            {headerActions}
                            <button
                                onClick={onClose}
                                className="p-1.5 rounded-full hover:bg-black/10 dark:hover:bg-white/10 transition-colors"
                            >
                                <X size={18} />
                            </button>
                        </div>
                    </div>

                    <div ref={containerRef} className="flex-1 overflow-hidden relative rounded-xl">
                        {items.length === 0 ? (
                            <div className="absolute inset-0 flex items-center justify-center opacity-50 text-sm">
                                {t('home.loadingLibrary') || 'No items'}
                            </div>
                        ) : (
                            <div
                                ref={scrollRef}
                                style={{ height: listHeight, width: '100%' }}
                                className="overflow-y-auto overflow-x-hidden custom-scrollbar"
                            >
                                {items.map((item, index) => renderItem(item, index, {
                                    height: itemHeight,
                                    width: '100%',
                                }))}
                            </div>
                        )}
                    </div>
                </motion.div>
            )}
        </AnimatePresence>
    );
}

// 行组件与上游逐字一致（只是不再由虚拟列表按视口取行）。
export const TrackListItem = React.memo<{
    track: any;
    index: number;
    style: React.CSSProperties;
    onPlay: () => void;
    onAddToQueue?: () => void;
    isUnavailable?: boolean;
    isActive?: boolean;
    albumTrackLabel?: string | null;
}>(({ track, style, onPlay, onAddToQueue, isUnavailable, isActive, albumTrackLabel }) => {
    const { t } = useTranslation();
    const coverUrl = getSongCoverUrl(track) || '';
    const artistName = getSongArtistLabel(track).split(',')[0]?.trim() || 'Unknown Artist';

    return (
        <div
            style={style}
            className="px-2 py-1"
        >
            <div
                onClick={isUnavailable ? undefined : onPlay}
                className={`flex items-center gap-3 p-2 rounded-lg transition-colors w-full h-full ${
                    isUnavailable
                        ? 'opacity-40 cursor-not-allowed'
                        : isActive
                            ? 'bg-black/10 dark:bg-white/10 cursor-pointer group'
                            : 'hover:bg-black/5 dark:hover:bg-white/5 cursor-pointer group'
                }`}
            >
                <div className="relative w-10 h-10 shrink-0 rounded overflow-hidden bg-zinc-200 dark:bg-zinc-800">
                    {coverUrl && (
                        <img
                            src={getSizedCoverUrl(coverUrl, 50)}
                            alt={track.name}
                            className="w-full h-full object-cover"
                            loading="lazy"
                        />
                    )}
                    {!isUnavailable && (
                        <div className="absolute inset-0 bg-black/40 flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity">
                            <Play size={16} className="text-white fill-white ml-0.5" />
                        </div>
                    )}
                </div>
                <div className="flex flex-col min-w-0 flex-1 justify-center">
                    <div className="flex min-w-0 items-baseline gap-1.5 leading-tight">
                        <span className="text-sm font-semibold truncate">{track.name}</span>
                        {albumTrackLabel && (
                            <span className="shrink-0 text-[10px] font-medium tabular-nums opacity-45">
                                {albumTrackLabel}
                            </span>
                        )}
                    </div>
                    <div className="text-[10px] opacity-60 truncate leading-tight mt-0.5">{artistName}</div>
                </div>
                {!isUnavailable && onAddToQueue && (
                    <button
                        onClick={(e) => {
                            e.stopPropagation();
                            onAddToQueue();
                        }}
                        className="p-2 ml-1 rounded-full hover:bg-black/10 dark:hover:bg-white/10 opacity-0 group-hover:opacity-100 transition-all shrink-0"
                        title={t('navidrome.addToQueue')}
                        style={{ color: 'var(--text-secondary)' }}
                    >
                        <Plus size={16} />
                    </button>
                )}
            </div>
        </div>
    );
});

export const CollectionListItem = React.memo<{
    item: any;
    index: number;
    style: React.CSSProperties;
    onClick: () => void;
    isActive?: boolean;
}>(({ item, style, onClick, isActive }) => {
    return (
        <div
            style={style}
            className="px-2 py-1"
        >
            <div
                onClick={onClick}
                className={`flex items-center gap-3 p-2 rounded-lg transition-colors w-full h-full ${
                    isActive
                        ? 'bg-black/10 dark:bg-white/10 cursor-pointer group'
                        : 'hover:bg-black/5 dark:hover:bg-white/5 cursor-pointer group'
                }`}
            >
                <div className="w-10 h-10 shrink-0 rounded overflow-hidden bg-zinc-200 dark:bg-zinc-800 relative">
                    {item.coverUrl && (
                        <img
                            src={getSizedCoverUrl(item.coverUrl, 512)}
                            alt={item.name}
                            className="w-full h-full object-cover"
                            loading="lazy"
                        />
                    )}
                </div>
                <div className="flex flex-col min-w-0 flex-1 justify-center">
                    <div className="text-sm font-semibold truncate leading-tight">{item.name}</div>
                    {item.description && (
                        <div className="text-[10px] opacity-60 truncate leading-tight mt-0.5">{item.description}</div>
                    )}
                </div>
            </div>
        </div>
    );
});
