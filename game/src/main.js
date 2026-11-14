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
document.getElementById('game').appendChild(renderer.domElement);

const scene = new THREE.Scene();
scene.background = new THREE.Color('#232a33');
scene.fog = new THREE.Fog(new THREE.Color('#232a33'), 65, 130);
const camera = new THREE.PerspectiveCamera(76, window.innerWidth / window.innerHeight, 0.05, 200);
scene.add(camera);

// The gun in the player's hands lives in its own scene, drawn after the world with the depth buffer
// cleared, so it never clips into a wall the player is standing against.
const viewScene = new THREE.Scene();
const viewCamera = new THREE.PerspectiveCamera(58, window.innerWidth / window.innerHeight, 0.01, 6);
const viewGun = new THREE.Group();
{
  const bodyMat = new THREE.MeshStandardMaterial({ color: new THREE.Color('#22262b'), roughness: 0.45, metalness: 0.75 });
  const woodMat = new THREE.MeshStandardMaterial({ color: new THREE.Color('#4a3524'), roughness: 0.75, metalness: 0.1 });
  const receiver = new THREE.Mesh(new THREE.BoxGeometry(0.09, 0.1, 0.42), bodyMat);
  const barrel = new THREE.Mesh(new THREE.BoxGeometry(0.045, 0.045, 0.34), bodyMat);
  barrel.position.set(0, 0.014, -0.36);
  const stock = new THREE.Mesh(new THREE.BoxGeometry(0.07, 0.09, 0.24), woodMat);
  stock.position.set(0, -0.02, 0.28);
  const grip = new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.15, 0.06), woodMat);
  grip.position.set(0, -0.1, 0.12);
  grip.rotation.x = 0.3;
  const mag = new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.16, 0.07), bodyMat);
  mag.position.set(0, -0.11, -0.04);
  mag.rotation.x = -0.22;
  viewGun.add(receiver, barrel, stock, grip, mag);
  viewGun.position.set(0.19, -0.19, -0.42);
  viewScene.add(viewGun);
  const vLight = new THREE.DirectionalLight(new THREE.Color('#ffe6c4'), 2.6);
  vLight.position.set(0.6, 1, 0.8);
  viewScene.add(vLight);
  viewScene.add(new THREE.HemisphereLight(new THREE.Color('#a8c0d8'), new THREE.Color('#20242a'), 1.1));
}

// --- Systems ---
const world = createWorld(scene);
const hud = createHud();
hud.mount();

const player = createPlayer(world);
player.side = TEAM.ATTACK;
player.weapon = 'sidearm';
player.weaponState = createWeaponState('sidearm');
player.armour = 100;

const state = createState(world);
const bots = createBots(scene, world, rand);
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

  for (let pellet = 0; pellet < def.pellets; pellet += 1) {
    scatter(aimDir, spread, rand, shotDir);
    raycaster.set(eyePoint, shotDir);
    const hits = raycaster.intersectObjects(shootables, false);
    for (let i = 0; i < hits.length; i += 1) {
      const hit = hits[i];
      const target = hit.object.userData.bot;
      if (target) {
        hitSomething = true;
        const part = hit.object.userData.part ?? 'torso';
        if (hurtBot(target, damageFor(def, part), player.side)) {
          killedSomething = true;
          state.money = Math.min(MONEY_CAP, state.money + MONEY_KILL);
          hud.kill('you', target.name, part === 'head');
        }
        break;
      }
      if (hit.object.visible) break; // a wall stops the pellet
    }
  }

  if (hitSomething) hud.hitMarker(killedSomething);
  const kick = def.recoil * (crouched ? 0.7 : 1);
  player.recoil(kick, (rand() * 2 - 1) * def.recoil * 0.55);
  viewGun.position.z = -0.37;
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
  for (let i = 0; i < hits.length; i += 1) {
    const hit = hits[i];
    const victimBot = hit.object.userData.bot;
    const part = hit.object.userData.part ?? 'torso';
    const isPlayerBody = hit.object.userData.player === true;
    if (isPlayerBody || (victimBot && victimBot !== bot)) {
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

  renderer.render(scene, camera);
  if (!paused) {
    renderer.autoClear = false;
    renderer.clearDepth();
    viewGun.position.z += (-0.42 - viewGun.position.z) * Math.min(1, elapsed * 12);
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

  let painted = 0;
  function paint() {
    requestAnimationFrame(paint);
    player.applyCamera(camera);
    updateHud(FIXED_STEP);
    renderer.render(scene, camera);
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
