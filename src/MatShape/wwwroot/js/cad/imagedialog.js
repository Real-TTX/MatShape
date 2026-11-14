/* MatShape – the editor "Picture → 3D model": load a picture (button, paste, drop), see its colours and the shapes that were recognised, choose per colour
   whether it is built, its height, colour and name, a base plate, the size; then the features are added as one step (imagetrace.js does the work).
   A click into the preview switches the colour under the pointer on or off. The picture can also go to the AI assistant instead. */

import { backgroundOf, buildFeatures, clean, hex, quantize, shapesOf } from './imagetrace.js';
import { debounce, el, t, toast, uid } from './util.js';

const PICTURES = ['image/png', 'image/jpeg', 'image/webp', 'image/gif', 'image/svg+xml'];

/** A rough name of a colour for the parts ("Green", "Black" …) from its hue, lightness and saturation. */
function colourName(rgb) {
  const [r, g, b] = rgb.map(v => v / 255);
  const max = Math.max(r, g, b), min = Math.min(r, g, b), l = (max + min) / 2, d = max - min;
  const s = d === 0 ? 0 : d / (1 - Math.abs(2 * l - 1));
  if (l < 0.16) return 'black';
  if (s < 0.15) return l > 0.85 ? 'white' : 'grey';
  let hue = max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  hue = (hue * 60 + 360) % 360;
  if (hue < 15 || hue >= 345) return l < 0.35 ? 'brown' : 'red';
  if (hue < 40) return l < 0.4 ? 'brown' : 'orange';
  if (hue < 70) return 'yellow';
  if (hue < 165) return 'green';
  if (hue < 200) return 'cyan';
  if (hue < 255) return 'blue';
  if (hue < 290) return 'purple';
  return 'pink';
}

export class ImageDialog {
  /** host: { apply(features, parts), toAi(file) | null, toMesh(file) | null (the 3D generation) } */
  constructor(dialog, host) {
    this.dialog = dialog;
    this.host = host;
    this.$ = s => dialog.querySelector(s);
    this.canvas = this.$('[data-img-canvas]');
    this.show = 'shapes';
    this.fileInput = this.$('[data-img-file]');
    dialog.querySelectorAll('[data-img-pick]').forEach(b => b.addEventListener('click', () => this.fileInput.click()));
    this.fileInput.addEventListener('change', () => { if (this.fileInput.files[0]) this.load(this.fileInput.files[0]); this.fileInput.value = ''; });
    dialog.addEventListener('dragover', e => { if (e.dataTransfer?.types?.includes('Files')) { e.preventDefault(); dialog.classList.add('is-dropping'); } });
    dialog.addEventListener('dragleave', e => { if (!dialog.contains(e.relatedTarget)) dialog.classList.remove('is-dropping'); });
    dialog.addEventListener('drop', e => { dialog.classList.remove('is-dropping'); const f = e.dataTransfer?.files?.[0]; if (f) { e.preventDefault(); this.load(f); } });
    dialog.addEventListener('paste', e => { const f = [...(e.clipboardData?.files || [])][0]; if (f) { e.preventDefault(); this.load(f); } });
    dialog.addEventListener('keydown', e => e.stopPropagation());   // the keys of the editor stay out while the dialog is open
    dialog.querySelectorAll('[data-img-show]').forEach(b => b.addEventListener('click', () => {
      this.show = b.dataset.imgShow;
      dialog.querySelectorAll('[data-img-show]').forEach(x => x.setAttribute('aria-pressed', String(x === b)));
      this.render();
    }));
    this.canvas.addEventListener('click', e => this.toggleAt(e));

    // what each setting recomputes: the colours (from scratch), the regions, or only the shapes
    // several changes in a row: the earliest step they touch is run (a later one alone would miss the others)
    const order = ['pixels', 'quantize', 'clean', 'shapes', 'stats'];
    let pending = null;
    const later = debounce(() => { const stage = pending; pending = null; this.compute(stage); }, 160);
    const on = (sel, stage) => this.$(sel)?.addEventListener('input', () => {
      this.outputs();
      if (pending === null || order.indexOf(stage) < order.indexOf(pending)) pending = stage;
      later();
    });
    on('[data-img-colours]', 'quantize');
    on('[data-img-detail]', 'pixels');
    on('[data-img-smooth]', 'clean');
    on('[data-img-minarea]', 'clean');
    on('[data-img-tol]', 'shapes');
    on('[data-img-circles]', 'shapes');
    on('[data-img-rects]', 'shapes');
    on('[data-img-base]', 'stats');
    on('[data-img-width]', 'stats');
    on('[data-img-baseh]', 'stats');
    on('[data-img-margin]', 'stats');
    this.$('[data-img-base]').addEventListener('change', () => { this.$('[data-img-base-fields]').hidden = this.$('[data-img-base]').value === 'none'; });
    this.$('[data-img-apply]').addEventListener('click', () => this.apply());
    this.$('[data-img-ai]')?.addEventListener('click', () => { if (this.file) { this.close(); this.host.toAi?.(this.file); } });
    this.$('[data-img-mesh]')?.addEventListener('click', () => { if (this.file) { this.close(); this.host.toMesh?.(this.file); } });
    this.outputs();
  }

  open(file) {
    if (!this.dialog.open) { if (window.MatUi?.dialog?.open) window.MatUi.dialog.open(this.dialog.id); else this.dialog.showModal(); }
    if (file) this.load(file);
  }

  close() { if (this.dialog.open) this.dialog.close(); }

  outputs() {
    for (const [name, sel] of [['colours', '[data-img-colours]'], ['smooth', '[data-img-smooth]'], ['tol', '[data-img-tol]'], ['minarea', '[data-img-minarea]']]) {
      const input = this.$(sel), out = this.$(`[data-img-out="${name}"]`);
      if (out) out.textContent = name === 'tol' ? input.value + ' px' : name === 'minarea' ? input.value + ' px²' : input.value;
      input.style.setProperty('--mat-range', ((input.value - input.min) / (input.max - input.min)) * 100 + '%');
    }
  }

  // ---- the picture ------------------------------------------------------------------------------------------------------------

  async load(file) {
    const type = file.type || (/\.svg$/i.test(file.name) ? 'image/svg+xml' : '');
    if (!PICTURES.includes(type)) { toast(t('Studio.Image.NotAPicture'), 'warning'); return; }
    try {
      const url = URL.createObjectURL(file);
      const img = new Image();
      await new Promise((resolve, reject) => { img.onload = resolve; img.onerror = reject; img.src = url; });
      URL.revokeObjectURL(this.url);
      this.url = url;
      this.source = img;
      this.file = file;
      this.svg = type === 'image/svg+xml';
    } catch {
      toast(t('Studio.Image.Unreadable'), 'warning');
      return;
    }
    this.$('[data-img-empty]').hidden = true;
    this.$('[data-img-stage]').hidden = false;
    this.$('[data-img-bar]').hidden = false;
    this.$('[data-img-apply]').disabled = false;
    const ai = this.$('[data-img-ai]');
    if (ai) ai.disabled = false;
    const mesh = this.$('[data-img-mesh]');
    if (mesh) mesh.disabled = false;
    this.compute('pixels');
  }

  /** Runs the steps from `stage` on: pixels -> quantize -> clean -> shapes -> stats. */
  compute(stage) {
    if (!this.source) return;
    const order = ['pixels', 'quantize', 'clean', 'shapes', 'stats'];
    const from = order.indexOf(stage);
    if (from <= 0) this.pixels();
    if (from <= 1) this.quantize();
    if (from <= 2) this.regions();
    if (from <= 3) this.shapes();
    this.stats();
    this.render();
  }

  pixels() {
    const max = Number(this.$('[data-img-detail]').value);
    const iw = this.source.naturalWidth || 512, ih = this.source.naturalHeight || 512;
    const scale = max / Math.max(iw, ih);
    const w = Math.max(8, Math.round(iw * scale)), h = Math.max(8, Math.round(ih * scale));
    const c = document.createElement('canvas');
    c.width = w; c.height = h;
    const g = c.getContext('2d', { willReadFrequently: true });
    g.drawImage(this.source, 0, 0, w, h);
    this.image = g.getImageData(0, 0, w, h);
    this.w = w; this.h = h;
    // the preview draws at twice the size, so outlines stay sharp
    this.canvas.width = w * 2;
    this.canvas.height = h * 2;
  }

  quantize() {
    const k = Number(this.$('[data-img-colours]').value);
    const q = quantize(this.image, k);
    this.quantized = q;
    this.colours = null;   // new colours: the list starts over
  }

  regions() {
    const { w, h } = this;
    this.labels = clean(this.quantized.labels, w, h, { smooth: Number(this.$('[data-img-smooth]').value), minArea: Number(this.$('[data-img-minarea]').value) });
    const count = new Array(this.quantized.palette.length).fill(0);
    for (const l of this.labels) if (l >= 0) count[l]++;
    const background = backgroundOf(this.labels, w, h);
    if (!this.colours) {
      const used = new Map();
      this.colours = this.quantized.palette.map((p, i) => {
        const base = t('Studio.Image.Hue.' + colourName(p.rgb));
        const n = (used.get(base) || 0) + 1;
        used.set(base, n);
        return { label: i, include: i !== background, height: 1, color: hex(p.rgb), name: n > 1 ? `${base} ${n}` : base };
      });
      this.$('[data-img-basecolor]').value = background >= 0 ? hex(this.quantized.palette[background].rgb) : '#ffffff';
    }
    this.colours.forEach(c => { c.count = count[c.label]; });
    this.renderPalette();
  }

  options() {
    return {
      tol: Number(this.$('[data-img-tol]').value),
      minArea: Math.max(4, Number(this.$('[data-img-minarea]').value)),
      circles: this.$('[data-img-circles]').checked,
      rects: this.$('[data-img-rects]').checked,
    };
  }

  shapes() {
    const options = this.options();
    this.shapesByLabel = new Map(this.colours.filter(c => c.count).map(c => [c.label, shapesOf(this.labels, this.w, this.h, c.label, options)]));
  }

  settings() {
    const num = sel => Math.max(0, Number(String(this.$(sel).value).replace(',', '.')) || 0);
    return {
      width: Math.max(1, num('[data-img-width]')),
      base: this.$('[data-img-base]').value,
      baseHeight: num('[data-img-baseh]'),
      margin: num('[data-img-margin]'),
      baseColor: this.$('[data-img-basecolor]').value,
      colours: this.colours.filter(c => c.count),
    };
  }

  stats() {
    let profiles = 0, circles = 0, rects = 0, lines = 0;
    for (const c of this.colours) {
      if (!c.include || !c.count) continue;
      for (const s of this.shapesByLabel.get(c.label) || []) { profiles++; if (s.kind === 'circle') circles++; else { lines += s.points.length; if (s.kind === 'rect') rects++; } }
    }
    const s = this.settings();
    const mm = v => (Math.round(v * 10) / 10).toLocaleString(document.documentElement.lang);
    this.$('[data-img-stats]').textContent = t('Studio.Image.Stats', profiles, circles, rects, lines, mm(s.width), mm(s.width * this.h / this.w));
    this.$('[data-img-apply]').disabled = !profiles && s.base === 'none';
  }

  // ---- the palette ------------------------------------------------------------------------------------------------------------

  renderPalette() {
    const list = this.$('[data-img-palette]');
    const total = this.w * this.h;
    list.replaceChildren(...this.colours.filter(c => c.count).map(c => {
      const include = el('input', { type: 'checkbox', 'aria-label': t('Studio.Image.Include', c.name) });
      include.checked = c.include;
      include.addEventListener('change', () => { c.include = include.checked; row.classList.toggle('is-off', !c.include); this.stats(); this.render(); });
      const color = el('input', { type: 'color', class: 'ms-imgdlg__color', value: c.color, 'aria-label': t('Studio.Image.ColourOf', c.name) });
      color.addEventListener('input', () => { c.color = color.value; this.render(); });
      const name = el('input', { class: 'mat-input mat-input--sm', value: c.name, 'aria-label': t('Studio.Image.NameOf', c.name), maxlength: '60' });
      name.addEventListener('input', () => { c.name = name.value.trim() || c.name; });
      const height = el('input', { class: 'mat-input mat-input--sm mat-mono ms-imgdlg__height', type: 'number', min: '0', step: '0.2', value: String(c.height), 'aria-label': t('Studio.Image.HeightOf', c.name), 'data-tip': t('Studio.Image.Height') });
      height.addEventListener('input', () => { c.height = Math.max(0, Number(height.value.replace(',', '.')) || 0); this.stats(); });
      const share = el('span', { class: 'ms-imgdlg__share mat-mono' }, Math.max(0.1, Math.round(c.count / total * 1000) / 10).toLocaleString(document.documentElement.lang) + ' %');
      const row = el('li', { class: 'ms-imgdlg__colour' + (c.include ? '' : ' is-off'), 'data-label': String(c.label) }, include, color, name, height, el('span', { class: 'ms-muted' }, 'mm'), share);
      return row;
    }));
  }

  /** A click into the preview: the colour under the pointer is switched on or off. */
  toggleAt(e) {
    if (!this.labels) return;
    const r = this.canvas.getBoundingClientRect();
    const x = Math.floor((e.clientX - r.left) / r.width * this.w), y = Math.floor((e.clientY - r.top) / r.height * this.h);
    const label = this.labels[y * this.w + x];
    const c = this.colours?.find(x => x.label === label);
    if (!c) return;
    c.include = !c.include;
    this.renderPalette();
    this.stats();
    this.render();

  }

  // ---- the preview ------------------------------------------------------------------------------------------------------------

  render() {
    if (!this.image) return;
    const g = this.canvas.getContext('2d');
    const { w, h } = this, W = this.canvas.width, H = this.canvas.height, k = W / w;
    g.clearRect(0, 0, W, H);
    if (this.show === 'original') { g.drawImage(this.source, 0, 0, W, H); return; }
    // the colours of the regions; colours that are not built are only hinted
    const pixels = g.createImageData(w, h);
    const rgb = new Map(this.colours.map(c => [c.label, [parseInt(c.color.slice(1, 3), 16), parseInt(c.color.slice(3, 5), 16), parseInt(c.color.slice(5, 7), 16), c.include]]));
    for (let i = 0; i < w * h; i++) {
      const c = rgb.get(this.labels[i]);
      if (!c) continue;
      const o = i * 4;
      pixels.data[o] = c[0]; pixels.data[o + 1] = c[1]; pixels.data[o + 2] = c[2];
      pixels.data[o + 3] = c[3] ? (this.show === 'shapes' ? 150 : 255) : 40;
    }
    const tmp = document.createElement('canvas');
    tmp.width = w; tmp.height = h;
    tmp.getContext('2d').putImageData(pixels, 0, 0);
    g.imageSmoothingEnabled = false;
    g.drawImage(tmp, 0, 0, W, H);
    if (this.show !== 'shapes') return;
    // the recognised shapes: circles and rectangles in the accent colour, other outlines dark
    g.lineWidth = 2;
    g.lineJoin = 'round';
    for (const c of this.colours) {
      if (!c.include) continue;
      for (const s of this.shapesByLabel.get(c.label) || []) {
        g.strokeStyle = s.kind === 'polygon' ? '#111827' : '#1d7a3c';
        g.beginPath();
        if (s.kind === 'circle') g.arc(s.c[0] * k, s.c[1] * k, s.r * k, 0, Math.PI * 2);
        else s.points.forEach((p, i) => (i ? g.lineTo(p[0] * k, p[1] * k) : g.moveTo(p[0] * k, p[1] * k)));
        g.closePath();
        g.stroke();
        if (s.kind === 'polygon') { g.fillStyle = '#111827'; s.points.forEach(p => g.fillRect(p[0] * k - 1.5, p[1] * k - 1.5, 3, 3)); }
      }
    }
  }

  // ---- the result -------------------------------------------------------------------------------------------------------------

  apply() {
    if (!this.labels) return;
    const s = this.settings();
    const names = {
      base: t('Studio.Image.BaseName'),
      top: t('Studio.Image.TopName'),
      sketch: n => t('Studio.Image.SketchName', n),
      extrude: n => n,
    };
    const built = buildFeatures({ w: this.w, h: this.h, labels: this.labels }, s, names, prefix => uid(prefix), this.options());
    if (!built.features.length) { toast(t('Studio.Image.Nothing'), 'warning'); return; }
    if (built.stats.lines > 8000) { toast(t('Studio.Image.TooMany'), 'warning'); return; }
    this.close();
    this.host.apply(built.features, built.parts);
  }
}
