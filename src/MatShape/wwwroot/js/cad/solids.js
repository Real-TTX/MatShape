/* MatShape – the geometry of the features beyond extrude and revolve, as plain meshes and polygons (no kernel, no DOM; model.js turns them into solids):
   offset of the faces of a mesh (shell, draft), the profile of a hole, a profile swept along a path (sweep, thread), a loft between profiles, the axis of a
   round face. Points are [x, y, z] in the world (mm). */

import { add, cross, dot, norm, scale, sub } from './topo.js';

// ---- moving faces: every vertex goes where each face around it is offset by its own distance ---------------------------------

/**
 * New vertices for a mesh whose faces move along their normals: distOf(faceNumber, point) -> distance (positive outwards). Per vertex the faces around it
 * (grouped by face number, their normals weighted by area) give planes; the vertex goes to the point that meets them best (least squares, a little damping
 * for faces that are nearly parallel). Exact for flat faces (a box shrinks to a box), close for round ones.
 */
export function offsetVertices(topo, distOf) {
  const { numVert, numTri, tv, fid } = topo;
  const groups = Array.from({ length: numVert }, () => new Map());
  for (let t = 0; t < numTri; t++) {
    const a = topo.P(tv[t * 3]), b = topo.P(tv[t * 3 + 1]), c = topo.P(tv[t * 3 + 2]);
    const n = cross(sub(b, a), sub(c, a));        // length = twice the area
    for (let k = 0; k < 3; k++) {
      const m = groups[tv[t * 3 + k]];
      const g = m.get(fid[t]) || [0, 0, 0];
      m.set(fid[t], add(g, n));
    }
  }
  const out = new Float32Array(numVert * 3);
  for (let v = 0; v < numVert; v++) {
    const p = topo.P(v);
    const A = [[1e-6, 0, 0], [0, 1e-6, 0], [0, 0, 1e-6]], B = [0, 0, 0];
    for (const [face, sum] of groups[v]) {
      const n = norm(sum), s = distOf(face, p);
      for (let i = 0; i < 3; i++) { B[i] += n[i] * s; for (let j = 0; j < 3; j++) A[i][j] += n[i] * n[j]; }
    }
    const d = solve3(A, B) || [0, 0, 0];
    out[v * 3] = p[0] + d[0]; out[v * 3 + 1] = p[1] + d[1]; out[v * 3 + 2] = p[2] + d[2];
  }
  return out;
}

function solve3(M, b) {
  const det = m => m[0][0] * (m[1][1] * m[2][2] - m[1][2] * m[2][1]) - m[0][1] * (m[1][0] * m[2][2] - m[1][2] * m[2][0]) + m[0][2] * (m[1][0] * m[2][1] - m[1][1] * m[2][0]);
  const D = det(M);
  if (Math.abs(D) < 1e-18) return null;
  return [0, 1, 2].map(j => det(M.map((row, i) => row.map((x, k) => (k === j ? b[i] : x)))) / D);
}

// ---- hole -----------------------------------------------------------------------------------------------------------------------

/**
 * The half profile of a hole (radius, height; 0 = the face, negative into the material), counter-clockwise: simple, counterbore or countersink, a drill
 * point at the bottom of a blind hole. spec: { kind, r, depth, through, cbR, cbDepth, csR, csAngle (degrees), tipAngle (degrees) }.
 */
export function holeProfile(spec) {
  const eps = Math.max(0.01, spec.r * 0.02);
  const pts = [[0, eps]];
  if (spec.kind === 'cbore' && spec.cbR > spec.r) pts.push([spec.cbR, eps], [spec.cbR, -spec.cbDepth], [spec.r, -spec.cbDepth]);
  else if (spec.kind === 'csink' && spec.csR > spec.r) {
    const h = (spec.csR - spec.r) / Math.tan((spec.csAngle || 90) * Math.PI / 360);
    pts.push([spec.csR + eps, eps], [spec.csR, 0], [spec.r, -h]);
  } else pts.push([spec.r, eps]);
  pts.push([spec.r, -spec.depth]);
  if (!spec.through && spec.tipAngle > 0 && spec.tipAngle < 180) pts.push([0, -spec.depth - spec.r / Math.tan(spec.tipAngle * Math.PI / 360)]);
  else pts.push([0, -spec.depth]);
  // counter-clockwise for the kernel (x = radius, y = height)
  let a = 0;
  for (let i = 0; i < pts.length; i++) { const p = pts[i], q = pts[(i + 1) % pts.length]; a += p[0] * q[1] - q[0] * p[1]; }
  return a < 0 ? pts.reverse() : pts;
}

// ---- sweeping a profile along a path --------------------------------------------------------------------------------------------

/**
 * The frames along a path (parallel transport: the profile does not twist): [{ p, t, n, b }]. start: a direction the first n should point to (else any).
 */
export function pathFrames(path, startNormal) {
  const n = path.length, out = [];
  const tangent = i => norm(sub(path[Math.min(n - 1, i + 1)], path[Math.max(0, i - 1)]));
  let T = tangent(0);
  let N = startNormal ? sub(startNormal, scale(T, dot(startNormal, T))) : null;
  if (!N || Math.hypot(...N) < 1e-9) N = Math.abs(T[2]) < 0.9 ? cross(T, [0, 0, 1]) : cross(T, [1, 0, 0]);
  N = norm(N);
  for (let i = 0; i < n; i++) {
    const T2 = tangent(i);
    // turn N by the rotation that takes T to T2 (Rodrigues)
    const axis = cross(T, T2), s = Math.hypot(...axis), c = dot(T, T2);
    if (s > 1e-12) {
      const k = scale(axis, 1 / s), ang = Math.atan2(s, c);
      N = add(add(scale(N, Math.cos(ang)), scale(cross(k, N), Math.sin(ang))), scale(k, dot(k, N) * (1 - Math.cos(ang))));
    }
    T = T2;
    N = norm(sub(N, scale(T, dot(N, T))));
    const frame = { p: path[i], t: T, n: N, b: cross(T, N) };
    if (i > 0 && i < n - 1) {
      const din = norm(sub(path[i], path[i - 1])), dout = norm(sub(path[i + 1], path[i])), c = dot(din, dout);
      if (c < 0.99999) { frame.k = norm(sub(dout, din)); frame.s = 1 / Math.cos(Math.acos(Math.max(-1, Math.min(1, c))) / 2); }
    }
    out.push(frame);
  }
  return out;
}

/**
 * A closed solid from loops placed at frames along a path: loops are lists of [a, b, c] (along n, along b, along t of each frame); caps: triangles of the
 * first loop set (indices into the loops flattened) or null (a closed path: no caps). Returns { vertProperties, triVerts, side: [triangle -> loop index] }.
 */
export function sweepMesh(frames, loops, caps, closed = false) {
  const m = loops.reduce((s, l) => s + l.length, 0), S = frames.length;
  const vert = new Float32Array(S * m * 3);
  frames.forEach((f, i) => {
    let k = 0;
    for (const loop of loops) for (const [a, b, c] of loop) {
      let w = add(scale(f.n, a), scale(f.b, b));
      if (f.k) w = add(w, scale(f.k, dot(w, f.k) * (f.s - 1)));
      const p = add(add(f.p, w), scale(f.t, c));
      vert.set(p, (i * m + k) * 3);
      k++;
    }
  });
  const tri = [], side = [];
  const spans = closed ? S : S - 1;
  for (let i = 0; i < spans; i++) {
    const i2 = (i + 1) % S;
    let base = 0;
    loops.forEach((loop, li) => {
      for (let j = 0; j < loop.length; j++) {
        const j2 = (j + 1) % loop.length;
        const A0 = i * m + base + j, A1 = i * m + base + j2, B0 = i2 * m + base + j, B1 = i2 * m + base + j2;
        tri.push(A0, A1, B1, A0, B1, B0);
        side.push(li, li);
      }
      base += loop.length;
    });
  }
  if (!closed && caps) {
    const last = (S - 1) * m;
    for (let k = 0; k < caps.length; k += 3) {
      tri.push(caps[k], caps[k + 2], caps[k + 1]);
      tri.push(last + caps[k], last + caps[k + 1], last + caps[k + 2]);
      side.push(-1, -2);
    }
  }
  // the right way round: positive volume
  if (volumeOf(vert, tri) < 0) for (let k = 0; k < tri.length; k += 3) { const x = tri[k + 1]; tri[k + 1] = tri[k + 2]; tri[k + 2] = x; }
  return { vertProperties: vert, triVerts: Uint32Array.from(tri), side };
}

function volumeOf(v, t) {
  let s = 0;
  for (let i = 0; i < t.length; i += 3) {
    const a = t[i] * 3, b = t[i + 1] * 3, c = t[i + 2] * 3;
    s += v[a] * (v[b + 1] * v[c + 2] - v[b + 2] * v[c + 1]) - v[a + 1] * (v[b] * v[c + 2] - v[b + 2] * v[c]) + v[a + 2] * (v[b] * v[c + 1] - v[b + 1] * v[c]);
  }
  return s / 6;
}

// ---- loft ---------------------------------------------------------------------------------------------------------------------------

/** A closed polyline resampled to n points evenly along its length. */
export function resample(loop, n) {
  const pts = [...loop, loop[0]];
  const lens = [0];
  for (let i = 1; i < pts.length; i++) lens.push(lens[i - 1] + Math.hypot(...sub(pts[i], pts[i - 1])));
  const total = lens[lens.length - 1], out = [];
  let k = 1;
  for (let i = 0; i < n; i++) {
    const s = total * i / n;
    while (k < lens.length - 1 && lens[k] < s) k++;
    const f = (s - lens[k - 1]) / ((lens[k] - lens[k - 1]) || 1);
    out.push(add(pts[k - 1], scale(sub(pts[k], pts[k - 1]), f)));
  }
  return out;
}

/**
 * The rings of a loft: closed loops (3D) resampled alike, turned the same way round and started at the points that fit best (the least twist).
 */
export function loftRings(loops, n) {
  const rings = loops.map(l => resample(l, n));
  const centre = r => scale(r.reduce((s, p) => add(s, p), [0, 0, 0]), 1 / r.length);
  const dir = norm(sub(centre(rings[rings.length - 1]), centre(rings[0])));
  const newell = r => r.reduce((s, p, i) => { const q = r[(i + 1) % r.length]; return add(s, [(p[1] - q[1]) * (p[2] + q[2]), (p[2] - q[2]) * (p[0] + q[0]), (p[0] - q[0]) * (p[1] + q[1])]); }, [0, 0, 0]);
  for (let k = 0; k < rings.length; k++) if (dot(newell(rings[k]), dir) < 0) rings[k].reverse();
  for (let k = 1; k < rings.length; k++) {
    const prev = rings[k - 1], cur = rings[k], c0 = centre(prev), c1 = centre(cur);
    let best = 0, bestD = Infinity;
    for (let s = 0; s < n; s++) {
      let d = 0;
      for (let j = 0; j < n; j += Math.max(1, Math.floor(n / 32))) d += Math.hypot(...sub(sub(cur[(j + s) % n], c1), sub(prev[j], c0)));
      if (d < bestD) { bestD = d; best = s; }
    }
    rings[k] = cur.map((_, j) => cur[(j + best) % n]);
  }
  return rings;
}

// ---- round faces --------------------------------------------------------------------------------------------------------------------

/** The axis of a round (cylindrical) face: { o, a, r, z0, z1, outward } – a point, the direction, the radius, the reach along it, whether the face looks away. */
export function axisOfFace(topo, face) {
  const verts = new Set(), normals = [];
  for (let t = 0; t < topo.numTri; t++) {
    if (topo.fid[t] !== face) continue;
    for (let k = 0; k < 3; k++) verts.add(topo.tv[t * 3 + k]);
    normals.push(topo.normal(t));
  }
  if (normals.length < 3) return null;
  // the direction no normal has: the smallest eigenvector of the sum of n nᵀ
  const M = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
  for (const n of normals) for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) M[i][j] += n[i] * n[j];
  const tr = M[0][0] + M[1][1] + M[2][2];
  let a = [0.3, 0.5, 0.8];
  for (let it = 0; it < 80; it++) {
    const x = [0, 1, 2].map(i => tr * a[i] - (M[i][0] * a[0] + M[i][1] * a[1] + M[i][2] * a[2]));
    a = norm(x);
  }
  const u = norm(Math.abs(a[0]) < 0.9 ? cross(a, [1, 0, 0]) : cross(a, [0, 1, 0])), v = cross(a, u);
  const pts = [...verts].map(i => topo.P(i));
  // the circle through the points seen along the axis (least squares)
  let sx = 0, sy = 0, sxx = 0, syy = 0, sxy = 0, sxz = 0, syz = 0, sz = 0;
  const n = pts.length;
  for (const p of pts) {
    const x = dot(p, u), y = dot(p, v), z = x * x + y * y;
    sx += x; sy += y; sxx += x * x; syy += y * y; sxy += x * y; sxz += x * z; syz += y * z; sz += z;
  }
  const sol = solve3([[sxx, sxy, sx], [sxy, syy, sy], [sx, sy, n]], [sxz, syz, sz]);
  if (!sol) return null;
  const cx = sol[0] / 2, cy = sol[1] / 2, r = Math.sqrt(Math.max(0, sol[2] + cx * cx + cy * cy));
  const along = pts.map(p => dot(p, a));
  const z0 = Math.min(...along), z1 = Math.max(...along);
  const o = add(scale(u, cx), scale(v, cy));
  // does the face look away from the axis (a shaft) or towards it (a hole)?
  let out = 0;
  for (let t = 0, k = 0; t < topo.numTri; t++) {
    if (topo.fid[t] !== face) continue;
    const c = topo.P(topo.tv[t * 3]);
    const radial = sub(sub(c, o), scale(a, dot(sub(c, o), a)));
    out += dot(normals[k++], radial);
  }
  return { o, a, u, v, r, z0, z1, outward: out > 0 };
}

/**
 * The tool that cuts a thread into a round face: a 60° V turned along a helix. axis: axisOfFace(); spec: { pitch, depth, from, to (along the axis), left }.
 * External threads cut from the face inwards, internal ones outwards. Returns a mesh like sweepMesh.
 */
export function threadTool(axis, spec) {
  const { pitch, depth } = spec;
  const steps = 48, turns = (spec.to - spec.from) / pitch;
  const n = Math.max(2, Math.ceil(turns * steps));
  const sign = axis.outward ? -1 : 1, eps = Math.max(0.02, depth * 0.1);
  const half = Math.tan(Math.PI / 6) * (depth + eps);
  // the V in the plane of axis and radius: [radial offset from the face, along the axis]
  const v = [[-sign * eps, -half], [-sign * eps, half], [sign * depth, 0]];
  const frames = [];
  for (let i = 0; i <= n; i++) {
    const ang = (spec.left ? -1 : 1) * 2 * Math.PI * turns * i / n;
    const z = spec.from + (spec.to - spec.from) * i / n;
    const radial = add(scale(axis.u, Math.cos(ang)), scale(axis.v, Math.sin(ang)));
    const p = add(add(axis.o, scale(axis.a, z)), scale(radial, axis.r));
    frames.push({ p, n: radial, b: axis.a, t: cross(radial, axis.a) });
  }
  // a: along the radius, b: along the axis
  return sweepMesh(frames, [v.map(([r, z]) => [r, z, 0])], [0, 1, 2]);
}

/** A closed solid through rings of equal length (a loft): the side between neighbours, the first and the last ring closed by the triangles given. */
export function loftMesh(rings, capFirst, capLast) {
  const m = rings[0].length, S = rings.length;
  const vert = new Float32Array(S * m * 3);
  rings.forEach((r, i) => r.forEach((p, j) => vert.set(p, (i * m + j) * 3)));
  const tri = [], side = [];
  for (let i = 0; i < S - 1; i++) for (let j = 0; j < m; j++) {
    const j2 = (j + 1) % m, A0 = i * m + j, A1 = i * m + j2, B0 = (i + 1) * m + j, B1 = (i + 1) * m + j2;
    tri.push(A0, A1, B1, A0, B1, B0);
    side.push(i, i);
  }
  const last = (S - 1) * m;
  for (let k = 0; k < capFirst.length; k += 3) { tri.push(capFirst[k], capFirst[k + 2], capFirst[k + 1]); side.push(-1); }
  for (let k = 0; k < capLast.length; k += 3) { tri.push(last + capLast[k], last + capLast[k + 1], last + capLast[k + 2]); side.push(-2); }
  if (volumeOf(vert, tri) < 0) for (let k = 0; k < tri.length; k += 3) { const x = tri[k + 1]; tri[k + 1] = tri[k + 2]; tri[k + 2] = x; }
  return { vertProperties: vert, triVerts: Uint32Array.from(tri), side };
}
