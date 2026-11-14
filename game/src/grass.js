// Grass: open patches of turf with instanced blades, so the map reads as open ground instead of one
// continuous concrete slab. This is the "openmap" dressing: a few open areas (the spawn plateaus and
// the mid connector) grow grass, and the edges stay concrete where the lanes and crates sit.
//
// Everything is procedural and original: a single turf texture painted on a canvas (green noise with
// a few dry blades), and one InstancedMesh of crossed tapered blades that is scattered inside the
// patches. A patch is a few hundred instances, so the whole field costs two draw calls.
//
// Nothing here is a collider or a shootable: grass is window dressing, exactly like the detail pass.

import * as THREE from 'three';

/** A blade of grass: a tapered quad, tip at the top, wider at the root. */
function bladeGeometry(w = 0.05, h = 0.34) {
  const g = new THREE.BufferGeometry();
  const hw = w / 2;
  const verts = new Float32Array([
    -hw, 0, 0,  hw, 0, 0,  -hw * 0.25, h, 0,
    hw, 0, 0,  hw * 0.25, h, 0,  -hw * 0.25, h, 0,
  ]);
  g.setAttribute('position', new THREE.BufferAttribute(verts, 3));
  g.computeVertexNormals();
  return g;
}

/** A tuft: two crossed blades so it reads as grass from any angle, not a flat card. */
function tuftGeometry() {
  const a = bladeGeometry(0.055, 0.36);
  const b = bladeGeometry(0.045, 0.30);
  b.rotateY(Math.PI / 2);
  // Merge two Positions into one, keeping the normals from each part.
  const merged = a.clone();
  // three r0.1xx merge path: build a combined BufferGeometry from both position arrays.
  const g = new THREE.BufferGeometry();
  const pa = a.getAttribute('position');
  const pb = b.getAttribute('position');
  const na = a.getAttribute('normal');
  const nb = b.getAttribute('normal');
  const pos = new Float32Array(pa.count * 3 + pb.count * 3);
  const nor = new Float32Array(pa.count * 3 + pb.count * 3);
  pos.set(pa.array, 0);
  nor.set(na.array, 0);
  pos.set(pb.array, pa.count * 3);
  nor.set(nb.array, pa.count * 3);
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
  return g;
}

/** A turf texture: mottled green with darker dry patches, painted once on a canvas. */
function turfTexture(seed = 7) {
  const size = 256;
  const c = document.createElement('canvas');
  c.width = size; c.height = size;
  const ctx = c.getContext('2d');
  let rng = seed * 1664525 + 1013904223;
  const rnd = () => { rng = (rng * 1103515245 + 12345) & 0x7fffffff; return rng / 0x7fffffff; };
  // Base green.
  ctx.fillStyle = '#41602f';
  ctx.fillRect(0, 0, size, size);
  // Mottle.
  const img = ctx.getImageData(0, 0, size, size);
  const d = img.data;
  for (let i = 0; i < d.length; i += 4) {
    const v = (Math.random() < 0.5 ? 1 : -1) * Math.random() * 18;
    d[i] = Math.max(0, Math.min(255, d[i] + v));             // R
    d[i + 1] = Math.max(0, Math.min(255, d[i + 1] + v * 1.2)); // G
    d[i + 2] = Math.max(0, Math.min(255, d[i + 2] + v * 0.4)); // B
  }
  ctx.putImageData(img, 0, 0);
  // A few dry blades scratched on top.
  ctx.strokeStyle = 'rgba(120,150,70,0.5)';
  for (let i = 0; i < 260; i += 1) {
    const x = rnd() * size, y = rnd() * size;
    ctx.beginPath();
    ctx.moveTo(x, y);
    ctx.lineTo(x + (rnd() - 0.5) * 3, y - 4 - rnd() * 6);
    ctx.stroke();
  }
  const tex = new THREE.CanvasTexture(c);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

/**
 * Scatter grass across the open ground. `patches` is a list of [cx, cz, halfW, halfD] rectangles in
 * map space; blades are dropped inside them with random yaw, scale and tint, and a flat turf slab is
 * laid under each patch so the colour carries even where the blades have been walked over.
 */
export function createGrass(scene, bounds, patches) {
  const { halfW: HW, halfL: HL } = bounds;
  const group = new THREE.Group();

  const turfTex = turfTexture(7);
  const turfMat = new THREE.MeshStandardMaterial({
    color: 0xffffff, roughness: 1.0, metalness: 0.0, map: turfTex,
  });

  // Turf slabs, slightly proud of the concrete floor so no z-fighting.
  for (const [cx, cz, hw0, hd0] of patches) {
    const slab = new THREE.Mesh(new THREE.BoxGeometry(hw0 * 2, 0.06, hd0 * 2), turfMat);
    slab.position.set(cx, 0.02, cz);
    slab.receiveShadow = true;
    group.add(slab);
  }

  const tuftGeo = tuftGeometry();
  const grassMat = new THREE.MeshStandardMaterial({
    color: 0xffffff, roughness: 0.9, metalness: 0.0, side: THREE.DoubleSide,
  });

  let total = 0;
  for (const [, , hw0, hd0] of patches) {
    total += Math.round((hw0 * hd0) / 0.9); // ~1 tuft per ~0.9 m^2
  }
  const grass = new THREE.InstancedMesh(tuftGeo, grassMat, total);
  grass.castShadow = true;
  grass.receiveShadow = true;

  const dummy = new THREE.Object3D();
  const col = new THREE.Color();
  let k = 0;
  for (const [cx, cz, hw0, hd0] of patches) {
    const n = Math.round((hw0 * hd0) / 0.9);
    for (let i = 0; i < n && k < total; i += 1) {
      const x = cx + (Math.random() * 2 - 1) * (hw0 - 0.15);
      const z = cz + (Math.random() * 2 - 1) * (hd0 - 0.15);
      dummy.position.set(x, 0.03, z);
      dummy.rotation.set(0, Math.random() * Math.PI * 2, (Math.random() - 0.5) * 0.12);
      const s = 0.7 + Math.random() * 0.9;
      dummy.scale.set(s, s * (0.8 + Math.random() * 0.6), s);
      dummy.updateMatrix();
      grass.setMatrixAt(k, dummy.matrix);
      // Green range: healthy grass to sun-bleached dry blade.
      col.setHSL(0.27 + Math.random() * 0.06, 0.45 + Math.random() * 0.2, 0.28 + Math.random() * 0.22);
      grass.setColorAt(k, col);
      k += 1;
    }
  }
  grass.count = k;
  grass.instanceMatrix.needsUpdate = true;
  if (grass.instanceColor) grass.instanceColor.needsUpdate = true;
  group.add(grass);

  scene.add(group);
  return group;
}