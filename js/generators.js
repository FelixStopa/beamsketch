// generators.js — Geometrie-Generatoren: Box mit Fingerzinken, Flexscharnier.
// Alle Maße in mm, y nach oben (Dokument-Koordinaten). Rückgabe: Teile mit
// geschlossenen Polygonen (outline + holes) bzw. offenen Linien.
import { polyArea, cleanPoly } from './geom.js';

/* Rechtwinkliges Polygon um d nach außen versetzen (Gehrung).
   Reicht für Zinken-Umrisse, bei denen jede Ecke 90° hat. */
function offsetOrtho(poly, d) {
  const p = cleanPoly(poly);
  const n = p.length, s = polyArea(p) > 0 ? 1 : -1;   // CCW → Außennormale rechts der Kante
  const nrm = (a, b) => { const dx = b.x - a.x, dy = b.y - a.y, l = Math.hypot(dx, dy) || 1; return { x: s * dy / l, y: -s * dx / l }; };
  return p.map((q, i) => {
    const a = nrm(p[(i - 1 + n) % n], q), b = nrm(q, p[(i + 1) % n]);
    return { x: q.x + (a.x + b.x) * d, y: q.y + (a.y + b.y) * d };
  });
}

/* Anzahl Finger: ungerade, damit beide Enden gleich sind */
function fingerCount(L, fw) {
  let n = Math.max(3, Math.floor(L / fw));
  if (n % 2 === 0) n--;
  return n;
}

/* Umriss einer Platte W×H mit vier Kantenprofilen.
   edges: [unten, rechts, oben, links], jeweils { type: 'out'|'in'|'flat', n }
   'out' = Zinken an den Ecken, 'in' = Aussparungen an den Ecken. Tiefe t. */
function panelOutline(W, H, edges, t) {
  const E = [
    { C: { x: 0, y: 0 }, dir: { x: 1, y: 0 }, nrm: { x: 0, y: 1 }, L: W },
    { C: { x: W, y: 0 }, dir: { x: 0, y: 1 }, nrm: { x: -1, y: 0 }, L: H },
    { C: { x: W, y: H }, dir: { x: -1, y: 0 }, nrm: { x: 0, y: -1 }, L: W },
    { C: { x: 0, y: H }, dir: { x: 0, y: -1 }, nrm: { x: 1, y: 0 }, L: H }
  ];
  const segs = edges.map((e, i) => {
    const L = E[i].L;
    if (e.type === 'flat') return [{ u0: 0, u1: L, d: 0 }];
    const n = e.n, s = L / n;
    return Array.from({ length: n }, (_, k) => ({ u0: k * s, u1: (k + 1) * s, d: (e.type === 'out' ? k % 2 : 1 - k % 2) ? t : 0 }));
  });
  const pts = [];
  for (let i = 0; i < 4; i++) {
    const e = E[i], sg = segs[i];
    const prevD = segs[(i + 3) % 4].slice(-1)[0].d, nextD = segs[(i + 1) % 4][0].d;
    sg.forEach((g, k) => {
      const u0 = k === 0 ? prevD : g.u0, u1 = k === sg.length - 1 ? e.L - nextD : g.u1;
      for (const u of [u0, u1]) pts.push({ x: e.C.x + e.dir.x * u + e.nrm.x * g.d, y: e.C.y + e.dir.y * u + e.nrm.y * g.d });
    });
  }
  return cleanPoly(pts);
}

/* Box mit Fingerzinken.
   cfg: { w, d, h, t, finger, kerf, inner:bool, lid:'open'|'closed', dividers:int } */
export function boxParts(cfg) {
  const t = cfg.t;
  let W = cfg.w, D = cfg.d, H = cfg.h;
  const closed = cfg.lid === 'closed';
  if (cfg.inner) { W += 2 * t; D += 2 * t; H += closed ? 2 * t : t; }
  const nW = fingerCount(W, cfg.finger), nD = fingerCount(D, cfg.finger), nH = fingerCount(H, cfg.finger);
  const top = closed ? 'out' : 'flat';
  // Trennwände: stehen quer (parallel zu den Seiten), mit Zinken nach unten in Schlitze im Boden
  const nDiv = Math.max(0, cfg.dividers | 0);
  const dvL = D - 2 * t, dvH = H - t - (closed ? t : 0);
  const nDv = fingerCount(dvL, cfg.finger);
  const parts = [];
  const add = (name, w, h, edges, holes = []) => parts.push({ name, w, h, outline: panelOutline(w, h, edges, t), holes });
  add('Boden', W, D, [{ type: 'in', n: nW }, { type: 'in', n: nD }, { type: 'in', n: nW }, { type: 'in', n: nD }], dividerSlots());
  if (closed) add('Deckel', W, D, [{ type: 'in', n: nW }, { type: 'in', n: nD }, { type: 'in', n: nW }, { type: 'in', n: nD }]);
  for (const nm of ['Vorderseite', 'Rückseite'])
    add(nm, W, H, [{ type: 'out', n: nW }, { type: 'out', n: nH }, { type: top, n: nW }, { type: 'out', n: nH }]);
  for (const nm of ['Linke Seite', 'Rechte Seite'])
    add(nm, D, H, [{ type: 'out', n: nD }, { type: 'in', n: nH }, { type: top, n: nD }, { type: 'in', n: nH }]);
  for (let i = 0; i < nDiv; i++)
    add('Trennwand', dvL, dvH, [{ type: 'out', n: nDv }, { type: 'flat' }, { type: 'flat' }, { type: 'flat' }]);

  function dividerSlots() {
    // Schlitze an den Stellen, an denen die Zinken der Trennwände sitzen
    const holes = [], s = dvL / nDv;
    for (let i = 1; i <= nDiv; i++) {
      const x = W * i / (nDiv + 1) - t / 2;
      for (let k = 0; k < nDv; k += 2) {
        const y0 = t + k * s, y1 = y0 + s;
        holes.push([{ x, y: y0 }, { x: x + t, y: y0 }, { x: x + t, y: y1 }, { x, y: y1 }]);
      }
    }
    return holes;
  }
  // Kerf: Umriss um kerf/2 vergrößern, Löcher um kerf/2 verkleinern → passgenaue Zinken
  const k = (cfg.kerf || 0) / 2;
  for (const p of parts) {
    if (k) { p.outline = offsetOrtho(p.outline, k); p.holes = p.holes.map(hh => offsetOrtho(hh, -k)); }
  }
  return { parts, outer: { w: W, d: D, h: H } };
}

/* Flexscharnier: versetzte Schlitzreihen in einem Feld w×h.
   cfg: { w, h, spacing (Abstand der Reihen), cut (Schlitzlänge), bridge (Steg), frame:bool } */
export function hingeLines(cfg) {
  const { w, h, spacing, bridge } = cfg;
  const lines = [];
  const cols = Math.max(1, Math.floor(w / spacing));
  const x0 = (w - (cols - 1) * spacing) / 2;
  const cut = Math.max(bridge, cfg.cut);
  for (let c = 0; c < cols; c++) {
    const x = x0 + c * spacing;
    // gerade Reihen beginnen am Rand (offen nach außen), ungerade sind um eine halbe Periode versetzt
    const period = cut + bridge;
    let y = c % 2 ? bridge : -cut / 2;
    for (; y < h; y += period) {
      const a = Math.max(0, y), b = Math.min(h, y + cut);
      if (b - a > bridge * 0.5) lines.push([{ x, y: a }, { x, y: b }]);
    }
  }
  return lines;
}
