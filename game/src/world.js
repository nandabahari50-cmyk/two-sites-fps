// The map: an original two-site layout built from boxes, and the collision the player and every bot
// share.
//
// Layout, from the attacker's spawn at +z to the defender's at -z. Two lanes run the length of the
// map, joined at the middle by a covered connector, so a round can be played down either lane or
// split across both. Each lane ends at a site: A on the left, B on the right, each with a plantable
// pad, a raised platform to hold from, and a crate cluster that breaks the long sightline.
//
// Nothing here is decoration: every box is a collider, and every box a bullet can hit.
import * as THREE from 'three';
import { concreteMaps, panelMaps, crateMaps, floorMaps, paintMaps } from './textures.js';

const WALL_COLOR = '#3c4550';
const FLOOR_COLOR = '#4c545e';
const CRATE_COLOR = '#7a6247';
const PLATFORM_COLOR = '#5a6169';
const SITE_COLOR = '#a94a36';
const ACCENT = '#b8863b';

/**
 * Repeat a texture so one tile covers `worldSize` metres regardless of the mesh's own UVs.
 *
 * A BoxGeometry's UVs are 0..1 per face, so a 40-metre wall and a 1-metre crate would show the same
 * number of tiles and the wall's texture would smear. Scaling `repeat` by the face size is the cheap
 * fix that works for the axis-aligned boxes this map is built from.
 */
function setTile(maps, w, h, d, metres) {
  // The dominant face of a given box decides its tiling: walls tile by height and length, floors by
  // their footprint. Using the two largest dimensions keeps tiles square-ish on every box.
  const dims = [w, h, d].sort((a, b) => b - a);
  const a = Math.max(0.5, dims[0] / metres);
  const b = Math.max(0.5, dims[1] / metres);
  for (const tex of Object.values(maps)) {
    if (!tex || !tex.repeat) continue;
    tex.repeat.set(a, b);
  }
}

export function createWorld(scene) {
  const group = new THREE.Group();
  scene.add(group);

  // One material per surface kind, each carrying a base colour, a roughness map and a normal map.
  // The maps are procedural (textures.js), so the surfaces have relief for the light to catch
  // instead of reading as flat panels. `repeat` on the maps is overwritten per mesh in box().
  //
  // material.color stays white wherever a map is present: three.js multiplies the two, so a dark
  // colour over an already-tinted map would square the darkness. The texture carries the albedo.
  const wallMaps = concreteMaps({ seed: 1, tint: [0.44, 0.47, 0.51] });
  const floorMaps0 = floorMaps({ seed: 21, tint: [0.38, 0.40, 0.43] });
  const crateMaps0 = crateMaps({ seed: 13, tint: [0.55, 0.41, 0.26] });
  const platformMaps = panelMaps({ seed: 7, tint: [0.42, 0.45, 0.49] });
  const accentMaps = paintMaps({ seed: 61, tint: [0.70, 0.52, 0.22] });
  const siteMaps = paintMaps({ seed: 73, tint: [0.66, 0.28, 0.20] });
  const WHITE = new THREE.Color(0xffffff);

  const mats = {
    wall: new THREE.MeshStandardMaterial({
      color: WHITE, roughness: 0.95, metalness: 0.02,
      map: wallMaps.map, normalMap: wallMaps.normalMap, roughnessMap: wallMaps.roughnessMap,
      normalScale: new THREE.Vector2(0.85, 0.85),
    }),
    floor: new THREE.MeshStandardMaterial({
      color: WHITE, roughness: 0.9, metalness: 0.05,
      map: floorMaps0.map, normalMap: floorMaps0.normalMap, roughnessMap: floorMaps0.roughnessMap,
      normalScale: new THREE.Vector2(0.7, 0.7),
    }),
    crate: new THREE.MeshStandardMaterial({
      color: WHITE, roughness: 0.85, metalness: 0.0,
      map: crateMaps0.map, normalMap: crateMaps0.normalMap, roughnessMap: crateMaps0.roughnessMap,
      normalScale: new THREE.Vector2(1.0, 1.0),
    }),
    platform: new THREE.MeshStandardMaterial({
      color: WHITE, roughness: 0.8, metalness: 0.1,
      map: platformMaps.map, normalMap: platformMaps.normalMap, roughnessMap: platformMaps.roughnessMap,
      normalScale: new THREE.Vector2(0.9, 0.9),
    }),
    site: new THREE.MeshStandardMaterial({
      color: WHITE, roughness: 0.6, metalness: 0.2,
      map: siteMaps.map, normalMap: siteMaps.normalMap, roughnessMap: siteMaps.roughnessMap,
    }),
    accent: new THREE.MeshStandardMaterial({
      color: WHITE, roughness: 0.4, metalness: 0.5,
      emissive: new THREE.Color(ACCENT), emissiveIntensity: 0.35,
      map: accentMaps.map, normalMap: accentMaps.normalMap, roughnessMap: accentMaps.roughnessMap,
    }),
  };

  const MAT_MAPS = {
    wall: wallMaps, floor: floorMaps0, crate: crateMaps0,
    platform: platformMaps, site: siteMaps, accent: accentMaps,
  };
  // Metres per texture tile, per surface kind: concrete slabs are large, crate planks small.
  const MAT_TILE = { wall: 4.0, floor: 4.0, crate: 1.4, platform: 2.5, site: 3.0, accent: 2.0 };

  const colliders = [];
  const shootables = [];
  const geometryCache = new Map();

  function boxGeometry(w, h, d) {
    const key = `${w}|${h}|${d}`;
    let g = geometryCache.get(key);
    if (!g) {
      g = new THREE.BoxGeometry(w, h, d);
      geometryCache.set(key, g);
    }
    return g;
  }

  // Texture repeat lives on the texture, and materials are shared, so a per-mesh repeat needs a
  // per-mesh material. Cloning one per box would upload the same canvas dozens of times, so the
  // repeat is quantised to half-tile steps and materials are cached per (kind, repeat) pair.
  // The map has ~40 boxes; that collapses to a couple of dozen materials sharing six canvases.
  const matCache = new Map();
  function materialFor(kind, a, b) {
    const qa = Math.max(1, Math.round(a * 2) / 2);
    const qb = Math.max(1, Math.round(b * 2) / 2);
    const key = `${kind}|${qa}|${qb}`;
    let m = matCache.get(key);
    if (m) return m;
    const src = mats[kind];
    m = src.clone();
    for (const field of ['map', 'normalMap', 'roughnessMap']) {
      const tex = src[field];
      if (!tex) continue;
      const t = tex.clone();
      t.repeat.set(qa, qb);
      t.needsUpdate = true;
      m[field] = t;
    }
    matCache.set(key, m);
    return m;
  }

  function box(w, h, d, x, y, z, mat) {
    const dims = [w, h, d].sort((p, q) => q - p);
    const tile = MAT_TILE[mat] ?? 3;
    const material = materialFor(mat, dims[0] / tile, dims[1] / tile);
    const mesh = new THREE.Mesh(boxGeometry(w, h, d), material);
    mesh.position.set(x, y, z);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    group.add(mesh);
    colliders.push(new THREE.Box3().setFromObject(mesh));
    shootables.push(mesh);
    return mesh;
  }

  const HALF_W = 20;
  const HALF_L = 32;

  box(HALF_W * 2 + 2, 0.5, HALF_L * 2 + 2, 0, -0.25, 0, 'floor');

  // Outer walls.
  box(1, 7, HALF_L * 2 + 2, -HALF_W - 0.5, 3.5, 0, 'wall');
  box(1, 7, HALF_L * 2 + 2, HALF_W + 0.5, 3.5, 0, 'wall');
  box(HALF_W * 2 + 2, 7, 1, 0, 3.5, -HALF_L - 0.5, 'wall');
  box(HALF_W * 2 + 2, 7, 1, 0, 3.5, HALF_L + 0.5, 'wall');

  // The mid spine: a long wall that splits the map into two lanes, with a gap in the middle so teams
  // can rotate between sites without walking the whole length.
  box(1.2, 7, 20, 0, 3.5, 14, 'wall');
  box(1.2, 7, 20, 0, 3.5, -14, 'wall');

  // Connector cover at mid: a half wall on each side of the gap, so crossing mid is a decision.
  box(6, 1.2, 1.2, -3.6, 0.6, 2.4, 'platform');
  box(6, 1.2, 1.2, 3.6, 0.6, 2.4, 'platform');
  box(1.2, 1.2, 6, -3.6, 0.6, -2.4, 'platform');
  box(1.2, 1.2, 6, 3.6, 0.6, -2.4, 'platform');

  // Site A, left front: raised platform to hold from, crates to peek around, plant pad.
  const padA = box(6, 0.12, 6, -13.5, 0.06, -24, 'site');
  box(7, 1.4, 7, -16.5, 0.7, -28.5, 'platform');
  box(2.2, 2.2, 2.2, -9.4, 1.1, -20.5, 'crate');
  box(2.2, 2.2, 2.2, -9.4, 1.1, -18.2, 'crate');
  box(2.2, 1.1, 2.2, -9.4, 0.55, -22.6, 'crate');
  box(1.4, 3.4, 1.4, -12.2, 1.7, -16.4, 'wall');

  // Site B, right front: same language, different shape, so the sites are not one baked layout.
  const padB = box(6, 0.12, 6, 13.5, 0.06, -24, 'site');
  box(7, 1.4, 7, 16.5, 0.7, -28.5, 'platform');
  box(2.2, 2.2, 2.2, 9.4, 1.1, -20.5, 'crate');
  box(2.2, 1.1, 2.2, 9.4, 0.55, -18.2, 'crate');
  box(2.2, 2.2, 2.2, 11.6, 1.1, -27.2, 'crate');
  box(1.4, 3.4, 1.4, 12.2, 1.7, -16.4, 'wall');

  // Lane cover: staggered crates so neither lane is a straight run into the site.
  box(2.6, 1.6, 2.6, -8.5, 0.8, -6, 'crate');
  box(2.6, 1.6, 2.6, -12.5, 0.8, -1, 'crate');
  box(2.6, 1.6, 2.6, 8.5, 0.8, -6, 'crate');
  box(2.6, 1.6, 2.6, 12.5, 0.8, -1, 'crate');
  box(2.6, 1.6, 2.6, -11, 0.8, 8, 'crate');
  box(2.6, 1.6, 2.6, 11, 0.8, 8, 'crate');

  // Attacker side: a low wall at each spawn mouth so the opening peek is not free.
  box(5, 1.3, 1, -10, 0.65, 26, 'platform');
  box(5, 1.3, 1, 10, 0.65, 26, 'platform');

  // Defender side: a rail along the back of each site to shoot over from the platform.
  box(7, 1.1, 0.6, -16.5, 1.95, -25.5, 'platform');
  box(7, 1.1, 0.6, 16.5, 1.95, -25.5, 'platform');

  // Accent rims so the plant pads read at a glance from across the map.
  const rimA = box(6.6, 0.16, 0.3, -13.5, 0.08, -20.9, 'accent');
  const rimB = box(6.6, 0.16, 0.3, 13.5, 0.08, -20.9, 'accent');
  rimA.castShadow = false;
  rimB.castShadow = false;

  // Lighting, now that the scene has an environment map and filmic tone mapping: the hemisphere is
  // dialled back because the IBL already supplies the sky bounce, the key stays for the shadows that
  // let geometry read, and the fill keeps the far side off black.
  scene.add(new THREE.HemisphereLight(new THREE.Color('#b9cfe4'), new THREE.Color('#2a3038'), 0.55));

  const key = new THREE.DirectionalLight(new THREE.Color('#ffe9cd'), 2.2);
  key.position.set(18, 26, 16);
  key.castShadow = true;
  key.shadow.mapSize.set(2048, 2048);
  key.shadow.camera.left = -40;
  key.shadow.camera.right = 40;
  key.shadow.camera.top = 40;
  key.shadow.camera.bottom = -40;
  key.shadow.camera.far = 90;
  key.shadow.bias = -0.0009;
  key.shadow.normalBias = 0.02;
  scene.add(key);

  const fill = new THREE.DirectionalLight(new THREE.Color('#8fb0d6'), 0.55);
  fill.position.set(-16, 14, -20);
  scene.add(fill);

  // Each site gets its own light so the pads glow and the map reads from spawn.
  const siteLightA = new THREE.PointLight(new THREE.Color(ACCENT), 10, 16, 2);
  siteLightA.position.set(-13.5, 3.2, -24);
  scene.add(siteLightA);
  const siteLightB = new THREE.PointLight(new THREE.Color(ACCENT), 10, 16, 2);
  siteLightB.position.set(13.5, 3.2, -24);
  scene.add(siteLightB);

  const sites = [
    { id: 'A', center: new THREE.Vector3(-13.5, 0, -24), radius: 4.2 },
    { id: 'B', center: new THREE.Vector3(13.5, 0, -24), radius: 4.2 },
  ];

  const attackSpawns = [
    new THREE.Vector3(-8, 0, 28), new THREE.Vector3(-3, 0, 29), new THREE.Vector3(2, 0, 29),
    new THREE.Vector3(7, 0, 28), new THREE.Vector3(0, 0, 30),
  ];
  const defendSpawns = [
    new THREE.Vector3(-14, 0, -29), new THREE.Vector3(-8, 0, -29), new THREE.Vector3(0, 0, -30),
    new THREE.Vector3(8, 0, -29), new THREE.Vector3(14, 0, -29),
  ];

  // Bot routes: waypoints down a lane into a site, plus the mid rotate, so the two teams do not
  // simply meet in the same spot every round.
  const routes = {
    A_long: [new THREE.Vector3(-11, 0, 22), new THREE.Vector3(-13, 0, 10), new THREE.Vector3(-13, 0, -4), new THREE.Vector3(-13.5, 0, -18)],
    A_short: [new THREE.Vector3(-3, 0, 12), new THREE.Vector3(-4.5, 0, 0), new THREE.Vector3(-9, 0, -12), new THREE.Vector3(-13.5, 0, -18)],
    B_long: [new THREE.Vector3(11, 0, 22), new THREE.Vector3(13, 0, 10), new THREE.Vector3(13, 0, -4), new THREE.Vector3(13.5, 0, -18)],
    B_short: [new THREE.Vector3(3, 0, 12), new THREE.Vector3(4.5, 0, 0), new THREE.Vector3(9, 0, -12), new THREE.Vector3(13.5, 0, -18)],
    mid: [new THREE.Vector3(0, 0, 10), new THREE.Vector3(0, 0, -2), new THREE.Vector3(0, 0, -12)],
  };

  // Hold points a defender takes: two per site, plus the connector.
  const holdPoints = {
    A: [new THREE.Vector3(-16.5, 0, -25.6), new THREE.Vector3(-9.4, 0, -16.4), new THREE.Vector3(-12.2, 0, -14)],
    B: [new THREE.Vector3(16.5, 0, -25.6), new THREE.Vector3(9.4, 0, -16.4), new THREE.Vector3(12.2, 0, -14)],
    mid: [new THREE.Vector3(3.6, 0, -2.4), new THREE.Vector3(-3.6, 0, -2.4)],
  };

  return {
    group, colliders, shootables, sites, attackSpawns, defendSpawns, routes, holdPoints,
    padA, padB, halfW: HALF_W, halfL: HALF_L, palette: { accent: ACCENT, wall: WALL_COLOR, site: SITE_COLOR },
  };
}
