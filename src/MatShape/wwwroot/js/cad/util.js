/* MatShape – small helpers shared by the editor modules: texts, DOM, ids, numbers, requests.
   Everything that goes into the page is text (textContent): nothing of a model is ever put in as HTML. */

let texts = null;

/** A text of the catalog (the JSON block the layout writes, keys "Js.*"); {0}, {1} ... are replaced by the arguments. */
export function t(key, ...args) {
  if (!texts) {
    const block = document.getElementById('ms-texts');
    try { texts = block ? JSON.parse(block.textContent) : {}; } catch { texts = {}; }
  }
  const text = texts['Js.' + key] ?? key;
  return args.length ? text.replace(/\{(\d+)\}/g, (_, i) => String(args[Number(i)] ?? '')) : text;
}

/** An element: el('button', { class: 'x', type: 'button', onclick: fn }, 'text', child). */
export function el(tag, attrs, ...children) {
  const node = document.createElement(tag);
  if (attrs) {
    for (const [name, value] of Object.entries(attrs)) {
      if (value === undefined || value === null || value === false) continue;
      if (name.startsWith('on') && typeof value === 'function') node.addEventListener(name.slice(2), value);
      else if (name === 'dataset') Object.assign(node.dataset, value);
      else if (name === 'text') node.textContent = value;
      else node.setAttribute(name, value === true ? '' : String(value));
    }
  }
  for (const child of children.flat()) {
    if (child === null || child === undefined || child === false) continue;
    node.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return node;
}

/** An icon of the sprite (the toolkit's or the app's). */
export function icon(name, cls) {
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('class', cls ? 'mat-icon ' + cls : 'mat-icon');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('focusable', 'false');
  const use = document.createElementNS(ns, 'use');
  use.setAttribute('href', '#mat-i-' + name);
  svg.append(use);
  return svg;
}

/** A short id that is unique enough inside one document. */
export function uid(prefix = '') {
  const bytes = new Uint8Array(6);
  crypto.getRandomValues(bytes);
  return prefix + Array.from(bytes, b => b.toString(36).padStart(2, '0')).join('').slice(0, 9);
}

export const clone = value => (value === undefined ? undefined : JSON.parse(JSON.stringify(value)));

export const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

/** A number for people: up to 4 places, no trailing zeros, the decimal sign of the page language. */
export function fmt(value, places = 4) {
  if (!Number.isFinite(value)) return '–';
  const rounded = Math.abs(value) < 1e-9 ? 0 : value;
  return rounded.toLocaleString(document.documentElement.lang || 'en', { maximumFractionDigits: places, useGrouping: false });
}

/** The unit factor and label of a document unit. */
export const UNITS = { mm: 1, cm: 10, m: 1000, in: 25.4 };

export function length(mm, unit) {
  return fmt(mm / (UNITS[unit] || 1), 4) + ' ' + unit;
}

/** The anti-forgery token of the page (the forms of the layout carry it). */
export function token() {
  return document.querySelector('[data-page-token] input[name="__RequestVerificationToken"]')?.value || '';
}

/** A JSON request; throws an error with .status for an answer that is not 2xx (and .body with the parsed answer when there is one). */
export async function request(method, url, body, options = {}) {
  const headers = { Accept: 'application/json' };
  if (method !== 'GET') headers.RequestVerificationToken = token();
  let payload;
  if (body instanceof Blob || body instanceof ArrayBuffer) { payload = body; headers['Content-Type'] = 'application/octet-stream'; }
  else if (body !== undefined) { payload = JSON.stringify(body); headers['Content-Type'] = 'application/json'; }
  const response = await fetch(url, { method, headers, body: payload, credentials: 'same-origin', cache: 'no-store', signal: options.signal });
  const type = response.headers.get('Content-Type') || '';
  const data = type.includes('json') ? await response.json().catch(() => null) : null;
  if (!response.ok) {
    const error = new Error('HTTP ' + response.status);
    error.status = response.status;
    error.body = data;
    throw error;
  }
  return data;
}

export function debounce(fn, ms) {
  let timer = 0;
  const run = (...args) => { clearTimeout(timer); timer = setTimeout(() => fn(...args), ms); };
  run.cancel = () => clearTimeout(timer);
  run.flush = (...args) => { clearTimeout(timer); fn(...args); };
  return run;
}

/** A toast of the toolkit. */
export function toast(message, tone = 'info') {
  if (window.MatUi?.toast) window.MatUi.toast(message, { tone });
}

/** A file download made in the browser. */
export function download(name, data, type) {
  const blob = data instanceof Blob ? data : new Blob([data], { type });
  const url = URL.createObjectURL(blob);
  const a = el('a', { href: url, download: name });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

/** A file name from a name: letters, digits, dash, underscore. */
export function fileName(name, ext) {
  const base = (name || 'model').normalize('NFKD').replace(/[^\w\- ]+/g, '').trim().replace(/\s+/g, '-') || 'model';
  return base + '.' + ext;
}

/** A small dot in a colour of the model (set through the CSSOM: the CSP allows no style attribute). */
export function swatch(color, cls = 'ms-swatch-dot') {
  const dot = el('span', { class: cls, 'aria-hidden': 'true' });
  dot.style.backgroundColor = color;
  return dot;
}
