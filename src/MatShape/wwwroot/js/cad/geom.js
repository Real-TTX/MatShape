/* MatShape – plain geometry: vectors, the frames of planes, and the profiles of a sketch.
   World axes like in most CAD tools: Z is up. Top = XY plane (normal +Z), Front = XZ plane (normal -Y), Right = YZ plane (normal +X).
   A frame is { o, x, y, n } (origin and three unit vectors, n = x × y); a point (u, v) of a sketch is o + u·x + v·y. */

export const v3 = {
  add: (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]],
  sub: (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]],
  scale: (a, s) => [a[0] * s, a[1] * s, a[2] * s],
  dot: (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2],
  cross: (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]],
  len: a => Math.hypot(a[0], a[1], a[2]),
  norm: a => { const l = Math.hypot(a[0], a[1], a[2]) || 1; return [a[0] / l, a[1] / l, a[2] / l]; },
  dist: (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]),
};

export const STANDARD_PLANES = {
  top: { o: [0, 0, 0], x: [1, 0, 0], y: [0, 1, 0], n: [0, 0, 1] },
  front: { o: [0, 0, 0], x: [1, 0, 0], y: [0, 0, 1], n: [0, -1, 0] },
  right: { o: [0, 0, 0], x: [0, 1, 0], y: [0, 0, 1], n: [1, 0, 0] },
};

export const AXES = { x: [1, 0, 0], y: [0, 1, 0], z: [0, 0, 1] };

/** A frame from an origin and a normal (the x axis is chosen to be as "horizontal" as possible). */
export function frameFromNormal(o, n, xHint) {
  const nn = v3.norm(n);
  let x = xHint ? v3.sub(xHint, v3.scale(nn, v3.dot(xHint, nn))) : null;
  if (!x || v3.len(x) < 1e-6) {
    const up = Math.abs(nn[2]) > 0.9 ? [1, 0, 0] : [0, 0, 1];
    x = v3.cross(up, nn);
    if (Math.abs(nn[2]) > 0.9) x = [nn[2] > 0 ? 1 : -1, 0, 0];
  }
  x = v3.norm(x);
  const y = v3.norm(v3.cross(nn, x));
  return { o: [...o], x, y, n: nn };
}

export function offsetFrame(f, d, flip) {
  const n = flip ? v3.scale(f.n, -1) : f.n;
  const x = flip ? v3.scale(f.x, -1) : f.x;
  return { o: v3.add(f.o, v3.scale(f.n, d)), x, y: f.y, n };
}

export const toWorld = (f, u, v) => [f.o[0] + f.x[0] * u + f.y[0] * v, f.o[1] + f.x[1] * u + f.y[1] * v, f.o[2] + f.x[2] * u + f.y[2] * v];

export function toLocal(f, p) {
  const d = v3.sub(p, f.o);
  return [v3.dot(d, f.x), v3.dot(d, f.y)];
}

/** The 4x4 matrix (column-major, as Manifold and three.js want it) that puts the local frame into the world. */
export function frameMatrix(f) {
  return [f.x[0], f.x[1], f.x[2], 0, f.y[0], f.y[1], f.y[2], 0, f.n[0], f.n[1], f.n[2], 0, f.o[0], f.o[1], f.o[2], 1];
}

/** A rotation about an axis through a point, as a column-major 4x4 matrix. Degrees. */
export function rotationMatrix(axis, degrees, pivot = [0, 0, 0]) {
  const [x, y, z] = v3.norm(axis);
  const a = degrees * Math.PI / 180;
  const c = Math.cos(a), s = Math.sin(a), t = 1 - c;
  const r = [
    t * x * x + c, t * x * y + s * z, t * x * z - s * y,
    t * x * y - s * z, t * y * y + c, t * y * z + s * x,
    t * x * z + s * y, t * y * z - s * x, t * z * z + c,
  ];
  // p' = R(p - pivot) + pivot
  const rp = [
    r[0] * pivot[0] + r[3] * pivot[1] + r[6] * pivot[2],
    r[1] * pivot[0] + r[4] * pivot[1] + r[7] * pivot[2],
    r[2] * pivot[0] + r[5] * pivot[1] + r[8] * pivot[2],
  ];
  return [r[0], r[1], r[2], 0, r[3], r[4], r[5], 0, r[6], r[7], r[8], 0, pivot[0] - rp[0], pivot[1] - rp[1], pivot[2] - rp[2], 1];
}

/** The mirror at a plane through o with normal n, as a column-major 4x4 matrix. */
export function mirrorMatrix(o, n) {
  const [a, b, c] = v3.norm(n);
  const d = -(a * o[0] + b * o[1] + c * o[2]);
  return [
    1 - 2 * a * a, -2 * a * b, -2 * a * c, 0,
    -2 * a * b, 1 - 2 * b * b, -2 * b * c, 0,
    -2 * a * c, -2 * b * c, 1 - 2 * c * c, 0,
    -2 * a * d, -2 * b * d, -2 * c * d, 1,
  ];
}

// ---- sketches ---------------------------------------------------------------------------------------------------------------

const TAU = Math.PI * 2;
const STEP = 5 * Math.PI / 180;

export function arcPoints(cx, cy, r, a0, a1) {
  let sweep = a1 - a0;
  while (sweep <= 0) sweep += TAU;
  while (sweep > TAU) sweep -= TAU;
  const n = Math.max(2, Math.ceil(sweep / STEP));
  const pts = [];
  for (let i = 0; i <= n; i++) {
    const a = a0 + sweep * i / n;
    pts.push([cx + r * Math.cos(a), cy + r * Math.sin(a)]);
  }
  return pts;
}

export function circlePoints(cx, cy, r) {
  const n = Math.max(24, Math.min(144, Math.ceil(TAU / STEP)));
  const pts = [];
  for (let i = 0; i < n; i++) {
    const a = TAU * i / n;
    pts.push([cx + r * Math.cos(a), cy + r * Math.sin(a)]);
  }
  return pts;
}

export function polygonPoints(e) {
  const n = Math.max(3, Math.min(64, Math.round(e.n || 6)));
  const pts = [];
  for (let i = 0; i < n; i++) {
    const a = (e.rot || 0) * Math.PI / 180 + TAU * i / n;
    pts.push([e.c[0] + e.r * Math.cos(a), e.c[1] + e.r * Math.sin(a)]);
  }
  return pts;
}

export function rectPoints(e) {
  const [x0, y0] = e.a, [x1, y1] = e.b;
  return [[x0, y0], [x1, y0], [x1, y1], [x0, y1]];
}

/** The start and end of an open entity (a line or an arc), for chaining. */
export function ends(e) {
  if (e.t === 'line') return [e.a, e.b];
  if (e.t === 'arc') return [[e.c[0] + e.r * Math.cos(e.a0), e.c[1] + e.r * Math.sin(e.a0)], [e.c[0] + e.r * Math.cos(e.a1), e.c[1] + e.r * Math.sin(e.a1)]];
  return null;
}

/** The points of an entity as a polyline (for drawing); closed shapes repeat their first point. */
export function entityPolyline(e) {
  switch (e.t) {
    case 'line': return [e.a, e.b];
    case 'arc': return arcPoints(e.c[0], e.c[1], e.r, e.a0, e.a1);
    case 'circle': { const p = circlePoints(e.c[0], e.c[1], e.r); return [...p, p[0]]; }
    case 'rect': { const p = rectPoints(e); return [...p, p[0]]; }
    case 'polygon': { const p = polygonPoints(e); return [...p, p[0]]; }
    default: return [];
  }
}

const key = p => `${Math.round(p[0] * 1e4)},${Math.round(p[1] * 1e4)}`;

/**
 * The closed profiles of a sketch, found like OnShape does: every curve that is not construction geometry is cut where it meets another, loose ends are
 * trimmed away, and every smallest enclosed region becomes a profile – so a line across a rectangle makes two profiles, a line ending at a corner does not
 * spoil the rectangle, and crossing lines enclose what they enclose. Returns [{ key, ids, points }] (points counter-clockwise); key is the sorted ids of the
 * entities of its border, so a choice of profiles survives edits of the sketch (regions with the same border entities get #2, #3 … from left to right).
 */
export function sketchLoops(entities) {
  // the curves as polylines, each piece knows its entity
  const segs = [];
  for (const e of entities || []) {
    if (e.cons || e.t === 'point') continue;
    if (e.t === 'circle' && !(e.r > 0)) continue;
    const pts = entityPolyline(e);
    for (let i = 1; i < pts.length; i++) {
      const a = pts[i - 1], b = pts[i];
      if (Math.hypot(b[0] - a[0], b[1] - a[1]) > 1e-9) segs.push({ a, b, id: e.id, cuts: [] });
    }
  }
  if (!segs.length) return [];

  // where pieces cross or touch: cut both there (sweep over x, so large traced sketches stay fast)
  const box = s => [Math.min(s.a[0], s.b[0]), Math.max(s.a[0], s.b[0]), Math.min(s.a[1], s.b[1]), Math.max(s.a[1], s.b[1])];
  const order = segs.map((s, i) => ({ s, i, bb: box(s) })).sort((p, q) => p.bb[0] - q.bb[0]);
  const eps = 1e-9;
  for (let i = 0; i < order.length; i++) {
    const A = order[i];
    for (let j = i + 1; j < order.length && order[j].bb[0] <= A.bb[1] + 1e-7; j++) {
      const B = order[j];
      if (B.bb[2] > A.bb[3] + 1e-7 || B.bb[3] < A.bb[2] - 1e-7) continue;
      const p = A.s.a, r = [A.s.b[0] - p[0], A.s.b[1] - p[1]], q = B.s.a, s = [B.s.b[0] - q[0], B.s.b[1] - q[1]];
      const den = r[0] * s[1] - r[1] * s[0];
      if (Math.abs(den) < eps * Math.hypot(...r) * Math.hypot(...s)) continue;   // parallel: touching ends join by their points anyway
      const w = [q[0] - p[0], q[1] - p[1]];
      const t = (w[0] * s[1] - w[1] * s[0]) / den, u = (w[0] * r[1] - w[1] * r[0]) / den;
      const tol = 1e-9;
      if (t < -tol || t > 1 + tol || u < -tol || u > 1 + tol) continue;
      const x = [p[0] + r[0] * t, p[1] + r[1] * t];
      if (t > tol && t < 1 - tol) A.s.cuts.push([t, x]);
      if (u > tol && u < 1 - tol) B.s.cuts.push([u, x]);
    }
  }

  // the graph: points merged (to a ten-thousandth of a millimetre), edges between them with the ids of their entities
  const index = new Map(), coords = [];
  const vertex = p => { const k = key(p); if (!index.has(k)) { index.set(k, coords.length); coords.push(p); } return index.get(k); };
  const edges = new Map();
  for (const s of segs) {
    const chain = [s.a, ...s.cuts.sort((x, y) => x[0] - y[0]).map(c => c[1]), s.b];
    for (let i = 1; i < chain.length; i++) {
      const u = vertex(chain[i - 1]), v = vertex(chain[i]);
      if (u === v) continue;
      const k = u < v ? u + ':' + v : v + ':' + u;
      if (!edges.has(k)) edges.set(k, { u, v, ids: new Set() });
      edges.get(k).ids.add(s.id);
    }
  }
  // loose ends do not enclose anything: trim them until every point has two or more edges
  const out = coords.map(() => []);
  for (const e of edges.values()) { out[e.u].push(e); out[e.v].push(e); }
  const degree = out.map(l => l.length);
  const gone = new Set();
  const queue = degree.map((d, i) => (d === 1 ? i : -1)).filter(i => i >= 0);
  while (queue.length) {
    const v = queue.pop();
    for (const e of out[v]) {
      if (gone.has(e)) continue;
      gone.add(e);
      const w = e.u === v ? e.v : e.u;
      if (--degree[w] === 1) queue.push(w);
      degree[v]--;
    }
  }
  // half-edges sorted by angle around each point; a face is walked keeping it on the left: at each point the next edge clockwise from the way back
  const around = coords.map(() => []);
  for (const e of edges.values()) {
    if (gone.has(e)) continue;
    for (const [from, to] of [[e.u, e.v], [e.v, e.u]]) {
      around[from].push({ from, to, e, angle: Math.atan2(coords[to][1] - coords[from][1], coords[to][0] - coords[from][0]) });
    }
  }
  around.forEach(list => list.sort((x, y) => x.angle - y.angle));
  const seen = new Set();
  const regions = [];
  for (const list of around) {
    for (const start of list) {
      if (seen.has(start)) continue;
      const cycle = [];
      let h = start, guard = 0;
      while (h && !seen.has(h) && guard++ < 1e6) {
        seen.add(h);
        cycle.push(h);
        const at = around[h.to];
        const back = at.findIndex(x => x.to === h.from && x.e === h.e);
        h = at[(back - 1 + at.length) % at.length];
      }
      if (cycle.length < 3 || h !== start) continue;
      const points = cycle.map(x => coords[x.from]);
      if (area2(points) <= 1e-9) continue;              // the outside of a group of regions runs clockwise
      const ids = [...new Set(cycle.flatMap(x => [...x.e.ids]))];
      regions.push({ ids, points });
    }
  }
  // keys: the sorted ids of the border; regions with the same border entities are told apart from left to right
  const byKey = new Map();
  for (const r of regions) {
    r.key = [...r.ids].sort().join('+');
    r.cx = r.points.reduce((s, p) => s + p[0], 0) / r.points.length;
    if (!byKey.has(r.key)) byKey.set(r.key, []);
    byKey.get(r.key).push(r);
  }
  for (const list of byKey.values()) {
    if (list.length < 2) continue;
    list.sort((a, b) => a.cx - b.cx).forEach((r, i) => { if (i) r.key += '#' + (i + 1); });
  }
  return regions.map(({ key: k, ids, points }) => ({ key: k, ids, points }));
}
/** The signed area of a polygon (counter-clockwise > 0). */
export function area2(points) {
  let a = 0;
  for (let i = 0, j = points.length - 1; i < points.length; j = i++) a += (points[j][0] + points[i][0]) * (points[j][1] - points[i][1]);
  return -a / 2;
}

export function pointInPolygon(p, points) {
  let inside = false;
  for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
    const [xi, yi] = points[i], [xj, yj] = points[j];
    if (((yi > p[1]) !== (yj > p[1])) && (p[0] < (xj - xi) * (p[1] - yi) / (yj - yi) + xi)) inside = !inside;
  }
  return inside;
}

/** The distance from a point to a segment (2D). */
export function distToSegment(p, a, b) {
  const dx = b[0] - a[0], dy = b[1] - a[1];
  const l2 = dx * dx + dy * dy;
  let t = l2 ? ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / l2 : 0;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(p[0] - a[0] - t * dx, p[1] - a[1] - t * dy);
}

/** The distance from a point to the drawn line of an entity (2D, in sketch units). */
export function distToEntity(p, e) {
  if (e.t === 'point') return Math.hypot(p[0] - e.p[0], p[1] - e.p[1]);
  if (e.t === 'circle') return Math.abs(Math.hypot(p[0] - e.c[0], p[1] - e.c[1]) - e.r);
  const pts = entityPolyline(e);
  let best = Infinity;
  for (let i = 1; i < pts.length; i++) best = Math.min(best, distToSegment(p, pts[i - 1], pts[i]));
  return best;
}

/** The points a pointer snaps to: ends, centres, midpoints of lines, corners. */
export function snapPoints(entities) {
  const out = [];
  for (const e of entities || []) {
    if (e.t === 'line') { out.push(e.a, e.b, [(e.a[0] + e.b[0]) / 2, (e.a[1] + e.b[1]) / 2]); }
    else if (e.t === 'arc') { out.push(...ends(e), e.c); }
    else if (e.t === 'circle') { out.push(e.c, [e.c[0] + e.r, e.c[1]], [e.c[0] - e.r, e.c[1]], [e.c[0], e.c[1] + e.r], [e.c[0], e.c[1] - e.r]); }
    else if (e.t === 'rect') { out.push(...rectPoints(e), [(e.a[0] + e.b[0]) / 2, (e.a[1] + e.b[1]) / 2]); }
    else if (e.t === 'polygon') { out.push(e.c, ...polygonPoints(e)); }
    else if (e.t === 'point') { out.push(e.p); }
  }
  return out;
}

/** The circle through three points (for the three-point arc), or null when they are on one line. */
export function circleThrough(a, b, c) {
  const d = 2 * (a[0] * (b[1] - c[1]) + b[0] * (c[1] - a[1]) + c[0] * (a[1] - b[1]));
  if (Math.abs(d) < 1e-12) return null;
  const a2 = a[0] * a[0] + a[1] * a[1], b2 = b[0] * b[0] + b[1] * b[1], c2 = c[0] * c[0] + c[1] * c[1];
  const ux = (a2 * (b[1] - c[1]) + b2 * (c[1] - a[1]) + c2 * (a[1] - b[1])) / d;
  const uy = (a2 * (c[0] - b[0]) + b2 * (a[0] - c[0]) + c2 * (b[0] - a[0])) / d;
  return { c: [ux, uy], r: Math.hypot(a[0] - ux, a[1] - uy) };
}

/** The arc from a to c through b (start angle, end angle counter-clockwise). */
export function arcThrough(a, b, c) {
  const circle = circleThrough(a, b, c);
  if (!circle) return null;
  const ang = p => Math.atan2(p[1] - circle.c[1], p[0] - circle.c[0]);
  let a0 = ang(a), a1 = ang(c);
  const am = ang(b);
  const norm = x => ((x % TAU) + TAU) % TAU;
  // is b on the counter-clockwise way from a to c? if not, go the other way round
  if (norm(am - a0) > norm(a1 - a0)) [a0, a1] = [a1, a0];
  return { c: circle.c, r: circle.r, a0, a1 };
}
