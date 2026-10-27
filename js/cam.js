// cam.js — Werkzeugweg-Erzeugung: Schneiden, Füllen, Offset-Füllung, Sortierung
import { Mat, V, boxFromPts, boxValid, pointInPoly, polyArea, offsetPolys, scanFill, cleanPoly, boxCenter, distToSeg } from './geom.js';
import { shapePolys, walk } from './doc.js';
import { imageScanLines } from './raster.js';

function layerGeometry(doc, layer, ctx, only) {
  const res = [];
  for (const sh of doc.shapes) {
    if (only && !only.has(sh.id)) continue;
    collect(sh, layer, ctx, res, [1, 0, 0, 1, 0, 0]);
  }
  return res;
}
function collect(sh, layer, ctx, res, parentMat) {
  if (sh.hidden) return;
  const m = Mat.mul(sh.transform, parentMat);
  if (sh.type === 'group') { for (const c of sh.children) collect(c, layer, ctx, res, m); return; }
  if (sh.layer !== layer.index) return;
  if (sh.type === 'image') { res.push({ image: sh, worldMat: m }); return; }
  for (const p of shapePolys(sh, ctx, parentMat)) res.push(p);
}

function nnOrder(paths, start = { x: 0, y: 0 }) {
  const out = [];
  const left = paths.slice();
  let cur = start;
  while (left.length) {
    let bi = 0, bd = Infinity, brev = false, bidx = 0;
    for (let i = 0; i < left.length; i++) {
      const p = left[i];
      if (p.closed) {
        // beste Startposition auf geschlossener Kontur
        for (let k = 0; k < p.pts.length; k++) {
          const d = V.dist2(cur, p.pts[k]);
          if (d < bd) { bd = d; bi = i; bidx = k; brev = false; }
        }
      } else {
        const d0 = V.dist2(cur, p.pts[0]);
        const d1 = V.dist2(cur, p.pts[p.pts.length - 1]);
        if (d0 < bd) { bd = d0; bi = i; brev = false; bidx = 0; }
        if (d1 < bd) { bd = d1; bi = i; brev = true; bidx = 0; }
      }
    }
    const p = left.splice(bi, 1)[0];
    let pts = p.pts;
    if (p.closed && bidx > 0) pts = pts.slice(bidx).concat(pts.slice(0, bidx));
    if (!p.closed && brev) pts = pts.slice().reverse();
    out.push({ ...p, pts });
    cur = p.closed ? pts[0] : pts[pts.length - 1];
  }
  return out;
}

function nestingDepth(poly, others) {
  let d = 0;
  const pt = poly.pts[0];
  for (const o of others) {
    if (o === poly || !o.closed) continue;
    if (pointInPoly(pt, o.pts)) d++;
  }
  return d;
}

function applyKerf(paths, kerf) {
  if (!kerf) return paths;
  const out = [];
  const closed = paths.filter(p => p.closed);
  for (const p of paths) {
    if (!p.closed) { out.push(p); continue; }
    const depth = nestingDepth(p, closed);
    const inward = (depth & 1) === 1;
    const d = inward ? -Math.abs(kerf) : Math.abs(kerf);
    const area = polyArea(p.pts);
    const or = area > 0 ? p.pts : p.pts.slice().reverse();
    const res = offsetPolys([or], d, 'round');
    for (const r of res) out.push({ ...p, pts: r });
  }
  return out;
}

function addTabs(paths, cfg) {
  if (!cfg || !cfg.enabled) return paths;
  const out = [];
  for (const p of paths) {
    if (!p.closed || p.pts.length < 4) { out.push(p); continue; }
    let len = 0;
    for (let i = 1; i < p.pts.length; i++) len += V.dist(p.pts[i - 1], p.pts[i]);
    len += V.dist(p.pts[p.pts.length - 1], p.pts[0]);
    if (cfg.skipSmall && len < cfg.size * cfg.count * 4) { out.push(p); continue; }
    const gaps = [];
    for (let i = 0; i < cfg.count; i++) gaps.push((i + 0.5) * len / cfg.count);
    // Kontur in Segmente zerlegen, an Lückenpositionen unterbrechen
    const ring = p.pts.concat([p.pts[0]]);
    let acc = 0, gi = 0, cur = [ring[0]];
    for (let i = 1; i < ring.length; i++) {
      let a = ring[i - 1], b = ring[i];
      let segLen = V.dist(a, b);
      let pos = 0;
      while (gi < gaps.length && acc + segLen >= gaps[gi] - cfg.size / 2) {
        const gStart = gaps[gi] - cfg.size / 2, gEnd = gaps[gi] + cfg.size / 2;
        if (acc + segLen < gStart) break;
        const t0 = Math.max(0, (gStart - acc) / segLen);
        const t1 = Math.min(1, (gEnd - acc) / segLen);
        if (t0 > pos) cur.push(V.lerp(a, b, t0));
        if (cur.length > 1) out.push({ ...p, closed: false, pts: cur });
        cur = [V.lerp(a, b, t1)];
        pos = t1;
        if (gEnd <= acc + segLen) gi++; else break;
      }
      if (pos < 1) cur.push(b);
      acc += segLen;
    }
    if (cur.length > 1) out.push({ ...p, closed: false, pts: cur });
  }
  return out;
}

export function buildJob(doc, ctx, opts = {}) {
  const ops = [];   // {pts, closed, speed, power, minPower, layer, kind, dot}
  const layers = doc.layers.slice().sort((a, b) => a.priority - b.priority);
  let cursor = { x: 0, y: 0 };
  for (const L of layers) {
    if (!L.output || L.isTool) continue;
    const geo = layerGeometry(doc, L, ctx, opts.only);
    if (!geo.length) continue;
    const images = geo.filter(g => g.image);
    const vec = geo.filter(g => !g.image);
    const closedPolys = vec.filter(p => p.closed).map(p => p.pts);

    for (let pass = 0; pass < Math.max(1, L.passes); pass++) {
      const zoff = (L.zOffset || 0) + pass * (L.zStep || 0);
      const mkOp = (o) => ({
        speed: L.speed, power: L.maxPower, minPower: L.minPower,
        layer: L.index, layerRef: L, z: zoff, pass, ...o
      });

      // --- Füllung / Gravur ---
      if (L.mode === 'fill' || L.mode === 'fill+line') {
        if (closedPolys.length) {
          const angles = L.crosshatch ? [L.angle, L.angle + 90] : [L.angle];
          for (const angDeg of angles) {
            const b = boxFromPts([].concat(...closedPolys));
            const ov = (L.overscan || 0) / 100 * (L.speed * L.speed) / (2 * (doc.machine.accelX || 3000));
            const lines = scanFill(closedPolys, L.interval, angDeg * Math.PI / 180, {
              overscan: Math.min(20, ov), bidir: L.bidir
            });
            for (const ln of lines) ops.push(mkOp({ pts: ln.pts, closed: false, kind: 'fill' }));
          }
        }
      }
      // --- Bild-Gravur ---
      for (const g of images) {
        const lines = imageScanLines({ ...g.image, worldMat: g.worldMat }, L, doc, ctx);
        for (const ln of lines) ops.push(mkOp({ pts: ln.pts, closed: false, kind: 'raster', power: ln.power, minPower: 0, raster: ln.cells, lead: ln.lead }));
      }
      // --- Offset-Füllung ---
      if (L.mode === 'offset') {
        let cur = closedPolys.map(p => p.slice());
        let n = 0;
        const step = L.interval;
        while (cur.length && (L.offsetCount === 0 || n < L.offsetCount) && n < 2000) {
          for (const p of cur) ops.push(mkOp({ pts: p, closed: true, kind: 'offset' }));
          cur = offsetPolys(cur, -step, 'round').filter(p => p.length >= 3 && Math.abs(polyArea(p)) > step * step);
          n++;
        }
      }
      // --- Linie / Schnitt ---
      if (L.mode === 'line' || L.mode === 'fill+line') {
        // entartete Reste (Punkte / Mikro-Segmente) verwerfen: sie brennen
        // sonst als Punkt mit voller Leistung ins Material
        let paths = vec.map(p => ({ pts: p.pts, closed: p.closed })).filter(p => {
          if (p.pts.length < 2) return false;
          let len = 0;
          for (let i = 1; i < p.pts.length; i++) len += V.dist(p.pts[i - 1], p.pts[i]);
          if (p.closed) len += V.dist(p.pts[p.pts.length - 1], p.pts[0]);
          return len > 0.02;
        });
        paths = applyKerf(paths, L.kerf);
        paths = addTabs(paths, L.tabs);
        const closedRef = paths.filter(p => p.closed);
        const withDepth = paths.map(p => ({ p, d: p.closed ? nestingDepth(p, closedRef) : -1 }));
        const maxD = Math.max(0, ...withDepth.map(w => w.d));
        let ordered = [];
        for (let d = maxD; d >= -1; d--) {
          const grp = withDepth.filter(w => w.d === d).map(w => w.p);
          if (!grp.length) continue;
          ordered = ordered.concat(nnOrder(grp, cursor));
          if (ordered.length) {
            const last = ordered[ordered.length - 1];
            cursor = last.closed ? last.pts[0] : last.pts[last.pts.length - 1];
          }
        }
        for (const p of ordered) ops.push(mkOp({ pts: p.pts, closed: p.closed, kind: 'line' }));
      }
    }
  }
  // globale Reihenfolge-Optimierung innerhalb gleicher Ebene+Art bleibt erhalten
  return ops;
}

export function jobBounds(ops) {
  const b = { x0: Infinity, y0: Infinity, x1: -Infinity, y1: -Infinity };
  for (const o of ops) for (const p of o.pts) {
    if (p.x < b.x0) b.x0 = p.x; if (p.y < b.y0) b.y0 = p.y;
    if (p.x > b.x1) b.x1 = p.x; if (p.y > b.y1) b.y1 = p.y;
  }
  return b;
}
