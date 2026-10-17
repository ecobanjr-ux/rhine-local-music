import test from "node:test";
import assert from "node:assert/strict";
import {
  SCENE_THEMES,
  sceneTheme,
  SHELL_SURFACE_MATERIALS,
  LIGHTING_LOOKS,
  INTERNAL_OPTICS_SURFACES,
} from "../src/music-scene-theme.ts";

const COLOR = /^#[0-9a-f]{6}$/i;

test("三套主题键齐全且颜色字段合法", () => {
  for (const name of ["day", "night", "dusk"]) {
    const tokens = sceneTheme(name);
    assert.ok(tokens, name);
    assert.match(tokens.background, COLOR);
    assert.match(tokens.floor, COLOR);
    assert.match(tokens.stars.color, COLOR);
    assert.match(tokens.key.color, COLOR);
    assert.match(tokens.hemisphere.sky, COLOR);
    assert.match(tokens.hemisphere.ground, COLOR);
    assert.match(tokens.selection.spot.color, COLOR);
    assert.match(tokens.selection.scatter.color, COLOR);
    assert.ok(tokens.exposure > 0 && tokens.environmentIntensity > 0);
  }
});

test("dusk 与 day 在背景和地面上不同，但曝光一致", () => {
  assert.notEqual(SCENE_THEMES.dusk.background, SCENE_THEMES.day.background);
  assert.notEqual(SCENE_THEMES.dusk.floor, SCENE_THEMES.day.floor);
  assert.equal(SCENE_THEMES.dusk.exposure, SCENE_THEMES.day.exposure);
});

test("night/dusk 提供壳体覆盖色，day 不提供", () => {
  assert.equal(SCENE_THEMES.day.shell, undefined);
  for (const name of ["night", "dusk"]) {
    const shell = SCENE_THEMES[name].shell;
    assert.ok(shell);
    assert.match(shell.frosted.color, COLOR);
    assert.match(shell.frosted.attenuation, COLOR);
    assert.match(shell.diffuser, COLOR);
    assert.match(shell.inlay, COLOR);
  }
});

test("壳体表面与光照 look 的字面量齐全", () => {
  for (const look of ["baseline", "refined"]) {
    assert.match(SHELL_SURFACE_MATERIALS.Internal_Ceramic.color[look], COLOR);
    assert.match(SHELL_SURFACE_MATERIALS.Subsurface_Optics.color[look], COLOR);
    assert.match(SHELL_SURFACE_MATERIALS.Optical_Edges.color[look], COLOR);
    const lighting = LIGHTING_LOOKS[look];
    assert.match(lighting.key.color, COLOR);
    assert.match(lighting.fill.color, COLOR);
    assert.match(lighting.hemisphere.ground, COLOR);
    assert.equal(lighting.key.position.length, 3);
  }
  assert.equal(Object.keys(INTERNAL_OPTICS_SURFACES).length, 4);
});
