// mesh.js — 3D-Modelle (STL binär/Text, OBJ) einlesen und in Schichten schneiden.
// Ergebnis eines Schichtmodells: je Schicht geschlossene Umrisse (außen gegen den Uhrzeigersinn,
// Löcher im Uhrzeigersinn) in mm, die gestapelt und verklebt wieder das Modell ergeben.
import { polyArea, pointInPoly, boolOp, cleanPoly, distToSeg } from './geom.js';

/* ---------------- Einlesen ---------------- */
// Dreiecke als Float32Array: je Dreieck 9 Werte (x,y,z der drei Ecken)
export function parseMesh(name, buf) {
  const ext = String(name).split('.').pop().toLowerCase();
  if (ext === 'obj') return parseOBJ(new TextDecoder().decode(buf));
  return parseSTL(buf);
}

export function parseSTL(buf) {
  const u8 = new Uint8Array(buf);
  const dv = new DataView(buf instanceof ArrayBuffer ? buf : u8.buffer, u8.byteOffset, u8.byteLength);
  // Binär: 80 Byte Kopf, Anzahl, je Dreieck 50 Byte. Manche Binärdateien beginnen trotzdem mit „solid".
  if (u8.byteLength >= 84) {
    const n = dv.getUint32(80, true);
    if (84 + n * 50 === u8.byteLength) {
      const out = new Float32Array(n * 9);
      for (let i = 0; i < n; i++) {
        const o = 84 + i * 50 + 12;
        for (let k = 0; k < 9; k++) out[i * 9 + k] = dv.getFloat32(o + k * 4, true);
      }
      return out;
    }
  }
  const text = new TextDecoder().decode(u8);
  if (!/^\s*solid/i.test(text) || !/vertex/i.test(text)) throw new Error('STL');
  const v = [];
  const re = /vertex\s+([-+\d.eE]+)\s+([-+\d.eE]+)\s+([-+\d.eE]+)/g;
  let m;
  while ((m = re.exec(text))) v.push(+m[1], +m[2], +m[3]);
  return new Float32Array(v.slice(0, v.length - (v.length % 9)));
}

export function parseOBJ(text) {
  const verts = [], out = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (line.startsWith('v ')) {
      const p = line.split(/\s+/);
      verts.push([+p[1], +p[2], +p[3]]);
    } else if (line.startsWith('f ')) {
      // Indizes 1-basiert, negativ = relativ zum Ende; „v/vt/vn" → nur v
      const idx = line.split(/\s+/).slice(1).map(t => {
        const i = parseInt(t.split('/')[0], 10);
        return i < 0 ? verts.length + i : i - 1;
      }).filter(i => verts[i]);
      for (let k = 1; k + 1 < idx.length; k++) out.push(...verts[idx[0]], ...verts[idx[k]], ...verts[idx[k + 1]]);
    }
  }
  if (!out.length) throw new Error('OBJ');
  return new Float32Array(out);
}

export function meshBounds(tris) {
  const b = { x0: Infinity, y0: Infinity, z0: Infinity, x1: -Infinity, y1: -Infinity, z1: -Infinity };
  for (let i = 0; i < tris.length; i += 3) {
    const x = tris[i], y = tris[i + 1], z = tris[i + 2];
    if (x < b.x0) b.x0 = x; if (x > b.x1) b.x1 = x;
    if (y < b.y0) b.y0 = y; if (y > b.y1) b.y1 = y;
    if (z < b.z0) b.z0 = z; if (z > b.z1) b.z1 = z;
  }
  return b;
}

/* Ausrichten: gewählte Achse der Datei zeigt nach oben (Stapelrichtung), Modell steht auf z = 0,
   linke vordere Ecke bei 0/0, längste Seite = size mm (0 = Originalgröße) */
export function orientMesh(tris, up = 'z', size = 0) {
  const out = new Float32Array(tris.length);
  for (let i = 0; i < tris.length; i += 3) {
    const x = tris[i], y = tris[i + 1], z = tris[i + 2];
    // Drehungen um 90°, damit links/rechts erhalten bleibt (keine Spiegelung)
    if (up === 'y') { out[i] = x; out[i + 1] = -z; out[i + 2] = y; }
    else if (up === 'x') { out[i] = -z; out[i + 1] = y; out[i + 2] = x; }
    else { out[i] = x; out[i + 1] = y; out[i + 2] = z; }
  }
  const b = meshBounds(out);
  const longest = Math.max(b.x1 - b.x0, b.y1 - b.y0, b.z1 - b.z0) || 1;
  const k = size > 0 ? size / longest : 1;
  for (let i = 0; i < out.length; i += 3) {
    out[i] = (out[i] - b.x0) * k; out[i + 1] = (out[i + 1] - b.y0) * k; out[i + 2] = (out[i + 2] - b.z0) * k;
  }
  return out;
}

/* ---------------- Schnitt in Höhe h ----------------
   Jedes Dreieck, das die Ebene kreuzt, liefert eine Strecke. Die Richtung folgt der Flächennormalen
   (Material links), damit Außenkonturen gegen den Uhrzeigersinn und Löcher im Uhrzeigersinn laufen.
   Gemeinsame Kanten liefern bitgleiche Punkte, weil jede Kante in fester Eckenreihenfolge geschnitten wird. */
export function sliceMesh(tris, h, gapTol = 0.5) {
  const segs = [];
  const P = (i) => [tris[i], tris[i + 1], tris[i + 2]];
  const less = (a, b) => a[0] !== b[0] ? a[0] < b[0] : a[1] !== b[1] ? a[1] < b[1] : a[2] < b[2];
  const cut = (a, b) => {
    if (less(b, a)) [a, b] = [b, a];
    const t = (h - a[2]) / (b[2] - a[2]);
    return { x: a[0] + (b[0] - a[0]) * t, y: a[1] + (b[1] - a[1]) * t };
  };
  for (let i = 0; i < tris.length; i += 9) {
    const v = [P(i), P(i + 3), P(i + 6)];
    // Ecken genau auf der Ebene minimal anheben, damit jede Ecke eindeutig oben oder unten liegt
    const above = v.map(p => p[2] > h || (p[2] === h));
    const nAbove = above.filter(Boolean).length;
    if (nAbove === 0 || nAbove === 3) continue;
    const pts = [];
    for (let k = 0; k < 3; k++) {
      const a = v[k], b = v[(k + 1) % 3];
      if (above[k] !== above[(k + 1) % 3]) pts.push(cut(a, b));
    }
    if (pts.length !== 2) continue;
    const ux = v[1][0] - v[0][0], uy = v[1][1] - v[0][1], uz = v[1][2] - v[0][2];
    const wx = v[2][0] - v[0][0], wy = v[2][1] - v[0][1], wz = v[2][2] - v[0][2];
    const nx = uy * wz - uz * wy, ny = uz * wx - ux * wz;
    let [p, q] = pts;
    if ((q.x - p.x) * -ny + (q.y - p.y) * nx < 0) [p, q] = [q, p];
    if (p.x === q.x && p.y === q.y) continue;
    segs.push([p, q]);
  }
  return chainSegments(segs, gapTol);
}

const pkey = p => Math.round(p.x * 1e5) + ',' + Math.round(p.y * 1e5);

/* Strecken zu geschlossenen Umrissen verketten; Lücken bis gapTol mm werden überbrückt */
export function chainSegments(segs, gapTol = 0.5) {
  const byStart = new Map();
  segs.forEach((s, i) => {
    const k = pkey(s[0]);
    if (!byStart.has(k)) byStart.set(k, []);
    byStart.get(k).push(i);
  });
  const used = new Uint8Array(segs.length);
  const loops = [], open = [];
  for (let i = 0; i < segs.length; i++) {
    if (used[i]) continue;
    used[i] = 1;
    const chain = [segs[i][0], segs[i][1]];
    const startKey = pkey(segs[i][0]);
    let closed = false;
    for (;;) {
      const endKey = pkey(chain[chain.length - 1]);
      if (endKey === startKey) { chain.pop(); closed = true; break; }
      const next = (byStart.get(endKey) || []).find(j => !used[j]);
      if (next === undefined) break;
      used[next] = 1;
      chain.push(segs[next][1]);
    }
    if (closed) { if (chain.length >= 3) loops.push(chain); }
    else open.push(chain);
  }
  // offene Ketten: Enden mit dem nächsten passenden Anfang verbinden (Löcher im Netz)
  let bridged = 0, dropped = 0;
  while (open.length) {
    const c = open.shift();
    const end = c[c.length - 1];
    let best = -1, bd = gapTol;
    const dSelf = Math.hypot(end.x - c[0].x, end.y - c[0].y);
    if (dSelf <= bd) { best = -2; bd = dSelf; }
    if (dSelf < 1e-6) { if (c.length >= 3) loops.push(c); else dropped++; continue; }
    open.forEach((o, j) => { const d = Math.hypot(end.x - o[0].x, end.y - o[0].y); if (d < bd) { bd = d; best = j; } });
    if (best === -2) { if (c.length >= 3) { loops.push(c); bridged++; } else dropped++; }
    else if (best >= 0) { const o = open.splice(best, 1)[0]; open.unshift(c.concat(o)); bridged++; }
    else dropped++;
  }
  return { loops: loops.map(l => cleanPoly(l)).filter(l => l.length >= 3), bridged, dropped };
}

/* Umrisse einer Schicht ordnen: überlappende Körper vereinigen, Löcher abziehen,
   Inseln und Löcher unter minArea mm² verwerfen */
export function normalizeLayer(loops, minArea) {
  const outers = loops.filter(l => polyArea(l) > 0 && polyArea(l) >= minArea);
  const holes = loops.filter(l => polyArea(l) < 0 && -polyArea(l) >= minArea);
  // überlappen sich Körper? (Umrissrechtecke berühren sich und ein Eckpunkt liegt im anderen Umriss)
  const box = p => p.reduce((b, q) => ({ x0: Math.min(b.x0, q.x), y0: Math.min(b.y0, q.y), x1: Math.max(b.x1, q.x), y1: Math.max(b.y1, q.y) }), { x0: Infinity, y0: Infinity, x1: -Infinity, y1: -Infinity });
  const boxes = outers.map(box);
  const overlap = outers.some((a, i) => outers.some((b, j) => {
    if (j <= i) return false;
    const A = boxes[i], B = boxes[j];
    if (A.x1 < B.x0 || B.x1 < A.x0 || A.y1 < B.y0 || B.y1 < A.y0) return false;
    return a.some(v => pointInPoly(v, b)) || b.some(v => pointInPoly(v, a));
  }));
  let res = outers;
  if (overlap) {
    // bündige Flächen (häufig bei STL aus CAD) ergeben genau übereinanderliegende Kanten – boolOp
    // behandelt sie als gemeinsame Kanten
    res = [outers[0]];
    for (const o of outers.slice(1)) res = boolOp(res, [o], 'union');
  }
  if (holes.length) {
    const solid = res.filter(p => polyArea(p) > 0);
    const kept = holes.filter(hl => solid.some(o => pointInPoly(hl[0], o)));
    if (overlap && kept.length) res = boolOp(res, kept.map(hl => hl.slice().reverse()), 'subtract');
    else res = res.concat(kept);
  }
  return res.map(p => cleanPoly(p)).filter(p => p.length >= 3);
}

/* ---------------- Schichtmodell ----------------
   opts: thickness (mm), section 'mid' | 'outside' | 'inside', minArea (mm²), gapTol (mm) */
export function layeredModel(tris, opts = {}) {
  const t = Math.max(0.1, opts.thickness || 3);
  const minArea = opts.minArea ?? 1;
  const b = meshBounds(tris);
  const height = b.z1 - b.z0;
  const n = Math.max(1, Math.round(height / t));
  const layers = [];
  let bridged = 0, dropped = 0;
  const at = z => {
    const r = sliceMesh(tris, z, opts.gapTol ?? 0.5);
    bridged += r.bridged; dropped += r.dropped;
    return normalizeLayer(r.loops, minArea);
  };
  for (let i = 0; i < n; i++) {
    const z0 = b.z0 + i * t, z1 = Math.min(b.z1, z0 + t), eps = Math.min(0.05, t * 0.05);
    let polys = at((z0 + z1) / 2);
    if (opts.section === 'outside' || opts.section === 'inside') {
      // außen: Vereinigung der Schnitte an Unter- und Oberkante (nichts fehlt, Stufen lassen sich abschleifen);
      // innen: Schnittmenge (keine Schicht steht über)
      const op = opts.section === 'outside' ? 'union' : 'intersect';
      for (const z of [z0 + eps, z1 - eps]) {
        const q = at(z);
        polys = op === 'union' ? (polys.length ? (q.length ? boolOp(polys, q, 'union') : polys) : q)
          : (polys.length && q.length ? boolOp(polys, q, 'intersect') : []);
      }
      polys = normalizeLayer(polys, minArea);
    }
    const islands = polys.filter(p => polyArea(p) > 0).length;
    layers.push({ index: i, z0, z1, polys, islands });
  }
  return {
    layers, bridged, dropped,
    size: { x: b.x1 - b.x0, y: b.y1 - b.y0, z: height },
    empty: layers.filter(l => !l.polys.length).length,
    multi: layers.filter(l => l.islands > 1).length
  };
}

/* Punkt im Material mit möglichst viel Abstand zum Rand (für die Schichtnummer) */
export function labelPoint(polys) {
  const solid = p => polys.reduce((c, poly) => c + (pointInPoly(p, poly) ? 1 : 0), 0) % 2 === 1;
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const poly of polys) for (const p of poly) { x0 = Math.min(x0, p.x); y0 = Math.min(y0, p.y); x1 = Math.max(x1, p.x); y1 = Math.max(y1, p.y); }
  let best = null, bd = -1;
  const N = 24;
  for (let i = 0; i <= N; i++) for (let j = 0; j <= N; j++) {
    const p = { x: x0 + (x1 - x0) * i / N, y: y0 + (y1 - y0) * j / N };
    if (!solid(p)) continue;
    let d = Infinity;
    for (const poly of polys) for (let k = 0; k < poly.length; k++) d = Math.min(d, distToSeg(p, poly[k], poly[(k + 1) % poly.length]));
    if (d > bd) { bd = d; best = p; }
  }
  return best ? { ...best, room: bd } : null;
}
