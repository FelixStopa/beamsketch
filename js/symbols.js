import { storage } from './storage.js';
// symbols.js — Symbol-Bibliothek: fertige Vektorformen zum Einfügen und eigene Symbole.
// Alle Symbole liegen in einem 100×100-Raster (y nach unten, wie SVG).
// Einfache Symbole sind ein SVG-Pfad (Kurven bleiben erhalten); zusammengesetzte
// werden beim Einfügen per Boolescher Operation zu einer schneidbaren Kontur verschmolzen:
//   { u: [teil, teil, …] }  Vereinigung      { s: [basis, minus, …] }  Differenz
import { boolOp, flattenCubic, ensureCCW, polyArea } from './geom.js';
import { parsePathData } from './svg.js';
import { Shape, nodeSub } from './doc.js';
import { loc } from './i18n.js';

/* ---------- Bausteine ---------- */
const f = n => +n.toFixed(2);
const P = pts => 'M' + pts.map(p => f(p[0]) + ' ' + f(p[1])).join(' L') + ' Z';
const circ = (cx, cy, r) => `M${f(cx - r)} ${f(cy)} A${r} ${r} 0 1 0 ${f(cx + r)} ${f(cy)} A${r} ${r} 0 1 0 ${f(cx - r)} ${f(cy)} Z`;
const ell = (cx, cy, rx, ry, rot = 0) => P(Array.from({ length: 48 }, (_, i) => {
  const a = i / 48 * 2 * Math.PI, c = Math.cos(rot * Math.PI / 180), s = Math.sin(rot * Math.PI / 180);
  const x = Math.cos(a) * rx, y = Math.sin(a) * ry;
  return [cx + x * c - y * s, cy + x * s + y * c];
}));
const rect = (x, y, w, h) => P([[x, y], [x + w, y], [x + w, y + h], [x, y + h]]);
const rrect = (x, y, w, h, r) => {
  const k = r * 0.5523;
  return `M${x + r} ${y} L${x + w - r} ${y} C${x + w - r + k} ${y} ${x + w} ${y + r - k} ${x + w} ${y + r} L${x + w} ${y + h - r} ` +
    `C${x + w} ${y + h - r + k} ${x + w - r + k} ${y + h} ${x + w - r} ${y + h} L${x + r} ${y + h} C${x + r - k} ${y + h} ${x} ${y + h - r + k} ${x} ${y + h - r} ` +
    `L${x} ${y + r} C${x} ${y + r - k} ${x + r - k} ${y} ${x + r} ${y} Z`;
};
const ngon = (n, r, cx = 50, cy = 50, rot = -90) => P(Array.from({ length: n }, (_, i) => {
  const a = (rot + i * 360 / n) * Math.PI / 180; return [cx + Math.cos(a) * r, cy + Math.sin(a) * r];
}));
const star = (n, R, r, cx = 50, cy = 50, rot = -90) => P(Array.from({ length: n * 2 }, (_, i) => {
  const a = (rot + i * 180 / n) * Math.PI / 180, q = i % 2 ? r : R; return [cx + Math.cos(a) * q, cy + Math.sin(a) * q];
}));
/* Punkte um (cx,cy) drehen */
const rot = (pts, deg, cx = 50, cy = 50) => pts.map(([x, y]) => {
  const a = deg * Math.PI / 180, c = Math.cos(a), s = Math.sin(a);
  return [cx + (x - cx) * c - (y - cy) * s, cy + (x - cx) * s + (y - cy) * c];
});
/* Kreis mit welligem Rand (Wellen-/Bogenrahmen) */
const scallop = (n, r, amp, cx = 50, cy = 50) => P(Array.from({ length: n * 16 }, (_, i) => {
  const a = i / (n * 16) * 2 * Math.PI, q = r + amp * Math.abs(Math.sin(a * n / 2));
  return [cx + Math.cos(a) * q, cy + Math.sin(a) * q];
}));
const gear = (teeth, R, r, hole) => {
  const pts = [], k = teeth * 4;
  for (let i = 0; i < k; i++) {
    const a = i / k * 2 * Math.PI, up = (i % 4 === 1 || i % 4 === 2);
    const q = up ? R : r; pts.push([50 + Math.cos(a) * q, 50 + Math.sin(a) * q]);
  }
  return { s: [P(pts), circ(50, 50, hole)] };
};
const ARROW = [[5, 38], [58, 38], [58, 16], [95, 50], [58, 84], [58, 62], [5, 62]];
const HEART = 'M50 90 C20 67 5 50 5 31 C5 16 16 6 29 6 C39 6 46 12 50 21 C54 12 61 6 71 6 C84 6 95 16 95 31 C95 50 80 67 50 90 Z';
const heartAt = (s, dx = 0, dy = 0) => HEART.replace(/([\d.]+) ([\d.]+)/g,
  (m, x, y) => f(50 + (x - 50) * s + dx) + ' ' + f(50 + (y - 50) * s + dy));
const petals = (n, len, w) => ({ u: Array.from({ length: n }, (_, i) => ell(50 + Math.cos(i * 2 * Math.PI / n - Math.PI / 2) * len / 2,
  50 + Math.sin(i * 2 * Math.PI / n - Math.PI / 2) * len / 2, len / 2, w / 2, i * 360 / n - 90)) });

/* ---------- Kategorien und Symbole ---------- */
export const SYMBOL_CATS = [
  ['basic', 'Grundformen'], ['hearts', 'Herzen & Liebe'], ['stars', 'Sterne'], ['arrows', 'Pfeile & Zeichen'],
  ['frames', 'Rahmen & Banner'], ['nature', 'Natur & Wetter'], ['animals', 'Tiere'], ['holiday', 'Feiertage'],
  ['misc', 'Werkstatt & Alltag']
];

export const SYMBOLS = [
  // Grundformen
  ['basic', 'Quadrat', rect(10, 10, 80, 80)],
  ['basic', 'Rechteck', rect(5, 25, 90, 50)],
  ['basic', 'Abgerundetes Quadrat', rrect(10, 10, 80, 80, 16)],
  ['basic', 'Kreis', circ(50, 50, 45)],
  ['basic', 'Oval', ell(50, 50, 45, 30)],
  ['basic', 'Ring', { s: [circ(50, 50, 45), circ(50, 50, 30)] }],
  ['basic', 'Dreieck', ngon(3, 50, 50, 58)],
  ['basic', 'Rechtwinkliges Dreieck', P([[10, 90], [10, 10], [90, 90]])],
  ['basic', 'Fünfeck', ngon(5, 46)],
  ['basic', 'Sechseck', ngon(6, 46, 50, 50, 0)],
  ['basic', 'Achteck', ngon(8, 46, 50, 50, 22.5)],
  ['basic', 'Raute', P([[50, 5], [85, 50], [50, 95], [15, 50]])],
  ['basic', 'Parallelogramm', P([[25, 25], [95, 25], [75, 75], [5, 75]])],
  ['basic', 'Trapez', P([[25, 25], [75, 25], [95, 75], [5, 75]])],
  ['basic', 'Halbkreis', 'M5 70 A45 45 0 0 1 95 70 Z'],
  ['basic', 'Viertelkreis', 'M10 90 L10 10 A80 80 0 0 1 90 90 Z'],
  // Herzen & Liebe
  ['hearts', 'Herz', HEART],
  ['hearts', 'Herz-Umriss', { s: [HEART, heartAt(0.72, 0, -2)] }],
  ['hearts', 'Zwei Herzen', { u: [heartAt(0.62, -17, -8), heartAt(0.62, 17, 12)] }],
  ['hearts', 'Herz mit Loch', { s: [HEART, circ(50, 22, 5)] }],
  ['hearts', 'Unendlich', { s: [{ u: [ell(30, 50, 26, 20), ell(70, 50, 26, 20)] }, ell(28, 50, 14, 9), ell(72, 50, 14, 9)] }],
  ['hearts', 'Ring (Hochzeit)', { u: [{ s: [circ(50, 60, 34), circ(50, 60, 26)] }, P([[38, 26], [62, 26], [70, 16], [50, 4], [30, 16]])] }],
  // Sterne
  ['stars', 'Stern', star(5, 48, 20, 50, 54)],
  ['stars', 'Stern-Umriss', { s: [star(5, 48, 20, 50, 54), star(5, 34, 14, 50, 54)] }],
  ['stars', 'Vierzackiger Stern', star(4, 48, 14)],
  ['stars', 'Sechszackiger Stern', star(6, 46, 26)],
  ['stars', 'Achtzackiger Stern', star(8, 47, 24)],
  ['stars', 'Funkeln', 'M50 3 C54 38 62 46 97 50 C62 54 54 62 50 97 C46 62 38 54 3 50 C38 46 46 38 50 3 Z'],
  ['stars', 'Stern im Kreis', { s: [circ(50, 50, 46), star(5, 36, 15, 50, 53)] }],
  ['stars', 'Sternschnuppe', { u: [star(5, 26, 11, 70, 32), P([[8, 86], [55, 36], [62, 44], [14, 92]])] }],
  // Pfeile & Zeichen
  ['arrows', 'Pfeil rechts', P(ARROW)],
  ['arrows', 'Pfeil links', P(rot(ARROW, 180))],
  ['arrows', 'Pfeil hoch', P(rot(ARROW, -90))],
  ['arrows', 'Pfeil runter', P(rot(ARROW, 90))],
  ['arrows', 'Doppelpfeil', P([[3, 50], [28, 22], [28, 40], [72, 40], [72, 22], [97, 50], [72, 78], [72, 60], [28, 60], [28, 78]])],
  ['arrows', 'Winkel', P([[25, 8], [47, 8], [85, 50], [47, 92], [25, 92], [63, 50]])],
  ['arrows', 'Doppelwinkel', { u: [P([[5, 10], [25, 10], [55, 50], [25, 90], [5, 90], [35, 50]]), P([[45, 10], [65, 10], [95, 50], [65, 90], [45, 90], [75, 50]])] }],
  ['arrows', 'Haken', P([[8, 52], [22, 38], [40, 56], [80, 14], [94, 28], [40, 84]])],
  ['arrows', 'Kreuz (X)', P(rot([[38, 5], [62, 5], [62, 38], [95, 38], [95, 62], [62, 62], [62, 95], [38, 95], [38, 62], [5, 62], [5, 38], [38, 38]], 45))],
  ['arrows', 'Plus', P([[38, 5], [62, 5], [62, 38], [95, 38], [95, 62], [62, 62], [62, 95], [38, 95], [38, 62], [5, 62], [5, 38], [38, 38]])],
  ['arrows', 'Warnschild', { s: [P([[50, 5], [96, 88], [4, 88]]), rrect(45, 32, 10, 32, 4), circ(50, 75, 6)] }],
  ['arrows', 'Ortsmarke', { s: [{ u: [circ(50, 36, 30), P([[24, 50], [76, 50], [50, 96]])] }, circ(50, 36, 12)] }],
  ['arrows', 'Blitz', P([[58, 3], [18, 56], [45, 56], [36, 97], [82, 40], [55, 40], [67, 3]])],
  // Rahmen & Banner
  ['frames', 'Rechteckrahmen', { s: [rect(5, 15, 90, 70), rect(13, 23, 74, 54)] }],
  ['frames', 'Abgerundeter Rahmen', { s: [rrect(5, 15, 90, 70, 14), rrect(13, 23, 74, 54, 8)] }],
  ['frames', 'Runder Rahmen', { s: [circ(50, 50, 46), circ(50, 50, 38)] }],
  ['frames', 'Ovaler Rahmen', { s: [ell(50, 50, 46, 34), ell(50, 50, 38, 26)] }],
  ['frames', 'Wellenrahmen', { s: [scallop(16, 42, 6), circ(50, 50, 34)] }],
  ['frames', 'Welliger Kreis', scallop(16, 42, 6)],
  ['frames', 'Banner', P([[3, 32], [97, 32], [85, 50], [97, 68], [3, 68], [15, 50]])],
  ['frames', 'Schleifenband', { u: [P([[18, 30], [82, 30], [82, 62], [18, 62]]), P([[2, 42], [20, 42], [20, 74], [2, 74], [10, 58]]), P([[98, 42], [80, 42], [80, 74], [98, 74], [90, 58]])] }],
  ['frames', 'Anhänger', { s: [P([[22, 20], [92, 20], [92, 80], [22, 80], [4, 50]]), circ(22, 50, 6)] }],
  ['frames', 'Etikett', P([[20, 22], [80, 22], [96, 50], [80, 78], [20, 78], [4, 50]])],
  ['frames', 'Siegel', star(24, 48, 41)],
  ['frames', 'Sprechblase', { u: [rrect(5, 8, 90, 62, 16), P([[22, 60], [42, 60], [18, 92]])] }],
  ['frames', 'Wappen', 'M50 5 L88 18 C88 55 75 80 50 95 C25 80 12 55 12 18 Z'],
  // Natur & Wetter
  ['nature', 'Blatt', 'M12 88 C12 42 40 10 92 8 C90 60 62 88 12 88 Z'],
  ['nature', 'Tropfen', 'M50 4 C50 4 18 42 18 63 C18 81 32 95 50 95 C68 95 82 81 82 63 C82 42 50 4 50 4 Z'],
  ['nature', 'Blume', { s: [petals(6, 46, 26), circ(50, 50, 9)] }],
  ['nature', 'Gänseblümchen', { s: [petals(12, 46, 13), circ(50, 50, 11)] }],
  ['nature', 'Sonne', { u: [circ(50, 50, 24), star(12, 48, 26)] }],
  ['nature', 'Wolke', { u: [circ(30, 60, 18), circ(52, 44, 24), circ(73, 58, 18), rrect(14, 52, 72, 26, 13)] }],
  ['nature', 'Mond', { s: [circ(46, 50, 42), circ(66, 38, 36)] }],
  ['nature', 'Schneeflocke', { u: [0, 60, 120].map(a => P(rot([[46, 5], [54, 5], [54, 95], [46, 95]], a))).concat(
    [0, 60, 120, 180, 240, 300].map(a => P(rot([[50, 22], [64, 10], [69, 15], [50, 34], [31, 15], [36, 10]], a)))) }],
  ['nature', 'Tanne', { u: [P([[50, 4], [78, 38], [22, 38]]), P([[50, 22], [84, 62], [16, 62]]), P([[50, 42], [92, 84], [8, 84]]), rect(43, 82, 14, 14)] }],
  ['nature', 'Laubbaum', { u: [circ(50, 36, 30), circ(30, 48, 20), circ(70, 48, 20), rect(44, 60, 12, 36)] }],
  ['nature', 'Berge', P([[2, 88], [34, 30], [50, 52], [66, 18], [98, 88]])],
  ['nature', 'Welle', P([...Array.from({ length: 41 }, (_, i) => [5 + i * 90 / 40, 45 + 12 * Math.sin(i / 40 * 4 * Math.PI)]),
    ...Array.from({ length: 41 }, (_, i) => [95 - i * 90 / 40, 65 + 12 * Math.sin((40 - i) / 40 * 4 * Math.PI)])])],
  ['nature', 'Kaktus', { u: [rrect(40, 10, 20, 86, 10), rrect(14, 30, 14, 36, 7), rrect(72, 22, 14, 34, 7), rect(20, 56, 24, 10), rect(56, 46, 24, 10)] }],
  // Tiere
  ['animals', 'Pfote', { u: [ell(50, 68, 22, 18), ell(22, 44, 9, 12, -20), ell(40, 28, 9, 12, -5), ell(60, 28, 9, 12, 5), ell(78, 44, 9, 12, 20)] }],
  ['animals', 'Fisch', { s: [{ u: [ell(42, 50, 34, 22), P([[66, 50], [96, 26], [96, 74]])] }, circ(24, 45, 4)] }],
  ['animals', 'Katze', { u: [circ(50, 56, 34), P([[20, 44], [18, 8], [44, 26]]), P([[80, 44], [82, 8], [56, 26]])] }],
  ['animals', 'Schmetterling', { u: [ell(32, 34, 22, 18, -25), ell(68, 34, 22, 18, 25), ell(36, 66, 15, 13, 25), ell(64, 66, 15, 13, -25), ell(50, 50, 5, 30)] }],
  ['animals', 'Hase', { u: [circ(50, 66, 28), ell(38, 24, 9, 24, -10), ell(62, 24, 9, 24, 10)] }],
  ['animals', 'Vogel', { u: [ell(46, 58, 32, 20, -10), circ(72, 36, 14), P([[84, 34], [98, 40], [84, 42]]), P([[18, 60], [2, 42], [8, 66]])] }],
  ['animals', 'Schnecke', { s: [{ u: [circ(58, 50, 30), rrect(8, 70, 84, 14, 7), rrect(8, 52, 10, 24, 5)] }, { s: [circ(58, 50, 20), circ(58, 50, 13)] }, circ(58, 50, 5)] }],
  // Feiertage
  ['holiday', 'Weihnachtsbaum', { u: [star(5, 10, 4, 50, 11), P([[50, 14], [76, 42], [24, 42]]), P([[50, 30], [84, 64], [16, 64]]), P([[50, 48], [92, 86], [8, 86]]), rect(44, 84, 12, 12)] }],
  ['holiday', 'Christbaumkugel', { s: [{ u: [circ(50, 58, 36), rect(40, 14, 20, 12), circ(50, 10, 7)] }, circ(50, 10, 3)] }],
  ['holiday', 'Geschenk', { u: [rect(14, 44, 72, 50), rect(8, 30, 84, 16), ell(38, 22, 13, 8, 20), ell(62, 22, 13, 8, -20)] }],
  ['holiday', 'Glocke', { u: ['M50 8 C30 8 22 25 22 45 C22 62 18 70 8 78 L92 78 C82 70 78 62 78 45 C78 25 70 8 50 8 Z', circ(50, 84, 9)] }],
  ['holiday', 'Kürbis', { u: [ell(36, 60, 22, 30), ell(64, 60, 22, 30), ell(50, 60, 22, 32), rect(46, 18, 8, 16)] }],
  ['holiday', 'Osterei', 'M50 5 C75 5 88 45 88 62 C88 82 71 95 50 95 C29 95 12 82 12 62 C12 45 25 5 50 5 Z'],
  ['holiday', 'Zuckerstange', { u: [rect(52, 38, 14, 58), { s: [circ(40, 38, 26), circ(40, 38, 12), rect(10, 38, 60, 30)] }] }],
  ['holiday', 'Kerze', { u: [rrect(34, 40, 32, 56, 4), 'M50 8 C58 20 60 28 50 36 C40 28 42 20 50 8 Z'] }],
  // Werkstatt & Alltag
  ['misc', 'Zahnrad', gear(12, 47, 38, 12)],
  ['misc', 'Haus', { s: [P([[50, 6], [94, 46], [80, 46], [80, 94], [20, 94], [20, 46], [6, 46]]), rect(42, 66, 16, 30)] }],
  ['misc', 'Schlüssel', { s: [{ u: [circ(26, 50, 20), rect(42, 45, 52, 10), rect(78, 52, 7, 16), rect(64, 52, 7, 12)] }, circ(26, 50, 8)] }],
  ['misc', 'Krone', P([[10, 82], [10, 28], [30, 54], [50, 18], [70, 54], [90, 28], [90, 82]])],
  ['misc', 'Diamant', P([[26, 14], [74, 14], [95, 40], [50, 92], [5, 40]])],
  ['misc', 'Musiknote', { u: [ell(34, 78, 16, 11, -20), rect(44, 12, 7, 66), P([[44, 12], [80, 24], [80, 40], [51, 30]])] }],
  ['misc', 'Glühbirne', { u: [circ(50, 40, 32), rrect(36, 64, 28, 30, 6)] }],
  ['misc', 'Hammer', { u: [rrect(44, 30, 12, 66, 5), P([[16, 10], [84, 10], [84, 32], [16, 32], [6, 21]])] }],
  ['misc', 'Schraubenschlüssel', { u: [{ s: [circ(26, 26, 22), rect(18, 2, 16, 26)] }, P(rot([[38, 28], [48, 28], [48, 100], [38, 100]], -45, 43, 43))] }],
  ['misc', 'Puzzleteil', { s: [{ u: [rect(18, 18, 64, 64), circ(88, 50, 11), circ(50, 12, 11)] }, circ(18, 50, 11), circ(50, 88, 11)] }],
  ['misc', 'Smiley', { s: [circ(50, 50, 46), ell(35, 38, 6, 8), ell(65, 38, 6, 8), { s: [ell(50, 60, 26, 20), ell(50, 50, 30, 16)] }] }],
  ['misc', 'Sechseck-Waben', { u: [ngon(6, 22, 28, 30, 0), ngon(6, 22, 72, 30, 0), ngon(6, 22, 50, 68, 0)] }],
  ['misc', 'Tasse', { u: [rrect(12, 20, 56, 70, 8), { s: [ell(72, 52, 20, 18), ell(72, 52, 11, 9), rect(52, 30, 12, 44)] }] }]
].map(([cat, name, def], i) => ({ id: 'b' + i, cat, name, def }));

/* ---------- Geometrie ---------- */
/* Pfad-String → geschlossene Polygone (y nach unten) */
function flattenD(d) {
  const out = [];
  for (const sp of parsePathData(d)) {
    const ns = sp.nodes; if (ns.length < 2) continue;
    const pts = [{ x: ns[0].x, y: ns[0].y }];
    const n = ns.length;
    for (let i = 1; i <= n; i++) {
      const a = ns[i - 1], b = ns[i % n];
      if (i === n && !sp.closed) break;
      if (a.out || b.in) flattenCubic(a, a.out || a, b.in || b, b, 0.02, pts); else pts.push({ x: b.x, y: b.y });
    }
    if (pts.length >= 3) out.push(ensureCCW(pts));
  }
  return out;
}
export function symbolPolys(def) {
  if (typeof def === 'string') return flattenD(def);
  if (def.polys) return def.polys.map(p => p.map(([x, y]) => ({ x, y })));
  const parts = (def.u || def.s).map(symbolPolys);
  let acc = parts[0];
  for (let i = 1; i < parts.length; i++) acc = boolOp(acc, parts[i], def.u ? 'union' : 'subtract');
  return acc.filter(p => Math.abs(polyArea(p)) > 0.5);
}
/* SVG-Pfad für die Vorschau */
const svgCache = new Map();
export function symbolSVG(sym) {
  if (svgCache.has(sym.id)) return svgCache.get(sym.id);
  let d;
  if (typeof sym.def === 'string') d = sym.def;
  else d = symbolPolys(sym.def).map(p => 'M' + p.map(q => f(q.x) + ' ' + f(q.y)).join('L') + 'Z').join('');
  svgCache.set(sym.id, d);
  return d;
}

/* Symbol als Pfad-Form erzeugen: size = Breite/Höhe in mm, (cx,cy) = Mittelpunkt */
export function makeSymbolShape(sym, cx, cy, size, layer) {
  let subs;
  if (typeof sym.def === 'string') {
    subs = parsePathData(sym.def).map(sp => ({
      closed: sp.closed || true,
      nodes: sp.nodes.map(n => ({ x: n.x, y: n.y, in: n.in && { ...n.in }, out: n.out && { ...n.out } }))
    }));
  } else subs = symbolPolys(sym.def).map(p => nodeSub(p, true));
  // Maßstab auf size (größere Seite), y umdrehen, zentrieren
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const s of subs) for (const n of s.nodes) { x0 = Math.min(x0, n.x); x1 = Math.max(x1, n.x); y0 = Math.min(y0, n.y); y1 = Math.max(y1, n.y); }
  const k = size / Math.max(x1 - x0, y1 - y0, 1e-6);
  const mx = (x0 + x1) / 2, my = (y0 + y1) / 2;
  const tp = p => p && { x: cx + (p.x - mx) * k, y: cy - (p.y - my) * k };
  for (const s of subs) s.nodes = s.nodes.map(n => ({ ...tp(n), in: tp(n.in), out: tp(n.out) }));
  const sh = Shape.path(subs, layer);
  sh.name = loc(sym.name);
  return sh;
}

/* ---------- Eigene Symbole ---------- */
// Gespeichert werden sie über einen Online-Speicher aus einer Erweiterung (setStore):
//   { list() → [{ id, name, polys }], add({ name, polys }) → Symbol, remove(id) }
// Ohne Speicher gibt es keine eigenen Symbole. Früher lagen sie nur im Browser (KEY) – sie werden
// beim ersten Laden mit Speicher einmalig dorthin übernommen.
const KEY = 'laserstudio.symbols';
let store = null, cache = [], loading = null;
const listeners = new Set();
const notify = () => { for (const fn of listeners) fn(); };

function takeOld() {
  try {
    const old = JSON.parse(storage.getItem(KEY) || '[]');
    storage.removeItem(KEY);
    return Array.isArray(old) ? old : [];
  } catch (e) { return []; }
}

export const UserSymbols = {
  setStore(s) { store = s; cache = []; loading = null; notify(); },
  get available() { return !!store; },
  // Liste aus dem Speicher holen (einmal je Sitzung; bei Fehler beim nächsten Aufruf erneut)
  load() {
    if (!store) return Promise.resolve();
    if (!loading) loading = (async () => {
      cache = await store.list();
      const old = takeOld(), failed = [];
      for (const o of old) {
        try { cache.push(await store.add({ name: o.name, polys: o.polys })); } catch (e) { failed.push(o); }
      }
      // was nicht übernommen werden konnte, bleibt im Browser für den nächsten Versuch
      if (failed.length) try { storage.setItem(KEY, JSON.stringify(failed)); } catch (e) { /* egal */ }
      notify();
    })().catch(e => { loading = null; throw e; });
    return loading;
  },
  onChange(fn) { listeners.add(fn); return () => listeners.delete(fn); },
  list() { return cache; },
  /* polys: Welt-Polygone (y nach oben) → auf 0..100 normiert, y nach unten */
  async add(name, polys) {
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const p of polys) for (const q of p) { x0 = Math.min(x0, q.x); x1 = Math.max(x1, q.x); y0 = Math.min(y0, q.y); y1 = Math.max(y1, q.y); }
    const k = 100 / Math.max(x1 - x0, y1 - y0, 1e-6);
    const norm = polys.map(p => p.map(q => [f((q.x - x0) * k), f((y1 - q.y) * k)]));
    if (!store) throw new Error('no store');
    const s = await store.add({ name, polys: norm });
    cache.push(s); notify();
    return s;
  },
  async remove(id) {
    await store.remove(id);
    cache = cache.filter(s => s.id !== id); notify();
  },
  asSymbols() { return cache.map(s => ({ id: 'u' + s.id, sid: s.id, cat: 'user', name: s.name, user: true, def: { polys: s.polys } })); }
};
