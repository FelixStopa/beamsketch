// formats.js — DXF- und PDF-Export, PDF-/Illustrator-Import (Vektoren).
// DXF: R12 (AC1009) mit Ebenen je BeamSketch-Ebene, Polylinien in mm – liest praktisch jedes CAD-Programm.
// PDF: eine Seite in Größe der Arbeitsfläche (1:1), Linien in Ebenenfarbe, Füll-Ebenen gefüllt.
// PDF-Import: eigener kleiner Leser ohne Zusatzpakete – Pfade (m l c v y h re), Transformationen (cm, q/Q),
// Formular-XObjects, Objektströme und FlateDecode. Texte und Bilder werden übersprungen und gezählt.
import { shapePolys, Shape, layerNo } from './doc.js';

const f4 = v => (Math.round(v * 10000) / 10000).toString();
const hexRGB = c => { const m = /^#?([0-9a-f]{6})$/i.exec(c || ''); const n = m ? parseInt(m[1], 16) : 0; return [(n >> 16) & 255, (n >> 8) & 255, n & 255]; };

/* ---------------- DXF-Export ---------------- */
const ACI = [[1, [255, 0, 0]], [2, [255, 255, 0]], [3, [0, 255, 0]], [4, [0, 255, 255]], [5, [0, 0, 255]], [6, [255, 0, 255]], [7, [0, 0, 0]], [8, [128, 128, 128]], [30, [255, 127, 0]], [140, [0, 127, 255]]];
const nearestACI = rgb => ACI.reduce((b, c) => { const d = (c[1][0] - rgb[0]) ** 2 + (c[1][1] - rgb[1]) ** 2 + (c[1][2] - rgb[2]) ** 2; return d < b.d ? { d, i: c[0] } : b; }, { d: Infinity, i: 7 }).i;

export function exportDXF(doc, ctx, sel = null) {
  const list = sel && sel.length ? sel : doc.shapes.filter(s => !s.hidden);
  const out = [];
  const w = (code, val) => out.push(String(code), String(val));
  const used = new Set();
  const ents = [];
  for (const sh of list) for (const p of shapePolys(sh, ctx)) { used.add(p.layer); ents.push(p); }
  const lname = i => 'L' + layerNo(i);
  w(0, 'SECTION'); w(2, 'HEADER'); w(9, '$ACADVER'); w(1, 'AC1009'); w(9, '$INSUNITS'); w(70, 4); w(0, 'ENDSEC');
  w(0, 'SECTION'); w(2, 'TABLES'); w(0, 'TABLE'); w(2, 'LAYER'); w(70, used.size);
  for (const i of [...used].sort((a, b) => a - b)) {
    const L = doc.layers[i] || {};
    w(0, 'LAYER'); w(2, lname(i)); w(70, 0); w(62, nearestACI(hexRGB(L.color))); w(6, 'CONTINUOUS');
  }
  w(0, 'ENDTAB'); w(0, 'ENDSEC');
  w(0, 'SECTION'); w(2, 'ENTITIES');
  for (const p of ents) {
    if (p.pts.length < 2) continue;
    w(0, 'POLYLINE'); w(8, lname(p.layer)); w(66, 1); w(70, p.closed ? 1 : 0);
    for (const q of p.pts) { w(0, 'VERTEX'); w(8, lname(p.layer)); w(10, f4(q.x)); w(20, f4(q.y)); }
    w(0, 'SEQEND'); w(8, lname(p.layer));
  }
  w(0, 'ENDSEC'); w(0, 'EOF');
  return out.join('\n') + '\n';
}

/* ---------------- PDF-Export ---------------- */
export function exportPDF(doc, ctx, sel = null) {
  const W = doc.machine.width, H = doc.machine.height, k = 72 / 25.4;
  const list = sel && sel.length ? sel : doc.shapes.filter(s => !s.hidden);
  const ops = ['0.567 w 1 J 1 j'];                     // 0,2 mm Linie
  for (const sh of list) for (const p of shapePolys(sh, ctx)) {
    if (p.pts.length < 2) continue;
    const L = doc.layers[p.layer] || {};
    const [r, g, b] = hexRGB(L.color).map(v => (v / 255).toFixed(3));
    const fill = p.closed && (L.mode === 'fill' || L.mode === 'fill+line');
    ops.push(`${r} ${g} ${b} RG ${r} ${g} ${b} rg`);
    ops.push(p.pts.map((q, i) => f4(q.x * k) + ' ' + f4(q.y * k) + (i ? ' l' : ' m')).join(' ') + (p.closed ? ' h' : '') + (fill ? ' B' : ' S'));
  }
  const content = ops.join('\n');
  const objs = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${f4(W * k)} ${f4(H * k)}] /Contents 4 0 R /Resources << >> >>`,
    `<< /Length ${new TextEncoder().encode(content).length} >>\nstream\n${content}\nendstream`,
    '<< /Producer (BeamSketch) >>'
  ];
  let pdf = '%PDF-1.4\n%âãÏÓ\n';
  const enc = s => new TextEncoder().encode(s).length;
  const offs = [];
  objs.forEach((o, i) => { offs.push(enc(pdf)); pdf += `${i + 1} 0 obj\n${o}\nendobj\n`; });
  const xref = enc(pdf);
  pdf += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n` + offs.map(o => String(o).padStart(10, '0') + ' 00000 n \n').join('');
  pdf += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R /Info 5 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return pdf;
}

/* ---------------- PDF-Leser ---------------- */
class Lexer {
  constructor(bytes, pos = 0) { this.b = bytes; this.p = pos; }
  ws() {
    const b = this.b;
    for (;;) {
      while (this.p < b.length && (b[this.p] <= 32)) this.p++;
      if (b[this.p] === 37) { while (this.p < b.length && b[this.p] !== 10 && b[this.p] !== 13) this.p++; continue; } // %Kommentar
      return;
    }
  }
  delim(c) { return c <= 32 || c === 40 || c === 41 || c === 60 || c === 62 || c === 91 || c === 93 || c === 123 || c === 125 || c === 47 || c === 37; }
  word() { const s = this.p; while (this.p < this.b.length && !this.delim(this.b[this.p])) this.p++; return String.fromCharCode(...this.b.subarray(s, this.p)); }
  // ein Objekt lesen; Referenzen „n g R" werden zu { ref: n }
  obj() {
    this.ws();
    const b = this.b, c = b[this.p];
    if (c === undefined) return undefined;
    if (c === 60 && b[this.p + 1] === 60) {
      this.p += 2; const d = {};
      for (;;) { this.ws(); if (b[this.p] === 62 && b[this.p + 1] === 62) { this.p += 2; break; } const k = this.obj(); if (k === undefined) break; d[k.name] = this.obj(); }
      return d;
    }
    if (c === 60) { this.p++; let s = ''; while (this.p < b.length && b[this.p] !== 62) s += String.fromCharCode(b[this.p++]); this.p++; return { str: s.replace(/\s/g, '') }; }
    if (c === 91) { this.p++; const a = []; for (;;) { this.ws(); if (b[this.p] === 93) { this.p++; break; } const v = this.obj(); if (v === undefined) break; a.push(v); } return a; }
    if (c === 47) { this.p++; return { name: this.word() }; }
    if (c === 40) {
      let depth = 0, s = '';
      for (this.p++; this.p < b.length; this.p++) {
        const ch = b[this.p];
        if (ch === 92) { this.p++; s += String.fromCharCode(b[this.p]); continue; }
        if (ch === 40) depth++;
        if (ch === 41) { if (!depth) { this.p++; break; } depth--; }
        s += String.fromCharCode(ch);
      }
      return { str: s };
    }
    const w = this.word();
    if (w === '') { this.p++; return this.obj(); }
    if (/^[+-]?(\d+\.?\d*|\.\d+)$/.test(w)) {
      // Referenz?
      const save = this.p;
      this.ws(); const w2 = this.word(); this.ws(); const w3 = this.word();
      if (/^\d+$/.test(w) && /^\d+$/.test(w2) && w3 === 'R') return { ref: +w };
      this.p = save;
      return +w;
    }
    if (w === 'true') return true; if (w === 'false') return false; if (w === 'null') return null;
    return { op: w };
  }
}

async function inflate(bytes) {
  const ds = new DecompressionStream('deflate');
  const stream = new Blob([bytes]).stream().pipeThrough(ds);
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/* Alle Objekte „n g obj … endobj" einsammeln (ohne Querverweistabelle, robust gegen kaputte xref) */
async function readObjects(bytes) {
  const objs = new Map();
  const text = new TextDecoder('latin1').decode(bytes);
  const re = /(\d+)\s+(\d+)\s+obj\b/g;
  let m;
  while ((m = re.exec(text))) {
    const lx = new Lexer(bytes, m.index + m[0].length);
    const val = lx.obj();
    lx.ws();
    let stream = null;
    if (text.startsWith('stream', lx.p)) {
      let s = lx.p + 6;
      if (bytes[s] === 13) s++; if (bytes[s] === 10) s++;
      // Länge aus /Length, wenn danach wirklich „endstream" folgt; sonst danach suchen
      const len = typeof val.Length === 'number' ? val.Length : -1;
      let e = -1;
      if (len >= 0) { let q = s + len; while (bytes[q] === 13 || bytes[q] === 10 || bytes[q] === 32) q++; if (text.startsWith('endstream', q)) e = s + len; }
      if (e < 0) { e = text.indexOf('endstream', s); if (e < 0) e = bytes.length; while (e > s && (bytes[e - 1] === 10 || bytes[e - 1] === 13)) e--; }
      stream = bytes.subarray(s, e);
      re.lastIndex = e;
    }
    objs.set(+m[1], { val, stream });
  }
  const get = r => (r && r.ref !== undefined ? (objs.get(r.ref) || {}).val : r);
  // Objektströme (PDF 1.5): enthaltene Objekte auspacken
  for (const [, o] of [...objs]) {
    if (!o.val || !o.val.Type || o.val.Type.name !== 'ObjStm' || !o.stream) continue;
    const data = await streamData(o, get);
    const head = new Lexer(data);
    const n = get(o.val.N), first = get(o.val.First), pairs = [];
    for (let i = 0; i < n; i++) pairs.push([head.obj(), head.obj()]);
    for (const [num, off] of pairs) if (!objs.has(num)) objs.set(num, { val: new Lexer(data, first + off).obj(), stream: null });
  }
  return { objs, get };
}
async function streamData(o, get) {
  const f = get(o.val.Filter);
  const filters = Array.isArray(f) ? f.map(x => get(x).name) : f ? [f.name] : [];
  let data = o.stream;
  for (const fl of filters) {
    if (fl === 'FlateDecode') data = await inflate(data);
    else throw new Error('Filter ' + fl);
  }
  return data;
}

const mul = (a, b) => [a[0] * b[0] + a[1] * b[2], a[0] * b[1] + a[1] * b[3], a[2] * b[0] + a[3] * b[2], a[2] * b[1] + a[3] * b[3], a[4] * b[0] + a[5] * b[2] + b[4], a[4] * b[1] + a[5] * b[3] + b[5]];
const apply = (m, x, y) => ({ x: m[0] * x + m[2] * y + m[4], y: m[1] * x + m[3] * y + m[5] });

/* PDF (auch .ai ab Illustrator 9) lesen. Ergebnis: { paths: [{ subpaths, color: [r,g,b] }], pages, skipped: { text, images } } in mm */
export async function readPDF(buf) {
  const bytes = new Uint8Array(buf);
  const head = new TextDecoder('latin1').decode(bytes.subarray(0, 1024));
  if (!head.includes('%PDF')) throw new Error(head.includes('%!PS') ? 'PostScript' : 'PDF');
  const { objs, get } = await readObjects(bytes);
  for (const [, o] of objs) if (o.val && o.val.Encrypt) throw new Error('encrypted');
  // Seiten in Reihenfolge des Seitenbaums
  const pages = [];
  const walk = node => {
    const n = get(node);
    if (!n) return;
    if (n.Type && n.Type.name === 'Page') { pages.push(n); return; }
    for (const k of get(n.Kids) || []) walk(k);
  };
  const root = [...objs.values()].find(o => o.val && o.val.Type && o.val.Type.name === 'Catalog');
  if (root) walk(root.val.Pages);
  if (!pages.length) for (const [, o] of objs) if (o.val && o.val.Type && o.val.Type.name === 'Page') pages.push(o.val);
  if (!pages.length) throw new Error('keine Seite');
  const page = pages[0];
  const k = 25.4 / 72;
  const paths = [], skipped = { text: 0, images: 0 };
  const objOf = r => (r && r.ref !== undefined ? objs.get(r.ref) : null);

  async function run(contentBytes, resources, ctm0) {
    const lx = new Lexer(contentBytes);
    let st = { ctm: ctm0, stroke: [0, 0, 0], fill: [0, 0, 0] };
    const stack = [];
    let ops = [], cur = null, subs = [];
    const P = (x, y) => { const p = apply(st.ctm, x, y); return { x: p.x * k, y: p.y * k }; };
    const finish = (paint, closeAll) => {
      if (cur && cur.nodes.length) subs.push(cur);
      cur = null;
      if (paint && subs.length) {
        if (closeAll) subs.forEach(s => { if (s.nodes.length > 2) s.closed = true; });
        paths.push({ subpaths: subs.filter(s => s.nodes.length >= 2), color: paint === 'f' ? st.fill : st.stroke });
      }
      subs = [];
    };
    const n = i => ops[i];
    for (;;) {
      const t = lx.obj();
      if (t === undefined) break;
      if (!t || t.op === undefined) { ops.push(t); continue; }
      const op = t.op;
      switch (op) {
        case 'q': stack.push({ ...st, ctm: st.ctm.slice() }); break;
        case 'Q': if (stack.length) st = stack.pop(); break;
        case 'cm': st.ctm = mul(ops.slice(-6).map(Number), st.ctm); break;
        case 'm': if (cur && cur.nodes.length) subs.push(cur); cur = { closed: false, nodes: [{ ...P(n(0), n(1)), in: null, out: null }] }; break;
        case 'l': if (cur) cur.nodes.push({ ...P(n(0), n(1)), in: null, out: null }); break;
        case 'c': case 'v': case 'y': {
          if (!cur) break;
          const last = cur.nodes[cur.nodes.length - 1];
          let c1, c2, e;
          if (op === 'c') { c1 = P(n(0), n(1)); c2 = P(n(2), n(3)); e = P(n(4), n(5)); }
          else if (op === 'v') { c1 = { x: last.x, y: last.y }; c2 = P(n(0), n(1)); e = P(n(2), n(3)); }
          else { c1 = P(n(0), n(1)); c2 = P(n(2), n(3)); e = { ...c2 }; }
          last.out = c1;
          cur.nodes.push({ ...e, in: c2, out: null });
          break;
        }
        case 'h': if (cur) { cur.closed = true; const a = cur.nodes[0], z = cur.nodes[cur.nodes.length - 1]; if (cur.nodes.length > 1 && Math.hypot(a.x - z.x, a.y - z.y) < 1e-6) { a.in = z.in; cur.nodes.pop(); } } break;
        case 're': {
          if (cur && cur.nodes.length) subs.push(cur);
          const [x, y, w, hh] = ops.slice(-4);
          subs.push({ closed: true, nodes: [P(x, y), P(x + w, y), P(x + w, y + hh), P(x, y + hh)].map(p => ({ ...p, in: null, out: null })) });
          cur = null; break;
        }
        case 'S': finish('s', false); break;
        case 's': if (cur) cur.closed = true; finish('s', false); break;
        case 'f': case 'F': case 'f*': finish('f', true); break;
        case 'B': case 'B*': case 'b': case 'b*': if (cur) cur.closed = true; finish('s', true); break;
        case 'n': finish(null, false); break;
        case 'RG': st.stroke = ops.slice(-3).map(Number); break;
        case 'rg': st.fill = ops.slice(-3).map(Number); break;
        case 'G': st.stroke = [n(0), n(0), n(0)]; break;
        case 'g': st.fill = [n(0), n(0), n(0)]; break;
        case 'K': { const [c, m, y, kk] = ops.slice(-4); st.stroke = [(1 - c) * (1 - kk), (1 - m) * (1 - kk), (1 - y) * (1 - kk)]; break; }
        case 'k': { const [c, m, y, kk] = ops.slice(-4); st.fill = [(1 - c) * (1 - kk), (1 - m) * (1 - kk), (1 - y) * (1 - kk)]; break; }
        case 'BT': skipped.text++; break;
        case 'BI': skipped.images++; { const s = new TextDecoder('latin1').decode(contentBytes.subarray(lx.p)); const e = s.indexOf('EI'); lx.p += e >= 0 ? e + 2 : s.length; } break;
        case 'Do': {
          const name = ops[ops.length - 1] && ops[ops.length - 1].name;
          const ref = (get(resources && resources.XObject) || {})[name];
          const xo = get(ref), o = objOf(ref);
          if (xo && xo.Subtype && xo.Subtype.name === 'Form' && o && o.stream) {
            const mtx = get(xo.Matrix) ? get(xo.Matrix).map(Number) : [1, 0, 0, 1, 0, 0];
            const saved = st;
            await run(await streamData(o, get), get(xo.Resources) || resources, mul(mtx, st.ctm));
            st = saved;
          } else if (xo && xo.Subtype && xo.Subtype.name === 'Image') skipped.images++;
          break;
        }
      }
      ops = [];
    }
  }
  const contents = get(page.Contents);
  const list = Array.isArray(contents) ? contents : [page.Contents];
  const parts = [];
  for (const c of list) { const o = objOf(c); if (o && o.stream) parts.push(await streamData(o, get)); }
  const all = new Uint8Array(parts.reduce((s, p) => s + p.length + 1, 0));
  let off = 0; for (const p of parts) { all.set(p, off); off += p.length; all[off++] = 10; }
  await run(all, get(page.Resources), [1, 0, 0, 1, 0, 0]);
  return { paths, pages: pages.length, skipped };
}

/* gelesene Pfade als Formen; Farbe → nächste Ebenenfarbe */
export function pdfShapes(res, doc) {
  const layers = doc.layers.filter(L => !L.isTool);
  const layerFor = rgb => {
    const c = rgb.map(v => v * 255);
    return layers.reduce((b, L) => { const l = hexRGB(L.color); const d = (l[0] - c[0]) ** 2 + (l[1] - c[1]) ** 2 + (l[2] - c[2]) ** 2; return d < b.d ? { d, i: L.index } : b; }, { d: Infinity, i: 0 }).i;
  };
  return res.paths.filter(p => p.subpaths.length).map(p => Shape.path(p.subpaths.map(s => ({ closed: s.closed, nodes: s.nodes.map(q => ({ x: q.x, y: q.y, in: q.in || null, out: q.out || null })) })), layerFor(p.color)));
}
