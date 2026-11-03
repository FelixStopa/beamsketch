// nest.js — Teile nach ihren echten Umrissen anordnen (Nesting).
// Verfahren: Fläche und Teile werden gerastert (Zellen ≈ 0,5–1 mm). Jedes Teil kommt – größte zuerst –
// an die tiefste, dann am weitesten links liegende Stelle, an der seine um den Abstand vergrößerte
// Form keine belegte Zelle trifft. Löcher bereits gelegter Teile bleiben frei, kleine Teile passen hinein.
// Belegung je Zeile als Präfixsummen: ein Überlappungstest kostet je Zeilenabschnitt O(1), und bei
// einem Treffer springt die Suche direkt hinter die belegte Stelle.
import { offsetPolys, polyArea, pointInPoly } from './geom.js';

/* Umlaufsinn nach Verschachtelung: außen gegen den Uhrzeigersinn, Löcher im Uhrzeigersinn */
export function orientByDepth(polys) {
  return polys.map(p => {
    const depth = polys.reduce((n, o) => n + (o !== p && pointInPoly(p[0], o) ? 1 : 0), 0);
    const ccw = polyArea(p) > 0;
    return (depth % 2 === 0) === ccw ? p : p.slice().reverse();
  });
}

/* Polygone (gerade/ungerade) in Zeilenabschnitte rastern: rows[y] = [[x0, x1], …] (Zellen, inklusive) */
export function rasterRuns(polys, lines, x0, y0, r, nx, ny) {
  const rows = Array.from({ length: ny }, () => []);
  for (let j = 0; j < ny; j++) {
    const yc = y0 + (j + 0.5) * r, xs = [];
    for (const p of polys) for (let i = 0, k = p.length - 1; i < p.length; k = i++) {
      const a = p[i], b = p[k];
      if ((a.y > yc) !== (b.y > yc)) xs.push(a.x + (yc - a.y) * (b.x - a.x) / (b.y - a.y));
    }
    xs.sort((a, b) => a - b);
    for (let i = 0; i + 1 < xs.length; i += 2) {
      const c0 = Math.max(0, Math.floor((xs[i] - x0) / r)), c1 = Math.min(nx - 1, Math.floor((xs[i + 1] - x0) / r));
      if (c1 >= c0) rows[j].push([c0, c1]);
    }
  }
  // offene Linien (Gravuren, Hilfslinien) belegen die Zellen, die sie durchlaufen
  for (const ln of lines || []) for (let i = 1; i < ln.length; i++) {
    const a = ln[i - 1], b = ln[i], n = Math.max(1, Math.ceil(Math.hypot(b.x - a.x, b.y - a.y) / (r / 2)));
    for (let s = 0; s <= n; s++) {
      const x = a.x + (b.x - a.x) * s / n, y = a.y + (b.y - a.y) * s / n;
      const c = Math.floor((x - x0) / r), j = Math.floor((y - y0) / r);
      if (j >= 0 && j < ny && c >= 0 && c < nx) rows[j].push([c, c]);
    }
  }
  return rows;
}

class Grid {
  constructor(nx, ny) { this.nx = nx; this.ny = ny; this.cells = new Uint8Array(nx * ny); this.dirty = new Set(); this.pre = []; }
  fill(j, a, b) { if (j < 0 || j >= this.ny) return; a = Math.max(0, a); b = Math.min(this.nx - 1, b); for (let x = a; x <= b; x++) this.cells[j * this.nx + x] = 1; this.dirty.add(j); }
  // Präfixsumme der Zeile j (neu berechnet, wenn die Zeile sich geändert hat)
  prefix(j) {
    if (!this.pre[j] || this.dirty.has(j)) {
      const p = this.pre[j] || new Int32Array(this.nx + 1), c = this.cells, o = j * this.nx;
      for (let x = 0; x < this.nx; x++) p[x + 1] = p[x] + c[o + x];
      this.pre[j] = p; this.dirty.delete(j);
    }
    return this.pre[j];
  }
  // letzte belegte Zelle in [a, b] der Zeile j, sonst -1
  lastOcc(j, a, b) { const c = this.cells, o = j * this.nx; for (let x = b; x >= a; x--) if (c[o + x]) return x; return -1; }
}

/* Teil an der ersten freien Stelle (unten, dann links) suchen; foot = Zeilenabschnitte relativ */
function findSpot(grid, foot, fw, fh) {
  const rows = [];
  for (let j = 0; j < foot.length; j++) if (foot[j].length) rows.push([j, foot[j]]);
  if (!rows.length) return null;
  for (let y = 0; y + fh <= grid.ny; y++) {
    let x = 0;
    while (x + fw <= grid.nx) {
      let jump = -1;
      for (const [j, runs] of rows) {
        const p = grid.prefix(y + j);
        for (const [a, b] of runs) {
          if (p[x + b + 1] - p[x + a] > 0) { jump = Math.max(jump, grid.lastOcc(y + j, x + a, x + b) - a + 1); break; }
        }
        if (jump > x) break;
      }
      if (jump < 0) return { x, y };
      x = Math.max(x + 1, jump);
    }
  }
  return null;
}

const rot = (polys, a, c) => {
  const cs = Math.cos(a), sn = Math.sin(a);
  return polys.map(p => p.map(q => ({ x: c.x + (q.x - c.x) * cs - (q.y - c.y) * sn, y: c.y + (q.x - c.x) * sn + (q.y - c.y) * cs })));
};
const bboxOf = list => {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const p of list) for (const q of p) { x0 = Math.min(x0, q.x); y0 = Math.min(y0, q.y); x1 = Math.max(x1, q.x); y1 = Math.max(y1, q.y); }
  return { x0, y0, x1, y1 };
};

/* parts: [{ polys: [[pts]], lines: [[pts]] }] in mm.
   area: { w, h } oder { polys } (Restplatte); obstacles: [{ polys, lines }] (nicht verschieben, nur meiden)
   opts: gap, margin, angles (Grad, z. B. [0, 90, 180, 270]), res (mm, optional), orders (Versuche)
   Ergebnis: placements[i] = { angle (rad), dx, dy, center } oder null (passt nicht) */
export function nest(parts, area, opts = {}) {
  const gap = opts.gap ?? 2, margin = opts.margin ?? 0;
  parts = parts.map(pt => ({ ...pt, polys: orientByDepth(pt.polys) }));
  const areaPolys = area.polys ? orientByDepth(area.polys) : [[{ x: 0, y: 0 }, { x: area.w, y: 0 }, { x: area.w, y: area.h }, { x: 0, y: area.h }]];
  const ab = bboxOf(areaPolys);
  const W = ab.x1 - ab.x0, H = ab.y1 - ab.y0;
  const r = opts.res || Math.max(0.25, Math.sqrt(W * H / 200000));
  const nx = Math.ceil(W / r), ny = Math.ceil(H / r);
  const angles = (opts.angles && opts.angles.length ? opts.angles : [0]).map(a => a * Math.PI / 180);

  // Vorbereitung je Teil und Winkel: Fußabdruck (um den Abstand vergrößert) und Belegung (Originalform)
  const prep = parts.map(pt => {
    const b = bboxOf([...pt.polys, ...(pt.lines || [])]);
    const c = { x: (b.x0 + b.x1) / 2, y: (b.y0 + b.y1) / 2 };
    const area = pt.polys.reduce((s, p) => s + Math.abs(polyArea(p)), 0) || (b.x1 - b.x0) * (b.y1 - b.y0);
    const variants = angles.map(a => {
      const polys = rot(pt.polys, a, c), lines = rot(pt.lines || [], a, c);
      // Fußabdruck: Außenkonturen um den Abstand vergrößert (eigene Löcher zählen als belegt)
      const outers = polys.filter(p => polyArea(p) > 0);
      const grown = gap > 0 && outers.length ? offsetPolys(outers, gap, 'round') : outers;
      const gLines = lines.map(l => l);
      const fb = bboxOf([...(grown.length ? grown : polys), ...lines]);
      const pad = Math.ceil((gap > 0 && !grown.length ? gap : 0) / r);
      const fw = Math.ceil((fb.x1 - fb.x0) / r) + 1 + 2 * pad, fh = Math.ceil((fb.y1 - fb.y0) / r) + 1 + 2 * pad;
      const ox = fb.x0 - pad * r, oy = fb.y0 - pad * r;
      return {
        a, polys, lines, ox, oy, fw, fh,
        foot: rasterRuns(grown.length ? grown : polys, gLines, ox, oy, r, fw, fh),
        occ: rasterRuns(polys, lines, ox, oy, r, fw, fh)
      };
    });
    return { c, area, variants, w: b.x1 - b.x0, h: b.y1 - b.y0 };
  });

  const run = order => {
    const grid = new Grid(nx, ny);
    // außerhalb der Fläche und der Rand sind belegt
    const inside = rasterRuns(margin > 0 ? offsetPolys(areaPolys.filter(p => polyArea(p) > 0), -margin, 'round').concat(areaPolys.filter(p => polyArea(p) < 0)) : areaPolys, [], ab.x0, ab.y0, r, nx, ny);
    for (let j = 0; j < ny; j++) {
      let x = 0;
      for (const [a, b] of inside[j].sort((p, q) => p[0] - q[0])) { if (a > x) grid.fill(j, x, a - 1); x = b + 1; }
      if (x < nx) grid.fill(j, x, nx - 1);
    }
    for (const ob of opts.obstacles || []) {
      const rr = rasterRuns(ob.polys || [], ob.lines || [], ab.x0, ab.y0, r, nx, ny);
      rr.forEach((runs, j) => runs.forEach(([a, b]) => grid.fill(j, a, b)));
    }
    const place = new Array(parts.length).fill(null);
    let top = 0;
    for (const i of order) {
      let best = null;
      for (const v of prep[i].variants) {
        if (v.fw > nx || v.fh > ny) continue;
        const s = findSpot(grid, v.foot, v.fw, v.fh);
        if (s && (!best || s.y < best.s.y || (s.y === best.s.y && s.x < best.s.x))) best = { s, v };
      }
      if (!best) continue;
      const { s, v } = best;
      v.occ.forEach((runs, j) => runs.forEach(([a, b]) => grid.fill(s.y + j, s.x + a, s.x + b)));
      // Verschiebung: Rasterursprung des Teils (ox, oy) landet auf der Zelle (s.x, s.y)
      place[i] = { angle: v.a, center: prep[i].c, dx: ab.x0 + s.x * r - v.ox, dy: ab.y0 + s.y * r - v.oy };
      top = Math.max(top, s.y + v.fh);
    }
    return { place, placed: place.filter(Boolean).length, top };
  };

  const idx = parts.map((_, i) => i);
  const orders = [
    idx.slice().sort((a, b) => prep[b].area - prep[a].area),
    idx.slice().sort((a, b) => Math.max(prep[b].w, prep[b].h) - Math.max(prep[a].w, prep[a].h)),
    idx.slice().sort((a, b) => prep[b].h - prep[a].h),
    idx.slice().sort((a, b) => prep[b].w * prep[b].h - prep[a].w * prep[a].h)
  ].slice(0, Math.max(1, opts.orders || 1));
  let best = null;
  for (const o of orders) {
    const res = run(o);
    if (!best || res.placed > best.placed || (res.placed === best.placed && res.top < best.top)) best = res;
  }
  return { placements: best.place, placed: best.placed, res: r };
}
