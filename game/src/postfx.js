// Post-processing: ambient occlusion, bloom, vignette and film grain.
//
// three.js ships these as addons, and the addons are not vendored here, so the passes are written
// out. The pipeline is deliberately small:
//
//   1. the world renders into a float colour target that carries a depth texture;
//   2. an occlusion pass reconstructs view-space position from that depth and darkens creases —
//      this is what gives a corner or a crate meeting the floor its contact shadow;
//   3. a bright pass plus two blurs make a bloom halo, added back over the frame;
//   4. a final pass composites occlusion, bloom, vignette and grain onto the screen.
//
// The viewmodel is drawn after the composite, directly to the screen: it is at the camera, so it has
// no occluders to darken against and no business being smeared by a screen-space blur.
//
// Normals are reconstructed from depth neighbours rather than from dFdx/dFdy so the shaders stay
// GLSL ES 1.00 and compile on every driver, including the software rasteriser used for screenshots.

import * as THREE from 'three';

const FULLSCREEN_VERT = /* glsl */`
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = vec4(position.xy, 0.0, 1.0);
}
`;

/** Camera intrinsics and the kernel, shared by the occlusion pass. */
function aoUniforms() {
  return {
    tDepth: { value: null },
    uNear: { value: 0.05 },
    uFar: { value: 200 },
    uTanHalfFov: { value: 0.7 },
    uAspect: { value: 1.6 },
    uRadius: { value: 0.75 },
    uBias: { value: 0.02 },
    uIntensity: { value: 1.6 },
    uFloor: { value: 0.30 },
    uResolution: { value: new THREE.Vector2(1, 1) },
    uSamples: { value: [] },
  };
}

const AO_FRAG = /* glsl */`
precision highp float;
varying vec2 vUv;
uniform sampler2D tDepth;
uniform float uNear, uFar, uTanHalfFov, uAspect, uRadius, uBias, uIntensity, uFloor;
uniform vec2 uResolution;
uniform vec2 uSamples[16];

// Depth buffer value (0..1, non-linear) to a positive view-space distance along the camera axis.
float linearDepth(float d) {
  float z = d * 2.0 - 1.0;
  return (2.0 * uNear * uFar) / (uFar + uNear - z * (uFar - uNear));
}

// Reconstruct a point in view space from a uv and a raw depth value.
vec3 viewPos(vec2 uv, float d) {
  float z = linearDepth(d);
  vec2 ndc = uv * 2.0 - 1.0;
  return vec3(ndc.x * uTanHalfFov * uAspect * z, ndc.y * uTanHalfFov * z, -z);
}

void main() {
  float d = texture2D(tDepth, vUv).r;
  // The sky has no depth written; treat it as fully lit.
  if (d >= 0.99999) { gl_FragColor = vec4(1.0); return; }

  vec3 p = viewPos(vUv, d);

  // Normal from two depth neighbours: safer than dFdx across drivers, and only three extra fetches.
  vec2 texel = 1.0 / uResolution;
  vec3 px = viewPos(vUv + vec2(texel.x, 0.0), texture2D(tDepth, vUv + vec2(texel.x, 0.0)).r);
  vec3 py = viewPos(vUv + vec2(0.0, texel.y), texture2D(tDepth, vUv + vec2(0.0, texel.y)).r);
  vec3 n = normalize(cross(px - p, py - p));
  // Face the normal toward the camera; reconstruction can hand back either winding.
  if (n.z < 0.0) n = -n;

  // Build a tangent frame around the normal so the sample disk lies in the surface plane.
  vec3 up = abs(n.z) < 0.95 ? vec3(0.0, 0.0, 1.0) : vec3(1.0, 0.0, 0.0);
  vec3 tangent = normalize(cross(up, n));
  vec3 bitangent = cross(n, tangent);

  float refZ = -p.z;
  // Discard the glove-add, it is far too close.
  float occluded = 0.0;
  float valid = 0.0;
  const int COUNT = 16;
  for (int i = 0; i < COUNT; i++) {
    vec2 s = uSamples[i] * uRadius;
    vec3 samplePos = p + tangent * s.x + bitangent * s.y + n * uBias;
    float sampleDepthZ = -samplePos.z;
    // Project the sample back to uv with the same intrinsics viewPos() inverted.
    vec2 ndc = vec2(samplePos.x / (uTanHalfFov * uAspect), samplePos.y / uTanHalfFov) / sampleDepthZ;
    vec2 uv2 = ndc * 0.5 + 0.5;
    if (uv2.x < 0.0 || uv2.x > 1.0 || uv2.y < 0.0 || uv2.y > 1.0) continue;
    float sd = texture2D(tDepth, uv2).r;
    valid += 1.0;
    float sampleZ = linearDepth(sd);
    // Range check: a stored surface far in front of the sample is a different object (a wall behind
    // a floor), not an occluder of it. Without this the whole floor darkens against the far wall.
    float diff = sampleDepthZ - sampleZ;
    if (diff > uBias && diff < uRadius * 2.4) occluded += 1.0;
  }

  float ratio = valid > 0.0 ? occluded / valid : 0.0;
  // Cap the darkening and keep a floor: full occlusion would multiply the ambient away entirely,
  // which reads as a black smudge rather than a contact shadow.
  float ao = clamp(1.0 - ratio * uIntensity, uFloor, 1.0);
  gl_FragColor = vec4(vec3(ao), 1.0);
}
`;

/** Separable blur, reused for the occlusion pass and each bloom mip. */
const BLUR_FRAG = /* glsl */`
precision highp float;
varying vec2 vUv;
uniform sampler2D tMap;
uniform vec2 uDirection;
void main() {
  float w[5];
  w[0] = 0.227027; w[1] = 0.194594; w[2] = 0.121621; w[3] = 0.054054; w[4] = 0.016216;
  vec4 sum = texture2D(tMap, vUv) * w[0];
  for (int i = 1; i < 5; i++) {
    vec2 o = uDirection * float(i);
    sum += texture2D(tMap, vUv + o) * w[i];
    sum += texture2D(tMap, vUv - o) * w[i];
  }
  gl_FragColor = sum;
}
`;

/** Bright-pass: keep only what is above the threshold, so emissive accents halo and walls do not. */
const BRIGHT_FRAG = /* glsl */`
precision highp float;
varying vec2 vUv;
uniform sampler2D tMap;
uniform float uThreshold;
void main() {
  vec3 c = texture2D(tMap, vUv).rgb;
  float l = dot(c, vec3(0.2126, 0.7152, 0.0722));
  float k = max(0.0, l - uThreshold) / max(l, 1e-4);
  gl_FragColor = vec4(c * k, 1.0);
}
`;

/** Final composite: occlusion multiply, bloom add, tone map to sRGB, vignette, grain. */
const COMPOSITE_FRAG = /* glsl */`
precision highp float;
varying vec2 vUv;
uniform sampler2D tScene;
uniform sampler2D tAO;
uniform sampler2D tBloom;
uniform float uBloomStrength;
uniform float uAOStrength;
uniform float uVignette;
uniform float uGrain;
uniform float uTime;
uniform float uExposure;
uniform vec2 uResolution;

float hash(vec2 p) {
  return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453123);
}

// ACES filmic curve (Narkowicz approximation): compresses highlights so bright surfaces keep their
// hue instead of clipping to white.
vec3 aces(vec3 x) {
  return clamp((x * (2.51 * x + 0.03)) / (x * (2.43 * x + 0.59) + 0.14), 0.0, 1.0);
}

// Linear to sRGB. three.js does this for us only when drawing to the canvas, and the world is drawn
// to an offscreen target, so the conversion has to happen here or everything reads too dark.
vec3 linearToSrgb(vec3 c) {
  return mix(c * 12.92, 1.055 * pow(max(c, 1e-5), vec3(1.0 / 2.4)) - 0.055, step(0.0031308, c));
}

void main() {
  vec3 scene = texture2D(tScene, vUv).rgb;
  float ao = texture2D(tAO, vUv).r;
  vec3 bloom = texture2D(tBloom, vUv).rgb;

  // Occlusion applied to the ambient part would be ideal; multiplying overall is the cheap version
  // and reads correctly here because the scene is ambient-dominant.
  vec3 col = scene * mix(1.0, ao, uAOStrength);
  col += bloom * uBloomStrength;

  // Exposure, tone map, then encode for the display.
  col = aces(col * uExposure);
  col = linearToSrgb(col);

  // Vignette: a smooth corner falloff that pulls the eye to the centre.
  vec2 d = vUv - 0.5;
  float vig = 1.0 - dot(d, d) * uVignette;
  col *= clamp(vig, 0.0, 1.0);

  // Film grain, animated so it does not look like a fixed overlay.
  float g = hash(vUv * uResolution + uTime * 60.0) - 0.5;
  col += g * uGrain;

  gl_FragColor = vec4(col, 1.0);
}
`;

/** A cheap poisson-ish disk, fixed once so the pattern is stable frame to frame. */
function sampleDisk(count) {
  const out = [];
  const golden = Math.PI * (3 - Math.sqrt(5));
  for (let i = 0; i < count; i += 1) {
    const r = Math.sqrt((i + 0.5) / count);
    const a = i * golden;
    out.push(new THREE.Vector2(Math.cos(a) * r, Math.sin(a) * r));
  }
  return out;
}

function fullScreenQuad(material) {
  const geo = new THREE.PlaneGeometry(2, 2);
  const mesh = new THREE.Mesh(geo, material);
  mesh.frustumCulled = false;
  const scene = new THREE.Scene();
  scene.add(mesh);
  const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  return { scene, camera, material };
}

export function createPostFX(renderer, { ao = true, bloom = true } = {}) {
  const size = new THREE.Vector2();
  renderer.getDrawingBufferSize(size);

  const depthTexture = new THREE.DepthTexture(size.x, size.y);
  depthTexture.type = THREE.UnsignedIntType;
  depthTexture.format = THREE.DepthFormat;
  depthTexture.minFilter = THREE.NearestFilter;
  depthTexture.magFilter = THREE.NearestFilter;

  const sceneRT = new THREE.WebGLRenderTarget(size.x, size.y, {
    minFilter: THREE.LinearFilter,
    magFilter: THREE.LinearFilter,
    type: THREE.HalfFloatType,
    depthTexture,
    depthBuffer: true,
  });

  const aoRT = new THREE.WebGLRenderTarget(size.x, size.y, {
    minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter,
  });
  const aoBlurRT = new THREE.WebGLRenderTarget(size.x, size.y, {
    minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter,
  });
  const bloomRT = new THREE.WebGLRenderTarget(size.x / 2, size.y / 2, {
    minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter, type: THREE.HalfFloatType,
  });
  const bloomBlurRT = new THREE.WebGLRenderTarget(size.x / 2, size.y / 2, {
    minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter, type: THREE.HalfFloatType,
  });

  const aoMat = new THREE.ShaderMaterial({
    vertexShader: FULLSCREEN_VERT, fragmentShader: AO_FRAG, uniforms: aoUniforms(),
  });
  aoMat.uniforms.uSamples.value = sampleDisk(16);

  const blurMat = new THREE.ShaderMaterial({
    vertexShader: FULLSCREEN_VERT, fragmentShader: BLUR_FRAG,
    uniforms: { tMap: { value: null }, uDirection: { value: new THREE.Vector2() } },
  });
  const brightMat = new THREE.ShaderMaterial({
    vertexShader: FULLSCREEN_VERT, fragmentShader: BRIGHT_FRAG,
    uniforms: { tMap: { value: null }, uThreshold: { value: 0.55 } },
  });
  const compositeMat = new THREE.ShaderMaterial({
    vertexShader: FULLSCREEN_VERT, fragmentShader: COMPOSITE_FRAG,
    uniforms: {
      tScene: { value: null }, tAO: { value: null }, tBloom: { value: null },
      uBloomStrength: { value: 0.9 }, uAOStrength: { value: 1.0 },
      uVignette: { value: 1.1 }, uGrain: { value: 0.028 },
      uTime: { value: 0 }, uExposure: { value: 1.45 },
      uResolution: { value: new THREE.Vector2(size.x, size.y) },
    },
  });

  const aoPass = fullScreenQuad(aoMat);
  const blurPass = fullScreenQuad(blurMat);
  const brightPass = fullScreenQuad(brightMat);
  const compositePass = fullScreenQuad(compositeMat);

  const quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), new THREE.MeshBasicMaterial());
  const copyScene = new THREE.Scene();
  copyScene.add(quad);

  function draw(pass, target) {
    renderer.setRenderTarget(target);
    renderer.render(pass.scene, pass.camera);
  }

  function blur(input, output, width, height) {
    blurMat.uniforms.tMap.value = input.texture;
    blurMat.uniforms.uDirection.value.set(1 / width, 0);
    draw(blurPass, output);
    blurMat.uniforms.tMap.value = output.texture;
    blurMat.uniforms.uDirection.value.set(0, 1 / height);
    draw(blurPass, input);
  }

  return {
    sceneRT,
    setCamera(camera) {
      const u = aoMat.uniforms;
      u.uNear.value = camera.near;
      u.uFar.value = camera.far;
      u.uTanHalfFov.value = Math.tan((camera.fov * Math.PI) / 360);
      u.uAspect.value = camera.aspect;
    },
    resize(w, h) {
      const dpr = renderer.getPixelRatio();
      const pw = Math.max(1, Math.floor(w * dpr));
      const ph = Math.max(1, Math.floor(h * dpr));
      sceneRT.setSize(pw, ph);
      aoRT.setSize(pw, ph);
      aoBlurRT.setSize(pw, ph);
      bloomRT.setSize(Math.max(1, Math.floor(pw / 2)), Math.max(1, Math.floor(ph / 2)));
      bloomBlurRT.setSize(Math.max(1, Math.floor(pw / 2)), Math.max(1, Math.floor(ph / 2)));
      aoMat.uniforms.uResolution.value.set(pw, ph);
      compositeMat.uniforms.uResolution.value.set(pw, ph);
    },
    /** Draw the world into the offscreen target. The caller then draws the viewmodel to screen. */
    renderWorld(scene, camera, time) {
      renderer.setRenderTarget(sceneRT);
      renderer.clear();
      renderer.render(scene, camera);

      const pw = sceneRT.width;
      const ph = sceneRT.height;

      // Occlusion.
      if (ao) {
        aoMat.uniforms.tDepth.value = depthTexture;
        draw(aoPass, aoRT);
        blur(aoRT, aoBlurRT, pw, ph);
      } else {
        renderer.setRenderTarget(aoRT);
        renderer.setClearColor(0xffffff, 1);
        renderer.clear(true, false, false);
      }

      // Bloom.
      if (bloom) {
        brightMat.uniforms.tMap.value = sceneRT.texture;
        draw(brightPass, bloomRT);
        blur(bloomRT, bloomBlurRT, bloomRT.width, bloomRT.height);
      }

      // Composite to the screen; the viewmodel is drawn on top by the caller.
      compositeMat.uniforms.tScene.value = sceneRT.texture;
      compositeMat.uniforms.tAO.value = aoRT.texture;
      compositeMat.uniforms.tBloom.value = bloom ? bloomRT.texture : null;
      compositeMat.uniforms.uBloomStrength.value = bloom ? compositeMat.uniforms.uBloomStrength.value : 0;
      compositeMat.uniforms.uTime.value = time;
      renderer.setRenderTarget(null);
      renderer.render(compositePass.scene, compositePass.camera);
    },
    dispose() {
      sceneRT.dispose(); aoRT.dispose(); aoBlurRT.dispose();
      bloomRT.dispose(); bloomBlurRT.dispose(); depthTexture.dispose();
      aoMat.dispose(); blurMat.dispose(); brightMat.dispose(); compositeMat.dispose();
    },
  };
}
