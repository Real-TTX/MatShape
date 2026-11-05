/* MatShape – the sketch editor, constraint-based like the sketcher of OnShape.
   Entities: lines, circles, arcs, polygons, points (and legacy rectangles) in the coordinates of the plane (mm). Constraints (coincident, horizontal, vertical,
   parallel, perpendicular, tangent, equal, midpoint, concentric, fix) and dimensions (distance, length, radius, diameter, angle) are kept in the sketch and held
   by the solver (sketchsolve.js) after every change, also while dragging. Colours: blue = still free, black = fully defined, red = conflict.
   Drawing sets the obvious constraints by itself (snapped to a point: coincident, to a curve: on it, nearly level: horizontal …), like OnShape. */

import { arcThrough, curvesFromPoints, distToEntity, entityPolyline, sketchLoops, toLocal, toWorld } from './geom.js';
import { CONSTRAINTS, ORIGIN, adoptSketch, constraintsOf, measure, pointKeys, pointOfRef, solveSketch } from './sketchsolve.js';
import { evalAngle, evalLength, evalNumber } from './expr.js';
import { clone, el, fmt, icon, t, uid, UNITS } from './util.js';
import { filletCorner, mirror, offset as offsetChain, slot, tangentArc, trim } from './sketchtools.js';
import { simplify as simplifyLoop, traceMask } from './imagetrace.js';

const SNAP_PX = 12;                       // how close (px) the pointer must be to a point; to a curve 10 px
const DRAW_TOOLS = ['line', 'rect', 'crect', 'circle', 'arc', 'tarc', 'polygon', 'slot', 'spline', 'ellipse', 'point', 'text'];
/** Tools that are clicked point by point only (no press – drag – release). */
const CLICK_ONLY = ['point', 'text', 'spline'];

export class Sketcher {
  constructor(viewport, panel, toolbar, callbacks) {
    this.vp = viewport;
    this.panel = panel;            // { root, title, summary, body }
    this.toolbar = toolbar;
    this.cb = callbacks;           // { status(text), hud(text) }
    this.active = false;
    this.bind();
    viewport.on('render', () => this.placeLabels());
  }

  start({ name, frame, entities, cons, dims, units, variables, polygonSides, image }) {
    this.active = true;
    this.image = image ? { ...image } : null;
    this.mirrorLine = null;
    this.name = name;
    this.frame = frame;
    // rectangles and polygons of older sketches (or of the AI) become lines; a sketch without any constraints gets the obvious ones (joined ends, level lines)
    const adopted = adoptSketch(clone(entities || []), clone(cons || constraintsOf({ dims }) || []), { infer: !cons, id: uid });
    this.entities = adopted.entities;
    this.cons = adopted.cons;
    this.replaced = adopted.replaced;
    this.units = units;
    this.unit = UNITS[units] || 1;
    this.variables = variables || {};
    this.selection = new Set();    // 'e:id', 'p:id.k', 'c:id'
    this.hover = null;
    this.tool = 'select';
    this.points = [];              // the clicks of a drawing tool
    this.picks = [];               // the picks of a constraint or dimension tool
    this.cursor = null;
    this.located = null;           // where the pointer would land with a drawing tool (snap, glyph, guides)
    this.placing = null;           // a dimension that follows the pointer until it is placed: { c, final }
    this.box = null;               // a selection box being dragged
    this.history = [];
    this.future = [];
    this.polygonSides = polygonSides || 6;
    this.evaluate = c => (CONSTRAINTS[c.type]?.angle ? evalAngle(c.value, this.variables) : evalLength(c.value, this.variables, this.unit));
    this.vp.navigationOnly = false;
    this.vp.normalTo(frame);
    setTimeout(() => this.vp.fit(true), 280);
    this.solve();
    this.setTool('select');
  }

  stop() {
    this.active = false;
    this.useEdge = null;
    this.vp.setEdgeMarks(null);
    this.vp.navigationOnly = false;
    this.vp.setSketchOverlay(null);
    this.closeEditor();
    this.labels?.replaceChildren();
    this.placing = null;
    this.box = null;
    this.located = null;
    this.pointer = null;
  }

  /** Lets the solver hold every constraint; with analysis the states (free, defined, conflict) are new. */
  solve(options = {}) {
    const result = solveSketch(this.entities, this.cons, this.evaluate, options);
    this.entities = result.entities;
    if (result.analysis) this.analysis = result.analysis;
    return result;
  }

  // ---- tools and history ----------------------------------------------------------------------------------------------------

  setTool(tool) {
    if (this.tool === 'use' && tool !== 'use') { this.useEdge = null; this.vp.setEdgeMarks(null); }
    this.mirrorLine = null;
    this.tool = tool;
    this.pressed = null;
    this.points = [];
    this.picks = [];
    this.placing = null;
    this.located = null;
    this.closeEditor();
    this.vp.navigationOnly = DRAW_TOOLS.includes(tool);
    this.toolbar.querySelectorAll('[data-sketch-tool]').forEach(b => b.setAttribute('aria-pressed', b.dataset.sketchTool === tool ? 'true' : 'false'));
    this.toolbar.querySelectorAll('[data-sketch-constraint]').forEach(b => b.setAttribute('aria-pressed', 'constraint:' + b.dataset.sketchConstraint === tool ? 'true' : 'false'));
    this.cb.status(t('Sketch.Hint.' + (tool.startsWith('constraint:') ? 'constraint' : tool)));
    this.renderPanel();
    this.draw();
  }

  snapshot() { return { entities: clone(this.entities), cons: clone(this.cons), image: this.image ? { ...this.image } : null }; }

  remember() {
    this.history.push(this.snapshot());
    if (this.history.length > 100) this.history.shift();
    this.future = [];
  }

  restore(s) {
    this.entities = s.entities;
    this.cons = s.cons;
    if ('image' in s) this.image = s.image;
    this.selection.clear();
    this.solve();
    this.renderPanel();
    this.draw();
    this.cb.changed?.();
  }

  undo() { if (this.history.length) { this.future.push(this.snapshot()); this.restore(this.history.pop()); } }

  redo() { if (this.future.length) { this.history.push(this.snapshot()); this.restore(this.future.pop()); } }

  /** Changes something and lets the solver settle it: one step of the history. */
  change(fn) {
    this.remember();
    fn();
    this.solve();
    this.renderPanel();
    this.draw();
    this.cb.changed?.();
  }

  deleteSelected() {
    if (!this.selection.size) return;
    const entities = new Set([...this.selection].filter(k => k.startsWith('e:')).map(k => k.slice(2)));
    const constraints = new Set([...this.selection].filter(k => k.startsWith('c:')).map(k => k.slice(2)));
    const points = [...this.selection].filter(k => k.startsWith('p:')).map(k => k.slice(2));
    // a selected point of a point entity deletes the point; the point of a line only its constraints
    points.forEach(p => { const [id, k] = p.split('.'); if (k === 'p' && id !== ORIGIN) entities.add(id); });
    const ownPoints = points.filter(p => !p.startsWith(ORIGIN + '.'));
    this.change(() => {
      this.entities = this.entities.filter(e => !entities.has(e.id));
      this.cons = this.cons.filter(c => !constraints.has(c.id)
        && !(c.refs || []).some(r => entities.has(r?.e) || ownPoints.includes(r?.e + '.' + r?.k)));
      this.selection.clear();
    });
  }

  toggleConstruction() {
    const ids = [...this.selection].filter(k => k.startsWith('e:')).map(k => k.slice(2));
    if (!ids.length) return;
    this.change(() => {
      const all = this.entities.filter(e => ids.includes(e.id));
      const on = !all.every(e => e.cons);
      all.forEach(e => { if (on) e.cons = true; else delete e.cons; });
    });
  }

  selectAll() {
    this.selection = new Set(this.entities.map(e => 'e:' + e.id));
    this.renderPanel();
    this.draw();
  }

  // ---- picking ----------------------------------------------------------------------------------------------------------------

  local(e) {
    const world = this.vp.rayOnPlane(e.ndc, this.frame);
    return world ? toLocal(this.frame, world) : null;
  }

  /** Every point that constraints can use: the ends and centres of the entities, and the origin. */
  allPoints() {
    const out = [{ ref: { e: ORIGIN, k: 'p' }, p: [0, 0] }];
    for (const e of this.entities) {
      for (const k of pointKeys(e)) out.push({ ref: { e: e.id, k }, p: pointOfRef([e], { e: e.id, k }) });
    }
    return out;
  }

  /** The point or curve under the pointer: { kind: 'point', ref, p } or { kind: 'curve', ref: { e }, entity }, or null. */
  pickAt(p) {
    const tolerance = SNAP_PX * this.vp.mmPerPixel;
    let best = null, bestD = tolerance;
    for (const q of this.allPoints()) {
      const d = Math.hypot(q.p[0] - p[0], q.p[1] - p[1]);
      if (d < bestD) { bestD = d; best = { kind: 'point', ref: q.ref, p: q.p }; }
    }
    if (best) return best;
    bestD = 10 * this.vp.mmPerPixel;
    for (const e of this.entities) {
      const d = distToEntity(p, e);
      if (d < bestD) { bestD = d; best = { kind: 'curve', ref: { e: e.id }, entity: e }; }
    }
    return best;
  }

  /**
   * Where a drawing click lands, like OnShape: on a point (coincident), in the middle of a line (midpoint), on a curve (on it); level or upright to the
   * point before (H / V), at a right angle to the line before (⊥), lined up with other points (dashed guides, no constraint). No grid: sizes come from
   * dimensions. Returns { p, ref | mid | curve, h, v, perp, glyph, target, snap, guides }.
   */
  locate(e, from, prevLine) {
    const p = this.local(e);
    if (!p) return null;
    const tol = SNAP_PX * this.vp.mmPerPixel;
    let best = null, bestD = tol;
    for (const q of this.allPoints()) {
      const d = Math.hypot(q.p[0] - p[0], q.p[1] - p[1]);
      if (d < bestD) { bestD = d; best = q; }
    }
    if (best) return { p: [...best.p], ref: best.ref, glyph: 'coincident', target: 'p:' + best.ref.e + '.' + best.ref.k, snap: best.p, guides: [] };
    for (const x of this.entities) {
      if (x.t !== 'line') continue;
      const m = [(x.a[0] + x.b[0]) / 2, (x.a[1] + x.b[1]) / 2];
      if (Math.hypot(m[0] - p[0], m[1] - p[1]) < tol * 0.8) return { p: m, mid: x.id, glyph: 'midpoint', target: 'e:' + x.id, snap: m, guides: [] };
    }
    const out = { p: [...p], guides: [] };
    if (from) {
      const dx = p[0] - from[0], dy = p[1] - from[1], len = Math.hypot(dx, dy);
      if (Math.abs(dy) < tol * 0.6 && Math.abs(dx) > tol) { out.p[1] = from[1]; out.h = true; out.glyph = 'horizontal'; }
      else if (Math.abs(dx) < tol * 0.6 && Math.abs(dy) > tol) { out.p[0] = from[0]; out.v = true; out.glyph = 'vertical'; }
      else if (prevLine && len > tol) {
        const u = unit2(prevLine), along = dx * u[0] + dy * u[1];
        if (Math.abs(along) / len < Math.sin(3 * Math.PI / 180)) { out.p = [p[0] - along * u[0], p[1] - along * u[1]]; out.perp = true; out.glyph = 'perpendicular'; }
      }
    }
    if (!out.glyph) {
      const curve = this.entities.filter(x => x.t === 'line' || x.t === 'circle' || x.t === 'arc')
        .map(x => ({ x, d: distToEntity(p, x) })).filter(c => c.d < tol * 0.7).sort((a, b) => a.d - b.d)[0];
      const on = curve && projectOnto(curve.x, p);
      if (on) return { p: on, curve: curve.x.id, glyph: 'onCurve', target: 'e:' + curve.x.id, snap: on, guides: [] };
    }
    // lined up with another point: that coordinate snaps, a dashed guide shows to which point
    if (!out.perp) {
      const points = this.allPoints().filter(q => !from || Math.hypot(q.p[0] - from[0], q.p[1] - from[1]) > 1e-9);
      if (!out.v) {
        const q = points.map(q => ({ q, d: Math.abs(q.p[0] - p[0]) })).filter(x => x.d < tol * 0.6).sort((a, b) => a.d - b.d)[0]?.q;
        if (q) { out.p[0] = q.p[0]; out.guides.push(q.p); }
      }
      if (!out.h) {
        const q = points.map(q => ({ q, d: Math.abs(q.p[1] - p[1]) })).filter(x => x.d < tol * 0.6).sort((a, b) => a.d - b.d)[0]?.q;
        if (q) { out.p[1] = q.p[1]; out.guides.push(q.p); }
      }
    }
    out.guides = out.guides.map(q => [q, [...out.p]]);
    if (from && (out.h || out.v || out.perp)) out.guides.push([from, [...out.p]]);
    if (out.glyph || out.guides.length) out.snap = out.p;
    return out;
  }

  /** The point a line goes on from, and the line before it (for ⊥), while the line tool draws a chain. */
  drawContext() {
    if (this.tool !== 'line') return [null, null];
    const last = this.points[this.points.length - 1];
    const prev = last?.ref?.k === 'b' ? this.entities.find(x => x.id === last.ref.e && x.t === 'line') : null;
    return [last?.p || null, prev];
  }

  gridStep() {
    const raw = 12 * this.vp.mmPerPixel / this.unit;
    const pow = Math.pow(10, Math.floor(Math.log10(raw)));
    const n = raw / pow;
    return (n < 1.5 ? 1 : n < 3.5 ? 2 : n < 7.5 ? 5 : 10) * pow * this.unit;
  }

  // ---- pointer ----------------------------------------------------------------------------------------------------------------

  bind() {
    const vp = this.vp;
    vp.on('hover', e => this.active && this.move(e));
    vp.on('drag', e => this.active && this.dragMove(e));
    vp.on('down', e => this.active && this.down(e));
    vp.on('dragend', e => this.active && this.dragEnd(e));
    vp.on('click', e => this.active && this.click(e));
    vp.on('cancel', () => {
      if (!this.active) return;
      this.dragging = null;
      // a second finger (pinch) while a point was pressed: that point is not meant
      if (this.pressed) { this.points.pop(); this.pressed = null; this.draw(); }
    });
  }

  move(e) {
    this.pointer = { x: e.clientX, y: e.clientY };
    if (this.tool === 'use') {
      // "Use" (U, like OnShape): an edge of the model lights up; a click takes it into the sketch
      const edge = this.vp.pickEdge(e.ndc);
      this.useEdge = edge;
      const part = edge && this.vp.pickable.get(edge.partId)?.part;
      this.vp.setEdgeMarks(part ? { hover: chainOf(part, edge.segments).flatMap(c => c.points.slice(1).flatMap((p, i) => [c.points[i], p])) } : null);
      this.vp.canvas.style.cursor = edge ? 'pointer' : '';
      return;
    }
    if (this.placing) {
      // the dimension follows the pointer until it is placed: dragged straight up or down it measures across (horizontal), left or right
      // upright (vertical), at a slant the direct distance; an angle measures the quadrant it is dragged into
      const p = this.local(e);
      if (p && this.placing.c.linear) linearKind(this.entities, this.placing.c, p);
      const shape = p && dimensionShape(this.entities, this.placing.c, this.vp.mmPerPixel);
      if (shape) this.placing.c.off = [p[0] - shape.anchor[0], p[1] - shape.anchor[1]];
      if (shape && this.placing.c.type === 'angle') {
        const again = dimensionShape(this.entities, this.placing.c, this.vp.mmPerPixel);
        if (again?.flip !== undefined) this.placing.c.flip = again.flip;
      }
      if (this.placing.final) { this.draw(); return; }
    }
    if (!DRAW_TOOLS.includes(this.tool)) {
      const p = this.local(e);
      const hit = p && this.pickAt(p);
      // a point under the pointer lights up alone (not its whole line), a curve as a whole: so one sees what a click takes
      const curve = hit?.kind === 'curve' ? hit.ref.e : null;
      const point = hit?.kind === 'point' ? hit.ref.e + '.' + hit.ref.k : null;
      if (curve !== this.hover || point !== this.hoverPoint || this.placing) { this.hover = curve; this.hoverPoint = point; this.draw(); }
      this.vp.canvas.style.cursor = hit ? 'pointer' : '';
      return;
    }
    const [from, prev] = this.drawContext();
    this.located = this.locate(e, from, prev);
    this.cursor = this.located?.p || null;
    // what the pointer snaps to lights up like a hover
    const target = this.located?.target || '';
    this.hover = target.startsWith('e:') ? target.slice(2) : null;
    this.hoverPoint = target.startsWith('p:') ? target.slice(2) : null;
    this.draw();
  }

  /**
   * Pressing in the select tool: on a point, a line (both ends) or a circle (its centre) it is dragged as far as the constraints allow;
   * in empty space a selection box is drawn (to the right: what lies wholly inside; to the left: what it touches), like OnShape.
   */
  down(e) {
    // trim like OnShape: press and drag across the pieces that should go
    if (this.tool === 'trim') { this.trimming = new Set(); this.vp.navigationOnly = true; return; }
    if (DRAW_TOOLS.includes(this.tool)) {
      // like OnShape: press – drag – release draws as well as click – click; the press sets the first point
      if (!this.points.length && !CLICK_ONLY.includes(this.tool)) {
        const [from, prev] = this.drawContext();
        const located = this.locate(e, from, prev);
        if (located) { this.points.push(located); this.pressed = { x: e.clientX, y: e.clientY }; this.located = null; this.draw(); }
      }
      return;
    }
    if (this.tool !== 'select') return;
    const p = this.local(e);
    if (!p) return;
    const hit = this.pickAt(p);
    this.vp.navigationOnly = true;
    if (!hit || hit.ref.e === ORIGIN) { this.box = { a: p, b: p, sx: e.clientX, sy: e.clientY, ex: e.clientX, ey: e.clientY }; return; }
    let refs;
    if (hit.kind === 'point') refs = [hit.ref];
    else if (hit.entity.t === 'line' || hit.entity.t === 'rect') refs = [{ e: hit.ref.e, k: 'a' }, { e: hit.ref.e, k: 'b' }];
    else if (hit.entity.c) refs = [{ e: hit.ref.e, k: 'c' }];
    else refs = [{ e: hit.ref.e, k: 'p' }];
    this.dragging = { start: p, refs: refs.map(ref => ({ ref, from: pointOfRef(this.entities, ref) })), before: this.snapshot(), moved: false };
  }

  dragMove(e) {
    if (this.trimming) {
      const p = this.local(e), hit = p && this.curveAt(p);
      if (hit && !this.trimming.has(hit.id)) { this.trimming.add(hit.id); this.trimAt(p, this.trimming.size > 1); }
      return;
    }
    // drawing with the button held: the preview follows like on hover
    if (DRAW_TOOLS.includes(this.tool)) { this.move(e); return; }
    const p = this.local(e);
    if (!p) return;
    if (this.box) {
      Object.assign(this.box, { b: p, ex: e.clientX, ey: e.clientY });
      this.drawBox();
      return;
    }
    if (!this.dragging) return;
    const dx = p[0] - this.dragging.start[0], dy = p[1] - this.dragging.start[1];
    this.dragging.moved = true;
    this.solve({ drag: this.dragging.refs.map(r => ({ ref: r.ref, to: [r.from[0] + dx, r.from[1] + dy] })), analyse: false, iterations: 20 });
    this.draw();
    this.cb.changed?.();
  }

  dragEnd(e) {
    if (this.trimming) { this.trimming = null; this.vp.navigationOnly = false; return; }
    if (DRAW_TOOLS.includes(this.tool)) {
      const pressed = this.pressed;
      this.pressed = null;
      // let go where it was pressed: the first point stays, a click sets the next one
      if (pressed && Math.hypot(e.clientX - pressed.x, e.clientY - pressed.y) < 6) return;
      // a drag that set no point (Esc while pressing, or nothing to snap to) draws nothing
      if (!pressed && !this.points.length) return;
      this.place(e, !!pressed);
      return;
    }
    if (this.box) {
      const crossing = this.box.ex < this.box.sx;
      this.boxSelect(this.box.a, this.box.b, crossing);
      this.box = null;
      this.drawBox();
      this.vp.navigationOnly = DRAW_TOOLS.includes(this.tool);
      this.renderPanel();
      this.draw();
      return;
    }
    if (!this.dragging) return;
    if (this.dragging.moved) { this.history.push(this.dragging.before); this.future = []; }
    this.dragging = null;
    this.vp.navigationOnly = DRAW_TOOLS.includes(this.tool);
    this.solve();
    this.renderPanel();
    this.draw();
    this.cb.changed?.();
  }

  /** Adds what the box holds to the selection: wholly inside (window) or touched (crossing). */
  boxSelect(a, b, crossing) {
    const [x0, x1] = [Math.min(a[0], b[0]), Math.max(a[0], b[0])], [y0, y1] = [Math.min(a[1], b[1]), Math.max(a[1], b[1])];
    const inside = q => q[0] >= x0 && q[0] <= x1 && q[1] >= y0 && q[1] <= y1;
    // a piece of a curve touches the box when it lies in it or crosses it (Liang-Barsky clipping)
    const touches = (a, b) => {
      let t0 = 0, t1 = 1;
      const dx = b[0] - a[0], dy = b[1] - a[1];
      for (const [p, q] of [[-dx, a[0] - x0], [dx, x1 - a[0]], [-dy, a[1] - y0], [dy, y1 - a[1]]]) {
        if (p === 0) { if (q < 0) return false; continue; }
        const r = q / p;
        if (p < 0) { if (r > t1) return false; if (r > t0) t0 = r; } else { if (r < t0) return false; if (r < t1) t1 = r; }
      }
      return true;
    };
    for (const e of this.entities) {
      if (e.t === 'point') { if (inside(e.p)) this.selection.add('p:' + e.id + '.p'); continue; }
      const poly = entityPolyline(e);
      const hit = crossing ? poly.some((p, i) => i > 0 && touches(poly[i - 1], p)) || (poly.length === 1 && inside(poly[0])) : poly.every(inside);
      if (hit) this.selection.add('e:' + e.id);
    }
  }

  /** The selection box over the view: solid to the right (window), dashed to the left (crossing). */
  drawBox() {
    let node = this.labels?.querySelector('.ms-selbox');
    if (!this.box) { node?.remove(); return; }
    if (!node && this.labels) { node = el('div', { class: 'ms-selbox' }); this.labels.append(node); }
    if (!node) return;
    const host = this.vp.canvas.parentElement.getBoundingClientRect();
    const { sx, sy, ex, ey } = this.box;
    node.classList.toggle('is-crossing', ex < sx);
    node.style.left = Math.min(sx, ex) - host.left + 'px';
    node.style.top = Math.min(sy, ey) - host.top + 'px';
    node.style.width = Math.abs(ex - sx) + 'px';
    node.style.height = Math.abs(ey - sy) + 'px';
  }

  click(e) {
    if (this.trimming) { this.trimming = null; this.vp.navigationOnly = false; }
    if (this.dragging) { this.dragging = null; this.vp.navigationOnly = DRAW_TOOLS.includes(this.tool); }
    if (this.box) { this.box = null; this.drawBox(); this.vp.navigationOnly = DRAW_TOOLS.includes(this.tool); }
    if (this.tool === 'select') return this.selectClick(e);
    if (this.tool === 'use') return this.useClick(e);
    if (this.tool === 'trim') return this.trimAt(this.local(e));
    if (this.tool === 'offset') return this.offsetClick(e);
    if (this.tool === 'sfillet') return this.filletClick(e);
    if (this.tool === 'mirror') return this.mirrorClick(e);
    if (this.tool === 'dimension') return this.dimensionClick(e);
    if (this.tool.startsWith('constraint:')) return this.constraintClick(e);
    // the press set this point already
    if (this.pressed) { this.pressed = null; this.located = null; this.draw(); return; }
    this.place(e);
  }

  /** A point of a drawing tool where the pointer is (snapped); dragged: the shape was drawn by press – drag – release. */
  place(e, dragged = false) {
    const [from, prev] = this.drawContext();
    const located = this.locate(e, from, prev);
    if (!located) return;
    this.points.push(located);
    this.tryComplete();
    // a line drawn by dragging is one line (like OnShape); clicks make a chain
    if (dragged && this.tool === 'line') this.points = [];
    this.located = null;
    this.draw();
  }

  /** Like OnShape: every click adds to the selection (a second click on the same thing takes it out), a click into empty space clears it. The origin can be picked too. */
  selectClick(e) {
    const p = this.local(e);
    const hit = p && this.pickAt(p);
    const key = !hit ? null : hit.kind === 'point' ? 'p:' + hit.ref.e + '.' + hit.ref.k : 'e:' + hit.ref.e;
    if (!key) this.selection.clear();
    else if (this.selection.has(key)) this.selection.delete(key);
    else this.selection.add(key);
    this.renderPanel();
    this.draw();
  }

  // ---- editing tools: trim, offset, fillet, mirror (sketchtools.js does the geometry) -----------------------------------------

  /** The curve under the pointer (not its points): for trim, offset, mirror. */
  curveAt(p) {
    let best = null, bestD = 10 * this.vp.mmPerPixel;
    for (const e of this.entities) {
      if (e.t === 'point') continue;
      const d = distToEntity(p, e);
      if (d < bestD) { bestD = d; best = e; }
    }
    return best;
  }

  /** Trim (M): the piece of the curve under the pointer up to its crossings goes; within one drag the steps are one undo step. */
  trimAt(p, sameStep = false) {
    const e = p && this.curveAt(p);
    if (!e) return;
    const res = trim(this.entities, this.cons, e.id, p, () => uid('e'));
    if (!res) { this.cb.status(t('Sketch.TrimNothing')); return; }
    if (!sameStep) this.remember();
    this.entities = res.entities;
    this.cons = res.cons;
    this.selection.clear();
    this.solve();
    this.renderPanel();
    this.draw();
    this.cb.changed?.();
  }

  /** Offset (O): a click on a curve takes its chain; the copy goes to the side the click was on, at the distance typed. */
  offsetClick(e) {
    const p = this.local(e), c = p && this.curveAt(p);
    if (!c) return;
    const size = (() => { const pts = entityPolyline(c); const xs = pts.map(q => q[0]), ys = pts.map(q => q[1]); return Math.hypot(Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys)); })();
    this.askValue(e.clientX, e.clientY, t('Sketch.OffsetDistance'), niceValue(size / 10 / this.unit), mm => {
      const res = offsetChain(this.entities, c.id, mm, p, () => uid('e'));
      if (!res) { this.cb.status(t('Sketch.OffsetFailed')); return; }
      const d = res.cons.find(k => k.type === 'distance');
      if (d) d.value = fmt(mm / this.unit, 4).replace(',', '.');
      this.addAll(res.entities, res.cons);
    });
  }

  /** Sketch fillet: a click on the corner of two lines, then the radius. */
  filletClick(e) {
    const p = this.local(e), hit = p && this.pickAt(p);
    if (hit?.kind !== 'point' || hit.ref.e === ORIGIN) { this.cb.status(t('Sketch.Hint.sfillet')); return; }
    const corner = hit.p;
    const lines = this.entities.filter(x => x.t === 'line' && !x.cons && [x.a, x.b].some(q => Math.hypot(q[0] - corner[0], q[1] - corner[1]) < 1e-6));
    if (lines.length !== 2) { this.cb.status(t('Sketch.FilletNoCorner')); return; }
    const shortest = Math.min(...lines.map(l => Math.hypot(l.b[0] - l.a[0], l.b[1] - l.a[1])));
    this.askValue(e.clientX, e.clientY, t('Sketch.FilletRadius'), niceValue(shortest / 4 / this.unit), mm => {
      const res = filletCorner(this.entities, this.cons, hit.ref, mm, () => uid('e'));
      if (!res) { this.cb.status(t('Sketch.FilletTooBig')); return; }
      const r = res.cons.find(k => k.id === res.radiusId);
      if (r) r.value = fmt(mm / this.unit, 4).replace(',', '.');
      this.change(() => { this.entities = res.entities; this.cons = res.cons; });
    });
  }

  /** Mirror: first the line to mirror about, then what is mirrored (or what was selected before). The copies are held symmetric. */
  mirrorClick(e) {
    const p = this.local(e), c = p && this.curveAt(p);
    if (!c) return;
    if (!this.mirrorLine) {
      if (c.t !== 'line') { this.cb.status(t('Sketch.Hint.mirror')); return; }
      this.mirrorLine = c.id;
      const chosen = [...this.selection].filter(k => k.startsWith('e:')).map(k => k.slice(2)).filter(id => id !== c.id);
      if (chosen.length) { this.mirrorIds(chosen); this.selection.clear(); }
      this.cb.status(t('Sketch.Hint.mirror2'));
      this.draw();
      return;
    }
    if (c.id === this.mirrorLine) return;
    this.mirrorIds([c.id]);
  }

  mirrorIds(ids) {
    const res = mirror(this.entities, ids, this.mirrorLine, () => uid('e'));
    if (res) this.addAll(res.entities, res.cons);
  }

  /** Where a tangent arc starts: the end of a line or arc, and the direction the curve goes on in there. */
  tangentStart(a) {
    const r = a?.ref;
    const e = r && this.entities.find(x => x.id === r.e);
    if (!e) return null;
    if (e.t === 'line' && (r.k === 'a' || r.k === 'b')) return { ref: r, curve: e.id, dir: r.k === 'b' ? [e.b[0] - e.a[0], e.b[1] - e.a[1]] : [e.a[0] - e.b[0], e.a[1] - e.b[1]] };
    if (e.t === 'arc' && (r.k === 's' || r.k === 'e')) return { ref: r, curve: e.id, dir: r.k === 'e' ? [-Math.sin(e.a1), Math.cos(e.a1)] : [Math.sin(e.a0), -Math.cos(e.a0)] };
    return null;
  }

  finishSpline() {
    const pts = this.points;
    if (pts.length >= 2) {
      const sp = { id: uid('e'), t: 'spline', pts: pts.map(x => x.p) };
      this.addAll([sp], [...this.tie({ e: sp.id, k: 'a' }, pts[0]), ...this.tie({ e: sp.id, k: 'b' }, pts[pts.length - 1])]);
    }
    this.points = [];
  }

  /** A small field over the view for a length (offset, fillet radius): Enter applies it (in mm), Esc closes. */
  askValue(clientX, clientY, label, initial, apply) {
    this.closeEditor();
    const host = this.vp.canvas.parentElement, box = host.getBoundingClientRect();
    const input = el('input', { class: 'mat-input mat-input--sm mat-mono', value: initial, autocomplete: 'off', spellcheck: 'false', 'aria-label': label, title: label });
    const editor = el('div', { class: 'ms-dimedit' }, el('span', { class: 'ms-dimedit__label' }, label), input);
    editor.style.left = Math.max(4, Math.min(box.width - 240, clientX - box.left - 60)) + 'px';
    editor.style.top = Math.max(4, Math.min(box.height - 44, clientY - box.top + 14)) + 'px';
    host.append(editor);
    this.editor = editor;
    const go = () => {
      let mm;
      try { mm = this.evaluate({ type: 'length', value: input.value.trim() }); if (!(mm > 0)) throw new Error('positive'); } catch { input.setAttribute('aria-invalid', 'true'); return; }
      this.closeEditor();
      apply(mm);
    };
    input.addEventListener('keydown', ev => { ev.stopPropagation(); if (ev.key === 'Enter') { ev.preventDefault(); go(); } if (ev.key === 'Escape') { ev.preventDefault(); this.closeEditor(); } });
    this.editorApply = go;
    this.focusEditor();
    setTimeout(() => this.focusEditor(), 40);
  }

  /** Text: what to write and how high; the letters become fixed curves of the sketch (their outlines, traced from the font of the browser). */
  askText(at) {
    this.closeEditor();
    const host = this.vp.canvas.parentElement, box = host.getBoundingClientRect();
    const s0 = this.vp.project(toWorld(this.frame, at[0], at[1]));
    const text = el('input', { class: 'mat-input mat-input--sm', value: '', autocomplete: 'off', placeholder: t('Sketch.TextValue'), 'aria-label': t('Sketch.TextValue') });
    const height = el('input', { class: 'mat-input mat-input--sm mat-mono ms-dimedit__small', value: niceValue(this.vp.viewHeight / 12 / this.unit), autocomplete: 'off', 'aria-label': t('Sketch.TextHeight'), title: t('Sketch.TextHeight') });
    const editor = el('div', { class: 'ms-dimedit' }, text, height);
    editor.style.left = Math.max(4, Math.min(box.width - 300, s0.x - 20)) + 'px';
    editor.style.top = Math.max(4, Math.min(box.height - 44, s0.y + 14)) + 'px';
    host.append(editor);
    this.editor = editor;
    const go = () => {
      let mm;
      try { mm = this.evaluate({ type: 'length', value: height.value.trim() }); if (!(mm > 0)) throw new Error('positive'); } catch { height.setAttribute('aria-invalid', 'true'); return; }
      const value = text.value.trim();
      this.closeEditor();
      if (!value) return;
      const curves = textCurves(value, mm, at);
      if (curves.length) this.addUsed(curves);
    };
    for (const input of [text, height]) input.addEventListener('keydown', ev => { ev.stopPropagation(); if (ev.key === 'Enter') { ev.preventDefault(); go(); } if (ev.key === 'Escape') { ev.preventDefault(); this.closeEditor(); } });
    this.editorApply = go;
    setTimeout(() => text.focus({ preventScroll: true }), 40);
  }

  // ---- a picture behind the sketch (to trace) ---------------------------------------------------------------------------------

  /** Puts a picture into the plane of the sketch, centred on the origin, 100 mm wide (made smaller in the browser, kept with the sketch). */
  async setImage(file) {
    const url = await new Promise((resolve, reject) => { const r = new FileReader(); r.onload = () => resolve(r.result); r.onerror = reject; r.readAsDataURL(file); });
    const img = new Image();
    img.src = url;
    await img.decode();
    const k = Math.min(1, 1600 / Math.max(img.width, img.height));
    const c = document.createElement('canvas');
    c.width = Math.max(1, Math.round(img.width * k)); c.height = Math.max(1, Math.round(img.height * k));
    c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
    const png = /png|gif|svg/.test(file.type);
    const src = png ? c.toDataURL('image/png') : c.toDataURL('image/jpeg', 0.85);
    this.remember();
    this.image = { src: src.length < 1200000 ? src : c.toDataURL('image/jpeg', 0.7), aspect: c.height / c.width, width: 100, x: 0, y: 0, opacity: 0.6 };
    this.renderPanel();
    this.draw();
    this.cb.changed?.();
  }

  imageFields() {
    const img = this.image;
    const box = el('div', { class: 'ms-imgfields' }, el('p', { class: 'ms-dialog__text ms-muted' }, icon('image'), ' ', t('Sketch.Image.Title')));
    const field = (label, key, step) => {
      const input = el('input', { class: 'mat-input mat-input--sm mat-mono', type: 'number', step, value: String(Math.round(img[key] / (key === 'opacity' ? 1 : this.unit) * 1000) / 1000), 'aria-label': label });
      input.addEventListener('change', () => { const v = Number(input.value); if (Number.isFinite(v) && (key !== 'width' || v > 0)) { img[key] = key === 'opacity' ? Math.min(1, Math.max(0.05, v)) : v * this.unit; this.draw(); this.cb.changed?.(); } });
      return el('label', { class: 'mat-field ms-field-sm' }, el('span', { class: 'mat-label' }, label), input);
    };
    box.append(el('div', { class: 'ms-dialog__pair' }, field(t('Sketch.Image.Width'), 'width', 'any'), field(t('Sketch.Image.Opacity'), 'opacity', '0.1')));
    box.append(el('div', { class: 'ms-dialog__pair' }, field('X', 'x', 'any'), field('Y', 'y', 'any')));
    box.append(el('button', { type: 'button', class: 'mat-btn mat-btn--ghost mat-btn--sm', onclick: () => { this.remember(); this.image = null; this.renderPanel(); this.draw(); this.cb.changed?.(); } }, icon('trash'), el('span', null, t('Sketch.Image.Remove'))));
    return box;
  }

  // ---- geometry from the model (Use, section, outline) ----------------------------------------------------------------------

  /** Takes an edge of the model into the sketch, projected onto its plane (as lines, arcs or a circle; fixed like the geometry OnShape "uses"). */
  useClick(e) {
    const edge = this.useEdge || this.vp.pickEdge(e.ndc);
    const part = edge && this.vp.pickable.get(edge.partId)?.part;
    if (!part) return;
    const curves = chainOf(part, edge.segments).flatMap(c => curvesFromPoints(c.points.map(p => toLocal(this.frame, p)), c.closed));
    if (!curves.length) { this.cb.toast?.(t('Sketch.UseNothing')); return; }
    this.addUsed(curves);
  }

  /** Adds curves from the model (a cut, an outline, an edge): fixed geometry, black like everything that is defined. */
  addUsed(curves) {
    if (!curves.length) return 0;
    this.addAll(curves.map(c => ({ id: uid('e'), ...c, use: true })), []);
    return curves.length;
  }

  // ---- drawing tools, with the constraints they set by themselves ------------------------------------------------------------

  /** The constraints that tie a new point to where it was snapped. */
  tie(ref, located) {
    if (located.ref) return [{ type: 'coincident', refs: [ref, located.ref] }];
    if (located.curve) return [{ type: 'onCurve', refs: [ref, { e: located.curve }] }];
    if (located.mid) return [{ type: 'midpoint', refs: [ref, { e: located.mid }] }];
    return [];
  }

  addAll(entities, constraints) {
    this.change(() => {
      this.entities.push(...entities);
      this.cons.push(...constraints.map(c => ({ id: uid('k'), ...c })));
    });
  }

  tryComplete() {
    const pts = this.points;
    const id = () => uid('e');
    switch (this.tool) {
      case 'point': {
        const p = { id: id(), t: 'point', p: pts[0].p };
        this.addAll([p], this.tie({ e: p.id, k: 'p' }, pts[0]));
        this.points = [];
        break;
      }
      case 'line': {
        if (pts.length < 2) break;
        const [a, b] = pts;
        if (Math.hypot(b.p[0] - a.p[0], b.p[1] - a.p[1]) < 1e-9) { this.points = [a]; break; }
        const line = { id: id(), t: 'line', a: a.p, b: b.p };
        const cons = [...this.tie({ e: line.id, k: 'a' }, a), ...this.tie({ e: line.id, k: 'b' }, b)];
        if (b.h) cons.push({ type: 'horizontal', refs: [{ e: line.id }] });
        if (b.v) cons.push({ type: 'vertical', refs: [{ e: line.id }] });
        const before = a.ref?.k === 'b' ? this.entities.find(x => x.id === a.ref.e && x.t === 'line') : null;
        if (b.perp && before) cons.push({ type: 'perpendicular', refs: [{ e: before.id }, { e: line.id }] });
        this.addAll([line], cons);
        // a chain: the next line starts at the end of this one; it ends when it closes on a point that was there, or with Esc
        this.points = b.ref ? [] : [{ p: b.p, ref: { e: line.id, k: 'b' } }];
        break;
      }
      case 'rect':
      case 'crect': {
        if (pts.length < 2) break;
        const [p1, p2] = pts;
        let x0, y0, x1, y1;
        if (this.tool === 'rect') { [x0, y0] = p1.p; [x1, y1] = p2.p; }
        else { const dx = Math.abs(p2.p[0] - p1.p[0]), dy = Math.abs(p2.p[1] - p1.p[1]); [x0, y0, x1, y1] = [p1.p[0] - dx, p1.p[1] - dy, p1.p[0] + dx, p1.p[1] + dy]; }
        if (Math.abs(x1 - x0) < 1e-9 || Math.abs(y1 - y0) < 1e-9) { this.points = [p1]; break; }
        // four lines, joined, two level and two upright: a rectangle the way OnShape draws it
        const L = [[x0, y0, x1, y0], [x1, y0, x1, y1], [x1, y1, x0, y1], [x0, y1, x0, y0]].map(([ax, ay, bx, by]) => ({ id: id(), t: 'line', a: [ax, ay], b: [bx, by] }));
        const cons = [];
        for (let i = 0; i < 4; i++) cons.push({ type: 'coincident', refs: [{ e: L[i].id, k: 'b' }, { e: L[(i + 1) % 4].id, k: 'a' }] });
        cons.push({ type: 'horizontal', refs: [{ e: L[0].id }] }, { type: 'horizontal', refs: [{ e: L[2].id }] }, { type: 'vertical', refs: [{ e: L[1].id }] }, { type: 'vertical', refs: [{ e: L[3].id }] });
        const entities = [...L];
        if (this.tool === 'rect') {
          cons.push(...this.tie({ e: L[0].id, k: 'a' }, p1), ...this.tie({ e: L[1].id, k: 'b' }, p2));
        } else {
          // the centre: a construction diagonal with a point in its middle
          const diagonal = { id: id(), t: 'line', a: [x0, y0], b: [x1, y1], cons: true };
          const centre = { id: id(), t: 'point', p: p1.p, cons: true };
          entities.push(diagonal, centre);
          cons.push({ type: 'coincident', refs: [{ e: diagonal.id, k: 'a' }, { e: L[0].id, k: 'a' }] }, { type: 'coincident', refs: [{ e: diagonal.id, k: 'b' }, { e: L[2].id, k: 'a' }] },
            { type: 'midpoint', refs: [{ e: centre.id, k: 'p' }, { e: diagonal.id }] }, ...this.tie({ e: centre.id, k: 'p' }, p1));
        }
        this.addAll(entities, cons);
        this.points = [];
        break;
      }
      case 'circle': {
        if (pts.length < 2) break;
        const r = Math.hypot(pts[1].p[0] - pts[0].p[0], pts[1].p[1] - pts[0].p[1]);
        if (r > 0) { const c = { id: id(), t: 'circle', c: pts[0].p, r }; this.addAll([c], this.tie({ e: c.id, k: 'c' }, pts[0])); }
        this.points = [];
        break;
      }
      case 'polygon': {
        if (pts.length < 2) break;
        const r = Math.hypot(pts[1].p[0] - pts[0].p[0], pts[1].p[1] - pts[0].p[1]);
        const rot = Math.atan2(pts[1].p[1] - pts[0].p[1], pts[1].p[0] - pts[0].p[0]) * 180 / Math.PI;
        if (r > 0) {
          // like OnShape: the sides as lines on a construction circle, all equal; the tie of the centre goes to the circle
          const g = { id: id(), t: 'polygon', c: pts[0].p, r, n: this.polygonSides, rot: Math.round(rot * 1e6) / 1e6 };
          const made = adoptSketch([g], [], { id: uid });
          this.addAll(made.entities, [...made.cons, ...this.tie({ e: g.id + '_c', k: 'c' }, pts[0])]);
        }
        this.points = [];
        break;
      }
      case 'slot': {
        // the centre of one end, the centre of the other, then how wide
        if (pts.length < 3) break;
        const [p1, p2, p3] = pts, d = [p2.p[0] - p1.p[0], p2.p[1] - p1.p[1]], l = Math.hypot(d[0], d[1]);
        const r = l > 1e-9 ? Math.abs(((p3.p[0] - p1.p[0]) * d[1] - (p3.p[1] - p1.p[1]) * d[0]) / l) : 0;
        const made = slot(p1.p, p2.p, r, id);
        if (made) { const axis = made.entities[4]; this.addAll(made.entities, [...made.cons, ...this.tie({ e: axis.id, k: 'a' }, p1), ...this.tie({ e: axis.id, k: 'b' }, p2)]); }
        this.points = [];
        break;
      }
      case 'tarc': {
        // from the end of a line or arc, on in its direction, to the next point; the next one goes on from there
        if (pts.length < 2) break;
        const [a, b] = pts, from = this.tangentStart(a);
        if (!from) { this.points = []; this.cb.status(t('Sketch.Hint.tarcStart')); break; }
        const g = tangentArc(a.p, from.dir, b.p);
        if (!g) { this.points = [a]; break; }
        const arc = { id: id(), t: 'arc', c: g.c, r: g.r, a0: g.a0, a1: g.a1 };
        const k0 = g.startIsA0 ? 's' : 'e', k1 = g.startIsA0 ? 'e' : 's';
        this.addAll([arc], [{ type: 'coincident', refs: [{ e: arc.id, k: k0 }, from.ref] }, { type: 'tangent', refs: [{ e: from.curve }, { e: arc.id }] }, ...this.tie({ e: arc.id, k: k1 }, b)]);
        this.points = b.ref ? [] : [{ p: b.p, ref: { e: arc.id, k: k1 } }];
        break;
      }
      case 'spline': {
        // a click on the last point again (a double click) ends it; so does Esc
        const n = pts.length, mm = this.vp.mmPerPixel;
        if (n >= 2 && Math.hypot(pts[n - 1].p[0] - pts[n - 2].p[0], pts[n - 1].p[1] - pts[n - 2].p[1]) < 4 * mm) { pts.pop(); this.finishSpline(); }
        break;
      }
      case 'ellipse': {
        // the centre, the end of the long axis, then a point for the short one
        if (pts.length < 3) break;
        const [c0, a, b] = pts, rx = Math.hypot(a.p[0] - c0.p[0], a.p[1] - c0.p[1]);
        if (rx > 1e-9) {
          const u = [(a.p[0] - c0.p[0]) / rx, (a.p[1] - c0.p[1]) / rx], ry = Math.abs(u[0] * (b.p[1] - c0.p[1]) - u[1] * (b.p[0] - c0.p[0]));
          if (ry > 1e-9) { const el2 = { id: id(), t: 'ellipse', c: c0.p, rx, ry, rot: Math.atan2(u[1], u[0]) }; this.addAll([el2], this.tie({ e: el2.id, k: 'c' }, c0)); }
        }
        this.points = [];
        break;
      }
      case 'text': {
        this.askText(pts[0].p);
        this.points = [];
        break;
      }
      case 'arc': {
        // start, end, then a point the arc passes through
        if (pts.length < 3) break;
        const arc = arcThrough(pts[0].p, pts[2].p, pts[1].p);
        if (arc) {
          const a = { id: id(), t: 'arc', ...arc };
          // arcThrough may have swapped the ends: tie each pick to the end it became
          const start = [a.c[0] + a.r * Math.cos(a.a0), a.c[1] + a.r * Math.sin(a.a0)];
          const swapped = Math.hypot(start[0] - pts[0].p[0], start[1] - pts[0].p[1]) > 1e-6;
          this.addAll([a], [...this.tie({ e: a.id, k: swapped ? 'e' : 's' }, pts[0]), ...this.tie({ e: a.id, k: swapped ? 's' : 'e' }, pts[1])]);
        }
        this.points = [];
        break;
      }
    }
  }

  preview() {
    const pts = this.points.map(x => x.p), c = this.cursor;
    if (!c || !pts.length) return [];
    switch (this.tool) {
      case 'line': return [{ id: 'p', t: 'line', a: pts[0], b: c }];
      case 'rect': return [{ id: 'p', t: 'rect', a: pts[0], b: c }];
      case 'crect': { const dx = Math.abs(c[0] - pts[0][0]), dy = Math.abs(c[1] - pts[0][1]); return [{ id: 'p', t: 'rect', a: [pts[0][0] - dx, pts[0][1] - dy], b: [pts[0][0] + dx, pts[0][1] + dy] }]; }
      case 'circle': return [{ id: 'p', t: 'circle', c: pts[0], r: Math.hypot(c[0] - pts[0][0], c[1] - pts[0][1]) }];
      case 'polygon': return [{ id: 'p', t: 'polygon', c: pts[0], r: Math.hypot(c[0] - pts[0][0], c[1] - pts[0][1]), n: this.polygonSides, rot: Math.atan2(c[1] - pts[0][1], c[0] - pts[0][0]) * 180 / Math.PI }];
      case 'slot': {
        if (pts.length === 1) return [{ id: 'p', t: 'line', a: pts[0], b: c, cons: true }];
        const d = [pts[1][0] - pts[0][0], pts[1][1] - pts[0][1]], l = Math.hypot(d[0], d[1]);
        const made = l > 1e-9 && slot(pts[0], pts[1], Math.abs(((c[0] - pts[0][0]) * d[1] - (c[1] - pts[0][1]) * d[0]) / l), () => 'p');
        return made ? made.entities : [{ id: 'p', t: 'line', a: pts[0], b: pts[1], cons: true }];
      }
      case 'tarc': {
        const from = this.tangentStart(this.points[0]), g = from && tangentArc(pts[0], from.dir, c);
        return g ? [{ id: 'p', t: 'arc', c: g.c, r: g.r, a0: g.a0, a1: g.a1 }] : [{ id: 'p', t: 'line', a: pts[0], b: c, cons: true }];
      }
      case 'spline': return [{ id: 'p', t: 'spline', pts: [...pts, c] }];
      case 'ellipse': {
        if (pts.length === 1) return [{ id: 'p', t: 'line', a: pts[0], b: c, cons: true }];
        const rx = Math.hypot(pts[1][0] - pts[0][0], pts[1][1] - pts[0][1]);
        if (rx < 1e-9) return [];
        const u = [(pts[1][0] - pts[0][0]) / rx, (pts[1][1] - pts[0][1]) / rx], ry = Math.abs(u[0] * (c[1] - pts[0][1]) - u[1] * (c[0] - pts[0][0]));
        return [{ id: 'p', t: 'ellipse', c: pts[0], rx, ry: Math.max(ry, rx * 0.02), rot: Math.atan2(u[1], u[0]) }];
      }
      case 'arc': {
        if (pts.length === 1) return [{ id: 'p', t: 'line', a: pts[0], b: c, cons: true }];
        const arc = arcThrough(pts[0], c, pts[1]);
        return arc ? [{ id: 'p', t: 'arc', ...arc }] : [{ id: 'p', t: 'line', a: pts[0], b: pts[1] }];
      }
      default: return [];
    }
  }

  // ---- constraints (select first, then the tool – or the tool, then the picks) -------------------------------------------------

  items() {
    return [...this.selection].map(k => {
      if (k.startsWith('e:')) return { kind: 'curve', ref: { e: k.slice(2) }, entity: this.entities.find(e => e.id === k.slice(2)) };
      if (k.startsWith('p:')) { const [e, kk] = k.slice(2).split('.'); return { kind: 'point', ref: { e, k: kk } }; }
      return null;
    }).filter(Boolean);
  }

  /** A constraint tool of the toolbar or a key: with a fitting selection it is set at once, else the tool waits for the picks. */
  constrain(type) {
    if (this.selection.size && this.makeConstraint(type, this.items())) { this.selection.clear(); this.renderPanel(); this.draw(); return; }
    this.setTool('constraint:' + type);
  }

  constraintClick(e) {
    const p = this.local(e);
    const hit = p && this.pickAt(p);
    if (!hit) return;
    this.picks.push(hit);
    const type = this.tool.slice('constraint:'.length);
    const enough = type === 'fix' || (['horizontal', 'vertical'].includes(type) && hit.kind === 'curve' && this.picks.length === 1) || this.picks.length >= (type === 'symmetric' ? 3 : 2);
    if (enough) {
      if (!this.makeConstraint(type, this.picks)) this.cb.status(t('Sketch.ConstraintNoFit'));
      else this.cb.status(t('Sketch.Hint.constraint'));
      this.picks = [];
    }
    this.draw();
  }

  /** Builds the constraint from the picked items; false when they do not fit. */
  makeConstraint(type, items) {
    const points = items.filter(i => i.kind === 'point'), curves = items.filter(i => i.kind === 'curve');
    const lines = curves.filter(c => c.entity?.t === 'line'), rounds = curves.filter(c => ['circle', 'arc', 'polygon'].includes(c.entity?.t));
    const out = [];
    switch (type) {
      case 'coincident':
        if (points.length === 2 && !curves.length) out.push({ type, refs: [points[0].ref, points[1].ref] });
        else if (points.length === 1 && curves.length === 1) out.push({ type: 'onCurve', refs: [points[0].ref, curves[0].ref] });
        break;
      case 'horizontal':
      case 'vertical':
        if (points.length === 2 && !curves.length) out.push({ type, refs: [points[0].ref, points[1].ref] });
        else if (lines.length && !points.length) lines.forEach(l => out.push({ type, refs: [l.ref] }));
        break;
      case 'parallel':
      case 'perpendicular':
        if (lines.length === 2 && !points.length) out.push({ type, refs: [lines[0].ref, lines[1].ref] });
        break;
      case 'equal':
        if ((lines.length === 2 || rounds.length === 2) && curves.length === 2) out.push({ type, refs: [curves[0].ref, curves[1].ref] });
        break;
      case 'concentric':
        if (rounds.length === 2) out.push({ type, refs: [rounds[0].ref, rounds[1].ref] });
        break;
      case 'tangent':
        if (curves.length === 2 && rounds.length >= 1) {
          const c = { type, refs: [curves[0].ref, curves[1].ref] };
          if (rounds.length === 2) { const [a, b] = rounds.map(r => r.entity); c.inside = Math.hypot(a.c[0] - b.c[0], a.c[1] - b.c[1]) < Math.max(a.r, b.r); }
          out.push(c);
        }
        break;
      case 'midpoint':
        if (points.length === 1 && lines.length === 1) out.push({ type, refs: [points[0].ref, lines[0].ref] });
        break;
      case 'symmetric': {
        // the last line picked is the axis
        const axis = [...items].reverse().find(i => i.kind === 'curve' && i.entity?.t === 'line');
        const rest = items.filter(i => i !== axis);
        if (axis && rest.length === 2 && rest.every(i => i.kind === 'point')) out.push({ type, refs: [rest[0].ref, rest[1].ref, axis.ref] });
        else if (axis && rest.length === 2 && rest.every(i => i.entity?.c)) {
          out.push({ type, refs: [{ e: rest[0].ref.e, k: 'c' }, { e: rest[1].ref.e, k: 'c' }, axis.ref] });
          if (rest.every(i => ['circle', 'arc'].includes(i.entity.t))) out.push({ type: 'equal', refs: [rest[0].ref, rest[1].ref] });
        }
        break;
      }
      case 'fix':
        points.filter(p => p.ref.e !== ORIGIN).forEach(p => out.push({ type, refs: [p.ref], at: pointOfRef(this.entities, p.ref) }));
        curves.forEach(c => out.push({ type, refs: [c.ref], at: valuesOf(c.entity) }));
        break;
    }
    if (!out.length) return false;
    this.change(() => { this.cons.push(...out.map(c => ({ id: uid('k'), ...c }))); });
    return true;
  }

  // ---- dimensions (tool D): pick one or two things, then set the value -------------------------------------------------------

  /**
   * Like OnShape: click one curve (its length / diameter / radius follows the pointer) or two things (distance or angle), move the dimension to where it
   * should stand, click to place it, type the value.
   */
  dimensionClick(e) {
    const p = this.local(e);
    if (!p) return;
    const hit = this.pickAt(p);
    if (this.placing && (this.placing.final || !hit)) { this.placeDimension(e); return; }
    if (!hit) {
      this.picks = [];
      this.placing = null;
      this.cb.status(t('Sketch.Hint.dimension'));
      this.draw();
      return;
    }
    this.picks.push(hit);
    const c = this.dimensionFor(this.picks);
    // the two ends of an arc: the chord follows the pointer, a click on the arc makes it the length along the arc (like OnShape)
    const [p1, p2] = this.picks;
    if (this.picks.length === 2 && p1.kind === 'point' && p2.kind === 'point' && p1.ref.e === p2.ref.e && ['s', 'e'].includes(p1.ref.k) && ['s', 'e'].includes(p2.ref.k) && p1.ref.k !== p2.ref.k) {
      this.placing = c ? { c, final: false } : null;
      this.cb.status(t('Sketch.Hint.dimensionArc'));
      if (this.placing) { const shape = dimensionShape(this.entities, c, this.vp.mmPerPixel); if (shape) c.off = [p[0] - shape.anchor[0], p[1] - shape.anchor[1]]; }
      this.draw();
      return;
    }
    if (this.picks.length === 1) {
      this.placing = c ? { c, final: false } : null;
      this.cb.status(t(c ? 'Sketch.Hint.dimensionOne' : 'Sketch.Hint.dimension2'));
    } else {
      this.picks = [];
      if (!c) { this.placing = null; this.cb.status(t('Sketch.DimensionNoFit')); this.draw(); return; }
      this.placing = { c, final: true };
      this.cb.status(t('Sketch.Hint.dimensionPlace'));
    }
    if (this.placing) {
      const shape = dimensionShape(this.entities, this.placing.c, this.vp.mmPerPixel);
      if (shape) this.placing.c.off = [p[0] - shape.anchor[0], p[1] - shape.anchor[1]];
    }
    this.draw();
  }

  /** The dimension the picks ask for: { type, refs } or null. */
  dimensionFor(picks) {
    const [a, b, third] = picks;
    if (third) return third.kind === 'curve' && third.entity?.t === 'arc' && third.ref.e === a.ref.e ? { type: 'arclength', refs: [third.ref] } : null;
    if (picks.length === 1 || (b && a.kind === 'curve' && b.kind === 'curve' && a.ref.e === b.ref.e)) {
      const x = a.entity;
      if (x?.t === 'line') {
        // a slanted line: its length, or what it measures across or upright, depending on where the dimension is dragged
        const slanted = Math.abs(x.a[0] - x.b[0]) > 1e-9 && Math.abs(x.a[1] - x.b[1]) > 1e-9;
        return { type: 'length', refs: [a.ref], ...(slanted ? { linear: { line: a.ref.e } } : {}) };
      }
      if (x?.t === 'circle') return { type: 'diameter', refs: [a.ref] };
      if (x?.t === 'arc' || x?.t === 'polygon') return { type: 'radius', refs: [a.ref] };
      return null;
    }
    if (a.kind === 'point' && b.kind === 'point') return { type: 'distance', refs: [a.ref, b.ref], linear: { points: [a.ref, b.ref] } };
    if (a.kind === 'point' || b.kind === 'point') {
      const point = a.kind === 'point' ? a : b, curve = a.kind === 'point' ? b : a;
      return curve.entity?.t === 'line' ? { type: 'distance', refs: [point.ref, curve.ref] } : curve.entity?.c ? { type: 'distance', refs: [point.ref, { e: curve.ref.e, k: 'c' }] } : null;
    }
    const [x, y] = [a.entity, b.entity];
    if (x?.t === 'line' && y?.t === 'line') {
      const u = unit2(x), v = unit2(y);
      return Math.abs(u[0] * v[1] - u[1] * v[0]) < 0.02 ? { type: 'distance', refs: [a.ref, b.ref] } : { type: 'angle', refs: [a.ref, b.ref] };
    }
    if (x?.c && y?.c) return { type: 'distance', refs: [{ e: x.id, k: 'c' }, { e: y.id, k: 'c' }] };
    if (x?.t === 'line' && y?.c) return { type: 'distance', refs: [{ e: y.id, k: 'c' }, a.ref] };
    if (y?.t === 'line' && x?.c) return { type: 'distance', refs: [{ e: x.id, k: 'c' }, b.ref] };
    return null;
  }

  /** The click that places the dimension: it becomes a constraint with the measured value, and the field opens for the real one. */
  placeDimension(e) {
    const { c } = this.placing;
    this.placing = null;
    this.picks = [];
    this.cb.status(t('Sketch.Hint.dimension'));
    const existing = this.cons.find(x => x.type === c.type && JSON.stringify(x.refs) === JSON.stringify(c.refs));
    if (existing) { existing.off = c.off; this.draw(); this.editDimension(existing, e.clientX, e.clientY); return; }
    const value = measure(this.entities, c);
    if (value === null) { this.cb.status(t('Sketch.DimensionNoFit')); this.draw(); return; }
    const shown = CONSTRAINTS[c.type].angle ? value : value / this.unit;
    const dim = { id: uid('k'), type: c.type, refs: c.refs, value: fmt(shown, 3).replace(',', '.'), off: c.off, ...(c.flip ? { flip: true } : {}) };
    this.change(() => { this.cons.push(dim); });
    if (this.analysis?.conflicts?.includes(dim.id)) {
      // it would over-define the sketch: like OnShape it becomes a driven dimension (grey, it only shows the value)
      dim.driven = true;
      this.solve();
      this.renderPanel();
      this.draw();
      this.cb.changed?.();
      this.cb.status(t('Sketch.DimensionDriven'));
      return;
    }
    this.editDimension(dim, e.clientX, e.clientY);
  }

  /** The small field over the view where the value is typed (25, 1 in, #width / 2, 30 deg). Enter applies, Esc closes, the bin deletes. */
  editDimension(d, clientX, clientY) {
    this.closeEditor();
    const host = this.vp.canvas.parentElement;
    const box = host.getBoundingClientRect();
    const measured = measure(this.entities, d);
    const now = measured === null ? '' : fmt(CONSTRAINTS[d.type].angle ? measured : measured / this.unit, 3).replace(',', '.');
    const input = el('input', { class: 'mat-input mat-input--sm mat-mono', value: d.driven ? now : d.value, autocomplete: 'off', spellcheck: 'false', 'aria-label': t('Sketch.DimensionValue') });
    input.disabled = !!d.driven;
    const remove = el('button', { type: 'button', class: 'mat-btn mat-btn--ghost mat-btn--icon mat-btn--sm', 'aria-label': t('Sketch.DimensionDelete'), 'data-tip': t('Sketch.DimensionDelete') }, icon('trash'));
    const drive = el('button', { type: 'button', class: 'mat-btn mat-btn--ghost mat-btn--icon mat-btn--sm', 'aria-pressed': d.driven ? 'true' : 'false', 'aria-label': t(d.driven ? 'Sketch.MakeDriving' : 'Sketch.MakeDriven'), 'data-tip': t(d.driven ? 'Sketch.MakeDriving' : 'Sketch.MakeDriven') }, icon('link'));
    const editor = el('div', { class: 'ms-dimedit' + (d.driven ? ' is-driven' : '') }, input, drive, remove);
    editor.style.left = Math.max(4, Math.min(box.width - 190, clientX - box.left - 60)) + 'px';
    editor.style.top = Math.max(4, Math.min(box.height - 44, clientY - box.top + 14)) + 'px';
    host.append(editor);
    this.editor = editor;
    const apply = () => {
      if (d.driven) { this.closeEditor(); return; }
      let text = input.value.trim();
      let v;
      try {
        v = this.evaluate({ ...d, value: text });
        // like OnShape: a negative distance puts the second thing on the other side
        if (v < 0 && FLIPPABLE.includes(d.type) && d.refs.every(r => r?.k)) text = /^-\s*[\d.,]+$/.test(text) ? text.replace(/^-\s*/, '') : `-(${text})`;
        else if (!(v > 0)) throw new Error('positive');
      } catch {
        input.setAttribute('aria-invalid', 'true');
        return;
      }
      this.closeEditor();
      if (v < 0) { this.change(() => { d.value = text; this.flipSide(d); }); return; }
      if (text !== d.value) this.change(() => { d.value = text; });
    };
    drive.addEventListener('click', () => {
      this.closeEditor();
      // driven -> driving takes the value it measures now; driving -> driven keeps the geometry as it is
      this.change(() => { if (d.driven) { delete d.driven; d.value = now || d.value; } else d.driven = true; });
    });
    input.addEventListener('keydown', ev => {
      ev.stopPropagation();
      if (ev.key === 'Enter') { ev.preventDefault(); apply(); }
      if (ev.key === 'Escape') { ev.preventDefault(); this.closeEditor(); }
    });
    remove.addEventListener('click', () => { this.closeEditor(); this.change(() => { this.cons = this.cons.filter(x => x !== d); }); });
    this.editorApply = apply;
    this.focusEditor();
    setTimeout(() => this.focusEditor(), 40);
  }

  /** A negative distance: the second point (or line) goes over to the other side of the first, the solver then holds the distance there. */
  flipSide(d) {
    const [r1, r2] = d.refs;
    const a = pointOfRef(this.entities, r1), b = pointOfRef(this.entities, r2);
    if (!a || !b) return;
    const to = d.type === 'hdistance' ? [2 * a[0] - b[0], b[1]] : d.type === 'vdistance' ? [b[0], 2 * a[1] - b[1]] : [2 * a[0] - b[0], 2 * a[1] - b[1]];
    this.solve({ drag: [{ ref: r2, to }], analyse: false, iterations: 40 });
  }

  /** Puts the focus into the value field (the view takes it on pointerdown, so this runs once more a moment later). */
  focusEditor() {
    const input = this.editor?.querySelector('input');
    if (input && document.activeElement !== input) { input.focus({ preventScroll: true }); input.select(); }
  }

  applyEditor() { this.editorApply?.(); }

  closeEditor() {
    this.editor?.remove();
    this.editorApply = null;
    this.editor = null;
  }

  /** Esc: first the field, then the picks or clicks of the tool, then the tool, then the selection. */
  escape() {
    if (this.editor) { this.closeEditor(); return; }
    this.pressed = null;
    if (this.tool === 'spline' && this.points.length >= 2) { this.finishSpline(); this.draw(); return; }
    if (this.tool === 'mirror' && this.mirrorLine) { this.mirrorLine = null; this.cb.status(t('Sketch.Hint.mirror')); this.draw(); return; }
    if (this.placing || this.points.length || this.picks.length) { this.placing = null; this.points = []; this.picks = []; this.located = null; this.draw(); return; }
    if (this.tool !== 'select') { this.setTool('select'); return; }
    this.selection.clear();
    this.renderPanel();
    this.draw();
  }

  // ---- drawing ----------------------------------------------------------------------------------------------------------------

  draw() {
    if (!this.active) return;
    const preview = this.preview();
    this.cb.hud('');   // the length and angle of what is drawn stand at the pointer (pointerDecor)
    const picked = new Set(this.picks.map(p => (p.kind === 'point' ? 'p:' + p.ref.e + '.' + p.ref.k : 'e:' + p.ref.e)));
    for (const r of this.placing?.c.refs || []) if (r?.e && r.e !== ORIGIN) picked.add(r.k ? 'p:' + r.e + '.' + r.k : 'e:' + r.e);
    if (this.placing?.c.linear?.line) picked.add('e:' + this.placing.c.linear.line);
    const mm = this.vp.mmPerPixel;
    // the dimensions as drawings: extension lines, dimension lines with arrows, leaders, arcs
    const annotations = [];
    for (const c of this.cons) {
      if (!CONSTRAINTS[c.type]?.dimension) continue;
      const shape = dimensionShape(this.entities, c, mm);
      if (!shape) continue;
      const state = this.analysis?.constraint.get(c.id) || 'ok';
      annotations.push({ segs: shape.segs, state: this.selection.has('c:' + c.id) ? 'selected' : state === 'driven' ? 'driven' : state !== 'ok' ? 'conflict' : 'ok' });
    }
    if (this.placing) {
      const shape = dimensionShape(this.entities, this.placing.c, mm);
      if (shape) annotations.push({ segs: shape.segs, state: 'preview' });
    }
    const drawing = DRAW_TOOLS.includes(this.tool);
    this.vp.setSketchOverlay({
      frame: this.frame,
      entities: this.entities,
      selected: new Set([...this.selection, ...picked, ...this.constraintHighlight()]),
      hover: this.hover,
      hoverPoint: this.hoverPoint,
      status: this.analysis?.entity,
      pointStatus: this.analysis?.point,
      preview,
      annotations,
      guides: drawing ? this.located?.guides : null,
      origin: true,
      snap: drawing ? this.located?.snap : null,
      loops: sketchLoops(this.entities),
      image: this.image,
      grid: this.gridStep(),
      gridExtent: Math.max(200, this.vp.viewHeight * 2),
    });
    this.placeLabels();
  }

  /** A selected constraint shows its entities as selected. */
  constraintHighlight() {
    const out = [];
    for (const k of this.selection) {
      if (!k.startsWith('c:')) continue;
      const c = this.cons.find(x => x.id === k.slice(2));
      (c?.refs || []).forEach(r => { if (r?.e && r.e !== ORIGIN) out.push(r.k ? 'p:' + r.e + '.' + r.k : 'e:' + r.e); });
    }
    return out;
  }

  measureText(p) {
    if (!p) return '';
    const L = mm => fmt(mm / this.unit, 3) + ' ' + this.units;
    if (p.t === 'line') { const l = Math.hypot(p.b[0] - p.a[0], p.b[1] - p.a[1]); return `${L(l)} · ${fmt(Math.atan2(p.b[1] - p.a[1], p.b[0] - p.a[0]) * 180 / Math.PI, 1)}°`; }
    if (p.t === 'rect') return `${L(Math.abs(p.b[0] - p.a[0]))} × ${L(Math.abs(p.b[1] - p.a[1]))}`;
    if (p.t === 'circle') return `⌀ ${L(p.r * 2)}`;
    if (p.t === 'polygon') return `R ${L(p.r)} · ${p.n}`;
    if (p.t === 'arc') return `R ${L(p.r)}`;
    if (p.t === 'ellipse') return `${L(p.rx * 2)} × ${L(p.ry * 2)}`;
    return '';
  }

  // ---- labels and symbols over the view -----------------------------------------------------------------------------------------

  /** The dimensions as values and the other constraints as symbols (H, V, ∥, ⊥, =, ◎, T, M, ⚓) at their places, following the camera. */
  placeLabels() {
    if (!this.active) return;
    if (!this.labels) {
      this.labels = el('div', { class: 'ms-dims', 'aria-label': t('Sketch.Dimensions') });
      this.vp.canvas.parentElement.append(this.labels);
    }
    const old = new Map([...this.labels.children].filter(n => n.dataset.id).map(n => [n.dataset.id, n]));
    const stack = new Map();
    const mm = this.vp.mmPerPixel;
    const placing = this.placing ? [{ ...this.placing.c, id: '__placing' }] : [];
    const touched = new Set([this.hover, this.hoverPoint?.split('.')[0], ...[...this.selection].filter(k => k.startsWith('e:') || k.startsWith('p:')).map(k => k.slice(2).split('.')[0])]);
    for (const c of [...this.cons, ...placing]) {
      const kind = CONSTRAINTS[c.type];
      if (!kind) continue;
      const state = this.analysis?.constraint.get(c.id) || 'ok';
      const shape = kind.dimension ? dimensionShape(this.entities, c, mm) : null;
      // the coincident dots only where one looks (hover, selection) or when they are wrong, else the sketch is full of dots
      const dot = c.type === 'coincident' || c.type === 'onCurve';
      const quiet = dot && !(c.refs || []).some(r => touched.has(r?.e)) && !this.selection.has('c:' + c.id);
      const at = kind.dimension ? shape?.label : anchorOf(this.entities, c);
      let node = old.get(c.id);
      old.delete(c.id);
      if (!at || (quiet && state === 'ok')) { node?.remove(); continue; }
      if (!node) {
        node = el('button', { type: 'button', class: kind.dimension ? 'ms-dim' : 'ms-glyph', dataset: { id: c.id } });
        node.addEventListener('pointerdown', ev => this.labelDown(ev, node));
        node.addEventListener('contextmenu', ev => ev.preventDefault());
        this.labels.append(node);
      }
      if (kind.dimension) {
        const value = measure(this.entities, c);
        const shown = value === null ? '' : kind.angle ? fmt(value, 2) + '°' : fmt(value / this.unit, 3);
        const plain = c.value === undefined || c.driven || /^[-+]?\d*[.,]?\d+$/.test(String(c.value).trim());
        const prefix = { diameter: 'Ø ', radius: 'R ', arclength: '⌒ ' }[c.type] || '';
        node.textContent = prefix + (plain ? shown : `${c.value} = ${shown}`);
        node.classList.toggle('is-driven', !!c.driven);
      } else {
        node.textContent = kind.glyph;
      }
      node.title = t('Sketch.Constraint.' + c.type) + (state === 'driven' ? ' – ' + t('Sketch.DrivenTitle') : state !== 'ok' ? ' – ' + t('Sketch.ConflictTitle') : '');
      node.classList.toggle('is-conflict', state !== 'ok' && state !== 'driven');
      node.classList.toggle('is-selected', this.selection.has('c:' + c.id));
      node.classList.toggle('is-dot', dot);
      node.classList.toggle('is-preview', c.id === '__placing');
      const s = this.vp.project(toWorld(this.frame, at[0], at[1]));
      let x = s.x, y = s.y;
      if (!kind.dimension) {
        const key = `${Math.round(s.x / 6)}:${Math.round(s.y / 6)}`;
        const n = stack.get(key) || 0;
        stack.set(key, n + 1);
        if (!dot) { x += 14 + n * 18; y -= 14; }
      }
      node.style.transform = `translate(${Math.round(x)}px, ${Math.round(y)}px) translate(-50%, -50%)`;
    }
    old.forEach(n => n.remove());
    this.pointerDecor();
  }

  /** At the pointer while drawing: the symbol of what it snaps to (as OnShape shows it) and the length and angle of what is drawn. */
  pointerDecor() {
    // while a dimension is placed or a drawing tool draws, labels and symbols let clicks through to the sketch (a click on them would take the wrong thing)
    this.labels.classList.toggle('is-busy', !!this.placing || DRAW_TOOLS.includes(this.tool));
    let glyph = this.labels.querySelector('.ms-snapglyph'), hud = this.labels.querySelector('.ms-drawhud');
    if (!glyph) { glyph = el('span', { class: 'ms-snapglyph', 'aria-hidden': 'true' }); hud = el('span', { class: 'ms-drawhud mat-mono', 'aria-hidden': 'true' }); this.labels.append(glyph, hud); }
    const drawing = DRAW_TOOLS.includes(this.tool) && this.pointer && this.located;
    const host = this.vp.canvas.parentElement.getBoundingClientRect();
    const x = (this.pointer?.x ?? 0) - host.left, y = (this.pointer?.y ?? 0) - host.top;
    const symbol = drawing && this.located.glyph ? CONSTRAINTS[this.located.glyph]?.glyph : '';
    glyph.hidden = !symbol;
    if (symbol) {
      glyph.textContent = symbol;
      glyph.title = t('Sketch.Constraint.' + this.located.glyph);
      glyph.classList.toggle('is-dot', this.located.glyph === 'coincident' || this.located.glyph === 'onCurve');
      glyph.style.transform = `translate(${Math.round(x + 14)}px, ${Math.round(y + 12)}px)`;
    }
    const text = drawing && this.points.length ? this.measureText(this.preview()[0]) : '';
    hud.hidden = !text;
    if (text) { hud.textContent = text; hud.style.transform = `translate(${Math.round(x + 16)}px, ${Math.round(y - 30)}px)`; }
  }

  /** A label: a click selects the constraint (a dimension also opens its field), a drag moves a dimension to another place (its lines follow). */
  labelDown(ev, node) {
    ev.stopPropagation();
    ev.preventDefault();
    const c = this.cons.find(x => x.id === node.dataset.id);
    if (!c) return;
    const start = { x: ev.clientX, y: ev.clientY };
    let moved = false;
    const onMove = e => {
      if (!moved && Math.hypot(e.clientX - start.x, e.clientY - start.y) < 4) return;
      if (!CONSTRAINTS[c.type].dimension) return;
      if (!moved) this.remember();
      moved = true;
      const p = this.local({ ndc: this.vp.ndc(e.clientX, e.clientY) });
      const shape = p && dimensionShape(this.entities, c, this.vp.mmPerPixel);
      if (shape) c.off = [p[0] - shape.anchor[0], p[1] - shape.anchor[1]];
      if (c.type === 'angle') {
        const again = dimensionShape(this.entities, c, this.vp.mmPerPixel);
        if (again && again.flip !== !!c.flip) {
          // the other quadrant: the angle there is 180° minus this one, the geometry stays
          const plain = /^[-+]?\d*[.,]?\d+$/.test(String(c.value).trim());
          if (c.driven || plain) {
            if (!c.driven) c.value = fmt(180 - Number(String(c.value).replace(',', '.')), 4).replace(',', '.');
            if (again.flip) c.flip = true; else delete c.flip;
            this.solve();
          }
        }
      }
      this.draw();
    };
    const onUp = e => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      if (moved) { this.cb.changed?.(); return; }
      const key = 'c:' + c.id;
      const double = this.lastLabel && this.lastLabel.id === c.id && performance.now() - this.lastLabel.at < 450;
      this.lastLabel = { id: c.id, at: performance.now() };
      if (double || e.button === 2) {
        this.selection = new Set([key]);
        this.renderPanel();
        this.draw();
        if (CONSTRAINTS[c.type].dimension) this.editDimension(c, e.clientX, e.clientY);
        return;
      }
      if (this.selection.has(key)) this.selection.delete(key); else this.selection.add(key);
      this.renderPanel();
      this.draw();
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
  }

  // ---- the panel: the state of the sketch, its conflicts, the constraints of the selection --------------------------------

  renderPanel() {
    if (!this.active) return;
    const body = this.panel.body;
    body.replaceChildren();
    this.panel.title.textContent = this.name;
    const a = this.analysis;
    const conflicts = a ? this.cons.filter(c => !['ok', 'driven'].includes(a.constraint.get(c.id) || 'ok')) : [];
    const summary = this.panel.summary;
    summary.classList.remove('is-ok', 'is-free', 'is-conflict');
    if (conflicts.length) { summary.textContent = t('Sketch.State.Conflicts', conflicts.length); summary.classList.add('is-conflict'); }
    else if (a && a.dof === 0 && this.entities.length) { summary.textContent = t('Sketch.State.Defined'); summary.classList.add('is-ok'); }
    else { summary.textContent = t('Sketch.State.Free', a?.dof ?? 0); summary.classList.add('is-free'); }

    if (conflicts.length) {
      body.append(el('p', { class: 'ms-dialog__text ms-conflict-head' }, icon('alert'), ' ', t('Sketch.ConflictsHint')));
      body.append(this.constraintList(conflicts));
    }
    const ids = new Set([...this.selection].filter(k => k.startsWith('e:') || k.startsWith('p:')).map(k => k.slice(2).split('.')[0]));
    const selectedCons = [...this.selection].filter(k => k.startsWith('c:')).map(k => this.cons.find(c => c.id === k.slice(2))).filter(Boolean);
    const related = [...new Set([...selectedCons, ...this.cons.filter(c => (c.refs || []).some(r => ids.has(r?.e)))])].filter(c => !conflicts.includes(c));
    if (ids.size || selectedCons.length) {
      body.append(el('p', { class: 'ms-dialog__text ms-muted' }, t(related.length ? 'Sketch.ConstraintsOfSelection' : 'Sketch.NoConstraints')));
      if (related.length) body.append(this.constraintList(related));
      if (ids.size) {
        body.append(el('div', { class: 'ms-dialog__row' },
          el('button', { type: 'button', class: 'mat-btn mat-btn--secondary mat-btn--sm', onclick: () => this.toggleConstruction() }, icon('construction'), el('span', null, t('Sketch.Construction'))),
          el('button', { type: 'button', class: 'mat-btn mat-btn--danger mat-btn--sm', onclick: () => this.deleteSelected() }, icon('trash'), el('span', null, t('Sketch.Delete')))));
      }
    } else if (this.tool === 'polygon') {
      body.append(this.sidesField());
    }
    if (this.image) body.append(this.imageFields());
    this.panel.root.classList.toggle('is-empty', !body.childElementCount);
  }

  constraintList(list) {
    const ul = el('ul', { class: 'ms-conslist' });
    for (const c of list) {
      const kind = CONSTRAINTS[c.type];
      const state = this.analysis?.constraint.get(c.id) || 'ok';
      const value = kind.dimension ? ` ${c.value}${kind.angle ? '°' : ''}${c.driven ? ' (' + t('Sketch.Driven') + ')' : ''}` : '';
      const select = el('button', { type: 'button', class: 'ms-conslist__name' + (state !== 'ok' && state !== 'driven' ? ' is-conflict' : '') },
        el('span', { class: 'ms-conslist__glyph' }, kind.glyph || '↔'), el('span', null, t('Sketch.Constraint.' + c.type) + value));
      select.addEventListener('click', () => { this.selection = new Set(['c:' + c.id]); this.renderPanel(); this.draw(); });
      const remove = el('button', { type: 'button', class: 'mat-btn mat-btn--ghost mat-btn--icon mat-btn--sm', 'aria-label': t('Sketch.ConstraintDelete'), 'data-tip': t('Sketch.ConstraintDelete') }, icon('trash'));
      remove.addEventListener('click', () => this.change(() => { this.cons = this.cons.filter(x => x !== c); this.selection.delete('c:' + c.id); }));
      ul.append(el('li', null, select, remove));
    }
    return ul;
  }

  sidesField() {
    const input = el('input', { class: 'mat-input mat-input--sm mat-mono', id: 'ms-sides', value: String(this.polygonSides), inputmode: 'numeric' });
    input.addEventListener('change', () => { try { this.polygonSides = Math.max(3, Math.min(64, Math.round(evalNumber(input.value)))); } catch { input.value = String(this.polygonSides); } });
    input.addEventListener('keydown', ev => ev.stopPropagation());
    return el('div', { class: 'mat-field ms-field-sm' }, el('label', { class: 'mat-label', for: 'ms-sides' }, t('Sketch.Sides')), input);
  }
}

// ---- the drawing of a dimension ------------------------------------------------------------------------------------------------

const V = {
  add: (a, b) => [a[0] + b[0], a[1] + b[1]],
  sub: (a, b) => [a[0] - b[0], a[1] - b[1]],
  mul: (a, k) => [a[0] * k, a[1] * k],
  dot: (a, b) => a[0] * b[0] + a[1] * b[1],
  len: a => Math.hypot(a[0], a[1]),
  unit: a => { const l = Math.hypot(a[0], a[1]); return l > 1e-12 ? [a[0] / l, a[1] / l] : [1, 0]; },
};

/** Two short strokes of an arrow head: the tip, the direction back along the line, its normal, the size. */
function arrow(tip, back, n, s) {
  return [[tip, V.add(tip, V.add(V.mul(back, s), V.mul(n, s * 0.32)))], [tip, V.add(tip, V.sub(V.mul(back, s), V.mul(n, s * 0.32)))]];
}

function footOn(p, line) {
  const u = unit2(line);
  return V.add(line.a, V.mul(u, V.dot(V.sub(p, line.a), u)));
}

/** The two points a linear dimension measures between (length of a line, distance of points, of a point to a line, of two parallel lines). */
function linearEnds(entities, c) {
  const E = r => entities.find(e => e.id === r?.e);
  const [r1, r2] = c.refs || [];
  if (c.type === 'length') { const l = E(r1); return l?.t === 'line' ? [l.a, l.b] : null; }
  if (!['distance', 'hdistance', 'vdistance'].includes(c.type)) return null;
  const p1 = r1?.k ? pointOfRef(entities, r1) : null, p2 = r2?.k ? pointOfRef(entities, r2) : null;
  const l1 = r1?.k ? null : E(r1), l2 = r2?.k ? null : E(r2);
  if (p1 && p2) return [p1, p2];
  if (p1 && l2?.t === 'line') return [p1, footOn(p1, l2)];
  if (p2 && l1?.t === 'line') return [footOn(p2, l1), p2];
  if (l1?.t === 'line' && l2?.t === 'line') { const m = [(l1.a[0] + l1.b[0]) / 2, (l1.a[1] + l1.b[1]) / 2]; return [m, footOn(m, l2)]; }
  return null;
}

/**
 * How a dimension is drawn, in the coordinates of the sketch: { segs: [[p, q]], label, anchor }. c.off is where the value stands, relative to the anchor
 * (the middle of what is measured, the centre of a circle, the corner of an angle); the lines follow it. mm = millimetres per pixel (sizes of arrows, gaps).
 */
export function dimensionShape(entities, c, mm) {
  const s = 9 * mm, gap = 3 * mm, ext = 6 * mm;
  const E = r => entities.find(e => e.id === r?.e);
  const off = c.off && V.len(c.off) > 1e-9 ? c.off : null;
  if (c.type === 'arclength') {
    // an arc beside the arc, with arrows at its ends and lines out from the ends of the arc
    const e = E(c.refs?.[0]);
    if (e?.t !== 'arc') return null;
    let sweep = e.a1 - e.a0;
    while (sweep <= 0) sweep += 2 * Math.PI;
    const mid = e.a0 + sweep / 2;
    const anchor = V.add(e.c, V.mul([Math.cos(mid), Math.sin(mid)], e.r));
    const label = off ? V.add(anchor, off) : V.add(e.c, V.mul([Math.cos(mid), Math.sin(mid)], e.r + 16 * mm));
    const R = Math.max(e.r * 0.2, V.len(V.sub(label, e.c)));
    const at = k => V.add(e.c, V.mul([Math.cos(e.a0 + sweep * k), Math.sin(e.a0 + sweep * k)], R));
    const segs = [];
    for (let i = 0; i < 32; i++) segs.push([at(i / 32), at((i + 1) / 32)]);
    const tangent = k => [-Math.sin(e.a0 + sweep * k), Math.cos(e.a0 + sweep * k)];
    const radial = k => [Math.cos(e.a0 + sweep * k), Math.sin(e.a0 + sweep * k)];
    segs.push(...arrow(at(0), tangent(0), radial(0), s), ...arrow(at(1), V.mul(tangent(1), -1), radial(1), s));
    for (const k of [0, 1]) {
      const from = V.add(e.c, V.mul(radial(k), e.r)), sg = Math.sign(R - e.r) || 1;
      if (Math.abs(R - e.r) > gap) segs.push([V.add(from, V.mul(radial(k), sg * gap)), V.add(at(k), V.mul(radial(k), sg * ext))]);
    }
    return { segs, label, anchor };
  }
  if (c.type === 'radius' || c.type === 'diameter') {
    const e = E(c.refs?.[0]);
    if (!e?.c) return null;
    const o = off || V.mul([0.7071, 0.7071], e.r + 16 * mm);
    const d = V.unit(o), n = [-d[1], d[0]];
    const A = V.add(e.c, V.mul(d, e.r));
    const B = c.type === 'diameter' ? V.sub(e.c, V.mul(d, e.r)) : e.c;
    const label = V.add(e.c, o);
    const segs = [[B, A], ...arrow(A, V.mul(d, -1), n, s)];
    if (c.type === 'diameter') segs.push(...arrow(B, d, n, s));
    if (V.len(o) > e.r) segs.push([A, label]);
    return { segs, label, anchor: e.c };
  }
  if (c.type === 'angle') {
    const l1 = E(c.refs?.[0]), l2 = E(c.refs?.[1]);
    if (l1?.t !== 'line' || l2?.t !== 'line') return null;
    const u = unit2(l1), v = unit2(l2), den = u[0] * v[1] - u[1] * v[0];
    if (Math.abs(den) < 1e-9) return null;
    const w = V.sub(l2.a, l1.a), t1 = (w[0] * v[1] - w[1] * v[0]) / den;
    const O = V.add(l1.a, V.mul(u, t1));
    const away = l => V.unit(V.sub(V.len(V.sub(l.a, O)) > V.len(V.sub(l.b, O)) ? l.a : l.b, O));
    let d1 = away(l1), d2 = away(l2);
    const cross = (a, b) => a[0] * b[1] - a[1] * b[0];
    const within = (a, b, x) => cross(a, x) * cross(a, b) >= 0 && cross(x, b) * cross(a, b) >= 0 && V.dot(x, V.add(a, b)) > 0;
    if (off) {
      const x = V.unit(off);
      const options = [[d1, d2], [V.mul(d1, -1), d2], [d1, V.mul(d2, -1)], [V.mul(d1, -1), V.mul(d2, -1)]];
      const fit = options.find(([a, b]) => within(a, b, x));
      if (fit) [d1, d2] = fit;
    }
    const R = off ? Math.max(10 * mm, V.len(off)) : 34 * mm;
    let a1 = Math.atan2(d1[1], d1[0]), da = Math.atan2(d2[1], d2[0]) - a1;
    while (da > Math.PI) da -= 2 * Math.PI;
    while (da < -Math.PI) da += 2 * Math.PI;
    const segs = [];
    const at = k => V.add(O, V.mul([Math.cos(a1 + da * k), Math.sin(a1 + da * k)], R));
    for (let i = 0; i < 24; i++) segs.push([at(i / 24), at((i + 1) / 24)]);
    const tangent = k => { const a = a1 + da * k; return [-Math.sin(a) * Math.sign(da), Math.cos(a) * Math.sign(da)]; };
    const radial = k => [Math.cos(a1 + da * k), Math.sin(a1 + da * k)];
    segs.push(...arrow(at(0), tangent(0), radial(0), s), ...arrow(at(1), V.mul(tangent(1), -1), radial(1), s));
    // extension of the lines to the arc when the arc lies beyond them
    for (const [l, dir] of [[l1, d1], [l2, d2]]) {
      const reach = Math.max(V.dot(V.sub(l.a, O), dir), V.dot(V.sub(l.b, O), dir));
      if (reach < R) segs.push([V.add(O, V.mul(dir, Math.max(0, reach) + gap)), V.add(O, V.mul(dir, R + ext))]);
    }
    const label = off ? V.add(O, off) : V.add(O, V.mul(V.unit(V.add(d1, d2)), R + 12 * mm));
    // the angle shown is between d1 and d2; the constraint measures between the directions of the lines (flip: the other one)
    const flip = Math.sign(V.dot(d1, d2)) !== Math.sign(V.dot(u, v)) && Math.abs(V.dot(u, v)) > 1e-9;
    return { segs, label, anchor: O, flip };
  }
  const ends = linearEnds(entities, c);
  if (!ends) return null;
  const [P, Q] = ends;
  const u = c.type === 'hdistance' ? [1, 0] : c.type === 'vdistance' ? [0, 1] : V.unit(V.sub(Q, P));
  const n = [-u[1], u[0]];
  const M = V.mul(V.add(P, Q), 0.5);
  const o = off || V.mul(n, 18 * mm);
  const d = V.dot(o, n);
  const base = V.add(M, V.mul(n, d));
  const onLine = X => V.add(X, V.mul(n, V.dot(V.sub(base, X), n)));
  const P2 = onLine(P), Q2 = onLine(Q);
  const segs = [];
  for (const [X, X2] of [[P, P2], [Q, Q2]]) {
    const L = V.dot(V.sub(X2, X), n), sg = Math.sign(L) || 1;
    if (Math.abs(L) > gap) segs.push([V.add(X, V.mul(n, sg * gap)), V.add(X2, V.mul(n, sg * ext))]);
  }
  segs.push([P2, Q2]);
  const along = V.sub(Q2, P2), span = V.len(along);
  if (span > 1e-9) {
    const k = V.unit(along);
    segs.push(...arrow(P2, k, n, Math.min(s, span / 3)), ...arrow(Q2, V.mul(k, -1), n, Math.min(s, span / 3)));
    const label = V.add(M, o);
    const tl = V.dot(V.sub(label, P2), k);
    if (tl < 0) segs.push([V.add(P2, V.mul(k, tl)), P2]);
    if (tl > span) segs.push([Q2, V.add(P2, V.mul(k, tl))]);
  }
  return { segs, label: V.add(M, o), anchor: M };
}

// ---- helpers ------------------------------------------------------------------------------------------------------------------

function unit2(line) {
  const dx = line.b[0] - line.a[0], dy = line.b[1] - line.a[1], l = Math.hypot(dx, dy) || 1;
  return [dx / l, dy / l];
}

/** The nearest point of a curve to p. */
function projectOnto(e, p) {
  if (e.t === 'line') {
    const dx = e.b[0] - e.a[0], dy = e.b[1] - e.a[1], l2 = dx * dx + dy * dy;
    if (!l2) return null;
    const s = Math.max(0, Math.min(1, ((p[0] - e.a[0]) * dx + (p[1] - e.a[1]) * dy) / l2));
    return [e.a[0] + s * dx, e.a[1] + s * dy];
  }
  if (e.t === 'circle' || e.t === 'arc') {
    const dx = p[0] - e.c[0], dy = p[1] - e.c[1], l = Math.hypot(dx, dy) || 1;
    return [e.c[0] + dx / l * e.r, e.c[1] + dy / l * e.r];
  }
  return null;
}

/** The numbers of an entity in the order of the solver (for "fix" of a whole entity). */
function valuesOf(e) {
  switch (e?.t) {
    case 'line': case 'rect': return [e.a[0], e.a[1], e.b[0], e.b[1]];
    case 'circle': return [e.c[0], e.c[1], e.r];
    case 'arc': return [e.c[0], e.c[1], e.r, e.a0, e.a1];
    case 'polygon': return [e.c[0], e.c[1], e.r, (e.rot || 0) * Math.PI / 180];
    case 'point': return [e.p[0], e.p[1]];
    default: return [];
  }
}

/** Where the symbol or value of a constraint sits (sketch coordinates). */
function anchorOf(entities, c) {
  const P = r => pointOfRef(entities, r);
  const E = r => entities.find(e => e.id === r?.e);
  const mid = l => [(l.a[0] + l.b[0]) / 2, (l.a[1] + l.b[1]) / 2];
  const [r1, r2] = c.refs || [];
  const e1 = E(r1), e2 = E(r2);
  switch (c.type) {
    case 'coincident': case 'onCurve': case 'midpoint': return P(r1);
    case 'fix': return r1?.k ? P(r1) : e1?.t === 'line' ? mid(e1) : e1?.c || e1?.p || null;
    case 'horizontal': case 'vertical':
      if (r2) { const a = P(r1), b = P(r2); return a && b ? [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2] : null; }
      return e1?.t === 'line' ? mid(e1) : null;
    case 'parallel': case 'perpendicular': case 'equal': case 'tangent': case 'length':
      return e1?.t === 'line' ? mid(e1) : e1?.c ? [e1.c[0], e1.c[1] + e1.r] : null;
    case 'concentric': return e1?.c || null;
    case 'radius': case 'diameter': return e1?.c ? [e1.c[0] + e1.r * 0.7071, e1.c[1] + e1.r * 0.7071] : null;
    case 'angle': return e1?.t === 'line' && e2?.t === 'line' ? [(mid(e1)[0] + mid(e2)[0]) / 2, (mid(e1)[1] + mid(e2)[1]) / 2] : null;
    case 'width': case 'height': return e1?.t === 'rect' ? mid(e1) : null;
    default: {
      const a = r1?.k ? P(r1) : e1?.t === 'line' ? mid(e1) : null;
      const b = r2?.k ? P(r2) : e2?.t === 'line' ? mid(e2) : null;
      return a && b ? [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2] : a || b;
    }
  }
}

/** The segments of an edge of a part (indices into part.mesh.edges) as polylines in their order: [{ points (world), closed }]. */
function chainOf(part, indices) {
  const e = part.mesh.edges;
  const at = new Map();
  for (const i of indices) for (const v of [e.verts[i * 2], e.verts[i * 2 + 1]]) { if (!at.has(v)) at.set(v, []); at.get(v).push(i); }
  const point = v => { for (const i of at.get(v)) { const k = e.verts[i * 2] === v ? 0 : 3; return [e.pos[i * 6 + k], e.pos[i * 6 + k + 1], e.pos[i * 6 + k + 2]]; } };
  const used = new Set(), out = [];
  const walk = from => {
    const verts = [from];
    let v = from;
    for (;;) {
      const i = (at.get(v) || []).find(j => !used.has(j));
      if (i === undefined) break;
      used.add(i);
      v = e.verts[i * 2] === v ? e.verts[i * 2 + 1] : e.verts[i * 2];
      verts.push(v);
    }
    const closed = verts.length > 2 && verts[verts.length - 1] === verts[0];
    out.push({ points: (closed ? verts.slice(0, -1) : verts).map(point), closed });
  };
  for (const [v, list] of at) if (list.length !== 2 && list.some(i => !used.has(i))) walk(v);
  for (const [v, list] of at) if (list.some(i => !used.has(i))) walk(v);
  return out;
}

const FLIPPABLE = ['distance', 'hdistance', 'vdistance'];

/**
 * Two points, or a slanted line, measured the way the dimension is dragged (like OnShape): beside the span of the points across and outside it upright: horizontal;
 * the other way round: vertical; elsewhere (at a slant, or between them): the direct distance (the length of the line).
 */
function linearKind(entities, c, p) {
  const ends = c.linear.line ? [pointOfRef(entities, { e: c.linear.line, k: 'a' }), pointOfRef(entities, { e: c.linear.line, k: 'b' })] : c.linear.points.map(r => pointOfRef(entities, r));
  if (!ends[0] || !ends[1]) return;
  const [A, B] = ends;
  const inX = p[0] > Math.min(A[0], B[0]) && p[0] < Math.max(A[0], B[0]), inY = p[1] > Math.min(A[1], B[1]) && p[1] < Math.max(A[1], B[1]);
  const kind = inX && !inY ? 'hdistance' : inY && !inX ? 'vdistance' : 'aligned';
  const refs = c.linear.line ? [{ e: c.linear.line, k: 'a' }, { e: c.linear.line, k: 'b' }] : c.linear.points;
  if (kind === 'aligned') { c.type = c.linear.line ? 'length' : 'distance'; c.refs = c.linear.line ? [{ e: c.linear.line }] : refs; }
  else { c.type = kind; c.refs = refs; }
}

/** A round number near a value (1, 2, 5 × 10^n) for the first value of a field. */
function niceValue(v) {
  if (!(v > 0)) return '1';
  const p = Math.pow(10, Math.floor(Math.log10(v))), n = v / p;
  return String(+((n < 1.5 ? 1 : n < 3.5 ? 2 : n < 7.5 ? 5 : 10) * p).toPrecision(3));
}

/** The outlines of a text in the font of the browser, as curves at a point of the sketch (baseline, left), the capitals as high as asked. */
function textCurves(text, height, at) {
  const px = 360, pad = 30, font = `600 ${px}px "Segoe UI", Roboto, Arial, sans-serif`;
  const c = document.createElement('canvas'), g = c.getContext('2d');
  g.font = font;
  const w = Math.ceil(g.measureText(text).width) + 2 * pad, h = Math.ceil(px * 1.45);
  c.width = w; c.height = h;
  const g2 = c.getContext('2d');
  g2.font = font; g2.fillStyle = '#000'; g2.textBaseline = 'alphabetic';
  const base = Math.round(px * 1.1);
  g2.fillText(text, pad, base);
  const data = g2.getImageData(0, 0, w, h).data, mask = new Uint8Array(w * h);
  for (let i = 0; i < w * h; i++) mask[i] = data[i * 4 + 3] > 127 ? 1 : 0;
  const k = height / (px * 0.71);
  const to = q => [at[0] + (q[0] - pad) * k, at[1] + (base - q[1]) * k];
  return traceMask(mask, w, h).map(l => simplifyLoop(l, 1.4)).filter(l => l.length >= 3).flatMap(l => curvesFromPoints(l.map(to), true));
}
