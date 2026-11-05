/* MatShape – an assembly as a tab of its own (like the assemblies of OnShape): instances of parts of the Part Studios of the document, placed by mates.
   A mate joins two mate connectors (picked on a flat face: its middle, its normal; on a round face: its axis) and says what may still move:
   fastened (nothing), revolute (turn about the axis), slider (move along it), cylindrical (both), planar (move in the plane and turn). Every mate keeps its
   values (angle, offset, dx, dy); the free ones have sliders. The placing is a tree: the first (or a fixed) instance stays, each mate places the instance
   it brings in; an instance no mate reaches keeps its own place (fields to move it). Also: exploded view, interference check, bill of materials (CSV).
   Content of the tab: { features: [], assembly: { instances: [{ id, studio, part, name, fixed, transform }], mates: [{ id, type, a: { inst, frame }, b, flip, angle, offset, dx, dy }] } }. */

import { dispose, regenerate, PART_COLORS } from './model.js';
import { axisOfFace } from './solids.js';
import { download, el, fmt, icon, t, toast, uid } from './util.js';

export const MATES = {
  fastened: { free: [] },
  revolute: { free: ['angle'] },
  slider: { free: ['offset'] },
  cylindrical: { free: ['angle', 'offset'] },
  planar: { free: ['dx', 'dy', 'angle'] },
};

// ---- 4×4 matrices, column-major (like three.js and Manifold) ------------------------------------------------------------------
export const I4 = () => [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
export function mul(a, b) {
  const o = new Array(16).fill(0);
  for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++) for (let k = 0; k < 4; k++) o[c * 4 + r] += a[k * 4 + r] * b[c * 4 + k];
  return o;
}
/** The inverse of a rigid motion (rotation + move). */
export function invert(m) {
  const R = [[m[0], m[4], m[8]], [m[1], m[5], m[9]], [m[2], m[6], m[10]]], tt = [m[12], m[13], m[14]];
  const o = I4();
  for (let r = 0; r < 3; r++) for (let c = 0; c < 3; c++) o[c * 4 + r] = R[c][r];
  for (let r = 0; r < 3; r++) o[12 + r] = -(R[0][r] * tt[0] + R[1][r] * tt[1] + R[2][r] * tt[2]);
  return o;
}
const fromFrame = f => [f.x[0], f.x[1], f.x[2], 0, f.y[0], f.y[1], f.y[2], 0, f.n[0], f.n[1], f.n[2], 0, f.o[0], f.o[1], f.o[2], 1];
const rotZ = deg => { const a = deg * Math.PI / 180, c = Math.cos(a), s = Math.sin(a); return [c, s, 0, 0, -s, c, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]; };
const move = (x, y, z) => [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, x, y, z, 1];
const FLIP = [1, 0, 0, 0, 0, -1, 0, 0, 0, 0, -1, 0, 0, 0, 0, 1];
const apply = (m, p) => [m[0] * p[0] + m[4] * p[1] + m[8] * p[2] + m[12], m[1] * p[0] + m[5] * p[1] + m[9] * p[2] + m[13], m[2] * p[0] + m[6] * p[1] + m[10] * p[2] + m[14]];
const applyDir = (m, d) => [m[0] * d[0] + m[4] * d[1] + m[8] * d[2], m[1] * d[0] + m[5] * d[1] + m[9] * d[2], m[2] * d[0] + m[6] * d[1] + m[10] * d[2]];

/** Where the connector of b sits in the connector of a: the flip (faces against each other), the turn, the moves. */
export function mateMatrix(m) {
  return mul(mul(m.flip === false ? I4() : FLIP, rotZ(m.angle || 0)), move(m.dx || 0, m.dy || 0, m.offset || 0));
}

/**
 * The places of the instances: { transforms: Map(inst -> matrix), over: [mate ids that close a loop and are left out] }.
 * Grounded are the fixed instances (or the first one); each mate places the instance it reaches.
 */
export function solveAssembly(asm) {
  const T = new Map(), over = [];
  const insts = asm.instances || [];
  const grounded = insts.filter(i => i.fixed);
  for (const i of grounded.length ? grounded : insts.slice(0, 1)) T.set(i.id, i.transform || I4());
  const mates = (asm.mates || []).filter(m => insts.some(i => i.id === m.a?.inst) && insts.some(i => i.id === m.b?.inst));
  const done = new Set();
  for (let progress = true; progress;) {
    progress = false;
    for (const m of mates) {
      if (done.has(m.id)) continue;
      const Fa = fromFrame(m.a.frame), Fb = fromFrame(m.b.frame), M = mateMatrix(m);
      if (T.has(m.a.inst) && !T.has(m.b.inst)) { T.set(m.b.inst, mul(mul(mul(T.get(m.a.inst), Fa), M), invert(Fb))); done.add(m.id); progress = true; }
      else if (T.has(m.b.inst) && !T.has(m.a.inst)) { T.set(m.a.inst, mul(mul(mul(T.get(m.b.inst), Fb), invert(M)), invert(Fa))); done.add(m.id); progress = true; }
    }
    // an instance no mate reaches yet keeps its own place and may bring others in
    if (!progress) {
      const loose = insts.find(i => !T.has(i.id) && mates.some(m => !done.has(m.id) && (m.a.inst === i.id || m.b.inst === i.id)));
      if (loose) { T.set(loose.id, loose.transform || I4()); progress = true; }
    }
  }
  for (const m of mates) if (!done.has(m.id)) over.push(m.id);
  for (const i of insts) if (!T.has(i.id)) T.set(i.id, i.transform || I4());
  return { transforms: T, over };
}

export class AssemblyEditor {
  /** ui: { panel, toolbar, insert (dialog) }; host: { kernel(), studios(), units(), unit(), viewport, change(fn(asm)), canEdit(), status(text), partName(part) } */
  constructor(ui, host) {
    this.ui = ui;
    this.host = host;
    this.cache = new Map();            // studio id -> { key, result }
    this.explode = 0;
    this.selected = null;
    this.mating = null;                // { type, a? }
    ui.toolbar.addEventListener('click', e => {
      const b = e.target.closest('[data-asm-action], [data-asm-mate]');
      if (!b) return;
      if (b.dataset.asmMate) this.startMate(b.dataset.asmMate);
      else this.action(b.dataset.asmAction);
    });
    ui.toolbar.querySelector('[data-asm-explode]')?.addEventListener('input', e => { this.explode = Number(e.target.value) / 100; this.build(); });
  }

  open(asm) {
    this.a = asm || { instances: [], mates: [] };
    this.a.instances ||= [];
    this.a.mates ||= [];
    this.build();
    this.renderPanel();
  }

  close() {
    this.a = null;
    this.mating = null;
    for (const c of this.cache.values()) dispose(c.result);
    this.cache.clear();
  }

  edit(fn) { if (this.host.canEdit()) this.host.change(a => { a.instances ||= []; a.mates ||= []; fn(a); }); }

  /** The parts of a Part Studio (made once per content). */
  partsOf(studioId) {
    const s = this.host.studios().find(x => x.id === studioId);
    if (!s) return [];
    const key = JSON.stringify(s.content);
    let c = this.cache.get(studioId);
    if (!c || c.key !== key) {
      if (c) dispose(c.result);
      c = { key, result: regenerate(this.host.kernel(), s.content, this.host.units()) };
      this.cache.set(studioId, c);
    }
    return c.result.parts;
  }

  /** The instances in the world: meshes moved by their matrices, for the view and for export. */
  build() {
    if (!this.a) return;
    const solved = solveAssembly(this.a);
    this.solved = solved;
    const list = [];
    const centre = [0, 0, 0];
    const items = [];
    this.a.instances.forEach((inst, n) => {
      const part = this.partsOf(inst.studio).find(p => p.id === inst.part);
      if (!part) return;
      const T = solved.transforms.get(inst.id);
      const box = part.manifold.boundingBox(), c = apply(T, [0, 1, 2].map(i => (box.min[i] + box.max[i]) / 2));
      items.push({ inst, part, T, c, n });
      for (let i = 0; i < 3; i++) centre[i] += c[i];
    });
    if (items.length) for (let i = 0; i < 3; i++) centre[i] /= items.length;
    for (const { inst, part, T, c, n } of items) {
      // exploded: each instance away from the middle of the assembly
      const k = this.explode * 1.2, M = this.explode ? mul(move((c[0] - centre[0]) * k, (c[1] - centre[1]) * k, (c[2] - centre[2]) * k), T) : T;
      list.push({ id: inst.id, name: inst.name || this.host.partName(part), number: n + 1, color: part.color || PART_COLORS[n % PART_COLORS.length], mesh: moveMesh(part.mesh, M), matrix: M, source: part });
    }
    this.instances = list;
    this.host.viewport.setParts(list, new Set());
    this.host.viewport.setSelection(this.selected ? [this.selected] : []);
  }

  /** The instances as parts (export: STL, 3MF …). */
  parts() { return this.instances || []; }

  // ---- mates: pick two faces ----------------------------------------------------------------------------------------------------

  startMate(type) {
    if (!this.host.canEdit()) return;
    this.mating = { type };
    this.ui.toolbar.querySelectorAll('[data-asm-mate]').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.asmMate === type)));
    this.host.status(t('Asm.Hint.mateA'));
  }

  /** A click in the view (a face of an instance, or nothing). */
  click(pick) {
    if (!this.a) return;
    if (this.mating) {
      if (!pick) return;
      const connector = this.connectorAt(pick);
      if (!connector) { this.host.status(t('Asm.NoConnector')); return; }
      if (!this.mating.a) { this.mating.a = connector; this.host.status(t('Asm.Hint.mateB')); return; }
      if (connector.inst === this.mating.a.inst) { this.host.status(t('Asm.SameInstance')); return; }
      const mate = { id: uid('m'), type: this.mating.type, a: this.mating.a, b: connector, flip: true, angle: 0, offset: 0, dx: 0, dy: 0 };
      this.mating = null;
      this.ui.toolbar.querySelectorAll('[data-asm-mate]').forEach(b => b.setAttribute('aria-pressed', 'false'));
      this.host.status('');
      this.edit(a => { a.mates.push(mate); });
      return;
    }
    this.selected = pick?.partId || null;
    this.host.viewport.setSelection(this.selected ? [this.selected] : []);
    this.renderPanel();
  }

  /** A mate connector on a picked face, in the coordinates of its instance: a flat face gives its middle and normal, a round face its axis. */
  connectorAt(pick) {
    const item = this.instances.find(x => x.id === pick.partId);
    if (!item) return null;
    const mesh = item.mesh, ids = mesh.faceIds, pos = mesh.positions;
    let o = null, n = null;
    const flat = this.host.viewport.faceNormal(pick.partId, pick.faceId);
    if (flat) {
      let area = 0;
      const c = [0, 0, 0];
      for (let t2 = 0; t2 < ids.length; t2++) {
        if (ids[t2] !== pick.faceId) continue;
        const a = [pos[t2 * 9], pos[t2 * 9 + 1], pos[t2 * 9 + 2]], b = [pos[t2 * 9 + 3], pos[t2 * 9 + 4], pos[t2 * 9 + 5]], d = [pos[t2 * 9 + 6], pos[t2 * 9 + 7], pos[t2 * 9 + 8]];
        const cr = [(b[1] - a[1]) * (d[2] - a[2]) - (b[2] - a[2]) * (d[1] - a[1]), (b[2] - a[2]) * (d[0] - a[0]) - (b[0] - a[0]) * (d[2] - a[2]), (b[0] - a[0]) * (d[1] - a[1]) - (b[1] - a[1]) * (d[0] - a[0])];
        const w = Math.hypot(...cr) / 2;
        area += w;
        for (let i = 0; i < 3; i++) c[i] += w * (a[i] + b[i] + d[i]) / 3;
      }
      if (area > 0) { o = c.map(v => v / area); n = flat; }
    } else {
      // a round face: its axis, through the middle of its reach
      const topo = {
        numTri: ids.length, fid: ids, tv: Uint32Array.from({ length: ids.length * 3 }, (_, i) => i),
        P: i => [pos[i * 3], pos[i * 3 + 1], pos[i * 3 + 2]],
        normal: t2 => { const a = topo.P(t2 * 3), b = topo.P(t2 * 3 + 1), d = topo.P(t2 * 3 + 2); const cr = [(b[1] - a[1]) * (d[2] - a[2]) - (b[2] - a[2]) * (d[1] - a[1]), (b[2] - a[2]) * (d[0] - a[0]) - (b[0] - a[0]) * (d[2] - a[2]), (b[0] - a[0]) * (d[1] - a[1]) - (b[1] - a[1]) * (d[0] - a[0])]; const l = Math.hypot(...cr) || 1; return cr.map(v => v / l); },
      };
      const axis = axisOfFace(topo, pick.faceId);
      if (!axis) return null;
      const mid = (axis.z0 + axis.z1) / 2;
      o = [0, 1, 2].map(i => axis.o[i] + axis.a[i] * mid);
      n = axis.a;
    }
    // the frame in the world, then in the instance
    const x = Math.abs(n[2]) < 0.9 ? norm(cross(n, [0, 0, 1])) : norm(cross(n, [1, 0, 0])), y = cross(n, x);
    const inv = invert(item.matrix);
    const lo = apply(inv, o), lx = applyDir(inv, x), ly = applyDir(inv, y), ln = applyDir(inv, n);
    const r = v => v.map(q => Math.round(q * 1e6) / 1e6);
    return { inst: pick.partId, frame: { o: r(lo), x: r(lx), y: r(ly), n: r(ln) } };
  }

  // ---- the panel: instances, mates (with their values), the selected instance --------------------------------------------------

  renderPanel() {
    const a = this.a, panel = this.ui.panel, ro = !this.host.canEdit();
    if (!a) return;
    const nameOf = id => this.instances?.find(x => x.id === id)?.name || '?';
    const instList = el('ul', { class: 'ms-asmlist' });
    for (const inst of a.instances) {
      const item = this.instances?.find(x => x.id === inst.id);
      const fixed = el('button', { type: 'button', class: 'mat-btn mat-btn--ghost mat-btn--icon mat-btn--sm', 'aria-pressed': String(!!inst.fixed), disabled: ro, 'aria-label': t('Asm.Fix'), 'data-tip': t('Asm.Fix') }, icon('fix'));
      fixed.addEventListener('click', () => this.edit(x => { const i = x.instances.find(q => q.id === inst.id); i.fixed = !i.fixed; }));
      const remove = el('button', { type: 'button', class: 'mat-btn mat-btn--ghost mat-btn--icon mat-btn--sm', disabled: ro, 'aria-label': t('Asm.Remove'), 'data-tip': t('Asm.Remove') }, icon('trash'));
      remove.addEventListener('click', () => this.edit(x => { x.instances = x.instances.filter(q => q.id !== inst.id); x.mates = x.mates.filter(m => m.a.inst !== inst.id && m.b.inst !== inst.id); }));
      const name = el('button', { type: 'button', class: 'ms-asmlist__name' + (this.selected === inst.id ? ' is-selected' : '') }, el('span', { class: 'ms-asmlist__dot' }), el('span', null, item?.name || inst.part));
      name.addEventListener('click', () => { this.selected = inst.id; this.host.viewport.setSelection([inst.id]); this.renderPanel(); });
      instList.append(el('li', null, name, fixed, remove));
      const dot = name.querySelector('.ms-asmlist__dot');
      if (item) dot.style.background = item.color;
    }
    if (!a.instances.length) instList.append(el('li', { class: 'ms-muted' }, t('Asm.Empty')));
    const mateList = el('ul', { class: 'ms-asmlist' });
    for (const m of a.mates) {
      const over = this.solved?.over.includes(m.id);
      const head = el('div', { class: 'ms-asmlist__mate' + (over ? ' is-conflict' : '') }, icon('mate-' + m.type), el('span', null, `${t('Asm.Mate.' + m.type)}: ${nameOf(m.a.inst)} – ${nameOf(m.b.inst)}`));
      const remove = el('button', { type: 'button', class: 'mat-btn mat-btn--ghost mat-btn--icon mat-btn--sm', disabled: ro, 'aria-label': t('Asm.Remove'), 'data-tip': t('Asm.Remove') }, icon('trash'));
      remove.addEventListener('click', () => this.edit(x => { x.mates = x.mates.filter(q => q.id !== m.id); }));
      const flip = el('button', { type: 'button', class: 'mat-btn mat-btn--ghost mat-btn--icon mat-btn--sm', disabled: ro, 'aria-pressed': String(m.flip !== false), 'aria-label': t('Asm.FlipMate'), 'data-tip': t('Asm.FlipMate') }, icon('flip'));
      flip.addEventListener('click', () => this.edit(x => { const q = x.mates.find(y => y.id === m.id); q.flip = q.flip === false; }));
      head.append(flip, remove);
      const li = el('li', null, head);
      // the values: the free ones with a slider (they move the mechanism), all of them with a field
      // angle and offset always (fixed values of a fastened mate are settings too), the moves in the plane for a planar mate
      for (const key of m.type === 'planar' ? ['dx', 'dy', 'angle', 'offset'] : ['angle', 'offset']) {
        const free = MATES[m.type]?.free.includes(key);
        const unit = key === 'angle' ? 1 : this.host.unit();
        const input = el('input', { class: 'mat-input mat-input--sm mat-mono', value: fmt((m[key] || 0) / unit, 3), disabled: ro, 'aria-label': t('Asm.Value.' + key) });
        input.addEventListener('change', () => { const v = Number(input.value.replace(',', '.')); if (Number.isFinite(v)) this.edit(x => { x.mates.find(q => q.id === m.id)[key] = v * unit; }); });
        const row = el('label', { class: 'ms-asmlist__value' }, el('span', null, t('Asm.Value.' + key)), input);
        if (free) {
          const range = el('input', { type: 'range', class: 'ms-asmlist__range', min: key === 'angle' ? -180 : -100, max: key === 'angle' ? 180 : 100, step: key === 'angle' ? 1 : 0.5, value: (m[key] || 0) / unit, disabled: ro, 'aria-label': t('Asm.Value.' + key) });
          // moving the slider moves the parts at once; the value is kept when it is let go
          range.addEventListener('input', () => { m[key] = Number(range.value) * unit; input.value = fmt(Number(range.value), 3); this.build(); });
          range.addEventListener('change', () => { const v = Number(range.value) * unit; this.edit(x => { x.mates.find(q => q.id === m.id)[key] = v; }); });
          row.append(range);
        }
        li.append(row);
      }
      mateList.append(li);
    }
    if (!a.mates.length) mateList.append(el('li', { class: 'ms-muted' }, t('Asm.NoMates')));
    // the selected instance: where it is (only when no mate places it)
    let place = null;
    const sel = a.instances.find(i => i.id === this.selected);
    if (sel) {
      const placedByMate = a.mates.some(m => (m.a.inst === sel.id || m.b.inst === sel.id)) && !sel.fixed && a.instances[0]?.id !== sel.id;
      const T = sel.transform || I4();
      const unit = this.host.unit();
      const field = (label, value, applyValue) => {
        const input = el('input', { class: 'mat-input mat-input--sm mat-mono', value: fmt(value, 3), disabled: ro || placedByMate });
        input.addEventListener('change', () => { const v = Number(input.value.replace(',', '.')); if (Number.isFinite(v)) this.edit(x => { const i = x.instances.find(q => q.id === sel.id); i.transform = applyValue(i.transform || I4(), v); }); });
        return el('label', { class: 'mat-field ms-field-sm' }, el('span', { class: 'mat-label' }, label), input);
      };
      const turn = (axis, deg) => { const a2 = deg * Math.PI / 180, c = Math.cos(a2), s = Math.sin(a2); return axis === 'x' ? [1, 0, 0, 0, 0, c, s, 0, 0, -s, c, 0, 0, 0, 0, 1] : axis === 'y' ? [c, 0, -s, 0, 0, 1, 0, 0, s, 0, c, 0, 0, 0, 0, 1] : rotZ(deg); };
      place = el('div', { class: 'ms-asmplace' },
        el('p', { class: 'mat-label' }, t('Asm.Place', this.instances.find(x => x.id === sel.id)?.name || '')),
        placedByMate ? el('p', { class: 'mat-hint' }, t('Asm.PlacedByMate')) : null,
        el('div', { class: 'ms-dialog__pair' }, field('X', T[12] / unit, (M, v) => { const o = [...M]; o[12] = v * unit; return o; }), field('Y', T[13] / unit, (M, v) => { const o = [...M]; o[13] = v * unit; return o; })),
        el('div', { class: 'ms-dialog__pair' }, field('Z', T[14] / unit, (M, v) => { const o = [...M]; o[14] = v * unit; return o; }), field(t('Asm.TurnZ'), 0, (M, v) => turnAbout(M, turn('z', v)))),
        el('div', { class: 'ms-dialog__pair' }, field(t('Asm.TurnX'), 0, (M, v) => turnAbout(M, turn('x', v))), field(t('Asm.TurnY'), 0, (M, v) => turnAbout(M, turn('y', v)))));
    }
    panel.replaceChildren(...[
      el('h2', { class: 'ms-side__head' }, icon('assembly'), el('span', null, t('Asm.Instances')), el('span', { class: 'ms-side__count' }, String(a.instances.length))),
      instList,
      el('h2', { class: 'ms-side__head' }, icon('link'), el('span', null, t('Asm.Mates')), el('span', { class: 'ms-side__count' }, String(a.mates.length))),
      mateList,
      place,
      this.solved?.over.length ? el('p', { class: 'ms-dialog__text ms-conflict-head' }, icon('alert'), ' ', t('Asm.Over', this.solved.over.length)) : null,
    ].filter(Boolean));
  }

  // ---- the tools ------------------------------------------------------------------------------------------------------------------

  action(name) {
    if (name === 'insert') return this.openInsert();
    if (name === 'interference') return this.interference();
    if (name === 'bom') return this.bom();
  }

  /** The parts of the Part Studios to choose from; a click adds an instance beside the others. */
  openInsert() {
    if (!this.host.canEdit()) return;
    const dlg = this.ui.insert, list = dlg.querySelector('[data-asm-insert-list]');
    list.replaceChildren();
    for (const s of this.host.studios().filter(x => !x.content?.drawing && !x.content?.assembly)) {
      const parts = this.partsOf(s.id);
      list.append(el('li', { class: 'ms-asminsert__studio' }, icon('studio'), el('span', null, s.name)));
      if (!parts.length) list.append(el('li', { class: 'ms-muted ms-asminsert__none' }, t('Asm.NoParts')));
      for (const p of parts) {
        const b = el('button', { type: 'button', class: 'ms-asminsert__part' }, el('span', { class: 'ms-asmlist__dot' }), el('span', null, this.host.partName(p)));
        b.querySelector('.ms-asmlist__dot').style.background = p.color;
        b.addEventListener('click', () => { this.insert(s.id, p); if (dlg.open) dlg.close(); });
        list.append(el('li', null, b));
      }
    }
    if (window.MatUi?.dialog?.open) window.MatUi.dialog.open(dlg.id); else dlg.showModal();
  }

  insert(studioId, part) {
    // beside what is there already, along x
    let right = 0;
    for (const x of this.instances || []) { const p = x.mesh.positions; for (let i = 0; i < p.length; i += 3) right = Math.max(right, p[i]); }
    const box = part.manifold.boundingBox();
    const dx = this.instances?.length ? right + 10 - box.min[0] : 0;
    const count = (this.a.instances || []).filter(i => i.studio === studioId && i.part === part.id).length;
    this.edit(a => { a.instances.push({ id: uid('i'), studio: studioId, part: part.id, name: `${this.host.partName(part)} <${count + 1}>`, fixed: !a.instances.length, transform: move(dx, 0, 0) }); });
  }

  /** Which instances overlap, and by how much (the kernel intersects them pair by pair). */
  interference() {
    const list = this.instances || [], found = [];
    for (let i = 0; i < list.length; i++) for (let j = i + 1; j < list.length; j++) {
      const a = list[i].source.manifold.transform(list[i].matrix), b = list[j].source.manifold.transform(list[j].matrix);
      const both = a.intersect(b), v = both.volume();
      if (v > 1e-6) found.push(`${list[i].name} × ${list[j].name}: ${fmt(v / Math.pow(this.host.unit(), 3), 2)} ${this.host.units()}³`);
      a.delete(); b.delete(); both.delete();
    }
    if (window.MatUi?.alert) window.MatUi.alert(found.length ? found.join('\n') : t('Asm.NoInterference'), { title: t('Asm.Interference'), icon: found.length ? 'alert' : 'check-circle' });
    else toast(found.length ? found.join(' · ') : t('Asm.NoInterference'));
  }

  /** The bill of materials: every part with how many times it is used, as CSV. */
  bom() {
    const rows = new Map();
    for (const inst of this.a.instances) {
      const s = this.host.studios().find(x => x.id === inst.studio), part = this.partsOf(inst.studio).find(p => p.id === inst.part);
      const key = inst.studio + '/' + inst.part;
      if (!rows.has(key)) rows.set(key, { name: part ? this.host.partName(part) : inst.part, studio: s?.name || '', count: 0, volume: part ? part.manifold.volume() : 0 });
      rows.get(key).count++;
    }
    const u = this.host.units(), k = Math.pow(this.host.unit(), 3);
    const csv = [[t('Asm.Bom.Pos'), t('Asm.Bom.Part'), t('Asm.Bom.Studio'), t('Asm.Bom.Count'), `${t('Asm.Bom.Volume')} (${u}³)`].join(';'),
      ...[...rows.values()].map((r, i) => [i + 1, r.name, r.studio, r.count, fmt(r.volume / k, 2)].map(v => `"${String(v).replace(/"/g, '""')}"`).join(';'))].join('\r\n');
    download('stueckliste.csv', '﻿' + csv, 'text/csv');
  }
}

/** A turn of an instance about its own place (the move stays). */
function turnAbout(M, R) {
  const o = mul(M, R);
  o[12] = M[12]; o[13] = M[13]; o[14] = M[14];
  return o;
}

/** A mesh moved by a matrix (positions of the triangles and of the edges). */
function moveMesh(mesh, M) {
  const p = mesh.positions, out = new Float32Array(p.length);
  for (let i = 0; i < p.length; i += 3) { const q = apply(M, [p[i], p[i + 1], p[i + 2]]); out[i] = q[0]; out[i + 1] = q[1]; out[i + 2] = q[2]; }
  let edges = mesh.edges;
  if (edges) {
    const e = edges.pos, ep = new Float32Array(e.length);
    for (let i = 0; i < e.length; i += 3) { const q = apply(M, [e[i], e[i + 1], e[i + 2]]); ep[i] = q[0]; ep[i + 1] = q[1]; ep[i + 2] = q[2]; }
    edges = { ...edges, pos: ep };
  }
  return { ...mesh, positions: out, edges };
}

const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const norm = a => { const l = Math.hypot(...a) || 1; return a.map(v => v / l); };
