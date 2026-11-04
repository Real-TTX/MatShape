/* MatShape – the editor of a document. It loads the document (/live/documents/{id}), runs the features of the open Part Studio (model.js), shows the result
   (viewport.js), and lets the person change the history: new features through their dialogs (dialogs.js), sketches (sketcher.js), rename, suppress, roll back, delete.
   Every change is saved by itself a moment later, with the revision it started from: when somebody else saved in between, nothing is overwritten unasked.
   Without a network the changes wait on this device (localStorage) and are sent when the network is back. */

import { Viewport } from './viewport.js';
import { loadKernel, regenerate, dispose, FEATURES, properties } from './model.js';
import { buildDialog } from './dialogs.js';
import { Sketcher } from './sketcher.js';
import { toObj, toStl } from './export.js';
import { STANDARD_PLANES, frameFromNormal, v3 } from './geom.js';
import { clone, debounce, download, el, fileName, fmt, icon, length, request, swatch, t, toast, uid, UNITS } from './util.js';

const root = document.getElementById('ms-studio');
if (root) start();

function start() {
  const $ = sel => root.querySelector(sel);
  const docId = root.dataset.document;
  const linkToken = root.dataset.token || '';
  const versionId = root.dataset.version || '';
  const signedIn = root.dataset.signedIn === 'true';
  const query = () => (linkToken ? '?t=' + encodeURIComponent(linkToken) : '');

  const ui = {
    tools: $('[data-toolbar="features"]'),
    sketchTools: $('[data-toolbar="sketch"]'),
    tree: $('[data-feature-list]'),
    featureCount: $('[data-feature-count]'),
    parts: $('[data-part-list]'),
    partCount: $('[data-part-count]'),
    tabs: $('[data-studio-tabs]'),
    status: $('[data-status]'),
    save: $('[data-save-state]'),
    dialog: $('[data-dialog]'),
    dialogTitle: $('[data-dialog-title]'),
    dialogIcon: $('[data-dialog-icon]'),
    dialogForm: $('[data-dialog-form]'),
    dialogError: $('[data-dialog-error]'),
    sketchPanel: $('[data-sketch-panel]'),
    hud: $('[data-hud]'),
    measure: $('[data-measure-out]'),
    empty: $('[data-empty]'),
    loading: $('[data-loading]'),
    failure: $('[data-failure]'),
    offline: $('[data-offline]'),
    side: $('#ms-side'),
    versionName: $('[data-version-name]'),
  };

  const state = {
    doc: null,
    studio: null,
    content: null,
    result: null,
    kernel: null,
    hidden: new Set(),
    selection: new Set(),
    undo: [],
    redo: [],
    mode: 'idle',
    dialog: null,
    display: 'shaded',
    planes: true,
    measure: [],
    saving: false,
    dirty: false,
    offline: !navigator.onLine,
  };
  const canEdit = () => !!state.doc?.canEdit;
  const unit = () => UNITS[state.doc?.units] || 1;

  const viewport = new Viewport($('[data-canvas]'), $('[data-triad]'));
  const sketcher = new Sketcher(viewport, { root: ui.sketchPanel, title: $('[data-sketch-title]'), body: $('[data-sketch-body]') }, ui.sketchTools, {
    status: text => setStatus(text),
    hud: text => showHud(text),
  });

  // ---- loading -------------------------------------------------------------------------------------------------------------

  async function load() {
    ui.loading.hidden = false;
    ui.failure.hidden = true;
    try {
      const [kernel, doc] = await Promise.all([
        loadKernel(),
        request('GET', `/live/documents/${docId}${query()}${versionId ? (linkToken ? '&' : '?') + 'v=' + encodeURIComponent(versionId) : ''}`),
      ]);
      state.kernel = kernel;
      state.doc = doc;
      document.title = `${doc.name} · MatShape`;
      if (doc.versionName && ui.versionName) ui.versionName.textContent = t('Studio.VersionNamed', doc.versionName);
      if (!canEdit()) root.classList.add('is-readonly');
      renderTabs();
      const wanted = Number(location.hash.replace('#studio-', '')) || null;
      const studio = doc.studios.find(s => s.id === wanted) || doc.studios[0];
      await openStudio(studio.id);
      ui.loading.hidden = true;
      viewport.fit(false);
      // the picture of the list shows the model as it is now (it may have been made by an older build, or never)
      if (!versionId) scheduleThumbnail();
    } catch (error) {
      ui.loading.hidden = true;
      ui.failure.hidden = false;
      const gone = error.status === 404 || error.status === 401;
      $('[data-failure-title]').textContent = t(gone ? 'Studio.Gone.Title' : 'Studio.Fail.Title');
      $('[data-failure-text]').textContent = t(gone ? 'Studio.Gone.Text' : 'Studio.Fail.Text');
      console.warn('MatShape: loading failed', error);
    }
  }

  async function openStudio(id) {
    if (state.studio && state.studio.id !== id) {
      closeModes();
      await flushSave();
    }
    const studio = state.doc.studios.find(s => s.id === id);
    if (!studio) return;
    state.studio = studio;
    state.content = normalize(clone(studio.content));
    state.undo = [];
    state.redo = [];
    state.selection.clear();
    state.hidden = new Set(readLocal('hidden.' + id) || []);
    if (!versionId) history.replaceState(null, '', '#studio-' + id);
    // changes that waited on this device for this Part Studio
    const pending = readLocal('pending.' + id);
    if (pending && canEdit()) {
      if (pending.revision === studio.revision) {
        state.content = normalize(pending.content);
        state.dirty = true;
        scheduleSave();
      } else {
        writeLocal('pending.' + id, null);
        toast(t('Save.PendingDropped'), 'warning');
      }
    }
    renderTabs();
    regen();
    updateUndo();
  }

  function normalize(content) {
    const c = content && typeof content === 'object' ? content : {};
    c.features = Array.isArray(c.features) ? c.features : [];
    c.parts = c.parts && typeof c.parts === 'object' ? c.parts : {};
    if (!Number.isInteger(c.rollback) || c.rollback >= c.features.length || c.rollback < 0) c.rollback = null;
    return c;
  }

  // ---- regeneration --------------------------------------------------------------------------------------------------------

  function regen(content = state.content, options = {}) {
    if (!state.kernel) return;
    const started = performance.now();
    const hadParts = state.result?.parts.length > 0;
    const next = regenerate(state.kernel, content, state.doc.units);
    dispose(state.result);
    state.result = next;
    for (const id of [...state.selection]) if (!next.parts.some(p => p.id === id)) state.selection.delete(id);
    viewport.setParts(next.parts, state.hidden);
    viewport.setSelection(state.selection);
    const editing = state.mode === 'sketch' ? state.dialog?.feature.id : null;
    viewport.setSketches(next.sketches.filter(s => s.fid !== editing && sketchVisible(s, content)));
    viewport.setPlanes(next.planes, state.planes);
    if (!options.keepTree) renderTree(content);
    renderParts();
    const empty = !content.features.length;
    ui.empty.hidden = !empty || state.mode !== 'idle';
    if (empty) {
      $('[data-empty-title]').textContent = t(canEdit() ? 'Studio.Empty.Title' : 'Studio.Empty.ViewTitle');
      $('[data-empty-text]').textContent = t(canEdit() ? 'Studio.Empty.Text' : 'Studio.Empty.ViewText');
    }
    setStatus(t('Studio.Regenerated', fmt(performance.now() - started, 0)));
    // the first part of a Part Studio: show it whole
    if (!hadParts && next.parts.length && state.mode !== 'sketch') setTimeout(() => viewport.fit(true), 320);
  }

  function sketchVisible(s, content) {
    const f = content.features.find(x => x.id === s.fid);
    if (!f) return false;
    if (f.view === 'hide') return false;
    if (f.view === 'show') return true;
    return !s.used;
  }

  // ---- changes and history -------------------------------------------------------------------------------------------------

  /** Takes a change of the content: into the history, saved later, the model made again. */
  function commit(before) {
    state.undo.push(before);
    if (state.undo.length > 200) state.undo.shift();
    state.redo = [];
    state.dirty = true;
    regen();
    updateUndo();
    scheduleSave();
  }

  function change(fn) {
    if (!canEdit()) return;
    const before = JSON.stringify(state.content);
    fn(state.content);
    if (JSON.stringify(state.content) !== before) commit(before);
  }

  function undo() {
    if (state.mode === 'sketch') { sketcher.undo(); return; }
    if (state.mode !== 'idle' || !state.undo.length) return;
    state.redo.push(JSON.stringify(state.content));
    state.content = normalize(JSON.parse(state.undo.pop()));
    state.dirty = true;
    regen();
    updateUndo();
    scheduleSave();
  }

  function redo() {
    if (state.mode === 'sketch') { sketcher.redo(); return; }
    if (state.mode !== 'idle' || !state.redo.length) return;
    state.undo.push(JSON.stringify(state.content));
    state.content = normalize(JSON.parse(state.redo.pop()));
    state.dirty = true;
    regen();
    updateUndo();
    scheduleSave();
  }

  function updateUndo() {
    const u = root.querySelector('[data-action="undo"]'), r = root.querySelector('[data-action="redo"]');
    if (u) u.disabled = !state.undo.length || state.mode !== 'idle';
    if (r) r.disabled = !state.redo.length || state.mode !== 'idle';
  }

  // ---- saving --------------------------------------------------------------------------------------------------------------

  const scheduleSave = debounce(() => save(), 700);

  async function save() {
    if (!canEdit() || !state.dirty || state.saving) return;
    const studio = state.studio;
    const content = JSON.parse(JSON.stringify(state.content));
    writeLocal('pending.' + studio.id, { revision: studio.revision, content });
    if (!navigator.onLine) { setSave('offline'); setOffline(true); return; }
    state.saving = true;
    state.dirty = false;
    setSave('saving');
    try {
      const answer = await request('PUT', `/live/studios/${studio.id}`, { revision: studio.revision, content });
      studio.revision = answer.revision;
      studio.content = content;
      if (!state.dirty) writeLocal('pending.' + studio.id, null);
      setSave('saved');
      setOffline(false);
      scheduleThumbnail();
    } catch (error) {
      if (error.status === 409 && error.body) {
        await conflict(studio, error.body, content);
      } else if (error.status === 404 || error.status === 401) {
        setSave('error');
        writeLocal('pending.' + studio.id, null);
        toast(t('Save.NoRight'), 'danger');
      } else if (error.status === 422) {
        setSave('error');
        toast(t('Save.Invalid'), 'danger');
      } else {
        state.dirty = true;
        setSave('offline');
        setOffline(true);
      }
    } finally {
      state.saving = false;
      if (state.dirty && navigator.onLine && !state.offline) scheduleSave();
    }
  }

  async function flushSave() {
    scheduleSave.cancel();
    if (state.dirty) await save();
  }

  async function conflict(studio, server, mine) {
    setSave('conflict');
    const keepMine = await window.MatUi.confirm(t('Save.Conflict.Text'), { title: t('Save.Conflict.Title'), ok: t('Save.Conflict.Keep'), cancel: t('Save.Conflict.Load') });
    studio.revision = server.revision;
    if (keepMine) {
      state.dirty = true;
      scheduleSave.flush();
    } else {
      studio.content = server.content;
      writeLocal('pending.' + studio.id, null);
      if (state.studio === studio) {
        closeModes();
        state.content = normalize(clone(server.content));
        state.undo = [];
        state.redo = [];
        regen();
        updateUndo();
      }
      setSave('saved');
    }
  }

  function setSave(stateName) {
    ui.save.textContent = stateName ? t('Save.' + stateName) : '';
    ui.save.dataset.state = stateName || '';
  }

  function setOffline(on) {
    state.offline = on;
    ui.offline.hidden = !on;
    root.classList.toggle('is-offline', on);
  }

  const scheduleThumbnail = debounce(async () => {
    if (!canEdit() || state.mode !== 'idle' || !state.result?.parts.length) return;
    try {
      const png = await viewport.snapshot(320, 240);
      if (png) await request('PUT', `/live/documents/${docId}/thumbnail`, png);
    } catch { /* the picture is a nicety */ }
  }, 4000);

  // somebody else may work on the same Part Studio: look now and then
  async function poll() {
    if (document.hidden || !state.studio || state.dirty || state.saving || state.mode !== 'idle' || versionId || state.studio.id < 0) return;
    try {
      const info = await request('GET', `/live/studios/${state.studio.id}/revision${query()}`);
      setOffline(false);
      if (info.revision > state.studio.revision) {
        const doc = await request('GET', `/live/documents/${docId}${query()}`);
        const fresh = doc.studios.find(s => s.id === state.studio.id);
        if (!fresh || state.dirty || state.mode !== 'idle') return;
        state.studio.revision = fresh.revision;
        state.studio.content = fresh.content;
        state.content = normalize(clone(fresh.content));
        regen();
        toast(info.by ? t('Studio.UpdatedBy', info.by) : t('Studio.Updated'), 'info');
      }
    } catch (error) {
      if (!error.status) setOffline(true);
    }
  }
  setInterval(poll, 8000);
  window.addEventListener('online', () => { setOffline(false); if (state.dirty) scheduleSave.flush(); poll(); });
  window.addEventListener('offline', () => setOffline(true));
  if (!navigator.onLine) setOffline(true);
  document.addEventListener('visibilitychange', () => { if (document.hidden) flushSave(); else poll(); });
  window.addEventListener('pagehide', () => { if (state.dirty) writeLocal('pending.' + state.studio.id, { revision: state.studio.revision, content: state.content }); });
  ui.offline.addEventListener('click', () => { if (state.dirty) scheduleSave.flush(); else poll(); });

  function readLocal(key) { try { return JSON.parse(localStorage.getItem('ms.' + key) || 'null'); } catch { return null; } }

  function writeLocal(key, value) {
    try {
      if (value === null) localStorage.removeItem('ms.' + key);
      else localStorage.setItem('ms.' + key, JSON.stringify(value));
    } catch { /* storage full or off */ }
  }

  // ---- the feature list ----------------------------------------------------------------------------------------------------

  const featureMenu = menu('ms-feature-menu', [
    ['edit', 'edit', t('Tree.Edit')],
    ['rename', 'type', t('Tree.Rename')],
    ['suppress', 'suppress', t('Tree.Suppress')],
    ['view', 'eye', t('Tree.ToggleSketch')],
    ['rollback', 'rollback', t('Tree.RollbackHere')],
    ['up', 'arrow-up', t('Tree.MoveUp')],
    ['down', 'arrow-down', t('Tree.MoveDown')],
    null,
    ['delete', 'trash', t('Tree.Delete'), true],
  ], onFeatureMenu);
  let menuFeature = null;

  function featureName(fid) {
    return state.content.features.find(f => f.id === fid)?.name || fid;
  }

  function renderTree(content = state.content) {
    const list = ui.tree;
    list.replaceChildren();
    const status = state.result?.status || {};
    const rollback = content.rollback ?? content.features.length;
    // the default geometry
    const defaults = el('li', { class: 'ms-tree__group' },
      el('details', { class: 'ms-tree__defaults' },
        el('summary', null, icon('origin'), el('span', null, t('Tree.Defaults'))),
        el('ul', null, ...['top', 'front', 'right'].map(name => el('li', { class: 'ms-tree__item ms-tree__item--plain', 'data-plane': name }, icon('plane'), el('span', null, t('Plane.' + name)))))));
    defaults.querySelectorAll('[data-plane]').forEach(li => {
      li.addEventListener('mouseenter', () => viewport.setPlaneHighlight(li.dataset.plane));
      li.addEventListener('mouseleave', () => viewport.setPlaneHighlight(null));
      li.addEventListener('click', () => { if (state.mode === 'pickplane') startSketchOn({ kind: 'std', name: li.dataset.plane }); });
    });
    list.append(defaults);

    content.features.forEach((f, i) => {
      if (i === rollback) list.append(rollbackBar());
      const s = status[f.id] || {};
      const editing = state.dialog?.feature.id === f.id;
      const row = el('li', {
        class: 'ms-tree__item' + (s.state === 'error' ? ' is-error' : '') + (f.suppressed ? ' is-suppressed' : '') + (i >= rollback ? ' is-rolled' : '') + (editing ? ' is-editing' : ''),
        'data-feature': f.id,
        tabindex: '0',
        title: s.state === 'error' ? t(s.key, ...(s.args || [])) : '',
      });
      row.append(icon(FEATURES[f.type]?.icon || 'cube', 'ms-tree__icon'));
      row.append(el('span', { class: 'ms-tree__name' }, f.name || t('Feature.' + f.type)));
      if (f.type === 'variable') {
        const v = state.result?.variables?.[f.params.name];
        if (v) row.append(el('span', { class: 'ms-tree__value mat-mono' }, '#' + f.params.name + ' = ' + (v.d === 1 ? length(v.v, state.doc.units) : fmt(v.v))));
      }
      if (s.state === 'error') row.append(icon('alert', 'ms-tree__warn'));
      if (f.type === 'sketch') {
        const shown = state.result ? sketchVisible({ fid: f.id, used: state.result.sketches.find(x => x.fid === f.id)?.used }, content) : true;
        const eye = el('button', { type: 'button', class: 'ms-tree__btn', 'aria-label': t(shown ? 'Tree.HideSketch' : 'Tree.ShowSketch'), 'data-tip': t(shown ? 'Tree.HideSketch' : 'Tree.ShowSketch') }, icon(shown ? 'eye' : 'eye-off'));
        eye.addEventListener('click', ev => { ev.stopPropagation(); toggleSketchView(f.id); });
        row.append(eye);
      }
      if (canEdit()) {
        const more = el('button', { type: 'button', class: 'ms-tree__btn', 'data-menu-toggle': 'ms-feature-menu', 'aria-haspopup': 'menu', 'aria-label': t('Tree.Actions', f.name || '') }, icon('more-horizontal'));
        more.addEventListener('click', () => { menuFeature = f.id; prepareFeatureMenu(f, i); });
        row.append(more);
      }
      row.addEventListener('dblclick', () => editFeature(f.id));
      row.addEventListener('keydown', ev => { if (ev.key === 'Enter') editFeature(f.id); if (ev.key === 'Delete' && canEdit()) deleteFeature(f.id); });
      row.addEventListener('click', () => {
        if (f.type === 'sketch' && state.mode === 'dialog') return;
        list.querySelectorAll('.is-current').forEach(x => x.classList.remove('is-current'));
        row.classList.add('is-current');
      });
      list.append(row);
    });
    if (rollback >= content.features.length) list.append(rollbackBar());
    ui.featureCount.textContent = String(content.features.length);
  }

  function rollbackBar() {
    const content = state.content;
    const bar = el('li', { class: 'ms-tree__rollback' + (content.rollback !== null ? ' is-moved' : ''), 'aria-label': t('Tree.RollbackBar') });
    bar.append(el('span', { class: 'ms-tree__rollback-line' }));
    if (content.rollback !== null && canEdit()) {
      const btn = el('button', { type: 'button', class: 'mat-btn mat-btn--ghost mat-btn--sm' }, icon('arrow-down'), el('span', null, t('Tree.RollToEnd')));
      btn.addEventListener('click', () => change(c => { c.rollback = null; }));
      bar.append(btn);
    }
    return bar;
  }

  function prepareFeatureMenu(f, index) {
    const item = name => featureMenu.querySelector(`[data-item="${name}"]`);
    item('suppress').querySelector('span').textContent = t(f.suppressed ? 'Tree.Unsuppress' : 'Tree.Suppress');
    item('view').hidden = f.type !== 'sketch';
    item('up').disabled = index === 0;
    item('down').disabled = index === state.content.features.length - 1;
  }

  function onFeatureMenu(action) {
    const id = menuFeature;
    const index = state.content.features.findIndex(f => f.id === id);
    if (index < 0) return;
    if (action === 'edit') editFeature(id);
    else if (action === 'rename') renameFeature(id);
    else if (action === 'suppress') change(c => { const f = c.features[index]; f.suppressed = !f.suppressed; });
    else if (action === 'view') toggleSketchView(id);
    else if (action === 'rollback') change(c => { c.rollback = index + 1 >= c.features.length ? null : index + 1; });
    else if (action === 'up' || action === 'down') change(c => {
      const to = index + (action === 'up' ? -1 : 1);
      if (to < 0 || to >= c.features.length) return;
      [c.features[index], c.features[to]] = [c.features[to], c.features[index]];
    });
    else if (action === 'delete') deleteFeature(id);
  }

  async function renameFeature(id) {
    const f = state.content.features.find(x => x.id === id);
    const name = await window.MatUi.prompt(t('Tree.RenameLabel'), { title: t('Tree.Rename'), value: f.name || '' });
    if (name && name.trim()) change(c => { c.features.find(x => x.id === id).name = name.trim().slice(0, 120); });
  }

  async function deleteFeature(id) {
    const f = state.content.features.find(x => x.id === id);
    if (!f) return;
    const users = state.content.features.filter(x => x.params?.sketch === id);
    const text = users.length ? t('Tree.DeleteUsed', f.name, users.map(u => u.name).join(', ')) : t('Tree.DeleteConfirm', f.name);
    if (!await window.MatUi.confirm(text, { danger: true, ok: t('Tree.Delete') })) return;
    change(c => {
      const index = c.features.findIndex(x => x.id === id);
      c.features.splice(index, 1);
      if (c.rollback !== null && index < c.rollback) c.rollback--;
      if (c.rollback !== null && c.rollback >= c.features.length) c.rollback = null;
    });
  }

  function toggleSketchView(id) {
    const f = state.content.features.find(x => x.id === id);
    const shown = sketchVisible({ fid: id, used: state.result?.sketches.find(x => x.fid === id)?.used }, state.content);
    if (canEdit()) change(() => { f.view = shown ? 'hide' : 'show'; });
    else { f.view = shown ? 'hide' : 'show'; regen(); }
  }

  // ---- the parts -----------------------------------------------------------------------------------------------------------

  const partMenu = menu('ms-part-menu', [
    ['rename', 'type', t('Part.Rename')],
    ['color', 'palette', t('Part.Color')],
    ['properties', 'info', t('Part.Properties')],
    ['isolate', 'eye', t('Part.Isolate')],
    null,
    ['delete', 'trash', t('Part.Delete'), true],
  ], onPartMenu);
  let menuPart = null;
  const colorInput = el('input', { type: 'color', class: 'ms-colorinput', tabindex: '-1', 'aria-hidden': 'true' });
  document.body.append(colorInput);

  function partName(part) { return part.name || t('Part.Default', part.number); }

  function renderParts() {
    const list = ui.parts;
    list.replaceChildren();
    const parts = state.result?.parts || [];
    if (!parts.length) list.append(el('li', { class: 'ms-parts__none' }, t('Part.None')));
    for (const part of parts) {
      const hidden = state.hidden.has(part.id);
      const row = el('li', { class: 'ms-parts__item' + (state.selection.has(part.id) ? ' is-selected' : '') + (hidden ? ' is-hidden' : ''), 'data-part': part.id, tabindex: '0' });
      row.append(swatch(part.color, 'ms-swatch'));
      row.append(el('span', { class: 'ms-parts__name' }, partName(part)));
      const eye = el('button', { type: 'button', class: 'ms-tree__btn', 'aria-label': t(hidden ? 'Part.Show' : 'Part.Hide'), 'data-tip': t(hidden ? 'Part.Show' : 'Part.Hide') }, icon(hidden ? 'eye-off' : 'eye'));
      eye.addEventListener('click', ev => { ev.stopPropagation(); toggleHidden(part.id); });
      const more = el('button', { type: 'button', class: 'ms-tree__btn', 'data-menu-toggle': 'ms-part-menu', 'aria-haspopup': 'menu', 'aria-label': t('Part.Actions', partName(part)) }, icon('more-horizontal'));
      more.addEventListener('click', () => {
        menuPart = part.id;
        partMenu.querySelectorAll('[data-item="rename"], [data-item="color"], [data-item="delete"]').forEach(b => { b.hidden = !canEdit(); });
      });
      row.append(eye, more);
      row.addEventListener('click', ev => selectPart(part.id, ev.shiftKey || ev.ctrlKey || ev.metaKey));
      list.append(row);
    }
    ui.partCount.textContent = String(parts.length);
  }

  function selectPart(id, add) {
    if (state.mode === 'dialog' && state.dialog.activeParts) { state.dialog.activeParts.toggle(id); return; }
    if (!add) state.selection = new Set(state.selection.has(id) && state.selection.size === 1 ? [] : [id]);
    else if (state.selection.has(id)) state.selection.delete(id);
    else state.selection.add(id);
    viewport.setSelection(state.selection);
    renderParts();
    const part = state.result.parts.find(p => p.id === id);
    if (part && state.selection.has(id)) showPartInfo(part);
  }

  function toggleHidden(id) {
    if (state.hidden.has(id)) state.hidden.delete(id); else state.hidden.add(id);
    writeLocal('hidden.' + state.studio.id, [...state.hidden]);
    viewport.setHidden(state.hidden);
    renderParts();
  }

  async function onPartMenu(action) {
    const part = state.result.parts.find(p => p.id === menuPart);
    if (!part) return;
    if (action === 'rename') {
      const name = await window.MatUi.prompt(t('Part.RenameLabel'), { title: t('Part.Rename'), value: partName(part) });
      if (name && name.trim()) change(c => { c.parts[part.id] = { ...(c.parts[part.id] || {}), name: name.trim().slice(0, 120) }; });
    } else if (action === 'color') {
      colorInput.value = part.color;
      colorInput.onchange = () => change(c => { c.parts[part.id] = { ...(c.parts[part.id] || {}), color: colorInput.value }; });
      colorInput.click();
    } else if (action === 'properties') {
      showPartInfo(part, true);
    } else if (action === 'isolate') {
      state.hidden = new Set(state.result.parts.filter(p => p.id !== part.id).map(p => p.id));
      writeLocal('hidden.' + state.studio.id, [...state.hidden]);
      viewport.setHidden(state.hidden);
      renderParts();
    } else if (action === 'delete') {
      newFeature('deletepart', { parts: [part.id] });
    }
  }

  function showPartInfo(part, sticky) {
    const p = properties(part);
    const u = state.doc.units, f = unit();
    const size = [0, 1, 2].map(i => fmt((p.box.max[i] - p.box.min[i]) / f, 3)).join(' × ');
    ui.measure.replaceChildren(
      el('strong', null, partName(part)),
      el('span', null, t('Part.Volume') + ': ' + fmt(p.volume / f ** 3, 3) + ' ' + u + '³'),
      el('span', null, t('Part.Area') + ': ' + fmt(p.area / f ** 2, 3) + ' ' + u + '²'),
      el('span', null, t('Part.Size') + ': ' + size + ' ' + u),
    );
    ui.measure.hidden = false;
    clearTimeout(showPartInfo.timer);
    if (!sticky) showPartInfo.timer = setTimeout(() => { if (state.mode !== 'measure') ui.measure.hidden = true; }, 6000);
  }

  // ---- features: new and edit ----------------------------------------------------------------------------------------------

  function nextName(type) {
    const base = t('Feature.' + type);
    let n = state.content.features.filter(f => f.type === type).length + 1;
    while (state.content.features.some(f => f.name === `${base} ${n}`)) n++;
    return `${base} ${n}`;
  }

  /** A new feature at the rollback bar, with its dialog open. */
  function newFeature(type, preset) {
    if (!canEdit() || state.mode === 'sketch') return;
    closeModes();
    if (type === 'sketch') { pickPlaneForSketch(); return; }
    const params = { ...FEATURES[type].params(), ...(preset || {}) };
    const selected = [...state.selection];
    if (selected.length) {
      if ('parts' in params && !preset?.parts) params.parts = selected;
      if (type === 'boolean') { params.targets = selected.slice(0, 1); params.tools = selected.slice(1); }
    }
    if (type === 'extrude' || type === 'revolve') {
      const sketches = state.result.sketches.filter(s => s.loops.length);
      if (!sketches.length) { toast(t('Studio.NeedSketch'), 'warning'); return; }
    }
    const feature = { id: uid('f'), type, name: nextName(type), params };
    openDialog(feature, true);
  }

  function editFeature(id) {
    if (state.mode !== 'idle') closeModes();
    const feature = state.content.features.find(f => f.id === id);
    if (!feature) return;
    if (!canEdit()) { toast(t('Studio.ReadOnlyHint'), 'info'); return; }
    if (feature.type === 'sketch') { openSketch(feature, false); return; }
    openDialog(clone(feature), false);
  }

  function insertIndex() {
    return state.content.rollback ?? state.content.features.length;
  }

  function openDialog(feature, isNew) {
    const content = state.content;
    const index = isNew ? insertIndex() : content.features.findIndex(f => f.id === feature.id);
    // what the feature can use: the result of everything before it
    const inputContent = { ...content, features: content.features.slice(0, index), rollback: null };
    const input = regenerate(state.kernel, inputContent, state.doc.units);
    state.mode = 'dialog';
    state.dialog = { feature, isNew, index, input, activeParts: null, activePlane: null };
    ui.dialog.hidden = false;
    ui.empty.hidden = true;
    ui.dialogTitle.textContent = t('Feature.' + feature.type);
    ui.dialogIcon.replaceChildren(icon(FEATURES[feature.type].icon));
    ui.dialogError.hidden = true;
    root.classList.add('is-dialog');
    const ctx = {
      feature,
      input,
      units: state.doc.units,
      unit: unit(),
      changed: (preview = true) => { if (preview) schedulePreview(); },
      rebuild: () => { build(); schedulePreview(); },
      activateParts: field => { state.dialog.activeParts?.activate(false); state.dialog.activeParts = field; field.activate(true); },
      activatePlane: field => { state.dialog.activePlane = field; setStatus(field ? t('Dialog.PickFaceHint') : ''); },
      featureName,
      partName,
    };
    const build = () => { state.dialog.fields = buildDialog(ui.dialogForm, ctx); };
    build();
    updateUndo();
    preview();
    setTimeout(() => ui.dialogForm.querySelector('input:not([type=checkbox]), select')?.focus(), 30);
  }

  /** The content with the feature of the dialog in its place. */
  function withDialogFeature() {
    const d = state.dialog;
    const content = clone(state.content);
    if (d.isNew) {
      content.features.splice(d.index, 0, clone(d.feature));
      if (content.rollback !== null) content.rollback++;
    } else content.features[d.index] = clone(d.feature);
    return content;
  }

  const schedulePreview = debounce(() => preview(), 120);

  function preview() {
    if (state.mode !== 'dialog') return;
    const content = withDialogFeature();
    regen(content, { keepTree: false });
    const s = state.result.status[state.dialog.feature.id];
    ui.dialogError.hidden = !(s && s.state === 'error');
    if (s && s.state === 'error') ui.dialogError.textContent = t(s.key, ...(s.args || []));
    ui.empty.hidden = true;
  }

  function acceptDialog() {
    if (state.mode !== 'dialog') return;
    schedulePreview.cancel();
    const d = state.dialog;
    const before = JSON.stringify(state.content);
    state.content = normalize(withDialogFeature());
    closeDialog();
    commit(before);
  }

  function cancelDialog() {
    if (state.mode !== 'dialog') return;
    schedulePreview.cancel();
    closeDialog();
    regen();
  }

  function closeDialog() {
    if (!state.dialog) return;
    dispose(state.dialog.input);
    state.dialog = null;
    state.mode = 'idle';
    ui.dialog.hidden = true;
    ui.dialogForm.replaceChildren();
    root.classList.remove('is-dialog');
    setStatus('');
    updateUndo();
  }

  ui.dialog.querySelector('[data-dialog-ok]').addEventListener('click', acceptDialog);
  ui.dialog.querySelector('[data-dialog-cancel]').addEventListener('click', cancelDialog);
  ui.dialog.querySelector('[data-dialog-help]').addEventListener('click', () => {
    if (state.dialog) window.MatUi.alert(t('Help.' + state.dialog.feature.type), { title: t('Feature.' + state.dialog.feature.type), icon: 'help-circle' });
  });
  ui.dialogForm.addEventListener('submit', e => { e.preventDefault(); acceptDialog(); });
  ui.dialogForm.addEventListener('keydown', e => {
    if (e.key === 'Enter' && e.target.tagName === 'INPUT' && e.target.type !== 'checkbox') { e.preventDefault(); acceptDialog(); }
    if (e.key === 'Escape') { e.preventDefault(); cancelDialog(); }
  });

  // ---- sketches ------------------------------------------------------------------------------------------------------------

  function pickPlaneForSketch() {
    state.mode = 'pickplane';
    root.classList.add('is-picking');
    ui.empty.hidden = true;
    showHud(t('Sketch.PickPlane'));
    setStatus(t('Sketch.PickPlane'));
    viewport.setPlanes(state.result.planes, true);
  }

  function startSketchOn(planeRef) {
    viewport.setPlaneHighlight(null);
    viewport.hover(null);
    root.classList.remove('is-picking');
    const feature = { id: uid('f'), type: 'sketch', name: nextName('sketch'), params: { plane: planeRef, entities: [] } };
    state.mode = 'idle';
    openSketch(feature, true);
  }

  function frameOf(ref, result) {
    if (ref.kind === 'std') return STANDARD_PLANES[ref.name];
    if (ref.kind === 'plane') return result.planes.find(p => p.fid === ref.id)?.frame;
    return ref.frame;
  }

  function openSketch(feature, isNew) {
    const content = state.content;
    const index = isNew ? insertIndex() : content.features.findIndex(f => f.id === feature.id);
    const input = regenerate(state.kernel, { ...content, features: content.features.slice(0, index), rollback: null }, state.doc.units);
    const frame = frameOf(feature.params.plane, input);
    if (!frame) { dispose(input); toast(t('Feature.MissingPlane'), 'danger'); return; }
    state.mode = 'sketch';
    state.dialog = { feature: clone(feature), isNew, index, input, view: viewport.saveView() };
    root.classList.add('is-sketching');
    ui.tools.hidden = true;
    ui.sketchTools.hidden = false;
    ui.sketchPanel.hidden = false;
    ui.empty.hidden = true;
    showHud('');
    regen(withDialogFeature());
    sketcher.start({ name: feature.name, frame, entities: feature.params.entities, units: state.doc.units, variables: input.variables });
    updateUndo();
  }

  function finishSketch() {
    if (state.mode !== 'sketch') return;
    const d = state.dialog;
    d.feature.params.entities = sketcher.entities;
    const before = JSON.stringify(state.content);
    const content = normalize(withDialogFeature());
    closeSketch();
    if (d.isNew && !d.feature.params.entities.length) { regen(); return; }
    state.content = content;
    commit(before);
  }

  function cancelSketch() {
    if (state.mode !== 'sketch') return;
    closeSketch();
    regen();
  }

  function closeSketch() {
    sketcher.stop();
    viewport.restoreView(state.dialog?.view);
    dispose(state.dialog?.input);
    state.dialog = null;
    state.mode = 'idle';
    root.classList.remove('is-sketching');
    ui.tools.hidden = false;
    ui.sketchTools.hidden = true;
    ui.sketchPanel.hidden = true;
    showHud('');
    setStatus('');
    updateUndo();
  }

  ui.sketchTools.addEventListener('click', e => {
    const tool = e.target.closest('[data-sketch-tool]');
    if (tool) { sketcher.setTool(tool.dataset.sketchTool); return; }
  });
  root.addEventListener('click', e => {
    const action = e.target.closest('[data-sketch-action]');
    if (!action || state.mode !== 'sketch') return;
    const name = action.dataset.sketchAction;
    if (name === 'finish') finishSketch();
    else if (name === 'cancel') cancelSketch();
    else if (name === 'delete') sketcher.deleteSelected();
    else if (name === 'construction') sketcher.toggleConstruction();
    else if (name === 'normal') viewport.normalTo(sketcher.frame);
  });

  // ---- the view: clicks and hover ------------------------------------------------------------------------------------------

  viewport.on('hover', e => {
    if (state.mode === 'sketch') return;
    const pick = viewport.pick(e.ndc);
    if (state.mode === 'pickplane' || (state.mode === 'dialog' && state.dialog.activePlane)) {
      const flat = pick && viewport.faceNormal(pick.partId, pick.faceId);
      viewport.hover(flat ? pick : null);
      const plane = !pick && viewport.pickPlane(e.ndc);
      viewport.setPlaneHighlight(plane ? plane.key : null);
      viewport.canvas.style.cursor = flat || plane ? 'pointer' : '';
      return;
    }
    viewport.hover(pick);
    viewport.canvas.style.cursor = pick ? 'pointer' : '';
  });
  viewport.on('leave', () => { viewport.hover(null); viewport.setPlaneHighlight(null); });

  viewport.on('click', e => {
    if (state.mode === 'sketch') return;
    const pick = viewport.pick(e.ndc);
    if (state.mode === 'pickplane' || (state.mode === 'dialog' && state.dialog.activePlane)) {
      let ref = null;
      if (pick) {
        const n = viewport.faceNormal(pick.partId, pick.faceId);
        if (n) ref = { kind: 'face', frame: roundFrame(frameFromNormal(pick.point, n)) };
      } else {
        const plane = viewport.pickPlane(e.ndc);
        if (plane && STANDARD_PLANES[plane.key]) ref = { kind: 'std', name: plane.key };
        else if (plane) ref = { kind: 'plane', id: plane.key };
      }
      if (!ref) { toast(t('Sketch.NotFlat'), 'warning'); return; }
      viewport.setPlaneHighlight(null);
      viewport.hover(null);
      if (state.mode === 'pickplane') { showHud(''); startSketchOn(ref); }
      else { state.dialog.activePlane.set(ref); state.dialog.activePlane = null; setStatus(''); }
      return;
    }
    if (state.mode === 'measure') { measureClick(pick); return; }
    if (state.mode === 'dialog') {
      if (pick && state.dialog.activeParts) state.dialog.activeParts.toggle(pick.partId);
      return;
    }
    if (pick) selectPart(pick.partId, e.shift || e.ctrl);
    else if (state.selection.size) { state.selection.clear(); viewport.setSelection(state.selection); renderParts(); ui.measure.hidden = true; }
  });

  viewport.on('context', () => { if (state.mode === 'pickplane') { closeModes(); } });

  function roundFrame(f) {
    const r = v => v.map(x => Math.round(x * 1e6) / 1e6);
    return { o: r(f.o), x: r(f.x), y: r(f.y), n: r(f.n) };
  }

  // ---- measuring -----------------------------------------------------------------------------------------------------------

  function toggleMeasure(on = state.mode !== 'measure') {
    const btn = root.querySelector('[data-action="measure"]');
    if (on) {
      closeModes();
      state.mode = 'measure';
      state.measure = [];
      btn?.setAttribute('aria-pressed', 'true');
      showHud(t('Measure.Hint'));
    } else {
      if (state.mode === 'measure') state.mode = 'idle';
      state.measure = [];
      viewport.setMarkers(null);
      btn?.setAttribute('aria-pressed', 'false');
      ui.measure.hidden = true;
      showHud('');
    }
  }

  function measureClick(pick) {
    if (!pick) return;
    if (state.measure.length >= 2) state.measure = [];
    state.measure.push(pick.point);
    viewport.setMarkers(state.measure);
    const u = state.doc.units;
    if (state.measure.length === 1) {
      const p = state.measure[0];
      ui.measure.replaceChildren(el('strong', null, t('Measure.Point')), el('span', { class: 'mat-mono' }, `X ${length(p[0], u)} · Y ${length(p[1], u)} · Z ${length(p[2], u)}`));
    } else {
      const [a, b] = state.measure;
      const d = v3.sub(b, a);
      ui.measure.replaceChildren(
        el('strong', null, t('Measure.Distance') + ': ' + length(v3.len(d), u)),
        el('span', { class: 'mat-mono' }, `ΔX ${length(Math.abs(d[0]), u)} · ΔY ${length(Math.abs(d[1]), u)} · ΔZ ${length(Math.abs(d[2]), u)}`),
      );
    }
    ui.measure.hidden = false;
  }

  // ---- modes, status -------------------------------------------------------------------------------------------------------

  function closeModes() {
    if (state.mode === 'dialog') cancelDialog();
    if (state.mode === 'sketch') cancelSketch();
    if (state.mode === 'measure') toggleMeasure(false);
    if (state.mode === 'pickplane') { state.mode = 'idle'; root.classList.remove('is-picking'); showHud(''); setStatus(''); viewport.setPlanes(state.result?.planes, state.planes); }
  }

  function setStatus(text) { ui.status.textContent = text || ''; }

  function showHud(text) { ui.hud.textContent = text || ''; ui.hud.hidden = !text; }

  // ---- Part Studio tabs ----------------------------------------------------------------------------------------------------

  const tabMenu = menu('ms-tab-menu', [
    ['rename', 'type', t('Tabs.Rename')],
    ['duplicate', 'copy', t('Tabs.Duplicate')],
    ['left', 'chevron-left', t('Tabs.MoveLeft')],
    ['right', 'chevron-right', t('Tabs.MoveRight')],
    null,
    ['delete', 'trash', t('Tabs.Delete'), true],
  ], onTabMenu);

  function renderTabs() {
    ui.tabs.replaceChildren();
    for (const s of state.doc.studios) {
      const active = state.studio?.id === s.id;
      const tab = el('div', { class: 'ms-tab' + (active ? ' is-active' : '') },
        el('button', { type: 'button', class: 'ms-tab__btn', role: 'tab', 'aria-selected': active ? 'true' : 'false' }, icon('studio'), el('span', null, s.name)));
      tab.firstChild.addEventListener('click', () => { if (!active) openStudio(s.id); });
      tab.firstChild.addEventListener('dblclick', () => { if (canEdit()) renameStudio(s); });
      if (active && canEdit()) {
        const more = el('button', { type: 'button', class: 'ms-tab__more', 'data-menu-toggle': 'ms-tab-menu', 'aria-haspopup': 'menu', 'aria-label': t('Tabs.Actions', s.name) }, icon('chevron-up'));
        tab.append(more);
      }
      ui.tabs.append(tab);
    }
  }

  async function renameStudio(s) {
    const name = await window.MatUi.prompt(t('Tabs.RenameLabel'), { title: t('Tabs.Rename'), value: s.name });
    if (!name || !name.trim()) return;
    try {
      const answer = await request('PATCH', `/live/studios/${s.id}`, { name: name.trim() });
      s.name = answer.name;
      renderTabs();
    } catch { toast(t('Tabs.Failed'), 'danger'); }
  }

  async function onTabMenu(action) {
    const s = state.studio;
    if (!s) return;
    try {
      if (action === 'rename') return renameStudio(s);
      await flushSave();
      if (action === 'duplicate') {
        const copy = await request('POST', `/live/studios/${s.id}/duplicate`);
        state.doc.studios.push(copy);
        await openStudio(copy.id);
      } else if (action === 'left' || action === 'right') {
        await request('POST', `/live/studios/${s.id}/move`, { step: action === 'left' ? -1 : 1 });
        const list = state.doc.studios, i = list.indexOf(s), j = i + (action === 'left' ? -1 : 1);
        if (j >= 0 && j < list.length) [list[i], list[j]] = [list[j], list[i]];
        renderTabs();
      } else if (action === 'delete') {
        if (state.doc.studios.length <= 1) { toast(t('Tabs.LastOne'), 'warning'); return; }
        if (!await window.MatUi.confirm(t('Tabs.DeleteConfirm', s.name), { danger: true, ok: t('Tabs.Delete') })) return;
        await request('DELETE', `/live/studios/${s.id}`);
        writeLocal('pending.' + s.id, null);
        state.doc.studios = state.doc.studios.filter(x => x !== s);
        state.studio = null;
        await openStudio(state.doc.studios[0].id);
      }
    } catch { toast(t('Tabs.Failed'), 'danger'); }
  }

  async function addStudio() {
    try {
      await flushSave();
      const studio = await request('POST', `/live/documents/${docId}/studios`, {});
      state.doc.studios.push(studio);
      await openStudio(studio.id);
      viewport.fit(true);
    } catch { toast(t('Tabs.Failed'), 'danger'); }
  }

  // ---- versions, export ----------------------------------------------------------------------------------------------------

  async function createVersion() {
    const name = await window.MatUi.prompt(t('Version.NameLabel'), { title: t('Version.Create'), value: t('Version.DefaultName', new Date().toLocaleString(document.documentElement.lang)) });
    if (!name || !name.trim()) return;
    try {
      await flushSave();
      await request('POST', `/live/documents/${docId}/versions`, { name: name.trim() });
      toast(t('Version.Created', name.trim()), 'success');
    } catch { toast(t('Version.Failed'), 'danger'); }
  }

  async function exportAs(kind) {
    const parts = (state.result?.parts || []).filter(p => !state.hidden.has(p.id));
    const name = state.doc.name + (state.doc.studios.length > 1 ? ' - ' + state.studio.name : '');
    if (kind === 'json') { download(fileName(name, 'matshape.json'), JSON.stringify({ format: 'MatShape Part Studio 1', units: state.doc.units, content: state.content }, null, 2), 'application/json'); return; }
    if (kind === 'png') { const png = await viewport.image(); if (png) download(fileName(name, 'png'), png); return; }
    if (!parts.length) { toast(t('Export.Empty'), 'warning'); return; }
    if (kind === 'stl') download(fileName(name, 'stl'), toStl(parts, name));
    else if (kind === 'obj') download(fileName(name, 'obj'), toObj(parts, parts.map(partName)));
  }

  // ---- menus ---------------------------------------------------------------------------------------------------------------

  /** A menu of the toolkit made once and opened by buttons with data-menu-toggle="id". */
  function menu(id, items, onPick) {
    const m = el('div', { class: 'mat-menu', id, role: 'menu', hidden: true });
    for (const item of items) {
      if (!item) { m.append(el('div', { class: 'mat-menu__sep', role: 'separator' })); continue; }
      const [name, ic, text, danger] = item;
      const b = el('button', { type: 'button', class: 'mat-menu__item' + (danger ? ' mat-menu__item--danger' : ''), role: 'menuitem', 'data-item': name }, icon(ic), el('span', null, text));
      b.addEventListener('click', () => { m.hidden = true; onPick(name); });
      m.append(b);
    }
    document.body.append(m);
    return m;
  }

  // ---- buttons and keys ----------------------------------------------------------------------------------------------------

  root.addEventListener('click', e => {
    const feature = e.target.closest('[data-feature]');
    if (feature && feature.closest('[data-toolbar="features"]')) { newFeature(feature.dataset.feature); return; }
    const view = e.target.closest('[data-view-set]');
    if (view) { viewport.setView(view.dataset.viewSet); return; }
    const exp = e.target.closest('[data-export]');
    if (exp) { exportAs(exp.dataset.export); return; }
    const action = e.target.closest('[data-action]')?.dataset.action;
    if (!action) return;
    if (action === 'undo') undo();
    else if (action === 'redo') redo();
    else if (action === 'fit') viewport.fit();
    else if (action === 'measure') toggleMeasure();
    else if (action === 'version') createVersion();
    else if (action === 'add-studio') addStudio();
    else if (action === 'reload') load();
    else if (action === 'display') cycleDisplay(e.target.closest('button'));
    else if (action === 'planes') { state.planes = !state.planes; e.target.closest('button').setAttribute('aria-pressed', String(state.planes)); viewport.setPlanes(state.result?.planes, state.planes); }
    else if (action === 'side') toggleSide();
  });
  // the export menu lives outside the root
  document.getElementById('ms-export-menu')?.addEventListener('click', e => {
    const exp = e.target.closest('[data-export]');
    if (exp) exportAs(exp.dataset.export);
  });

  function cycleDisplay(button) {
    const order = ['shaded', 'shaded-plain', 'wireframe'];
    state.display = order[(order.indexOf(state.display) + 1) % order.length];
    viewport.setDisplay(state.display);
    button?.querySelector('use')?.setAttribute('href', '#mat-i-' + (state.display === 'wireframe' ? 'wireframe' : 'shaded'));
    toast(t('View.Display.' + state.display), 'info');
  }

  function toggleSide(force) {
    const open = force ?? root.classList.contains('is-side-closed');
    root.classList.toggle('is-side-closed', !open);
    root.querySelector('[data-action="side"]')?.setAttribute('aria-expanded', String(open));
    setTimeout(() => viewport.resize(), 220);
  }
  if (window.matchMedia('(max-width: 720px)').matches) toggleSide(false);

  document.addEventListener('keydown', e => {
    const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName) || e.target.isContentEditable;
    if (document.querySelector('dialog[open]')) return;
    const ctrl = e.ctrlKey || e.metaKey;
    if (ctrl && e.key.toLowerCase() === 'z' && !typing) { e.preventDefault(); if (e.shiftKey) redo(); else undo(); return; }
    if (ctrl && e.key.toLowerCase() === 'y' && !typing) { e.preventDefault(); redo(); return; }
    if (typing) return;
    if (e.key === 'Escape') {
      if (state.mode === 'sketch') sketcher.escape();
      else if (state.mode === 'dialog') cancelDialog();
      else closeModes();
      return;
    }
    if (state.mode === 'sketch') {
      const keys = { l: 'line', g: 'rect', c: 'circle', a: 'arc' };
      if (keys[e.key.toLowerCase()] && !ctrl) { sketcher.setTool(keys[e.key.toLowerCase()]); return; }
      if (e.key === 'Delete' || e.key === 'Backspace') { sketcher.deleteSelected(); return; }
      if (e.key.toLowerCase() === 'q') { sketcher.toggleConstruction(); return; }
      if (e.key.toLowerCase() === 'n') { viewport.normalTo(sketcher.frame); return; }
      if (e.key === 'Enter') { finishSketch(); return; }
    }
    if (state.mode === 'dialog' && e.key === 'Enter') { acceptDialog(); return; }
    if (e.key.toLowerCase() === 'f' && !ctrl) viewport.fit();
    else if (e.key.toLowerCase() === 'i' && !ctrl) viewport.setView('iso');
    else if (e.key.toLowerCase() === 'm' && !ctrl && state.mode !== 'sketch') toggleMeasure();
    else if (e.shiftKey && e.key.toLowerCase() === 's') newFeature('sketch');
    else if (e.shiftKey && e.key.toLowerCase() === 'e') newFeature('extrude');
    else if (e.shiftKey && e.key.toLowerCase() === 'w') newFeature('revolve');
  });

  // the theme changes the colours of the edges
  new MutationObserver(() => { viewport.applyDisplay(); viewport.updatePlanes(); }).observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
  window.matchMedia('(prefers-color-scheme: dark)').addEventListener?.('change', () => viewport.applyDisplay());

  window.addEventListener('beforeunload', e => {
    if (state.dirty && !navigator.onLine) return;
    if (state.dirty) { flushSave(); e.preventDefault(); }
  });

  load();
}
