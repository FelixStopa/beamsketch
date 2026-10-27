// font.js — Text zu Vektor: exakte Umrisse via opentype.js (geladene Fontdatei)
// oder universelles Canvas-Tracing (Marching Squares) für jede Systemschrift.
import { V, cleanPoly, polyArea } from './geom.js';
import { nodeSub } from './doc.js';

export const FontStore = {
  fonts: new Map(),          // name -> opentype.Font (exakte Umrisse)
  systemFonts: ['Sans', 'Serif', 'Monospace', 'Arial', 'Helvetica', 'Times New Roman',
    'Georgia', 'Courier New', 'Verdana', 'Tahoma', 'Trebuchet MS', 'Impact', 'Comic Sans MS'],
  library: [],               // mitgelieferte Schriften: [{name,file,cat,lic}]
  cats: {},                  // Kategorie-Schlüssel -> Anzeigename
  loading: new Map(),        // name -> Promise
  cache: new Map(),
  otReady: null
};

/* ---------------- Mitgelieferte Schriftbibliothek ----------------
   fonts/fonts.json listet alle Schriften. Die Dateien werden erst geladen,
   wenn eine Schrift wirklich benutzt wird. Für die Vorschau in der Auswahl
   genügen @font-face-Regeln – die lädt der Browser selbst bei Bedarf. */
export async function loadFontLibrary(base = 'fonts/') {
  try {
    const r = await fetch(base + 'fonts.json');
    if (!r.ok) throw new Error('fonts.json ' + r.status);
    const j = await r.json();
    FontStore.library = j.fonts || [];
    FontStore.cats = j.cats || {};
    FontStore.base = base;
    const css = FontStore.library.map(f =>
      `@font-face{font-family:"${f.name}";src:url("${base}${f.file}") format("truetype");font-display:swap}`).join('\n');
    const st = document.createElement('style');
    st.id = 'bundledFonts'; st.textContent = css;
    document.head.appendChild(st);
    return FontStore.library.length;
  } catch (e) {
    console.warn('Schriftbibliothek nicht ladbar:', e.message);
    return 0;
  }
}
export function libraryEntry(name) { return FontStore.library.find(f => f.name === name); }
export function isBundled(name) { return !!libraryEntry(name); }

/* Stellt sicher, dass eine Schrift benutzbar ist:
   CSS-Schrift für Vorschau/Tracing und – wenn möglich – exakte Umrisse via opentype. */
export async function ensureFont(name) {
  const e = libraryEntry(name);
  if (!e) return false;
  if (FontStore.fonts.has(name)) return true;
  if (FontStore.loading.has(name)) return FontStore.loading.get(name);
  const p = (async () => {
    // CSS zuerst: damit greift notfalls auch das Canvas-Tracing auf die richtige Schrift zu
    try { await document.fonts.load('40px "' + name + '"'); } catch (err) { /* egal */ }
    try {
      const ot = await ensureOpentype();
      const buf = await (await fetch((FontStore.base || 'fonts/') + e.file)).arrayBuffer();
      FontStore.fonts.set(name, ot.parse(buf));
    } catch (err) {
      console.warn('Exakte Umrisse für', name, 'nicht verfügbar:', err.message);
    }
    FontStore.cache.clear();
    return true;
  })();
  FontStore.loading.set(name, p);
  return p;
}
/* Alle in einem Dokument benutzten mitgelieferten Schriften vorladen */
export async function preloadUsedFonts(shapes) {
  const names = new Set();
  const walk = list => { for (const s of list) { if (s.type === 'group') walk(s.children); else if (s.type === 'text' && s.font) names.add(s.font); } };
  walk(shapes || []);
  const jobs = [...names].filter(isBundled).map(ensureFont);
  if (jobs.length) await Promise.all(jobs);
  return jobs.length;
}

export async function ensureOpentype() {
  if (window.opentype) return window.opentype;
  if (FontStore.otReady) return FontStore.otReady;
  const load = src => new Promise((res, rej) => {
    const s = document.createElement('script');
    s.src = src;
    s.onload = () => window.opentype ? res(window.opentype) : rej(new Error('opentype.js leer'));
    s.onerror = () => rej(new Error('opentype.js nicht ladbar: ' + src));
    document.head.appendChild(s);
  });
  // nur die eigene Kopie – keine Anfragen an fremde Server (Datenschutz)
  FontStore.otReady = load('vendor/opentype.min.js');
  return FontStore.otReady;
}

export async function loadFontFile(file) {
  const ot = await ensureOpentype();
  const buf = await file.arrayBuffer();
  const font = ot.parse(buf);
  const name = (font.names.fullName && (font.names.fullName.de || font.names.fullName.en)) || file.name.replace(/\.[^.]+$/, '');
  FontStore.fonts.set(name, font);
  // Auch als CSS-Font registrieren, damit Vorschau passt
  try {
    const ff = new FontFace(name, buf);
    await ff.load(); document.fonts.add(ff);
  } catch (e) { /* egal */ }
  FontStore.cache.clear();
  return name;
}

function cssFont(sh) {
  const style = sh.italic ? 'italic ' : '';
  const weight = sh.bold ? '700 ' : '400 ';
  const fam = { Sans: 'sans-serif', Serif: 'serif', Monospace: 'monospace' }[sh.font] || `"${sh.font}"`;
  return { style, weight, fam };
}

/* ------- Exakte Umrisse via opentype ------- */
function otSubpaths(sh) {
  const font = FontStore.fonts.get(sh.font);
  if (!font) return null;
  const size = sh.size;
  const lines = String(sh.text).split('\n');
  const subs = [];
  const lineH = size * 1.25 + (sh.vspace || 0);
  // Kerning ist bei Schreibschriften entscheidend – sonst hängen die Buchstaben nicht zusammen
  const kern = (a, b) => {
    if (!a || !b) return 0;
    try { return font.getKerningValue(a, b) || 0; } catch (e) { return 0; }
  };
  lines.forEach((line, li) => {
    // Breite für Ausrichtung
    let adv = 0;
    const glyphs = font.stringToGlyphs(line);
    const scale = size / font.unitsPerEm;
    for (let i = 0; i < glyphs.length; i++)
      adv += glyphs[i].advanceWidth * scale + (sh.hspace || 0) + kern(glyphs[i], glyphs[i + 1]) * scale;
    let x = sh.align === 'center' ? -adv / 2 : sh.align === 'right' ? -adv : 0;
    const y = -li * lineH;
    for (let gi = 0; gi < glyphs.length; gi++) {
      const g = glyphs[gi];
      const path = g.getPath(x, 0, size);
      let cur = null, start = null;
      for (const c of path.commands) {
        if (c.type === 'M') { if (cur && cur.nodes.length) subs.push(cur); cur = { closed: true, nodes: [] }; cur.nodes.push({ x: c.x, y: -c.y + y, in: null, out: null }); }
        else if (c.type === 'L') cur.nodes.push({ x: c.x, y: -c.y + y, in: null, out: null });
        else if (c.type === 'C') {
          const prev = cur.nodes[cur.nodes.length - 1];
          prev.out = { x: c.x1, y: -c.y1 + y };
          cur.nodes.push({ x: c.x, y: -c.y + y, in: { x: c.x2, y: -c.y2 + y }, out: null });
        } else if (c.type === 'Q') {
          const prev = cur.nodes[cur.nodes.length - 1];
          const c1 = { x: prev.x + 2 / 3 * (c.x1 - prev.x), y: prev.y + 2 / 3 * ((-c.y1 + y) - prev.y) };
          const c2 = { x: c.x + 2 / 3 * (c.x1 - c.x), y: (-c.y + y) + 2 / 3 * ((-c.y1 + y) - (-c.y + y)) };
          prev.out = c1;
          cur.nodes.push({ x: c.x, y: -c.y + y, in: c2, out: null });
        } else if (c.type === 'Z') { if (cur && cur.nodes.length) { subs.push(cur); cur = null; } }
      }
      if (cur && cur.nodes.length) subs.push(cur);
      x += g.advanceWidth * scale + (sh.hspace || 0) + kern(g, glyphs[gi + 1]) * scale;
    }
  });
  // Kursiv wird für exakte Umrisse geschert (die Schriftdateien haben keine Kursiv-Schnitte)
  if (sh.italic) for (const sp of subs) for (const n of sp.nodes) {
    n.x += n.y * 0.21;
    if (n.in) n.in.x += n.in.y * 0.21;
    if (n.out) n.out.x += n.out.y * 0.21;
  }
  return subs;
}

/* ------- Canvas-Tracing (Marching Squares) ------- */
function traceSubpaths(sh) {
  const size = sh.size;
  const ppmm = Math.min(24, Math.max(6, 300 / Math.max(size, 4))); // Pixel pro mm
  const { style, weight, fam } = cssFont(sh);
  const lines = String(sh.text).split('\n');
  const lineH = size * 1.25 + (sh.vspace || 0);
  const meas = document.createElement('canvas').getContext('2d');
  const fontStr = `${style}${weight}${size * ppmm}px ${fam}`;
  meas.font = fontStr;
  let maxW = 1;
  const widths = lines.map(l => {
    let w = meas.measureText(l).width + (sh.hspace || 0) * ppmm * Math.max(0, l.length - 1);
    maxW = Math.max(maxW, w); return w;
  });
  const pad = Math.ceil(size * ppmm * 0.4) + 4;
  const W = Math.ceil(maxW) + pad * 2;
  const H = Math.ceil(lines.length * lineH * ppmm + size * ppmm) + pad * 2;
  if (W * H > 40e6) return [];
  const cv = document.createElement('canvas');
  cv.width = W; cv.height = H;
  const g = cv.getContext('2d', { willReadFrequently: true });
  g.fillStyle = '#000'; g.fillRect(0, 0, W, H);
  g.fillStyle = '#fff'; g.font = fontStr; g.textBaseline = 'alphabetic';
  const baseY = pad + size * ppmm;
  lines.forEach((l, li) => {
    let x = pad;
    if (sh.align === 'center') x = pad + (maxW - widths[li]) / 2;
    if (sh.align === 'right') x = pad + (maxW - widths[li]);
    const y = baseY + li * lineH * ppmm;
    if (sh.hspace) {
      let cx = x;
      for (const ch of l) { g.fillText(ch, cx, y); cx += g.measureText(ch).width + sh.hspace * ppmm; }
    } else g.fillText(l, x, y);
  });
  const img = g.getImageData(0, 0, W, H).data;
  const at = (x, y) => (x < 0 || y < 0 || x >= W || y >= H) ? 0 : img[(y * W + x) * 4] / 255;
  const segs = [];
  const ip = (a, b) => { const d = b - a; return Math.abs(d) < 1e-6 ? .5 : (0.5 - a) / d; };
  for (let y = -1; y < H; y++) {
    for (let x = -1; x < W; x++) {
      const tl = at(x, y), tr = at(x + 1, y), br = at(x + 1, y + 1), bl = at(x, y + 1);
      const idx = (tl > .5 ? 8 : 0) | (tr > .5 ? 4 : 0) | (br > .5 ? 2 : 0) | (bl > .5 ? 1 : 0);
      if (idx === 0 || idx === 15) continue;
      const T = { x: x + ip(tl, tr), y: y }, R = { x: x + 1, y: y + ip(tr, br) },
        B = { x: x + ip(bl, br), y: y + 1 }, L = { x: x, y: y + ip(tl, bl) };
      const add = (a, b) => segs.push([a, b]);
      switch (idx) {
        case 1: add(L, B); break; case 2: add(B, R); break; case 3: add(L, R); break;
        case 4: add(T, R); break; case 6: add(T, B); break; case 7: add(L, T); break;
        case 8: add(T, L); break; case 9: add(T, B); break; case 11: add(T, R); break;
        case 12: add(L, R); break; case 13: add(B, R); break; case 14: add(L, B); break;
        case 5: add(L, T); add(B, R); break;
        case 10: add(T, R); add(L, B); break;
      }
    }
  }
  const loops = stitchUndirected(segs, 0.3);
  const subs = [];
  const minArea = 1.5; // Pixel², filtert Antialiasing-Artefakte
  for (let loop of loops) {
    loop = rdpRing(loop, 0.35);
    loop = cleanPoly(loop, 1e-4);
    if (loop.length < 3 || Math.abs(polyArea(loop)) < minArea) continue;
    const pts = loop.map(p => ({ x: (p.x - pad) / ppmm, y: -(p.y - baseY) / ppmm }));
    subs.push(nodeSub(pts, true));
  }
  // Ausrichtung: bei center/right wurde bereits im Canvas ausgerichtet -> Nullpunkt korrigieren
  if (sh.align === 'center') shiftSubs(subs, -maxW / (2 * ppmm));
  if (sh.align === 'right') shiftSubs(subs, -maxW / ppmm);
  return subs;
}
function shiftSubs(subs, dx) {
  for (const s of subs) for (const n of s.nodes) {
    n.x += dx; if (n.in) n.in.x += dx; if (n.out) n.out.x += dx;
  }
}

function stitchUndirected(segs, tol) {
  // Marching-Squares-Segmente haben exakt gemeinsame Endpunkte -> exaktes Hashing
  const k = p => Math.round(p.x * 1e5) + ',' + Math.round(p.y * 1e5);
  const map = new Map();
  segs.forEach((s, i) => {
    for (const p of s) {
      const kk = k(p);
      if (!map.has(kk)) map.set(kk, []);
      map.get(kk).push(i);
    }
  });
  const used = new Array(segs.length).fill(false);
  const loops = [];
  for (let i = 0; i < segs.length; i++) {
    if (used[i]) continue;
    used[i] = true;
    const startK = k(segs[i][0]);
    const loop = [segs[i][0], segs[i][1]];
    // vorwärts laufen
    for (let guard = 0; guard < segs.length; guard++) {
      const end = loop[loop.length - 1];
      const ek = k(end);
      if (ek === startK) break;
      const cand = (map.get(ek) || []).find(j => !used[j]);
      if (cand === undefined) break;
      used[cand] = true;
      const [a, b] = segs[cand];
      loop.push(k(a) === ek ? b : a);
    }
    // rückwärts (offene Kette)
    if (k(loop[loop.length - 1]) !== startK) {
      for (let guard = 0; guard < segs.length; guard++) {
        const st = loop[0];
        const sk = k(st);
        const cand = (map.get(sk) || []).find(j => !used[j]);
        if (cand === undefined) break;
        used[cand] = true;
        const [a, b] = segs[cand];
        loop.unshift(k(a) === sk ? b : a);
      }
    }
    if (loop.length >= 4) loops.push(loop);
  }
  return loops;
}

// RDP für geschlossene Ringe (erster Punkt == letzter Punkt)
export function rdpRing(pts, eps) {
  if (pts.length < 4) return pts;
  const closed = Math.abs(pts[0].x - pts[pts.length - 1].x) < 1e-9 && Math.abs(pts[0].y - pts[pts.length - 1].y) < 1e-9;
  if (!closed) return rdp(pts, eps);
  let mi = 1, md = -1;
  for (let i = 1; i < pts.length - 1; i++) {
    const d = (pts[i].x - pts[0].x) ** 2 + (pts[i].y - pts[0].y) ** 2;
    if (d > md) { md = d; mi = i; }
  }
  const a = rdp(pts.slice(0, mi + 1), eps);
  const b = rdp(pts.slice(mi), eps);
  return a.concat(b.slice(1));
}

export function rdp(pts, eps) {
  if (pts.length < 3) return pts;
  const keep = new Array(pts.length).fill(false);
  keep[0] = keep[pts.length - 1] = true;
  const stack = [[0, pts.length - 1]];
  while (stack.length) {
    const [s, e] = stack.pop();
    let maxD = 0, idx = -1;
    const a = pts[s], b = pts[e];
    const dx = b.x - a.x, dy = b.y - a.y, l = Math.hypot(dx, dy) || 1;
    for (let i = s + 1; i < e; i++) {
      const d = Math.abs((pts[i].x - a.x) * dy - (pts[i].y - a.y) * dx) / l;
      if (d > maxD) { maxD = d; idx = i; }
    }
    if (maxD > eps && idx > 0) { keep[idx] = true; stack.push([s, idx], [idx, e]); }
  }
  return pts.filter((_, i) => keep[i]);
}

/* Vorschub je Zeichen in mm (erste Zeile) – für Text auf Pfad */
export function charAdvances(sh) {
  const chars = [...String(sh.text).split('\n')[0]];
  const font = FontStore.fonts.get(sh.font);
  if (font) {
    const scale = sh.size / font.unitsPerEm;
    const gl = chars.map(c => font.charToGlyph(c));
    return gl.map((g, i) => {
      let k = 0; try { if (gl[i + 1]) k = font.getKerningValue(g, gl[i + 1]) || 0; } catch (e) { /* egal */ }
      return g.advanceWidth * scale + k * scale + (sh.hspace || 0);
    });
  }
  const { style, weight, fam } = cssFont(sh);
  const g = document.createElement('canvas').getContext('2d');
  g.font = `${style}${weight}100px ${fam}`;
  return chars.map(c => g.measureText(c).width / 100 * sh.size + (sh.hspace || 0));
}

/* ------- öffentlicher Provider ------- */
export function textSubpaths(sh) {
  const key = JSON.stringify([sh.text, sh.font, sh.size, sh.bold, sh.italic, sh.hspace, sh.vspace, sh.align]);
  if (FontStore.cache.has(key)) return FontStore.cache.get(key);
  let subs = null;
  if (FontStore.fonts.has(sh.font)) { try { subs = otSubpaths(sh); } catch (e) { subs = null; } }
  if (!subs) { try { subs = traceSubpaths(sh); } catch (e) { subs = []; } }
  if (FontStore.cache.size > 400) FontStore.cache.clear();
  FontStore.cache.set(key, subs);
  return subs;
}

// Debug-Zugriff (nur für Entwicklung)
export function _trace(sh) { return traceSubpaths(sh); }
