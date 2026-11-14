// Two Sites: the boot, the one loop, and the systems wired together.
//
// The loop keeps three things apart, which is the architecture of the whole game:
//
//   * input events are queued (input.js) and drained once per rendered frame;
//   * the simulation runs on a fixed 1/60 step, as many times as the frame's elapsed time allows, so
//     a fast machine and a slow one simulate the same game;
//   * rendering happens once per frame, and nothing inside the simulation touches the DOM or the
//     renderer.
//
// ?shot=start|play|end|buy|freeze with &seed=N sets up a deterministic frame for a screenshot: it
// drives the simulation forward with no input, renders twice, freezes, and sets window.__shotReady.
import * as THREE from 'three';
import { createWorld } from './world.js';
import { createInput } from './input.js';
import { createPlayer } from './player.js';
import { createHud } from './hud.js';
import { createBots } from './roster.js';
import { createRound } from './round.js';
import { createBomb } from './bomb.js';
import { createState, TEAM, MONEY_KILL, MONEY_CAP } from './state.js';
import { configureTextures, environmentTexture, panelMaps, fabricMaps } from './textures.js';
import { createOperatorKit } from './operator.js';
import { createPostFX } from './postfx.js';
import { createEffects } from './effects.js';
import { WEAPONS, createWeaponState, equip, startReload, stepWeapon, takeRound, spreadOf, scatter, damageFor } from './weapons.js';
import { buy, menuHtml, BUY_LIST } from './buy.js';
import { stepBot } from './bots.js';

const FIXED_STEP = 1 / 60;
const MAX_STEPS_PER_FRAME = 6;

const params = new URLSearchParams(window.location.search);
const shot = params.get('shot');
const seed = Number.parseInt(params.get('seed') ?? '1', 10) || 1;

/** Deterministic RNG: a shot frame is reproducible, and a round does not shift between runs. */
function mulberry32(initial) {
  let a = initial;
  return function random() {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rand = mulberry32(seed);

// --- Renderer, scene and the viewmodel ---
const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
// Filmic tone mapping: without it, emissive accents and the key light clip to white and the image
// reads flat. ACES compresses the highlights so bright surfaces keep their hue.
// Tone mapping and the sRGB encode live in the post composite, because drawing to an offscreen
// target skips both. Doing them twice would double-brighten, so the renderer is left on NoToneMapping
// and the output space is linear; the composite writes final display values.
renderer.toneMapping = THREE.NoToneMapping;
if (THREE.LinearSRGBColorSpace) renderer.outputColorSpace = THREE.LinearSRGBColorSpace;
document.getElementById('game').appendChild(renderer.domElement);

const scene = new THREE.Scene();
scene.background = new THREE.Color('#232a33');
scene.fog = new THREE.Fog(new THREE.Color('#232a33'), 65, 130);
const camera = new THREE.PerspectiveCamera(76, window.innerWidth / window.innerHeight, 0.05, 200);
const muzzlePoint = new THREE.Vector3();
scene.add(camera);

// Image-based lighting. The metalness channel on every material is a lie without an environment to
// reflect: metallic surfaces would render black. A painted sky is pushed through PMREM once and used
// as the scene environment, which also gives the surfaces a soft ambient that follows the sky.
configureTextures(renderer);
const envTex = environmentTexture(renderer, {
  sky: [0.34, 0.44, 0.60],
  horizon: [0.62, 0.59, 0.54],
  ground: [0.16, 0.15, 0.14],
  sun: [1.0, 0.90, 0.74],
});
scene.environment = envTex;
scene.environmentIntensity = 0.55;

// The gun in the player's hands lives in its own scene, drawn after the world with the depth buffer
// cleared, so it never clips into a wall the player is standing against.
const viewScene = new THREE.Scene();
const viewCamera = new THREE.PerspectiveCamera(58, window.innerWidth / window.innerHeight, 0.01, 6);
// The viewmodel has its own environment so the weapon's metal reads: the world env lives on the
// world scene, and this scene would otherwise sample black on every metalness surface.
viewScene.environment = envTex;
viewScene.environmentIntensity = 0.9;
// Resting distance of the viewmodel from the eye. Closer than the old -0.42 so the hands sit
// inside the frame instead of hanging off the bottom edge.
const REST_Z = -0.33;
const viewGun = new THREE.Group();
{
  // Weapon metal: dark parkerised steel with a roughness map so the highlight breaks along the
  // receiver instead of reading as one flat bar.
  const steelMaps = panelMaps({ size: 256, seed: 90, tint: [0.20, 0.21, 0.23] });
  const bodyMat = new THREE.MeshStandardMaterial({
    color: 0xffffff, roughness: 0.42, metalness: 0.8,
    map: steelMaps.map, roughnessMap: steelMaps.roughnessMap, normalMap: steelMaps.normalMap,
    normalScale: new THREE.Vector2(1.2, 1.2),
  });
  const polymerMaps = panelMaps({ size: 256, seed: 92, tint: [0.16, 0.17, 0.18] });
  const polymerMat = new THREE.MeshStandardMaterial({
    color: 0xffffff, roughness: 0.78, metalness: 0.12,
    map: polymerMaps.map, roughnessMap: polymerMaps.roughnessMap, normalMap: polymerMaps.normalMap,
  });
  // Gloved hand: fabric maps so the fingers of the grip read at the edge of frame.
  const gloveMaps = fabricMaps({ size: 128, seed: 94, tint: [0.46, 0.40, 0.31] });
  const gloveMat = new THREE.MeshStandardMaterial({
    color: 0xffffff, roughness: 0.9, metalness: 0.02,
    map: gloveMaps.map, normalMap: gloveMaps.normalMap, roughnessMap: gloveMaps.roughnessMap,
  });
  const sleeveMat = new THREE.MeshStandardMaterial({ color: 0x55584e, roughness: 0.95, metalness: 0.02 });

  const receiver = new THREE.Mesh(new THREE.BoxGeometry(0.09, 0.1, 0.42), bodyMat);
  const receiverTop = new THREE.Mesh(new THREE.BoxGeometry(0.07, 0.035, 0.34), polymerMat);
  receiverTop.position.set(0, 0.062, -0.02);
  const barrel = new THREE.Mesh(new THREE.CylinderGeometry(0.017, 0.017, 0.40, 10), bodyMat);
  barrel.rotation.x = Math.PI / 2;
  barrel.position.set(0, 0.014, -0.40);
  const handguard = new THREE.Mesh(new THREE.BoxGeometry(0.055, 0.065, 0.26), polymerMat);
  handguard.position.set(0, 0.008, -0.30);
  // Vent slots on the handguard: three thin boxes that read as cut-outs at this distance.
  for (let i = 0; i < 3; i += 1) {
    const slot = new THREE.Mesh(new THREE.BoxGeometry(0.062, 0.012, 0.03), bodyMat);
    slot.position.set(0, 0.03, -0.22 - i * 0.07);
    viewGun.add(slot);
  }
  const stock = new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.09, 0.26), polymerMat);
  stock.position.set(0, -0.012, 0.30);
  const cheek = new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.03, 0.18), polymerMat);
  cheek.position.set(0, 0.045, 0.30);
  const grip = new THREE.Mesh(new THREE.BoxGeometry(0.055, 0.16, 0.07), polymerMat);
  grip.position.set(0, -0.11, 0.13);
  grip.rotation.x = 0.32;
  const mag = new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.18, 0.08), polymerMat);
  mag.position.set(0, -0.13, -0.04);
  mag.rotation.x = -0.20;
  const sightRear = new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.04, 0.03), bodyMat);
  sightRear.position.set(0, 0.085, 0.10);
  const sightFront = new THREE.Mesh(new THREE.BoxGeometry(0.03, 0.045, 0.025), bodyMat);
  sightFront.position.set(0, 0.095, -0.36);
  viewGun.add(receiver, receiverTop, barrel, handguard, stock, cheek, grip, mag, sightRear, sightFront);

  // Right hand on the grip, left hand on the handguard: two gloved blocks and a forearm each, so the
  // weapon is held rather than floating.
  // The forearm is what reaches toward the camera: it runs +z (back toward the shooter) from the
  // hand, so the arms occupy the lower corners of the frame the way a held weapon does.
  function hand(x, y, z, rotX, rotY) {
    const g = new THREE.Group();
    const palm = new THREE.Mesh(new THREE.BoxGeometry(0.075, 0.10, 0.085), gloveMat);
    const thumb = new THREE.Mesh(new THREE.BoxGeometry(0.025, 0.05, 0.05), gloveMat);
    thumb.position.set(-0.045, 0.02, -0.02);
    const fingers = new THREE.Mesh(new THREE.BoxGeometry(0.075, 0.055, 0.06), gloveMat);
    fingers.position.set(0, 0.055, -0.03);
    const wrist = new THREE.Mesh(new THREE.CylinderGeometry(0.042, 0.048, 0.07, 8), sleeveMat);
    wrist.rotation.x = Math.PI / 2;
    wrist.position.set(0, -0.045, 0.06);
    const arm = new THREE.Mesh(new THREE.BoxGeometry(0.08, 0.085, 0.30), sleeveMat);
    arm.position.set(0, -0.03, 0.22);
    arm.rotation.x = -0.22;
    g.add(palm, thumb, fingers, wrist, arm);
    g.position.set(x, y, z);
    g.rotation.set(rotX, rotY, 0);
    g.traverse((o) => { if (o.isMesh) o.castShadow = false; });
    return g;
  }
  const gripHand = hand(0, -0.05, 0.06, 0.26, 0);
  gripHand.userData.probe = 'hand';
  const guardHand = hand(0, -0.045, -0.24, -0.10, 0);
  guardHand.userData.probe = 'hand';
  viewGun.add(gripHand, guardHand);

  // Framing: the camera sees y ∈ ±0.17 at z = -0.35, so the grip and the guard hand have to sit
  // inside that band or they fall off the bottom of the screen. The gun is raised and pushed
  // forward until both hands are in frame, and the arms run back toward the camera below them.
  viewGun.position.set(0.105, -0.020, REST_Z);
  viewGun.rotation.set(0.012, -0.045, 0.01);
  viewScene.add(viewGun);

  const vLight = new THREE.DirectionalLight(new THREE.Color('#ffe6c4'), 2.6);
  vLight.position.set(0.6, 1, 0.8);
  viewScene.add(vLight);
  const vFill = new THREE.DirectionalLight(new THREE.Color('#7f9dc4'), 0.8);
  vFill.position.set(-0.8, 0.3, 0.5);
  viewScene.add(vFill);
  viewScene.add(new THREE.HemisphereLight(new THREE.Color('#a8c0d8'), new THREE.Color('#20242a'), 0.7));
}

// --- Systems ---
const world = createWorld(scene);
const effects = createEffects(scene);
const postfx = createPostFX(renderer, { ao: true, bloom: true });
postfx.setCamera(camera);
postfx.resize(window.innerWidth, window.innerHeight);
const hud = createHud();
hud.mount();

const player = createPlayer(world);
player.side = TEAM.ATTACK;
player.weapon = 'sidearm';
player.weaponState = createWeaponState('sidearm');
player.armour = 100;

const state = createState(world);
const operatorKit = createOperatorKit(renderer);
const bots = createBots(scene, world, rand, operatorKit);
const round = createRound(world, { state, player, bots, hud });
const bomb = createBomb(scene, world);

const raycaster = new THREE.Raycaster();
raycaster.far = 120;
const shootables = world.shootables.slice();
for (const bot of bots) shootables.push(bot.head, bot.torso, bot.legs[0], bot.legs[1]);

const aimDir = new THREE.Vector3();
const shotDir = new THREE.Vector3();
const eyePoint = new THREE.Vector3();
const botEye = new THREE.Vector3();
const botAim = new THREE.Vector3();

// --- Input and UI state ---
const input = createInput(renderer.domElement, onLockChange);
let started = false;
let frozenForShot = false;
let paused = true;
let buyOpen = false;

function onLockChange(locked) {
  if (shot) return;
  if (locked) {
    paused = false;
    started = true;
    hud.hideOverlay();
  } else {
    paused = true;
    if (state.phase !== 'matchEnd') hud.setOverlay(started ? 'paused' : 'start');
  }
}

hud.onPlay(() => input.requestLock());

// --- Combat ---
function hurtBot(bot, amount, fromSide) {
  if (!bot.alive || bot.side === fromSide) return false;
  bot.hp -= amount;
  if (bot.hp <= 0) {
    bot.alive = false;
    bot.hp = 0;
    bot.deathTilt = 0;
    return true;
  }
  // Being hit turns a bot toward the shooter even when it had not seen them.
  bot.hasLastKnown = true;
  bot.lastKnown.set(player.state.position.x, 0, player.state.position.z);
  return false;
}

function firePlayer() {
  if (!player.state.alive) return;
  const def = player.weaponState.def;
  if (!takeRound(player.weaponState)) return;

  const crouched = player.state.crouching;
  const spread = spreadOf(player.weaponState, player.state.speed, crouched);
  player.aimDirection(aimDir);
  camera.getWorldPosition(eyePoint);

  let hitSomething = false;
  let killedSomething = false;
  let endPoint = null;
  let endNormal = null;
  let gotFlesh = false;

  // Where the muzzle actually is in the world: just in front of the camera, low right, so the flash
  // and the tracer leave the weapon rather than the eye.
  muzzlePoint.copy(eyePoint).addScaledVector(aimDir, 0.55);
  muzzlePoint.y -= 0.12;

  for (let pellet = 0; pellet < def.pellets; pellet += 1) {
    scatter(aimDir, spread, rand, shotDir);
    raycaster.set(eyePoint, shotDir);
    const hits = raycaster.intersectObjects(shootables, false);
    for (let i = 0; i < hits.length; i += 1) {
      const hit = hits[i];
      const target = hit.object.userData.bot;
      if (target) {
        hitSomething = true;
        gotFlesh = true;
        // Blood-mist tint rather than sparks when a pellet lands on a body.
        endPoint = hit.point;
        endNormal = shotDir.clone().negate();
        const part = hit.object.userData.part ?? 'torso';
        if (hurtBot(target, damageFor(def, part), player.side)) {
          killedSomething = true;
          state.money = Math.min(MONEY_CAP, state.money + MONEY_KILL);
          hud.kill('you', target.name, part === 'head');
        }
        break;
      }
      if (hit.object.visible) {
        // A wall stops the pellet: sparks and a hole where it struck.
        endPoint = hit.point;
        endNormal = hit.face ? hit.face.normal.clone() : shotDir.clone().negate();
        if (hit.object.matrixWorld) endNormal.transformDirection(hit.object.matrixWorld).normalize();
        break;
      }
    }
    if (endPoint) break;
  }

  const strength = def.pellets > 4 ? 1.25 : 1.0;
  effects.gunshot(muzzlePoint, endPoint, endNormal, {
    strength,
    sparks: gotFlesh ? 14 : 10,
    tint: gotFlesh ? [0.85, 0.13, 0.10] : [1.0, 0.76, 0.42],
  });

  if (hitSomething) hud.hitMarker(killedSomething);
  const kick = def.recoil * (crouched ? 0.7 : 1);
  player.recoil(kick, (rand() * 2 - 1) * def.recoil * 0.55);
  viewGun.position.z = REST_Z + 0.03;
}

function botShoot(bot, jitter) {
  if (!bot.alive || !bot.target || !bot.target.alive) return;
  const def = WEAPONS[bot.weapon] ?? WEAPONS.rifle;
  botEye.set(bot.position.x, bot.eyeHeight, bot.position.z);
  const tgt = bot.target;
  botAim.set(tgt.position.x, (tgt.eyeHeight ?? 1.5) * 0.92, tgt.position.z).sub(botEye).normalize();
  scatter(botAim, jitter, rand, shotDir);
  raycaster.set(botEye, shotDir);
  const hits = raycaster.intersectObjects(shootables, false);
  // The bot's own muzzle sits at its weapon, so its flash and tracer read from the right place.
  const botMuzzle = botEye.clone().addScaledVector(shotDir, 0.5);
  botMuzzle.y -= 0.08;
  let botHit = null;
  let botNormal = null;
  for (let i = 0; i < hits.length; i += 1) {
    const hit = hits[i];
    const victimBot = hit.object.userData.bot;
    const part = hit.object.userData.part ?? 'torso';
    const isPlayerBody = hit.object.userData.player === true;
    if (isPlayerBody || (victimBot && victimBot !== bot)) {
      botHit = hit.point;
      botNormal = shotDir.clone().negate();
      const dmg = damageFor(def, part) * 0.85;
      if (isPlayerBody) {
        if (player.armour > 0) player.armour = Math.max(0, player.armour - dmg * 0.55);
        const dead = player.damage(dmg * 0.9);
        state.hitFlash = Math.min(1, state.hitFlash + 0.55);
        state.damageTaken += dmg;
        if (dead) hud.kill(bot.name, 'you', part === 'head');
      } else if (hurtBot(victimBot, dmg, bot.side)) {
        hud.kill(bot.name, victimBot.name, part === 'head');
      }
      break;
    }
    if (hit.object.visible) break;
  }
}

/** The player's body as a bot sees it: mutated in place, never allocated in the loop. */
const playerBody = { alive: true, isPlayer: true, eyeHeight: 1.62, position: new THREE.Vector3() };
const enemiesScratch = [];

// --- Simulation ---
let accumulator = 0;
let lastTime = performance.now();

function stepSim(dt) {
  const inFreeze = state.phase === 'freeze';

  player.step(dt, input.state.keys, input.takeJump(), inFreeze);
  stepWeapon(player.weaponState, dt);

  playerBody.alive = player.state.alive;
  playerBody.position.copy(player.state.position);
  playerBody.eyeHeight = player.state.eye;

  for (const bot of bots) {
    if (!bot.alive) {
      bot.deathTilt = Math.min(1, bot.deathTilt + dt * 3.4);
      bot.group.rotation.x = bot.deathTilt * 1.35;
      bot.group.position.y = -bot.deathTilt * 0.35;
      continue;
    }
    if (inFreeze) {
      bot.yaw = bot.side === TEAM.ATTACK ? Math.PI : 0;
      continue;
    }
    const enemyTeam = bot.side === TEAM.ATTACK ? TEAM.DEFEND : TEAM.ATTACK;
    enemiesScratch.length = 0;
    for (const other of bots) if (other.side === enemyTeam && other.alive) enemiesScratch.push(other);
    if (player.side === enemyTeam && player.state.alive) enemiesScratch.push(playerBody);
    stepBot(bot, dt, {
      world,
      enemies: enemiesScratch,
      rand,
      time: state.time,
      weaponDef: WEAPONS[bot.weapon] ?? WEAPONS.rifle,
      onShoot: (shooter, jitter) => botShoot(shooter, jitter),
    });
  }

  bomb.update(state, player, dt, input.state.keys);
  round.step(dt);

  for (const ev of state.events) {
    if (ev.kind === 'round' || ev.kind === 'live' || ev.kind === 'match' || ev.kind === 'swap') hud.banner(ev.text);
    else if (ev.kind === 'plant') hud.banner('BOMB PLANTED', 1.6);
    else if (ev.kind === 'defuse') hud.banner('BOMB DEFUSED', 1.6);
  }
  state.events.length = 0;

  if (state.hitFlash > 0) state.hitFlash = Math.max(0, state.hitFlash - dt * 1.8);
}

// --- HUD ---
function formatClock(seconds) {
  const s = Math.max(0, Math.ceil(seconds));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

function shortName(id) {
  if (id === 'rifle') return 'AK';
  if (id === 'smg') return 'K7';
  if (id === 'shotgun') return 'B2';
  return 'P9';
}

function updateHud(dt) {
  const w = player.weaponState;
  const clock = state.bomb.state === 'planted' ? state.bomb.timer : state.phaseTime;
  hud.update({
    hp: player.state.hp,
    armour: player.armour,
    mag: w.mag,
    reserve: w.reserve,
    money: state.money,
    clock: formatClock(clock),
    score: `${state.score[TEAM.ATTACK]} — ${state.score[TEAM.DEFEND]}`,
    round: state.round,
    weapon: shortName(w.def.id),
    bomb: state.bomb.state === 'planted' ? `BOMB ${Math.max(0, Math.ceil(state.bomb.timer))}s` : '',
    hint: state.plHint ?? (state.phase === 'freeze' ? 'Press B to buy' : ''),
    spread: spreadOf(w, player.state.speed, player.state.crouching),
    damageFlash: state.hitFlash,
  });
  hud.tick(dt);
  hud.ageFeed(dt);
  hud.setBuy(buyOpen ? menuHtml(state) : '');
}

// --- The loop ---
function frame(now) {
  requestAnimationFrame(frame);
  const elapsed = Math.min((now - lastTime) / 1000, 0.25);
  lastTime = now;

  if (!frozenForShot) {
    const look = input.takeLook();
    if (!paused) player.look(look.x, look.y);

    if (!paused) {
      const pressed = input.takePressed();
      if (pressed === 'KeyB') buyOpen = !buyOpen && state.phase === 'freeze';
      if (pressed === 'KeyR') startReload(player.weaponState);
      if (buyOpen && pressed && pressed.startsWith('Digit')) {
        const idx = Number.parseInt(pressed.slice(5), 10) - 1;
        const entry = BUY_LIST[idx];
        if (entry) {
          buy(state, entry, (id) => {
            player.weapon = id;
            equip(player.weaponState, id);
          });
        }
      }

      const w = player.weaponState;
      if (input.state.firing && state.phase !== 'freeze' && player.state.alive) {
        // Automatic weapons fire while held; the rest need a fresh hold each round.
        if (w.def.auto || w.burstIndex === 0) firePlayer();
      }

      accumulator += elapsed;
      let steps = 0;
      while (accumulator >= FIXED_STEP && steps < MAX_STEPS_PER_FRAME) {
        stepSim(FIXED_STEP);
        accumulator -= FIXED_STEP;
        steps += 1;
      }
      if (accumulator > FIXED_STEP * MAX_STEPS_PER_FRAME) accumulator = 0;
    }
  }

  player.applyCamera(camera);
  updateHud(elapsed);

  // World through the post chain into the offscreen target, then the viewmodel straight to the
  // screen on top: the weapon is at the camera, so it has nothing to occlude against and no reason
  // to be smeared by a screen-space blur.
  effects.update(elapsed);
  postfx.setCamera(camera);
  postfx.renderWorld(scene, camera, elapsed);
  if (!paused) {
    renderer.autoClear = false;
    renderer.clearDepth();
    viewGun.position.z += (-REST_Z - viewGun.position.z) * Math.min(1, elapsed * 12);
    renderer.render(viewScene, viewCamera);
    renderer.autoClear = true;
  }
}

window.addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  viewCamera.aspect = window.innerWidth / window.innerHeight;
  viewCamera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
  postfx.resize(window.innerWidth, window.innerHeight);
  postfx.setCamera(camera);
});

// --- Boot ---
round.startRound(true);
hud.setOverlay('start');

if (shot) runShot(shot);
else requestAnimationFrame(frame);

/**
 * A screenshot frame. Each name is a different, reproducible situation, and every one drives the
 * real simulation: nothing here is a painted picture the game cannot reach by playing.
 */
function runShot(name) {
  paused = true;
  round.startRound(true);
  hud.hideOverlay();

  if (name === 'start' || name === 'freeze') {
    player.spawnAt(world.attackSpawns[0]);
    player.state.yaw = Math.PI;
    player.state.pitch = -0.02;
    for (let i = 0; i < 30; i += 1) stepSim(FIXED_STEP);
  } else if (name === 'play' || name === 'site') {
    state.phase = 'live';
    state.phaseTime = 78;
    state.time = 27;
    player.spawnAt(new THREE.Vector3(-13.5, 0, -20.5));
    player.state.yaw = 0.18;
    player.state.pitch = -0.03;
    state.money = 4250;
    buy(state, { kind: 'weapon', id: 'rifle' }, (id) => {
      player.weapon = id;
      equip(player.weaponState, id);
    });
    state.grenades.frag = 1;
    for (const bot of bots) {
      if (bot.side === TEAM.DEFEND) {
        // Placed in the player's forward arc: the shot is of a fight, so the fight must be in frame.
        const spreadX = (bot.slot % 3) - 1;
        bot.position.set(-13.0 + spreadX * 2.4, 0, -25.0 + (bot.slot % 2) * 2.2);
        bot.yaw = 0.05;
        bot.arrived = true;
        bot.group.position.set(bot.position.x, 0, bot.position.z);
        bot.group.rotation.y = bot.yaw;
      }
    }
    for (let i = 0; i < 24; i += 1) stepSim(FIXED_STEP);
    firePlayer();
    for (let i = 0; i < 3; i += 1) stepSim(FIXED_STEP);
    hud.kill('you', 'Rook', true);
    hud.banner('SITE A', 99);
    state.plHint = 'Hold E to plant';
  } else if (name === 'end' || name === 'bomb') {
    state.phase = 'live';
    state.time = 64;
    state.bomb.state = 'planted';
    state.bomb.timer = 23;
    state.bomb.site = 'A';
    state.bomb.position = world.sites[0].center.clone();
    player.spawnAt(new THREE.Vector3(-13.5, 0, -18.2));
    player.state.yaw = 0.05;
    player.state.pitch = -0.12;
    state.money = 1200;
    state.score = [2, 1];
    state.round = 4;
    hud.kill('you', 'Vex', false);
    hud.kill('Rook', 'Teammate', false);
    hud.banner('BOMB PLANTED', 99);
    for (let i = 0; i < 20; i += 1) stepSim(FIXED_STEP);
  } else if (name === 'buy') {
    state.phase = 'freeze';
    state.phaseTime = 4.2;
    state.money = 5100;
    buyOpen = true;
    player.spawnAt(world.attackSpawns[0]);
    player.state.yaw = Math.PI;
    for (let i = 0; i < 20; i += 1) stepSim(FIXED_STEP);
  }


  // Measurement bridge, used only by tools/probe_view.py while a shot is being framed: it reports
  // where the viewmodel's parts land in clip space, so a transform can be corrected by arithmetic
  // instead of by eye. Harmless outside a shot because nothing reads it.
  window.__fx = () => effects.debugState();
  window.__probe = () => {
    const out = { restZ: REST_Z, gunPos: viewGun.position.toArray(),
                  gunRot: [viewGun.rotation.x, viewGun.rotation.y, viewGun.rotation.z], parts: [] };
    const camFov = viewCamera.fov * Math.PI / 180;
    const depth = -viewGun.position.z;
    out.frameHalfHeight = Math.tan(camFov / 2) * depth;
    out.frameHalfWidth = out.frameHalfHeight * viewCamera.aspect;
    const v = new THREE.Vector3();
    viewGun.updateMatrixWorld(true);
    viewGun.traverse((o) => {
      if (!o.isGroup && !o.isMesh) return;
      if (!o.userData || !o.userData.probe) return;
      o.getWorldPosition(v);
      const p = v.clone().project(viewCamera);
      out.parts.push({
        name: o.userData.probe,
        world: [round3(v.x), round3(v.y), round3(v.z)],
        ndc: [round3(p.x), round3(p.y), round3(p.z)],
        onScreen: Math.abs(p.x) <= 1 && Math.abs(p.y) <= 1 && p.z > -1 && p.z < 1,
      });
    });
    return out;
  };
  function round3(n) { return Math.round(n * 1000) / 1000; }


  // In a shot the effects are frozen, not advanced: the flash and tracer only live ~50 ms, so a
  // screenshot taken two frames later would show the aftermath with none of the muzzle work. The
  // freeze keeps whatever the setup's shots emitted on screen for the capture.
  // Set once the setup's shots have fired, so their flash and tracer stay on screen for the capture.
  let freezeEffects = true;
  let painted = 0;
  function paint() {
    requestAnimationFrame(paint);
    player.applyCamera(camera);
    updateHud(FIXED_STEP);
    if (!freezeEffects) effects.update(FIXED_STEP);
    postfx.setCamera(camera);
    postfx.renderWorld(scene, camera, FIXED_STEP);
    renderer.autoClear = false;
    renderer.clearDepth();
    renderer.render(viewScene, viewCamera);
    renderer.autoClear = true;
    painted += 1;
    if (painted >= 2) {
      frozenForShot = true;
      window.__shotReady = true;
    }
  }
  requestAnimationFrame(paint);
}
