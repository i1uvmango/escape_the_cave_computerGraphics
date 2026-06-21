// gen.mjs — (re)generate the committed cave.json (THE map).
// Run: node gen.mjs
import { generateCave } from "./caveGenerator.js";
import { caveToJSONObject } from "./caveIO.js";
import { writeFileSync } from "node:fs";

// Default params -> a guaranteed-walkable room+corridor cave.
const cave = generateCave({
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
});

const json = JSON.stringify(caveToJSONObject(cave));
writeFileSync("cave.json", json);
console.log("[gen] wrote cave.json", json.length, "bytes");
