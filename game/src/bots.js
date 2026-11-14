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
export function createBot(scene, world, opts) {
  const { side, slot, route, hold, behaviour, weaponId, skill, rand } = opts;

  const group = new THREE.Group();
  scene.add(group);

  // A simple humanoid from boxes: torso, head, two legs, an arm holding the gun. Built once here,
  // never rebuilt, so no geometry is created in a frame.
  const skin = new THREE.MeshStandardMaterial({
    color: new THREE.Color(side === 0 ? '#c96f4a' : '#4a7fc9'),
    roughness: 0.75, metalness: 0.05,
  });
  const gear = new THREE.MeshStandardMaterial({
    color: new THREE.Color(side === 0 ? '#6d3b28' : '#27406b'),
    roughness: 0.9, metalness: 0.05,
  });
  const gunMat = new THREE.MeshStandardMaterial({ color: new THREE.Color('#1d2126'), roughness: 0.5, metalness: 0.6 });

  const torsoGeo = new THREE.BoxGeometry(0.62, 0.78, 0.36);
  const headGeo = new THREE.BoxGeometry(0.3, 0.3, 0.3);
  const limbGeo = new THREE.BoxGeometry(0.2, 0.62, 0.22);
  const gunGeo = new THREE.BoxGeometry(0.09, 0.12, 0.72);

  const torso = new THREE.Mesh(torsoGeo, skin);
  torso.position.y = 1.16;
  const head = new THREE.Mesh(headGeo, skin);
  head.position.y = 1.68;
  head.userData.part = 'head';
  const legL = new THREE.Mesh(limbGeo, gear);
  legL.position.set(-0.18, 0.31, 0);
  const legR = new THREE.Mesh(limbGeo, gear);
  legR.position.set(0.18, 0.31, 0);
  const arm = new THREE.Mesh(limbGeo, skin);
  arm.position.set(0.34, 1.2, -0.1);
  arm.rotation.x = -1.35;
  const gun = new THREE.Mesh(gunGeo, gunMat);
  gun.position.set(0.34, 1.14, -0.5);

  torso.userData.part = 'torso';
  legL.userData.part = 'legs';
  legR.userData.part = 'legs';

  group.add(torso, head, legL, legR, arm, gun);
  for (const m of [torso, head, legL, legR, arm, gun]) {
    m.castShadow = true;
    m.receiveShadow = true;
  }

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
    legs: [legL, legR],
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

/** Put the meshes where the bot's state says they are. */
export function syncBot(bot) {
  bot.group.position.set(bot.position.x, 0, bot.position.z);
  bot.group.rotation.y = bot.yaw;
  const down = bot.alive ? 0 : Math.min(1, bot.deathTilt);
  bot.group.rotation.x = down * 1.35;
  bot.group.position.y = -down * 0.35;
  bot.group.visible = bot.alive || bot.deathTilt < 1;
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
    syncBot(bot);
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

  syncBot(bot);
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
