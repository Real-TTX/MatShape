/* MatShape – the parametric model: the list of features is run from the top (the "regeneration") and gives the parts, the sketches, the planes and the variables.
   The solid geometry is Manifold (WebAssembly, robust booleans); every object it makes lives in an "arena" that is freed when the next result replaces it.
   A feature that fails gets an error and is left out; the ones after it still run (they may fail too when they needed it). */

import { evalAngle, evalLength, evalNumber, evalVariable, errorKey, ExprError, isVariableName } from './expr.js';
import { AXES, STANDARD_PLANES, distToEntity, distToSegment, entityPolyline, frameMatrix, mirrorMatrix, polygonPoints, rectPoints, rotationMatrix, sketchLoops, toLocal, toWorld, v3, offsetFrame } from './geom.js';
import { UNITS } from './util.js';
import { CONSTRAINTS, constraintsOf, solveSketch } from './sketchsolve.js';
import { distToSegment3, topology } from './topo.js';
import { blendTools } from './blend.js';
import { unpackArray } from './step.js';
import { axisOfFace, holeProfile, loftMesh, loftRings, offsetVertices, pathFrames, sweepMesh, threadTool } from './solids.js';
import { figureMeshes } from './figure.js';

/** The face numbers the model gives (every triangle carries one); smaller numbers are ones the kernel made itself. */
export const FACE_BASE = 1 << 20;
/** Edges flatter than this (radians between the normals) are tangent edges: they cannot be rounded and are left out of drawings. */
export const TANGENT = 0.05;

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
  // edges: [{ part, faces: [face, face], at }] an edge (by the names of its two faces, at = where it was picked), { part, face } every edge of a face, { part } every edge of a part
  fillet: { icon: 'fillet', params: () => ({ edges: [], radius: '2' }) },
  chamfer: { icon: 'chamfer', params: () => ({ edges: [], mode: 'equal', distance: '1', distance2: '2', flip: false }) },
  // hole: at every point (and circle centre) of a sketch, into the material (against the normal of the sketch plane)
  hole: { icon: 'hole', params: () => ({ sketch: null, kind: 'simple', diameter: '6', end: 'through', depth: '10', cbDiameter: '11', cbDepth: '6', csDiameter: '12', csAngle: '90', tipAngle: '118', flip: false, thread: false, pitch: '1', scope: null }) },
  // shell: faces (refs like the edges of a fillet: { part, face }) are opened, the rest becomes a wall; { part } alone: a closed hollow part
  shell: { icon: 'shell', params: () => ({ faces: [], thickness: '2' }) },
  rib: { icon: 'rib', params: () => ({ sketch: null, thickness: '3', flip: false, scope: null }) },
  sweep: { icon: 'sweep', params: () => ({ sketch: null, profiles: null, path: null, op: 'new', scope: null }) },
  loft: { icon: 'loft', params: () => ({ sketches: [], op: 'new', scope: null }) },
  draft: { icon: 'draft', params: () => ({ faces: [], neutral: { kind: 'std', name: 'top' }, angle: '3', flip: false }) },
  thread: { icon: 'thread', params: () => ({ faces: [], pitch: '1.5', depth: '', length: '', flip: false, left: false }) },
  // import: bodies of a STEP, IGES, BREP or STL file or of the 3D generation, kept as meshes (base64 of the arrays: p positions, i indices, f the face of the source
  // per triangle; kept: the faces are final, also a single one)
  import: { icon: 'upload', params: () => ({ file: '', bodies: [] }) },
  // figure: a free form of building blocks that melt into each other (figure.js); each group is a part in its colour
  figure: { icon: 'figure', params: () => ({ scale: '1', detail: 'normal', flat: true, parts: [{ name: 'Figure', color: '#3cb764', smooth: 3, blocks: [{ t: 'ellipsoid', c: [0, 0, 14], r: [10, 8, 14] }, { t: 'sphere', c: [0, -1, 33], r: 8 }] }] }) },
};

class FeatureError extends Error {
  constructor(key, ...args) { super(key); this.key = key; this.args = args; }
}

/** Runs the features; returns the result (free it with dispose when it is replaced). */
export function regenerate(kernel, content, units = 'mm') {
  const { CrossSection, Manifold, Mesh } = kernel;
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
    faceKeys: [],            // face number - FACE_BASE -> the name of the face
    faceNums: new Map(),     // the name of a face -> its number
  };

  // ---- the names of the faces: every triangle of a new body is given the number of its face; the kernel keeps them through all operations
  const faceNum = key => {
    let n = ctx.faceNums.get(key);
    if (n === undefined) { n = FACE_BASE + ctx.faceKeys.length; ctx.faceKeys.push(key); ctx.faceNums.set(key, n); }
    return n;
  };
  const keyOf = n => (n >= FACE_BASE ? ctx.faceKeys[n - FACE_BASE] : `?${n}`);
  /** A copy of a body whose triangles carry the face numbers labelOf(centre, normal, number before) names (null keeps the number). */
  const labelled = (manifold, labelOf) => {
    const mesh = manifold.getMesh();
    const np = mesh.numProp, vp = mesh.vertProperties, tv = mesh.triVerts, before = mesh.faceID;
    const ids = new Uint32Array(tv.length / 3);
    for (let t = 0; t < ids.length; t++) {
      const a = tv[t * 3] * np, b = tv[t * 3 + 1] * np, c = tv[t * 3 + 2] * np;
      const A = [vp[a], vp[a + 1], vp[a + 2]], B = [vp[b], vp[b + 1], vp[b + 2]], C = [vp[c], vp[c + 1], vp[c + 2]];
      const n = v3.norm(v3.cross(v3.sub(B, A), v3.sub(C, A)));
      const key = labelOf([(A[0] + B[0] + C[0]) / 3, (A[1] + B[1] + C[1]) / 3, (A[2] + B[2] + C[2]) / 3], n, before?.[t] ?? 0);
      ids[t] = key === null ? before?.[t] ?? 0 : faceNum(key);
    }
    const options = { numProp: np, vertProperties: vp, triVerts: tv, faceID: ids };
    if (mesh.mergeFromVert?.length) { options.mergeFromVert = mesh.mergeFromVert; options.mergeToVert = mesh.mergeToVert; }
    return keep(new Manifold(new Mesh(options)));
  };
  /** The face of a side of an extrude or revolve: the sketch entity (a side of a rectangle or polygon) the point is next to. */
  const sideOf = (entities, q) => {
    let best = Infinity, key = '';
    for (const e of entities) {
      if (e.t === 'rect' || e.t === 'polygon') {
        const pts = e.t === 'rect' ? rectPoints(e) : polygonPoints(e);
        pts.forEach((p, k) => { const d = distToSegment(q, p, pts[(k + 1) % pts.length]); if (d < best) { best = d; key = `${e.id}.${k}`; } });
      } else {
        const d = distToEntity(q, e);
        if (d < best) { best = d; key = e.id; }
      }
    }
    return key;
  };
  const profileEntities = sketch => sketch.entities.filter(e => !e.cons && e.t !== 'point');

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

  // info: the name and colour a feature gives its part (a group of a figure), used unless the person gave their own
  const newPart = (id, manifold, info = null) => {
    ctx.created++;
    ctx.parts.push({ id, manifold, created: ctx.created, info });
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
      // the faces: "start" lies on the sketch plane (or below it), "end" opposite, a side is named after its sketch entity
      const flipped = p.end !== 'symmetric' && p.end !== 'through' && !!p.flip;
      const sides = profileEntities(sketch);
      let body = labelled(keep(cs.extrude(depth)), (c, n) => (Math.abs(n[2]) > 0.999 ? `${f.id}:${(n[2] < 0) !== flipped ? 'start' : 'end'}` : `${f.id}:${sideOf(sides, c)}`));
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
      // the faces: a side is named after the sketch entity it was turned from; a revolve of less than a full turn has a "start" and an "end"
      const sides = profileEntities(sketch), partial = angle < 360 - 1e-9;
      let body = labelled(keep(cs.revolve(segments, angle)), (c, n) => {
        const th = Math.atan2(c[1], c[0]);
        if (partial && Math.abs(n[0] * -Math.sin(th) + n[1] * Math.cos(th)) > 0.999) return `${f.id}:${th < (angle * Math.PI / 180) / 2 ? 'start' : 'end'}`;
        const r = Math.hypot(c[0], c[1]);
        return `${f.id}:${sideOf(sides, [a[0] + perp[0] * r + d[0] * c[2], a[1] + perp[1] * r + d[1] * c[2]])}`;
      });
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
        let [above, below] = part.manifold.splitByPlane(frame.n, v3.dot(frame.n, frame.o));
        keep(above); keep(below);
        if (above.isEmpty() || below.isEmpty()) continue;
        // the new faces of the cut get a name of their own
        const cut = (c, n, before) => (before >= FACE_BASE ? null : `${f.id}:cut`);
        above = labelled(above, cut);
        below = labelled(below, cut);
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

    fillet(f) { return blend(f); },

    import(f) {
      const bodies = Array.isArray(f.params.bodies) ? f.params.bodies : [];
      if (!bodies.length) throw new FeatureError('Feature.ImportEmpty');
      let made = 0, failed = 0;
      bodies.forEach((b, k) => {
        const mesh = new Mesh({ numProp: 3, vertProperties: unpackArray(b.p, Float32Array), triVerts: unpackArray(b.i, Uint32Array) });
        const faces = b.f ? unpackArray(b.f, Int32Array) : null;
        mesh.faceID = Uint32Array.from({ length: mesh.triVerts.length / 3 }, (_, t) => faceNum(`${f.id}:${k}.${faces ? faces[t] : 0}`));
        // the corners of the faces of the file are welded into one closed body
        mesh.merge();
        let m = keep(new Manifold(mesh));
        if (m.status() !== 'NoError' || m.isEmpty()) { failed++; return; }
        // a file without faces (STL): the faces are the regions between sharp edges (more than 20°), so that edges can be picked and rounded;
        // a generated figure (meshgen.js) brings its faces along and keeps them, even a single one
        if (!faces || (!b.kept && new Set(faces).size < 2)) {
          const topo = topology(m.getMesh()), group = new Int32Array(topo.numTri).fill(-1), limit = Math.cos(20 * Math.PI / 180);
          let groups = 0;
          for (let s = 0; s < topo.numTri; s++) {
            if (group[s] >= 0) continue;
            group[s] = groups;
            const stack = [s];
            while (stack.length) {
              const t = stack.pop(), n = topo.normal(t);
              for (let c = 0; c < 3; c++) {
                const u = topo.half.get(topo.tv[t * 3 + (c + 1) % 3] * topo.numVert + topo.tv[t * 3 + c]);
                if (u === undefined || group[u] >= 0 || v3.dot(n, topo.normal(u)) < limit) continue;
                group[u] = groups;
                stack.push(u);
              }
            }
            groups++;
          }
          const ids = Uint32Array.from(group, g => faceNum(`${f.id}:${k}.${g}`));
          m = keep(new Manifold(new Mesh({ numProp: 3, vertProperties: topo.vp, triVerts: topo.tv, faceID: ids })));
        }
        newPart(bodies.length > 1 ? `${f.id}.${k}` : f.id, m);
        made++;
      });
      if (!made) throw new FeatureError('Feature.ImportNotSolid');
      if (failed) return { state: 'warn', key: 'Feature.ImportSomeOpen', args: [failed] };
    },

    figure(f) {
      const p = f.params;
      const scale = num(p.scale || '1');
      if (!(scale > 0)) throw new FeatureError('Feature.FigureScale');
      let groups;
      try { groups = figureMeshes(kernel, p, scale); } catch (e) { if (e?.key) throw new FeatureError(e.key, ...(e.args || [])); throw e; }
      const made = groups.filter(g => g.mesh).map(g => {
        const faceID = new Uint32Array(g.mesh.triVerts.length / 3).fill(faceNum(`${f.id}:${g.index}`));
        const m = keep(new Manifold(new Mesh({ numProp: g.mesh.numProp, vertProperties: g.mesh.vertProperties, triVerts: g.mesh.triVerts, faceID })));
        return { g, m, box: m.boundingBox() };
      });
      if (!made.length) throw new FeatureError('Feature.FigureEmpty');
      // a later group is cut out of the earlier ones it reaches into (an eye out of the head): separate parts only touch
      const meets = (a, b) => [0, 1, 2].every(k => a.min[k] < b.max[k] && b.min[k] < a.max[k]);
      made.forEach((x, i) => {
        const later = made.slice(i + 1).filter(y => meets(x.box, y.box)).map(y => y.m);
        if (later.length) x.m = keep(x.m.subtract(later.length > 1 ? keep(Manifold.union(later)) : later[0]));
      });
      // flat underneath (it stands, and prints without supports): what melted below the Top plane is cut off
      if (p.flat !== false) made.forEach(x => { x.m = keep(x.m.trimByPlane([0, 0, 1], 0)); });
      const several = made.length > 1;
      let shown = 0;
      made.forEach(({ g, m }) => { if (!m.isEmpty()) { newPart(several ? `${f.id}.${g.index}` : f.id, m, { name: g.name, color: g.color }); shown++; } });
      if (shown < made.length) return { state: 'warn', key: 'Feature.FigureHidden', args: [made.length - shown] };
    },

    hole(f) {
      const p = f.params;
      const sketch = ctx.sketches.get(p.sketch);
      if (!sketch) throw new FeatureError(p.sketch ? 'Feature.MissingSketch' : 'Feature.NoSketch');
      ctx.used.add(p.sketch);
      const at = sketch.entities.filter(e => e.t === 'point' || e.t === 'circle').map(e => e.p || e.c);
      if (!at.length) throw new FeatureError('Feature.NoHolePoints');
      const r = len(p.diameter) / 2;
      if (!(r > 0)) throw new FeatureError('Feature.DiameterPositive');
      const through = p.end === 'through';
      const spec = { kind: p.kind || 'simple', r, through, depth: through ? extent() : len(p.depth), tipAngle: through ? 0 : ang(p.tipAngle || '118') };
      if (spec.kind === 'cbore') { spec.cbR = len(p.cbDiameter) / 2; spec.cbDepth = len(p.cbDepth); }
      if (spec.kind === 'csink') { spec.csR = len(p.csDiameter) / 2; spec.csAngle = ang(p.csAngle || '90'); }
      if (!through && !(spec.depth > 0)) throw new FeatureError('Feature.DepthPositive');
      const profile = holeProfile(spec);
      // the faces of the hole: named after the piece of the profile they were turned from
      const segName = (c) => {
        const q = [Math.hypot(c[0], c[1]), c[2]];
        let best = 0, bd = Infinity;
        profile.forEach((a, k) => { const d = distToSegment(q, a, profile[(k + 1) % profile.length]); if (d < bd) { bd = d; best = k; } });
        return `${f.id}:${best}`;
      };
      const tool = labelled(keep(new CrossSection([profile]).revolve(48, 360)), segName);
      const fr = sketch.frame, s = p.flip ? -1 : 1;
      const tools = at.map(q => {
        const o = toWorld(fr, q[0], q[1]);
        const x = v3.scale(fr.x, s), n = v3.scale(fr.n, s);
        return keep(tool.transform([x[0], x[1], x[2], 0, fr.y[0], fr.y[1], fr.y[2], 0, n[0], n[1], n[2], 0, o[0], o[1], o[2], 1]));
      });
      apply(f.id, keep(Manifold.union(tools)), 'remove', p.scope);
      // a tapped hole: the thread is cut into its wall (internal, 60°)
      if (p.thread) {
        const pitch = len(p.pitch);
        if (!(pitch > 0)) throw new FeatureError('Feature.PitchPositive');
        const reach = through ? extentOfParts(fr) : spec.depth;
        const threads = at.map(q => {
          const o = toWorld(fr, q[0], q[1]);
          const axis = { o, a: v3.scale(fr.n, -s), u: fr.x, v: v3.scale(fr.y, s), r, outward: false };
          return solidOf(threadTool(axis, { pitch, depth: 0.5413 * pitch, from: through ? -reach : 0, to: reach, left: false }), () => `${f.id}:thread`);
        });
        for (const part of (p.scope?.length ? findParts(p.scope) : ctx.parts)) {
          const next = keep(part.manifold.subtract(keep(Manifold.union(threads))));
          if (!next.isEmpty()) part.manifold = next;
        }
      }
    },

    shell(f) {
      const p = f.params;
      const t = len(p.thickness);
      if (!(t > 0)) throw new FeatureError('Feature.ThicknessPositive');
      const byPart = facesByPart(p.faces);
      if (!byPart.size) throw new FeatureError('Feature.NoFaces');
      for (const [part, open] of byPart) {
        const topo = topology(part.manifold.getMesh());
        const inner = offsetVertices(topo, face => (open.has(face) ? t : -t));
        const ids = Uint32Array.from(topo.fid, n => faceNum(`${f.id}:in:${keyOf(n)}`));
        const cavity = keep(new Manifold(new Mesh({ numProp: 3, vertProperties: inner, triVerts: topo.tv, faceID: ids })));
        if (cavity.status() !== 'NoError' || cavity.isEmpty()) throw new FeatureError('Feature.ShellFailed');
        const next = keep(part.manifold.subtract(cavity));
        if (next.isEmpty()) throw new FeatureError('Feature.ShellFailed');
        part.manifold = next;
      }
    },

    rib(f) {
      const p = f.params;
      const sketch = ctx.sketches.get(p.sketch);
      if (!sketch) throw new FeatureError(p.sketch ? 'Feature.MissingSketch' : 'Feature.NoSketch');
      ctx.used.add(p.sketch);
      const t = len(p.thickness);
      if (!(t > 0)) throw new FeatureError('Feature.ThicknessPositive');
      const targets = p.scope?.length ? findParts(p.scope) : ctx.parts.slice();
      if (!targets.length) throw new FeatureError('Feature.NoParts');
      // the region between the rib line and the parts: the side of the line towards the parts, in a slab as thick as the rib, within the hull of the parts
      const hull = keep(Manifold.hull(targets.map(x => x.manifold)));
      const L = extent();
      const regions = [];
      const slabOf = poly => keep(keep(keep(keep(new CrossSection([poly])).extrude(t)).translate([0, 0, -t / 2])).transform(frameMatrix(sketch.frame)));
      const ccw = poly => { let s = 0; poly.forEach((q, k) => { const w = poly[(k + 1) % poly.length]; s += q[0] * w[1] - w[0] * q[1]; }); return s < 0 ? poly.reverse() : poly; };
      const material = poly => { const m = keep(slabOf(ccw(poly.map(q => [...q]))).intersect(Manifold.union(targets.map(x => x.manifold)))); return m.volume(); };
      for (const e of sketch.entities.filter(x => !x.cons && x.t !== 'point')) {
        const pts = entityPolyline(e);
        for (let i = 1; i < pts.length; i++) {
          const a = pts[i - 1], b = pts[i], l = Math.hypot(b[0] - a[0], b[1] - a[1]);
          if (l < 1e-9) continue;
          const d = [(b[0] - a[0]) / l, (b[1] - a[1]) / l];
          const side = n => [[a[0] - d[0] * L, a[1] - d[1] * L], [b[0] + d[0] * L, b[1] + d[1] * L], [b[0] + d[0] * L + n[0] * L, b[1] + d[1] * L + n[1] * L], [a[0] - d[0] * L + n[0] * L, a[1] - d[1] * L + n[1] * L]];
          const n = [-d[1], d[0]], m = [d[1], -d[0]];
          let toward = material(side(n)) >= material(side(m)) ? n : m;
          if (p.flip) toward = toward === n ? m : n;
          regions.push(ccw(side(toward)));
        }
      }
      if (!regions.length) throw new FeatureError('Feature.NoRibCurve');
      let body = labelled(keep(Manifold.union(regions.map(slabOf))), () => `${f.id}:side`);
      body = keep(body.intersect(hull));
      apply(f.id, body, 'add', p.scope);
    },

    sweep(f) {
      const p = f.params;
      const { cs, sketch } = section(p.sketch, p.profiles);
      const pathSketch = ctx.sketches.get(p.path);
      if (!pathSketch) throw new FeatureError(p.path ? 'Feature.MissingSketch' : 'Feature.NoPath');
      ctx.used.add(p.path);
      const path = pathOf(pathSketch);
      if (!path) throw new FeatureError('Feature.NoPath');
      const frames = pathFrames(path.points, sketch.frame.x);
      const f0 = frames[0];
      const polygons = cs.toPolygons().map(l => l.map(q => [q[0], q[1]]));
      const loops = polygons.map(l => l.map(q => { const w = v3.sub(toWorld(sketch.frame, q[0], q[1]), f0.p); return [v3.dot(w, f0.n), v3.dot(w, f0.b), v3.dot(w, f0.t)]; }));
      const caps = path.closed ? null : kernel.triangulate(polygons, 1e-6).flat();
      const mesh = sweepMesh(frames, loops, caps, path.closed);
      const body = solidOf(mesh, (k, side) => `${f.id}:${side === -1 ? 'start' : side === -2 ? 'end' : 'side' + side}`);
      apply(f.id, body, p.op || 'new', p.scope);
    },

    loft(f) {
      const p = f.params;
      const ids = (p.sketches || []).filter(id => ctx.sketches.has(id));
      if (ids.length < 2) throw new FeatureError('Feature.LoftTwo');
      const profiles = ids.map(id => {
        ctx.used.add(id);
        const s = ctx.sketches.get(id);
        // the biggest closed profile of each sketch
        const loop = [...s.loops].sort((a, b) => Math.abs(areaOf(b.points)) - Math.abs(areaOf(a.points)))[0];
        if (!loop) throw new FeatureError('Feature.NoProfile');
        return { frame: s.frame, pts: loop.points.map(q => toWorld(s.frame, q[0], q[1])) };
      });
      const n = Math.min(240, Math.max(64, ...profiles.map(x => x.pts.length)));
      const rings = loftRings(profiles.map(x => x.pts), n);
      const cap = (ring, frame) => kernel.triangulate([ring.map(q => toLocal(frame, q))], 1e-6).flat();
      const mesh = loftMesh(rings, cap(rings[0], profiles[0].frame), cap(rings[rings.length - 1], profiles[profiles.length - 1].frame));
      const body = solidOf(mesh, (k, side) => `${f.id}:${side === -1 ? 'start' : side === -2 ? 'end' : 'side'}`);
      apply(f.id, body, p.op || 'new', p.scope);
    },

    draft(f) {
      const p = f.params;
      const byPart = facesByPart(p.faces);
      if (!byPart.size) throw new FeatureError('Feature.NoFaces');
      const neutral = plane(p.neutral);
      const pull = p.flip ? v3.scale(neutral.n, -1) : neutral.n;
      const k = Math.tan(ang(p.angle) * Math.PI / 180);
      for (const [part, faces] of byPart) {
        const topo = topology(part.manifold.getMesh());
        // a face is turned about the line where it meets the neutral plane: its points move inwards by their height times the tangent of the angle
        const moved = offsetVertices(topo, (face, q) => (faces.has(face) ? -v3.dot(v3.sub(q, neutral.o), pull) * k : 0));
        const m = keep(new Manifold(new Mesh({ numProp: 3, vertProperties: moved, triVerts: topo.tv, faceID: topo.fid })));
        if (m.status() !== 'NoError' || m.isEmpty()) throw new FeatureError('Feature.DraftFailed');
        part.manifold = m;
      }
    },

    thread(f) {
      const p = f.params;
      const byPart = facesByPart(p.faces);
      if (!byPart.size) throw new FeatureError('Feature.NoFaces');
      const pitch = len(p.pitch);
      if (!(pitch > 0)) throw new FeatureError('Feature.PitchPositive');
      for (const [part, faces] of byPart) {
        const topo = topology(part.manifold.getMesh());
        const tools = [];
        for (const face of faces) {
          const axis = axisOfFace(topo, face);
          if (!axis || !(axis.r > 0)) throw new FeatureError('Feature.NotRound');
          const depth = p.depth ? len(p.depth) : (axis.outward ? 0.6134 : 0.5413) * pitch;
          const reach = p.length ? Math.min(len(p.length), axis.z1 - axis.z0) : axis.z1 - axis.z0;
          const [from, to] = p.flip ? [axis.z1 - reach, axis.z1 + pitch] : [axis.z0 - pitch, axis.z0 + reach];
          tools.push(solidOf(threadTool(axis, { pitch, depth, from, to, left: !!p.left }), () => `${f.id}:thread`));
        }
        const next = keep(part.manifold.subtract(keep(Manifold.union(tools))));
        if (next.isEmpty()) throw new FeatureError('Feature.EmptyBody');
        part.manifold = next;
      }
    },
    chamfer(f) { return blend(f); },
  };

  /** Fillet / chamfer: the chosen edges are found again by the names of their faces, the tools of blend.js are cut away (outer edges) or added (inner edges). */
  const blend = f => {
    const p = f.params;
    const refs = Array.isArray(p.edges) ? p.edges.filter(r => r && typeof r === 'object') : [];
    if (!refs.length) throw new FeatureError('Feature.NoEdges');
    let spec;
    if (f.type === 'fillet') {
      const r = len(p.radius);
      if (!(r > 0)) throw new FeatureError('Feature.RadiusPositive');
      spec = { kind: 'fillet', r };
    } else {
      const d1 = len(p.distance), d2 = p.mode === 'two' ? len(p.distance2) : d1;
      if (!(d1 > 0) || !(d2 > 0)) throw new FeatureError('Feature.DistancePositive');
      // with two distances: the first goes to the face whose name comes first (the same face every time), "flip" swaps them
      spec = { kind: 'chamfer', d1, d2, firstFace: (a, b) => (keyOf(a) <= keyOf(b)) !== !!p.flip };
    }
    const topos = new Map();
    const topoOf = part => { if (!topos.has(part)) topos.set(part, topology(part.manifold.getMesh())); return topos.get(part); };
    const chosen = new Map();
    let missing = 0;
    for (const ref of refs) {
      let part = ctx.parts.find(x => x.id === ref.part);
      let edges = part ? edgesOf(topoOf(part), ref, part) : [];
      // the part may have another name now (a merge, a split): the faces tell where the edge is
      if (!edges.length && (ref.faces || ref.face)) {
        for (const other of ctx.parts) {
          if (other === part) continue;
          const found = edgesOf(topoOf(other), { ...ref, at: null, near: ref.at }, other);
          if (found.length) { part = other; edges = found; break; }
        }
      }
      if (!edges.length) { missing++; continue; }
      if (!chosen.has(part)) chosen.set(part, new Set());
      edges.forEach(e => chosen.get(part).add(e));
    }
    if (!chosen.size) throw new FeatureError('Feature.EdgesMissing', refs.length);
    let chain = 0, corner = 0;
    for (const [part, set] of chosen) {
      const tools = blendTools(topoOf(part), [...set], spec);
      if (tools.tooLarge) throw new FeatureError('Feature.BlendFailed');
      const other = faceNum(`${f.id}:x`);
      const solid = mesh => {
        const key = faceNum(`${f.id}:${chain++}`);
        const m = keep(new Manifold(new Mesh({ numProp: 3, vertProperties: mesh.vertProperties, triVerts: mesh.triVerts, faceID: mesh.faceID.map(x => (x === 1 ? key : other)) })));
        if (m.status() !== 'NoError' || m.isEmpty()) throw new FeatureError('Feature.BlendFailed');
        return m;
      };
      const cut = tools.cut.map(solid), fill = tools.add.map(solid);
      for (const c of tools.corners) {
        const box = labelled(keep(Manifold.hull(c.hull)), () => `${f.id}:x`);
        const ball = labelled(keep(Manifold.sphere(c.r, 72).translate(c.centre)), () => `${f.id}:c${corner}`);
        corner++;
        cut.push(keep(box.subtract(ball)));
      }
      let m = part.manifold;
      if (cut.length) m = keep(m.subtract(keep(Manifold.union(cut))));
      if (fill.length) m = keep(Manifold.union([m, ...fill]));
      if (m.isEmpty()) throw new FeatureError('Feature.EmptyBody');
      part.manifold = m;
    }
    if (missing) return { state: 'warn', key: 'Feature.EdgesMissing', args: [missing] };
  };

  /** A solid from a mesh of solids.js; nameOf(triangle, side) names its faces. */
  const solidOf = (mesh, nameOf) => {
    const ids = new Uint32Array(mesh.triVerts.length / 3);
    for (let t = 0; t < ids.length; t++) ids[t] = faceNum(nameOf(t, mesh.side?.[t]));
    const m = keep(new Manifold(new Mesh({ numProp: 3, vertProperties: mesh.vertProperties, triVerts: mesh.triVerts, faceID: ids })));
    if (m.status() !== 'NoError' || m.isEmpty()) throw new FeatureError('Feature.BodyFailed');
    return m;
  };

  /** Face references ({ part, face } or { part }) as the parts with the numbers of those faces (an empty set: the part as a whole). */
  const facesByPart = refs => {
    const out = new Map();
    for (const ref of Array.isArray(refs) ? refs : []) {
      const part = ctx.parts.find(x => x.id === ref?.part) || (ref?.face ? ctx.parts.find(x => x.manifold && hasFace(x, ref.face)) : null);
      if (!part) continue;
      if (!out.has(part)) out.set(part, new Set());
      if (ref.face && ctx.faceNums.has(ref.face)) out.get(part).add(ctx.faceNums.get(ref.face));
    }
    return out;
  };
  const hasFace = (part, name) => { const n = ctx.faceNums.get(name); return n !== undefined && part.manifold.getMesh().faceID?.includes(n); };

  /** The reach of the parts along the normal of a frame, both ways from it (for threads through all). */
  const extentOfParts = fr => {
    let r = 1;
    for (const x of ctx.parts) { const b = x.manifold.boundingBox(); for (let k = 0; k < 8; k++) { const c = [k & 1 ? b.max[0] : b.min[0], k & 2 ? b.max[1] : b.min[1], k & 4 ? b.max[2] : b.min[2]]; r = Math.max(r, Math.abs(v3.dot(v3.sub(c, fr.o), fr.n))); } }
    return r;
  };

  /** The path of a sweep: the curves of a sketch joined end to end, in the world: { points, closed } or null. */
  const pathOf = sketch => {
    const pieces = sketch.entities.filter(e => !e.cons && ['line', 'arc', 'spline'].includes(e.t)).map(e => entityPolyline(e));
    if (!pieces.length) return null;
    const same = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]) < 1e-6;
    // start at a free end (if there is one)
    const ends = pieces.flatMap(q => [q[0], q[q.length - 1]]);
    let first = pieces.findIndex(q => ends.filter(e => same(e, q[0])).length === 1);
    if (first < 0) first = 0;
    const used = new Set([first]);
    let pts = pieces[first].slice();
    for (;;) {
      const tail = pts[pts.length - 1];
      const k = pieces.findIndex((q, i) => !used.has(i) && (same(q[0], tail) || same(q[q.length - 1], tail)));
      if (k < 0) break;
      used.add(k);
      const q = same(pieces[k][0], tail) ? pieces[k] : pieces[k].slice().reverse();
      pts = pts.concat(q.slice(1));
    }
    const closed = pts.length > 3 && same(pts[0], pts[pts.length - 1]);
    if (closed) pts.pop();
    const out = [];
    for (const q of pts) if (!out.length || !same(out[out.length - 1], q)) out.push(q);
    return out.length >= 2 ? { points: out.map(q => toWorld(sketch.frame, q[0], q[1])), closed } : null;
  };
  const areaOf = pts => pts.reduce((s, q, i) => { const w = pts[(i + 1) % pts.length]; return s + q[0] * w[1] - w[0] * q[1]; }, 0) / 2;

  /** The edges of a part a reference means (see FEATURES.fillet). */
  const edgesOf = (topo, ref, part) => {
    const names = e => [keyOf(topo.fid[e.L]), keyOf(topo.fid[e.R])];
    const sharp = topo.edges.filter(e => e.angle > TANGENT);
    if (Array.isArray(ref.faces) && ref.faces.length === 2) {
      const [k1, k2] = ref.faces;
      let hits = sharp.filter(e => { const [a, b] = names(e); return (a === k1 && b === k2) || (a === k2 && b === k1); });
      // no edge between these faces any more: the nearest edge where it was picked (when it is close)
      if (!hits.length && ref.at) {
        const box = part.manifold.boundingBox();
        const tol = Math.max(0.5, 0.02 * Math.hypot(box.max[0] - box.min[0], box.max[1] - box.min[1], box.max[2] - box.min[2]));
        let best = null, dist = tol;
        for (const e of sharp) { const d = distToSegment3(ref.at, topo.P(e.a), topo.P(e.b)); if (d < dist) { dist = d; best = e; } }
        if (best) hits = sharp.filter(e => topo.fid[e.L] === topo.fid[best.L] && topo.fid[e.R] === topo.fid[best.R] || topo.fid[e.L] === topo.fid[best.R] && topo.fid[e.R] === topo.fid[best.L]);
      }
      return nearestGroup(topo, hits, ref.at || ref.near);
    }
    if (typeof ref.face === 'string') return sharp.filter(e => names(e).includes(ref.face));
    return sharp;
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
    // several bodies of one feature (<id>.<n>) or the other half of a split (<id>~<feature>) take the colour of the feature unless they have their own
    const own = meta[p.id] || {}, base = meta[String(p.id).split(/[.~]/)[0]] || {};
    const body = /\.(\d+)$/.exec(String(p.id));
    const info = { name: own.name || p.info?.name || (base.name && body ? `${base.name} ${Number(body[1]) + 1}` : null), color: own.color || p.info?.color || base.color };
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

  return { parts, sketches, planes, variables: ctx.variables, status: ctx.status, arena, rollback, faceKeys: ctx.faceKeys };
}

/** The matrix that takes world coordinates into the coordinates of a frame (x, y in the plane, z along its normal). */
function intoFrame(f) {
  return [f.x[0], f.y[0], f.n[0], 0, f.x[1], f.y[1], f.n[1], 0, f.x[2], f.y[2], f.n[2], 0, -v3.dot(f.x, f.o), -v3.dot(f.y, f.o), -v3.dot(f.n, f.o), 1];
}

/** The cut of parts by a plane: per part its outlines in the plane (2D loops in the coordinates of the frame) and triangles that fill them (world, with uv = the 2D point). */
export function sectionOf(kernel, parts, frame) {
  const m = intoFrame(frame);
  return parts.map(part => {
    const local = part.manifold.transform(m);
    const cs = local.slice(0);
    const polygons = cs.toPolygons().map(loop => loop.map(p => [p[0], p[1]]));
    cs.delete(); local.delete();
    const flat = polygons.flat();
    const triangles = [], uv = [];
    if (polygons.length) {
      for (const t of kernel.triangulate(polygons, 1e-6)) for (const i of t) { const [u, v] = flat[i]; triangles.push(...toWorld(frame, u, v)); uv.push(u, v); }
    }
    return { partId: part.id, color: part.color, polygons, triangles, uv };
  });
}

/** The outline of parts seen along the normal of a plane (their shadow on it), as 2D loops in the coordinates of the frame, one list per part. */
export function outlineOf(parts, frame) {
  const m = intoFrame(frame);
  return parts.map(part => {
    const local = part.manifold.transform(m);
    const cs = local.project();
    const polygons = cs.toPolygons().map(loop => loop.map(p => [p[0], p[1]]));
    cs.delete(); local.delete();
    return { partId: part.id, polygons };
  });
}

/** The name of a face number of a result ("<feature>:end", "<feature>:<entity>" …). */
export function faceKey(result, n) {
  return n >= FACE_BASE ? result?.faceKeys?.[n - FACE_BASE] ?? `?${n}` : `?${n}`;
}

/** Of edges that may lie apart (a face pair that meets twice, copies), the connected group nearest to a point. */
function nearestGroup(topo, edges, at) {
  if (edges.length < 2 || !at) return edges;
  const parent = new Map();
  const find = v => { while (parent.get(v) !== v) { parent.set(v, parent.get(parent.get(v))); v = parent.get(v); } return v; };
  for (const e of edges) for (const v of [e.a, e.b]) if (!parent.has(v)) parent.set(v, v);
  for (const e of edges) { const ra = find(e.a), rb = find(e.b); if (ra !== rb) parent.set(ra, rb); }
  const groups = new Map();
  for (const e of edges) { const r = find(e.a); if (!groups.has(r)) groups.set(r, []); groups.get(r).push(e); }
  if (groups.size < 2) return edges;
  let best = edges, dist = Infinity;
  for (const g of groups.values()) for (const e of g) { const d = distToSegment3(at, topo.P(e.a), topo.P(e.b)); if (d < dist) { dist = d; best = g; } }
  return best;
}

/** A triangle mesh for drawing and picking: positions (3 per corner, 3 corners per triangle), the face number of every triangle, and the edges between faces
    (pos: 2 points each, faces: the face numbers left and right, verts: the vertex numbers for chains, angle: between the normals, radians). */
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
  const topo = topology(mesh);
  const E = topo.edges.length;
  const edges = { pos: new Float32Array(E * 6), faces: new Uint32Array(E * 2), verts: new Uint32Array(E * 2), angle: new Float32Array(E), count: E };
  topo.edges.forEach((e, i) => {
    edges.pos.set([...topo.P(e.a), ...topo.P(e.b)], i * 6);
    edges.faces[i * 2] = faceIds[e.L]; edges.faces[i * 2 + 1] = faceIds[e.R];
    edges.verts[i * 2] = e.a; edges.verts[i * 2 + 1] = e.b;
    edges.angle[i] = e.angle;
  });
  return { positions, faceIds, triangles: count, edges };
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
/**
 * Separate parts that interpenetrate: [{ a, b, volume }] (part ids, mm³). Touching parts share no volume; a common volume that is tiny next to the parts (numerical noise
 * of faces that lie on each other) does not count. Only pairs whose boxes overlap are intersected, and at most `limit` parts are looked at (the kernel does the work).
 */
export function overlapsOf(parts, limit = 60) {
  const list = parts.slice(0, limit).map(p => ({ id: p.id, m: p.manifold, box: p.manifold.boundingBox(), v: p.manifold.volume() }));
  const found = [];
  for (let i = 0; i < list.length; i++) {
    for (let j = i + 1; j < list.length; j++) {
      const A = list[i].box, B = list[j].box;
      let apart = false;
      for (let k = 0; k < 3; k++) if (A.max[k] <= B.min[k] + 1e-6 || B.max[k] <= A.min[k] + 1e-6) apart = true;
      if (apart) continue;
      const both = list[i].m.intersect(list[j].m);
      const volume = both.volume();
      both.delete();
      if (volume > Math.max(0.01, 1e-6 * Math.min(list[i].v, list[j].v))) found.push({ a: list[i].id, b: list[j].id, volume });
    }
  }
  return found;
}

export function properties(part) {
  const box = part.manifold.boundingBox();
  return { volume: part.manifold.volume(), area: part.manifold.surfaceArea(), box };
}

/** The ids of the parts a feature refers to (for the dialogs and the checks after a part is gone). */
export function partRefs(feature) {
  const p = feature.params || {};
  return [...(p.parts || []), ...(p.targets || []), ...(p.tools || []), ...(p.scope || []), ...(Array.isArray(p.edges) ? p.edges.map(e => e?.part).filter(Boolean) : [])];
}
