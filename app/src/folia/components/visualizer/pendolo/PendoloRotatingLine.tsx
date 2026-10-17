/**
 * Ported from folia-major (https://github.com/chthollyphile/folia-major), AGPL-3.0-only.
 * Upstream file: src/components/visualizer/pendolo/PendoloRotatingLine.tsx @ 369c34e6f83404c65129479e6bd88d70acb0e43e
 * This project is released under AGPL-3.0. Registered rewrites of this file:
 * see NOTICE.md「移植清单（Folia 视图）」 and memory/folia-port-rewrite-log.md.
 */
import React from 'react';
import { motion, useTransform, type MotionValue } from 'framer-motion';
import { resolvePendoloRotatingLineOpacity } from './pendoloTimeline';

// src/components/visualizer/pendolo/PendoloRotatingLine.tsx

interface PendoloRotatingLineProps {
    wheelRotationDeg: MotionValue<number>;
    baseAngleDeg: number;
    baseOpacity: number;
    left: number;
    top: number;
    fontFamily: string;
    fontWeight: number;
    canSeek: boolean;
    onClick: React.MouseEventHandler<HTMLDivElement>;
    children: React.ReactNode;
}

/** Keeps lyrics hidden outside the unwrapped visible arc while the wheel preserves its full rotation. */
const PendoloRotatingLine: React.FC<PendoloRotatingLineProps> = ({
    wheelRotationDeg,
    baseAngleDeg,
    baseOpacity,
    left,
    top,
    fontFamily,
    fontWeight,
    canSeek,
    onClick,
    children,
}) => {
    const opacity = useTransform(wheelRotationDeg, rotationDeg => (
        resolvePendoloRotatingLineOpacity(baseAngleDeg, rotationDeg, baseOpacity)
    ));

    return (
        <motion.div
            className={`absolute pointer-events-auto ${canSeek ? 'cursor-pointer' : ''}`}
            style={{
                left,
                top,
                transformOrigin: 'left center',
                opacity,
                fontFamily,
                fontWeight,
            }}
            onClick={onClick}
        >
            {children}
        </motion.div>
    );
};

export default React.memo(PendoloRotatingLine);
