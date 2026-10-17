/**
 * Single source of truth for the 3D scene palette.
 * Values were moved verbatim from scene.ts / appearance.ts / internal-optics.ts /
 * music-lighting.ts / archive-lighting.ts / viewer-theme.ts; the CSS tokens in
 * music.css remain the DOM layer and are kept in sync by theme name only.
 */

export type SceneThemeName = "day" | "night" | "dusk";
export type LightingLook = "baseline" | "refined";

export interface SceneThemeTokens {
  warmth: number;
  exposure: number;
  environmentIntensity: number;
  background: string;
  floor: string;
  stars: { color: string; opacity: number };
  key: { color: string; intensity: number };
  hemisphere: { sky: string; ground: string; intensity: number };
  /** Shell surface overrides for night/dusk; day keeps each material's dayColor. */
  shell?: {
    frosted: { color: string; attenuation: string };
    diffuser: string;
    inlay: string;
  };
  /** Local key light for the selected album (MusicSelectionLighting). */
  selection: {
    environmentIntensity: number;
    keyIntensity: number;
    otherKeyIntensity: number;
    hemisphereIntensity: number;
    spot: { color: string; intensityFactor: number };
    scatter: { color: string; strength: number };
    printAmbient: number;
  };
}

export const SCENE_THEMES: Record<SceneThemeName, SceneThemeTokens> = {
  day: {
    warmth: 1,
    exposure: 1.05,
    environmentIntensity: 0.48,
    background: "#eae5e1",
    floor: "#d8c9b9",
    stars: { color: "#dbeaff", opacity: 0 },
    key: { color: "#fff7ed", intensity: 1.4 },
    hemisphere: { sky: "#fffaf5", ground: "#b4a18c", intensity: 0.65 },
    selection: {
      environmentIntensity: 0.25,
      keyIntensity: 0.45,
      otherKeyIntensity: 0.045,
      hemisphereIntensity: 0.32,
      spot: { color: "#ffe3b2", intensityFactor: 180 },
      scatter: { color: "#ffdba3", strength: 1 },
      printAmbient: 0.5,
    },
  },
  night: {
    warmth: 0,
    exposure: 1.08,
    environmentIntensity: 0.68,
    background: "#07111f",
    floor: "#0b1828",
    stars: { color: "#dbeaff", opacity: 0.6 },
    key: { color: "#e5f0ff", intensity: 1.7 },
    hemisphere: { sky: "#e2eeff", ground: "#56708c", intensity: 0.9 },
    shell: {
      frosted: { color: "#f6fbff", attenuation: "#dceafd" },
      diffuser: "#c6d6e5",
      inlay: "#d7e9ff",
    },
    selection: {
      environmentIntensity: 0.16,
      keyIntensity: 0.3,
      otherKeyIntensity: 0.045,
      hemisphereIntensity: 0.21,
      spot: { color: "#dbe9ff", intensityFactor: 130 },
      scatter: { color: "#cee5ff", strength: 0.72 },
      printAmbient: 0.12,
    },
  },
  dusk: {
    warmth: 0,
    exposure: 1.05,
    environmentIntensity: 0.48,
    background: "#b9c7cc",
    floor: "#a6b8c0",
    stars: { color: "#dbeaff", opacity: 0 },
    key: { color: "#eff8ff", intensity: 1.4 },
    hemisphere: { sky: "#fffaf5", ground: "#718898", intensity: 0.65 },
    shell: {
      frosted: { color: "#e6f0f2", attenuation: "#c8dbe1" },
      diffuser: "#91a4af",
      inlay: "#b9d2df",
    },
    selection: {
      environmentIntensity: 0.25,
      keyIntensity: 0.45,
      otherKeyIntensity: 0.045,
      hemisphereIntensity: 0.32,
      spot: { color: "#ffe3b2", intensityFactor: 180 },
      scatter: { color: "#ffdba3", strength: 1 },
      printAmbient: 0.38,
    },
  },
};

export function sceneTheme(name: SceneThemeName): SceneThemeTokens {
  return SCENE_THEMES[name];
}

/** Shell material palette; color may differ per lighting look. */
export const SHELL_SURFACE_MATERIALS = {
  Frosted_Polymer: {
    color: "#fffdfa",
    transmission: 0.9,
    thickness: 0.12,
    roughness: 0.21,
    ior: 1.46,
    attenuationColor: "#eee6df",
    attenuationDistance: 2,
  },
  Internal_Ceramic: {
    color: { refined: "#c4baae", baseline: "#c7beb6" } as Record<LightingLook, string>,
    roughness: 0.6,
  },
  Printed_Label: { color: "#eae5dc" },
  Ivory_Edges: { color: "#f0e7df", roughness: 0.31, transmission: 0.65, thickness: 0.04 },
  Optical_Diffuser: { color: "#e2dad4", transmission: 0, roughness: 0.7 },
  Subsurface_Optics: {
    color: { refined: "#b9a796", baseline: "#b9aba1" } as Record<LightingLook, string>,
    roughness: 0.48,
    metalness: 0.05,
  },
  Optical_Edges: {
    color: { refined: "#d8c7b5", baseline: "#d4c7be" } as Record<LightingLook, string>,
    transmission: 0,
    roughness: 0.26,
    metalness: 0.08,
  },
} as const;

/** Studio illumination per lighting look (archive route and model viewer). */
export const LIGHTING_LOOKS: Record<
  LightingLook,
  {
    exposure: number;
    environmentIntensity: number;
    hemisphere: { sky: string; ground: string; intensity: number };
    key: { color: string; intensity: number; position: [number, number, number] };
    fill: { color: string; intensity: number; position: [number, number, number] };
  }
> = {
  baseline: {
    exposure: 1.05,
    environmentIntensity: 0.48,
    hemisphere: { sky: "#fffaf5", ground: "#b4a18c", intensity: 0.65 },
    key: { color: "#fff7ed", intensity: 1.4, position: [-6, 14, -5] },
    fill: { color: "#ffffff", intensity: 0.6, position: [7, 8, -10] },
  },
  refined: {
    exposure: 1.0,
    environmentIntensity: 0.52,
    hemisphere: { sky: "#fffaf5", ground: "#b49b80", intensity: 0.5 },
    key: { color: "#fff4e5", intensity: 1.7, position: [-8, 14, 4] },
    fill: { color: "#ffffff", intensity: 0.3, position: [7, 8, -10] },
  },
};

/** Internal refractive surfaces of the CD shell (theme/look independent). */
export const INTERNAL_OPTICS_SURFACES: Record<
  string,
  { color: string; roughness: number; opacity: number; order: number }
> = {
  Optical_Glass_Body: { color: "#929894", roughness: 0.38, opacity: 0.27, order: 20 },
  Optical_Glass_Roof: { color: "#929b94", roughness: 0.34, opacity: 0.42, order: 24 },
  Optical_Glass_Edge: { color: "#edf0e7", roughness: 0.19, opacity: 0.9, order: 28 },
  Optical_Bridge_Glass: { color: "#a0aca2", roughness: 0.32, opacity: 0.36, order: 26 },
};
