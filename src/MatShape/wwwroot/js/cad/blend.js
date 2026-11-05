/* MatShape – fillets and chamfers of edges (the kernel is a mesh kernel, so the rounding is built, not computed on a boundary representation):
   along every chain of chosen edges a "tool" is swept: its cross-section is the corner between the two faces minus the circle that touches both (fillet) or the triangle
   cut off by the chamfer. On an outer (convex) edge the tool is cut away, on an inner (concave) edge it is added. Where chained edges turn, the cross-sections meet in the
   mitre plane (the rim of a cylinder, the four top edges of a box); where three rounded edges meet in a corner, a ball corner is cut as well.
   No DOM, no kernel: the tools come back as plain meshes (model.js turns them into solids). */

import { chains, add, cross, dot, norm, scale, sub } from './topo.js';

const STEP = 5 * Math.PI / 180;      // like the circles of the sketches
const MIN_ANGLE = 0.05;              // edges flatter than ~3° (tangent edges) cannot be rounded

/**
 * The tools for the chosen edges of one part.
 * topo: topology(mesh) of the part; edges: the chosen edges (items of topo.edges); spec: { kind: 'fillet', r } or { kind: 'chamfer', d1, d2, firstFace(numL, numR) -> true when L takes d1 }.
 * Returns { cut: [mesh], add: [mesh], corners: [{ hull: [points], centre, r }] }; a mesh is { vertProperties, triVerts, faceID } with face numbers 1 (the new face) or 2 (the rest).
 */
export function blendTools(topo, edges, spec) {
  const usable = edges.filter(e => e.angle > MIN_ANGLE);
  const frames = new Map();
  const frameOf = (e, forward) => {
    const k = (forward ? '+' : '-') + e.a + ':' + e.b;
    if (!frames.has(k)) frames.set(k, segmentFrame(topo, e, forward));
    return frames.get(k);
  };
  // chains end where the kind of edge changes (outer / inner) or where they turn back on themselves
  const split = (e1, e2, v) => {
    const f1 = frameOf(e1, e1.b === v), f2 = frameOf(e2, e2.a === v);
    return f1.convex !== f2.convex || dot(f1.d, f2.d) < -0.3;
  };
  // a fillet or chamfer wider than the faces next to the edge cannot be made
  const reach = faceReach(topo);
  const size = spec.kind === 'fillet' ? null : Math.max(spec.d1, spec.d2);
  for (const e of usable) {
    const fr = frameOf(e, true);
    const need = size ?? spec.r / Math.tan(fr.theta / 2);
    const P = topo.P(e.a);
    if (need > reach(topo.fid[fr.L], P, fr.uL) + 1e-6 || need > reach(topo.fid[fr.R], P, fr.uR) + 1e-6) return { tooLarge: true, cut: [], add: [], corners: [] };
  }
  const out = { cut: [], add: [], corners: [] };
  for (const chain of chains(usable, split)) {
    const mesh = sweep(topo, chain, frameOf, spec);
    if (!mesh) continue;
    (mesh.convex ? out.cut : out.add).push(mesh);
  }
  if (spec.kind === 'fillet') out.corners = ballCorners(topo, usable, spec.r, frameOf);
  return out;
}

/** How far a face reaches from a point in a direction (the largest projection of its corners): reach(face number, point, direction). */
function faceReach(topo) {
  let verts = null;
  return (face, p, u) => {
    if (!verts) {
      verts = new Map();
      for (let t = 0; t < topo.numTri; t++) {
        const f = topo.fid[t];
        if (!verts.has(f)) verts.set(f, new Set());
        for (let c = 0; c < 3; c++) verts.get(f).add(topo.tv[t * 3 + c]);
      }
    }
    let best = 0;
    for (const v of verts.get(face) || []) best = Math.max(best, dot(sub(topo.P(v), p), u));
    return best;
  };
}

/** The directions at an edge going from p to q: d along it, nL/nR the normals of the faces on its left and right, uL/uR the directions into these faces, perpendicular to d. */
function segmentFrame(topo, e, forward) {
  const p = topo.P(forward ? e.a : e.b), q = topo.P(forward ? e.b : e.a);
  const d = norm(sub(q, p));
  const L = forward ? e.L : e.R, R = forward ? e.R : e.L;
  const nL = topo.normal(L), nR = topo.normal(R);
  const uL = norm(cross(nL, d)), uR = norm(cross(d, nR));
  return { p, q, d, L, R, nL, nR, uL, uR, convex: dot(nL, uR) < 0, theta: Math.acos(Math.max(-1, Math.min(1, dot(uL, uR)))) };
}

/** The cross-section of the tool at an edge, as offsets from the point of the edge, and which of its sides is the new face. */
function profile(fr, spec, steps, firstL) {
  const { uL, uR, nL, nR, convex, theta } = fr;
  const outL = convex ? nL : scale(nL, -1), outR = convex ? nR : scale(nR, -1);
  const size = spec.kind === 'fillet' ? spec.r : Math.max(spec.d1, spec.d2);
  const eps = Math.max(1e-3, size * 0.02);
  const pts = [scale(add(outL, outR), eps)];
  if (spec.kind === 'fillet') {
    const t = spec.r / Math.tan(theta / 2), h = spec.r / Math.sin(theta / 2);
    const O = scale(norm(add(uL, uR)), h);
    const TL = scale(uL, t), TR = scale(uR, t);
    pts.push(add(TL, scale(outL, eps)));
    const a = sub(TL, O), b = sub(TR, O);
    const phi = Math.acos(Math.max(-1, Math.min(1, dot(a, b) / (spec.r * spec.r))));
    for (let j = 0; j <= steps; j++) {
      const s = j / steps;
      const k1 = phi > 1e-9 ? Math.sin((1 - s) * phi) / Math.sin(phi) : 1 - s, k2 = phi > 1e-9 ? Math.sin(s * phi) / Math.sin(phi) : s;
      pts.push(add(O, add(scale(a, k1), scale(b, k2))));
    }
    pts.push(add(TR, scale(outR, eps)));
    return { pts, face: k => k >= 2 && k < 2 + steps };
  }
  const dL = firstL ? spec.d1 : spec.d2, dR = firstL ? spec.d2 : spec.d1;
  const TL = scale(uL, dL), TR = scale(uR, dR);
  pts.push(add(TL, scale(outL, eps)), TL, TR, add(TR, scale(outR, eps)));
  return { pts, face: k => k === 2 };
}

/** The tool of one chain: the cross-section swept along it (mitred where it turns), closed at open ends. */
function sweep(topo, chain, frameOf, spec) {
  const segs = chain.edges.map(({ edge, forward }) => frameOf(edge, forward));
  if (!segs.length) return null;
  const convex = segs[0].convex;
  // a fillet: as many steps on the arc as the widest corner of the chain needs
  const steps = spec.kind === 'fillet' ? Math.max(2, ...segs.map(s => Math.ceil((Math.PI - s.theta) / STEP))) : 0;
  const first = s => (spec.firstFace ? spec.firstFace(topo.fid[s.L], topo.fid[s.R]) : true);
  const profiles = segs.map(s => profile(s, spec, steps, first(s)));
  const m = profiles[0].pts.length;
  const n = chain.verts.length;
  const rings = [];
  for (let i = 0; i < n; i++) {
    const P = topo.P(chain.verts[i]);
    const before = chain.closed ? (i - 1 + segs.length) % segs.length : i - 1, after = i < segs.length ? i : -1;
    if (before < 0 || after < 0) {
      const s = after >= 0 ? after : before;
      rings.push(profiles[s].pts.map(o => add(P, o)));
      continue;
    }
    // the mitre plane halves the turn; both cross-sections are carried along their edge onto it and averaged
    const d0 = segs[before].d, d1 = segs[after].d, mtr = norm(add(d0, d1));
    const onto = (o, d) => { const k = dot(o, mtr) / (dot(d, mtr) || 1e-9); return sub(o, scale(d, k)); };
    rings.push(profiles[before].pts.map((o, k) => add(P, scale(add(onto(o, d0), onto(profiles[after].pts[k], d1)), 0.5))));
  }
  const vert = [], tri = [], ids = [];
  rings.forEach(r => r.forEach(p => vert.push(p[0], p[1], p[2])));
  const id = (i, k) => i * m + k;
  const ringCount = rings.length, spans = chain.closed ? ringCount : ringCount - 1;
  const face = profiles[0].face;
  // which way the cross-section runs about the edge decides the order of the corners of the triangles (outside = counter-clockwise)
  const ccw = dot(newell(rings[0]), segs[0].d) > 0;
  const push = (a, b, c) => (ccw ? tri.push(a, c, b) : tri.push(a, b, c));
  for (let i = 0; i < spans; i++) {
    const j = (i + 1) % ringCount;
    for (let k = 0; k < m; k++) {
      const k2 = (k + 1) % m, f = face(k) ? 1 : 2;
      push(id(i, k), id(j, k), id(j, k2));
      push(id(i, k), id(j, k2), id(i, k2));
      ids.push(f, f);
    }
  }
  if (!chain.closed) {
    // the ends: a fan from the outer corner of the cross-section (every point of it can be seen from there)
    for (const [i, start] of [[0, true], [ringCount - 1, false]]) {
      for (let k = 1; k < m - 1; k++) {
        if (start === ccw) tri.push(id(i, 0), id(i, k + 1), id(i, k)); else tri.push(id(i, 0), id(i, k), id(i, k + 1));
        ids.push(2);
      }
    }
  }
  // the right way round: the volume must come out positive
  if (signedVolume(vert, tri) < 0) for (let t = 0; t < tri.length; t += 3) { const x = tri[t + 1]; tri[t + 1] = tri[t + 2]; tri[t + 2] = x; }
  return { vertProperties: Float32Array.from(vert), triVerts: Uint32Array.from(tri), faceID: Uint32Array.from(ids), convex };
}

/** Corners where three rounded outer edges meet: the box between the corner and the centre of the ball that touches the three faces, minus that ball. */
function ballCorners(topo, edges, r, frameOf) {
  const at = new Map();
  edges.forEach(e => { for (const v of [e.a, e.b]) { if (!at.has(v)) at.set(v, []); at.get(v).push(e); } });
  const out = [];
  for (const [v, list] of at) {
    if (list.length !== 3) continue;
    const frames = list.map(e => frameOf(e, e.a === v));
    if (!frames.every(f => f.convex)) continue;
    // the three faces: the normals around the corner
    const normals = new Map();
    frames.forEach(f => { normals.set(topo.fid[f.L], f.nL); normals.set(topo.fid[f.R], f.nR); });
    if (normals.size !== 3) continue;
    const V = topo.P(v);
    const [n1, n2, n3] = [...normals.values()];
    const O = solve3([n1, n2, n3], [dot(n1, V) - r, dot(n2, V) - r, dot(n3, V) - r]);
    if (!O) continue;
    const dirs = frames.map(f => f.d);
    const c = solve3([[dirs[0][0], dirs[1][0], dirs[2][0]], [dirs[0][1], dirs[1][1], dirs[2][1]], [dirs[0][2], dirs[1][2], dirs[2][2]]], sub(O, V));
    if (!c || c.some(x => !(x > 1e-9))) continue;
    const hull = [];
    for (let m = 0; m < 8; m++) {
      let p = V;
      for (let j = 0; j < 3; j++) if (m & (1 << j)) p = add(p, scale(dirs[j], c[j]));
      hull.push(p);
    }
    out.push({ hull, centre: O, r });
  }
  return out;
}

/** The normal of a polygon (Newell), not normalised. */
function newell(pts) {
  const n = [0, 0, 0];
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i], b = pts[(i + 1) % pts.length];
    n[0] += (a[1] - b[1]) * (a[2] + b[2]); n[1] += (a[2] - b[2]) * (a[0] + b[0]); n[2] += (a[0] - b[0]) * (a[1] + b[1]);
  }
  return n;
}

function signedVolume(v, t) {
  let s = 0;
  for (let i = 0; i < t.length; i += 3) {
    const a = t[i] * 3, b = t[i + 1] * 3, c = t[i + 2] * 3;
    s += v[a] * (v[b + 1] * v[c + 2] - v[b + 2] * v[c + 1]) - v[a + 1] * (v[b] * v[c + 2] - v[b + 2] * v[c]) + v[a + 2] * (v[b] * v[c + 1] - v[b + 1] * v[c]);
  }
  return s / 6;
}

/** Solves the 3×3 system M x = b (rows of M), or null. */
function solve3(M, b) {
  const det = m => m[0][0] * (m[1][1] * m[2][2] - m[1][2] * m[2][1]) - m[0][1] * (m[1][0] * m[2][2] - m[1][2] * m[2][0]) + m[0][2] * (m[1][0] * m[2][1] - m[1][1] * m[2][0]);
  const D = det(M);
  if (Math.abs(D) < 1e-12) return null;
  return [0, 1, 2].map(j => det(M.map((row, i) => row.map((x, k) => (k === j ? b[i] : x)))) / D);
}
