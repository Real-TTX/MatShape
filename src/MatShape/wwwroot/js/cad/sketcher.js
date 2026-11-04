/* MatShape – the sketch editor. A sketch lies on a plane; its entities are lines, rectangles, circles, arcs, polygons and points in the coordinates of the plane (mm).
   Drawing snaps to the ends, centres and midpoints of what is there, to the grid, and keeps lines horizontal or vertical when they are nearly so.
   Ends that meet stay together when one of them is moved (the chains of a profile do not break). Every entity has its numbers in the panel (expressions allowed). */

import { applyDimensions, arcThrough, dimensionAnchor, distToEntity, ends, measureDimension, pointOf, sketchLoops, snapPoints, toLocal, toWorld } from './geom.js';
import { evalAngle, evalLength, evalNumber } from './expr.js';
import { clone, el, fmt, icon, t, uid, UNITS } from './util.js';

const SNAP_PX = 10;

export class Sketcher {
  constructor(viewport, panel, toolbar, callbacks) {
    this.vp = viewport;
    this.panel = panel;            // { root, title, body }
    this.toolbar = toolbar;
    this.cb = callbacks;           // { finish(entities), cancel(), status(text) }
    this.active = false;
    this.bind();
    viewport.on('render', () => this.placeLabels());
  }

  start({ name, frame, entities, dims, units, variables, polygonSides }) {
    this.active = true;
    this.name = name;
    this.frame = frame;
    this.entities = clone(entities || []);
    this.dims = clone(dims || []);
    this.dimFirst = null;
    this.units = units;
    this.unit = UNITS[units] || 1;
    this.variables = variables || {};
    this.selected = new Set();
    this.hover = null;
    this.tool = 'select';
    this.points = [];              // the clicks of the tool so far
    this.cursor = null;
    this.snap = null;
    this.history = [];
    this.future = [];
    this.polygonSides = polygonSides || 6;
    this.vp.navigationOnly = false;
    this.vp.normalTo(frame);
    setTimeout(() => this.vp.fit(true), 280);
    this.setTool('select');
    this.renderPanel();
    this.draw();
  }

  stop() {
    this.active = false;
    this.vp.navigationOnly = false;
    this.vp.setSketchOverlay(null);
    this.closeDimEditor();
    this.labels?.replaceChildren();
  }

  // ---- tools ---------------------------------------------------------------------------------------------------------------

  setTool(tool) {
    this.tool = tool;
    this.points = [];
    this.vp.navigationOnly = tool !== 'select' && tool !== 'dimension';
    this.dimFirst = null;
    this.closeDimEditor?.();
    this.toolbar.querySelectorAll('[data-sketch-tool]').forEach(b => b.setAttribute('aria-pressed', b.dataset.sketchTool === tool ? 'true' : 'false'));
    this.cb.status(t('Sketch.Hint.' + tool));
    this.draw();
  }

  remember() {
    this.history.push(this.snapshot());
    if (this.history.length > 100) this.history.shift();
    this.future = [];
  }

  undo() {
    if (!this.history.length) return;
    this.future.push(this.snapshot());
    this.restore(this.history.pop());
    this.selected.clear();
    this.renderPanel();
    this.draw();
  }

  redo() {
    if (!this.future.length) return;
    this.history.push(this.snapshot());
    this.restore(this.future.pop());
    this.renderPanel();
    this.draw();
  }

  deleteSelected() {
    if (!this.selected.size) return;
    this.remember();
    this.entities = this.entities.filter(e => !this.selected.has(e.id));
    this.dropDimensionsOf(this.selected);
    this.selected.clear();
    this.renderPanel();
    this.draw();
  }

  toggleConstruction() {
    if (!this.selected.size) return;
    this.remember();
    const all = this.entities.filter(e => this.selected.has(e.id));
    const on = !all.every(e => e.cons);
    all.forEach(e => { if (on) e.cons = true; else delete e.cons; });
    this.renderPanel();
    this.draw();
  }

  // ---- dimensions (tool D, like OnShape): they stay in the sketch and drive its geometry ---------------------------------------

  snapshot() { return { entities: clone(this.entities), dims: clone(this.dims) }; }

  restore(s) {
    this.entities = s.entities;
    this.dims = s.dims;
    this.selected.clear();
  }

  /** The dimensions of entities that are deleted go with them. */
  dropDimensionsOf(ids) {
    this.dims = this.dims.filter(d => !ids.has(d.ref) && !ids.has(d.p1?.id) && !ids.has(d.p2?.id));
  }

  /** Makes the geometry follow the dimensions (after every change, also while dragging: a line with a length turns about its start). */
  enforce() {
    const applied = applyDimensions(this.entities, this.dims, v => evalLength(v, this.variables, this.unit));
    this.entities = applied.entities;
    this.dimErrors = new Set(applied.errors.map(x => x.id));
  }

  /** The end, point or centre under the pointer as a reference { id, at } with its position, or null. */
  pointAt(p, tolerance) {
    let best = null, bestD = tolerance;
    const consider = (e, at, q) => { const d = Math.hypot(q[0] - p[0], q[1] - p[1]); if (d < bestD) { bestD = d; best = { ref: { id: e.id, at }, point: q }; } };
    for (const e of this.entities) {
      if (e.t === 'line') { consider(e, 'a', e.a); consider(e, 'b', e.b); }
      else if (e.t === 'point') consider(e, 'p', e.p);
      else if (e.c) consider(e, 'c', e.c);
    }
    return best;
  }

  dimensionClick(e) {
    const world = this.vp.rayOnPlane(e.ndc, this.frame);
    if (!world) return;
    const p = toLocal(this.frame, world);
    const point = this.pointAt(p, SNAP_PX * this.vp.mmPerPixel);
    if (point) {
      if (!this.dimFirst) { this.dimFirst = point; this.cb.status(t('Sketch.Hint.dimension2')); this.draw(); return; }
      if (point.ref.id === this.dimFirst.ref.id && point.ref.at === this.dimFirst.ref.at) return;
      const value = Math.hypot(point.point[0] - this.dimFirst.point[0], point.point[1] - this.dimFirst.point[1]);
      const d = this.addDimension({ kind: 'distance', p1: this.dimFirst.ref, p2: point.ref }, value);
      this.dimFirst = null;
      this.cb.status(t('Sketch.Hint.dimension'));
      this.editDimension(d, e.clientX, e.clientY);
      return;
    }
    this.dimFirst = null;
    const hit = this.entityAt(e);
    if (!hit) return;
    let kind = { line: 'length', circle: 'diameter', arc: 'radius', polygon: 'radius' }[hit.t];
    if (hit.t === 'rect') {
      const dTop = Math.min(Math.abs(p[1] - hit.a[1]), Math.abs(p[1] - hit.b[1])), dSide = Math.min(Math.abs(p[0] - hit.a[0]), Math.abs(p[0] - hit.b[0]));
      kind = dTop <= dSide ? 'width' : 'height';
    }
    if (!kind) return;
    const existing = this.dims.find(d => d.kind === kind && d.ref === hit.id);
    const d = existing || this.addDimension({ kind, ref: hit.id }, measureDimension(this.entities, { kind, ref: hit.id }));
    this.editDimension(d, e.clientX, e.clientY);
  }

  addDimension(dim, value) {
    this.remember();
    const d = { id: uid('d'), ...dim, value: fmt(value / this.unit, 4).replace(',', '.') };
    this.dims.push(d);
    this.draw();
    return d;
  }

  /** The small field over the view where the value of a dimension is typed (an expression: 25, 1 in, #width / 2). Enter applies, Esc closes. */
  editDimension(d, clientX, clientY) {
    this.closeDimEditor();
    const host = this.vp.canvas.parentElement;
    const box = host.getBoundingClientRect();
    const input = el('input', { class: 'mat-input mat-input--sm mat-mono', value: d.value, autocomplete: 'off', spellcheck: 'false', 'aria-label': t('Sketch.DimensionValue') });
    const remove = el('button', { type: 'button', class: 'mat-btn mat-btn--ghost mat-btn--icon mat-btn--sm', 'aria-label': t('Sketch.DimensionDelete'), 'data-tip': t('Sketch.DimensionDelete') }, icon('trash'));
    const editor = el('div', { class: 'ms-dimedit' }, input, remove);
    editor.style.left = Math.max(4, Math.min(box.width - 190, clientX - box.left - 60)) + 'px';
    editor.style.top = Math.max(4, Math.min(box.height - 44, clientY - box.top + 14)) + 'px';
    host.append(editor);
    this.dimEditor = editor;
    const apply = () => {
      const text = input.value.trim();
      try {
        if (!(evalLength(text, this.variables, this.unit) > 0)) throw new Error('positive');
      } catch {
        input.setAttribute('aria-invalid', 'true');
        return false;
      }
      if (text !== d.value) { this.remember(); d.value = text; }
      this.closeDimEditor();
      this.renderPanel();
      this.draw();
      return true;
    };
    input.addEventListener('keydown', ev => {
      ev.stopPropagation();
      if (ev.key === 'Enter') { ev.preventDefault(); apply(); }
      if (ev.key === 'Escape') { ev.preventDefault(); this.closeDimEditor(); }
    });
    remove.addEventListener('click', () => { this.remember(); this.dims = this.dims.filter(x => x !== d); this.closeDimEditor(); this.draw(); });
    setTimeout(() => { input.focus(); input.select(); }, 0);
  }

  closeDimEditor() {
    this.dimEditor?.remove();
    this.dimEditor = null;
  }

  /** The labels of the dimensions, over the view at their places (moved along with the camera). */
  placeLabels() {
    if (!this.active) return;
    if (!this.labels) {
      this.labels = el('div', { class: 'ms-dims', 'aria-label': t('Sketch.Dimensions') });
      this.vp.canvas.parentElement.append(this.labels);
    }
    const current = new Map([...this.labels.children].map(n => [n.dataset.dim, n]));
    for (const d of this.dims) {
      const at = dimensionAnchor(this.entities, d);
      let label = current.get(d.id);
      current.delete(d.id);
      if (!at) { label?.remove(); continue; }
      if (!label) {
        label = el('button', { type: 'button', class: 'ms-dim', dataset: { dim: d.id } });
        label.addEventListener('click', ev => { const dim = this.dims.find(x => x.id === label.dataset.dim); if (dim) this.editDimension(dim, ev.clientX, ev.clientY); });
        this.labels.append(label);
      }
      const value = measureDimension(this.entities, d);
      const plain = /^[-+]?\d*[.,]?\d+$/.test(d.value.trim());
      const prefix = { diameter: 'Ø ', radius: 'R ' }[d.kind] || '';
      label.textContent = prefix + (plain || value === null ? d.value : `${d.value} = ${fmt(value / this.unit, 3)}`);
      label.classList.toggle('is-error', this.dimErrors?.has(d.id) === true);
      const s = this.vp.project(toWorld(this.frame, at[0], at[1]));
      label.style.transform = `translate(${Math.round(s.x)}px, ${Math.round(s.y)}px) translate(-50%, -50%)`;
    }
    current.forEach(n => n.remove());
  }

  // ---- pointer -------------------------------------------------------------------------------------------------------------

  bind() {
    const vp = this.vp;
    vp.on('hover', e => this.active && this.move(e));
    vp.on('drag', e => this.active && this.dragMove(e));
    vp.on('down', e => this.active && this.down(e));
    vp.on('dragend', e => this.active && this.dragEnd(e));
    vp.on('click', e => this.active && this.click(e));
    vp.on('cancel', () => { if (this.active) { this.dragging = null; } });
  }

  /** The sketch point under the pointer, snapped; sets this.snap for the marker. */
  locate(e, from) {
    const world = this.vp.rayOnPlane(e.ndc, this.frame);
    if (!world) return null;
    let p = toLocal(this.frame, world);
    const tolerance = SNAP_PX * this.vp.mmPerPixel;
    this.snap = null;
    let best = tolerance;
    const skip = this.dragging?.handles ? new Set(this.dragging.handles.map(h => h.entity.id)) : null;
    for (const q of snapPoints(this.entities.filter(x => !skip || !skip.has(x.id)))) {
      const d = Math.hypot(q[0] - p[0], q[1] - p[1]);
      if (d < best) { best = d; this.snap = q; }
    }
    if (Math.hypot(p[0], p[1]) < best) this.snap = [0, 0];
    for (const q of this.points) {
      const d = Math.hypot(q[0] - p[0], q[1] - p[1]);
      if (d < best) { best = d; this.snap = q; }
    }
    if (this.snap) return [...this.snap];
    // horizontal / vertical from the previous point
    if (from) {
      const dx = p[0] - from[0], dy = p[1] - from[1];
      if (Math.abs(dy) < tolerance * 0.8 && Math.abs(dx) > tolerance) p = [p[0], from[1]];
      else if (Math.abs(dx) < tolerance * 0.8 && Math.abs(dy) > tolerance) p = [from[0], p[1]];
    }
    const step = this.gridStep();
    return [Math.round(p[0] / step) * step, Math.round(p[1] / step) * step];
  }

  gridStep() {
    const raw = 12 * this.vp.mmPerPixel / this.unit;
    const pow = Math.pow(10, Math.floor(Math.log10(raw)));
    const n = raw / pow;
    const nice = n < 1.5 ? 1 : n < 3.5 ? 2 : n < 7.5 ? 5 : 10;
    return nice * pow * this.unit;
  }

  entityAt(e) {
    const world = this.vp.rayOnPlane(e.ndc, this.frame);
    if (!world) return null;
    const p = toLocal(this.frame, world);
    const tolerance = 8 * this.vp.mmPerPixel;
    let best = null, bestD = tolerance;
    for (const x of this.entities) {
      const d = distToEntity(p, x);
      if (d < bestD) { bestD = d; best = x; }
    }
    return best;
  }

  move(e) {
    if (this.tool === 'select' || this.tool === 'dimension') {
      const hit = this.entityAt(e);
      const id = hit ? hit.id : null;
      if (id !== this.hover) { this.hover = id; this.draw(); }
      this.vp.canvas.style.cursor = hit ? 'pointer' : '';
      return;
    }
    this.cursor = this.locate(e, this.points[this.points.length - 1]);
    this.draw();
  }

  down(e) {
    if (this.tool !== 'select') return;
    // a drag on an end (or on an entity) moves it; the ends at the same place move with it
    const world = this.vp.rayOnPlane(e.ndc, this.frame);
    if (!world) return;
    const p = toLocal(this.frame, world);
    const tolerance = SNAP_PX * this.vp.mmPerPixel;
    const handle = this.handleAt(p, tolerance);
    if (handle) {
      this.vp.navigationOnly = true;
      this.dragging = { handles: this.handlesAt(handle.point), start: p, before: this.snapshot() };
    } else {
      const hit = this.entityAt(e);
      if (hit) {
        this.vp.navigationOnly = true;
        this.dragging = { entity: hit, start: p, last: p, before: this.snapshot() };
      }
    }
  }

  dragMove(e) {
    if (!this.dragging) return;
    if (this.dragging.handles) {
      const p = this.locate(e);
      if (!p) return;
      for (const h of this.dragging.handles) h.set(p);
    } else {
      const world = this.vp.rayOnPlane(e.ndc, this.frame);
      if (!world) return;
      const p = toLocal(this.frame, world);
      const dx = p[0] - this.dragging.last[0], dy = p[1] - this.dragging.last[1];
      this.dragging.last = p;
      translate(this.dragging.entity, dx, dy);
      this.selected = new Set([this.dragging.entity.id]);
    }
    this.renderPanel();
    this.draw();
  }

  dragEnd() {
    if (!this.dragging) return;
    if (this.dragging.entity) {
      // snap the moved entity to the grid by its first point
      const step = this.gridStep();
      const ref = firstPoint(this.dragging.entity);
      translate(this.dragging.entity, Math.round(ref[0] / step) * step - ref[0], Math.round(ref[1] / step) * step - ref[1]);
    }
    this.history.push(this.dragging.before);
    this.future = [];
    this.dragging = null;
    this.vp.navigationOnly = this.tool !== 'select' && this.tool !== 'dimension';
    this.snap = null;
    this.renderPanel();
    this.draw();
  }

  /** The handles of every entity: points that can be dragged, with how to move them. */
  handles() {
    const out = [];
    for (const e of this.entities) {
      if (e.t === 'line') {
        out.push({ entity: e, point: e.a, set: p => { e.a = p; } }, { entity: e, point: e.b, set: p => { e.b = p; } });
      } else if (e.t === 'rect') {
        out.push({ entity: e, point: e.a, set: p => { e.a = p; } }, { entity: e, point: e.b, set: p => { e.b = p; } });
        out.push({ entity: e, point: [e.b[0], e.a[1]], set: p => { e.b = [p[0], e.b[1]]; e.a = [e.a[0], p[1]]; } });
        out.push({ entity: e, point: [e.a[0], e.b[1]], set: p => { e.a = [p[0], e.a[1]]; e.b = [e.b[0], p[1]]; } });
      } else if (e.t === 'circle' || e.t === 'polygon') {
        out.push({ entity: e, point: e.c, set: p => { e.c = p; } });
        out.push({ entity: e, point: [e.c[0] + e.r, e.c[1]], set: p => { e.r = Math.max(1e-3, Math.hypot(p[0] - e.c[0], p[1] - e.c[1])); } });
      } else if (e.t === 'arc') {
        const [s, f] = ends(e);
        out.push({ entity: e, point: e.c, set: p => { e.c = p; } });
        out.push({ entity: e, point: s, set: p => { const fe = ends(e)[1]; const mid = arcMid(e); const arc = arcThrough(p, mid, fe); if (arc) Object.assign(e, arc); } });
        out.push({ entity: e, point: f, set: p => { const se = ends(e)[0]; const mid = arcMid(e); const arc = arcThrough(se, mid, p); if (arc) Object.assign(e, arc); } });
      } else if (e.t === 'point') {
        out.push({ entity: e, point: e.p, set: p => { e.p = p; } });
      }
    }
    return out;
  }

  handleAt(p, tolerance) {
    let best = null, bestD = tolerance;
    for (const h of this.handles()) {
      const d = Math.hypot(h.point[0] - p[0], h.point[1] - p[1]);
      if (d < bestD) { bestD = d; best = h; }
    }
    return best;
  }

  handlesAt(point) {
    // the ends of lines and arcs at the same place move together; centres and corners only alone
    const all = this.handles();
    const same = all.filter(h => Math.hypot(h.point[0] - point[0], h.point[1] - point[1]) < 1e-6);
    const first = same[0];
    if (!first) return [];
    const isEnd = h => (h.entity.t === 'line') || (h.entity.t === 'arc' && h.point !== h.entity.c);
    return isEnd(first) ? same.filter(isEnd) : [first];
  }

  click(e) {
    if (this.tool === 'dimension') { this.dimensionClick(e); return; }
    if (this.tool === 'select') {
      const hit = this.entityAt(e);
      if (!hit) { if (!e.shift) this.selected.clear(); }
      else if (e.shift || e.ctrl) { if (this.selected.has(hit.id)) this.selected.delete(hit.id); else this.selected.add(hit.id); }
      else this.selected = new Set([hit.id]);
      this.renderPanel();
      this.draw();
      return;
    }
    const p = this.locate(e, this.points[this.points.length - 1]);
    if (!p) return;
    this.points.push(p);
    this.tryComplete();
    this.draw();
  }

  /** Makes the entity of the tool when it has enough points. */
  tryComplete() {
    const pts = this.points;
    const add = entity => { this.remember(); entity.id = uid('e'); this.entities.push(entity); this.renderPanel(); return entity; };
    switch (this.tool) {
      case 'point':
        add({ t: 'point', p: pts[0] });
        this.points = [];
        break;
      case 'line':
        if (pts.length === 2) {
          const [a, b] = pts;
          if (Math.hypot(b[0] - a[0], b[1] - a[1]) < 1e-9) { this.points = [a]; break; }
          add({ t: 'line', a, b });
          // a chain: the next line starts where this one ended; it ends when it closes or with Esc
          const closed = this.entities.some(x => x.t === 'line' && x.id !== this.entities[this.entities.length - 1].id && (same(x.a, b) || same(x.b, b)));
          this.points = closed ? [] : [b];
        }
        break;
      case 'rect':
        if (pts.length === 2 && pts[0][0] !== pts[1][0] && pts[0][1] !== pts[1][1]) { add({ t: 'rect', a: pts[0], b: pts[1] }); this.points = []; }
        else if (pts.length === 2) this.points = [pts[0]];
        break;
      case 'crect':
        if (pts.length === 2) {
          const [c, k] = pts;
          const dx = Math.abs(k[0] - c[0]), dy = Math.abs(k[1] - c[1]);
          if (dx > 0 && dy > 0) add({ t: 'rect', a: [c[0] - dx, c[1] - dy], b: [c[0] + dx, c[1] + dy] });
          this.points = [];
        }
        break;
      case 'circle':
        if (pts.length === 2) {
          const r = Math.hypot(pts[1][0] - pts[0][0], pts[1][1] - pts[0][1]);
          if (r > 0) add({ t: 'circle', c: pts[0], r });
          this.points = [];
        }
        break;
      case 'polygon':
        if (pts.length === 2) {
          const r = Math.hypot(pts[1][0] - pts[0][0], pts[1][1] - pts[0][1]);
          const rot = Math.atan2(pts[1][1] - pts[0][1], pts[1][0] - pts[0][0]) * 180 / Math.PI;
          if (r > 0) add({ t: 'polygon', c: pts[0], r, n: this.polygonSides, rot: round(rot, 6) });
          this.points = [];
        }
        break;
      case 'arc':
        // start, end, then a point the arc passes through
        if (pts.length === 3) {
          const arc = arcThrough(pts[0], pts[2], pts[1]);
          if (arc) add({ t: 'arc', ...arc });
          this.points = [];
        }
        break;
    }
  }

  /** What the tool would make with the pointer where it is. */
  preview() {
    const pts = this.points, c = this.cursor;
    if (!c || !pts.length) return [];
    switch (this.tool) {
      case 'line': return [{ id: 'p', t: 'line', a: pts[0], b: c }];
      case 'rect': return [{ id: 'p', t: 'rect', a: pts[0], b: c }];
      case 'crect': {
        const dx = Math.abs(c[0] - pts[0][0]), dy = Math.abs(c[1] - pts[0][1]);
        return [{ id: 'p', t: 'rect', a: [pts[0][0] - dx, pts[0][1] - dy], b: [pts[0][0] + dx, pts[0][1] + dy] }];
      }
      case 'circle': return [{ id: 'p', t: 'circle', c: pts[0], r: Math.hypot(c[0] - pts[0][0], c[1] - pts[0][1]) }];
      case 'polygon': return [{ id: 'p', t: 'polygon', c: pts[0], r: Math.hypot(c[0] - pts[0][0], c[1] - pts[0][1]), n: this.polygonSides, rot: Math.atan2(c[1] - pts[0][1], c[0] - pts[0][0]) * 180 / Math.PI }];
      case 'arc': {
        if (pts.length === 1) return [{ id: 'p', t: 'line', a: pts[0], b: c, cons: true }];
        const arc = arcThrough(pts[0], c, pts[1]);
        return arc ? [{ id: 'p', t: 'arc', ...arc }] : [{ id: 'p', t: 'line', a: pts[0], b: pts[1] }];
      }
      default: return [];
    }
  }

  /** Esc: first the tool's clicks, then the tool, then the selection. */
  escape() {
    if (this.points.length) { this.points = []; this.draw(); return; }
    if (this.tool !== 'select') { this.setTool('select'); return; }
    this.selected.clear();
    this.renderPanel();
    this.draw();
  }

  draw() {
    if (!this.active) return;
    this.enforce();
    const preview = this.preview();
    const hud = this.measureText(preview[0]);
    this.cb.hud(hud);
    // the distance dimensions as thin lines between their points, and the first point of one being made
    const dimLines = this.dims.filter(d => d.kind === 'distance').map(d => [pointOf(this.entities, d.p1), pointOf(this.entities, d.p2)])
      .filter(([a, b]) => a && b).map(([a, b], i) => ({ id: 'dim' + i, t: 'line', a, b, cons: true }));
    this.vp.setSketchOverlay({
      frame: this.frame,
      entities: [...this.entities, ...dimLines],
      selected: this.selected,
      hover: this.hover,
      preview,
      snap: this.tool === 'dimension' ? this.dimFirst?.point ?? null : this.tool !== 'select' ? this.snap : null,
      loops: sketchLoops(this.entities),
      grid: this.gridStep(),
      gridExtent: Math.max(200, this.vp.viewHeight * 2),
    });
    this.placeLabels();
  }

  measureText(p) {
    if (!p) return '';
    const L = mm => fmt(mm / this.unit, 3) + ' ' + this.units;
    if (p.t === 'line') { const l = Math.hypot(p.b[0] - p.a[0], p.b[1] - p.a[1]); return `${L(l)} · ${fmt(Math.atan2(p.b[1] - p.a[1], p.b[0] - p.a[0]) * 180 / Math.PI, 1)}°`; }
    if (p.t === 'rect') return `${L(Math.abs(p.b[0] - p.a[0]))} × ${L(Math.abs(p.b[1] - p.a[1]))}`;
    if (p.t === 'circle') return `⌀ ${L(p.r * 2)}`;
    if (p.t === 'polygon') return `R ${L(p.r)} · ${p.n}`;
    if (p.t === 'arc') return `R ${L(p.r)}`;
    return '';
  }

  // ---- the panel -----------------------------------------------------------------------------------------------------------

  /**
   * The panel stays small: its head says what the sketch holds (or what is selected); the fields open below it only for a selection (or the sides of a polygon),
   * so on a small screen the panel is one line. The head can also fold the fields away (app.js).
   */
  renderPanel() {
    const body = this.panel.body;
    body.replaceChildren();
    this.panel.title.textContent = this.name;
    const chosen = this.entities.filter(e => this.selected.has(e.id));
    const loops = sketchLoops(this.entities);
    this.panel.summary.textContent = chosen.length === 1
      ? t('Sketch.Entity.' + chosen[0].t) + (chosen[0].cons ? ' · ' + t('Sketch.Construction') : '')
      : chosen.length > 1 ? t('Sketch.SelectedMany', chosen.length)
      : t('Sketch.Summary', this.entities.length, loops.length);
    if (chosen.length === 1) {
      this.entityFields(chosen[0]).slice(1).forEach(f => body.append(f));
    } else if (!chosen.length && this.tool === 'polygon') {
      body.append(this.field(t('Sketch.Sides'), String(this.polygonSides), v => { this.polygonSides = Math.max(3, Math.min(64, Math.round(evalNumber(v)))); }));
    }
    if (chosen.length) {
      const row = el('div', { class: 'ms-dialog__row' },
        el('button', { type: 'button', class: 'mat-btn mat-btn--secondary mat-btn--sm', onclick: () => this.toggleConstruction() }, icon('construction'), el('span', null, t('Sketch.Construction'))),
        el('button', { type: 'button', class: 'mat-btn mat-btn--danger mat-btn--sm', onclick: () => this.deleteSelected() }, icon('trash'), el('span', null, t('Sketch.Delete'))));
      body.append(row);
    }
    this.panel.root.classList.toggle('is-empty', !body.childElementCount);
  }

  selectAll() {
    this.selected = new Set(this.entities.map(e => e.id));
    this.renderPanel();
    this.draw();
  }

  /** H / V: the selected lines become horizontal or vertical (their second end moves; ends that meet it move with it). */
  align(horizontal) {
    const lines = this.entities.filter(e => this.selected.has(e.id) && e.t === 'line');
    if (!lines.length) { this.cb.status(t('Sketch.AlignNeedsLine')); return; }
    this.remember();
    for (const line of lines) this.moveEnd(line.b, horizontal ? [line.b[0], line.a[1]] : [line.a[0], line.b[1]]);
    this.renderPanel();
    this.draw();
  }

  /** A field with an expression; the change is applied on Enter or when the field is left. */
  field(label, value, apply) {
    const id = uid('f');
    const input = el('input', { class: 'mat-input mat-input--sm mat-mono', id, value, autocomplete: 'off', spellcheck: 'false', inputmode: 'text' });
    const error = el('p', { class: 'mat-field__error', hidden: true });
    const commit = () => {
      try {
        apply(input.value);
        error.hidden = true;
        input.removeAttribute('aria-invalid');
        this.draw();
      } catch {
        error.textContent = t('Expr.Syntax');
        error.hidden = false;
        input.setAttribute('aria-invalid', 'true');
      }
    };
    input.addEventListener('change', commit);
    input.addEventListener('keydown', ev => { if (ev.key === 'Enter') { ev.preventDefault(); commit(); input.select(); } ev.stopPropagation(); });
    return el('div', { class: 'mat-field ms-field-sm' }, el('label', { class: 'mat-label', for: id }, label), input, error);
  }

  entityFields(e) {
    const L = mm => fmt(mm / this.unit, 4);
    const len = v => evalLength(v, this.variables, this.unit);
    const deg = v => evalAngle(v, this.variables);
    const change = fn => v => { this.remember(); fn(v); this.renderPanel(); };
    const head = el('p', { class: 'ms-dialog__text' }, icon(ENTITY_ICONS[e.t] || 'line'), ' ', t('Sketch.Entity.' + e.t) + (e.cons ? ' · ' + t('Sketch.Construction') : ''));
    const out = [head];
    if (e.t === 'line') {
      const l = Math.hypot(e.b[0] - e.a[0], e.b[1] - e.a[1]);
      const a = Math.atan2(e.b[1] - e.a[1], e.b[0] - e.a[0]) * 180 / Math.PI;
      out.push(
        this.pair(this.field('X1', L(e.a[0]), change(v => this.moveEnd(e.a, [len(v), e.a[1]]))), this.field('Y1', L(e.a[1]), change(v => this.moveEnd(e.a, [e.a[0], len(v)])))),
        this.pair(this.field('X2', L(e.b[0]), change(v => this.moveEnd(e.b, [len(v), e.b[1]]))), this.field('Y2', L(e.b[1]), change(v => this.moveEnd(e.b, [e.b[0], len(v)])))),
        this.pair(
          this.field(t('Sketch.Length'), L(l), change(v => { const n = len(v); const r = a * Math.PI / 180; this.moveEnd(e.b, [e.a[0] + n * Math.cos(r), e.a[1] + n * Math.sin(r)]); })),
          this.field(t('Sketch.Angle'), fmt(a, 3), change(v => { const r = deg(v) * Math.PI / 180; this.moveEnd(e.b, [e.a[0] + l * Math.cos(r), e.a[1] + l * Math.sin(r)]); }))),
      );
    } else if (e.t === 'rect') {
      const x = Math.min(e.a[0], e.b[0]), y = Math.min(e.a[1], e.b[1]), w = Math.abs(e.b[0] - e.a[0]), h = Math.abs(e.b[1] - e.a[1]);
      const set = (nx, ny, nw, nh) => { if (nw <= 0 || nh <= 0) throw new Error('size'); e.a = [nx, ny]; e.b = [nx + nw, ny + nh]; };
      out.push(
        this.pair(this.field('X', L(x), change(v => set(len(v), y, w, h))), this.field('Y', L(y), change(v => set(x, len(v), w, h)))),
        this.pair(this.field(t('Sketch.Width'), L(w), change(v => set(x, y, len(v), h))), this.field(t('Sketch.Height'), L(h), change(v => set(x, y, w, len(v))))),
      );
    } else if (e.t === 'circle') {
      out.push(
        this.pair(this.field('X', L(e.c[0]), change(v => { e.c = [len(v), e.c[1]]; })), this.field('Y', L(e.c[1]), change(v => { e.c = [e.c[0], len(v)]; }))),
        this.field(t('Sketch.Diameter'), L(e.r * 2), change(v => { const d = len(v); if (!(d > 0)) throw new Error('size'); e.r = d / 2; })),
      );
    } else if (e.t === 'arc') {
      out.push(
        this.pair(this.field('X', L(e.c[0]), change(v => { e.c = [len(v), e.c[1]]; })), this.field('Y', L(e.c[1]), change(v => { e.c = [e.c[0], len(v)]; }))),
        this.field(t('Sketch.Radius'), L(e.r), change(v => { const r = len(v); if (!(r > 0)) throw new Error('size'); e.r = r; })),
        this.pair(
          this.field(t('Sketch.StartAngle'), fmt(e.a0 * 180 / Math.PI, 3), change(v => { e.a0 = deg(v) * Math.PI / 180; })),
          this.field(t('Sketch.EndAngle'), fmt(e.a1 * 180 / Math.PI, 3), change(v => { e.a1 = deg(v) * Math.PI / 180; }))),
      );
    } else if (e.t === 'polygon') {
      out.push(
        this.pair(this.field('X', L(e.c[0]), change(v => { e.c = [len(v), e.c[1]]; })), this.field('Y', L(e.c[1]), change(v => { e.c = [e.c[0], len(v)]; }))),
        this.pair(
          this.field(t('Sketch.Radius'), L(e.r), change(v => { const r = len(v); if (!(r > 0)) throw new Error('size'); e.r = r; })),
          this.field(t('Sketch.Sides'), String(e.n), change(v => { e.n = Math.max(3, Math.min(64, Math.round(evalNumber(v, this.variables)))); }))),
        this.field(t('Sketch.Rotation'), fmt(e.rot || 0, 3), change(v => { e.rot = deg(v); })),
      );
    } else if (e.t === 'point') {
      out.push(this.pair(this.field('X', L(e.p[0]), change(v => { e.p = [len(v), e.p[1]]; })), this.field('Y', L(e.p[1]), change(v => { e.p = [e.p[0], len(v)]; }))));
    }
    return out;
  }

  pair(a, b) { return el('div', { class: 'ms-dialog__pair' }, a, b); }

  /** Moves an end and every end of a line or arc at the same place with it. */
  moveEnd(point, to) {
    const from = [...point];
    for (const h of this.handlesAt(from)) h.set([...to]);
    // the end that was asked for (when it is not a line or arc end)
    point[0] = to[0];
    point[1] = to[1];
  }
}

const ENTITY_ICONS = { line: 'line', rect: 'rectangle', circle: 'circle-tool', arc: 'arc', polygon: 'polygon', point: 'point' };

const same = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]) < 1e-9;

const round = (v, places) => Math.round(v * 10 ** places) / 10 ** places;

function arcMid(e) {
  let sweep = e.a1 - e.a0;
  while (sweep <= 0) sweep += Math.PI * 2;
  const m = e.a0 + sweep / 2;
  return [e.c[0] + e.r * Math.cos(m), e.c[1] + e.r * Math.sin(m)];
}

function firstPoint(e) {
  if (e.t === 'line' || e.t === 'rect') return e.a;
  if (e.t === 'point') return e.p;
  return e.c;
}

function translate(e, dx, dy) {
  const mv = p => [p[0] + dx, p[1] + dy];
  if (e.t === 'line' || e.t === 'rect') { e.a = mv(e.a); e.b = mv(e.b); }
  else if (e.t === 'point') e.p = mv(e.p);
  else e.c = mv(e.c);
}


