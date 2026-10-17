import test from "node:test";
import assert from "node:assert/strict";
import {
  MusicCameraOrbit,
  ORBIT_DRAG_THRESHOLD_PX,
  ORBIT_PITCH_LIMIT,
  ORBIT_YAW_LIMIT,
  ORBIT_ZOOM_RANGE,
} from "../src/music-camera-orbit.ts";

test("位移不超过阈值不算拖拽，超过才算", () => {
  const click = new MusicCameraOrbit();
  click.pointerDown(100, 100);
  click.pointerMove(100 + ORBIT_DRAG_THRESHOLD_PX - 1, 100);
  click.pointerUp();
  assert.equal(click.dragging, false);
  assert.equal(click.suppressNextSelect, false);
  assert.equal(click.targets.yaw, 0);

  const drag = new MusicCameraOrbit();
  drag.pointerDown(100, 100);
  drag.pointerMove(100 + ORBIT_DRAG_THRESHOLD_PX + 4, 100);
  assert.equal(drag.dragging, true);
  assert.equal(drag.suppressNextSelect, true);
  assert.ok(drag.targets.yaw > 0);
});

test("yaw/pitch/zoom 越限被钳制", () => {
  const orbit = new MusicCameraOrbit();
  orbit.pointerDown(0, 0);
  orbit.pointerMove(100000, 100000);
  assert.equal(orbit.targets.yaw, ORBIT_YAW_LIMIT);
  assert.equal(orbit.targets.pitch, ORBIT_PITCH_LIMIT);
  for (let i = 0; i < 200; i++) orbit.wheel(-100);
  assert.equal(orbit.targets.zoom, ORBIT_ZOOM_RANGE[1]);
  for (let i = 0; i < 200; i++) orbit.wheel(100);
  assert.equal(orbit.targets.zoom, ORBIT_ZOOM_RANGE[0]);
});

test("update 单调收敛到目标", () => {
  const orbit = new MusicCameraOrbit();
  orbit.pointerDown(0, 0);
  orbit.pointerMove(120, 40);
  orbit.pointerUp();
  const target = orbit.targets.yaw;
  assert.ok(target > 0);
  let previous = 0;
  for (let i = 0; i < 90; i++) {
    orbit.update(1 / 60);
    assert.ok(orbit.yaw >= previous - 1e-9);
    previous = orbit.yaw;
  }
  assert.ok(Math.abs(orbit.yaw - target) < Math.abs(target) * 0.05);
});

test("reduced 模式一步到位", () => {
  const orbit = new MusicCameraOrbit();
  orbit.setReduced(true);
  orbit.pointerDown(0, 0);
  orbit.pointerMove(80, 20);
  orbit.pointerUp();
  orbit.update(1 / 60);
  assert.equal(orbit.yaw, orbit.targets.yaw);
  assert.equal(orbit.pitch, orbit.targets.pitch);
  assert.equal(orbit.zoom, 1);
});

test("reset 清零且不影响后续手势", () => {
  const orbit = new MusicCameraOrbit();
  orbit.pointerDown(0, 0);
  orbit.pointerMove(90, 30);
  orbit.reset();
  assert.equal(orbit.yaw, 0);
  assert.equal(orbit.targets.yaw, 0);
  assert.equal(orbit.suppressNextSelect, false);
  orbit.pointerDown(0, 0);
  orbit.pointerMove(40, 0);
  assert.ok(orbit.targets.yaw > 0);
});
