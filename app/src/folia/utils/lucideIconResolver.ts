/**
 * Ported from folia-major (https://github.com/chthollyphile/folia-major), AGPL-3.0-only.
 * Upstream file: src/utils/lucideIconResolver.ts @ 369c34e6f83404c65129479e6bd88d70acb0e43e
 * This project is released under AGPL-3.0. Registered rewrites of this file:
 * see NOTICE.md「移植清单（Folia 视图）」 and memory/folia-port-rewrite-log.md.
 */
import * as LucideIcons from 'lucide-react';
import type { LucideIcon } from 'lucide-react';

// src/utils/lucideIconResolver.ts
// Resolves a theme's lyricsIcons entry (a PascalCase lucide name coming from AI output or the
// theme editor) to a renderable component, so callers never index lucide-react by hand.

// lucide icons are forwardRef objects; requiring that shape keeps the module's other exports
// (createLucideIcon, the icons map, ...) from passing as icon names.
const isLucideIcon = (value: unknown): value is LucideIcon => (
    typeof value === 'object' && value !== null && '$$typeof' in value && 'render' in value
);

export const resolveLucideIcon = (name: string | null | undefined): LucideIcon | null => {
    const trimmed = typeof name === 'string' ? name.trim() : '';
    if (!trimmed) {
        return null;
    }

    const candidate = (LucideIcons as unknown as Record<string, unknown>)[trimmed];
    return isLucideIcon(candidate) ? candidate : null;
};

export const isLucideIconName = (name: string) => resolveLucideIcon(name) !== null;

// Case-insensitive name table over the PascalCase exports (same filter Sonnet has always used).
// Built on first use so the other importers of this module never pay for scanning every export.
let lucideIconNamesByLowercase: Map<string, string> | null = null;
const iconNamesByLowercase = () => {
    lucideIconNamesByLowercase ??= new Map(Object.keys(LucideIcons)
        .filter(name => {
            const candidate = LucideIcons[name as keyof typeof LucideIcons];
            return /^[A-Z]/.test(name) && (typeof candidate === 'object' || typeof candidate === 'function');
        })
        .map(name => [name.toLowerCase(), name]));
    return lucideIconNamesByLowercase;
};

/**
 * Resolves a theme's lyricsIcons list to canonical lucide export names: case-insensitive, deduplicated,
 * unknown names dropped. No fallback - callers that want a default icon add it themselves.
 */
export const resolveLucideIconNames = (names: readonly string[] | undefined): string[] => [
    ...new Set((names ?? [])
        .map(name => (typeof name === 'string' ? iconNamesByLowercase().get(name.toLowerCase()) : undefined))
        .filter(Boolean)),
] as string[];
