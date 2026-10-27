// render.js — Canvas-Darstellung: Bett, Raster, Formen, Auswahl, Lineale, Vorschau
import { Mat, V, boxValid, boxW, boxH } from './geom.js';
import { shapeSubpaths, subpathToPoly, shapePolys, shapeBBox, walk } from './doc.js';
import { getImage, imagePreviewCanvas } from './raster.js';

export const RULER = 22;

export class View {
  constructor() { this.scale = 2; this.ox = 60; this.oy = 60; }
  toScreen(p, h) { return { x: p.x * this.scale + this.ox, y: h - (p.y * this.scale + this.oy) }; }
  toWorld(p, h) { return { x: (p.x - this.ox) / this.scale, y: (h - p.y - this.oy) / this.scale }; }
  fit(box, cw, ch, pad = 40) {
    const w = Math.max(1e-6, box.x1 - box.x0), hh = Math.max(1e-6, box.y1 - box.y0);
    const aw = Math.max(50, cw - pad * 2 - RULER), ah = Math.max(50, ch - pad * 2 - RULER);
    this.scale = Math.max(0.05, Math.min(aw / w, ah / hh));
    this.ox = pad + RULER - box.x0 * this.scale + (aw - w * this.scale) / 2;
    this.oy = pad - box.y0 * this.scale + (ah - hh * this.scale) / 2;
  }
}

const pathCache = new Map();
export function invalidateShape(sh) { if (sh) pathCache.delete(sh.id); }
export function invalidateAll() { pathCache.clear(); }

function sig(sh) {
  switch (sh.type) {
    case 'rect': return `r${sh.w},${sh.h},${sh.r}`;
    case 'ellipse': return `e${sh.rx},${sh.ry}`;
    case 'polygon': return `p${sh.r},${sh.n},${sh.star}`;
    case 'text': return `t${sh.text}|${sh.font}|${sh.size}|${sh.bold}|${sh.italic}|${sh.hspace}|${sh.vspace}|${sh.align}`;
    case 'image': return `i${sh.w},${sh.h}`;
    case 'path': return 'P' + (sh._v || 0) + ':' + sh.subpaths.length;
    default: return '';
  }
}
export function getSubs(sh, ctx) {
  const k = sh.id, s = sig(sh);
  const c = pathCache.get(k);
  if (c && c.sig === s) return c.subs;
  const subs = shapeSubpaths(sh, ctx.fontProvider);
  const p2 = new Path2D();
  for (const sp of subs) {
    const n = sp.nodes;
    if (!n.length) continue;
    p2.moveTo(n[0].x, n[0].y);
    const cnt = sp.closed ? n.length : n.length - 1;
    for (let i = 0; i < cnt; i++) {
      const a = n[i], b = n[(i + 1) % n.length];
      if (a.out || b.in) p2.bezierCurveTo((a.out || a).x, (a.out || a).y, (b.in || b).x, (b.in || b).y, b.x, b.y);
      else p2.lineTo(b.x, b.y);
    }
    if (sp.closed) p2.closePath();
  }
  pathCache.set(k, { sig: s, subs, p2 });
  return subs;
}
export function getPath2D(sh, ctx) { getSubs(sh, ctx); return pathCache.get(sh.id).p2; }

export function render(cv, doc, view, state, ctxGeo) {
  const dpr = window.devicePixelRatio || 1;
  const w = cv.clientWidth, h = cv.clientHeight;
  if (cv.width !== Math.round(w * dpr) || cv.height !== Math.round(h * dpr)) {
    cv.width = Math.round(w * dpr); cv.height = Math.round(h * dpr);
  }
  const g = cv.getContext('2d');
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  g.clearRect(0, 0, w, h);
  g.fillStyle = state.dark ? '#1b1d22' : '#e9ecf1';
  g.fillRect(0, 0, w, h);

  const M = doc.machine;
  const base = () => g.setTransform(dpr * view.scale, 0, 0, -dpr * view.scale, dpr * view.ox, dpr * (h - view.oy));
  base();
  const px = 1 / view.scale;

  // Bett
  g.fillStyle = state.dark ? '#25272e' : '#ffffff';
  g.fillRect(0, 0, M.width, M.height);
  // Raster
  const gs = doc.settings.gridSize;
  if (gs > 0 && gs * view.scale > 4) {
    g.lineWidth = px;
    g.strokeStyle = state.dark ? '#33363f' : '#e4e8ef';
    g.beginPath();
    for (let x = 0; x <= M.width + 1e-6; x += gs) { g.moveTo(x, 0); g.lineTo(x, M.height); }
    for (let y = 0; y <= M.height + 1e-6; y += gs) { g.moveTo(0, y); g.lineTo(M.width, y); }
    g.stroke();
    if (gs * view.scale > 30) {
      g.strokeStyle = state.dark ? '#3d4150' : '#cfd6e2';
      g.beginPath();
      for (let x = 0; x <= M.width + 1e-6; x += gs * 5) { g.moveTo(x, 0); g.lineTo(x, M.height); }
      for (let y = 0; y <= M.height + 1e-6; y += gs * 5) { g.moveTo(0, y); g.lineTo(M.width, y); }
      g.stroke();
    }
  }
  // Bettrahmen
  g.lineWidth = 1.5 * px;
  g.strokeStyle = state.dark ? '#6b7280' : '#9aa3b2';
  g.strokeRect(0, 0, M.width, M.height);

  // Formen
  const selSet = new Set(state.selection.map(s => s.id));
  if (state.showFill) drawLayerFills(g, doc, ctxGeo, state);
  drawShapes(g, doc.shapes, doc, ctxGeo, view, state, Mat.id(), px);
  drawLockMarks(g, doc, ctxGeo, px);

  // Auswahl
  if (state.selection.length) drawSelection(g, doc, state, ctxGeo, px, view);

  // Werkzeug-Overlay
  if (state.overlay) state.overlay(g, px);
  // Zusätzliche Overlays (z. B. Live-Vorschau beim Nachzeichnen)
  if (state.aux) for (const fn of state.aux) { if (fn) fn(g, px); }

  // Vorschau der Werkzeugwege
  if (state.preview && state.preview.ops) drawPreview(g, state.preview, px);

  // Lineale (Bildschirmkoordinaten)
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  drawRulers(g, w, h, view, state);
  return { w, h };
}

/* Kleines Schloss an der oberen rechten Ecke gesperrter Objekte */
function drawLockMarks(g, doc, ctxGeo, px) {
  for (const sh of doc.shapes) {
    if (!sh.locked || sh.hidden) continue;
    const L = layerOf(doc, sh.layer);
    if (L && !L.show) continue;
    const b = shapeBBox(sh, ctxGeo);
    if (!boxValid(b)) continue;
    const s = 11 * px, x = b.x1 + 2 * px, y = b.y1 - s;   // y zeigt nach oben
    g.save();
    g.fillStyle = '#e5a50a'; g.strokeStyle = '#e5a50a'; g.lineWidth = 1.6 * px;
    g.fillRect(x, y, s, s * .62);
    g.beginPath();
    g.arc(x + s / 2, y + s * .62, s * .3, 0, Math.PI);
    g.stroke();
    g.restore();
  }
}
function layerOf(doc, i) { return doc.layers[i] || doc.layers[0]; }

const isFillMode = L => L.mode === 'fill' || L.mode === 'fill+line' || L.mode === 'offset';
/* Füllungen je Ebene gemeinsam nach der Gerade-Ungerade-Regel zeichnen – wie beim
   Erzeugen des Jobs (scanFill über alle Konturen der Ebene): eine Form innerhalb
   einer anderen auf derselben Füll-Ebene bleibt als Loch ausgespart. */
function drawLayerFills(g, doc, ctxGeo, state) {
  const byLayer = new Map();
  const collect = (shapes, parent) => {
    for (const sh of shapes) {
      if (sh.hidden) continue;
      const L = layerOf(doc, sh.layer);
      if (L && !L.show) continue;
      const m = Mat.mul(sh.transform, parent);
      if (sh.type === 'group') { collect(sh.children, m); continue; }
      if (sh.type === 'image' || !L || !isFillMode(L)) continue;
      let p = byLayer.get(L);
      if (!p) byLayer.set(L, p = new Path2D());
      p.addPath(getPath2D(sh, ctxGeo), new DOMMatrix(m));
    }
  };
  collect(doc.shapes, Mat.id());
  for (const [L, p] of byLayer) {
    g.fillStyle = hexA(L.color, state.dark ? 0.45 : 0.3);
    g.fill(p, 'evenodd');
  }
}

const rectPath = (w, h) => { const p = new Path2D(); p.rect(0, 0, w, h); return p; };
function drawShapes(g, shapes, doc, ctxGeo, view, state, parent, px) {
  for (const sh of shapes) {
    if (sh.hidden) continue;
    const L = layerOf(doc, sh.layer);
    if (L && !L.show) continue;
    const m = Mat.mul(sh.transform, parent);
    if (sh.type === 'group') { drawShapes(g, sh.children, doc, ctxGeo, view, state, m, px); continue; }
    g.save();
    g.transform(m[0], m[1], m[2], m[3], m[4], m[5]);
    if (sh.type === 'image') {
      const im = getImage(sh.src);
      if (im.complete && im.naturalWidth) {
        // Vorschau der Gravur (Graustufen/Dither/Schwelle) statt Originalbild
        let src = im, prevCols = 0;
        if (state.imagePreview !== false || sh._pv) {
          const pv = imagePreviewCanvas(sh, L ? L.interval : .1, sh._pv, state.fastPreview ? 3.2e5 : 0);
          if (pv) { src = pv; prevCols = pv.width; }
        }
        g.save();
        g.translate(0, sh.h); g.scale(1, -1);
        g.globalAlpha = sh.hidden ? .3 : 1;
        // Beim Hineinzoomen die einzelnen Gravurpunkte scharf zeichnen
        if (prevCols) {
          const pxPerCell = (sh.w / prevCols) * view.scale * Mat.scaleFactor(m);
          g.imageSmoothingEnabled = pxPerCell < 1.6;
        }
        try { g.drawImage(src, 0, 0, sh.w, sh.h); } catch (e) { }
        g.restore();
      }
      g.restore();
      // Rahmen in Weltkoordinaten zeichnen (siehe unten), damit er überall gleich dick ist
      const frame = new Path2D(); frame.addPath(rectPath(sh.w, sh.h), new DOMMatrix(m));
      g.save();
      g.strokeStyle = displayColor(L.color, state.dark); g.lineWidth = px;
      g.setLineDash([4 * px, 3 * px]);
      g.stroke(frame);
      g.restore();
      continue;
    }
    // Kontur erst in Weltkoordinaten umrechnen und dann zeichnen: mit der Formmatrix als Zeichen-
    // transformation würde ungleichmäßiges Skalieren (z. B. nur in der Breite gezogen) auch die
    // Linienstärke verzerren – waagrechte und senkrechte Linien wären unterschiedlich dick
    g.restore();
    const wp = new Path2D(); wp.addPath(getPath2D(sh, ctxGeo), new DOMMatrix(m));
    g.save();
    g.strokeStyle = displayColor(L.color, state.dark);
    g.lineWidth = px * 1.2;
    g.lineJoin = 'round'; g.lineCap = 'round';
    g.stroke(wp);
    g.restore();
  }
}
// Sehr dunkle Ebenenfarben im Dunkeldesign aufhellen, damit sie sichtbar bleiben
export function displayColor(hex, dark) {
  if (!dark) return hex;
  const h = hex.replace('#', '');
  const r = parseInt(h.slice(0, 2), 16), g = parseInt(h.slice(2, 4), 16), b = parseInt(h.slice(4, 6), 16);
  const lum = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
  if (lum > 0.28) return hex;
  const k = (0.62 - lum);
  const mix = v => Math.round(v + (235 - v) * k);
  return `rgb(${mix(r)},${mix(g)},${mix(b)})`;
}
function hexA(hex, a) {
  const h = hex.replace('#', '');
  const r = parseInt(h.slice(0, 2), 16), gg = parseInt(h.slice(2, 4), 16), b = parseInt(h.slice(4, 6), 16);
  return `rgba(${r},${gg},${b},${a})`;
}

export function selectionBox(doc, state, ctxGeo) {
  let b = { x0: Infinity, y0: Infinity, x1: -Infinity, y1: -Infinity };
  for (const s of state.selection) {
    const sb = shapeBBox(s, ctxGeo, s._parentMat || Mat.id());
    b = { x0: Math.min(b.x0, sb.x0), y0: Math.min(b.y0, sb.y0), x1: Math.max(b.x1, sb.x1), y1: Math.max(b.y1, sb.y1) };
  }
  return b;
}

export const HANDLES = [
  { id: 'nw', fx: 0, fy: 1 }, { id: 'n', fx: .5, fy: 1 }, { id: 'ne', fx: 1, fy: 1 },
  { id: 'w', fx: 0, fy: .5 }, { id: 'e', fx: 1, fy: .5 },
  { id: 'sw', fx: 0, fy: 0 }, { id: 's', fx: .5, fy: 0 }, { id: 'se', fx: 1, fy: 0 }
];

/* Dreh-Anfasser wie in LightBurn: Viertelkreis außen an jeder Ecke des Auswahlrahmens.
   Radius und Greifbreite in Bildschirmpixeln; dx/dy zeigen von der Ecke nach außen (Welt: y nach oben). */
export const ROT_R = 17, ROT_GRIP = 7;
export function rotateCorners(b) {
  return [[0, 0], [1, 0], [0, 1], [1, 1]].map(([fx, fy]) => ({
    x: fx ? b.x1 : b.x0, y: fy ? b.y1 : b.y0, dx: fx ? 1 : -1, dy: fy ? 1 : -1
  }));
}

function drawRotateArcs(g, b, px) {
  const r = ROT_R * px, head = 4 * px;
  g.save();
  g.lineCap = 'round';
  for (const c of rotateCorners(b)) {
    // Viertelkreis von der waagrechten zur senkrechten Richtung nach außen
    const a1 = c.dx > 0 ? 0 : Math.PI, a2 = c.dy > 0 ? Math.PI / 2 : -Math.PI / 2;
    const ccw = ((a2 - a1 + Math.PI * 2) % (Math.PI * 2)) > Math.PI;
    const arc = () => { g.beginPath(); g.arc(c.x, c.y, r, a1, a2, ccw); };
    g.strokeStyle = 'rgba(255,255,255,.85)'; g.lineWidth = 4.2 * px; arc(); g.stroke();
    g.strokeStyle = '#1e88ff'; g.lineWidth = 2 * px; arc(); g.stroke();
    // kleine Pfeilspitzen an beiden Enden (zeigen entlang des Bogens)
    g.fillStyle = '#1e88ff';
    for (const [a, s] of [[a1, ccw ? -1 : 1], [a2, ccw ? 1 : -1]]) {
      const ex = c.x + Math.cos(a) * r, ey = c.y + Math.sin(a) * r;
      const tx = -Math.sin(a) * s, ty = Math.cos(a) * s;      // Richtung vom Bogen weg
      const nx = Math.cos(a), ny = Math.sin(a);
      g.beginPath();
      g.moveTo(ex - tx * head * 1.4, ey - ty * head * 1.4);
      g.lineTo(ex + nx * head, ey + ny * head);
      g.lineTo(ex - nx * head, ey - ny * head);
      g.closePath(); g.fill();
    }
  }
  g.restore();
}

function drawSelection(g, doc, state, ctxGeo, px, view) {
  const b = selectionBox(doc, state, ctxGeo);
  if (!boxValid(b)) return;
  // Umrisse der ausgewählten Formen hervorheben: blauer Schein + blau gestrichelt – so sieht man auch bei
  // mehreren gewählten Objekten im großen Rahmen, welche dazugehören
  g.save();
  g.lineJoin = g.lineCap = 'round';
  const outline = new Path2D();
  for (const s of state.selection) for (const p of shapePolys(s, ctxGeo, s._parentMat || Mat.id())) {
    p.pts.forEach((q, i) => outline[i ? 'lineTo' : 'moveTo'](q.x, q.y));
    if (p.closed) outline.closePath();
  }
  g.strokeStyle = 'rgba(30,136,255,.3)'; g.lineWidth = 6 * px; g.stroke(outline);
  g.strokeStyle = '#ffffff'; g.lineWidth = 1.8 * px; g.stroke(outline);
  g.strokeStyle = '#1e88ff'; g.lineWidth = 1.8 * px; g.setLineDash([4 * px, 3 * px]); g.stroke(outline);
  g.setLineDash([]);
  g.lineCap = 'butt';
  // Rahmen um die ganze Auswahl
  g.strokeStyle = '#1e88ff';
  g.lineWidth = 1.6 * px;
  g.setLineDash([5 * px, 4 * px]);
  g.strokeRect(b.x0, b.y0, boxW(b), boxH(b));
  g.setLineDash([]);
  const hs = 4 * px;
  for (const H of HANDLES) {
    const x = b.x0 + boxW(b) * H.fx, y = b.y0 + boxH(b) * H.fy;
    g.fillStyle = state.rotateMode ? '#ff9800' : '#ffffff';
    g.strokeStyle = '#1e88ff'; g.lineWidth = 1.2 * px;
    if (state.rotateMode && H.fx !== .5 && H.fy !== .5) {
      g.beginPath(); g.arc(x, y, hs, 0, Math.PI * 2); g.fill(); g.stroke();
    } else {
      g.fillRect(x - hs, y - hs, hs * 2, hs * 2);
      g.strokeRect(x - hs, y - hs, hs * 2, hs * 2);
    }
  }
  g.restore();
  if (state.tool === 'select' && !(state.drag && state.drag.mode !== 'rotate')) drawRotateArcs(g, b, px);
}

function drawPreview(g, pv, px) {
  const { ops, upto } = pv;
  g.save();
  g.lineCap = 'round'; g.lineJoin = 'round';
  let pos = null;
  const n = upto == null ? ops.length : upto;
  for (let i = 0; i < n && i < ops.length; i++) {
    const op = ops[i];
    if (pv.showTravel && pos) {
      g.strokeStyle = 'rgba(255,80,80,.45)'; g.lineWidth = px;
      g.beginPath(); g.moveTo(pos.x, pos.y); g.lineTo(op.pts[0].x, op.pts[0].y); g.stroke();
    }
    const int = Math.max(.12, Math.min(1, op.power / 100));
    g.strokeStyle = op.kind === 'raster' ? `rgba(80,200,255,${int})` : `rgba(60,220,120,${.35 + .65 * int})`;
    g.lineWidth = (op.kind === 'fill' || op.kind === 'raster') ? Math.max(px, (op.layerRef.interval || .1)) : 2 * px;
    g.beginPath();
    g.moveTo(op.pts[0].x, op.pts[0].y);
    for (let k = 1; k < op.pts.length; k++) g.lineTo(op.pts[k].x, op.pts[k].y);
    if (op.closed) g.closePath();
    g.stroke();
    pos = op.closed ? op.pts[0] : op.pts[op.pts.length - 1];
  }
  if (pv.head) {
    g.fillStyle = '#ff3b30';
    g.beginPath(); g.arc(pv.head.x, pv.head.y, 4 * px, 0, Math.PI * 2); g.fill();
  }
  g.restore();
}

function niceStep(scale) {
  const target = 70 / scale;
  const pows = [1, 2, 5, 10, 20, 25, 50, 100, 200, 500, 1000];
  for (const p of pows) if (p >= target) return p;
  return 1000;
}

function drawRulers(g, w, h, view, state) {
  const bg = state.dark ? '#15171b' : '#f4f6f9';
  const fg = state.dark ? '#9aa3b2' : '#5b6472';
  g.fillStyle = bg;
  g.fillRect(0, 0, w, RULER);
  g.fillRect(0, 0, RULER, h);
  g.strokeStyle = state.dark ? '#2a2d35' : '#d6dbe4';
  g.lineWidth = 1;
  g.beginPath(); g.moveTo(0, RULER + .5); g.lineTo(w, RULER + .5);
  g.moveTo(RULER + .5, 0); g.lineTo(RULER + .5, h); g.stroke();
  g.fillStyle = fg; g.font = '10px system-ui, sans-serif';
  const step = niceStep(view.scale);
  const x0 = Math.floor(((RULER - view.ox) / view.scale) / step) * step;
  const x1 = (w - view.ox) / view.scale;
  g.textAlign = 'left'; g.textBaseline = 'top';
  g.beginPath();
  for (let x = x0; x <= x1; x += step) {
    const sx = x * view.scale + view.ox;
    if (sx < RULER) continue;
    g.moveTo(Math.round(sx) + .5, RULER - 6); g.lineTo(Math.round(sx) + .5, RULER);
    g.fillText(String(Math.round(x)), sx + 2, 4);
  }
  const yTop = (h - RULER - view.oy) / view.scale;
  const y0 = Math.floor((-view.oy / view.scale) / step) * step;
  for (let y = y0; y <= yTop; y += step) {
    const sy = h - (y * view.scale + view.oy);
    if (sy < RULER) continue;
    g.moveTo(RULER - 6, Math.round(sy) + .5); g.lineTo(RULER, Math.round(sy) + .5);
    g.save(); g.translate(4, sy - 2); g.rotate(-Math.PI / 2);
    g.textAlign = 'left'; g.fillText(String(Math.round(y)), 0, 0);
    g.restore();
  }
  g.strokeStyle = fg; g.stroke();
  g.fillStyle = bg; g.fillRect(0, 0, RULER, RULER);
  g.fillStyle = fg; g.font = '9px system-ui'; g.fillText('mm', 3, 6);
}
