import * as THREE from "three";
import { RoomEnvironment } from "three/addons/environments/RoomEnvironment.js";
import { LIGHTING_LOOKS, type LightingLook } from "./music-scene-theme";

export type { LightingLook };

// The archive and its independent viewer use the same studio illumination.
// Each renderer needs its own PMREM render target / WebGL texture.
export function createArchiveLighting(
  renderer: THREE.WebGLRenderer,
  scene: THREE.Scene,
  look: LightingLook = "baseline",
) {
  const tokens = LIGHTING_LOOKS[look];
  renderer.toneMappingExposure = tokens.exposure;
  const pmrem = new THREE.PMREMGenerator(renderer);
  const room = new RoomEnvironment();
  scene.environment = pmrem.fromScene(room, 0.04).texture;
  room.dispose();
  pmrem.dispose();
  scene.environmentIntensity = tokens.environmentIntensity;
  scene.add(
    new THREE.HemisphereLight(
      tokens.hemisphere.sky,
      tokens.hemisphere.ground,
      tokens.hemisphere.intensity,
    ),
  );
  const key = new THREE.DirectionalLight(tokens.key.color, tokens.key.intensity);
  key.position.set(...tokens.key.position);
  const fill = new THREE.DirectionalLight(tokens.fill.color, tokens.fill.intensity);
  fill.position.set(...tokens.fill.position);
  scene.add(key, fill);
  return key;
}
