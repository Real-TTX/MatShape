/* MatShape – the 3D generation (like Meshy): the mesh that comes back (a GLB, else an STL) becomes a solid the kernel can work with. The model is stood upright (glTF is
   Y-up, MatShape Z-up), scaled to the height asked for, put on the Top plane and centred on the origin; its corners are welded. A closed mesh is taken as it is (shells
   that overlap, like eyes stuck into a head, are united); a mesh with holes or loose flaps – common for generated ones – is rebuilt: voxels by ray parity along the three
   axes (the majority decides, so one hole does not flood a ray), smoothed, a level set of them (Manifold.levelSet), simplified back to a light mesh.
   No DOM here: the editor (meshdialog.js) and the tests in Node use it alike. */

import { packArray, readStl } from './step.js';

// ---- reading ----------------------------------------------------------------------------------------------------------------

const GLB_MAGIC = 0x46546c67, CHUNK_JSON = 0x4e4f534a, CHUNK_BIN = 0x004e4942;
const COMPONENTS = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4, MAT4: 16 };

const multiply = (a, b) => {
  const out = new Array(16);
  for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++) {
    let s = 0;
    for (let k = 0; k < 4; k++) s += a[k * 4 + r] * b[c * 4 + k];
    out[c * 4 + r] = s;
  }
  return out;
};

/** The matrix of a node (column-major): its matrix, or translation · rotation · scale. */
function nodeMatrix(node) {
  if (Array.isArray(node.matrix) && node.matrix.length === 16) return node.matrix.slice();
  const [tx, ty, tz] = node.translation || [0, 0, 0];
  const [x, y, z, w] = node.rotation || [0, 0, 0, 1];
  const [sx, sy, sz] = node.scale || [1, 1, 1];
  return [
    (1 - 2 * (y * y + z * z)) * sx, (2 * (x * y + z * w)) * sx, (2 * (x * z - y * w)) * sx, 0,
    (2 * (x * y - z * w)) * sy, (1 - 2 * (x * x + z * z)) * sy, (2 * (y * z + x * w)) * sy, 0,
    (2 * (x * z + y * w)) * sz, (2 * (y * z - x * w)) * sz, (1 - 2 * (x * x + y * y)) * sz, 0,
    tx, ty, tz, 1,
  ];
}

const det3 = m => m[0] * (m[5] * m[10] - m[9] * m[6]) - m[4] * (m[1] * m[10] - m[9] * m[2]) + m[8] * (m[1] * m[6] - m[5] * m[2]);

/**
 * The triangles of a binary glTF (all meshes of the scene, with the matrices of their nodes) as { positions, indices }. Only triangle lists with float positions;
 * a compressed file (Draco, meshopt) throws 'compressed'.
 */
export function readGlb(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (bytes.byteLength < 20 || view.getUint32(0, true) !== GLB_MAGIC) throw new Error('glb');
  let json = null, bin = null;
  for (let at = 12; at + 8 <= bytes.byteLength;) {
    const length = view.getUint32(at, true), type = view.getUint32(at + 4, true);
    const chunk = bytes.subarray(at + 8, at + 8 + length);
    if (type === CHUNK_JSON) json = JSON.parse(new TextDecoder().decode(chunk));
    else if (type === CHUNK_BIN && !bin) bin = chunk;
    at += 8 + length + ((4 - (length % 4)) % 4);
  }
  if (!json) throw new Error('glb');
  const required = json.extensionsRequired || [];
  if (required.some(e => /draco|meshopt|quantiz/i.test(e))) throw new Error('compressed');

  const accessor = index => {
    const a = json.accessors?.[index];
    if (!a || a.bufferView === undefined || !bin) return null;
    const bv = json.bufferViews[a.bufferView];
    const comps = COMPONENTS[a.type] || 1;
    const size = { 5120: 1, 5121: 1, 5122: 2, 5123: 2, 5125: 4, 5126: 4 }[a.componentType];
    const stride = bv.byteStride || comps * size;
    const base = (bv.byteOffset || 0) + (a.byteOffset || 0);
    const dv = new DataView(bin.buffer, bin.byteOffset, bin.byteLength);
    const read = { 5120: o => dv.getInt8(o), 5121: o => dv.getUint8(o), 5122: o => dv.getInt16(o, true), 5123: o => dv.getUint16(o, true), 5125: o => dv.getUint32(o, true), 5126: o => dv.getFloat32(o, true) }[a.componentType];
    if (!read) return null;
    const out = new Float64Array(a.count * comps);
    for (let i = 0; i < a.count; i++) for (let c = 0; c < comps; c++) out[i * comps + c] = read(base + i * stride + c * size);
    return out;
  };

  const positions = [], indices = [];
  const addMesh = (meshIndex, matrix) => {
    const mesh = json.meshes?.[meshIndex];
    if (!mesh) return;
    const flip = det3(matrix) < 0;
    for (const prim of mesh.primitives || []) {
      if ((prim.mode ?? 4) !== 4 || prim.attributes?.POSITION === undefined) continue;
      const pos = accessor(prim.attributes.POSITION);
      if (!pos) continue;
      const first = positions.length / 3, count = pos.length / 3;
      for (let i = 0; i < count; i++) {
        const x = pos[i * 3], y = pos[i * 3 + 1], z = pos[i * 3 + 2];
        positions.push(matrix[0] * x + matrix[4] * y + matrix[8] * z + matrix[12], matrix[1] * x + matrix[5] * y + matrix[9] * z + matrix[13], matrix[2] * x + matrix[6] * y + matrix[10] * z + matrix[14]);
      }
      const idx = prim.indices !== undefined ? accessor(prim.indices) : Float64Array.from({ length: count }, (_, i) => i);
      if (!idx) continue;
      for (let t = 0; t + 2 < idx.length; t += 3) {
        if (flip) indices.push(first + idx[t], first + idx[t + 2], first + idx[t + 1]);
        else indices.push(first + idx[t], first + idx[t + 1], first + idx[t + 2]);
      }
    }
  };
  const identity = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
  const scene = json.scenes?.[json.scene ?? 0];
  if (scene?.nodes?.length) {
    const visit = (index, parent, depth) => {
      const node = json.nodes?.[index];
      if (!node || depth > 64) return;
      const matrix = multiply(parent, nodeMatrix(node));
      if (node.mesh !== undefined) addMesh(node.mesh, matrix);
      for (const child of node.children || []) visit(child, matrix, depth + 1);
    };
    for (const n of scene.nodes) visit(n, identity, 0);
  } else {
    (json.meshes || []).forEach((_, i) => addMesh(i, identity));
  }
  if (!indices.length) throw new Error('empty');
  return { positions: Float64Array.from(positions), indices: Uint32Array.from(indices) };
}

/** The mesh of a file of the generation: 'glb' or 'stl'. */
export function readMesh(bytes, format) {
  if (format === 'stl') {
    const stl = readStl(bytes);
    if (!stl.indices.length) throw new Error('empty');
    return { positions: Float64Array.from(stl.positions), indices: stl.indices };
  }
  return readGlb(bytes);
}

// ---- placing ----------------------------------------------------------------------------------------------------------------

/**
 * The mesh stood upright (Y-up -> Z-up: a turn of 90° about X), scaled to `height` (mm) and stood on the Top plane, centred on the origin in X and Y.
 * yaw (degrees) turns it about Z afterwards (the front of a figure looks to -Y, at the Front view).
 */
export function place(positions, { height, yaw = 0, up = 'y' } = {}) {
  const n = positions.length / 3, out = new Float64Array(positions.length);
  const c = Math.cos(yaw * Math.PI / 180), s = Math.sin(yaw * Math.PI / 180);
  const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < n; i++) {
    let x = positions[i * 3], y = positions[i * 3 + 1], z = positions[i * 3 + 2];
    if (up === 'y') [y, z] = [-z, y];
    [x, y] = [c * x - s * y, s * x + c * y];
    out[i * 3] = x; out[i * 3 + 1] = y; out[i * 3 + 2] = z;
    for (let k = 0; k < 3; k++) { const v = out[i * 3 + k]; if (v < min[k]) min[k] = v; if (v > max[k]) max[k] = v; }
  }
  const tall = max[2] - min[2];
  if (!(tall > 0)) throw new Error('flat');
  const k = (height > 0 ? height : tall) / tall;
  const cx = (min[0] + max[0]) / 2, cy = (min[1] + max[1]) / 2;
  for (let i = 0; i < n; i++) {
    out[i * 3] = (out[i * 3] - cx) * k;
    out[i * 3 + 1] = (out[i * 3 + 1] - cy) * k;
    out[i * 3 + 2] = (out[i * 3 + 2] - min[2]) * k;
  }
  return out;
}

/** Corners at the same place become one (a GLB splits them at the seams of its texture); triangles that lost a corner go. */
export function weld(positions, indices) {
  const map = new Map(), remap = new Uint32Array(positions.length / 3), out = [];
  for (let i = 0; i < remap.length; i++) {
    const key = `${Math.fround(positions[i * 3])},${Math.fround(positions[i * 3 + 1])},${Math.fround(positions[i * 3 + 2])}`;
    let v = map.get(key);
    if (v === undefined) { v = out.length / 3; map.set(key, v); out.push(positions[i * 3], positions[i * 3 + 1], positions[i * 3 + 2]); }
    remap[i] = v;
  }
  const tris = [];
  const seen = new Set();
  for (let t = 0; t + 2 < indices.length; t += 3) {
    const a = remap[indices[t]], b = remap[indices[t + 1]], c = remap[indices[t + 2]];
    if (a === b || b === c || a === c) continue;
    // the same triangle twice (a doubled shell) goes, once
    const key = [a, b, c].sort((p, q) => p - q).join(',');
    if (seen.has(key)) continue;
    seen.add(key);
    tris.push(a, b, c);
  }
  return { positions: Float64Array.from(out), indices: Uint32Array.from(tris) };
}

// ---- rebuilding ---------------------------------------------------------------------------------------------------------------

/**
 * The inside of a mesh with holes as voxels: per axis a grid of rays, the crossings of each ray with the triangles sorted, the cells between an odd and an even
 * crossing are inside; a cell is inside when two of the three axes say so. Returns { inside: Uint8Array, dims, origin, h }.
 */
export function voxelize(positions, indices, cells = 150) {
  const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < positions.length; i += 3) for (let k = 0; k < 3; k++) { const v = positions[i + k]; if (v < min[k]) min[k] = v; if (v > max[k]) max[k] = v; }
  const h = Math.max(max[0] - min[0], max[1] - min[1], max[2] - min[2]) / cells;
  const pad = 2;
  const origin = min.map(v => v - pad * h);
  const dims = min.map((v, k) => Math.ceil((max[k] - v) / h) + 2 * pad);
  const [nx, ny] = dims;
  const votes = new Uint8Array(dims[0] * dims[1] * dims[2]);
  const strides = [1, nx, nx * ny];
  const tri = indices.length / 3;

  for (let axis = 0; axis < 3; axis++) {
    const u = axis === 0 ? 1 : 0, v = axis === 2 ? 1 : 2;
    const nu = dims[u], nv = dims[v], na = dims[axis];
    // a ray through the middle of each cell, a little off so that it does not run along the edges of triangles
    const ju = 0.0137 * h, jv = 0.0071 * h;
    const rayU = i => origin[u] + (i + 0.5) * h + ju, rayV = j => origin[v] + (j + 0.5) * h + jv;
    // the triangles per ray (compressed lists: counts, then the indices)
    const count = new Uint32Array(nu * nv + 1);
    const range = (lo, hi, o, n) => [Math.max(0, Math.floor((lo - o) / h - 0.5)), Math.min(n - 1, Math.ceil((hi - o) / h - 0.5))];
    const spans = new Int32Array(tri * 4);
    for (let t = 0; t < tri; t++) {
      let ulo = Infinity, uhi = -Infinity, vlo = Infinity, vhi = -Infinity;
      for (let c = 0; c < 3; c++) {
        const p = indices[t * 3 + c] * 3;
        ulo = Math.min(ulo, positions[p + u]); uhi = Math.max(uhi, positions[p + u]);
        vlo = Math.min(vlo, positions[p + v]); vhi = Math.max(vhi, positions[p + v]);
      }
      const [i0, i1] = range(ulo, uhi, origin[u], nu), [j0, j1] = range(vlo, vhi, origin[v], nv);
      spans.set([i0, i1, j0, j1], t * 4);
      for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) count[j * nu + i + 1]++;
    }
    for (let k = 1; k < count.length; k++) count[k] += count[k - 1];
    const list = new Uint32Array(count[count.length - 1]), fill = count.slice(0, -1);
    for (let t = 0; t < tri; t++) {
      const [i0, i1, j0, j1] = spans.subarray(t * 4, t * 4 + 4);
      for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) list[fill[j * nu + i]++] = t;
    }
    const hits = [];
    for (let j = 0; j < nv; j++) {
      const pv = rayV(j);
      for (let i = 0; i < nu; i++) {
        const pu = rayU(i);
        hits.length = 0;
        for (let s = count[j * nu + i]; s < count[j * nu + i + 1]; s++) {
          const t = list[s], a = indices[t * 3] * 3, b = indices[t * 3 + 1] * 3, c = indices[t * 3 + 2] * 3;
          const au = positions[a + u] - pu, av = positions[a + v] - pv, bu = positions[b + u] - pu, bv = positions[b + v] - pv, cu = positions[c + u] - pu, cv = positions[c + v] - pv;
          const w0 = bu * cv - bv * cu, w1 = cu * av - cv * au, w2 = au * bv - av * bu;
          if (!((w0 >= 0 && w1 >= 0 && w2 >= 0) || (w0 <= 0 && w1 <= 0 && w2 <= 0))) continue;
          const sum = w0 + w1 + w2;
          if (Math.abs(sum) < 1e-18) continue;
          hits.push((w0 * positions[a + axis] + w1 * positions[b + axis] + w2 * positions[c + axis]) / sum);
        }
        if (hits.length < 2) continue;
        hits.sort((p, q) => p - q);
        let next = 0, inside = false;
        const base = i * strides[u] + j * strides[v], step = strides[axis];
        for (let k = 0; k < na; k++) {
          const centre = origin[axis] + (k + 0.5) * h;
          while (next < hits.length && hits[next] < centre) { inside = !inside; next++; }
          if (next >= hits.length && !inside) break;
          if (inside) votes[base + k * step]++;
        }
      }
    }
  }
  const inside = new Uint8Array(votes.length);
  for (let i = 0; i < votes.length; i++) inside[i] = votes[i] >= 2 ? 1 : 0;
  return { inside, dims, origin, h };
}

/** The voxels as a smooth solid: the cells blurred (3 × 3 × 3), a level set at one half (trilinear between the cell middles), simplified. */
export function voxelSolid(kernel, { inside, dims, origin, h }) {
  const [nx, ny, nz] = dims;
  const at = (x, y, z) => (z * ny + y) * nx + x;
  const field = new Float32Array(inside.length);
  for (let z = 0; z < nz; z++) for (let y = 0; y < ny; y++) for (let x = 0; x < nx; x++) {
    let s = 0, n = 0;
    for (let dz = -1; dz <= 1; dz++) for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
      const X = x + dx, Y = y + dy, Z = z + dz;
      n++;
      if (X >= 0 && Y >= 0 && Z >= 0 && X < nx && Y < ny && Z < nz) s += inside[at(X, Y, Z)];
    }
    field[at(x, y, z)] = s / n;
  }
  const sample = p => {
    const fx = (p[0] - origin[0]) / h - 0.5, fy = (p[1] - origin[1]) / h - 0.5, fz = (p[2] - origin[2]) / h - 0.5;
    const x0 = Math.floor(fx), y0 = Math.floor(fy), z0 = Math.floor(fz);
    const tx = fx - x0, ty = fy - y0, tz = fz - z0;
    const f = (x, y, z) => (x < 0 || y < 0 || z < 0 || x >= nx || y >= ny || z >= nz ? 0 : field[at(x, y, z)]);
    const c00 = f(x0, y0, z0) * (1 - tx) + f(x0 + 1, y0, z0) * tx, c10 = f(x0, y0 + 1, z0) * (1 - tx) + f(x0 + 1, y0 + 1, z0) * tx;
    const c01 = f(x0, y0, z0 + 1) * (1 - tx) + f(x0 + 1, y0, z0 + 1) * tx, c11 = f(x0, y0 + 1, z0 + 1) * (1 - tx) + f(x0 + 1, y0 + 1, z0 + 1) * tx;
    return ((c00 * (1 - ty) + c10 * ty) * (1 - tz) + (c01 * (1 - ty) + c11 * ty) * tz) - 0.5;
  };
  const bounds = { min: origin.slice(), max: origin.map((o, k) => o + dims[k] * h) };
  const raw = kernel.Manifold.levelSet(sample, bounds, h);
  try {
    return raw.simplify(h * 0.1);
  } finally {
    raw.delete();
  }
}

/** A closed mesh as a manifold of the kernel (overlapping shells united), or null when the kernel does not take it. */
function closedSolid(kernel, positions, indices) {
  const { Manifold, Mesh } = kernel;
  const mesh = new Mesh({ numProp: 3, vertProperties: Float32Array.from(positions), triVerts: indices });
  mesh.merge();
  let m;
  try { m = new Manifold(mesh); } catch { return null; }
  if (m.status() !== 'NoError' || m.isEmpty() || !(m.volume() > 0)) { m.delete(); return null; }
  const parts = m.decompose();
  if (parts.length < 2) { parts.forEach(p => p.delete()); return m; }
  m.delete();
  const united = Manifold.union(parts);
  parts.forEach(p => p.delete());
  return united;
}

/**
 * The mesh of a generation as a solid: { positions: Float32Array, indices: Uint32Array, triangles, rebuilt, size: [x, y, z] } in mm, standing on the Top plane.
 * options: height (mm), yaw (degrees), cells (voxels along the longest side when it has to be rebuilt), rebuild: true = always through voxels.
 */
export function toSolid(kernel, mesh, { height = 50, yaw = 0, cells = 150, rebuild = false } = {}) {
  const placed = place(mesh.positions, { height, yaw });
  const welded = weld(placed, mesh.indices);
  // a closed surface is taken as it is (the kernel's merge also closes seams where corners lie at the same place); everything else is rebuilt
  let solid = rebuild ? null : closedSolid(kernel, welded.positions, welded.indices), rebuilt = false;
  if (!solid) {
    solid = voxelSolid(kernel, voxelize(welded.positions, welded.indices, cells));
    rebuilt = true;
  }
  try {
    if (solid.isEmpty()) throw new Error('empty');
    const out = solid.getMesh();
    const box = solid.boundingBox();
    // the solid stands on the Top plane again (the voxels or the union may have moved its foot a little)
    const lift = -box.min[2];
    const np = out.numProp, count = out.vertProperties.length / np;
    const positions = new Float32Array(count * 3);
    for (let i = 0; i < count; i++) {
      positions[i * 3] = out.vertProperties[i * np];
      positions[i * 3 + 1] = out.vertProperties[i * np + 1];
      positions[i * 3 + 2] = out.vertProperties[i * np + 2] + lift;
    }
    return {
      positions,
      indices: Uint32Array.from(out.triVerts),
      triangles: out.triVerts.length / 3,
      rebuilt,
      size: [box.max[0] - box.min[0], box.max[1] - box.min[1], box.max[2] - box.min[2]],
      volume: solid.volume(),
    };
  } finally {
    solid.delete();
  }
}

/**
 * The faces of an organic mesh: regions between creases (neighbouring triangles that bend more than `angle` degrees), small regions (the noise of a generated or rebuilt
 * surface) joined to the neighbour they share the most edges with. Int32Array, one face per triangle; the view draws edges only between faces, so a figure shows its
 * real creases (an ear on a head) and no scratches.
 */
export function faceGroups(positions, indices, { angle = 40, minShare = 0.002, minSize = 24 } = {}) {
  const tri = indices.length / 3, numVert = positions.length / 3;
  const normal = new Float64Array(tri * 3);
  for (let t = 0; t < tri; t++) {
    const a = indices[t * 3] * 3, b = indices[t * 3 + 1] * 3, c = indices[t * 3 + 2] * 3;
    const ux = positions[b] - positions[a], uy = positions[b + 1] - positions[a + 1], uz = positions[b + 2] - positions[a + 2];
    const vx = positions[c] - positions[a], vy = positions[c + 1] - positions[a + 1], vz = positions[c + 2] - positions[a + 2];
    const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx, l = Math.hypot(nx, ny, nz) || 1;
    normal[t * 3] = nx / l; normal[t * 3 + 1] = ny / l; normal[t * 3 + 2] = nz / l;
  }
  // the neighbours across each edge
  const edge = new Map(), next = new Int32Array(tri * 3).fill(-1);
  for (let t = 0; t < tri; t++) for (let k = 0; k < 3; k++) {
    const a = indices[t * 3 + k], b = indices[t * 3 + (k + 1) % 3], key = Math.min(a, b) * numVert + Math.max(a, b);
    const other = edge.get(key);
    if (other === undefined) edge.set(key, t * 3 + k);
    else { next[t * 3 + k] = Math.floor(other / 3); next[other] = t; }
  }
  const limit = Math.cos(angle * Math.PI / 180);
  const dot = (s, t) => normal[s * 3] * normal[t * 3] + normal[s * 3 + 1] * normal[t * 3 + 1] + normal[s * 3 + 2] * normal[t * 3 + 2];
  const group = new Int32Array(tri).fill(-1);
  let groups = 0;
  for (let s = 0; s < tri; s++) {
    if (group[s] >= 0) continue;
    group[s] = groups;
    const stack = [s];
    while (stack.length) {
      const t = stack.pop();
      for (let k = 0; k < 3; k++) {
        const u = next[t * 3 + k];
        if (u < 0 || group[u] >= 0 || dot(t, u) < limit) continue;
        group[u] = groups;
        stack.push(u);
      }
    }
    groups++;
  }
  // small regions join the neighbour they share the most edges with (a few rounds: a speck inside a speck)
  const small = Math.max(minSize, Math.round(minShare * tri));
  for (let round = 0; round < 4; round++) {
    const size = new Int32Array(groups);
    for (let t = 0; t < tri; t++) size[group[t]]++;
    const shared = new Map();
    for (let t = 0; t < tri; t++) {
      const g = group[t];
      if (size[g] >= small) continue;
      for (let k = 0; k < 3; k++) {
        const u = next[t * 3 + k];
        if (u < 0 || group[u] === g) continue;
        const m = shared.get(g) || new Map();
        m.set(group[u], (m.get(group[u]) || 0) + 1);
        shared.set(g, m);
      }
    }
    if (!shared.size) break;
    const into = new Map([...shared].map(([g, m]) => [g, [...m].sort((p, q) => q[1] - p[1] || size[q[0]] - size[p[0]])[0][0]]));
    for (let t = 0; t < tri; t++) if (into.has(group[t])) group[t] = into.get(group[t]);
  }
  // numbered from 0 again
  const ids = new Map();
  return Int32Array.from(group, g => { if (!ids.has(g)) ids.set(g, ids.size); return ids.get(g); });
}

/**
 * The feature "import" of a generated solid: one body with its faces (kept as they are, even when it is one: a smooth figure has no edges to draw). dx, dy move it
 * (next to the parts that are there already).
 */
export function meshFeature({ id, name, file, positions, indices, rebuilt = false, dx = 0, dy = 0 }) {
  const faces = faceGroups(positions, indices, { angle: rebuilt ? 55 : 40 });
  let p = positions;
  if (dx || dy) {
    p = Float32Array.from(positions);
    for (let i = 0; i < p.length; i += 3) { p[i] += dx; p[i + 1] += dy; }
  }
  const label = String(name || 'Mesh').slice(0, 120);
  return { id, type: 'import', name: label, params: { file, bodies: [{ name: label, p: packArray(p), i: packArray(indices), f: packArray(faces), kept: true }] } };
}
