// lbrn.js — Import von LightBurn-Projekten (.lbrn / .lbrn2)
import { Mat } from './geom.js';
import { Shape } from './doc.js';
import { loc } from './i18n.js';

const num = (v, d = 0) => { const n = parseFloat(v); return isFinite(n) ? n : d; };
const attr = (el, name, d) => (el.hasAttribute(name) ? el.getAttribute(name) : d);
function childValue(el, tag, d) {
  for (const c of el.children) if (c.tagName === tag) return c.getAttribute('Value');
  return d;
}
function xform(el) {
  for (const c of el.children) {
    if (c.tagName === 'XForm') {
      const a = c.textContent.trim().split(/\s+/).map(Number);
      if (a.length >= 6 && a.every(isFinite)) return a.slice(0, 6);
    }
  }
  return Mat.id();
}

/* VertList: "V<x> <y>" mit optionalen Kontrollpunkten c0 (vorwärts) und c1 (rückwärts).
   Ein Handle zählt nur, wenn x UND y vorhanden sind ("c0x1" allein heißt: kein Handle). */
export function parseVertList(text) {
  const verts = [];
  const re = /V(-?[\d.eE+-]+)\s+(-?[\d.eE+-]+)((?:c[01][xy]-?[\d.eE+-]+)*)/g;
  let m;
  while ((m = re.exec(text))) {
    const v = { x: num(m[1]), y: num(m[2]), c0: null, c1: null };
    const parts = {};
    const cre = /c([01])([xy])(-?[\d.eE+-]+)/g;
    let c;
    while ((c = cre.exec(m[3]))) parts[c[1] + c[2]] = num(c[3]);
    if (parts['0x'] !== undefined && parts['0y'] !== undefined) v.c0 = { x: parts['0x'], y: parts['0y'] };
    if (parts['1x'] !== undefined && parts['1y'] !== undefined) v.c1 = { x: parts['1x'], y: parts['1y'] };
    verts.push(v);
  }
  return verts;
}
export function parsePrimList(text) {
  const prims = [];
  const re = /([LB])(\d+)\s+(\d+)/g;
  let m;
  while ((m = re.exec(text))) prims.push({ t: m[1], a: +m[2], b: +m[3] });
  return prims;
}

/* Kanten zu Teilpfaden verketten */
export function buildSubpaths(verts, prims) {
  const subs = [];
  let cur = null, first = -1, last = -1;
  const nodeOf = i => ({ x: verts[i].x, y: verts[i].y, in: null, out: null });
  const close = () => {
    if (!cur || cur.nodes.length < 2) { cur = null; return; }
    if (first === last && cur.nodes.length > 2) {
      const f = cur.nodes[0], l = cur.nodes[cur.nodes.length - 1];
      f.in = l.in;                 // Schließkurve auf den ersten Knoten übertragen
      cur.nodes.pop();
      cur.closed = true;
    }
    subs.push(cur);
    cur = null;
  };
  for (const p of prims) {
    if (!verts[p.a] || !verts[p.b]) continue;
    if (!cur || last !== p.a) {
      close();
      cur = { closed: false, nodes: [nodeOf(p.a)] };
      first = p.a;
    }
    const prev = cur.nodes[cur.nodes.length - 1];
    const n = nodeOf(p.b);
    if (p.t === 'B') {
      if (verts[p.a].c0) prev.out = { ...verts[p.a].c0 };
      if (verts[p.b].c1) n.in = { ...verts[p.b].c1 };
    }
    cur.nodes.push(n);
    last = p.b;
  }
  close();
  return subs.filter(s => s.nodes.length > 1);
}

/* CutSetting -> Ebene */
function applyCutSetting(cs, layers) {
  const idx = parseInt(childValue(cs, 'index', '0'), 10);
  if (!(idx >= 0 && idx < layers.length)) return null;
  const L = layers[idx];
  const type = cs.getAttribute('type') || 'Cut';
  const name = childValue(cs, 'name', '');
  if (name && !/^C\d+$/.test(name) && name !== 'T1' && name !== 'T2') L.name = name;
  L.mode = type === 'Scan' ? 'fill' : type === 'Tool' ? 'line' : 'line';
  L.isTool = type === 'Tool';
  const set = (tag, fn) => { const v = childValue(cs, tag); if (v !== undefined && v !== null) fn(num(v)); };
  set('maxPower', v => L.maxPower = v);
  set('minPower', v => L.minPower = v);
  set('speed', v => L.speed = v);
  set('numPasses', v => L.passes = Math.max(1, Math.round(v)));
  set('priority', v => L.priority = v);
  set('interval', v => { if (v > 0) L.interval = v; });
  set('overscan', v => L.overscan = v);
  set('dotTime', v => L.dotTime = v);
  set('kerf', v => L.kerf = v);
  set('tabsEnabled', v => L.tabs.enabled = !!v);
  set('tabCount', v => L.tabs.count = Math.max(1, Math.round(v)));
  set('runBlower', v => L.airAssist = !!v);
  const out = childValue(cs, 'doOutput');
  L.output = out === undefined || out === null ? true : num(out) !== 0;
  const hide = childValue(cs, 'hide');
  L.show = !(hide !== undefined && hide !== null && num(hide) !== 0);
  if (L.isTool) L.output = false;
  return L;
}

/* Shape -> BeamSketch-Form */
function convertShape(el, layers, warn) {
  const type = el.getAttribute('Type');
  const cut = parseInt(el.getAttribute('CutIndex') || '0', 10) || 0;
  const layer = Math.max(0, Math.min(layers.length - 1, cut));
  const m = xform(el);
  let sh = null;

  const pathFrom = (vlEl, plEl) => {
    const verts = parseVertList(vlEl ? vlEl.textContent : '');
    const prims = parsePrimList(plEl ? plEl.textContent : '');
    const subs = buildSubpaths(verts, prims);
    return subs.length ? Shape.path(subs, layer) : null;
  };
  const find = tag => { for (const c of el.children) if (c.tagName === tag) return c; return null; };

  switch (type) {
    case 'Path':
      sh = pathFrom(find('VertList'), find('PrimList'));
      break;
    case 'Group': {
      const kidsEl = find('Children');
      const kids = [];
      if (kidsEl) for (const c of kidsEl.children) {
        if (c.tagName !== 'Shape') continue;
        const k = convertShape(c, layers, warn);
        if (k) kids.push(k);
      }
      if (kids.length) sh = Shape.group(kids, layer);
      break;
    }
    case 'Rect': {
      const w = num(el.getAttribute('W')), hh = num(el.getAttribute('H'));
      const cr = num(el.getAttribute('Cr'));
      if (w > 0 && hh > 0) {
        // LightBurn-Formen sind um ihren Ursprung zentriert
        sh = Shape.rect(0, 0, w, hh, layer, cr);
        sh.transform = Mat.translate(-w / 2, -hh / 2);
      }
      break;
    }
    case 'Ellipse': {
      const rx = num(el.getAttribute('Rx')), ry = num(el.getAttribute('Ry'));
      if (rx > 0 && ry > 0) { sh = Shape.ellipse(0, 0, rx, ry, layer); sh.transform = Mat.id(); }
      break;
    }
    case 'Text': {
      // Bevorzugt die von LightBurn mitgespeicherten Umrisse (schriftgetreu)
      const bp = find('BackupPath');
      if (bp) {
        const p = pathFrom((() => { for (const c of bp.children) if (c.tagName === 'VertList') return c; return null; })(),
          (() => { for (const c of bp.children) if (c.tagName === 'PrimList') return c; return null; })());
        if (p) { p.transform = xform(bp); p.name = el.getAttribute('Str') || 'Text'; sh = p; }
      }
      if (!sh) {
        const str = el.getAttribute('Str') || '';
        if (str) {
          sh = Shape.text(0, 0, str, layer);
          sh.size = num(el.getAttribute('H'), 20) || 20;
          const font = (el.getAttribute('Font') || '').split(',')[0];
          if (font) sh.font = font;
          const ah = num(el.getAttribute('Ah'), 0);
          sh.align = ah === 1 ? 'center' : ah === 2 ? 'right' : 'left';
          sh.transform = Mat.id();
          warn.font = true;
        }
      }
      break;
    }
    case 'Bitmap': {
      const w = num(el.getAttribute('W')), hh = num(el.getAttribute('H'));
      const data = el.getAttribute('Data');
      if (w > 0 && hh > 0 && data) {
        sh = Shape.image(0, 0, w, hh, 'data:image/png;base64,' + data.replace(/\s+/g, ''), layer);
        sh.transform = Mat.translate(-w / 2, -hh / 2);
        sh.gamma = num(el.getAttribute('Gamma'), 1) || 1;
        sh.contrast = num(el.getAttribute('Contrast'), 0);
        sh.brightness = num(el.getAttribute('Brightness'), 0);
        sh.dither = 'stucki';
      } else if (w > 0 && hh > 0) {
        warn.image = true;
      }
      break;
    }
    default:
      warn.types = warn.types || new Set();
      warn.types.add(type);
      return null;
  }
  if (!sh) return null;
  sh.layer = layer;
  sh.transform = Mat.mul(sh.transform, m);
  return sh;
}

export function importLBRN(text, doc) {
  const dom = new DOMParser().parseFromString(text, 'application/xml');
  const err = dom.querySelector('parsererror');
  if (err) throw new Error(loc('Datei konnte nicht gelesen werden (kein gültiges XML)'));
  const root = dom.querySelector('LightBurnProject');
  if (!root) throw new Error(loc('Keine LightBurn-Projektdatei'));

  // Schnitteinstellungen übernehmen
  const touched = [];
  for (const cs of dom.querySelectorAll('CutSetting, CutSetting_Img')) {
    const L = applyCutSetting(cs, doc.layers);
    if (L) touched.push(L.index);
  }
  const warn = {};
  const shapes = [];
  for (const el of root.children) {
    if (el.tagName !== 'Shape') continue;
    const s = convertShape(el, doc.layers, warn);
    if (s) shapes.push(s);
  }
  return {
    shapes,
    layers: touched,
    device: root.getAttribute('DeviceName') || '',
    version: root.getAttribute('AppVersion') || '',
    warn
  };
}
