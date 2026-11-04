/* MatShape – the parametric model: the list of features is run from the top (the "regeneration") and gives the parts, the sketches, the planes and the variables.
   The solid geometry is Manifold (WebAssembly, robust booleans); every object it makes lives in an "arena" that is freed when the next result replaces it.
   A feature that fails gets an error and is left out; the ones after it still run (they may fail too when they needed it). */

import { evalAngle, evalLength, evalNumber, evalVariable, errorKey, ExprError, isVariableName } from './expr.js';
import { AXES, STANDARD_PLANES, frameMatrix, mirrorMatrix, rotationMatrix, sketchLoops, v3, offsetFrame } from './geom.js';
import { UNITS } from './util.js';
import { CONSTRAINTS, constraintsOf, solveSketch } from './sketchsolve.js';

let kernelPromise = null;

/** The geometry kernel (loaded once). */
export function loadKernel() {
  if (!kernelPromise) {
    kernelPromise = import('/lib/manifold/manifold.js').then(async m => {
      const wasm = await m.default();
      wasm.setup();
      return wasm;
    });
  }
  return kernelPromise;
}

/** The colours new parts get, one after the other (soft, readable on light and dark backgrounds). */
export const PART_COLORS = ['#9fb3c8', '#c8a882', '#9cc49a', '#d39a9a', '#ab9fd8', '#8ec6c8', '#d6c27a', '#b8b8b8'];

/** The kinds of features and their default parameters. */
export const FEATURES = {
  sketch: { icon: 'sketch', params: () => ({ plane: { kind: 'std', name: 'top' }, entities: [] }) },
  plane: { icon: 'plane', params: () => ({ base: { kind: 'std', name: 'top' }, offset: '10', flip: false }) },
  extrude: { icon: 'extrude', params: () => ({ sketch: null, profiles: null, depth: '10', end: 'blind', flip: false, op: 'new', scope: null }) },
  revolve: { icon: 'revolve', params: () => ({ sketch: null, profiles: null, axis: 'y', angle: '360', symmetric: false, flip: false, op: 'new', scope: null }) },
  boolean: { icon: 'boolean', params: () => ({ op: 'union', targets: [], tools: [], keep: false }) },
  transform: { icon: 'move', params: () => ({ parts: [], dx: '0', dy: '0', dz: '0', axis: 'z', angle: '0', copy: false }) },
  mirror: { icon: 'mirror', params: () => ({ parts: [], plane: { kind: 'std', name: 'right' }, merge: true }) },
  lpattern: { icon: 'pattern-linear', params: () => ({ parts: [], dir: 'x', flip: false, distance: '20', count: '3', merge: false }) },
  cpattern: { icon: 'pattern-circular', params: () => ({ parts: [], axis: 'z', count: '6', angle: '360', merge: false }) },
  split: { icon: 'split', params: () => ({ parts: [], plane: { kind: 'std', name: 'top' }, keep: 'both' }) },
  deletepart: { icon: 'delete-part', params: () => ({ parts: [] }) },
  variable: { icon: 'variable', params: () => ({ name: '', value: '10 mm' }) },
};

class FeatureError extends Error {
  constructor(key, ...args) { super(key); this.key = key; this.args = args; }
}

/** Runs the features; returns the result (free it with dispose when it is replaced). */
export function regenerate(kernel, content, units = 'mm') {
  const { CrossSection, Manifold } = kernel;
  const arena = [];
  const keep = obj => { arena.push(obj); return obj; };
  const unit = UNITS[units] || 1;

  const ctx = {
    parts: [],               // { id, manifold, created }
    sketches: new Map(),     // fid -> { frame, entities, loops }
    planes: new Map(),       // fid -> { frame }
    variables: {},
    status: {},
    created: 0,
    used: new Set(),         // sketches used by a later feature
  };

  const features = content.features || [];
  const rollback = Number.isInteger(content.rollback) ? content.rollback : features.length;

  const len = text => {
    try { return evalLength(text, ctx.variables, unit); } catch (e) { throw exprFail(e); }
  };
  const ang = text => {
    try { return evalAngle(text, ctx.variables); } catch (e) { throw exprFail(e); }
  };
  const num = text => {
    try { return evalNumber(text, ctx.variables); } catch (e) { throw exprFail(e); }
  };
  const exprFail = e => {
    if (!(e instanceof ExprError)) return e;
    const [key, ...args] = errorKey(e);
    return new FeatureError(key, ...args);
  };

  const plane = ref => {
    if (!ref) throw new FeatureError('Feature.NoPlane');
    if (ref.kind === 'std' && STANDARD_PLANES[ref.name]) return STANDARD_PLANES[ref.name];
    if (ref.kind === 'plane') { const p = ctx.planes.get(ref.id); if (!p) throw new FeatureError('Feature.MissingPlane'); return p.frame; }
    if (ref.kind === 'face' && ref.frame) return ref.frame;
    throw new FeatureError('Feature.NoPlane');
  };

  const findParts = ids => {
    const found = (ids || []).map(id => ctx.parts.find(p => p.id === id)).filter(Boolean);
    return found;
  };

  const newPart = (id, manifold) => {
    ctx.created++;
    ctx.parts.push({ id, manifold, created: ctx.created });
  };

  const removePart = part => { ctx.parts = ctx.parts.filter(p => p !== part); };

  const boxesTouch = (a, b) => {
    const A = a.boundingBox(), B = b.boundingBox();
    const eps = 1e-6;
    for (let i = 0; i < 3; i++) {
      if (A.max[i] < B.min[i] - eps || B.max[i] < A.min[i] - eps) return false;
    }
    return true;
  };

  /** Puts a new body into the Part Studio the way the operation says. */
  const apply = (fid, body, op, scope) => {
    if (body.isEmpty()) throw new FeatureError('Feature.EmptyBody');
    const targets = scope && scope.length ? findParts(scope) : ctx.parts.slice();
    if (op === 'new' || (op === 'add' && !targets.some(p => boxesTouch(p.manifold, body)))) {
      const pieces = body.decompose().map(keep);
      if (pieces.length === 1) newPart(fid, pieces[0]);
      else pieces.forEach((piece, i) => newPart(`${fid}.${i}`, piece));
      return;
    }
    if (op === 'add') {
      const touching = targets.filter(p => boxesTouch(p.manifold, body));
      const merged = keep(Manifold.union([...touching.map(p => p.manifold), body]));
      touching[0].manifold = merged;
      touching.slice(1).forEach(removePart);
      return;
    }
    let changed = 0;
    for (const p of targets) {
      if (!boxesTouch(p.manifold, body)) {
        if (op === 'intersect') { removePart(p); changed++; }
        continue;
      }
      const next = keep(op === 'remove' ? p.manifold.subtract(body) : p.manifold.intersect(body));
      changed++;
      if (next.isEmpty()) removePart(p);
      else p.manifold = next;
    }
    if (!changed) throw new FeatureError(op === 'remove' ? 'Feature.NothingToRemove' : 'Feature.NothingToIntersect');
  };

  /** The cross-section of the chosen profiles of a sketch, in the coordinates of the sketch. */
  const section = (sketchId, profiles, map) => {
    const sketch = ctx.sketches.get(sketchId);
    if (!sketch) throw new FeatureError(sketchId ? 'Feature.MissingSketch' : 'Feature.NoSketch');
    ctx.used.add(sketchId);
    let loops = sketch.loops;
    if (profiles && profiles.length) loops = loops.filter(l => profiles.includes(l.key));
    if (!loops.length) throw new FeatureError('Feature.NoProfile');
    const contours = loops.map(l => (map ? l.points.map(map) : l.points));
    const cs = keep(new CrossSection(contours, 'EvenOdd'));
    if (cs.isEmpty()) throw new FeatureError('Feature.NoProfile');
    return { cs, sketch };
  };

  const extent = () => {
    let size = 100;
    for (const p of ctx.parts) {
      const b = p.manifold.boundingBox();
      for (let i = 0; i < 3; i++) size = Math.max(size, Math.abs(b.min[i]), Math.abs(b.max[i]));
    }
    return size * 4 + 1000;
  };

  const run = {
    sketch(f) {
      const frame = plane(f.params.plane);
      // the constraints and dimensions drive the geometry: values are expressions (variables before the sketch count)
      const cons = constraintsOf(f.params);
      for (const c of cons) if (CONSTRAINTS[c.type]?.dimension) (CONSTRAINTS[c.type].angle ? ang : len)(c.value);
      const solved = solveSketch(f.params.entities || [], cons, c => (CONSTRAINTS[c.type]?.angle ? ang(c.value) : len(c.value)), { analyse: cons.length > 0 });
      const entities = solved.entities;
      ctx.sketches.set(f.id, { frame, entities, loops: sketchLoops(entities) });
      const a = solved.analysis;
      if (a && (a.conflicts.length || a.errors.length)) return { state: 'warn', key: 'Feature.SketchConflict', args: [a.conflicts.length + a.errors.length] };
    },

    plane(f) {
      const base = plane(f.params.base);
      ctx.planes.set(f.id, { frame: offsetFrame(base, len(f.params.offset), !!f.params.flip) });
    },

    variable(f) {
      const name = (f.params.name || '').trim();
      if (!isVariableName(name)) throw new FeatureError('Feature.VariableName');
      try { ctx.variables[name] = evalVariable(f.params.value, ctx.variables); } catch (e) { throw exprFail(e); }
    },

    extrude(f) {
      const p = f.params;
      const { cs, sketch } = section(p.sketch, p.profiles);
      let depth = p.end === 'through' ? extent() : len(p.depth);
      if (!(depth > 0)) throw new FeatureError('Feature.DepthPositive');
      let body = keep(cs.extrude(depth));
      if (p.end === 'symmetric' || p.end === 'through') body = keep(body.translate([0, 0, -depth / 2]));
      else if (p.flip) body = keep(body.translate([0, 0, -depth]));
      body = keep(body.transform(frameMatrix(sketch.frame)));
      apply(f.id, body, p.op || 'new', p.scope);
    },

    revolve(f) {
      const p = f.params;
      const sketch = ctx.sketches.get(p.sketch);
      if (!sketch) throw new FeatureError(p.sketch ? 'Feature.MissingSketch' : 'Feature.NoSketch');
      // the axis in the sketch: its x or y axis, or a line of the sketch
      let a = [0, 0], d = [0, 1];
      if (p.axis === 'x') d = [1, 0];
      else if (p.axis !== 'y') {
        const line = sketch.entities.find(e => e.id === p.axis && e.t === 'line');
        if (!line) throw new FeatureError('Feature.NoAxis');
        a = line.a;
        const l = Math.hypot(line.b[0] - line.a[0], line.b[1] - line.a[1]);
        if (l < 1e-9) throw new FeatureError('Feature.NoAxis');
        d = [(line.b[0] - line.a[0]) / l, (line.b[1] - line.a[1]) / l];
      }
      let perp = [-d[1], d[0]];
      // the side of the profile: the revolve takes the half on the positive side of the axis
      const chosen = sketch.loops.filter(l => !p.profiles || !p.profiles.length || p.profiles.includes(l.key));
      const pts = chosen.flatMap(l => l.points);
      const side = pts.reduce((s, q) => s + (q[0] - a[0]) * perp[0] + (q[1] - a[1]) * perp[1], 0);
      if (side < 0) perp = [-perp[0], -perp[1]];
      const map = q => [(q[0] - a[0]) * perp[0] + (q[1] - a[1]) * perp[1], (q[0] - a[0]) * d[0] + (q[1] - a[1]) * d[1]];
      const { cs } = section(p.sketch, p.profiles, map);
      const angle = Math.min(360, Math.abs(ang(p.angle)));
      if (!(angle > 0)) throw new FeatureError('Feature.AnglePositive');
      const segments = Math.max(8, Math.round(72 * angle / 360));
      let body = keep(cs.revolve(segments, angle));
      if (p.symmetric) body = keep(body.rotate([0, 0, -angle / 2]));
      else if (p.flip) body = keep(body.rotate([0, 0, -angle]));
      const f3 = sketch.frame;
      const dir2 = v => v3.add(v3.scale(f3.x, v[0]), v3.scale(f3.y, v[1]));
      const lx = v3.norm(dir2(perp)), lz = v3.norm(dir2(d)), ly = v3.cross(lz, lx);
      const origin = v3.add(f3.o, dir2(a));
      body = keep(body.transform([lx[0], lx[1], lx[2], 0, ly[0], ly[1], ly[2], 0, lz[0], lz[1], lz[2], 0, origin[0], origin[1], origin[2], 1]));
      apply(f.id, body, p.op || 'new', p.scope);
    },

    boolean(f) {
      const p = f.params;
      const targets = findParts(p.targets);
      const tools = findParts(p.tools).filter(t => !targets.includes(t));
      if (!targets.length) throw new FeatureError('Feature.NoTargets');
      if (p.op === 'union') {
        const all = [...targets, ...tools];
        if (all.length < 2) throw new FeatureError('Feature.TwoParts');
        targets[0].manifold = keep(Manifold.union(all.map(x => x.manifold)));
        all.slice(1).forEach(x => { if (targets.includes(x) || !p.keep) removePart(x); });
        return;
      }
      if (!tools.length) throw new FeatureError('Feature.NoTools');
      const tool = keep(Manifold.union(tools.map(x => x.manifold)));
      for (const target of targets) {
        const next = keep(p.op === 'intersect' ? target.manifold.intersect(tool) : target.manifold.subtract(tool));
        if (next.isEmpty()) removePart(target);
        else target.manifold = next;
      }
      if (!p.keep) tools.forEach(removePart);
    },

    transform(f) {
      const p = f.params;
      const parts = findParts(p.parts);
      if (!parts.length) throw new FeatureError('Feature.NoParts');
      const angle = ang(p.angle || '0');
      const move = [len(p.dx || '0'), len(p.dy || '0'), len(p.dz || '0')];
      parts.forEach((part, i) => {
        let m = part.manifold;
        if (angle) m = keep(m.transform(rotationMatrix(AXES[p.axis] || AXES.z, angle)));
        m = keep(m.translate(move));
        if (p.copy) newPart(`${f.id}.${i}`, m);
        else part.manifold = m;
      });
    },

    mirror(f) {
      const p = f.params;
      const parts = findParts(p.parts);
      if (!parts.length) throw new FeatureError('Feature.NoParts');
      const frame = plane(p.plane);
      const matrix = mirrorMatrix(frame.o, frame.n);
      parts.forEach((part, i) => {
        const copy = keep(part.manifold.transform(matrix));
        if (p.merge) part.manifold = keep(Manifold.union(part.manifold, copy));
        else newPart(`${f.id}.${i}`, copy);
      });
    },

    lpattern(f) {
      const p = f.params;
      const parts = findParts(p.parts);
      if (!parts.length) throw new FeatureError('Feature.NoParts');
      const count = Math.round(num(p.count));
      if (count < 2 || count > 200) throw new FeatureError('Feature.CountRange', 2, 200);
      const step = len(p.distance);
      const dir = v3.scale(AXES[p.dir] || AXES.x, p.flip ? -step : step);
      parts.forEach((part, i) => {
        const copies = [];
        for (let k = 1; k < count; k++) copies.push(keep(part.manifold.translate(v3.scale(dir, k))));
        if (p.merge) part.manifold = keep(Manifold.union([part.manifold, ...copies]));
        else copies.forEach((c, k) => newPart(`${f.id}.${i}.${k + 1}`, c));
      });
    },

    cpattern(f) {
      const p = f.params;
      const parts = findParts(p.parts);
      if (!parts.length) throw new FeatureError('Feature.NoParts');
      const count = Math.round(num(p.count));
      if (count < 2 || count > 200) throw new FeatureError('Feature.CountRange', 2, 200);
      const total = ang(p.angle || '360');
      const full = Math.abs(Math.abs(total) - 360) < 1e-9;
      const step = full ? total / count : total / (count - 1);
      parts.forEach((part, i) => {
        const copies = [];
        for (let k = 1; k < count; k++) copies.push(keep(part.manifold.transform(rotationMatrix(AXES[p.axis] || AXES.z, step * k))));
        if (p.merge) part.manifold = keep(Manifold.union([part.manifold, ...copies]));
        else copies.forEach((c, k) => newPart(`${f.id}.${i}.${k + 1}`, c));
      });
    },

    split(f) {
      const p = f.params;
      const parts = findParts(p.parts);
      if (!parts.length) throw new FeatureError('Feature.NoParts');
      const frame = plane(p.plane);
      let cut = 0;
      for (const part of parts) {
        const [above, below] = part.manifold.splitByPlane(frame.n, v3.dot(frame.n, frame.o));
        keep(above); keep(below);
        if (above.isEmpty() || below.isEmpty()) continue;
        cut++;
        if (p.keep === 'front') part.manifold = above;
        else if (p.keep === 'back') part.manifold = below;
        else { part.manifold = above; newPart(`${part.id}~${f.id}`, below); }
      }
      if (!cut) throw new FeatureError('Feature.NothingToSplit');
    },

    deletepart(f) {
      const parts = findParts(f.params.parts);
      if (!parts.length) throw new FeatureError('Feature.NoParts');
      parts.forEach(removePart);
    },
  };

  features.forEach((f, index) => {
    if (index >= rollback) { ctx.status[f.id] = { state: 'rolled' }; return; }
    if (f.suppressed) { ctx.status[f.id] = { state: 'suppressed' }; return; }
    const step = run[f.type];
    if (!step) { ctx.status[f.id] = { state: 'error', key: 'Feature.Unknown' }; return; }
    try {
      const result = step(f);
      ctx.status[f.id] = result?.state ? result : { state: 'ok' };
    } catch (e) {
      if (e instanceof FeatureError) ctx.status[f.id] = { state: 'error', key: e.key, args: e.args };
      else { console.warn('MatShape: feature failed', f, e); ctx.status[f.id] = { state: 'error', key: 'Feature.Failed' }; }
    }
  });

  // the parts with their names, colours and meshes
  const meta = content.parts || {};
  const parts = ctx.parts.map((p, i) => {
    const info = meta[p.id] || {};
    return {
      id: p.id,
      name: info.name || null,
      number: p.created,
      color: info.color || PART_COLORS[(p.created - 1) % PART_COLORS.length],
      manifold: p.manifold,
      mesh: meshOf(p.manifold),
      index: i,
    };
  });

  const sketches = [];
  ctx.sketches.forEach((s, fid) => sketches.push({ fid, ...s, used: ctx.used.has(fid) }));
  const planes = [];
  ctx.planes.forEach((s, fid) => planes.push({ fid, ...s }));

  return { parts, sketches, planes, variables: ctx.variables, status: ctx.status, arena, rollback };
}

/** A triangle mesh for drawing and picking: positions (3 per corner, 3 corners per triangle) and the face id of every triangle. */
function meshOf(manifold) {
  const mesh = manifold.getMesh();
  const props = mesh.vertProperties, tris = mesh.triVerts, np = mesh.numProp;
  const count = tris.length / 3;
  const positions = new Float32Array(count * 9);
  for (let t = 0; t < count; t++) {
    for (let c = 0; c < 3; c++) {
      const v = tris[t * 3 + c];
      positions[t * 9 + c * 3] = props[v * np];
      positions[t * 9 + c * 3 + 1] = props[v * np + 1];
      positions[t * 9 + c * 3 + 2] = props[v * np + 2];
    }
  }
  const faceIds = mesh.faceID && mesh.faceID.length === count ? Uint32Array.from(mesh.faceID) : new Uint32Array(count);
  return { positions, faceIds, triangles: count };
}

/** Frees everything the kernel made for a result. */
export function dispose(result) {
  if (!result) return;
  for (const obj of result.arena) {
    try { obj.delete(); } catch { /* freed already */ }
  }
  result.arena.length = 0;
}

/** Volume, surface and bounding box of a part (mm³, mm², mm). */
export function properties(part) {
  const box = part.manifold.boundingBox();
  return { volume: part.manifold.volume(), area: part.manifold.surfaceArea(), box };
}

/** The ids of the parts a feature refers to (for the dialogs and the checks after a part is gone). */
export function partRefs(feature) {
  const p = feature.params || {};
  return [...(p.parts || []), ...(p.targets || []), ...(p.tools || []), ...(p.scope || [])];
}
