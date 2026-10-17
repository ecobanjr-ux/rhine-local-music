/**
 * Ported from folia-major (https://github.com/chthollyphile/folia-major), AGPL-3.0-only.
 * Upstream file: src/components/shared/GridListSearchButton.tsx @ 369c34e6f83404c65129479e6bd88d70acb0e43e
 * This project is released under AGPL-3.0. Registered rewrites of this file:
 * see NOTICE.md「移植清单（Folia 视图）」 and memory/folia-port-rewrite-log.md.
 */
import React from 'react';
import { motion } from 'framer-motion';
import { Command, List, Search } from 'lucide-react';
// R162（沿用 R8/R48 的 shim 口径）：本仓没有 i18next 依赖，文案一律经自撰的 i18n shim。
import { useTranslation } from '../../i18n/config';
import { openCommandFilter, openCommandPalette } from '../../stores/useAppViewStore';
import { useInteractionSettingsStore } from '../../stores/useInteractionSettingsStore';
import { usePlayerBottomBarBottomPx } from '../../hooks/usePlayerBottomBarBottomPx';
import { SlideActionButton } from './SlideActionButton';

// Player-style grid action button: click for the list, or slide left to reveal search.
//
// Where the slide lands is a setting, so the destination is read here rather than passed in: the
// icon at the end of the track and the tooltip have to name the same place the gesture goes, and
// three grids each remembering to keep those three in step is three chances to get it wrong.
//
// The gesture itself is SlideActionButton, shared with the poster wall.
interface GridListSearchButtonProps {
    isDaylight: boolean;
    accentColor: string;
    listTitle: string;
    /** What the slide is called when it opens this surface's filter, which is the default. */
    searchTitle: string;
    onOpenList: () => void;
}

export const GridListSearchButton: React.FC<GridListSearchButtonProps> = ({
    isDaylight,
    accentColor,
    listTitle,
    searchTitle,
    onOpenList,
}) => {
    const { t } = useTranslation();
    const slideTarget = useInteractionSettingsStore(state => state.gridActionButtonSlideTarget);
    const opensPalette = slideTarget === 'command-palette';
    const bottomBarBottomPx = usePlayerBottomBarBottomPx();

    return (
        <motion.div
            initial={{ opacity: 0, x: 20, y: 12, scale: 0.92 }}
            animate={{ opacity: 1, x: 0, y: 0, scale: 1 }}
            exit={{ opacity: 0, x: 20, y: 12, scale: 0.92 }}
            transition={{ duration: 0.24, ease: 'easeOut' }}
            data-testid="grid-list-search-button"
            style={{ bottom: bottomBarBottomPx }}
            className="pointer-events-auto fixed right-0 z-[60] pr-4 md:pr-8 group w-20 flex justify-end"
        >
            <SlideActionButton
                icon={List}
                title={listTitle}
                onActivate={onOpenList}
                slideIcon={opensPalette ? Command : Search}
                slideTitle={opensPalette ? t('options.gridSlideTargetCommandPalette') : searchTitle}
                onSlide={opensPalette ? openCommandPalette : openCommandFilter}
                isDaylight={isDaylight}
                accentColor={accentColor}
            />
        </motion.div>
    );
};
