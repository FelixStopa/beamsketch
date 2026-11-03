// centerline.js — Mittellinien aus einem Schwarz-Weiß-Raster: Striche werden auf ein Pixel ausgedünnt
// (Zhang-Suen), kurze Seitenäste entfernt und die Linien als offene Polylinien verfolgt.
// Für Handschrift, Unterschriften und Strichzeichnungen: der Laser fährt die Mitte des Strichs ab.

const N8 = [[0, -1], [1, -1], [1, 0], [1, 1], [0, 1], [-1, 1], [-1, 0], [-1, -1]];   // P2 … P9 im Uhrzeigersinn

/* bin: Uint8Array W×H (1 = Strich). Ergebnis wird in bin ausgedünnt. */
export function thin(bin, W, H) {
  const at = (x, y) => (x < 0 || y < 0 || x >= W || y >= H) ? 0 : bin[y * W + x];
  let changed = true;
  const del = [];
  while (changed) {
    changed = false;
    for (let step = 0; step < 2; step++) {
      del.length = 0;
      for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
        if (!bin[y * W + x]) continue;
        const p = N8.map(([dx, dy]) => at(x + dx, y + dy));
        const B = p.reduce((a, b) => a + b, 0);
        if (B < 2 || B > 6) continue;
        let A = 0;
        for (let i = 0; i < 8; i++) if (!p[i] && p[(i + 1) % 8]) A++;
        if (A !== 1) continue;
        if (step === 0 ? (p[0] * p[2] * p[4] || p[2] * p[4] * p[6]) : (p[0] * p[2] * p[6] || p[0] * p[4] * p[6])) continue;
        del.push(y * W + x);
      }
      for (const i of del) bin[i] = 0;
      if (del.length) changed = true;
    }
  }
  return bin;
}

/* m-Nachbarn: gerade Nachbarn immer, schräge nur, wenn keiner der beiden geraden Zwischenpixel belegt ist.
   So hat jeder Pixel einer Linie – auch auf den Treppenstufen schräger Linien – genau zwei Nachbarn. */
function mNeighbors(bin, W, H, x, y) {
  const on = (X, Y) => X >= 0 && Y >= 0 && X < W && Y < H && bin[Y * W + X];
  const out = [];
  for (const [dx, dy] of N8) {
    if (!on(x + dx, y + dy)) continue;
    if (dx && dy && (on(x + dx, y) || on(x, y + dy))) continue;
    out.push([x + dx, y + dy]);
  }
  return out;
}
const deg = (bin, W, H, x, y) => mNeighbors(bin, W, H, x, y).length;

/* Skelett in Polylinien zerlegen (Pixelkoordinaten). Äste kürzer als spur Pixel, die an einer Kreuzung
   enden, werden entfernt. */
export function traceSkeleton(bin, W, H, spur = 0) {
  const nb = (x, y) => mNeighbors(bin, W, H, x, y);
  const isNode = (x, y) => deg(bin, W, H, x, y) !== 2;
  const used = new Set();                // benutzte Kanten „a|b"
  const ek = (a, b) => a < b ? a + '|' + b : b + '|' + a;
  const lines = [];
  const walk = (x, y, nx, ny) => {
    const pts = [[x, y]];
    let px = x, py = y, cx = nx, cy = ny;
    used.add(ek(py * W + px, cy * W + cx));
    for (;;) {
      pts.push([cx, cy]);
      if (isNode(cx, cy)) break;
      const next = nb(cx, cy).find(([X, Y]) => !(X === px && Y === py) && !used.has(ek(cy * W + cx, Y * W + X)));
      if (!next) break;
      used.add(ek(cy * W + cx, next[1] * W + next[0]));
      px = cx; py = cy; [cx, cy] = next;
      if (cx === x && cy === y) { pts.push([cx, cy]); break; }
    }
    return pts;
  };
  // von Enden und Kreuzungen aus
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    if (!bin[y * W + x] || !isNode(x, y)) continue;
    for (const [X, Y] of nb(x, y)) if (!used.has(ek(y * W + x, Y * W + X))) lines.push(walk(x, y, X, Y));
  }
  // übrige geschlossene Ringe (alle Pixel mit genau zwei Nachbarn)
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    if (!bin[y * W + x]) continue;
    for (const [X, Y] of nb(x, y)) if (!used.has(ek(y * W + x, Y * W + X))) lines.push(walk(x, y, X, Y));
  }
  // kurze Seitenäste: ein Ende frei, das andere an einer Kreuzung
  const kept = lines.filter(l => {
    const [a, b] = [l[0], l[l.length - 1]];
    const da = deg(bin, W, H, a[0], a[1]), db = deg(bin, W, H, b[0], b[1]);
    // winzige Stücke innerhalb einer Kreuzung (mehrere benachbarte Kreuzungspixel)
    if (l.length <= 3 && da >= 3 && db >= 3) return false;
    if (spur <= 0 || l.length > spur) return true;
    return !((da === 1 && db >= 3) || (db === 1 && da >= 3));
  }).map(l => l.map(([x, y]) => ({ x: x + 0.5, y: y + 0.5 })));
  return mergeEnds(kept);
}

/* Linien verbinden, deren Enden sich (fast) berühren, wenn dort genau zwei Enden zusammenkommen –
   sonst zerfallen Ringe und Bögen an den Treppenstufen schräger Linien */
function mergeEnds(lines, tol = 1.5) {
  const near = (a, b) => Math.hypot(a.x - b.x, a.y - b.y) <= tol;
  const ends = () => lines.flatMap((l, i) => [{ i, s: 0, p: l[0] }, { i, s: 1, p: l[l.length - 1] }]);
  for (let changed = true; changed;) {
    changed = false;
    const E = ends();
    for (const e of E) {
      const others = E.filter(f => f !== e && near(e.p, f.p));
      if (others.length !== 1) continue;
      const f = others[0];
      if (f.i === e.i) continue;
      let a = lines[e.i], b = lines[f.i];
      if (e.s === 0) a = a.slice().reverse();
      if (f.s === 1) b = b.slice().reverse();
      lines[e.i] = a.concat(b);
      lines.splice(f.i, 1);
      changed = true;
      break;
    }
  }
  return lines;
}

/* Polylinie vereinfachen (Ramer-Douglas-Peucker, offen) */
export function simplify(pts, tol) {
  if (pts.length < 3) return pts;
  const keep = new Uint8Array(pts.length); keep[0] = keep[pts.length - 1] = 1;
  const st = [[0, pts.length - 1]];
  while (st.length) {
    const [i, j] = st.pop();
    const a = pts[i], b = pts[j], dx = b.x - a.x, dy = b.y - a.y, l = Math.hypot(dx, dy);
    let md = -1, mi = -1;
    for (let k = i + 1; k < j; k++) {
      const d = l ? Math.abs(dy * pts[k].x - dx * pts[k].y + b.x * a.y - b.y * a.x) / l : Math.hypot(pts[k].x - a.x, pts[k].y - a.y);
      if (d > md) { md = d; mi = k; }
    }
    if (md > tol) { keep[mi] = 1; st.push([i, mi], [mi, j]); }
  }
  return pts.filter((_, k) => keep[k]);
}

/* Komplett: bin → Mittellinien in Pixelkoordinaten */
export function centerlines(bin, W, H, opts = {}) {
  const b = Uint8Array.from(bin);
  thin(b, W, H);
  return traceSkeleton(b, W, H, opts.spur ?? 6).map(l => simplify(l, opts.tol ?? 0.8)).filter(l => l.length >= 2);
}
