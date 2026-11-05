/* MatShape – exchange with other CAD programs. Export: STEP AP214, written here (no library): every part a closed B-rep solid, its flat regions merged into
   real faces (with their holes), round regions as small flat faces; the colours of the parts. Import: STEP, IGES and BREP through OpenCascade
   (occt-import-js, WebAssembly in /lib/occt, in a worker started only when such a file comes), STL read here; the result is a mesh per body for the feature "import".
   Points in millimetres. */

// ---- export ---------------------------------------------------------------------------------------------------------------------

/**
 * STEP AP214 of parts: [{ manifold (or mesh: { vertProperties, triVerts, numProp, faceID }), name, color }]. Returns the text of the file.
 */
export function toStep(parts, title = 'MatShape') {
  const out = [];
  let n = 0;
  const add = text => { n++; out.push(`#${n}=${text};`); return n; };
  // a real of STEP: always with a decimal point (10. 1.5 1.23E-07)
  const num = v => {
    if (!Number.isFinite(v) || Math.abs(v) < 1e-12) return '0.';
    let [m, e] = v.toPrecision(12).split('e');
    if (m.includes('.')) m = m.replace(/0+$/, '');
    if (!m.includes('.')) m += '.';
    return e ? m + 'E' + e : m;
  };
  const str = s => `'${String(s).replace(/'/g, "''").replace(/[^\x20-\x7e]/g, '_')}'`;
  const point = p => add(`CARTESIAN_POINT('',(${num(p[0])},${num(p[1])},${num(p[2])}))`);
  const dir = d => add(`DIRECTION('',(${num(d[0])},${num(d[1])},${num(d[2])}))`);

  const app = add(`APPLICATION_CONTEXT('core data for automotive mechanical design processes')`);
  add(`APPLICATION_PROTOCOL_DEFINITION('international standard','automotive_design',2000,#${app})`);
  const lengthUnit = add(`(LENGTH_UNIT()NAMED_UNIT(*)SI_UNIT(.MILLI.,.METRE.))`);
  const angleUnit = add(`(NAMED_UNIT(*)PLANE_ANGLE_UNIT()SI_UNIT($,.RADIAN.))`);
  const solidUnit = add(`(NAMED_UNIT(*)SI_UNIT($,.STERADIAN.)SOLID_ANGLE_UNIT())`);
  const uncertainty = add(`UNCERTAINTY_MEASURE_WITH_UNIT(LENGTH_MEASURE(1.E-06),#${lengthUnit},'distance_accuracy_value','confusion accuracy')`);
  const context = add(`(GEOMETRIC_REPRESENTATION_CONTEXT(3)GLOBAL_UNCERTAINTY_ASSIGNED_CONTEXT((#${uncertainty}))GLOBAL_UNIT_ASSIGNED_CONTEXT((#${lengthUnit},#${angleUnit},#${solidUnit}))REPRESENTATION_CONTEXT('Context #1','3D Context with UNIT and UNCERTAINTY'))`);
  const origin = add(`AXIS2_PLACEMENT_3D('',#${point([0, 0, 0])},#${dir([0, 0, 1])},#${dir([1, 0, 0])})`);
  const productContext = add(`PRODUCT_CONTEXT('',#${app},'mechanical')`);
  const definitionContext = add(`PRODUCT_DEFINITION_CONTEXT('part definition',#${app},'design')`);

  const solids = [], styles = [];
  parts.forEach((part, k) => {
    const mesh = part.mesh?.vertProperties ? part.mesh : part.manifold.getMesh();
    const solid = brep(mesh, add, point, dir, num, part.name || `Part ${k + 1}`, str);
    if (!solid) return;
    solids.push(solid);
    const c = hexToRgb(part.color);
    if (c) {
      const rgb = add(`COLOUR_RGB('',${num(c[0])},${num(c[1])},${num(c[2])})`);
      const fill = add(`FILL_AREA_STYLE('',(#${add(`FILL_AREA_STYLE_COLOUR('',#${rgb})`)}))`);
      const side = add(`SURFACE_SIDE_STYLE('',(#${add(`SURFACE_STYLE_FILL_AREA(#${fill})`)}))`);
      const usage = add(`SURFACE_STYLE_USAGE(.BOTH.,#${side})`);
      styles.push(add(`STYLED_ITEM('color',(#${add(`PRESENTATION_STYLE_ASSIGNMENT((#${usage}))`)}),#${solid})`));
    }
  });
  const shape = add(`ADVANCED_BREP_SHAPE_REPRESENTATION(${str(title)},(#${origin}${solids.map(s => ',#' + s).join('')}),#${context})`);
  const product = add(`PRODUCT(${str(title)},${str(title)},'',(#${productContext}))`);
  add(`PRODUCT_RELATED_PRODUCT_CATEGORY('part',$,(#${product}))`);
  const formation = add(`PRODUCT_DEFINITION_FORMATION('','',#${product})`);
  const definition = add(`PRODUCT_DEFINITION('design','',#${formation},#${definitionContext})`);
  const definitionShape = add(`PRODUCT_DEFINITION_SHAPE('','',#${definition})`);
  add(`SHAPE_DEFINITION_REPRESENTATION(#${definitionShape},#${shape})`);
  if (styles.length) add(`MECHANICAL_DESIGN_GEOMETRIC_PRESENTATION_REPRESENTATION('',(${styles.map(s => '#' + s).join(',')}),#${context})`);
  const stamp = new Date().toISOString().slice(0, 19);
  return ['ISO-10303-21;', 'HEADER;', `FILE_DESCRIPTION(('MatShape model'),'2;1');`, `FILE_NAME(${str(title + '.step')},'${stamp}',(''),(''),'MatShape','MatShape','');`,
    `FILE_SCHEMA(('AUTOMOTIVE_DESIGN { 1 0 10303 214 1 1 1 1 }'));`, 'ENDSEC;', 'DATA;', ...out, 'ENDSEC;', 'END-ISO-10303-21;', ''].join('\n');
}

/** One closed shell: the triangles grouped into flat faces (same face number and plane), each face bounded by the loops of its outer edges. */
function brep(mesh, add, point, dir, num, name, str) {
  const np = mesh.numProp || 3, vp = mesh.vertProperties, tv = mesh.triVerts, T = tv.length / 3;
  if (!T) return null;
  const P = i => [vp[i * np], vp[i * np + 1], vp[i * np + 2]];
  const normalOf = t => {
    const a = P(tv[t * 3]), b = P(tv[t * 3 + 1]), c = P(tv[t * 3 + 2]);
    const n = [(b[1] - a[1]) * (c[2] - a[2]) - (b[2] - a[2]) * (c[1] - a[1]), (b[2] - a[2]) * (c[0] - a[0]) - (b[0] - a[0]) * (c[2] - a[2]), (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0])];
    const l = Math.hypot(...n);
    return l > 1e-15 ? n.map(v => v / l) : null;
  };
  // groups: triangles of one face number that lie in one plane, joined across their edges
  const half = new Map();
  for (let t = 0; t < T; t++) for (let k = 0; k < 3; k++) half.set(tv[t * 3 + k] + ',' + tv[t * 3 + (k + 1) % 3], t);
  const normals = Array.from({ length: T }, (_, t) => normalOf(t));
  const group = new Int32Array(T).fill(-1);
  const fid = mesh.faceID && mesh.faceID.length === T ? mesh.faceID : null;
  let groups = 0;
  for (let s = 0; s < T; s++) {
    if (group[s] >= 0 || !normals[s]) continue;
    const g = groups++, stack = [s], n0 = normals[s], d0 = n0[0] * vp[tv[s * 3] * np] + n0[1] * vp[tv[s * 3] * np + 1] + n0[2] * vp[tv[s * 3] * np + 2];
    group[s] = g;
    while (stack.length) {
      const t = stack.pop();
      for (let k = 0; k < 3; k++) {
        const u = half.get(tv[t * 3 + (k + 1) % 3] + ',' + tv[t * 3 + k]);
        if (u === undefined || group[u] >= 0 || !normals[u]) continue;
        if (fid && fid[u] !== fid[s]) continue;
        const n = normals[u], p = P(tv[u * 3]);
        if (n[0] * n0[0] + n[1] * n0[1] + n[2] * n0[2] < 1 - 1e-9 || Math.abs(n0[0] * p[0] + n0[1] * p[1] + n0[2] * p[2] - d0) > 1e-6) continue;
        group[u] = g;
        stack.push(u);
      }
    }
  }
  // the entities shared by the faces: points, vertices, edges
  const vertex = new Map(), edges = new Map();
  const vertexOf = i => { if (!vertex.has(i)) vertex.set(i, add(`VERTEX_POINT('',#${point(P(i))})`)); return vertex.get(i); };
  const edgeOf = (a, b) => {
    const key = a < b ? a + ',' + b : b + ',' + a;
    if (!edges.has(key)) {
      const [s, e] = a < b ? [a, b] : [b, a];
      const ps = P(s), pe = P(e), d = [pe[0] - ps[0], pe[1] - ps[1], pe[2] - ps[2]], l = Math.hypot(...d) || 1;
      const line = add(`LINE('',#${point(ps)},#${add(`VECTOR('',#${dir(d.map(v => v / l))},${num(l)})`)})`);
      edges.set(key, { id: add(`EDGE_CURVE('',#${vertexOf(s)},#${vertexOf(e)},#${line},.T.)`), s });
    }
    const edge = edges.get(key);
    return add(`ORIENTED_EDGE('',*,*,#${edge.id},${edge.s === a ? '.T.' : '.F.'})`);
  };
  const faces = [];
  const members = Array.from({ length: groups }, () => []);
  for (let t = 0; t < T; t++) if (group[t] >= 0) members[group[t]].push(t);
  for (const tris of members) {
    // the outer edges of the group, then their loops (each vertex has one edge going on)
    const inGroup = new Set(tris), next = new Map();
    for (const t of tris) for (let k = 0; k < 3; k++) {
      const a = tv[t * 3 + k], b = tv[t * 3 + (k + 1) % 3];
      const other = half.get(b + ',' + a);
      if (other === undefined || !inGroup.has(other)) { if (!next.has(a)) next.set(a, []); next.get(a).push(b); }
    }
    const loops = [];
    for (const [start] of next) {
      while (next.get(start)?.length) {
        const loop = [start];
        let v = start;
        for (let guard = 0; guard < 1e6; guard++) {
          const list = next.get(v);
          if (!list?.length) break;
          const w = list.pop();
          if (w === start) break;
          loop.push(w);
          v = w;
        }
        if (loop.length >= 3) loops.push(loop);
      }
    }
    if (!loops.length) continue;
    const n0 = normals[tris[0]];
    // the outer loop: the largest area (seen along the normal)
    const area = loop => { let s = [0, 0, 0]; for (let i = 0; i < loop.length; i++) { const a = P(loop[i]), b = P(loop[(i + 1) % loop.length]); s = [s[0] + a[1] * b[2] - a[2] * b[1], s[1] + a[2] * b[0] - a[0] * b[2], s[2] + a[0] * b[1] - a[1] * b[0]]; } return (s[0] * n0[0] + s[1] * n0[1] + s[2] * n0[2]) / 2; };
    const outer = loops.reduce((best, l) => (Math.abs(area(l)) > Math.abs(area(best)) ? l : best), loops[0]);
    const bounds = loops.map(loop => {
      const edgeLoop = add(`EDGE_LOOP('',(${loop.map((a, i) => '#' + edgeOf(a, loop[(i + 1) % loop.length])).join(',')}))`);
      return add(`${loop === outer ? 'FACE_OUTER_BOUND' : 'FACE_BOUND'}('',#${edgeLoop},.T.)`);
    });
    const p0 = P(outer[0]), ref = Math.abs(n0[2]) < 0.9 ? [n0[1], -n0[0], 0] : [0, n0[2], -n0[1]], rl = Math.hypot(...ref) || 1;
    const plane = add(`PLANE('',#${add(`AXIS2_PLACEMENT_3D('',#${point(p0)},#${dir(n0)},#${dir(ref.map(v => v / rl))})`)})`);
    faces.push(add(`ADVANCED_FACE('',(${bounds.map(b => '#' + b).join(',')}),#${plane},.T.)`));
  }
  const shell = add(`CLOSED_SHELL('',(${faces.map(f => '#' + f).join(',')}))`);
  return add(`MANIFOLD_SOLID_BREP(${str(name)},#${shell})`);
}

function hexToRgb(hex) {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex || '');
  if (!m) return null;
  const v = parseInt(m[1], 16);
  return [(v >> 16) / 255, ((v >> 8) & 255) / 255, (v & 255) / 255];
}

// ---- import -----------------------------------------------------------------------------------------------------------------------

/**
 * Reads a file with OpenCascade in a Web Worker (the worker of occt-import-js in /lib/occt). Its code builds functions at run time (embind), which the
 * Content-Security-Policy of MatShape does not allow; without a policy of its own for /lib/occt the worker fails and the import says so.
 */
function readInWorker(format, bytes, params) {
  return new Promise((resolve, reject) => {
    const worker = new Worker('/lib/occt/occt-import-js-worker.js');
    worker.onmessage = e => { worker.terminate(); resolve(e.data); };
    worker.onerror = e => { e.preventDefault?.(); worker.terminate(); reject(new Error('occt')); };
    worker.postMessage({ format, buffer: bytes, params });
  });
}

/**
 * The bodies of a CAD file: [{ name, color: '#rrggbb' | null, positions: Float32Array, indices: Uint32Array, faces: Int32Array (face of the source per triangle) }].
 * kind: 'step', 'iges', 'brep' (through OpenCascade: the module given (Node), else a worker) or 'stl'.
 */
export async function readCad(bytes, kind, occt = null) {
  if (kind === 'stl') return [readStl(bytes)];
  const params = { linearUnit: 'millimeter', linearDeflectionType: 'bounding_box_ratio', linearDeflection: 0.0015, angularDeflection: 0.2 };
  // in Node (tests) the module is given; in the browser a worker reads the file
  const result = occt ? (kind === 'iges' ? occt.ReadIgesFile(bytes, params) : kind === 'brep' ? occt.ReadBrepFile(bytes, params) : occt.ReadStepFile(bytes, params)) : await readInWorker(kind, bytes, params);
  if (!result?.success) throw new Error('read');
  return result.meshes.map((mesh, k) => {
    const indices = Uint32Array.from(mesh.index.array), faces = new Int32Array(indices.length / 3).fill(-1);
    (mesh.brep_faces || []).forEach((f, i) => { for (let t = f.first; t <= f.last; t++) faces[t] = i; });
    // OpenCascade gives linear colours; the screen wants sRGB
    const c = mesh.color, srgb = v => (v <= 0.0031308 ? 12.92 * v : 1.055 * Math.pow(v, 1 / 2.4) - 0.055);
    return { name: mesh.name || `Body ${k + 1}`, color: c ? '#' + c.map(v => Math.round(Math.min(1, Math.max(0, srgb(v))) * 255).toString(16).padStart(2, '0')).join('') : null, positions: Float32Array.from(mesh.attributes.position.array), indices, faces };
  });
}

/** An STL file (binary or text) as one mesh (the corners welded later by the kernel). */
export function readStl(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const count = bytes.byteLength >= 84 ? view.getUint32(80, true) : 0;
  let positions;
  if (count && 84 + count * 50 === bytes.byteLength) {
    positions = new Float32Array(count * 9);
    for (let t = 0; t < count; t++) for (let k = 0; k < 9; k++) positions[t * 9 + k] = view.getFloat32(84 + t * 50 + 12 + k * 4, true);
  } else {
    const text = new TextDecoder().decode(bytes), list = [];
    for (const m of text.matchAll(/vertex\s+(\S+)\s+(\S+)\s+(\S+)/g)) list.push(Number(m[1]), Number(m[2]), Number(m[3]));
    positions = Float32Array.from(list);
  }
  const indices = Uint32Array.from({ length: positions.length / 3 }, (_, i) => i);
  return { name: 'STL', color: null, positions, indices, faces: new Int32Array(indices.length / 3).fill(0) };
}

// ---- storing meshes in the content of a Part Studio (base64 of the arrays) --------------------------------------------------------

export function packArray(arr) {
  const bytes = new Uint8Array(arr.buffer, arr.byteOffset, arr.byteLength);
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

export function unpackArray(text, Type) {
  const s = atob(text || ''), bytes = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) bytes[i] = s.charCodeAt(i);
  return new Type(bytes.buffer);
}
