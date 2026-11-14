/* MatShape – the dialog "AI 3D": one picture, up to four views of the same thing (the first is the front), or a text become a figure, in one of two ways.
   AI blocks: the request goes to the AI assistant of the installation (any provider), which writes a feature "figure" of building blocks (figure.js) – it can be
   changed in the chat afterwards. Meshy: the server starts the task
   at Meshy (/live/studios/{id}/ai/mesh), the dialog asks for its state every few seconds – also while it is closed, and after a reload (the run is kept per model in
   localStorage) – then fetches the mesh through the server, makes a solid of it (meshgen.js) and shows the picture Meshy made of it. Height, turn and "rebuild" work on
   the fetched mesh without a new generation; "Apply" adds it to the open Part Studio as one step (a feature "import" and its part). */

import { meshFeature, readMesh, toSolid } from './meshgen.js';
import { el, fmt, icon, request, t, toast, uid } from './util.js';

const MAX_PICTURES = 4;
const MAX_SIDE = 1600;
const POLL_MS = 4000;
const PICTURES = ['image/png', 'image/jpeg', 'image/webp', 'image/gif', 'image/svg+xml'];

const base64Of = blob => new Promise((resolve, reject) => {
  const reader = new FileReader();
  reader.onload = () => resolve(String(reader.result).slice(String(reader.result).indexOf(',') + 1));
  reader.onerror = () => reject(reader.error);
  reader.readAsDataURL(blob);
});

/** A picture as Meshy takes it (PNG or JPEG, at most MAX_SIDE): photos as JPEG, the rest (logos, drawings, SVG, GIF) as PNG on white where it is transparent. */
async function meshPicture(file) {
  const type = file.type || (/\.svg$/i.test(file.name) ? 'image/svg+xml' : '');
  if (!PICTURES.includes(type)) throw new Error('Studio.Mesh.NotAPicture');
  const url = URL.createObjectURL(file);
  try {
    const img = new Image();
    await new Promise((resolve, reject) => { img.onload = resolve; img.onerror = reject; img.src = url; });
    const w = img.naturalWidth || 1024, h = img.naturalHeight || 1024;
    if (Math.min(w, h) < 32) throw new Error('Studio.Mesh.TooSmall');
    const scale = Math.min(1, MAX_SIDE / Math.max(w, h)) * (type === 'image/svg+xml' && Math.max(w, h) < 1024 ? 1024 / Math.max(w, h) : 1);
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(32, Math.round(w * scale));
    canvas.height = Math.max(32, Math.round(h * scale));
    const g = canvas.getContext('2d');
    const photo = type === 'image/jpeg' || type === 'image/webp';
    if (!photo) { g.fillStyle = '#ffffff'; g.fillRect(0, 0, canvas.width, canvas.height); }
    g.drawImage(img, 0, 0, canvas.width, canvas.height);
    const out = photo ? 'image/jpeg' : 'image/png';
    const blob = await new Promise(resolve => canvas.toBlob(resolve, out, 0.9));
    if (!blob) throw new Error('Studio.Mesh.Unreadable');
    return { name: file.name || 'picture.png', mediaType: out, blob, data: await base64Of(blob), preview: URL.createObjectURL(blob) };
  } catch (e) {
    throw e instanceof Error && e.message.startsWith('Studio.') ? e : new Error('Studio.Mesh.Unreadable');
  } finally {
    URL.revokeObjectURL(url);
  }
}

export class MeshDialog {
  /**
   * host: { modelId, studioId(), kernel(), units(), unit(), occupied() -> { min, max } of the parts there or null, apply({ feature, name, color }) -> bool,
   * ready(on) (the tool button shows a finished result) }
   */
  constructor(dialog, host) {
    this.dialog = dialog;
    this.host = host;
    this.$ = s => dialog.querySelector(s);
    this.mode = 'image';
    this.pictures = [];
    this.job = null;        // { run, name } while a generation runs or waits to be applied
    this.mesh = null;       // the fetched mesh { positions, indices } (as Meshy made it)
    this.solid = null;      // the solid made of it with the current settings
    this.timer = 0;
    this.storeKey = 'ms.mesh.' + host.modelId;
    this.hasMeshy = dialog.dataset.hasMeshy === '1';
    this.hasAi = dialog.dataset.hasAi === '1';
    dialog.querySelectorAll('[data-mesh-method]').forEach(b => b.addEventListener('click', () => this.setMethod(b.dataset.meshMethod, true)));

    dialog.querySelectorAll('[data-mesh-mode]').forEach(b => b.addEventListener('click', () => this.setMode(b.dataset.meshMode)));
    this.fileInput = this.$('[data-mesh-file]');
    this.$('[data-mesh-pick]').addEventListener('click', () => this.fileInput.click());
    this.fileInput.addEventListener('change', () => { this.add([...this.fileInput.files]); this.fileInput.value = ''; });
    dialog.addEventListener('dragover', e => { if (e.dataTransfer?.types?.includes('Files') && this.state() === 'ask') { e.preventDefault(); dialog.classList.add('is-dropping'); } });
    dialog.addEventListener('dragleave', e => { if (!dialog.contains(e.relatedTarget)) dialog.classList.remove('is-dropping'); });
    dialog.addEventListener('drop', e => {
      dialog.classList.remove('is-dropping');
      const files = [...(e.dataTransfer?.files || [])];
      if (files.length && this.state() === 'ask') { e.preventDefault(); this.setMode('image'); this.add(files); }
    });
    dialog.addEventListener('paste', e => {
      if (e.target.closest?.('textarea, input')) return;
      const files = [...(e.clipboardData?.files || [])];
      if (files.length && this.state() === 'ask') { e.preventDefault(); this.setMode('image'); this.add(files); }
    });
    dialog.addEventListener('keydown', e => e.stopPropagation());   // the keys of the editor stay out while the dialog is open
    this.prompt = this.$('[data-mesh-prompt]');
    this.prompt.addEventListener('input', () => this.update());
    dialog.querySelectorAll('[data-mesh-example]').forEach(b => b.addEventListener('click', () => { this.prompt.value = b.textContent.trim(); this.update(); this.prompt.focus(); }));
    this.$('[data-mesh-start]').addEventListener('click', () => this.start());
    this.$('[data-mesh-cancel]').addEventListener('click', () => this.cancel());
    this.$('[data-mesh-again]').addEventListener('click', () => this.reset(true));
    this.$('[data-mesh-apply]').addEventListener('click', () => this.apply());
    for (const sel of ['[data-mesh-height]', '[data-mesh-turn]', '[data-mesh-rebuild]']) {
      this.$(sel).addEventListener('change', () => { if (this.mesh) this.solidify(); });
    }
    this.showUnits();
    let method = null;
    try { method = localStorage.getItem('ms.mesh.method'); } catch { /* private mode */ }
    this.setMethod(method);
  }

  /** blocks (the AI of the installation) or meshy; what is not available falls back to the other. Free blocks first when both are there. */
  setMethod(method, remember = false) {
    const wanted = method === 'meshy' || method === 'blocks' ? method : this.hasAi ? 'blocks' : 'meshy';
    this.method = wanted === 'meshy' ? (this.hasMeshy ? 'meshy' : 'blocks') : (this.hasAi ? 'blocks' : 'meshy');
    this.dialog.querySelectorAll('[data-mesh-method]').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.meshMethod === this.method)));
    this.dialog.querySelectorAll('[data-mesh-hint]').forEach(h => { h.hidden = h.dataset.meshHint !== this.method; });
    this.dialog.querySelectorAll('[data-meshy-only]').forEach(n => { n.hidden = this.method !== 'meshy'; });
    if (remember) { try { localStorage.setItem('ms.mesh.method', this.method); } catch { /* private mode */ } }
    this.update();
  }

  // ---- opening, resuming --------------------------------------------------------------------------------------------------------

  open(file) {
    if (!this.dialog.open) { if (window.MatUi?.dialog?.open) window.MatUi.dialog.open(this.dialog.id); else this.dialog.showModal(); }
    this.showUnits();
    this.host.ready?.(false);
    if (file && this.state() === 'ask') { this.setMode('image'); this.add([file]); }
    this.update();
  }

  close() { if (this.dialog.open) this.dialog.close(); }

  /** After the model was loaded: a generation of this person that was running (or done and not yet applied) when the page was left goes on. */
  resume() {
    let saved = null;
    try { saved = JSON.parse(localStorage.getItem(this.storeKey) || 'null'); } catch { /* none */ }
    if (!saved?.run || this.job) return;
    // a result is kept at Meshy for three days; older ones are gone
    if (Date.now() - (saved.at || 0) > 3 * 24 * 3600 * 1000) { this.forget(); return; }
    this.job = { run: saved.run, name: saved.name };
    if (saved.name) this.$('[data-mesh-name]').value = saved.name;
    this.show('busy');
    this.poll();
  }

  remember() {
    try { localStorage.setItem(this.storeKey, JSON.stringify({ run: this.job.run, name: this.job.name, at: Date.now() })); } catch { /* storage full or off */ }
  }

  forget() {
    try { localStorage.removeItem(this.storeKey); } catch { /* storage off */ }
  }

  showUnits() {
    const units = this.host.units?.() || 'mm';
    this.$('[data-mesh-unit]').textContent = '(' + units + ')';
    const height = this.$('[data-mesh-height]');
    if (!height.dataset.touched) {
      height.value = String(Math.round(50 / (this.host.unit?.() || 1) * 100) / 100);
      height.addEventListener('input', () => { height.dataset.touched = '1'; }, { once: true });
    }
  }

  // ---- the request --------------------------------------------------------------------------------------------------------------

  setMode(mode) {
    this.mode = mode === 'text' ? 'text' : 'image';
    this.dialog.querySelectorAll('[data-mesh-mode]').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.meshMode === this.mode)));
    this.dialog.querySelectorAll('[data-mesh-pane]').forEach(p => { p.hidden = p.dataset.meshPane !== this.mode; });
    this.update();
  }

  async add(files) {
    for (const file of files) {
      if (this.pictures.length >= MAX_PICTURES) { toast(t('Studio.Mesh.Max', MAX_PICTURES), 'warning'); break; }
      try {
        this.pictures.push(await meshPicture(file));
      } catch (e) {
        toast(t(e.message), 'warning');
      }
    }
    if (!this.$('[data-mesh-name]').value && this.pictures[0]) this.$('[data-mesh-name]').value = this.pictures[0].name.replace(/\.[^.]+$/, '').slice(0, 80);
    this.renderPictures();
    this.update();
  }

  renderPictures() {
    const list = this.$('[data-mesh-pics]');
    list.hidden = !this.pictures.length;
    list.replaceChildren(...this.pictures.map((p, i) => {
      const remove = el('button', { type: 'button', class: 'mat-btn mat-btn--ghost mat-btn--icon mat-btn--sm ms-meshdlg__remove', 'aria-label': t('Studio.Mesh.Remove', p.name) }, icon('x'));
      remove.addEventListener('click', () => { URL.revokeObjectURL(p.preview); this.pictures.splice(i, 1); this.renderPictures(); this.update(); });
      return el('li', { class: 'ms-meshdlg__pic' },
        el('img', { src: p.preview, alt: p.name }),
        el('span', { class: 'ms-meshdlg__picname' }, i === 0 && this.pictures.length > 1 ? t('Studio.Mesh.Front') : p.name),
        remove);
    }));
    this.$('[data-mesh-drop]').classList.toggle('is-small', this.pictures.length > 0);
  }

  update() {
    const ready = this.mode === 'text' ? this.prompt.value.trim().length > 0 : this.pictures.length > 0;
    this.$('[data-mesh-start]').disabled = !ready || this.state() !== 'ask';
  }

  state() { return this.dialog.dataset.meshPhase || 'ask'; }

  /** ask: the request; busy: waiting for Meshy (or making the solid); ready: a result to apply. */
  show(state) {
    this.dialog.dataset.meshPhase = state;
    this.$('[data-mesh-ask]').hidden = state !== 'ask';
    this.$('[data-mesh-work]').hidden = state === 'ask';
    this.$('[data-mesh-start]').hidden = state !== 'ask';
    this.$('[data-mesh-cancel]').hidden = state !== 'busy';
    this.$('[data-mesh-apply]').hidden = state !== 'ready';
    this.$('[data-mesh-again]').hidden = state !== 'ready';
    if (state !== 'ready') { this.$('[data-mesh-thumb]').hidden = true; this.$('[data-mesh-wait]').hidden = false; }
    this.$('[data-mesh-bar]').hidden = state === 'ready';
    this.update();
  }

  progress(percent, text) {
    const p = Math.max(0, Math.min(100, Math.round(percent)));
    this.$('[data-mesh-fill]').style.width = p + '%';
    this.$('[data-mesh-bar]').setAttribute('aria-valuenow', String(p));
    this.$('[data-mesh-state]').textContent = text;
  }

  async start() {
    if (this.state() !== 'ask') return;
    if (this.method === 'blocks') { await this.toAssistant(); return; }
    const name = (this.$('[data-mesh-name]').value || '').trim() || (this.mode === 'text' ? this.prompt.value.trim().split(/\s+/).slice(0, 4).join(' ') : '') || t('Studio.Mesh.DefaultName');
    const body = this.mode === 'text'
      ? { kind: 'text', prompt: this.prompt.value.trim() }
      : { kind: 'image', images: this.pictures.map(p => ({ mediaType: p.mediaType, data: p.data })) };
    this.show('busy');
    this.progress(0, t('Studio.Mesh.Sending'));
    try {
      const answer = await request('POST', `/live/studios/${this.host.studioId()}/ai/mesh`, body);
      this.job = { run: answer.run, name };
      this.$('[data-mesh-name]').value = name;
      this.remember();
      this.progress(1, t('Studio.Mesh.Queued'));
      this.timer = setTimeout(() => this.poll(), POLL_MS);
    } catch (e) {
      this.show('ask');
      const message = e.body?.error || t(e.status === 404 ? 'Studio.Gone.Text' : 'Studio.Mesh.Failed');
      this.$('[data-mesh-state]').textContent = message;
      toast(message, 'danger');
    }
  }

  /** The way of the AI blocks: the request (and the pictures) go to the assistant, which builds a figure feature; the chat shows it and takes changes. */
  async toAssistant() {
    if (!this.host.toAssistant) return;
    const units = this.host.units?.() || 'mm';
    const height = String(this.$('[data-mesh-height]').value || '50').replace(',', '.') + ' ' + units;
    const files = this.mode === 'image'
      ? this.pictures.map(p => new File([p.blob], p.name.replace(/.[^.]+$/, '') + (p.mediaType === 'image/png' ? '.png' : '.jpg'), { type: p.mediaType }))
      : [];
    const prompt = this.mode === 'text' ? t('Studio.Mesh.FigureFromText', this.prompt.value.trim(), height) : t('Studio.Mesh.FigureFromPicture', '', height).trim();
    this.reset(false);
    this.close();
    await this.host.toAssistant({ prompt, files });
  }

  // ---- waiting ------------------------------------------------------------------------------------------------------------------

  async poll() {
    clearTimeout(this.timer);
    if (!this.job) return;
    let state;
    try {
      state = await request('GET', `/live/ai/mesh/${this.job.run}`);
    } catch (e) {
      if (e.status === 404) { this.fail(t('Studio.Mesh.Gone')); return; }
      // offline or the server restarting: ask again a little later
      this.timer = setTimeout(() => this.poll(), POLL_MS * 2);
      return;
    }
    if (state.status === 'done') { await this.fetch(state.thumbnail); return; }
    if (state.status === 'failed' || state.status === 'cancelled') { this.fail(state.error || t('Studio.Mesh.Failed')); return; }
    this.show('busy');
    this.progress(Math.max(1, state.progress * 0.9), state.status === 'pending' ? t('Studio.Mesh.Queued') : t('Studio.Mesh.Running', state.progress));
    this.timer = setTimeout(() => this.poll(), POLL_MS);
  }

  fail(message) {
    this.job = null;
    this.forget();
    this.show('ask');
    this.$('[data-mesh-state]').textContent = message;
    toast(message, 'danger');
  }

  async cancel() {
    if (!this.job) { this.show('ask'); return; }
    clearTimeout(this.timer);
    const run = this.job.run;
    this.job = null;
    this.forget();
    this.show('ask');
    try { await request('DELETE', `/live/ai/mesh/${run}`); } catch { /* it ends at Meshy by itself */ }
    toast(t('Studio.Mesh.Stopped'), 'info');
  }

  /** The finished mesh through the server (the GLB; an STL when the GLB is compressed), then the solid. */
  async fetch(thumbnail) {
    this.show('busy');
    this.progress(92, t('Studio.Mesh.Fetching'));
    const get = async what => {
      const response = await fetch(`/live/ai/mesh/${this.job.run}/${what}`, { credentials: 'same-origin', cache: 'no-store' });
      if (!response.ok) throw Object.assign(new Error('HTTP ' + response.status), { status: response.status });
      return { bytes: new Uint8Array(await response.arrayBuffer()), format: response.headers.get('X-Mesh-Format') || (what === 'stl' ? 'stl' : 'glb') };
    };
    try {
      let file = await get('model');
      try {
        this.mesh = readMesh(file.bytes, file.format);
      } catch (e) {
        if (file.format !== 'glb') throw e;
        file = await get('stl');
        this.mesh = readMesh(file.bytes, 'stl');
      }
    } catch (e) {
      console.warn('MatShape: the generated mesh could not be read', e);
      this.fail(t(e.status === 404 ? 'Studio.Mesh.Gone' : 'Studio.Mesh.Unreadable'));
      return;
    }
    const thumb = this.$('[data-mesh-thumb]');
    if (thumbnail) {
      thumb.onload = () => { thumb.hidden = false; this.$('[data-mesh-wait]').hidden = true; };
      thumb.src = `/live/ai/mesh/${this.job.run}/thumbnail`;
    }
    if (await this.solidify() && !this.dialog.open) {
      this.host.ready?.(true);
      toast(t('Studio.Mesh.Ready', this.job.name), 'success');
    }
  }

  /** The solid of the fetched mesh with the height, turn and rebuild of the dialog (again when one of them changes). */
  async solidify() {
    const kernel = this.host.kernel();
    if (!kernel || !this.mesh) return false;
    const wasReady = this.state() === 'ready';
    this.show('busy');
    this.$('[data-mesh-cancel]').hidden = true;
    this.progress(96, t('Studio.Mesh.Making'));
    // let the page paint the state before the work
    await new Promise(resolve => setTimeout(resolve, 30));
    const height = Number(String(this.$('[data-mesh-height]').value).replace(',', '.')) * (this.host.unit?.() || 1);
    try {
      this.solid = toSolid(kernel, this.mesh, {
        height: height > 0 ? height : 50,
        yaw: Number(this.$('[data-mesh-turn]').value) || 0,
        rebuild: this.$('[data-mesh-rebuild]').checked,
      });
    } catch (e) {
      console.warn('MatShape: no solid of the generated mesh', e);
      this.solid = null;
      if (wasReady) { toast(t('Studio.Mesh.NoSolid'), 'warning'); }
      else { this.fail(t('Studio.Mesh.NoSolid')); return false; }
    }
    this.show('ready');
    if (this.$('[data-mesh-thumb]').src && this.$('[data-mesh-thumb]').complete && this.$('[data-mesh-thumb]').naturalWidth) {
      this.$('[data-mesh-thumb]').hidden = false;
      this.$('[data-mesh-wait]').hidden = true;
    }
    this.$('[data-mesh-apply]').disabled = !this.solid;
    if (this.solid) {
      const u = this.host.unit?.() || 1, units = this.host.units?.() || 'mm';
      const [x, y, z] = this.solid.size.map(v => fmt(v / u, 1));
      this.$('[data-mesh-state]').textContent = t(this.solid.rebuilt ? 'Studio.Mesh.StatsRebuilt' : 'Studio.Mesh.Stats', this.solid.triangles.toLocaleString(document.documentElement.lang), `${x} × ${y} × ${z} ${units}`);
    }
    return !!this.solid;
  }

  // ---- the result ---------------------------------------------------------------------------------------------------------------

  apply() {
    if (!this.solid || !this.job) return;
    const name = (this.$('[data-mesh-name]').value || '').trim() || this.job.name || t('Studio.Mesh.DefaultName');
    // next to the parts that are there already (on the right, with a gap), not into them
    const box = this.host.occupied?.();
    let dx = 0;
    if (box) {
      let minX = Infinity;
      for (let i = 0; i < this.solid.positions.length; i += 3) minX = Math.min(minX, this.solid.positions[i]);
      dx = box.max[0] + Math.max(5, 0.15 * this.solid.size[0]) - minX;
    }
    const feature = meshFeature({ id: uid('f'), name, file: 'meshy.glb', positions: this.solid.positions, indices: this.solid.indices, rebuilt: this.solid.rebuilt, dx });
    if (!this.host.apply({ feature, name, color: this.$('[data-mesh-color]').value })) return;
    toast(t('Studio.Mesh.Added', name), 'success');
    this.reset(false);
    this.close();
  }

  /** Back to the request: again = keep the pictures and the text for another try. */
  reset(again) {
    clearTimeout(this.timer);
    this.job = null;
    this.mesh = null;
    this.solid = null;
    this.forget();
    this.host.ready?.(false);
    const thumb = this.$('[data-mesh-thumb]');
    thumb.removeAttribute('src');
    if (!again) {
      this.pictures.forEach(p => URL.revokeObjectURL(p.preview));
      this.pictures = [];
      this.prompt.value = '';
      this.$('[data-mesh-name]').value = '';
      this.renderPictures();
    }
    this.$('[data-mesh-state]').textContent = '';
    this.show('ask');
  }
}
