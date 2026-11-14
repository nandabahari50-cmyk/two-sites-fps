// Operators: the humanoid every bot and the player's own body is built from.
//
// The old model was six boxes with flat colours, which is why a bot read as a blue brick: nothing
// on it caught the light, so no amount of scene lighting made it look like a person. This builds the
// same silhouette out of tapered, bevelled parts wearing fabric and plate, whose joints actually
// bend — knees, elbows, a neck that turns — so a running figure reads as running.
//
// Parts are grouped as a small skeleton: hips carry the legs and the chest, the chest carries the
// arms and head. Only the group transforms are touched per frame (cheap, no new geometry), so an
// animation costs a handful of rotations.
//
// One geometry/material set is built once and shared: twelve bots cost one allocation.

import * as THREE from 'three';
import { fabricMaps, panelMaps } from './textures.js';

const SKIN_TONE = { attack: 0x6b4a32, defend: 0x4a3a2c };

/** A box with its top and bottom pinched in, used for limbs and the torso. */
function taper(w, h, d, topScale = 0.78, bottomScale = 0.86) {
  const g = new THREE.BoxGeometry(w, h, d, 1, 2, 1);
  const pos = g.attributes.position;
  const half = h / 2;
  for (let i = 0; i < pos.count; i += 1) {
    const y = pos.getY(i);
    const x = pos.getX(i);
    const z = pos.getZ(i);
    // Scale the cross-section by how close this vertex is to the top or the bottom.
    const t = (y + half) / h;               // 0 at the bottom, 1 at the top
    const s = bottomScale + (topScale - bottomScale) * t;
    pos.setX(i, x * s);
    pos.setZ(i, z * s);
  }
  g.computeVertexNormals();
  return g;
}

/** A rounded plate for shoulders, kneepads and the helmet brim. */
function plate(w, h, d) {
  return new THREE.BoxGeometry(w, h, d, 2, 2, 2);
}

export function createOperatorKit(renderer) {
  const fabricAttack = fabricMaps({ seed: 101, tint: [0.30, 0.27, 0.22] });
  const fabricDefend = fabricMaps({ seed: 103, tint: [0.22, 0.24, 0.30] });
  const plateMaps = panelMaps({ seed: 105, tint: [0.30, 0.32, 0.35] });
  const kitMaps = { fabricAttack, fabricDefend, plateMaps };

  function fabric(side) {
    const src = side === 0 ? fabricAttack : fabricDefend;
    return new THREE.MeshStandardMaterial({
      color: 0xffffff, roughness: 0.92, metalness: 0.03,
      map: src.map, normalMap: src.normalMap, roughnessMap: src.roughnessMap,
      normalScale: new THREE.Vector2(0.9, 0.9),
    });
  }

  const plateMat = new THREE.MeshStandardMaterial({
    color: 0xffffff, roughness: 0.55, metalness: 0.35,
    map: plateMaps.map, normalMap: plateMaps.normalMap, roughnessMap: plateMaps.roughnessMap,
    normalScale: new THREE.Vector2(1.0, 1.0),
  });

  const skinMat = (side) => new THREE.MeshStandardMaterial({
    color: SKIN_TONE[side === 0 ? 'attack' : 'defend'], roughness: 0.72, metalness: 0.0,
  });
  const rubberMat = new THREE.MeshStandardMaterial({ color: 0x14161a, roughness: 0.85, metalness: 0.05 });

  // Shared geometry: built once, reused by every operator.
  const geo = {
    chest: taper(0.60, 0.66, 0.34, 0.94, 0.80),
    abdomen: taper(0.46, 0.30, 0.30, 1.0, 1.0),
    shoulder: plate(0.20, 0.20, 0.30),
    upperArm: taper(0.15, 0.34, 0.16, 0.92, 0.86),
    foreArm: taper(0.13, 0.32, 0.14, 0.88, 0.94),
    hand: plate(0.11, 0.16, 0.11),
    thigh: taper(0.22, 0.44, 0.24, 0.90, 0.84),
    shin: taper(0.18, 0.44, 0.20, 0.86, 0.92),
    boot: plate(0.19, 0.13, 0.32),
    neck: taper(0.15, 0.10, 0.15, 0.9, 1.0),
    head: plate(0.26, 0.30, 0.28),
    helmet: plate(0.30, 0.20, 0.32),
    visor: plate(0.24, 0.09, 0.06),
    kneePad: plate(0.20, 0.16, 0.22),
    vest: plate(0.54, 0.44, 0.30),
    pouch: plate(0.16, 0.12, 0.10),
  };

  /**
   * Build one operator. Returns the group plus the named joints the animation writes to.
   * `side` 0 = attacker, 1 = defender.
   */
  function createOperator(side) {
    const root = new THREE.Group();
    const cloth = fabric(side);
    const skin = skinMat(side);

    // --- lower body: hips are the root of the leg chain ---
    const hips = new THREE.Group();
    hips.position.y = 0.92;
    root.add(hips);

    const pelvis = new THREE.Mesh(geo.abdomen, cloth);
    pelvis.position.y = -0.06;
    pelvis.scale.set(1.15, 1.0, 1.0);
    hips.add(pelvis);

    function leg(sign) {
      const hip = new THREE.Group();
      hip.position.set(0.14 * sign, -0.04, 0);
      const thigh = new THREE.Mesh(geo.thigh, cloth);
      thigh.position.y = -0.20;
      hip.add(thigh);
      const knee = new THREE.Group();
      knee.position.y = -0.42;
      hip.add(knee);
      const shin = new THREE.Mesh(geo.shin, cloth);
      shin.position.y = -0.21;
      knee.add(shin);
      const pad = new THREE.Mesh(geo.kneePad, plateMat);
      pad.position.set(0, 0.01, -0.10);
      knee.add(pad);
      const boot = new THREE.Mesh(geo.boot, rubberMat);
      boot.position.set(0, -0.44, -0.05);
      knee.add(boot);
      hips.add(hip);
      return { hip, knee };
    }
    const legL = leg(-1);
    const legR = leg(1);

    // --- upper body: chest carries arms and head, so a torso turn moves everything ---
    const chest = new THREE.Group();
    chest.position.y = 0.06;
    hips.add(chest);

    const torso = new THREE.Mesh(geo.chest, cloth);
    torso.position.y = 0.30;
    chest.add(torso);

    const vest = new THREE.Mesh(geo.vest, plateMat);
    vest.position.set(0, 0.32, 0.02);
    vest.scale.set(1, 0.92, 1);
    chest.add(vest);

    // Two pouches on the vest front, offset so the belt line is not symmetric.
    for (const [px, py] of [[-0.16, 0.22], [0.13, 0.20], [0.0, 0.10]]) {
      const p = new THREE.Mesh(geo.pouch, plateMat);
      p.position.set(px, py, 0.19);
      chest.add(p);
    }

    const neck = new THREE.Mesh(geo.neck, skin);
    neck.position.y = 0.68;
    chest.add(neck);

    const head = new THREE.Group();
    head.position.y = 0.86;
    chest.add(head);
    const skull = new THREE.Mesh(geo.head, skin);
    skull.position.y = 0.05;
    head.add(skull);
    const helmet = new THREE.Mesh(geo.helmet, plateMat);
    helmet.position.y = 0.14;
    head.add(helmet);
    const visor = new THREE.Mesh(geo.visor, rubberMat);
    visor.position.set(0, 0.06, 0.16);
    head.add(visor);

    function arm(sign) {
      const shoulder = new THREE.Group();
      shoulder.position.set(0.33 * sign, 0.54, 0);
      const pad = new THREE.Mesh(geo.shoulder, plateMat);
      pad.position.y = 0.02;
      shoulder.add(pad);
      const upper = new THREE.Mesh(geo.upperArm, cloth);
      upper.position.y = -0.17;
      shoulder.add(upper);
      const elbow = new THREE.Group();
      elbow.position.y = -0.34;
      shoulder.add(elbow);
      const fore = new THREE.Mesh(geo.foreArm, cloth);
      fore.position.y = -0.16;
      elbow.add(fore);
      const hand = new THREE.Mesh(geo.hand, skin);
      hand.position.y = -0.36;
      elbow.add(hand);
      chest.add(shoulder);
      return { shoulder, elbow, hand };
    }
    const armL = arm(-1);
    const armR = arm(1);

    root.traverse((o) => {
      if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; }
    });

    return {
      group: root,
      // Named joints the animation drives.
      joints: { hips, chest, head, legL, legR, armL, armR },
      // The part a shot lands on, kept for the existing hit code.
      parts: { head: skull, torso, legs: [legL.hip, legR.hip] },
      geometry: geo,
      materials: { cloth, skin, plateMat, rubberMat, kitMaps },
    };
  }

  return { createOperator, geo, plateMat, rubberMat, fabric, skinMat };
}
