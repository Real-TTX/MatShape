/* MatShape – the dialogs of the features: one form per kind, built from a few kinds of fields (expression, choice, switch, parts, plane, sketch + profiles,
   revolve axis). Every change writes into the parameters of the feature and asks for a new preview; the dialog never touches the model itself. */

import { el, icon, swatch, t, uid } from './util.js';
import { evalAngle, evalLength, evalNumber, errorKey } from './expr.js';

/**
 * Builds the form of a feature into `form`.
 * ctx: { feature, input (the result before the feature: parts, sketches, planes, variables), units, unit, changed(), activateParts(field), activatePlane(field), partName(part) }
 */
export function buildDialog(form, ctx) {
  form.replaceChildren();
  const f = ctx.feature;
  const p = f.params;
  const add = (...nodes) => nodes.forEach(n => n && form.append(n));
  const fields = { parts: [] };

  add(text(t('Dialog.Name'), f.name, v => { f.name = v.trim() || f.name; ctx.changed(false); }));

  switch (f.type) {
    case 'extrude':
      add(sketchField(ctx, p), profilesField(ctx, p));
      add(segment(t('Dialog.Operation'), p.op, OPS, v => { p.op = v; refreshScope(); ctx.changed(); }));
      add(choice(t('Dialog.End'), p.end, [['blind', t('Dialog.End.blind')], ['symmetric', t('Dialog.End.symmetric')], ['through', t('Dialog.End.through')]], v => { p.end = v; depth.hidden = v === 'through'; flip.hidden = v !== 'blind'; ctx.changed(); }));
      var depth = expr(t('Dialog.Depth'), p.depth, 'length', ctx, v => { p.depth = v; });
      var flip = check(t('Dialog.Flip'), p.flip, v => { p.flip = v; ctx.changed(); }, 'flip');
      depth.hidden = p.end === 'through';
      flip.hidden = p.end !== 'blind';
      add(depth, flip);
      var scope = partsField(ctx, p.scope || [], t('Dialog.Scope'), ids => { p.scope = ids.length ? ids : null; }, t('Dialog.Scope.Hint'));
      add(scope.node);
      fields.parts.push(scope);
      var refreshScope = () => { scope.node.hidden = p.op === 'new'; };
      refreshScope();
      break;

    case 'revolve':
      add(sketchField(ctx, p, () => axisRefresh()), profilesField(ctx, p));
      var axis = axisField(ctx, p);
      var axisRefresh = () => axis.refresh();
      add(axis.node);
      add(segment(t('Dialog.Operation'), p.op, OPS, v => { p.op = v; refreshScope2(); ctx.changed(); }));
      add(expr(t('Dialog.Angle'), p.angle, 'angle', ctx, v => { p.angle = v; }));
      add(check(t('Dialog.Symmetric'), p.symmetric, v => { p.symmetric = v; ctx.changed(); }));
      add(check(t('Dialog.Flip'), p.flip, v => { p.flip = v; ctx.changed(); }, 'flip'));
      var scope2 = partsField(ctx, p.scope || [], t('Dialog.Scope'), ids => { p.scope = ids.length ? ids : null; }, t('Dialog.Scope.Hint'));
      add(scope2.node);
      fields.parts.push(scope2);
      var refreshScope2 = () => { scope2.node.hidden = p.op === 'new'; };
      refreshScope2();
      break;

    case 'plane':
      add(planeField(ctx, p.base, t('Dialog.BasePlane'), ref => { p.base = ref; }, fields));
      add(expr(t('Dialog.Offset'), p.offset, 'length', ctx, v => { p.offset = v; }));
      add(check(t('Dialog.Flip'), p.flip, v => { p.flip = v; ctx.changed(); }, 'flip'));
      break;

    case 'boolean': {
      add(segment(t('Dialog.Operation'), p.op, [['union', t('Dialog.Bool.union'), 'union'], ['subtract', t('Dialog.Bool.subtract'), 'subtract'], ['intersect', t('Dialog.Bool.intersect'), 'intersect']], v => { p.op = v; tools.node.hidden = false; ctx.changed(); }));
      const targets = partsField(ctx, p.targets, t('Dialog.Targets'), ids => { p.targets = ids; }, t('Dialog.Targets.Hint'));
      const tools = partsField(ctx, p.tools, t('Dialog.Tools'), ids => { p.tools = ids; }, t('Dialog.Tools.Hint'));
      add(targets.node, tools.node, check(t('Dialog.KeepTools'), p.keep, v => { p.keep = v; ctx.changed(); }));
      fields.parts.push(targets, tools);
      break;
    }

    case 'transform': {
      const parts = partsField(ctx, p.parts, t('Dialog.Parts'), ids => { p.parts = ids; });
      add(parts.node);
      fields.parts.push(parts);
      add(pair(expr('ΔX', p.dx, 'length', ctx, v => { p.dx = v; }), expr('ΔY', p.dy, 'length', ctx, v => { p.dy = v; })));
      add(pair(expr('ΔZ', p.dz, 'length', ctx, v => { p.dz = v; }), choice(t('Dialog.Axis'), p.axis, AXES, v => { p.axis = v; ctx.changed(); })));
      add(expr(t('Dialog.Rotate'), p.angle, 'angle', ctx, v => { p.angle = v; }));
      add(check(t('Dialog.Copy'), p.copy, v => { p.copy = v; ctx.changed(); }, 'copy'));
      break;
    }

    case 'mirror': {
      const parts = partsField(ctx, p.parts, t('Dialog.Parts'), ids => { p.parts = ids; });
      add(parts.node, planeField(ctx, p.plane, t('Dialog.MirrorPlane'), ref => { p.plane = ref; }, fields));
      add(check(t('Dialog.Merge'), p.merge, v => { p.merge = v; ctx.changed(); }));
      fields.parts.push(parts);
      break;
    }

    case 'lpattern': {
      const parts = partsField(ctx, p.parts, t('Dialog.Parts'), ids => { p.parts = ids; });
      add(parts.node);
      fields.parts.push(parts);
      add(pair(choice(t('Dialog.Direction'), p.dir, AXES, v => { p.dir = v; ctx.changed(); }), check(t('Dialog.Flip'), p.flip, v => { p.flip = v; ctx.changed(); }, 'flip')));
      add(pair(expr(t('Dialog.Distance'), p.distance, 'length', ctx, v => { p.distance = v; }), expr(t('Dialog.Count'), p.count, 'count', ctx, v => { p.count = v; })));
      add(check(t('Dialog.Merge'), p.merge, v => { p.merge = v; ctx.changed(); }));
      break;
    }

    case 'cpattern': {
      const parts = partsField(ctx, p.parts, t('Dialog.Parts'), ids => { p.parts = ids; });
      add(parts.node);
      fields.parts.push(parts);
      add(choice(t('Dialog.Axis'), p.axis, AXES, v => { p.axis = v; ctx.changed(); }));
      add(pair(expr(t('Dialog.Count'), p.count, 'count', ctx, v => { p.count = v; }), expr(t('Dialog.TotalAngle'), p.angle, 'angle', ctx, v => { p.angle = v; })));
      add(check(t('Dialog.Merge'), p.merge, v => { p.merge = v; ctx.changed(); }));
      break;
    }

    case 'split': {
      const parts = partsField(ctx, p.parts, t('Dialog.Parts'), ids => { p.parts = ids; });
      add(parts.node, planeField(ctx, p.plane, t('Dialog.SplitPlane'), ref => { p.plane = ref; }, fields));
      add(choice(t('Dialog.Keep'), p.keep, [['both', t('Dialog.Keep.both')], ['front', t('Dialog.Keep.front')], ['back', t('Dialog.Keep.back')]], v => { p.keep = v; ctx.changed(); }));
      fields.parts.push(parts);
      break;
    }

    case 'deletepart': {
      const parts = partsField(ctx, p.parts, t('Dialog.Parts'), ids => { p.parts = ids; });
      add(parts.node);
      fields.parts.push(parts);
      break;
    }

    case 'variable':
      add(text(t('Dialog.VariableName'), p.name, v => { p.name = v.trim().replace(/^#/, ''); ctx.changed(); }, '#'));
      add(expr(t('Dialog.Value'), p.value, 'variable', ctx, v => { p.value = v; }));
      add(el('p', { class: 'ms-dialog__text ms-muted' }, t('Dialog.Variable.Hint')));
      break;

    case 'fillet':
    case 'chamfer': {
      fields.edges = edgesField(ctx, p);
      add(fields.edges.node);
      if (f.type === 'fillet') {
        add(expr(t('Dialog.Radius'), p.radius, 'length', ctx, v => { p.radius = v; }));
        break;
      }
      const two = () => (p.mode || 'equal') === 'two';
      add(choice(t('Dialog.ChamferType'), p.mode || 'equal', [['equal', t('Dialog.Chamfer.equal')], ['two', t('Dialog.Chamfer.two')]], v => { p.mode = v; second.hidden = flip.hidden = !two(); ctx.changed(); }));
      add(expr(t('Dialog.Distance'), p.distance, 'length', ctx, v => { p.distance = v; }));
      const second = expr(t('Dialog.Distance2'), p.distance2 ?? p.distance, 'length', ctx, v => { p.distance2 = v; });
      const flip = check(t('Dialog.Flip'), p.flip, v => { p.flip = v; ctx.changed(); }, 'flip');
      second.hidden = flip.hidden = !two();
      add(second, flip);
      break;
    }
  }

  // the edges of a fillet or chamfer, else the first parts field, take the clicks in the view
  if (fields.edges) ctx.activateEdges(fields.edges);
  else if (fields.parts.length) ctx.activateParts(fields.parts[0]);
  return fields;
}

/** The same reference (the same edge, face or part)? */
export function sameRef(a, b) {
  if (a.part !== b.part) return false;
  if (a.faces || b.faces) return !!(a.faces && b.faces) && [...a.faces].sort().join('|') === [...b.faces].sort().join('|');
  return (a.face || null) === (b.face || null);
}

/** The edges of a fillet or chamfer: picked in the view (an edge, or a face for all its edges), or every edge of a part from the list. */
function edgesField(ctx, p) {
  if (!Array.isArray(p.edges)) p.edges = [];
  const list = el('ul', { class: 'ms-edgelist' });
  const parts = el('select', { class: 'mat-select mat-select--sm mat-input--sm', 'aria-label': t('Dialog.WholePart') });
  const addPart = el('button', { type: 'button', class: 'mat-btn mat-btn--secondary mat-btn--sm' }, icon('plus'), el('span', null, t('Dialog.WholePart')));
  const node = el('fieldset', { class: 'mat-field ms-field-sm ms-fieldset ms-partsfield' }, el('legend', { class: 'mat-label' }, t('Dialog.Edges')), list,
    el('p', { class: 'mat-hint' }, t('Dialog.Edges.Hint')), el('div', { class: 'ms-dialog__pickrow' }, parts, addPart));
  const field = {
    node,
    toggle(ref) {
      const i = p.edges.findIndex(r => sameRef(r, ref));
      if (i >= 0) p.edges.splice(i, 1); else p.edges.push(ref);
      render();
      ctx.changed();
      ctx.edgesChanged?.();
    },
    activate(on) { node.classList.toggle('is-active', on); },
  };
  const render = () => {
    list.replaceChildren();
    const count = { edge: 0, face: 0 };
    if (!p.edges.length) list.append(el('li', { class: 'ms-edgelist__empty ms-muted' }, t('Dialog.NoEdges')));
    p.edges.forEach(ref => {
      const kind = ref.faces ? 'edge' : ref.face ? 'face' : 'part';
      const part = ctx.input.parts.find(x => x.id === ref.part);
      const name = kind === 'part' ? t('Dialog.AllEdgesOf', part ? ctx.partName(part) : ref.part) : t(kind === 'edge' ? 'Dialog.Edge' : 'Dialog.Face', ++count[kind]);
      const remove = el('button', { type: 'button', class: 'mat-btn mat-btn--ghost mat-btn--icon mat-btn--sm', 'aria-label': t('Dialog.RemoveEdge', name), 'data-tip': t('Dialog.RemoveEdge', name) }, icon('x'));
      remove.addEventListener('click', () => field.toggle(ref));
      list.append(el('li', { class: 'ms-edgelist__item' }, icon(kind === 'edge' ? 'edge' : kind === 'face' ? 'face' : 'part'), el('span', null, name), remove));
    });
  };
  for (const part of ctx.input.parts) parts.append(el('option', { value: part.id }, ctx.partName(part)));
  parts.disabled = addPart.disabled = !ctx.input.parts.length;
  addPart.addEventListener('click', () => { if (parts.value && !p.edges.some(r => sameRef(r, { part: parts.value }))) field.toggle({ part: parts.value }); });
  render();
  node.addEventListener('focusin', () => ctx.activateEdges(field));
  return field;
}

const OPS = [['new', t('Dialog.Op.new'), 'part'], ['add', t('Dialog.Op.add'), 'union'], ['remove', t('Dialog.Op.remove'), 'subtract'], ['intersect', t('Dialog.Op.intersect'), 'intersect']];
const AXES = [['x', 'X'], ['y', 'Y'], ['z', 'Z']];

// ---- fields ----------------------------------------------------------------------------------------------------------------

function label(id, text) { return el('label', { class: 'mat-label', for: id }, text); }

function wrap(id, caption, control, hint) {
  return el('div', { class: 'mat-field ms-field-sm' }, label(id, caption), control, hint ? el('p', { class: 'mat-hint' }, hint) : null);
}

function pair(a, b) { return el('div', { class: 'ms-dialog__pair' }, a, b); }

function text(caption, value, apply, prefix) {
  const id = uid('d');
  const input = el('input', { class: 'mat-input mat-input--sm', id, value: value || '', autocomplete: 'off', spellcheck: 'false', maxlength: 120 });
  input.addEventListener('input', () => apply(input.value));
  return wrap(id, caption, prefix ? el('div', { class: 'ms-prefixed' }, el('span', { class: 'ms-prefixed__mark mat-mono' }, prefix), input) : input);
}

/** An expression: a length, an angle, a count or the value of a variable. Shows the value it means, or what is wrong. */
function expr(caption, value, kind, ctx, apply) {
  const id = uid('d');
  const input = el('input', { class: 'mat-input mat-input--sm mat-mono', id, value: value ?? '', autocomplete: 'off', spellcheck: 'false', inputmode: 'text' });
  const out = el('p', { class: 'ms-expr-out mat-mono' });
  const node = el('div', { class: 'mat-field ms-field-sm' }, label(id, caption), input, out);
  const show = () => {
    try {
      const v = input.value;
      let shown;
      if (kind === 'length') shown = fmtLen(evalLength(v, ctx.input.variables, ctx.unit), ctx);
      else if (kind === 'angle') shown = round(evalAngle(v, ctx.input.variables)) + '°';
      else if (kind === 'count') shown = String(Math.round(evalNumber(v, ctx.input.variables)));
      else shown = '';
      out.textContent = /^[-+]?\d*\.?\d+$/.test(v.trim()) ? '' : shown ? '= ' + shown : '';
      out.classList.remove('is-error');
      node.classList.remove('is-invalid');
      return true;
    } catch (e) {
      const [key, ...args] = errorKey(e);
      out.textContent = t(key, ...args);
      out.classList.add('is-error');
      node.classList.add('is-invalid');
      return false;
    }
  };
  input.addEventListener('input', () => { apply(input.value); show(); ctx.changed(); });
  if (kind !== 'variable') show();
  return node;
}

function fmtLen(mm, ctx) { return round(mm / ctx.unit) + ' ' + ctx.units; }

function round(v) { return String(Math.round(v * 10000) / 10000); }

function choice(caption, value, options, apply) {
  const id = uid('d');
  const select = el('select', { class: 'mat-select mat-select--sm mat-input--sm', id });
  for (const [v, text] of options) select.append(el('option', { value: v, selected: v === value }, text));
  select.addEventListener('change', () => apply(select.value));
  return wrap(id, caption, select);
}

function segment(caption, value, options, apply) {
  const group = el('div', { class: 'mat-seg ms-seg', role: 'group', 'aria-label': caption });
  for (const [v, text, ic] of options) {
    const b = el('button', { type: 'button', class: 'mat-seg__btn', 'aria-pressed': v === value ? 'true' : 'false', 'data-tip': text, 'aria-label': text }, ic ? icon(ic) : null, ic ? null : text);
    b.addEventListener('click', () => {
      group.querySelectorAll('button').forEach(x => x.setAttribute('aria-pressed', x === b ? 'true' : 'false'));
      apply(v);
    });
    group.append(b);
  }
  return el('div', { class: 'mat-field ms-field-sm' }, el('span', { class: 'mat-label' }, caption), group);
}

function check(caption, value, apply, ic) {
  const input = el('input', { type: 'checkbox', checked: !!value });
  input.addEventListener('change', () => apply(input.checked));
  return el('label', { class: 'mat-check ms-check' }, input, el('span', { class: 'mat-check__text' }, ic ? icon(ic) : null, ' ', caption));
}

/** The sketch a feature uses: the sketches before it. */
function sketchField(ctx, p, after) {
  const sketches = ctx.input.sketches;
  if (!p.sketch && sketches.length) p.sketch = sketches[sketches.length - 1].fid;
  const options = sketches.map(s => [s.fid, ctx.featureName(s.fid)]);
  if (!options.length) options.push(['', t('Dialog.NoSketches')]);
  return choice(t('Dialog.Sketch'), p.sketch || '', options, v => { p.sketch = v || null; p.profiles = null; ctx.rebuild(); after?.(); });
}

/** The profiles of the sketch (all when none is ticked). */
function profilesField(ctx, p) {
  const sketch = ctx.input.sketches.find(s => s.fid === p.sketch);
  const node = el('fieldset', { class: 'mat-field ms-field-sm ms-fieldset' }, el('legend', { class: 'mat-label' }, t('Dialog.Profiles')));
  if (!sketch || !sketch.loops.length) {
    node.append(el('p', { class: 'ms-expr-out is-error' }, t('Dialog.NoProfiles')));
    return node;
  }
  const list = el('div', { class: 'ms-checklist' });
  sketch.loops.forEach((loop, i) => {
    const input = el('input', { type: 'checkbox', checked: !p.profiles || p.profiles.includes(loop.key) });
    input.addEventListener('change', () => {
      const ticked = [...list.querySelectorAll('input')].map((x, k) => (x.checked ? sketch.loops[k].key : null)).filter(Boolean);
      p.profiles = ticked.length === sketch.loops.length ? null : ticked;
      ctx.changed();
    });
    list.append(el('label', { class: 'mat-check ms-check' }, input, el('span', { class: 'mat-check__text' }, t('Dialog.Profile', i + 1))));
  });
  node.append(list);
  return node;
}

/** The axis of a revolve: the axes of the sketch or one of its lines. */
function axisField(ctx, p) {
  const id = uid('d');
  const select = el('select', { class: 'mat-select mat-select--sm mat-input--sm', id });
  const refresh = () => {
    const sketch = ctx.input.sketches.find(s => s.fid === p.sketch);
    select.replaceChildren(el('option', { value: 'y' }, t('Dialog.Axis.SketchY')), el('option', { value: 'x' }, t('Dialog.Axis.SketchX')));
    (sketch?.entities || []).filter(e => e.t === 'line').forEach((e, i) => select.append(el('option', { value: e.id }, t('Dialog.Axis.Line', i + 1) + (e.cons ? ' · ' + t('Sketch.Construction') : ''))));
    if (![...select.options].some(o => o.value === p.axis)) p.axis = 'y';
    select.value = p.axis;
  };
  refresh();
  select.addEventListener('change', () => { p.axis = select.value; ctx.changed(); });
  return { node: wrap(id, t('Dialog.Axis'), select), refresh };
}

/** A plane: the standard planes, the planes of Plane features before this one, or a flat face picked in the view. */
function planeField(ctx, value, caption, apply, fields) {
  const id = uid('d');
  const select = el('select', { class: 'mat-select mat-select--sm mat-input--sm', id });
  let current = value;
  const fill = () => {
    select.replaceChildren(
      el('option', { value: 'std:top' }, t('Plane.top')),
      el('option', { value: 'std:front' }, t('Plane.front')),
      el('option', { value: 'std:right' }, t('Plane.right')),
      ...ctx.input.planes.map(pl => el('option', { value: 'plane:' + pl.fid }, ctx.featureName(pl.fid))),
    );
    if (current?.kind === 'face') select.append(el('option', { value: 'face' }, t('Plane.face')));
    select.value = current?.kind === 'std' ? 'std:' + current.name : current?.kind === 'plane' ? 'plane:' + current.id : current?.kind === 'face' ? 'face' : 'std:top';
  };
  fill();
  select.addEventListener('change', () => {
    const v = select.value;
    if (v.startsWith('std:')) current = { kind: 'std', name: v.slice(4) };
    else if (v.startsWith('plane:')) current = { kind: 'plane', id: v.slice(6) };
    apply(current);
    ctx.changed();
  });
  const pick = el('button', { type: 'button', class: 'mat-btn mat-btn--secondary mat-btn--sm', 'aria-pressed': 'false' }, icon('target'), el('span', null, t('Dialog.PickFace')));
  const field = {
    set(ref) { current = ref; apply(ref); fill(); ctx.changed(); pick.setAttribute('aria-pressed', 'false'); },
    button: pick,
  };
  pick.addEventListener('click', () => { const on = pick.getAttribute('aria-pressed') !== 'true'; pick.setAttribute('aria-pressed', on ? 'true' : 'false'); ctx.activatePlane(on ? field : null); });
  fields.plane = field;
  return el('div', { class: 'mat-field ms-field-sm' }, label(id, caption), el('div', { class: 'ms-dialog__pickrow' }, select, pick));
}

/** A choice of parts: a list to tick, and clicks on parts in the view while the field is active. */
function partsField(ctx, ids, caption, apply, hint) {
  const chosen = new Set(ids || []);
  const list = el('div', { class: 'ms-checklist ms-checklist--parts' });
  const node = el('fieldset', { class: 'mat-field ms-field-sm ms-fieldset ms-partsfield' }, el('legend', { class: 'mat-label' }, caption), list, hint ? el('p', { class: 'mat-hint' }, hint) : null);
  const field = {
    node,
    chosen,
    toggle(id) { if (chosen.has(id)) chosen.delete(id); else chosen.add(id); render(); apply([...chosen]); ctx.changed(); },
    activate(on) { node.classList.toggle('is-active', on); },
  };
  const render = () => {
    list.replaceChildren();
    if (!ctx.input.parts.length) { list.append(el('p', { class: 'ms-expr-out is-error' }, t('Dialog.NoParts'))); return; }
    for (const part of ctx.input.parts) {
      const input = el('input', { type: 'checkbox', checked: chosen.has(part.id) });
      input.addEventListener('change', () => field.toggle(part.id));
      list.append(el('label', { class: 'mat-check ms-check' }, input, swatch(part.color), el('span', { class: 'mat-check__text' }, ctx.partName(part))));
    }
  };
  render();
  node.addEventListener('focusin', () => ctx.activateParts(field));
  node.addEventListener('click', () => ctx.activateParts(field));
  return field;
}
