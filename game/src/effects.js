// Impact and muzzle effects: sparks, muzzle flash, bullet holes, tracers.
//
// All of it lives in one pooled system. Nothing is allocated while a round is live: the sparks are a
// single Points cloud whose live count is a draw range, the flashes are two lights that get moved and
// timed out, decals are a fixed ring of quads written round-robin. A firefight is then a handful of
// buffer writes, which matters because this runs on the same thread as the game loop.
//
// The muzzle flash is a light plus a camera-facing quad rather than an animated model: at the
// distances a weapon is seen in a first-person frame, a short bright pop with a falloff reads
// better than geometry and costs one draw call.

import * as THREE from 'three';

const SPARK_COUNT = 240;
const DECAL_COUNT = 48;

export function createEffects(scene, viewScene = null) {
  // The muzzle work belongs to the viewmodel scene when one is given: that scene is drawn after the
  // post chain with the depth buffer cleared, so the flash is guaranteed to sit on top of the frame
  // instead of being swallowed by the world's own pass (or occluded by a wall the muzzle pokes into).
  const flashScene = viewScene ?? scene;
  // --- sparks: one Points cloud, drawn up to `live` -------------------------
  const sparkPos = new Float32Array(SPARK_COUNT * 3);
  const sparkCol = new Float32Array(SPARK_COUNT * 3);
  const sparkVel = new Float32Array(SPARK_COUNT * 3);
  const sparkLife = new Float32Array(SPARK_COUNT);
  const sparkMax = new Float32Array(SPARK_COUNT);

  const sparkGeo = new THREE.BufferGeometry();
  sparkGeo.setAttribute('position', new THREE.BufferAttribute(sparkPos, 3));
  sparkGeo.setAttribute('color', new THREE.BufferAttribute(sparkCol, 3));
  sparkGeo.setDrawRange(0, 0);

  const sparkMat = new THREE.PointsMaterial({
    size: 0.055, vertexColors: true, transparent: true,
    blending: THREE.AdditiveBlending, depthWrite: false, sizeAttenuation: true,
  });
  const sparks = new THREE.Points(sparkGeo, sparkMat);
  sparks.frustumCulled = false;
  scene.add(sparks);

  let sparkCursor = 0;
  let sparkLive = 0;

  function emitSparks(point, normal, count, tint, speed = 3.4) {
    for (let i = 0; i < count; i += 1) {
      const idx = sparkCursor;
      sparkCursor = (sparkCursor + 1) % SPARK_COUNT;
      if (sparkLive < SPARK_COUNT) sparkLive += 1;

      const j = idx * 3;
      sparkPos[j] = point.x;
      sparkPos[j + 1] = point.y;
      sparkPos[j + 2] = point.z;

      // A cone around the surface normal, with a little upward bias so sparks arc.
      const spread = 0.85;
      sparkVel[j] = (normal.x + (Math.random() - 0.5) * spread) * speed;
      sparkVel[j + 1] = (normal.y + (Math.random() - 0.5) * spread) * speed + 1.1;
      sparkVel[j + 2] = (normal.z + (Math.random() - 0.5) * spread) * speed;

      sparkCol[j] = tint[0];
      sparkCol[j + 1] = tint[1];
      sparkCol[j + 2] = tint[2];

      sparkLife[idx] = 0.22 + Math.random() * 0.3;
      sparkMax[idx] = sparkLife[idx];
    }
    sparkGeo.setDrawRange(0, sparkLive);
  }

  // --- muzzle flash: pool of two lights, reused round-robin -----------------
  const flashLights = [];
  for (let i = 0; i < 4; i += 1) {
    const l = new THREE.PointLight(0xffd9a0, 0, 9, 2);
    l.visible = false;
    scene.add(l);
    flashLights.push({ light: l, ttl: 0, life: 0 });
  }
  let flashCursor = 0;

  // The flash itself is two additive spheres: a small hot core and a larger soft halo.
  //
  // A camera-facing quad is the usual choice, but a quad seen edge-on vanishes, and the flash has to
  // read from whatever angle the shot frame happens to catch. A sphere looks identical from every
  // direction, so there is nothing to orient and nothing that can disappear.
  const flashGroup = new THREE.Group();
  // A local light so the flash actually spills onto the weapon and the player's hands.
  const flashLight = new THREE.PointLight(0xffd9a0, 0, 6, 2);
  flashGroup.add(flashLight);
  const coreMat = new THREE.MeshBasicMaterial({
    color: 0xfff0d0, transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false,
  });
  const haloMat = new THREE.MeshBasicMaterial({
    color: 0xffb45c, transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false,
  });
  // Sized against the viewmodel camera's frustum: at the muzzle's depth the frame's half-height is
  // ~0.34, so a 0.045 halo reads as a ~7%-of-screen pop. The earlier 0.20 overflowed the frame and
  // whited out the centre of the picture.
  const flashCore = new THREE.Mesh(new THREE.SphereGeometry(0.020, 12, 10), coreMat);
  const flashHalo = new THREE.Mesh(new THREE.SphereGeometry(0.045, 14, 12), haloMat);
  flashGroup.add(flashCore, flashHalo);
  flashGroup.visible = false;
  flashScene.add(flashGroup);
  let quadTtl = 0;
  let quadLife = 0;

  function muzzleFlash(point, dir, strength = 1, viewPoint = null) {
    const slot = flashLights[flashCursor];
    flashCursor = (flashCursor + 1) % flashLights.length;
    slot.light.position.copy(point);
    slot.light.intensity = 22 * strength;
    slot.light.visible = true;
    slot.life = 0.05;
    slot.ttl = slot.life;

    // The flash lives in the viewmodel scene when there is one, whose camera sits at the origin, so
    // it takes its own coordinate rather than the world muzzle.
    flashGroup.position.copy(viewPoint ?? point).addScaledVector(dir, 0.16);
    flashGroup.scale.setScalar(1.0 + 0.35 * (strength - 1));
    flashGroup.visible = true;
    coreMat.opacity = 1.0;
    haloMat.opacity = 0.75;
    flashLight.intensity = 14 * strength;
    quadLife = 0.075;
    quadTtl = quadLife;

    // A few sparks out of the barrel, tinted hot.
    emitSparks(point, dir, 6, [1.0, 0.72, 0.32], 5.5);
  }

  // Build a quaternion that faces a direction; the quad is a billboard in world space.
  const tmpM = new THREE.Matrix4();
  const tmpUp = new THREE.Vector3(0, 1, 0);
  function cameraForwardQuat(dir) {
    tmpM.lookAt(new THREE.Vector3(0, 0, 0), dir.clone().negate(), tmpUp);
    return new THREE.Quaternion().setFromRotationMatrix(tmpM);
  }

  // --- decals: a ring of quads so a wall accumulates holes ------------------
  const holeGeo = new THREE.PlaneGeometry(0.16, 0.16);
  const holeMat = new THREE.MeshBasicMaterial({
    color: 0x0a0a0c, transparent: true, opacity: 0.85, depthWrite: false,
    polygonOffset: true, polygonOffsetFactor: -4, polygonOffsetUnits: -4,
  });
  const holes = [];
  for (let i = 0; i < DECAL_COUNT; i += 1) {
    const m = new THREE.Mesh(holeGeo, holeMat);
    m.visible = false;
    scene.add(m);
    holes.push(m);
  }
  let holeCursor = 0;

  function bulletHole(point, normal) {
    const m = holes[holeCursor];
    holeCursor = (holeCursor + 1) % DECAL_COUNT;
    m.position.copy(point).addScaledVector(normal, 0.012);
    m.quaternion.copy(cameraForwardQuat(normal));
    m.visible = true;
  }

  // --- impact flash: brief bright pops where rounds land --------------------
  // Where the muzzle flash is about the gun, this is about the far end of the tracer. A tiny additive
  // sphere plus a point light at the hit reads as a thump against a wall/armour and, with the sparks,
  // ties the muzzle to the impact in one visual motion.
  const IMPACT_COUNT = 8;
  const impactCoreMat = new THREE.MeshBasicMaterial({
    color: 0xfff2d8, transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false,
  });
  const impactHaloMat = new THREE.MeshBasicMaterial({
    color: 0xff9a3c, transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false,
  });
  // Round-robin now, so the newest impact is always the brightest and the noise stays bounded.
  const impacts = [];
  for (let i = 0; i < IMPACT_COUNT; i += 1) {
    const core = new THREE.Mesh(new THREE.SphereGeometry(0.032, 10, 8), impactCoreMat);
    const halo = new THREE.Mesh(new THREE.SphereGeometry(0.12, 12, 10), impactHaloMat);
    const light = new THREE.PointLight(0xffc880, 0, 5, 1.6);
    const g = new THREE.Group();
    g.add(core, halo, light);
    g.visible = false;
    scene.add(g);
    impacts.push({ group: g, core, halo, light, ttl: 0, life: 0.06 });
  }
  let impactCursor = 0;

  function impactFlash(point, normal, strength = 1) {
    const s = impacts[impactCursor];
    impactCursor = (impactCursor + 1) % IMPACT_COUNT;
    s.group.position.copy(point).addScaledVector(normal, 0.03);
    s.group.visible = true;
    s.life = 0.06;
    s.ttl = s.life;
    s.core.scale.setScalar(strength);
    s.halo.scale.setScalar(strength);
    s.core.material.opacity = 1;
    s.halo.material.opacity = 0.85;
    s.light.intensity = 8 * strength;
  }
  const traceGeo = new THREE.BufferGeometry();
  const tracePos = new Float32Array(2 * 3 * 12);
  traceGeo.setAttribute('position', new THREE.BufferAttribute(tracePos, 3));
  traceGeo.setDrawRange(0, 0);
  const traceMat = new THREE.LineBasicMaterial({
    color: 0xffe0a0, transparent: true, opacity: 0.55, blending: THREE.AdditiveBlending,
  });
  const tracers = new THREE.LineSegments(traceGeo, traceMat);
  tracers.frustumCulled = false;
  scene.add(tracers);
  let traceLive = 0;
  let traceTtl = 0;

  function tracer(from, to) {
    const j = traceLive * 6;
    if (j + 6 > tracePos.length) return;
    tracePos[j] = from.x; tracePos[j + 1] = from.y; tracePos[j + 2] = from.z;
    tracePos[j + 3] = to.x; tracePos[j + 4] = to.y; tracePos[j + 5] = to.z;
    traceLive += 1;
    traceGeo.setDrawRange(0, traceLive * 2);
    traceTtl = 0.045;
  }

  /** One shot's worth of everything: flash at the muzzle, tracer, sparks and a hole at the hit. */
  function gunshot(muzzle, hitPoint, hitNormal, opts = {}) {
    const dir = hitPoint ? hitPoint.clone().sub(muzzle).normalize() : new THREE.Vector3(0, 0, -1);
    muzzleFlash(muzzle, dir, opts.strength ?? 1, opts.viewMuzzle ?? null);
    if (hitPoint) {
      tracer(muzzle, hitPoint);
      const n = hitNormal ?? dir.clone().negate();
      emitSparks(hitPoint, n, opts.sparks ?? 10, opts.tint ?? [1.0, 0.78, 0.44]);
      impactFlash(hitPoint, n, opts.impact ?? 1);
      bulletHole(hitPoint, n);
    }
  }

  /**
   * Advance every effect. Sparks fall, decals fade after a while, flash lights time out, tracers
   * clear. Called once per rendered frame with the frame's dt.
   */
  function update(dt) {
    // Sparks.
    for (let i = 0; i < sparkLive; i += 1) {
      if (sparkLife[i] <= 0) continue;
      sparkLife[i] -= dt;
      const j = i * 3;
      sparkVel[j + 1] -= 9.4 * dt;
      // Air drag so sparks do not fly like bullets.
      sparkVel[j] *= 0.94;
      sparkVel[j + 1] *= 0.96;
      sparkVel[j + 2] *= 0.94;
      sparkPos[j] += sparkVel[j] * dt;
      sparkPos[j + 1] += sparkVel[j + 1] * dt;
      sparkPos[j + 2] += sparkVel[j + 2] * dt;
      const k = Math.max(0, sparkLife[i] / sparkMax[i]);
      sparkCol[j] = Math.min(1, sparkCol[j] * (0.9 + 0.1 * k));
      sparkCol[j + 1] *= 0.965;
      sparkCol[j + 2] *= 0.955;
    }
    sparkGeo.attributes.position.needsUpdate = true;
    sparkGeo.attributes.color.needsUpdate = true;

    // Muzzle lights.
    for (const slot of flashLights) {
      if (slot.ttl <= 0) continue;
      slot.ttl -= dt;
      const k = Math.max(0, slot.ttl / slot.life);
      slot.light.intensity = 22 * k * k;
      if (slot.ttl <= 0) slot.light.visible = false;
    }

    // Flash spheres: fade fast, with the halo lingering slightly past the core.
    if (quadTtl > 0) {
      quadTtl -= dt;
      const k = Math.max(0, quadTtl / quadLife);
      coreMat.opacity = k * k;
      haloMat.opacity = 0.75 * k;
      flashLight.intensity = 14 * k * k;
      if (quadTtl <= 0) flashGroup.visible = false;
    }

    // Tracer.
    if (traceTtl > 0) {
      traceTtl -= dt;
      if (traceTtl <= 0) {
        traceLive = 0;
        traceGeo.setDrawRange(0, 0);
      }
    }

    // Impact flashes.
    for (const s of impacts) {
      if (s.ttl <= 0) continue;
      s.ttl -= dt;
      const k = Math.max(0, s.ttl / s.life);
      s.core.material.opacity = k * k;
      s.halo.material.opacity = 0.85 * k;
      s.light.intensity = 8 * k * k;
      if (s.ttl <= 0) s.group.visible = false;
    }
  }

  function clear() {
    sparkLive = 0;
    sparkCursor = 0;
    sparkGeo.setDrawRange(0, 0);
    traceLive = 0;
    traceGeo.setDrawRange(0, 0);
    for (const slot of flashLights) { slot.ttl = 0; slot.light.visible = false; }
    flashGroup.visible = false;
    for (const s of impacts) { s.ttl = 0; s.group.visible = false; }
    for (const m of holes) m.visible = false;
  }

  // A read-only view of what is live, for the screenshot probe: how many sparks are drawn, whether
  // a flash light is on, how many bullet holes are placed, whether a tracer is up. Nothing in the
  // game reads it.
  function debugState() {
    return {
      sparksLive: sparkGeo.drawRange.count,
      sparksCursor: sparkCursor,
      flashesOn: flashLights.filter((s) => s.ttl > 0).length,
      quadVisible: flashGroup.visible,
      coreOpacity: coreMat.opacity,
      holesVisible: holes.filter((m) => m.visible).length,
      tracerSegments: traceGeo.drawRange.count / 2,
      impactsOn: impacts.filter((s) => s.ttl > 0).length,
    };
  }

  return { gunshot, muzzleFlash, bulletHole, emitSparks, impactFlash, update, clear, debugState };
}
