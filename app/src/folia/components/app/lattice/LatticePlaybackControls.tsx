/**
 * Ported from folia-major (https://github.com/chthollyphile/folia-major), AGPL-3.0-only.
 * Upstream file: src/components/app/lattice/LatticePlaybackControls.tsx @ 369c34e6f83404c65129479e6bd88d70acb0e43e
 * This project is released under AGPL-3.0. Registered rewrites of this file:
 * see NOTICE.md「移植清单（Folia 视图第一期）」 and memory/folia-port-rewrite-log.md.
 */
import { motionValue } from 'framer-motion';
import { ArrowUpRight, Pause, Play } from 'lucide-react';
import { useTranslation } from '../../../i18n/config';
import ProgressBar from '../../ProgressBar';
import { PlayerState } from '../../../types';
import { getPlaybackSongKey } from '../../../utils/appPlaybackGuards';
import { useLatticeTransport } from './LatticeTransportContext';
import type { LatticeTile } from './latticeModel';
import LatticeChromeTime from './LatticeChromeTime';
import LatticeExtraControls from './LatticeExtraControls';
// R126（本项目自撰的那一颗按钮，逻辑全在宿主）：只在这首在线曲目没有封面时出现。
import LatticeCoverRetry from '../../../../folia-host/LatticeCoverRetry';
import './LatticeChrome.css';

// Adapts the shared Player Chrome transport and progress bar to one expanded wall tile.

type LatticePlaybackControlsProps = {
    revealed: boolean;
    tile: LatticeTile;
    onPlay: (tile: LatticeTile) => void;
    onTogglePlayback: () => void;
    onSeek: (time: number) => void;
    onOpenPlayer: () => void;
};

const idleTime = motionValue(0);
const ignoreSeek = () => { };

export default function LatticePlaybackControls({
    revealed,
    tile,
    onPlay,
    onTogglePlayback,
    onSeek,
    onOpenPlayer,
}: LatticePlaybackControlsProps) {
    const { t } = useTranslation();
    // Subscribed here rather than threaded through every poster: only this card reads transport state.
    const { currentSong, playerState, currentTime, playbackDuration, canTogglePlayback } = useLatticeTransport();
    const isCurrentSong = Boolean(
        currentSong && getPlaybackSongKey(currentSong) === getPlaybackSongKey(tile.song),
    );
    const canControlCurrent = isCurrentSong && canTogglePlayback;
    const isPlaying = canControlCurrent && playerState === PlayerState.PLAYING;
    const duration = canControlCurrent
        ? playbackDuration
        : Math.max(0, tile.song.durationMs / 1000);

    return (
        <div
            // 思索靠这个属性认出整条控制条。类名会随样式重构改名，属性不会 —— 见 ponderSelectorContract。
            data-ponder="lattice-chrome"
            className={`lattice-chrome ${revealed ? 'is-revealed' : ''}`}
            role="group"
            aria-label={t('home.latticePlaybackControls')}
        >
            <div className="lattice-chrome-transport">
                <button
                    type="button"
                    className="lattice-transport-button"
                    onClick={() => canControlCurrent ? onTogglePlayback() : onPlay(tile)}
                    aria-label={isPlaying ? t('player.pause') : t('player.play')}
                    title={isPlaying ? t('player.pause') : t('player.play')}
                >
                    {isPlaying ? <Pause fill="currentColor" /> : <Play fill="currentColor" />}
                </button>
                <div className="lattice-chrome-details" inert={!revealed} aria-hidden={!revealed}>
                    <LatticeExtraControls disabled={!canControlCurrent} />
                </div>
                {/* R126：宿主自撰的「重取封面」，放在传输行里（details 那一格是 0fr→1fr 的擦除动画，
                    多塞一个子元素会多出一行）。它只认 tile.song，与"是不是当前这首"无关。 */}
                <LatticeCoverRetry song={tile.song} />
                <LatticeChromeTime currentTime={canControlCurrent ? currentTime : idleTime} duration={duration} />
                <button type="button" className="lattice-secondary-action" onClick={onOpenPlayer}
                    aria-label={t('home.latticeOpenPlayer')} title={t('home.latticeOpenPlayer')}>
                    <ArrowUpRight size={20} />
                </button>
            </div>
            <div className="lattice-progress">
                <ProgressBar
                    currentTime={canControlCurrent ? currentTime : idleTime}
                    duration={duration}
                    onSeek={canControlCurrent ? onSeek : ignoreSeek}
                    primaryColor="var(--lattice-chrome-ink)"
                    secondaryColor="var(--lattice-chrome-ink)"
                    trackColor="color-mix(in srgb, var(--lattice-chrome-ink) 20%, transparent)"
                    disabled={!canControlCurrent}
                    edgeStyle="square"
                />
            </div>
        </div>
    );
}
