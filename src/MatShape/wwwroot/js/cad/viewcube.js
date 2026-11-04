/* MatShape – the view cube in the corner of the 3D view (like the cube of the CAD tools on the web).
   It always shows how the model is turned: its faces are named (Top, Front, Right, ...) and turn with the camera.
   A click on a face looks straight at it, a click on an edge or a corner turns the view to look across it; a drag on the cube turns the model.
   It has a three.js renderer of its own on a small canvas and draws whenever the main view draws. */

import * as THREE from '/lib/three/three.module.js';
import { isDark } from './viewport.js';
import { t } from './util.js';

const EDGE = 0.17;   // how far from the border a click counts as an edge or a corner (the cube is 1 wide)

export class ViewCube {
  constructor(canvas, viewport) {
    this.canvas = canvas;
    this.vp = viewport;
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    this.renderer.setClearColor(0x000000, 0);
    this.scene = new THREE.Scene();
    this.camera = new THREE.OrthographicCamera(-0.9, 0.9, 0.9, -0.9, 0.1, 10);
    this.raycaster = new THREE.Raycaster();

    // the cube is built Y-up (so the names on the sides stand upright) and turned so that its local +Y is the world's +Z
    this.group = new THREE.Group();
    this.group.rotation.x = Math.PI / 2;
    this.scene.add(this.group);
    // light from the viewer, a little from the upper left: the three visible faces get three shades
    this.scene.add(new THREE.AmbientLight(0xffffff, 1.7));
    this.light = new THREE.DirectionalLight(0xffffff, 1.3);
    this.scene.add(this.light);
    this.build();

    this.highlight = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshBasicMaterial({ color: 0x3cb764, transparent: true, opacity: 0.55, depthWrite: false }));
    this.highlight.visible = false;
    this.scene.add(this.highlight);

    this.bind();
    new ResizeObserver(() => this.resize()).observe(canvas);
    this.resize();
    viewport.onRender = () => this.render();
  }

  /** The faces with their names, in the colours of the theme. */
  build() {
    this.group.clear();
    const dark = isDark();
    // three.js order of the materials: +x, -x, +y, -y, +z, -z (local) = right, left, top, bottom, front, back (world)
    const names = ['right', 'left', 'top', 'bottom', 'front', 'back'];
    this.materials?.forEach(m => { m.map?.dispose(); m.dispose(); });
    this.materials = names.map(name => new THREE.MeshLambertMaterial({ map: this.label(t('View.Cube.' + name), dark) }));
    const cube = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), this.materials);
    const edges = new THREE.LineSegments(new THREE.EdgesGeometry(cube.geometry), new THREE.LineBasicMaterial({ color: dark ? 0x9ca3af : 0x4b5563 }));
    this.group.add(cube, edges);
    this.cube = cube;
    this.render();
  }

  label(text, dark) {
    const size = 256;
    const c = document.createElement('canvas');
    c.width = c.height = size;
    const ctx = c.getContext('2d');
    ctx.fillStyle = dark ? '#2a2d33' : '#f4f6f8';
    ctx.fillRect(0, 0, size, size);
    ctx.strokeStyle = dark ? '#4b5563' : '#cbd2da';
    ctx.lineWidth = 10;
    ctx.strokeRect(5, 5, size - 10, size - 10);
    ctx.fillStyle = dark ? '#e5e7eb' : '#1f2937';
    let font = 64;
    ctx.font = `600 ${font}px system-ui, "Segoe UI", sans-serif`;
    while (ctx.measureText(text).width > size * 0.84 && font > 28) { font -= 4; ctx.font = `600 ${font}px system-ui, "Segoe UI", sans-serif`; }
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(text, size / 2, size / 2 + 4);
    const texture = new THREE.CanvasTexture(c);
    texture.colorSpace = THREE.SRGBColorSpace;
    texture.anisotropy = 4;
    return texture;
  }

  resize() {
    const r = this.canvas.getBoundingClientRect();
    if (r.width && r.height) this.renderer.setSize(r.width, r.height, false);
    this.render();
  }

  render() {
    // the same turn as the main camera, looking at the cube from outside
    this.camera.quaternion.copy(this.vp.camera.quaternion);
    this.camera.position.set(0, 0, 4).applyQuaternion(this.camera.quaternion);
    this.camera.updateMatrixWorld();
    this.light.position.set(-1.2, 2, 3).applyQuaternion(this.camera.quaternion);
    this.renderer.render(this.scene, this.camera);
  }

  /** The face, edge or corner under the pointer as a direction with components -1, 0 or 1 (in world axes), or null. */
  regionAt(e) {
    const r = this.canvas.getBoundingClientRect();
    const ndc = new THREE.Vector2(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
    this.raycaster.setFromCamera(ndc, this.camera);
    const hit = this.raycaster.intersectObject(this.cube, false)[0];
    if (!hit) return null;
    const p = hit.point; // world coordinates (the cube is centred on the origin, 1 wide)
    const s = v => (Math.abs(v) > 0.5 - EDGE ? Math.sign(v) : 0);
    return [s(p.x), s(p.y), s(p.z)];
  }

  showRegion(d) {
    const key = d ? d.join(',') : null;
    if (key === this.hoverKey) return;
    this.hoverKey = key;
    this.highlight.visible = !!d;
    if (d) {
      const size = d.map(v => (v ? EDGE + 0.012 : 1 - 2 * EDGE));
      const pos = d.map(v => v * (0.5 - EDGE / 2 + 0.006));
      this.highlight.scale.set(...size);
      this.highlight.position.set(...pos);
    }
    this.canvas.style.cursor = d ? 'pointer' : '';
    this.render();
  }

  bind() {
    const c = this.canvas;
    let drag = null;
    c.addEventListener('contextmenu', e => e.preventDefault());
    c.addEventListener('pointerdown', e => {
      c.setPointerCapture(e.pointerId);
      drag = { x: e.clientX, y: e.clientY, sx: e.clientX, sy: e.clientY, moved: false };
    });
    c.addEventListener('pointermove', e => {
      if (!drag) { this.showRegion(this.regionAt(e)); return; }
      if (!drag.moved && Math.hypot(e.clientX - drag.sx, e.clientY - drag.sy) > 3) { drag.moved = true; this.showRegion(null); }
      if (drag.moved) this.vp.orbit((e.clientX - drag.x) * 1.4, (e.clientY - drag.y) * 1.4);
      drag.x = e.clientX;
      drag.y = e.clientY;
    });
    c.addEventListener('pointerup', e => {
      const was = drag;
      drag = null;
      if (!was || was.moved) return;
      const d = this.regionAt(e);
      if (d) this.lookFrom(d);
    });
    c.addEventListener('pointercancel', () => { drag = null; });
    c.addEventListener('pointerleave', () => { if (!drag) this.showRegion(null); });
  }

  /** Looks at the model from a direction of the cube; straight down or up keeps north up, everything else keeps Z up. */
  lookFrom(d) {
    const up = d[0] === 0 && d[1] === 0 ? [0, d[2] > 0 ? 1 : -1, 0] : [0, 0, 1];
    this.vp.setView(null, true, d, up);
  }
}
