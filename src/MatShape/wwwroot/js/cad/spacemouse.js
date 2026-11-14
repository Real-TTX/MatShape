/* MatShape – a 3D mouse (the SpaceMouse family of 3Dconnexion: SpaceMouse Compact, Wireless, Pro, Enterprise, SpaceNavigator …) in the 3D view.
   The browser talks to the device itself through WebHID (Chrome, Edge, Opera on Windows, macOS, Linux; not Firefox or Safari): no driver and no plug-in is
   needed. The person allows the device once (the browser asks); after that it is opened by itself whenever the editor starts.
   The cap has six axes: pushed left/right, up/down and to and fro it moves the view (to and fro zooms), tilted and twisted it turns the view about the
   middle of the screen. "Move the model" (the default of 3Dconnexion) moves the model like the cap; "move the camera" the other way round.
   The device sends reports while the cap is moved (report 1: the three shifts – or all six axes on newer devices –, report 2: the three turns, report 3:
   the buttons); the view is moved once per frame by the last values and the time since the frame before, so the speed does not depend on the frame rate. */

/** 3Dconnexion, and Logitech (the older SpaceNavigator, SpaceExplorer, SpacePilot were sold under its vendor id). */
const VENDOR_3DCONNEXION = 0x256f;
const VENDOR_LOGITECH = 0x046d;
const LOGITECH_PRODUCTS = [0xc603, 0xc605, 0xc606, 0xc621, 0xc623, 0xc625, 0xc626, 0xc627, 0xc628, 0xc629, 0xc62b, 0xc640];

/** The filters of the browser's device choice: only 3D mice are offered. */
export const FILTERS = [
  { vendorId: VENDOR_3DCONNEXION },
  ...LOGITECH_PRODUCTS.map(productId => ({ vendorId: VENDOR_LOGITECH, productId })),
];

/** The value of an axis at full deflection (the devices report about ±350). */
export const FULL = 350;

/** Below this share of a full deflection an axis counts as at rest (the cap never sits exactly at 0). */
export const DEAD = 0.04;

/** Speeds per second at full deflection: turning (radians), moving (view heights), zooming (factor e^x). */
export const SPEEDS = { slow: 0.5, normal: 1, fast: 2 };
const TURN = 2.2, MOVE = 1.1, ZOOM = 1.6;

export function isSupported() {
  return typeof navigator !== 'undefined' && 'hid' in navigator && (typeof isSecureContext === 'undefined' || isSecureContext);
}

/** Whether a device is a 3D mouse (by the filters). */
export function isSpaceMouse(device) {
  return FILTERS.some(f => f.vendorId === device.vendorId && (f.productId === undefined || f.productId === device.productId));
}

/**
 * Reads one input report into the state { t: [x, y, z], r: [x, y, z], buttons } (raw device values). Report 1 holds the shifts – on newer devices (12 bytes)
 * the turns as well –, report 2 the turns, report 3 the buttons as bits. Returns the kind of change: 'motion', 'buttons' or null.
 */
export function readReport(state, reportId, data) {
  const at = i => data.getInt16(i, true);
  if (reportId === 1 && data.byteLength >= 6) {
    state.t = [at(0), at(2), at(4)];
    if (data.byteLength >= 12) state.r = [at(6), at(8), at(10)];
    return 'motion';
  }
  if (reportId === 2 && data.byteLength >= 6) { state.r = [at(0), at(2), at(4)]; return 'motion'; }
  if (reportId === 3 && data.byteLength >= 1) {
    let bits = 0;
    for (let i = 0; i < Math.min(4, data.byteLength); i++) bits |= data.getUint8(i) << (8 * i);
    state.buttons = bits >>> 0;
    return 'buttons';
  }
  return null;
}

/** An axis value as a share of a full deflection, 0 inside the dead zone, beyond it rising smoothly (fine moves stay fine). */
export function shaped(value) {
  const v = Math.max(-1, Math.min(1, value / FULL));
  const a = Math.abs(v);
  if (a < DEAD) return 0;
  const k = (a - DEAD) / (1 - DEAD);
  return Math.sign(v) * k * k;
}

/**
 * The motion of one frame in the frame of the screen (x right, y up, z towards the person), from the raw state: the device has x right, y towards the person
 * and z down, for shifts and turns alike. "object" moves the model like the cap: the view (the camera) moves the other way – the caller applies the camera
 * motion, so the signs are turned here. Returns { pan: [x, y], zoom, turn: [x, y, z] } as fractions per second (times the speed of the person).
 */
export function motionOf(state, mode = 'object', speed = 1) {
  const [tx, ty, tz] = state.t.map(shaped);
  const [rx, ry, rz] = state.r.map(shaped);
  const s = mode === 'camera' ? -speed : speed;
  return {
    // the model follows the cap: the camera moves against it
    pan: [-tx * MOVE * s, tz * MOVE * s],
    // pulled towards the person the model comes closer: the view gets smaller (zoom < 0 shrinks the height)
    zoom: -ty * ZOOM * s,
    // the model turns with the cap: the camera turns against it (screen axes: x = tilt to and fro, y = twist, z = roll)
    turn: [-rx * TURN * s, rz * TURN * s, -ry * TURN * s],
  };
}

export function isAtRest(state) {
  return state.t.every(v => shaped(v) === 0) && state.r.every(v => shaped(v) === 0);
}

/**
 * The 3D mouse of the editor. host: { navigate(motion, seconds) – moves the view, button(index) – a button was pressed, changed(device | null) – opened or gone }.
 */
export class SpaceMouse {
  constructor(host) {
    this.host = host;
    this.device = null;
    this.state = { t: [0, 0, 0], r: [0, 0, 0], buttons: 0 };
    this.mode = 'object';
    this.speed = 1;
    this.last = 0;
    this.running = false;
    this.onReport = e => this.report(e);
    if (isSupported()) {
      navigator.hid.addEventListener('disconnect', e => { if (e.device === this.device) this.closed(); });
      navigator.hid.addEventListener('connect', e => { if (!this.device && isSpaceMouse(e.device)) this.open(e.device).catch(() => {}); });
    }
  }

  get connected() { return !!this.device; }

  get name() { return this.device?.productName || 'SpaceMouse'; }

  /** Opens a device the person allowed before (no question). */
  async reconnect() {
    if (!isSupported() || this.device) return false;
    const devices = (await navigator.hid.getDevices()).filter(isSpaceMouse);
    for (const device of devices) {
      try { await this.open(device); return true; } catch { /* the next one */ }
    }
    return false;
  }

  /** Asks the person for the device (needs a click) and opens it. */
  async connect() {
    if (!isSupported()) throw new Error('unsupported');
    const devices = await navigator.hid.requestDevice({ filters: FILTERS });
    if (!devices.length) return false;
    // a wireless receiver shows up as several devices: the first that opens and talks is taken
    for (const device of devices) {
      try { await this.open(device); return true; } catch (e) { this.error = e; }
    }
    throw this.error || new Error('open');
  }

  async open(device) {
    if (!device.opened) await device.open();
    if (this.device && this.device !== device) await this.disconnect();
    this.device = device;
    device.addEventListener('inputreport', this.onReport);
    this.host.changed?.(device);
  }

  async disconnect() {
    const device = this.device;
    if (!device) return;
    device.removeEventListener('inputreport', this.onReport);
    this.device = null;
    this.stop();
    try { await device.close(); } catch { /* gone already */ }
    this.host.changed?.(null);
  }

  closed() {
    this.device?.removeEventListener('inputreport', this.onReport);
    this.device = null;
    this.stop();
    this.host.changed?.(null);
  }

  report(e) {
    const before = this.state.buttons;
    const kind = readReport(this.state, e.reportId, e.data);
    if (kind === 'buttons') {
      const pressed = this.state.buttons & ~before;
      for (let i = 0; i < 32; i++) if (pressed & (1 << i)) this.host.button?.(i);
    } else if (kind === 'motion' && !this.running && !isAtRest(this.state)) {
      this.start();
    }
  }

  start() {
    this.running = true;
    this.last = performance.now();
    const step = now => {
      if (!this.running) return;
      // a hidden page gets no frames; after it the time since the last frame would be long
      const seconds = Math.min(0.1, (now - this.last) / 1000);
      this.last = now;
      if (isAtRest(this.state)) { this.running = false; return; }
      this.host.navigate(motionOf(this.state, this.mode, this.speed), seconds);
      requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  }

  stop() {
    this.running = false;
    this.state = { t: [0, 0, 0], r: [0, 0, 0], buttons: 0 };
  }
}
