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

// ---- 3MF (the format of the 3D printers and slicers): one object per part, each with its colour (core spec, basematerials / displaycolor) --------------

const xml = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const num = v => (Math.abs(v) < 1e-9 ? 0 : v).toFixed(5).replace(/\.?0+$/, '');

/** A 3MF file of the parts: names and colours as in the Part Studio, millimetres. */
export function toThreeMf(parts, names, title = 'MatShape') {
  const out = ['<?xml version="1.0" encoding="UTF-8"?>',
    '<model unit="millimeter" xml:lang="en-US" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02">',
    `<metadata name="Title">${xml(title)}</metadata>`, '<metadata name="Application">MatShape</metadata>', '<resources>', '<basematerials id="1">'];
  parts.forEach((part, i) => out.push(`<base name="${xml(names[i] || part.id)}" displaycolor="${xml((part.color || '#9fb3c8').toUpperCase())}FF"/>`));
  out.push('</basematerials>');
  parts.forEach((part, i) => {
    const p = part.mesh.positions, map = new Map(), verts = [], tris = [];
    for (let t = 0; t < part.mesh.triangles; t++) {
      const f = [];
      for (let c = 0; c < 3; c++) {
        const k = t * 9 + c * 3;
        const key = `${p[k]},${p[k + 1]},${p[k + 2]}`;
        let idx = map.get(key);
        if (idx === undefined) { idx = verts.length; map.set(key, idx); verts.push(`<vertex x="${num(p[k])}" y="${num(p[k + 1])}" z="${num(p[k + 2])}"/>`); }
        f.push(idx);
      }
      if (f[0] !== f[1] && f[1] !== f[2] && f[0] !== f[2]) tris.push(`<triangle v1="${f[0]}" v2="${f[1]}" v3="${f[2]}"/>`);
    }
    out.push(`<object id="${i + 2}" type="model" name="${xml(names[i] || part.id)}" pid="1" pindex="${i}"><mesh><vertices>`, ...verts, '</vertices><triangles>', ...tris, '</triangles></mesh></object>');
  });
  out.push('</resources>', '<build>', ...parts.map((_, i) => `<item objectid="${i + 2}"/>`), '</build>', '</model>');
  const files = [
    ['[Content_Types].xml', '<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="model" ContentType="application/vnd.ms-package.3dmanufacturing-3dmodel+xml"/></Types>'],
    ['_rels/.rels', '<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Target="/3D/3dmodel.model" Id="rel0" Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel"/></Relationships>'],
    ['3D/3dmodel.model', out.join('\n')],
  ];
  return new Blob([zip(files)], { type: 'model/3mf' });
}

// ---- a small ZIP writer (stored, no compression): enough for a 3MF package ---------------------------------------------------

const CRC = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; table[n] = c >>> 0; }
  return table;
})();

function crc32(bytes) {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = CRC[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** files: [[name, text]] -> the bytes of a ZIP archive. */
export function zip(files) {
  const enc = new TextEncoder();
  const entries = files.map(([name, text]) => ({ name: enc.encode(name), data: enc.encode(text) }));
  let size = 22;
  for (const e of entries) { e.crc = crc32(e.data); size += 30 + e.name.length + e.data.length + 46 + e.name.length; }
  const buf = new Uint8Array(size), view = new DataView(buf.buffer);
  let o = 0;
  const local = [];
  for (const e of entries) {
    local.push(o);
    view.setUint32(o, 0x04034b50, true); view.setUint16(o + 4, 20, true); view.setUint16(o + 6, 0x0800, true); view.setUint16(o + 8, 0, true);
    view.setUint32(o + 10, 0, true); view.setUint32(o + 14, e.crc, true); view.setUint32(o + 18, e.data.length, true); view.setUint32(o + 22, e.data.length, true);
    view.setUint16(o + 26, e.name.length, true); view.setUint16(o + 28, 0, true);
    buf.set(e.name, o + 30); buf.set(e.data, o + 30 + e.name.length);
    o += 30 + e.name.length + e.data.length;
  }
  const start = o;
  entries.forEach((e, i) => {
    view.setUint32(o, 0x02014b50, true); view.setUint16(o + 4, 20, true); view.setUint16(o + 6, 20, true); view.setUint16(o + 8, 0x0800, true); view.setUint16(o + 10, 0, true);
    view.setUint32(o + 12, 0, true); view.setUint32(o + 16, e.crc, true); view.setUint32(o + 20, e.data.length, true); view.setUint32(o + 24, e.data.length, true);
    view.setUint16(o + 28, e.name.length, true); view.setUint16(o + 30, 0, true); view.setUint16(o + 32, 0, true); view.setUint16(o + 34, 0, true); view.setUint16(o + 36, 0, true);
    view.setUint32(o + 38, 0, true); view.setUint32(o + 42, local[i], true);
    buf.set(e.name, o + 46);
    o += 46 + e.name.length;
  });
  view.setUint32(o, 0x06054b50, true); view.setUint16(o + 8, entries.length, true); view.setUint16(o + 10, entries.length, true);
  view.setUint32(o + 12, o - start, true); view.setUint32(o + 16, start, true);
  return buf;
}
