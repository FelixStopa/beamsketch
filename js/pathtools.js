// pathtools.js — Pfad-Werkzeuge: Verzerren (Bogen, Wölbung, Fahne, Perspektive), Ecken abrunden/fasen,
// offene Pfade schließen, Pfade verbinden, Richtung umkehren, Startpunkt setzen, Trimmen.
// Arbeitet auf Pfaden mit Knoten { x, y, in, out } (in/out = absolute Kurvenpunkte oder null).

const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
const sub = (a, b) => ({ x: a.x - b.x, y: a.y - b.y });
const unit = v => { const l = Math.hypot(v.x, v.y) || 1; return { x: v.x / l, y: v.y / l }; };

/* ---------------- Verzerren ----------------
   polys: [{ pts, closed }] (Weltkoordinaten), box = Rahmen der Auswahl; amount −100 … 100 (%).
   Kanten werden vorher fein unterteilt, damit sie sich biegen. */
export function warpPolys(polys, box, mode, amount, rot90 = false, step = 0.5) {
  const W = box.x1 - box.x0, H = box.y1 - box.y0, k = amount / 100;
  const f = p => {
    // u entlang der Biegerichtung, v quer dazu (0 = unten, 1 = oben); bei 90° ist „oben" die linke Seite
    let u = (p.x - box.x0) / (W || 1), v = (p.y - box.y0) / (H || 1);
    if (rot90) { u = (p.y - box.y0) / (H || 1); v = 1 - (p.x - box.x0) / (W || 1); }
    const bow = 1 - (2 * u - 1) ** 2;                   // 0 an den Rändern, 1 in der Mitte
    const L = rot90 ? H : W, T = rot90 ? W : H;
    let du = 0, dv = 0;
    if (mode === 'arc') dv = k * L / 2 * bow;
    else if (mode === 'arcUpper') dv = k * L / 2 * bow * v;
    else if (mode === 'arcLower') dv = k * L / 2 * bow * (1 - v);
    else if (mode === 'bulge') dv = k * T / 2 * bow * (2 * v - 1);
    else if (mode === 'flag') dv = k * T / 4 * Math.sin(2 * Math.PI * u);
    else if (mode === 'perspective') du = k * (u - 0.5) * L * (v - 0.5);
    return rot90 ? { x: p.x - dv, y: p.y + du } : { x: p.x + du, y: p.y + dv };
  };
  return polys.map(pl => {
    const pts = pl.pts, out = [];
    const n = pl.closed ? pts.length : pts.length - 1;
    for (let i = 0; i < n; i++) {
      const a = pts[i], b = pts[(i + 1) % pts.length];
      const m = Math.max(1, Math.ceil(dist(a, b) / step));
      for (let s = 0; s < m; s++) out.push(f({ x: a.x + (b.x - a.x) * s / m, y: a.y + (b.y - a.y) * s / m }));
    }
    if (!pl.closed) out.push(f(pts[pts.length - 1]));
    return { pts: out, closed: pl.closed };
  });
}

/* ---------------- Ecken abrunden / fasen / nach innen runden ----------------
   sp: Subpfad { closed, nodes }; nur Ecken zwischen zwei geraden Kanten. which: Set der Knotenindizes
   (null = alle). mode: 'round' | 'chamfer' | 'inward'. Gibt die Anzahl bearbeiteter Ecken zurück. */
export function cornerSubpath(sp, r, mode = 'round', which = null) {
  const N = sp.nodes.length;
  if (N < 3) return 0;
  const out = [];
  let count = 0;
  for (let i = 0; i < N; i++) {
    const P = sp.nodes[i];
    const iA = (i - 1 + N) % N, iB = (i + 1) % N;
    const edge = !sp.closed && (i === 0 || i === N - 1);
    const A = sp.nodes[iA], B = sp.nodes[iB];
    const straight = !P.in && !P.out && !A.out && !B.in;
    if (edge || !straight || (which && !which.has(i))) { out.push({ ...P }); continue; }
    const u1 = unit(sub(A, P)), u2 = unit(sub(B, P));
    const cos = Math.max(-1, Math.min(1, u1.x * u2.x + u1.y * u2.y)), th = Math.acos(cos);
    if (th < 0.01 || th > Math.PI - 0.01) { out.push({ ...P }); continue; }
    // Abstand der Berührpunkte von der Ecke; bei zu kurzen Kanten kleiner
    let t = mode === 'chamfer' ? r : r / Math.tan(th / 2);
    const maxT = Math.min(dist(A, P), dist(B, P)) / 2;
    if (t > maxT) t = maxT;
    const rr = mode === 'chamfer' ? t : t * Math.tan(th / 2);
    const T1 = { x: P.x + u1.x * t, y: P.y + u1.y * t }, T2 = { x: P.x + u2.x * t, y: P.y + u2.y * t };
    count++;
    if (mode === 'chamfer') { out.push({ ...T1, in: null, out: null }, { ...T2, in: null, out: null }); continue; }
    if (mode === 'inward') {
      // Viertelkreis-ähnlicher Bogen um die Ecke (konkav): Mittelpunkt in der Ecke, Radius t
      const a1 = Math.atan2(u1.y, u1.x), a2 = Math.atan2(u2.y, u2.x);
      let d = a2 - a1; while (d > Math.PI) d -= 2 * Math.PI; while (d < -Math.PI) d += 2 * Math.PI;
      const steps = 8;
      for (let s = 0; s <= steps; s++) { const a = a1 + d * s / steps; out.push({ x: P.x + Math.cos(a) * t, y: P.y + Math.sin(a) * t, in: null, out: null }); }
      continue;
    }
    // Rundung als Bézierkurve (Kreisbogen-Näherung): Griff = 4/3 · tan(φ/4) · r, φ = π − θ
    const hk = 4 / 3 * Math.tan((Math.PI - th) / 4) * rr;
    out.push({ ...T1, in: null, out: { x: T1.x - u1.x * hk, y: T1.y - u1.y * hk } });
    out.push({ ...T2, in: { x: T2.x - u2.x * hk, y: T2.y - u2.y * hk }, out: null });
  }
  sp.nodes = out;
  return count;
}

/* ---------------- Offene Pfade schließen ----------------
   how: 'line' (Linie einfügen) | 'pull' (Enden zusammenziehen). Gibt die Anzahl geschlossener Subpfade zurück. */
export function closeSubpaths(subpaths, tol, how = 'line') {
  let n = 0;
  for (const sp of subpaths) {
    if (sp.closed || sp.nodes.length < 3) continue;
    const a = sp.nodes[0], b = sp.nodes[sp.nodes.length - 1];
    const d = dist(a, b);
    if (d > tol) continue;
    if (how === 'pull' || d < 1e-6) {
      const m = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
      a.x = m.x; a.y = m.y; a.in = b.in;
      sp.nodes.pop();
    }
    sp.closed = true; n++;
  }
  return n;
}

/* Subpfad umdrehen (Kurvengriffe tauschen) */
export function reverseSubpath(sp) {
  sp.nodes = sp.nodes.slice().reverse().map(n => ({ x: n.x, y: n.y, in: n.out, out: n.in }));
}

/* Startpunkt eines geschlossenen Subpfads auf Knoten i legen und festhalten (die Optimierung behält ihn) */
export function setStart(sp, i) {
  if (!sp.closed) return false;
  sp.nodes = sp.nodes.slice(i).concat(sp.nodes.slice(0, i));
  sp.fixedStart = true;
  return true;
}

/* ---------------- Verbinden ----------------
   Offene Subpfade, deren Enden höchstens tol auseinander liegen, zu Ketten verbinden; schließt, wenn sich
   Anfang und Ende treffen. subs: [{ closed, nodes }] in gemeinsamen Koordinaten. Gibt neue Liste zurück. */
export function joinSubpaths(subs, tol = 0.05) {
  const open = subs.filter(s => !s.closed).map(s => ({ closed: false, nodes: s.nodes.map(n => ({ ...n })) }));
  const done = subs.filter(s => s.closed);
  let joined = 0;
  const near = (p, q) => dist(p, q) <= tol;
  for (let changed = true; changed;) {
    changed = false;
    outer: for (let i = 0; i < open.length; i++) for (let j = 0; j < open.length; j++) {
      if (i === j) continue;
      const a = open[i], b = open[j];
      const aEnd = a.nodes[a.nodes.length - 1];
      let bn = null;
      if (near(aEnd, b.nodes[0])) bn = b.nodes;
      else if (near(aEnd, b.nodes[b.nodes.length - 1])) { reverseSubpath(b); bn = b.nodes; }
      if (!bn) continue;
      aEnd.out = bn[0].out;
      a.nodes = a.nodes.concat(bn.slice(1));
      open.splice(j, 1); joined++; changed = true;
      break outer;
    }
  }
  for (const s of open) {
    const a = s.nodes[0], b = s.nodes[s.nodes.length - 1];
    if (s.nodes.length > 2 && near(a, b)) { a.in = b.in; s.nodes.pop(); s.closed = true; }
  }
  return { subpaths: done.concat(open), joined };
}

/* ---------------- Trimmen ----------------
   Auf geglätteten Linien: das Stück von target (Polylinie), auf dem der Punkt p liegt, zwischen den nächsten
   Schnittpunkten mit allen Linien (others, auch target selbst) entfernen. Gibt die verbleibenden Stücke zurück. */
function segX(a, b, c, d) {
  const r = sub(b, a), s = sub(d, c), den = r.x * s.y - r.y * s.x;
  if (Math.abs(den) < 1e-12) return null;
  const t = ((c.x - a.x) * s.y - (c.y - a.y) * s.x) / den, u = ((c.x - a.x) * r.y - (c.y - a.y) * r.x) / den;
  return t >= -1e-9 && t <= 1 + 1e-9 && u >= -1e-9 && u <= 1 + 1e-9 ? t : null;
}
export function trimPolyline(target, others, p) {
  const pts = target.closed ? target.pts.concat([target.pts[0]]) : target.pts;
  // Bogenlänge je Punkt
  const L = [0];
  for (let i = 1; i < pts.length; i++) L.push(L[i - 1] + dist(pts[i - 1], pts[i]));
  const total = L[L.length - 1];
  // Position des Klicks
  let best = { d: Infinity, s: 0 };
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1], b = pts[i], ab = sub(b, a), l2 = ab.x * ab.x + ab.y * ab.y;
    const t = l2 ? Math.max(0, Math.min(1, ((p.x - a.x) * ab.x + (p.y - a.y) * ab.y) / l2)) : 0;
    const d = dist(p, { x: a.x + ab.x * t, y: a.y + ab.y * t });
    if (d < best.d) best = { d, s: L[i - 1] + t * (L[i] - L[i - 1]) };
  }
  // Schnittpunkte (als Bogenlänge auf target)
  const cuts = [];
  for (const o of others) {
    const q = o.closed ? o.pts.concat([o.pts[0]]) : o.pts;
    for (let i = 1; i < pts.length; i++) for (let j = 1; j < q.length; j++) {
      if (o === target && Math.abs(i - j) <= 1) continue;
      const t = segX(pts[i - 1], pts[i], q[j - 1], q[j]);
      if (t !== null) cuts.push(L[i - 1] + t * (L[i] - L[i - 1]));
    }
  }
  const sorted = [...new Set(cuts.map(c => Math.round(c * 1e6) / 1e6))].sort((a, b) => a - b).filter(c => c > 1e-6 && c < total - 1e-6);
  let s0 = 0, s1 = total;
  for (const c of sorted) { if (c <= best.s) s0 = c; else { s1 = c; break; } }
  if (target.closed && !sorted.length) return { removed: [0, total], removedPts: pts.slice(), pieces: [] };
  // Teilstück zwischen zwei Bogenlängen herausschneiden
  const at = s => { for (let i = 1; i < pts.length; i++) if (L[i] >= s - 1e-12) { const t = (s - L[i - 1]) / ((L[i] - L[i - 1]) || 1); return { x: pts[i - 1].x + (pts[i].x - pts[i - 1].x) * t, y: pts[i - 1].y + (pts[i].y - pts[i - 1].y) * t }; } return pts[pts.length - 1]; };
  const piece = (a, b) => { const out = [at(a)]; for (let i = 1; i < pts.length - 1; i++) if (L[i] > a && L[i] < b) out.push(pts[i]); out.push(at(b)); return out; };
  let pieces;
  if (target.closed) {
    // geschlossene Linie: zwischen den beiden Schnitten wird sie geöffnet
    if (best.s >= sorted[0] && best.s <= sorted[sorted.length - 1]) {
      const rest = piece(s1, total).concat(piece(0, s0).slice(1));
      pieces = [rest];
    } else {
      const a = sorted[sorted.length - 1], b = sorted[0];
      pieces = [piece(b, a)];
      s0 = a; s1 = b;
    }
  } else {
    pieces = [];
    if (s0 > 1e-6) pieces.push(piece(0, s0));
    if (s1 < total - 1e-6) pieces.push(piece(s1, total));
  }
  // entferntes Stück (für die rote Markierung)
  const removedPts = target.closed && s0 > s1 ? piece(s0, total).concat(piece(0, s1).slice(1)) : piece(s0, s1);
  return { removed: [s0, s1], removedPts, pieces: pieces.filter(pc => pc.length >= 2) };
}
