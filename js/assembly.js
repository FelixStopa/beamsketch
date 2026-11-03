// assembly.js — Baugruppen für die 3D-Ansicht: setzt die Teile aus dem Teile-Generator (Box, Schublade,
// Steckregal, Einsatz, Zahnradpaar) so zusammen, wie sie nach dem Lasern stehen. Jede Platte bekommt
// eine Abbildung map(u, v, w) → [x, y, z]: (u, v) ist der Umriss in mm, w die Materialstärke (0 … t).
// Alle anderen geschlossenen Formen liegen flach an ihrer Stelle.
import { PART_KINDS } from './parts.js';
import { polyArea, pointInPoly } from './geom.js';

// Platte: u, v, w auf drei Raumachsen abbilden ('x' | 'y' | 'z'), danach verschieben
const plate = (ua, va, wa, ox = 0, oy = 0, oz = 0) => (u, v, w) => {
  const p = { x: 0, y: 0, z: 0 };
  p[ua] += u; p[va] += v; p[wa] += w;
  return [p.x + ox, p.y + oy, p.z + oz];
};
const rotZ = (a, ox = 0, oy = 0, oz = 0) => (u, v, w) => [ox + u * Math.cos(a) - v * Math.sin(a), oy + u * Math.sin(a) + v * Math.cos(a), oz + w];

/* Platten einer Baugruppe aus kind + cfg; t = Materialstärke (aus cfg oder Standard) */
export function assemblyPlates(kind, cfg) {
  const K = PART_KINDS[kind];
  if (!K) return null;
  const res = K.make(cfg), parts = res.parts, t = cfg.t || cfg.thickness || 3;
  const P = (i, map, extra = {}) => ({ name: parts[i].name, polys: [parts[i].outline, ...parts[i].holes], z0: 0, z1: t, map, ...extra });
  const out = [];
  if (kind === 'box' || kind === 'drawer') {
    const o = kind === 'box' ? res.info.outer : res.info.box, W = o.w, D = o.d, H = o.h;
    let div = 0;
    const nDiv = parts.filter(p => p.name === 'Trennwand').length;
    parts.forEach((p, i) => {
      if (p.name === 'Boden') out.push(P(i, plate('x', 'y', 'z')));
      else if (p.name === 'Deckel') out.push(P(i, plate('x', 'y', 'z', 0, 0, H - t)));
      else if (p.name === 'Vorderseite') out.push(P(i, plate('x', 'z', 'y')));
      else if (p.name === 'Rückseite') out.push(P(i, plate('x', 'z', 'y', 0, D - t)));
      else if (p.name === 'Linke Seite') out.push(P(i, plate('y', 'z', 'x')));
      else if (p.name === 'Rechte Seite') out.push(P(i, plate('y', 'z', 'x', W - t)));
      else if (p.name === 'Trennwand') { div++; out.push(P(i, plate('y', 'z', 'x', W * div / (nDiv + 1) - t / 2, t))); }
      else if (p.name === 'Front') {
        const ov = cfg.overlay ?? 5, c = cfg.clearance ?? 1;
        out.push(P(i, plate('x', 'z', 'y', -c - ov, -t, -ov)));
      }
    });
    return out;
  }
  if (kind === 'shelf') {
    const o = cfg.overhang ?? 20;
    let side = 0, board = 0;
    parts.forEach((p, i) => {
      if (p.name === 'Seite') out.push(P(i, plate('y', 'z', 'x', side++ ? cfg.W - o - t : o)));
      else out.push(P(i, plate('x', 'y', 'z', 0, 0, res.info.levels[board++] - t / 2)));
    });
    return out;
  }
  if (kind === 'insert') {
    const nx = Math.round(cfg.nx), ny = Math.round(cfg.ny), e = cfg.endClear ?? 0.5;
    let j = 0, i2 = 0;
    parts.forEach((p, i) => {
      if (p.name === 'Längswand') out.push(P(i, plate('x', 'z', 'y', e, (++j) * cfg.D / ny - t / 2)));
      else out.push(P(i, plate('y', 'z', 'x', (++i2) * cfg.W / nx - t / 2, e)));
    });
    return out;
  }
  if (kind === 'gearPair') {
    const dist = res.info.distance;
    parts.forEach((p, i) => {
      if (p.name === 'Grundplatte') out.push(P(i, plate('x', 'y', 'z')));
      else if (p.name === 'Zahnrad 1') out.push(P(i, rotZ(0, 0, 0, cfg.plate ? t + 1 : 0)));
      else out.push(P(i, rotZ(Math.PI / cfg.teeth2, dist, 0, cfg.plate ? t + 1 : 0)));
    });
    return out;
  }
  // Einzelteile (Zahnrad, Nocke …): flach
  return parts.map((p, i) => P(i, plate('x', 'y', 'z')));
}

/* Umrisse nach Verschachtelung ausrichten (außen gegen, Löcher im Uhrzeigersinn) */
export function orientPolys(polys) {
  return polys.map(p => {
    const depth = polys.reduce((n, o) => n + (o !== p && pointInPoly(p[0], o) ? 1 : 0), 0);
    return (depth % 2 === 0) === (polyArea(p) > 0) ? p : p.slice().reverse();
  });
}

/* Szene: generierte Sätze zusammengebaut nebeneinander, übrige Formen flach an ihrer Stelle.
   sets: [{ kind, cfg }], flat: [[poly, …], …] (Umrisse je Form), t = Stärke flacher Platten */
export function buildScene(sets, flat, t) {
  const scene = [];
  let x = 0;
  for (const s of sets) {
    const plates = assemblyPlates(s.kind, s.cfg);
    if (!plates || !plates.length) continue;
    // Baugruppe neben die vorige stellen
    let x0 = Infinity, x1 = -Infinity;
    for (const pl of plates) for (const poly of pl.polys) for (const q of poly) for (const w of [pl.z0, pl.z1]) { const p = pl.map(q.x, q.y, w); x0 = Math.min(x0, p[0]); x1 = Math.max(x1, p[0]); }
    const dx = x - x0;
    for (const pl of plates) { const m = pl.map; scene.push({ ...pl, map: (u, v, w) => { const p = m(u, v, w); return [p[0] + dx, p[1], p[2]]; } }); }
    x += (x1 - x0) + 30;
  }
  // flache Teile: Lage untereinander wie auf der Arbeitsfläche, als Gruppe rechts neben den Baugruppen
  let fx = Infinity, fy = Infinity;
  for (const polys of flat) for (const p of polys) for (const q of p) { fx = Math.min(fx, q.x); fy = Math.min(fy, q.y); }
  for (const polys of flat) {
    if (!polys.length) continue;
    const pp = orientPolys(polys);
    scene.push({ name: '', polys: pp, z0: 0, z1: t, map: sets.length ? (u, v, w) => [u - fx + x, v - fy, w] : (u, v, w) => [u, v, w] });
  }
  return scene;
}
