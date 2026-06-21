// voxelTexture.js
// Build a GPU-ready 3D voxel texture + palette texture from a cave object.
//
// Downstream note: this voxel grid is later raymarched in a fragment shader
// for primary visibility + DDGI rays (pure voxel). Therefore the 3D texture
// MUST be NearestFilter / no mipmaps / ClampToEdge, and the CPU Uint8Array
// (cave.data) is always kept alongside it.

import * as THREE from "three";

/**
 * buildVoxelTexture(cave) -> { voxelTex, paletteTex }
 *   voxelTex   : THREE.Data3DTexture  (RedFormat, UnsignedByte, material ids)
 *   paletteTex : THREE.DataTexture    (256x1 RGBA, albedo.rgb + emissive in a)
 */
export function buildVoxelTexture(cave) {
  const { X, Y, Z } = cave.dims;

  // --- 3D voxel texture (raw material ids) ---------------------------------
  const voxelTex = new THREE.Data3DTexture(cave.data, X, Y, Z);
  voxelTex.format = THREE.RedFormat;
  voxelTex.type = THREE.UnsignedByteType;
  voxelTex.minFilter = THREE.NearestFilter;
  voxelTex.magFilter = THREE.NearestFilter;
  voxelTex.wrapS = THREE.ClampToEdgeWrapping;
  voxelTex.wrapT = THREE.ClampToEdgeWrapping;
  voxelTex.wrapR = THREE.ClampToEdgeWrapping;
  voxelTex.generateMipmaps = false;
  voxelTex.unpackAlignment = 1; // single-byte rows, no 4-byte padding
  voxelTex.needsUpdate = true;

  // --- palette texture (256x1 RGBA) ----------------------------------------
  // rgb = albedo (0..255). a = peak emissive component (0..255), so downstream
  // shading can read "is this material emissive and how much".
  const pal = new Uint8Array(256 * 4); // zero-filled
  for (const m of cave.palette) {
    const i = (m.id & 0xff) * 4;
    pal[i + 0] = clamp255(m.albedo[0] * 255);
    pal[i + 1] = clamp255(m.albedo[1] * 255);
    pal[i + 2] = clamp255(m.albedo[2] * 255);
    const e = Math.max(m.emissive[0], m.emissive[1], m.emissive[2]);
    pal[i + 3] = clamp255(e * 255);
  }
  const paletteTex = new THREE.DataTexture(pal, 256, 1, THREE.RGBAFormat, THREE.UnsignedByteType);
  paletteTex.minFilter = THREE.NearestFilter;
  paletteTex.magFilter = THREE.NearestFilter;
  paletteTex.wrapS = THREE.ClampToEdgeWrapping;
  paletteTex.wrapT = THREE.ClampToEdgeWrapping;
  paletteTex.generateMipmaps = false;
  paletteTex.unpackAlignment = 1;
  paletteTex.needsUpdate = true;

  return { voxelTex, paletteTex };
}

function clamp255(v) {
  v = Math.round(v);
  return v < 0 ? 0 : v > 255 ? 255 : v;
}

/**
 * buildSdfTexture(cave) -> THREE.Data3DTexture | null
 * The baked signed distance field for the GI raymarch. Unlike the material-id
 * texture this uses LINEAR filtering so the downstream sphere-tracer gets a
 * smooth, interpolated surface (and free gradient normals). Decode in-shader:
 *   dist = (texel * 2.0 - 1.0) * sdfRange;   // voxels, negative inside solid
 */
export function buildSdfTexture(cave) {
  if (!cave.sdf) return null;
  const { X, Y, Z } = cave.dims;
  const tex = new THREE.Data3DTexture(cave.sdf, X, Y, Z);
  tex.format = THREE.RedFormat;
  tex.type = THREE.UnsignedByteType;
  tex.minFilter = THREE.LinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.wrapS = THREE.ClampToEdgeWrapping;
  tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.wrapR = THREE.ClampToEdgeWrapping;
  tex.generateMipmaps = false;
  tex.unpackAlignment = 1;
  tex.needsUpdate = true;
  return tex;
}
