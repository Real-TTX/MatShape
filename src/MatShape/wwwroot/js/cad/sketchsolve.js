/* MatShape – the constraint solver of a sketch (like the sketcher of OnShape).
   The unknowns are the numbers of the entities (the ends of lines, centres, radii, the angles of arcs). Every constraint and every dimension is one or two equations
   (residuals that are 0 when it holds). The solver moves the geometry as little as possible until every equation holds (Levenberg-Marquardt, the Jacobian by
   finite differences, dense normal equations – a sketch has tens to a few hundred unknowns). The analysis then tells, from the rank of the equations,
   which numbers are still free (blue), which are fully defined (black) and which constraints contradict the others or are redundant (red).

   A constraint: { id, type, refs: [ref, ref], value?, at?, off? }. A ref to a point: { e: entityId, k: 'a'|'b'|'c'|'s'|'e'|'p' } (s / e: start / end of an arc;
   { e: 'origin', k: 'p' } is the origin of the sketch); a ref to a curve: { e: entityId }. value is an expression (dimensions). */

export const ORIGIN = 'origin';

/** The kinds of constraints and dimensions; dimension: has a value. */
export const CONSTRAINTS = {
  coincident: { glyph: '•' },
  onCurve: { glyph: '•' },
  horizontal: { glyph: 'H' },
  vertical: { glyph: 'V' },
  parallel: { glyph: '∥' },
  perpendicular: { glyph: '⊥' },
  tangent: { glyph: 'T' },
  equal: { glyph: '=' },
  concentric: { glyph: '◎' },
  midpoint: { glyph: 'M' },
  fix: { glyph: '⚓' },
  distance: { dimension: true },
  hdistance: { dimension: true },
  vdistance: { dimension: true },
  length: { dimension: true },
  radius: { dimension: true },
  diameter: { dimension: true },
  angle: { dimension: true, angle: true },
  width: { dimension: true },
  height: { dimension: true },
};

/** The points an entity offers to constraints. */
export function pointKeys(e) {
  switch (e.t) {
    case 'line': case 'rect': return ['a', 'b'];
    case 'circle': case 'polygon': return ['c'];
    case 'arc': return ['c', 's', 'e'];
    case 'point': return ['p'];
    default: return [];
  }
}

const isLine = e => e?.t === 'line';
const isRound = e => e && (e.t === 'circle' || e.t === 'arc' || e.t === 'polygon');

// ---- the unknowns ---------------------------------------------------------------------------------------------------------

class System {
  constructor(entities) {
    this.entities = entities;
    this.byId = new Map(entities.map(e => [e.id, e]));
    this.slots = new Map();
    this.x = [];
    this.owner = [];
    const add = (e, name, value) => { this.slots.set(e.id + '.' + name, this.x.length); this.x.push(value); this.owner.push(e.id); };
    for (const e of entities) {
      if (e.t === 'line' || e.t === 'rect') { add(e, 'ax', e.a[0]); add(e, 'ay', e.a[1]); add(e, 'bx', e.b[0]); add(e, 'by', e.b[1]); }
      else if (e.t === 'circle') { add(e, 'cx', e.c[0]); add(e, 'cy', e.c[1]); add(e, 'r', e.r); }
      else if (e.t === 'arc') { add(e, 'cx', e.c[0]); add(e, 'cy', e.c[1]); add(e, 'r', e.r); add(e, 'a0', e.a0); add(e, 'a1', e.a1); }
      else if (e.t === 'polygon') { add(e, 'cx', e.c[0]); add(e, 'cy', e.c[1]); add(e, 'r', e.r); add(e, 'rot', (e.rot || 0) * Math.PI / 180); }
      else if (e.t === 'point') { add(e, 'px', e.p[0]); add(e, 'py', e.p[1]); }
    }
  }

  s(id, name) { return this.slots.get(id + '.' + name); }

  /** The indices of the unknowns of a point (empty for the origin). */
  pointVars(ref) {
    if (!ref || ref.e === ORIGIN) return [];
    const e = this.byId.get(ref.e);
    if (!e) return null;
    switch (ref.k) {
      case 'a': return [this.s(e.id, 'ax'), this.s(e.id, 'ay')];
      case 'b': return [this.s(e.id, 'bx'), this.s(e.id, 'by')];
      case 'c': return [this.s(e.id, 'cx'), this.s(e.id, 'cy')];
      case 'p': return [this.s(e.id, 'px'), this.s(e.id, 'py')];
      case 's': return ['cx', 'cy', 'r', 'a0'].map(n => this.s(e.id, n));
      case 'e': return ['cx', 'cy', 'r', 'a1'].map(n => this.s(e.id, n));
      default: return null;
    }
  }

  curveVars(ref) {
    const e = this.byId.get(ref?.e);
    if (!e) return null;
    return [...this.slots.entries()].filter(([k]) => k.startsWith(e.id + '.')).map(([, v]) => v);
  }

  point(x, ref) {
    if (ref.e === ORIGIN) return [0, 0];
    const e = this.byId.get(ref.e), v = n => x[this.s(e.id, n)];
    switch (ref.k) {
      case 'a': return [v('ax'), v('ay')];
      case 'b': return [v('bx'), v('by')];
      case 'c': return [v('cx'), v('cy')];
      case 'p': return [v('px'), v('py')];
      case 's': return [v('cx') + v('r') * Math.cos(v('a0')), v('cy') + v('r') * Math.sin(v('a0'))];
      case 'e': return [v('cx') + v('r') * Math.cos(v('a1')), v('cy') + v('r') * Math.sin(v('a1'))];
      default: return [0, 0];
    }
  }

  line(x, id) { const v = n => x[this.s(id, n)]; return { a: [v('ax'), v('ay')], b: [v('bx'), v('by')] }; }

  round(x, id) { const v = n => x[this.s(id, n)]; return { c: [v('cx'), v('cy')], r: v('r') }; }

  /** The entities with the numbers of x. */
  write(x) {
    return this.entities.map(e => {
      const v = n => x[this.s(e.id, n)];
      switch (e.t) {
        case 'line': case 'rect': return { ...e, a: [v('ax'), v('ay')], b: [v('bx'), v('by')] };
        case 'circle': return { ...e, c: [v('cx'), v('cy')], r: Math.abs(v('r')) };
        case 'arc': return { ...e, c: [v('cx'), v('cy')], r: Math.abs(v('r')), a0: v('a0'), a1: v('a1') };
        case 'polygon': return { ...e, c: [v('cx'), v('cy')], r: Math.abs(v('r')), rot: v('rot') * 180 / Math.PI };
        case 'point': return { ...e, p: [v('px'), v('py')] };
        default: return e;
      }
    });
  }
}

// ---- the equations ----------------------------------------------------------------------------------------------------------

const sub = (p, q) => [p[0] - q[0], p[1] - q[1]];
const len = v => Math.hypot(v[0], v[1]);
const cross = (u, v) => u[0] * v[1] - u[1] * v[0];
const dot = (u, v) => u[0] * v[0] + u[1] * v[1];
const unit = v => { const l = len(v) || 1e-12; return [v[0] / l, v[1] / l]; };
const distPointLine = (p, l) => cross(sub(l.b, l.a), sub(p, l.a)) / (len(sub(l.b, l.a)) || 1e-12);

/**
 * The equations of a constraint: [{ f(x), vars }], or { error } when a reference is gone or the kind does not fit.
 * value: the evaluated value of a dimension (mm, or degrees for an angle).
 */
function equations(sys, c, value) {
  const [r1, r2] = c.refs || [];
  const e1 = sys.byId.get(r1?.e), e2 = sys.byId.get(r2?.e);
  const P = (x, r) => sys.point(x, r);
  const pv = r => sys.pointVars(r), cv = r => sys.curveVars(r);
  const rows = (vars, ...fs) => (vars.some(v => v === null || v === undefined) ? { error: 'gone' } : fs.map(f => ({ f, vars })));
  const both = (a, b) => (a && b ? [...new Set([...a, ...b])] : [null]);

  switch (c.type) {
    case 'coincident': return rows(both(pv(r1), pv(r2)), x => P(x, r1)[0] - P(x, r2)[0], x => P(x, r1)[1] - P(x, r2)[1]);
    case 'onCurve':
      if (isLine(e2)) return rows(both(pv(r1), cv(r2)), x => distPointLine(P(x, r1), sys.line(x, e2.id)));
      if (isRound(e2)) return rows(both(pv(r1), cv(r2)), x => { const k = sys.round(x, e2.id); return len(sub(P(x, r1), k.c)) - k.r; });
      return { error: 'kind' };
    case 'horizontal':
    case 'vertical': {
      const i = c.type === 'horizontal' ? 1 : 0;
      if (r2) return rows(both(pv(r1), pv(r2)), x => P(x, r1)[i] - P(x, r2)[i]);
      if (isLine(e1)) return rows(cv(r1), x => { const l = sys.line(x, e1.id); return l.a[i] - l.b[i]; });
      return { error: 'kind' };
    }
    case 'parallel':
    case 'perpendicular':
      if (!isLine(e1) || !isLine(e2)) return { error: 'kind' };
      return rows(both(cv(r1), cv(r2)), x => {
        const u = unit(sub(sys.line(x, e1.id).b, sys.line(x, e1.id).a)), v = unit(sub(sys.line(x, e2.id).b, sys.line(x, e2.id).a));
        return c.type === 'parallel' ? cross(u, v) : dot(u, v);
      });
    case 'equal':
      if (isLine(e1) && isLine(e2)) return rows(both(cv(r1), cv(r2)), x => { const a = sys.line(x, e1.id), b = sys.line(x, e2.id); return len(sub(a.b, a.a)) - len(sub(b.b, b.a)); });
      if (isRound(e1) && isRound(e2)) return rows(both(cv(r1), cv(r2)), x => sys.round(x, e1.id).r - sys.round(x, e2.id).r);
      return { error: 'kind' };
    case 'concentric':
      if (!isRound(e1) || !isRound(e2)) return { error: 'kind' };
      return rows(both(cv(r1), cv(r2)), x => sys.round(x, e1.id).c[0] - sys.round(x, e2.id).c[0], x => sys.round(x, e1.id).c[1] - sys.round(x, e2.id).c[1]);
    case 'tangent': {
      const line = isLine(e1) ? e1 : isLine(e2) ? e2 : null, round = isRound(e1) ? e1 : isRound(e2) ? e2 : null;
      if (line && round) return rows(both(cv({ e: line.id }), cv({ e: round.id })), x => { const k = sys.round(x, round.id); return Math.abs(distPointLine(k.c, sys.line(x, line.id))) - k.r; });
      if (isRound(e1) && isRound(e2)) {
        return rows(both(cv(r1), cv(r2)), x => {
          const a = sys.round(x, e1.id), b = sys.round(x, e2.id), d = len(sub(a.c, b.c));
          return c.inside ? d - Math.abs(a.r - b.r) : d - (a.r + b.r);
        });
      }
      return { error: 'kind' };
    }
    case 'midpoint':
      if (!isLine(e2)) return { error: 'kind' };
      return rows(both(pv(r1), cv(r2)),
        x => P(x, r1)[0] - (sys.line(x, e2.id).a[0] + sys.line(x, e2.id).b[0]) / 2,
        x => P(x, r1)[1] - (sys.line(x, e2.id).a[1] + sys.line(x, e2.id).b[1]) / 2);
    case 'fix': {
      // a point stays where it was fixed; a whole entity keeps every number it had
      if (r1?.k) { const at = c.at || [0, 0]; return rows(pv(r1) || [null], x => P(x, r1)[0] - at[0], x => P(x, r1)[1] - at[1]); }
      const vars = cv(r1);
      if (!vars) return { error: 'gone' };
      return vars.map((v, i) => ({ f: x => x[v] - (c.at?.[i] ?? 0), vars: [v] }));
    }

    // dimensions
    case 'distance':
      if (r1?.k && r2?.k) return rows(both(pv(r1), pv(r2)), x => len(sub(P(x, r1), P(x, r2))) - value);
      if (r1?.k && isLine(e2)) return rows(both(pv(r1), cv(r2)), x => Math.abs(distPointLine(P(x, r1), sys.line(x, e2.id))) - value);
      if (r2?.k && isLine(e1)) return rows(both(pv(r2), cv(r1)), x => Math.abs(distPointLine(P(x, r2), sys.line(x, e1.id))) - value);
      if (isLine(e1) && isLine(e2)) return rows(both(cv(r1), cv(r2)), x => Math.abs(distPointLine(sys.line(x, e2.id).a, sys.line(x, e1.id))) - value);
      return { error: 'kind' };
    case 'hdistance':
    case 'vdistance': {
      const i = c.type === 'hdistance' ? 0 : 1;
      if (!r1?.k || !r2?.k) return { error: 'kind' };
      return rows(both(pv(r1), pv(r2)), x => Math.abs(P(x, r2)[i] - P(x, r1)[i]) - value);
    }
    case 'length':
      if (!isLine(e1)) return { error: 'kind' };
      return rows(cv(r1), x => { const l = sys.line(x, e1.id); return len(sub(l.b, l.a)) - value; });
    case 'radius':
    case 'diameter':
      if (!isRound(e1)) return { error: 'kind' };
      return rows(cv(r1), x => sys.round(x, e1.id).r * (c.type === 'diameter' ? 2 : 1) - value);
    case 'angle':
      if (!isLine(e1) || !isLine(e2)) return { error: 'kind' };
      return rows(both(cv(r1), cv(r2)), x => {
        const u = unit(sub(sys.line(x, e1.id).b, sys.line(x, e1.id).a)), v = unit(sub(sys.line(x, e2.id).b, sys.line(x, e2.id).a));
        return Math.atan2(Math.abs(cross(u, v)), c.flip ? -dot(u, v) : dot(u, v)) - value * Math.PI / 180;
      });
    case 'width':
    case 'height': {
      if (e1?.t !== 'rect') return { error: 'kind' };
      const i = c.type === 'width' ? 0 : 1;
      return rows(cv(r1), x => { const l = sys.line(x, e1.id); return Math.abs(l.b[i] - l.a[i]) - value; });
    }
    default: return { error: 'kind' };
  }
}

// ---- solving ------------------------------------------------------------------------------------------------------------------

function cholesky(A, b, n) {
  const L = new Float64Array(n * n);
  for (let i = 0; i < n; i++) {
    for (let j = 0; j <= i; j++) {
      let s = A[i * n + j];
      for (let k = 0; k < j; k++) s -= L[i * n + k] * L[j * n + k];
      if (i === j) { if (s <= 0) return null; L[i * n + i] = Math.sqrt(s); } else L[i * n + j] = s / L[j * n + j];
    }
  }
  const y = new Float64Array(n);
  for (let i = 0; i < n; i++) { let s = b[i]; for (let k = 0; k < i; k++) s -= L[i * n + k] * y[k]; y[i] = s / L[i * n + i]; }
  const out = new Float64Array(n);
  for (let i = n - 1; i >= 0; i--) { let s = y[i]; for (let k = i + 1; k < n; k++) s -= L[k * n + i] * out[k]; out[i] = s / L[i * n + i]; }
  return out;
}

/** The gradient of an equation by finite differences (only its own unknowns). */
function gradient(row, x) {
  const g = [];
  for (const v of row.vars) {
    const keep = x[v], h = 1e-6 * Math.max(1, Math.abs(keep));
    x[v] = keep + h; const fp = row.f(x);
    x[v] = keep - h; const fm = row.f(x);
    x[v] = keep;
    g.push((fp - fm) / (2 * h));
  }
  return g;
}

/** Levenberg-Marquardt on weighted rows; changes x in place. */
function minimize(rows, x, iterations = 80) {
  const n = x.length;
  if (!rows.length || !n) return 0;
  let lambda = 1e-3;
  const cost = () => rows.reduce((s, r) => { const v = r.f(x) * r.w; return s + v * v; }, 0);
  let current = cost();
  for (let it = 0; it < iterations && current > 1e-22; it++) {
    const A = new Float64Array(n * n), g = new Float64Array(n);
    for (const row of rows) {
      const r = row.f(x) * row.w, grad = gradient(row, x).map(v => v * row.w);
      row.vars.forEach((vi, a) => {
        g[vi] += grad[a] * r;
        row.vars.forEach((vj, b) => { A[vi * n + vj] += grad[a] * grad[b]; });
      });
    }
    let improved = false;
    for (let tries = 0; tries < 8; tries++) {
      const M = A.slice();
      for (let i = 0; i < n; i++) M[i * n + i] += lambda * (1 + A[i * n + i]);
      const step = cholesky(M, g.map(v => -v), n);
      if (!step) { lambda *= 10; continue; }
      const old = x.slice();
      for (let i = 0; i < n; i++) x[i] += step[i];
      const next = cost();
      if (next < current) { current = next; lambda = Math.max(1e-9, lambda / 3); improved = true; break; }
      for (let i = 0; i < n; i++) x[i] = old[i];
      lambda *= 4;
    }
    if (!improved) break;
  }
  return current;
}

/**
 * Solves a sketch. evaluate(constraint) -> the value of a dimension (mm or degrees; may throw). drag: [{ ref, to }] pulls points towards places (while dragging).
 * Returns { entities, analysis } – analysis: { dof, entity: Map(id -> 'defined'|'free'|'conflict'), point: Map('id.k' -> state), constraint: Map(id -> 'ok'|'conflict'|'error'), errors: [{ id, reason }] }.
 */
export function solveSketch(entities, constraints, evaluate, options = {}) {
  const sys = new System(entities);
  const x = sys.x.slice();
  const rows = [];
  const errors = [];
  const rowsOf = new Map();
  for (const c of constraints || []) {
    let value;
    if (CONSTRAINTS[c.type]?.dimension) {
      try { value = evaluate(c); } catch (error) { errors.push({ id: c.id, reason: 'value', error }); continue; }
      if (!(value > 0) && !(CONSTRAINTS[c.type].angle && value === 0)) { errors.push({ id: c.id, reason: 'value' }); continue; }
    }
    const eq = equations(sys, c, value);
    if (eq.error) { errors.push({ id: c.id, reason: eq.error }); continue; }
    eq.forEach(r => { r.w = 1; r.c = c.id; });
    rowsOf.set(c.id, eq);
    rows.push(...eq);
  }

  // like OnShape, a constraint in conflict is shown but not applied: the geometry keeps to the others instead of tearing apart in a compromise.
  // First the equations that add nothing to the earlier ones (redundant or contradicting: the newest of them), then the ones that cannot be met.
  const conflict = new Set(rank(rows, x).dependent);
  let active = rows.filter(r => !conflict.has(r.c));
  const x0 = x.slice();

  // dragging: the constraints weigh a lot more than the pull of the pointer, then a second pass makes them hold exactly
  if (options.drag?.length) {
    const pulls = [];
    for (const d of options.drag) {
      const vars = sys.pointVars(d.ref);
      if (!vars?.length) continue;
      pulls.push({ f: x2 => sys.point(x2, d.ref)[0] - d.to[0], vars, w: 1 }, { f: x2 => sys.point(x2, d.ref)[1] - d.to[1], vars, w: 1 });
    }
    active.forEach(r => { r.w = 1000; });
    minimize([...active, ...pulls], x, 30);
    active.forEach(r => { r.w = 1; });
  }
  minimize(active, x, options.iterations || 80);
  if (!options.drag?.length) {
    const unmet = new Set(active.filter(row => Math.abs(row.f(x)) > 1e-5).map(row => row.c));
    if (unmet.size) {
      unmet.forEach(id => conflict.add(id));
      active = active.filter(r => !unmet.has(r.c));
      for (let i = 0; i < x.length; i++) x[i] = x0[i];
      minimize(active, x, options.iterations || 80);
    }
  }

  const result = { entities: sys.write(x) };
  if (options.analyse !== false) result.analysis = analyse(sys, x, active, conflict, errors, constraints);
  return result;
}

/** Gram-Schmidt over the gradients of the equations in their order: the basis and the constraints whose equations add nothing new. */
function rank(rows, x) {
  const n = x.length;
  const basis = [];
  const dependent = new Set();
  for (const row of rows) {
    const v = new Float64Array(n);
    gradient(row, x).forEach((g, i) => { v[row.vars[i]] += g; });
    let norm = Math.hypot(...v);
    if (norm < 1e-12) { dependent.add(row.c); continue; }
    for (let i = 0; i < n; i++) v[i] /= norm;
    for (const q of basis) {
      let d = 0;
      for (let i = 0; i < n; i++) d += v[i] * q[i];
      for (let i = 0; i < n; i++) v[i] -= d * q[i];
    }
    norm = Math.hypot(...v);
    if (norm < 1e-6) { dependent.add(row.c); continue; }
    for (let i = 0; i < n; i++) v[i] /= norm;
    basis.push(v);
  }
  return { basis, dependent };
}

/**
 * The state of the sketch: an unknown is defined when it lies wholly in the space of the (applied) equations. The origin is fixed; nothing else is.
 */
function analyse(sys, x, rows, found, errors, constraints) {
  const n = x.length;
  const { basis } = rank(rows, x);
  const conflict = new Set([...errors.map(e => e.id), ...found]);

  const defined = new Array(n).fill(false);
  for (let i = 0; i < n; i++) {
    let s = 0;
    for (const q of basis) s += q[i] * q[i];
    defined[i] = s > 1 - 1e-6;
  }
  const inConflict = new Set();
  for (const c of constraints || []) if (conflict.has(c.id)) (c.refs || []).forEach(r => r?.e && inConflict.add(r.e));

  const entity = new Map(), point = new Map(), constraint = new Map();
  for (const e of sys.entities) {
    const vars = sys.curveVars({ e: e.id }) || [];
    entity.set(e.id, inConflict.has(e.id) ? 'conflict' : vars.every(v => defined[v]) ? 'defined' : 'free');
    for (const k of pointKeys(e)) {
      const pvars = sys.pointVars({ e: e.id, k }) || [];
      point.set(e.id + '.' + k, inConflict.has(e.id) ? 'conflict' : pvars.every(v => defined[v]) ? 'defined' : 'free');
    }
  }
  for (const c of constraints || []) constraint.set(c.id, errors.some(e => e.id === c.id) ? 'error' : conflict.has(c.id) ? 'conflict' : 'ok');
  return { dof: n - basis.length, entity, point, constraint, errors, conflicts: [...conflict] };
}

/** The current value of a dimension in the geometry (mm or degrees), or null. */
export function measure(entities, c) {
  const sys = new System(entities);

  const eq = equations(sys, c, 0);
  if (eq.error || !eq.length) return null;
  const v = eq[0].f(sys.x);
  return CONSTRAINTS[c.type]?.angle ? v * 180 / Math.PI : v;
}

/** A point of the sketch by its reference (for labels and glyphs). */
export function pointOfRef(entities, ref) {
  if (ref?.e === ORIGIN) return [0, 0];
  const sys = new System(entities);
  return sys.pointVars(ref) ? sys.point(sys.x, ref) : null;
}

/** The constraints of the sketch format before constraints existed ("dims" of length, diameter ... and "distance" with p1 / p2) as constraints. */
export function migrateDims(dims) {
  return (dims || []).map(d => {
    if (d.kind === 'distance') return { id: d.id, type: 'distance', refs: [ref(d.p1), ref(d.p2)], value: d.value };
    return { id: d.id, type: d.kind, refs: [{ e: d.ref }], value: d.value };
  });

  function ref(p) { return { e: p?.id, k: p?.at === 'a' || p?.at === 'b' ? p.at : p?.at === 'c' ? 'c' : 'p' }; }
}

/** The constraints of a sketch: the new list, or the old dims turned into constraints. */
export function constraintsOf(params) {
  return params?.cons || migrateDims(params?.dims);
}
