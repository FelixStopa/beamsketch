// dxf.js — DXF-Import (ASCII): LINE, LWPOLYLINE, POLYLINE, CIRCLE, ARC, ELLIPSE, SPLINE, INSERT, TEXT
import { Mat, arcToCubics } from './geom.js';
import { Shape, nodeSub } from './doc.js';
import { loc } from './i18n.js';

function pairs(text) {
  const lines = text.split(/\r\n|\r|\n/);
  const out = [];
  for (let i = 0; i + 1 < lines.length; i += 2) {
    const c = parseInt(lines[i].trim(), 10);
    if (isNaN(c)) continue;
    out.push([c, lines[i + 1]]);
  }
  return out;
}

function groupEntities(pr, from, to) {
  const ents = [];
  let cur = null;
  for (let i = from; i < to; i++) {
    const [c, v] = pr[i];
    if (c === 0) {
      if (cur) ents.push(cur);
      cur = { type: v.trim(), data: [] };
    } else if (cur) cur.data.push([c, v]);
  }
  if (cur) ents.push(cur);
  return ents;
}
function g(e, code, def) {
  for (const [c, v] of e.data) if (c === code) return v.trim();
  return def;
}
function gn(e, code, def = 0) { const v = g(e, code); return v === undefined ? def : (parseFloat(v) || 0); }
function gall(e, code) { const r = []; for (const [c, v] of e.data) if (c === code) r.push(v.trim()); return r; }

function bulgeArc(p0, p1, bulge) {
  // Bulge = tan(theta/4)
  const theta = 4 * Math.atan(bulge);
  const d = Math.hypot(p1.x - p0.x, p1.y - p0.y);
  if (d < 1e-12) return null;
  const r = d / (2 * Math.sin(Math.abs(theta) / 2));
  const mid = { x: (p0.x + p1.x) / 2, y: (p0.y + p1.y) / 2 };
  const h = r * Math.cos(theta / 2);
  const nx = -(p1.y - p0.y) / d, ny = (p1.x - p0.x) / d;
  const s = bulge > 0 ? 1 : -1;
  const cx = mid.x - nx * h * s * (theta > 0 ? 1 : 1);
  const cy = mid.y - ny * h * s;
  const a0 = Math.atan2(p0.y - cy, p0.x - cx);
  const a1 = a0 + theta;
  return arcToCubics(cx, cy, r, r, 0, a0, a1);
}

function nurbs(ctrl, knots, degree, samples = 120) {
  if (ctrl.length <= degree) return ctrl;
  const n = ctrl.length - 1;
  if (!knots || knots.length !== n + degree + 2) {
    knots = [];
    for (let i = 0; i <= n + degree + 1; i++) knots.push(i <= degree ? 0 : (i > n ? n - degree + 1 : i - degree));
  }
  const N = (i, p, u) => {
    if (p === 0) return (u >= knots[i] && u < knots[i + 1]) || (u === knots[knots.length - 1] && knots[i + 1] === u) ? 1 : 0;
    let a = 0, b = 0;
    const d1 = knots[i + p] - knots[i], d2 = knots[i + p + 1] - knots[i + 1];
    if (d1 > 1e-12) a = (u - knots[i]) / d1 * N(i, p - 1, u);
    if (d2 > 1e-12) b = (knots[i + p + 1] - u) / d2 * N(i + 1, p - 1, u);
    return a + b;
  };
  const u0 = knots[degree], u1 = knots[n + 1];
  const pts = [];
  for (let s = 0; s <= samples; s++) {
    const u = u0 + (u1 - u0) * s / samples;
    let x = 0, y = 0, wsum = 0;
    for (let i = 0; i <= n; i++) {
      const b = N(i, degree, u);
      if (b === 0) continue;
      x += ctrl[i].x * b; y += ctrl[i].y * b; wsum += b;
    }
    if (wsum > 1e-9) pts.push({ x: x / wsum, y: y / wsum });
  }
  return pts;
}

export function importDXF(text, doc, opts = {}) {
  const pr = pairs(text);
  let unitScale = 1;
  for (let i = 0; i < pr.length - 2; i++) {
    if (pr[i][0] === 9 && pr[i][1].trim() === '$INSUNITS') {
      const u = parseInt(pr[i + 2][1]);
      const map = { 1: 25.4, 2: 304.8, 4: 1, 5: 10, 6: 1000, 11: 0.0000254 };
      if (map[u]) unitScale = map[u];
    }
  }
  // Abschnitte finden
  const secStart = [], blocks = {};
  let entFrom = -1, entTo = pr.length;
  for (let i = 0; i < pr.length; i++) {
    if (pr[i][0] === 2 && pr[i][1].trim() === 'ENTITIES' && pr[i - 1] && pr[i - 1][0] === 0) entFrom = i + 1;
    if (pr[i][0] === 0 && pr[i][1].trim() === 'ENDSEC' && entFrom >= 0 && i > entFrom && entTo === pr.length) entTo = i;
  }
  // BLOCKS
  let bFrom = -1;
  for (let i = 0; i < pr.length; i++) {
    if (pr[i][0] === 2 && pr[i][1].trim() === 'BLOCKS' && pr[i - 1] && pr[i - 1][0] === 0) bFrom = i + 1;
    if (bFrom >= 0 && pr[i][0] === 0 && pr[i][1].trim() === 'ENDSEC' && i > bFrom) {
      const be = groupEntities(pr, bFrom, i);
      let cur = null;
      for (const e of be) {
        if (e.type === 'BLOCK') { cur = { name: g(e, 2, ''), bx: gn(e, 10), by: gn(e, 20), ents: [] }; blocks[cur.name] = cur; }
        else if (e.type === 'ENDBLK') cur = null;
        else if (cur) cur.ents.push(e);
      }
      break;
    }
  }
  if (entFrom < 0) throw new Error(loc('Keine ENTITIES im DXF gefunden'));
  const ents = groupEntities(pr, entFrom, entTo);
  const shapes = [];
  const layerMap = new Map();
  const layerFor = (name) => {
    if (opts.singleLayer != null) return opts.singleLayer;
    if (!layerMap.has(name)) layerMap.set(name, layerMap.size % 30);
    return layerMap.get(name);
  };
  emit(ents, Mat.scale(unitScale, unitScale), shapes, layerFor, blocks, 0);
  return { shapes, layers: [...layerMap.keys()] };
}

function emit(ents, mat, out, layerFor, blocks, depth) {
  let i = 0;
  while (i < ents.length) {
    const e = ents[i];
    const lay = layerFor(g(e, 8, '0'));
    let sh = null;
    switch (e.type) {
      case 'LINE':
        sh = Shape.path([nodeSub([{ x: gn(e, 10), y: gn(e, 20) }, { x: gn(e, 11), y: gn(e, 21) }], false)], lay);
        break;
      case 'LWPOLYLINE': {
        const xs = gall(e, 10).map(Number), ys = gall(e, 20).map(Number);
        const bulges = [];
        let vi = -1;
        for (const [c, v] of e.data) { if (c === 10) vi++; if (c === 42) bulges[vi] = parseFloat(v); }
        const closed = (gn(e, 70) & 1) === 1;
        const nodes = [];
        for (let k = 0; k < xs.length; k++) nodes.push({ x: xs[k], y: ys[k], in: null, out: null });
        const sp = { closed, nodes };
        applyBulges(sp, bulges);
        if (nodes.length > 1) sh = Shape.path([sp], lay);
        break;
      }
      case 'POLYLINE': {
        const nodes = []; const bulges = [];
        let j = i + 1;
        while (j < ents.length && ents[j].type === 'VERTEX') {
          nodes.push({ x: gn(ents[j], 10), y: gn(ents[j], 20), in: null, out: null });
          bulges.push(gn(ents[j], 42, 0));
          j++;
        }
        if (j < ents.length && ents[j].type === 'SEQEND') j++;
        const closed = (gn(e, 70) & 1) === 1;
        const sp = { closed, nodes };
        applyBulges(sp, bulges);
        if (nodes.length > 1) sh = Shape.path([sp], lay);
        i = j - 1;
        break;
      }
      case 'CIRCLE': {
        sh = Shape.ellipse(0, 0, gn(e, 40), gn(e, 40), lay);
        sh.transform = Mat.translate(gn(e, 10), gn(e, 20));
        break;
      }
      case 'ARC': {
        const cs = arcToCubics(gn(e, 10), gn(e, 20), gn(e, 40), gn(e, 40), 0,
          gn(e, 50) * Math.PI / 180, normArc(gn(e, 50), gn(e, 51)) * Math.PI / 180);
        sh = Shape.path([cubicsToSub(cs, false)], lay);
        break;
      }
      case 'ELLIPSE': {
        const cx = gn(e, 10), cy = gn(e, 20);
        const mx = gn(e, 11), my = gn(e, 21);
        const ratio = gn(e, 40, 1);
        const rx = Math.hypot(mx, my), ry = rx * ratio;
        const rot = Math.atan2(my, mx);
        const a0 = gn(e, 41, 0), a1 = gn(e, 42, Math.PI * 2);
        const cs = arcToCubics(cx, cy, rx, ry, rot, a0, a1);
        sh = Shape.path([cubicsToSub(cs, Math.abs(a1 - a0) >= Math.PI * 2 - 1e-6)], lay);
        break;
      }
      case 'SPLINE': {
        const xs = gall(e, 10).map(Number), ys = gall(e, 20).map(Number);
        const fx = gall(e, 11).map(Number), fy = gall(e, 21).map(Number);
        const knots = gall(e, 40).map(Number);
        const deg = gn(e, 71, 3);
        const closed = (gn(e, 70) & 1) === 1;
        let pts;
        if (xs.length > deg) pts = nurbs(xs.map((x, k) => ({ x, y: ys[k] })), knots, deg);
        else if (fx.length) pts = fx.map((x, k) => ({ x, y: fy[k] }));
        if (pts && pts.length > 1) sh = Shape.path([nodeSub(pts, closed)], lay);
        break;
      }
      case 'POINT': break;
      case 'TEXT': case 'MTEXT': {
        const t = (g(e, 1, '') || '').replace(/\\P/g, '\n').replace(/\\[A-Za-z][^;]*;/g, '');
        if (t) {
          sh = Shape.text(0, 0, t, lay);
          sh.size = gn(e, 40, 5) || 5;
          sh.transform = Mat.translate(gn(e, 10), gn(e, 20));
        }
        break;
      }
      case 'INSERT': {
        if (depth > 8) break;
        const name = g(e, 2, '');
        const blk = blocks[name];
        if (blk) {
          const sx = gn(e, 41, 1) || 1, sy = gn(e, 42, 1) || 1;
          const rot = gn(e, 50, 0) * Math.PI / 180;
          const m = Mat.mul(Mat.mul(Mat.mul(Mat.translate(-blk.bx, -blk.by), Mat.scale(sx, sy)), Mat.rotate(rot)),
            Mat.translate(gn(e, 10), gn(e, 20)));
          const kids = [];
          emit(blk.ents, Mat.id(), kids, layerFor, blocks, depth + 1);
          if (kids.length) { const gr = Shape.group(kids, lay); gr.transform = m; sh = gr; }
        }
        break;
      }
    }
    if (sh) {
      sh.transform = Mat.mul(sh.transform, mat);
      out.push(sh);
    }
    i++;
  }
}
function normArc(a0, a1) { let x = a1; while (x <= a0) x += 360; return x; }
function applyBulges(sp, bulges) {
  if (!bulges || !bulges.some(b => b)) return;
  const nodes = sp.nodes;
  const res = [];
  const n = nodes.length;
  const cnt = sp.closed ? n : n - 1;
  for (let k = 0; k < cnt; k++) {
    const a = nodes[k], b = nodes[(k + 1) % n];
    const bl = bulges[k] || 0;
    if (!res.length) res.push({ x: a.x, y: a.y, in: null, out: null });
    if (Math.abs(bl) > 1e-9) {
      const cs = bulgeArc(a, b, bl);
      if (cs) {
        for (const c of cs) {
          res[res.length - 1].out = c.c1;
          res.push({ x: c.p3.x, y: c.p3.y, in: c.c2, out: null });
        }
        continue;
      }
    }
    res.push({ x: b.x, y: b.y, in: null, out: null });
  }
  if (sp.closed && res.length > 1) {
    const f = res[0], l = res[res.length - 1];
    if (Math.hypot(f.x - l.x, f.y - l.y) < 1e-9) { f.in = l.in; res.pop(); }
  }
  sp.nodes = res;
}
function cubicsToSub(cs, closed) {
  const nodes = [];
  for (let i = 0; i < cs.length; i++) {
    if (!nodes.length) nodes.push({ x: cs[i].p0.x, y: cs[i].p0.y, in: null, out: null });
    nodes[nodes.length - 1].out = cs[i].c1;
    nodes.push({ x: cs[i].p3.x, y: cs[i].p3.y, in: cs[i].c2, out: null });
  }
  if (closed && nodes.length > 1) {
    const f = nodes[0], l = nodes[nodes.length - 1];
    if (Math.hypot(f.x - l.x, f.y - l.y) < 1e-6) { f.in = l.in; nodes.pop(); }
  }
  return { closed, nodes };
}
