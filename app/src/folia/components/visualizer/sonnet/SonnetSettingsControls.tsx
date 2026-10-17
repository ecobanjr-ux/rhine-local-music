/**
 * Ported from folia-major (https://github.com/chthollyphile/folia-major), AGPL-3.0-only.
 * Upstream file: src/components/visualizer/sonnet/SonnetSettingsControls.tsx @ 369c34e6f83404c65129479e6bd88d70acb0e43e
 * This project is released under AGPL-3.0. Registered rewrites of this file:
 * see NOTICE.md「移植清单（Folia 视图）」 and memory/folia-port-rewrite-log.md.
 */
import React from 'react';

// src/components/visualizer/sonnet/SonnetSettingsControls.tsx
// Provides compact section and slider primitives for the Sonnet settings panel.
interface SonnetSettingsSectionProps {
    title: string;
    children: React.ReactNode;
}

export const SonnetSettingsSection: React.FC<SonnetSettingsSectionProps> = ({ title, children }) => (
    <section className="space-y-4 border-t border-white/10 pt-4">
        <h3
            className="text-xs font-medium uppercase tracking-[0.24em] opacity-45"
            style={{ color: 'var(--text-secondary)' }}
        >
            {title}
        </h3>
        {children}
    </section>
);

interface SonnetRangeControlProps {
    label: string;
    value: number;
    rangeInputClass: string;
    onChange: (value: number) => void;
    onPointerDown?: () => void;
    onPointerUp?: () => void;
    min?: number;
    max?: number;
    step?: number;
}

export const SonnetRangeControl: React.FC<SonnetRangeControlProps> = ({
    label,
    value,
    rangeInputClass,
    onChange,
    onPointerDown,
    onPointerUp,
    min = 0,
    max = 2,
    step = 0.05,
}) => (
    <div className="space-y-2">
        <div className="flex items-center justify-between gap-3 text-sm" style={{ color: 'var(--text-primary)' }}>
            <span>{label}</span>
            <span className="shrink-0 font-mono opacity-70" style={{ color: 'var(--text-secondary)' }}>
                {value.toFixed(2)}x
            </span>
        </div>
        <input
            type="range"
            min={min}
            max={max}
            step={step}
            value={value}
            onChange={event => onChange(Number(event.target.value))}
            onPointerDown={onPointerDown}
            onPointerUp={onPointerUp}
            className={rangeInputClass}
        />
    </div>
);
