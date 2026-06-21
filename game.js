// game.js — Voxel Cave: Escape.
// Loads cave.json ONLY (no generator), first-person walk with gravity + voxel
// collision, collect all keys to unlock the exit, reach the exit to win.
// (GI/DDGI is layered on top in a later step; this is the playable core.)

import * as THREE from "three";
import { computeBoundsTree, disposeBoundsTree, acceleratedRaycast } from "three-mesh-bvh";
import { FBXLoader } from "three/addons/loaders/FBXLoader.js";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { clone as cloneSkinned } from "three/addons/utils/SkeletonUtils.js";
import { loadCaveFromJSON } from "./caveIO.js";

THREE.BufferGeometry.prototype.computeBoundsTree = computeBoundsTree;
THREE.BufferGeometry.prototype.disposeBoundsTree = disposeBoundsTree;
THREE.Mesh.prototype.raycast = acceleratedRaycast;

const AIR = 0, WATER = 4, LAVA = 5;
const isOpen = (v) => v === AIR || v === WATER || v === LAVA;
const isSolid = (v) => !isOpen(v);

// --- renderer / scene --------------------------------------------------------
const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.3));
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.toneMapping = THREE.ACESFilmicToneMapping;
const BRIGHTNESS = 55;                              // 1..100 scale
renderer.toneMappingExposure = BRIGHTNESS / 14;    // 55 -> ~3.9 exposure
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.BasicShadowMap;     // nearest sampling (cheapest); 1 shadow light only (cost)
document.body.appendChild(renderer.domElement);

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x05060a);
scene.fog = new THREE.Fog(0x05060a, 36, 150);

const camera = new THREE.PerspectiveCamera(74, window.innerWidth / window.innerHeight, 0.05, 2000);

// dim cave so the flashlight matters (but never fully blind)
scene.add(new THREE.AmbientLight(0x9fb0c8, 0.5));
scene.add(new THREE.HemisphereLight(0x8aa0c0, 0x1a140d, 0.4));
const headLamp = new THREE.PointLight(0xcfe0ff, 0.8, 26, 1.4); // faint "eyes adjust" glow
scene.add(headLamp);

// Flashlight = spotlight fixed to the camera (shines where you look).
scene.add(camera); // camera must be in the scene graph for its child lights
const flashlight = new THREE.SpotLight(0xfff2d8, 14, 100, Math.PI / 4, 0.4, 0.8); // 45deg cone, reach 100, decay 0.8
flashlight.position.set(0, 0, 0.2);
flashlight.target.position.set(0, 0, -1);
camera.add(flashlight); camera.add(flashlight.target);
let flashOn = true; const BATTERY_MAX = 180; let battery = BATTERY_MAX, flashTipShown = false; // 3-min flashlight battery

// --- held view-models (always drawn on top, no wall clipping) ---------------
const viewModels = new THREE.Group(); camera.add(viewModels);
const onTop = (m) => { m.renderOrder = 999; m.traverse((o) => { if (o.material) { o.material.depthTest = false; o.material.depthWrite = false; o.material.transparent = true; } o.renderOrder = 999; }); };
// right hand: flashlight
const flGroup = new THREE.Group();
flGroup.position.set(0.32, -0.3, -0.5);   // right hand
viewModels.add(flGroup);
onTop(viewModels);
// load the tactical flashlight GLB (model +X = forward, tail = -X)
new GLTFLoader().load("./flashlight_tactical_mesh.glb", (gltf) => {
  const m = gltf.scene;
  // drop the optional light-cone mesh (we use a real SpotLight)
  const rm = []; m.traverse((o) => { if (o.isMesh && /cone|light|beam|spot/i.test(o.name)) rm.push(o); });
  rm.forEach((o) => o.parent && o.parent.remove(o));
  m.rotation.y = Math.PI / 2;             // +X -> camera forward (-Z)
  const box = new THREE.Box3().setFromObject(m), size = new THREE.Vector3(); box.getSize(size);
  const s = 0.24 / (Math.max(size.x, size.y, size.z) || 1); m.scale.setScalar(s);   // ~hand size
  const c = new THREE.Vector3(); box.getCenter(c); m.position.sub(c.multiplyScalar(s)); // center
  flGroup.add(m); onTop(flGroup);
  console.log("[flashlight] GLB loaded");
}, undefined, (e) => console.warn("[flashlight] GLB load failed:", e));

// 2D HUD compass (compass.png dial + red needle pointing to the nearest key)
const compassEl = document.createElement("div");
compassEl.style.cssText = "position:fixed;left:18px;bottom:46px;width:104px;height:104px;z-index:12;pointer-events:none;clip-path:circle(50%);";
const compassImg = document.createElement("img");
compassImg.src = "./compass.png"; compassImg.style.cssText = "width:100%;height:100%;display:block;";
const needleEl = document.createElement("div");
needleEl.style.cssText = "position:absolute;left:50%;top:50%;width:5px;height:40px;margin:-40px 0 0 -2.5px;border-radius:3px;transform-origin:50% 100%;background:#ff3030;box-shadow:0 0 4px rgba(0,0,0,.6);";
compassEl.append(compassImg, needleEl);
document.body.appendChild(compassEl);

// --- Rock035 PBR textures (ambientCG, CC0) ----------------------------------
const _aniso = Math.min(4, renderer.capabilities.getMaxAnisotropy());
const _loader = new THREE.TextureLoader();
const loadTex = (url, srgb) => {
  const t = _loader.load(url);
  t.wrapS = t.wrapT = THREE.RepeatWrapping; t.anisotropy = _aniso;
  t.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
  return t;
};
const TEXP = "./texture/Rock035_2K-JPG_";
const ROCK = {
  color: loadTex(TEXP + "Color.jpg", true),
  normal: loadTex(TEXP + "NormalGL.jpg", false),
  rough: loadTex(TEXP + "Roughness.jpg", false),
};
function makeRockMaterial() {
  const mat = new THREE.MeshStandardMaterial({
    map: ROCK.color, roughnessMap: ROCK.rough, normalMap: ROCK.normal,
    metalness: 0.0, roughness: 1.0, vertexColors: true, side: THREE.DoubleSide,
  });
  mat.onBeforeCompile = (sh) => {
    sh.uniforms.uTri = { value: 0.18 };
    sh.vertexShader = sh.vertexShader
      .replace("#include <common>", "#include <common>\nvarying vec3 vWP; varying vec3 vWN; varying vec3 vGI; attribute vec3 aGI;")
      .replace("#include <begin_vertex>", "#include <begin_vertex>\n vWP = (modelMatrix * vec4(transformed,1.0)).xyz; vGI = aGI;")
      .replace("#include <beginnormal_vertex>", "#include <beginnormal_vertex>\n vWN = normalize(mat3(modelMatrix) * objectNormal);");
    sh.fragmentShader = sh.fragmentShader
      .replace("#include <roughnessmap_pars_fragment>",
        "#include <roughnessmap_pars_fragment>\nuniform float uTri; varying vec3 vWP; varying vec3 vWN; varying vec3 vGI;\n" +
        "vec4 triS(sampler2D s){ vec3 b=pow(abs(vWN),vec3(2.0)); b/=max(dot(b,vec3(1.0)),1e-4);\n" +
        " return texture2D(s,vWP.zy*uTri)*b.x+texture2D(s,vWP.xz*uTri)*b.y+texture2D(s,vWP.xy*uTri)*b.z; }\n" +
        "vec3 triN(){ vec3 b=pow(abs(vWN),vec3(2.0)); b/=max(dot(b,vec3(1.0)),1e-4);\n" +
        " vec3 nx=texture2D(normalMap,vWP.zy*uTri).xyz*2.0-1.0, ny=texture2D(normalMap,vWP.xz*uTri).xyz*2.0-1.0, nz=texture2D(normalMap,vWP.xy*uTri).xyz*2.0-1.0;\n" +
        " nx=vec3(nx.xy+vWN.zy,abs(nx.z)*vWN.x); ny=vec3(ny.xy+vWN.xz,abs(ny.z)*vWN.y); nz=vec3(nz.xy+vWN.xy,abs(nz.z)*vWN.z);\n" +
        " vec3 wn=normalize(nx.zyx*b.x+ny.xzy*b.y+nz.xyz*b.z); return normalize((viewMatrix*vec4(wn,0.0)).xyz); }")
      .replace("#include <map_fragment>", "diffuseColor.rgb *= pow(triS(map).rgb, vec3(2.2)) * 2.2;")
      .replace("#include <roughnessmap_fragment>", "float roughnessFactor = roughness * triS(roughnessMap).g;")
      .replace("#include <normal_fragment_maps>", "normal = triN();")
      // baked indirect GI (glowstone bounce), added as light tinted by albedo
      .replace("#include <emissivemap_fragment>", "#include <emissivemap_fragment>\n totalEmissiveRadiance += vGI * diffuseColor.rgb * 2.0;");
  };
  return mat;
}

// --- cube faces (collision) + Surface Nets (smooth render mesh) --------------
const FACE = [
  { n: [1, 0, 0], v: [[1, 0, 0], [1, 1, 0], [1, 1, 1], [1, 0, 1]] },
  { n: [-1, 0, 0], v: [[0, 0, 1], [0, 1, 1], [0, 1, 0], [0, 0, 0]] },
  { n: [0, 1, 0], v: [[0, 1, 0], [0, 1, 1], [1, 1, 1], [1, 1, 0]] },
  { n: [0, -1, 0], v: [[0, 0, 1], [0, 0, 0], [1, 0, 0], [1, 0, 1]] },
  { n: [0, 0, 1], v: [[1, 0, 1], [1, 1, 1], [0, 1, 1], [0, 0, 1]] },
  { n: [0, 0, -1], v: [[0, 0, 0], [0, 1, 0], [1, 1, 0], [1, 0, 0]] },
];
const _cubeEdges = new Int32Array(24), _edgeTable = new Int32Array(256);
(function () {
  let k = 0;
  for (let i = 0; i < 8; ++i) for (let j = 1; j <= 4; j <<= 1) { const p = i ^ j; if (i <= p) { _cubeEdges[k++] = i; _cubeEdges[k++] = p; } }
  for (let i = 0; i < 256; ++i) { let em = 0; for (let j = 0; j < 24; j += 2) { const a = !!(i & (1 << _cubeEdges[j])), b = !!(i & (1 << _cubeEdges[j + 1])); em |= a !== b ? (1 << (j >> 1)) : 0; } _edgeTable[i] = em; }
})();
function surfaceNets(field, dims) {
  const vertices = [], faces = [], x = [0, 0, 0], R = [1, dims[0] + 1, (dims[0] + 1) * (dims[1] + 1)];
  const grid = new Float32Array(8); let buf_no = 1, buffer = new Int32Array(R[2] * 2), n = 0;
  for (x[2] = 0; x[2] < dims[2] - 1; ++x[2], n += dims[0], buf_no ^= 1, R[2] = -R[2]) {
    let m = 1 + (dims[0] + 1) * (1 + buf_no * (dims[1] + 1));
    for (x[1] = 0; x[1] < dims[1] - 1; ++x[1], ++n, m += 2)
      for (x[0] = 0; x[0] < dims[0] - 1; ++x[0], ++n, ++m) {
        let mask = 0, g = 0, idx = n;
        for (let k = 0; k < 2; ++k, idx += dims[0] * (dims[1] - 2)) for (let j = 0; j < 2; ++j, idx += dims[0] - 2) for (let i = 0; i < 2; ++i, ++g, ++idx) { const p = field[idx]; grid[g] = p; mask |= (p < 0) ? (1 << g) : 0; }
        if (mask === 0 || mask === 0xff) continue;
        const edge_mask = _edgeTable[mask]; const vt = [0, 0, 0]; let e_count = 0;
        for (let i = 0; i < 12; ++i) {
          if (!(edge_mask & (1 << i))) continue; ++e_count;
          const e0 = _cubeEdges[i << 1], e1 = _cubeEdges[(i << 1) + 1], g0 = grid[e0], g1 = grid[e1];
          let t = g0 - g1; if (Math.abs(t) > 1e-6) t = g0 / t; else continue;
          for (let j = 0, k = 1; j < 3; ++j, k <<= 1) { const a = e0 & k, b = e1 & k; if (a !== b) vt[j] += a ? 1 - t : t; else vt[j] += a ? 1 : 0; }
        }
        const s = 1 / e_count; for (let i = 0; i < 3; ++i) vt[i] = x[i] + s * vt[i];
        buffer[m] = vertices.length; vertices.push(vt);
        for (let i = 0; i < 3; ++i) {
          if (!(edge_mask & (1 << i))) continue;
          const iu = (i + 1) % 3, iv = (i + 2) % 3; if (x[iu] === 0 || x[iv] === 0) continue;
          const du = R[iu], dv = R[iv];
          if (mask & 1) faces.push([buffer[m], buffer[m - du], buffer[m - du - dv], buffer[m - dv]]);
          else faces.push([buffer[m], buffer[m - dv], buffer[m - du - dv], buffer[m - du]]);
        }
      }
  }
  return { vertices, faces };
}
function laplacianSmooth(vertices, faces, iters, factor) {
  const n = vertices.length, adj = Array.from({ length: n }, () => new Set());
  for (const q of faces) for (let i = 0; i < 4; i++) { const a = q[i], b = q[(i + 1) % 4]; adj[a].add(b); adj[b].add(a); }
  for (let it = 0; it < iters; it++) {
    const np = vertices.map((v) => [v[0], v[1], v[2]]);
    for (let i = 0; i < n; i++) {
      const nb = adj[i]; if (!nb.size) continue; let sx = 0, sy = 0, sz = 0;
      for (const j of nb) { sx += vertices[j][0]; sy += vertices[j][1]; sz += vertices[j][2]; }
      const k = 1 / nb.size;
      np[i][0] = vertices[i][0] + (sx * k - vertices[i][0]) * factor;
      np[i][1] = vertices[i][1] + (sy * k - vertices[i][1]) * factor;
      np[i][2] = vertices[i][2] + (sz * k - vertices[i][2]) * factor;
    }
    for (let i = 0; i < n; i++) vertices[i] = np[i];
  }
}

// --- world / game state ------------------------------------------------------
let cave = null, off = new THREE.Vector3(), collider = null, PH = 3;
const keyItems = [];   // { group, light, pos[world], got }
let exitMesh = null, exitLight = null, exitPos = new THREE.Vector3();
let keysGot = 0, totalKeys = 0, won = false, lost = false, started = false;
let torchesLeft = 10; const torches = []; let aimedKey = null;
// health (Minecraft-style: 10 hearts = 20 HP), goblins
const HP_MAX = 20; let hp = HP_MAX, regenAcc = 0, shakeT = 0;
const goblins = []; const GOBLIN_SPEED = 3.8, GOBLIN_DETECT = 45, GOBLIN_DMG = 3, GOBLIN_HEAR = 30; // 약 달리기(10)의 1/3 ~ 0.4배; GOBLIN_HEAR = 달릴 때 들리는 범위
let playerRunning = false;          // true while sprinting (Shift+W) → goblins hear it
let goblinsAngry = false;   // unleashed when all glowstones are spent (strategic resource)
let goblinTemplate = null, goblinClips = []; const GOBLIN_FACE = 0; // model facing offset
let playerTemplate = null, playerClips = []; // human player character (Standard Walk) — shadow caster
const BODY_FACE = Math.PI;  // player model facing offset (body is shadow-only, 1st person)
// baked indirect-GI volume (flood from glowstones) + audio timers
let caveGeo = null, caveAGI = null, giIrr = null, giVertCell = null, giOpen = null, giDimX = 0, giDimY = 0, giDimZ = 0;
let giLava = null;   // static lava emission injected into the probe grid (computed once at build)
const GI_CELL = 3; let stepT = 0, heartT = 0, growlT = 6;
let visited = null, mapOpen = false, mapCanvas = null;   // explored-route map (M)
// tutorial stage: practice controls in a small room before the real cave
let worldGroup = new THREE.Group(); scene.add(worldGroup);
const TUTORIAL = true;           // set false to skip straight into the cave
let tutorialMode = false;
const tut = { move: false, flash: false, glow: false, key: false, map: false };
function clearWorld() {
  worldGroup.traverse((o) => { if (o.geometry) { o.geometry.disposeBoundsTree && o.geometry.disposeBoundsTree(); o.geometry.dispose(); } });
  scene.remove(worldGroup); worldGroup = new THREE.Group(); scene.add(worldGroup);
  keyItems.length = 0; torches.length = 0; goblins.length = 0;
  exitMesh = null; exitLight = null; collider = null; caveGeo = null; giVertCell = null; probeMesh = null; probeCells.length = 0;
  keysGot = 0; won = false; lost = false; torchesLeft = 10; goblinsAngry = false; giDirty = 0; shadowTorch = null;
}
function makeTutorialCave() {   // tiny solid room with a floor, one key, an exit
  const X = 22, Y = 12, Z = 30, data = new Uint8Array(X * Y * Z).fill(1), idx = (x, y, z) => x + y * X + z * X * Y;
  for (let z = 2; z < Z - 2; z++) for (let y = 2; y < 9; y++) for (let x = 2; x < X - 2; x++) data[idx(x, y, z)] = 0; // open room
  const cx = X >> 1, fy = 2;
  return { dims: { X, Y, Z }, data, palette: [], entrance: [cx, fy, 4], exit: [cx, fy, Z - 4], keys: [[cx, fy, Z >> 1]], spawn: [cx, fy, 4], playerHeight: 3, sdf: null };
}
const TUT_TASKS = [["move", "WASD로 이동하기"], ["flash", "손전등 켜기/끄기 (좌클릭)"], ["glow", "글로우스톤 10개 모두 설치하기 (우클릭)"], ["key", "열쇠 줍기 (조준 + F)"], ["map", "지도 열기 (M)"]];
const tutDone = () => TUT_TASKS.every(([k]) => tut[k]);
const tutBox = document.createElement("div");
tutBox.style.cssText = "position:fixed;top:14px;left:50%;transform:translateX(-50%);z-index:13;display:none;font:13px/1.8 ui-monospace,monospace;color:#dfe8f5;background:rgba(12,18,30,.82);border:1px solid rgba(120,140,180,.35);border-radius:10px;padding:12px 20px;text-shadow:0 1px 2px #000;pointer-events:none;text-align:left;";
document.body.appendChild(tutBox);
function updateTut() {
  if (!tutorialMode || introIdx >= 0) { tutBox.style.display = "none"; return; }  // hide during intro cards
  tutBox.style.display = "block";
  tutBox.innerHTML = "<b style='color:#ffd24a'>튜토리얼 — 조작법 익히기</b><br>" +
    TUT_TASKS.map(([k, t]) => (tut[k] ? "<span style='color:#5fe07a'>&#10003;</span> " : "<span style='color:#6b7689'>&#9633;</span> ") + t).join("<br>") +
    (tutDone() ? "<br><b style='color:#5fe07a'>완료! 초록 출구로 들어가면 동굴로 진입합니다.</b>" : "");
}
const markTut = (k) => { if (tutorialMode && !tut[k]) { tut[k] = true; updateTut(); } };
// loading screen
const loadingEl = document.getElementById("loading"), loadingTxt = loadingEl.querySelector(".lt");
function showLoading(html) { loadingTxt.innerHTML = html; loadingEl.style.display = "flex"; requestAnimationFrame(() => { loadingEl.style.opacity = "1"; }); }
function hideLoading() { loadingEl.style.opacity = "0"; setTimeout(() => { loadingEl.style.display = "none"; }, 400); }
const delay = (ms) => new Promise((r) => setTimeout(r, ms));
let tutFinishing = false;
async function finishTutorial() {
  if (tutFinishing) return; tutFinishing = true;
  tutBox.style.display = "none";
  showLoading("<b>동굴로 진입 중…</b><br><span style='font-size:15px;opacity:.9'>열쇠 조각 3개를 찾고, 출구를 찾아 탈출하세요</span>");
  const res = await fetch("./cave.json", { cache: "no-store" });
  const data = loadCaveFromJSON(await res.json());
  await delay(900);                       // let the loading screen show (min duration)
  buildWorld(data, false);                // clears tutorial, builds the cave (blocking)
  await delay(250);
  tutorialMode = false; tutFinishing = false;  // flip only after the real cave is built
  hideLoading();
}

// transient toast message
const toastEl = document.createElement("div");
toastEl.style.cssText = "position:fixed;bottom:86px;left:50%;transform:translateX(-50%);z-index:14;display:none;font:14px/1.5 ui-monospace,monospace;color:#fff;background:rgba(20,28,44,.9);border:1px solid rgba(255,210,74,.45);border-radius:9px;padding:10px 18px;text-align:center;pointer-events:none;text-shadow:0 1px 2px #000;max-width:560px;";
document.body.appendChild(toastEl);
let toastT = 0;
function showToast(msg, ms) { toastEl.innerHTML = msg; toastEl.style.display = "block"; toastT = (ms || 3800) / 1000; }
// F-prompt next to the crosshair (right side, doesn't block view)
const fprompt = document.createElement("div");
fprompt.style.cssText = "position:fixed;top:50%;left:calc(50% + 20px);transform:translateY(-50%);z-index:12;display:none;font:13px/1 ui-monospace,monospace;color:#ffd24a;background:rgba(10,14,22,.72);border:1px solid rgba(255,210,74,.5);border-radius:6px;padding:5px 9px;pointer-events:none;white-space:nowrap;text-shadow:0 1px 2px #000;";
fprompt.textContent = "[F] 줍기";
document.body.appendChild(fprompt);
// tutorial intro cards: spotlight the relevant UI (dim everything else), F to advance
const INTRO = [
  ["환영합니다 — Escape the Cave", "무너진 동굴에서 <b>열쇠 조각 3개</b>를 모아 출구로 탈출하세요.<br><b>F</b>를 눌러 조작 안내를 시작합니다.", null],
  ["나침반", "좌측 하단 나침반은 <b>가장 가까운 열쇠</b> 방향을 가리킵니다.", () => compassEl],
  ["손전등", "<b>좌클릭</b>으로 손전등을 켜고 끕니다. 지속시간은 <b>3분</b>뿐이니 배터리를 아껴 쓰세요.", () => batteryEl],
  ["글로우스톤", "<b>우클릭</b>으로 글로우스톤을 설치합니다. 영구히 빛나지만 <b>회수할 수 없고</b>, <b>10개를 모두 소진하면 고블린이 깨어나 공격</b>하니 전략적으로 쓰세요.", () => hud],
  ["열쇠 조각", "화면 중앙 <b>조준점</b>으로 열쇠를 겨냥하고 <b>F</b>로 줍습니다. 3개를 모으면 출구가 열립니다.", () => crosshair],
  ["고블린 (위험)", "어둠 속 고블린은 <b>손전등 빛</b>이나 <b>달리는 발소리</b>에 이끌려 다가옵니다. <b>Shift+W로 달리면 멀리서도 들키니</b>, 위험할 땐 걷는 게 안전합니다. 이동 속도는 당신 달리기의 약 1/3입니다.", () => heartsEl],
  ["지도", "<b>M</b> 키로 지나온 길(지도)을 확인할 수 있습니다.", () => document.getElementById("guide")],
  ["GI 확인 (probe)", "<b>P</b> 키로 GI probe 격자를 표시합니다 — 손전등·글로우스톤 빛이 동굴에 어떻게 퍼지는지(간접광)를 점으로 확인할 수 있습니다.", () => document.getElementById("guide")],
];
const introBox = document.createElement("div");
introBox.style.cssText = "position:fixed;top:15%;left:50%;transform:translateX(-50%);z-index:23;display:none;font:16px/1.7 ui-monospace,monospace;color:#eef3fb;background:rgba(12,18,30,.96);border:1px solid rgba(120,140,180,.45);border-radius:14px;padding:24px 34px;text-align:center;max-width:560px;box-shadow:0 10px 44px rgba(0,0,0,.7);";
document.body.appendChild(introBox);
// spotlight cutout: a transparent box over the target + a huge dark box-shadow
const highlightEl = document.createElement("div");
highlightEl.style.cssText = "position:fixed;z-index:21;display:none;border:2px solid #ffd24a;border-radius:10px;box-shadow:0 0 0 9999px rgba(0,0,0,.72), 0 0 16px rgba(255,210,74,.7);pointer-events:none;transition:left .2s,top .2s,width .2s,height .2s;";
document.body.appendChild(highlightEl);
function highlightTarget(el) {
  if (!el || !el.getBoundingClientRect) { highlightEl.style.display = "none"; return; }
  const r = el.getBoundingClientRect(), pad = 10;
  highlightEl.style.left = (r.left - pad) + "px"; highlightEl.style.top = (r.top - pad) + "px";
  highlightEl.style.width = (r.width + pad * 2) + "px"; highlightEl.style.height = (r.height + pad * 2) + "px";
  highlightEl.style.display = "block";
}
let introIdx = -1;
function showIntroCard() {
  const [t, d, tgt] = INTRO[introIdx];
  introBox.innerHTML = `<div style="font-size:13px;color:#8fa6c4;letter-spacing:2px">조작 안내 ${introIdx + 1} / ${INTRO.length}</div>` +
    `<div style="font-size:24px;color:#ffd24a;margin:8px 0 10px">${t}</div><div>${d}</div>` +
    `<div style="margin-top:16px;opacity:.78;font-size:14px"><b style="color:#ffd24a">F</b> 를 눌러 다음으로 →</div>`;
  introBox.style.display = "block";
  highlightTarget(tgt ? tgt() : null);
}
function startIntro() { introIdx = 0; tutBox.style.display = "none"; showIntroCard(); }
function advanceIntro() {
  introIdx++;
  if (introIdx >= INTRO.length) { introIdx = -1; introBox.style.display = "none"; highlightTarget(null); updateTut(); }
  else showIntroCard();
}
const _dir = new THREE.Vector3(), aimRay = new THREE.Raycaster(), _giP = new THREE.Vector3();
const _cqInv = new THREE.Quaternion(), _kq = new THREE.Quaternion(), _UP = new THREE.Vector3(0, 1, 0);
// debug readout (so we can see lock/keys/mouse state)
let lastDx = 0, lastDy = 0, lockErr = "";
const dbg = document.createElement("div");
dbg.style.cssText = "position:fixed;bottom:8px;right:10px;z-index:30;font:11px/1.45 ui-monospace,monospace;color:#9fe6b0;background:rgba(0,0,0,0.55);padding:5px 9px;border-radius:5px;pointer-events:none;white-space:pre;";
document.body.appendChild(dbg);

function worldOf(p) { return new THREE.Vector3(p[0] + off.x + 0.5, p[1] + off.y + 0.5, p[2] + off.z + 0.5); }

function buildWorld(c, isTut = false) {
  clearWorld();
  cave = c;
  const { X, Y, Z } = c.dims, data = c.data;
  const idx = (x, y, z) => x + y * X + z * X * Y;
  const openAt = (x, y, z) => (x < 0 || x >= X || y < 0 || y >= Y || z < 0 || z >= Z) ? false : isOpen(data[idx(x, y, z)]);
  off = new THREE.Vector3(-X / 2, -Y / 2, -Z / 2);
  PH = c.playerHeight || 3;

  // water cells (collision uses the smooth render mesh, built below)
  const water = [];
  for (let z = 0; z < Z; z++) for (let y = 0; y < Y; y++) for (let x = 0; x < X; x++)
    if (data[idx(x, y, z)] === WATER) water.push([x, y, z]);

  // smooth render mesh (prefers baked SDF) + vertex AO
  const N = X * Y * Z, field = new Float32Array(N);
  if (c.sdf) { const R = c.sdfRange || 8; for (let i = 0; i < N; i++) field[i] = (c.sdf[i] / 255 * 2 - 1) * R; }
  else for (let i = 0; i < N; i++) field[i] = isSolid(data[i]) ? -1 : 1;
  const { vertices, faces } = surfaceNets(field, [X, Y, Z]);
  laplacianSmooth(vertices, faces, 2, 0.5);
  const vpos = new Float32Array(vertices.length * 3), vcol = new Float32Array(vertices.length * 3);
  const solidAt = (x, y, z) => (x < 0 || x >= X || y < 0 || y >= Y || z < 0 || z >= Z) ? false : isSolid(data[idx(x, y, z)]);
  for (let i = 0; i < vertices.length; i++) {
    const vt = vertices[i];
    vpos[i * 3] = vt[0] + off.x + 0.5; vpos[i * 3 + 1] = vt[1] + off.y + 0.5; vpos[i * 3 + 2] = vt[2] + off.z + 0.5;
    const vx = Math.min(X - 1, Math.max(0, Math.round(vt[0]))), vy = Math.min(Y - 1, Math.max(0, Math.round(vt[1]))), vz = Math.min(Z - 1, Math.max(0, Math.round(vt[2])));
    let occ = 0;
    for (let dz = -1; dz <= 1; dz++) for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) if (solidAt(vx + dx, vy + dy, vz + dz)) occ++;
    const ao = Math.max(0.25, 1 - (occ / 27) * 0.95);
    vcol[i * 3] = vcol[i * 3 + 1] = vcol[i * 3 + 2] = ao;
  }
  const vindex = []; for (const f of faces) vindex.push(f[0], f[1], f[2], f[0], f[2], f[3]);
  const sgeo = new THREE.BufferGeometry();
  sgeo.setAttribute("position", new THREE.BufferAttribute(vpos, 3));
  sgeo.setAttribute("color", new THREE.BufferAttribute(vcol, 3));
  caveAGI = new Float32Array(vertices.length * 3);
  sgeo.setAttribute("aGI", new THREE.BufferAttribute(caveAGI, 3)); // baked indirect GI
  sgeo.setIndex(vindex); sgeo.computeVertexNormals();
  caveGeo = sgeo;
  // collision = the SMOOTH mesh we render (so hills/walls match what you see)
  if (collider) collider.geometry.disposeBoundsTree();
  sgeo.computeBoundsTree();
  collider = new THREE.Mesh(sgeo, makeRockMaterial());
  collider.receiveShadow = true;                    // cave receives the player/goblin shadow (does not cast → cheap)
  collider.updateMatrixWorld(true);
  worldGroup.add(collider);

  // lava (was water) — glowing emissive + lights nearby GI probes
  if (water.length) {
    const wgeo = new THREE.BoxGeometry(1, 1, 1);
    const wmat = new THREE.MeshStandardMaterial({ color: 0x3a0d00, emissive: 0xff4400, emissiveIntensity: 1.4, roughness: 0.85, metalness: 0.0 });
    const wmesh = new THREE.InstancedMesh(wgeo, wmat, water.length), m4 = new THREE.Matrix4();
    for (let i = 0; i < water.length; i++) { const [x, y, z] = water[i]; m4.makeTranslation(x + off.x + 0.5, y + off.y + 0.5, z + off.z + 0.5); wmesh.setMatrixAt(i, m4); }
    wmesh.instanceMatrix.needsUpdate = true; worldGroup.add(wmesh);
  }

  // --- keys ---
  totalKeys = c.keys.length;
  for (const k of c.keys) {
    const grp = new THREE.Group();
    const body = new THREE.Mesh(new THREE.IcosahedronGeometry(0.7, 0), new THREE.MeshStandardMaterial({ color: 0xffcf3a, emissive: 0xffae00, emissiveIntensity: 1.4, roughness: 0.3, metalness: 0.4 }));
    grp.add(body);
    const ring = new THREE.Mesh(new THREE.TorusGeometry(1.1, 0.08, 8, 24), new THREE.MeshBasicMaterial({ color: 0xffe07a }));
    ring.rotation.x = Math.PI / 2; grp.add(ring);
    const w = worldOf(k); grp.position.copy(w);
    const light = new THREE.PointLight(0xffc23a, 3.0, 18, 1.8); light.position.copy(w).add(new THREE.Vector3(0, 0.5, 0));
    worldGroup.add(grp); worldGroup.add(light);
    keyItems.push({ group: grp, light, pos: w.clone(), got: false });
  }

  // --- exit ---
  exitPos.copy(worldOf(c.exit));
  const ring1 = new THREE.Mesh(new THREE.TorusGeometry(1.6, 0.18, 12, 32), new THREE.MeshStandardMaterial({ color: 0xff3333, emissive: 0xff2222, emissiveIntensity: 1.0, roughness: 0.4 }));
  ring1.position.copy(exitPos); ring1.position.y += 1.2;
  exitMesh = ring1; worldGroup.add(ring1);
  exitLight = new THREE.PointLight(0xff4444, 2.5, 24, 1.8); exitLight.position.copy(exitPos).add(new THREE.Vector3(0, 1.6, 0)); worldGroup.add(exitLight);

  // spawn player
  PH = c.playerHeight || 3;
  const sp = c.spawn, ex = c.exit;
  pos.set(sp[0] + off.x + 0.5, sp[1] + off.y, sp[2] + off.z + 0.5);
  vel.set(0, 0, 0);
  yaw = Math.atan2(sp[0] - ex[0], sp[2] - ex[2]); pitch = 0;
  hp = HP_MAX; updateHearts(); spawnGoblins(isTut ? 0 : 8);   // doubled goblin count
  battery = BATTERY_MAX; flashOn = true; flashlight.intensity = 11; updateBattery();   // reset flashlight
  visited = new Uint8Array(c.dims.X * c.dims.Z);   // fog-of-war for the map
  setupGI(); buildVertCellMap(); buildLavaGI(water); bakeGIToVertices();   // DDGI probe grid + static vertex→cell map + lava emission
  updateHUD();
}

// --- first-person controller (pointer lock + clamped look) ------------------
const pos = new THREE.Vector3(), vel = new THREE.Vector3();
// invisible player body: FrontSide capsule — camera sits inside it (backfaces culled → unseen in 1st person) but it casts a shadow
// lightweight humanoid (head+torso+limbs) used ONLY as a shadow caster — built in code, zero download
let playerBody = null, playerLimbs = null, playerPhase = 0;
function buildPlayerBody() {
  if (playerBody) { playerBody.removeFromParent(); playerBody = null; }
  const mat = new THREE.MeshBasicMaterial();
  mat.colorWrite = false; mat.depthWrite = false;   // shadow-only: invisible in the camera, still casts into the shadow map
  const body = new THREE.Group();
  const add = (geo, x, y) => { const m = new THREE.Mesh(geo, mat); m.position.set(x, y, 0); m.castShadow = true; m.frustumCulled = false; body.add(m); };
  add(new THREE.CapsuleGeometry(0.26, 0.7, 4, 8), 0, 1.35);   // torso
  add(new THREE.SphereGeometry(0.24, 8, 6), 0, 1.95);         // head
  // limb = pivot group at hip/shoulder, capsule hangs down → rotate group to swing
  const limb = (px, py, r, len) => { const g = new THREE.Group(); g.position.set(px, py, 0); const c = new THREE.Mesh(new THREE.CapsuleGeometry(r, len, 4, 8), mat); c.position.y = -len / 2; c.castShadow = true; c.frustumCulled = false; g.add(c); body.add(g); return g; };
  playerLimbs = {
    legL: limb(0.16, 0.95, 0.14, 0.85), legR: limb(-0.16, 0.95, 0.14, 0.85),
    armL: limb(0.42, 1.6, 0.11, 0.7), armR: limb(-0.42, 1.6, 0.11, 0.7),
  };
  playerBody = body; playerBody.visible = false; scene.add(playerBody);
}
function animatePlayerBody(dt, moving, run) {        // simple walk: swing legs/arms while moving
  if (!playerLimbs) return;
  if (moving) playerPhase += dt * (run ? 17 : 11);
  const s = moving ? Math.sin(playerPhase) * 0.7 : 0;
  playerLimbs.legL.rotation.x = s; playerLimbs.legR.rotation.x = -s;
  playerLimbs.armL.rotation.x = -s; playerLimbs.armR.rotation.x = s;
}
// only the NEAREST glowstone casts a shadow (1 shadow light, cost)
let shadowTorch = null;
function updateShadowLight() {
  if (!torches.length) { if (shadowTorch) { shadowTorch.light.castShadow = false; shadowTorch = null; } return; }
  let best = null, bd = Infinity;
  for (const tr of torches) { const dx = tr.light.position.x - pos.x, dz = tr.light.position.z - pos.z, d = dx * dx + dz * dz; if (d < bd) { bd = d; best = tr; } }
  if (best === shadowTorch) return;                  // only re-bind when the nearest glowstone changes
  if (shadowTorch) shadowTorch.light.castShadow = false;
  shadowTorch = best;
  const L = best.light;
  if (!L.userData.shadowInit) { L.shadow.mapSize.set(512, 512); L.shadow.camera.near = 0.3; L.shadow.camera.far = 55; L.shadow.bias = -0.002; L.shadow.normalBias = 0.25; L.userData.shadowInit = true; }
  L.castShadow = true;
}
let onGround = false;
const keys = Object.create(null);
let yaw = 0, pitch = 0;
const RAD = 0.4, STEP = 1.05, GRAV = 30, LOOK = 0.0022; // collision = smooth mesh, so slimmer capsule is fine
const WALK_SPEED = 4.2, RUN_SPEED = 10;                 // run faster (sub-step collision prevents tunneling)
const ray = new THREE.Raycaster(); ray.firstHitOnly = true;
const DOWN = new THREE.Vector3(0, -1, 0);
const _seg = new THREE.Line3(), _box = new THREE.Box3(), _tp = new THREE.Vector3(), _cp = new THREE.Vector3(), _push = new THREE.Vector3(), _ro = new THREE.Vector3();
const _eu = new THREE.Euler();
function placeCamera() {                              // first-person eye
  camera.quaternion.setFromEuler(_eu.set(pitch, yaw, 0, "YXZ"));
  camera.position.set(pos.x, pos.y + (PH - 0.5), pos.z);
  headLamp.position.copy(camera.position);
}

function collideWalls() {
  if (!collider) return;
  _seg.start.set(pos.x, pos.y + STEP + RAD, pos.z); _seg.end.set(pos.x, pos.y + PH - RAD, pos.z);
  if (_seg.start.y > _seg.end.y) _seg.end.y = _seg.start.y;
  _box.makeEmpty(); _box.expandByPoint(_seg.start); _box.expandByPoint(_seg.end); _box.min.addScalar(-RAD); _box.max.addScalar(RAD);
  collider.geometry.boundsTree.shapecast({
    intersectsBounds: (b) => b.intersectsBox(_box),
    intersectsTriangle: (tri) => {
      const d = tri.closestPointToSegment(_seg, _tp, _cp);
      if (d < RAD) { _push.copy(_cp).sub(_tp); _push.y = 0; if (_push.lengthSq() < 1e-9) return; _push.normalize().multiplyScalar(RAD - d); _seg.start.add(_push); _seg.end.add(_push); }
    },
  });
  pos.x = _seg.start.x; pos.z = _seg.start.z;
}
function snapGround(dt) {
  if (!collider) return;
  _ro.set(pos.x, pos.y + STEP + 0.2, pos.z); ray.set(_ro, DOWN); ray.far = STEP + 0.2 + 120;
  const hit = ray.intersectObject(collider, false)[0];
  if (hit && vel.y <= 0 && pos.y - hit.point.y <= STEP + 0.05) {  // snap only when not rising (jump)
    pos.y += (hit.point.y - pos.y) * Math.min(1, 20 * dt);
    if (Math.abs(pos.y - hit.point.y) < 0.02) pos.y = hit.point.y;
    vel.y = 0; onGround = true;
  } else { vel.y -= GRAV * dt; pos.y += vel.y * dt; onGround = false; }
}
function updatePlayer(dt) {
  const fwd = new THREE.Vector3(0, 0, -1).applyEuler(new THREE.Euler(0, yaw, 0));
  const right = new THREE.Vector3().crossVectors(fwd, new THREE.Vector3(0, 1, 0)).normalize();
  let mx = 0, mz = 0;
  if (keys["KeyW"]) { mx += fwd.x; mz += fwd.z; }
  if (keys["KeyS"]) { mx -= fwd.x; mz -= fwd.z; }
  if (keys["KeyD"]) { mx += right.x; mz += right.z; }
  if (keys["KeyA"]) { mx -= right.x; mz -= right.z; }
  const len = Math.hypot(mx, mz);
  const run = len > 0 && (keys["ShiftLeft"] || keys["ShiftRight"]) && keys["KeyW"];
  playerRunning = run;                                     // goblins hear sprinting
  if (len > 0) {
    const dirx = mx / len, dirz = mz / len;
    let dist = (run ? RUN_SPEED : WALK_SPEED) * dt;        // slower speeds
    const maxStep = RAD * 0.5;                             // sub-step so fast moves / low fps can't tunnel thin walls
    while (dist > 1e-4) {
      const d = Math.min(maxStep, dist);
      pos.x += dirx * d; pos.z += dirz * d;
      collideWalls();
      dist -= d;
    }
    stepT -= dt; if (stepT <= 0) { sfxStep(run); stepT = run ? 0.4 : 0.55; }   // louder footsteps while running
    markTut("move");
  }
  if (keys["Space"] && onGround) { vel.y = 8.5; onGround = false; }          // jump
  collideWalls(); snapGround(dt);
  // mark explored route for the map
  if (visited && cave) {
    const { X, Z } = cave.dims, vx = Math.floor(pos.x - off.x), vz = Math.floor(pos.z - off.z);
    for (let dz = -1; dz <= 1; dz++) for (let dx = -1; dx <= 1; dx++) { const x = vx + dx, z = vz + dz; if (x >= 0 && x < X && z >= 0 && z < Z) visited[x + z * X] = 1; }
  }
  placeCamera();                                    // 1st/3rd person
  if (playerBody) {                                 // humanoid shadow caster (invisible in 1st person)
    playerBody.visible = true;
    playerBody.position.set(pos.x, pos.y, pos.z);    // origin = feet
    playerBody.rotation.y = yaw + BODY_FACE;         // face look/move direction
    animatePlayerBody(dt, len > 0, (keys["ShiftLeft"] || keys["ShiftRight"]) && keys["KeyW"]);
  }
}

// --- gameplay update ---------------------------------------------------------
const hud = document.getElementById("hud"), banner = document.getElementById("banner"), crosshair = document.getElementById("crosshair");
crosshair.style.transition = "transform .08s, background .08s";
function updateHUD() {
  hud.innerHTML = `<b>열쇠</b> ${keysGot}/${totalKeys} &nbsp; <b>글로우스톤</b> ${torchesLeft}/10`
    + (keysGot >= totalKeys ? ` &nbsp; <span style="color:#4fe06a">출구 열림 — 출구로!</span>` : ` &nbsp; 열쇠 조각을 찾으세요`);
}
function updateGameplay(dt, t) {
  // keys spin/bob
  for (const it of keyItems) { if (it.got) continue; it.group.rotation.y += dt * 1.6; it.group.position.y = it.pos.y + Math.sin(t * 2 + it.pos.x) * 0.18; }
  // aim detection (crosshair ray) -> enables [F]
  aimedKey = null;
  if (started && !won) {
    camera.getWorldDirection(_dir); aimRay.set(camera.position, _dir); aimRay.far = 4.5;
    let best = Infinity;
    for (const it of keyItems) { if (it.got) continue; const h = aimRay.intersectObject(it.group, true); if (h.length && h[0].distance < best) { best = h[0].distance; aimedKey = it; } }
  }
  // exit spin + torch flicker
  if (exitMesh) { exitMesh.rotation.z += dt * 0.8; exitMesh.rotation.y += dt * 0.4; }
  for (const tr of torches) { const f = 0.94 + Math.sin(t * 3 + tr.grp.position.x) * 0.06; tr.light.intensity = 9 * f; } // glowstone: steady glow
  // reaching the exit: tutorial -> next stage (all tasks done), else -> win
  let exitMsg = "";
  if (!won && !lost && pos.distanceTo(exitPos) < 3.2) {
    if (tutorialMode) { if (tutDone()) finishTutorial(); else exitMsg = "먼저 모든 과제를 완료하세요!"; }
    else if (keysGot >= totalKeys) winGame();
  }
  // F-prompt beside the crosshair when aiming at a key (banner reserved for exit msg)
  const showF = started && !won && !lost && aimedKey && introIdx < 0;
  fprompt.style.display = showF ? "block" : "none";
  banner.style.display = exitMsg ? "block" : "none"; if (exitMsg) banner.textContent = exitMsg;
  if (showF) { crosshair.style.transform = "scale(1.8)"; crosshair.style.background = "#ffd24a"; crosshair.style.boxShadow = "0 0 8px #ffd24a"; }
  else { crosshair.style.transform = "scale(1)"; crosshair.style.background = "rgba(255,255,255,0.7)"; crosshair.style.boxShadow = "none"; }
  // toast fade
  if (toastT > 0) { toastT -= dt; if (toastT <= 0) toastEl.style.display = "none"; }
}

// --- input -------------------------------------------------------------------
// X11/Linux sends keyup+keydown REPEAT pairs while a key is held, which clears
// held state and breaks multi-key combos. Defer the keyup: an autorepeat keydown
// cancels the pending clear; a genuine release clears after the small delay.
const keyUpTimers = Object.create(null);
window.addEventListener("keydown", (e) => {
  if (keyUpTimers[e.code]) { clearTimeout(keyUpTimers[e.code]); keyUpTimers[e.code] = 0; }
  const wasDown = keys[e.code];
  keys[e.code] = true;
  if (!wasDown && e.code === "KeyF") tryInteract();   // fire once, not on repeat
  if (!wasDown && e.code === "KeyM") { mapOpen = !mapOpen; if (mapCanvas) mapCanvas.style.display = mapOpen ? "block" : "none"; markTut("map"); }
  if (!wasDown && e.code === "KeyP") { if (!probeMesh) buildProbeViz(); if (probeMesh) { probeMesh.visible = !probeMesh.visible; if (probeMesh.visible) updateProbeColors(); showToast(probeMesh.visible ? `GI probe 격자 표시 — ${probeCells.length}개 (동굴 공간 셀, ${GI_CELL}복셀 간격)` : "probe 표시 OFF"); } }
  if (!wasDown && e.code === "KeyB") toggleMusic();
  if (e.code === "Space" || e.code.startsWith("Arrow")) e.preventDefault();
});
window.addEventListener("keyup", (e) => {
  if (keyUpTimers[e.code]) clearTimeout(keyUpTimers[e.code]);
  keyUpTimers[e.code] = setTimeout(() => { keys[e.code] = false; keyUpTimers[e.code] = 0; }, 90);
});

// Mouse look = HYBRID: if Pointer Lock engages you get free FPS look (move to
// turn); if the browser won't lock, you can still hold the mouse and drag. Works
// either way, so the cursor can never strand the camera.
let locked = false, dragging = false, skipMove = 0;
const lockOk = () => started && !won;
function requestLock() { if (lockOk() && !locked) { try { renderer.domElement.requestPointerLock(); } catch (_) {} } }
renderer.domElement.addEventListener("contextmenu", (e) => e.preventDefault());
renderer.domElement.addEventListener("mousedown", (e) => {
  if (e.button === 2) { e.preventDefault(); placeTorch(); return; } // right = torch
  dragging = true; requestLock();
  if (started && !won && !lost && !(!flashOn && battery <= 0)) {  // left = toggle (can't turn on when dead)
    flashOn = !flashOn;
    flashlight.intensity = flashOn ? 14 : 0;
    updateBattery(); markTut("flash");
    if (flashOn && !flashTipShown) { flashTipShown = true; showToast("손전등 지속시간은 3분입니다. 배터리를 고려하여 아껴 사용하세요."); }
  }
});
window.addEventListener("mouseup", () => { dragging = false; });
document.addEventListener("pointerlockchange", () => {
  locked = document.pointerLockElement === renderer.domElement;
  if (locked) { skipMove = 2; lockErr = ""; }
});
document.addEventListener("pointerlockerror", () => { lockErr = "LOCK DENIED"; });
document.addEventListener("mousemove", (e) => {
  lastDx = e.movementX || 0; lastDy = e.movementY || 0;
  if (!lockOk() || (!locked && !dragging)) return;   // need lock OR an active drag
  if (skipMove > 0) { skipMove--; return; }
  if (Math.abs(lastDx) > 200 || Math.abs(lastDy) > 200) return; // drop warp spikes
  yaw -= lastDx * LOOK; pitch -= lastDy * LOOK;
  const lim = Math.PI / 2 - 0.02; pitch = Math.max(-lim, Math.min(lim, pitch));
});

const overlay = document.getElementById("overlay");
document.getElementById("startBtn").addEventListener("click", () => {
  overlay.style.display = "none"; started = true;
  initAudio(); startMusic(); requestLock();
  if (tutorialMode) startIntro();
});
function winGame() {
  won = true; sfxWin(); document.exitPointerLock?.();
  overlay.innerHTML = `<h1 style="color:#ffe9a8">탈출 성공!</h1><div>열쇠 조각 <span class="key">${totalKeys}</span>개를 모두 모아 탈출했습니다.</div><button onclick="location.reload()">다시 하기</button>`;
  overlay.style.display = "flex";
}

// --- interaction (F) + torch placement (right-click) ------------------------
function tryInteract() {
  if (!started || won) return;
  if (introIdx >= 0) { advanceIntro(); return; }   // F advances tutorial intro cards
  if (aimedKey && !aimedKey.got) collectKey(aimedKey);
}
function collectKey(it) {
  it.got = true; keysGot++; sfxPickup(); markTut("key");
  it.group.removeFromParent(); it.light.removeFromParent();   // keys live in worldGroup
  if (keysGot >= totalKeys && exitMesh) {
    exitMesh.material.color.set(0x4fe06a); exitMesh.material.emissive.set(0x33ff66);
    exitLight.color.set(0x55ff77);
  }
  updateHUD();
}
function placeTorch() {
  if (!started || won || torchesLeft <= 0 || !collider) return;
  camera.getWorldDirection(_dir);
  aimRay.set(camera.position, _dir); aimRay.far = 7;
  const hit = aimRay.intersectObject(collider, false)[0];
  const p = hit ? hit.point.clone().addScaledVector(_dir, -0.4)
               : camera.position.clone().addScaledVector(_dir, 3);
  const grp = new THREE.Group();
  const block = new THREE.Mesh(new THREE.BoxGeometry(0.7, 0.7, 0.7), new THREE.MeshStandardMaterial({ color: 0xffe79a, emissive: 0xffc94a, emissiveIntensity: 1.7, roughness: 0.45 }));
  grp.add(block); grp.position.copy(p);
  const light = new THREE.PointLight(0xffe1a0, 9, 55, 1.0); light.position.copy(p).add(new THREE.Vector3(0, 0.2, 0));
  worldGroup.add(grp); worldGroup.add(light);
  torches.push({ grp, light, flame: block });   // glowstone (steady pulse)
  torchesLeft--; sfxTorch(); rebuildActiveProbes(); giDirty = DDGI_BURST; updateHUD();   // re-trace only probes near a glowstone
  if (torchesLeft === 0) {
    if (tutorialMode) { markTut("glow"); showToast("글로우스톤을 모두 소진했습니다 (회수 불가). 본게임에서는 다 쓰면 <b>고블린이 깨어나 공격</b>하니 전략적으로 사용하세요!", 5500); }
    else { goblinsAngry = true; showToast("⚠ 글로우스톤 소진 — <b>고블린이 깨어나 공격을 시작합니다!</b>", 6000); }
  } else if (tutorialMode) {
    showToast(`글로우스톤 설치 ${10 - torchesLeft}/10 — 10개를 모두 사용해 보세요`, 1600);
  }
  // NOTE: each torch is a real light for now; the DDGI step replaces these with
  // a single illuminance volume (cheap + drives goblin safety).
}

// --- hearts HUD (10 hearts, half-heart granularity) -------------------------
const heartsEl = document.createElement("div");
heartsEl.style.cssText = "position:fixed;bottom:18px;left:50%;transform:translateX(-50%);z-index:12;display:flex;gap:4px;pointer-events:none;";
document.body.appendChild(heartsEl);
const heartFills = [];
for (let i = 0; i < 10; i++) {
  const h = document.createElement("div");
  h.style.cssText = "position:relative;width:30px;height:28px;font:27px/28px sans-serif;";
  const base = document.createElement("span"); base.textContent = "♥"; base.style.cssText = "position:absolute;left:0;top:0;color:#37323a;text-shadow:0 1px 2px #000;";
  const fill = document.createElement("span"); fill.textContent = "♥"; fill.style.cssText = "position:absolute;left:0;top:0;color:#ff3b46;display:inline-block;overflow:hidden;width:100%;white-space:nowrap;text-shadow:0 1px 2px #000;";
  h.append(base, fill); heartsEl.append(h); heartFills.push(fill);
}
function updateHearts() { for (let i = 0; i < 10; i++) heartFills[i].style.width = (Math.max(0, Math.min(2, hp - i * 2)) / 2 * 100) + "%"; }

// flashlight battery bar
const batteryEl = document.createElement("div");
batteryEl.style.cssText = "position:fixed;bottom:60px;left:50%;transform:translateX(-50%);z-index:12;width:250px;font:14px/1.5 ui-monospace,monospace;color:#dce6f4;text-align:center;pointer-events:none;text-shadow:0 1px 2px #000;";
batteryEl.innerHTML = '<div style="margin-bottom:5px">🔦 <span id="batTxt"></span></div><div style="height:12px;background:#1a2230;border:1px solid #3a465c;border-radius:5px;overflow:hidden"><div id="batFill" style="height:100%;width:100%"></div></div>';
document.body.appendChild(batteryEl);
const batFill = batteryEl.querySelector("#batFill"), batTxt = batteryEl.querySelector("#batTxt");
function updateBattery() {
  const pct = battery / BATTERY_MAX;
  batFill.style.width = (pct * 100) + "%";
  batFill.style.background = pct < 0.17 ? "#ff4040" : (pct < 0.34 ? "#ffae3a" : "linear-gradient(90deg,#ffd24a,#ffc23a)");
  batTxt.textContent = `${Math.floor(battery / 60)}:${String(Math.floor(battery % 60)).padStart(2, "0")}` + (battery <= 0 ? " 방전" : flashOn ? " (켜짐)" : " (꺼짐)");
}

// hurt flash (red vignette)
const hurtEl = document.createElement("div");
hurtEl.style.cssText = "position:fixed;inset:0;z-index:11;pointer-events:none;opacity:0;background:radial-gradient(circle,transparent 45%,rgba(190,0,0,0.65) 100%);";
document.body.appendChild(hurtEl);
let hurtT = 0;

// explored-route map (toggle with M)
mapCanvas = document.createElement("canvas");
mapCanvas.width = mapCanvas.height = 380;
mapCanvas.style.cssText = "position:fixed;left:50%;top:50%;transform:translate(-50%,-50%);z-index:25;display:none;border:2px solid #4a5878;border-radius:8px;box-shadow:0 6px 30px rgba(0,0,0,.6);";
document.body.appendChild(mapCanvas);
function drawMap() {
  if (!cave || !visited) return;
  const { X, Z } = cave.dims, ctx = mapCanvas.getContext("2d"), W = mapCanvas.width, s = W / Math.max(X, Z);
  ctx.fillStyle = "#0a0c12"; ctx.fillRect(0, 0, W, W);
  ctx.fillStyle = "#3f72a8";
  for (let z = 0; z < Z; z++) for (let x = 0; x < X; x++) if (visited[x + z * X]) ctx.fillRect(x * s, z * s, Math.ceil(s), Math.ceil(s));
  const px = (pos.x - off.x) * s, pz = (pos.z - off.z) * s, fx = -Math.sin(yaw), fz = -Math.cos(yaw);
  ctx.strokeStyle = "#ffd24a"; ctx.lineWidth = 2; ctx.beginPath(); ctx.moveTo(px, pz); ctx.lineTo(px + fx * 14, pz + fz * 14); ctx.stroke();
  ctx.fillStyle = "#ffd24a"; ctx.beginPath(); ctx.arc(px, pz, 4, 0, 7); ctx.fill();
  ctx.fillStyle = "#9fb4c8"; ctx.font = "12px ui-monospace,monospace"; ctx.fillText("MAP · explored route · [M] close", 8, W - 8);
}

// --- voxel helpers for goblin movement --------------------------------------
function solidAtWorld(wx, wy, wz) {
  if (!cave) return true;
  const { X, Y, Z } = cave.dims, d = cave.data;
  const vx = Math.floor(wx - off.x), vy = Math.floor(wy - off.y), vz = Math.floor(wz - off.z);
  if (vx < 0 || vx >= X || vy < 0 || vy >= Y || vz < 0 || vz >= Z) return true;
  return isSolid(d[vx + vy * X + vz * X * Y]);
}
function floorYAtWorld(wx, wz, nearY) {
  if (!cave) return nearY;
  const { X, Y, Z } = cave.dims, d = cave.data;
  const vx = Math.floor(wx - off.x), vz = Math.floor(wz - off.z);
  if (vx < 0 || vx >= X || vz < 0 || vz >= Z) return nearY;
  const nearVY = Math.round(nearY - off.y);
  for (let vy = Math.min(Y - 2, nearVY + 3); vy >= 1; vy--)
    if (!isSolid(d[vx + vy * X + vz * X * Y]) && isSolid(d[vx + (vy - 1) * X + vz * X * Y])) return vy + off.y;
  return nearY;
}

// --- goblins: slow (1/4 player), drawn to the FLASHLIGHT beam, attack in it --
function spawnGoblins(n) {
  const { X, Y, Z } = cave.dims, d = cave.data, idx = (x, y, z) => x + y * X + z * X * Y;
  const cands = [];
  for (let z = 2; z < Z - 2; z += 3) for (let x = 2; x < X - 2; x += 3) for (let y = 2; y < Y - 2; y++) {
    if (!isSolid(d[idx(x, y, z)]) && isSolid(d[idx(x, y - 1, z)]) && !isSolid(d[idx(x, y + 1, z)])) {
      if (Math.hypot(x - cave.spawn[0], z - cave.spawn[2]) > 22) cands.push([x, y, z]);
      break;
    }
  }
  for (let i = 0; i < n && cands.length; i++) {
    const c = cands[(i * 7919 + 13) % cands.length];
    const g = new THREE.Group();
    let mixer = null, action = null;
    if (goblinTemplate) {
      const model = cloneSkinned(goblinTemplate);
      model.scale.setScalar(goblinTemplate.userData.fit);
      model.traverse((o) => { if (o.isMesh) { o.frustumCulled = true; o.castShadow = true; } }); // cull off-screen (beauty + shadow passes) → only in-view goblins render/cast
      g.add(model);
      mixer = new THREE.AnimationMixer(model);
      if (goblinClips.length) { action = mixer.clipAction(goblinClips[0]); action.play(); action.paused = true; }
    } else { // capsule fallback
      const body = new THREE.Mesh(new THREE.CapsuleGeometry(0.42, 0.7, 4, 8), new THREE.MeshStandardMaterial({ color: 0x33602e, roughness: 0.85, emissive: 0x0a160a }));
      body.position.y = 0.7; g.add(body);
      const em = new THREE.MeshBasicMaterial({ color: 0xff2a2a });
      const eL = new THREE.Mesh(new THREE.SphereGeometry(0.07, 8, 6), em); eL.position.set(-0.16, 1.05, -0.34);
      const eR = eL.clone(); eR.position.x = 0.16; g.add(eL, eR);
    }
    g.position.set(c[0] + off.x + 0.5, c[1] + off.y, c[2] + off.z + 0.5);
    worldGroup.add(g);
    goblins.push({ g, pos: g.position.clone(), atkT: 0, mixer, action });
  }
}
async function loadGoblin() {
  try {
    const obj = await new FBXLoader().loadAsync("./Walking.fbx");  // skinned goblin + walk animation
    // kill self-illumination so goblins are only visible when lit (lurk in dark)
    obj.traverse((o) => {
      if (!o.isMesh || !o.material) return;
      for (const m of (Array.isArray(o.material) ? o.material : [o.material])) {
        if (m.emissive) m.emissive.setHex(0x000000);
        m.emissiveIntensity = 0; m.emissiveMap = null;
        m.toneMapped = true; m.needsUpdate = true;
      }
    });
    const box = new THREE.Box3().setFromObject(obj);
    const h = box.max.y - box.min.y;
    obj.userData.fit = h > 0 ? 1.9 / h : 0.01;   // scale so it's ~1.9 units tall
    goblinTemplate = obj;
    goblinClips = obj.animations || [];
    console.log("[goblin] loaded, clips:", goblinClips.length, "fit:", obj.userData.fit.toFixed(4));
  } catch (e) { console.warn("[goblin] FBX load failed, using capsule:", e); goblinTemplate = null; }
}
async function loadPlayer() {
  try {
    const obj = await new FBXLoader().loadAsync("./Standard Walk.fbx");  // human character + walk animation
    const box = new THREE.Box3().setFromObject(obj);
    const h = box.max.y - box.min.y;
    obj.userData.fit = h > 0 ? 2.1 / h : 0.01;   // scale to ~player height (2.1 units; shrunk)
    playerTemplate = obj;
    playerClips = obj.animations || [];
    console.log("[player] loaded, clips:", playerClips.length, "fit:", obj.userData.fit.toFixed(4));
  } catch (e) { console.warn("[player] Standard Walk FBX failed, falling back to goblin/capsule:", e); playerTemplate = null; }
}
function inFlashlightView(p) {
  if (!flashOn) return false;
  camera.getWorldDirection(_dir);
  const to = p.clone().sub(camera.position); const dist = to.length();
  if (dist > GOBLIN_DETECT) return false;
  return to.normalize().dot(_dir) > Math.cos(Math.PI / 3.4);
}
function updateGoblins(dt) {
  for (const g of goblins) {
    const heardRun = playerRunning && Math.hypot(pos.x - g.pos.x, pos.z - g.pos.z) < GOBLIN_HEAR;  // hears sprinting
    const aggro = goblinsAngry || heardRun || inFlashlightView(g.pos);   // beam-drawn, noise-drawn, or unleashed

    let moving = false;
    if (aggro) {
      const dx = pos.x - g.pos.x, dz = pos.z - g.pos.z, dist = Math.hypot(dx, dz) || 1;
      if (dist > 1.4) {
        const sp = GOBLIN_SPEED * dt, nx = g.pos.x + (dx / dist) * sp, nz = g.pos.z + (dz / dist) * sp;
        if (!solidAtWorld(nx, g.pos.y + 0.6, nz)) { g.pos.x = nx; g.pos.z = nz; moving = true; }
        else if (!solidAtWorld(nx, g.pos.y + 0.6, g.pos.z)) { g.pos.x = nx; moving = true; }
        else if (!solidAtWorld(g.pos.x, g.pos.y + 0.6, nz)) { g.pos.z = nz; moving = true; }
      } else {
        g.atkT -= dt;
        if (g.atkT <= 0) {
          hp = Math.max(0, hp - GOBLIN_DMG); g.atkT = 1.0; regenAcc = 0;
          hurtT = 0.6; shakeT = 0.45; sfxHit(); updateHearts();   // jolt + sound
          if (hp <= 0) loseGame();
        }
      }
    }
    if (g.action) g.action.paused = !moving;   // walk only while actually moving
    if (g.mixer) g.mixer.update(dt);
    g.pos.y = floorYAtWorld(g.pos.x, g.pos.z, g.pos.y);
    g.g.position.copy(g.pos);
    g.g.lookAt(pos.x, g.pos.y + 1.0, pos.z);
    g.g.rotateY(GOBLIN_FACE);   // model facing offset
  }
}
function loseGame() {
  if (won) return; lost = true; sfxLose(); document.exitPointerLock?.();
  overlay.innerHTML = `<h1 style="color:#ff6a6a">사망</h1><div>어둠 속에서 고블린에게 당했습니다.</div><button onclick="location.reload()">다시 하기</button>`;
  overlay.style.display = "flex";
}
function updateCompass() {
  let target = null;
  if (keysGot >= totalKeys) { target = exitPos; needleEl.style.background = "#4fe06a"; } // green -> exit
  else {
    needleEl.style.background = "#ff3030";
    let bd = Infinity; for (const it of keyItems) { if (it.got) continue; const dd = it.pos.distanceToSquared(pos); if (dd < bd) { bd = dd; target = it.pos; } }
  }
  if (!target) { compassEl.style.opacity = "0.3"; return; }
  compassEl.style.opacity = "1";
  // bearing of the target in the player's local frame: 0 = ahead (needle up), + = right
  const dx = target.x - pos.x, dz = target.z - pos.z;
  const fx = -Math.sin(yaw), fz = -Math.cos(yaw);  // player forward (x,z)
  const rx = Math.cos(yaw), rz = -Math.sin(yaw);   // player right (x,z)
  const bearing = Math.atan2(dx * rx + dz * rz, dx * fx + dz * fz);
  needleEl.style.transform = `rotate(${bearing}rad)`;
}

// --- baked indirect GI: flood glowstone light through open cells (around
// corners), then bake per-vertex onto the cave mesh. Recomputed on placement. -
function setupGI() {
  const { X, Y, Z } = cave.dims, d = cave.data, idx = (x, y, z) => x + y * X + z * X * Y;
  giDimX = Math.ceil(X / GI_CELL); giDimY = Math.ceil(Y / GI_CELL); giDimZ = Math.ceil(Z / GI_CELL);
  const n = giDimX * giDimY * giDimZ;
  giIrr = new Float32Array(n * 3); giOpen = new Uint8Array(n);
  for (let cz = 0; cz < giDimZ; cz++) for (let cy = 0; cy < giDimY; cy++) for (let cx = 0; cx < giDimX; cx++) {
    const x = Math.min(X - 1, cx * GI_CELL + 1), y = Math.min(Y - 1, cy * GI_CELL + 1), z = Math.min(Z - 1, cz * GI_CELL + 1);
    giOpen[cx + cy * giDimX + cz * giDimX * giDimY] = isOpen(d[idx(x, y, z)]) ? 1 : 0;
  }
  buildDDGI();
}
function giCell(wx, wy, wz) {
  const vx = Math.floor(wx - off.x), vy = Math.floor(wy - off.y), vz = Math.floor(wz - off.z);
  const cx = Math.max(0, Math.min(giDimX - 1, (vx / GI_CELL) | 0));
  const cy = Math.max(0, Math.min(giDimY - 1, (vy / GI_CELL) | 0));
  const cz = Math.max(0, Math.min(giDimZ - 1, (vz / GI_CELL) | 0));
  return cx + cy * giDimX + cz * giDimX * giDimY;
}
function buildLavaGI(lavaCells) {   // lava is a STATIC area light: inject warm emission into nearby probes once at build
  if (!giIrr) { giLava = null; return; }
  giLava = new Float32Array(giIrr.length);
  if (!lavaCells || !lavaCells.length) return;
  const W = giDimX, H = giDimY, D = giDimZ;
  const LR = 1.5, LG = 0.5, LB = 0.12;                 // warm lava irradiance
  for (let k = 0; k < lavaCells.length; k++) {
    const [x, y, z] = lavaCells[k], ci = giCell(x + off.x + 0.5, y + off.y + 0.5, z + off.z + 0.5);
    if (giLava[ci * 3] < LR) { giLava[ci * 3] = LR; giLava[ci * 3 + 1] = LG; giLava[ci * 3 + 2] = LB; }
  }
  const nb = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]], decay = 0.6, tmp = new Float32Array(giLava.length);
  for (let it = 0; it < 4; it++) {                     // soft halo: max-decay flood so nearby walls catch the glow
    tmp.set(giLava);
    for (let cz = 0; cz < D; cz++) for (let cy = 0; cy < H; cy++) for (let cx = 0; cx < W; cx++) {
      const ci = cx + cy * W + cz * W * H; if (!giOpen[ci]) continue;
      let r = giLava[ci * 3], g = giLava[ci * 3 + 1], b = giLava[ci * 3 + 2];
      for (let q = 0; q < 6; q++) {
        const nx = cx + nb[q][0], ny = cy + nb[q][1], nz = cz + nb[q][2];
        if (nx < 0 || nx >= W || ny < 0 || ny >= H || nz < 0 || nz >= D) continue;
        const ni = nx + ny * W + nz * W * H; if (!giOpen[ni]) continue;
        const nr = giLava[ni * 3] * decay, ng = giLava[ni * 3 + 1] * decay, nbv = giLava[ni * 3 + 2] * decay;
        if (nr > r) r = nr; if (ng > g) g = ng; if (nbv > b) b = nbv;
      }
      tmp[ci * 3] = r; tmp[ci * 3 + 1] = g; tmp[ci * 3 + 2] = b;
    }
    giLava.set(tmp);
  }
}
// ===== DDGI: probe grid + BVH ray-traced irradiance + temporal accumulation =====
const DDGI_RAYS = 12, DDGI_REFRESH = 14, DDGI_BURST = 56;  // STATIC GI burst: fewer rays + more frame-spread to avoid placement-frame lag spikes
const DDGI_TGT = 55, FLASH_GI = 0.85, FLASH_GI_RANGE = 100; // dynamic flashlight indirect (NOT DDGI — a cheap real-time injection trick)
let ddgiDirs = null, giProbes = null, giCursor = 0, giDirty = 0, giActive = [];  // giActive = probe indices near a glowstone (only these are re-traced)
let giFlash = null, flashWasOn = false;            // per-frame flashlight indirect, added on top of the static glowstone GI
const _rc = new THREE.Raycaster(); _rc.firstHitOnly = true;
const _pO = new THREE.Vector3(), _rd = new THREE.Vector3(), _hn = new THREE.Vector3();
function buildDDGI() {
  ddgiDirs = [];                                    // Fibonacci-sphere ray directions
  const N = DDGI_RAYS, GA = Math.PI * (3 - Math.sqrt(5));
  for (let i = 0; i < N; i++) { const y = 1 - ((i + 0.5) / N) * 2, r = Math.sqrt(Math.max(0, 1 - y * y)), th = GA * i; ddgiDirs.push(new THREE.Vector3(Math.cos(th) * r, y, Math.sin(th) * r)); }
  giProbes = []; const W = giDimX, H = giDimY, D = giDimZ, half = GI_CELL / 2;  // active (in-cave) probe world centers
  for (let cz = 0; cz < D; cz++) for (let cy = 0; cy < H; cy++) for (let cx = 0; cx < W; cx++) {
    const ci = cx + cy * W + cz * W * H; if (!giOpen[ci]) continue;
    giProbes.push(ci, cx * GI_CELL + half + off.x + 0.5, cy * GI_CELL + half + off.y + 0.5, cz * GI_CELL + half + off.z + 0.5);
  }
  giCursor = 0; giActive.length = 0;
  giFlash = new Float32Array(giIrr.length);
  for (let i = 0; i < giIrr.length; i += 3) { giIrr[i] = 0.016; giIrr[i + 1] = 0.02; giIrr[i + 2] = 0.028; } // ambient floor
}
// Flashlight indirect light — NOT DDGI. A real-time trick: 1 raycast to the beam hit, inject light into the nearby probe cells.
function flashGI() {
  if (!giFlash) return;
  giFlash.fill(0);
  if (!flashOn || battery <= 0 || !collider) return;
  camera.getWorldDirection(_dir);
  aimRay.set(camera.position, _dir); aimRay.far = FLASH_GI_RANGE;
  const h = aimRay.intersectObject(collider, false)[0]; if (!h) return;
  const W = giDimX, H = giDimY, ci = giCell(h.point.x, h.point.y, h.point.z);
  const cz = (ci / (W * H)) | 0, rem = ci % (W * H), cy = (rem / W) | 0, cx = rem % W;
  const inject = (c, s) => { if (c < 0 || c >= giOpen.length || !giOpen[c]) return; giFlash[c * 3] += 1.0 * s; giFlash[c * 3 + 1] += 0.95 * s; giFlash[c * 3 + 2] += 0.82 * s; };
  inject(ci, FLASH_GI);                              // hit cell + open 6-neighbors (soft pool)
  if (cx > 0) inject(ci - 1, FLASH_GI * 0.5); if (cx < W - 1) inject(ci + 1, FLASH_GI * 0.5);
  if (cy > 0) inject(ci - W, FLASH_GI * 0.5); if (cy < H - 1) inject(ci + W, FLASH_GI * 0.5);
  if (cz > 0) inject(ci - W * H, FLASH_GI * 0.5); if (cz < giDimZ - 1) inject(ci + W * H, FLASH_GI * 0.5);
}
function occluded(px, py, pz, tx, ty, tz, dist) {   // shadow ray via BVH
  _rd.set(tx - px, ty - py, tz - pz).normalize();
  _pO.set(px, py, pz).addScaledVector(_rd, 0.15);
  _rc.set(_pO, _rd); _rc.far = dist - 0.3;
  return _rc.intersectObject(collider, false).length > 0;
}
const _nearT = []; const _AMB = [0.016, 0.02, 0.028];
function gatherProbe(idx) {                          // STATIC GI: trace rays, gather GLOWSTONE light only (flashlight is a plain direct light)
  const ci = giProbes[idx * 4], px = giProbes[idx * 4 + 1], py = giProbes[idx * 4 + 2], pz = giProbes[idx * 4 + 3], a = 0.5;
  // pre-filter: only glowstones close enough to possibly light this probe — far ones cost 0 rays
  let nT = 0; const R2 = (DDGI_TGT + 62) * (DDGI_TGT + 62);
  for (const tr of torches) { const lp = tr.light.position, dx = lp.x - px, dy = lp.y - py, dz = lp.z - pz; if (dx * dx + dy * dy + dz * dz < R2) _nearT[nT++] = tr; }
  if (nT === 0) {                                    // no glowstone near → just ambient (skip all ray tracing)
    giIrr[ci * 3] += (_AMB[0] - giIrr[ci * 3]) * a; giIrr[ci * 3 + 1] += (_AMB[1] - giIrr[ci * 3 + 1]) * a; giIrr[ci * 3 + 2] += (_AMB[2] - giIrr[ci * 3 + 2]) * a;
    return;
  }
  let ar = _AMB[0], ag = _AMB[1], ab = _AMB[2]; const inv = 1 / DDGI_RAYS;
  for (let k = 0; k < DDGI_RAYS; k++) {
    _pO.set(px, py, pz); _rc.set(_pO, ddgiDirs[k]); _rc.far = 60;
    const h = _rc.intersectObject(collider, false)[0]; if (!h) continue;
    const hp = h.point; _hn.copy(h.face ? h.face.normal : ddgiDirs[k]);
    if (_hn.dot(ddgiDirs[k]) > 0) _hn.negate();      // orient surface normal toward the probe (lit side)
    let r = 0, g = 0, b = 0;
    for (let t = 0; t < nT; t++) {                   // only the near glowstones
      const tr = _nearT[t], lp = tr.light.position, dx = lp.x - hp.x, dy = lp.y - hp.y, dz = lp.z - hp.z, dd = Math.hypot(dx, dy, dz);
      if (dd > DDGI_TGT || dd < 0.05) continue;
      const ndl = Math.max(0, (dx * _hn.x + dy * _hn.y + dz * _hn.z) / dd); if (ndl <= 0) continue;
      if (occluded(hp.x, hp.y, hp.z, lp.x, lp.y, lp.z, dd)) continue;
      const at = 1 - dd / DDGI_TGT, e = at * at * ndl * 1.8;
      r += tr.light.color.r * e; g += tr.light.color.g * e; b += tr.light.color.b * e;
    }
    ar += r * inv; ag += g * inv; ab += b * inv;
  }
  giIrr[ci * 3] += (ar - giIrr[ci * 3]) * a; giIrr[ci * 3 + 1] += (ag - giIrr[ci * 3 + 1]) * a; giIrr[ci * 3 + 2] += (ab - giIrr[ci * 3 + 2]) * a;
}
function rebuildActiveProbes() {                     // only probes within range of SOME glowstone need tracing
  giActive.length = 0; giCursor = 0;
  if (!giProbes) return;
  const count = giProbes.length / 4, R2 = (DDGI_TGT + 62) * (DDGI_TGT + 62);
  for (let i = 0; i < count; i++) {
    const px = giProbes[i * 4 + 1], py = giProbes[i * 4 + 2], pz = giProbes[i * 4 + 3];
    for (const tr of torches) { const lp = tr.light.position, dx = lp.x - px, dy = lp.y - py, dz = lp.z - pz; if (dx * dx + dy * dy + dz * dz < R2) { giActive.push(i); break; } }
  }
}
function ddgiTick() {                                // refresh a slice of ACTIVE probes only (bake happens per-frame)
  if (!giProbes || !collider || !giIrr) return;
  const total = giActive.length; if (!total) return;
  const slice = Math.ceil(total / DDGI_REFRESH);
  for (let s = 0; s < slice; s++) { gatherProbe(giActive[giCursor]); giCursor = (giCursor + 1) % total; }
}
function buildVertCellMap() {   // vertex→probe-cell is static (geometry fixed) → compute once
  if (!caveGeo || !giOpen) return;
  const p = caveGeo.getAttribute("position"), nm = caveGeo.getAttribute("normal"), s = GI_CELL * 0.8;
  giVertCell = new Int32Array(p.count);
  for (let i = 0; i < p.count; i++) {
    // sample the probe just inside the cave (offset along the surface normal) so wall verts read a lit probe
    let ci = giCell(p.getX(i) + nm.getX(i) * s, p.getY(i) + nm.getY(i) * s, p.getZ(i) + nm.getZ(i) * s);
    if (!giOpen[ci]) ci = giCell(p.getX(i), p.getY(i), p.getZ(i));
    giVertCell[i] = ci;
  }
}
function bakeGIToVertices() {   // per-frame: static glowstone GI + dynamic flashlight injection
  if (!caveGeo || !caveAGI || !giIrr || !giVertCell) return;
  const f = giFlash, lv = giLava;
  for (let i = 0; i < giVertCell.length; i++) {
    const ci = giVertCell[i] * 3;
    caveAGI[i * 3] = giIrr[ci] + (f ? f[ci] : 0) + (lv ? lv[ci] : 0); caveAGI[i * 3 + 1] = giIrr[ci + 1] + (f ? f[ci + 1] : 0) + (lv ? lv[ci + 1] : 0); caveAGI[i * 3 + 2] = giIrr[ci + 2] + (f ? f[ci + 2] : 0) + (lv ? lv[ci + 2] : 0);
  }
  caveGeo.getAttribute("aGI").needsUpdate = true;
  if (probeMesh && probeMesh.visible) updateProbeColors();   // keep probe colors live
}
// --- DDGI-style probe grid visualization (P key) ----------------------------
let probeMesh = null; const probeCells = [];
function buildProbeViz() {
  if (!giIrr || !cave) return;
  if (probeMesh) { probeMesh.removeFromParent(); probeMesh.geometry.dispose(); probeMesh.material.dispose(); probeMesh = null; }
  probeCells.length = 0;
  const W = giDimX, H = giDimY, D = giDimZ, half = GI_CELL / 2;
  for (let cz = 0; cz < D; cz++) for (let cy = 0; cy < H; cy++) for (let cx = 0; cx < W; cx++) {
    const ci = cx + cy * W + cz * W * H; if (!giOpen[ci]) continue;          // only active (in-cave) probes
    probeCells.push(ci);
    probeCells.push(cx * GI_CELL + half + off.x + 0.5, cy * GI_CELL + half + off.y + 0.5, cz * GI_CELL + half + off.z + 0.5);
  }
  const count = probeCells.length / 4;
  const geo = new THREE.SphereGeometry(0.28, 8, 6);
  probeMesh = new THREE.InstancedMesh(geo, new THREE.MeshBasicMaterial({ toneMapped: false }), count);
  const m = new THREE.Matrix4();
  for (let i = 0; i < count; i++) { m.makeTranslation(probeCells[i * 4 + 1], probeCells[i * 4 + 2], probeCells[i * 4 + 3]); probeMesh.setMatrixAt(i, m); }
  probeMesh.instanceMatrix.needsUpdate = true; probeMesh.visible = false; probeMesh.renderOrder = 999;
  worldGroup.add(probeMesh);
  updateProbeColors();
}
function updateProbeColors() {
  if (!probeMesh || !giIrr) return;
  const c = new THREE.Color(), count = probeCells.length / 4;
  for (let i = 0; i < count; i++) {
    const ci = probeCells[i * 4], f = giFlash, lv = giLava;
    const r = giIrr[ci * 3] + (f ? f[ci * 3] : 0) + (lv ? lv[ci * 3] : 0), g = giIrr[ci * 3 + 1] + (f ? f[ci * 3 + 1] : 0) + (lv ? lv[ci * 3 + 1] : 0), b = giIrr[ci * 3 + 2] + (f ? f[ci * 3 + 2] : 0) + (lv ? lv[ci * 3 + 2] : 0);
    // unlit probes = faint blue dots so the lattice is visible; lit probes glow warm
    c.setRGB(Math.min(1, 0.06 + r * 1.7), Math.min(1, 0.10 + g * 1.7), Math.min(1, 0.22 + b * 1.6));
    probeMesh.setColorAt(i, c);
  }
  if (probeMesh.instanceColor) probeMesh.instanceColor.needsUpdate = true;
}

// --- sound effects (WebAudio-generated; no asset files) ---------------------
let actx = null;
function initAudio() { try { if (!actx) actx = new (window.AudioContext || window.webkitAudioContext)(); if (actx.state === "suspended") actx.resume(); } catch (_) {} }
function tone(freq, dur, type, gain) {
  if (!actx) return; const o = actx.createOscillator(), g = actx.createGain();
  o.type = type || "sine"; o.frequency.value = freq;
  const t = actx.currentTime; g.gain.setValueAtTime(gain || 0.2, t); g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  o.connect(g).connect(actx.destination); o.start(t); o.stop(t + dur);
}
function noiseBurst(dur, gain) {
  if (!actx) return; const n = (actx.sampleRate * dur) | 0; const buf = actx.createBuffer(1, n, actx.sampleRate); const d = buf.getChannelData(0);
  for (let i = 0; i < n; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / n, 2);
  const s = actx.createBufferSource(); s.buffer = buf; const g = actx.createGain(); g.gain.value = gain || 0.2; s.connect(g).connect(actx.destination); s.start();
}
function sfxHit() { tone(85, 0.2, "square", 0.3); noiseBurst(0.2, 0.25); }
function sfxPickup() { tone(680, 0.12, "sine", 0.25); setTimeout(() => tone(1020, 0.16, "sine", 0.22), 90); }
function sfxTorch() { noiseBurst(0.28, 0.12); tone(210, 0.16, "triangle", 0.12); }
function sfxWin() { [523, 659, 784, 1047].forEach((f, i) => setTimeout(() => tone(f, 0.18, "sine", 0.25), i * 130)); }
function sfxLose() { tone(180, 0.5, "sawtooth", 0.25); tone(90, 0.7, "square", 0.2); }
function sfxStep(loud) { noiseBurst(loud ? 0.07 : 0.05, loud ? 0.17 : 0.05); }   // running = amplified footstep
function sfxHeart() { tone(62, 0.12, "sine", 0.28); setTimeout(() => tone(54, 0.14, "sine", 0.22), 150); }
function sfxGrowl(vol) {                 // Minecraft-zombie-like groan
  if (!actx) return;
  const t = actx.currentTime, dur = 0.75;
  const out = actx.createGain(); out.gain.value = vol; out.connect(actx.destination);
  const lp = actx.createBiquadFilter(); lp.type = "lowpass"; lp.frequency.value = 520; lp.Q.value = 6; lp.connect(out);
  for (const [type, base] of [["sawtooth", 128], ["sine", 131]]) {       // detuned guttural pair
    const o = actx.createOscillator(), g = actx.createGain();
    o.type = type; o.frequency.setValueAtTime(base, t); o.frequency.linearRampToValueAtTime(base * 0.72, t + dur);
    const lfo = actx.createOscillator(), lg = actx.createGain();         // vibrato = moan
    lfo.frequency.value = 6.5; lg.gain.value = 9; lfo.connect(lg).connect(o.frequency); lfo.start(t); lfo.stop(t + dur);
    g.gain.setValueAtTime(0.0001, t); g.gain.linearRampToValueAtTime(1, t + 0.14);
    g.gain.setValueAtTime(1, t + dur * 0.55); g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(g).connect(lp); o.start(t); o.stop(t + dur);
  }
}
// --- background music: generated dark-cave ambient drone (royalty-free) ------
let musicGain = null, musicOn = true;
function startMusic() {
  if (!actx || musicGain) return;
  musicGain = actx.createGain(); musicGain.gain.value = 0.0001; musicGain.connect(actx.destination);
  musicGain.gain.exponentialRampToValueAtTime(0.09, actx.currentTime + 4); // slow fade-in
  const lp = actx.createBiquadFilter(); lp.type = "lowpass"; lp.frequency.value = 360; lp.Q.value = 0.6; lp.connect(musicGain);
  const flfo = actx.createOscillator(), flg = actx.createGain(); flfo.frequency.value = 0.04; flg.gain.value = 140; flfo.connect(flg).connect(lp.frequency); flfo.start();
  for (const f of [55, 73.4, 110]) {                 // low minor-ish drone, detuned
    const o = actx.createOscillator(), g = actx.createGain();
    o.type = "sawtooth"; o.frequency.value = f;
    const vib = actx.createOscillator(), vg = actx.createGain(); vib.frequency.value = 0.06 + Math.random() * 0.05; vg.gain.value = 0.35; vib.connect(vg).connect(o.frequency); vib.start();
    g.gain.value = 0.45; o.connect(g).connect(lp); o.start();
  }
  // sparse eerie high tone every ~10-20s
  (function ping() { if (!musicGain) return; if (musicOn && actx) { const o = actx.createOscillator(), g = actx.createGain(); o.type = "sine"; o.frequency.value = 520 + Math.random() * 300; const t = actx.currentTime; g.gain.setValueAtTime(0.0001, t); g.gain.linearRampToValueAtTime(0.04, t + 0.4); g.gain.exponentialRampToValueAtTime(0.0001, t + 2.4); o.connect(g).connect(musicGain); o.start(t); o.stop(t + 2.5); } setTimeout(ping, 10000 + Math.random() * 12000); })();
}
function toggleMusic() { if (!musicGain) return; musicOn = !musicOn; musicGain.gain.setTargetAtTime(musicOn ? 0.09 : 0.0, actx.currentTime, 0.3); }

// --- boot --------------------------------------------------------------------
(async function boot() {
  hud.textContent = "불러오는 중…";
  await loadGoblin();                 // (Standard Walk 94MB 제거: 웹 로딩 안정화 — 플레이어 그림자는 고블린 메시 재사용)
  buildPlayerBody();                  // shadow caster (goblinTemplate fallback)
  if (TUTORIAL) {                     // tutorial stage
    tutorialMode = true;
    buildWorld(makeTutorialCave(), true);
    updateTut();
    if (started) startIntro();
  } else {                           // straight into the cave
    const res = await fetch("./cave.json", { cache: "no-store" });
    buildWorld(loadCaveFromJSON(await res.json()), false);
  }
})();

window.addEventListener("resize", () => {
  camera.aspect = window.innerWidth / window.innerHeight; camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
});
const clock = new THREE.Clock();
function animate() {
  requestAnimationFrame(animate);
  const dt = Math.min(clock.getDelta(), 0.05), t = clock.elapsedTime;
  if (cave) {
    if (started && !won && !lost) {
      if (flashOn) { battery -= dt; if (battery <= 0) { battery = 0; flashOn = false; flashlight.intensity = 0; } }
      updateBattery();
      updatePlayer(dt);
      if (collider) {                                 // GI: static glowstone DDGI (burst) + dynamic flashlight injection
        let changed = giDirty > 0;
        if (changed) { ddgiTick(); giDirty--; }
        if (flashOn && battery > 0) { flashGI(); changed = true; flashWasOn = true; }
        else if (flashWasOn) { giFlash.fill(0); flashWasOn = false; changed = true; }   // clear once when turned off
        if (changed) bakeGIToVertices();
      }
      updateShadowLight();                          // nearest glowstone = the single shadow caster
      updateGoblins(dt);
      if (hp < HP_MAX) { regenAcc += dt; if (regenAcc >= 30) { regenAcc -= 30; hp = Math.min(HP_MAX, hp + 2); updateHearts(); } } // +1 heart / 30s
      // danger audio: heartbeat when a goblin is near, occasional distant growl
      let nd = Infinity; for (const g of goblins) { const dd = Math.hypot(g.pos.x - pos.x, g.pos.z - pos.z); if (dd < nd) nd = dd; }
      heartT -= dt; if (nd < 12 && heartT <= 0) { sfxHeart(); heartT = 0.45 + (nd / 12) * 0.8; }
      growlT -= dt;
      if (growlT <= 0) { growlT = 4 + Math.random() * 6; if (nd < 24) sfxGrowl(0.28 * (1 - nd / 24)); } // only within range
    } else {
      placeCamera();
    }
    updateGameplay(dt, t);
    updateCompass();
    if (mapOpen) drawMap();
    hurtT = Math.max(0, hurtT - dt); hurtEl.style.opacity = hurtT;
    if (shakeT > 0) { // hit jolt
      shakeT = Math.max(0, shakeT - dt);
      const s = shakeT * 0.5;
      camera.position.x += (Math.random() - 0.5) * s;
      camera.position.y += (Math.random() - 0.5) * s;
      camera.position.z += (Math.random() - 0.5) * s;
    }
  }
  const km = ["KeyW", "KeyA", "KeyS", "KeyD"].map((k) => keys[k] ? k[3] : "·").join("");
  dbg.textContent =
    `lock:${locked ? "ON" : "off"}  drag:${dragging ? "Y" : "n"}  ${lockErr}\n` +
    `keys:${km}  shift:${keys["ShiftLeft"] || keys["ShiftRight"] ? 1 : 0}\n` +
    `mouseΔ:${lastDx},${lastDy}  fps:${(1 / Math.max(dt, 1e-3)).toFixed(0)}`;
  renderer.render(scene, camera);
}
animate();
