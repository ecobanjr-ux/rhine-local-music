/**
 * Ported from folia-major (https://github.com/chthollyphile/folia-major), AGPL-3.0-only.
 * Upstream file: src/components/app/lattice/LatticeExtraControls.tsx @ 369c34e6f83404c65129479e6bd88d70acb0e43e
 * This project is released under AGPL-3.0. Registered rewrites of this file:
 * see NOTICE.md「移植清单（Folia 视图第一期）」 and memory/folia-port-rewrite-log.md.
 */
import { useTranslation } from '../../../i18n/config';
import { usePlayerChromeSettingsStore } from '../../../stores/usePlayerChromeSettingsStore';
import { resolvePlayerControlSlot, type PlayerControlSlotActionId } from '../../floating-player/playerControlSlotActions';
import { useLatticePlaybackActions } from './LatticePlaybackProvider';

// src/components/app/lattice/LatticeExtraControls.tsx
// Transport and the main bar's configured slots share their handlers, icons and availability.
export default function LatticeExtraControls({ disabled }: { disabled: boolean }) {
    const { t } = useTranslation();
    const context = useLatticePlaybackActions();
    const primary = usePlayerChromeSettingsStore(state => state.playerControlSlotPrimary);
    const secondary = usePlayerChromeSettingsStore(state => state.playerControlSlotSecondary);
    const actions: PlayerControlSlotActionId[] = ['prev', primary, secondary, 'next'];
    return <div className="lattice-chrome-actions">
        {actions.map((action, index) => {
            const slot = resolvePlayerControlSlot(action, context);
            const Icon = slot.icon;
            return <button key={index} type="button" data-action={action} className={slot.active ? 'is-active' : ''}
                disabled={disabled || slot.disabled} onClick={() => slot.onActivate()}
                aria-label={t(slot.labelKey)} title={t(slot.labelKey)}
                aria-pressed={action === 'loop' || action === 'like' ? slot.active : undefined}>
                <Icon size={20} fill={slot.filled ? 'currentColor' : 'none'} />
            </button>;
        })}

    </div>;
}
