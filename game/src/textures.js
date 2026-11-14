// Procedural textures for the world, generated in the browser at load time.
//
// Every surface in the game was a flat colour, which is what made it read as a greybox: a flat
// material has nothing for light to catch, so a wall and a crate look the same shape whatever the
// light does. These generators paint real maps instead — a base colour with grime and wear, a
// roughness map that varies so highlights break up, and a normal map so the surface has relief.
//
// Nothing is loaded from disk: the maps are computed from value noise, so the game ships as code.
// The noise wraps at the texture edge, so a tiled surface has no seam.
//
// Cost: a 512 map is ~260k pixels through a 5-octave fbm, which lands around 150 ms per map. The
// set below costs roughly a second at boot, which is why they are built once and shared.

import * as THREE from 'three';

const SRGB = THREE.SRGBColorSpace ?? null;
const LINEAR = THREE.NoColorSpace ?? THREE.LinearSRGBColorSpace ?? null;

function makeCanvas(size) {
  const c = document.createElement('canvas');
  c.width = size;
  c.height = size;
  return c;
}

// --- value noise -----------------------------------------------------------

function hash2(x, y, seed) {
  let h = Math.imul(x, 374761393) + Math.imul(y, 668265263) + Math.imul(seed, 2246822519);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967295;
}

const lerp = (a, b, t) => a + (b - a) * t;
const smoothstep = (t) => t * t * (3 - 2 * t);
const wrap = (v, p) => ((v % p) + p) % p;

/** Value noise on a lattice that repeats every `period` cells, so the result tiles. */
function pnoise(x, y, seed, period) {
  const xi = Math.floor(x);
  const yi = Math.floor(y);
  const u = smoothstep(x - xi);
  const v = smoothstep(y - yi);
  const x0 = wrap(xi, period);
  const x1 = wrap(xi + 1, period);
  const y0 = wrap(yi, period);
  const y1 = wrap(yi + 1, period);
  const a = hash2(x0, y0, seed);
  const b = hash2(x1, y0, seed);
  const c = hash2(x0, y1, seed);
  const d = hash2(x1, y1, seed);
  return lerp(lerp(a, b, u), lerp(c, d, u), v);
}

/** Fractal sum; each octave doubles the frequency and keeps the lattice period aligned. */
function fbm(x, y, seed, basePeriod, octaves = 5, gain = 0.5) {
  let sum = 0;
  let norm = 0;
  let amp = 1;
  let f = 1;
  for (let i = 0; i < octaves; i += 1) {
    sum += amp * pnoise(x * f, y * f, seed + i * 37, basePeriod * f);
    norm += amp;
    amp *= gain;
    f *= 2;
  }
  return sum / norm;
}

/** Clamp helper for the paint loops. */
const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);

// --- painting helpers ------------------------------------------------------

/**
 * Paint a map by evaluating `fn(u, v)` for every pixel.
 * `fn` returns [r, g, b] in 0..1. Values are quantised to 8-bit because that is what a texture is.
 */
function paint(size, fn) {
  const c = makeCanvas(size);
  const ctx = c.getContext('2d');
  const img = ctx.createImageData(size, size);
  const data = img.data;
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const rgb = fn(x / size, y / size, x, y);
      const i = (y * size + x) * 4;
      data[i] = clamp01(rgb[0]) * 255;
      data[i + 1] = clamp01(rgb[1]) * 255;
      data[i + 2] = clamp01(rgb[2]) * 255;
      data[i + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  return c;
}

/** The height channel a normal map is derived from: one number per pixel. */
function paintHeight(size, fn) {
  const out = new Float32Array(size * size);
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      out[y * size + x] = fn(x / size, y / size);
    }
  }
  return out;
}

/**
 * Sobel the height field into a tangent-space normal map.
 * Wrapping indices keep the map tileable, and `strength` scales how deep the relief reads.
 */
function normalFromHeight(height, size, strength = 2.2) {
  const c = makeCanvas(size);
  const ctx = c.getContext('2d');
  const img = ctx.createImageData(size, size);
  const data = img.data;
  const at = (x, y) => height[wrap(y, size) * size + wrap(x, size)];
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const dx = (at(x + 1, y - 1) + 2 * at(x + 1, y) + at(x + 1, y + 1))
               - (at(x - 1, y - 1) + 2 * at(x - 1, y) + at(x - 1, y + 1));
      const dy = (at(x - 1, y + 1) + 2 * at(x, y + 1) + at(x + 1, y + 1))
               - (at(x - 1, y - 1) + 2 * at(x, y - 1) + at(x + 1, y - 1));
      let nx = -dx * strength;
      let ny = -dy * strength;
      const nz = 1;
      const len = Math.hypot(nx, ny, nz) || 1;
      nx /= len;
      ny /= len;
      const i = (y * size + x) * 4;
      data[i] = (nx * 0.5 + 0.5) * 255;
      data[i + 1] = (ny * 0.5 + 0.5) * 255;
      data[i + 2] = (nz / len * 0.5 + 0.5) * 255;
      data[i + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  return c;
}

function greyCanvas(size, fn) {
  return paint(size, (u, v) => {
    const g = clamp01(fn(u, v));
    return [g, g, g];
  });
}

// --- texture wrappers ------------------------------------------------------

let maxAniso = 4;

export function configureTextures(renderer) {
  if (renderer?.capabilities?.getMaxAnisotropy) {
    maxAniso = Math.min(8, renderer.capabilities.getMaxAnisotropy());
  }
}

function toTexture(canvas, { srgb = false, repeat = 1 } = {}) {
  const tex = new THREE.CanvasTexture(canvas);
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  tex.repeat.set(repeat, repeat);
  tex.anisotropy = maxAniso;
  if (srgb && SRGB) tex.colorSpace = SRGB;
  else if (!srgb && LINEAR) tex.colorSpace = LINEAR;
  tex.needsUpdate = true;
  return tex;
}

// --- surface generators ----------------------------------------------------

/** Poured concrete: cool grey, trowel swirls, damp patches, hairline cracks, chipped corners. */
export function concreteMaps({ size = 512, seed = 1, repeat = 1, tint = [0.52, 0.53, 0.55] } = {}) {
  const grime = (u, v) => fbm(u * 4, v * 4, seed + 11, 4, 5);
  const swell = (u, v) => fbm(u * 2, v * 2, seed + 23, 2, 3);
  const grit = (u, v) => pnoise(u * size * 0.5, v * size * 0.5, seed + 31, size * 0.5);

  const color = paint(size, (u, v) => {
    const g = grime(u, v);
    const s = swell(u, v);
    const n = grit(u, v);
    // Broad damp patches darken the slab; fine grit adds the speckle concrete has.
    const shade = 0.78 + 0.34 * g - 0.22 * s + 0.06 * (n - 0.5);
    return [tint[0] * shade, tint[1] * shade, tint[2] * shade];
  });

  const height = paintHeight(size, (u, v) => {
    const n = grit(u, v);
    const g = grime(u, v);
    // Aggregate pitting: grit highs with occasional deep pits where a stone washed out.
    return n * 0.6 + g * 0.4 - (n > 0.86 ? 0.5 : 0);
  });

  const rough = greyCanvas(size, (u, v) => {
    const g = grime(u, v);
    const s = swell(u, v);
    // Damp areas are smoother, dry areas chalky.
    return 0.72 + 0.2 * g - 0.24 * s;
  });

  return {
    map: toTexture(color, { srgb: true, repeat }),
    normalMap: toTexture(normalFromHeight(height, size, 1.5), { repeat }),
    roughnessMap: toTexture(rough, { repeat }),
  };
}

/** Painted steel panel: plate lines, bolt heads, scuffs, rust bloom at the seams. */
export function panelMaps({ size = 512, seed = 7, repeat = 1, tint = [0.30, 0.33, 0.37] } = {}) {
  // Plate grid: four plates across, one plate line per cell with a bolt at each intersection.
  const PLATES = 2;
  const cell = 1 / PLATES;

  const plateU = (u) => {
    const f = (u % cell) / cell;
    return f;
  };
  const edgeMask = (f, w = 0.035) => {
    // 1 on the plate line, 0 in the middle of the plate.
    const d = Math.min(f, 1 - f);
    return d < w ? 1 - d / w : 0;
  };

  const wear = (u, v) => fbm(u * 5, v * 5, seed + 3, 5, 5);
  const rust = (u, v) => fbm(u * 7, v * 7, seed + 5, 7, 4);

  const color = paint(size, (u, v) => {
    const fu = plateU(u);
    const fv = plateU(v);
    const line = Math.max(edgeMask(fu), edgeMask(fv));
    const w = wear(u, v);
    const r = rust(u, v);

    // Bolts sit just inside each plate corner.
    const bu = Math.abs(((u % cell) / cell) - 0.5);
    const bv = Math.abs(((v % cell) / cell) - 0.5);
    const bolt = bu > 0.41 && bv > 0.41 ? 1 : 0;

    const shade = 0.72 + 0.3 * w;
    let rgb = [tint[0] * shade, tint[1] * shade, tint[2] * shade];
    // Plate lines are darker (dirt collects there) and rust tints them brown.
    rgb = rgb.map((c, i) => lerp(c, c * 0.45 + (i === 0 ? 0.14 : 0.06), line * 0.8));
    // Rust bloom only where the noise is strong, biased to the seams.
    const rustAmt = clamp01((r - 0.55) * 2.4 + line * 0.4);
    rgb = [lerp(rgb[0], 0.29, rustAmt * 0.75), lerp(rgb[1], 0.15, rustAmt * 0.75), lerp(rgb[2], 0.08, rustAmt * 0.75)];
    // Bolts read as raised caps: slightly brighter, catching the key light.
    if (bolt) rgb = rgb.map((c) => c * 1.28 + 0.05);
    return rgb;
  });

  const height = paintHeight(size, (u, v) => {
    const fu = plateU(u);
    const fv = plateU(v);
    const line = Math.max(edgeMask(fu, 0.02), edgeMask(fv, 0.02));
    const bu = Math.abs(((u % cell) / cell) - 0.5);
    const bv = Math.abs(((v % cell) / cell) - 0.5);
    const bolt = bu > 0.41 && bv > 0.41 ? 1 : 0;
    const w = wear(u, v);
    return 0.5 + w * 0.12 - line * 0.5 + bolt * 0.55;
  });

  const rough = greyCanvas(size, (u, v) => {
    const fu = plateU(u);
    const fv = plateU(v);
    const line = Math.max(edgeMask(fu), edgeMask(fv));
    const r = rust(u, v);
    const w = wear(u, v);
    // Painted steel is fairly smooth; rust and dirt are rough; worn centres get shinier.
    return clamp01(0.34 + 0.2 * w + 0.35 * clamp01((r - 0.55) * 2.4) + line * 0.2);
  });

  return {
    map: toTexture(color, { srgb: true, repeat }),
    normalMap: toTexture(normalFromHeight(height, size, 2.6), { repeat }),
    roughnessMap: toTexture(rough, { repeat }),
  };
}

/** Shipping crate: planks, nails, stencil band, split grain, scuffed corners. */
export function crateMaps({ size = 512, seed = 13, repeat = 1, tint = [0.46, 0.34, 0.22] } = {}) {
  const PLANKS = 5;
  const plankIndex = (v) => Math.floor(v * PLANKS);
  const acrossPlank = (v) => (v * PLANKS) % 1;

  const grain = (u, v) => {
    // Grain runs along the plank: stretch the noise along u and compress across v.
    const i = plankIndex(v);
    return fbm(u * 9, v * 46 + i * 4.7, seed + i * 11, 512, 4);
  };

  const color = paint(size, (u, v) => {
    const f = acrossPlank(v);
    const g = grain(u, v);
    const i = plankIndex(v);
    // Plank gap: a dark line at both edges of every plank.
    const gap = f < 0.04 || f > 0.96 ? 1 : 0;
    // Each plank is a slightly different board.
    const plankTone = 0.86 + 0.28 * hash2(i, 3, seed);
    const knots = (() => {
      const k = fbm(u * 5, v * 5 + i * 9, seed + 71, 5, 3);
      return k > 0.72 ? (k - 0.72) * 3 : 0;
    })();
    const shade = (0.72 + 0.4 * g) * plankTone - knots * 0.5 - gap * 0.55;
    return [tint[0] * shade, tint[1] * shade, tint[2] * shade];
  });

  const height = paintHeight(size, (u, v) => {
    const f = acrossPlank(v);
    const g = grain(u, v);
    const gap = f < 0.04 || f > 0.96 ? 1 : 0;
    return 0.55 + g * 0.2 - gap * 0.6;
  });

  const rough = greyCanvas(size, (u, v) => {
    const g = grain(u, v);
    const f = acrossPlank(v);
    const gap = f < 0.04 || f > 0.96 ? 1 : 0;
    // Bare wood is rough; the gap holds dirt and is rougher still.
    return clamp01(0.62 + 0.28 * (1 - g) + gap * 0.15);
  });

  return {
    map: toTexture(color, { srgb: true, repeat }),
    normalMap: toTexture(normalFromHeight(height, size, 2.0), { repeat }),
    roughnessMap: toTexture(rough, { repeat }),
  };
}

/** Tiled floor: grout grid, stained tiles, scuff trails down the middle of the lane. */
export function floorMaps({ size = 512, seed = 21, repeat = 1, tint = [0.36, 0.38, 0.41] } = {}) {
  const TILES = 4;
  const t = 1 / TILES;

  const stain = (u, v) => fbm(u * 3, v * 3, seed + 2, 3, 5);
  const scuff = (u, v) => fbm(u * 6, v * 12, seed + 9, 6, 4);

  const groutMask = (u, v) => {
    const fu = (u % t) / t;
    const fv = (v % t) / t;
    const du = Math.min(fu, 1 - fu);
    const dv = Math.min(fv, 1 - fv);
    const w = 0.045;
    return du < w || dv < w ? 1 : 0;
  };

  const color = paint(size, (u, v) => {
    const grout = groutMask(u, v);
    const s = stain(u, v);
    const sc = scuff(u, v);
    const tileTone = 0.82 + 0.3 * hash2(Math.floor(u * TILES), Math.floor(v * TILES), seed);
    let shade = (0.74 + 0.32 * s) * tileTone;
    // The lane wears darker where boots pass.
    shade -= clamp01((sc - 0.5) * 1.6) * 0.18;
    if (grout) shade *= 0.55;
    return [tint[0] * shade, tint[1] * shade, tint[2] * shade];
  });

  const height = paintHeight(size, (u, v) => {
    const grout = groutMask(u, v);
    const s = stain(u, v);
    return 0.6 + s * 0.1 - grout * 0.65;
  });

  const rough = greyCanvas(size, (u, v) => {
    const grout = groutMask(u, v);
    const s = stain(u, v);
    const sc = scuff(u, v);
    return clamp01(0.5 + 0.26 * s + grout * 0.3 - clamp01((sc - 0.5) * 1.6) * 0.16);
  });

  return {
    map: toTexture(color, { srgb: true, repeat }),
    normalMap: toTexture(normalFromHeight(height, size, 1.7), { repeat }),
    roughnessMap: toTexture(rough, { repeat }),
  };
}

/** Woven fabric for uniforms and pouches: weft threads, wear, faded dye. */
export function fabricMaps({ size = 256, seed = 33, repeat = 1, tint = [0.22, 0.24, 0.21] } = {}) {
  const THREADS = 64;
  const weave = (u, v) => {
    // A plain weave alternates over/under every thread, which is what makes the diagonal rib.
    const a = Math.sin(u * THREADS * Math.PI * 2);
    const b = Math.sin(v * THREADS * Math.PI * 2);
    const over = (Math.floor(u * THREADS) + Math.floor(v * THREADS)) % 2 === 0;
    return (over ? a : b) * 0.5 + 0.5;
  };

  const color = paint(size, (u, v) => {
    const w = weave(u, v);
    const fade = fbm(u * 4, v * 4, seed + 4, 4, 4);
    const shade = 0.72 + 0.3 * w + 0.16 * (fade - 0.5);
    return [tint[0] * shade, tint[1] * shade, tint[2] * shade];
  });

  const height = paintHeight(size, (u, v) => weave(u, v) * 0.6 + fbm(u * 8, v * 8, seed + 6, 8, 3) * 0.4);

  const rough = greyCanvas(size, (u, v) => {
    const w = weave(u, v);
    return clamp01(0.82 + 0.14 * w);
  });

  return {
    map: toTexture(color, { srgb: true, repeat }),
    normalMap: toTexture(normalFromHeight(height, size, 1.2), { repeat }),
    roughnessMap: toTexture(rough, { repeat }),
  };
}

/** Painted metal sheet with lighter wear, for platforms and railings. */
export function paintMaps({ size = 256, seed = 47, repeat = 1, tint = [0.38, 0.40, 0.43] } = {}) {
  const chip = (u, v) => fbm(u * 11, v * 11, seed + 1, 11, 4);
  const tone = (u, v) => fbm(u * 3, v * 3, seed + 8, 3, 4);

  const color = paint(size, (u, v) => {
    const c = chip(u, v);
    const t = tone(u, v);
    const shade = 0.8 + 0.28 * t;
    let rgb = [tint[0] * shade, tint[1] * shade, tint[2] * shade];
    // Chipped paint shows bare metal: brighter and colder underneath.
    const bare = clamp01((c - 0.66) * 3.2);
    rgb = [lerp(rgb[0], 0.62, bare), lerp(rgb[1], 0.64, bare), lerp(rgb[2], 0.67, bare)];
    return rgb;
  });

  const height = paintHeight(size, (u, v) => 0.6 + fbm(u * 14, v * 14, seed + 2, 14, 3) * 0.3 - clamp01((chip(u, v) - 0.66) * 3.2) * 0.3);

  const rough = greyCanvas(size, (u, v) => {
    const bare = clamp01((chip(u, v) - 0.66) * 3.2);
    const t = tone(u, v);
    // Paint is matte, the metal under a chip is smooth.
    return clamp01(0.55 + 0.2 * t - bare * 0.35);
  });

  return {
    map: toTexture(color, { srgb: true, repeat }),
    normalMap: toTexture(normalFromHeight(height, size, 1.3), { repeat }),
    roughnessMap: toTexture(rough, { repeat }),
  };
}

/**
 * A sky-and-sun environment map, used as the scene's image-based light.
 * Without one, every material samples black from the environment and the metalness channel does
 * nothing. Painted rather than loaded, then pushed through PMREM so roughness mips are right.
 */
export function environmentTexture(renderer, {
  size = 256,
  sky = [0.42, 0.52, 0.66],
  horizon = [0.72, 0.68, 0.62],
  ground = [0.20, 0.19, 0.18],
  sun = [1.0, 0.93, 0.80],
  sunDir = [0.45, 0.62, 0.65],
} = {}) {
  // Equirectangular: v runs from sky (0) to ground (1), u around the horizon.
  const src = paint(size * 2, (u, v) => {
    const up = 1 - v;
    let rgb;
    if (up > 0.5) {
      const t = (up - 0.5) / 0.5;
      rgb = [lerp(horizon[0], sky[0], t), lerp(horizon[1], sky[1], t), lerp(horizon[2], sky[2], t)];
    } else {
      const t = up / 0.5;
      rgb = [lerp(ground[0], horizon[0], t), lerp(ground[1], horizon[1], t), lerp(ground[2], horizon[2], t)];
    }
    // A soft sun disc so specular highlights have a source with a shape.
    const su = Math.atan2(sunDir[0], sunDir[2]) / (Math.PI * 2) + 0.5;
    const sv = 1 - (Math.asin(clamp01(Math.abs(sunDir[1]))) / Math.PI + 0.5);
    let du = Math.abs(u - su);
    du = Math.min(du, 1 - du);
    const dv = v - sv;
    const d = Math.hypot(du * 2.6, dv * 1.2);
    const glow = Math.exp(-d * d * 22) * 0.9 + Math.exp(-d * d * 3) * 0.22;
    return [rgb[0] + sun[0] * glow, rgb[1] + sun[1] * glow, rgb[2] + sun[2] * glow];
  });

  const tex = new THREE.CanvasTexture(src);
  tex.mapping = THREE.EquirectangularReflectionMapping;
  if (SRGB) tex.colorSpace = SRGB;
  tex.needsUpdate = true;

  const pmrem = new THREE.PMREMGenerator(renderer);
  pmrem.compileEquirectangularShader();
  const rt = pmrem.fromEquirectangular(tex);
  pmrem.dispose();
  tex.dispose();
  return rt.texture;
}
