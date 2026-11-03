// parts.js — parametrische Teile: Zahnrad (Evolvente), Zahnstange, Zahnriemenscheibe, Nocke,
// Einsatz mit Fächern, Steckregal, Schublade. Alle Maße in mm, y nach oben.
// Rückgabe: { parts: [{ name, outline, holes: [], lines: [] }], info: {…} } – Umrisse gegen den
// Uhrzeigersinn, Löcher im Uhrzeigersinn. Kerf: Umrisse um kerf/2 nach außen, Löcher nach innen.
import { offsetPolys, polyArea, cleanPoly } from './geom.js';
import { boxParts } from './generators.js';

const TAU = Math.PI * 2, rad = d => d * Math.PI / 180;
const pol = (r, a) => ({ x: r * Math.cos(a), y: r * Math.sin(a) });
const ccw = p => polyArea(p) >= 0 ? p : p.slice().reverse();
const cw = p => polyArea(p) <= 0 ? p : p.slice().reverse();
const circle = (r, n = 96, cx = 0, cy = 0) => Array.from({ length: n }, (_, i) => ({ x: cx + r * Math.cos(i * TAU / n), y: cy + r * Math.sin(i * TAU / n) }));
const rect = (x, y, w, h) => [{ x, y }, { x: x + w, y }, { x: x + w, y: y + h }, { x, y: y + h }];

/* Kerf ausgleichen: Außenkontur größer, Löcher kleiner */
function kerfPart(part, kerf) {
  const k = (kerf || 0) / 2;
  if (!k) return part;
  const grow = (p, d) => { const r = offsetPolys([ccw(p)], d, 'round'); return r.length ? r.reduce((a, b) => Math.abs(polyArea(b)) > Math.abs(polyArea(a)) ? b : a) : p; };
  return { ...part, outline: ccw(grow(part.outline, k)), holes: part.holes.map(h => cw(grow(h, -k))) };
}

/* Bohrung: rund, D-Welle (abgeflacht) oder mit Passfedernut */
function bore(cfg) {
  const d = cfg.bore || 0;
  if (d <= 0) return [];
  const r = d / 2;
  if (cfg.boreType === 'd') {
    const flat = r - Math.max(0.3, d * 0.1), a = Math.acos(flat / r);
    const pts = [];
    for (let i = 0; i <= 64; i++) { const t = a + (TAU - 2 * a) * i / 64; pts.push(pol(r, t)); }
    return [cw(pts)];
  }
  if (cfg.boreType === 'key') {
    const w = Math.max(1, d / 4), depth = Math.max(0.5, d / 8), a = Math.asin(w / 2 / r);
    const pts = [];
    for (let i = 0; i <= 64; i++) { const t = a + (TAU - 2 * a) * i / 64; pts.push(pol(r, t)); }
    pts.push({ x: r * Math.cos(a) + depth, y: -w / 2 }, { x: r * Math.cos(a) + depth, y: w / 2 });
    return [cw(pts)];
  }
  return [cw(circle(r, 64))];
}

/* ---------------- Zahnrad mit Evolventenverzahnung ----------------
   z Zähne, Modul m, Eingriffswinkel alpha (°), Profilverschiebung x, Flankenspiel backlash (mm) */
export function gear(cfg) {
  const z = Math.max(5, Math.round(cfg.teeth)), m = cfg.module, a = rad(cfg.pressure || 20), x = cfg.shift || 0;
  const r = m * z / 2, rb = r * Math.cos(a), ra = r + m * (1 + x), rf = Math.max(0.5, r - m * (1.25 - x));
  const inv = t => Math.tan(t) - t;
  const s = Math.PI * m / 2 + 2 * x * m * Math.tan(a) - (cfg.backlash || 0);
  const psi = s / (2 * r) + inv(a);
  const th = R => R <= rb ? psi : psi - inv(Math.acos(rb / R));
  let rTip = ra;
  while (th(rTip) <= 0.002 && rTip > r) rTip -= 0.01 * m;     // spitze Zähne kappen
  const r0 = Math.max(rb, rf), pitch = TAU / z, pts = [];
  const steps = 10;
  for (let k = 0; k < z; k++) {
    const c = k * pitch;
    // Fußkreis von der Lücke bis zur rechten Flanke
    const a0 = c - pitch / 2, a1 = c - th(r0);
    for (let i = 0; i <= 4; i++) pts.push(pol(rf, a0 + (a1 - a0) * i / 4));
    if (rf < rb) pts.push(pol(rb, c - psi));
    for (let i = 1; i <= steps; i++) { const R = r0 + (rTip - r0) * i / steps; pts.push(pol(R, c - th(R))); }
    for (let i = 1; i < 4; i++) { const t = -th(rTip) + 2 * th(rTip) * i / 4; pts.push(pol(rTip, c + t)); }
    for (let i = steps; i >= 1; i--) { const R = r0 + (rTip - r0) * i / steps; pts.push(pol(R, c + th(R))); }
    if (rf < rb) pts.push(pol(rb, c + psi));
    const b0 = c + th(r0), b1 = c + pitch / 2;
    for (let i = 0; i <= 4; i++) pts.push(pol(rf, b0 + (b1 - b0) * i / 4));
  }
  const part = kerfPart({ name: 'Zahnrad', outline: ccw(cleanPoly(pts)), holes: bore(cfg), lines: [] }, cfg.kerf);
  return { parts: [part], info: { pitchD: 2 * r, outerD: 2 * rTip, rootD: 2 * rf, pointed: rTip < ra - 1e-9 } };
}

/* Zahnradpaar: zwei passende Räder im Achsabstand, optional Grundplatte mit Achslöchern */
export function gearPair(cfg) {
  const g1 = gear({ ...cfg, teeth: cfg.teeth, shift: cfg.shift || 0 });
  const g2 = gear({ ...cfg, teeth: cfg.teeth2, shift: -(cfg.shift || 0), bore: cfg.bore2 ?? cfg.bore });
  const dist = cfg.module * (cfg.teeth + cfg.teeth2) / 2;
  const parts = [{ ...g1.parts[0], name: 'Zahnrad 1' }, { ...g2.parts[0], name: 'Zahnrad 2' }];
  if (cfg.plate) {
    const R = Math.max(g1.info.outerD, g2.info.outerD) / 2 + 6;
    const holeR = Math.max(1, (cfg.axle || 3) / 2);
    parts.push(kerfPart({ name: 'Grundplatte', outline: ccw(rect(-R, -R, dist + 2 * R, 2 * R)), holes: [cw(circle(holeR, 48)), cw(circle(holeR, 48, dist, 0))], lines: [] }, cfg.kerf));
  }
  return { parts, info: { distance: dist, d1: g1.info.pitchD, d2: g2.info.pitchD } };
}

/* ---------------- Zahnstange (passend zum Zahnrad) ---------------- */
export function rack(cfg) {
  const m = cfg.module, a = rad(cfg.pressure || 20), n = Math.max(1, Math.round(cfg.teeth)), p = Math.PI * m;
  const s = p / 2 - (cfg.backlash || 0), body = Math.max(m, cfg.height || 10);
  const ta = Math.tan(a), hf = 1.25 * m;
  const L = n * p;
  const pts = [{ x: 0, y: -hf - body }, { x: L, y: -hf - body }, { x: L, y: -hf }];
  for (let i = n - 1; i >= 0; i--) {
    const xc = i * p + p / 2;
    pts.push({ x: xc + s / 2 + hf * ta, y: -hf }, { x: xc + s / 2 - m * ta, y: m }, { x: xc - s / 2 + m * ta, y: m }, { x: xc - s / 2 - hf * ta, y: -hf });
  }
  pts.push({ x: 0, y: -hf });
  const part = kerfPart({ name: 'Zahnstange', outline: ccw(cleanPoly(pts)), holes: [], lines: [] }, cfg.kerf);
  return { parts: [part], info: { length: L, pitch: p } };
}

/* ---------------- Zahnriemenscheibe (GT2 / HTD, Näherung mit runden Zahnlücken) ---------------- */
const BELTS = {
  'GT2-2': { p: 2, pld: 0.254, h: 0.75, rg: 0.555 },
  'GT2-3': { p: 3, pld: 0.381, h: 1.14, rg: 0.85 },
  'GT2-5': { p: 5, pld: 0.5715, h: 1.93, rg: 1.44 },
  'HTD-3M': { p: 3, pld: 0.381, h: 1.17, rg: 0.86 },
  'HTD-5M': { p: 5, pld: 0.5715, h: 2.06, rg: 1.49 }
};
export function pulley(cfg) {
  const b = BELTS[cfg.belt] || BELTS['GT2-2'], n = Math.max(8, Math.round(cfg.teeth));
  const R = n * b.p / Math.PI / 2 - b.pld;                  // Außenradius
  const rg = b.rg + (cfg.groove || 0) / 2, Rc = R - b.h + rg;
  const beta = Math.acos(Math.max(-1, Math.min(1, (R * R + Rc * Rc - rg * rg) / (2 * R * Rc))));
  const pts = [];
  for (let j = 0; j < n; j++) {
    const aj = j * TAU / n, C = pol(Rc, aj);
    const p1 = pol(R, aj - beta), p2 = pol(R, aj + beta);
    const g1 = Math.atan2(p1.y - C.y, p1.x - C.x), g2 = Math.atan2(p2.y - C.y, p2.x - C.x);
    // Lücke: Kreisbogen um C auf der Innenseite (durch die Richtung zur Mitte), im Uhrzeigersinn
    let end = g2; while (end > g1) end -= TAU;
    for (let i = 0; i <= 12; i++) { const g = g1 + (end - g1) * i / 12; pts.push({ x: C.x + rg * Math.cos(g), y: C.y + rg * Math.sin(g) }); }
    const nxt = (j + 1) * TAU / n - beta;
    for (let i = 1; i < 6; i++) pts.push(pol(R, aj + beta + (nxt - aj - beta) * i / 6));
  }
  const part = kerfPart({ name: 'Zahnriemenscheibe', outline: ccw(cleanPoly(pts)), holes: bore(cfg), lines: [] }, cfg.kerf);
  return { parts: [part], info: { outerD: 2 * R, pitchD: n * b.p / Math.PI } };
}

/* ---------------- Kurvenscheibe (Nocke) ---------------- */
function motion(type, u) {
  if (type === 'harmonic') return (1 - Math.cos(Math.PI * u)) / 2;
  if (type === 'poly') return u * u * u * (10 - 15 * u + 6 * u * u);
  return u - Math.sin(TAU * u) / TAU;                       // zykloidisch
}
export function cam(cfg) {
  const rb = cfg.base, h = cfg.lift, A = [rad(cfg.rise), rad(cfg.dwell), rad(cfg.ret)];
  const rr = cfg.follower === 'roller' ? Math.max(0.5, cfg.roller || 5) : 0;
  const lift = th => {
    if (th < A[0]) return h * motion(cfg.motion, th / A[0]);
    if (th < A[0] + A[1]) return h;
    if (th < A[0] + A[1] + A[2]) return h * (1 - motion(cfg.motion, (th - A[0] - A[1]) / A[2]));
    return 0;
  };
  const N = 360, pitch = Array.from({ length: N }, (_, i) => { const t = i * TAU / N; return pol(rb + rr + lift(t), t); });
  let outline = pitch;
  if (rr) { const o = offsetPolys([ccw(pitch)], -rr, 'round'); if (o.length) outline = o.reduce((a, b) => Math.abs(polyArea(b)) > Math.abs(polyArea(a)) ? b : a); }
  const part = kerfPart({ name: 'Nocke', outline: ccw(outline), holes: bore(cfg), lines: [] }, cfg.kerf);
  return { parts: [part], info: { maxD: 2 * (rb + h), rest: 360 - cfg.rise - cfg.dwell - cfg.ret } };
}

/* Rechteck w × h mit Schlitzen von unten (bottom) bzw. oben (top): slots = [{ x, w, d }] */
function slotted(w, hgt, top, bottom) {
  const pts = [{ x: 0, y: 0 }];
  for (const s of bottom.slice().sort((a, b) => a.x - b.x)) pts.push({ x: s.x - s.w / 2, y: 0 }, { x: s.x - s.w / 2, y: s.d }, { x: s.x + s.w / 2, y: s.d }, { x: s.x + s.w / 2, y: 0 });
  pts.push({ x: w, y: 0 }, { x: w, y: hgt });
  for (const s of top.slice().sort((a, b) => b.x - a.x)) pts.push({ x: s.x + s.w / 2, y: hgt }, { x: s.x + s.w / 2, y: hgt - s.d }, { x: s.x - s.w / 2, y: hgt - s.d }, { x: s.x - s.w / 2, y: hgt });
  pts.push({ x: 0, y: hgt });
  return ccw(cleanPoly(pts));
}

/* ---------------- Einsatz mit Fächern (Halbschlitze über Kreuz) ----------------
   W × D Innenmaß der Box, Höhe H, nx Fächer in der Breite, ny in der Tiefe */
export function insert(cfg) {
  const { W, D, H, t } = cfg, nx = Math.max(1, Math.round(cfg.nx)), ny = Math.max(1, Math.round(cfg.ny));
  const sw = t + (cfg.clearance ?? 0.2) - (cfg.kerf || 0), e = cfg.endClear ?? 0.5;
  const lenX = W - 2 * e, lenY = D - 2 * e;
  const xs = Array.from({ length: nx - 1 }, (_, i) => (i + 1) * W / nx - e);
  const ys = Array.from({ length: ny - 1 }, (_, j) => (j + 1) * D / ny - e);
  const parts = [];
  // Längswände (entlang der Breite) mit Schlitzen von oben, Querwände mit Schlitzen von unten
  for (let j = 0; j < ny - 1; j++) parts.push({ name: 'Längswand', outline: slotted(lenX, H, xs.map(x => ({ x, w: sw, d: H / 2 })), []), holes: [], lines: [] });
  for (let i = 0; i < nx - 1; i++) parts.push({ name: 'Querwand', outline: slotted(lenY, H, [], ys.map(y => ({ x: y, w: sw, d: H / 2 }))), holes: [], lines: [] });
  return { parts: parts.map(p => kerfPart(p, cfg.kerf)), info: { cells: nx * ny, cellW: W / nx - t, cellD: D / ny - t } };
}

/* ---------------- Steckregal: zwei Seiten, n Böden, über Kreuz gesteckt ----------------
   W Breite der Böden, D Tiefe, H Höhe der Seiten, n Böden, overhang = Überstand der Böden */
export function shelf(cfg) {
  const { W, D, H, t } = cfg, n = Math.max(1, Math.round(cfg.shelves));
  const sw = t + (cfg.clearance ?? 0.2) - (cfg.kerf || 0), o = cfg.overhang ?? 20, foot = cfg.foot ?? 20;
  const levels = Array.from({ length: n }, (_, k) => n === 1 ? H / 2 : foot + (H - foot - t - 10) * k / (n - 1) + t / 2);
  // Seite (D breit, H hoch): Schlitze von vorne (x = 0) bis zur halben Tiefe
  const side = [{ x: 0, y: 0 }, { x: D, y: 0 }, { x: D, y: H }, { x: 0, y: H }];
  for (const y of levels.slice().reverse()) side.push({ x: 0, y: y + sw / 2 }, { x: D / 2, y: y + sw / 2 }, { x: D / 2, y: y - sw / 2 }, { x: 0, y: y - sw / 2 });
  const parts = [{ name: 'Seite', outline: ccw(cleanPoly(side)), holes: [], lines: [] }, { name: 'Seite', outline: ccw(cleanPoly(side)), holes: [], lines: [] }];
  // Boden (W lang, D tief): Schlitze von hinten (y = D) bis zur halben Tiefe
  const bx = [o + t / 2, W - o - t / 2];
  for (let k = 0; k < n; k++) parts.push({ name: 'Boden', outline: slotted(W, D, bx.map(x => ({ x, w: sw, d: D / 2 })), []), holes: [], lines: [] });
  return { parts: parts.map(p => kerfPart(p, cfg.kerf)), info: { levels } };
}

/* ---------------- Schublade: Kasten mit Fingerzinken + Front mit Griffloch ----------------
   Öffnung W × H, Tiefe D; Spiel seitlich/oben, Front überlappt um overlay */
export function drawer(cfg) {
  const c = cfg.clearance ?? 1;
  const box = boxParts({ w: cfg.W - 2 * c, d: cfg.D - c, h: cfg.H - c, t: cfg.t, finger: cfg.finger || 10, kerf: cfg.kerf || 0, inner: false, lid: 'open', dividers: 0 });
  const ov = cfg.overlay ?? 5, fw = cfg.W + 2 * ov, fh = cfg.H + 2 * ov;
  const holes = [];
  if (cfg.handle === 'slot') {
    const w = Math.min(80, fw * 0.5), hh = 22, r = hh / 2, cx = fw / 2, cy = fh * 0.62;
    const right = Array.from({ length: 17 }, (_, i) => { const a = -Math.PI / 2 + Math.PI * i / 16; return { x: cx + w / 2 - r + r * Math.cos(a), y: cy + r * Math.sin(a) }; });
    const left = Array.from({ length: 17 }, (_, i) => { const a = Math.PI / 2 + Math.PI * i / 16; return { x: cx - w / 2 + r + r * Math.cos(a), y: cy + r * Math.sin(a) }; });
    holes.push(cw(right.concat(left)));
  } else if (cfg.handle === 'hole') holes.push(cw(circle(12.5, 64, fw / 2, fh * 0.62)));
  const front = kerfPart({ name: 'Front', outline: ccw(rect(0, 0, fw, fh)), holes, lines: [] }, cfg.kerf);
  return { parts: [...box.parts.map(p => ({ name: p.name, outline: ccw(p.outline), holes: p.holes.map(cw), lines: [] })), front], info: { box: box.outer } };
}

export const PART_KINDS = {
  box: {
    make: cfg => { const r = boxParts(cfg); return { parts: r.parts.map(p => ({ name: p.name, outline: ccw(p.outline), holes: p.holes.map(cw), lines: [] })), info: { outer: r.outer, count: r.parts.length } }; },
    defaults: { w: 100, d: 80, h: 60, t: 3, finger: 10, kerf: 0.1, inner: false, lid: 'open', dividers: 0 }
  },
  gear: { make: gear, defaults: { teeth: 20, module: 2, pressure: 20, shift: 0, backlash: 0.1, kerf: 0.1, bore: 5, boreType: 'round' } },
  gearPair: { make: gearPair, defaults: { teeth: 15, teeth2: 30, module: 2, pressure: 20, shift: 0, backlash: 0.1, kerf: 0.1, bore: 5, boreType: 'round', plate: true, axle: 5 } },
  rack: { make: rack, defaults: { teeth: 15, module: 2, pressure: 20, backlash: 0.1, kerf: 0.1, height: 10 } },
  pulley: { make: pulley, defaults: { belt: 'GT2-2', teeth: 20, groove: 0.1, kerf: 0.1, bore: 5, boreType: 'd' } },
  cam: { make: cam, defaults: { base: 25, lift: 10, rise: 120, dwell: 60, ret: 120, motion: 'cycloid', follower: 'knife', roller: 5, kerf: 0.1, bore: 6, boreType: 'round' } },
  insert: { make: insert, defaults: { W: 150, D: 100, H: 40, t: 3, nx: 3, ny: 2, clearance: 0.2, endClear: 0.5, kerf: 0.1 } },
  shelf: { make: shelf, defaults: { W: 300, D: 150, H: 400, t: 6, shelves: 3, overhang: 20, foot: 20, clearance: 0.2, kerf: 0.1 } },
  drawer: { make: drawer, defaults: { W: 200, D: 250, H: 80, t: 3, finger: 10, clearance: 1, overlay: 5, handle: 'slot', kerf: 0.1 } }
};
