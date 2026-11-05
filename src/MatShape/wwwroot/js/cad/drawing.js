/* MatShape – a technical drawing of the parts (like the drawings of OnShape), in first-angle projection after ISO 128 / DIN ISO 5456: the front view, the top view
   below it, the view from the left to the right of it, an isometric view and a section A–A; visible edges thick, hidden edges thin and dashed, cut faces hatched,
   the overall dimensions, a title block. Everything is worked out here (no DOM, no kernel: tested in Node) as primitives in millimetres of the sheet (y down),
   which become SVG, DXF (R12) or PDF.
   Hidden lines: the triangles of a view are drawn into a depth buffer; every edge is sampled along its length and is visible where nothing lies in front of it. */

import { cross, dot, norm, topology } from './topo.js';
import { STANDARD_PLANES, offsetFrame, toWorld } from './geom.js';
import { sectionOf } from './model.js';

export const SHEETS = { A4: [297, 210], A3: [420, 297], A2: [594, 420], A1: [841, 594] };
export const SCALES = [[50, 1], [20, 1], [10, 1], [5, 1], [2, 1], [1, 1], [1, 2], [1, 5], [1, 10], [1, 20], [1, 50], [1, 100], [1, 200], [1, 500], [1, 1000]];
/** Edges whose faces bend less (radians) are tangent edges: not drawn (the contour of a round surface is drawn instead). */
const DRAW_ANGLE = 0.15;

/** The directions of the views: d = the direction one looks in, r = right on the sheet, u = up on the sheet. */
export const VIEWS = {
  front: basis([0, 1, 0], [0, 0, 1]),
  top: basis([0, 0, -1], [0, 1, 0]),
  left: basis([1, 0, 0], [0, 0, 1]),
  iso: basis([-1, 1, -0.8], [0, 0, 1]),
};
/** A section looks like the view whose plane it is parallel to: the cut by the Front plane like the front view … */
export const SECTION_VIEW = { front: 'front', right: 'left', top: 'top' };

export function basis(dir, up) {
  const d = norm(dir), r = norm(cross(d, up)), u = cross(r, d);
  return { d, r, u };
}

/**
 * The lines of one view of meshes ({ vertProperties, triVerts, numProp, faceID }), in the coordinates of the view (model units, y up):
 * { lines: [{ a, b, hidden }], box: { minX, maxX, minY, maxY } | null }. Sharp edges and the contours of round surfaces; hidden ones only with hidden: true.
 */
export function projectView(meshes, view, { hidden = true, resolution = 1400 } = {}) {
  const { d, r, u } = view;
  const tops = meshes.map(m => topology(m));
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  const proj = tops.map(t => {
    const X = new Float64Array(t.numVert), Y = new Float64Array(t.numVert), Z = new Float64Array(t.numVert);
    for (let v = 0; v < t.numVert; v++) {
      const p = t.P(v);
      X[v] = dot(p, r); Y[v] = dot(p, u); Z[v] = dot(p, d);
      if (X[v] < minX) minX = X[v]; if (X[v] > maxX) maxX = X[v];
      if (Y[v] < minY) minY = Y[v]; if (Y[v] > maxY) maxY = Y[v];
    }
    return { X, Y, Z };
  });
  if (!(maxX >= minX)) return { lines: [], box: null };
  const size = Math.max(maxX - minX, maxY - minY, 1e-6);
  const px = size / resolution;
  const W = Math.ceil((maxX - minX) / px) + 4, H = Math.ceil((maxY - minY) / px) + 4;
  const zb = new Float32Array(W * H).fill(Infinity);
  const gx = x => (x - minX) / px + 2, gy = y => (y - minY) / px + 2;

  // the depth buffer
  tops.forEach((t, k) => {
    const { X, Y, Z } = proj[k];
    for (let tri = 0; tri < t.numTri; tri++) {
      const a = t.tv[tri * 3], b = t.tv[tri * 3 + 1], c = t.tv[tri * 3 + 2];
      const ax = gx(X[a]), ay = gy(Y[a]), bx = gx(X[b]), by = gy(Y[b]), cx = gx(X[c]), cy = gy(Y[c]);
      const area = (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
      if (Math.abs(area) < 1e-12) continue;
      const i0 = Math.max(0, Math.floor(Math.min(ax, bx, cx))), i1 = Math.min(W - 1, Math.ceil(Math.max(ax, bx, cx)));
      const j0 = Math.max(0, Math.floor(Math.min(ay, by, cy))), j1 = Math.min(H - 1, Math.ceil(Math.max(ay, by, cy)));
      for (let j = j0; j <= j1; j++) {
        const y = j + 0.5;
        for (let i = i0; i <= i1; i++) {
          const x = i + 0.5;
          const w0 = ((bx - x) * (cy - y) - (by - y) * (cx - x)) / area;
          const w1 = ((cx - x) * (ay - y) - (cy - y) * (ax - x)) / area;
          const w2 = 1 - w0 - w1;
          if (w0 < -1e-6 || w1 < -1e-6 || w2 < -1e-6) continue;
          const z = w0 * Z[a] + w1 * Z[b] + w2 * Z[c];
          if (z < zb[j * W + i]) zb[j * W + i] = z;
        }
      }
    }
  });

  // the edges: sharp edges between faces (thick), tangent edges where a round face runs into a flat one (thin), and the outlines of round faces
  // (where the surface turns away from the viewer or is seen edge-on)
  const segs = [];
  const turns = (t, L, R) => (dot(t.normal(L), d) < -1e-6) !== (dot(t.normal(R), d) < -1e-6);
  tops.forEach((t, k) => {
    const drawn = new Set();
    for (const e of t.edges) {
      if (e.angle <= 1e-3) continue;
      segs.push([k, e.a, e.b, e.angle <= DRAW_ANGLE && !turns(t, e.L, e.R)]);
      drawn.add(e.a * t.numVert + e.b);
    }
    for (let tri = 0; tri < t.numTri; tri++) {
      for (let c = 0; c < 3; c++) {
        const a = t.tv[tri * 3 + c], b = t.tv[tri * 3 + (c + 1) % 3];
        if (a > b || drawn.has(a * t.numVert + b)) continue;
        const R = t.half.get(b * t.numVert + a);
        if (R === undefined) continue;
        if (turns(t, tri, R)) segs.push([k, a, b, false]);
      }
    }
  });

  const tol = px * 3;
  const seen = (x, y, z) => {
    const i = Math.floor(gx(x)), j = Math.floor(gy(y));
    for (let dj = -1; dj <= 1; dj++) for (let di = -1; di <= 1; di++) {
      const ii = i + di, jj = j + dj;
      if (ii < 0 || jj < 0 || ii >= W || jj >= H) return true;
      if (zb[jj * W + ii] >= z - tol) return true;
    }
    return false;
  };
  const lines = [];
  for (const [k, a, b, tangent] of segs) {
    const { X, Y, Z } = proj[k];
    const ax = X[a], ay = Y[a], az = Z[a], bx = X[b], by = Y[b], bz = Z[b];
    const len = Math.hypot(bx - ax, by - ay) / px;
    if (len < 1e-6) continue;     // an edge along the direction of view is a point here
    const n = Math.max(2, Math.ceil(len));
    let from = 0, state = null;
    const at = s => [ax + (bx - ax) * s, ay + (by - ay) * s];
    for (let m = 0; m <= n; m++) {
      const s = m / n;
      const v = seen(ax + (bx - ax) * s, ay + (by - ay) * s, az + (bz - az) * s);
      if (state === null) { state = v; continue; }
      if (v !== state) {
        const cut = (m - 0.5) / n;
        if (state || (hidden && !tangent)) lines.push({ a: at(from), b: at(cut), hidden: !state, tangent });
        from = cut; state = v;
      }
    }
    if (state || (hidden && !tangent)) lines.push({ a: at(from), b: at(1), hidden: !state, tangent });
  }
  return { lines: mergeLines(lines), box: { minX, maxX, minY, maxY } };
}

/**
 * The views of a drawing of parts (with their manifolds), ready for layoutDrawing.
 * opts: { views: { front, top, left, iso } (booleans), section: null | { plane: 'front' | 'right' | 'top', offset }, hidden, dims, labels: { front, top, left, iso, section } }
 */
export function drawingViews(kernel, parts, opts) {
  const meshes = parts.map(p => p.manifold.getMesh());
  const views = [];
  for (const key of ['front', 'top', 'left', 'iso']) {
    if (!opts.views?.[key]) continue;
    const v = projectView(meshes, VIEWS[key], { hidden: !!opts.hidden && key !== 'iso' });
    views.push({ key, label: opts.labels?.[key] || key, ...v, dims: opts.dims ? (key === 'front' ? ['x', 'y'] : key === 'top' ? ['y'] : []) : [] });
  }
  if (opts.section && STANDARD_PLANES[opts.section.plane]) {
    const frame = offsetFrame(STANDARD_PLANES[opts.section.plane], opts.section.offset || 0, false);
    const view = VIEWS[SECTION_VIEW[opts.section.plane]];
    // what lies behind the plane, seen in the direction of the view; the cut faces in the coordinates of the view
    const kept = parts.map(p => { const m = p.manifold.trimByPlane(view.d, dot(view.d, frame.o)); const mesh = m.getMesh(); m.delete(); return mesh; }).filter(m => m.triVerts.length);
    const v = projectView(kept, view, { hidden: false });
    const cut = sectionOf(kernel, parts, frame).filter(c => c.polygons.length)
      .map(c => c.polygons.map(loop => loop.map(([a, b]) => { const p = toWorld(frame, a, b); return [dot(p, view.r), dot(p, view.u)]; })));
    if (!v.box && cut.length) {
      const pts = cut.flat(2);
      v.box = { minX: Math.min(...pts.map(p => p[0])), maxX: Math.max(...pts.map(p => p[0])), minY: Math.min(...pts.map(p => p[1])), maxY: Math.max(...pts.map(p => p[1])) };
    }
    if (v.box) {
      views.push({ key: 'section', label: opts.labels?.section || 'A–A', ...v, cut });
      // the cut line, in the view the plane stands upright in (the top view for the Front plane, else the front view)
      const host = views.find(x => x.key === (opts.section.plane === 'front' ? 'top' : 'front'));
      if (host?.box) {
        const hv = VIEWS[host.key];
        const n2 = [dot(view.d, hv.r), dot(view.d, hv.u)], o2 = [dot(frame.o, hv.r), dot(frame.o, hv.u)], along = [-n2[1], n2[0]];
        const b = host.box, corners = [[b.minX, b.minY], [b.maxX, b.minY], [b.maxX, b.maxY], [b.minX, b.maxY]];
        const ts = corners.map(c => (c[0] - o2[0]) * along[0] + (c[1] - o2[1]) * along[1]);
        const m = 0.06 * Math.hypot(b.maxX - b.minX, b.maxY - b.minY);
        const t0 = Math.min(...ts) - m, t1 = Math.max(...ts) + m;
        host.cutLine = { a: [o2[0] + along[0] * t0, o2[1] + along[1] * t0], b: [o2[0] + along[0] * t1, o2[1] + along[1] * t1], dir: n2, letter: 'A' };
      }
    }
  }
  return views;
}

/** Pieces of one straight line that follow each other become one (fewer, longer lines in the files). */
function mergeLines(lines) {
  const out = [];
  for (const l of lines) {
    const last = out[out.length - 1];
    if (last && last.hidden === l.hidden && last.tangent === l.tangent && Math.hypot(last.b[0] - l.a[0], last.b[1] - l.a[1]) < 1e-9) {
      const d1 = [last.b[0] - last.a[0], last.b[1] - last.a[1]], d2 = [l.b[0] - l.a[0], l.b[1] - l.a[1]];
      const c = d1[0] * d2[1] - d1[1] * d2[0], l1 = Math.hypot(...d1), l2 = Math.hypot(...d2);
      if (l1 && l2 && Math.abs(c) / (l1 * l2) < 1e-6 && d1[0] * d2[0] + d1[1] * d2[1] > 0) { last.b = l.b; continue; }
    }
    out.push({ a: l.a, b: l.b, hidden: l.hidden, tangent: l.tangent });
  }
  return out;
}

/** Hatching of closed loops (even-odd): parallel lines at an angle (degrees), spacing apart; returns segments [a, b]. */
export function hatch(polygons, spacing, angle = 45) {
  const t = angle * Math.PI / 180, c = Math.cos(t), s = Math.sin(t);
  // turn the loops so that the hatching runs along x
  const rot = p => [p[0] * c + p[1] * s, -p[0] * s + p[1] * c];
  const back = p => [p[0] * c - p[1] * s, p[0] * s + p[1] * c];
  const loops = polygons.map(l => l.map(rot));
  const ys = loops.flat().map(p => p[1]);
  if (!ys.length) return [];
  const out = [];
  for (let k = Math.ceil(Math.min(...ys) / spacing); k * spacing <= Math.max(...ys); k++) {
    const y = k * spacing, xs = [];
    for (const l of loops) for (let i = 0; i < l.length; i++) {
      const p = l[i], q = l[(i + 1) % l.length];
      if ((p[1] <= y) !== (q[1] <= y)) xs.push(p[0] + (y - p[1]) / (q[1] - p[1]) * (q[0] - p[0]));
    }
    xs.sort((a, b) => a - b);
    for (let i = 0; i + 1 < xs.length; i += 2) out.push([back([xs[i], y]), back([xs[i + 1], y])]);
  }
  return out;
}

/**
 * Puts the views on a sheet. spec: { sheet: 'A4' …, scale: 'auto' | [a, b], views: [{ key, label, lines, box, cut?: [loops] (section), dims?: ['x' | 'y'], cutLine?: { a, b, dir } }],
 * title: { name, doc, date, units, by, labels: {…} }, format(value) -> text of a dimension }.
 * Returns { width, height, scale: [a, b], prims } or null when nothing fits even at the smallest scale.
 */
export function layoutDrawing(spec) {
  const [width, height] = SHEETS[spec.sheet] || SHEETS.A4;
  const inner = { x0: 20, y0: 10, x1: width - 10, y1: height - 10 };
  const title = { w: Math.min(180, inner.x1 - inner.x0), h: 32 };
  const titleRect = { x0: inner.x1 - title.w, y0: inner.y1 - title.h, x1: inner.x1, y1: inner.y1 };
  const views = spec.views.filter(v => v.box);
  const at = key => views.find(v => v.key === key);
  const LABEL = 7, GAP = 6;
  const pad = v => (v.dims?.length || v.cutLine ? 13 : 5);
  /**
   * The front view at the top left, the view from the left to its right, the top view below it (they line up, first-angle projection); the section and the
   * isometric view go where there is room: right of them above the title block, or below the view from the left next to the title block.
   */
  const tryScale = s => {
    const k = s[0] / s[1];
    const W = v => (v ? (v.box.maxX - v.box.minX) * k + 2 * pad(v) : 0), H = v => (v ? (v.box.maxY - v.box.minY) * k + 2 * pad(v) + LABEL : 0);
    const front = at('front'), left = at('left'), top = at('top');
    const c0 = Math.max(W(front), W(top)), c1 = W(left), r0 = Math.max(H(front), H(left)), r1 = H(top);
    const X0 = inner.x0 + GAP, Y0 = inner.y0 + GAP;
    const cells = [];
    const cell = (v, x, y, w, h) => cells.push({ v, x0: x, y0: y, x1: x + w, y1: y + h, cx: x + w / 2, cy: y + (h - LABEL) / 2 });
    if (front) cell(front, X0, Y0, c0, r0);
    if (left) cell(left, X0 + (c0 ? c0 + GAP : 0), Y0, c1, r0);
    if (top) cell(top, X0, Y0 + (r0 ? r0 + GAP : 0), c0, r1);
    const right = X0 + c0 + (c1 ? (c0 ? GAP : 0) + c1 : 0), bottom = Y0 + r0 + (r1 ? (r0 ? GAP : 0) + r1 : 0);
    // the places that are left: right of the aligned views (above the title block), below the view from the left (left of the title block), below everything
    const regions = [
      { x0: right + GAP, y0: inner.y0 + GAP, x1: inner.x1 - GAP, y1: titleRect.y0 - GAP },
      { x0: X0 + (c0 ? c0 + GAP : 0), y0: Y0 + (r0 ? r0 + GAP : 0), x1: titleRect.x0 - GAP, y1: inner.y1 - GAP },
      { x0: X0, y0: bottom + GAP, x1: titleRect.x0 - GAP, y1: inner.y1 - GAP },
    ];
    for (const key of ['section', 'iso']) {
      const v = at(key);
      if (!v) continue;
      const w = W(v), h = H(v);
      const r = regions.find(g => g.x1 - g.x0 >= w && g.y1 - g.y0 >= h);
      if (!r) return null;
      cell(v, r.x0 + (r.x1 - r.x0 - w) / 2, r.y0, w, h);
      r.y0 += h + GAP;
    }
    // everything inside the frame, nothing on the title block
    for (const c of cells) {
      if (c.x0 < inner.x0 || c.y0 < inner.y0 || c.x1 > inner.x1 || c.y1 > inner.y1) return null;
      if (c.x1 > titleRect.x0 && c.y1 > titleRect.y0) return null;
    }
    return { k, cells };
  };
  let chosen = null, scale = null;
  if (Array.isArray(spec.scale)) { scale = spec.scale; chosen = tryScale(scale) || forceScale(scale); }
  else for (const s of SCALES) { chosen = tryScale(s); if (chosen) { scale = s; break; } }
  if (!chosen) return null;
  function forceScale(s) {
    // a scale the person chose: the views keep their places even when they do not fit
    const k = s[0] / s[1], cells = [];
    const n = views.length;
    views.forEach((v, i) => {
      const cx = inner.x0 + (inner.x1 - inner.x0) * (i % 3 + 0.5) / Math.min(3, n), cy = inner.y0 + (titleRect.y0 - inner.y0) * (Math.floor(i / 3) + 0.5) / Math.ceil(n / 3);
      cells.push({ v, cx, cy });
    });
    return { k, cells };
  }

  const prims = [];
  const line = (a, b, style) => prims.push({ k: 'line', a, b, style });
  const text = (p, s, size, anchor = 'middle', extra = {}) => prims.push({ k: 'text', p, text: s, size, anchor, ...extra });
  const tri = pts => prims.push({ k: 'tri', pts });

  // frame and title block
  const rect = (r, style) => { line([r.x0, r.y0], [r.x1, r.y0], style); line([r.x1, r.y0], [r.x1, r.y1], style); line([r.x1, r.y1], [r.x0, r.y1], style); line([r.x0, r.y1], [r.x0, r.y0], style); };
  rect(inner, 'frame');
  titleBlock(titleRect, spec.title, scale, spec.sheet, line, text, rect);

  const { k, cells } = chosen;
  for (const c of cells) {
    const v = c.v, bx = (v.box.minX + v.box.maxX) / 2, by = (v.box.minY + v.box.maxY) / 2;
    const P = p => [c.cx + (p[0] - bx) * k, c.cy - (p[1] - by) * k];
    for (const l of v.lines) line(P(l.a), P(l.b), l.hidden ? 'hidden' : l.tangent ? 'thin' : 'visible');
    if (v.cut) {
      // the cut faces: hatched at 45°, every part the other way (2.5 mm on the sheet)
      v.cut.forEach((loops, i) => { for (const [a, b] of hatch(loops, 2.5 / k, i % 2 ? 135 : 45)) line(P(a), P(b), 'thin'); });
    }
    const half = { w: (v.box.maxX - v.box.minX) * k / 2, h: (v.box.maxY - v.box.minY) * k / 2 };
    text([c.cx, c.cy + half.h + pad(v) + 2], v.label, 3.5, 'middle', { bold: v.key === 'section' });
    // the overall dimensions
    for (const axis of v.dims || []) {
      if (axis === 'x') dimension(P([v.box.minX, v.box.minY]), P([v.box.maxX, v.box.minY]), 'below', spec.format(v.box.maxX - v.box.minX), line, text, tri);
      else dimension(P([v.box.minX, v.box.minY]), P([v.box.minX, v.box.maxY]), 'left', spec.format(v.box.maxY - v.box.minY), line, text, tri);
    }
    // where a section is cut: a dash-dot line, thick at its ends, arrows in the direction one looks, the letters
    if (v.cutLine) {
      const a = P(v.cutLine.a), b = P(v.cutLine.b), dir = [v.cutLine.dir[0], -v.cutLine.dir[1]];
      const along = norm2([b[0] - a[0], b[1] - a[1]]);
      line(a, b, 'center');
      for (const [p, sgn] of [[a, 1], [b, -1]]) {
        const q = [p[0] + along[0] * 5 * sgn, p[1] + along[1] * 5 * sgn];
        line(p, q, 'visible');
        const tip = [p[0] + dir[0] * 7, p[1] + dir[1] * 7];
        line(p, tip, 'thin');
        tri([tip, [tip[0] - dir[0] * 3 + dir[1] * 1, tip[1] - dir[1] * 3 - dir[0] * 1], [tip[0] - dir[0] * 3 - dir[1] * 1, tip[1] - dir[1] * 3 + dir[0] * 1]]);
        text([tip[0] + dir[0] * 3, tip[1] + dir[1] * 3 + 1.3], v.cutLine.letter || 'A', 3.5, 'middle', { bold: true });
      }
    }
  }
  return { width, height, scale, prims };
}

const norm2 = v => { const l = Math.hypot(v[0], v[1]) || 1; return [v[0] / l, v[1] / l]; };

/** A dimension between two points of the sheet: extension lines, the dimension line with arrows, the value (vertical ones read from below). */
function dimension(a, b, side, value, line, text, tri) {
  const off = 8, gap = 1.5, over = 2, arrow = 2.8;
  if (side === 'below') {
    const y = Math.max(a[1], b[1]) + off;
    line([a[0], a[1] + gap], [a[0], y + over], 'thin');
    line([b[0], b[1] + gap], [b[0], y + over], 'thin');
    line([a[0], y], [b[0], y], 'thin');
    tri([[a[0], y], [a[0] + arrow, y - 0.9], [a[0] + arrow, y + 0.9]]);
    tri([[b[0], y], [b[0] - arrow, y - 0.9], [b[0] - arrow, y + 0.9]]);
    text([(a[0] + b[0]) / 2, y - 1], value, 3.5, 'middle');
  } else {
    const x = Math.min(a[0], b[0]) - off;
    line([a[0] - gap, a[1]], [x - over, a[1]], 'thin');
    line([b[0] - gap, b[1]], [x - over, b[1]], 'thin');
    line([x, a[1]], [x, b[1]], 'thin');
    const lo = Math.max(a[1], b[1]), hi = Math.min(a[1], b[1]);
    tri([[x, lo], [x - 0.9, lo - arrow], [x + 0.9, lo - arrow]]);
    tri([[x, hi], [x - 0.9, hi + arrow], [x + 0.9, hi + arrow]]);
    text([x - 1, (a[1] + b[1]) / 2], value, 3.5, 'middle', { rot: 90 });
  }
}

/** The title block (after ISO 7200, simplified): name, document, scale, date, units, sheet, the symbol of first-angle projection. */
function titleBlock(r, t, scale, sheet, line, text, rect) {
  rect(r, 'frame');
  const L = t.labels || {};
  const x1 = r.x0 + 110, y1 = r.y0 + 14, y2 = r.y0 + 23;
  line([r.x0, y1], [r.x1, y1], 'thin');
  line([r.x0, y2], [r.x1, y2], 'thin');
  line([x1, r.y0], [x1, r.y1], 'thin');
  line([r.x0 + 55, y1], [r.x0 + 55, r.y1], 'thin');
  line([x1 + 35, y1], [x1 + 35, r.y1], 'thin');
  const small = (x, y, s) => text([x + 1.5, y + 3], s, 2, 'start', { muted: true });
  const value = (x, y, s, size = 3.5) => text([x + 1.5, y + 7.6], s, size, 'start');
  small(r.x0, r.y0, L.title || 'Title');
  text([r.x0 + 1.5, r.y0 + 11], t.name || '', 6, 'start', { bold: true });
  small(x1, r.y0, L.document || 'Document');
  value(x1, r.y0, t.doc || '', 3);
  small(r.x0, y1, L.scale || 'Scale'); value(r.x0, y1, `${scale[0]} : ${scale[1]}`);
  small(r.x0 + 55, y1, L.date || 'Date'); value(r.x0 + 55, y1, t.date || '');
  small(x1, y1, L.units || 'Units'); value(x1, y1, t.units || 'mm');
  small(x1 + 35, y1, L.sheet || 'Sheet'); value(x1 + 35, y1, `${sheet} · 1/1`);
  small(r.x0, y2, L.by || 'Drawn by'); value(r.x0, y2, t.by || '', 3);
  small(r.x0 + 55, y2, L.software || 'Made with'); value(r.x0 + 55, y2, 'MatShape', 3);
  // first-angle projection: the cone seen from the side (left), its circles (right)
  small(x1, y2, L.projection || 'Projection');
  const cx = x1 + 52, cy = y2 + 5;
  line([cx - 14, cy - 2.6], [cx - 6, cy - 1.4], 'thin'); line([cx - 6, cy - 1.4], [cx - 6, cy + 1.4], 'thin'); line([cx - 6, cy + 1.4], [cx - 14, cy + 2.6], 'thin'); line([cx - 14, cy + 2.6], [cx - 14, cy - 2.6], 'thin');
  circle([cx + 4, cy], 2.6, line); circle([cx + 4, cy], 1.4, line);
}

function circle(c, rad, line) {
  const n = 24;
  for (let i = 0; i < n; i++) {
    const a0 = i / n * Math.PI * 2, a1 = (i + 1) / n * Math.PI * 2;
    line([c[0] + rad * Math.cos(a0), c[1] + rad * Math.sin(a0)], [c[0] + rad * Math.cos(a1), c[1] + rad * Math.sin(a1)], 'thin');
  }
}

// ---- files -------------------------------------------------------------------------------------------------------------------

const STYLES = {
  visible: { width: 0.5, dash: null, layer: 'VISIBLE', colour: 7 },
  hidden: { width: 0.25, dash: [2, 1], layer: 'HIDDEN', colour: 8 },
  thin: { width: 0.18, dash: null, layer: 'THIN', colour: 3 },
  center: { width: 0.25, dash: [6, 1, 1, 1], layer: 'CENTER', colour: 1 },
  frame: { width: 0.7, dash: null, layer: 'FRAME', colour: 7 },
};
const f2 = v => (Math.round(v * 1000) / 1000).toString();
const esc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** The drawing as SVG (millimetres). */
export function toSvg(d) {
  const out = [`<svg xmlns="http://www.w3.org/2000/svg" width="${d.width}mm" height="${d.height}mm" viewBox="0 0 ${d.width} ${d.height}">`, `<rect width="${d.width}" height="${d.height}" fill="#ffffff"/>`];
  for (const [name, st] of Object.entries(STYLES)) {
    const path = d.prims.filter(p => p.k === 'line' && p.style === name).map(p => `M${f2(p.a[0])} ${f2(p.a[1])}L${f2(p.b[0])} ${f2(p.b[1])}`).join('');
    if (path) out.push(`<path d="${path}" fill="none" stroke="#000000" stroke-width="${st.width}" stroke-linecap="round"${st.dash ? ` stroke-dasharray="${st.dash.join(' ')}"` : ''}/>`);
  }
  const tris = d.prims.filter(p => p.k === 'tri').map(p => `M${p.pts.map(q => `${f2(q[0])} ${f2(q[1])}`).join('L')}Z`).join('');
  if (tris) out.push(`<path d="${tris}" fill="#000000"/>`);
  for (const p of d.prims.filter(x => x.k === 'text')) {
    const rot = p.rot ? ` transform="rotate(${-p.rot} ${f2(p.p[0])} ${f2(p.p[1])})"` : '';
    out.push(`<text x="${f2(p.p[0])}" y="${f2(p.p[1])}" font-family="Helvetica, Arial, sans-serif" font-size="${p.size}" text-anchor="${p.anchor}"${p.bold ? ' font-weight="bold"' : ''} fill="${p.muted ? '#555555' : '#000000'}"${rot}>${esc(p.text)}</text>`);
  }
  out.push('</svg>');
  return out.join('\n');
}

/** The drawing as DXF (R12, ASCII), in millimetres, y up; layers VISIBLE, HIDDEN, THIN, CENTER, FRAME, TEXT. */
export function toDxf(d) {
  const o = [];
  const g = (code, value) => o.push(String(code), String(value));
  const Y = y => f2(d.height - y);
  g(0, 'SECTION'); g(2, 'HEADER'); g(9, '$ACADVER'); g(1, 'AC1009'); g(9, '$INSUNITS'); g(70, 4); g(9, '$EXTMIN'); g(10, 0); g(20, 0); g(9, '$EXTMAX'); g(10, d.width); g(20, d.height); g(0, 'ENDSEC');
  g(0, 'SECTION'); g(2, 'TABLES');
  g(0, 'TABLE'); g(2, 'LTYPE'); g(70, 3);
  for (const [name, text, pattern] of [['CONTINUOUS', 'Solid line', []], ['DASHED', '__ __ __', [2, -1]], ['CENTER', '____ _ ____', [6, -1, 1, -1]]]) {
    g(0, 'LTYPE'); g(2, name); g(70, 0); g(3, text); g(72, 65); g(73, pattern.length); g(40, pattern.reduce((s, x) => s + Math.abs(x), 0));
    for (const x of pattern) g(49, x);
  }
  g(0, 'ENDTAB');
  g(0, 'TABLE'); g(2, 'LAYER'); g(70, 6);
  const layers = [['VISIBLE', 7, 'CONTINUOUS'], ['HIDDEN', 8, 'DASHED'], ['THIN', 3, 'CONTINUOUS'], ['CENTER', 1, 'CENTER'], ['FRAME', 7, 'CONTINUOUS'], ['TEXT', 7, 'CONTINUOUS']];
  for (const [name, colour, type] of layers) { g(0, 'LAYER'); g(2, name); g(70, 0); g(62, colour); g(6, type); }
  g(0, 'ENDTAB'); g(0, 'ENDSEC');
  g(0, 'SECTION'); g(2, 'ENTITIES');
  for (const p of d.prims) {
    if (p.k === 'line') { g(0, 'LINE'); g(8, STYLES[p.style].layer); g(10, f2(p.a[0])); g(20, Y(p.a[1])); g(30, 0); g(11, f2(p.b[0])); g(21, Y(p.b[1])); g(31, 0); }
    else if (p.k === 'tri') { g(0, 'SOLID'); g(8, 'THIN'); const [a, b, c] = p.pts; g(10, f2(a[0])); g(20, Y(a[1])); g(11, f2(b[0])); g(21, Y(b[1])); g(12, f2(c[0])); g(22, Y(c[1])); g(13, f2(c[0])); g(23, Y(c[1])); }
    else if (p.k === 'text') {
      g(0, 'TEXT'); g(8, 'TEXT'); g(10, f2(p.p[0])); g(20, Y(p.p[1])); g(30, 0); g(40, f2(p.size * 0.72)); g(1, p.text.replace(/[\r\n]/g, ' '));
      if (p.rot) g(50, p.rot);
      const h = p.anchor === 'middle' ? 1 : p.anchor === 'end' ? 2 : 0;
      if (h) { g(72, h); g(11, f2(p.p[0])); g(21, Y(p.p[1])); g(31, 0); }
    }
  }
  g(0, 'ENDSEC'); g(0, 'EOF');
  return o.join('\r\n') + '\r\n';
}

// the widths of Helvetica (1/1000 em, characters 32 … 126) for the placing of centred text in a PDF
const HELV = [278, 278, 355, 556, 556, 889, 667, 191, 333, 333, 389, 584, 278, 333, 278, 278, ...Array(10).fill(556), 278, 278, 584, 584, 584, 556, 1015,
  667, 667, 722, 722, 667, 611, 778, 722, 278, 500, 667, 556, 833, 722, 778, 667, 778, 722, 667, 611, 722, 667, 944, 667, 667, 611, 278, 278, 278, 469, 556, 333,
  556, 556, 500, 556, 556, 278, 556, 556, 222, 222, 500, 222, 833, 556, 556, 556, 556, 333, 500, 278, 556, 500, 722, 500, 500, 500, 334, 260, 334, 584];
const WIDTH = new Map(HELV.map((w, i) => [String.fromCharCode(32 + i), w]));
const LIKE = { ä: 'a', ö: 'o', ü: 'u', Ä: 'A', Ö: 'O', Ü: 'U', ß: 'B', é: 'e', è: 'e', '–': 'n', '°': 'o' };
const widthOf = (s, size, bold) => [...s].reduce((w, ch) => w + (WIDTH.get(ch) ?? WIDTH.get(LIKE[ch]) ?? 556), 0) / 1000 * size * (bold ? 1.06 : 1);
const WIN = { '–': 0x96, '—': 0x97, '…': 0x85, '€': 0x80, '’': 0x92, '‘': 0x91, '“': 0x93, '”': 0x94, '•': 0x95 };

/** The drawing as a PDF (one page, vector, Helvetica): bytes. */
export function toPdf(d) {
  const k = 72 / 25.4;
  const X = x => (x * k).toFixed(2), Y = y => ((d.height - y) * k).toFixed(2);
  const pdfText = s => [...s].map(ch => {
    const code = WIN[ch] ?? (ch.charCodeAt(0) < 256 ? ch.charCodeAt(0) : 63);
    const c = String.fromCharCode(code);
    return c === '(' || c === ')' || c === '\\' ? '\\' + c : c;
  }).join('');
  const ops = ['1 J 1 j'];
  for (const [name, st] of Object.entries(STYLES)) {
    const lines = d.prims.filter(p => p.k === 'line' && p.style === name);
    if (!lines.length) continue;
    ops.push(`${(st.width * k).toFixed(3)} w [${(st.dash || []).map(x => (x * k).toFixed(2)).join(' ')}] 0 d`);
    for (const p of lines) ops.push(`${X(p.a[0])} ${Y(p.a[1])} m ${X(p.b[0])} ${Y(p.b[1])} l S`);
  }
  ops.push('[] 0 d');
  for (const p of d.prims.filter(x => x.k === 'tri')) ops.push(`${X(p.pts[0][0])} ${Y(p.pts[0][1])} m ${X(p.pts[1][0])} ${Y(p.pts[1][1])} l ${X(p.pts[2][0])} ${Y(p.pts[2][1])} l f`);
  for (const p of d.prims.filter(x => x.k === 'text')) {
    const size = p.size * k, w = widthOf(p.text, size, p.bold);
    const shift = p.anchor === 'middle' ? -w / 2 : p.anchor === 'end' ? -w : 0;
    const grey = p.muted ? '0.33 g' : '0 g';
    if (p.rot === 90) ops.push(`BT ${grey} /${p.bold ? 'F2' : 'F1'} ${size.toFixed(2)} Tf 0 1 -1 0 ${X(p.p[0])} ${(Number(Y(p.p[1])) + shift).toFixed(2)} Tm (${pdfText(p.text)}) Tj ET`);
    else ops.push(`BT ${grey} /${p.bold ? 'F2' : 'F1'} ${size.toFixed(2)} Tf ${(Number(X(p.p[0])) + shift).toFixed(2)} ${Y(p.p[1])} Td (${pdfText(p.text)}) Tj ET`);
  }
  const content = ops.join('\n');
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${(d.width * k).toFixed(2)} ${(d.height * k).toFixed(2)}] /Resources << /Font << /F1 5 0 R /F2 6 0 R >> >> /Contents 4 0 R >>`,
    `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>',
  ];
  let pdf = '%PDF-1.4\n%âãÏÓ\n';
  const offsets = [];
  objects.forEach((obj, i) => { offsets.push(pdf.length); pdf += `${i + 1} 0 obj\n${obj}\nendobj\n`; });
  const xref = pdf.length;
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map(o => String(o).padStart(10, '0') + ' 00000 n \n').join('')}`;
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  const bytes = new Uint8Array(pdf.length);
  for (let i = 0; i < pdf.length; i++) bytes[i] = pdf.charCodeAt(i) & 0xff;
  return bytes;
}
