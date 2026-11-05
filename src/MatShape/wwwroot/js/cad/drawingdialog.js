/* MatShape – the dialog "Drawing": a technical drawing of the visible parts (drawing.js does the work) with a preview of the sheet; the sheet size, the scale (or the
   largest standard scale that fits), the views (front, top, left, isometric), a section A–A (plane and place of the cut), hidden lines, the overall dimensions and the
   title; downloads as PDF (to print), SVG and DXF (for CAD and laser cutters). */

import { SCALES, drawingViews, layoutDrawing, toDxf, toPdf, toSvg } from './drawing.js';
import { debounce, download, fileName, fmt, t, toast } from './util.js';

export class DrawingDialog {
  /** host: { kernel(), parts() (the visible parts, with manifolds), name(), doc(), units(), unit(), person() } */
  constructor(dialog, host) {
    this.dialog = dialog;
    this.host = host;
    this.$ = s => dialog.querySelector(s);
    this.preview = this.$('[data-draw-preview]');
    this.views = [];
    const scale = this.$('[data-draw-scale]');
    for (const [a, b] of SCALES) scale.append(new Option(`${a} : ${b}`, `${a}:${b}`));
    dialog.addEventListener('keydown', e => e.stopPropagation());   // the keys of the editor stay out while the dialog is open
    // the views are worked out again when what is drawn changes; the sheet is laid out again when only its frame changes
    const views = debounce(() => this.compute(), 150), layout = debounce(() => this.layout(), 60);
    dialog.querySelectorAll('[data-draw-view], [data-draw-section], [data-draw-hidden], [data-draw-dims]').forEach(x => x.addEventListener('change', views));
    this.$('[data-draw-offset]').addEventListener('input', views);
    this.$('[data-draw-section]').addEventListener('change', () => { this.$('[data-draw-offset-field]').hidden = this.$('[data-draw-section]').value === 'none'; });
    dialog.querySelectorAll('[data-draw-sheet], [data-draw-scale]').forEach(x => x.addEventListener('change', layout));
    this.$('[data-draw-name]').addEventListener('input', layout);
    dialog.querySelectorAll('[data-draw-save]').forEach(b => b.addEventListener('click', () => this.save(b.dataset.drawSave)));
  }

  open() {
    this.$('[data-draw-name]').value = this.host.name();
    this.$('[data-draw-offset-field]').hidden = this.$('[data-draw-section]').value === 'none';
    if (!this.dialog.open) { if (window.MatUi?.dialog?.open) window.MatUi.dialog.open(this.dialog.id); else this.dialog.showModal(); }
    this.compute();
  }

  options() {
    const on = key => !!this.$(`[data-draw-view="${key}"]`)?.checked;
    const plane = this.$('[data-draw-section]').value;
    const offset = Number(String(this.$('[data-draw-offset]').value).replace(',', '.')) || 0;
    return {
      views: { front: on('front'), top: on('top'), left: on('left'), iso: on('iso') },
      section: plane === 'none' ? null : { plane, offset: offset * this.host.unit() },
      hidden: this.$('[data-draw-hidden]').checked,
      dims: this.$('[data-draw-dims]').checked,
      labels: { front: t('Drawing.View.front'), top: t('Drawing.View.top'), left: t('Drawing.View.left'), iso: t('Drawing.View.iso'), section: t('Drawing.View.section') },
    };
  }

  /** The views of the visible parts (the hidden lines take a moment for big models). */
  compute() {
    if (!this.dialog.open) return;
    const parts = this.host.parts();
    this.views = [];
    if (parts.length) {
      try { this.views = drawingViews(this.host.kernel(), parts, this.options()); } catch (e) { console.warn('MatShape: drawing failed', e); toast(t('Drawing.Failed'), 'danger'); }
    }
    this.layout();
  }

  layout() {
    const stats = this.$('[data-draw-stats]');
    const value = this.$('[data-draw-scale]').value;
    const sheet = this.$('[data-draw-sheet]').value;
    this.drawing = null;
    if (!this.views.length) {
      stats.textContent = t(this.host.parts().length ? 'Drawing.NoViews' : 'Drawing.Empty');
      this.show(null);
      return;
    }
    const unit = this.host.unit();
    this.drawing = layoutDrawing({
      sheet,
      scale: value === 'auto' ? 'auto' : value.split(':').map(Number),
      views: this.views,
      title: {
        name: this.$('[data-draw-name]').value.trim(),
        doc: this.host.doc(),
        date: new Date().toLocaleDateString(document.documentElement.lang || 'en'),
        units: this.host.units(),
        by: this.host.person(),
        labels: { title: t('Drawing.Block.Title'), document: t('Drawing.Block.Document'), scale: t('Drawing.Block.Scale'), date: t('Drawing.Block.Date'), units: t('Drawing.Block.Units'), sheet: t('Drawing.Block.Sheet'), by: t('Drawing.Block.By'), software: t('Drawing.Block.Software'), projection: t('Drawing.Block.Projection') },
      },
      format: v => fmt(v / unit, 2),
    });
    if (!this.drawing) { stats.textContent = t('Drawing.TooBig'); this.show(null); return; }
    this.show(toSvg(this.drawing));
    stats.textContent = t('Drawing.Stats', `${this.drawing.scale[0]} : ${this.drawing.scale[1]}`, sheet);
  }

  show(svg) {
    if (this.url) URL.revokeObjectURL(this.url);
    this.url = svg ? URL.createObjectURL(new Blob([svg], { type: 'image/svg+xml' })) : null;
    this.preview.hidden = !svg;
    if (svg) this.preview.src = this.url;
    else this.preview.removeAttribute('src');
    this.dialog.querySelectorAll('[data-draw-save]').forEach(b => { b.disabled = !svg; });
  }

  save(kind) {
    if (!this.drawing) return;
    const name = fileName(this.$('[data-draw-name]').value.trim() || this.host.name(), kind);
    if (kind === 'pdf') download(name, toPdf(this.drawing), 'application/pdf');
    else if (kind === 'svg') download(name, toSvg(this.drawing), 'image/svg+xml');
    else if (kind === 'dxf') download(name, toDxf(this.drawing), 'application/dxf');
  }
}
