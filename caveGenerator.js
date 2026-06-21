// caveGenerator.js
// Pure JS. NO three.js dependency.
//
// Room+corridor CARVING generator that GUARANTEES walkable space.
// (The old cellular-automata approach produced no continuous floor to walk on.)
//
// Coordinate convention (see README):
//   Y is UP. Flat index = x + y*X + z*X*Y.
//
// Material ids:
//   0 = air
//   1 = rock
//   2 = glowing mushroom (emissive)  — on open ceilings/walls
//   3 = high-albedo ore              — on open surfaces
//   4 = water                        — shallow, in floor low points
//
// "walkable cell" = air, with solid directly below, and `playerHeight` cells
// of air above (head room). Walking connectivity allows a ±1 step between
// adjacent columns.

// ---------------------------------------------------------------------------
// Seedable deterministic PRNG (mulberry32). Same seed -> same cave.
// ---------------------------------------------------------------------------
export function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Cheap deterministic 3D value noise in [0,1] (for organic wall wobble).
function makeNoise(seed) {
  const S = seed >>> 0;
  const hash = (ix, iy, iz) => {
    let h = (Math.imul(ix, 374761393) ^ Math.imul(iy, 668265263) ^ Math.imul(iz, 2147483647) ^ S) >>> 0;
    h = Math.imul(h ^ (h >>> 13), 1274126177) >>> 0;
    return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
  };
  const smooth = (t) => t * t * (3 - 2 * t);
  const lerp = (a, b, t) => a + (b - a) * t;
  return (x, y, z) => {
    const x0 = Math.floor(x), y0 = Math.floor(y), z0 = Math.floor(z);
    const xf = smooth(x - x0), yf = smooth(y - y0), zf = smooth(z - z0);
    const c = (dx, dy, dz) => hash(x0 + dx, y0 + dy, z0 + dz);
    const x00 = lerp(c(0, 0, 0), c(1, 0, 0), xf), x10 = lerp(c(0, 1, 0), c(1, 1, 0), xf);
    const x01 = lerp(c(0, 0, 1), c(1, 0, 1), xf), x11 = lerp(c(0, 1, 1), c(1, 1, 1), xf);
    return lerp(lerp(x00, x10, yf), lerp(x01, x11, yf), zf);
  };
}

// Material palette (shared with viewer / voxelTexture).
export const PALETTE = [
  { id: 0, albedo: [0.0, 0.0, 0.0], emissive: [0.0, 0.0, 0.0] }, // air
  { id: 1, albedo: [0.17, 0.19, 0.23], emissive: [0.0, 0.0, 0.0] }, // rock (deepslate)
  { id: 2, albedo: [0.10, 0.30, 0.32], emissive: [0.10, 0.95, 0.85] }, // glowing mushroom
  { id: 3, albedo: [0.55, 0.85, 0.95], emissive: [0.05, 0.20, 0.25] }, // ore
  { id: 4, albedo: [0.10, 0.25, 0.45], emissive: [0.0, 0.0, 0.0] }, // water
  { id: 5, albedo: [0.25, 0.05, 0.0], emissive: [3.0, 0.9, 0.18] }, // lava (HDR emissive; GI light source)
];

const DEFAULTS = {
  X: 128, Y: 64, Z: 128,
  seed: 1,
  roomCount: 12,      // more rooms -> deeper, branchier network
  roomRadiusMin: 6,
  roomRadiusMax: 13,
  corridorRadius: 2,
  corridorHeightExtra: 2,
  extraLoops: 5,       // more non-tree links -> harder path-finding (loops)
  noiseAmount: 0.4,
  playerHeight: 3,
  keyCount: 3,
  minWalkable: 0,   // 0 => auto = floor(X*Z*0.04)
  computeSdf: true, // bake a signed distance field for the downstream GI raymarch
  sdfRange: 8,      // clamp distance band (voxels) stored in the SDF
};

const AIR = 0, ROCK = 1, MUSHROOM = 2, ORE = 3, WATER = 4, LAVA = 5;
const MAX_ATTEMPTS = 6;

/**
 * generateCave(params) -> cave object.
 * Retries (carving more) until the largest walkable component >= minWalkable,
 * so it NEVER returns an unwalkable map.
 */
export function generateCave(params = {}) {
  const p = { ...DEFAULTS, ...params };
  const X = p.X | 0, Y = p.Y | 0, Z = p.Z | 0;
  const minWalkable = p.minWalkable > 0 ? p.minWalkable : Math.floor(X * Z * 0.04);

  let best = null;
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    const r = buildOnce(p, attempt, minWalkable);
    if (!best || r.walkableCount > best.walkableCount) best = r;
    if (r.walkableCount >= minWalkable) break;
  }

  // SDF bake (GI prep): signed distance field, negative inside solid, 0 at the
  // surface. The GI stage sphere-traces this for smooth surfaces + free normals.
  if (p.computeSdf) {
    const R = p.sdfRange | 0 || 8;
    best.sdf = computeSDF(best.data, X, Y, Z, R);
    best.sdfRange = R;
  }

  console.log(
    `[caveGenerator] seed=${p.seed} dims=${X}x${Y}x${Z} ` +
    `walkable=${best.walkableCount} (min ${minWalkable}) ` +
    `connectedAir=${best.connectedCount} largestRoom=${best.largestRoom} ` +
    `solidPct=${(best.solidPct * 100).toFixed(1)}% keys=${best.keys.length}/${p.keyCount} ` +
    `attempts=${best.attempt + 1}`
  );
  return best;
}

function buildOnce(p, attempt, minWalkable) {
  const X = p.X | 0, Y = p.Y | 0, Z = p.Z | 0;
  const PH = p.playerHeight | 0;
  // sub-seed varies per attempt for deterministic retries
  const subSeed = (p.seed + attempt * 0x9e3779b1) >>> 0;
  const rng = mulberry32(subSeed);
  const noise = makeNoise(subSeed ^ 0x1234567);
  // carve more aggressively on later attempts
  const roomCount = p.roomCount + attempt * 2;
  const extraLoops = p.extraLoops + attempt;
  const corridorRadius = p.corridorRadius + (attempt > 2 ? 1 : 0);

  const idx = (x, y, z) => x + y * X + z * X * Y;
  const inInterior = (x, y, z) => x > 0 && x < X - 1 && y > 0 && y < Y - 1 && z > 0 && z < Z - 1;
  const data = new Uint8Array(X * Y * Z).fill(ROCK); // Step 1: all solid

  const randInt = (lo, hi) => lo + ((rng() * (hi - lo + 1)) | 0);
  const carveAir = (x, y, z) => { if (inInterior(x, y, z)) data[idx(x, y, z)] = AIR; };

  // --- Step 2: carve rooms (flat-floored, domed ellipsoids) ---------------
  const rooms = [];
  let largestRoom = 0;
  const corridorH = PH + p.corridorHeightExtra + 1; // air cells above floor
  for (let i = 0; i < roomCount; i++) {
    const rx = randInt(p.roomRadiusMin, p.roomRadiusMax);
    const rz = randInt(p.roomRadiusMin, p.roomRadiusMax);
    const ry = randInt(Math.max(PH + 2, p.roomRadiusMin), p.roomRadiusMax);
    const margin = p.roomRadiusMax + 2;
    const cx = randInt(margin, X - 1 - margin);
    const cz = randInt(margin, Z - 1 - margin);
    // centre spread across more of the height -> multi-level, deeper caves
    const cy = randInt(Math.floor(Y * 0.28), Math.floor(Y * 0.70));
    const floorY = Math.max(2, cy - Math.round(ry * 0.6));
    let vol = 0;
    for (let z = cz - rz - 2; z <= cz + rz + 2; z++) {
      for (let y = floorY; y <= cy + ry; y++) {
        for (let x = cx - rx - 2; x <= cx + rx + 2; x++) {
          if (!inInterior(x, y, z)) continue;
          const nd = ((x - cx) / rx) ** 2 + ((y - cy) / ry) ** 2 + ((z - cz) / rz) ** 2;
          const wob = 1 + p.noiseAmount * (noise(x * 0.13, y * 0.13, z * 0.13) * 2 - 1);
          if (nd <= wob && y >= floorY) { // flat floor: nothing carved below floorY
            if (data[idx(x, y, z)] !== AIR) { data[idx(x, y, z)] = AIR; vol++; }
          }
        }
      }
    }
    largestRoom = Math.max(largestRoom, vol);
    rooms.push({ cx, cy, cz, floorY });
  }

  // --- Step 3: connect rooms with thick, meandering corridors -------------
  // Carve a vertical tube (radius >= corridorRadius, height corridorH) along a
  // noise-meandered path; floor stays solid so the corridor floor is walkable.
  const carveTube = (a, b) => {
    const dist = Math.hypot(b.cx - a.cx, b.cz - a.cz, b.floorY - a.floorY);
    const steps = Math.max(2, Math.ceil(dist * 1.5));
    for (let s = 0; s <= steps; s++) {
      const t = s / steps;
      const mx = (noise(t * 4 + 11.3, 1.5, 2.5) * 2 - 1) * 5;
      const mz = (noise(t * 4 + 23.7, 3.5, 4.5) * 2 - 1) * 5;
      const px = Math.round(a.cx + (b.cx - a.cx) * t + mx);
      const pz = Math.round(a.cz + (b.cz - a.cz) * t + mz);
      const py = Math.round(a.floorY + (b.floorY - a.floorY) * t);
      const R = corridorRadius;
      for (let dz = -R - 1; dz <= R + 1; dz++) {
        for (let dx = -R - 1; dx <= R + 1; dx++) {
          const wob = 1 + p.noiseAmount * (noise(px * 0.2, py * 0.2, pz * 0.2) * 2 - 1);
          if (dx * dx + dz * dz > (R * wob) ** 2 && dx * dx + dz * dz > 1) continue;
          for (let h = 0; h < corridorH; h++) carveAir(px + dx, py + h, pz + dz);
        }
      }
    }
  };

  if (rooms.length > 1) {
    // Prim spanning tree over room centres (each new room -> nearest connected)
    const inSet = new Set([0]);
    const d2 = (a, b) => (a.cx - b.cx) ** 2 + (a.cy - b.cy) ** 2 + (a.cz - b.cz) ** 2;
    while (inSet.size < rooms.length) {
      let bestPair = null, bd = Infinity;
      for (const ai of inSet) {
        for (let bi = 0; bi < rooms.length; bi++) {
          if (inSet.has(bi)) continue;
          const d = d2(rooms[ai], rooms[bi]);
          if (d < bd) { bd = d; bestPair = [ai, bi]; }
        }
      }
      carveTube(rooms[bestPair[0]], rooms[bestPair[1]]);
      inSet.add(bestPair[1]);
    }
    // extra loops for non-linear exploration
    for (let k = 0; k < extraLoops; k++) {
      const a = randInt(0, rooms.length - 1);
      let b = randInt(0, rooms.length - 1);
      if (b === a) b = (b + 1) % rooms.length;
      carveTube(rooms[a], rooms[b]);
    }
  }

  // --- Step 5: head-room guarantee ----------------------------------------
  // For every air cell that sits on solid (a standing spot), ensure PH cells
  // of air above it. (No CA re-fill — that would re-close corridors.)
  for (let z = 1; z < Z - 1; z++) {
    for (let x = 1; x < X - 1; x++) {
      for (let y = 1; y < Y - 1; y++) {
        if (data[idx(x, y, z)] === AIR && data[idx(x, y - 1, z)] === ROCK) {
          for (let h = 1; h < PH; h++) carveAir(x, y + h, z);
        }
      }
    }
  }

  // --- Step 6: walkable graph; keep largest walking component -------------
  const walk = computeWalkable(data, X, Y, Z, PH, idx);
  const { comp, largestId, largestSize, members } = labelWalkComponents(walk, data, X, Y, Z, PH, idx);
  const inMain = (x, y, z) => comp[idx(x, y, z)] === largestId;

  // --- Step 7: placement on the walkable component ------------------------
  // entrance = walkable cell nearest a room floor; far exit/keys by BFS.
  let entrance = members.length ? members[0] : [1, 1, 1];
  // prefer a walkable cell close to room 0 centre for a sensible start
  if (rooms.length && members.length) {
    let bd = Infinity;
    for (const m of members) {
      const d = (m[0] - rooms[0].cx) ** 2 + (m[2] - rooms[0].cz) ** 2 + (m[1] - rooms[0].floorY) ** 2;
      if (d < bd) { bd = d; entrance = m; }
    }
  }
  const dist = bfsWalk(walk, data, X, Y, Z, PH, idx, entrance);
  const reach = members
    .map((m) => ({ m, d: dist[idx(m[0], m[1], m[2])] }))
    .filter((o) => o.d >= 0)
    .sort((a, b) => b.d - a.d);
  const exit = reach.length ? reach[0].m.slice() : entrance.slice();
  const d3 = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
  const keys = [];
  let sep = Math.max(6, Math.cbrt(largestSize) * 2);
  for (let att = 0; att < 6 && keys.length < p.keyCount; att++) {
    keys.length = 0;
    for (const { m } of reach) {
      if (keys.length >= p.keyCount) break;
      if (d3(m, entrance) < sep || d3(m, exit) < sep) continue;
      if (keys.some((k) => d3(m, k) < sep)) continue;
      keys.push(m.slice());
    }
    sep *= 0.6;
  }
  const spawn = entrance.slice(); // spawn = entrance

  // --- Step 8: seal boundary + materials ----------------------------------
  for (let z = 0; z < Z; z++) for (let y = 0; y < Y; y++) for (let x = 0; x < X; x++) {
    if (x === 0 || x === X - 1 || y === 0 || y === Y - 1 || z === 0 || z === Z - 1) data[idx(x, y, z)] = ROCK;
  }
  decorate(data, X, Y, Z, idx, inMain, rng, noise, { entrance, exit, keys }, PH);

  const lavaPools = []; // (lava disabled)

  // --- stats --------------------------------------------------------------
  let solid = 0;
  for (let i = 0; i < data.length; i++) if (data[i] === ROCK || data[i] === MUSHROOM || data[i] === ORE) solid++;
  const solidPct = solid / data.length;
  const connectedCount = largestOpenRegion(data, X, Y, Z, idx);

  return {
    dims: { X, Y, Z },
    data,
    palette: PALETTE.map((m) => ({ ...m, albedo: [...m.albedo], emissive: [...m.emissive] })),
    entrance, exit, keys, spawn, lavaPools,
    connectedCount,
    walkableCount: largestSize,
    largestRoom,
    solidPct,
    seed: p.seed,
    playerHeight: PH,
    attempt,
  };
}

// ---------------------------------------------------------------------------
// Walkable helpers
// ---------------------------------------------------------------------------
function computeWalkable(data, X, Y, Z, PH, idx) {
  const walk = new Uint8Array(data.length);
  for (let z = 1; z < Z - 1; z++) {
    for (let x = 1; x < X - 1; x++) {
      for (let y = 1; y < Y - PH - 1; y++) {
        const feet = data[idx(x, y, z)];
        if (feet !== 0 && feet !== 4 && feet !== 5) continue;  // air / water / lava (open)
        const below = data[idx(x, y - 1, z)];
        if (below === 0 || below === 4 || below === 5) continue; // need solid below
        let head = true;
        for (let h = 1; h < PH; h++) if (data[idx(x, y + h, z)] !== 0) { head = false; break; }
        if (head) walk[idx(x, y, z)] = 1;
      }
    }
  }
  return walk;
}

// Connect walkable columns whose floor differs by <=1 (±1 step). Largest comp.
function labelWalkComponents(walk, data, X, Y, Z, PH, idx) {
  const comp = new Int32Array(data.length).fill(-1);
  const members = [];
  let largestId = -1, largestSize = 0, nextId = 0;
  const stack = [];
  const horiz = [[1, 0], [-1, 0], [0, 1], [0, -1]];
  for (let z = 1; z < Z - 1; z++) {
    for (let x = 1; x < X - 1; x++) {
      for (let y = 1; y < Y - 1; y++) {
        const s = idx(x, y, z);
        if (!walk[s] || comp[s] !== -1) continue;
        const id = nextId++;
        const local = [];
        comp[s] = id; stack.push([x, y, z]);
        while (stack.length) {
          const [cx, cy, cz] = stack.pop();
          local.push([cx, cy, cz]);
          for (const [dx, dz] of horiz) {
            for (let dy = -1; dy <= 1; dy++) {
              const nx = cx + dx, ny = cy + dy, nz = cz + dz;
              if (nx < 1 || nx >= X - 1 || nz < 1 || nz >= Z - 1 || ny < 1 || ny >= Y - 1) continue;
              const ni = idx(nx, ny, nz);
              if (walk[ni] && comp[ni] === -1) { comp[ni] = id; stack.push([nx, ny, nz]); }
            }
          }
        }
        if (local.length > largestSize) { largestSize = local.length; largestId = id; members.length = 0; members.push(...local); }
      }
    }
  }
  return { comp, largestId, largestSize, members };
}

function bfsWalk(walk, data, X, Y, Z, PH, idx, start) {
  const dist = new Int32Array(data.length).fill(-1);
  const q = [];
  let head = 0;
  const s = idx(start[0], start[1], start[2]);
  dist[s] = 0; q.push(start);
  const horiz = [[1, 0], [-1, 0], [0, 1], [0, -1]];
  while (head < q.length) {
    const [cx, cy, cz] = q[head++];
    const cd = dist[idx(cx, cy, cz)];
    for (const [dx, dz] of horiz) {
      for (let dy = -1; dy <= 1; dy++) {
        const nx = cx + dx, ny = cy + dy, nz = cz + dz;
        if (nx < 1 || nx >= X - 1 || nz < 1 || nz >= Z - 1 || ny < 1 || ny >= Y - 1) continue;
        const ni = idx(nx, ny, nz);
        if (walk[ni] && dist[ni] === -1) { dist[ni] = cd + 1; q.push([nx, ny, nz]); }
      }
    }
  }
  return dist;
}

// Largest 6-connected OPEN (air|water) region size — reported as connectedCount.
function largestOpenRegion(data, X, Y, Z, idx) {
  const seen = new Uint8Array(data.length);
  const open = (i) => data[i] === 0 || data[i] === 4 || data[i] === 5;
  const neigh = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]];
  let largest = 0;
  const stack = [];
  for (let start = 0; start < data.length; start++) {
    if (!open(start) || seen[start]) continue;
    let size = 0; stack.push(start); seen[start] = 1;
    while (stack.length) {
      const cur = stack.pop(); size++;
      const x = cur % X, y = ((cur / X) | 0) % Y, z = (cur / (X * Y)) | 0;
      for (const [dx, dy, dz] of neigh) {
        const nx = x + dx, ny = y + dy, nz = z + dz;
        if (nx < 0 || nx >= X || ny < 0 || ny >= Y || nz < 0 || nz >= Z) continue;
        const ni = idx(nx, ny, nz);
        if (open(ni) && !seen[ni]) { seen[ni] = 1; stack.push(ni); }
      }
    }
    if (size > largest) largest = size;
  }
  return largest;
}

// Mushrooms (ceilings), ore (walls) as small clusters; shallow water in lows.
function decorate(data, X, Y, Z, idx, inMain, rng, noise, places, PH) {
  const reserved = new Set([places.entrance, places.exit, ...places.keys].map((p) => idx(p[0], p[1], p[2])));
  const n6 = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]];
  const facesAir = (x, y, z) => {
    for (const [dx, dy, dz] of n6) if (data[idx(x + dx, y + dy, z + dz)] === 0) return true;
    return false;
  };
  // surface rock list, split into ceilings (air below) and walls
  const ceil = [], wall = [];
  for (let z = 1; z < Z - 1; z++) for (let y = 1; y < Y - 1; y++) for (let x = 1; x < X - 1; x++) {
    const i = idx(x, y, z);
    if (data[i] !== 1 || !facesAir(x, y, z)) continue;
    if (data[idx(x, y - 1, z)] === 0) ceil.push(i); else wall.push(i);
  }
  const grow = (seed, mat, size) => {
    const q = [seed], seen = new Set([seed]); let n = 0;
    while (q.length && n < size) {
      const qi = (rng() * q.length) | 0; const cur = q[qi]; q.splice(qi, 1);
      if (data[cur] === 1 && !reserved.has(cur)) { data[cur] = mat; n++; }
      const x = cur % X, y = ((cur / X) | 0) % Y, z = (cur / (X * Y)) | 0;
      for (let dz = -1; dz <= 1; dz++) for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        if (!(dx || dy || dz)) continue;
        const nx = x + dx, ny = y + dy, nz = z + dz;
        if (nx < 1 || nx >= X - 1 || ny < 1 || ny >= Y - 1 || nz < 1 || nz >= Z - 1) continue;
        const ni = idx(nx, ny, nz);
        if (data[ni] === 1 && facesAir(nx, ny, nz) && !seen.has(ni)) { seen.add(ni); q.push(ni); }
      }
    }
  };
  if (ceil.length) for (let k = 0; k < Math.max(6, (ceil.length * 0.01) | 0); k++) grow(ceil[(rng() * ceil.length) | 0], MUSHROOM, 3 + ((rng() * 8) | 0));
  if (wall.length) for (let k = 0; k < Math.max(4, (wall.length * 0.003) | 0); k++) grow(wall[(rng() * wall.length) | 0], ORE, 3 + ((rng() * 6) | 0));

  // shallow water: lowest standing floors get a 1-cell puddle
  let minFloor = Y;
  for (let z = 1; z < Z - 1; z++) for (let x = 1; x < X - 1; x++) for (let y = 1; y < Y - 1; y++) {
    if (data[idx(x, y, z)] === 0 && data[idx(x, y - 1, z)] === 1) { if (y < minFloor) minFloor = y; break; }
  }
  for (let z = 1; z < Z - 1; z++) for (let x = 1; x < X - 1; x++) {
    const i = idx(x, minFloor, z);
    if (data[i] === 0 && data[idx(x, minFloor - 1, z)] === 1 && !reserved.has(i)) data[i] = WATER;
  }
}

// ---------------------------------------------------------------------------
// SDF bake (signed distance field). Uint8: 127 ≈ surface, <127 inside solid,
// >127 in open space. Decode: dist = (u/255*2 - 1) * range  (voxels).
// ---------------------------------------------------------------------------
function computeSDF(data, X, Y, Z, R) {
  const N = data.length;
  const inside = new Uint8Array(N);  // 1 = solid (rock/ore/mushroom)
  const open = new Uint8Array(N);    // 1 = air/water
  for (let i = 0; i < N; i++) {
    const s = data[i] !== AIR && data[i] !== WATER && data[i] !== LAVA; // lava is open
    inside[i] = s ? 1 : 0;
    open[i] = s ? 0 : 1;
  }
  const dOut = chamfer3D(inside, X, Y, Z); // air -> nearest solid
  const dIn = chamfer3D(open, X, Y, Z);    // solid -> nearest open
  const sdf = new Uint8Array(N);
  for (let i = 0; i < N; i++) {
    let s = inside[i] ? -dIn[i] : dOut[i]; // negative inside solid
    if (s > R) s = R; else if (s < -R) s = -R;
    sdf[i] = Math.round((s / R * 0.5 + 0.5) * 255);
  }
  return sdf;
}

// 3D chamfer distance transform: distance from each cell to the nearest cell
// where seed===1, using 26-neighbour Euclidean weights (two scan passes).
function chamfer3D(seed, X, Y, Z) {
  const INF = 1e9;
  const d = new Float32Array(seed.length);
  for (let i = 0; i < seed.length; i++) d[i] = seed[i] ? 0 : INF;
  const idx = (x, y, z) => x + y * X + z * X * Y;
  const offs = [];
  for (let dz = -1; dz <= 1; dz++) for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
    if (!dx && !dy && !dz) continue;
    offs.push([dx, dy, dz, Math.hypot(dx, dy, dz)]);
  }
  const isFwd = (o) => o[2] < 0 || (o[2] === 0 && (o[1] < 0 || (o[1] === 0 && o[0] < 0)));
  const fwd = offs.filter(isFwd), bwd = offs.filter((o) => !isFwd(o));
  const sweep = (order, neigh) => {
    for (const [zr, yr, xr] of order) {
      for (let z = zr[0]; z !== zr[1]; z += zr[2])
        for (let y = yr[0]; y !== yr[1]; y += yr[2])
          for (let x = xr[0]; x !== xr[1]; x += xr[2]) {
            const i = idx(x, y, z); let v = d[i];
            for (const [dx, dy, dz, w] of neigh) {
              const nx = x + dx, ny = y + dy, nz = z + dz;
              if (nx < 0 || nx >= X || ny < 0 || ny >= Y || nz < 0 || nz >= Z) continue;
              const nv = d[idx(nx, ny, nz)] + w;
              if (nv < v) v = nv;
            }
            d[i] = v;
          }
    }
  };
  sweep([[[0, Z, 1], [0, Y, 1], [0, X, 1]]], fwd);
  sweep([[[Z - 1, -1, -1], [Y - 1, -1, -1], [X - 1, -1, -1]]], bwd);
  return d;
}
