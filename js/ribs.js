// ribs.js — Rippenmodell aus einem 3D-Modell: Rippen stehen quer zu einer Achse und werden mit
// Halbschlitzen auf ein Rückgrat gesteckt (wie Holztier-Bausätze). Die Rippe ist von unten geschlitzt,
// das Rückgrat von oben – die Rippen werden von oben auf das Rückgrat geschoben.
// Koordinaten je Teil: Rippe (s, h) = (Richtung quer zum Rückgrat, Höhe), Rückgrat (a, h) = (Achse, Höhe).
import { sliceMesh, normalizeLayer, meshBounds } from './mesh.js';
import { boolOp, polyArea, pointInPoly, offsetPolys } from './geom.js';

// je Achse: Umordnung der Dreiecke, damit die Schnittrichtung z wird, und Zuordnung der 2D-Koordinaten
const AXES = {
  x: { rib: [1, 2, 0], ribSH: [0, 1], spine: [2, 0, 1], spineAH: [1, 0], normal: 'y', phys: (a, s, h) => [a, s, h] },
  y: { rib: [2, 0, 1], ribSH: [1, 0], spine: [1, 2, 0], spineAH: [0, 1], normal: 'x', phys: (a, s, h) => [s, a, h] },
  z: { rib: [0, 1, 2], ribSH: [1, 0], spine: [2, 0, 1], spineAH: [0, 1], normal: 'y', phys: (a, s, h) => [h, s, a] }
};
const permute = (tris, p) => {
  const out = new Float32Array(tris.length);
  for (let i = 0; i < tris.length; i += 3) { out[i] = tris[i + p[0]]; out[i + 1] = tris[i + p[1]]; out[i + 2] = tris[i + p[2]]; }
  return out;
};
const remap = (polys, idx) => polys.map(p => p.map(q => { const c = [q.x, q.y]; return { x: c[idx[0]], y: c[idx[1]] }; }));
const orient = polys => polys.map(p => {
  const depth = polys.reduce((n, o) => n + (o !== p && pointInPoly(p[0], o) ? 1 : 0), 0);
  return (depth % 2 === 0) === (polyArea(p) > 0) ? p : p.slice().reverse();
});
// Materialabschnitte einer Umrissmenge entlang der Linie x = c (in y-Richtung) bzw. y = c (in x-Richtung)
function spans(polys, c, alongY) {
  const xs = [];
  for (const p of polys) for (let i = 0, j = p.length - 1; i < p.length; j = i++) {
    const a = p[i], b = p[j], ka = alongY ? a.x : a.y, kb = alongY ? b.x : b.y;
    if ((ka > c) !== (kb > c)) { const t = (c - ka) / (kb - ka); xs.push(alongY ? a.y + (b.y - a.y) * t : a.x + (b.x - a.x) * t); }
  }
  xs.sort((a, b) => a - b);
  const out = [];
  for (let i = 0; i + 1 < xs.length; i += 2) out.push([xs[i], xs[i + 1]]);
  return out;
}
const rect = (x0, y0, x1, y1) => [{ x: x0, y: y0 }, { x: x1, y: y0 }, { x: x1, y: y1 }, { x: x0, y: y1 }];

/* tris: ausgerichtetes Modell (orientMesh). cfg: axis ('x' | 'y' | 'z'), t (Materialstärke), spacing (Rippenabstand),
   spineOffset (Versatz des Rückgrats aus der Mitte), inset (Rückgrat nach innen versetzt), clearance, kerf, minArea */
export function ribModel(tris, cfg) {
  const ax = AXES[cfg.axis] || AXES.x, t = cfg.t || 3, w = t + (cfg.clearance ?? 0.2) - (cfg.kerf || 0);
  const b = meshBounds(tris);
  const lo = { x: b.x0, y: b.y0, z: b.z0 }, hi = { x: b.x1, y: b.y1, z: b.z1 };
  const aMin = lo[cfg.axis || 'x'], aMax = hi[cfg.axis || 'x'];
  const sPos = (lo[ax.normal] + hi[ax.normal]) / 2 + (cfg.spineOffset || 0);
  const warnings = { dropped: 0, noSpine: 0 };

  // Rückgrat: Schnitt in der Ebene normal = sPos, als (a, h)
  const spineTris = permute(tris, ax.spine);
  let spine = orient(remap(normalizeLayer(sliceMesh(spineTris, sPos).loops, cfg.minArea ?? 1), ax.spineAH));
  if (cfg.inset > 0 && spine.length) spine = orient(offsetPolys(spine.filter(p => polyArea(p) > 0), -cfg.inset, 'round'));
  if (!spine.length) return { ribs: [], spine: null, warnings: { ...warnings, noSpine: 1 }, sPos, t };

  // Rippen in gleichmäßigem Abstand, mittig auf der Achse verteilt
  const n = Math.max(1, Math.floor((aMax - aMin) / Math.max(1, cfg.spacing)));
  const first = aMin + ((aMax - aMin) - (n - 1) * cfg.spacing) / 2;
  const ribTris = permute(tris, ax.rib);
  const ribs = [];
  let spineCut = spine;
  for (let i = 0; i < n; i++) {
    const a = first + i * cfg.spacing;
    let polys = orient(remap(normalizeLayer(sliceMesh(ribTris, a).loops, cfg.minArea ?? 1), ax.ribSH));
    if (!polys.length) continue;
    // gemeinsame Höhe von Rippe (Linie s = sPos) und Rückgrat (Linie a): größter überlappender Abschnitt
    const rs = spans(polys, sPos, true), ss = spans(spine, a, true);
    let best = null;
    for (const [r0, r1] of rs) for (const [s0, s1] of ss) {
      const o0 = Math.max(r0, s0), o1 = Math.min(r1, s1);
      if (o1 - o0 > 1 && (!best || o1 - o0 > best[1] - best[0])) best = [o0, o1];
    }
    if (!best) { warnings.dropped++; continue; }
    const hm = (best[0] + best[1]) / 2;
    // Rippe von unten bis zur Mitte schlitzen, Rückgrat von oben bis zur Mitte
    const big = 1e4;
    polys = orient(boolOp(polys, [rect(sPos - w / 2, -big, sPos + w / 2, hm)], 'subtract'));
    spineCut = orient(boolOp(spineCut, [rect(a - w / 2, hm, a + w / 2, big)], 'subtract'));
    // Inseln ohne Verbindung zum Rückgrat fallen weg (sie hätten keinen Halt)
    const outers = polys.filter(p => polyArea(p) > 0);
    const keep = outers.filter(o => spans([o], sPos, true).some(([y0, y1]) => y1 > best[0] - 1 && y0 < best[1] + 1) ||
      spans([o], sPos - w / 2 - 0.5, true).length || spans([o], sPos + w / 2 + 0.5, true).length);
    if (keep.length < outers.length) warnings.dropped += outers.length - keep.length;
    polys = polys.filter(p => polyArea(p) > 0 ? keep.includes(p) : keep.some(o => pointInPoly(p[0], o)));
    ribs.push({ index: ribs.length, a, polys, slotH: hm });
  }
  if (!spineCut.length) return { ribs: [], spine: null, warnings: { ...warnings, noSpine: 1 }, sPos, t, phys: ax.phys };
  return { ribs, spine: spineCut, sPos, t, warnings, phys: ax.phys };
}

/* Platten für die 3D-Ansicht: Rippen quer zur Achse, Rückgrat in seiner Ebene */
export function ribPlates(model) {
  if (!model.spine) return [];
  const { t, sPos, phys } = model;
  const plates = model.ribs.map(r => ({ polys: r.polys, z0: 0, z1: t, map: (u, v, w) => phys(r.a - t / 2 + w, u, v) }));
  plates.push({ polys: model.spine, z0: 0, z1: t, map: (u, v, w) => phys(u, sPos - t / 2 + w, v), spine: true });
  return plates;
}
