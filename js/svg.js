// svg.js — SVG-Import (Pfade, Formen, Transformationen, Stile) und -Export
import { Mat, V, arcToCubics } from './geom.js';
import { Shape, nodeSub, LAYER_COLORS, shapePolys, walk } from './doc.js';
import { loc } from './i18n.js';

const UNIT = { px: 25.4 / 96, pt: 25.4 / 72, pc: 25.4 / 6, mm: 1, cm: 10, in: 25.4, '': 1 };
function toMM(v, def = 0) {
  if (v == null) return def;
  const m = String(v).trim().match(/^(-?[\d.eE+-]+)\s*([a-z%]*)$/);
  if (!m) return def;
  const n = parseFloat(m[1]);
  if (!isFinite(n)) return def;
  return n * (UNIT[m[2]] !== undefined ? UNIT[m[2]] : 1);
}
function num(v, def = 0) { const n = parseFloat(v); return isFinite(n) ? n : def; }

function parseTransform(str) {
  let m = Mat.id();
  if (!str) return m;
  const re = /(matrix|translate|scale|rotate|skewX|skewY)\s*\(([^)]*)\)/g;
  let t;
  while ((t = re.exec(str))) {
    const a = t[2].split(/[\s,]+/).filter(s => s.length).map(Number);
    let n = Mat.id();
    switch (t[1]) {
      case 'matrix': n = [a[0], a[1], a[2], a[3], a[4], a[5]]; break;
      case 'translate': n = Mat.translate(a[0] || 0, a[1] || 0); break;
      case 'scale': n = Mat.scale(a[0], a.length > 1 ? a[1] : a[0]); break;
      case 'rotate': {
        const r = Mat.rotate((a[0] || 0) * Math.PI / 180);
        n = (a.length > 2) ? Mat.aroundPoint(r, a[1], a[2]) : r;
        break;
      }
      case 'skewX': n = [1, 0, Math.tan((a[0] || 0) * Math.PI / 180), 1, 0, 0]; break;
      case 'skewY': n = [1, Math.tan((a[0] || 0) * Math.PI / 180), 0, 1, 0, 0]; break;
    }
    m = Mat.mul(n, m);
  }
  return m;
}

/* ---- Pfad-Daten ---- */
export function parsePathData(d) {
  const subs = [];
  let cur = null, start = null, pos = { x: 0, y: 0 }, lastC = null, lastQ = null;
  const tok = String(d).match(/[MmZzLlHhVvCcSsQqTtAa]|[-+]?(?:\d*\.\d+|\d+\.?)(?:[eE][-+]?\d+)?/g) || [];
  let i = 0, cmd = null;
  const nx = () => parseFloat(tok[i++]);
  const newSub = () => { cur = { closed: false, nodes: [] }; subs.push(cur); };
  const push = (p, inC, outC) => {
    cur.nodes.push({ x: p.x, y: p.y, in: inC || null, out: outC || null });
  };
  const arity = { M: 2, L: 2, H: 1, V: 1, C: 6, S: 4, Q: 4, T: 2, A: 7, Z: 0 };
  const command = t => /^[MmZzLlHhVvCcSsQqTtAa]$/.test(t);
  const invalid = () => new Error(loc('Keine gültige SVG-Datei'));
  while (i < tok.length) {
    const before = i;
    if (/[MmZzLlHhVvCcSsQqTtAa]/.test(tok[i])) cmd = tok[i++];
    if (!cmd || (!cur && cmd.toUpperCase() !== 'M')) throw invalid();
    const count = arity[cmd.toUpperCase()];
    if (i + count > tok.length || tok.slice(i, i + count).some(t => command(t) || !Number.isFinite(Number(t)))) throw invalid();
    const rel = cmd === cmd.toLowerCase();
    const R = p => rel ? { x: pos.x + p.x, y: pos.y + p.y } : p;
    switch (cmd.toUpperCase()) {
      case 'M': {
        const p = R({ x: nx(), y: nx() });
        newSub(); push(p); pos = p; start = p; lastC = lastQ = null;
        cmd = rel ? 'l' : 'L';
        break;
      }
      case 'L': { const p = R({ x: nx(), y: nx() }); if (!cur) newSub(); push(p); pos = p; lastC = lastQ = null; break; }
      case 'H': { const x = rel ? pos.x + nx() : nx(); const p = { x, y: pos.y }; push(p); pos = p; lastC = lastQ = null; break; }
      case 'V': { const y = rel ? pos.y + nx() : nx(); const p = { x: pos.x, y }; push(p); pos = p; lastC = lastQ = null; break; }
      case 'C': {
        const c1 = R({ x: nx(), y: nx() }), c2 = R({ x: nx(), y: nx() }), p = R({ x: nx(), y: nx() });
        cur.nodes[cur.nodes.length - 1].out = c1;
        push(p, c2); pos = p; lastC = c2; lastQ = null; break;
      }
      case 'S': {
        const prev = cur.nodes[cur.nodes.length - 1];
        const c1 = lastC ? { x: 2 * pos.x - lastC.x, y: 2 * pos.y - lastC.y } : { x: pos.x, y: pos.y };
        const c2 = R({ x: nx(), y: nx() }), p = R({ x: nx(), y: nx() });
        prev.out = c1; push(p, c2); pos = p; lastC = c2; lastQ = null; break;
      }
      case 'Q': {
        const q = R({ x: nx(), y: nx() }), p = R({ x: nx(), y: nx() });
        const prev = cur.nodes[cur.nodes.length - 1];
        prev.out = { x: prev.x + 2 / 3 * (q.x - prev.x), y: prev.y + 2 / 3 * (q.y - prev.y) };
        push(p, { x: p.x + 2 / 3 * (q.x - p.x), y: p.y + 2 / 3 * (q.y - p.y) });
        pos = p; lastQ = q; lastC = null; break;
      }
      case 'T': {
        const q = lastQ ? { x: 2 * pos.x - lastQ.x, y: 2 * pos.y - lastQ.y } : { x: pos.x, y: pos.y };
        const p = R({ x: nx(), y: nx() });
        const prev = cur.nodes[cur.nodes.length - 1];
        prev.out = { x: prev.x + 2 / 3 * (q.x - prev.x), y: prev.y + 2 / 3 * (q.y - prev.y) };
        push(p, { x: p.x + 2 / 3 * (q.x - p.x), y: p.y + 2 / 3 * (q.y - p.y) });
        pos = p; lastQ = q; lastC = null; break;
      }
      case 'A': {
        const rx = Math.abs(nx()), ry = Math.abs(nx()), rot = nx() * Math.PI / 180;
        const laf = nx(), sf = nx();
        const p = R({ x: nx(), y: nx() });
        arcSeg(cur, pos, p, rx, ry, rot, laf, sf);
        pos = p; lastC = lastQ = null; break;
      }
      case 'Z': {
        if (cur) {
          cur.closed = true;
          const f = cur.nodes[0], l = cur.nodes[cur.nodes.length - 1];
          if (l && V.dist(f, l) < 1e-9 && cur.nodes.length > 1) { f.in = l.in; cur.nodes.pop(); }
          pos = start || pos;
        }
        cur = null; lastC = lastQ = null;
        break;
      }
      default: i++;
    }
    if (cmd === 'Z' || cmd === 'z') cmd = null;
    if (i <= before) throw invalid();
  }
  return subs.filter(s => s.nodes.length > 1);
}

function arcSeg(cur, p0, p1, rx, ry, rot, laf, sf) {
  if (rx === 0 || ry === 0) { cur.nodes.push({ x: p1.x, y: p1.y, in: null, out: null }); return; }
  const cosr = Math.cos(rot), sinr = Math.sin(rot);
  const dx2 = (p0.x - p1.x) / 2, dy2 = (p0.y - p1.y) / 2;
  const x1 = cosr * dx2 + sinr * dy2, y1 = -sinr * dx2 + cosr * dy2;
  let l = (x1 * x1) / (rx * rx) + (y1 * y1) / (ry * ry);
  if (l > 1) { const s = Math.sqrt(l); rx *= s; ry *= s; }
  let sq = (rx * rx * ry * ry - rx * rx * y1 * y1 - ry * ry * x1 * x1) / (rx * rx * y1 * y1 + ry * ry * x1 * x1);
  sq = Math.max(0, sq);
  let coef = Math.sqrt(sq) * (laf === sf ? -1 : 1);
  const cx1 = coef * rx * y1 / ry, cy1 = -coef * ry * x1 / rx;
  const cx = cosr * cx1 - sinr * cy1 + (p0.x + p1.x) / 2;
  const cy = sinr * cx1 + cosr * cy1 + (p0.y + p1.y) / 2;
  const ang = (ux, uy, vx, vy) => {
    const d = (ux * vx + uy * vy) / (Math.hypot(ux, uy) * Math.hypot(vx, vy));
    const a = Math.acos(Math.max(-1, Math.min(1, d)));
    return (ux * vy - uy * vx < 0) ? -a : a;
  };
  const th0 = ang(1, 0, (x1 - cx1) / rx, (y1 - cy1) / ry);
  let dth = ang((x1 - cx1) / rx, (y1 - cy1) / ry, (-x1 - cx1) / rx, (-y1 - cy1) / ry);
  if (!sf && dth > 0) dth -= 2 * Math.PI;
  if (sf && dth < 0) dth += 2 * Math.PI;
  const cs = arcToCubics(cx, cy, rx, ry, rot, th0, th0 + dth);
  for (const c of cs) {
    cur.nodes[cur.nodes.length - 1].out = c.c1;
    cur.nodes.push({ x: c.p3.x, y: c.p3.y, in: c.c2, out: null });
  }
}

/* ---- Import ---- */
export function importSVG(text, doc, opts = {}) {
  const dom = new DOMParser().parseFromString(text, 'image/svg+xml');
  const svg = dom.querySelector('svg');
  if (!svg) throw new Error(loc('Keine gültige SVG-Datei'));
  let vb = svg.getAttribute('viewBox');
  let vbx = 0, vby = 0, vbw = 0, vbh = 0;
  if (vb) { const a = vb.split(/[\s,]+/).map(Number); vbx = a[0]; vby = a[1]; vbw = a[2]; vbh = a[3]; }
  const wAttr = svg.getAttribute('width'), hAttr = svg.getAttribute('height');
  let wmm = wAttr ? toMM(wAttr) : 0, hmm = hAttr ? toMM(hAttr) : 0;
  if (!vbw) { vbw = wmm / (UNIT.px); vbh = hmm / UNIT.px; }
  if (!wmm) { wmm = vbw * UNIT.px; hmm = vbh * UNIT.px; }
  const sx = vbw ? wmm / vbw : UNIT.px, sy = vbh ? hmm / vbh : UNIT.px;
  // SVG: y nach unten. Ziel: y nach oben, Ursprung unten links.
  const root = Mat.mul(Mat.translate(-vbx, -vby), [sx, 0, 0, -sy, 0, hmm]);
  const shapes = [];
  const styleMap = new Map();
  walkSVG(svg, root, {}, shapes, doc, opts);
  return { shapes, width: wmm, height: hmm };
}

function inheritStyle(el, parent) {
  const st = { ...parent };
  const styleAttr = el.getAttribute && el.getAttribute('style');
  const get = k => {
    let v = el.getAttribute && el.getAttribute(k);
    if (styleAttr) {
      const m = styleAttr.match(new RegExp('(?:^|;)\\s*' + k + '\\s*:\\s*([^;]+)'));
      if (m) v = m[1].trim();
    }
    return v;
  };
  for (const k of ['stroke', 'fill', 'stroke-width', 'opacity', 'display', 'visibility']) {
    const v = get(k);
    if (v) st[k] = v;
  }
  return st;
}

function colorToLayer(st, doc) {
  const c = (st.stroke && st.stroke !== 'none') ? st.stroke : (st.fill && st.fill !== 'none' ? st.fill : null);
  if (!c) return 0;
  const rgb = parseColor(c);
  if (!rgb) return 0;
  let best = 0, bd = Infinity;
  doc.layers.forEach((L, i) => {
    if (L.isTool) return;
    const lc = parseColor(L.color);
    const d = (lc[0] - rgb[0]) ** 2 + (lc[1] - rgb[1]) ** 2 + (lc[2] - rgb[2]) ** 2;
    if (d < bd) { bd = d; best = i; }
  });
  return best;
}
export function parseColor(c) {
  if (!c) return null;
  c = c.trim();
  if (c[0] === '#') {
    let h = c.slice(1);
    if (h.length === 3) h = h.split('').map(x => x + x).join('');
    if (h.length < 6) return null;
    return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
  }
  const m = c.match(/rgba?\(([^)]+)\)/);
  if (m) { const a = m[1].split(',').map(s => parseFloat(s)); return [a[0], a[1], a[2]]; }
  const named = { black: [0, 0, 0], white: [255, 255, 255], red: [255, 0, 0], green: [0, 128, 0], blue: [0, 0, 255], yellow: [255, 255, 0], cyan: [0, 255, 255], magenta: [255, 0, 255], gray: [128, 128, 128], grey: [128, 128, 128] };
  return named[c.toLowerCase()] || null;
}

function walkSVG(el, mat, style, out, doc, opts) {
  for (const child of el.children) {
    const tag = child.tagName.toLowerCase();
    const st = inheritStyle(child, style);
    if (st.display === 'none' || st.visibility === 'hidden') continue;
    const m = Mat.mul(parseTransform(child.getAttribute('transform')), mat);
    const layer = opts.singleLayer != null ? opts.singleLayer : colorToLayer(st, doc);
    let sh = null;
    switch (tag) {
      case 'g': case 'a': case 'svg': {
        const kids = [];
        walkSVG(child, Mat.id(), st, kids, doc, opts);
        if (kids.length) { const gr = Shape.group(kids, layer); gr.transform = m; out.push(gr); }
        continue;
      }
      case 'path': {
        const subs = parsePathData(child.getAttribute('d') || '');
        if (subs.length) { sh = Shape.path(subs, layer); sh.transform = m; }
        break;
      }
      case 'rect': {
        const x = num(child.getAttribute('x')), y = num(child.getAttribute('y'));
        const w = num(child.getAttribute('width')), h = num(child.getAttribute('height'));
        const rx = num(child.getAttribute('rx') || child.getAttribute('ry'));
        if (w > 0 && h > 0) {
          sh = Shape.rect(0, 0, w, h, layer, rx);
          sh.transform = Mat.mul(Mat.translate(x, y), m);
        }
        break;
      }
      case 'circle': {
        const r = num(child.getAttribute('r'));
        sh = Shape.ellipse(0, 0, r, r, layer);
        sh.transform = Mat.mul(Mat.translate(num(child.getAttribute('cx')), num(child.getAttribute('cy'))), m);
        break;
      }
      case 'ellipse': {
        sh = Shape.ellipse(0, 0, num(child.getAttribute('rx')), num(child.getAttribute('ry')), layer);
        sh.transform = Mat.mul(Mat.translate(num(child.getAttribute('cx')), num(child.getAttribute('cy'))), m);
        break;
      }
      case 'line': {
        sh = Shape.path([nodeSub([{ x: num(child.getAttribute('x1')), y: num(child.getAttribute('y1')) },
        { x: num(child.getAttribute('x2')), y: num(child.getAttribute('y2')) }], false)], layer);
        sh.transform = m;
        break;
      }
      case 'polyline': case 'polygon': {
        const pts = (child.getAttribute('points') || '').split(/[\s,]+/).filter(s => s).map(Number);
        const arr = [];
        for (let i = 0; i + 1 < pts.length; i += 2) arr.push({ x: pts[i], y: pts[i + 1] });
        if (arr.length > 1) { sh = Shape.path([nodeSub(arr, tag === 'polygon')], layer); sh.transform = m; }
        break;
      }
      case 'text': {
        const t = child.textContent.trim();
        if (t) {
          sh = Shape.text(0, 0, t, layer);
          sh.size = num(child.getAttribute('font-size'), 16);
          const ff = child.getAttribute('font-family');
          if (ff) sh.font = ff.split(',')[0].replace(/['"]/g, '').trim();
          sh.transform = Mat.mul(Mat.mul(Mat.scale(1, -1), Mat.translate(num(child.getAttribute('x')), num(child.getAttribute('y')))), m);
        }
        break;
      }
      case 'image': {
        const href = child.getAttribute('href') || child.getAttribute('xlink:href');
        const w = num(child.getAttribute('width')), h = num(child.getAttribute('height'));
        if (href && w && h) {
          sh = Shape.image(0, 0, w, h, href, layer);
          sh.transform = Mat.mul(Mat.mul(Mat.translate(num(child.getAttribute('x')), num(child.getAttribute('y')) + h), Mat.scale(1, -1)), m);
        }
        break;
      }
      default: continue;
    }
    if (sh) out.push(sh);
  }
}

/* ---- Export ---- */
export function exportSVG(doc, ctx, sel = null) {
  const W = doc.machine.width, H = doc.machine.height;
  const list = sel && sel.length ? sel : doc.shapes;
  const parts = [];
  for (const sh of list) {
    const polys = shapePolys(sh, ctx);
    for (const p of polys) {
      const L = doc.layers[p.layer] || doc.layers[0];
      const d = p.pts.map((q, i) => (i ? 'L' : 'M') + q.x.toFixed(4) + ' ' + (H - q.y).toFixed(4)).join(' ') + (p.closed ? ' Z' : '');
      parts.push(`<path d="${d}" fill="none" stroke="${L.color}" stroke-width="0.2"/>`);
    }
  }
  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${W}mm" height="${H}mm" viewBox="0 0 ${W} ${H}">
${parts.join('\n')}
</svg>`;
}
