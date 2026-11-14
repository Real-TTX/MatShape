/* MatShape – a drawing as a tab of its own (like the drawings of OnShape): the sheet of a Part Studio of the model, made again whenever the Part Studio changes.
   Settings on the left (Part Studio, sheet, scale, views, section, hidden edges, overall dimensions, centre marks, title); tools over the sheet: select (drag a
   view to move it, Del deletes a note), dimension (two points of a view; dragged up/down it measures across, left/right upright, at a slant along), diameter
   (a circle), detail view (centre, size, place). The notes are kept in the coordinates of their view, so they follow when the model changes.
   Content of the tab: { features: [], drawing: { source, sheet, scale, views, section, hidden, dims, centres, title, notes: [...], moved: { view: [dx, dy] } } }. */

import { SCALES, annotate, drawingViews, layoutDrawing, toDxf, toPdf, toSvg, viewGeometry } from './drawing.js';
import { dispose, regenerate } from './model.js';
import { download, el, fileName, fmt, t, uid } from './util.js';

const SVGNS = 'http://www.w3.org/2000/svg';
const LETTERS = 'ZYXWVUTSRQPONMLKJIHGFEDCB';

export class DrawingEditor {
  /** ui: { sheet (container over the view), panel (settings), toolbar }; host: { kernel(), studios(), units(), unit(), person(), modelName(), name(), change(fn(drawing)), canEdit() } */
  constructor(ui, host) {
    this.ui = ui;
    this.host = host;
    this.tool = 'select';
    this.zoom = 1;
    this.d = null;
    this.views = [];
    this.key = '';
    ui.toolbar.addEventListener('click', e => {
      const b = e.target.closest('[data-draw-tool], [data-draw-action]');
      if (!b) return;
      if (b.dataset.drawTool) this.setTool(b.dataset.drawTool);
      else this.action(b.dataset.drawAction);
    });
    ui.sheet.addEventListener('wheel', e => { e.preventDefault(); this.setZoom(this.zoom * Math.pow(1.0015, -e.deltaY), e); }, { passive: false });
    ui.sheet.addEventListener('pointerdown', e => this.down(e));
    ui.sheet.addEventListener('pointermove', e => this.move(e));
    ui.sheet.addEventListener('pointerup', e => this.up(e));
    document.addEventListener('keydown', e => {
      if (!this.d || ui.sheet.hidden || /^(INPUT|SELECT|TEXTAREA)$/.test(e.target.tagName)) return;
      if ((e.key === 'Delete' || e.key === 'Backspace') && this.selected) { e.preventDefault(); this.removeSelected(); }
      if (e.key === 'Escape') { this.pending = null; this.setTool('select'); }
    });
  }

  /** Shows a drawing (the content of the tab); made again from its Part Studio when that or the settings changed. */
  open(drawing) {
    this.d = drawing || {};
    this.ensureDefaults();
    this.renderPanel();
    this.compute();
    this.setTool(this.tool);
    requestAnimationFrame(() => this.fit());
  }

  close() { this.d = null; this.ui.sheet.replaceChildren(); }

  ensureDefaults() {
    const d = this.d, studios = this.host.studios().filter(s => !s.content?.drawing && !s.content?.assembly);
    if (!studios.some(s => s.id === d.source)) d.source = studios[0]?.id ?? null;
    d.sheet ||= 'A3';
    d.scale ||= 'auto';
    d.views ||= { front: true, top: true, left: true, iso: true };
    if (d.section === undefined) d.section = { plane: 'front', offset: 0 };
    if (d.hidden === undefined) d.hidden = true;
    if (d.dims === undefined) d.dims = true;
    if (d.centres === undefined) d.centres = true;
    d.notes ||= [];
    d.moved ||= {};
  }

  /** A change of the drawing: one step of the history of the tab (the editor gets it back through open). */
  edit(fn) { if (this.host.canEdit()) this.host.change(d => { fn(d); }); }

  // ---- making the sheet --------------------------------------------------------------------------------------------------------

  compute() {
    const d = this.d;
    const studio = this.host.studios().find(s => s.id === d.source);
    const opts = { views: d.views, section: d.section, hidden: d.hidden, dims: d.dims };
    const key = JSON.stringify([studio?.id, studio?.content, opts]);
    if (key !== this.key) {
      this.key = key;
      this.views = [];
      if (studio) {
        const result = regenerate(this.host.kernel(), studio.content, this.host.units());
        try {
          this.views = viewGeometry(drawingViews(this.host.kernel(), result.parts, { ...opts, labels: { front: t('Drawing.View.front'), top: t('Drawing.View.top'), left: t('Drawing.View.left'), iso: t('Drawing.View.iso'), section: t('Drawing.View.section') } }));
        } catch (e) { console.warn('MatShape: drawing failed', e); }
        dispose(result);
      }
    }
    this.layout();
  }

  layout() {
    const d = this.d, unit = this.host.unit();
    const format = v => fmt(v / unit, 2);
    this.sheet = this.views.length ? layoutDrawing({
      sheet: d.sheet, scale: d.scale === 'auto' ? 'auto' : String(d.scale).split(':').map(Number), views: this.views, moved: d.moved, centres: d.centres,
      title: {
        name: d.title || this.host.name(), model: this.host.modelName(), date: new Date().toLocaleDateString(document.documentElement.lang || 'en'), units: this.host.units(), by: this.host.person(),
        labels: { title: t('Drawing.Block.Title'), model: t('Drawing.Block.Model'), scale: t('Drawing.Block.Scale'), date: t('Drawing.Block.Date'), units: t('Drawing.Block.Units'), sheet: t('Drawing.Block.Sheet'), by: t('Drawing.Block.By'), software: t('Drawing.Block.Software'), projection: t('Drawing.Block.Projection') },
      },
      format,
    }) : null;
    if (this.sheet) annotate(this.sheet, this.views, d.notes, format);
    this.draw();
  }

  draw() {
    const box = this.ui.sheet;
    if (!this.sheet) {
      box.replaceChildren(el('p', { class: 'ms-sheet__empty ms-muted' }, t(this.views.length || !this.d.source ? 'Drawing.TooBig' : 'Drawing.Empty')));
      this.svg = null;
      return;
    }
    const doc = new DOMParser().parseFromString(toSvg(this.sheet), 'image/svg+xml');
    const svg = document.importNode(doc.documentElement, true);
    svg.classList.add('ms-sheet__svg');
    // the chosen note, and what a tool shows while it is used
    this.overlay = document.createElementNS(SVGNS, 'g');
    svg.append(this.overlay);
    const old = this.svg;
    this.svg = svg;
    if (old && old.parentNode === box) box.replaceChild(svg, old); else box.replaceChildren(svg);
    this.applyZoom();
    this.drawOverlay();
  }

  // ---- zoom ------------------------------------------------------------------------------------------------------------------------

  fit() {
    if (!this.sheet) return;
    const r = this.ui.sheet.getBoundingClientRect();
    this.zoom = Math.max(0.1, Math.min((r.width - 32) / this.sheet.width, (r.height - 32) / this.sheet.height) / 3.78);
    this.applyZoom();
  }

  setZoom(z, e) {
    const box = this.ui.sheet, before = this.zoom;
    this.zoom = Math.min(20, Math.max(0.1, z));
    this.applyZoom();
    if (e) {
      const r = box.getBoundingClientRect(), k = this.zoom / before;
      box.scrollLeft = (box.scrollLeft + e.clientX - r.left) * k - (e.clientX - r.left);
      box.scrollTop = (box.scrollTop + e.clientY - r.top) * k - (e.clientY - r.top);
    }
  }

  applyZoom() {
    if (!this.svg || !this.sheet) return;
    // 1 mm of the sheet = 3.78 px at zoom 1
    this.svg.style.width = Math.round(this.sheet.width * 3.78 * this.zoom) + 'px';
    this.svg.style.height = Math.round(this.sheet.height * 3.78 * this.zoom) + 'px';
  }

  // ---- the pointer ----------------------------------------------------------------------------------------------------------------

  /** Where the pointer is on the sheet (mm). */
  paper(e) {
    if (!this.svg) return null;
    const m = this.svg.getScreenCTM();
    if (!m) return null;
    const p = new DOMPoint(e.clientX, e.clientY).matrixTransform(m.inverse());
    return [p.x, p.y];
  }

  /** The view at a point of the sheet, and the point in its coordinates. */
  viewAt(p) {
    for (const pl of this.sheet?.placed || []) {
      if (Math.abs(p[0] - pl.cx) <= pl.w / 2 + 4 && Math.abs(p[1] - pl.cy) <= pl.h / 2 + 4) return { pl, at: [pl.bx + (p[0] - pl.cx) / pl.k, pl.by - (p[1] - pl.cy) / pl.k] };
    }
    return null;
  }

  /** The point of a view the pointer snaps to (an end of an edge or a centre), within a few pixels. */
  snapAt(p) {
    const hit = this.viewAt(p);
    if (!hit) return null;
    const v = this.views.find(x => x.key === hit.pl.key);
    const tol = 9 / (3.78 * this.zoom) / hit.pl.k;
    let best = null, bd = tol;
    for (const q of v?.snaps || []) { const dd = Math.hypot(q[0] - hit.at[0], q[1] - hit.at[1]); if (dd < bd) { bd = dd; best = q; } }
    return best ? { view: hit.pl.key, p: best, pl: hit.pl } : null;
  }

  noteAt(p) {
    // the notes are hit near their points (good enough to select one for deleting)
    let best = null, bd = 6 / (3.78 * this.zoom);
    for (const n of this.d.notes) {
      const pl = this.sheet.placed.find(x => x.key === n.view);
      if (!pl) continue;
      const P = q => [pl.cx + (q[0] - pl.bx) * pl.k, pl.cy - (q[1] - pl.by) * pl.k];
      const pts = n.kind === 'detail' ? [n.at || P(n.c), P(n.c)] : n.kind === 'dia' ? [P(n.c)] : [P(n.a), P(n.b), [(P(n.a)[0] + P(n.b)[0]) / 2, (P(n.a)[1] + P(n.b)[1]) / 2]];
      for (const q of pts) { const dd = Math.hypot(q[0] - p[0], q[1] - p[1]); if (dd < bd) { bd = dd; best = n; } }
    }
    return best;
  }

  down(e) {
    const p = this.paper(e);
    if (!p || e.button !== 0) {
      if (e.button === 1 || e.button === 2) this.pan = { x: e.clientX, y: e.clientY, sl: this.ui.sheet.scrollLeft, st: this.ui.sheet.scrollTop };
      return;
    }
    this.ui.sheet.setPointerCapture(e.pointerId);
    if (this.tool === 'select') {
      const n = this.noteAt(p);
      if (n) { this.selected = n.id; this.drawOverlay(); return; }
      this.selected = null;
      const hit = this.viewAt(p);
      if (hit && this.host.canEdit()) this.dragView = { key: hit.pl.key, from: p, start: [...(this.d.moved[hit.pl.key] || [0, 0])] };
      else this.pan = { x: e.clientX, y: e.clientY, sl: this.ui.sheet.scrollLeft, st: this.ui.sheet.scrollTop };
      this.drawOverlay();
    }
  }

  move(e) {
    if (this.pan) { this.ui.sheet.scrollLeft = this.pan.sl - (e.clientX - this.pan.x); this.ui.sheet.scrollTop = this.pan.st - (e.clientY - this.pan.y); return; }
    const p = this.paper(e);
    if (!p) return;
    this.pointer = p;
    if (this.dragView) {
      const k = this.dragView.key;
      this.d.moved[k] = [this.dragView.start[0] + p[0] - this.dragView.from[0], this.dragView.start[1] + p[1] - this.dragView.from[1]];
      this.layout();
      this.dragView.moved = true;
      return;
    }
    this.drawOverlay();
  }

  up(e) {
    this.pan = null;
    if (this.dragView) {
      const drag = this.dragView;
      this.dragView = null;
      if (drag.moved) { const moved = { ...this.d.moved }; this.edit(d => { d.moved = moved; }); }
      return;
    }
    const p = this.paper(e);
    if (!p || e.button !== 0 || !this.host.canEdit()) return;
    if (this.tool === 'dim') this.dimClick(p);
    else if (this.tool === 'dia') this.diaClick(p);
    else if (this.tool === 'detail') this.detailClick(p);
  }

  // ---- the tools ------------------------------------------------------------------------------------------------------------------

  setTool(tool) {
    this.tool = tool;
    this.pending = null;
    this.ui.toolbar.querySelectorAll('[data-draw-tool]').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.drawTool === tool)));
    this.ui.sheet.dataset.tool = tool;
    this.host.status?.(t('Drawing.Hint.' + tool));
    this.drawOverlay();
  }

  /** Two points of one view, then where the dimension stands: the kind follows the direction it was dragged (like in the sketch). */
  dimClick(p) {
    const s = this.snapAt(p);
    if (!this.pending) { if (s) { this.pending = { a: s }; this.host.status?.(t('Drawing.Hint.dim2')); } return; }
    if (!this.pending.b) {
      if (s && s.view === this.pending.a.view && Math.hypot(s.p[0] - this.pending.a.p[0], s.p[1] - this.pending.a.p[1]) > 1e-9) { this.pending.b = s; this.host.status?.(t('Drawing.Hint.dim3')); }
      return;
    }
    const note = this.linearNote(p);
    this.pending = null;
    this.host.status?.(t('Drawing.Hint.dim'));
    if (note) this.edit(d => { d.notes.push(note); });
  }

  linearNote(p) {
    const { a, b } = this.pending, pl = a.pl;
    const P = q => [pl.cx + (q[0] - pl.bx) * pl.k, pl.cy - (q[1] - pl.by) * pl.k];
    const A = P(a.p), B = P(b.p);
    const inX = p[0] > Math.min(A[0], B[0]) && p[0] < Math.max(A[0], B[0]), inY = p[1] > Math.min(A[1], B[1]) && p[1] < Math.max(A[1], B[1]);
    const kind = inX && !inY ? 'h' : inY && !inX ? 'v' : 'a';
    const u = kind === 'h' ? [1, 0] : kind === 'v' ? [0, 1] : (() => { const l = Math.hypot(B[0] - A[0], B[1] - A[1]); return [(B[0] - A[0]) / l, (B[1] - A[1]) / l]; })();
    const n = [-u[1], u[0]], mid = [(A[0] + B[0]) / 2, (A[1] + B[1]) / 2];
    return { id: uid('n'), kind, view: a.view, a: a.p, b: b.p, off: (p[0] - mid[0]) * n[0] + (p[1] - mid[1]) * n[1] };
  }

  diaClick(p) {
    const hit = this.viewAt(p);
    if (!hit) return;
    const v = this.views.find(x => x.key === hit.pl.key);
    let best = null, bd = 8 / (3.78 * this.zoom) / hit.pl.k;
    for (const c of v?.circles || []) { const dd = Math.abs(Math.hypot(hit.at[0] - c.c[0], hit.at[1] - c.c[1]) - c.r); if (dd < bd) { bd = dd; best = c; } }
    if (!best) { this.host.status?.(t('Drawing.Hint.diaNone')); return; }
    const angle = Math.atan2(-(hit.at[1] - best.c[1]), hit.at[0] - best.c[0]);
    this.edit(d => { d.notes.push({ id: uid('n'), kind: 'dia', view: hit.pl.key, c: best.c, r: best.r, angle }); });
  }

  /** A detail view: the centre in a view, the size, then where the enlarged view goes. */
  detailClick(p) {
    if (!this.pending) { const hit = this.viewAt(p); if (hit && hit.pl.key !== 'iso') { this.pending = { view: hit.pl.key, c: hit.at, pl: hit.pl }; this.host.status?.(t('Drawing.Hint.detail2')); } return; }
    if (this.pending.r === undefined) {
      const pl = this.pending.pl, C = [pl.cx + (this.pending.c[0] - pl.bx) * pl.k, pl.cy - (this.pending.c[1] - pl.by) * pl.k];
      const r = Math.hypot(p[0] - C[0], p[1] - C[1]) / pl.k;
      if (r > 1e-6) { this.pending.r = r; this.host.status?.(t('Drawing.Hint.detail3')); }
      return;
    }
    const used = new Set(this.d.notes.filter(n => n.kind === 'detail').map(n => n.letter));
    const letter = [...LETTERS].find(l => !used.has(l)) || 'Z';
    const { view, c, r } = this.pending;
    this.pending = null;
    this.host.status?.(t('Drawing.Hint.detail'));
    this.edit(d => { d.notes.push({ id: uid('n'), kind: 'detail', view, c, r, factor: Number(this.ui.panel.querySelector('[data-draw-factor]')?.value) || 2, at: p, letter }); });
  }

  removeSelected() {
    const id = this.selected;
    this.selected = null;
    if (id) this.edit(d => { d.notes = d.notes.filter(n => n.id !== id); });
  }

  /** What a tool shows over the sheet: the point it snaps to, the dimension or detail that is being made, the chosen note. */
  drawOverlay() {
    const g = this.overlay;
    if (!g) return;
    g.replaceChildren();
    const mm = 1 / (3.78 * this.zoom);
    const add = (name, attrs) => { const n = document.createElementNS(SVGNS, name); for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, v); g.append(n); return n; };
    const accent = '#f59e0b', blue = '#2563eb';
    if (this.selected) {
      const n = this.d.notes.find(x => x.id === this.selected), pl = n && this.sheet.placed.find(x => x.key === n.view);
      if (pl) {
        const P = q => [pl.cx + (q[0] - pl.bx) * pl.k, pl.cy - (q[1] - pl.by) * pl.k];
        const pts = n.kind === 'detail' ? [P(n.c), n.at] : n.kind === 'dia' ? [P(n.c)] : [P(n.a), P(n.b)];
        for (const q of pts) add('circle', { cx: q[0], cy: q[1], r: 6 * mm, fill: 'none', stroke: accent, 'stroke-width': 2 * mm });
      }
    }
    const p = this.pointer;
    if (!p) return;
    if (this.tool === 'dim') {
      const s = this.snapAt(p);
      if (s) { const pl = s.pl; add('circle', { cx: pl.cx + (s.p[0] - pl.bx) * pl.k, cy: pl.cy - (s.p[1] - pl.by) * pl.k, r: 4 * mm, fill: blue }); }
      if (this.pending?.a && this.pending.b) {
        const n = this.linearNote(p), d = { prims: [], placed: this.sheet.placed, scale: this.sheet.scale };
        annotate(d, this.views, [n], v => fmt(v / this.host.unit(), 2));
        for (const q of d.prims) {
          if (q.k === 'line') add('line', { x1: q.a[0], y1: q.a[1], x2: q.b[0], y2: q.b[1], stroke: blue, 'stroke-width': 0.25 });
          else if (q.k === 'text') { const tx = add('text', { x: q.p[0], y: q.p[1], 'font-size': 3.5, 'text-anchor': 'middle', fill: blue, 'font-family': 'Helvetica, Arial, sans-serif', ...(q.rot ? { transform: `rotate(${-q.rot} ${q.p[0]} ${q.p[1]})` } : {}) }); tx.textContent = q.text; }
        }
      } else if (this.pending?.a) {
        const pl = this.pending.a.pl, A = [pl.cx + (this.pending.a.p[0] - pl.bx) * pl.k, pl.cy - (this.pending.a.p[1] - pl.by) * pl.k];
        add('line', { x1: A[0], y1: A[1], x2: p[0], y2: p[1], stroke: blue, 'stroke-width': 0.25, 'stroke-dasharray': '1 1' });
      }
    }
    if (this.tool === 'detail' && this.pending) {
      const pl = this.pending.pl, C = [pl.cx + (this.pending.c[0] - pl.bx) * pl.k, pl.cy - (this.pending.c[1] - pl.by) * pl.k];
      const r = this.pending.r !== undefined ? this.pending.r * pl.k : Math.hypot(p[0] - C[0], p[1] - C[1]);
      add('circle', { cx: C[0], cy: C[1], r, fill: 'none', stroke: blue, 'stroke-width': 0.3, 'stroke-dasharray': '2 1' });
    }
  }

  // ---- settings and files ---------------------------------------------------------------------------------------------------------

  renderPanel() {
    const d = this.d, panel = this.ui.panel;
    const studios = this.host.studios().filter(s => !s.content?.drawing && !s.content?.assembly);
    const ro = !this.host.canEdit();
    const field = (label, control) => el('label', { class: 'mat-field ms-field-sm' }, el('span', { class: 'mat-label' }, label), control);
    const select = (value, options, apply) => {
      const s = el('select', { class: 'mat-select mat-select--sm mat-input--sm', disabled: ro });
      for (const [v, text] of options) s.append(el('option', { value: v, selected: String(v) === String(value) }, text));
      s.addEventListener('change', () => this.edit(dd => apply(dd, s.value)));
      return s;
    };
    const check = (label, value, apply) => {
      const input = el('input', { type: 'checkbox', checked: !!value, disabled: ro });
      input.addEventListener('change', () => this.edit(dd => apply(dd, input.checked)));
      return el('label', { class: 'mat-check ms-check' }, input, el('span', { class: 'mat-check__text' }, label));
    };
    const title = el('input', { class: 'mat-input mat-input--sm', value: d.title || '', placeholder: this.host.name(), maxlength: 80, disabled: ro });
    title.addEventListener('change', () => this.edit(dd => { dd.title = title.value.trim(); }));
    const offset = el('input', { class: 'mat-input mat-input--sm mat-mono', value: String((d.section?.offset || 0) / this.host.unit()), inputmode: 'decimal', disabled: ro });
    offset.addEventListener('change', () => { const v = Number(offset.value.replace(',', '.')); if (Number.isFinite(v)) this.edit(dd => { if (dd.section) dd.section.offset = v * this.host.unit(); }); });
    const factor = el('select', { class: 'mat-select mat-select--sm mat-input--sm', 'data-draw-factor': '' }, ...[2, 3, 4, 5, 10].map(f => el('option', { value: f, selected: f === 2 }, '× ' + f)));
    panel.replaceChildren(
      el('h2', { class: 'ms-side__head' }, el('span', null, t('Drawing.Settings'))),
      el('div', { class: 'ms-drawpanel mat-form' },
        field(t('Drawing.Source'), select(d.source ?? '', studios.length ? studios.map(s => [s.id, s.name]) : [['', '–']], (dd, v) => { dd.source = Number(v) || null; })),
        field(t('Drawing.Name'), title),
        el('div', { class: 'ms-dialog__pair' },
          field(t('Drawing.Sheet'), select(d.sheet, [['A4', 'A4'], ['A3', 'A3'], ['A2', 'A2'], ['A1', 'A1']], (dd, v) => { dd.sheet = v; })),
          field(t('Drawing.Scale'), select(d.scale, [['auto', t('Drawing.Scale.Auto')], ...SCALES.map(([a, b]) => [`${a}:${b}`, `${a} : ${b}`])], (dd, v) => { dd.scale = v; }))),
        el('p', { class: 'mat-label' }, t('Drawing.Views')),
        ...['front', 'top', 'left', 'iso'].map(k => check(t('Drawing.View.' + k), d.views[k], (dd, v) => { dd.views = { ...dd.views, [k]: v }; })),
        field(t('Drawing.Section'), select(d.section?.plane || 'none', [['none', t('Drawing.Section.None')], ['front', t('Drawing.Section.Front')], ['right', t('Drawing.Section.Right')], ['top', t('Drawing.Section.Top')]], (dd, v) => { dd.section = v === 'none' ? null : { plane: v, offset: dd.section?.offset || 0 }; })),
        field(t('Drawing.Offset'), offset),
        check(t('Drawing.Hidden'), d.hidden, (dd, v) => { dd.hidden = v; }),
        check(t('Drawing.Dims'), d.dims, (dd, v) => { dd.dims = v; }),
        check(t('Drawing.Centres'), d.centres, (dd, v) => { dd.centres = v; }),
        field(t('Drawing.DetailFactor'), factor),
        d.moved && Object.keys(d.moved).length ? el('button', { type: 'button', class: 'mat-btn mat-btn--ghost mat-btn--sm', disabled: ro, onclick: () => this.edit(dd => { dd.moved = {}; }) }, t('Drawing.ResetViews')) : null,
        el('p', { class: 'mat-hint' }, t('Drawing.TabHint'))),
    );
  }

  action(name) {
    if (name === 'fit') { this.fit(); return; }
    if (name === 'delete') { this.removeSelected(); return; }
    if (!this.sheet) return;
    const file = fileName(this.d.title || this.host.name(), name);
    if (name === 'pdf') download(file, toPdf(this.sheet), 'application/pdf');
    else if (name === 'svg') download(file, toSvg(this.sheet), 'image/svg+xml');
    else if (name === 'dxf') download(file, toDxf(this.sheet), 'application/dxf');
  }
}
