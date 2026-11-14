// Bots: the enemy team, and the teammates that fill the player's side.
//
// A bot is not a turret. It has a route it walks, a hold point it stops at, hearing that reacts to
// gunfire and footsteps, sight that needs a clear line and loses its target behind cover, and a
// reaction delay before it starts shooting. Its aim drifts, and it only fires in bursts when it has
// settled, so a player who stops and aims wins the duel a bot started.
//
// Every bot shares the player's collision and weapon code: nothing here is a shortcut around the
// rules the player plays by.
import * as THREE from 'three';

const EYE = 1.62;
const BODY_R = 0.42;
const MAX_HP = 100;

const tmpVec = new THREE.Vector3();
const tmpVec2 = new THREE.Vector3();

/**
 * Build one bot. `side` picks the spawn set, `route` is a key into world.routes, `hold` a key into
 * world.holdPoints, and `behaviour` decides what it does when it has nothing better to do:
 * 'push' walks its route to the site, 'hold' walks to a hold point and watches a direction.
 */
export function createBot(scene, world, opts, kit) {
  const { side, slot, route, hold, behaviour, weaponId, skill, rand } = opts;

  // The body is a jointed operator (operator.js): tapered limbs, plate and fabric, and a real
  // skeleton, so a moving figure reads as a person instead of a stack of coloured boxes.
  const operator = kit.createOperator(side, slot % 4);
  const group = operator.group;
  const joints = operator.joints;
  scene.add(group);

  const head = operator.parts.head;
  const torso = operator.parts.torso;

  // The weapon the bot carries: a real silhouette rather than a single bar, with a stock, receiver,
  // magazine, barrel and a handguard the hands can grip.
  const gunMat = new THREE.MeshStandardMaterial({ color: 0x1a1d21, roughness: 0.45, metalness: 0.7 });
  const gunAccent = new THREE.MeshStandardMaterial({ color: 0x2b2f35, roughness: 0.6, metalness: 0.4 });
  const gun = new THREE.Group();
  const receiver = new THREE.Mesh(new THREE.BoxGeometry(0.075, 0.10, 0.40), gunMat);
  receiver.position.z = -0.02;
  const barrel = new THREE.Mesh(new THREE.CylinderGeometry(0.018, 0.018, 0.30, 8), gunMat);
  barrel.rotation.x = Math.PI / 2;
  barrel.position.set(0, 0.015, -0.32);
  const handguard = new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.07, 0.22), gunAccent);
  handguard.position.set(0, 0.005, -0.24);
  const magazine = new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.16, 0.08), gunMat);
  magazine.position.set(0, -0.12, -0.02);
  magazine.rotation.x = 0.18;
  const stock = new THREE.Mesh(new THREE.BoxGeometry(0.055, 0.09, 0.22), gunAccent);
  stock.position.set(0, -0.01, 0.26);
  const sight = new THREE.Mesh(new THREE.BoxGeometry(0.03, 0.045, 0.10), gunAccent);
  sight.position.set(0, 0.075, -0.02);
  gun.add(receiver, barrel, handguard, magazine, stock, sight);
  gun.traverse((o) => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; } });

  // The gun rides the right hand, so it follows the arm's aim without its own transform.
  gun.position.set(0, -0.30, -0.16);
  joints.armR.elbow.add(gun);
  // Left hand supports the handguard.
  joints.armL.elbow.rotation.set(-0.3, 0, 0);

  const spawnSet = side === 0 ? world.attackSpawns : world.defendSpawns;
  const spawn = spawnSet[slot % spawnSet.length];

  const holdSet = world.holdPoints[hold] ?? world.holdPoints.mid;
  const holdPoint = holdSet[slot % holdSet.length].clone();

  const bot = {
    isBot: true,
    side,
    slot,
    group,
    head,
    torso,
    legs: [operator.parts.legs[0], operator.parts.legs[1]],
    joints,
    stride: rand ? rand() * 6.28 : 0,
    idle: rand ? rand() * 6.28 : 0,
    hp: MAX_HP,
    alive: true,
    eyeHeight: EYE,
    radius: BODY_R,
    position: new THREE.Vector3(spawn.x, 0, spawn.z),
    // Where it is going, and what it does when it gets there.
    routeKey: route,
    holdKey: hold,
    behaviour,
    waypoints: [...(world.routes[route] ?? world.routes.mid)],
    waypointIndex: 0,
    holdPoint,
    arrived: false,
    // Combat state.
    weapon: weaponId,
    skill, // 0..1: aim drift and reaction time both scale off this
    target: null,
    targetSeen: 0,
    reactionLeft: 0,
    fireCooldown: 0,
    burstLeft: 0,
    burstPause: 0,
    aimJitter: 0,
    lastKnown: new THREE.Vector3(),
    hasLastKnown: false,
    // Movement.
    speed: 0,
    yaw: 0,
    crouch: false,
    // Death and respawn.
    respawnAt: 0,
    deathTilt: 0,
  };

  bot.position.copy(spawn);
  syncBot(bot);
  return bot;
}

/** Put the meshes where the bot's state says they are, and animate the joints. */
export function syncBot(bot, dt = 0) {
  bot.group.position.set(bot.position.x, 0, bot.position.z);
  bot.group.rotation.y = bot.yaw;
  const down = bot.alive ? 0 : Math.min(1, bot.deathTilt);
  bot.group.rotation.x = down * 1.35;
  bot.group.position.y = -down * 0.35;
  bot.group.visible = bot.alive || bot.deathTilt < 1;

  const j = bot.joints;
  if (!j) return;

  if (!bot.alive) {
    // A dead operator folds: the whole rig slumps, joints go slack.
    const t = Math.min(1, bot.deathTilt);
    j.chest.rotation.x = -0.35 * t;
    j.head.rotation.x = 0.5 * t;
    j.legL.hip.rotation.x = 0.5 * t;
    j.legR.hip.rotation.x = 0.35 * t;
    j.legL.knee.rotation.x = -0.9 * t;
    j.legR.knee.rotation.x = -0.7 * t;
    j.armL.shoulder.rotation.x = -0.6 * t;
    j.armR.shoulder.rotation.x = -0.4 * t;
    return;
  }

  // Walk cycle: the phase advances with distance travelled, so the stride matches the ground speed
  // instead of sliding. A fast bot steps faster, a standing one holds a breathing idle.
  bot.stride = (bot.stride ?? 0) + (bot.speed ?? 0) * (dt || 0) * 3.1;
  bot.idle = (bot.idle ?? Math.random() * 6.28) + (dt || 0) * 1.6;
  const speed = bot.speed ?? 0;
  const moving = speed > 0.2;
  const swing = moving ? Math.min(0.85, 0.30 + speed * 0.16) : 0.0;
  const phase = bot.stride;
  const breathe = Math.sin(bot.idle) * 0.02;

  const legSwing = Math.sin(phase) * swing;
  const legSwing2 = Math.sin(phase + Math.PI) * swing;

  j.legL.hip.rotation.x = legSwing;
  j.legR.hip.rotation.x = legSwing2;
  // Knees only bend backwards, and most when the leg is behind.
  j.legL.knee.rotation.x = -Math.max(0, -Math.sin(phase)) * swing * 1.5;
  j.legR.knee.rotation.x = -Math.max(0, -Math.sin(phase + Math.PI)) * swing * 1.5;

  // Arms counter-swing, but the right arm is holding the weapon so it stays up.
  j.armL.shoulder.rotation.x = -0.55 - legSwing * 0.35;
  j.armL.shoulder.rotation.z = 0.18;
  j.armR.shoulder.rotation.x = -0.75;
  j.armR.shoulder.rotation.z = -0.10;

  // Torso leans into a run and turns slightly with the stride; the head holds its aim.
  j.chest.rotation.x = moving ? -0.12 - Math.min(0.2, speed * 0.02) : breathe;
  j.chest.rotation.y = Math.sin(phase) * swing * 0.12;
  j.chest.rotation.z = Math.sin(phase) * swing * 0.05;
  j.head.rotation.x = -(j.chest.rotation.x) * 0.6 + breathe * 0.5;

  // The hips bob and roll with each step: the single detail that sells a walk.
  const bob = Math.abs(Math.sin(phase)) * (moving ? 0.045 : 0);
  j.hips.position.y = 0.92 + bob + breathe * 0.3;
  j.hips.rotation.y = -Math.sin(phase) * swing * 0.10;
  j.hips.rotation.z = Math.sin(phase) * swing * 0.06;

  // A crouching bot drops the whole rig and folds the knees.
  if (bot.crouch) {
    j.hips.position.y -= 0.30;
    j.legL.knee.rotation.x -= 0.95;
    j.legR.knee.rotation.x -= 0.95;
    j.legL.hip.rotation.x += 0.55;
    j.legR.hip.rotation.x += 0.55;
    j.chest.rotation.x -= 0.12;
  }
}

/** Reset a bot for a new round: full health, back at spawn, route restarted. */
export function resetBot(bot, world) {
  const spawnSet = bot.side === 0 ? world.attackSpawns : world.defendSpawns;
  const spawn = spawnSet[bot.slot % spawnSet.length];
  bot.hp = MAX_HP;
  bot.alive = true;
  bot.deathTilt = 0;
  bot.position.copy(spawn);
  bot.waypoints = [...(world.routes[bot.routeKey] ?? world.routes.mid)];
  bot.waypointIndex = 0;
  bot.arrived = false;
  bot.target = null;
  bot.targetSeen = 0;
  bot.reactionLeft = 0;
  bot.fireCooldown = 0;
  bot.burstLeft = 0;
  bot.burstPause = 0;
  bot.hasLastKnown = false;
  bot.speed = 0;
  bot.yaw = bot.side === 0 ? Math.PI : 0;
  syncBot(bot);
}

/**
 * Line of sight between two points against the map's boxes. Walks the segment and tests each box,
 * cheap enough at a few dozen boxes and called only when a bot is deciding whether it can see.
 */
export function hasLineOfSight(colliders, from, to) {
  const dir = tmpVec.subVectors(to, from);
  const dist = dir.length();
  if (dist < 0.0001) return true;
  dir.divideScalar(dist);
  const ray = new THREE.Ray(from, dir);
  for (let i = 0; i < colliders.length; i += 1) {
    const box = colliders[i];
    // Skip the floor: it is below every sight line and costs a test per call.
    if (box.max.y <= 0.05) continue;
    const hit = ray.intersectBox(box, tmpVec2);
    if (hit && hit.distanceTo(from) < dist - 0.2) return false;
  }
  return true;
}

/**
 * One bot's step. `enemies` is the list this bot may shoot, `world` gives collision, and `dt` is the
 * fixed step. `hear` is a one-shot event the round manager broadcasts when a shot lands.
 */
export function stepBot(bot, dt, ctx) {
  const { world, enemies, rand, time, onShoot } = ctx;

  if (!bot.alive) {
    bot.deathTilt = Math.min(1, bot.deathTilt + dt * 3.4);
    syncBot(bot, dt);
    return;
  }

  // --- Perception: can it see any enemy this instant? Head height to chest height. ---
  let best = null;
  let bestDist = Infinity;
  const eye = tmpVec.set(bot.position.x, EYE, bot.position.z);
  for (let i = 0; i < enemies.length; i += 1) {
    const e = enemies[i];
    if (!e.alive) continue;
    const chest = tmpVec2.set(e.position.x, e.eyeHeight * 0.9, e.position.z);
    const d = eye.distanceTo(chest);
    if (d > 55) continue;
    if (!hasLineOfSight(world.colliders, eye, chest)) continue;
    // Field of view: a bot does not see behind itself, which is what makes a flank work.
    const toTargetX = e.position.x - bot.position.x;
    const toTargetZ = e.position.z - bot.position.z;
    const facing = Math.atan2(-Math.sin(bot.yaw), -Math.cos(bot.yaw));
    const angle = Math.abs(Math.atan2(Math.sin(Math.atan2(toTargetX, toTargetZ) - facing + Math.PI), Math.cos(Math.atan2(toTargetX, toTargetZ) - facing + Math.PI)));
    const inFov = angle < 1.35 || d < 6;
    if (!inFov) continue;
    if (d < bestDist) {
      bestDist = d;
      best = e;
    }
  }

  if (best) {
    if (bot.target !== best) {
      bot.target = best;
      bot.targetSeen = 0;
      // Reaction time: a sharper bot starts shooting sooner, but never instantly.
      bot.reactionLeft = (0.42 - bot.skill * 0.26) * (0.75 + rand() * 0.5);
    }
    bot.targetSeen += dt;
    bot.lastKnown.set(best.position.x, 0, best.position.z);
    bot.hasLastKnown = true;
  } else if (bot.target) {
    // Lost sight: keep the last known position for a while, then give up and go back to the route.
    bot.targetSeen += dt;
    if (bot.targetSeen > 3.2) {
      bot.target = null;
      bot.reactionLeft = 0;
    }
  }

  // --- Aim: face the target when there is one, else face the way it is walking. ---
  let desiredYaw = bot.yaw;
  if (bot.target) {
    const dx = bot.target.position.x - bot.position.x;
    const dz = bot.target.position.z - bot.position.z;
    desiredYaw = Math.atan2(-dx, -dz);
  } else if (bot.hasLastKnown) {
    const dx = bot.lastKnown.x - bot.position.x;
    const dz = bot.lastKnown.z - bot.position.z;
    if (Math.hypot(dx, dz) > 2.5) desiredYaw = Math.atan2(-dx, -dz);
  } else if (bot.waypointIndex < bot.waypoints.length) {
    const wp = bot.waypoints[bot.waypointIndex];
    const dx = wp.x - bot.position.x;
    const dz = wp.z - bot.position.z;
    if (Math.hypot(dx, dz) > 0.6) desiredYaw = Math.atan2(-dx, -dz);
  }
  // Turn rate: a bot does not snap onto a target behind it.
  let diff = desiredYaw - bot.yaw;
  while (diff > Math.PI) diff -= Math.PI * 2;
  while (diff < -Math.PI) diff += Math.PI * 2;
  const turn = Math.min(Math.abs(diff), (3.2 + bot.skill * 4.0) * dt);
  bot.yaw += Math.sign(diff) * turn;

  // --- Movement: walk the route, or hold. Never walk straight while shooting. ---
  let moveX = 0;
  let moveZ = 0;
  const engaged = Boolean(bot.target);
  if (!engaged) {
    if (!bot.arrived) {
      const wp = bot.waypoints[bot.waypointIndex];
      if (wp) {
        const dx = wp.x - bot.position.x;
        const dz = wp.z - bot.position.z;
        const d = Math.hypot(dx, dz);
        if (d < 0.9) {
          bot.waypointIndex += 1;
          if (bot.waypointIndex >= bot.waypoints.length) {
            bot.arrived = true;
          }
        } else {
          moveX = dx / d;
          moveZ = dz / d;
        }
      } else {
        bot.arrived = true;
      }
    }
    // Once the route is done, drift to the hold point and stay there.
    if (bot.arrived && bot.holdPoint) {
      const dx = bot.holdPoint.x - bot.position.x;
      const dz = bot.holdPoint.z - bot.position.z;
      const d = Math.hypot(dx, dz);
      if (d > 1.1) {
        moveX = dx / d;
        moveZ = dz / d;
      } else {
        // At the hold point: sweep the arc it guards, so it is not staring at one wall.
        const sweep = Math.sin(time * 0.6 + bot.slot) * 0.55;
        bot.yaw += sweep * dt;
      }
    }
  } else {
    // In contact: strafe, do not charge. A bot that runs at you is a free kill.
    const sidestep = Math.sin(time * 2.1 + bot.slot * 1.7) > 0;
    const dx = bot.target.position.x - bot.position.x;
    const dz = bot.target.position.z - bot.position.z;
    const d = Math.hypot(dx, dz) || 1;
    const perpX = -dz / d;
    const perpZ = dx / d;
    moveX = perpX * (sidestep ? 1 : -1) * 0.7;
    moveZ = perpZ * (sidestep ? 1 : -1) * 0.7;
    // If the target is far away, close some distance while strafing.
    if (d > 18) {
      moveX += dx / d * 0.5;
      moveZ += dz / d * 0.5;
    }
  }

  const speedWant = engaged ? 3.1 : 5.0;
  const len = Math.hypot(moveX, moveZ);
  if (len > 0.001) {
    const nx = moveX / len;
    const nz = moveZ / len;
    const nextX = bot.position.x + nx * speedWant * dt;
    const nextZ = bot.position.z + nz * speedWant * dt;
    if (canStand(world.colliders, nextX, bot.position.z, BODY_R)) bot.position.x = nextX;
    if (canStand(world.colliders, bot.position.x, nextZ, BODY_R)) bot.position.z = nextZ;
    bot.speed = speedWant;
  } else {
    bot.speed = 0;
  }

  // Keep them on the map.
  bot.position.x = Math.max(-world.halfW + 1, Math.min(world.halfW - 1, bot.position.x));
  bot.position.z = Math.max(-world.halfL + 1, Math.min(world.halfL - 1, bot.position.z));

  // --- Fire: only with a target, only after the reaction delay, only in bursts. ---
  if (bot.fireCooldown > 0) bot.fireCooldown -= dt;
  if (bot.burstPause > 0) bot.burstPause -= dt;

  if (bot.target && bot.target.alive) {
    if (bot.reactionLeft > 0) {
      bot.reactionLeft -= dt;
    } else if (bot.burstPause <= 0 && bot.fireCooldown <= 0) {
      const def = ctx.weaponDef;
      // Aim error shrinks the longer the target has been visible, and never reaches zero.
      const settle = Math.min(1, bot.targetSeen / 1.6);
      const jitter = (1 - bot.skill * 0.55) * (1 - settle * 0.45) * 0.035;
      bot.aimJitter = jitter;
      onShoot(bot, jitter);
      bot.fireCooldown = 60 / def.rpm;
      if (bot.burstLeft <= 0) bot.burstLeft = 3 + Math.floor(rand() * 4);
      bot.burstLeft -= 1;
      if (bot.burstLeft <= 0) bot.burstPause = 0.22 + rand() * 0.3;
    }
  }

  syncBot(bot, dt);
}

/** Whether a body of radius r can stand at x,z without being inside a collider. */
export function canStand(colliders, x, z, r) {
  for (let i = 0; i < colliders.length; i += 1) {
    const b = colliders[i];
    if (b.max.y <= 0.35) continue; // step over low things rather than collide with them
    if (x > b.min.x - r && x < b.max.x + r && z > b.min.z - r && z < b.max.z + r) {
      // Only blocks if it is tall enough to be a wall at body height.
      if (b.max.y > 0.9) return false;
    }
  }
  return true;
}

export { EYE as BOT_EYE, MAX_HP as BOT_MAX_HP };
