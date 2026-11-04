/* MatShape – a picture becomes a 3D model: the colours of the picture are found (k-means), the regions cleaned (smoothing, specks removed), the outline of every
   colour traced (pixel edges, chained with the region on the right), simplified (Douglas-Peucker) and recognised (circles, axis-aligned rectangles, else
   straight lines). The result are ordinary features: a base plate (rectangle, the outline of the motif, or none), a plane on top of it, and per colour a sketch
   with an extrude as a part of its own in that colour – ready for a multi-colour 3MF. No DOM here: the editor (imagedialog.js) and the tests in Node use it alike. */

const TRANSPARENT = -1;

// ---- colours ----------------------------------------------------------------------------------------------------------------

const dist2 = (a, b) => (a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2 + (a[2] - b[2]) ** 2;
export const hex = rgb => '#' + rgb.map(v => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0')).join('');

/**
 * The k main colours of the picture and a label per pixel (-1 = transparent). Deterministic: the first centre is the most frequent colour, each next one the
 * colour farthest from those chosen (so a small but distinct colour of a logo is not lost), then Lloyd iterations. Palette sorted by area, largest first.
 */
export function quantize(image, k, { merge = 36 } = {}) {
  const { width: w, height: h, data } = image;
  const n = w * h;
  const opaque = [];
  for (let i = 0; i < n; i++) if (data[i * 4 + 3] >= 128) opaque.push(i);
  const labels = new Int16Array(n).fill(TRANSPARENT);
  if (!opaque.length) return { palette: [], labels };
  const step = Math.max(1, Math.floor(opaque.length / 40000));
  const sample = [];
  for (let s = 0; s < opaque.length; s += step) { const i = opaque[s] * 4; sample.push([data[i], data[i + 1], data[i + 2]]); }

  // the most frequent colour (coarse bins of 16 levels)
  const bins = new Map();
  for (const c of sample) { const key = (c[0] >> 4) << 8 | (c[1] >> 4) << 4 | (c[2] >> 4); bins.set(key, (bins.get(key) || 0) + 1); }
  const top = [...bins.entries()].sort((a, b) => b[1] - a[1])[0][0];
  const centres = [sample.find(c => ((c[0] >> 4) << 8 | (c[1] >> 4) << 4 | (c[2] >> 4)) === top).slice()];
  const nearest = new Float64Array(sample.length).fill(Infinity);
  while (centres.length < k) {
    const last = centres[centres.length - 1];
    let far = -1, farD = 0;
    sample.forEach((c, i) => { nearest[i] = Math.min(nearest[i], dist2(c, last)); if (nearest[i] > farD) { farD = nearest[i]; far = i; } });
    if (far < 0 || farD < merge * merge) break;   // no colour left that differs noticeably
    centres.push(sample[far].slice());
  }
  for (let it = 0; it < 12; it++) {
    const sum = centres.map(() => [0, 0, 0, 0]);
    for (const c of sample) {
      let best = 0, bestD = Infinity;
      centres.forEach((m, j) => { const d = dist2(c, m); if (d < bestD) { bestD = d; best = j; } });
      const s = sum[best]; s[0] += c[0]; s[1] += c[1]; s[2] += c[2]; s[3]++;
    }
    centres.forEach((m, j) => { if (sum[j][3]) { m[0] = sum[j][0] / sum[j][3]; m[1] = sum[j][1] / sum[j][3]; m[2] = sum[j][2] / sum[j][3]; } });
  }
  // colours closer than `merge` are one colour (noise of a photo or a scan splits a colour otherwise)
  for (let a = 0; a < centres.length; a++) {
    for (let b = centres.length - 1; b > a; b--) {
      if (dist2(centres[a], centres[b]) < merge * merge) centres.splice(b, 1);
    }
  }
  const count = new Array(centres.length).fill(0);
  for (const i of opaque) {
    const c = [data[i * 4], data[i * 4 + 1], data[i * 4 + 2]];
    let best = 0, bestD = Infinity;
    centres.forEach((m, j) => { const d = dist2(c, m); if (d < bestD) { bestD = d; best = j; } });
    labels[i] = best;
    count[best]++;
  }
  // largest first; colours that got no pixel are dropped
  const order = centres.map((_, j) => j).filter(j => count[j]).sort((a, b) => count[b] - count[a]);
  const remap = new Int16Array(centres.length).fill(TRANSPARENT);
  order.forEach((j, i) => { remap[j] = i; });
  for (let i = 0; i < n; i++) if (labels[i] >= 0) labels[i] = remap[labels[i]];
  return { palette: order.map(j => ({ rgb: centres[j].map(Math.round), count: count[j], share: count[j] / n })), labels };
}

// ---- cleaning ---------------------------------------------------------------------------------------------------------------

/** Smoothing (a 3 × 3 majority filter, `smooth` times) and specks below `minArea` pixels joined to the colour around them. Returns new labels. */
export function clean(labels, w, h, { smooth = 1, minArea = 12, seams = true } = {}) {
  let cur = Int16Array.from(labels);
  if (seams) cur = dissolveSeams(cur, w, h);
  for (let pass = 0; pass < smooth; pass++) {
    const next = Int16Array.from(cur);
    const votes = new Map();
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        votes.clear();
        for (let dy = -1; dy <= 1; dy++) {
          const yy = y + dy;
          if (yy < 0 || yy >= h) continue;
          for (let dx = -1; dx <= 1; dx++) {
            const xx = x + dx;
            if (xx < 0 || xx >= w) continue;
            const l = cur[yy * w + xx];
            votes.set(l, (votes.get(l) || 0) + 1);
          }
        }
        let best = cur[y * w + x], bestV = votes.get(best);
        for (const [l, v] of votes) if (v > bestV) { best = l; bestV = v; }
        next[y * w + x] = best;
      }
    }
    cur = next;
  }
  if (minArea > 1) {
    const seen = new Uint8Array(w * h);
    const stack = [];
    for (let start = 0; start < w * h; start++) {
      if (seen[start]) continue;
      const label = cur[start];
      const comp = [];
      const around = new Map();
      stack.push(start); seen[start] = 1;
      while (stack.length) {
        const i = stack.pop();
        comp.push(i);
        const x = i % w, y = (i / w) | 0;
        for (const [nx, ny] of [[x + 1, y], [x - 1, y], [x, y + 1], [x, y - 1]]) {
          if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
          const j = ny * w + nx;
          if (cur[j] === label) { if (!seen[j]) { seen[j] = 1; stack.push(j); } }
          else around.set(cur[j], (around.get(cur[j]) || 0) + 1);
        }
      }
      if (comp.length < minArea && around.size) {
        const into = [...around.entries()].sort((a, b) => b[1] - a[1])[0][0];
        for (const i of comp) cur[i] = into;
      }
    }
  }
  return cur;
}

/**
 * The seams of anti-aliasing: where two colours meet, a picture has a thin band of mixed colours that k-means makes a colour of its own (a ring around every
 * shape). A region that is nearly all border (at most about two pixels wide) and small against the picture is given, pixel by pixel, to the colours around it.
 */
function dissolveSeams(labels, w, h) {
  const cur = Int16Array.from(labels);
  const n = w * h;
  const seen = new Uint8Array(n);
  const stack = [];
  const border = i => {
    const x = i % w, y = (i / w) | 0, l = cur[i];
    return (x > 0 && cur[i - 1] !== l) || (x < w - 1 && cur[i + 1] !== l) || (y > 0 && cur[i - w] !== l) || (y < h - 1 && cur[i + w] !== l);
  };
  const totals = new Map();
  for (const l of cur) totals.set(l, (totals.get(l) || 0) + 1);
  // a colour whose pixels are nearly all border pixels is a seam colour as a whole (an outline drawn in the picture is wider than two pixels)
  const edge = new Map();
  for (let i = 0; i < n; i++) if (border(i)) edge.set(cur[i], (edge.get(cur[i]) || 0) + 1);
  const seam = new Set([...totals.keys()].filter(l => l >= 0 && (edge.get(l) || 0) >= 0.8 * totals.get(l) && totals.get(l) < 0.15 * n));
  if (!seam.size) return cur;
  for (let pass = 0; pass < 6; pass++) {
    let left = 0;
    const next = Int16Array.from(cur);
    for (let i = 0; i < n; i++) {
      if (!seam.has(cur[i])) continue;
      const x = i % w, y = (i / w) | 0;
      const votes = new Map();
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        const xx = x + dx, yy = y + dy;
        if (xx < 0 || yy < 0 || xx >= w || yy >= h) continue;
        const l = cur[yy * w + xx];
        if (!seam.has(l)) votes.set(l, (votes.get(l) || 0) + 1);
      }
      if (votes.size) next[i] = [...votes.entries()].sort((a, b) => b[1] - a[1])[0][0];
      else left++;
    }
    cur.set(next);
    if (!left) break;
  }
  return cur;
}

// ---- tracing ----------------------------------------------------------------------------------------------------------------

/**
 * The outlines of a mask (mask[i] true = inside) as closed loops of pixel corners [x, y] (y down). Edges run with the inside on the right; where two loops
 * touch at a corner, the walk turns right, so every loop stays simple. Outer outlines and holes both come out; which is which follows from nesting.
 */
export function traceMask(mask, w, h) {
  const at = (x, y) => x >= 0 && y >= 0 && x < w && y < h && mask[y * w + x];
  const W = w + 1;
  const out = new Map();                     // vertex -> list of [toVertex, dx, dy]
  const edge = (x0, y0, x1, y1) => {
    const k = y0 * W + x0;
    if (!out.has(k)) out.set(k, []);
    out.get(k).push([y1 * W + x1, x1 - x0, y1 - y0]);
  };
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (!at(x, y)) continue;
      if (!at(x, y - 1)) edge(x, y, x + 1, y);
      if (!at(x + 1, y)) edge(x + 1, y, x + 1, y + 1);
      if (!at(x, y + 1)) edge(x + 1, y + 1, x, y + 1);
      if (!at(x - 1, y)) edge(x, y + 1, x, y);
    }
  }
  const loops = [];
  for (const [startV, list] of out) {
    while (list.length) {
      const loop = [];
      let v = startV, [to, dx, dy] = list.pop();
      loop.push([v % W, (v / W) | 0]);
      while (to !== startV || !loop.length) {
        v = to;
        loop.push([v % W, (v / W) | 0]);
        const next = out.get(v);
        if (!next?.length) break;
        let pick = 0;
        if (next.length > 1) {
          // prefer the right turn (y down: right of (dx, dy) is (-dy, dx)), then straight on, then left
          const rank = ([, ex, ey]) => (ex === -dy && ey === dx ? 0 : ex === dx && ey === dy ? 1 : 2);
          pick = next.reduce((best, e, i) => (rank(e) < rank(next[best]) ? i : best), 0);
        }
        [to, dx, dy] = next.splice(pick, 1)[0];
        if (loop.length > 4 * (w + 1) * (h + 1)) break;
      }
      if (loop.length >= 4) loops.push(dropStraight(loop));
    }
  }
  return loops;
}

/** Corners only: points in the middle of a straight run go. */
function dropStraight(loop) {
  const out = [];
  const n = loop.length;
  for (let i = 0; i < n; i++) {
    const a = loop[(i - 1 + n) % n], b = loop[i], c = loop[(i + 1) % n];
    if ((b[0] - a[0]) * (c[1] - b[1]) - (b[1] - a[1]) * (c[0] - b[0]) !== 0) out.push(b);
  }
  return out;
}

export function area(loop) {
  let s = 0;
  for (let i = 0; i < loop.length; i++) { const a = loop[i], b = loop[(i + 1) % loop.length]; s += a[0] * b[1] - b[0] * a[1]; }
  return s / 2;
}

function segDist(p, a, b) {
  const dx = b[0] - a[0], dy = b[1] - a[1], l2 = dx * dx + dy * dy;
  if (!l2) return Math.hypot(p[0] - a[0], p[1] - a[1]);
  const t = Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / l2));
  return Math.hypot(p[0] - a[0] - t * dx, p[1] - a[1] - t * dy);
}

function dpOpen(points, tol) {
  if (points.length < 3) return points.slice();
  let far = 0, farD = -1;
  for (let i = 1; i < points.length - 1; i++) { const d = segDist(points[i], points[0], points[points.length - 1]); if (d > farD) { farD = d; far = i; } }
  if (farD <= tol) return [points[0], points[points.length - 1]];
  const left = dpOpen(points.slice(0, far + 1), tol), right = dpOpen(points.slice(far), tol);
  return [...left.slice(0, -1), ...right];
}

/** Douglas-Peucker on a closed loop: split at the point farthest from the first, simplify both halves. */
export function simplify(loop, tol) {
  if (loop.length <= 4) return loop.slice();
  let far = 0, farD = -1;
  loop.forEach((p, i) => { const d = Math.hypot(p[0] - loop[0][0], p[1] - loop[0][1]); if (d > farD) { farD = d; far = i; } });
  const a = dpOpen(loop.slice(0, far + 1), tol), b = dpOpen([...loop.slice(far), loop[0]], tol);
  const out = [...a.slice(0, -1), ...b.slice(0, -1)];
  return out.length >= 3 ? out : loop.slice();
}

/** What a loop is: a circle (all corners near one radius and the area of that circle), an axis-aligned rectangle, else a polygon of straight lines. */
export function recognise(raw, simple, { circles = true, rects = true } = {}) {
  const A = Math.abs(area(raw));
  if (circles && raw.length >= 8) {
    let cx = 0, cy = 0;
    raw.forEach(p => { cx += p[0]; cy += p[1]; });
    cx /= raw.length; cy /= raw.length;
    const radii = raw.map(p => Math.hypot(p[0] - cx, p[1] - cy));
    const r = radii.reduce((s, v) => s + v, 0) / radii.length;
    const dev = Math.max(...radii.map(v => Math.abs(v - r)));
    if (r >= 3 && dev <= Math.max(1.2, 0.08 * r) && Math.abs(A - Math.PI * r * r) / (Math.PI * r * r) < 0.1) return { kind: 'circle', c: [cx, cy], r: Math.sqrt(A / Math.PI) };
  }
  if (rects && simple.length === 4) {
    const straight = simple.every((p, i) => { const q = simple[(i + 1) % 4]; const dx = Math.abs(q[0] - p[0]), dy = Math.abs(q[1] - p[1]); return Math.min(dx, dy) <= Math.max(1, 0.035 * Math.max(dx, dy)); });
    if (straight) {
      const xs = simple.map(p => p[0]), ys = simple.map(p => p[1]);
      const [x0, x1, y0, y1] = [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)];
      return { kind: 'rect', points: [[x0, y0], [x1, y0], [x1, y1], [x0, y1]] };
    }
  }
  return { kind: 'polygon', points: simple };
}

/** The mask grown by `grow` pixels (a square neighbourhood) with its holes filled: the silhouette of a motif for a base plate in its shape. */
export function silhouette(mask, w, h, grow) {
  let m = Uint8Array.from(mask);
  for (let pass = 0; pass < grow; pass++) {
    const next = Uint8Array.from(m);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      if (m[y * w + x]) continue;
      if ((x > 0 && m[y * w + x - 1]) || (x < w - 1 && m[y * w + x + 1]) || (y > 0 && m[(y - 1) * w + x]) || (y < h - 1 && m[(y + 1) * w + x])) next[y * w + x] = 1;
    }
    m = next;
  }
  // whatever outside cannot reach from the border is inside
  const outside = new Uint8Array(w * h);
  const stack = [];
  for (let x = 0; x < w; x++) { stack.push(x, (h - 1) * w + x); }
  for (let y = 0; y < h; y++) { stack.push(y * w, y * w + w - 1); }
  while (stack.length) {
    const i = stack.pop();
    if (outside[i] || m[i]) continue;
    outside[i] = 1;
    const x = i % w, y = (i / w) | 0;
    if (x > 0) stack.push(i - 1); if (x < w - 1) stack.push(i + 1); if (y > 0) stack.push(i - w); if (y < h - 1) stack.push(i + w);
  }
  for (let i = 0; i < w * h; i++) m[i] = outside[i] ? 0 : 1;
  return m;
}

// ---- the whole way: picture -> regions -> shapes ------------------------------------------------------------------------------

/** The colour that covers most of the border: usually the background (not built; a base plate takes its place). -1 when the border is transparent. */
export function backgroundOf(labels, w, h) {
  const count = new Map();
  const add = i => count.set(labels[i], (count.get(labels[i]) || 0) + 1);
  for (let x = 0; x < w; x++) { add(x); add((h - 1) * w + x); }
  for (let y = 0; y < h; y++) { add(y * w); add(y * w + w - 1); }
  return [...count.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? TRANSPARENT;
}

/**
 * The shapes of one colour: [{ kind: 'circle', c, r } | { kind: 'rect' | 'polygon', points }] in pixels, plus the raw loops for the preview.
 * tol = how far (px) a simplified outline may leave the pixels; tiny loops (below minArea) are left out.
 */
export function shapesOf(labels, w, h, label, { tol = 1, minArea = 12, circles = true, rects = true } = {}) {
  const mask = new Uint8Array(w * h);
  for (let i = 0; i < w * h; i++) mask[i] = labels[i] === label ? 1 : 0;
  return shapesOfMask(mask, w, h, { tol, minArea, circles, rects });
}

export function shapesOfMask(mask, w, h, { tol = 1, minArea = 12, circles = true, rects = true } = {}) {
  return traceMask(mask, w, h)
    .filter(loop => Math.abs(area(loop)) >= minArea)
    .map(loop => recognise(loop, simplify(loop, tol), { circles, rects }));
}

// ---- features ---------------------------------------------------------------------------------------------------------------

const round = v => Math.round(v * 1000) / 1000;

/** The shapes in millimetres on the sketch plane (centred on the origin, y up) as sketch entities. Loops of lines are closed exactly. */
export function entitiesOf(shapes, { w, h, scale, id }) {
  const P = ([x, y]) => [round((x - w / 2) * scale), round((h / 2 - y) * scale)];
  const out = [];
  for (const s of shapes) {
    if (s.kind === 'circle') { out.push({ id: id('c'), t: 'circle', c: P(s.c), r: round(s.r * scale) }); continue; }
    const pts = s.points.map(P).filter((p, i, all) => { const q = all[(i + 1) % all.length]; return p[0] !== q[0] || p[1] !== q[1]; });
    if (pts.length < 3) continue;
    pts.forEach((p, i) => out.push({ id: id('l'), t: 'line', a: p, b: pts[(i + 1) % pts.length] }));
  }
  return out;
}

/**
 * The features of a traced picture. settings: { width (mm), base: 'rect' | 'outline' | 'none', baseHeight, margin (mm), baseColor, baseName,
 * colours: [{ label, include, height, color, name }] }, trace: { w, h, labels }, names: { base, top, sketch(name), extrude(name) }, id(prefix) -> unique id.
 * Returns { features, parts, stats }.
 */
export function buildFeatures(trace, settings, names, id, options = {}) {
  const { w, h, labels } = trace;
  const scale = settings.width / w;
  const features = [];
  const parts = {};
  const stats = { profiles: 0, lines: 0, circles: 0, rects: 0 };
  const count = shapes => shapes.forEach(s => { stats.profiles++; if (s.kind === 'circle') stats.circles++; else { stats.lines += s.points.length; if (s.kind === 'rect') stats.rects++; } });
  const sketch = (name, plane, entities) => { const f = { id: id('s'), type: 'sketch', name, suppressed: false, params: { plane, entities, cons: [] } }; features.push(f); return f; };
  const extrude = (name, sketchId, depth, color, partName) => {
    const f = { id: id('e'), type: 'extrude', name, suppressed: false, params: { sketch: sketchId, profiles: null, depth: round(depth) + ' mm', end: 'blind', flip: false, op: 'new', scope: null } };
    features.push(f);
    parts[f.id] = { name: partName, color };
    return f;
  };
  const top = { kind: 'std', name: 'top' };
  const included = settings.colours.filter(c => c.include);
  let colourPlane = top;

  if (settings.base !== 'none' && settings.baseHeight > 0) {
    let entities;
    const m = (settings.margin || 0) / scale;
    if (settings.base === 'outline') {
      const mask = new Uint8Array(w * h);
      const keep = new Set(included.map(c => c.label));
      for (let i = 0; i < w * h; i++) mask[i] = keep.has(labels[i]) ? 1 : 0;
      const grown = silhouette(mask, w, h, Math.max(0, Math.round(m)));
      const shapes = shapesOfMask(grown, w, h, { ...options, minArea: Math.max(options.minArea || 12, 40) });
      count(shapes);
      entities = entitiesOf(shapes, { w, h, scale, id });
    } else {
      const shapes = [{ kind: 'rect', points: [[-m, -m], [w + m, -m], [w + m, h + m], [-m, h + m]] }];
      count(shapes);
      entities = entitiesOf(shapes, { w, h, scale, id });
    }
    if (entities.length) {
      const s = sketch(names.sketch(names.base), top, entities);
      extrude(names.extrude(names.base), s.id, settings.baseHeight, settings.baseColor, names.base);
      const plane = { id: id('p'), type: 'plane', name: names.top, suppressed: false, params: { base: top, offset: round(settings.baseHeight) + ' mm', flip: false } };
      features.push(plane);
      colourPlane = { kind: 'plane', id: plane.id };
    }
  }

  for (const c of included) {
    if (!(c.height > 0)) continue;
    const shapes = shapesOf(labels, w, h, c.label, options);
    if (!shapes.length) continue;
    count(shapes);
    const s = sketch(names.sketch(c.name), colourPlane, entitiesOf(shapes, { w, h, scale, id }));
    extrude(names.extrude(c.name), s.id, c.height, c.color, c.name);
  }
  return { features, parts, stats };
}
