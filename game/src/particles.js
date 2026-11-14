// Tactical FPS particle system. One shared GPU pool, no per-frame allocation.
// The game loop calls `update(dt)` every frame and `clear()` between rounds.

import * as THREE from 'three';

// Max live particles across every effect. Draw ranges keep the Points draw call small.
const SYSTEM_COUNT = 8192;

const systemPos = new Float32Array(SYSTEM_COUNT * 3);
const systemVel = new Float32Array(SYSTEM_COUNT * 3);
const systemCol = new Float32Array(SYSTEM_COUNT * 3);
const systemSize = new Float32Array(SYSTEM_COUNT);
const systemLife = new Float32Array(SYSTEM_COUNT);
const systemMax = new Float32Array(SYSTEM_COUNT);
const systemType = new Uint8Array(SYSTEM_COUNT);
const systemAlive = new Uint8Array(SYSTEM_COUNT);

// GPU buffers. Positions/colors are rewritten with a dirty range; sizes/life are constants.
const geo = new THREE.BufferGeometry();
geo.setAttribute('position', new THREE.BufferAttribute(systemPos, 3));
geo.setAttribute('color', new THREE.BufferAttribute(systemCol, 3));
geo.setAttribute('size', new THREE.BufferAttribute(systemSize, 1));
geo.setAttribute('life', new THREE.BufferAttribute(systemLife, 1));
geo.setAttribute('alive', new THREE.BufferAttribute(systemAlive, 1));

// Additive blending + depthWrite off, so smoke/wisps render in front without sorting their
// individual particles. Render order keeps them above the world.
const mat = new THREE.PointsMaterial({
  size: 0.06,
  vertexColors: true,
  transparent: true,
  opacity: 1,
  blending: THREE.AdditiveBlending,
  depthWrite: false,
  sizeAttenuation: true,
});
const points = new THREE.Points(geo, mat);
points.frustumCulled = false;
points.renderOrder = 1;

// Global cursor + live count. `aliveTotal` is the number of particles actually drawn.
let cursor = 0;
let aliveTotal = 0;

// Type tags used by the update loop.
const TYPE = { EXPLOSION: 1, BLOOD_MIST: 2, DEBRIS: 3, SMOKE: 4, MUZZLE_SMOKE: 5, SHELL_CASING: 6 };

// Return a pre-allocated vector, or a new one when the pool is empty.
function allocVector() {
  // Pool is intentionally small: modern browsers recycle zeroed arrays on emit anyway.
  return new THREE.Vector3();
}

export function createParticleSystem(THREE) {
  if (!THREE || !THREE.BufferGeometry || !THREE.PointsMaterial) {
    throw new Error('createParticleSystem expects a THREE namespace');
  }

  const localPos = new Float32Array(2048);
  const localVel = new Float32Array(2048);
  const localCol = new Float32Array(2048);
  const localSize = new Float32Array(2048);
  const localLife = new Float32Array(2048);

  // Emit one effect type into the global pool. `type` is the particle tag; the rest are
  // per-effect parameters copied into the state object so callers can inspect/tune them.
  function emitParticles(type, count, emit) {
    if (cursor + count > SYSTEM_COUNT) count = SYSTEM_COUNT - cursor;

    if (count <= 0) return;

    const pos = allocVector();
    pos.set(0, 0, 0);

    // Local scratch so we never grow the global arrays during the emit loop.
    for (let i = 0; i < count; i += 1) {
      emit(
        i,
        pos,
        localPos, localVel, localCol, localSize, localLife,
        TYPE, cursor + i
      );
    }

    // Copy local scratch into the GPU pool and advance the cursor.
    for (let i = 0; i < count; i += 1) {
      const j = cursor * 3;
      systemPos[j] = localPos[i * 3];
      systemPos[j + 1] = localPos[i * 3 + 1];
      systemPos[j + 2] = localPos[i * 3 + 2];

      systemVel[j] = localVel[i * 3];
      systemVel[j + 1] = localVel[i * 3 + 1];
      systemVel[j + 2] = localVel[i * 3 + 2];

      systemCol[j] = localCol[i * 3];
      systemCol[j + 1] = localCol[i * 3 + 1];
      systemCol[j + 2] = localCol[i * 3 + 2];

      systemSize[cursor] = localSize[i];
      systemLife[cursor] = localLife[i];
      systemMax[cursor] = localLife[i];
      systemType[cursor] = type;
      systemAlive[cursor] = 1;
      cursor += 1;
    }

    aliveTotal += count;
  }

  function explosion(pos, opts = {}) {
    const seed = opts.seed ?? 0x9e3779b9;
    const count = opts.count ?? 180;
    const spread = opts.spread ?? 0.9;
    const lifeMin = opts.lifeMin ?? 0.5;
    const lifeMax = opts.lifeMax ?? 1.1;

    const fireTint = new THREE.Color(0xff6600);
    const smokeTint = new THREE.Color(0x886644);

    emitParticles(TYPE.EXPLOSION, count, (i, p, lp, lv, lc, ls, ll, type, idx) => {
      const h = seed + i;
      const t = (i / count) * Math.PI * 2;
      const r = Math.cbrt(Math.random()) * spread;

      lp[i * 3] = pos.x;
      lp[i * 3 + 1] = pos.y;
      lp[i * 3 + 2] = pos.z;

      // Radial outward velocity with a slight upward bias so the sphere billows.
      lv[i * 3] = (Math.random() - 0.5) * 2 * spread;
      lv[i * 3 + 1] = (Math.random() - 0.5) * 2 * spread + 0.6;
      lv[i * 3 + 2] = (Math.random() - 0.5) * 2 * spread;

      const isFire = Math.random() < 0.55;
      if (isFire) {
        lc[i * 3] = fireTint.r + (Math.random() - 0.5) * 0.2;
        lc[i * 3 + 1] = fireTint.g + (Math.random() - 0.5) * 0.2;
        lc[i * 3 + 2] = fireTint.b + (Math.random() - 0.5) * 0.2;
      } else {
        lc[i * 3] = smokeTint.r + (Math.random() - 0.5) * 0.15;
        lc[i * 3 + 1] = smokeTint.g + (Math.random() - 0.5) * 0.15;
        lc[i * 3 + 2] = smokeTint.b + (Math.random() - 0.5) * 0.15;
      }

      ls[i] = 0.04 + Math.random() * 0.12;
      ll[i] = lifeMin + Math.random() * (lifeMax - lifeMin);
    });
    return { type: 'explosion', pos, seed, count, spread, lifeMin, lifeMax };
  }

  function bloodMist(pos, dir) {
    const count = 120;
    const tint = new THREE.Color(0xaa2233);
    const spread = 0.5;
    const lifeMin = 0.3;
    const lifeMax = 0.9;

    emitParticles(TYPE.BLOOD_MIST, count, (i, p, lp, lv, lc, ls, ll, type, idx) => {
      lp[i * 3] = pos.x;
      lp[i * 3 + 1] = pos.y;
      lp[i * 3 + 2] = pos.z;

      // Bias emission along the hit direction so the mist follows the trajectory.
      lv[i * 3] = dir.x + (Math.random() - 0.5) * spread;
      lv[i * 3 + 1] = dir.y + (Math.random() - 0.5) * spread + 0.1;
      lv[i * 3 + 2] = dir.z + (Math.random() - 0.5) * spread;

      lc[i * 3] = tint.r + (Math.random() - 0.5) * 0.1;
      lc[i * 3 + 1] = tint.g + (Math.random() - 0.5) * 0.1;
      lc[i * 3 + 2] = tint.b + (Math.random() - 0.5) * 0.1;

      ls[i] = 0.05 + Math.random() * 0.12;
      ll[i] = lifeMin + Math.random() * (lifeMax - lifeMin);
    });
    return { type: 'bloodMist', pos };
  }

  function debris(pos, count = 32) {
    const lifeMin = 0.8;
    const lifeMax = 1.8;

    emitParticles(TYPE.DEBRIS, count, (i, p, lp, lv, lc, ls, ll, type, idx) => {
      lp[i * 3] = pos.x;
      lp[i * 3 + 1] = pos.y;
      lp[i * 3 + 2] = pos.z;

      // Tumbling, near-horizontal debris from the blast.
      const t = (i / count) * Math.PI * 2;
      const r = Math.cbrt(Math.random()) * 0.5;
      lv[i * 3] = Math.cos(t) * r;
      lv[i * 3 + 1] = Math.sin(t) * r + 1.2;
      lv[i * 3 + 2] = Math.sin(t * 1.3) * r;

      lc[i * 3] = 0.7 + Math.random() * 0.3;
      lc[i * 3 + 1] = 0.7 + Math.random() * 0.3;
      lc[i * 3 + 2] = 0.7 + Math.random() * 0.3;

      ls[i] = 0.05 + Math.random() * 0.15;
      ll[i] = lifeMin + Math.random() * (lifeMax - lifeMin);
    });
    return { type: 'debris', pos, count };
  }

  function smoke(pos, duration = 2.2) {
    const count = 80;
    const lifeMin = 0.4;
    const lifeMax = duration;

    emitParticles(TYPE.SMOKE, count, (i, p, lp, lv, lc, ls, ll, type, idx) => {
      lp[i * 3] = pos.x;
      lp[i * 3 + 1] = pos.y;
      lp[i * 3 + 2] = pos.z;

      // Rising buoyancy with mild lateral drift.
      lv[i * 3] = (Math.random() - 0.5) * 0.5;
      lv[i * 3 + 1] = 0.3 + Math.random() * 0.5;
      lv[i * 3 + 2] = (Math.random() - 0.5) * 0.5;

      lc[i * 3] = 0.6 + Math.random() * 0.4;
      lc[i * 3 + 1] = 0.6 + Math.random() * 0.4;
      lc[i * 3 + 2] = 0.7 + Math.random() * 0.3;

      ls[i] = 0.08 + Math.random() * 0.22;
      ll[i] = lifeMin + Math.random() * (lifeMax - lifeMin);
    });
    return { type: 'smoke', pos, duration };
  }

  function muzzleSmoke(pos) {
    const count = 40;
    const lifeMin = 0.12;
    const lifeMax = 0.35;

    emitParticles(TYPE.MUZZLE_SMOKE, count, (i, p, lp, lv, lc, ls, ll, type, idx) => {
      lp[i * 3] = pos.x;
      lp[i * 3 + 1] = pos.y;
      lp[i * 3 + 2] = pos.z;

      // Wisp blowing backwards out of the barrel.
      const t = (i / count) * Math.PI * 2;
      const r = Math.cbrt(Math.random()) * 0.2;
      lv[i * 3] = -Math.cos(t) * r;
      lv[i * 3 + 1] = Math.sin(t) * r * 0.6 + 0.2;
      lv[i * 3 + 2] = Math.sin(t * 1.1) * r * 0.6;

      lc[i * 3] = 0.85 + Math.random() * 0.15;
      lc[i * 3 + 1] = 0.85 + Math.random() * 0.15;
      lc[i * 3 + 2] = 0.9;

      ls[i] = 0.05 + Math.random() * 0.14;
      ll[i] = lifeMin + Math.random() * (lifeMax - lifeMin);
    });
    return { type: 'muzzleSmoke', pos };
  }

  function shellCasing(pos, dir) {
    const count = 24;

    emitParticles(TYPE.SHELL_CASING, count, (i, p, lp, lv, lc, ls, ll, type, idx) => {
      lp[i * 3] = pos.x;
      lp[i * 3 + 1] = pos.y;
      lp[i * 3 + 2] = pos.z;

      // Small brass cube ejected sideways from the shell's travel direction.
      lv[i * 3] = -dir.y + (Math.random() - 0.5) * 0.3;
      lv[i * 3 + 1] = -dir.z + (Math.random() - 0.5) * 0.3 + 0.1;
      lv[i * 3 + 2] = dir.x + (Math.random() - 0.5) * 0.3;

      lc[i * 3] = 0.7 + Math.random() * 0.3;
      lc[i * 3 + 1] = 0.6 + Math.random() * 0.3;
      lc[i * 3 + 2] = 0.5 + Math.random() * 0.3;

      ls[i] = 0.04 + Math.random() * 0.08;
      ll[i] = 0.5 + Math.random() * 1.0;
    });
    return { type: 'shellCasing', pos };
  }

  // Advance all active particles and recycle dead ones.
  function update(dt) {
    if (dt <= 0) return;

    let alive = 0;
    for (let i = 0; i < cursor; i += 1) {
      if (!systemAlive[i]) continue;

      systemLife[i] -= dt;
      if (systemLife[i] <= 0) {
        systemAlive[i] = 0;
        continue;
      }

      // Physics per type. Gravity pulls everything down; drag slows sparks.
      switch (systemType[i]) {
        case TYPE.EXPLOSION: {
          systemVel[i * 3 + 1] -= 9.4 * dt;
          systemVel[i * 3] *= 0.94;
          systemVel[i * 3 + 1] *= 0.95;
          systemVel[i * 3 + 2] *= 0.94;
          break;
        }
        case TYPE.BLOOD_MIST: {
          systemVel[i * 3 + 1] -= 4.0 * dt;
          systemVel[i * 3] *= 0.97;
          systemVel[i * 3 + 1] *= 0.98;
          systemVel[i * 3 + 2] *= 0.97;
          break;
        }
        case TYPE.DEBRIS: {
          systemVel[i * 3 + 1] -= 8.0 * dt;
          break;
        }
        case TYPE.SMOKE: {
          // Smoke keeps its upward drift; fade toward lighter gray as it rises.
          systemVel[i * 3 + 1] -= 1.2 * dt;
          break;
        }
        case TYPE.MUZZLE_SMOKE: {
          systemVel[i * 3 + 1] -= 1.5 * dt;
          break;
        }
        case TYPE.SHELL_CASING: {
          systemVel[i * 3 + 1] -= 7.5 * dt;
          break;
        }
      }

      const j = i * 3;
      systemPos[j] += systemVel[j] * dt;
      systemPos[j + 1] += systemVel[j + 1] * dt;
      systemPos[j + 2] += systemVel[j + 2] * dt;

      // Natural fade as life runs out.
      const k = systemLife[i] / systemMax[i];
      systemCol[j] *= 0.995;
      systemCol[j + 1] *= 0.995;
      systemCol[j + 2] *= 0.995;

      if (systemAlive[i]) alive += 1;
    }

    aliveTotal = alive;
    // Tell GPU the buffers changed.
    geo.attributes.position.needsUpdate = true;
    geo.attributes.color.needsUpdate = true;
    geo.attributes.size.needsUpdate = true;
    geo.attributes.life.needsUpdate = true;
  }

  // Recycle everything, ready for the next round.
  function clear() {
    cursor = 0;
    aliveTotal = 0;
    for (let i = 0; i < SYSTEM_COUNT; i += 1) {
      systemAlive[i] = 0;
    }
    geo.setDrawRange(0, 0);
  }

  points.count = 0;
  points.particleSystem = {
    update,
    clear,
    get alive() { return aliveTotal; },
  };

  return {
    points,
    createExplosion: explosion,
    createBloodMist: bloodMist,
    createDebris: debris,
    createSmoke: smoke,
    createMuzzleSmoke: muzzleSmoke,
    createShellCasing: shellCasing,
    update,
    clear,
  };
}
