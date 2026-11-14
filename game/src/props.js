// Props: barrels and sandbag stacks, the cover that fills the open corners a bare crate cluster
// leaves empty. Unlike the detail pass (pure decoration), these are real: a barrel or a sandbag is a
// collider the player cannot walk through and a shootable the bullet stops on, because you hide
// behind them and shoot through the gaps.
//
// Everything is built from primitives and shares texture maps with the rest of the map, so the cost
// is a handful of draw calls. Each prop pushes its bounds into the movement colliders and its mesh
// into the shootables, exactly like the boxes in createWorld.

import * as THREE from 'three';
import { chamferBox } from './detail.js';
import { panelMaps } from './textures.js';

/** A metal drum: a cylinder with rolled ribs, top and bottom rims, and a dentable plate cap. */
function barrel(metalMat, rimMat) {
  const g = new THREE.Group();
  const body = new THREE.Mesh(new THREE.CylinderGeometry(0.36, 0.36, 0.92, 14), metalMat);
  body.castShadow = true;
  body.receiveShadow = true;
  g.add(body);
  // Two rolled ribs around the waist so the drum is not a plain tube.
  for (const y of [-0.22, 0.24]) {
    const rib = new THREE.Mesh(new THREE.CylinderGeometry(0.375, 0.375, 0.06, 14), rimMat);
    rib.position.y = y;
    rib.castShadow = true;
    g.add(rib);
  }
  // Rimmed cap on top and bottom.
  for (const y of [0.47, -0.47]) {
    const rim = new THREE.Mesh(new THREE.CylinderGeometry(0.32, 0.32, 0.03, 14), rimMat);
    rim.position.y = y;
    g.add(rim);
  }
  return g;
}

/** A sandbag wall: two courses of chamfered sacks, the top one offset so the creases interlock. */
function sandbagStack(sackMat) {
  const g = new THREE.Group();
  const sackGeo = chamferBox(0.72, 0.24, 0.36, 0.08);
  for (let i = 0; i < 4; i += 1) {
    const s = new THREE.Mesh(sackGeo, sackMat);
    s.position.set((i - 1.5) * 0.72, 0.12, 0);
    s.castShadow = true;
    s.receiveShadow = true;
    g.add(s);
  }
  for (let i = 0; i < 3; i += 1) {
    const s = new THREE.Mesh(sackGeo, sackMat);
    s.position.set((i - 1) * 0.72, 0.34, 0.08);
    s.rotation.y = 0.15;
    s.scale.set(0.92, 1.0, 0.92);
    s.castShadow = true;
    s.receiveShadow = true;
    g.add(s);
  }
  return g;
}

/**
 * Place props. Each entry is [x, z, yaw, kind] where kind is 'barrel' or 'sandbag'; the prop is
 * dropped at (x, 0, z), rotated by `yaw`, and registered as both a collider and a shootable.
 */
export function addProps(scene, colliders, shootables, placements) {
  const drumMaps = panelMaps({ size: 256, seed: 140, tint: [0.32, 0.25, 0.16] });
  const drumMat = new THREE.MeshStandardMaterial({
    color: 0xffffff, roughness: 0.55, metalness: 0.6,
    map: drumMaps.map, normalMap: drumMaps.normalMap, roughnessMap: drumMaps.roughnessMap,
    normalScale: new THREE.Vector2(0.7, 0.7),
  });
  const rimMat = new THREE.MeshStandardMaterial({ color: 0x2a2e33, roughness: 0.5, metalness: 0.7 });
  const sackMaps = panelMaps({ size: 256, seed: 141, tint: [0.62, 0.55, 0.40] });
  const sackMat = new THREE.MeshStandardMaterial({
    color: 0xffffff, roughness: 0.95, metalness: 0.0,
    map: sackMaps.map, normalMap: sackMaps.normalMap, roughnessMap: sackMaps.roughnessMap,
    normalScale: new THREE.Vector2(0.8, 0.8),
  });

  let barrels = 0;
  let sandbags = 0;
  for (const [x, z, yaw, kind] of placements) {
    const g = kind === 'barrel' ? barrel(drumMat, rimMat) : sandbagStack(sackMat);
    const height = kind === 'barrel' ? 0.95 : 0.6;
    const half = kind === 'barrel' ? 0.38 : 1.45;
    g.position.set(x, 0, z);
    g.rotation.y = yaw;
    scene.add(g);

    // Collider: a box that fits the prop's silhouette.
    colliders.push(new THREE.Box3().setFromCenterAndSize(
      new THREE.Vector3(x, height / 2, z), new THREE.Vector3(half * 2, height, half * 2)));
    // Shootable: the group itself, so a bullet stops on any child mesh.
    shootables.push(g);
    if (kind === 'barrel') barrels += 1; else sandbags += 1;
  }

  return { barrels, sandbags, total: barrels + sandbags };
}