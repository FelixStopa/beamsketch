// geom.js — Matrizen, Bezier, Polygon-Boolean, Offset, Fill-Scanlines
export const EPS = 1e-9;
export const SNAP = 1e-7;

/* ---------------- Matrix [a,b,c,d,e,f] ---------------- */
export const Mat = {
  id: () => [1, 0, 0, 1, 0, 0],
  mul(m, n) { // m dann n?  -> gibt n∘m (erst m, dann n)
    return [
      m[0] * n[0] + m[1] * n[2], m[0] * n[1] + m[1] * n[3],
      m[2] * n[0] + m[3] * n[2], m[2] * n[1] + m[3] * n[3],
      m[4] * n[0] + m[5] * n[2] + n[4], m[4] * n[1] + m[5] * n[3] + n[5]
    ];
  },
  apply(m, p) { return { x: m[0] * p.x + m[2] * p.y + m[4], y: m[1] * p.x + m[3] * p.y + m[5] }; },
  applyV(m, p) { return { x: m[0] * p.x + m[2] * p.y, y: m[1] * p.x + m[3] * p.y }; },
  translate(x, y) { return [1, 0, 0, 1, x, y]; },
  scale(x, y) { return [x, 0, 0, y === undefined ? x : y, 0, 0]; },
  rotate(a) { const c = Math.cos(a), s = Math.sin(a); return [c, s, -s, c, 0, 0]; },
  invert(m) {
    const det = m[0] * m[3] - m[1] * m[2];
    if (Math.abs(det) < 1e-14) return Mat.id();
    return [m[3] / det, -m[1] / det, -m[2] / det, m[0] / det,
      (m[2] * m[5] - m[3] * m[4]) / det, (m[1] * m[4] - m[0] * m[5]) / det];
  },
  aroundPoint(m, cx, cy) { return Mat.mul(Mat.mul(Mat.translate(-cx, -cy), m), Mat.translate(cx, cy)); },
  scaleFactor(m) { return Math.sqrt(Math.abs(m[0] * m[3] - m[1] * m[2])) || 1; },
  decompose(m) {
    const rot = Math.atan2(m[1], m[0]);
    const sx = Math.hypot(m[0], m[1]);
    const sy = (m[0] * m[3] - m[1] * m[2]) / (sx || 1);
    return { x: m[4], y: m[5], rot, sx, sy };
  }
};

/* ---------------- Vektoren ---------------- */
export const V = {
  add: (a, b) => ({ x: a.x + b.x, y: a.y + b.y }),
  sub: (a, b) => ({ x: a.x - b.x, y: a.y - b.y }),
  mul: (a, s) => ({ x: a.x * s, y: a.y * s }),
  len: a => Math.hypot(a.x, a.y),
  dist: (a, b) => Math.hypot(a.x - b.x, a.y - b.y),
  dist2: (a, b) => (a.x - b.x) ** 2 + (a.y - b.y) ** 2,
  norm(a) { const l = Math.hypot(a.x, a.y) || 1; return { x: a.x / l, y: a.y / l }; },
  perp: a => ({ x: -a.y, y: a.x }),
  dot: (a, b) => a.x * b.x + a.y * b.y,
  cross: (a, b) => a.x * b.y - a.y * b.x,
  lerp: (a, b, t) => ({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t })
};

/* ---------------- BBox ---------------- */
export function emptyBox() { return { x0: Infinity, y0: Infinity, x1: -Infinity, y1: -Infinity }; }
export function growBox(b, p) { if (p.x < b.x0) b.x0 = p.x; if (p.y < b.y0) b.y0 = p.y; if (p.x > b.x1) b.x1 = p.x; if (p.y > b.y1) b.y1 = p.y; return b; }
export function mergeBox(a, b) { return { x0: Math.min(a.x0, b.x0), y0: Math.min(a.y0, b.y0), x1: Math.max(a.x1, b.x1), y1: Math.max(a.y1, b.y1) }; }
export function boxValid(b) { return b && b.x1 >= b.x0 && b.y1 >= b.y0 && isFinite(b.x0); }
export function boxW(b) { return b.x1 - b.x0; }
export function boxH(b) { return b.y1 - b.y0; }
export function boxCenter(b) { return { x: (b.x0 + b.x1) / 2, y: (b.y0 + b.y1) / 2 }; }
export function boxIntersects(a, b) { return !(a.x1 < b.x0 || b.x1 < a.x0 || a.y1 < b.y0 || b.y1 < a.y0); }
export function boxContains(a, b) { return a.x0 <= b.x0 && a.y0 <= b.y0 && a.x1 >= b.x1 && a.y1 >= b.y1; }
export function boxFromPts(pts) { const b = emptyBox(); for (const p of pts) growBox(b, p); return b; }

/* ---------------- Bezier ---------------- */
export function cubicAt(p0, p1, p2, p3, t) {
  const mt = 1 - t, a = mt * mt * mt, b = 3 * mt * mt * t, c = 3 * mt * t * t, d = t * t * t;
  return { x: a * p0.x + b * p1.x + c * p2.x + d * p3.x, y: a * p0.y + b * p1.y + c * p2.y + d * p3.y };
}
export function cubicDeriv(p0, p1, p2, p3, t) {
  const mt = 1 - t;
  return {
    x: 3 * mt * mt * (p1.x - p0.x) + 6 * mt * t * (p2.x - p1.x) + 3 * t * t * (p3.x - p2.x),
    y: 3 * mt * mt * (p1.y - p0.y) + 6 * mt * t * (p2.y - p1.y) + 3 * t * t * (p3.y - p2.y)
  };
}
// adaptive Unterteilung nach Flachheitskriterium
export function flattenCubic(p0, p1, p2, p3, tol, out) {
  const stack = [[p0, p1, p2, p3, 0]];
  while (stack.length) {
    const [a, b, c, d, depth] = stack.pop();
    const dx = d.x - a.x, dy = d.y - a.y;
    let d1 = Math.abs((b.x - d.x) * dy - (b.y - d.y) * dx);
    let d2 = Math.abs((c.x - d.x) * dy - (c.y - d.y) * dx);
    const dd = (d1 + d2) ** 2;
    if (depth > 18 || dd <= tol * (dx * dx + dy * dy) || (Math.abs(dx) < EPS && Math.abs(dy) < EPS && V.dist(a, b) < tol)) {
      out.push({ x: d.x, y: d.y });
    } else {
      const ab = V.lerp(a, b, .5), bc = V.lerp(b, c, .5), cd = V.lerp(c, d, .5);
      const abc = V.lerp(ab, bc, .5), bcd = V.lerp(bc, cd, .5), m = V.lerp(abc, bcd, .5);
      stack.push([m, bcd, cd, d, depth + 1]);
      stack.push([a, ab, abc, m, depth + 1]);
    }
  }
}
export function cubicBBox(p0, p1, p2, p3) {
  const b = emptyBox(); growBox(b, p0); growBox(b, p3);
  for (const ax of ['x', 'y']) {
    const a = -p0[ax] + 3 * p1[ax] - 3 * p2[ax] + p3[ax];
    const bb = 2 * (p0[ax] - 2 * p1[ax] + p2[ax]);
    const c = p1[ax] - p0[ax];
    let ts = [];
    if (Math.abs(a) < 1e-12) { if (Math.abs(bb) > 1e-12) ts.push(-c / bb); }
    else { const disc = bb * bb - 4 * a * c; if (disc >= 0) { const s = Math.sqrt(disc); ts.push((-bb + s) / (2 * a), (-bb - s) / (2 * a)); } }
    for (const t of ts) if (t > 0 && t < 1) growBox(b, cubicAt(p0, p1, p2, p3, t));
  }
  return b;
}
// Kreisbogen -> Beziers
export function arcToCubics(cx, cy, rx, ry, rot, a0, a1) {
  const out = []; let sweep = a1 - a0;
  const n = Math.max(1, Math.ceil(Math.abs(sweep) / (Math.PI / 2)));
  const da = sweep / n; const k = 4 / 3 * Math.tan(da / 4);
  const cosR = Math.cos(rot), sinR = Math.sin(rot);
  const xf = p => ({ x: cx + p.x * rx * cosR - p.y * ry * sinR, y: cy + p.x * rx * sinR + p.y * ry * cosR });
  let ang = a0;
  for (let i = 0; i < n; i++) {
    const b = ang + da;
    const p0 = { x: Math.cos(ang), y: Math.sin(ang) }, p3 = { x: Math.cos(b), y: Math.sin(b) };
    const c1 = { x: p0.x - k * Math.sin(ang), y: p0.y + k * Math.cos(ang) };
    const c2 = { x: p3.x + k * Math.sin(b), y: p3.y - k * Math.cos(b) };
    out.push({ p0: xf(p0), c1: xf(c1), c2: xf(c2), p3: xf(p3) });
    ang = b;
  }
  return out;
}

/* ---------------- Polygone ---------------- */
export function polyArea(p) {
  let a = 0;
  for (let i = 0, j = p.length - 1; i < p.length; j = i++) a += (p[j].x * p[i].y - p[i].x * p[j].y);
  return a / 2;
}
export function polyLength(p, closed = true) {
  let l = 0;
  for (let i = 1; i < p.length; i++) l += V.dist(p[i - 1], p[i]);
  if (closed && p.length > 1) l += V.dist(p[p.length - 1], p[0]);
  return l;
}
export function pointInPoly(pt, poly) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i], b = poly[j];
    if ((a.y > pt.y) !== (b.y > pt.y)) {
      const x = (b.x - a.x) * (pt.y - a.y) / (b.y - a.y) + a.x;
      if (pt.x < x) inside = !inside;
    }
  }
  return inside;
}
// Even-odd über Polygonmenge
// Umlaufzahl eines geschlossenen Linienzugs um pt (optional ohne Kante skip)
export function windingNumber(pt, poly, skip = -1) {
  let w = 0;
  for (let i = 0, n = poly.length; i < n; i++) {
    if (i === skip) continue;
    const a = poly[i], b = poly[(i + 1) % n];
    if (a.y <= pt.y) {
      if (b.y > pt.y && V.cross(V.sub(b, a), V.sub(pt, a)) > 0) w++;
    } else if (b.y <= pt.y && V.cross(V.sub(b, a), V.sub(pt, a)) < 0) w--;
  }
  return w;
}
export function pointInPolys(pt, polys) {
  let n = 0;
  for (const p of polys) if (pointInPoly(pt, p)) n++;
  return (n & 1) === 1;
}
export function distToSeg(p, a, b) {
  const dx = b.x - a.x, dy = b.y - a.y;
  const l2 = dx * dx + dy * dy;
  let t = l2 ? ((p.x - a.x) * dx + (p.y - a.y) * dy) / l2 : 0;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
}
export function distToPoly(p, poly, closed = true) {
  let d = Infinity;
  const n = poly.length;
  for (let i = 0; i < (closed ? n : n - 1); i++) {
    d = Math.min(d, distToSeg(p, poly[i], poly[(i + 1) % n]));
    if (d < 1e-9) break;
  }
  return d;
}
export function cleanPoly(p, tol = 1e-6) {
  const out = [];
  for (const q of p) if (!out.length || V.dist(out[out.length - 1], q) > tol) out.push(q);
  while (out.length > 1 && V.dist(out[0], out[out.length - 1]) <= tol) out.pop();
  return out;
}
export function reverse(p) { return p.slice().reverse(); }
export function ensureCCW(p) { return polyArea(p) < 0 ? reverse(p) : p; }
export function ensureCW(p) { return polyArea(p) > 0 ? reverse(p) : p; }

/* ---------------- Segment-Schnitt ---------------- */
export function segInt(a, b, c, d) {
  const r = V.sub(b, a), s = V.sub(d, c);
  const den = V.cross(r, s);
  const qp = V.sub(c, a);
  if (Math.abs(den) < 1e-13) return null; // parallel / kollinear
  const t = V.cross(qp, s) / den;
  const u = V.cross(qp, r) / den;
  if (t < -1e-12 || t > 1 + 1e-12 || u < -1e-12 || u > 1 + 1e-12) return null;
  return { t: Math.min(1, Math.max(0, t)), u: Math.min(1, Math.max(0, u)), p: { x: a.x + r.x * t, y: a.y + r.y * t } };
}

/* ---------------- Boolean-Operationen -------------
   Ansatz: alle Kanten an Schnittpunkten teilen, Kanten anhand des
   Mittelpunkt-Innen-Tests klassifizieren, gewünschte Kanten behalten und
   zu Schleifen zusammensetzen. Robust genug für CAD-artige Eingaben.
---------------------------------------------------*/
// Kanten an den Schnittpunkten teilen. Beide Kanten eines Schnitts bekommen
// denselben Punkt, damit die Teilstücke beim Zusammensetzen exakt aneinanderpassen.
function splitAtCuts(edges, cuts) {
  const out = [];
  for (let i = 0; i < edges.length; i++) {
    const { a, b } = edges[i];
    const cs = [{ t: 0, p: a }, ...cuts[i].filter(c => c.t > 1e-9 && c.t < 1 - 1e-9).sort((x, y) => x.t - y.t), { t: 1, p: b }];
    for (let k = 1; k < cs.length; k++) {
      if (cs[k].t - cs[k - 1].t < 1e-9) continue;
      out.push({ a: cs[k - 1].p, b: cs[k].p, src: i });
    }
  }
  return out;
}
function splitEdges(polysA, polysB) {
  const edgesOf = polys => {
    const e = [];
    for (const poly of polys) {
      const n = poly.length;
      for (let i = 0; i < n; i++) e.push({ a: poly[i], b: poly[(i + 1) % n] });
    }
    return e;
  };
  const ea = edgesOf(polysA), eb = edgesOf(polysB);
  const cutsA = ea.map(() => []), cutsB = eb.map(() => []);
  for (let i = 0; i < ea.length; i++) {
    for (let j = 0; j < eb.length; j++) {
      const x = segInt(ea[i].a, ea[i].b, eb[j].a, eb[j].b);
      if (x) { cutsA[i].push({ t: x.t, p: x.p }); cutsB[j].push({ t: x.u, p: x.p }); }
    }
  }
  return [splitAtCuts(ea, cutsA), splitAtCuts(eb, cutsB)];
}

function key(p) { return Math.round(p.x / 1e-6) + ',' + Math.round(p.y / 1e-6); }

function stitch(edges) {
  const map = new Map();
  edges.forEach((e, i) => {
    const k = key(e.a);
    if (!map.has(k)) map.set(k, []);
    map.get(k).push(i);
  });
  const used = new Array(edges.length).fill(false);
  const loops = [];
  const emit = pts => {
    const cl = cleanPoly(pts);
    if (cl.length >= 3 && Math.abs(polyArea(cl)) > 1e-9) loops.push(cl);
  };
  for (let i = 0; i < edges.length; i++) {
    if (used[i]) continue;
    // Kette ablaufen. Erreicht sie einen Knoten, den sie schon besucht hat,
    // wird der Kreis dort als Schleife abgetrennt – so entstehen an Berührungs-
    // punkten keine offenen Reststücke, die später quer geschlossen würden.
    const pts = [], seenAt = new Map();
    let cur = i;
    while (cur !== -1) {
      used[cur] = true;
      const ka = key(edges[cur].a);
      if (seenAt.has(ka)) {
        const k0 = seenAt.get(ka);
        emit(pts.slice(k0));
        for (let k = k0; k < pts.length; k++) seenAt.delete(key(pts[k]));
        pts.length = k0;
      }
      seenAt.set(ka, pts.length);
      pts.push(edges[cur].a);
      const endK = key(edges[cur].b);
      const cands = (map.get(endK) || []).filter(j => !used[j]);
      if (!cands.length) {
        // geschlossen, wenn das Ende auf einen Knoten der Kette trifft;
        // offene Reste sind keine gültige Kontur und werden verworfen
        if (seenAt.has(endK)) emit(pts.slice(seenAt.get(endK)));
        break;
      }
      if (cands.length === 1) { cur = cands[0]; continue; }
      // mehrdeutig: schärfste Linkskurve wählen (hält Außenkonturen zusammen)
      const dIn = V.norm(V.sub(edges[cur].b, edges[cur].a));
      let best = cands[0], bestAng = -Infinity;
      for (const j of cands) {
        const dOut = V.norm(V.sub(edges[j].b, edges[j].a));
        const ang = Math.atan2(V.cross(dIn, dOut), V.dot(dIn, dOut));
        if (ang > bestAng) { bestAng = ang; best = j; }
      }
      cur = best;
    }
  }
  return loops;
}

function orientPolys(polys) {
  return polys.map(p => (nestDepth(p, polys) & 1) ? ensureCW(p) : ensureCCW(p));
}

export function boolOp(polysA, polysB, op) {
  polysA = polysA.map(p => cleanPoly(p)).filter(p => p.length >= 3);
  polysB = polysB.map(p => cleanPoly(p)).filter(p => p.length >= 3);
  if (!polysA.length) return op === 'union' ? polysB.slice() : [];
  if (!polysB.length) return (op === 'intersect') ? [] : polysA.slice();
  // Einheitlicher Umlaufsinn (Außenkontur CCW, Loch CW). Sonst laufen die
  // behaltenen Kanten von A und B gegeneinander, lassen sich nicht zu
  // Schleifen verbinden und es entstehen wirre Verbindungslinien.
  polysA = orientPolys(polysA);
  polysB = orientPolys(polysB);
  const [ea, eb] = splitEdges(polysA, polysB);
  const mid = e => V.lerp(e.a, e.b, .5);
  const keep = [];
  for (const e of ea) {
    const inB = pointInPolys(mid(e), polysB);
    if (op === 'union' && !inB) keep.push(e);
    if (op === 'intersect' && inB) keep.push(e);
    if (op === 'subtract' && !inB) keep.push(e);
    if (op === 'xor') keep.push(inB ? { a: e.b, b: e.a } : e);
  }
  for (const e of eb) {
    const inA = pointInPolys(mid(e), polysA);
    if (op === 'union' && !inA) keep.push(e);
    if (op === 'intersect' && inA) keep.push(e);
    if (op === 'subtract' && inA) keep.push({ a: e.b, b: e.a });
    if (op === 'xor') keep.push(inA ? { a: e.b, b: e.a } : e);
  }
  // Duplikate (überlappende Kanten) entfernen
  const seen = new Set(), uniq = [];
  for (const e of keep) {
    const k = key(e.a) + '|' + key(e.b);
    const rk = key(e.b) + '|' + key(e.a);
    if (seen.has(k) || seen.has(rk)) continue;
    seen.add(k); uniq.push(e);
  }
  return stitch(uniq);
}

/* ---------------- Offset ---------------- */
export function offsetPoly(poly, delta, join = 'round', arcTol = 0.05) {
  poly = cleanPoly(poly);
  if (poly.length < 3) return [];
  const ccw = polyArea(poly) > 0;
  const p = ccw ? poly : reverse(poly);
  const d = ccw ? delta : -delta;
  const n = p.length;
  const raw = [];
  for (let i = 0; i < n; i++) {
    const a = p[i], b = p[(i + 1) % n], c = p[(i + 2) % n];
    const n1 = V.mul(V.perp(V.norm(V.sub(b, a))), -1); // Außennormale bei CCW
    const n2 = V.mul(V.perp(V.norm(V.sub(c, b))), -1);
    raw.push({ x: a.x + n1.x * d, y: a.y + n1.y * d });
    raw.push({ x: b.x + n1.x * d, y: b.y + n1.y * d });
    const cr = V.cross(V.sub(b, a), V.sub(c, b));
    const convex = (cr > 0); // Linkskurve bei CCW = konvex
    if (convex && d > 0 || !convex && d < 0) {
      // Rundung einfügen
      const a0 = Math.atan2(n1.y, n1.x), a1 = Math.atan2(n2.y, n2.x);
      let sweep = a1 - a0;
      while (sweep > Math.PI) sweep -= 2 * Math.PI;
      while (sweep < -Math.PI) sweep += 2 * Math.PI;
      const r = Math.abs(d);
      const steps = join === 'miter' ? 1 : Math.max(1, Math.ceil(Math.abs(sweep) / Math.acos(Math.max(-1, 1 - arcTol / Math.max(r, .01)))));
      for (let s = 1; s < steps; s++) {
        const ang = a0 + sweep * (s / steps);
        raw.push({ x: b.x + Math.cos(ang) * d, y: b.y + Math.sin(ang) * d });
      }
    }
  }
  // Selbstschnitte auflösen: Kanten teilen, ungültige Punkte verwerfen, neu verbinden
  const edges = [];
  for (let i = 0; i < raw.length; i++) edges.push({ a: raw[i], b: raw[(i + 1) % raw.length] });
  const cuts = edges.map(() => []);
  for (let i = 0; i < edges.length; i++)
    for (let j = i + 2; j < edges.length; j++) {
      if (i === 0 && j === edges.length - 1) continue;
      const x = segInt(edges[i].a, edges[i].b, edges[j].a, edges[j].b);
      if (x) { cuts[i].push({ t: x.t, p: x.p }); cuts[j].push({ t: x.u, p: x.p }); }
    }
  const split = splitAtCuts(edges, cuts);
  // Sehnen-Mittelpunkte der Bogen-Approximation liegen leicht innerhalb des
  // Soll-Abstands -> Toleranz in Höhe der Bogentoleranz zulassen.
  const lim = Math.abs(d) - Math.max(arcTol, 1e-3) - Math.abs(d) * 1e-3;
  // Kanten nach Umlaufzahl der Rohkontur auswählen: behalten wird der Rand des
  // Bereichs mit Umlaufzahl ≥ 1 (links innen, rechts außen). So bleiben die
  // Kanten an jedem Knoten paarig und die Schleifen schließen sich sauber –
  // ein Abstandstest pro Kante reißt an engen Stellen einzelne Stücke heraus.
  // Die Umlaufzahl wird exakt im Kantenmittelpunkt bestimmt, ohne die eigene
  // Ursprungskante; deren Beitrag links bzw. rechts wird direkt addiert
  // (Probepunkte neben der Kante versagen bei flach kreuzenden Linien).
  // Dazu wird so gedreht, dass die Kante senkrecht nach oben zeigt: links
  // von ihr ist die Umlaufzahl dann w + 1, rechts w.
  const valid = split.filter(e => {
    const dir = V.norm(V.sub(e.b, e.a));
    if (!(Math.abs(dir.x) + Math.abs(dir.y) > 0)) return false;
    const m = V.lerp(e.a, e.b, .5);
    const rot = q => { const r = V.sub(q, m); return { x: dir.y * r.x - dir.x * r.y, y: V.dot(r, dir) }; };
    return windingNumber({ x: 0, y: 0 }, raw.map(rot), e.src) === 0;
  });
  let loops = stitch(valid);
  loops = loops.filter(l => Math.abs(polyArea(l)) > 1e-7);
  // Schleifen, die überwiegend näher als der Soll-Abstand an der Originalkontur
  // liegen, sind Artefakte (z. B. umgestülpte Stücke beim Offset nach innen).
  loops = loops.filter(l => {
    let ok = 0, all = 0;
    for (let i = 0; i < l.length; i++) {
      const a = l[i], b = l[(i + 1) % l.length], len = V.dist(a, b);
      all += len;
      if (distToPoly(V.lerp(a, b, .5), p) >= lim) ok += len;
    }
    return ok >= all * .5;
  });
  // Orientierung/Auswahl: nur Schleifen mit korrektem Umlaufsinn behalten
  if (d > 0) loops = loops.filter(l => polyArea(l) > 0);
  else loops = loops.filter(l => polyArea(l) > 0);
  return ccw ? loops : loops.map(reverse);
}

export function offsetPolys(polys, delta, join = 'round') {
  // äußere Konturen und Löcher getrennt behandeln (even-odd Verschachtelung)
  const withDepth = polys.map(p => ({ p, depth: nestDepth(p, polys) }));
  let out = [];
  for (const { p, depth } of withDepth) {
    const hole = (depth & 1) === 1;
    // Außenkonturen CCW, Löcher CW: offsetPoly berücksichtigt die Orientierung,
    // positives delta vergrößert dadurch immer das Material.
    const or = hole ? ensureCW(p) : ensureCCW(p);
    out = out.concat(offsetPoly(or, delta, join));
  }
  return out;
}
export function nestDepth(poly, all) {
  const pt = poly[0];
  let d = 0;
  for (const q of all) {
    if (q === poly) continue;
    if (pointInPoly(pt, q)) d++;
  }
  return d;
}

/* ---------------- Scanline-Füllung ---------------- */
export function scanFill(polys, interval, angle, opts = {}) {
  const overscan = opts.overscan || 0;
  const bidir = opts.bidir !== false;
  const ca = Math.cos(-angle), sa = Math.sin(-angle);
  const rot = p => ({ x: p.x * ca - p.y * sa, y: p.x * sa + p.y * ca });
  const unrot = p => ({ x: p.x * ca + p.y * sa, y: -p.x * sa + p.y * ca });
  const rp = polys.map(poly => poly.map(rot));
  const b = emptyBox();
  for (const poly of rp) for (const p of poly) growBox(b, p);
  if (!boxValid(b)) return [];
  const lines = [];
  let idx = 0;
  const y0 = Math.ceil(b.y0 / interval) * interval;
  for (let y = y0; y <= b.y1 + 1e-9; y += interval, idx++) {
    const xs = [];
    for (const poly of rp) {
      const n = poly.length;
      for (let i = 0; i < n; i++) {
        const a = poly[i], c = poly[(i + 1) % n];
        if ((a.y > y) !== (c.y > y)) {
          xs.push(a.x + (c.x - a.x) * (y - a.y) / (c.y - a.y));
        }
      }
    }
    if (xs.length < 2) continue;
    xs.sort((p, q) => p - q);
    const segs = [];
    for (let i = 0; i + 1 < xs.length; i += 2) {
      if (xs[i + 1] - xs[i] < 1e-6) continue;
      segs.push([xs[i], xs[i + 1]]);
    }
    if (!segs.length) continue;
    const rev = bidir && (idx & 1);
    const ordered = rev ? segs.slice().reverse() : segs;
    for (const [xa, xb] of ordered) {
      const s = rev ? xb + overscan : xa - overscan;
      const e = rev ? xa - overscan : xb + overscan;
      lines.push({
        pts: [unrot({ x: s, y }), unrot({ x: e, y })],
        lead: overscan, row: idx
      });
    }
  }
  return lines;
}
