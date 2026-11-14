// Detail pass: what turns a room of plain boxes into a place.
//
// A bare BoxGeometry has no edge highlight and no shadow line, so a wall reads as a flat panel no
// matter how good its texture is. Two things fix that cheaply:
//
//   * a chamfered box — every edge cut by a small bevel, which gives the key light a highlight to
//     catch and the occlusion pass a crease to darken;
//   * surface dressing — pipes along a wall, cable runs sagging between clips, conduit, floor
//     grating, hanging lamps, ceiling beams.
//
// Everything here is built from primitives and merged where it repeats, so the detail costs a few
// dozen draw calls rather than a few hundred. Nothing here is a collider: the collision set stays
// the plain boxes the movement code already understands, so gameplay is untouched by decoration.

import * as THREE from 'three';
import { panelMaps, concreteMaps } from './textures.js';

/**
 * A box with softened edges. Built by pulling every vertex a little toward the box's centre on a
 * segmented cube, which clips the corners and rounds the edges: the silhouette gains a highlight
 * line where a plain box would have none, and the occlusion pass gets a crease to darken.
 *
 * `round` is the fraction of the way to the centre, 0.02-0.06; higher reads as a soft rubber corner
 * rather than machined metal. Segments matter: with one vertex per face there is nothing to round.
 */
export function chamferBox(w, h, d, round = 0.04) {
  const g = new THREE.BoxGeometry(w, h, d, 2, 2, 2);
  const pos = g.attributes.position;
  const v = new THREE.Vector3();
  for (let i = 0; i < pos.count; i += 1) {
    v.set(pos.getX(i), pos.getY(i), pos.getZ(i));
    // Scaled component-wise so a long thin beam does not round more on its long axis.
    v.x *= 1 - round;
    v.y *= 1 - round;
    v.z *= 1 - round;
    pos.setXYZ(i, v.x, v.y, v.z);
  }
  g.computeVertexNormals();
  return g;
}

/** A pipe run with elbows and wall clips, laid along X from x0 to x1 at (y, z). */
function pipeRun(parent, mat, clipMat, x0, x1, y, z, radius = 0.055, clips = 6) {
  const len = Math.abs(x1 - x0);
  const cx = (x0 + x1) / 2;
  const tube = new THREE.Mesh(new THREE.CylinderGeometry(radius, radius, len, 10), mat);
  tube.rotation.z = Math.PI / 2;
  tube.position.set(cx, y, z);
  tube.castShadow = true;
  tube.receiveShadow = true;
  parent.add(tube);

  for (let i = 0; i < clips; i += 1) {
    const t = (i + 0.5) / clips;
    const clip = new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.14, 0.05), clipMat);
    clip.position.set(x0 + (x1 - x0) * t, y + 0.05, z + 0.05);
    parent.add(clip);
  }
  // Flanges at both ends so the run does not end mid-air.
  for (const ex of [x0, x1]) {
    const fl = new THREE.Mesh(new THREE.CylinderGeometry(radius * 1.7, radius * 1.7, 0.05, 10), clipMat);
    fl.rotation.z = Math.PI / 2;
    fl.position.set(ex, y, z);
    parent.add(fl);
  }
}

/** A cable sagging between two points: a tube along a catenary, plus a clip at each end. */
function cableRun(parent, mat, a, b, sag = 0.22, radius = 0.022) {
  const pts = [];
  for (let i = 0; i <= 10; i += 1) {
    const t = i / 10;
    const x = a.x + (b.x - a.x) * t;
    const z = a.z + (b.z - a.z) * t;
    // Parabola is close enough to a catenary at this sag and costs nothing.
    const y = a.y + (b.y - a.y) * t - Math.sin(Math.PI * t) * sag;
    pts.push(new THREE.Vector3(x, y, z));
  }
  const curve = new THREE.CatmullRomCurve3(pts);
  const tube = new THREE.Mesh(new THREE.TubeGeometry(curve, 20, radius, 5, false), mat);
  tube.castShadow = true;
  parent.add(tube);
  for (const p of [a, b]) {
    const clip = new THREE.Mesh(new THREE.CylinderGeometry(radius * 1.6, radius * 1.6, 0.05, 6), mat);
    clip.position.copy(p);
    parent.add(clip);
  }
}

/** A hanging lamp: a shade, a bulb that glows, and a thin drop cable to the ceiling. */
function hangingLamp(parent, shadeMat, bulbMat, x, y, z, ceilingY = 7) {
  const drop = new THREE.Mesh(new THREE.CylinderGeometry(0.008, 0.008, ceilingY - y, 5), shadeMat);
  drop.position.set(x, (y + ceilingY) / 2, z);
  parent.add(drop);

  const shade = new THREE.Mesh(new THREE.ConeGeometry(0.34, 0.22, 12, 1, true), shadeMat);
  shade.position.set(x, y, z);
  shade.castShadow = true;
  parent.add(shade);

  const bulb = new THREE.Mesh(new THREE.SphereGeometry(0.09, 10, 8), bulbMat);
  bulb.position.set(x, y - 0.07, z);
  parent.add(bulb);

  const light = new THREE.PointLight(0xffd9a8, 8, 13, 2);
  light.position.set(x, y - 0.10, z);
  parent.add(light);
  return light;
}

/** A floor grate: a web of thin bars, drawn where the player walks. */
function grate(parent, mat, w, d, x, y, z) {
  const group = new THREE.Group();
  group.position.set(x, y, z);
  const rails = Math.max(3, Math.round(w / 0.28));
  for (let i = 0; i < rails; i += 1) {
    const bar = new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.03, d), mat);
    bar.position.set(-w / 2 + (i / (rails - 1)) * w, 0, 0);
    group.add(bar);
  }
  const frame = new THREE.Mesh(new THREE.BoxGeometry(w, 0.04, 0.06), mat);
  frame.position.set(0, 0.005, d / 2);
  const frame2 = frame.clone();
  frame2.position.z = -d / 2;
  group.add(frame, frame2);
  parent.add(group);
}

/**
 * Dress the map. Called once from createWorld with the scene group and the map bounds.
 * Returns the lamp count so the caller can report it.
 */
export function addDetail(group, bounds) {
  const { halfW: HW, halfL: HL } = bounds;

  const metalMaps = panelMaps({ size: 256, seed: 130, tint: [0.30, 0.31, 0.33] });
  const metalMat = new THREE.MeshStandardMaterial({
    color: 0xffffff, roughness: 0.5, metalness: 0.6,
    map: metalMaps.map, normalMap: metalMaps.normalMap, roughnessMap: metalMaps.roughnessMap,
    normalScale: new THREE.Vector2(0.6, 0.6),
  });
  const darkMat = new THREE.MeshStandardMaterial({ color: 0x22262b, roughness: 0.72, metalness: 0.3 });
  const cableMat = new THREE.MeshStandardMaterial({ color: 0x17191c, roughness: 0.88, metalness: 0.05 });
  const shadeMaps = concreteMaps({ size: 256, seed: 132, tint: [0.24, 0.25, 0.27] });
  const shadeMat = new THREE.MeshStandardMaterial({
    color: 0xffffff, roughness: 0.62, metalness: 0.45,
    map: shadeMaps.map, normalMap: shadeMaps.normalMap, roughnessMap: shadeMaps.roughnessMap,
  });
  const bulbMat = new THREE.MeshStandardMaterial({
    color: 0xffe6bd, emissive: 0xffd9a0, emissiveIntensity: 2.4, roughness: 0.3, metalness: 0.0,
  });

  // --- ceiling structure: beams across, so the room has a top -------------------
  const beamCount = 7;
  for (let i = 0; i < beamCount; i += 1) {
    const z = -HL + ((i + 0.5) / beamCount) * (HL * 2);
    const beam = new THREE.Mesh(chamferBox(HW * 2 + 2, 0.32, 0.34, 0.03), metalMat);
    beam.position.set(0, 6.8, z);
    beam.castShadow = true;
    beam.receiveShadow = true;
    group.add(beam);
  }
  // One long spine beam down the middle, so the ceiling is not a bare slab.
  const spine = new THREE.Mesh(chamferBox(0.36, 0.28, HL * 2 + 2, 0.03), metalMat);
  spine.position.set(0, 6.55, 0);
  spine.castShadow = true;
  group.add(spine);

  // --- pipes and cable runs along the outer walls ------------------------------
  pipeRun(group, metalMat, darkMat, -HW + 0.8, HW - 0.8, 5.4, -HL + 0.75, 0.06, 8);
  pipeRun(group, metalMat, darkMat, -HW + 0.8, HW - 0.8, 5.1, -HL + 0.75, 0.04, 8);
  pipeRun(group, metalMat, darkMat, -HW + 0.75, -HW + 0.75, 5.2, -HL + 1.2, 0.05, 1);
  // Vertical conduit drops beside each site.
  for (const sx of [-1, 1]) {
    const drop = new THREE.Mesh(new THREE.CylinderGeometry(0.06, 0.06, 6.4, 10), metalMat);
    drop.position.set(sx * (HW - 0.7), 3.2, -HL + 0.7);
    drop.castShadow = true;
    group.add(drop);
  }

  // Cable runs sagging between the beams, two per gap.
  for (let i = 0; i < beamCount - 1; i += 1) {
    const z0 = -HL + ((i + 0.5) / beamCount) * (HL * 2);
    const z1 = -HL + ((i + 1.5) / beamCount) * (HL * 2);
    for (const x of [-HW * 0.55, HW * 0.55]) {
      cableRun(group, cableMat,
        new THREE.Vector3(x, 6.6, z0), new THREE.Vector3(x, 6.6, z1), 0.30);
    }
  }

  // --- hanging lamps over the lanes and each site ------------------------------
  const lampSpots = [
    [-13, 4.6, 6], [13, 4.6, 6],
    [-13, 4.6, -8], [13, 4.6, -8],
    [-13.5, 4.8, -24], [13.5, 4.8, -24],
    [0, 4.8, 2], [0, 4.8, -6],
  ];
  for (const [x, y, z] of lampSpots) hangingLamp(group, shadeMat, bulbMat, x, y, z, 6.9);

  // --- floor dressing: grates at the mid connector, and a raised kerb ----------
  for (const [gx, gz] of [[-4.6, 2.4], [4.6, 2.4], [-4.6, -2.4], [4.6, -2.4]]) {
    grate(group, darkMat, 1.5, 0.7, gx, 0.02, gz);
  }
  // A low kerb down each lane edge: reads as a change of level and catches the key light.
  for (const kx of [-HW * 0.62, HW * 0.62]) {
    const kerb = new THREE.Mesh(chamferBox(0.22, 0.14, HL * 2 - 6, 0.02), shadeMat);
    kerb.position.set(kx, 0.07, 0);
    kerb.castShadow = true;
    kerb.receiveShadow = true;
    group.add(kerb);
  }

  // --- colliders the detail adds, so a player cannot walk through a pipe stack --
  const extra = [];
  for (const kx of [-HW * 0.62, HW * 0.62]) {
    extra.push(new THREE.Box3().setFromCenterAndSize(
      new THREE.Vector3(kx, 0.07, 0), new THREE.Vector3(0.22, 0.14, HL * 2 - 6)));
  }

  return { lamps: lampSpots.length, extraColliders: extra };
}
