/* MatShape – files of the model: STL (binary, every visible part in one file, millimetres) and OBJ (one object per part). Made in the browser from the meshes. */

function normalOf(p, i) {
  const ax = p[i + 3] - p[i], ay = p[i + 4] - p[i + 1], az = p[i + 5] - p[i + 2];
  const bx = p[i + 6] - p[i], by = p[i + 7] - p[i + 1], bz = p[i + 8] - p[i + 2];
  const nx = ay * bz - az * by, ny = az * bx - ax * bz, nz = ax * by - ay * bx;
  const l = Math.hypot(nx, ny, nz) || 1;
  return [nx / l, ny / l, nz / l];
}

/** Binary STL of the parts. */
export function toStl(parts, title = 'MatShape') {
  const triangles = parts.reduce((n, p) => n + p.mesh.triangles, 0);
  const buffer = new ArrayBuffer(84 + triangles * 50);
  const view = new DataView(buffer);
  const header = new TextEncoder().encode(`MatShape STL: ${title}`.slice(0, 79));
  new Uint8Array(buffer, 0, 80).set(header);
  view.setUint32(80, triangles, true);
  let o = 84;
  for (const part of parts) {
    const p = part.mesh.positions;
    for (let t = 0; t < part.mesh.triangles; t++) {
      const i = t * 9;
      const n = normalOf(p, i);
      for (const v of n) { view.setFloat32(o, v, true); o += 4; }
      for (let k = 0; k < 9; k++) { view.setFloat32(o, p[i + k], true); o += 4; }
      view.setUint16(o, 0, true);
      o += 2;
    }
  }
  return new Blob([buffer], { type: 'model/stl' });
}

/** Wavefront OBJ: one object per part, shared vertices per part. */
export function toObj(parts, names) {
  const lines = ['# MatShape OBJ (millimetres)'];
  let base = 1;
  parts.forEach((part, index) => {
    lines.push(`o ${(names[index] || part.id).replace(/\s+/g, '_')}`);
    const p = part.mesh.positions;
    const map = new Map();
    const verts = [];
    const faces = [];
    for (let t = 0; t < part.mesh.triangles; t++) {
      const f = [];
      for (let c = 0; c < 3; c++) {
        const i = t * 9 + c * 3;
        const key = `${p[i]},${p[i + 1]},${p[i + 2]}`;
        let idx = map.get(key);
        if (idx === undefined) { idx = verts.length; map.set(key, idx); verts.push(key); }
        f.push(idx + base);
      }
      faces.push(f);
    }
    verts.forEach(v => lines.push('v ' + v.split(',').map(x => Number(x).toFixed(5)).join(' ')));
    faces.forEach(f => lines.push('f ' + f.join(' ')));
    base += verts.length;
  });
  return new Blob([lines.join('\n') + '\n'], { type: 'text/plain' });
}
