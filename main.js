// main.js — verification viewer for the room+corridor cave generator.
//
// Focus: PROVE the cave is walkable. Default = first-person Walk test
// (WASD + gravity + voxel collision, ±1 step-up) starting at spawn.
// Also: external orbit + cross-section slab to inspect interior.
// No GI / raymarch / gameplay logic here.

import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { computeBoundsTree, disposeBoundsTree, acceleratedRaycast } from "three-mesh-bvh";
import GUI from "lil-gui";

// BVH acceleration for collision (capsule shapecast) + ground raycasts.
THREE.BufferGeometry.prototype.computeBoundsTree = computeBoundsTree;
THREE.BufferGeometry.prototype.disposeBoundsTree = disposeBoundsTree;
THREE.Mesh.prototype.raycast = acceleratedRaycast;

import { generateCave } from "./caveGenerator.js";
import { exportCaveToJSON, loadCaveFromJSON } from "./caveIO.js";
import { buildVoxelTexture } from "./voxelTexture.js";

const AIR = 0, WATER = 4, LAVA = 5;
const isOpen = (v) => v === AIR || v === WATER || v === LAVA; // walkable feet / passable
const isSolid = (v) => !isOpen(v);                            // rock / mushroom / ore

// --- params (bound to GUI) ---------------------------------------------------
const params = {
  // generator (defaults match the committed cave.json)
  X: 128, Y: 64, Z: 128,
  seed: 1,
  roomCount: 12,
  roomRadiusMin: 6,
  roomRadiusMax: 13,
  corridorRadius: 2,
  corridorHeightExtra: 2,
  extraLoops: 5,
  noiseAmount: 0.4,
  playerHeight: 3,
  keyCount: 3,
  // viewer-only display (does NOT affect exported cave.json)
  walkMode: true,
  fullbright: false,
  brightness: 1.7,
  // cross-section (orbit view)
  clip: true, clipAxis: "y", clipPos: 0.5, clipThickness: 12,
};

// --- renderer / scene --------------------------------------------------------
const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.4)); // cap DPI cost
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.toneMapping = THREE.ACESFilmicToneMapping; // filmic look for realistic rock
renderer.toneMappingExposure = params.brightness;
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.localClippingEnabled = true;
document.body.appendChild(renderer.domElement);

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x06070a);
scene.fog = new THREE.Fog(0x06070a, 50, 220);

const camera = new THREE.PerspectiveCamera(70, window.innerWidth / window.innerHeight, 0.05, 3000);

// orbit (external inspection)
const orbit = new OrbitControls(camera, renderer.domElement);
orbit.enableDamping = true;
const clock = new THREE.Clock();
// first-person look = drag-to-look (manual yaw/pitch; NO pointer lock, which
// could fling the camera on lock/boundary transitions).
let yaw = 0, pitch = 0, dragging = false;
const LOOK_SENS = 0.0026;

// cool fill from above, warm key, warm head-lamp -> limestone cave mood
const ambient = new THREE.AmbientLight(0xb9c4d6, 0.35);
scene.add(ambient);
scene.add(new THREE.HemisphereLight(0x95a8c8, 0x231a12, 0.7));
const dir = new THREE.DirectionalLight(0xffe6c2, 0.8);
dir.position.set(0.6, 1.4, 0.4);
scene.add(dir);
// warm lamp that follows the camera so interiors read with depth + falloff
const headLamp = new THREE.PointLight(0xffd9a8, 1.6, 120, 1.5);
scene.add(headLamp);

// --- cross-section slab ------------------------------------------------------
const planeLo = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
const planeHi = new THREE.Plane(new THREE.Vector3(0, -1, 0), 0);
function updateClip() {
  if (!currentCave) return;
  const active = params.clip && !params.walkMode; // clip only in orbit view
  const { X, Y, Z } = currentCave.dims;
  const axisVec = { x: [1, 0, 0], y: [0, 1, 0], z: [0, 0, 1] }[params.clipAxis];
  const dim = { x: X, y: Y, z: Z }[params.clipAxis];
  const center = -dim / 2 + params.clipPos * dim;
  const half = Math.max(0.5, params.clipThickness / 2);
  planeLo.normal.set(axisVec[0], axisVec[1], axisVec[2]);
  planeLo.constant = -(center - half);
  planeHi.normal.set(-axisVec[0], -axisVec[1], -axisVec[2]);
  planeHi.constant = center + half;
  for (const m of caveMats) { m.clippingPlanes = active ? [planeLo, planeHi] : null; m.needsUpdate = true; }
}

// --- procedural rock PBR textures (no external files) -----------------------
// fBm value noise -> limestone albedo + roughness, tiled via triplanar.
const clampB = (v) => (v < 0 ? 0 : v > 255 ? 255 : v | 0);
function valueNoise2D(seed) {
  const hash = (ix, iy) => {
    let h = (Math.imul(ix, 374761393) ^ Math.imul(iy, 668265263) ^ (seed >>> 0)) >>> 0;
    h = Math.imul(h ^ (h >>> 13), 1274126177) >>> 0;
    return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
  };
  const sm = (t) => t * t * (3 - 2 * t), lp = (a, b, t) => a + (b - a) * t;
  return (x, y) => {
    const x0 = Math.floor(x), y0 = Math.floor(y), xf = sm(x - x0), yf = sm(y - y0);
    return lp(lp(hash(x0, y0), hash(x0 + 1, y0), xf), lp(hash(x0, y0 + 1), hash(x0 + 1, y0 + 1), xf), yf);
  };
}
const fbm = (n, x, y) => { let s = 0, a = 0.5, f = 1; for (let o = 0; o < 5; o++) { s += a * n(x * f, y * f); f *= 2; a *= 0.5; } return s; };
// Rock035 PBR set (ambientCG, CC0). Tiled seamlessly via triplanar.
// Keep anisotropy LOW: triplanar samples each map 3x, so high anisotropy gets
// multiplied and tanks the framerate.
const _aniso = Math.min(4, renderer.capabilities.getMaxAnisotropy());
const _texLoader = new THREE.TextureLoader();
function loadTex(url, srgb) {
  const t = _texLoader.load(url);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.anisotropy = _aniso;
  t.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
  return t;
}
const _TEX = "./texture/Rock035_2K-JPG_";
const ROCK = {
  color: loadTex(_TEX + "Color.jpg", true),
  normal: loadTex(_TEX + "NormalGL.jpg", false),
  rough: loadTex(_TEX + "Roughness.jpg", false),
  ao: loadTex(_TEX + "AmbientOcclusion.jpg", false),
};
const texWater = (() => {
  const S = 64, cvs = document.createElement("canvas"); cvs.width = cvs.height = S;
  const ctx = cvs.getContext("2d"), img = ctx.createImageData(S, S), n = valueNoise2D(3);
  for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
    const w = fbm(n, x * 0.15, y * 0.15), i = (y * S + x) * 4;
    img.data[i] = clampB(20 + w * 30); img.data[i + 1] = clampB(70 + w * 50); img.data[i + 2] = clampB(140 + w * 60); img.data[i + 3] = 255;
  }
  ctx.putImageData(img, 0, 0);
  const t = new THREE.CanvasTexture(cvs); t.wrapS = t.wrapT = THREE.RepeatWrapping; t.colorSpace = THREE.SRGBColorSpace; return t;
})();

let caveGroup = new THREE.Group();
scene.add(caveGroup);
const lavaLights = new THREE.Group();
scene.add(lavaLights);
let currentCave = null;
let gpuTextures = null;
let off = new THREE.Vector3();
let caveMats = [];     // surface materials (for clipping plane updates)
let collider = null;   // invisible merged mesh with a BVH, for walk collision

// Cube face table (neighbour offset, 4 corner offsets, used for both render +
// collision geometry). DoubleSide rendering, so winding is not critical;
// per-face normals are set explicitly for correct flat lighting.
const FACE = [
  { n: [1, 0, 0], v: [[1, 0, 0], [1, 1, 0], [1, 1, 1], [1, 0, 1]] },
  { n: [-1, 0, 0], v: [[0, 0, 1], [0, 1, 1], [0, 1, 0], [0, 0, 0]] },
  { n: [0, 1, 0], v: [[0, 1, 0], [0, 1, 1], [1, 1, 1], [1, 1, 0]] },
  { n: [0, -1, 0], v: [[0, 0, 1], [0, 0, 0], [1, 0, 0], [1, 0, 1]] },
  { n: [0, 0, 1], v: [[1, 0, 1], [1, 1, 1], [0, 1, 1], [0, 0, 1]] },
  { n: [0, 0, -1], v: [[0, 0, 0], [0, 1, 0], [1, 1, 0], [1, 0, 0]] },
];

// --- Naive Surface Nets (Lysenko, MIT) — smooth dual mesh of an isosurface --
const _cubeEdges = new Int32Array(24), _edgeTable = new Int32Array(256);
(function () {
  let k = 0;
  for (let i = 0; i < 8; ++i) for (let j = 1; j <= 4; j <<= 1) { const p = i ^ j; if (i <= p) { _cubeEdges[k++] = i; _cubeEdges[k++] = p; } }
  for (let i = 0; i < 256; ++i) {
    let em = 0;
    for (let j = 0; j < 24; j += 2) {
      const a = !!(i & (1 << _cubeEdges[j])), b = !!(i & (1 << _cubeEdges[j + 1]));
      em |= a !== b ? (1 << (j >> 1)) : 0;
    }
    _edgeTable[i] = em;
  }
})();
// field: Float32Array potential (negative = inside solid). dims=[X,Y,Z].
function surfaceNets(field, dims) {
  const vertices = [], faces = [];
  const n_ = [0, 0, 0], x = [0, 0, 0], R = [1, dims[0] + 1, (dims[0] + 1) * (dims[1] + 1)];
  const grid = new Float32Array(8);
  let buf_no = 1;
  let buffer = new Int32Array(R[2] * 2);
  let n = 0;
  for (x[2] = 0; x[2] < dims[2] - 1; ++x[2], n += dims[0], buf_no ^= 1, R[2] = -R[2]) {
    let m = 1 + (dims[0] + 1) * (1 + buf_no * (dims[1] + 1));
    for (x[1] = 0; x[1] < dims[1] - 1; ++x[1], ++n, m += 2)
      for (x[0] = 0; x[0] < dims[0] - 1; ++x[0], ++n, ++m) {
        let mask = 0, g = 0, idx = n;
        for (let k = 0; k < 2; ++k, idx += dims[0] * (dims[1] - 2))
          for (let j = 0; j < 2; ++j, idx += dims[0] - 2)
            for (let i = 0; i < 2; ++i, ++g, ++idx) { const p = field[idx]; grid[g] = p; mask |= (p < 0) ? (1 << g) : 0; }
        if (mask === 0 || mask === 0xff) continue;
        const edge_mask = _edgeTable[mask];
        const vt = [0, 0, 0]; let e_count = 0;
        for (let i = 0; i < 12; ++i) {
          if (!(edge_mask & (1 << i))) continue;
          ++e_count;
          const e0 = _cubeEdges[i << 1], e1 = _cubeEdges[(i << 1) + 1];
          const g0 = grid[e0], g1 = grid[e1];
          let t = g0 - g1; if (Math.abs(t) > 1e-6) t = g0 / t; else continue;
          for (let j = 0, k = 1; j < 3; ++j, k <<= 1) {
            const a = e0 & k, b = e1 & k;
            if (a !== b) vt[j] += a ? 1.0 - t : t; else vt[j] += a ? 1.0 : 0.0;
          }
        }
        const s = 1.0 / e_count;
        for (let i = 0; i < 3; ++i) vt[i] = x[i] + s * vt[i];
        buffer[m] = vertices.length; vertices.push(vt);
        for (let i = 0; i < 3; ++i) {
          if (!(edge_mask & (1 << i))) continue;
          const iu = (i + 1) % 3, iv = (i + 2) % 3;
          if (x[iu] === 0 || x[iv] === 0) continue;
          const du = R[iu], dv = R[iv];
          if (mask & 1) faces.push([buffer[m], buffer[m - du], buffer[m - du - dv], buffer[m - dv]]);
          else faces.push([buffer[m], buffer[m - dv], buffer[m - du - dv], buffer[m - du]]);
        }
      }
  }
  void n_;
  return { vertices, faces };
}

// Laplacian smoothing: relax surface-nets vertices toward neighbour averages so
// flat facets round off (fewer hard crease lines on big flat floors/walls).
function laplacianSmooth(vertices, faces, iters, factor) {
  const n = vertices.length;
  const adj = Array.from({ length: n }, () => new Set());
  for (const q of faces) for (let i = 0; i < 4; i++) { const a = q[i], b = q[(i + 1) % 4]; adj[a].add(b); adj[b].add(a); }
  for (let it = 0; it < iters; it++) {
    const np = vertices.map((v) => [v[0], v[1], v[2]]);
    for (let i = 0; i < n; i++) {
      const nb = adj[i]; if (!nb.size) continue;
      let sx = 0, sy = 0, sz = 0;
      for (const j of nb) { sx += vertices[j][0]; sy += vertices[j][1]; sz += vertices[j][2]; }
      const k = 1 / nb.size;
      np[i][0] = vertices[i][0] + (sx * k - vertices[i][0]) * factor;
      np[i][1] = vertices[i][1] + (sy * k - vertices[i][1]) * factor;
      np[i][2] = vertices[i][2] + (sz * k - vertices[i][2]) * factor;
    }
    for (let i = 0; i < n; i++) vertices[i] = np[i];
  }
}

// MeshStandardMaterial with world-space TRIPLANAR projection for albedo +
// roughness (so the smooth, UV-less surface-nets mesh tiles seamlessly).
function makeRockMaterial() {
  const mat = new THREE.MeshStandardMaterial({
    map: ROCK.color, roughnessMap: ROCK.rough, normalMap: ROCK.normal,
    metalness: 0.0, roughness: 1.0, vertexColors: true, side: THREE.DoubleSide,
  });
  mat.onBeforeCompile = (sh) => {
    sh.uniforms.uTri = { value: 0.18 };
    sh.vertexShader = sh.vertexShader
      .replace("#include <common>", "#include <common>\nvarying vec3 vWP; varying vec3 vWN;")
      .replace("#include <begin_vertex>", "#include <begin_vertex>\n vWP = (modelMatrix * vec4(transformed,1.0)).xyz;")
      .replace("#include <beginnormal_vertex>", "#include <beginnormal_vertex>\n vWN = normalize(mat3(modelMatrix) * objectNormal);");
    // triplanar albedo + roughness + normal, all injected AFTER the sampler
    // declarations (pars includes) so the samplers exist when referenced.
    sh.fragmentShader = sh.fragmentShader
      .replace("#include <roughnessmap_pars_fragment>",
        "#include <roughnessmap_pars_fragment>\nuniform float uTri; varying vec3 vWP; varying vec3 vWN;\n" +
        "vec3 triW(){ vec3 b=pow(abs(vWN),vec3(2.0)); return b/max(dot(b,vec3(1.0)),1e-4); }\n" +
        "vec4 triS(sampler2D s){ vec3 b=triW(); return texture2D(s,vWP.zy*uTri)*b.x+texture2D(s,vWP.xz*uTri)*b.y+texture2D(s,vWP.xy*uTri)*b.z; }\n" +
        "vec3 triN(){ vec3 b=triW();\n" +
        " vec3 nx=texture2D(normalMap,vWP.zy*uTri).xyz*2.0-1.0, ny=texture2D(normalMap,vWP.xz*uTri).xyz*2.0-1.0, nz=texture2D(normalMap,vWP.xy*uTri).xyz*2.0-1.0;\n" +
        " nx=vec3(nx.xy+vWN.zy,abs(nx.z)*vWN.x); ny=vec3(ny.xy+vWN.xz,abs(ny.z)*vWN.y); nz=vec3(nz.xy+vWN.xy,abs(nz.z)*vWN.z);\n" +
        " vec3 wn=normalize(nx.zyx*b.x+ny.xzy*b.y+nz.xyz*b.z); return normalize((viewMatrix*vec4(wn,0.0)).xyz); }")
      .replace("#include <map_fragment>", "diffuseColor.rgb *= pow(triS(map).rgb, vec3(2.2));")
      .replace("#include <roughnessmap_fragment>", "float roughnessFactor = roughness * triS(roughnessMap).g;")
      .replace("#include <normal_fragment_maps>", "normal = triN();");
  };
  return mat;
}

// Animated emissive lava (flowing fBm noise) for the lava pools. Shared time
// uniform updated each frame. Emissive is HDR-bright so it reads as a light.
const lavaTime = { value: 0 };
function makeLavaMaterial() {
  const m = new THREE.MeshStandardMaterial({ color: 0x140300, roughness: 0.8, metalness: 0.0, emissive: 0xff5a12, emissiveIntensity: 2.2 });
  m.onBeforeCompile = (sh) => {
    sh.uniforms.uTime = lavaTime;
    sh.vertexShader = sh.vertexShader
      .replace("#include <common>", "#include <common>\nvarying vec3 vLP;")
      .replace("#include <begin_vertex>", "#include <begin_vertex>\n#ifdef USE_INSTANCING\n vLP=(modelMatrix*instanceMatrix*vec4(transformed,1.0)).xyz;\n#else\n vLP=(modelMatrix*vec4(transformed,1.0)).xyz;\n#endif");
    sh.fragmentShader = sh.fragmentShader
      .replace("#include <common>",
        "#include <common>\nuniform float uTime; varying vec3 vLP;\n" +
        "float h21(vec2 p){return fract(sin(dot(p,vec2(127.1,311.7)))*43758.5453);}\n" +
        "float vn(vec2 p){vec2 i=floor(p),f=fract(p);f=f*f*(3.0-2.0*f);return mix(mix(h21(i),h21(i+vec2(1,0)),f.x),mix(h21(i+vec2(0,1)),h21(i+vec2(1,1)),f.x),f.y);}\n" +
        "float fbm2(vec2 p){float s=0.0,a=0.5;for(int i=0;i<4;i++){s+=a*vn(p);p*=2.03;a*=0.5;}return s;}")
      .replace("#include <emissivemap_fragment>",
        "vec2 lp=vLP.xz*0.25;\n" +
        "float flow=fbm2(lp+vec2(0.0,uTime*0.16))*0.6 + fbm2(lp*2.7-vec2(uTime*0.11,0.0))*0.4;\n" +
        "float hot=smoothstep(0.32,0.85,flow);\n" +
        "vec3 lava=mix(vec3(0.55,0.05,0.0),vec3(2.6,1.15,0.22),hot)+vec3(2.2,0.75,0.1)*pow(hot,3.0);\n" +
        "totalEmissiveRadiance=lava;");
  };
  return m;
}

// ---------------------------------------------------------------------------
// Build scene from a cave
// ---------------------------------------------------------------------------
function buildSceneFromCave(cave) {
  scene.remove(caveGroup);
  caveGroup.traverse((o) => {
    if (o.geometry) o.geometry.dispose();
    if (o.material) (Array.isArray(o.material) ? o.material : [o.material]).forEach((m) => m.dispose());
  });
  caveGroup = new THREE.Group();

  const { X, Y, Z } = cave.dims;
  const data = cave.data;
  const idx = (x, y, z) => x + y * X + z * X * Y;
  const inB = (x, y, z) => x >= 0 && x < X && y >= 0 && y < Y && z >= 0 && z < Z;
  const openAt = (x, y, z) => (inB(x, y, z) ? isOpen(data[idx(x, y, z)]) : false);
  off = new THREE.Vector3(-X / 2, -Y / 2, -Z / 2);

  // Pass 1: cube-face COLLISION geometry (exact voxel surface, for the BVH walk
  // controller) + collect water cells. The visible mesh is smoothed separately.
  const cpos = [], cidx = []; let cn = 0;
  const water = [], lava = [];
  for (let z = 0; z < Z; z++) for (let y = 0; y < Y; y++) for (let x = 0; x < X; x++) {
    const v = data[idx(x, y, z)];
    if (v === AIR) continue;
    if (v === WATER) { water.push([x, y, z]); continue; }
    if (v === LAVA) { lava.push([x, y, z]); continue; }
    const wx = x + off.x, wy = y + off.y, wz = z + off.z;
    for (const f of FACE) {
      if (!openAt(x + f.n[0], y + f.n[1], z + f.n[2])) continue;
      for (let k = 0; k < 4; k++) { const c = f.v[k]; cpos.push(wx + c[0], wy + c[1], wz + c[2]); }
      cidx.push(cn, cn + 1, cn + 2, cn, cn + 2, cn + 3); cn += 4;
    }
  }
  if (collider) collider.geometry.disposeBoundsTree();
  const cgeo = new THREE.BufferGeometry();
  cgeo.setAttribute("position", new THREE.Float32BufferAttribute(cpos, 3));
  cgeo.setIndex(cidx);
  cgeo.computeBoundsTree();
  collider = new THREE.Mesh(cgeo);
  collider.updateMatrixWorld(true);

  // Pass 2: SMOOTH visible mesh via Surface Nets (prefers the baked SDF for an
  // organic surface), with per-vertex AO + material tint, triplanar rock PBR.
  const N = X * Y * Z;
  const field = new Float32Array(N);
  if (cave.sdf) { const R = cave.sdfRange || 8; for (let i = 0; i < N; i++) field[i] = (cave.sdf[i] / 255 * 2 - 1) * R; }
  else for (let i = 0; i < N; i++) field[i] = isSolid(data[i]) ? -1 : 1;
  const { vertices, faces } = surfaceNets(field, [X, Y, Z]);
  laplacianSmooth(vertices, faces, 2, 0.5); // round off flat facets / crease lines
  const vpos = new Float32Array(vertices.length * 3), vcol = new Float32Array(vertices.length * 3);
  const solidAt = (x, y, z) => (x < 0 || x >= X || y < 0 || y >= Y || z < 0 || z >= Z) ? false : isSolid(data[idx(x, y, z)]);
  for (let i = 0; i < vertices.length; i++) {
    const vt = vertices[i];
    vpos[i * 3] = vt[0] + off.x + 0.5; vpos[i * 3 + 1] = vt[1] + off.y + 0.5; vpos[i * 3 + 2] = vt[2] + off.z + 0.5;
    const vx = Math.min(X - 1, Math.max(0, Math.round(vt[0]))), vy = Math.min(Y - 1, Math.max(0, Math.round(vt[1]))), vz = Math.min(Z - 1, Math.max(0, Math.round(vt[2])));
    let occ = 0, mat = 1;
    for (let dz = -1; dz <= 1; dz++) for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
      if (solidAt(vx + dx, vy + dy, vz + dz)) occ++;
      const xx = vx + dx, yy = vy + dy, zz = vz + dz;
      if (xx >= 0 && xx < X && yy >= 0 && yy < Y && zz >= 0 && zz < Z) { const vv = data[idx(xx, yy, zz)]; if (vv === 3) mat = 3; else if (vv === 2 && mat !== 3) mat = 2; }
    }
    const ao = Math.max(0.22, 1 - (occ / 27) * 0.95); // crevices darker
    let tr = 1, tg = 1, tb = 1;
    if (mat === 3) { tr = 1.1; tg = 1.25; tb = 1.5; }      // ore: cool/bright
    else if (mat === 2) { tr = 0.65; tg = 1.35; tb = 1.0; } // mushroom: greenish
    vcol[i * 3] = tr * ao; vcol[i * 3 + 1] = tg * ao; vcol[i * 3 + 2] = tb * ao;
  }
  const vindex = [];
  for (const f of faces) vindex.push(f[0], f[1], f[2], f[0], f[2], f[3]);
  const sgeo = new THREE.BufferGeometry();
  sgeo.setAttribute("position", new THREE.BufferAttribute(vpos, 3));
  sgeo.setAttribute("color", new THREE.BufferAttribute(vcol, 3));
  sgeo.setIndex(vindex);
  sgeo.computeVertexNormals();
  const rockMat = makeRockMaterial();
  caveMats = [rockMat];
  caveGroup.add(new THREE.Mesh(sgeo, rockMat));
  const surfaceCount = vertices.length;

  // water (translucent instanced cubes)
  if (water.length) {
    const wgeo = new THREE.BoxGeometry(1, 1, 1);
    const wmat = new THREE.MeshLambertMaterial({ map: texWater, transparent: true, opacity: 0.6 });
    const wmesh = new THREE.InstancedMesh(wgeo, wmat, water.length);
    const m4 = new THREE.Matrix4();
    for (let i = 0; i < water.length; i++) {
      const [x, y, z] = water[i];
      m4.makeTranslation(x + off.x + 0.5, y + off.y + 0.5, z + off.z + 0.5);
      wmesh.setMatrixAt(i, m4);
    }
    wmesh.instanceMatrix.needsUpdate = true;
    caveGroup.add(wmesh);
  }

  // lava (animated emissive pools) + warm point lights (direct-light preview)
  if (lava.length) {
    const lgeo = new THREE.BoxGeometry(1, 1, 1);
    const lmesh = new THREE.InstancedMesh(lgeo, makeLavaMaterial(), lava.length);
    const m4 = new THREE.Matrix4();
    for (let i = 0; i < lava.length; i++) {
      const [x, y, z] = lava[i];
      m4.makeTranslation(x + off.x + 0.5, y + off.y + 0.5, z + off.z + 0.5);
      lmesh.setMatrixAt(i, m4);
    }
    lmesh.instanceMatrix.needsUpdate = true;
    caveGroup.add(lmesh);
  }
  // Few point lights only: each one multiplies the per-pixel lighting cost.
  lavaLights.clear();
  const pools = cave.lavaPools || [];
  for (let i = 0; i < Math.min(pools.length, 4); i++) {
    const [x, y, z] = pools[i];
    const L = new THREE.PointLight(0xff6418, 8.0, 42, 1.8);
    L.position.set(x + off.x + 0.5, y + off.y + 1.6, z + off.z + 0.5);
    lavaLights.add(L);
  }

  // markers
  const marker = (pos, color, r = 1.6) => {
    const sp = new THREE.Mesh(new THREE.SphereGeometry(r, 16, 12), new THREE.MeshBasicMaterial({ color }));
    sp.position.set(pos[0] + off.x + 0.5, pos[1] + off.y + 0.9, pos[2] + off.z + 0.5);
    caveGroup.add(sp);
  };
  marker(cave.entrance, 0x22dd55);
  marker(cave.exit, 0xee3333);
  for (const k of cave.keys) marker(k, 0xffcc22, 1.3);

  scene.add(caveGroup);

  if (gpuTextures) { gpuTextures.voxelTex.dispose(); gpuTextures.paletteTex.dispose(); }
  gpuTextures = buildVoxelTexture(cave);

  currentCave = cave;
  if (params.walkMode) startWalk(); else frameCamera(cave);
  updateClip();
  updateHUD(cave, surfaceCount);
}

function frameCamera(cave) {
  orbit.enabled = true;
  const { X, Y, Z } = cave.dims;
  const r = Math.max(X, Y, Z);
  camera.position.set(r * 0.85, r * 0.65, r * 0.85);
  orbit.target.set(0, 0, 0);
  orbit.update();
}

// ---------------------------------------------------------------------------
// Walkable + solvable (same rule as the generator) for the HUD
// ---------------------------------------------------------------------------
function walkSolvable(cave) {
  const { X, Y, Z } = cave.dims, d = cave.data, PH = cave.playerHeight || 3;
  const idx = (x, y, z) => x + y * X + z * X * Y;
  const isWalk = (x, y, z) => {
    if (!isOpen(d[idx(x, y, z)])) return false;
    if (!isSolid(d[idx(x, y - 1, z)])) return false;
    for (let h = 1; h < PH; h++) if (d[idx(x, y + h, z)] !== AIR) return false;
    return true;
  };
  const seen = new Set(); const key = (x, y, z) => x + "," + y + "," + z;
  const q = [cave.entrance]; seen.add(key(...cave.entrance));
  const H = [[1, 0], [-1, 0], [0, 1], [0, -1]]; let h = 0;
  while (h < q.length) {
    const [cx, cy, cz] = q[h++];
    for (const [dx, dz] of H) for (let dy = -1; dy <= 1; dy++) {
      const nx = cx + dx, ny = cy + dy, nz = cz + dz;
      if (nx < 1 || nx >= X - 1 || nz < 1 || nz >= Z - 1 || ny < 1 || ny >= Y - 1) continue;
      if (isWalk(nx, ny, nz) && !seen.has(key(nx, ny, nz))) { seen.add(key(nx, ny, nz)); q.push([nx, ny, nz]); }
    }
  }
  const r = (p) => seen.has(key(...p));
  return { ok: r(cave.exit) && cave.keys.every(r), reached: seen.size };
}

// ---------------------------------------------------------------------------
// HUD
// ---------------------------------------------------------------------------
const hud = document.getElementById("hud");
function updateHUD(cave, surfaceCount) {
  const sv = walkSolvable(cave);
  hud.innerHTML =
    `<b>dims</b> ${cave.dims.X}×${cave.dims.Y}×${cave.dims.Z} &nbsp;|&nbsp; <b>seed</b> ${cave.seed}<br>` +
    `<b>walkable</b> ${cave.walkableCount} &nbsp;|&nbsp; <b>reached</b> ${sv.reached}` +
    `&nbsp;|&nbsp; <b>largestRoom</b> ${cave.largestRoom}<br>` +
    `<b>solidPct</b> ${(cave.solidPct * 100).toFixed(1)}% &nbsp;|&nbsp; <b>connectedAir</b> ${cave.connectedCount}` +
    `&nbsp;|&nbsp; <b>surfaceVox</b> ${surfaceCount}<br>` +
    `<b>Solvable:</b> <span style="color:${sv.ok ? "#3e6" : "#e33"}">${sv.ok ? "YES" : "NO"}</span>` +
    `&nbsp;·&nbsp;${params.walkMode ? "WALK TEST — drag to look, WASD" : "ORBIT"}`;
}

// ---------------------------------------------------------------------------
// Walk test: capsule-vs-BVH collision for smooth, high-quality walking.
//  - horizontal: capsule shapecast pushes out of walls (slide), with the lower
//    `STEP` of the body excluded so it auto-steps over ≤1-block ledges;
//  - vertical: a downward BVH raycast snaps the feet onto the floor within STEP
//    (step up/down), else gravity makes the player fall.
// ---------------------------------------------------------------------------
const pos = new THREE.Vector3(); // player FEET (world)
const vel = new THREE.Vector3();
const keys = Object.create(null);
let PH = 3;
const RAD = 0.34, STEP = 1.05, GRAV = 30;
const ray = new THREE.Raycaster();
ray.firstHitOnly = true;
const DOWN = new THREE.Vector3(0, -1, 0);
const _seg = new THREE.Line3(), _box = new THREE.Box3();
const _tp = new THREE.Vector3(), _cp = new THREE.Vector3(), _push = new THREE.Vector3(), _ro = new THREE.Vector3();

function startWalk() {
  params.walkMode = true;
  orbit.enabled = false;
  PH = currentCave.playerHeight || 3;
  const sp = currentCave.spawn, ex = currentCave.exit;
  pos.set(sp[0] + off.x + 0.5, sp[1] + off.y, sp[2] + off.z + 0.5);
  vel.set(0, 0, 0);
  yaw = Math.atan2(sp[0] - ex[0], sp[2] - ex[2]); // face the exit
  pitch = 0;
  walkHint.style.display = "block";
}
function stopWalk() {
  params.walkMode = false;
  dragging = false;
  walkHint.style.display = "none";
  if (currentCave) frameCamera(currentCave);
}

// Push the body capsule out of walls (horizontal only). The capsule spans from
// feet+STEP up to feet+PH so ≤STEP ledges are ignored (auto-step zone).
function collideWalls() {
  if (!collider) return;
  _seg.start.set(pos.x, pos.y + STEP + RAD, pos.z);
  _seg.end.set(pos.x, pos.y + PH - RAD, pos.z);
  if (_seg.start.y > _seg.end.y) _seg.end.y = _seg.start.y; // PH small guard
  _box.makeEmpty(); _box.expandByPoint(_seg.start); _box.expandByPoint(_seg.end);
  _box.min.addScalar(-RAD); _box.max.addScalar(RAD);
  collider.geometry.boundsTree.shapecast({
    intersectsBounds: (b) => b.intersectsBox(_box),
    intersectsTriangle: (tri) => {
      const d = tri.closestPointToSegment(_seg, _tp, _cp);
      if (d < RAD) {
        _push.copy(_cp).sub(_tp); _push.y = 0;       // horizontal correction only
        if (_push.lengthSq() < 1e-9) return;
        _push.normalize().multiplyScalar(RAD - d);
        _seg.start.add(_push); _seg.end.add(_push);
      }
    },
  });
  pos.x = _seg.start.x; pos.z = _seg.start.z;
}

// Snap feet to the floor below (step up/down within STEP), else fall.
function snapGround(dt) {
  if (!collider) return;
  _ro.set(pos.x, pos.y + STEP + 0.2, pos.z);
  ray.set(_ro, DOWN);
  ray.far = STEP + 0.2 + 120;
  const hit = ray.intersectObject(collider, false)[0];
  if (hit && pos.y - hit.point.y <= STEP + 0.05) {
    pos.y += (hit.point.y - pos.y) * Math.min(1, 20 * dt); // smooth step
    if (Math.abs(pos.y - hit.point.y) < 0.02) pos.y = hit.point.y;
    vel.y = 0;
  } else {
    vel.y -= GRAV * dt;
    pos.y += vel.y * dt;
  }
}

function updateWalk(dt) {
  // orientation from drag-look yaw/pitch
  camera.quaternion.setFromEuler(new THREE.Euler(pitch, yaw, 0, "YXZ"));
  const fwd = new THREE.Vector3(0, 0, -1).applyEuler(new THREE.Euler(0, yaw, 0));
  const right = new THREE.Vector3().crossVectors(fwd, new THREE.Vector3(0, 1, 0)).normalize();
  let mx = 0, mz = 0;
  if (keys["KeyW"]) { mx += fwd.x; mz += fwd.z; }
  if (keys["KeyS"]) { mx -= fwd.x; mz -= fwd.z; }
  if (keys["KeyD"]) { mx += right.x; mz += right.z; }
  if (keys["KeyA"]) { mx -= right.x; mz -= right.z; }
  const len = Math.hypot(mx, mz);
  if (len > 0) {
    const sp = (keys["ShiftLeft"] ? 18 : 9) * dt;
    pos.x += (mx / len) * sp;
    pos.z += (mz / len) * sp;
  }
  collideWalls();
  snapGround(dt);
  camera.position.set(pos.x, pos.y + (PH - 0.5), pos.z);
  headLamp.position.copy(camera.position);
}

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------
function regenerate() {
  buildSceneFromCave(generateCave({
    X: params.X, Y: params.Y, Z: params.Z, seed: params.seed,
    roomCount: params.roomCount, roomRadiusMin: params.roomRadiusMin, roomRadiusMax: params.roomRadiusMax,
    corridorRadius: params.corridorRadius, corridorHeightExtra: params.corridorHeightExtra,
    extraLoops: params.extraLoops, noiseAmount: params.noiseAmount,
    playerHeight: params.playerHeight, keyCount: params.keyCount,
  }));
}
function exportJSON() { if (currentCave) exportCaveToJSON(currentCave, "cave.json"); }
async function loadCaveJson() {
  try {
    const res = await fetch("./cave.json", { cache: "no-store" });
    if (!res.ok) throw new Error(res.status);
    const cave = loadCaveFromJSON(await res.json());
    params.seed = cave.seed; params.X = cave.dims.X; params.Y = cave.dims.Y; params.Z = cave.dims.Z;
    gui.controllersRecursive().forEach((c) => c.updateDisplay());
    buildSceneFromCave(cave);
  } catch (e) { console.warn("[main] cave.json load failed:", e); }
}

// ---------------------------------------------------------------------------
// Input + hint overlay
// ---------------------------------------------------------------------------
const walkHint = document.createElement("div");
walkHint.style.cssText =
  "position:fixed;bottom:48px;left:50%;transform:translateX(-50%);z-index:20;display:none;" +
  "font:13px/1.5 ui-monospace,monospace;color:#cde;background:rgba(8,12,20,0.82);" +
  "padding:8px 14px;border-radius:6px;border:1px solid rgba(120,140,180,0.3);";
walkHint.innerHTML = "<b>Drag</b> to look · <b>WASD</b> move · <b>Shift</b> run";
document.body.appendChild(walkHint);
window.addEventListener("keydown", (e) => {
  keys[e.code] = true;
  if (params.walkMode && (e.code === "Space" || e.code.startsWith("Arrow"))) e.preventDefault();
});
window.addEventListener("keyup", (e) => { keys[e.code] = false; });
// drag-to-look (no pointer lock)
renderer.domElement.addEventListener("pointerdown", (e) => {
  if (!params.walkMode) return;
  dragging = true;
  renderer.domElement.setPointerCapture(e.pointerId);
});
renderer.domElement.addEventListener("pointerup", () => { dragging = false; });
renderer.domElement.addEventListener("pointermove", (e) => {
  if (!params.walkMode || !dragging) return;
  yaw -= e.movementX * LOOK_SENS;
  pitch -= e.movementY * LOOK_SENS;
  const lim = Math.PI / 2 - 0.05;
  pitch = Math.max(-lim, Math.min(lim, pitch));
});

// ---------------------------------------------------------------------------
// GUI
// ---------------------------------------------------------------------------
const gui = new GUI({ title: "Cave Viewer" });
gui.add({ "Load cave.json": loadCaveJson }, "Load cave.json");
gui.add({ "Export to JSON": exportJSON }, "Export to JSON");

const view = gui.addFolder("View");
view.add(params, "walkMode").name("Walk test").onChange((v) => { v ? startWalk() : stopWalk(); updateClip(); });
view.add(params, "fullbright").name("Bright (flat fill)").onChange((v) => { ambient.intensity = v ? 1.8 : 0.35; });
view.add(params, "brightness", 0.2, 6.0, 0.05).name("Brightness").onChange((v) => { renderer.toneMappingExposure = v; });

const sec = gui.addFolder("Cross-section (orbit only)");
sec.add(params, "clip").name("Slab on").onChange(updateClip);
sec.add(params, "clipAxis", ["x", "y", "z"]).name("Axis").onChange(updateClip);
sec.add(params, "clipPos", 0, 1, 0.005).name("Scan position").onChange(updateClip);
sec.add(params, "clipThickness", 1, 64, 1).name("Thickness (vox)").onChange(updateClip);

const genf = gui.addFolder("Generator (make a new map)");
genf.close();
genf.add(params, "seed", 0, 999999, 1);
genf.add(params, "roomCount", 2, 16, 1);
genf.add(params, "roomRadiusMin", 4, 14, 1);
genf.add(params, "roomRadiusMax", 6, 20, 1);
genf.add(params, "corridorRadius", 1, 5, 1);
genf.add(params, "extraLoops", 0, 6, 1);
genf.add(params, "noiseAmount", 0, 0.8, 0.02);
genf.add(params, "keyCount", 0, 8, 1);
genf.add({ Regenerate: regenerate }, "Regenerate");

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------
(async function boot() {
  try {
    const res = await fetch("./cave.json", { cache: "no-store" });
    if (res.ok) {
      const cave = loadCaveFromJSON(await res.json());
      params.seed = cave.seed; params.X = cave.dims.X; params.Y = cave.dims.Y; params.Z = cave.dims.Z;
      gui.controllersRecursive().forEach((c) => c.updateDisplay());
      buildSceneFromCave(cave);
      return;
    }
  } catch (_) { /* fall through */ }
  regenerate();
})();

// ---------------------------------------------------------------------------
// Loop
// ---------------------------------------------------------------------------
window.addEventListener("resize", () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
});
function animate() {
  requestAnimationFrame(animate);
  const dt = Math.min(clock.getDelta(), 0.05);
  lavaTime.value += dt; // animate lava flow
  if (params.walkMode && currentCave) updateWalk(dt);
  else { orbit.update(); headLamp.position.copy(camera.position); }
  renderer.render(scene, camera);
}
animate();
