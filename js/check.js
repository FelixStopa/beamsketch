// check.js — Design-Check vor dem Lasern: findet typische Fehler in der Zeichnung.
// Jeder Fund: { type, level ('err' | 'warn'), shapes: [Form, …], at: {x, y}, box, fix?: 'delete' | 'close' | 'inside', n? }
import { shapePolys } from './doc.js';

const q = v => Math.round(v * 100);           // 0,01 mm
const segDist = (a, b, c, d) => {
  // kürzester Abstand zweier Strecken (0, wenn sie sich schneiden) und der Punkt dazu
  const cross = (o, p, r) => (p.x - o.x) * (r.y - o.y) - (p.y - o.y) * (r.x - o.x);
  const d1 = cross(c, d, a), d2 = cross(c, d, b), d3 = cross(a, b, c), d4 = cross(a, b, d);
  if (((d1 > 0) !== (d2 > 0)) && ((d3 > 0) !== (d4 > 0)) && d1 && d2 && d3 && d4) return { d: 0, p: a };
  const pt = (p, s, e) => {
    const dx = e.x - s.x, dy = e.y - s.y, l2 = dx * dx + dy * dy;
    const t = l2 ? Math.max(0, Math.min(1, ((p.x - s.x) * dx + (p.y - s.y) * dy) / l2)) : 0;
    const x = s.x + t * dx, y = s.y + t * dy;
    return { d: Math.hypot(p.x - x, p.y - y), p: { x: (p.x + x) / 2, y: (p.y + y) / 2 } };
  };
  return [pt(a, c, d), pt(b, c, d), pt(c, a, b), pt(d, a, b)].reduce((m, r) => r.d < m.d ? r : m);
};
const boxOf = pts => {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const p of pts) { x0 = Math.min(x0, p.x); y0 = Math.min(y0, p.y); x1 = Math.max(x1, p.x); y1 = Math.max(y1, p.y); }
  return { x0, y0, x1, y1 };
};

/* Zeichnung prüfen. opts: minBridge (mm, Standard 1), gapTol (mm, Standard 1) */
export function checkDesign(doc, ctx, opts = {}) {
  const minBridge = opts.minBridge ?? 1, gapTol = opts.gapTol ?? 1;
  const M = doc.machine, found = [];
  const layerOf = i => doc.layers[i] || {};
  // alle ausgegebenen Umrisse sammeln, mit Zuordnung zur obersten Form und zur Blatt-Form
  const items = [];
  for (const top of doc.shapes) {
    if (top.hidden) continue;
    const counter = new Map();
    for (const p of shapePolys(top, ctx)) {
      const L = layerOf(p.layer);
      const k = counter.get(p.shape) || 0; counter.set(p.shape, k + 1);
      if (!L.output || L.isTool || p.shape.hidden) continue;
      let pts = p.pts;
      if (p.closed && pts.length > 1) { const a = pts[0], b = pts[pts.length - 1]; if (Math.abs(a.x - b.x) < 1e-9 && Math.abs(a.y - b.y) < 1e-9) pts = pts.slice(0, -1); }
      items.push({ ...p, pts, top, L, sub: k, cut: L.mode === 'line' || L.mode === 'fill+line' });
    }
    if (top.type === 'image' || (top.type === 'group' && top.children.some(c => c.type === 'image'))) {
      const L = layerOf(top.layer);
      if (top.type === 'image' && L.output && L.mode === 'line') found.push({ type: 'imageOnLine', level: 'warn', shapes: [top], box: null });
    }
  }

  // 1. doppelte Umrisse (identische Form zweimal übereinander)
  const sig = it => {
    const pts = it.pts.map(p => q(p.x) + ',' + q(p.y));
    if (it.closed) {
      // Start und Richtung egal: kleinste Drehung beider Richtungen
      const rot = a => { let best = null; for (let i = 0; i < a.length; i++) { const s = a.slice(i).concat(a.slice(0, i)).join(';'); if (best === null || s < best) best = s; } return best; };
      const f = rot(pts), r = rot(pts.slice().reverse());
      return 'c' + (f < r ? f : r);
    }
    const f = pts.join(';'), r = pts.slice().reverse().join(';');
    return 'o' + (f < r ? f : r);
  };
  const seen = new Map(), dupTops = new Map();
  for (const it of items.filter(i => i.cut)) {
    const s = sig(it);
    if (seen.has(s) && seen.get(s).top !== it.top) {
      const list = dupTops.get(it.top) || []; list.push(it); dupTops.set(it.top, list);
    } else if (!seen.has(s)) seen.set(s, it);
  }
  for (const [top, list] of dupTops) {
    const all = items.filter(i => i.top === top && i.cut).length === list.length;
    found.push({ type: 'duplicate', level: 'err', shapes: [top], box: boxOf(list[0].pts), fix: all ? 'delete' : undefined });
  }

  // 2. gemeinsame Kanten verschiedener Umrisse (wird zweimal geschnitten)
  const edges = new Map();
  let shared = 0, sharedAt = null, sharedShapes = new Set();
  for (const it of items.filter(i => i.cut && !dupTops.has(i.top))) {
    const n = it.pts.length, m = it.closed ? n : n - 1;
    for (let i = 0; i < m; i++) {
      const a = it.pts[i], b = it.pts[(i + 1) % n];
      const ka = q(a.x) + ',' + q(a.y), kb = q(b.x) + ',' + q(b.y);
      if (ka === kb) continue;
      const k = ka < kb ? ka + '|' + kb : kb + '|' + ka;
      const prev = edges.get(k);
      if (prev && prev !== it.top) { shared++; sharedAt = sharedAt || { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }; sharedShapes.add(prev); sharedShapes.add(it.top); }
      else if (!prev) edges.set(k, it.top);
    }
  }
  if (shared) found.push({ type: 'shared', level: 'warn', n: shared, shapes: [...sharedShapes], at: sharedAt });

  // 3. offene Linien: fast geschlossen bzw. auf Füll-Ebenen
  for (const it of items) {
    if (it.closed || it.pts.length < 2) continue;
    const a = it.pts[0], b = it.pts[it.pts.length - 1], d = Math.hypot(a.x - b.x, a.y - b.y);
    if (d > 1e-6 && d <= gapTol && it.pts.length > 2) {
      found.push({ type: 'almostClosed', level: 'warn', shapes: [it.top], leaf: it.shape, sub: it.sub, d, at: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }, fix: 'close' });
    } else if (it.L.mode === 'fill') {
      found.push({ type: 'openOnFill', level: 'warn', shapes: [it.top], box: boxOf(it.pts) });
    }
  }

  // 4. zu kleine Ausschnitte für die Schnittfuge
  for (const it of items.filter(i => i.cut && i.closed)) {
    const b = boxOf(it.pts), minDim = Math.min(b.x1 - b.x0, b.y1 - b.y0);
    const limit = Math.max(0.3, 2 * Math.abs(it.L.kerf || 0));
    if (minDim < limit) found.push({ type: 'tiny', level: 'warn', shapes: [it.top], box: b, size: minDim });
  }

  // 5. schmale Stege zwischen zwei Schnitten (Raster der Kanten, nur benachbarte Zellen vergleichen)
  const cutClosed = items.filter(i => i.cut && i.closed && i.pts.length >= 3 && !dupTops.has(i.top));
  const cell = Math.max(minBridge, 0.5), grid = new Map(), segs = [];
  cutClosed.forEach((it, ci) => {
    for (let i = 0; i < it.pts.length; i++) {
      const a = it.pts[i], b = it.pts[(i + 1) % it.pts.length];
      const s = { a, b, ci };
      const bx = boxOf([a, b]), id = segs.push(s) - 1;
      for (let gx = Math.floor(bx.x0 / cell); gx <= Math.floor(bx.x1 / cell); gx++)
        for (let gy = Math.floor(bx.y0 / cell); gy <= Math.floor(bx.y1 / cell); gy++) {
          const k = gx + ',' + gy; if (!grid.has(k)) grid.set(k, []); grid.get(k).push(id);
        }
    }
  });
  const pairBest = new Map();
  for (const [k, ids] of grid) {
    const [gx, gy] = k.split(',').map(Number);
    const near = [];
    for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) { const o = grid.get((gx + dx) + ',' + (gy + dy)); if (o) near.push(...o); }
    for (const i of ids) for (const j of near) {
      const s = segs[i], t = segs[j];
      if (j <= i || s.ci === t.ci) continue;
      const r = segDist(s.a, s.b, t.a, t.b);
      if (r.d <= 1e-6 || r.d >= minBridge) continue;
      const key = Math.min(s.ci, t.ci) + '|' + Math.max(s.ci, t.ci);
      const prev = pairBest.get(key);
      if (!prev || r.d < prev.d) pairBest.set(key, { d: r.d, at: r.p, a: s.ci, b: t.ci });
    }
  }
  for (const v of pairBest.values()) {
    const A = cutClosed[v.a], B = cutClosed[v.b];
    found.push({ type: 'bridge', level: 'warn', shapes: [...new Set([A.top, B.top])], at: v.at, d: v.d });
  }

  // 6. außerhalb der Arbeitsfläche (nur absolute Koordinaten)
  if (M.jobOrigin === 'absolute') {
    for (const top of doc.shapes) {
      const its = items.filter(i => i.top === top);
      if (!its.length) continue;
      const b = boxOf(its.flatMap(i => i.pts));
      if (b.x0 < -0.01 || b.y0 < -0.01 || b.x1 > M.width + 0.01 || b.y1 > M.height + 0.01)
        found.push({ type: 'outside', level: 'err', shapes: [top], box: b, fix: 'inside' });
    }
  }
  return found;
}

/* Fund beheben; gibt true zurück, wenn etwas geändert wurde */
export function fixFinding(doc, f) {
  if (f.fix === 'delete') {
    doc.shapes = doc.shapes.filter(s => s !== f.shapes[0]);
    return true;
  }
  if (f.fix === 'close' && f.leaf && f.leaf.type === 'path' && f.leaf.subpaths[f.sub]) {
    f.leaf.subpaths[f.sub].closed = true;
    return true;
  }
  if (f.fix === 'inside' && f.box) {
    const M = doc.machine, b = f.box;
    const dx = b.x0 < 0 ? -b.x0 : b.x1 > M.width ? M.width - b.x1 : 0;
    const dy = b.y0 < 0 ? -b.y0 : b.y1 > M.height ? M.height - b.y1 : 0;
    const s = f.shapes[0];
    s.transform = [s.transform[0], s.transform[1], s.transform[2], s.transform[3], s.transform[4] + dx, s.transform[5] + dy];
    return true;
  }
  return false;
}

