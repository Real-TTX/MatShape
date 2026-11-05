/* MatShape – the edges of a part. Every triangle of a part carries the number of the face it belongs to (model.js names the faces: "<feature>:start", "<feature>:end",
   "<feature>:<sketch entity>", the faces of fillets …), so an edge is where two faces meet: two neighbouring triangles with different face numbers that are not in one plane.
   An edge is known by the names of its two faces, which stay the same when the model is built again with other values (like the edges of OnShape).
   No DOM, no kernel: works on the plain arrays of a mesh (tested in Node). */

/** The neighbours of the triangles and the edges between faces of a mesh ({ vertProperties, triVerts, numProp, faceID }). */
export function topology(mesh) {
  const np = mesh.numProp || 3, vp = mesh.vertProperties, tv = mesh.triVerts;
  const numTri = tv.length / 3, numVert = vp.length / np;
  const fid = mesh.faceID && mesh.faceID.length === numTri ? mesh.faceID : new Uint32Array(numTri);
  const P = i => [vp[i * np], vp[i * np + 1], vp[i * np + 2]];
  const normals = new Float64Array(numTri * 3);
  for (let t = 0; t < numTri; t++) {
    const a = P(tv[t * 3]), b = P(tv[t * 3 + 1]), c = P(tv[t * 3 + 2]);
    const n = cross(sub(b, a), sub(c, a)), l = Math.hypot(n[0], n[1], n[2]) || 1;
    normals[t * 3] = n[0] / l; normals[t * 3 + 1] = n[1] / l; normals[t * 3 + 2] = n[2] / l;
  }
  const normal = t => [normals[t * 3], normals[t * 3 + 1], normals[t * 3 + 2]];
  // the halfedge a -> b belongs to the triangle that has it counter-clockwise; its twin b -> a to the neighbour
  const half = new Map();
  for (let t = 0; t < numTri; t++) for (let c = 0; c < 3; c++) half.set(tv[t * 3 + c] * numVert + tv[t * 3 + (c + 1) % 3], t);
  const edges = [];
  for (let t = 0; t < numTri; t++) {
    for (let c = 0; c < 3; c++) {
      const a = tv[t * 3 + c], b = tv[t * 3 + (c + 1) % 3];
      if (a > b) continue;
      const R = half.get(b * numVert + a);
      if (R === undefined) continue;
      if (fid[t] === fid[R]) continue;
      const nl = normal(t), nr = normal(R);
      // two faces in one plane are one face for the person (a part put flush on another): no edge between them
      if (dot(nl, nr) > 1 - 1e-9 && Math.abs(dot(nl, sub(P(tv[R * 3]), P(a)))) < 1e-6) continue;
      edges.push({ a, b, L: t, R, angle: Math.acos(Math.max(-1, Math.min(1, dot(nl, nr)))) });
    }
  }
  return { np, vp, tv, fid, numTri, numVert, P, normal, half, edges };
}

/** Splits a list of edges (of one topology) into connected chains: [{ verts: [v0, v1, …], edges: [edge, …], closed }]. Chains end where more than two edges meet. */
export function chains(edges, split = () => false) {
  const at = new Map();
  edges.forEach((e, i) => { for (const v of [e.a, e.b]) { if (!at.has(v)) at.set(v, []); at.get(v).push(i); } });
  const used = new Set(), out = [];
  const walk = (start, from) => {
    const verts = [from], list = [];
    let i = start, v = from;
    while (i !== undefined && !used.has(i)) {
      used.add(i);
      const e = edges[i], next = e.a === v ? e.b : e.a;
      list.push({ edge: e, forward: e.a === v });
      verts.push(next);
      const around = at.get(next);
      if (around.length !== 2) break;
      const j = around[0] === i ? around[1] : around[0];
      if (split(e, edges[j], next)) break;
      i = j; v = next;
    }
    return { verts, list };
  };
  // open chains first (from their ends), then the closed loops that are left
  for (const [v, list] of at) {
    if (list.length === 2 && !split(edges[list[0]], edges[list[1]], v)) continue;
    for (const i of list) {
      if (used.has(i)) continue;
      const { verts, list: l } = walk(i, v);
      out.push({ verts, edges: l, closed: false });
    }
  }
  edges.forEach((e, i) => {
    if (used.has(i)) return;
    const { verts, list } = walk(i, e.a);
    const closed = verts[verts.length - 1] === verts[0];
    out.push({ verts: closed ? verts.slice(0, -1) : verts, edges: list, closed });
  });
  return out;
}

/** The distance of a point to a segment (3D). */
export function distToSegment3(p, a, b) {
  const ab = sub(b, a), l2 = dot(ab, ab);
  const s = l2 ? Math.max(0, Math.min(1, dot(sub(p, a), ab) / l2)) : 0;
  return Math.hypot(...sub(p, [a[0] + ab[0] * s, a[1] + ab[1] * s, a[2] + ab[2] * s]));
}

export const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
export const add = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
export const scale = (a, s) => [a[0] * s, a[1] * s, a[2] * s];
export const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
export const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
export const norm = a => { const l = Math.hypot(a[0], a[1], a[2]) || 1; return [a[0] / l, a[1] / l, a[2] / l]; };
