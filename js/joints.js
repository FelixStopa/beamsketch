// joints.js — Fugen an geraden Kanten bestehender Formen: Fingerzinken, Zapfen mit Schlitzen, Kreuzverbindung.
// Kante 1 bekommt Finger bzw. Zapfen (stehen nach außen über), Kante 2 das Gegenstück (Aussparungen bzw. Schlitze).
// Kerf: Material wird um die halbe Schnittfuge breiter, Öffnungen schmaler; Spiel (clearance) wirkt umgekehrt
// (negativ = Presspassung). Die Formen werden dabei zu Pfaden in Weltkoordinaten.
import { Mat, pointInPoly } from './geom.js';
import { Shape, toPath, nodeSub } from './doc.js';

const sub = (a, b) => ({ x: a.x - b.x, y: a.y - b.y });
const len = v => Math.hypot(v.x, v.y);

/* Form als Pfad mit eingerechneter Transformation (Knoten in Weltkoordinaten) */
export function bakePath(sh, ctx) {
  const p = toPath(sh, ctx);
  const m = p.transform;
  const subpaths = p.subpaths.map(sp => ({
    closed: sp.closed,
    nodes: sp.nodes.map(n => ({ x: Mat.apply(m, n).x, y: Mat.apply(m, n).y, in: n.in ? Mat.apply(m, n.in) : null, out: n.out ? Mat.apply(m, n.out) : null }))
  }));
  const out = Shape.path(subpaths, sh.layer);
  out.id = sh.id; out.name = sh.name;
  return out;
}

/* gerade Kanten einer Form (Weltkoordinaten) */
export function edgesOf(sh, ctx) {
  if (!sh || !['path', 'rect', 'polygon'].includes(sh.type)) return [];
  const p = bakePath(sh, ctx), out = [];
  p.subpaths.forEach((sp, si) => {
    const n = sp.nodes.length, m = sp.closed ? n : n - 1;
    for (let i = 0; i < m; i++) {
      const a = sp.nodes[i], b = sp.nodes[(i + 1) % n];
      if (a.out || b.in) continue;           // Kurve
      if (len(sub(b, a)) < 0.5) continue;
      out.push({ shape: sh, si, i, a: { x: a.x, y: a.y }, b: { x: b.x, y: b.y }, closed: sp.closed });
    }
  });
  return out;
}

/* nächste gerade Kante zum Punkt w (innerhalb tol mm) */
export function pickEdge(shapes, w, tol, ctx) {
  let best = null, bd = tol;
  for (const sh of shapes) for (const e of edgesOf(sh, ctx)) {
    const d = sub(e.b, e.a), l2 = d.x * d.x + d.y * d.y;
    const t = Math.max(0, Math.min(1, ((w.x - e.a.x) * d.x + (w.y - e.a.y) * d.y) / l2));
    const dist = Math.hypot(w.x - (e.a.x + t * d.x), w.y - (e.a.y + t * d.y));
    if (dist < bd) { bd = dist; best = e; }
  }
  return best;
}

/* Normale, die aus dem Material der Form zeigt (bei offenen Linien: links der Richtung) */
function outward(path, e) {
  const d = sub(e.b, e.a), L = len(d);
  const n = { x: d.y / L, y: -d.x / L };
  if (!e.closed) return n;
  const mid = { x: (e.a.x + e.b.x) / 2 + n.x * 0.05, y: (e.a.y + e.b.y) / 2 + n.y * 0.05 };
  const polys = path.subpaths.filter(sp => sp.closed).map(sp => sp.nodes);
  const inside = polys.reduce((c, p) => c + (pointInPoly(mid, p) ? 1 : 0), 0) % 2 === 1;
  return inside ? { x: -n.x, y: -n.y } : n;
}

/* Breite der Form senkrecht zur Kante (für die Tiefe von Kreuzschlitzen) */
function depthOf(path, e, nIn) {
  let d = 0;
  for (const sp of path.subpaths) for (const p of sp.nodes) d = Math.max(d, (p.x - e.a.x) * nIn.x + (p.y - e.a.y) * nIn.y);
  return d;
}

/* Kante (si, i) im Pfad durch Zwischenpunkte ersetzen (zwischen a und b) */
function replaceEdge(path, e, mids) {
  const sp = path.subpaths[e.si];
  const ins = mids.map(p => ({ x: p.x, y: p.y, in: null, out: null }));
  sp.nodes.splice(e.i + 1, 0, ...ins);
}

/* Punkte entlang der Kante: (s = Abstand ab a, h = Höhe in Richtung n) */
const at = (e, n, s, hgt) => {
  const d = sub(e.b, e.a), L = len(d), u = { x: d.x / L, y: d.y / L };
  return { x: e.a.x + u.x * s + n.x * hgt, y: e.a.y + u.y * s + n.y * hgt };
};

/* Rechteck-Muster entlang einer Kante: intervals = [[s0, s1], …] mit Höhe hgt in Richtung n */
function notchPoints(e, n, intervals, hgt, L) {
  const pts = [];
  for (const [s0, s1] of intervals) {
    const a = Math.max(0, s0), b = Math.min(L, s1);
    if (b - a < 1e-6) continue;
    if (a > 1e-9) pts.push(at(e, n, a, 0));
    pts.push(at(e, n, a, hgt), at(e, n, b, hgt));
    if (b < L - 1e-9) pts.push(at(e, n, b, 0));
  }
  return pts;
}

export const JOINT_DEFAULTS = { type: 'finger', t: 3, finger: 10, kerf: 0.1, clearance: 0, tabs: 2, tabW: 10, inset: 0, slots: 1, depth: 50 };

/* Fuge anlegen. e1, e2 aus pickEdge (dürfen zu derselben Form gehören).
   Gibt { shapes: [geänderte/neue Formen], remove: [zu entfernende Formen], info } zurück. */
export function makeJoint(e1, e2, cfg, ctx) {
  cfg = { ...JOINT_DEFAULTS, ...cfg };
  const same = e1.shape === e2.shape;
  const p1 = bakePath(e1.shape, ctx), p2 = same ? p1 : bakePath(e2.shape, ctx);
  const L1 = len(sub(e1.b, e1.a)), L2 = len(sub(e2.b, e2.a));
  const n1 = outward(p1, e1), n2 = outward(p2, e2), in2 = { x: -n2.x, y: -n2.y };
  const k = cfg.kerf / 2, c = cfg.clearance / 2;
  const res = { shapes: [p1], remove: [], info: {} };
  if (!same) res.shapes.push(p2);
  // Kanten im selben Pfad: die spätere zuerst ersetzen, damit die Indizes der früheren stimmen
  const order = (a, b) => (same && a.e.si === b.e.si && a.e.i < b.e.i) ? [b, a] : [a, b];

  if (cfg.type === 'finger') {
    let N = Math.max(3, Math.round(L1 / Math.max(1, cfg.finger)));
    if (N % 2 === 0) N++;
    const s = L1 / N, off = (L2 - L1) / 2;
    // Finger auf Kante 1 (gerade Abschnitte), Aussparungen auf Kante 2 an denselben Stellen
    const fingers = [], notches = [];
    for (let i = 0; i < N; i += 2) {
      const a = i * s, b = (i + 1) * s;
      fingers.push([i ? a - k + c : a, i < N - 1 ? b + k - c : b]);
      notches.push([off + (i ? a + k - c : a - 1), off + (i < N - 1 ? b - k + c : b + 1)]);
    }
    const jobs = order({ e: e1, path: p1, pts: notchPoints(e1, n1, fingers, cfg.t, L1) }, { e: e2, path: p2, pts: notchPoints(e2, in2, notches, cfg.t, L2) });
    // Kante 2 läuft beim Zusammenstecken gegenläufig: Muster ist symmetrisch (N ungerade)
    for (const j of jobs) replaceEdge(j.path, j.e, j.pts);
    res.info = { count: N, width: s, mismatch: Math.abs(L1 - L2) };
    return res;
  }

  if (cfg.type === 'tab') {
    const n = Math.max(1, Math.round(cfg.tabs)), w = Math.min(cfg.tabW, L1 / n * 0.8);
    const centers = Array.from({ length: n }, (_, i) => (i + 0.5) * L1 / n);
    replaceEdge(p1, e1, notchPoints(e1, n1, centers.map(m => [m - w / 2 - k + c, m + w / 2 + k - c]), cfg.t, L1));
    // Schlitze: Rechtecke auf Kante 2 (bei geschlossenen Formen um „inset" nach innen versetzt)
    const off = (L2 - L1) / 2, depth = e2.closed ? Math.max(cfg.inset, cfg.t) : 0;
    const sw = w - 2 * k + 2 * c, st = cfg.t - 2 * k + 2 * c;
    const slots = centers.map(m => {
      const mm = off + m;
      return [at(e2, in2, mm - sw / 2, depth - st / 2), at(e2, in2, mm + sw / 2, depth - st / 2), at(e2, in2, mm + sw / 2, depth + st / 2), at(e2, in2, mm - sw / 2, depth + st / 2)];
    });
    if (e2.closed) {
      for (const s of slots) p2.subpaths.push(nodeSub(s, true));
    } else {
      // einzelne Linie: wird durch die Schlitze ersetzt
      const slotShape = Shape.path(slots.map(s => nodeSub(s, true)), e2.shape.layer);
      if (p2.subpaths.length === 1) { res.remove.push(e2.shape); res.shapes = res.shapes.filter(s => s !== p2); }
      res.shapes.push(slotShape);
    }
    res.info = { count: n, mismatch: Math.abs(L1 - L2) };
    return res;
  }

  if (cfg.type === 'cross') {
    // Kreuzverbindung: beide Kanten bekommen Schlitze in Materialstärke; Tiefe = Anteil der Plattenbreite
    const n = Math.max(1, Math.round(cfg.slots));
    const sw = cfg.t - 2 * k + 2 * c;
    const d1 = depthOf(p1, e1, { x: -n1.x, y: -n1.y }) * cfg.depth / 100;
    const d2 = depthOf(p2, e2, in2) * (100 - cfg.depth) / 100;
    const mk = (e, nIn, L, d) => notchPoints(e, nIn, Array.from({ length: n }, (_, i) => { const m = (i + 1) * L / (n + 1); return [m - sw / 2, m + sw / 2]; }), d, L);
    const jobs = order({ e: e1, path: p1, pts: mk(e1, { x: -n1.x, y: -n1.y }, L1, d1) }, { e: e2, path: p2, pts: mk(e2, in2, L2, d2) });
    for (const j of jobs) replaceEdge(j.path, j.e, j.pts);
    res.info = { count: n, depth1: d1, depth2: d2, mismatch: Math.abs(L1 - L2) };
    return res;
  }
  throw new Error('Fugentyp');
}
