/* MatShape – the expressions of the fields: "25", "2.5 cm", "#width / 2 + 3 mm", "sqrt(#a^2 + #b^2)", "30 deg".
   A value carries a dimension (the power of length): 10 mm is length, 2 is a plain number, #w * 2 is a length again. A plain number in a length field means the unit
   of the document; a plain number in an angle field means degrees. Lengths are millimetres inside. Variables are written #name and come from Variable features. */

const LENGTH_UNITS = { mm: 1, cm: 10, m: 1000, in: 25.4, inch: 25.4, ft: 304.8, um: 0.001 };
const ANGLE_UNITS = { deg: 1, rad: 180 / Math.PI };
const FUNCTIONS = {
  sin: x => Math.sin(x * Math.PI / 180), cos: x => Math.cos(x * Math.PI / 180), tan: x => Math.tan(x * Math.PI / 180),
  asin: x => Math.asin(x) * 180 / Math.PI, acos: x => Math.acos(x) * 180 / Math.PI, atan: x => Math.atan(x) * 180 / Math.PI,
  sqrt: Math.sqrt, abs: Math.abs, round: Math.round, floor: Math.floor, ceil: Math.ceil, min: Math.min, max: Math.max,
};

export class ExprError extends Error {}

function tokenize(text) {
  const tokens = [];
  let i = 0;
  while (i < text.length) {
    const c = text[i];
    if (/\s/.test(c)) { i++; continue; }
    if (/[0-9.]/.test(c)) {
      const m = /^(\d+\.?\d*|\.\d+)(e[+-]?\d+)?/i.exec(text.slice(i));
      if (!m) throw new ExprError('number');
      tokens.push({ k: 'num', v: parseFloat(m[0]) });
      i += m[0].length;
      continue;
    }
    if (c === '#') {
      const m = /^#([A-Za-z_][A-Za-z0-9_]*)/.exec(text.slice(i));
      if (!m) throw new ExprError('variable');
      tokens.push({ k: 'var', v: m[1] });
      i += m[0].length;
      continue;
    }
    if (/[A-Za-z_]/.test(c)) {
      const m = /^[A-Za-z_][A-Za-z0-9_]*/.exec(text.slice(i));
      tokens.push({ k: 'id', v: m[0] });
      i += m[0].length;
      continue;
    }
    if ('+-*/^(),'.includes(c)) { tokens.push({ k: c }); i++; continue; }
    if (c === '"') { tokens.push({ k: 'id', v: 'in' }); i++; continue; }
    throw new ExprError('character');
  }
  return tokens;
}

/** Parses and evaluates; returns { v, d } (value in mm^d). */
function evaluate(text, variables) {
  const tokens = tokenize(text);
  let p = 0;
  const peek = () => tokens[p];
  const take = k => { const tok = tokens[p]; if (!tok || (k && tok.k !== k)) throw new ExprError('syntax'); p++; return tok; };

  const add = (a, b, sign) => {
    // a plain number next to a length is read as the same kind (lenient, like a calculator)
    if (a.d !== b.d && a.d !== 0 && b.d !== 0) throw new ExprError('dimension');
    return { v: a.v + sign * b.v, d: a.d || b.d, plain: a.plain && b.plain };
  };

  function expression() {
    let left = term();
    while (peek() && (peek().k === '+' || peek().k === '-')) {
      const op = take().k;
      left = add(left, term(), op === '+' ? 1 : -1);
    }
    return left;
  }
  function term() {
    let left = power();
    while (peek() && (peek().k === '*' || peek().k === '/')) {
      const op = take().k;
      const right = power();
      if (op === '*') left = { v: left.v * right.v, d: left.d + right.d };
      else {
        if (right.v === 0) throw new ExprError('division');
        left = { v: left.v / right.v, d: left.d - right.d };
      }
    }
    return left;
  }
  function power() {
    const base = unary();
    if (peek() && peek().k === '^') {
      take();
      const exp = unary();
      if (exp.d !== 0) throw new ExprError('dimension');
      return { v: Math.pow(base.v, exp.v), d: base.d * exp.v };
    }
    return base;
  }
  function unary() {
    if (peek() && peek().k === '-') { take(); const v = unary(); return { ...v, v: -v.v }; }
    if (peek() && peek().k === '+') { take(); return unary(); }
    return postfix();
  }
  function postfix() {
    const value = primary();
    // a unit right after a value: 10 mm, (3 + 4) cm, 30 deg
    const next = peek();
    if (next && next.k === 'id' && (next.v in LENGTH_UNITS || next.v in ANGLE_UNITS)) {
      take();
      if (next.v in LENGTH_UNITS) return { v: value.v * LENGTH_UNITS[next.v], d: value.d + 1 };
      return { v: value.v * ANGLE_UNITS[next.v], d: value.d, angle: true };
    }
    return value;
  }
  function primary() {
    const tok = take();
    if (tok.k === 'num') return { v: tok.v, d: 0, plain: true };
    if (tok.k === 'var') {
      const variable = variables?.[tok.v];
      if (!variable) throw new ExprError('unknown:' + tok.v);
      return { v: variable.v, d: variable.d };
    }
    if (tok.k === '(') { const v = expression(); take(')'); return v; }
    if (tok.k === 'id') {
      if (tok.v === 'pi' || tok.v === 'PI') return { v: Math.PI, d: 0 };
      const fn = FUNCTIONS[tok.v];
      if (!fn) throw new ExprError('function');
      take('(');
      const args = [expression()];
      while (peek() && peek().k === ',') { take(); args.push(expression()); }
      take(')');
      const d = ['min', 'max', 'abs', 'round', 'floor', 'ceil'].includes(tok.v) ? args[0].d : tok.v === 'sqrt' ? args[0].d / 2 : 0;
      return { v: fn(...args.map(a => a.v)), d };
    }
    throw new ExprError('syntax');
  }

  if (tokens.length === 0) throw new ExprError('empty');
  const result = expression();
  if (p !== tokens.length) throw new ExprError('syntax');
  if (!Number.isFinite(result.v)) throw new ExprError('number');
  return result;
}

/** A length in mm from an expression; a plain number is in <unitFactor> (the unit of the document). */
export function evalLength(text, variables, unitFactor = 1) {
  const r = evaluate(String(text ?? ''), variables);
  if (r.d === 0) return r.v * unitFactor;
  if (r.d !== 1) throw new ExprError('dimension');
  return r.v;
}

/** An angle in degrees. */
export function evalAngle(text, variables) {
  const r = evaluate(String(text ?? ''), variables);
  if (r.d !== 0) throw new ExprError('dimension');
  return r.v;
}

/** A plain number (counts are rounded by the caller). */
export function evalNumber(text, variables) {
  const r = evaluate(String(text ?? ''), variables);
  if (r.d !== 0) throw new ExprError('dimension');
  return r.v;
}

/** The value of a variable: a length when it has a length unit or uses length variables (stored in mm), else a plain number. */
export function evalVariable(text, variables) {
  const r = evaluate(String(text ?? ''), variables);
  return { v: r.v, d: r.d };
}

/** Is it a valid variable name (without #)? */
export const isVariableName = name => /^[A-Za-z_][A-Za-z0-9_]{0,31}$/.test(name || '');

/** The message key of an error (Js.Expr.*). */
export function errorKey(error) {
  const m = String(error?.message || '');
  if (m.startsWith('unknown:')) return ['Expr.Unknown', m.slice(8)];
  if (m === 'dimension') return ['Expr.Dimension'];
  if (m === 'division') return ['Expr.Division'];
  if (m === 'empty') return ['Expr.Empty'];
  return ['Expr.Syntax'];
}
