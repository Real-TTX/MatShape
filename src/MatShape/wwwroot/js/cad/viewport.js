/* MatShape – the 3D view: an orthographic camera that turns about the model (Z up), the parts with their edges, the planes, the sketches, picking and highlighting.
   It draws only when something changed. Mouse: left drag on empty space or right drag turns, middle drag or Shift + drag pans, the wheel zooms to the pointer.
   Touch: one finger turns, two fingers pan and pinch. The colours and line widths come from the view theme (setTheme). */

import * as THREE from '/lib/three/three.module.js';
import { LineSegments2 } from '/lib/three/lines/LineSegments2.js';
import { LineSegmentsGeometry } from '/lib/three/lines/LineSegmentsGeometry.js';
import { LineMaterial } from '/lib/three/lines/LineMaterial.js';
import { STANDARD_PLANES, entityPolyline, toWorld } from './geom.js';

// ---- the colour schemes of the view (themes). Lines have real widths in pixels (WebGL alone draws 1 px). "auto" follows light and dark mode of the app.
const AUTO_LIGHT = { background: null, edge: 0x1f2937, edgeOpacity: 0.9, edgeWidth: 1.6, sketch: 0x2563eb, defined: 0x111827, conflict: 0xdc2626, sketchWidth: 2.2, cons: 0x6b7280, dim: 0x374151, grid: 0x6b7280, gridOpacity: 0.16, axis: 0x4b5563, plane: 0x3cb764, select: 0xf59e0b, hover: 0x3b82f6 };
const AUTO_DARK = { background: null, edge: 0xe5e7eb, edgeOpacity: 0.95, edgeWidth: 1.6, sketch: 0x60a5fa, defined: 0xf9fafb, conflict: 0xf87171, sketchWidth: 2.2, cons: 0x9ca3af, dim: 0xd1d5db, grid: 0x9ca3af, gridOpacity: 0.16, axis: 0x9ca3af, plane: 0x3cb764, select: 0xfbbf24, hover: 0x93c5fd };
const THEMES = {
  contrast: { background: '#ffffff', edge: 0x000000, edgeOpacity: 1, edgeWidth: 2.4, sketch: 0x0050ff, defined: 0x000000, conflict: 0xdc2626, sketchWidth: 2.8, cons: 0x374151, dim: 0x111827, grid: 0x111827, gridOpacity: 0.22, axis: 0x111827, plane: 0x15803d, select: 0xd97706, hover: 0x2563eb },
  dark: { background: 'linear-gradient(180deg, #2c313a 0%, #121418 100%)', edge: 0xf9fafb, edgeOpacity: 1, edgeWidth: 1.9, sketch: 0x7dd3fc, defined: 0xffffff, conflict: 0xf87171, sketchWidth: 2.5, cons: 0xa1a1aa, dim: 0xe5e7eb, grid: 0xe5e7eb, gridOpacity: 0.14, axis: 0xd1d5db, plane: 0x4ade80, select: 0xfbbf24, hover: 0x93c5fd },
  blueprint: { background: 'linear-gradient(180deg, #1e4f93 0%, #0b2a57 100%)', edge: 0xffffff, edgeOpacity: 1, edgeWidth: 1.9, sketch: 0xffd166, defined: 0xffffff, conflict: 0xff6b6b, sketchWidth: 2.6, cons: 0xbfdbfe, dim: 0xffffff, grid: 0xffffff, gridOpacity: 0.13, axis: 0xdbeafe, plane: 0x93c5fd, select: 0xfb923c, hover: 0xfde68a },
};
export const VIEW_THEMES = ['auto', 'contrast', 'dark', 'blueprint'];
let themeName = 'auto';
let palette = AUTO_LIGHT;
const resolution = new THREE.Vector2(1, 1);

function refreshPalette() { palette = themeName === 'auto' || !THEMES[themeName] ? (isDark() ? AUTO_DARK : AUTO_LIGHT) : THEMES[themeName]; }

/** Line segments with a width in pixels: points is a list of [x, y, z], two per segment. */
function fatLines(points, color, width, options = {}) {
  const flat = new Float32Array(points.length * 3);
  points.forEach((p, i) => flat.set(p, i * 3));
  const geometry = new LineSegmentsGeometry().setPositions(flat);
  const material = new LineMaterial({ color, linewidth: width, transparent: options.opacity !== undefined && options.opacity < 1, opacity: options.opacity ?? 1, depthTest: options.depthTest ?? true });
  material.resolution.copy(resolution);
  const lines = new LineSegments2(geometry, material);
  lines.renderOrder = options.renderOrder ?? 0;
  return lines;
}

export class Viewport {
  constructor(canvas, triad) {
    this.canvas = canvas;
    this.triad = triad;
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true, preserveDrawingBuffer: false });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    this.renderer.setClearColor(0x000000, 0);

    this.scene = new THREE.Scene();
    this.camera = new THREE.OrthographicCamera(-1, 1, 1, -1, -100000, 100000);
    this.camera.up.set(0, 0, 1);
    this.target = new THREE.Vector3();
    this.viewHeight = 200;           // the height of the view in mm
    this.scene.add(new THREE.HemisphereLight(0xffffff, 0x8899aa, 1.6));
    this.headlight = new THREE.DirectionalLight(0xffffff, 1.6);
    this.scene.add(this.headlight);
    this.scene.add(this.headlight.target);

    this.partsGroup = new THREE.Group();
    this.planesGroup = new THREE.Group();
    this.sketchGroup = new THREE.Group();
    this.overlayGroup = new THREE.Group();
    this.scene.add(this.partsGroup, this.planesGroup, this.sketchGroup, this.overlayGroup);

    this.partObjects = new Map();    // part id -> { mesh, edges, part }
    this.display = 'shaded';         // shaded | edges | wireframe
    this.showPlanes = true;
    this.selected = new Set();       // part ids
    this.hoverFace = null;
    this.raycaster = new THREE.Raycaster();
    this.listeners = {};
    this.dirty = true;
    this.sceneSize = 100;
    this.navigationOnly = false;     // true while a sketch tool draws: left drag draws, not turns

    this.setView('iso', false);
    this.bindPointer();
    new ResizeObserver(() => this.resize()).observe(canvas.parentElement);
    this.resize();
    const loop = () => { if (this.dirty) { this.dirty = false; this.render(); } requestAnimationFrame(loop); };
    requestAnimationFrame(loop);
  }

  on(name, fn) { (this.listeners[name] ||= []).push(fn); }

  emit(name, detail) { (this.listeners[name] || []).forEach(fn => fn(detail)); }

  invalidate() { this.dirty = true; }

  resize() {
    const box = this.canvas.parentElement.getBoundingClientRect();
    this.width = Math.max(1, box.width);
    this.height = Math.max(1, box.height);
    this.renderer.setSize(this.width, this.height, false);
    // lines with a width in pixels need the size of the view
    resolution.set(this.width, this.height);
    this.scene.traverse(o => { if (o.material?.isLineMaterial) o.material.resolution.copy(resolution); });
    this.updateCamera();
  }

  updateCamera() {
    const aspect = this.width / this.height;
    const h = this.viewHeight / 2;
    this.camera.left = -h * aspect;
    this.camera.right = h * aspect;
    this.camera.top = h;
    this.camera.bottom = -h;
    this.camera.updateProjectionMatrix();
    const dir = new THREE.Vector3(0, 0, 1).applyQuaternion(this.camera.quaternion);
    this.camera.position.copy(this.target).addScaledVector(dir, 50000);
    this.camera.updateMatrixWorld();
    this.headlight.position.copy(this.camera.position).add(new THREE.Vector3(0.3, 0.5, 0).applyQuaternion(this.camera.quaternion).multiplyScalar(20000));
    this.headlight.target.position.copy(this.target);
    this.invalidate();
  }

  /** The millimetres one pixel of the screen is. */
  get mmPerPixel() { return this.viewHeight / this.height; }

  // ---- views ---------------------------------------------------------------------------------------------------------------

  /** A named view (iso, top, front, right, back, left, bottom) or a direction + up. */
  setView(name, animate = true, dir, up) {
    const views = {
      iso: [[1, -1, 0.8], [0, 0, 1]],
      top: [[0, 0, 1], [0, 1, 0]],
      bottom: [[0, 0, -1], [0, -1, 0]],
      front: [[0, -1, 0], [0, 0, 1]],
      back: [[0, 1, 0], [0, 0, 1]],
      right: [[1, 0, 0], [0, 0, 1]],
      left: [[-1, 0, 0], [0, 0, 1]],
    };
    const [d, u] = dir ? [dir, up] : views[name] || views.iso;
    const back = new THREE.Vector3(...d).normalize();
    const upv = new THREE.Vector3(...u).normalize();
    const m = new THREE.Matrix4().lookAt(back, new THREE.Vector3(), upv);
    const q = new THREE.Quaternion().setFromRotationMatrix(m);
    if (!animate) { this.camera.quaternion.copy(q); this.updateCamera(); return; }
    const from = this.camera.quaternion.clone();
    const start = performance.now();
    const step = now => {
      const k = Math.min(1, (now - start) / 260);
      const e = k < 0.5 ? 2 * k * k : 1 - Math.pow(-2 * k + 2, 2) / 2;
      this.camera.quaternion.slerpQuaternions(from, q, e);
      this.updateCamera();
      if (k < 1) requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  }

  /** The view as it is (to come back to it after a sketch). */
  saveView() {
    return { q: this.camera.quaternion.clone(), target: this.target.clone(), height: this.viewHeight };
  }

  restoreView(view) {
    if (!view) return;
    const fromQ = this.camera.quaternion.clone(), fromT = this.target.clone(), fromH = this.viewHeight, start = performance.now();
    const step = now => {
      const k = Math.min(1, (now - start) / 300);
      const e = k < 0.5 ? 2 * k * k : 1 - Math.pow(-2 * k + 2, 2) / 2;
      this.camera.quaternion.slerpQuaternions(fromQ, view.q, e);
      this.target.lerpVectors(fromT, view.target, e);
      this.viewHeight = fromH + (view.height - fromH) * e;
      this.updateCamera();
      if (k < 1) requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  }

  /** Looks straight at a plane (a sketch). */
  normalTo(frame, animate = true) {
    this.setView(null, animate, frame.n, frame.y);
  }

  /** Zooms and pans so everything visible fits. */
  fit(animate = true) {
    const box = new THREE.Box3();
    this.partsGroup.children.forEach(o => { if (o.visible) box.expandByObject(o); });
    this.sketchGroup.children.forEach(o => { if (o.visible) box.expandByObject(o); });
    if (box.isEmpty()) box.set(new THREE.Vector3(-60, -60, -60), new THREE.Vector3(60, 60, 60));
    // the extent of the box as the camera sees it
    const corners = [];
    for (let i = 0; i < 8; i++) corners.push(new THREE.Vector3(i & 1 ? box.max.x : box.min.x, i & 2 ? box.max.y : box.min.y, i & 4 ? box.max.z : box.min.z));
    const inv = this.camera.quaternion.clone().invert();
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    corners.forEach(c => { const p = c.clone().applyQuaternion(inv); minX = Math.min(minX, p.x); maxX = Math.max(maxX, p.x); minY = Math.min(minY, p.y); maxY = Math.max(maxY, p.y); });
    const aspect = this.width / this.height;
    const height = Math.max((maxY - minY) * 1.25, (maxX - minX) * 1.25 / aspect, 1);
    const center = box.getCenter(new THREE.Vector3());
    if (!animate) { this.target.copy(center); this.viewHeight = height; this.updateCamera(); return; }
    const fromT = this.target.clone(), fromH = this.viewHeight, start = performance.now();
    const step = now => {
      const k = Math.min(1, (now - start) / 260);
      this.target.lerpVectors(fromT, center, k);
      this.viewHeight = fromH + (height - fromH) * k;
      this.updateCamera();
      if (k < 1) requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  }

  // ---- pointer -------------------------------------------------------------------------------------------------------------

  bindPointer() {
    const c = this.canvas;
    const pointers = new Map();
    let drag = null;
    let pinch = null;

    c.addEventListener('contextmenu', e => e.preventDefault());
    c.addEventListener('pointerdown', e => {
      c.focus({ preventScroll: true });
      pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      c.setPointerCapture(e.pointerId);
      if (pointers.size === 2) {
        const [a, b] = [...pointers.values()];
        pinch = { d: Math.hypot(a.x - b.x, a.y - b.y), cx: (a.x + b.x) / 2, cy: (a.y + b.y) / 2 };
        drag = null;
        this.emit('cancel', {});
        return;
      }
      const mode = e.button === 1 || (e.button === 0 && e.shiftKey) || (e.button === 2 && e.shiftKey) ? 'pan' : e.button === 2 ? 'orbit' : 'left';
      drag = { mode, x: e.clientX, y: e.clientY, sx: e.clientX, sy: e.clientY, moved: false, button: e.button, pointerType: e.pointerType };
      if (mode === 'left') this.emit('down', this.eventInfo(e));
    });
    c.addEventListener('pointermove', e => {
      if (pointers.has(e.pointerId)) pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (pinch && pointers.size === 2) {
        const [a, b] = [...pointers.values()];
        const d = Math.hypot(a.x - b.x, a.y - b.y), cx = (a.x + b.x) / 2, cy = (a.y + b.y) / 2;
        this.pan(cx - pinch.cx, cy - pinch.cy);
        if (pinch.d > 0 && d > 0) this.zoomAt(pinch.d / d, cx, cy);
        pinch = { d, cx, cy };
        return;
      }
      if (!drag) { this.emit('hover', this.eventInfo(e)); return; }
      const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
      if (!drag.moved && Math.hypot(e.clientX - drag.sx, e.clientY - drag.sy) > 4) {
        drag.moved = true;
        // a left drag turns the model, unless a tool wants the drag (sketching)
        if (drag.mode === 'left' && !this.navigationOnly) { drag.mode = 'orbit'; this.emit('cancel', {}); }
      }
      if (drag.moved) {
        if (drag.mode === 'orbit') this.orbit(dx, dy);
        else if (drag.mode === 'pan') this.pan(dx, dy);
        else if (drag.mode === 'left') this.emit('drag', this.eventInfo(e));
      }
      drag.x = e.clientX;
      drag.y = e.clientY;
    });
    const up = e => {
      pointers.delete(e.pointerId);
      if (pinch) { if (pointers.size < 2) pinch = null; return; }
      if (!drag) return;
      const info = this.eventInfo(e);
      if (drag.mode === 'left') this.emit(drag.moved ? 'dragend' : 'click', { ...info, button: drag.button, shift: e.shiftKey, ctrl: e.ctrlKey || e.metaKey });
      else if (drag.mode === 'pan' && !drag.moved && drag.button === 0) this.emit('click', { ...info, button: 0, shift: true, ctrl: e.ctrlKey || e.metaKey });
      else if (!drag.moved && drag.button === 2) this.emit('context', info);
      drag = null;
    };
    c.addEventListener('pointerup', up);
    c.addEventListener('pointercancel', e => { pointers.delete(e.pointerId); drag = null; pinch = null; });
    c.addEventListener('pointerleave', () => { if (!drag) this.emit('leave', {}); });
    c.addEventListener('wheel', e => {
      e.preventDefault();
      const factor = Math.pow(1.0015, e.deltaY * (e.deltaMode === 1 ? 30 : 1));
      this.zoomAt(factor, e.clientX, e.clientY);
    }, { passive: false });
  }

  orbit(dx, dy) {
    const speed = 0.008;
    const qz = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), -dx * speed);
    const right = new THREE.Vector3(1, 0, 0).applyQuaternion(this.camera.quaternion);
    const qx = new THREE.Quaternion().setFromAxisAngle(right, -dy * speed);
    this.camera.quaternion.premultiply(qz).premultiply(qx).normalize();
    this.updateCamera();
  }

  pan(dx, dy) {
    const s = this.mmPerPixel;
    const right = new THREE.Vector3(1, 0, 0).applyQuaternion(this.camera.quaternion);
    const upv = new THREE.Vector3(0, 1, 0).applyQuaternion(this.camera.quaternion);
    this.target.addScaledVector(right, -dx * s).addScaledVector(upv, dy * s);
    this.updateCamera();
  }

  /** Zooms by a factor (> 1 out) and keeps the point under the pointer where it is. */
  zoomAt(factor, clientX, clientY) {
    const before = this.screenToWorldOnView(clientX, clientY);
    this.viewHeight = Math.min(1e6, Math.max(0.05, this.viewHeight * factor));
    this.updateCamera();
    const after = this.screenToWorldOnView(clientX, clientY);
    this.target.add(before.sub(after));
    this.updateCamera();
  }

  ndc(clientX, clientY) {
    const r = this.canvas.getBoundingClientRect();
    return new THREE.Vector2(((clientX - r.left) / r.width) * 2 - 1, -((clientY - r.top) / r.height) * 2 + 1);
  }

  screenToWorldOnView(clientX, clientY) {
    const n = this.ndc(clientX, clientY);
    const v = new THREE.Vector3(n.x, n.y, 0).unproject(this.camera);
    // onto the plane through the target that faces the camera
    const dir = new THREE.Vector3(0, 0, -1).applyQuaternion(this.camera.quaternion);
    return v.addScaledVector(dir, v.clone().sub(this.target).dot(dir) * -1);
  }

  eventInfo(e) {
    return { clientX: e.clientX, clientY: e.clientY, ndc: this.ndc(e.clientX, e.clientY), shift: e.shiftKey, ctrl: e.ctrlKey || e.metaKey };
  }

  /** The point where the pointer meets a plane (frame), in world coordinates, or null. */
  rayOnPlane(ndc, frame) {
    this.raycaster.setFromCamera(ndc, this.camera);
    const plane = new THREE.Plane().setFromNormalAndCoplanarPoint(new THREE.Vector3(...frame.n), new THREE.Vector3(...frame.o));
    const hit = new THREE.Vector3();
    return this.raycaster.ray.intersectPlane(plane, hit) ? [hit.x, hit.y, hit.z] : null;
  }

  /** What is under the pointer: a face of a part ({ partId, faceId, point, normal }) or null. */
  pick(ndc) {
    this.raycaster.setFromCamera(ndc, this.camera);
    const meshes = [...this.partObjects.values()].filter(o => o.mesh.visible).map(o => o.mesh);
    const hit = this.raycaster.intersectObjects(meshes, false)[0];
    if (!hit) return null;
    const part = hit.object.userData.part;
    const tri = hit.faceIndex;
    const n = hit.face.normal.clone().transformDirection(hit.object.matrixWorld);
    // the normal of the triangle itself (the shading normals are smoothed)
    const pos = hit.object.geometry.attributes.position;
    const a = new THREE.Vector3().fromBufferAttribute(pos, tri * 3), b = new THREE.Vector3().fromBufferAttribute(pos, tri * 3 + 1), c = new THREE.Vector3().fromBufferAttribute(pos, tri * 3 + 2);
    const flat = b.clone().sub(a).cross(c.clone().sub(a)).normalize();
    return { partId: part.id, faceId: part.mesh.faceIds[tri], point: [hit.point.x, hit.point.y, hit.point.z], normal: flat.lengthSq() ? [flat.x, flat.y, flat.z] : [n.x, n.y, n.z], triangle: tri };
  }

  /** Is the face of a part flat (every triangle of the face has the same normal)? Returns its normal or null. */
  faceNormal(partId, faceId) {
    const o = this.partObjects.get(partId);
    if (!o) return null;
    const pos = o.mesh.geometry.attributes.position, ids = o.part.mesh.faceIds;
    let normal = null;
    const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3();
    for (let t = 0; t < ids.length; t++) {
      if (ids[t] !== faceId) continue;
      a.fromBufferAttribute(pos, t * 3); b.fromBufferAttribute(pos, t * 3 + 1); c.fromBufferAttribute(pos, t * 3 + 2);
      const n = b.sub(a).cross(c.sub(a));
      if (n.lengthSq() < 1e-12) continue;
      n.normalize();
      if (!normal) normal = n.clone();
      else if (normal.dot(n) < 0.9999) return null;
    }
    return normal ? [normal.x, normal.y, normal.z] : null;
  }

  // ---- parts ---------------------------------------------------------------------------------------------------------------

  setParts(parts, hidden = new Set()) {
    for (const o of this.partObjects.values()) {
      o.mesh.geometry.dispose(); o.mesh.material.dispose(); o.edges.geometry.dispose(); o.edges.material.dispose();
    }
    this.partsGroup.clear();
    this.partObjects.clear();
    this.clearHover();
    let size = 50;
    for (const part of parts) {
      const geometry = new THREE.BufferGeometry();
      geometry.setAttribute('position', new THREE.BufferAttribute(part.mesh.positions, 3));
      geometry.setAttribute('normal', new THREE.BufferAttribute(smoothNormals(part.mesh.positions), 3));
      geometry.computeBoundingSphere();
      geometry.computeBoundingBox();
      const material = new THREE.MeshStandardMaterial({ color: new THREE.Color(part.color), roughness: 0.55, metalness: 0.08, polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 1, side: THREE.DoubleSide });
      const mesh = new THREE.Mesh(geometry, material);
      mesh.userData.part = part;
      const edgeGeometry = new THREE.EdgesGeometry(geometry, 25);
      const edgePoints = [];
      const ep = edgeGeometry.attributes.position.array;
      for (let i = 0; i < ep.length; i += 3) edgePoints.push([ep[i], ep[i + 1], ep[i + 2]]);
      edgeGeometry.dispose();
      const edges = fatLines(edgePoints, palette.edge, palette.edgeWidth, { opacity: palette.edgeOpacity });
      edges.userData.part = part;
      this.partsGroup.add(mesh, edges);
      this.partObjects.set(part.id, { mesh, edges, part });
      const box = geometry.boundingBox;
      size = Math.max(size, ...box.min.toArray().map(Math.abs), ...box.max.toArray().map(Math.abs));
      mesh.visible = edges.visible = !hidden.has(part.id);
    }
    this.sceneSize = size;
    this.applyDisplay();
    this.applySelection();
    this.updatePlanes();
    this.invalidate();
  }

  setHidden(hidden) {
    for (const [id, o] of this.partObjects) o.mesh.visible = o.edges.visible = !hidden.has(id);
    this.applyDisplay();
    this.invalidate();
  }

  setDisplay(mode) {
    this.display = mode;
    this.applyDisplay();
  }

  /** The colour scheme of the view (auto, contrast, dark, blueprint): the background, the colours and widths of the lines. The caller draws the sketches again. */
  setTheme(name) {
    themeName = VIEW_THEMES.includes(name) ? name : 'auto';
    refreshPalette();
    this.canvas.parentElement.style.background = palette.background || '';
    this.canvas.parentElement.dataset.viewTheme = themeName;
    this.applyDisplay();
    this.updatePlanes();
  }

  get themeName() { return themeName; }

  applyDisplay() {
    refreshPalette();
    for (const o of this.partObjects.values()) {
      const visible = o.mesh.visible || o.edges.visible;
      o.mesh.material.wireframe = false;
      o.mesh.material.transparent = this.display === 'wireframe';
      o.mesh.material.opacity = this.display === 'wireframe' ? 0.08 : 1;
      o.mesh.material.depthWrite = this.display !== 'wireframe';
      o.edges.material.color.set(palette.edge);
      o.edges.material.linewidth = palette.edgeWidth;
      o.edges.material.opacity = palette.edgeOpacity;
      o.edges.material.transparent = palette.edgeOpacity < 1;
      o.edges.visible = visible && this.display !== 'shaded-plain';
      o.mesh.visible = visible;
    }
    this.invalidate();
  }

  setSelection(ids) {
    this.selected = new Set(ids);
    this.applySelection();
  }

  applySelection() {
    for (const [id, o] of this.partObjects) {
      const on = this.selected.has(id);
      o.mesh.material.emissive.set(on ? palette.select : 0x000000);
      o.mesh.material.emissiveIntensity = on ? 0.35 : 0;
    }
    this.invalidate();
  }

  /** Lights up the face under the pointer. */
  hover(pick) {
    const key = pick ? pick.partId + '/' + pick.faceId : null;
    if (key === this.hoverKey) return;
    this.clearHover();
    this.hoverKey = key;
    if (!pick) return;
    const o = this.partObjects.get(pick.partId);
    if (!o) return;
    const src = o.mesh.geometry.attributes.position.array, ids = o.part.mesh.faceIds;
    const out = [];
    for (let t = 0; t < ids.length; t++) if (ids[t] === pick.faceId) for (let k = 0; k < 9; k++) out.push(src[t * 9 + k]);
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(out, 3));
    this.hoverFace = new THREE.Mesh(g, new THREE.MeshBasicMaterial({ color: palette.hover, transparent: true, opacity: 0.45, depthTest: true, polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -1, side: THREE.DoubleSide }));
    this.overlayGroup.add(this.hoverFace);
    this.invalidate();
  }

  clearHover() {
    if (this.hoverFace) { this.overlayGroup.remove(this.hoverFace); this.hoverFace.geometry.dispose(); this.hoverFace.material.dispose(); this.hoverFace = null; }
    this.hoverKey = null;
    this.invalidate();
  }

  // ---- planes --------------------------------------------------------------------------------------------------------------

  setPlanes(datum, visible) {
    this.datumPlanes = datum || [];
    this.showPlanes = visible;
    this.updatePlanes();
  }

  updatePlanes() {
    this.planesGroup.children.forEach(disposeObject);
    this.planesGroup.clear();
    if (!this.showPlanes) { this.invalidate(); return; }
    const size = Math.max(40, this.sceneSize * 1.2);
    const all = [
      ...Object.entries(STANDARD_PLANES).map(([name, frame]) => ({ key: name, frame })),
      ...(this.datumPlanes || []).map(p => ({ key: p.fid, frame: p.frame })),
    ];
    for (const p of all) this.planesGroup.add(planeObject(p.key, p.frame, size, this.highlightPlane === p.key));
    // the origin: three short axes
    const axes = new THREE.AxesHelper(Math.max(8, size * 0.12));
    axes.material.depthTest = false;
    axes.renderOrder = 2;
    this.planesGroup.add(axes);
    this.invalidate();
  }

  /** The plane under the pointer (standard planes and datum planes), as { key, frame }, or null. */
  pickPlane(ndc) {
    if (!this.showPlanes) return null;
    this.raycaster.setFromCamera(ndc, this.camera);
    const meshes = this.planesGroup.children.filter(o => o.isMesh);
    const hit = this.raycaster.intersectObjects(meshes, false)[0];
    return hit ? hit.object.userData : null;
  }

  setPlaneHighlight(key) {
    if (this.highlightPlane === key) return;
    this.highlightPlane = key;
    this.updatePlanes();
  }

  // ---- sketches ------------------------------------------------------------------------------------------------------------

  /** The sketches that are shown in the model (not the one being edited). */
  setSketches(sketches) {
    this.sketchGroup.children.forEach(disposeObject);
    this.sketchGroup.clear();
    for (const s of sketches) this.sketchGroup.add(sketchObject(s.frame, s.entities, { color: palette.sketch }));
    this.invalidate();
  }

  /** The sketch being edited: its entities, what is selected and hovered, the preview of the tool and the filled profiles. */
  setSketchOverlay(state) {
    if (this.sketchOverlay) { disposeObject(this.sketchOverlay); this.overlayGroup.remove(this.sketchOverlay); this.sketchOverlay = null; }
    if (!state) { this.invalidate(); return; }
    const group = new THREE.Group();
    const f = state.frame;
    // the grid of the sketch
    group.add(gridObject(f, state.grid, state.gridExtent));
    for (const loop of state.loops || []) group.add(fillObject(f, loop.points, state.selectedProfiles?.includes(loop.key)));
    group.add(sketchObject(f, state.entities, { color: palette.sketch, selected: state.selected, hover: state.hover, hoverPoint: state.hoverPoint, points: true, status: state.status, pointStatus: state.pointStatus }));
    if (state.origin) group.add(markerObject(toWorld(f, 0, 0), state.selected?.has?.('p:origin.p') ? palette.select : palette.defined));
    if (state.preview?.length) group.add(sketchObject(f, state.preview, { color: palette.select, points: true }));
    // dimensions: extension and dimension lines with arrows, leaders, angle arcs (thin, in the colour of their state)
    for (const a of state.annotations || []) {
      if (!a.segs.length) continue;
      const colour = a.state === 'conflict' ? palette.conflict : a.state === 'selected' ? palette.select : a.state === 'preview' ? palette.hover : palette.dim;
      group.add(fatLines(a.segs.flatMap(([p, q]) => [toWorld(f, p[0], p[1]), toWorld(f, q[0], q[1])]), colour, 1.3, { depthTest: false, renderOrder: 8 }));
    }
    // the guides of snapping: dashed lines to the point a new point lines up with
    if (state.guides?.length) {
      const list = state.guides.flatMap(([p, q]) => [new THREE.Vector3(...toWorld(f, p[0], p[1])), new THREE.Vector3(...toWorld(f, q[0], q[1]))]);
      const lines = new THREE.LineSegments(new THREE.BufferGeometry().setFromPoints(list), new THREE.LineDashedMaterial({ color: palette.hover, dashSize: this.mmPerPixel * 5, gapSize: this.mmPerPixel * 4, depthTest: false }));
      lines.computeLineDistances();
      lines.renderOrder = 9;
      group.add(lines);
    }
    if (state.snap) {
      const marker = markerObject(toWorld(f, state.snap[0], state.snap[1]), palette.select);
      marker.material.size = 12;
      group.add(marker);
    }
    group.renderOrder = 5;
    this.sketchOverlay = group;
    this.overlayGroup.add(group);
    this.invalidate();
  }

  /** The points of a measurement (or nothing). */
  setMarkers(points) {
    if (this.markers) { disposeObject(this.markers); this.overlayGroup.remove(this.markers); this.markers = null; }
    if (points?.length) {
      const group = new THREE.Group();
      points.forEach(p => group.add(markerObject(p, 0xef4444)));
      if (points.length === 2) {
        const g = new THREE.BufferGeometry().setFromPoints(points.map(p => new THREE.Vector3(...p)));
        const line = new THREE.Line(g, new THREE.LineDashedMaterial({ color: 0xef4444, dashSize: this.mmPerPixel * 6, gapSize: this.mmPerPixel * 4, depthTest: false }));
        line.computeLineDistances();
        line.renderOrder = 9;
        group.add(line);
      }
      this.markers = group;
      this.overlayGroup.add(group);
    }
    this.invalidate();
  }

  // ---- drawing -------------------------------------------------------------------------------------------------------------

  /** Where a point of the world is on the screen, in pixels from the top left of the view. */
  project(p) {
    const v = new THREE.Vector3(...p).project(this.camera);
    return { x: (v.x + 1) / 2 * this.width, y: (1 - v.y) / 2 * this.height };
  }

  render() {
    this.renderer.render(this.scene, this.camera);
    this.drawTriad();
    this.onRender?.();
    this.emit('render');
  }

  /** The arrow keys (like OnShape): turns the model about the vertical of the world (yaw) or the horizontal of the screen (pitch), in degrees, animated. */
  turn(yaw, pitch) {
    const right = new THREE.Vector3(1, 0, 0).applyQuaternion(this.camera.quaternion);
    const target = new THREE.Quaternion().setFromAxisAngle(right, -pitch * Math.PI / 180)
      .multiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), -yaw * Math.PI / 180))
      .multiply(this.camera.quaternion);
    const from = this.camera.quaternion.clone(), start = performance.now();
    const step = now => {
      const k = Math.min(1, (now - start) / 160);
      this.camera.quaternion.slerpQuaternions(from, target, k);
      this.updateCamera();
      if (k < 1) requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  }

  /** Turns the view about the direction one looks in (degrees; positive = counter-clockwise on the screen). */
  roll(degrees) {
    const forward = new THREE.Vector3(0, 0, -1).applyQuaternion(this.camera.quaternion);
    const target = new THREE.Quaternion().setFromAxisAngle(forward, -degrees * Math.PI / 180).multiply(this.camera.quaternion);
    const from = this.camera.quaternion.clone(), start = performance.now();
    const step = now => {
      const k = Math.min(1, (now - start) / 220);
      this.camera.quaternion.slerpQuaternions(from, target, k);
      this.updateCamera();
      if (k < 1) requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  }

  drawTriad() {
    const c = this.triad;
    if (!c) return;
    const ctx = c.getContext('2d');
    const s = c.width;
    ctx.clearRect(0, 0, s, s);
    const inv = this.camera.quaternion.clone().invert();
    const axes = [['X', [1, 0, 0], '#e5484d'], ['Y', [0, 1, 0], '#30a46c'], ['Z', [0, 0, 1], '#3b82f6']]
      .map(([name, v, color]) => ({ name, color, p: new THREE.Vector3(...v).applyQuaternion(inv) }))
      .sort((a, b) => a.p.z - b.p.z);
    const r = s * 0.32, cx = s / 2, cy = s / 2;
    ctx.lineWidth = 2.5;
    ctx.font = `600 ${Math.round(s * 0.13)}px system-ui, sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    for (const a of axes) {
      ctx.strokeStyle = a.color;
      ctx.fillStyle = a.color;
      ctx.beginPath();
      ctx.moveTo(cx, cy);
      ctx.lineTo(cx + a.p.x * r, cy - a.p.y * r);
      ctx.stroke();
      ctx.fillText(a.name, cx + a.p.x * (r + s * 0.1), cy - a.p.y * (r + s * 0.1));
    }
  }

  /** A PNG of the current view (for the list of documents), scaled to w × h. */
  async snapshot(w = 320, h = 240) {
    const planes = this.planesGroup.visible, sketches = this.sketchGroup.visible, overlay = this.overlayGroup.visible;
    const view = this.saveView(), selection = this.selected;
    this.planesGroup.visible = false; this.sketchGroup.visible = false; this.overlayGroup.visible = false;
    // the picture shows the whole model, without what is selected
    this.selected = new Set();
    this.applySelection();
    this.fit(false);
    this.renderer.render(this.scene, this.camera);
    const out = document.createElement('canvas');
    out.width = w; out.height = h;
    const ctx = out.getContext('2d');
    const src = this.canvas;
    const scale = Math.max(w / src.width, h / src.height);
    const sw = w / scale, sh = h / scale;
    ctx.fillStyle = isDark() ? '#1b1d21' : '#eef1f4';
    ctx.fillRect(0, 0, w, h);
    ctx.drawImage(src, (src.width - sw) / 2, (src.height - sh) / 2, sw, sh, 0, 0, w, h);
    this.planesGroup.visible = planes; this.sketchGroup.visible = sketches; this.overlayGroup.visible = overlay;
    this.camera.quaternion.copy(view.q);
    this.target.copy(view.target);
    this.viewHeight = view.height;
    this.selected = selection;
    this.applySelection();
    this.updateCamera();
    return new Promise(resolve => out.toBlob(resolve, 'image/png'));
  }

  /** A PNG of the view at the size of the screen (export). */
  async image() {
    this.renderer.render(this.scene, this.camera);
    return new Promise(resolve => this.canvas.toBlob(resolve, 'image/png'));
  }
}

// ---- helpers ---------------------------------------------------------------------------------------------------------------

export function isDark() {
  const theme = document.documentElement.getAttribute('data-theme');
  return theme === 'dark' || (theme !== 'light' && window.matchMedia('(prefers-color-scheme: dark)').matches);
}

/** Normals that are smooth over a curved surface and sharp at an edge: the normal of a corner is the mean of the triangles at the same point that bend less than 35°. */
function smoothNormals(positions) {
  const count = positions.length / 9;
  const faceNormals = new Float32Array(count * 3);
  const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3();
  for (let t = 0; t < count; t++) {
    a.fromArray(positions, t * 9); b.fromArray(positions, t * 9 + 3); c.fromArray(positions, t * 9 + 6);
    const n = b.sub(a).cross(c.sub(a));
    const area = n.length();
    if (area > 0) n.divideScalar(area);
    faceNormals.set([n.x, n.y, n.z], t * 3);
  }
  const at = new Map();
  const keyOf = i => `${Math.round(positions[i] * 1e4)},${Math.round(positions[i + 1] * 1e4)},${Math.round(positions[i + 2] * 1e4)}`;
  for (let t = 0; t < count; t++) for (let k = 0; k < 3; k++) {
    const key = keyOf(t * 9 + k * 3);
    let list = at.get(key);
    if (!list) at.set(key, list = []);
    list.push(t);
  }
  const out = new Float32Array(positions.length);
  const limit = Math.cos(35 * Math.PI / 180);
  for (let t = 0; t < count; t++) {
    const nx = faceNormals[t * 3], ny = faceNormals[t * 3 + 1], nz = faceNormals[t * 3 + 2];
    for (let k = 0; k < 3; k++) {
      let sx = 0, sy = 0, sz = 0;
      for (const o of at.get(keyOf(t * 9 + k * 3))) {
        const ox = faceNormals[o * 3], oy = faceNormals[o * 3 + 1], oz = faceNormals[o * 3 + 2];
        if (nx * ox + ny * oy + nz * oz >= limit) { sx += ox; sy += oy; sz += oz; }
      }
      const l = Math.hypot(sx, sy, sz) || 1;
      out.set([sx / l, sy / l, sz / l], t * 9 + k * 3);
    }
  }
  return out;
}

/** A plane: a see-through square with its border; the square knows which plane it is (userData { key, frame }) for picking. */
function planeObject(key, frame, size, highlight) {
  const h = size / 2;
  const corners = [[-h, -h], [h, -h], [h, h], [-h, h]].map(([u, v]) => new THREE.Vector3(...toWorld(frame, u, v)));
  const g = new THREE.BufferGeometry().setFromPoints([corners[0], corners[1], corners[2], corners[0], corners[2], corners[3]]);
  const fill = new THREE.Mesh(g, new THREE.MeshBasicMaterial({ color: palette.plane, transparent: true, opacity: highlight ? 0.28 : 0.07, side: THREE.DoubleSide, depthWrite: false }));
  fill.userData = { key, frame };
  fill.renderOrder = 1;
  const border = new THREE.LineLoop(new THREE.BufferGeometry().setFromPoints(corners), new THREE.LineBasicMaterial({ color: palette.plane, transparent: true, opacity: highlight ? 1 : 0.55 }));
  fill.add(border);
  return fill;
}

function gridObject(frame, step, extent) {
  const pts = [];
  const n = Math.min(200, Math.ceil(extent / step));
  const lim = n * step;
  for (let i = -n; i <= n; i++) {
    const s = i * step;
    pts.push(new THREE.Vector3(...toWorld(frame, s, -lim)), new THREE.Vector3(...toWorld(frame, s, lim)));
    pts.push(new THREE.Vector3(...toWorld(frame, -lim, s)), new THREE.Vector3(...toWorld(frame, lim, s)));
  }
  const grid = new THREE.LineSegments(new THREE.BufferGeometry().setFromPoints(pts), new THREE.LineBasicMaterial({ color: palette.grid, transparent: true, opacity: palette.gridOpacity, depthWrite: false }));
  const axes = new THREE.LineSegments(new THREE.BufferGeometry().setFromPoints([
    new THREE.Vector3(...toWorld(frame, -lim, 0)), new THREE.Vector3(...toWorld(frame, lim, 0)),
    new THREE.Vector3(...toWorld(frame, 0, -lim)), new THREE.Vector3(...toWorld(frame, 0, lim)),
  ]), new THREE.LineBasicMaterial({ color: palette.axis, transparent: true, opacity: 0.55, depthWrite: false }));
  const group = new THREE.Group();
  group.add(grid, axes);
  return group;
}

function fillObject(frame, points, selected) {
  const shape = new THREE.Shape(points.map(p => new THREE.Vector2(p[0], p[1])));
  const g = new THREE.ShapeGeometry(shape);
  g.applyMatrix4(new THREE.Matrix4().fromArray([frame.x[0], frame.x[1], frame.x[2], 0, frame.y[0], frame.y[1], frame.y[2], 0, frame.n[0], frame.n[1], frame.n[2], 0, frame.o[0], frame.o[1], frame.o[2], 1]));
  return new THREE.Mesh(g, new THREE.MeshBasicMaterial({ color: selected ? palette.select : palette.sketch, transparent: true, opacity: selected ? 0.3 : 0.1, side: THREE.DoubleSide, depthWrite: false }));
}

/**
 * The lines and points of a sketch. style: { color } for everything (other sketches, previews), or the states of the sketch being edited:
 * status (Map id -> defined | free | conflict: black, blue, red like OnShape), pointStatus (Map 'id.k' -> state), selected (Set of 'e:id' and 'p:id.k'), hover (id), points (draw the ends).
 */
function sketchObject(frame, entities, style) {
  const group = new THREE.Group();
  const buckets = new Map();               // colour -> { width, segments }
  const dashed = [];
  const points = new Map();                // colour -> list of points
  const colourOf = state => (state === 'conflict' ? palette.conflict : state === 'defined' ? palette.defined : palette.sketch);
  const push = (colour, width, a, b) => { const k = colour + '/' + width; if (!buckets.has(k)) buckets.set(k, { colour, width, list: [] }); buckets.get(k).list.push(a, b); };
  const dot = (colour, p) => { if (!points.has(colour)) points.set(colour, []); points.get(colour).push(p); };
  for (const e of entities || []) {
    const selected = style.selected?.has?.('e:' + e.id), hovered = style.hover === e.id;
    const state = style.status?.get(e.id);
    const colour = selected ? palette.select : hovered ? palette.hover : style.status ? colourOf(state) : style.color;
    if (e.t === 'point') { dot(colour, toWorld(frame, e.p[0], e.p[1])); continue; }
    const poly = entityPolyline(e).map(p => toWorld(frame, p[0], p[1]));
    const width = palette.sketchWidth + (selected || hovered ? 1 : 0);
    for (let i = 1; i < poly.length; i++) {
      if (e.cons && !selected && !hovered) dashed.push({ a: poly[i - 1], b: poly[i], colour: state === 'conflict' ? palette.conflict : palette.cons });
      else push(colour, width, poly[i - 1], poly[i]);
    }
    if (!style.points) continue;
    const ends = e.t === 'line' || e.t === 'rect' ? [['a', e.a], ['b', e.b]] : e.t === 'arc' ? [['s', [e.c[0] + e.r * Math.cos(e.a0), e.c[1] + e.r * Math.sin(e.a0)]], ['e', [e.c[0] + e.r * Math.cos(e.a1), e.c[1] + e.r * Math.sin(e.a1)]], ['c', e.c]] : e.c ? [['c', e.c]] : [];
    for (const [k, p] of ends) {
      const key = e.id + '.' + k;
      const c = style.selected?.has?.('p:' + key) ? palette.select : style.hoverPoint === key ? palette.hover : style.pointStatus ? colourOf(style.pointStatus.get(key)) : colour;
      dot(c, toWorld(frame, p[0], p[1]));
    }
  }
  for (const { colour, width, list } of buckets.values()) group.add(fatLines(list, colour, width, { depthTest: false, renderOrder: 6 }));
  const byColour = new Map();
  for (const d of dashed) { if (!byColour.has(d.colour)) byColour.set(d.colour, []); byColour.get(d.colour).push(d.a, d.b); }
  for (const [colour, list] of byColour) {
    const lines = new THREE.LineSegments(new THREE.BufferGeometry().setFromPoints(list.map(p => new THREE.Vector3(...p))), new THREE.LineDashedMaterial({ color: colour, dashSize: 2, gapSize: 1.5, depthTest: false }));
    lines.computeLineDistances();
    lines.renderOrder = 6;
    group.add(lines);
  }
  for (const [colour, list] of points) {
    const pts = new THREE.Points(new THREE.BufferGeometry().setFromPoints(list.map(p => new THREE.Vector3(...p))), new THREE.PointsMaterial({ color: colour, size: colour === palette.select || colour === palette.hover ? 10 : 6, sizeAttenuation: false, depthTest: false }));
    pts.renderOrder = 7;
    group.add(pts);
  }
  return group;
}

function markerObject(p, color) {
  const g = new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(...p)]);
  const pts = new THREE.Points(g, new THREE.PointsMaterial({ color, size: 9, sizeAttenuation: false, depthTest: false }));
  pts.renderOrder = 10;
  return pts;
}

function disposeObject(obj) {
  obj.traverse?.(o => { o.geometry?.dispose?.(); if (o.material) (Array.isArray(o.material) ? o.material : [o.material]).forEach(m => m.dispose()); });
}
