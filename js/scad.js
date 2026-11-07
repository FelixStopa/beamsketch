// scad.js — OpenSCAD-Code für den Laser: eigener Interpreter für die Sprache und ihre 2D-Geometrie.
// Sprache: Variablen, Module, Funktionen (auch als Werte), if/for/let/each, Listen-Ausdrücke, Bereiche,
// Spezialvariablen ($fn, $fa, $fs, $t, $children), eingebaute Funktionen.
// Geometrie: square, circle, polygon, text, translate/rotate/scale/mirror/multmatrix/resize,
// offset, hull, minkowski, union/difference/intersection. 3D-Teile (cube, cylinder, sphere,
// linear_extrude, projection) werden als Draufsicht übernommen – für den Laser zählt der Umriss.
// Ergebnis: geschlossene Umrisse in mm (außen gegen, Löcher im Uhrzeigersinn). Für den Laser: Teile mit
// verschiedener Farbe (color()) bleiben getrennt – jede Farbe wird eine eigene Ebene (z. B. rot = Gravur).
import { boolOp, offsetPolys, polyArea, pointInPoly, cleanPoly } from './geom.js';
import { loc } from './i18n.js';

export class ScadError extends Error {
  constructor(msg, line) { super(msg); this.line = line; }
}

/* ======================= Lexer ======================= */
const KEYWORDS = new Set(['module', 'function', 'if', 'else', 'for', 'let', 'each', 'true', 'false', 'undef', 'include', 'use', 'assert', 'echo', 'intersection_for']);
export function tokenize(src) {
  const toks = [];
  let i = 0, line = 1;
  const n = src.length;
  const push = (type, value) => toks.push({ type, value, line });
  while (i < n) {
    const c = src[i];
    if (c === '\n') { line++; i++; continue; }
    if (/\s/.test(c)) { i++; continue; }
    if (c === '/' && src[i + 1] === '/') { while (i < n && src[i] !== '\n') i++; continue; }
    if (c === '/' && src[i + 1] === '*') {
      i += 2;
      while (i < n && !(src[i] === '*' && src[i + 1] === '/')) { if (src[i] === '\n') line++; i++; }
      i += 2; continue;
    }
    if (/[0-9]/.test(c) || (c === '.' && /[0-9]/.test(src[i + 1]))) {
      const m = /^(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?/.exec(src.slice(i));
      push('num', parseFloat(m[0])); i += m[0].length; continue;
    }
    if (/[A-Za-z_$]/.test(c)) {
      const m = /^[A-Za-z_$][A-Za-z0-9_]*/.exec(src.slice(i));
      push(KEYWORDS.has(m[0]) ? 'kw' : 'id', m[0]); i += m[0].length; continue;
    }
    if (c === '"') {
      let s = ''; i++;
      while (i < n && src[i] !== '"') {
        if (src[i] === '\\') {
          const e = src[i + 1];
          if (e === 'n') s += '\n'; else if (e === 't') s += '\t'; else if (e === 'r') s += '\r';
          else if (e === 'u' || e === 'x') {
            const len = e === 'u' ? 4 : 2, hex = src.slice(i + 2, i + 2 + len);
            s += String.fromCodePoint(parseInt(hex, 16)); i += len;
          } else s += e;
          i += 2; continue;
        }
        if (src[i] === '\n') line++;
        s += src[i++];
      }
      if (i >= n) throw new ScadError(loc('Zeichenkette nicht abgeschlossen'), line);
      i++; push('str', s); continue;
    }
    if (c === '<' && toks.length && toks[toks.length - 1].type === 'kw' && /^(include|use)$/.test(toks[toks.length - 1].value)) {
      const j = src.indexOf('>', i);
      push('path', src.slice(i + 1, j)); i = j + 1; continue;
    }
    const two = src.slice(i, i + 2);
    if (['<=', '>=', '==', '!=', '&&', '||'].includes(two)) { push('op', two); i += 2; continue; }
    if ('+-*/%^!<>?:=;,.()[]{}#'.includes(c)) { push('op', c); i++; continue; }
    throw new ScadError(loc('Unerwartetes Zeichen „{c}“', { c }), line);
  }
  push('eof', null);
  return toks;
}

/* ======================= Parser ======================= */
export function parse(src) {
  const t = tokenize(src);
  let p = 0;
  const peek = (k = 0) => t[p + k];
  const is = (v, k = 0) => { const x = t[p + k]; return (x.type === 'op' || x.type === 'kw') && x.value === v; };
  const next = () => t[p++];
  const fail = (msg, tok = peek()) => { throw new ScadError(msg, tok.line); };
  const expect = v => { if (!is(v)) fail(loc('„{v}“ erwartet, gefunden: {f}', { v, f: desc(peek()) })); return next(); };
  const desc = x => x.type === 'eof' ? loc('Dateiende') : `„${x.value}“`;
  const ident = () => { const x = peek(); if (x.type !== 'id') fail(loc('Name erwartet, gefunden: {f}', { f: desc(x) })); p++; return x.value; };

  // ---- Ausdrücke ----
  const expr = () => {
    const tok = peek();
    if (is('function') && is('(', 1)) {
      next(); expect('(');
      const params = paramList();
      return { k: 'lambda', params, body: expr(), line: tok.line };
    }
    if (is('let') || is('assert') || is('echo')) {
      const kw = next().value; expect('(');
      const args = argList();
      const body = (is(')') || is(']') || is(',') || is(';')) ? null : expr();
      return { k: kw, args, body, line: tok.line };
    }
    const c = orExpr();
    if (is('?')) { next(); const a = expr(); expect(':'); const b = expr(); return { k: 'tern', c, a, b, line: tok.line }; }
    return c;
  };
  const bin = (sub, ops) => () => {
    let l = sub();
    while (peek().type === 'op' && ops.includes(peek().value)) { const o = next(); l = { k: 'bin', op: o.value, l, r: sub(), line: o.line }; }
    return l;
  };
  const unary = () => {
    if (is('!') || is('-') || is('+')) { const o = next(); return { k: 'un', op: o.value, e: unary(), line: o.line }; }
    return power();
  };
  const power = () => {
    const b = postfix();
    if (is('^')) { const o = next(); return { k: 'bin', op: '^', l: b, r: unary(), line: o.line }; }
    return b;
  };
  const mulExpr = bin(unary, ['*', '/', '%']);
  const addExpr = bin(mulExpr, ['+', '-']);
  const relExpr = bin(addExpr, ['<', '>', '<=', '>=']);
  const eqExpr = bin(relExpr, ['==', '!=']);
  const andExpr = bin(eqExpr, ['&&']);
  const orExpr = bin(andExpr, ['||']);
  const postfix = () => {
    let e = primary();
    for (;;) {
      if (is('(')) { const l = next().line; e = { k: 'call', f: e, args: argList(), line: l }; }
      else if (is('[')) { const l = next().line; const i = expr(); expect(']'); e = { k: 'idx', e, i, line: l }; }
      else if (is('.')) { const l = next().line; e = { k: 'mem', e, name: ident(), line: l }; }
      else return e;
    }
  };
  const primary = () => {
    const x = peek();
    if (x.type === 'num') { p++; return { k: 'lit', v: x.value }; }
    if (x.type === 'str') { p++; return { k: 'lit', v: x.value }; }
    if (is('true')) { p++; return { k: 'lit', v: true }; }
    if (is('false')) { p++; return { k: 'lit', v: false }; }
    if (is('undef')) { p++; return { k: 'lit', v: undefined }; }
    if (x.type === 'id') { p++; return { k: 'var', name: x.value, line: x.line }; }
    if (is('(')) { next(); const e = expr(); expect(')'); return e; }
    if (is('[')) return vector();
    fail(loc('Ausdruck erwartet, gefunden: {f}', { f: desc(x) }));
  };
  const vector = () => {
    const l = expect('[').line;
    if (is(']')) { next(); return { k: 'vec', items: [], line: l }; }
    const first = listElem();
    if (is(':') && first.k !== 'lc') {
      next(); const b = expr();
      if (is(':')) { next(); const c = expr(); expect(']'); return { k: 'range', a: first, s: b, b: c, line: l }; }
      expect(']'); return { k: 'range', a: first, s: null, b, line: l };
    }
    const items = [first];
    while (is(',')) { next(); if (is(']')) break; items.push(listElem()); }
    expect(']');
    return { k: 'vec', items, line: l };
  };
  // Elemente in Listen dürfen Listen-Ausdrücke sein: for, if, let, each
  const listElem = () => {
    const tok = peek();
    if (is('for')) {
      next(); expect('(');
      const a = argList();
      if (is(';')) {         // C-artiges for: for (init; cond; update)
        next(); const cond = expr(); expect(';'); const upd = argList(true);
        return { k: 'lc', kind: 'cfor', init: a, cond, upd, body: listElem(), line: tok.line };
      }
      return { k: 'lc', kind: 'for', args: a, body: listElem(), line: tok.line };
    }
    if (is('if')) {
      next(); expect('('); const c = expr(); expect(')');
      const a = listElem();
      let b = null;
      if (is('else')) { next(); b = listElem(); }
      return { k: 'lc', kind: 'if', c, a, b, line: tok.line };
    }
    if (is('let') && is('(', 1)) {
      next(); expect('(');
      return { k: 'lc', kind: 'let', args: argList(), body: listElem(), line: tok.line };
    }
    if (is('each')) { next(); return { k: 'lc', kind: 'each', e: listElem(), line: tok.line }; }
    if (is('(') && (is('for', 1) || is('if', 1) || is('each', 1))) { next(); const e = listElem(); expect(')'); return e; }
    return expr();
  };
  // Argumente: (a, b=2, …) – schließt die Klammer selbst
  const argList = (noOpen = false) => {
    const args = [];
    if (!noOpen && false) expect('(');
    while (!is(')')) {
      let name = null;
      if ((peek().type === 'id') && is('=', 1)) { name = next().value; next(); }
      args.push({ name, e: expr() });
      if (!is(',')) break;
      next();
    }
    expect(')');
    return args;
  };
  const paramList = () => {
    const ps = [];
    while (!is(')')) {
      const name = ident();
      let def = null;
      if (is('=')) { next(); def = expr(); }
      ps.push({ name, def });
      if (!is(',')) break;
      next();
    }
    expect(')');
    return ps;
  };

  // ---- Anweisungen ----
  const statement = () => {
    const tok = peek();
    if (is(';')) { next(); return null; }
    if (is('{')) { next(); const body = []; while (!is('}')) { if (peek().type === 'eof') fail(loc('„}“ fehlt')); const s = statement(); if (s) body.push(s); } next(); return { k: 'block', body, line: tok.line }; }
    if (is('module')) {
      next(); const name = ident(); expect('(');
      const params = paramList();
      return { k: 'moddef', name, params, body: statement(), line: tok.line };
    }
    if (is('function')) {
      next(); const name = ident(); expect('(');
      const params = paramList(); expect('=');
      const body = expr(); expect(';');
      return { k: 'fundef', name, params, body, line: tok.line };
    }
    if (is('include') || is('use')) { next(); const x = next(); throw new ScadError(loc('include/use <{f}> wird nicht unterstützt – bitte den Inhalt der Datei einfügen', { f: x.value }), tok.line); }
    if (peek().type === 'id' && is('=', 1)) {
      const name = next().value; next(); const e = expr(); expect(';');
      return { k: 'assign', name, e, line: tok.line };
    }
    if (is('!') || is('#') || is('%') || is('*')) {
      const m = next().value; const s = statement();
      return s ? { ...s, mod: (s.mod || '') + m } : null;
    }
    if (is('if')) {
      next(); expect('('); const c = expr(); expect(')');
      const a = statement();
      let b = null;
      if (is('else')) { next(); b = statement(); }
      return { k: 'if', c, a, b, line: tok.line };
    }
    if (is('for') || is('intersection_for')) {
      const kind = next().value; expect('(');
      const args = argList();
      return { k: kind === 'for' ? 'for' : 'ifor', args, body: statement(), line: tok.line };
    }
    if (is('let') || is('assert') || is('echo')) {
      const kw = next().value; expect('(');
      const args = argList();
      return { k: 'call', name: kw, args, child: childOf(), line: tok.line };
    }
    if (peek().type === 'id') {
      const name = next().value; expect('(');
      const args = argList();
      return { k: 'call', name, args, child: childOf(), line: tok.line };
    }
    fail(loc('Unerwartet: {f}', { f: desc(tok) }));
  };
  const childOf = () => { if (is(';')) { next(); return null; } return statement(); };

  const body = [];
  while (peek().type !== 'eof') { const s = statement(); if (s) body.push(s); }
  return { k: 'block', body, line: 1 };
}

/* ======================= Werte ======================= */
const isNum = v => typeof v === 'number';
const isVec = v => Array.isArray(v);
class Range { constructor(a, s, b) { this.a = a; this.s = s; this.b = b; } * [Symbol.iterator]() { if (!(this.s > 0 || this.s < 0)) return; const n = Math.floor((this.b - this.a) / this.s + 1e-9); for (let i = 0; i <= n && i < 1e6; i++) yield this.a + i * this.s; } }
class Fn { constructor(params, body, scope, name) { this.params = params; this.body = body; this.scope = scope; this.name = name; } }
const rad = d => d * Math.PI / 180, deg = r => r * 180 / Math.PI;
// Winkelfunktionen in Grad, bei Vielfachen von 90° exakt
const sinD = a => { const m = ((a % 360) + 360) % 360; return m === 0 || m === 180 ? 0 : m === 90 ? 1 : m === 270 ? -1 : Math.sin(rad(a)); };
const cosD = a => sinD(a + 90);
const truthy = v => !(v === undefined || v === false || v === 0 || v === '' || (isVec(v) && !v.length) || Number.isNaN(v));
function fmt(v) {
  if (v === undefined) return 'undef';
  if (isNum(v)) {
    if (!isFinite(v)) return Number.isNaN(v) ? 'nan' : v > 0 ? 'inf' : '-inf';
    const r = Math.abs(v) >= 1e-6 && Math.abs(v) < 1e15 ? Number(v.toPrecision(6)) : v;
    return String(r);
  }
  if (typeof v === 'string') return v;
  if (typeof v === 'boolean') return String(v);
  if (isVec(v)) return '[' + v.map(x => typeof x === 'string' ? JSON.stringify(x) : fmt(x)).join(', ') + ']';
  if (v instanceof Range) return `[${fmt(v.a)} : ${fmt(v.s)} : ${fmt(v.b)}]`;
  if (v instanceof Fn) return 'function';
  return String(v);
}
const eqv = (a, b) => {
  if (isVec(a) && isVec(b)) return a.length === b.length && a.every((x, i) => eqv(x, b[i]));
  return a === b;
};

/* ======================= Geometrie-Hilfen ======================= */
// 4×4-Matrizen zeilenweise; Punkte liegen in z = 0, nach der Abbildung zählt die Draufsicht (x, y)
const M4 = {
  id: () => [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1],
  mul(a, b) { const o = new Array(16).fill(0); for (let r = 0; r < 4; r++) for (let c = 0; c < 4; c++) for (let k = 0; k < 4; k++) o[r * 4 + c] += a[r * 4 + k] * b[k * 4 + c]; return o; },
  apply(m, p) { return { x: m[0] * p.x + m[1] * p.y + m[3], y: m[4] * p.x + m[5] * p.y + m[7] }; }
};
function rotM(ax, ay, az) {
  const cx = cosD(ax), sx = sinD(ax), cy = cosD(ay), sy = sinD(ay), cz = cosD(az), sz = sinD(az);
  const Rx = [1, 0, 0, 0, 0, cx, -sx, 0, 0, sx, cx, 0, 0, 0, 0, 1];
  const Ry = [cy, 0, sy, 0, 0, 1, 0, 0, -sy, 0, cy, 0, 0, 0, 0, 1];
  const Rz = [cz, -sz, 0, 0, sz, cz, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
  return M4.mul(Rz, M4.mul(Ry, Rx));          // erst x, dann y, dann z (wie OpenSCAD)
}
function hull(pts) {
  const P = pts.slice().sort((a, b) => a.x - b.x || a.y - b.y);
  if (P.length < 3) return P;
  const cr = (o, a, b) => (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);
  const lo = [], up = [];
  for (const p of P) { while (lo.length >= 2 && cr(lo[lo.length - 2], lo[lo.length - 1], p) <= 1e-12) lo.pop(); lo.push(p); }
  for (let i = P.length - 1; i >= 0; i--) { const p = P[i]; while (up.length >= 2 && cr(up[up.length - 2], up[up.length - 1], p) <= 1e-12) up.pop(); up.push(p); }
  return lo.slice(0, -1).concat(up.slice(0, -1));
}
// Umrisse nach Verschachtelung ausrichten (außen gegen, Löcher im Uhrzeigersinn)
function orient(polys) {
  return polys.map(p => {
    const depth = polys.reduce((n, o) => n + (o !== p && o.length > 2 && pointInPoly(p[0], o) ? 1 : 0), 0);
    return (depth % 2 === 0) === (polyArea(p) > 0) ? p : p.slice().reverse();
  });
}
const tidy = polys => polys.map(p => cleanPoly(p, 1e-7)).filter(p => p.length >= 3 && Math.abs(polyArea(p)) > 1e-9);
// Geometrie eines Objekts: { polys, is3d }; mehrere Objekte werden für Operationen vereinigt
// Die Farbe des Ergebnisses ist die des ersten Teils (wie bei OpenSCAD-Operationen)
function unite(objs) {
  let acc = null, is3d = false, color;
  for (const o of objs) {
    if (!o || !o.polys.length) continue;
    is3d = is3d || o.is3d;
    if (acc === null) color = o.color;
    acc = acc ? boolOp(acc, o.polys, 'union') : orient(tidy(o.polys));
  }
  return { polys: acc ? tidy(acc) : [], is3d, color };
}
// Farbe vereinheitlichen: Namen klein, Vektoren [r, g, b] (0…1) als #rrggbb
function colorKey(c) {
  if (typeof c === 'string') return c.trim().toLowerCase();
  if (isVec(c) && c.length >= 3) return '#' + c.slice(0, 3).map(v => Math.round(Math.max(0, Math.min(1, +v || 0)) * 255).toString(16).padStart(2, '0')).join('');
  return undefined;
}

/* ======================= Auswertung ======================= */
class Scope {
  // parent: lexikalisch (Variablen, Module, Funktionen); caller: Aufrufstelle – dort suchen $-Variablen weiter
  constructor(parent, caller) { this.parent = parent; this.caller = caller || null; this.vars = new Map(); this.mods = new Map(); this.funs = new Map(); }
  lookup(name) {
    if (name[0] === '$') { for (let s = this; s; s = s.caller || s.parent) if (s.vars.has(name)) return { v: s.vars.get(name) }; return null; }
    for (let s = this; s; s = s.parent) if (s.vars.has(name)) return { v: s.vars.get(name) };
    return null;
  }
  findMod(name) { for (let s = this; s; s = s.parent) if (s.mods.has(name)) return s.mods.get(name); return null; }
  findFun(name) { for (let s = this; s; s = s.parent) if (s.funs.has(name)) return s.funs.get(name); return null; }
}

/* run(src, opts) → { polys, warnings, echo, params }
   opts.params: Werte für Customizer-Parameter (überschreiben die Zuweisungen oben in der Datei)
   opts.text(str, { size, font, halign, valign, spacing }) → Umrisse (Browser); ohne: Text wird übersprungen */
export function run(src, opts = {}) {
  const ast = parse(src);
  const warnings = [], echo = [];
  const warn = (msg, line) => { if (warnings.length < 50) warnings.push(line ? loc('{m} (Zeile {n})', { m: msg, n: line }) : msg); };
  let steps = 0;
  const tick = line => { if (++steps > 2e6) throw new ScadError(loc('Abbruch: zu viele Rechenschritte (Endlosschleife?)'), line); };
  const root = new Scope(null, null);
  for (const [k, v] of Object.entries({ $fn: 0, $fa: 2, $fs: 0.25, $t: 0, $preview: false, PI: Math.PI })) root.vars.set(k, v);
  const overrides = opts.params || {};

  // Anweisungsblock: Definitionen zuerst (gelten im ganzen Block), Zuweisungen in Reihenfolge –
  // bei doppelter Zuweisung gilt wie in OpenSCAD der letzte Wert an der Stelle der ersten.
  const declare = (stmts, scope, top) => {
    const assigns = [];
    for (const s of stmts) {
      if (s.k === 'moddef') scope.mods.set(s.name, { params: s.params, body: s.body, scope });
      else if (s.k === 'fundef') scope.funs.set(s.name, new Fn(s.params, s.body, scope, s.name));
      else if (s.k === 'assign') {
        const i = assigns.findIndex(a => a.name === s.name);
        if (i >= 0) assigns[i] = { ...s, line: assigns[i].line }; else assigns.push(s);
      }
    }
    for (const a of assigns) {
      if (top && Object.prototype.hasOwnProperty.call(overrides, a.name)) scope.vars.set(a.name, overrides[a.name]);
      else scope.vars.set(a.name, ev(a.e, scope));
    }
  };

  // ---- Ausdrücke ----
  const num = (v, what, line) => { if (!isNum(v)) throw new ScadError(loc('Bereich: Zahl erwartet, bekommen {v}', { v: fmt(v) }), line); return v; };
  const ev = (e, sc) => {
    tick(e.line);
    switch (e.k) {
      case 'lit': return e.v;
      case 'var': {
        const r = sc.lookup(e.name);
        if (r) return r.v;
        const f = sc.findFun(e.name); if (f) return f;
        if (BUILTIN_FN[e.name]) return { builtin: e.name };
        warn(loc('Unbekannte Variable „{n}“', { n: e.name }), e.line); return undefined;
      }
      case 'vec': { const out = []; for (const it of e.items) listItem(it, sc, out); return out; }
      case 'lc': { const out = []; listItem(e, sc, out); return out; }
      case 'range': {
        const a = ev(e.a, sc), b = ev(e.b, sc), s = e.s ? ev(e.s, sc) : 1;
        return new Range(num(a, 'Bereich', e.line), num(s, 'Bereich', e.line), num(b, 'Bereich', e.line));
      }
      case 'un': {
        const v = ev(e.e, sc);
        if (e.op === '!') return !truthy(v);
        if (e.op === '-') return neg(v);
        return v;
      }
      case 'bin': {
        if (e.op === '&&') return truthy(ev(e.l, sc)) && truthy(ev(e.r, sc));
        if (e.op === '||') return truthy(ev(e.l, sc)) || truthy(ev(e.r, sc));
        return binop(e.op, ev(e.l, sc), ev(e.r, sc));
      }
      case 'tern': return truthy(ev(e.c, sc)) ? ev(e.a, sc) : ev(e.b, sc);
      case 'idx': {
        const v = ev(e.e, sc), i = ev(e.i, sc);
        if ((isVec(v) || typeof v === 'string') && isNum(i)) return v[Math.floor(i)];
        if (v instanceof Range && isNum(i)) return [...v][Math.floor(i)];
        return undefined;
      }
      case 'mem': {
        const v = ev(e.e, sc), k = { x: 0, y: 1, z: 2 }[e.name];
        if (isVec(v) && k !== undefined) return v[k];
        if (v instanceof Range) return { begin: v.a, step: v.s, end: v.b }[e.name];
        return undefined;
      }
      case 'lambda': return new Fn(e.params, e.body, sc, null);
      case 'let': { const s2 = new Scope(sc); for (const a of e.args) s2.vars.set(a.name, ev(a.e, s2)); return e.body ? ev(e.body, s2) : undefined; }
      case 'assert': {
        const c = e.args[0] ? ev(e.args[0].e, sc) : undefined;
        if (!truthy(c)) throw new ScadError(loc('assert fehlgeschlagen') + (e.args[1] ? ': ' + fmt(ev(e.args[1].e, sc)) : ''), e.line);
        return e.body ? ev(e.body, sc) : undefined;
      }
      case 'echo': { echo.push(e.args.map(a => (a.name ? a.name + ' = ' : '') + fmtEcho(ev(a.e, sc))).join(', ')); return e.body ? ev(e.body, sc) : undefined; }
      case 'call': {
        if (e.f.k === 'var') {
          const r = sc.lookup(e.f.name);
          const f = r && (r.v instanceof Fn || (r.v && r.v.builtin)) ? r.v : sc.findFun(e.f.name);
          if (f) return callFn(f, e.args, sc, e.line);
          if (BUILTIN_FN[e.f.name]) return callBuiltin(e.f.name, e.args, sc, e.line);
          warn(loc('Unbekannte Funktion „{n}“', { n: e.f.name }), e.line); return undefined;
        }
        const f = ev(e.f, sc);
        if (f instanceof Fn || (f && f.builtin)) return callFn(f, e.args, sc, e.line);
        warn(loc('Aufruf eines Werts, der keine Funktion ist'), e.line); return undefined;
      }
    }
    throw new ScadError(loc('Unbekannter Ausdruck'), e.line);
  };
  const fmtEcho = v => typeof v === 'string' ? JSON.stringify(v) : fmt(v);
  const listItem = (it, sc, out) => {
    if (it.k !== 'lc') { out.push(ev(it, sc)); return; }
    tick(it.line);
    if (it.kind === 'if') { if (truthy(ev(it.c, sc))) listItem(it.a, sc, out); else if (it.b) listItem(it.b, sc, out); return; }
    if (it.kind === 'let') { const s2 = new Scope(sc); for (const a of it.args) s2.vars.set(a.name, ev(a.e, s2)); listItem(it.body, s2, out); return; }
    if (it.kind === 'each') { const v = ev(it.e.k === 'lc' ? { k: 'vec', items: [it.e] } : it.e, sc); if (isVec(v) || v instanceof Range) for (const x of v) out.push(x); else if (typeof v === 'string') for (const ch of v) out.push(ch); else out.push(v); return; }
    if (it.kind === 'for') { forEach(it.args, sc, s2 => listItem(it.body, s2, out), it.line); return; }
    if (it.kind === 'cfor') {
      let s2 = new Scope(sc);
      for (const a of it.init) s2.vars.set(a.name, ev(a.e, s2));
      while (truthy(ev(it.cond, s2))) {
        tick(it.line);
        listItem(it.body, s2, out);
        const s3 = new Scope(sc);
        for (const [k, v] of s2.vars) s3.vars.set(k, v);
        for (const a of it.upd) s3.vars.set(a.name, ev(a.e, s2));
        s2 = s3;
      }
    }
  };
  // for (i = …, j = …): verschachtelt über alle Kombinationen
  const forEach = (args, sc, fn, line) => {
    const rec = (k, s) => {
      if (k === args.length) { fn(s); return; }
      const a = args[k], v = ev(a.e, s);
      const items = isVec(v) || v instanceof Range ? v : typeof v === 'string' ? [...v] : v === undefined ? [] : [v];
      for (const x of items) { tick(line); const s2 = new Scope(s); s2.vars.set(a.name, x); rec(k + 1, s2); }
    };
    rec(0, sc);
  };
  const neg = v => isNum(v) ? -v : isVec(v) ? v.map(neg) : undefined;
  const binop = (op, a, b) => {
    switch (op) {
      case '+': case '-': {
        if (isNum(a) && isNum(b)) return op === '+' ? a + b : a - b;
        if (isVec(a) && isVec(b)) { const n = Math.min(a.length, b.length); const o = []; for (let i = 0; i < n; i++) o.push(binop(op, a[i], b[i])); return o; }
        return undefined;
      }
      case '*': {
        if (isNum(a) && isNum(b)) return a * b;
        if (isNum(a) && isVec(b)) return b.map(x => binop('*', a, x));
        if (isVec(a) && isNum(b)) return a.map(x => binop('*', x, b));
        if (isVec(a) && isVec(b)) {
          const am = a.length && isVec(a[0]), bm = b.length && isVec(b[0]);
          if (!am && !bm) return a.length === b.length ? a.reduce((s, x, i) => s + x * b[i], 0) : undefined;          // Skalarprodukt
          if (am && !bm) return a.map(row => binop('*', row, b));                                                     // Matrix · Vektor
          if (!am && bm) return b[0].map((_, j) => a.reduce((s, x, i) => s + x * b[i][j], 0));                         // Vektor · Matrix
          return a.map(row => b[0].map((_, j) => row.reduce((s, x, i) => s + x * b[i][j], 0)));                       // Matrix · Matrix
        }
        return undefined;
      }
      case '/': if (isNum(a) && isNum(b)) return a / b; if (isVec(a) && isNum(b)) return a.map(x => binop('/', x, b)); if (isNum(a) && isVec(b)) return b.map(x => binop('/', a, x)); return undefined;
      case '%': return isNum(a) && isNum(b) ? a - b * Math.trunc(a / b) : undefined;
      case '^': return isNum(a) && isNum(b) ? Math.pow(a, b) : undefined;
      case '<': return a < b; case '>': return a > b; case '<=': return a <= b; case '>=': return a >= b;
      case '==': return eqv(a, b); case '!=': return !eqv(a, b);
    }
  };
  // Argumente an Parameter binden
  const bind = (params, args, sc, target, line) => {
    const pos = args.filter(a => !a.name), named = args.filter(a => a.name);
    params.forEach((p, i) => {
      const na = named.find(a => a.name === p.name);
      if (na) target.vars.set(p.name, ev(na.e, sc));
      else if (i < pos.length) target.vars.set(p.name, ev(pos[i].e, sc));
      else target.vars.set(p.name, p.def ? ev(p.def, target) : undefined);
    });
    for (const a of named) if (a.name[0] === '$') target.vars.set(a.name, ev(a.e, sc));
    else if (!params.some(p => p.name === a.name)) warn(loc('Unbekannter Parameter „{n}“', { n: a.name }), line);
  };
  let depth = 0;
  const callFn = (f, args, sc, line) => {
    if (f.builtin) return callBuiltin(f.builtin, args, sc, line);
    if (++depth > 400) throw new ScadError(loc('Rekursion zu tief'), line);
    const s = new Scope(f.scope, sc);
    bind(f.params, args, sc, s, line);
    try { return ev(f.body, s); } finally { depth--; }
  };
  const callBuiltin = (name, args, sc, line) => {
    const vals = args.map(a => ev(a.e, sc));
    const named = {}; args.forEach((a, i) => { if (a.name) named[a.name] = vals[i]; });
    const pos = vals.filter((_, i) => !args[i].name);
    return BUILTIN_FN[name](pos, named, { line, warn, callFn: (f, xs) => callFn(f, xs.map(x => ({ name: null, e: { k: 'lit', v: x } })), sc, line) });
  };

  // ---- Module ----
  const fragments = (r, sc) => {
    const fn = sc.lookup('$fn').v, fa = sc.lookup('$fa').v, fs = sc.lookup('$fs').v;
    if (r < 1e-9) return 3;
    if (fn > 0) return Math.max(3, Math.floor(fn));
    return Math.ceil(Math.max(Math.min(360 / fa, r * 2 * Math.PI / fs), 5));
  };
  const circlePts = (r, sc) => { const n = fragments(r, sc); const o = []; for (let i = 0; i < n; i++) o.push({ x: r * cosD(360 * i / n), y: r * sinD(360 * i / n) }); return o; };
  const xform = (objs, m) => objs.map(o => {
    const det = m[0] * m[5] - m[1] * m[4];
    let polys = o.polys.map(p => p.map(q => M4.apply(m, q)));
    if (Math.abs(det) < 1e-12) { warn(loc('Drehung kippt die Fläche senkrecht – sie fällt in der Draufsicht weg')); polys = []; }
    else if (det < 0) polys = polys.map(p => p.slice().reverse());
    return { polys, is3d: o.is3d, color: o.color };
  });

  // Anweisungen eines Blocks auswerten → Liste von Objekten
  const execBlock = (stmts, sc, top = false) => {
    declare(stmts, sc, top);
    const roots = stmts.filter(s => s.mod && s.mod.includes('!'));
    const out = [];
    for (const s of (roots.length ? roots : stmts)) { const r = exec(s, sc); if (r) out.push(...r); }
    return out;
  };
  const exec = (s, sc) => {
    tick(s.line);
    if (s.mod && (s.mod.includes('*') || s.mod.includes('%'))) return [];
    switch (s.k) {
      case 'assign': case 'moddef': case 'fundef': return [];
      case 'block': return execBlock(s.body, new Scope(sc));
      case 'if': return truthy(ev(s.c, sc)) ? (s.a ? exec(s.a, new Scope(sc)) : []) : (s.b ? exec(s.b, new Scope(sc)) : []);
      case 'for': { const out = []; forEach(s.args, sc, s2 => { if (s.body) out.push(...exec(s.body, s2)); }, s.line); return out; }
      case 'ifor': {
        let acc = null;
        forEach(s.args, sc, s2 => { const g = unite(s.body ? exec(s.body, s2) : []); acc = acc ? { ...acc, polys: tidy(boolOp(acc.polys, g.polys, 'intersect')), is3d: acc.is3d || g.is3d } : g; }, s.line);
        return acc ? [acc] : [];
      }
      case 'call': return callModule(s, sc);
    }
    return [];
  };
  const children = (s, sc) => s.child ? exec(s.child, new Scope(sc)) : [];
  const callModule = (s, sc) => {
    const { name, args, line } = s;
    if (name === 'echo') { const vals = args.map(a => (a.name ? a.name + ' = ' : '') + fmtEcho(ev(a.e, sc))); echo.push(vals.join(', ')); return children(s, sc); }
    if (name === 'let') { const s2 = new Scope(sc); for (const a of args) s2.vars.set(a.name, ev(a.e, s2)); return s.child ? exec(s.child, s2) : []; }
    if (name === 'assert') { const c = args[0] ? ev(args[0].e, sc) : undefined; if (!truthy(c)) throw new ScadError(loc('assert fehlgeschlagen') + (args[1] ? ': ' + fmt(ev(args[1].e, sc)) : ''), line); return children(s, sc); }
    if (name === 'children') {
      const ctx = sc.lookup('$__children'); if (!ctx) return [];
      const { stmts, scope } = ctx.v;
      const sel = args.length ? ev(args[0].e, sc) : undefined;
      const idx = sel === undefined ? stmts.map((_, i) => i) : isNum(sel) ? [sel] : [...sel];
      const out = [];
      for (const i of idx) if (stmts[i]) out.push(...exec(stmts[i], new Scope(scope)));
      return out;
    }
    const user = sc.findMod(name);
    if (user) {
      if (++depth > 400) throw new ScadError(loc('Rekursion zu tief'), line);
      try {
        const m = new Scope(user.scope, sc);
        bind(user.params, args, sc, m, line);
        const kids = s.child ? (s.child.k === 'block' ? s.child.body : [s.child]) : [];
        m.vars.set('$children', kids.length);
        m.vars.set('$__children', { stmts: kids, scope: sc });
        const body = user.body ? (user.body.k === 'block' ? user.body.body : [user.body]) : [];
        return execBlock(body, m);
      } finally { depth--; }
    }
    const B = BUILTIN_MOD[name];
    if (!B) { warn(loc('Unbekanntes Modul „{n}“', { n: name }), line); return []; }
    // Spezialvariablen ($fn …) als benannte Argumente gelten für dieses Modul und seine Kinder
    const s2 = new Scope(sc, sc);
    const A = {}; const pos = [];
    for (const a of args) { const v = ev(a.e, sc); if (a.name) { if (a.name[0] === '$') s2.vars.set(a.name, v); A[a.name] = v; } else pos.push(v); }
    return B({ pos, A, sc: s2, line, kids: () => children(s, s2), warn, circlePts, fragments, xform, opts });
  };

  let top;
  try { top = execBlock(ast.body, root, true); }
  catch (e) { if (e instanceof RangeError) throw new ScadError(loc('Rekursion zu tief')); throw e; }
  // je Farbe ein Teil (ohne Farbe: alles zusammen, wie OpenSCAD)
  const groups = new Map();
  for (const o of top) { const k = o.color || ''; if (!groups.has(k)) groups.set(k, []); groups.get(k).push(o); }
  const parts = [...groups].map(([color, objs]) => ({ color: color || null, polys: orient(unite(objs).polys) })).filter(p => p.polys.length);
  return { polys: parts.flatMap(p => p.polys), parts, warnings, echo, has3d: top.some(o => o.is3d) };
}

/* ---------------- eingebaute Funktionen ---------------- */
const nums = xs => xs.flatMap(x => isVec(x) ? x : [x]).filter(isNum);
const BUILTIN_FN = {
  sin: ([a]) => sinD(a), cos: ([a]) => cosD(a), tan: ([a]) => sinD(a) / cosD(a),
  asin: ([a]) => deg(Math.asin(a)), acos: ([a]) => deg(Math.acos(a)), atan: ([a]) => deg(Math.atan(a)), atan2: ([y, x]) => deg(Math.atan2(y, x)),
  abs: ([a]) => Math.abs(a), sign: ([a]) => Math.sign(a), ceil: ([a]) => Math.ceil(a), floor: ([a]) => Math.floor(a),
  round: ([a]) => (a < 0 ? -Math.round(-a) : Math.round(a)),
  sqrt: ([a]) => Math.sqrt(a), pow: ([a, b]) => Math.pow(a, b), exp: ([a]) => Math.exp(a), ln: ([a]) => Math.log(a), log: ([a, b]) => b === undefined ? Math.log10(a) : Math.log(b) / Math.log(a),
  min: xs => Math.min(...nums(xs.length === 1 ? xs[0] : xs)), max: xs => Math.max(...nums(xs.length === 1 ? xs[0] : xs)),
  norm: ([v]) => isVec(v) ? Math.hypot(...v) : undefined,
  cross: ([a, b]) => isVec(a) && isVec(b) ? (a.length === 2 ? a[0] * b[1] - a[1] * b[0] : [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]) : undefined,
  len: ([v]) => isVec(v) || typeof v === 'string' ? v.length : undefined,
  concat: xs => xs.flatMap(x => isVec(x) ? x : [x]),
  str: xs => xs.map(fmt).join(''),
  chr: xs => xs.flatMap(x => isVec(x) ? x : x instanceof Range ? [...x] : [x]).map(c => String.fromCodePoint(c)).join(''),
  ord: ([s]) => typeof s === 'string' && s.length ? s.codePointAt(0) : undefined,
  lookup: ([k, table]) => {
    if (!isVec(table) || !table.length) return undefined;
    const t = table.slice().sort((a, b) => a[0] - b[0]);
    if (k <= t[0][0]) return t[0][1];
    if (k >= t[t.length - 1][0]) return t[t.length - 1][1];
    for (let i = 1; i < t.length; i++) if (k <= t[i][0]) { const [a, va] = t[i - 1], [b, vb] = t[i]; return va + (vb - va) * (k - a) / (b - a); }
  },
  rands: ([lo, hi, n, seed]) => {
    let s = seed === undefined ? Math.random() * 1e9 : seed * 9301 + 49297;
    const r = () => { s = (s * 9301 + 49297) % 233280; return s / 233280; };
    return Array.from({ length: Math.max(0, Math.floor(n || 0)) }, () => lo + (hi - lo) * r());
  },
  search: ([m, v, num = 1, col = 0]) => {
    const vec = isVec(v) ? v : typeof v === 'string' ? [...v] : [];
    const find = x => { const o = []; vec.forEach((e, i) => { if ((num === 0 || o.length < num) && eqv(isVec(e) ? e[col] : e, x)) o.push(i); }); return num === 1 ? (o.length ? o[0] : []) : o; };
    if (isNum(m)) return find(m);
    return (typeof m === 'string' ? [...m] : m).map(find);
  },
  version: () => [2021, 1, 0], version_num: () => 20210100,
  is_undef: ([v]) => v === undefined, is_num: ([v]) => isNum(v) && !Number.isNaN(v), is_bool: ([v]) => typeof v === 'boolean',
  is_string: ([v]) => typeof v === 'string', is_list: ([v]) => isVec(v), is_function: ([v]) => v instanceof Fn || !!(v && v.builtin),
  parent_module: () => undefined
};

/* ---------------- eingebaute Module ---------------- */
const vec2 = (v, d) => isNum(v) || typeof v === 'boolean' ? [v, v] : isVec(v) ? [v[0] ?? d, v[1] ?? d] : [d, d];
const vec3 = (v, d) => isNum(v) ? [v, v, v] : isVec(v) ? [v[0] ?? d, v[1] ?? d, v[2] ?? d] : [d, d, d];
const pass = c => c.kids();
const footprint = (c, polys) => [{ polys, is3d: true }];
const BUILTIN_MOD = {
  square(c) {
    const [w, h] = vec2(c.A.size ?? c.pos[0] ?? 1, 1), center = c.A.center ?? c.pos[1] ?? false;
    const x0 = center ? -w / 2 : 0, y0 = center ? -h / 2 : 0;
    if (!(w > 0 && h > 0)) return [];
    return [{ polys: [[{ x: x0, y: y0 }, { x: x0 + w, y: y0 }, { x: x0 + w, y: y0 + h }, { x: x0, y: y0 + h }]], is3d: false }];
  },
  circle(c) {
    const r = c.A.r ?? (c.A.d !== undefined ? c.A.d / 2 : c.pos[0] ?? 1);
    return r > 0 ? [{ polys: [c.circlePts(r, c.sc)], is3d: false }] : [];
  },
  polygon(c) {
    const pts = (c.A.points ?? c.pos[0] ?? []).filter(isVec).map(p => ({ x: +p[0], y: +p[1] }));
    const paths = c.A.paths ?? c.pos[1];
    const polys = isVec(paths) && paths.length ? paths.map(path => path.map(i => pts[i]).filter(Boolean)) : [pts];
    // Pfade verhalten sich wie in OpenSCAD nach gerade-ungerade-Regel: Löcher sind Löcher, egal welche Richtung
    return [{ polys: orient(tidy(polys)), is3d: false }];
  },
  text(c) {
    const t = String(c.A.text ?? c.pos[0] ?? '');
    if (!t) return [];
    if (!c.opts.text) { c.warn(loc('Text wird in dieser Umgebung nicht gesetzt'), c.line); return []; }
    const font = String(c.A.font ?? '').split(':')[0].trim();
    const polys = c.opts.text(t, { size: c.A.size ?? 10, font, halign: c.A.halign ?? 'left', valign: c.A.valign ?? 'baseline', spacing: c.A.spacing ?? 1, bold: /bold/i.test(String(c.A.font ?? '')), italic: /italic|oblique/i.test(String(c.A.font ?? '')) });
    return polys.length ? [{ polys: orient(tidy(polys)), is3d: false }] : [];
  },
  // 3D-Grundkörper: Draufsicht
  cube(c) {
    const [x, y] = vec3(c.A.size ?? c.pos[0] ?? 1, 1), center = c.A.center ?? c.pos[1] ?? false;
    const x0 = center ? -x / 2 : 0, y0 = center ? -y / 2 : 0;
    return footprint(c, [[{ x: x0, y: y0 }, { x: x0 + x, y: y0 }, { x: x0 + x, y: y0 + y }, { x: x0, y: y0 + y }]]);
  },
  cylinder(c) {
    const A = c.A;
    const r1 = A.r1 ?? (A.d1 !== undefined ? A.d1 / 2 : A.r ?? (A.d !== undefined ? A.d / 2 : c.pos[1] ?? 1));
    const r2 = A.r2 ?? (A.d2 !== undefined ? A.d2 / 2 : A.r ?? (A.d !== undefined ? A.d / 2 : c.pos[2] ?? r1));
    const r = Math.max(r1, r2);
    return r > 0 ? footprint(c, [c.circlePts(r, c.sc)]) : [];
  },
  sphere(c) {
    const r = c.A.r ?? (c.A.d !== undefined ? c.A.d / 2 : c.pos[0] ?? 1);
    return r > 0 ? footprint(c, [c.circlePts(r, c.sc)]) : [];
  },
  polyhedron(c) {
    const pts = (c.A.points ?? c.pos[0] ?? []).map(p => ({ x: p[0], y: p[1] }));
    return pts.length > 2 ? footprint(c, [hull(pts)]) : [];
  },
  linear_extrude(c) { return c.kids().map(o => ({ ...o, is3d: true })); },
  rotate_extrude(c) {
    // Draufsicht eines Drehkörpers: Kreisring vom kleinsten bis zum größten Abstand zur Achse
    const g = unite(c.kids()); let r0 = Infinity, r1 = 0;
    for (const p of g.polys) for (const q of p) { const x = Math.abs(q.x); r0 = Math.min(r0, x); r1 = Math.max(r1, x); }
    if (!(r1 > 0)) return [];
    const outer = c.circlePts(r1, c.sc), polys = [outer];
    if (r0 > 1e-6) polys.push(c.circlePts(r0, c.sc).reverse());
    return footprint(c, polys);
  },
  projection(c) { return [{ ...unite(c.kids()), is3d: false }]; },
  surface(c) { c.warn(loc('surface() wird nicht unterstützt'), c.line); return []; },
  import(c) { c.warn(loc('import() wird nicht unterstützt – Datei bitte direkt in BeamSketch öffnen'), c.line); return []; },
  // Transformationen
  translate(c) { const [x, y] = vec3(c.A.v ?? c.pos[0], 0); return c.xform(c.kids(), [1, 0, 0, x || 0, 0, 1, 0, y || 0, 0, 0, 1, 0, 0, 0, 0, 1]); },
  rotate(c) {
    const a = c.A.a ?? c.pos[0], v = c.A.v ?? c.pos[1];
    let m;
    if (isVec(a)) m = rotM(a[0] || 0, a[1] || 0, a[2] || 0);
    else if (isVec(v)) {
      // Drehung um eine Achse (Rodrigues)
      const l = Math.hypot(...v) || 1, [x, y, z] = v.map(t => t / l), cs = cosD(a || 0), sn = sinD(a || 0), t = 1 - cs;
      m = [t * x * x + cs, t * x * y - sn * z, t * x * z + sn * y, 0, t * x * y + sn * z, t * y * y + cs, t * y * z - sn * x, 0, t * x * z - sn * y, t * y * z + sn * x, t * z * z + cs, 0, 0, 0, 0, 1];
    } else m = rotM(0, 0, a || 0);
    return c.xform(c.kids(), m);
  },
  scale(c) { const [x, y, z] = vec3(c.A.v ?? c.pos[0] ?? 1, 1); return c.xform(c.kids(), [x, 0, 0, 0, 0, y, 0, 0, 0, 0, z, 0, 0, 0, 0, 1]); },
  mirror(c) {
    const [a, b, d] = vec3(c.A.v ?? c.pos[0] ?? [1, 0, 0], 0), l = a * a + b * b + d * d;
    if (!l) return c.kids();
    const k = 2 / l;
    return c.xform(c.kids(), [1 - k * a * a, -k * a * b, -k * a * d, 0, -k * a * b, 1 - k * b * b, -k * b * d, 0, -k * a * d, -k * b * d, 1 - k * d * d, 0, 0, 0, 0, 1]);
  },
  multmatrix(c) {
    const M = c.A.m ?? c.pos[0];
    if (!isVec(M)) return c.kids();
    const m = M4.id();
    for (let r = 0; r < Math.min(4, M.length); r++) for (let k = 0; k < 4; k++) if (isNum(M[r][k])) m[r * 4 + k] = M[r][k];
    return c.xform(c.kids(), m);
  },
  resize(c) {
    const kids = c.kids(), g = unite(kids);
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const p of g.polys) for (const q of p) { x0 = Math.min(x0, q.x); y0 = Math.min(y0, q.y); x1 = Math.max(x1, q.x); y1 = Math.max(y1, q.y); }
    if (!isFinite(x0)) return [];
    const [nx, ny] = vec2(c.A.newsize ?? c.pos[0], 0), auto = c.A.auto ?? c.pos[1] ?? false;
    let sx = nx > 0 ? nx / (x1 - x0) : 1, sy = ny > 0 ? ny / (y1 - y0) : 1;
    const au = vec2(auto, false);
    if (nx > 0 && !(ny > 0) && au[1]) sy = sx;
    if (ny > 0 && !(nx > 0) && au[0]) sx = sy;
    return c.xform([g], [sx, 0, 0, 0, 0, sy, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
  },
  color(c) {
    const k = colorKey(c.A.c ?? c.pos[0]);
    return c.kids().map(o => ({ ...o, color: k ?? o.color }));
  },
  render: pass, group: pass,
  // Boolesche Operationen
  union(c) { return [unite(c.kids())]; },
  difference(c) {
    const kids = c.kids();
    if (!kids.length) return [];
    let acc = unite([kids[0]]);
    for (const k of kids.slice(1)) { if (!k.polys.length) continue; acc = { ...acc, polys: tidy(boolOp(acc.polys, unite([k]).polys, 'subtract')) }; }
    return [acc];
  },
  intersection(c) {
    const kids = c.kids().filter(k => k.polys.length);
    if (!kids.length) return [];
    let acc = unite([kids[0]]);
    for (const k of kids.slice(1)) acc = { ...acc, polys: tidy(boolOp(acc.polys, unite([k]).polys, 'intersect')), is3d: acc.is3d || k.is3d };
    return [acc];
  },
  offset(c) {
    const g = unite(c.kids());
    const r = c.A.r, delta = c.A.delta ?? (r === undefined ? c.pos[0] ?? 1 : undefined), chamfer = c.A.chamfer ?? false;
    const d = r !== undefined ? r : delta;
    if (!d) return [g];
    const join = r !== undefined ? 'round' : chamfer ? 'miter' : 'sharp';
    return [{ ...g, polys: orient(tidy(offsetPolys(g.polys, d, join))) }];
  },
  hull(c) {
    const kids = c.kids(), pts = kids.flatMap(o => o.polys.flat());
    return pts.length > 2 ? [{ polys: [hull(pts)], is3d: kids.some(k => k.is3d), color: (kids.find(k => k.polys.length) || {}).color }] : [];
  },
  minkowski(c) {
    const kids = c.kids().filter(k => k.polys.length);
    if (kids.length < 2) return kids;
    // Summe zweier Flächen: für konvexe Teile exakt über die Hülle aller Punktsummen
    let acc = unite([kids[0]]);
    for (const k of kids.slice(1)) {
      const B = k.polys.flat(), parts = [];
      for (const a of acc.polys.filter(p => polyArea(p) > 0)) { const pts = []; for (const p of a) for (const q of B) pts.push({ x: p.x + q.x, y: p.y + q.y }); parts.push({ polys: [hull(pts)], is3d: false }); }
      if (acc.polys.some(p => polyArea(p) > 0 && hull(p).length !== cleanPoly(p).length)) c.warn(loc('minkowski() mit nicht konvexer Form wird angenähert (konvexe Hülle)'), c.line);
      acc = { ...unite(parts), color: acc.color };
    }
    return [acc];
  }
};

/* ---------------- Customizer: Parameter oben in der Datei ----------------
   name = 20; // [5:50]        Schieberegler          name = "a"; // [a, b, c]  Auswahl
   name = true;                Kontrollkästchen        /* [Gruppe] *\/        Gruppen, [Hidden] blendet aus
   Die Zeile davor (// Kommentar) ist die Beschreibung. Gesammelt wird bis zum ersten Modul. */
export function scadParams(src) {
  const lines = src.split('\n');
  const out = [];
  let group = '', desc = '', depth = 0, inBlock = false;
  for (let i = 0; i < lines.length; i++) {
    const L = lines[i], s = L.trim();
    if (inBlock) { if (s.includes('*/')) inBlock = false; continue; }
    const g = /^\/\*\s*\[([^\]]*)\]\s*\*\/$/.exec(s);
    if (g) { group = g[1].trim(); desc = ''; continue; }
    if (s.startsWith('/*') && !s.includes('*/')) { inBlock = true; continue; }
    if (s.startsWith('//')) { desc = s.replace(/^\/\/+\s*/, ''); continue; }
    if (!s) { desc = ''; continue; }
    if (depth === 0 && /^(module|function)\b/.test(s)) break;
    const m = depth === 0 ? /^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.+?);\s*(\/\/\s*(.*))?$/.exec(s) : null;
    if (m && /^hidden$/i.test(group) === false) {
      const [, name, raw, , hint] = m;
      let value; let type = null;
      try {
        const v = JSON.parse(raw.replace(/^(-?\.\d)/, '0$1'));
        if (typeof v === 'number') type = 'number'; else if (typeof v === 'boolean') type = 'bool'; else if (typeof v === 'string') type = 'string';
        else if (Array.isArray(v) && v.every(x => typeof x === 'number')) type = 'vector';
        value = v;
      } catch (e) { type = null; }
      if (type) {
        const p = { name, value, type, desc, group, line: i + 1 };
        const h = hint && /^\[(.*)\]\s*$/.exec(hint.trim());
        if (h && type !== 'bool') {
          const inner = h[1];
          const r = /^\s*(-?[\d.]+)\s*(?::\s*(-?[\d.]+))?\s*(?::\s*(-?[\d.]+))?\s*$/.exec(inner);
          if (r && type === 'number' && !inner.includes(',')) {
            if (r[3] !== undefined) { p.min = +r[1]; p.step = +r[2]; p.max = +r[3]; }
            else if (r[2] !== undefined) { p.min = +r[1]; p.max = +r[2]; }
            else { p.min = 0; p.max = +r[1]; }
          } else {
            p.options = inner.split(',').map(x => x.trim()).filter(Boolean).map(x => {
              const [v, label] = x.split(':').map(y => y.trim());
              return { v: type === 'number' ? +v : v.replace(/^"|"$/g, ''), t: label || v.replace(/^"|"$/g, '') };
            });
          }
        } else if (hint && !h) p.desc = p.desc || hint.trim();
        out.push(p);
      }
      desc = '';
    } else desc = '';
    depth += (L.match(/\{/g) || []).length - (L.match(/\}/g) || []).length;
  }
  return out;
}
