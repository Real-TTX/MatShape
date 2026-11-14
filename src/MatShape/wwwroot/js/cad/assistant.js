/* MatShape – the AI assistant of the editor: a panel at the right of the view. The person writes what they need ("a plate 80 × 40 × 6 with four holes of 6 mm"), the server asks the AI
   of the installation (POST /live/studios/{id}/ai with the Part Studio as it is), checks the answer and sends back the new content. The editor applies it as ONE step that can be undone,
   builds it, and when features of the answer do not build – or separate parts now interpenetrate – it sends that back for a repair (as often as the administrator allows).
   The person chooses the level of detail (rough, normal, fine; kept on this device). Everything shown is text (textContent). */

import { el, icon, request, t, toast } from './util.js';

export class Assistant {
  /**
   * host: { studioId(), content(), apply(content) -> before, statusOf(ids) -> [{id, name, message}], overlaps() -> [{a, b, aName, bName, volume}], undo(before) -> bool,
   *         fit(), busy(on) }
   */
  constructor(panel, host) {
    this.panel = panel;
    this.host = host;
    this.log = panel.querySelector('[data-ai-log]');
    this.input = panel.querySelector('[data-ai-input]');
    this.send = panel.querySelector('[data-ai-send]');
    this.running = false;
    this.send.addEventListener('click', () => this.submit());
    this.input.addEventListener('keydown', e => {
      e.stopPropagation();
      if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); this.submit(); }
    });
    // attachments: the paperclip, pasting a picture into the field, dropping files on the panel
    this.files = [];
    this.fileList = panel.querySelector('[data-ai-files]');
    this.picker = panel.querySelector('[data-ai-picker]');
    panel.querySelector('[data-ai-attach]')?.addEventListener('click', () => this.picker.click());
    this.picker?.addEventListener('change', () => { this.attach([...this.picker.files]); this.picker.value = ''; });
    this.input.addEventListener('paste', e => {
      const files = [...(e.clipboardData?.files || [])];
      if (files.length) { e.preventDefault(); this.attach(files); }
    });
    panel.addEventListener('dragover', e => { if (e.dataTransfer?.types?.includes('Files')) { e.preventDefault(); panel.classList.add('is-dropping'); } });
    panel.addEventListener('dragleave', e => { if (!panel.contains(e.relatedTarget)) panel.classList.remove('is-dropping'); });
    panel.addEventListener('drop', e => {
      panel.classList.remove('is-dropping');
      const files = [...(e.dataTransfer?.files || [])];
      if (files.length) { e.preventDefault(); this.attach(files); }
    });
    panel.querySelectorAll('[data-ai-example]').forEach(b => b.addEventListener('click', () => { this.input.value = b.textContent; this.input.focus(); }));
    // the level of detail, kept on this device
    this.detail = panel.querySelector('[data-ai-detail]');
    if (this.detail) {
      try { this.detail.value = localStorage.getItem('ms.ai.detail') || 'normal'; } catch { /* private mode */ }
      if (!this.detail.value) this.detail.value = 'normal';
      this.detail.addEventListener('change', () => { try { localStorage.setItem('ms.ai.detail', this.detail.value); } catch { /* private mode */ } });
    }
  }

  /** The overlaps that are new or grew since the start of a request (the person's own stay theirs). */
  newOverlaps(baseline) {
    return (this.host.overlaps?.() || []).filter(o => {
      const before = baseline.get(o.a + '|' + o.b);
      return before === undefined || o.volume > before * 1.5 + 0.01;
    });
  }

  open(on = this.panel.hidden) {
    this.panel.hidden = !on;
    document.getElementById('ms-studio')?.classList.toggle('is-ai', on);
    if (on) setTimeout(() => this.input.focus(), 30);
  }

  line(kind, text, extra) {
    const item = el('li', { class: 'ms-ai__msg ms-ai__msg--' + kind }, el('p', null, text), extra || null);
    this.log.append(item);
    this.log.querySelector('[data-ai-hello]')?.remove();
    item.scrollIntoView({ block: 'end', behavior: 'smooth' });
    return item;
  }

  thinking(text) {
    const item = el('li', { class: 'ms-ai__msg ms-ai__msg--busy' }, el('span', { class: 'mat-spinner', 'aria-hidden': 'true' }), el('p', null, text));
    this.log.append(item);
    item.scrollIntoView({ block: 'end' });
    return item;
  }

  /** Reads the files (pictures are scaled down here) and shows them as chips above the field. */
  async attach(list) {
    for (const file of list) {
      if (this.files.length >= MAX_FILES) { toast(t('Ai.Attach.TooMany', MAX_FILES), 'warning'); break; }
      try {
        this.files.push(await readAttachment(file));
      } catch (error) {
        toast(t(String(error?.message).startsWith('Ai.') ? error.message : 'Ai.Attach.Unreadable', file.name || ''), 'warning');
      }
    }
    this.renderFiles();
  }

  renderFiles() {
    if (!this.fileList) return;
    this.fileList.replaceChildren(...this.files.map((f, i) => {
      const remove = el('button', { type: 'button', class: 'ms-ai__file-x', 'aria-label': t('Ai.Attach.Remove', f.name), 'data-tip': t('Ai.Attach.Remove', f.name) }, icon('x'));
      remove.addEventListener('click', () => { if (f.preview) URL.revokeObjectURL(f.preview); this.files.splice(i, 1); this.renderFiles(); });
      return el('li', { class: 'ms-ai__file' }, this.thumb(f), el('span', { class: 'ms-ai__file-name' }, f.name), remove);
    }));
    this.fileList.hidden = !this.files.length;
  }

  thumb(f) {
    return f.preview ? el('img', { class: 'ms-ai__thumb', src: f.preview, alt: '' }) : el('span', { class: 'ms-ai__thumb ms-ai__thumb--file' }, icon('file-text'));
  }

  async submit() {
    const prompt = this.input.value.trim();
    if ((!prompt && !this.files.length) || this.running) return;
    const files = this.files;
    this.files = [];
    this.renderFiles();
    this.input.value = '';
    const shown = files.length ? el('ul', { class: 'ms-ai__sent' }, ...files.map(f => el('li', null, this.thumb(f), el('span', null, f.name)))) : null;
    this.line('user', prompt || t('Ai.Attach.DefaultPrompt'), shown);
    this.running = true;
    this.send.disabled = true;
    this.host.busy(true);
    try {
      await this.run(prompt, files.flatMap(f => f.parts));
    } finally {
      this.running = false;
      this.send.disabled = false;
      this.host.busy(false);
      this.input.focus();
    }
  }

  async run(prompt, attachments = []) {
    let before = null;
    let errors = null;
    let overlaps = null;
    let tokens = 0;
    let changed = [];
    let removed = [];
    const baseline = new Map((this.host.overlaps?.() || []).map(o => [o.a + '|' + o.b, o.volume]));
    const detail = this.detail?.value || 'normal';
    for (let round = 0; ; round++) {
      const busy = this.thinking(t(round ? 'Ai.Repairing' : 'Ai.Thinking'));
      let answer;
      try {
        answer = await request('POST', `/live/studios/${this.host.studioId()}/ai`, {
          prompt, content: this.host.content(), errors, overlaps, detail, language: document.documentElement.lang, attachments,
        });
      } catch (error) {
        busy.remove();
        const body = error.body || {};
        const settings = body.settingsUrl ? el('a', { class: 'ms-ai__link', href: body.settingsUrl }, icon('settings'), el('span', null, t('Ai.Settings'))) : null;
        this.line('error', body.error || t(error.status ? 'Ai.Failed' : 'Ai.Offline'), settings);
        return;
      }

      busy.remove();
      tokens += answer.tokens || 0;
      const applied = this.host.apply(answer.content);
      if (before === null) before = applied;
      removed = [...new Set([...removed, ...(answer.removed || [])])];
      changed = [...new Set([...changed, ...(answer.changed || [])])].filter(id => !removed.includes(id));
      const broken = this.host.statusOf(answer.changed || []);
      const overlapping = this.newOverlaps(baseline);
      if ((broken.length || overlapping.length) && round < (answer.repairRounds ?? 0)) {
        if (answer.message) this.line('ai', answer.message);
        errors = broken;
        overlaps = overlapping.map(o => ({ a: o.a, aName: o.aName, b: o.b, bName: o.bName, volume: Math.round(o.volume * 1000) / 1000 }));
        continue;
      }

      this.host.fit();
      const undo = changed.length || removed.length
        ? el('button', { type: 'button', class: 'mat-btn mat-btn--ghost mat-btn--sm' }, icon('undo'), el('span', null, t('Ai.Undo')))
        : null;
      const meta = el('div', { class: 'ms-ai__meta' },
        el('span', { class: 'mat-pill mat-pill--plain' }, t('Ai.Changed', changed.length)),
        removed.length ? el('span', { class: 'mat-pill mat-pill--plain' }, t('Ai.Removed', removed.length)) : null,
        el('span', { class: 'ms-ai__tokens mat-mono' }, t('Ai.Tokens', tokens.toLocaleString(document.documentElement.lang))),
        undo);
      const item = this.line('ai', answer.message || t('Ai.Done'), meta);
      if (broken.length) item.append(el('p', { class: 'ms-ai__warn' }, icon('alert'), ' ', t('Ai.StillBroken', broken.map(b => b.name || b.id).join(', '))));
      if (overlapping.length) item.append(el('p', { class: 'ms-ai__warn' }, icon('alert'), ' ', t('Ai.StillOverlapping', overlapping.map(o => o.aName + ' × ' + o.bName).join(', '))));
      undo?.addEventListener('click', () => {
        if (this.host.undo(before)) { undo.disabled = true; undo.querySelector('span').textContent = t('Ai.Undone'); }
        else toast(t('Ai.CannotUndo'), 'warning');
      });
      return;
    }
  }
}

// ---- attachments: pictures (to rebuild, or a logo as a template), SVG, PDF ---------------------------------------------------

const MAX_FILES = 4;
const MAX_SIDE = 1600;                       // larger pictures are scaled down in the browser: enough for a model, far fewer tokens
const PDF_LIMIT = 8 * 1024 * 1024;
const SVG_LIMIT = 256 * 1024;
const PICTURES = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'];

const base64Of = blob => new Promise((resolve, reject) => {
  const reader = new FileReader();
  reader.onload = () => resolve(String(reader.result).slice(String(reader.result).indexOf(',') + 1));
  reader.onerror = () => reject(reader.error);
  reader.readAsDataURL(blob);
});

const canvasBlob = (canvas, type, quality) => new Promise(resolve => canvas.toBlob(resolve, type, quality));

/** A picture as it is, or scaled to MAX_SIDE (photos as JPEG, the rest as PNG to keep sharp edges and transparency). */
async function picture(file) {
  const bitmap = await createImageBitmap(file);
  const scale = Math.min(1, MAX_SIDE / Math.max(bitmap.width, bitmap.height));
  if (scale === 1 && file.size <= 1.5 * 1024 * 1024) { bitmap.close?.(); return { type: file.type, blob: file }; }
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(bitmap.width * scale));
  canvas.height = Math.max(1, Math.round(bitmap.height * scale));
  canvas.getContext('2d').drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close?.();
  const photo = file.type === 'image/jpeg' || file.type === 'image/webp';
  const type = photo ? 'image/jpeg' : 'image/png';
  return { type, blob: await canvasBlob(canvas, type, 0.88) };
}

/** An SVG drawn into a PNG on white, so that models that only see pictures see it too. */
async function svgPicture(file) {
  const url = URL.createObjectURL(file);
  try {
    const img = new Image();
    await new Promise((resolve, reject) => { img.onload = resolve; img.onerror = reject; img.src = url; });
    const w = img.naturalWidth || 1024, h = img.naturalHeight || 1024;
    const scale = 1024 / Math.max(w, h);
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(w * scale);
    canvas.height = Math.round(h * scale);
    const g = canvas.getContext('2d');
    g.fillStyle = '#fff';
    g.fillRect(0, 0, canvas.width, canvas.height);
    g.drawImage(img, 0, 0, canvas.width, canvas.height);
    return await canvasBlob(canvas, 'image/png');
  } catch {
    return null;
  } finally {
    URL.revokeObjectURL(url);
  }
}

/** A file -> { name, preview, parts: [{ name, mediaType, data }] } or throws a text key. */
export async function readAttachment(file) {
  const name = file.name || 'clipboard.png';
  const type = file.type || (/\.svg$/i.test(name) ? 'image/svg+xml' : /\.pdf$/i.test(name) ? 'application/pdf' : '');
  if (type === 'image/svg+xml') {
    if (file.size > SVG_LIMIT) throw new Error('Ai.Attach.TooLarge');
    const parts = [{ name, mediaType: type, data: await base64Of(file) }];
    const png = await svgPicture(file);
    if (png) parts.push({ name: name.replace(/\.svg$/i, '') + '.png', mediaType: 'image/png', data: await base64Of(png) });
    return { name, preview: png ? URL.createObjectURL(png) : null, parts };
  }
  if (type === 'application/pdf') {
    if (file.size > PDF_LIMIT) throw new Error('Ai.Attach.TooLarge');
    return { name, preview: null, parts: [{ name, mediaType: type, data: await base64Of(file) }] };
  }
  if (!PICTURES.includes(type)) throw new Error('Ai.Attach.Type');
  const shrunk = await picture(file);
  return { name, preview: URL.createObjectURL(shrunk.blob), parts: [{ name, mediaType: shrunk.type, data: await base64Of(shrunk.blob) }] };
}
