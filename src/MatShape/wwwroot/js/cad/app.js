/* MatShape – the editor of a model. It loads the model (/live/models/{id}), runs the features of the open Part Studio (model.js), shows the result
   (viewport.js), and lets the person change the history: new features through their dialogs (dialogs.js), sketches (sketcher.js), rename, suppress, roll back, delete.
   Every change is saved by itself a moment later, with the revision it started from: when somebody else saved in between, nothing is overwritten unasked.
   Without a network the changes wait on this device (localStorage) and are sent when the network is back. */

import { Viewport, edgeGroup, edgePoints } from './viewport.js';
import { ViewCube } from './viewcube.js';
import { SpaceMouse, SPEEDS, isSupported as spaceMouseSupported } from './spacemouse.js';
import { Assistant } from './assistant.js';
import { ImageDialog } from './imagedialog.js';
import { MeshDialog } from './meshdialog.js';
import { DrawingDialog } from './drawingdialog.js';
import { DrawingEditor } from './drawingeditor.js';
import { AssemblyEditor } from './assembly.js';
import { loadKernel, regenerate, dispose, FEATURES, TANGENT, faceKey, outlineOf, overlapsOf, properties, sectionOf } from './model.js';
import { buildDialog } from './dialogs.js';
import { distToSegment3 } from './topo.js';
import { Sketcher } from './sketcher.js';
import { renameProfiles } from './sketchsolve.js';
import { toObj, toStl, toThreeMf } from './export.js';
import { packArray, readCad, toStep } from './step.js';
import { STANDARD_PLANES, curvesFromPoints, frameFromNormal, offsetFrame, v3 } from './geom.js';
import { clone, debounce, download, el, fileName, fmt, icon, length, request, swatch, t, toast, uid, UNITS } from './util.js';

const root = document.getElementById('ms-studio');
if (root) start();

function start() {
  const $ = sel => root.querySelector(sel);
  const modelId = root.dataset.model;
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
    model: null,
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
  const canEdit = () => !!state.model?.canEdit;
  const unit = () => UNITS[state.model?.units] || 1;

  const viewport = new Viewport($('[data-canvas]'), $('[data-triad]'));
  const viewCube = new ViewCube($('[data-viewcube]'), viewport);

  // ---- the AI assistant (only when the page offers it) ----------------------------------------------------------------------
  const aiPanel = $('[data-ai-panel]');
  const assistant = aiPanel ? new Assistant(aiPanel, {
    studioId: () => state.studio.id,
    // the pictures behind sketches stay here (they are big and say nothing about the model)
    content: () => ({ ...state.content, features: state.content.features.map(f => (f.params?.image ? { ...f, params: { ...f.params, image: undefined } } : f.type === 'import' ? { ...f, params: { file: f.params?.file, bodies: [] } } : f)) }),
    // the answer of the AI is one change: it can be undone like every other
    apply: content => {
      closeModes();
      const before = JSON.stringify(state.content);
      // the pictures behind sketches were not sent: they come back from here
      const images = new Map(state.content.features.filter(f => f.params?.image).map(f => [f.id, f.params.image]));
      for (const f of content.features || []) if (images.has(f.id) && f.params && !f.params.image) f.params.image = images.get(f.id);
      // the bodies of imported files were not sent either
      const imports = new Map(state.content.features.filter(f => f.type === 'import').map(f => [f.id, f.params.bodies]));
      for (const f of content.features || []) if (f.type === 'import' && imports.has(f.id) && !f.params?.bodies?.length) f.params = { ...f.params, bodies: imports.get(f.id) };
      state.content = normalize(clone(content));
      commit(before);
      return before;
    },
    statusOf: ids => ids
      .map(id => ({ id, f: state.content.features.find(x => x.id === id), s: state.result?.status[id] }))
      .filter(x => x.f && x.s?.state === 'error')
      .map(x => ({ id: x.id, name: x.f.name || x.f.type, message: t(x.s.key, ...(x.s.args || [])) })),
    undo: before => {
      if (!canEdit()) return false;
      const now = JSON.stringify(state.content);
      if (now === before) return false;
      state.content = normalize(JSON.parse(before));
      commit(now);
      return true;
    },
    // separate parts that interpenetrate (one part is one solid; separate parts may only touch): sent back to the AI for a repair
    overlaps: () => {
      const parts = state.result?.parts || [];
      const named = id => { const p = parts.find(x => x.id === id); return p ? partName(p) : id; };
      try { return overlapsOf(parts).map(o => ({ ...o, aName: named(o.a), bName: named(o.b) })); } catch { return []; }
    },
    fit: () => viewport.fit(true),
    busy: on => root.classList.toggle('is-ai-busy', on),
  }) : null;
  // picture -> 3D model: the features of the editor are added as one step (before the rollback bar when it was moved), the view shows them
  const imageDialogEl = document.getElementById('ms-image');
  const imageDialog = imageDialogEl ? new ImageDialog(imageDialogEl, {
    apply: (features, parts) => {
      if (!canEdit()) return;
      closeModes();
      const before = JSON.stringify(state.content);
      const content = clone(state.content);
      const at = Number.isInteger(content.rollback) ? content.rollback : content.features.length;
      content.features.splice(at, 0, ...features);
      if (Number.isInteger(content.rollback)) content.rollback += features.length;
      content.parts = { ...content.parts, ...parts };
      state.content = normalize(content);
      commit(before);
      setTimeout(() => viewport.fit(), 50);
      toast(t('Studio.Image.Added', features.length));
    },
    toAi: assistant ? file => { assistant.open(true); assistant.attach([file]); if (!assistant.input.value.trim()) assistant.input.value = t('Studio.Image.AiPrompt'); } : null,
    toMesh: file => openMesh(file),
  }) : null;
  // the 3D generation (like Meshy): a picture, up to four views or a text become a mesh at Meshy, then a solid part of the open Part Studio (one step)
  const meshDialogEl = document.getElementById('ms-mesh');
  const meshDialog = meshDialogEl ? new MeshDialog(meshDialogEl, {
    modelId,
    studioId: () => state.studio.id,
    kernel: () => state.kernel,
    units: () => state.model?.units || 'mm',
    unit: () => unit(),
    occupied: () => {
      const parts = state.kind === 'studio' ? state.result?.parts || [] : [];
      if (!parts.length) return null;
      const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
      for (const p of parts) {
        const b = p.manifold.boundingBox();
        for (let k = 0; k < 3; k++) { min[k] = Math.min(min[k], b.min[k]); max[k] = Math.max(max[k], b.max[k]); }
      }
      return { min, max };
    },
    apply: ({ feature, name, color }) => {
      if (!canEdit() || state.kind !== 'studio') { toast(t('Studio.Mesh.NeedStudio'), 'warning'); return false; }
      closeModes();
      const before = JSON.stringify(state.content);
      const content = clone(state.content);
      const at = Number.isInteger(content.rollback) ? content.rollback : content.features.length;
      content.features.splice(at, 0, feature);
      if (Number.isInteger(content.rollback)) content.rollback++;
      content.parts = { ...content.parts, [feature.id]: { name, color } };
      state.content = normalize(content);
      commit(before);
      setTimeout(() => viewport.fit(), 50);
      return true;
    },
    // the way of the AI blocks: the request goes to the assistant (which builds a figure feature, changeable in the chat)
    toAssistant: assistant ? async ({ prompt, files }) => {
      assistant.open(true);
      if (files.length) await assistant.attach(files);
      assistant.input.value = prompt;
      await assistant.submit();
    } : null,
    // a result that came while the dialog was closed: the tool shows it
    ready: on => $('[data-action="mesh"]')?.classList.toggle('is-ready', on),
  }) : null;
  // the technical drawing of the visible parts (also for people who may only look)
  const drawingEl = document.getElementById('ms-drawing');
  const drawingDialog = drawingEl ? new DrawingDialog(drawingEl, {
    kernel: () => state.kernel,
    parts: () => (state.result?.parts || []).filter(p => !state.hidden.has(p.id)),
    name: () => (state.model.studios.length > 1 ? state.studio.name : state.model.name),
    modelName: () => state.model.name,
    units: () => state.model.units,
    unit: () => unit(),
    person: () => root.dataset.person || '',
    asTab: drawing => addStudio('drawing', { ...drawing, source: state.studio.id }),
  }) : null;

  // ---- a drawing tab (drawingeditor.js): the sheet of a Part Studio, dimensions, details ---------------------------------------
  const drawingEditor = new DrawingEditor({ sheet: $('[data-sheet]'), panel: $('[data-drawing-panel]'), toolbar: $('[data-toolbar="drawing"]') }, {
    kernel: () => state.kernel,
    studios: () => state.model.studios,
    units: () => state.model.units,
    unit: () => unit(),
    person: () => root.dataset.person || '',
    modelName: () => state.model.name,
    name: () => state.studio?.name || '',
    canEdit: () => canEdit(),
    status: text => setStatus(text),
    change: fn => change(c => { c.drawing ||= {}; fn(c.drawing); }),
  });
  // ---- importing a CAD file (STEP, IGES, BREP through OpenCascade; STL): a feature "import" with the bodies --------------------------
  const importInput = el('input', { type: 'file', accept: '.step,.stp,.iges,.igs,.brep,.brp,.stl', class: 'mat-sr-only', tabindex: '-1', 'aria-hidden': 'true' });
  root.append(importInput);
  importInput.addEventListener('change', async () => {
    const file = importInput.files[0];
    importInput.value = '';
    if (!file || !canEdit() || state.kind !== 'studio') return;
    const ext = file.name.toLowerCase().split('.').pop();
    const kind = ext === 'stp' || ext === 'step' ? 'step' : ext === 'igs' || ext === 'iges' ? 'iges' : ext === 'brep' || ext === 'brp' ? 'brep' : 'stl';
    toast(t('Import.Reading', file.name), 'info');
    try {
      closeModes();
      const bodies = await readCad(new Uint8Array(await file.arrayBuffer()), kind);
      const id = uid('f');
      const feature = { id, type: 'import', name: file.name.replace(/\.[^.]+$/, '').slice(0, 120), params: { file: file.name, bodies: bodies.map(b => ({ name: b.name, p: packArray(b.positions), i: packArray(b.indices), f: packArray(b.faces) })) } };
      const before = JSON.stringify(state.content);
      const content = clone(state.content);
      const at = Number.isInteger(content.rollback) ? content.rollback : content.features.length;
      content.features.splice(at, 0, feature);
      if (Number.isInteger(content.rollback)) content.rollback++;
      bodies.forEach((b, k) => { if (b.color || bodies.length > 1) content.parts[bodies.length > 1 ? `${id}.${k}` : id] = { name: b.name, ...(b.color ? { color: b.color } : {}) }; });
      state.content = normalize(content);
      commit(before);
      setTimeout(() => viewport.fit(), 50);
      toast(t('Import.Done', bodies.length), 'success');
    } catch (e) { console.warn('MatShape: import failed', e); toast(t('Import.Failed'), 'danger'); }
  });

  // ---- an assembly tab (assembly.js): instances of parts, mates -------------------------------------------------------------
  const assemblyEditor = new AssemblyEditor({ panel: $('[data-assembly-panel]'), toolbar: $('[data-toolbar="assembly"]'), insert: document.getElementById('ms-insert') }, {
    kernel: () => state.kernel,
    studios: () => state.model.studios,
    units: () => state.model.units,
    unit: () => unit(),
    viewport,
    canEdit: () => canEdit(),
    status: text => setStatus(text),
    partName: part => partName(part),
    change: fn => change(c => { c.assembly ||= { instances: [], mates: [] }; fn(c.assembly); }),
  });

  /** What a tab holds: a Part Studio, a drawing or an assembly. */
  const kindOf = content => (content?.drawing ? 'drawing' : content?.assembly ? 'assembly' : 'studio');
  function showKind(kind) {
    root.classList.toggle('is-drawing', kind === 'drawing');
    root.classList.toggle('is-assembly', kind === 'assembly');
    ui.tools.hidden = kind !== 'studio';
    $('[data-toolbar="drawing"]').hidden = kind !== 'drawing';
    $('[data-sheet]').hidden = kind !== 'drawing';
    $('[data-drawing-panel]').hidden = kind !== 'drawing';
    ui.tree.closest('.ms-side__part').hidden = kind !== 'studio';
    $('[data-parts-section]').hidden = kind !== 'studio';
    $('[data-toolbar="assembly"]').hidden = kind !== 'assembly';
    $('[data-assembly-panel]').hidden = kind !== 'assembly';
    if (kind !== 'drawing') drawingEditor.close();
    if (kind !== 'assembly') assemblyEditor.close();
  }
  const openDrawing = () => { if (!drawingDialog || !state.result) return; if (state.mode === 'dialog' || state.mode === 'sketch') closeModes(); drawingDialog.open(); };
  const openImage = file => { if (canEdit() && imageDialog && state.mode !== 'sketch') imageDialog.open(file); };
  const openMesh = file => { if (canEdit() && meshDialog && state.mode !== 'sketch') meshDialog.open(file); };
  // a picture dropped on the view or pasted (outside of fields) opens the editor with it
  root.addEventListener('dragover', e => { if (canEdit() && imageDialog && e.dataTransfer?.types?.includes('Files') && !e.target.closest('[data-ai-panel]')) e.preventDefault(); });
  root.addEventListener('drop', e => {
    if (e.target.closest('[data-ai-panel]')) return;
    const file = [...(e.dataTransfer?.files || [])].find(f => /^image\//.test(f.type));
    if (file && canEdit() && imageDialog) { e.preventDefault(); openImage(file); }
  });
  document.addEventListener('paste', e => {
    if (e.target.closest?.('input, textarea, [contenteditable], dialog')) return;
    const file = [...(e.clipboardData?.files || [])].find(f => /^image\//.test(f.type));
    if (file && canEdit() && imageDialog) { e.preventDefault(); openImage(file); }
  });

  const sketcher = new Sketcher(viewport, { root: ui.sketchPanel, title: $('[data-sketch-title]'), summary: $('[data-sketch-summary]'), body: $('[data-sketch-body]') }, ui.sketchTools, {
    status: text => setStatus(text),
    hud: text => showHud(text),
    toast: text => toast(text, 'info'),
    // like OnShape: every change of the sketch (a value, a constraint, a drag) rebuilds the parts at once, not only when the sketch is accepted
    changed: () => liveSketch(),
  });
  let liveTimer = 0;
  function liveSketch() {
    if (liveTimer) return;
    liveTimer = setTimeout(() => {
      liveTimer = 0;
      if (state.mode !== 'sketch' || !state.dialog) return;
      state.dialog.feature.params.entities = sketcher.entities;
      state.dialog.feature.params.cons = sketcher.cons;
      delete state.dialog.feature.params.dims;
      if (sketcher.image) state.dialog.feature.params.image = sketcher.image; else delete state.dialog.feature.params.image;
      regen(withDialogFeature(), { keepTree: true });
    }, 40);
  }

  // ---- loading -------------------------------------------------------------------------------------------------------------

  async function load() {
    ui.loading.hidden = false;
    ui.failure.hidden = true;
    try {
      const [kernel, model] = await Promise.all([
        loadKernel(),
        request('GET', `/live/models/${modelId}${query()}${versionId ? (linkToken ? '&' : '?') + 'v=' + encodeURIComponent(versionId) : ''}`),
      ]);
      state.kernel = kernel;
      state.model = model;
      document.title = `${model.name} · MatShape`;
      if (model.versionName && ui.versionName) ui.versionName.textContent = t('Studio.VersionNamed', model.versionName);
      if (!canEdit()) root.classList.add('is-readonly');
      renderTabs();
      const wanted = Number(location.hash.replace('#studio-', '')) || null;
      const studio = model.studios.find(s => s.id === wanted) || model.studios[0];
      await openStudio(studio.id);
      ui.loading.hidden = true;
      viewport.fit(false);
      // a generation of the 3D AI that was running when the page was left goes on
      if (canEdit()) meshDialog?.resume();
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
    const studio = state.model.studios.find(s => s.id === id);
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
    state.kind = kindOf(state.content);
    showKind(state.kind);
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
    const next = regenerate(state.kernel, content, state.model.units);
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
    ui.empty.hidden = !empty || state.mode !== 'idle' || (state.kind && state.kind !== 'studio');
    if (empty) {
      $('[data-empty-title]').textContent = t(canEdit() ? 'Studio.Empty.Title' : 'Studio.Empty.ViewTitle');
      $('[data-empty-text]').textContent = t(canEdit() ? 'Studio.Empty.Text' : 'Studio.Empty.ViewText');
    }
    // while sketching, the line below the view keeps the hint of the tool
    if (state.mode !== 'sketch') setStatus(t('Studio.Regenerated', fmt(performance.now() - started, 0)));
    // the numbers of a part shown before may be old now
    if (state.mode !== 'measure') ui.measure.hidden = true;
    // the first part of a Part Studio: show it whole
    if (!hadParts && next.parts.length && state.mode !== 'sketch') setTimeout(() => viewport.fit(true), 320);
    if (state.section) updateSection();
    if (state.kind === 'drawing') drawingEditor.open(content.drawing);
    if (state.kind === 'assembly') assemblyEditor.open(content.assembly);
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
      if (png) await request('PUT', `/live/models/${modelId}/thumbnail`, png);
    } catch { /* the picture is a nicety */ }
  }, 4000);

  // somebody else may work on the same Part Studio: look now and then
  async function poll() {
    if (document.hidden || !state.studio || state.dirty || state.saving || state.mode !== 'idle' || versionId || state.studio.id < 0) return;
    try {
      const info = await request('GET', `/live/studios/${state.studio.id}/revision${query()}`);
      setOffline(false);
      if (info.revision > state.studio.revision) {
        const model = await request('GET', `/live/models/${modelId}${query()}`);
        const fresh = model.studios.find(s => s.id === state.studio.id);
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
        class: 'ms-tree__item' + (s.state === 'error' ? ' is-error' : s.state === 'warn' ? ' is-warn' : '') + (f.suppressed ? ' is-suppressed' : '') + (i >= rollback ? ' is-rolled' : '') + (editing ? ' is-editing' : ''),
        'data-feature': f.id,
        tabindex: '0',
        title: s.state === 'error' || s.state === 'warn' ? t(s.key, ...(s.args || [])) : '',
      });
      row.append(icon(FEATURES[f.type]?.icon || 'cube', 'ms-tree__icon'));
      row.append(el('span', { class: 'ms-tree__name' }, f.name || t('Feature.' + f.type)));
      if (f.type === 'variable') {
        const v = state.result?.variables?.[f.params.name];
        if (v) row.append(el('span', { class: 'ms-tree__value mat-mono' }, '#' + f.params.name + ' = ' + (v.d === 1 ? length(v.v, state.model.units) : fmt(v.v))));
      }
      if (s.state === 'error' || s.state === 'warn') row.append(icon('alert', 'ms-tree__warn'));
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
      // the colour square: a click colours the part (editors), like "Appearance" in OnShape
      const dot = swatch(part.color, 'ms-swatch');
      if (canEdit()) {
        const paint = el('button', { type: 'button', class: 'ms-swatch-btn', 'aria-label': t('Part.Color') + ': ' + partName(part), 'data-tip': t('Part.Color') }, dot);
        paint.addEventListener('click', ev => { ev.stopPropagation(); pickColor(part); });
        row.append(paint);
      } else row.append(dot);
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


  /** The colour of a part (the colour picker of the browser): saved with the Part Studio, exported with 3MF. */
  function pickColor(part) {
    colorInput.value = part.color;
    colorInput.onchange = () => change(c => { c.parts[part.id] = { ...(c.parts[part.id] || {}), color: colorInput.value }; });
    colorInput.click();
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
    if (state.section) updateSection();
  }

  async function onPartMenu(action) {
    const part = state.result.parts.find(p => p.id === menuPart);
    if (!part) return;
    if (action === 'rename') {
      const name = await window.MatUi.prompt(t('Part.RenameLabel'), { title: t('Part.Rename'), value: partName(part) });
      if (name && name.trim()) change(c => { c.parts[part.id] = { ...(c.parts[part.id] || {}), name: name.trim().slice(0, 120) }; });
    } else if (action === 'color') {
      pickColor(part);
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
    const u = state.model.units, f = unit();
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
    if (['fillet', 'chamfer', 'shell', 'draft', 'thread'].includes(type) && !state.result.parts.length) { toast(t('Studio.NeedPart'), 'warning'); return; }
    if (['rib', 'hole'].includes(type) && !state.result.sketches.length) { toast(t('Studio.NeedSketchAny'), 'warning'); return; }
    if (['extrude', 'revolve', 'sweep', 'loft'].includes(type)) {
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
    const input = regenerate(state.kernel, inputContent, state.model.units);
    state.mode = 'dialog';
    state.dialog = { feature, isNew, index, input, activeParts: null, activePlane: null, activeEdges: null };
    // a fillet or chamfer picks the edges of the parts before it, while the view shows its preview
    if (['fillet', 'chamfer', 'shell', 'draft', 'thread'].includes(feature.type)) viewport.setPickParts(input.parts);
    ui.dialog.hidden = false;
    ui.empty.hidden = true;
    ui.dialogTitle.textContent = t('Feature.' + feature.type);
    ui.dialogIcon.replaceChildren(icon(FEATURES[feature.type].icon));
    ui.dialogError.hidden = true;
    root.classList.add('is-dialog');
    const ctx = {
      feature,
      input,
      units: state.model.units,
      unit: unit(),
      changed: (preview = true) => { if (preview) schedulePreview(); },
      rebuild: () => { build(); schedulePreview(); },
      activateParts: field => { state.dialog.activeParts?.activate(false); state.dialog.activeParts = field; field.activate(true); },
      activatePlane: field => { state.dialog.activePlane = field; setStatus(field ? t('Dialog.PickFaceHint') : ''); },
      activateEdges: field => { state.dialog.activeEdges = field; field.activate(true); setStatus(t('Dialog.Edges.Hint')); markEdges(null); },
      edgesChanged: () => markEdges(null),
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
    viewport.setPickParts(null);
    viewport.setEdgeMarks(null);
    viewport.hover(null);
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
    const input = regenerate(state.kernel, { ...content, features: content.features.slice(0, index), rollback: null }, state.model.units);
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
    // "Use" takes edges of the parts before the sketch (the view shows the whole model, which follows the sketch live)
    viewport.setPickParts(input.parts.filter(p => !state.hidden.has(p.id)));
    sketcher.start({ name: feature.name, frame, entities: feature.params.entities, cons: feature.params.cons, dims: feature.params.dims, units: state.model.units, variables: input.variables, image: feature.params.image });
    updateUndo();
  }

  function finishSketch() {
    if (state.mode !== 'sketch') return;
    const d = state.dialog;
    d.feature.params.entities = sketcher.entities;
    // always a list (also empty): a sketch with a list is not given the obvious constraints again when it is opened
    d.feature.params.cons = sketcher.cons;
    delete d.feature.params.dims;
    if (sketcher.image) d.feature.params.image = sketcher.image; else delete d.feature.params.image;
    const before = JSON.stringify(state.content);
    const content = normalize(withDialogFeature());
    // rectangles and polygons that became lines: the features that chose their profiles keep them under the new names
    for (const f of content.features) {
      if (f.params?.sketch === d.feature.id && Array.isArray(f.params.profiles)) f.params.profiles = renameProfiles(f.params.profiles, sketcher.replaced);
    }
    // … and fillets and chamfers keep their edges: a side of a rectangle or polygon ("<extrude>:<rect>.<k>") is now the face of its line
    const users = new Set(content.features.filter(f => f.params?.sketch === d.feature.id).map(f => f.id));
    const renameFace = name => {
      const m = /^(.+?):(.+)\.(\d+)$/.exec(name || '');
      const lines = m && users.has(m[1]) && sketcher.replaced?.[m[2]];
      return lines?.[Number(m[3])] ? `${m[1]}:${lines[Number(m[3])]}` : name;
    };
    for (const f of content.features) {
      if (!Array.isArray(f.params?.edges) || !Object.keys(sketcher.replaced || {}).length) continue;
      f.params.edges = f.params.edges.map(r => ({ ...r, ...(Array.isArray(r.faces) ? { faces: r.faces.map(renameFace) } : {}), ...(r.face ? { face: renameFace(r.face) } : {}) }));
    }
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
    viewport.setPickParts(null);
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
    const constraint = e.target.closest('[data-sketch-constraint]');
    if (constraint) sketcher.constrain(constraint.dataset.sketchConstraint);
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
    else if (name === 'slice' || name === 'outline') useModel(name);
    else if (name === 'image') sketchImageInput.click();
  });

  // a picture behind the sketch, to trace it
  const sketchImageInput = el('input', { type: 'file', accept: 'image/png,image/jpeg,image/webp,image/gif,image/svg+xml', class: 'mat-sr-only', tabindex: '-1', 'aria-hidden': 'true' });
  root.append(sketchImageInput);
  sketchImageInput.addEventListener('change', async () => {
    const file = sketchImageInput.files[0];
    sketchImageInput.value = '';
    if (file && state.mode === 'sketch') { try { await sketcher.setImage(file); } catch (e) { console.warn('MatShape: picture failed', e); toast(t('Sketch.Image.Failed'), 'danger'); } }
  });

  /** The cut of the parts (before the sketch) by the plane of the sketch, or their outline seen along its normal, as fixed curves of the sketch. */
  function useModel(kind) {
    const parts = state.dialog.input.parts.filter(p => !state.hidden.has(p.id));
    const frame = sketcher.frame;
    const loops = (kind === 'slice' ? sectionOf(state.kernel, parts, frame) : outlineOf(parts, frame)).flatMap(x => x.polygons);
    const added = sketcher.addUsed(loops.flatMap(loop => curvesFromPoints(loop, true)));
    toast(added ? t(kind === 'slice' ? 'Sketch.SliceAdded' : 'Sketch.OutlineAdded', added) : t(kind === 'slice' ? 'Sketch.SliceNone' : 'Sketch.OutlineNone'), added ? 'success' : 'warning');
  }

  // ---- the view: clicks and hover ------------------------------------------------------------------------------------------

  viewport.on('hover', e => {
    if (state.mode === 'sketch') return;
    if (state.mode === 'dialog' && state.dialog.activeEdges && !state.dialog.activePlane) {
      // an edge near the pointer, else the face under it (all its edges); some features take faces only
      const edge = state.dialog.activeEdges.facesOnly ? null : viewport.pickEdge(e.ndc);
      const face = edge ? null : viewport.pick(e.ndc);
      viewport.hover(face);
      markEdges(edge);
      viewport.canvas.style.cursor = edge || face ? 'pointer' : '';
      return;
    }
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
    if (state.kind === 'assembly' && state.mode === 'idle') { assemblyEditor.click(pick); return; }
    if (state.mode === 'dialog' && state.dialog.activeEdges) {
      const d = state.dialog, edge = d.activeEdges.facesOnly ? null : viewport.pickEdge(e.ndc);
      const round = p => p.map(x => Math.round(x * 1e4) / 1e4);
      if (edge) d.activeEdges.toggle({ part: edge.partId, faces: [faceKey(d.input, edge.faces[0]), faceKey(d.input, edge.faces[1])].sort(), at: round(edge.point) });
      else if (pick) d.activeEdges.toggle({ part: pick.partId, face: faceKey(d.input, pick.faceId), at: round(pick.point) });
      return;
    }
    if (state.mode === 'dialog') {
      if (pick && state.dialog.activeParts) state.dialog.activeParts.toggle(pick.partId);
      return;
    }
    if (pick) selectPart(pick.partId, e.shift || e.ctrl);
    else if (state.selection.size) { state.selection.clear(); viewport.setSelection(state.selection); renderParts(); ui.measure.hidden = true; }
  });

  viewport.on('context', () => { if (state.mode === 'pickplane') { closeModes(); } });

  /** The chosen edges of a fillet or chamfer and the edge under the pointer, drawn over the view. */
  function markEdges(hover) {
    const d = state.dialog;
    if (!d?.activeEdges) { viewport.setEdgeMarks(null); return; }
    const selected = (d.feature.params[d.activeEdges.key || 'edges'] || []).flatMap(ref => refPoints(ref, d.input));
    const part = hover && d.input.parts.find(p => p.id === hover.partId);
    viewport.setEdgeMarks({ selected, hover: part ? edgePoints(part, hover.segments) : [] });
  }

  /** The segments a reference of a fillet means, in the parts before it (like model.js finds them). */
  function refPoints(ref, input) {
    const part = input.parts.find(p => p.id === ref.part);
    if (!part?.mesh.edges) return [];
    const e = part.mesh.edges, name = n => faceKey(input, n), list = [];
    for (let i = 0; i < e.count; i++) {
      if (e.angle[i] <= TANGENT) continue;
      const a = name(e.faces[i * 2]), b = name(e.faces[i * 2 + 1]);
      if (ref.faces ? (a === ref.faces[0] && b === ref.faces[1]) || (a === ref.faces[1] && b === ref.faces[0]) : ref.face ? a === ref.face || b === ref.face : true) list.push(i);
    }
    if (ref.faces && ref.at && list.length > 1) {
      let best = list[0], dist = Infinity;
      for (const i of list) {
        const d = distToSegment3(ref.at, [e.pos[i * 6], e.pos[i * 6 + 1], e.pos[i * 6 + 2]], [e.pos[i * 6 + 3], e.pos[i * 6 + 4], e.pos[i * 6 + 5]]);
        if (d < dist) { dist = d; best = i; }
      }
      return edgePoints(part, edgeGroup(part, best));
    }
    return edgePoints(part, list);
  }

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
    const u = state.model.units;
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

  // ---- the section view (like OnShape): a plane cuts the parts, the side its normal points to is not drawn, the cut faces are hatched ------------------------

  const sectionUi = { panel: $('[data-section-panel]'), plane: $('[data-section-plane]'), range: $('[data-section-offset]'), value: $('[data-section-value]'), flip: $('[data-section-flip]') };

  function toggleSection(on = !state.section) {
    state.section = on ? state.section || { plane: 'std:front', offset: 0, flip: false } : null;
    sectionUi.panel.hidden = !on;
    root.querySelector('[data-action="section"]')?.setAttribute('aria-pressed', String(on));
    if (on) {
      const planes = state.result?.planes || [];
      sectionUi.plane.replaceChildren(...['top', 'front', 'right'].map(n => el('option', { value: 'std:' + n }, t('Plane.' + n))), ...planes.map(p => el('option', { value: 'plane:' + p.fid }, featureName(p.fid))));
      if (![...sectionUi.plane.options].some(o => o.value === state.section.plane)) state.section.plane = 'std:front';
      sectionUi.plane.value = state.section.plane;
      sectionUi.flip.setAttribute('aria-pressed', String(state.section.flip));
    }
    updateSection();
  }

  /** The plane of the section view; its normal points to the side that is cut away. */
  function sectionFrame() {
    const s = state.section;
    const base = s.plane.startsWith('std:') ? STANDARD_PLANES[s.plane.slice(4)] : state.result?.planes.find(p => 'plane:' + p.fid === s.plane)?.frame;
    return base ? { base, frame: offsetFrame(base, s.offset, s.flip) } : null;
  }

  function updateSection() {
    if (!state.section || !state.result) { viewport.setSection(null); return; }
    const plane = sectionFrame();
    if (!plane) { viewport.setSection(null); return; }
    // the slider spans the parts along the normal of the plane
    let lo = Infinity, hi = -Infinity;
    for (const p of state.result.parts) {
      const box = p.manifold.boundingBox();
      for (let k = 0; k < 8; k++) {
        const c = [k & 1 ? box.max[0] : box.min[0], k & 2 ? box.max[1] : box.min[1], k & 4 ? box.max[2] : box.min[2]];
        const d = v3.dot(v3.sub(c, plane.base.o), plane.base.n);
        lo = Math.min(lo, d); hi = Math.max(hi, d);
      }
    }
    if (!(hi > lo)) { lo = -50; hi = 50; }
    const u = unit();
    sectionUi.range.min = String(Math.floor(lo / u)); sectionUi.range.max = String(Math.ceil(hi / u));
    sectionUi.range.step = String(Math.max(0.01, Math.pow(10, Math.floor(Math.log10((hi - lo) / u)) - 2)));
    sectionUi.range.value = String(state.section.offset / u);
    if (document.activeElement !== sectionUi.value) sectionUi.value.value = fmt(state.section.offset / u, 2);
    const parts = state.result.parts.filter(p => !state.hidden.has(p.id));
    viewport.setSection({ frame: plane.frame, caps: sectionOf(state.kernel, parts, plane.frame) });
  }

  sectionUi.plane.addEventListener('change', () => { state.section.plane = sectionUi.plane.value; state.section.offset = 0; updateSection(); });
  sectionUi.range.addEventListener('input', () => { state.section.offset = Number(sectionUi.range.value) * unit(); updateSection(); });
  sectionUi.value.addEventListener('change', () => {
    const v = Number(sectionUi.value.value.replace(',', '.'));
    if (Number.isFinite(v)) { state.section.offset = v * unit(); updateSection(); }
  });
  sectionUi.value.addEventListener('keydown', e => { if (e.key === 'Enter') sectionUi.value.dispatchEvent(new Event('change')); });
  sectionUi.flip.addEventListener('click', () => { state.section.flip = !state.section.flip; sectionUi.flip.setAttribute('aria-pressed', String(state.section.flip)); updateSection(); });
  $('[data-section-close]').addEventListener('click', () => toggleSection(false));

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
    for (const s of state.model.studios) {
      const active = state.studio?.id === s.id;
      const kind = kindOf(s.id === state.studio?.id ? state.content : s.content);
      const tab = el('div', { class: 'ms-tab' + (active ? ' is-active' : '') },
        el('button', { type: 'button', class: 'ms-tab__btn', role: 'tab', 'aria-selected': active ? 'true' : 'false' }, icon(kind === 'drawing' ? 'drawing' : kind === 'assembly' ? 'assembly' : 'studio'), el('span', null, s.name)));
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
        state.model.studios.push(copy);
        await openStudio(copy.id);
      } else if (action === 'left' || action === 'right') {
        await request('POST', `/live/studios/${s.id}/move`, { step: action === 'left' ? -1 : 1 });
        const list = state.model.studios, i = list.indexOf(s), j = i + (action === 'left' ? -1 : 1);
        if (j >= 0 && j < list.length) [list[i], list[j]] = [list[j], list[i]];
        renderTabs();
      } else if (action === 'delete') {
        if (state.model.studios.length <= 1) { toast(t('Tabs.LastOne'), 'warning'); return; }
        if (!await window.MatUi.confirm(t('Tabs.DeleteConfirm', s.name), { danger: true, ok: t('Tabs.Delete') })) return;
        await request('DELETE', `/live/studios/${s.id}`);
        writeLocal('pending.' + s.id, null);
        state.model.studios = state.model.studios.filter(x => x !== s);
        state.studio = null;
        await openStudio(state.model.studios[0].id);
      }
    } catch { toast(t('Tabs.Failed'), 'danger'); }
  }

  /** A new tab: a Part Studio, a drawing (of the open Part Studio, or with the settings given) or an assembly. */
  async function addStudio(kind = 'studio', drawing = null) {
    try {
      await flushSave();
      const count = state.model.studios.filter(s => kindOf(s.content) === kind).length + 1;
      const name = kind === 'drawing' ? t('Tabs.DrawingName', count) : kind === 'assembly' ? t('Tabs.AssemblyName', count) : undefined;
      const source = state.kind === 'studio' ? state.studio?.id : state.model.studios.find(s => kindOf(s.content) === 'studio')?.id;
      const studio = await request('POST', `/live/models/${modelId}/studios`, { name, kind: kind === 'studio' ? null : kind });
      if (kind === 'drawing') {
        const content = { ...studio.content, drawing: drawing || { source } };
        const answer = await request('PUT', `/live/studios/${studio.id}`, { revision: studio.revision, content });
        studio.revision = answer.revision;
        studio.content = content;
      }
      state.model.studios.push(studio);
      await openStudio(studio.id);
      if (kind === 'studio') viewport.fit(true);
    } catch { toast(t('Tabs.Failed'), 'danger'); }
  }
  menu('ms-add-menu', [['studio', 'studio', t('Tabs.NewStudio')], ['drawing', 'drawing', t('Tabs.NewDrawing')], ['assembly', 'assembly', t('Tabs.NewAssembly')]], kind => addStudio(kind));

  // ---- versions, export ----------------------------------------------------------------------------------------------------

  async function createVersion() {
    const name = await window.MatUi.prompt(t('Version.NameLabel'), { title: t('Version.Create'), value: t('Version.DefaultName', new Date().toLocaleString(document.documentElement.lang)) });
    if (!name || !name.trim()) return;
    try {
      await flushSave();
      await request('POST', `/live/models/${modelId}/versions`, { name: name.trim() });
      toast(t('Version.Created', name.trim()), 'success');
    } catch { toast(t('Version.Failed'), 'danger'); }
  }

  async function exportAs(kind) {
    const parts = (state.result?.parts || []).filter(p => !state.hidden.has(p.id));
    const name = state.model.name + (state.model.studios.length > 1 ? ' - ' + state.studio.name : '');
    if (kind === 'json') { download(fileName(name, 'matshape.json'), JSON.stringify({ format: 'MatShape Part Studio 1', units: state.model.units, content: state.content }, null, 2), 'application/json'); return; }
    if (kind === 'png') { const png = await viewport.image(); if (png) download(fileName(name, 'png'), png); return; }
    if (kind === 'drawing') { openDrawing(); return; }
    if (kind === 'step') {
      const all = state.kind === 'assembly' ? assemblyEditor.parts().map(p => ({ mesh: { vertProperties: p.mesh.positions, triVerts: Uint32Array.from({ length: p.mesh.positions.length / 3 }, (_, i) => i), numProp: 3, faceID: p.mesh.faceIds }, name: p.name, color: p.color })) : parts.map(p => ({ manifold: p.manifold, name: partName(p), color: p.color }));
      if (!all.length) { toast(t('Export.Empty'), 'warning'); return; }
      download(fileName(name, 'step'), toStep(all, name), 'application/step');
      return;
    }
    if (state.kind === 'assembly' && ['stl', 'obj', '3mf'].includes(kind)) {
      const all = assemblyEditor.parts();
      if (!all.length) { toast(t('Export.Empty'), 'warning'); return; }
      if (kind === 'stl') download(fileName(name, 'stl'), toStl(all, name));
      else if (kind === 'obj') download(fileName(name, 'obj'), toObj(all, all.map(p => p.name)));
      else download(fileName(name, '3mf'), toThreeMf(all, all.map(p => p.name), name));
      return;
    }
    if (!parts.length) { toast(t('Export.Empty'), 'warning'); return; }
    if (kind === 'stl') download(fileName(name, 'stl'), toStl(parts, name));
    else if (kind === 'obj') download(fileName(name, 'obj'), toObj(parts, parts.map(partName)));
    else if (kind === '3mf') download(fileName(name, '3mf'), toThreeMf(parts, parts.map(partName), name));
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
    const roll = e.target.closest('[data-roll]');
    if (roll) { viewport.roll(Number(roll.dataset.roll)); return; }
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
    else if (action === 'planes') togglePlanes();
    else if (action === 'section') toggleSection();
    else if (action === 'side') toggleSide();
    else if (action === 'ai') assistant?.open();
    else if (action === 'image') openImage();
    else if (action === 'mesh') openMesh();
    else if (action === 'import') importInput.click();
    else if (action === 'drawing') openDrawing();
    else if (action === 'keys') openKeys();
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

  // ---- keyboard: the shortcuts of OnShape (the list: Services/KeyMap.cs, the dialog "?") -----------------------------------
  const NAMED_VIEWS = { Digit1: 'front', Digit2: 'back', Digit3: 'left', Digit4: 'right', Digit5: 'top', Digit6: 'bottom', Digit7: 'iso' };
  const SKETCH_TOOLS = { l: 'line', g: 'rect', c: 'circle', a: 'arc', d: 'dimension', u: 'use', m: 'trim', o: 'offset', t: 'tarc' };
  const ARROWS = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] };

  document.addEventListener('keydown', e => {
    const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName) || e.target.isContentEditable;
    if (document.querySelector('dialog[open]')) return;
    const ctrl = e.ctrlKey || e.metaKey;
    const key = e.key.toLowerCase();
    if (ctrl && key === 'z' && !typing) { e.preventDefault(); if (e.shiftKey) redo(); else undo(); return; }
    if (ctrl && key === 'y' && !typing) { e.preventDefault(); redo(); return; }
    if (typing) return;
    if (e.key === 'Escape') {
      if (state.mode === 'sketch') sketcher.escape();
      else if (state.mode === 'dialog') cancelDialog();
      else closeModes();
      return;
    }
    if (e.key === '?') { e.preventDefault(); openKeys(); return; }

    // the view: Shift+1 … 7 the named views, arrows turn by 15° (with Shift by 90°), Alt+← → rolls
    if (e.shiftKey && !ctrl && !e.altKey && NAMED_VIEWS[e.code]) { e.preventDefault(); viewport.setView(NAMED_VIEWS[e.code]); return; }
    if (ARROWS[e.key] && !ctrl) {
      e.preventDefault();
      const [x, y] = ARROWS[e.key];
      if (e.altKey) { if (x) viewport.roll(-x * 15); return; }
      const step = e.shiftKey ? 90 : 15;
      viewport.turn(x * step, y * step);
      return;
    }

    if (state.mode === 'sketch') {
      // a value field of a dimension is open (the focus may still be on the view): keys go to it, Enter applies it
      if (sketcher.editor) { if (e.key === 'Enter') { e.preventDefault(); sketcher.applyEditor(); } else if (!ctrl && e.key.length === 1) sketcher.focusEditor(); return; }
      if (ctrl && key === 'a') { e.preventDefault(); sketcher.selectAll(); return; }
      if (ctrl) return;
      if (SKETCH_TOOLS[key] && !e.shiftKey) { sketcher.setTool(SKETCH_TOOLS[key]); return; }
      if (e.key === 'Delete' || e.key === 'Backspace') { sketcher.deleteSelected(); return; }
      if (key === 'q') { sketcher.toggleConstruction(); return; }
      if (key === 'h') { sketcher.constrain('horizontal'); return; }
      if (key === 'i') { sketcher.constrain('coincident'); return; }
      if (key === 'v') { sketcher.constrain('vertical'); return; }
      if (key === 'n') { viewport.normalTo(sketcher.frame); return; }
      if (e.key === 'Enter') { finishSketch(); return; }
    }
    if (state.mode === 'dialog' && e.key === 'Enter') { acceptDialog(); return; }
    if (ctrl || e.altKey || state.kind === 'drawing') return;
    if (state.kind === 'assembly' && e.shiftKey) return;
    if (key === 'f' && !e.shiftKey) viewport.fit();
    else if (key === 'p' && !e.shiftKey) togglePlanes();
    else if (key === 'm' && !e.shiftKey && state.mode !== 'sketch') toggleMeasure();
    else if (e.shiftKey && key === 's') newFeature('sketch');
    else if (e.shiftKey && key === 'e') newFeature('extrude');
    else if (e.shiftKey && key === 'w') newFeature('revolve');
    else if (e.shiftKey && key === 'f') newFeature('fillet');
  });

  function openKeys() { window.MatUi?.dialog?.open('ms-keys'); }

  function togglePlanes() {
    state.planes = !state.planes;
    root.querySelector('[data-action="planes"]')?.setAttribute('aria-pressed', String(state.planes));
    viewport.setPlanes(state.result?.planes, state.planes);
  }


  // ---- the colour scheme of the view (kept on this device) -----------------------------------------------------------------
  function applyViewTheme(name) {
    viewport.setTheme(name);
    document.querySelectorAll('#ms-theme-menu [data-view-theme]').forEach(b => b.setAttribute('aria-checked', String(b.dataset.viewTheme === viewport.themeName)));
    if (!state.result) return;
    if (state.mode === 'sketch') { regen(withDialogFeature()); sketcher.draw(); }
    else if (state.mode === 'dialog') preview();
    else regen();
  }
  applyViewTheme(readLocal('viewTheme') || 'auto');

  // ---- the 3D mouse (SpaceMouse through WebHID): connected once by the person, opened by itself after that ------------------
  const spaceButton = root.querySelector('[data-action="spacemouse"]');
  const spaceMenu = document.getElementById('ms-spacemouse-menu');
  const spaceMouse = new SpaceMouse({
    navigate: (motion, seconds) => viewport.navigate(motion, seconds),
    // the buttons: the two of every model (left: isometric, right: fit), the view keys of the larger ones (T, R, F)
    button: index => {
      const views = { 0: 'iso', 2: 'top', 4: 'right', 5: 'front' };
      if (index === 1) viewport.fit();
      else if (views[index]) viewport.setView(views[index]);
    },
    changed: device => {
      spaceButton?.setAttribute('aria-pressed', String(!!device));
      showSpaceMenu();
      if (device) toast(t('SpaceMouse.Connected', spaceMouse.name), 'success');
    },
  });
  spaceMouse.speed = SPEEDS[readLocal('spaceMouse.speed')] || 1;
  spaceMouse.mode = readLocal('spaceMouse.mode') === 'camera' ? 'camera' : 'object';
  function showSpaceMenu() {
    if (!spaceMenu) return;
    spaceMenu.querySelector('[data-spacemouse="connect"]').hidden = spaceMouse.connected;
    spaceMenu.querySelector('[data-spacemouse="disconnect"]').hidden = !spaceMouse.connected;
    spaceMenu.querySelectorAll('[data-spacemouse-speed]').forEach(b => b.setAttribute('aria-checked', String((readLocal('spaceMouse.speed') || 'normal') === b.dataset.spacemouseSpeed)));
    spaceMenu.querySelectorAll('[data-spacemouse-mode]').forEach(b => b.setAttribute('aria-checked', String(spaceMouse.mode === b.dataset.spacemouseMode)));
  }
  if (spaceMouseSupported() && spaceButton) {
    spaceButton.hidden = false;
    showSpaceMenu();
    spaceMouse.reconnect().catch(() => {});
    spaceMenu?.addEventListener('click', async e => {
      const item = e.target.closest('[data-spacemouse], [data-spacemouse-speed], [data-spacemouse-mode]');
      if (!item) return;
      if (item.dataset.spacemouse === 'connect') {
        // the browser asks which device (this click is the gesture it needs)
        try { if (!await spaceMouse.connect()) return; } catch (err) { console.warn('MatShape: 3D mouse', err); toast(t('SpaceMouse.Failed'), 'danger'); }
      } else if (item.dataset.spacemouse === 'disconnect') {
        await spaceMouse.disconnect();
      } else if (item.dataset.spacemouseSpeed) {
        writeLocal('spaceMouse.speed', item.dataset.spacemouseSpeed);
        spaceMouse.speed = SPEEDS[item.dataset.spacemouseSpeed] || 1;
      } else if (item.dataset.spacemouseMode) {
        writeLocal('spaceMouse.mode', item.dataset.spacemouseMode);
        spaceMouse.mode = item.dataset.spacemouseMode;
      }
      showSpaceMenu();
    });
  }
  document.getElementById('ms-theme-menu')?.addEventListener('click', e => {
    const item = e.target.closest('[data-view-theme]');
    if (!item) return;
    writeLocal('viewTheme', item.dataset.viewTheme);
    applyViewTheme(item.dataset.viewTheme);
  });
  // ---- folding a dialog away (the sketch panel and the feature dialog), remembered on this device --------------------------
  function fold(section, folded) {
    section.classList.toggle('is-folded', folded);
    const button = section.querySelector('[data-fold]');
    button?.setAttribute('aria-expanded', String(!folded));
    button?.querySelector('use')?.setAttribute('href', '#mat-i-' + (folded ? 'chevron-down' : 'chevron-up'));
  }
  root.querySelectorAll('[data-collapsible]').forEach(section => {
    const name = section.hasAttribute('data-sketch-panel') ? 'sketch' : 'dialog';
    fold(section, readLocal('fold.' + name) === true);
    section.querySelector('[data-fold]')?.addEventListener('click', () => {
      const folded = !section.classList.contains('is-folded');
      fold(section, folded);
      writeLocal('fold.' + name, folded);
    });
  });

  // the theme changes the colours of the edges
  new MutationObserver(() => { applyViewTheme(viewport.themeName); viewCube.build(); }).observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
  window.matchMedia('(prefers-color-scheme: dark)').addEventListener?.('change', () => viewport.applyDisplay());

  window.addEventListener('beforeunload', e => {
    if (state.dirty && !navigator.onLine) return;
    if (state.dirty) { flushSave(); e.preventDefault(); }
  });

  load();
}
