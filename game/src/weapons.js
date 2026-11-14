// Weapons: the catalogue, the per-weapon state, and the ballistics the shot resolves against.
//
// What makes gunfire tactical here is spread. A rifle fired while standing still lands inside a
// small cone; the same rifle fired while running lands wherever the cone happens to point. Crouching
// tightens the cone further, and the first shot of a burst is the most accurate one, so stopping to
// aim is what wins a duel, exactly as the bounty asks.

import * as THREE from 'three';

export const WEAPONS = {
  sidearm: {
    id: 'sidearm', name: 'P9 Sidearm', cost: 0, slot: 'primary',
    damage: 26, headMult: 3.4, magSize: 12, reserveMax: 48, reloadSeconds: 1.7,
    rpm: 400, spreadStill: 0.004, spreadMove: 0.055, spreadCrouch: 0.002,
    recoil: 0.004, range: 60, auto: false, pellets: 1, penetration: 0,
  },
  rifle: {
    id: 'rifle', name: 'AK-pattern Rifle', cost: 2700, slot: 'primary',
    damage: 34, headMult: 3.8, magSize: 30, reserveMax: 90, reloadSeconds: 2.4,
    rpm: 600, spreadStill: 0.0035, spreadMove: 0.075, spreadCrouch: 0.0018,
    recoil: 0.0075, range: 90, auto: true, pellets: 1, penetration: 0.35,
  },
  smg: {
    id: 'smg', name: 'K7 SMG', cost: 1250, slot: 'primary',
    damage: 24, headMult: 2.8, magSize: 30, reserveMax: 120, reloadSeconds: 2.0,
    rpm: 800, spreadStill: 0.006, spreadMove: 0.035, spreadCrouch: 0.004,
    recoil: 0.0045, range: 45, auto: true, pellets: 1, penetration: 0.15,
  },
  shotgun: {
    id: 'shotgun', name: 'B2 Shotgun', cost: 1100, slot: 'primary',
    damage: 13, headMult: 2.2, magSize: 7, reserveMax: 28, reloadSeconds: 2.9,
    rpm: 80, spreadStill: 0.028, spreadMove: 0.05, spreadCrouch: 0.024,
    recoil: 0.02, range: 22, auto: false, pellets: 9, penetration: 0,
  },
};

export const GRENADES = {
  frag: { id: 'frag', name: 'Frag Grenade', cost: 300, damage: 95, radius: 6.5, fuse: 2.1 },
  smoke: { id: 'smoke', name: 'Smoke Grenade', cost: 300, radius: 4.5, fuse: 6.5, duration: 14 },
};

/** One player's weapon state: what is loaded, what is left, and what it is doing right now. */
export function createWeaponState(weaponId) {
  const def = WEAPONS[weaponId] ?? WEAPONS.sidearm;
  return {
    def,
    mag: def.magSize,
    reserve: def.reserveMax,
    reloading: false,
    reloadLeft: 0,
    cooldown: 0,
    burstIndex: 0, // how many rounds into the current trigger hold, for recoil recovery
  };
}

export function equip(state, weaponId) {
  if (!WEAPONS[weaponId]) return;
  state.def = WEAPONS[weaponId];
  state.mag = state.def.magSize;
  state.reserve = state.def.reserveMax;
  state.reloading = false;
  state.reloadLeft = 0;
  state.cooldown = 0;
  state.burstIndex = 0;
}

export function refill(state) {
  state.mag = state.def.magSize;
  state.reserve = state.def.reserveMax;
  state.reloading = false;
  state.reloadLeft = 0;
  state.cooldown = 0;
  state.burstIndex = 0;
}

export function startReload(state) {
  if (state.reloading) return;
  const need = state.def.magSize - state.mag;
  if (need <= 0 || state.reserve <= 0) return;
  state.reloading = true;
  state.reloadLeft = state.def.reloadSeconds;
}

export function stepWeapon(state, dt) {
  if (state.cooldown > 0) state.cooldown -= dt;
  if (state.reloading) {
    state.reloadLeft -= dt;
    if (state.reloadLeft <= 0) {
      const need = state.def.magSize - state.mag;
      const take = Math.min(need, state.reserve);
      state.mag += take;
      state.reserve -= take;
      state.reloading = false;
      state.reloadLeft = 0;
    }
  }
  // Firing raises the cone, holding still lowers it again: burst discipline in one line.
  if (state.cooldown <= 0 && state.burstIndex > 0) {
    state.burstIndex = Math.max(0, state.burstIndex - dt * 6);
  }
}

export function canFire(state) {
  return !state.reloading && state.cooldown <= 0 && state.mag > 0;
}

export function takeRound(state) {
  if (!canFire(state)) return false;
  state.mag -= 1;
  state.cooldown = 60 / state.def.rpm;
  state.burstIndex += 1;
  if (state.mag === 0 && state.reserve > 0) startReload(state);
  return true;
}

/**
 * The cone half-angle for a shot, given how the shooter is moving and whether they are crouched.
 * The burst penalty is what makes the second and third round of a spray worse than the first.
 */
export function spreadOf(state, speed, crouched) {
  const def = state.def;
  const move = crouched ? def.spreadCrouch : def.spreadMove;
  const still = crouched ? def.spreadCrouch * 0.8 : def.spreadStill;
  const t = Math.min(1, speed / 5.2);
  const base = still + (move - still) * t;
  return base * (1 + Math.min(state.burstIndex, 10) * 0.22);
}

/** A direction inside a cone of `halfAngle` around `forward`, using a supplied random source. */
const tmpA = new THREE.Vector3();
const tmpB = new THREE.Vector3();
export function scatter(forward, halfAngle, rand, out) {
  if (halfAngle <= 0) return out.copy(forward);
  // Build an orthonormal basis around the forward vector once per call: no allocation.
  tmpA.set(0, 1, 0);
  if (Math.abs(forward.y) > 0.9) tmpA.set(1, 0, 0);
  tmpB.crossVectors(forward, tmpA).normalize();
  tmpA.crossVectors(tmpB, forward).normalize();
  const r = halfAngle * Math.sqrt(rand());
  const theta = rand() * Math.PI * 2;
  return out.copy(forward)
    .addScaledVector(tmpA, Math.cos(theta) * r)
    .addScaledVector(tmpB, Math.sin(theta) * r)
    .normalize();
}

/** Damage for a hit on a body part. */
export function damageFor(def, part) {
  if (part === 'head') return def.damage * def.headMult;
  if (part === 'legs') return def.damage * 0.75;
  return def.damage;
}
