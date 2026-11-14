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

const WALL_COLOR = '#3c4550';
const FLOOR_COLOR = '#4c545e';
const CRATE_COLOR = '#7a6247';
const PLATFORM_COLOR = '#5a6169';
const SITE_COLOR = '#a94a36';
const ACCENT = '#b8863b';

export function createWorld(scene) {
  const group = new THREE.Group();
  scene.add(group);

  const mats = {
    wall: new THREE.MeshStandardMaterial({ color: new THREE.Color(WALL_COLOR), roughness: 0.95, metalness: 0.02 }),
    floor: new THREE.MeshStandardMaterial({ color: new THREE.Color(FLOOR_COLOR), roughness: 0.9, metalness: 0.05 }),
    crate: new THREE.MeshStandardMaterial({ color: new THREE.Color(CRATE_COLOR), roughness: 0.85, metalness: 0.0 }),
    platform: new THREE.MeshStandardMaterial({ color: new THREE.Color(PLATFORM_COLOR), roughness: 0.8, metalness: 0.1 }),
    site: new THREE.MeshStandardMaterial({ color: new THREE.Color(SITE_COLOR), roughness: 0.6, metalness: 0.2 }),
    accent: new THREE.MeshStandardMaterial({ color: new THREE.Color(ACCENT), roughness: 0.4, metalness: 0.5, emissive: new THREE.Color(ACCENT), emissiveIntensity: 0.25 }),
  };

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

  function box(w, h, d, x, y, z, mat) {
    const mesh = new THREE.Mesh(boxGeometry(w, h, d), mats[mat]);
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

  // Lighting: cool hemisphere for shape, warm key for the shadows that let the geometry read, dim
  // bounce on the opposite side so nothing goes black.
  scene.add(new THREE.HemisphereLight(new THREE.Color('#b9cfe4'), new THREE.Color('#2a3038'), 1.55));

  const key = new THREE.DirectionalLight(new THREE.Color('#ffe9cd'), 2.7);
  key.position.set(18, 26, 16);
  key.castShadow = true;
  key.shadow.mapSize.set(2048, 2048);
  key.shadow.camera.left = -40;
  key.shadow.camera.right = 40;
  key.shadow.camera.top = 40;
  key.shadow.camera.bottom = -40;
  key.shadow.camera.far = 90;
  key.shadow.bias = -0.0009;
  scene.add(key);

  const fill = new THREE.DirectionalLight(new THREE.Color('#8fb0d6'), 1.05);
  fill.position.set(-16, 14, -20);
  scene.add(fill);

  // Each site gets its own light so the pads glow and the map reads from spawn.
  const siteLightA = new THREE.PointLight(new THREE.Color(ACCENT), 14, 16, 2);
  siteLightA.position.set(-13.5, 3.2, -24);
  scene.add(siteLightA);
  const siteLightB = new THREE.PointLight(new THREE.Color(ACCENT), 14, 16, 2);
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
