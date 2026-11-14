/* MatShape – the feature "figure": a free form (a mascot, an animal, a character, a vase …) made of building blocks that melt into each other. Each group of blocks is
   one part in its colour; its blocks (sphere, ellipsoid, capsule / round cone, box, cylinder, torus, cone) are joined smoothly (or cut away) as signed distance
   fields, and the surface is found by the kernel's level set. A later group is cut out of the earlier ones, so the parts only touch – ready for a multi-colour print.
   The meshes are kept in a small cache (a figure takes a second to compute; the history runs again after every change). No DOM: model.js and the tests in Node use it. */

export const BLOCKS = ['sphere', 'ellipsoid', 'capsule', 'box', 'cylinder', 'torus', 'cone'];
export const MAX_BLOCKS = 400;
export const MAX_GROUPS = 32;
const CELLS = { rough: 70, normal: 110, fine: 170 };

const num = (v, d = 0) => (Number.isFinite(Number(v)) ? Number(v) : d);
const vec = (v, d = [0, 0, 0]) => (Array.isArray(v) && v.length >= 3 ? [num(v[0]), num(v[1]), num(v[2])] : d.slice());
const len3 = (x, y, z) => Math.sqrt(x * x + y * y + z * z);

/** The rotation (degrees about X, then Y, then Z) as a 3 × 3 matrix, rows. */
function rotation(rot) {
  const [ax, ay, az] = vec(rot).map(a => a * Math.PI / 180);
  const cx = Math.cos(ax), sx = Math.sin(ax), cy = Math.cos(ay), sy = Math.sin(ay), cz = Math.cos(az), sz = Math.sin(az);
  // R = Rz · Ry · Rx
  return [
    cz * cy, cz * sy * sx - sz * cx, cz * sy * cx + sz * sx,
    sz * cy, sz * sy * sx + cz * cx, sz * sy * cx - cz * sx,
    -sy, cy * sx, cy * cx,
  ];
}

/**
 * One block as { dist(x, y, z), centre, radius (of a ball around it), cut, blend } or a text key of what is wrong. Numbers in millimetres; s = the scale of the figure.
 */
export function block(b, s, smooth) {
  if (!b || typeof b !== 'object' || !BLOCKS.includes(b.t)) return 'Feature.FigureBlock';
  const cut = b.op === 'cut';
  const blend = Math.max(0, num(b.blend, smooth)) * s;
  const c = vec(b.c).map(v => v * s);
  // a point into the frame of the block (centre c, rotation rot)
  const local = b.rot ? (() => { const m = rotation(b.rot); return (x, y, z, f) => { x -= c[0]; y -= c[1]; z -= c[2]; return f(m[0] * x + m[3] * y + m[6] * z, m[1] * x + m[4] * y + m[7] * z, m[2] * x + m[5] * y + m[8] * z); }; })()
    : (x, y, z, f) => f(x - c[0], y - c[1], z - c[2]);
  let dist, centre = c, radius;
  switch (b.t) {
    case 'sphere': {
      const r = Math.abs(num(b.r, 1)) * s;
      dist = (x, y, z) => len3(x - c[0], y - c[1], z - c[2]) - r;
      radius = r;
      break;
    }
    case 'ellipsoid': {
      const r = (Array.isArray(b.r) ? vec(b.r) : [num(b.r, 1), num(b.r, 1), num(b.r, 1)]).map(v => Math.max(1e-3, Math.abs(v) * s));
      // the usual approximation (exact on the axes, close everywhere else)
      const e = (x, y, z) => {
        const k0 = len3(x / r[0], y / r[1], z / r[2]), k1 = len3(x / (r[0] * r[0]), y / (r[1] * r[1]), z / (r[2] * r[2]));
        return k1 > 0 ? k0 * (k0 - 1) / k1 : -Math.min(...r);
      };
      dist = (x, y, z) => local(x, y, z, e);
      radius = Math.max(...r);
      break;
    }
    case 'capsule': {
      // a round cone from a (radius r) to b (radius r2, default r): limbs, necks, tails, horns
      const a = vec(b.a).map(v => v * s), e = vec(b.b).map(v => v * s);
      const r1 = Math.abs(num(b.r, 1)) * s, r2 = Math.abs(num(b.r2, num(b.r, 1))) * s;
      const ba = [e[0] - a[0], e[1] - a[1], e[2] - a[2]], l2 = ba[0] ** 2 + ba[1] ** 2 + ba[2] ** 2;
      if (l2 < 1e-9) { dist = (x, y, z) => len3(x - a[0], y - a[1], z - a[2]) - Math.max(r1, r2); }
      else {
        const rr = r1 - r2, a2 = l2 - rr * rr, il2 = 1 / l2, k = Math.sign(rr) * rr * rr;
        dist = (x, y, z) => {
          const px = x - a[0], py = y - a[1], pz = z - a[2];
          const yy = px * ba[0] + py * ba[1] + pz * ba[2], zz = yy - l2;
          const qx = px * l2 - ba[0] * yy, qy = py * l2 - ba[1] * yy, qz = pz * l2 - ba[2] * yy;
          const x2 = qx * qx + qy * qy + qz * qz, y2 = yy * yy * l2, z2 = zz * zz * l2, kk = k * x2;
          if (Math.sign(zz) * a2 * z2 > kk) return Math.sqrt(x2 + z2) * il2 - r2;
          if (Math.sign(yy) * a2 * y2 < kk) return Math.sqrt(x2 + y2) * il2 - r1;
          return (Math.sqrt(x2 * a2 * il2) + yy * rr) * il2 - r1;
        };
      }
      centre = [(a[0] + e[0]) / 2, (a[1] + e[1]) / 2, (a[2] + e[2]) / 2];
      radius = Math.sqrt(l2) / 2 + Math.max(r1, r2);
      break;
    }
    case 'box': {
      const h = vec(b.size, [1, 1, 1]).map(v => Math.abs(v) * s / 2);
      const round = Math.min(Math.max(0, num(b.round) * s), ...h);
      const q = h.map(v => v - round);
      const f = (x, y, z) => {
        const dx = Math.abs(x) - q[0], dy = Math.abs(y) - q[1], dz = Math.abs(z) - q[2];
        return len3(Math.max(dx, 0), Math.max(dy, 0), Math.max(dz, 0)) + Math.min(Math.max(dx, dy, dz), 0) - round;
      };
      dist = (x, y, z) => local(x, y, z, f);
      radius = len3(...h);
      break;
    }
    case 'cylinder': {
      // upright (along Z) before its rotation, centred on c
      const r = Math.abs(num(b.r, 1)) * s, hh = Math.abs(num(b.h, 1)) * s / 2, round = Math.min(Math.max(0, num(b.round) * s), r, hh);
      const f = (x, y, z) => {
        const dx = Math.hypot(x, y) - r + round, dz = Math.abs(z) - hh + round;
        return Math.min(Math.max(dx, dz), 0) + Math.hypot(Math.max(dx, 0), Math.max(dz, 0)) - round;
      };
      dist = (x, y, z) => local(x, y, z, f);
      radius = Math.hypot(r, hh);
      break;
    }
    case 'torus': {
      // lying in the XY plane before its rotation: a ring, a rim, a handle
      const R = Math.abs(num(b.R, 2)) * s, r = Math.abs(num(b.r, 0.5)) * s;
      const f = (x, y, z) => Math.hypot(Math.hypot(x, y) - R, z) - r;
      dist = (x, y, z) => local(x, y, z, f);
      radius = R + r;
      break;
    }
    case 'cone': {
      // a cone with flat ends from a (radius ra) to b (radius rb): a hat, a nose, a beak, a horn
      const a = vec(b.a).map(v => v * s), e = vec(b.b).map(v => v * s);
      const ra = Math.abs(num(b.ra, 1)) * s, rb = Math.abs(num(b.rb, 0)) * s;
      const ba = [e[0] - a[0], e[1] - a[1], e[2] - a[2]], baba = ba[0] ** 2 + ba[1] ** 2 + ba[2] ** 2;
      if (baba < 1e-9) return 'Feature.FigureBlock';
      const rba = rb - ra, kk = rba * rba + baba;
      dist = (x, y, z) => {
        const px = x - a[0], py = y - a[1], pz = z - a[2];
        const papa = px * px + py * py + pz * pz, paba = (px * ba[0] + py * ba[1] + pz * ba[2]) / baba;
        const xx = Math.sqrt(Math.max(0, papa - paba * paba * baba));
        const cax = Math.max(0, xx - (paba < 0.5 ? ra : rb)), cay = Math.abs(paba - 0.5) - 0.5;
        const f = Math.min(1, Math.max(0, (rba * (xx - ra) + paba * baba) / kk));
        const cbx = xx - ra - f * rba, cby = paba - f;
        const sign = cbx < 0 && cay < 0 ? -1 : 1;
        return sign * Math.sqrt(Math.min(cax * cax + cay * cay * baba, cbx * cbx + cby * cby * baba));
      };
      centre = [(a[0] + e[0]) / 2, (a[1] + e[1]) / 2, (a[2] + e[2]) / 2];
      radius = Math.sqrt(baba) / 2 + Math.max(ra, rb);
      break;
    }
  }
  return { dist, centre, radius, cut, blend };
}

/** The signed distance of a group (negative inside): its blocks in order, added with a smooth union, cut with a smooth difference. */
function groupDistance(blocks) {
  return (x, y, z) => {
    let d = 1e9;
    for (const b of blocks) {
      const far = len3(x - b.centre[0], y - b.centre[1], z - b.centre[2]) - b.radius;
      const k = b.blend;
      if (!b.cut) {
        if (far >= d + k) continue;
        const e = b.dist(x, y, z);
        if (k > 0) { const h = Math.max(k - Math.abs(d - e), 0) / k; d = Math.min(d, e) - h * h * k * 0.25; }
        else d = Math.min(d, e);
      } else {
        if (far >= k - d) continue;
        const e = b.dist(x, y, z);
        if (k > 0) { const h = Math.max(k - Math.abs(-d - e), 0) / k; d = -(Math.min(-d, e) - h * h * k * 0.25); }
        else d = Math.max(d, -e);
      }
    }
    return d;
  };
}

/** The box of a group: around the balls of its added blocks, with room for the blending. */
function boxOf(blocks) {
  const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
  for (const b of blocks) {
    if (b.cut) continue;
    for (let k = 0; k < 3; k++) { min[k] = Math.min(min[k], b.centre[k] - b.radius - b.blend); max[k] = Math.max(max[k], b.centre[k] + b.radius + b.blend); }
  }
  return { min, max };
}

const cache = new Map();
const CACHE_SIZE = 48;

/**
 * The groups of a figure as meshes: [{ index, name, color, mesh: { vertProperties, triVerts } | null }] or throws { key }. params: { parts: [{ name, color, smooth, blocks }],
 * detail }, scale: the evaluated scale. The kernel makes the surface of each group (Manifold.levelSet), simplified a little.
 */
export function figureMeshes(kernel, params, scale = 1) {
  const groups = Array.isArray(params?.parts) ? params.parts.filter(g => g && Array.isArray(g.blocks) && g.blocks.length) : [];
  if (!groups.length) throw { key: 'Feature.FigureEmpty' };
  if (groups.length > MAX_GROUPS || groups.reduce((n, g) => n + g.blocks.length, 0) > MAX_BLOCKS) throw { key: 'Feature.FigureTooBig', args: [MAX_BLOCKS] };
  const s = scale > 0 ? scale : 1;
  const built = groups.map((g, gi) => {
    const smooth = Math.max(0, num(g.smooth, 2));
    const blocks = g.blocks.map((b, bi) => {
      const made = block(b, s, smooth);
      if (typeof made === 'string') throw { key: made, args: [g.name || String(gi + 1), bi + 1] };
      return made;
    });
    if (!blocks.some(b => !b.cut)) throw { key: 'Feature.FigureBlock', args: [g.name || String(gi + 1), 1] };
    return { g, gi, blocks, box: boxOf(blocks) };
  });
  // one cell size for the whole figure (from its largest side), finer for a small group so that it keeps its shape
  const all = { min: [0, 1, 2].map(k => Math.min(...built.map(b => b.box.min[k]))), max: [0, 1, 2].map(k => Math.max(...built.map(b => b.box.max[k]))) };
  const extent = Math.max(...[0, 1, 2].map(k => all.max[k] - all.min[k]));
  const cells = CELLS[params.detail] || CELLS.normal;
  const base = Number((extent / cells).toPrecision(2));
  return built.map(({ g, gi, blocks, box }) => {
    const own = Math.max(...[0, 1, 2].map(k => box.max[k] - box.min[k]));
    const h = Math.max(base / 3, Math.min(base, Number((own / 24).toPrecision(2))));
    const key = JSON.stringify([g.blocks, g.smooth, s, h]);
    let mesh = cache.get(key);
    if (!mesh) {
      const d = groupDistance(blocks);
      const pad = 2 * h;
      const bounds = { min: box.min.map(v => v - pad), max: box.max.map(v => v + pad) };
      const raw = kernel.Manifold.levelSet(p => -d(p[0], p[1], p[2]), bounds, h);
      try {
        const solid = raw.isEmpty() ? null : raw.simplify(h * 0.05);
        if (solid) {
          const m = solid.getMesh();
          mesh = { vertProperties: Float32Array.from(m.vertProperties), triVerts: Uint32Array.from(m.triVerts), numProp: m.numProp };
          solid.delete();
        } else mesh = { empty: true };
      } finally {
        raw.delete();
      }
      cache.set(key, mesh);
      if (cache.size > CACHE_SIZE) cache.delete(cache.keys().next().value);
    } else {
      // most recently used last
      cache.delete(key);
      cache.set(key, mesh);
    }
    return { index: gi, name: typeof g.name === 'string' ? g.name.slice(0, 80) : null, color: /^#[0-9a-f]{6}$/i.test(g.color || '') ? g.color : null, mesh: mesh.empty ? null : mesh };
  });
}
