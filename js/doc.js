// doc.js — Dokumentmodell, Ebenen (Cut-Layer), Formen, Undo
import { Mat, V, emptyBox, growBox, mergeBox, boxValid, flattenCubic, cubicBBox, arcToCubics, cleanPoly, polyArea } from './geom.js';

// Eigene Palette: gut unterscheidbar auf heller und dunkler Arbeitsfläche
export const LAYER_COLORS = [
  '#2b2d42', '#e63946', '#1d7fe0', '#2a9d4b', '#f4a100', '#8e44ad', '#00a6a6', '#d6336c',
  '#6b7f00', '#b85c00', '#3f51b5', '#7cb518', '#9d0208', '#0096c7', '#a0522d', '#5e60ce',
  '#e76f51', '#2d6a4f', '#b5179e', '#577590', '#ff7f11', '#006d77', '#c0392b', '#4361ee',
  '#8a817c', '#43aa8b', '#c9a227', '#7209b7', '#ef476f', '#118ab2'
];
export const TOOL_COLORS = ['#00b4d8', '#ff8fab'];
// Ältere Projekte: Standardfarben der früheren Palette auf die neue umstellen
const OLD_COLORS = [
  '#000000', '#0000ff', '#ff0000', '#00e000', '#d0d000', '#ff8000', '#00e0e0', '#ff00ff',
  '#b4b4b4', '#0000a0', '#a00000', '#00a000', '#a0a000', '#c08000', '#00a0ff', '#a000a0',
  '#808080', '#7d7dff', '#ff7d7d', '#7dff7d', '#a0a03c', '#ffa07d', '#7dffff', '#ff7dff',
  '#505050', '#0000d2', '#00d200', '#d20000', '#d2d200', '#8000ff'
];
export function migrateLayers(layers) {
  for (const L of layers) {
    if (L.isTool) {
      if (L.name === 'T1' || L.name === 'T2') L.name = '';
      if (L.color === '#00a0ff' || L.color === '#ff00a0') L.color = TOOL_COLORS[L.index - 30] || L.color;
    } else if (L.color === OLD_COLORS[L.index]) L.color = LAYER_COLORS[L.index];
  }
  return layers;
}
// Anzeige-Nummer einer Ebene: 01 … 30 (Hilfsebenen haben keine Nummer)
export const layerNo = i => String(i + 1).padStart(2, '0');

export const CUT_MODES = ['line', 'fill', 'fill+line', 'offset'];

export function defaultLayer(i) {
  return {
    index: i,
    name: '',
    color: LAYER_COLORS[i % LAYER_COLORS.length],
    mode: 'line',
    output: true,
    show: true,
    speed: 100,          // mm/s
    maxPower: 20,        // %
    minPower: 15,        // % (für dynamische Leistung / Kurven)
    passes: 1,
    interval: 0.1,       // mm (Füllung / Gravur-Zeilenabstand)
    angle: 0,            // Grad
    crosshatch: false,
    bidir: true,
    overscan: 2.5,       // %
    kerf: 0,             // mm Schnittfugen-Ausgleich
    zOffset: 0,
    zStep: 0,
    airAssist: true,
    constantPower: false, // M3 statt M4
    priority: i,
    tabs: { enabled: false, count: 4, size: 0.5, skipSmall: true },
    dotMode: false,
    dotTime: 1.0,
    offsetCount: 0,      // Offset-Füllung: 0 = bis leer
    isTool: false
  };
}

export function newDoc() {
  const layers = [];
  for (let i = 0; i < 30; i++) layers.push(defaultLayer(i));
  const t1 = defaultLayer(30); t1.color = TOOL_COLORS[0]; t1.isTool = true; t1.output = false;
  const t2 = defaultLayer(31); t2.color = TOOL_COLORS[1]; t2.isTool = true; t2.output = false;
  layers.push(t1, t2);
  return {
    shapes: [],
    layers,
    machine: defaultMachine(),
    settings: {
      unit: 'mm',
      gridSize: 10,
      snapGrid: false,
      snapObjects: true,
      curveTol: 0.02
    },
    nextId: 1
  };
}

export function defaultMachine() {
  return {
    name: 'CR-Laser Falcon',
    firmware: 'GRBL',
    width: 400, height: 415,
    originCorner: 'front-left',      // Maschinennullpunkt
    sScale: 1000,
    baud: 115200,
    startGcode: '',
    endGcode: '',
    enableZ: false,
    negativeZ: false,
    airAssistM7: false,              // false => M8
    laserFirePower: 3,
    boundsCheck: true,
    homeOnStartup: true,
    maxSpeedX: 500, maxSpeedY: 400,
    accelX: 3000, accelY: 3000,
    rapidSpeed: 400,
    junctionDeviation: 0.01,
    absoluteCoords: true,
    jobOrigin: 'absolute',           // current | absolute | user
    jobOriginAnchor: 4,              // 0..8 (3x3 Raster) für "Aktuelle Position"
    userX: 0, userY: 0,
    finishX: 0, finishY: 0,
    returnToFinish: false,
    // Rahmen um den Job vor dem Start abfahren: 'off' | 'move' (Laser aus) | 'laser' (schwacher Laser)
    frameBeforeJob: 'laser',
    frameRepeat: 1,
    frameSpeed: 60,                  // mm/s beim Rahmen mit Laser (langsam genug zum Sehen)
    framePause: 1                    // Sekunden Pause nach dem Rahmen
  };
}

/* ---------------- Formen ---------------- */
let idc = 1;
export function uid() { return 'S' + (idc++) + '_' + Math.random().toString(36).slice(2, 7); }

function base(type, layer) {
  return { id: uid(), type, layer, transform: Mat.id(), name: '', locked: false, hidden: false };
}
export const Shape = {
  rect(x, y, w, h, layer = 0, r = 0) {
    const s = base('rect', layer); s.w = w; s.h = h; s.r = r;
    s.transform = Mat.translate(x, y); return s;
  },
  ellipse(cx, cy, rx, ry, layer = 0) {
    const s = base('ellipse', layer); s.rx = rx; s.ry = ry;
    s.transform = Mat.translate(cx, cy); return s;
  },
  polygon(cx, cy, r, n, layer = 0, star = 0) {
    const s = base('polygon', layer); s.r = r; s.n = n; s.star = star;
    s.transform = Mat.translate(cx, cy); return s;
  },
  path(subpaths, layer = 0) {
    const s = base('path', layer); s.subpaths = subpaths; return s;
  },
  text(x, y, text, layer = 0) {
    const s = base('text', layer);
    s.text = text; s.font = 'Sans'; s.size = 20; s.bold = false; s.italic = false;
    s.hspace = 0; s.vspace = 0; s.align = 'left'; s.weld = false;
    s.transform = Mat.translate(x, y);
    return s;
  },
  image(x, y, w, h, src, layer = 0) {
    const s = base('image', layer);
    s.w = w; s.h = h; s.src = src;
    s.dither = 'stucki'; s.dpi = 254; s.contrast = 0; s.brightness = 0; s.gamma = 1;
    s.invert = false; s.negative = false; s.transparency = true; s.threshold = 128;
    s.transform = Mat.translate(x, y);
    return s;
  },
  group(children, layer = 0) {
    const s = base('group', layer); s.children = children; return s;
  }
};

/* Subpath: {closed:bool, nodes:[{x,y,in:{x,y}|null,out:{x,y}|null}]} */
export function nodeSub(pts, closed = true) {
  return { closed, nodes: pts.map(p => ({ x: p.x, y: p.y, in: p.in || null, out: p.out || null })) };
}

/* ---------------- Lokale Geometrie -> Subpaths ---------------- */
export function shapeSubpaths(sh, fontProvider) {
  switch (sh.type) {
    case 'rect': {
      const { w, h } = sh;
      const r = sh.r || 0;
      if (r <= 0) {
        return [nodeSub([{ x: 0, y: 0 }, { x: w, y: 0 }, { x: w, y: h }, { x: 0, y: h }], true)];
      }
      const rr = Math.min(r, Math.abs(w) / 2, Math.abs(h) / 2);
      const k = rr * 0.5522847498307936;
      return [{
        closed: true, nodes: [
          { x: rr, y: 0, in: { x: rr - k, y: 0 }, out: null },
          { x: w - rr, y: 0, in: null, out: { x: w - rr + k, y: 0 } },
          { x: w, y: rr, in: { x: w, y: rr - k }, out: null },
          { x: w, y: h - rr, in: null, out: { x: w, y: h - rr + k } },
          { x: w - rr, y: h, in: { x: w - rr + k, y: h }, out: null },
          { x: rr, y: h, in: null, out: { x: rr - k, y: h } },
          { x: 0, y: h - rr, in: { x: 0, y: h - rr + k }, out: null },
          { x: 0, y: rr, in: null, out: { x: 0, y: rr - k } }
        ]
      }];
    }
    case 'ellipse': {
      const cs = arcToCubics(0, 0, sh.rx, sh.ry, 0, 0, Math.PI * 2);
      const nodes = [];
      for (let i = 0; i < cs.length; i++) {
        const c = cs[i], nx = cs[(i + 1) % cs.length];
        nodes.push({ x: c.p0.x, y: c.p0.y, in: (i === 0 ? cs[cs.length - 1].c2 : cs[i - 1].c2), out: c.c1 });
      }
      return [{ closed: true, nodes }];
    }
    case 'polygon': {
      const pts = [];
      const N = sh.n;
      if (sh.star > 0) {
        for (let i = 0; i < N * 2; i++) {
          const a = -Math.PI / 2 + i * Math.PI / N;
          const r = (i % 2 === 0) ? sh.r : sh.r * (1 - sh.star);
          pts.push({ x: Math.cos(a) * r, y: Math.sin(a) * r });
        }
      } else {
        for (let i = 0; i < N; i++) {
          const a = -Math.PI / 2 + i * 2 * Math.PI / N;
          pts.push({ x: Math.cos(a) * sh.r, y: Math.sin(a) * sh.r });
        }
      }
      return [nodeSub(pts, true)];
    }
    case 'path': return sh.subpaths;
    case 'text': return fontProvider ? fontProvider(sh) : [];
    case 'image': {
      const { w, h } = sh;
      return [nodeSub([{ x: 0, y: 0 }, { x: w, y: 0 }, { x: w, y: h }, { x: 0, y: h }], true)];
    }
    default: return [];
  }
}

/* Subpath -> Polylinie (lokal) */
export function subpathToPoly(sp, tol = 0.02) {
  const out = [];
  const n = sp.nodes;
  if (!n.length) return out;
  out.push({ x: n[0].x, y: n[0].y });
  const cnt = sp.closed ? n.length : n.length - 1;
  for (let i = 0; i < cnt; i++) {
    const a = n[i], b = n[(i + 1) % n.length];
    const c1 = a.out, c2 = b.in;
    if (c1 || c2) {
      flattenCubic({ x: a.x, y: a.y }, c1 || { x: a.x, y: a.y }, c2 || { x: b.x, y: b.y }, { x: b.x, y: b.y }, tol, out);
    } else out.push({ x: b.x, y: b.y });
  }
  return out;
}

/* Welt-Polylinien einer Form (rekursiv für Gruppen) */
export function shapePolys(sh, ctx, parentMat = Mat.id()) {
  const m = Mat.mul(sh.transform, parentMat);
  if (sh.type === 'group') {
    let out = [];
    for (const c of sh.children) out = out.concat(shapePolys(c, ctx, m));
    return out;
  }
  const tol = (ctx && ctx.tol) || 0.02;
  const subs = shapeSubpaths(sh, ctx && ctx.fontProvider);
  const res = [];
  for (const sp of subs) {
    const poly = subpathToPoly(sp, tol).map(p => Mat.apply(m, p));
    if (poly.length >= 2) res.push({ pts: poly, closed: sp.closed, layer: sh.layer, shape: sh });
  }
  return res;
}

export function shapeBBox(sh, ctx, parentMat = Mat.id()) {
  const polys = shapePolys(sh, ctx, parentMat);
  const b = emptyBox();
  for (const p of polys) for (const q of p.pts) growBox(b, q);
  return b;
}
export function shapesBBox(list, ctx) {
  let b = emptyBox();
  for (const s of list) b = mergeBox(b, shapeBBox(s, ctx));
  return b;
}

export function walk(shapes, fn, parentMat = Mat.id()) {
  for (const s of shapes) {
    const m = Mat.mul(s.transform, parentMat);
    fn(s, m);
    if (s.type === 'group') walk(s.children, fn, m);
  }
}
export function findById(shapes, id) {
  let found = null;
  walk(shapes, s => { if (s.id === id) found = s; });
  return found;
}
export function removeShape(shapes, sh) {
  const i = shapes.indexOf(sh);
  if (i >= 0) { shapes.splice(i, 1); return true; }
  for (const s of shapes) if (s.type === 'group' && removeShape(s.children, sh)) return true;
  return false;
}

/* Transformation auf Form anwenden (in Weltkoordinaten) */
export function applyTransform(sh, m) {
  sh.transform = Mat.mul(sh.transform, m);
}

/* Form in Pfad umwandeln (für Node-Editing/Boolean) */
export function toPath(sh, ctx) {
  if (sh.type === 'path') return sh;
  const subs = shapeSubpaths(sh, ctx && ctx.fontProvider);
  const p = Shape.path(JSON.parse(JSON.stringify(subs)), sh.layer);
  p.transform = sh.transform.slice();
  p.name = sh.name;
  return p;
}

/* ---------------- Undo ---------------- */
/* Rückgängig-Verlauf. Jeder Schritt ist eine vollständige Momentaufnahme von Formen und Ebenen,
   gespeichert aber platzsparend: jede Form als JSON-Text in einem gemeinsamen Vorrat (unveränderte
   Formen teilen sich den Eintrag über alle Schritte), große eingebettete Bilder (data:-URLs) noch
   einmal getrennt davon. So lässt sich der Verlauf auch mit dem Projekt speichern (serialize/from). */
// data:-URLs ab 2000 Zeichen werden ausgelagert (ohne Escape-Zeichen – sonst bleiben sie in der Form)
const BLOB_RE = /"(data:[^"\\]{2000,})"/g;
const REF_RE = /"\u0001(\d+)"/g;
export class History {
  constructor(limit = 200) {
    this.stack = []; this.pos = -1; this.limit = limit;
    this.shapes = []; this.shapeIx = new Map();      // Vorrat: JSON je Form
    this.layers = []; this.layerIx = new Map();      // Vorrat: JSON der Ebenenliste
    this.blobs = []; this.blobIx = new Map();        // Vorrat: große data:-URLs
    this.pushes = 0;
  }
  _blob(url) {
    let i = this.blobIx.get(url);
    if (i === undefined) { i = this.blobs.length; this.blobs.push(url); this.blobIx.set(url, i); }
    return i;
  }
  _pool(arr, ix, str) {
    let i = ix.get(str);
    if (i === undefined) { i = arr.length; arr.push(str); ix.set(str, i); }
    return i;
  }
  _shapeId(sh) {
    let str = JSON.stringify(sh);
    if (str.includes('"data:')) str = str.replace(BLOB_RE, (m, url) => '"\u0001' + this._blob(url) + '"');
    return this._pool(this.shapes, this.shapeIx, str);
  }
  push(doc, label) {
    const s = doc.shapes.map(sh => this._shapeId(sh));
    const l = this._pool(this.layers, this.layerIx, JSON.stringify(doc.layers));
    const cur = this.stack[this.pos];
    if (cur && cur.l === l && cur.s.length === s.length && cur.s.every((v, i) => v === s[i])) return;
    this.stack = this.stack.slice(0, this.pos + 1);
    this.stack.push({ s, l, label });
    if (this.stack.length > this.limit) this.stack.shift();
    this.pos = this.stack.length - 1;
    // nicht mehr benutzte Vorratseinträge gelegentlich aufräumen
    if (++this.pushes % 50 === 0) this._gc();
  }
  canUndo() { return this.pos > 0; }
  canRedo() { return this.pos < this.stack.length - 1; }
  undo(doc) { if (!this.canUndo()) return false; this.pos--; this.restore(doc); return true; }
  redo(doc) { if (!this.canRedo()) return false; this.pos++; this.restore(doc); return true; }
  restore(doc) {
    const e = this.stack[this.pos];
    let txt = '{"shapes":[' + e.s.map(i => this.shapes[i]).join(',') + '],"layers":' + this.layers[e.l] + '}';
    if (txt.includes('\u0001')) txt = txt.replace(REF_RE, (m, n) => JSON.stringify(this.blobs[+n]));
    const st = JSON.parse(txt);
    doc.shapes = st.shapes; doc.layers = st.layers;
  }
  // Vorräte auf die noch benutzten Einträge verkleinern (Nummern werden neu vergeben)
  _gc(from = 0) {
    const steps = this.stack.slice(from);
    const sMap = new Map(), lMap = new Map(), shapes = [], layers = [];
    for (const e of steps) {
      for (const i of e.s) if (!sMap.has(i)) { sMap.set(i, shapes.length); shapes.push(this.shapes[i]); }
      if (!lMap.has(e.l)) { lMap.set(e.l, layers.length); layers.push(this.layers[e.l]); }
    }
    const bMap = new Map(), blobs = [];
    const shapes2 = shapes.map(str => str.includes('\u0001') ? str.replace(REF_RE, (m, n) => {
      if (!bMap.has(+n)) { bMap.set(+n, blobs.length); blobs.push(this.blobs[+n]); }
      return '"\u0001' + bMap.get(+n) + '"';
    }) : str);
    this.stack = steps.map(e => ({ s: e.s.map(i => sMap.get(i)), l: lMap.get(e.l), label: e.label }));
    this.pos -= from;
    this.shapes = shapes2; this.layers = layers; this.blobs = blobs;
    this.shapeIx = new Map(shapes2.map((v, i) => [v, i]));
    this.layerIx = new Map(layers.map((v, i) => [v, i]));
    this.blobIx = new Map(blobs.map((v, i) => [v, i]));
  }
  _size(docUrls) {
    let n = 0;
    for (const v of this.shapes) n += v.length;
    for (const v of this.layers) n += v.length;
    for (const v of this.blobs) if (!docUrls.has(v)) n += v.length;
    for (const e of this.stack) n += e.s.length * 4 + 20 + (e.label ? String(e.label).length : 0);
    return n;
  }
  /* Verlauf zum Speichern: höchstens maxSteps Schritte und etwa maxBytes Zeichen; älteste Schritte
     fallen zuerst weg. Bilder, die auch in der aktuellen Zeichnung stecken, werden nicht doppelt
     abgelegt, sondern über ihre Reihenfolge in der Zeichnung gefunden. null = passt nicht. */
  serialize(doc, { maxBytes = 4e6, maxSteps = 100 } = {}) {
    if (this.pos < 0) return null;
    const docUrls = [...new Set((JSON.stringify(doc.shapes).match(BLOB_RE) || []).map(m => m.slice(1, -1)))];
    const docIx = new Map(docUrls.map((u, i) => [u, i]));
    const h = new History(this.limit);
    Object.assign(h, { stack: this.stack.slice(), pos: this.pos, shapes: this.shapes, layers: this.layers, blobs: this.blobs });
    // Schritte nach dem aktuellen (Wiederholen) bleiben, ältere fallen bei Bedarf weg
    let from = Math.max(0, h.stack.length - maxSteps);
    if (from > h.pos) from = h.pos;
    h._gc(from);
    const urls = new Set(docUrls);
    while (h._size(urls) > maxBytes && h.pos > 0) h._gc(Math.max(1, Math.ceil(h.pos / 4)));
    if (h._size(urls) > maxBytes) return null;
    return {
      v: 1, pos: h.pos,
      steps: h.stack.map(e => ({ s: e.s, l: e.l, t: e.label || '' })),
      shapes: h.shapes, layers: h.layers,
      blobs: h.blobs.map(u => docIx.has(u) ? { doc: docIx.get(u) } : u)
    };
  }
  // gespeicherten Verlauf wiederherstellen; passt er nicht zur Zeichnung, kommt sie als neuer Schritt dazu
  static from(data, doc, limit = 200) {
    const h = new History(limit);
    try {
      if (!data || data.v !== 1 || !Array.isArray(data.steps) || !data.steps.length) throw 0;
      const docUrls = [...new Set((JSON.stringify(doc.shapes).match(BLOB_RE) || []).map(m => m.slice(1, -1)))];
      const blobs = data.blobs.map(b => typeof b === 'string' ? b : docUrls[b.doc]);
      if (blobs.some(b => typeof b !== 'string')) throw 0;
      const n = data.shapes.length, m = data.layers.length;
      if (!data.steps.every(e => Array.isArray(e.s) && e.s.every(i => i >= 0 && i < n) && e.l >= 0 && e.l < m)) throw 0;
      Object.assign(h, {
        stack: data.steps.map(e => ({ s: e.s, l: e.l, label: e.t })),
        pos: Math.min(Math.max(0, data.pos | 0), data.steps.length - 1),
        shapes: data.shapes.slice(), layers: data.layers.slice(), blobs
      });
      h.shapeIx = new Map(h.shapes.map((v, i) => [v, i]));
      h.layerIx = new Map(h.layers.map((v, i) => [v, i]));
      h.blobIx = new Map(blobs.map((v, i) => [v, i]));
    } catch (e) { return History.fresh(doc, limit); }
    h.push(doc, 'Start');   // gleicher Stand → nichts passiert
    return h;
  }
  static fresh(doc, limit = 200) { const h = new History(limit); h.push(doc, 'Start'); return h; }
}
