import { damp, type Spring } from "./motion.ts";

/** Pointer travel beyond this counts as a drag, not a click (matches the scene click threshold). */
export const ORBIT_DRAG_THRESHOLD_PX = 6;
export const ORBIT_YAW_LIMIT = 0.6;
export const ORBIT_PITCH_LIMIT = 0.35;
export const ORBIT_ZOOM_RANGE: readonly [number, number] = [0.8, 1.3];

const ORBIT_RATE = 9;
const REDUCED_RATE = 35;
const PIXELS_TO_YAW = 0.0032;
const PIXELS_TO_PITCH = 0.0022;
const WHEEL_ZOOM_STEP = 0.06;

const clamp = (value: number, lo: number, hi: number) =>
  Math.max(lo, Math.min(hi, value));

/**
 * User-driven camera offset for the album array. Values are additive offsets on
 * top of the preset choreography poses; the scene composes them each frame.
 * Damping reuses the critically damped spring from motion.ts so reduced-motion
 * can snap with the same rate convention as the rest of the scene.
 */
export class MusicCameraOrbit {
  private readonly yawSpring: Spring = { value: 0, velocity: 0 };
  private readonly pitchSpring: Spring = { value: 0, velocity: 0 };
  private readonly zoomSpring: Spring = { value: 1, velocity: 0 };
  private targetYaw = 0;
  private targetPitch = 0;
  private targetZoom = 1;
  private pointerActive = false;
  private startX = 0;
  private startY = 0;
  private lastX = 0;
  private lastY = 0;
  private moved = 0;
  private reduced = false;

  dragging = false;
  /** Frame counter used by scene diagnostics to prove the offset is stepped each frame. */
  private updates = 0;
  get updateCount(): number {
    return this.updates;
  }
  /** True once a gesture crossed the drag threshold; the scene skips onSelect for it. */
  suppressNextSelect = false;

  get yaw(): number {
    return this.yawSpring.value;
  }
  get pitch(): number {
    return this.pitchSpring.value;
  }
  get zoom(): number {
    return this.zoomSpring.value;
  }
  get targets(): { yaw: number; pitch: number; zoom: number } {
    return { yaw: this.targetYaw, pitch: this.targetPitch, zoom: this.targetZoom };
  }

  pointerDown(x: number, y: number): void {
    this.pointerActive = true;
    this.startX = this.lastX = x;
    this.startY = this.lastY = y;
    this.moved = 0;
    this.dragging = false;
    this.suppressNextSelect = false;
  }

  pointerMove(x: number, y: number): void {
    if (!this.pointerActive) return;
    this.moved = Math.max(this.moved, Math.hypot(x - this.startX, y - this.startY));
    if (!this.dragging && this.moved > ORBIT_DRAG_THRESHOLD_PX) {
      this.dragging = true;
      this.suppressNextSelect = true;
    }
    if (this.dragging) {
      this.targetYaw = clamp(
        this.targetYaw + (x - this.lastX) * PIXELS_TO_YAW,
        -ORBIT_YAW_LIMIT,
        ORBIT_YAW_LIMIT,
      );
      this.targetPitch = clamp(
        this.targetPitch + (y - this.lastY) * PIXELS_TO_PITCH,
        -ORBIT_PITCH_LIMIT,
        ORBIT_PITCH_LIMIT,
      );
    }
    this.lastX = x;
    this.lastY = y;
  }

  pointerUp(): void {
    this.pointerActive = false;
    this.dragging = false;
  }

  wheel(deltaY: number): void {
    const step = Math.sign(deltaY) * WHEEL_ZOOM_STEP;
    this.targetZoom = clamp(
      this.targetZoom - step,
      ORBIT_ZOOM_RANGE[0],
      ORBIT_ZOOM_RANGE[1],
    );
  }

  update(dt: number): void {
    this.updates += 1;
    if (this.reduced) {
      this.yawSpring.value = this.targetYaw;
      this.pitchSpring.value = this.targetPitch;
      this.zoomSpring.value = this.targetZoom;
      this.yawSpring.velocity = this.pitchSpring.velocity = this.zoomSpring.velocity = 0;
      return;
    }
    damp(this.yawSpring, this.targetYaw, ORBIT_RATE, dt);
    damp(this.pitchSpring, this.targetPitch, ORBIT_RATE, dt);
    damp(this.zoomSpring, this.targetZoom, ORBIT_RATE, dt);
  }

  reset(): void {
    this.targetYaw = this.targetPitch = 0;
    this.targetZoom = 1;
    this.yawSpring.value = this.pitchSpring.value = 0;
    this.zoomSpring.value = 1;
    this.yawSpring.velocity = this.pitchSpring.velocity = this.zoomSpring.velocity = 0;
    this.dragging = false;
    this.suppressNextSelect = false;
    this.pointerActive = false;
  }

  setReduced(reduced: boolean): void {
    this.reduced = reduced;
    if (reduced) this.update(0);
  }

  /** Exposed for tests and diagnostics. */
  get reducedMode(): boolean {
    return this.reduced;
  }
  get rate(): number {
    return this.reduced ? REDUCED_RATE : ORBIT_RATE;
  }
}
