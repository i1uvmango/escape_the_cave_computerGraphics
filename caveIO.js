// caveIO.js
// Serialize / deserialize a cave object. The voxel `data` (Uint8Array) is
// stored as base64 — never as a giant JSON number array.

// --- base64 <-> Uint8Array (browser-safe, chunked) -------------------------
export function uint8ToBase64(u8) {
  let s = "";
  const chunk = 0x8000; // avoid arg-count limits on fromCharCode
  for (let i = 0; i < u8.length; i += chunk) {
    s += String.fromCharCode.apply(null, u8.subarray(i, i + chunk));
  }
  // Node fallback if btoa is unavailable.
  if (typeof btoa === "function") return btoa(s);
  return Buffer.from(s, "binary").toString("base64");
}

export function base64ToUint8(b64) {
  if (typeof atob === "function") {
    const s = atob(b64);
    const u8 = new Uint8Array(s.length);
    for (let i = 0; i < s.length; i++) u8[i] = s.charCodeAt(i);
    return u8;
  }
  return new Uint8Array(Buffer.from(b64, "base64"));
}

/**
 * Build the plain JSON object for a cave (data as base64). No DOM side effects.
 */
export function caveToJSONObject(cave) {
  return {
    version: 2,
    dims: cave.dims,
    seed: cave.seed,
    playerHeight: cave.playerHeight,
    solidPct: cave.solidPct,
    connectedCount: cave.connectedCount,
    walkableCount: cave.walkableCount,
    largestRoom: cave.largestRoom,
    palette: cave.palette,
    entrance: cave.entrance,
    exit: cave.exit,
    keys: cave.keys,
    spawn: cave.spawn,
    lavaPools: cave.lavaPools,
    dataBase64: uint8ToBase64(cave.data),
    // baked SDF for the downstream GI raymarch (optional)
    sdfRange: cave.sdfRange,
    sdfBase64: cave.sdf ? uint8ToBase64(cave.sdf) : undefined,
  };
}

/**
 * exportCaveToJSON(cave): build JSON + trigger a browser download of cave.json.
 * Returns the JSON string (also usable in non-DOM contexts).
 */
export function exportCaveToJSON(cave, filename = "cave.json") {
  const obj = caveToJSONObject(cave);
  const json = JSON.stringify(obj);

  if (typeof document !== "undefined") {
    const blob = new Blob([json], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }
  return json;
}

/**
 * loadCaveFromJSON(json): accept a parsed object or JSON string, restore the
 * Uint8Array from base64, and return a cave object identical in shape to
 * generateCave()'s output.
 */
export function loadCaveFromJSON(json) {
  const o = typeof json === "string" ? JSON.parse(json) : json;
  return {
    dims: o.dims,
    data: base64ToUint8(o.dataBase64),
    palette: o.palette,
    entrance: o.entrance,
    exit: o.exit,
    keys: o.keys,
    spawn: o.spawn,
    lavaPools: o.lavaPools || [],
    connectedCount: o.connectedCount,
    walkableCount: o.walkableCount,
    largestRoom: o.largestRoom,
    solidPct: o.solidPct,
    seed: o.seed,
    playerHeight: o.playerHeight ?? 3,
    sdf: o.sdfBase64 ? base64ToUint8(o.sdfBase64) : undefined,
    sdfRange: o.sdfRange,
  };
}
