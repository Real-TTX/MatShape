/* MatShape – the editing tools of the sketch that change existing geometry (like OnShape): trim (M), offset (O), sketch fillet, mirror; and the geometry of the
   slot and the tangent arc. Plain functions on { entities, cons } (no DOM, tested in Node); the sketcher calls them inside one step of its history.
   Points: [x, y] in the plane of the sketch (mm). Angles in radians, arcs run counter-clockwise from a0 to a1. */

const TAU = Math.PI * 2;
const EPS = 1e-7;
const sub = (p, q) => [p[0] - q[0], p[1] - q[1]];
const add = (p, q) => [p[0] + q[0], p[1] + q[1]];
const mul = (p, s) => [p[0] * s, p[1] * s];
const dot = (p, q) => p[0] * q[0] + p[1] * q[1];
const cross = (p, q) => p[0] * q[1] - p[1] * q[0];
const len = p => Math.hypot(p[0], p[1]);
const unit = p => { const l = len(p) || 1; return [p[0] / l, p[1] / l]; };
const norm = a => { let x = a % TAU; if (x < 0) x += TAU; return x; };
const sweepOf = e => { let s = e.a1 - e.a0; while (s <= 0) s += TAU; while (s > TAU) s -= TAU; return s; };
const at = (e, a) => [e.c[0] + e.r * Math.cos(a), e.c[1] + e.r * Math.sin(a)];

// ---- intersections ------------------------------------------------------------------------------------------------------------

/** Where two curves meet (lines, circles, arcs): a list of points. */
export function meet(e, f) {
  const out = [];
  if (e.t === 'line' && f.t === 'line') {
    const d = sub(e.b, e.a), g = sub(f.b, f.a), den = cross(d, g);
    if (Math.abs(den) < 1e-12) return out;
    const w = sub(f.a, e.a), t = cross(w, g) / den, s = cross(w, d) / den;
    if (t >= -EPS && t <= 1 + EPS && s >= -EPS && s <= 1 + EPS) out.push(add(e.a, mul(d, t)));
    return out;
  }
  if (e.t === 'line' && f.c) return lineRound(e, f);
  if (f.t === 'line' && e.c) return lineRound(f, e);
  if (e.c && f.c && (e.t === 'circle' || e.t === 'arc') && (f.t === 'circle' || f.t === 'arc')) {
    const d = len(sub(f.c, e.c));
    if (d < 1e-12 || d > e.r + f.r + 1e-9 || d < Math.abs(e.r - f.r) - 1e-9) return out;
    const a = (e.r * e.r - f.r * f.r + d * d) / (2 * d), h = Math.sqrt(Math.max(0, e.r * e.r - a * a));
    const u = unit(sub(f.c, e.c)), m = add(e.c, mul(u, a)), n = [-u[1], u[0]];
    for (const p of h < 1e-12 ? [m] : [add(m, mul(n, h)), sub(m, mul(n, h))]) if (onRound(e, p) && onRound(f, p)) out.push(p);
  }
  return out;
}

function lineRound(l, c) {
  const d = sub(l.b, l.a), w = sub(l.a, c.c);
  const A = dot(d, d), B = 2 * dot(w, d), C = dot(w, w) - c.r * c.r, D = B * B - 4 * A * C;
  if (A < 1e-12 || D < -1e-12) return [];
  const r = Math.sqrt(Math.max(0, D)), out = [];
  for (const t of r < 1e-12 ? [-B / (2 * A)] : [(-B - r) / (2 * A), (-B + r) / (2 * A)]) {
    const p = add(l.a, mul(d, t));
    if (t >= -EPS && t <= 1 + EPS && onRound(c, p)) out.push(p);
  }
  return out;
}

/** Does a point (on the circle of c) lie on the arc c? (circles: always) */
function onRound(c, p) {
  if (c.t !== 'arc') return true;
  const a = norm(Math.atan2(p[1] - c.c[1], p[0] - c.c[0]) - c.a0);
  return a <= sweepOf(c) + 1e-7 || a >= TAU - 1e-7;
}

/** The place of a point along a curve: a line 0 … 1, an arc 0 … its sweep (radians from a0), a circle 0 … 2π. */
function paramOf(e, p) {
  if (e.t === 'line') { const d = sub(e.b, e.a); return dot(sub(p, e.a), d) / (dot(d, d) || 1); }
  const a = Math.atan2(p[1] - e.c[1], p[0] - e.c[0]);
  return e.t === 'arc' ? norm(a - e.a0) : norm(a);
}

// ---- trim -----------------------------------------------------------------------------------------------------------------------

/**
 * Trim (M, like OnShape): the piece of a curve between its nearest crossings with other curves around the clicked point goes away; a piece without crossings takes
 * the whole curve with it. A line or an arc may be cut in two; a circle becomes an arc. The new ends lie on the curves they were cut by (onCurve).
 * Returns { entities, cons } (new lists) or null when nothing changed. newId() gives ids.
 */
export function trim(entities, cons, id, click, newId) {
  const e = entities.find(x => x.id === id);
  if (!e || !['line', 'arc', 'circle'].includes(e.t)) return null;
  const cuts = [];
  for (const f of entities) {
    if (f.id === id || f.t === 'point' || f.t === 'polygon' || f.t === 'rect' || f.t === 'spline' || f.t === 'ellipse') continue;
    for (const p of meet(e, f)) cuts.push({ t: paramOf(e, p), p, by: f.id });
  }
  const tc = paramOf(e, click);
  const end = e.t === 'line' ? 1 : e.t === 'arc' ? sweepOf(e) : TAU;
  const inner = e.t === 'circle' ? cuts.filter((c, i) => cuts.findIndex(d => Math.abs(d.t - c.t) < 1e-9) === i) : cuts.filter(c => c.t > 1e-6 && c.t < end - 1e-6);
  // without crossings the whole curve goes
  const drop = () => ({ entities: entities.filter(x => x.id !== id), cons: cons.filter(c => !(c.refs || []).some(r => r?.e === id)) });
  if (e.t === 'circle') {
    if (inner.length < 2) return drop();
    // the circle becomes the arc from the crossing after the click round to the crossing before it
    const sorted = inner.sort((a, b) => a.t - b.t);
    const next = sorted.find(c => c.t > tc) || sorted[0], prev = [...sorted].reverse().find(c => c.t < tc) || sorted[sorted.length - 1];
    const arc = { id: e.id, t: 'arc', c: e.c, r: e.r, a0: next.t, a1: prev.t, ...(e.cons ? { cons: true } : {}) };
    const kept = cons.filter(c => !(c.refs || []).some(r => r?.e === id) || ['concentric', 'equal', 'tangent', 'onCurve', 'fix'].includes(c.type) || (c.type === 'coincident' && c.refs.some(r => r?.e === id && r.k === 'c')));
    return {
      entities: entities.map(x => (x.id === id ? arc : x)),
      cons: [...kept.filter(c => c.type !== 'fix'), { id: newId(), type: 'onCurve', refs: [{ e: id, k: 's' }, { e: next.by }] }, { id: newId(), type: 'onCurve', refs: [{ e: id, k: 'e' }, { e: prev.by }] }],
    };
  }
  const before = inner.filter(c => c.t < tc).sort((a, b) => b.t - a.t)[0], after = inner.filter(c => c.t > tc).sort((a, b) => a.t - b.t)[0];
  if (!before && !after) return drop();
  const [k0, k1] = e.t === 'line' ? ['a', 'b'] : ['s', 'e'];
  const point = c => (e.t === 'line' ? c.p : at(e, e.a0 + c.t));
  // which constraints still fit: none that held the end that is cut off, no dimension of the whole curve (its length changed)
  const keep = (c, gone) => !(c.refs || []).some(r => r?.e === id && (gone.includes(r.k) || (!r.k && DIMENSION.includes(c.type))));
  if (!before || !after) {
    const cut = before || after, cutStart = !before;   // no crossing before the click: the start goes
    const piece = { ...e };
    if (e.t === 'line') piece[cutStart ? 'a' : 'b'] = point(cut);
    else if (cutStart) piece.a0 = e.a0 + cut.t; else piece.a1 = e.a0 + cut.t;
    const gone = cutStart ? [k0] : [k1];
    return {
      entities: entities.map(x => (x.id === id ? piece : x)),
      cons: [...cons.filter(c => keep(c, gone)), { id: newId(), type: 'onCurve', refs: [{ e: id, k: cutStart ? k0 : k1 }, { e: cut.by }] }],
    };
  }
  // cut in two: this one keeps the start, a new one takes the end
  const first = { ...e }, second = { ...e, id: newId() };
  if (e.t === 'line') { first.b = point(before); second.a = point(after); }
  else { first.a1 = e.a0 + before.t; second.a0 = e.a0 + after.t; }
  const moved = cons.filter(c => keep(c, [])).map(c => {
    // what held the end now holds the end of the second piece; directions hold both
    if ((c.refs || []).some(r => r?.e === id && r.k === k1)) return { ...c, refs: c.refs.map(r => (r?.e === id && r.k === k1 ? { e: second.id, k: k1 } : r)) };
    return c;
  });
  const copies = cons.filter(c => ['horizontal', 'vertical', 'parallel', 'perpendicular'].includes(c.type) && (c.refs || []).some(r => r?.e === id && !r.k))
    .map(c => ({ ...c, id: newId(), refs: c.refs.map(r => (r?.e === id && !r.k ? { e: second.id } : r)) }));
  const ties = e.t === 'line' ? [{ id: newId(), type: 'parallel', refs: [{ e: id }, { e: second.id }] }, { id: newId(), type: 'onCurve', refs: [{ e: second.id, k: 'a' }, { e: id }] }] : [{ id: newId(), type: 'concentric', refs: [{ e: id }, { e: second.id }] }, { id: newId(), type: 'equal', refs: [{ e: id }, { e: second.id }] }];
  return {
    entities: entities.flatMap(x => (x.id === id ? [first, second] : [x])),
    cons: [...moved, ...copies, ...(e.t === 'line' ? [] : ties),
      { id: newId(), type: 'onCurve', refs: [{ e: id, k: k1 }, { e: before.by }] }, { id: newId(), type: 'onCurve', refs: [{ e: second.id, k: k0 }, { e: after.by }] }],
  };
}

const DIMENSION = ['length', 'distance', 'hdistance', 'vdistance', 'radius', 'diameter', 'angle', 'arclength'];

// ---- chains (for offset) --------------------------------------------------------------------------------------------------------

const endsOf = e => (e.t === 'line' ? [e.a, e.b] : e.t === 'arc' ? [at(e, e.a0), at(e, e.a1)] : null);
const same = (p, q) => p && q && Math.hypot(p[0] - q[0], p[1] - q[1]) < 1e-6;

/** The curves joined end to end with one of them, in their order: [{ e, forward }], closed. */
export function chainOf(entities, id) {
  const pool = entities.filter(x => (x.t === 'line' || x.t === 'arc') && !x.cons);
  const start = entities.find(x => x.id === id);
  if (!start) return null;
  if (start.t === 'circle') return { items: [{ e: start, forward: true }], closed: true };
  if (!endsOf(start)) return null;
  const used = new Set([start.id]);
  const items = [{ e: start, forward: true }];
  const step = (tail, append) => {
    for (;;) {
      const next = pool.find(x => !used.has(x.id) && (same(endsOf(x)[0], tail) || same(endsOf(x)[1], tail)));
      if (!next) return;
      used.add(next.id);
      const forward = append ? same(endsOf(next)[0], tail) : same(endsOf(next)[1], tail);
      if (append) items.push({ e: next, forward }); else items.unshift({ e: next, forward });
      tail = append ? endsOf(next)[forward ? 1 : 0] : endsOf(next)[forward ? 0 : 1];
    }
  };
  step(endsOf(start)[1], true);
  const first = items[0], last = items[items.length - 1];
  const head = endsOf(first.e)[first.forward ? 0 : 1], tail = endsOf(last.e)[last.forward ? 1 : 0];
  const closed = items.length > 1 && same(head, tail);
  if (!closed) step(endsOf(start)[0], false);
  return { items, closed };
}

/**
 * Offset (O, like OnShape): copies of a chain of curves at a distance, to the side of the point; lines meet where their copies cross, arcs keep their centres.
 * Returns { entities: the new curves, cons: coincident at the joints, parallel / concentric to the originals, one distance } or null.
 */
export function offset(entities, id, d, side, newId) {
  const chain = chainOf(entities, id);
  if (!chain || !(d > 0)) return null;
  const { items, closed } = chain;
  if (items.length === 1 && items[0].e.t === 'circle') {
    const c = items[0].e, outside = len(sub(side, c.c)) > c.r, r = c.r + (outside ? d : -d);
    if (!(r > 1e-9)) return null;
    const copy = { id: newId(), t: 'circle', c: [...c.c], r };
    return { entities: [copy], cons: [{ id: newId(), type: 'concentric', refs: [{ e: c.id }, { e: copy.id }] }] };
  }
  // which side: the left of the clicked curve as it runs in the chain, or its right
  const clicked = items.find(x => x.e.id === id);
  const left = item => {
    const e = item.e;
    if (e.t === 'line') { const u = unit(item.forward ? sub(e.b, e.a) : sub(e.a, e.b)); return [-u[1], u[0]]; }
    return null;
  };
  let sign;
  if (clicked.e.t === 'line') sign = Math.sign(dot(sub(side, clicked.e.a), left(clicked))) || 1;
  else {
    // an arc run forwards (counter-clockwise) has its centre on the left
    const inside = len(sub(side, clicked.e.c)) < clicked.e.r;
    sign = (inside === clicked.forward) ? 1 : -1;
  }
  const off = d * sign;
  // the copies, each on its own
  const copies = items.map(item => {
    const e = item.e;
    if (e.t === 'line') { const n = left(item), shift = mul(n, off); return { id: newId(), t: 'line', a: add(e.a, shift), b: add(e.b, shift) }; }
    const r = e.r + (item.forward ? -off : off);
    return r > 1e-9 ? { id: newId(), t: 'arc', c: [...e.c], r, a0: e.a0, a1: e.a1 } : null;
  });
  if (copies.some(x => !x)) return null;
  // the joints: where the copies of neighbours meet (lines: their crossing; else the nearest crossing)
  const joint = (i, j) => {
    const A = copies[i], B = copies[j], ia = items[i], ib = items[j];
    const endA = A.t === 'line' ? (ia.forward ? A.b : A.a) : at(A, ia.forward ? A.a1 : A.a0);
    const startB = B.t === 'line' ? (ib.forward ? B.a : B.b) : at(B, ib.forward ? B.a0 : B.a1);
    if (same(endA, startB)) return endA;
    let best = null;
    const guess = mul(add(endA, startB), 0.5);
    const lineOf = x => ({ t: 'line', a: add(x.a, mul(sub(x.a, x.b), 1e4)), b: add(x.b, mul(sub(x.b, x.a), 1e4)) });
    const full = x => (x.t === 'line' ? lineOf(x) : { t: 'circle', c: x.c, r: x.r });
    for (const p of meet(full(A), full(B))) if (!best || len(sub(p, guess)) < len(sub(best, guess))) best = p;
    return best || guess;
  };
  const n = items.length;
  for (let i = 0; i < n; i++) {
    const j = i + 1;
    if (j >= n && !closed) break;
    const p = joint(i, j % n);
    setEnd(copies[i], items[i].forward, true, p);
    setEnd(copies[j % n], items[j % n].forward, false, p);
  }
  const cons = [];
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    if (i + 1 >= n && !closed) break;
    cons.push({ id: newId(), type: 'coincident', refs: [{ e: copies[i].id, k: endKey(copies[i], items[i].forward, true) }, { e: copies[j].id, k: endKey(copies[j], items[j].forward, false) }] });
  }
  items.forEach((item, i) => cons.push({ id: newId(), type: item.e.t === 'line' ? 'parallel' : 'concentric', refs: [{ e: item.e.id }, { e: copies[i].id }] }));
  if (clicked.e.t === 'line') cons.push({ id: newId(), type: 'distance', refs: [{ e: clicked.e.id }, { e: copies[items.indexOf(clicked)].id }], value: String(Math.round(d * 1e4) / 1e4) });
  return { entities: copies, cons };
}

const endKey = (e, forward, last) => (e.t === 'line' ? ((forward === last) ? 'b' : 'a') : ((forward === last) ? 'e' : 's'));
function setEnd(e, forward, last, p) {
  const k = endKey(e, forward, last);
  if (e.t === 'line') e[k] = p;
  else e[k === 's' ? 'a0' : 'a1'] = Math.atan2(p[1] - e.c[1], p[0] - e.c[0]);
}

// ---- sketch fillet --------------------------------------------------------------------------------------------------------------

/**
 * A round corner between two lines that meet in a point (like the sketch fillet of OnShape): the lines are shortened, an arc touches both, a radius dimension
 * holds its size. ref: the corner point ({ e, k } of one of the lines). Returns { entities, cons, radiusId } or null.
 */
export function filletCorner(entities, cons, ref, r, newId) {
  const P = (e, k) => e[k];
  const corner = entities.find(x => x.id === ref.e)?.[ref.k];
  if (!corner) return null;
  const lines = entities.filter(x => x.t === 'line' && !x.cons && (same(x.a, corner) || same(x.b, corner)));
  if (lines.length !== 2) return null;
  const [l1, l2] = lines;
  const k1 = same(l1.a, corner) ? 'a' : 'b', k2 = same(l2.a, corner) ? 'a' : 'b';
  const far1 = P(l1, k1 === 'a' ? 'b' : 'a'), far2 = P(l2, k2 === 'a' ? 'b' : 'a');
  const u1 = unit(sub(far1, corner)), u2 = unit(sub(far2, corner));
  const theta = Math.acos(Math.max(-1, Math.min(1, dot(u1, u2))));
  if (theta < 1e-3 || theta > Math.PI - 1e-3) return null;
  const t = r / Math.tan(theta / 2);
  if (t >= len(sub(far1, corner)) || t >= len(sub(far2, corner))) return null;
  const T1 = add(corner, mul(u1, t)), T2 = add(corner, mul(u2, t));
  const O = add(corner, mul(unit(add(u1, u2)), r / Math.sin(theta / 2)));
  let a0 = Math.atan2(T1[1] - O[1], T1[0] - O[0]), a1 = Math.atan2(T2[1] - O[1], T2[0] - O[0]);
  // the short way round, counter-clockwise
  if (norm(a1 - a0) > Math.PI) [a0, a1] = [a1, a0];
  const arc = { id: newId(), t: 'arc', c: O, r, a0, a1 };
  const startAtT1 = same(at(arc, a0), T1);
  const out = entities.map(x => (x.id === l1.id ? { ...x, [k1]: T1 } : x.id === l2.id ? { ...x, [k2]: T2 } : x)).concat(arc);
  // the corner no longer holds the two lines together; the arc does
  const kept = cons.filter(c => !(c.type === 'coincident' && c.refs.some(r1 => r1.e === l1.id && r1.k === k1) && c.refs.some(r2 => r2.e === l2.id && r2.k === k2)));
  const radiusId = newId();
  kept.push(
    { id: newId(), type: 'coincident', refs: [{ e: l1.id, k: k1 }, { e: arc.id, k: startAtT1 ? 's' : 'e' }] },
    { id: newId(), type: 'coincident', refs: [{ e: l2.id, k: k2 }, { e: arc.id, k: startAtT1 ? 'e' : 's' }] },
    { id: newId(), type: 'tangent', refs: [{ e: l1.id }, { e: arc.id }] },
    { id: newId(), type: 'tangent', refs: [{ e: l2.id }, { e: arc.id }] },
    { id: radiusId, type: 'radius', refs: [{ e: arc.id }], value: String(Math.round(r * 1e4) / 1e4) },
  );
  return { entities: out, cons: kept, radiusId };
}

// ---- mirror ---------------------------------------------------------------------------------------------------------------------

/** Mirror copies of entities about a line, held symmetric to the originals (point by point). Returns { entities, cons } of the copies or null. */
export function mirror(entities, ids, lineId, newId) {
  const m = entities.find(x => x.id === lineId && x.t === 'line');
  if (!m) return null;
  const u = unit(sub(m.b, m.a));
  const reflect = p => { const w = sub(p, m.a), along = mul(u, dot(w, u)); return add(m.a, sub(mul(along, 2), w)); };
  const angle = a => { const p = reflect([Math.cos(a), Math.sin(a)]), o = reflect([0, 0]); return Math.atan2(p[1] - o[1], p[0] - o[0]); };
  const out = [], cons = [];
  const sym = (a, b) => cons.push({ id: newId(), type: 'symmetric', refs: [a, b, { e: lineId }] });
  for (const id of ids) {
    const e = entities.find(x => x.id === id);
    if (!e || e.id === lineId) continue;
    const id2 = newId();
    if (e.t === 'line') { out.push({ ...e, id: id2, a: reflect(e.a), b: reflect(e.b) }); sym({ e: id, k: 'a' }, { e: id2, k: 'a' }); sym({ e: id, k: 'b' }, { e: id2, k: 'b' }); }
    else if (e.t === 'circle') { out.push({ ...e, id: id2, c: reflect(e.c) }); sym({ e: id, k: 'c' }, { e: id2, k: 'c' }); cons.push({ id: newId(), type: 'equal', refs: [{ e: id }, { e: id2 }] }); }
    else if (e.t === 'arc') {
      // a mirrored arc runs the other way: its start is the mirror of the end
      out.push({ ...e, id: id2, c: reflect(e.c), a0: angle(e.a1), a1: angle(e.a0) });
      sym({ e: id, k: 'c' }, { e: id2, k: 'c' }); sym({ e: id, k: 's' }, { e: id2, k: 'e' }); sym({ e: id, k: 'e' }, { e: id2, k: 's' });
    } else if (e.t === 'point') { out.push({ ...e, id: id2, p: reflect(e.p) }); sym({ e: id, k: 'p' }, { e: id2, k: 'p' }); }
    else if (e.t === 'spline') out.push({ ...e, id: id2, pts: e.pts.map(reflect) });
    else if (e.t === 'ellipse') { out.push({ ...e, id: id2, c: reflect(e.c), rot: angle(e.rot || 0) }); sym({ e: id, k: 'c' }, { e: id2, k: 'c' }); }
  }
  return out.length ? { entities: out, cons } : null;
}

// ---- slot and tangent arc -----------------------------------------------------------------------------------------------------

/** A slot (Langloch) from the centre of one end to the centre of the other and its half width: two lines, two arcs, tangent and joined, the arcs equal. */
export function slot(c1, c2, r, newId) {
  const d = unit(sub(c2, c1)), n = [-d[1], d[0]];
  if (!(r > 1e-9) || len(sub(c2, c1)) < 1e-9) return null;
  const an = Math.atan2(n[1], n[0]);
  const L1 = { id: newId(), t: 'line', a: add(c1, mul(n, r)), b: add(c2, mul(n, r)) };
  const L2 = { id: newId(), t: 'line', a: sub(c2, mul(n, r)), b: sub(c1, mul(n, r)) };
  const A2 = { id: newId(), t: 'arc', c: [...c2], r, a0: an - Math.PI, a1: an };       // from -n round +d to +n
  const A1 = { id: newId(), t: 'arc', c: [...c1], r, a0: an, a1: an + Math.PI };       // from +n round -d to -n
  const axis = { id: newId(), t: 'line', a: [...c1], b: [...c2], cons: true };
  const k = (type, refs) => ({ id: newId(), type, refs });
  const cons = [
    k('coincident', [{ e: L1.id, k: 'b' }, { e: A2.id, k: 'e' }]), k('coincident', [{ e: A2.id, k: 's' }, { e: L2.id, k: 'a' }]),
    k('coincident', [{ e: L2.id, k: 'b' }, { e: A1.id, k: 'e' }]), k('coincident', [{ e: A1.id, k: 's' }, { e: L1.id, k: 'a' }]),
    k('tangent', [{ e: L1.id }, { e: A1.id }]), k('tangent', [{ e: L1.id }, { e: A2.id }]), k('tangent', [{ e: L2.id }, { e: A1.id }]), k('tangent', [{ e: L2.id }, { e: A2.id }]),
    k('equal', [{ e: A1.id }, { e: A2.id }]),
    k('coincident', [{ e: axis.id, k: 'a' }, { e: A1.id, k: 'c' }]), k('coincident', [{ e: axis.id, k: 'b' }, { e: A2.id, k: 'c' }]),
  ];
  return { entities: [L1, A2, L2, A1, axis], cons };
}

/** A tangent arc from the end of a curve (direction dir going on from it) to a point: { c, r, a0, a1, startIsA0 } or null. */
export function tangentArc(S, dir, E) {
  const t = unit(dir), n = [-t[1], t[0]];
  const w = sub(E, S), k = dot(w, w) / (2 * dot(w, n));
  if (!Number.isFinite(k) || Math.abs(k) < 1e-9 || Math.abs(k) > 1e6) return null;
  const c = add(S, mul(n, k)), r = Math.abs(k);
  const as = Math.atan2(S[1] - c[1], S[0] - c[0]), ae = Math.atan2(E[1] - c[1], E[0] - c[0]);
  // turning left (k > 0) the arc runs counter-clockwise from the start
  return k > 0 ? { c, r, a0: as, a1: ae, startIsA0: true } : { c, r, a0: ae, a1: as, startIsA0: false };
}
