// main.js — Anwendungskern: Zustand, Eingabe, Werkzeuge, Befehle
import { Mat, V, boxValid, boxW, boxH, boxCenter, emptyBox, growBox, mergeBox, boolOp, offsetPolys, polyArea, cleanPoly, distToSeg, pointInPoly } from './geom.js';
import * as D from './doc.js';
import { newDoc, Shape, History, shapePolys, shapeBBox, shapesBBox, walk, removeShape, toPath, nodeSub, LAYER_COLORS, defaultMachine, layerNo } from './doc.js';
import { View, render, RULER, invalidateAll, invalidateShape, selectionBox, HANDLES, ROT_R, ROT_GRIP, rotateCorners, getSubs, displayColor } from './render.js';
import { textSubpaths, FontStore, loadFontFile, loadFontLibrary, ensureFont, isBundled, libraryEntry, preloadUsedFonts } from './font.js';
import { importSVG, exportSVG, parsePathData } from './svg.js';
import { importDXF } from './dxf.js';
import { importLBRN } from './lbrn.js';
import { buildJob, jobBounds } from './cam.js';
import { generateGCode, frameGCode, estimateTime, fmtTime, jobOffset } from './gcode.js';
import { GrblSerial } from './serial.js';
import { Library, Session, DEFAULT_MATERIALS } from './library.js';
import { showOnboarding, wasOnboarded, resetOnboarding, deviceChooser, applyDevice, loadDevices, confirmSafety } from './onboarding.js';
import { loadImage, getImage, grayscaleGrid, invalidateImagePreview, ImageCache } from './raster.js';
import { icon } from './icons.js';
import { h, $, toast, hint, modal, field, numInput, selectInput, checkbox, slider, segmented, dockPanel, closeDock, hasDock, fmtNum, buildLayers, buildPalette, cutSettingsDialog, langSelect, speedInput, layerLabel } from './ui.js';
import { speedUnit, setSpeedUnit, toDisp, fmtSpeed } from './units.js';
import { SYMBOLS, SYMBOL_CATS, symbolSVG, makeSymbolShape, UserSymbols } from './symbols.js';
import * as F from './features.js';
import { loc, locale, translateDOM } from './i18n.js';
import { Ext, loadExtensions } from './ext.js';
import { Projects, docData } from './projects.js';

const App = {
  doc: newDoc(),
  view: new View(),
  history: new History(),
  serial: new GrblSerial(),
  state: {
    tool: 'select', selection: [], selIds: new Set(), activeLayer: 0,
    dark: true, showFill: true, rotateMode: false, drag: null, overlay: null,
    preview: null, nodeSel: [], mouse: { x: 0, y: 0 }, snapGrid: false, snapObj: true,
    clipboard: null, showTravel: true,
    imagePreview: true, aux: []
  },
  ctxGeo: { tol: 0.02, fontProvider: textSubpaths }
};
window.App = App;
App.Shape = Shape;   // für Konsole/Tests
const cv = $('#cv');

/* ============ Grundfunktionen ============ */
let selBoxCache = null;   // Rahmen der Auswahl vom letzten Zeichnen (für den Mauszeiger beim Überfahren)
App.draw = () => {
  App.state.selection = resolveSel();
  render(cv, App.doc, App.view, App.state, App.ctxGeo);
  $('#stZoom').textContent = Math.round(App.view.scale * 25.4 / 96 * 100) + '%';
  const n = App.state.selection.length;
  const sb = n ? shapesBBox(App.state.selection, App.ctxGeo) : null;
  selBoxCache = sb;
  $('#stSel').textContent = n ? `${n > 1 ? loc('{n} Objekte', { n }) : loc('1 Objekt')} · ${boxW(sb).toFixed(1)} × ${boxH(sb).toFixed(1)} mm` : '–';
};
App.refresh = () => {
  App.state.selection = resolveSel();
  buildLayers(App); buildProps(); buildLaser(); buildToolbar(); App.draw();
  if (App.onHistory) App.onHistory();
};
App.commit = (label) => {
  App.history.push(App.doc, label);
  App.refresh();
  scheduleAutosave();
};
let autosaveT = null;
App.persist = () => scheduleAutosave();
function scheduleAutosave() {
  Projects.changed();   // verbundenes Server-Projekt nach kurzer Pause speichern
  clearTimeout(autosaveT);
  autosaveT = setTimeout(() => {
    autosaveT = null;
    const ok = Session.save(App.doc, App.history);
    const el = $('#stMsg');
    if (!ok && el && !el.textContent) toast(loc('Automatisches Speichern fehlgeschlagen (Speicher voll)'), 'err');
  }, 1200);
}

// Fenster wird geschlossen: ausstehende Sitzungssicherung sofort erledigen
window.addEventListener('pagehide', () => { if (autosaveT) { clearTimeout(autosaveT); autosaveT = null; Session.save(App.doc, App.history); } });

function resolveSel() {
  const out = [];
  for (const s of App.doc.shapes) if (App.state.selIds.has(s.id) && !s.locked) out.push(s);
  return out;
}
/* Gesperrte Objekte bleiben sichtbar und werden gelasert, lassen sich aber
   weder auswählen noch verschieben, bearbeiten oder löschen. */
const selectable = s => !s.hidden && !s.locked;
function lockSel() {
  const s = sel();
  if (!s.length) return toast(loc('Nichts ausgewählt'), 'err');
  for (const x of s) x.locked = true;
  setSel([]); App.commit(loc('Sperren'));
  toast(loc('{n} gesperrt – Doppelklick auf ein gesperrtes Objekt entsperrt es', { n: s.length }), 'ok');
}
function unlockShape(sh) {
  sh.locked = false;
  setSel([sh]); App.commit(loc('Entsperren'));
  toast(loc('Objekt entsperrt'), 'ok');
}
function unlockAll() {
  const list = App.doc.shapes.filter(s => s.locked);
  if (!list.length) return toast(loc('Keine gesperrten Objekte'));
  for (const x of list) x.locked = false;
  setSel(list); App.commit(loc('Alle entsperren'));
  toast(loc('{n} entsperrt', { n: list.length }), 'ok');
}
function countLocked() { return App.doc.shapes.filter(s => s.locked).length; }
function setSel(list, add = false) {
  if (!add) App.state.selIds.clear();
  for (const s of list) App.state.selIds.add(s.id);
  App.state.rotateMode = false;
  App.state.nodeSel = [];
  App.refresh();
}
App.setSel = setSel;
const sel = () => App.state.selection;

/* ============ Koordinaten ============ */
function evtWorld(e) {
  const r = cv.getBoundingClientRect();
  return App.view.toWorld({ x: e.clientX - r.left, y: e.clientY - r.top }, r.height);
}
function pxWorld(px = 1) { return px / App.view.scale; }

function snap(p, ignoreShapes) {
  const st = App.state;
  let best = { ...p }, bd = Infinity;
  if (st.snapObj) {
    const tol = pxWorld(9);
    for (const sh of App.doc.shapes) {
      if (sh.hidden || (ignoreShapes && ignoreShapes.includes(sh))) continue;
      for (const poly of shapePolys(sh, App.ctxGeo)) {
        for (const q of poly.pts) {
          const d = V.dist(p, q);
          if (d < tol && d < bd) { bd = d; best = { x: q.x, y: q.y }; }
        }
      }
      const b = shapeBBox(sh, App.ctxGeo);
      const c = boxCenter(b);
      const d = V.dist(p, c);
      if (d < tol && d < bd) { bd = d; best = c; }
    }
  }
  if (bd === Infinity && (st.snapGrid || App.doc.settings.snapGrid)) {
    const g = App.doc.settings.gridSize;
    best = { x: Math.round(p.x / g) * g, y: Math.round(p.y / g) * g };
  }
  return best;
}

/* ============ Trefferprüfung ============ */
function hitTest(p, tol, withLocked = false) {
  tol = tol || pxWorld(6);
  for (let i = App.doc.shapes.length - 1; i >= 0; i--) {
    const sh = App.doc.shapes[i];
    if (sh.hidden || (sh.locked && !withLocked)) continue;
    const L = App.doc.layers[sh.layer];
    if (L && !L.show) continue;
    const polys = shapePolys(sh, App.ctxGeo);
    for (const poly of polys) {
      const n = poly.pts.length;
      for (let k = 0; k < (poly.closed ? n : n - 1); k++) {
        if (distToSeg(p, poly.pts[k], poly.pts[(k + 1) % n]) <= tol) return sh;
      }
    }
    // Füllung / Bild
    const filled = sh.type === 'image' || (L && (L.mode === 'fill' || L.mode === 'fill+line' || L.mode === 'offset'));
    if (filled) {
      let inside = 0;
      for (const poly of polys) if (poly.closed && pointInPoly(p, poly.pts)) inside++;
      if (inside & 1) return sh;
    }
  }
  return null;
}
function shapesInBox(b) {
  return App.doc.shapes.filter(sh => {
    if (!selectable(sh)) return false;
    const L = App.doc.layers[sh.layer];
    if (L && !L.show) return false;
    const sb = shapeBBox(sh, App.ctxGeo);
    return boxValid(sb) && sb.x0 >= b.x0 && sb.y0 >= b.y0 && sb.x1 <= b.x1 && sb.y1 <= b.y1;
  });
}
function handleAt(p, b = sel().length ? selectionBox(App.doc, App.state, App.ctxGeo) : null) {
  if (!b) return null;
  if (!boxValid(b)) return null;
  const t = pxWorld(6);
  for (const H of HANDLES) {
    const x = b.x0 + boxW(b) * H.fx, y = b.y0 + boxH(b) * H.fy;
    if (Math.abs(p.x - x) <= t && Math.abs(p.y - y) <= t) return { ...H, box: b };
  }
  return null;
}

// Dreh-Anfasser (Viertelkreis außen an einer Ecke) unter dem Punkt?
function rotateArcAt(p, b = sel().length ? selectionBox(App.doc, App.state, App.ctxGeo) : null) {
  if (!b || !boxValid(b)) return false;
  const r = pxWorld(ROT_R), t = pxWorld(ROT_GRIP);
  return rotateCorners(b).some(c => {
    const vx = p.x - c.x, vy = p.y - c.y, d = Math.hypot(vx, vy);
    // auf dem Ring und im äußeren Viertel der Ecke (etwas Spielraum an den Bogenenden)
    return d >= r - t && d <= r + t && vx * c.dx >= -t * .5 && vy * c.dy >= -t * .5;
  });
}
// Mauszeiger zum Drehen (Pfeil im Kreis)
const ROTATE_CURSOR = `url("data:image/svg+xml,${encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24"><g fill="none" stroke-linecap="round" stroke-linejoin="round"><path d="M19 12a7 7 0 1 1-2.05-4.95" stroke="#fff" stroke-width="4.5"/><path d="M17.5 3.5v4h-4" stroke="#fff" stroke-width="4.5"/><path d="M19 12a7 7 0 1 1-2.05-4.95" stroke="#000" stroke-width="2"/><path d="M17.5 3.5v4h-4" stroke="#000" stroke-width="2"/></g></svg>')}") 12 12, crosshair`;

// Punkt innerhalb des blauen Auswahlrahmens? Dort lässt sich die Auswahl überall greifen und verschieben,
// auch zwischen dünnen Linien
function inSelBox(p, b = sel().length ? selectionBox(App.doc, App.state, App.ctxGeo) : null) {
  if (!b || !boxValid(b)) return false;
  const t = pxWorld(4);
  return p.x >= b.x0 - t && p.x <= b.x1 + t && p.y >= b.y0 - t && p.y <= b.y1 + t;
}

/* ============ Transformationen ============ */
function applyToSel(m) {
  for (const s of sel()) { s.transform = Mat.mul(s.transform, m); }
}
App.applyToSel = applyToSel;

/* ============ Zeichenwerkzeuge: Zustand ============ */
let pen = null;    // {nodes:[], closed}
let polyDraw = null;

/* ============ Maus / Zeiger ============ */
let panning = null, spaceDown = false, rightDown = null;

cv.addEventListener('contextmenu', e => e.preventDefault());
cv.addEventListener('wheel', e => {
  e.preventDefault();
  const r = cv.getBoundingClientRect();
  const mx = e.clientX - r.left, my = e.clientY - r.top;
  if (e.ctrlKey || e.metaKey || !e.shiftKey) {
    const before = App.view.toWorld({ x: mx, y: my }, r.height);
    const f = Math.pow(1.0015, -e.deltaY);
    App.view.scale = Math.max(0.05, Math.min(600, App.view.scale * f));
    const after = App.view.toWorld({ x: mx, y: my }, r.height);
    App.view.ox += (after.x - before.x) * App.view.scale;
    App.view.oy += (after.y - before.y) * App.view.scale;
  } else {
    App.view.ox -= e.deltaX; App.view.oy += e.deltaY;
  }
  App.draw();
}, { passive: false });

cv.addEventListener('pointerdown', e => {
  cv.setPointerCapture(e.pointerId);
  const w = evtWorld(e);
  App.state.mouse = w;
  // Rechtsklick ohne Ziehen öffnet beim Loslassen das Kontextmenü, Ziehen verschiebt die Ansicht
  rightDown = e.button === 2 ? { x: e.clientX, y: e.clientY } : null;
  if (e.button === 1 || (e.button === 0 && spaceDown) || e.button === 2 && App.state.tool === 'select' && !hitTest(w)) {
    panning = { sx: e.clientX, sy: e.clientY, ox: App.view.ox, oy: App.view.oy };
    return;
  }
  if (e.button !== 0) return;
  const T = tools[App.state.tool];
  if (T && T.down) T.down(w, e);
});

window.addEventListener('pointermove', e => {
  const r = cv.getBoundingClientRect();
  if (e.clientX < r.left || e.clientX > r.right) { }
  const w = evtWorld(e);
  App.state.mouse = w;
  $('#stPos').textContent = w.x.toFixed(2) + ', ' + w.y.toFixed(2);
  if (panning) {
    App.view.ox = panning.ox + (e.clientX - panning.sx);
    App.view.oy = panning.oy - (e.clientY - panning.sy);
    App.draw(); return;
  }
  const T = tools[App.state.tool];
  if (T && T.move) T.move(w, e);
});

window.addEventListener('pointerup', e => {
  if (e.button === 2 && rightDown) {
    const click = Math.hypot(e.clientX - rightDown.x, e.clientY - rightDown.y) < 5;
    rightDown = null;
    if (click) {
      if (panning) { App.view.ox = panning.ox; App.view.oy = panning.oy; panning = null; }
      contextMenu(e);
      return;
    }
  }
  if (panning) { panning = null; return; }
  const w = evtWorld(e);
  const T = tools[App.state.tool];
  if (T && T.up) T.up(w, e);
});
cv.addEventListener('dblclick', e => {
  const w = evtWorld(e);
  const T = tools[App.state.tool];
  if (T && T.dbl) T.dbl(w, e);
});

/* ============ Werkzeuge ============ */
const tools = {};

tools.select = {
  down(w, e) {
    const st = App.state;
    const hnd = handleAt(w);
    if (hnd) {
      const b = hnd.box;
      st.drag = st.rotateMode && hnd.fx !== .5 && hnd.fy !== .5
        ? { mode: 'rotate', center: boxCenter(b), start: w, a0: Math.atan2(w.y - boxCenter(b).y, w.x - boxCenter(b).x), snaps: snapshot() }
        : { mode: 'scale', h: hnd, box: b, snaps: snapshot() };
      return;
    }
    // Viertelkreis an einer Ecke: Auswahl um ihre Mitte drehen
    if (rotateArcAt(w)) {
      const c = boxCenter(selectionBox(App.doc, st, App.ctxGeo));
      st.drag = { mode: 'rotate', center: c, start: w, a0: Math.atan2(w.y - c.y, w.x - c.x), snaps: snapshot() };
      return;
    }
    const hit = hitTest(w);
    // leere Stelle im Auswahlrahmen: Auswahl verschieben (ein anderes Objekt darunter wird weiter normal gewählt)
    if (!hit && !e.shiftKey && inSelBox(w)) {
      st.drag = { mode: 'move', start: w, snaps: snapshot(), moved: false };
      return;
    }
    if (hit) {
      if (st.selIds.has(hit.id)) {
        if (!e.shiftKey && st.selIds.size === 1) { st.rotateMode = !st.rotateMode; App.draw(); }
        if (e.shiftKey) { st.selIds.delete(hit.id); App.refresh(); return; }
      } else setSel([hit], e.shiftKey);
      st.drag = { mode: 'move', start: w, snaps: snapshot(), moved: false };
    } else {
      if (!e.shiftKey) setSel([]);
      if (hitTest(w, 0, true)) toast(loc('Gesperrtes Objekt – Doppelklick entsperrt'));
      st.drag = { mode: 'marquee', start: w, cur: w };
      st.overlay = (g, px) => {
        const d = st.drag; if (!d || d.mode !== 'marquee') return;
        g.strokeStyle = '#12a594'; g.lineWidth = px; g.setLineDash([4 * px, 3 * px]);
        g.strokeRect(Math.min(d.start.x, d.cur.x), Math.min(d.start.y, d.cur.y), Math.abs(d.cur.x - d.start.x), Math.abs(d.cur.y - d.start.y));
        g.setLineDash([]);
      };
    }
  },
  move(w, e) {
    const d = App.state.drag;
    if (!d) {
      // Mauszeiger: Verschieben-Symbol im Auswahlrahmen, an den Anfassern der normale Pfeil
      if (!spaceDown && !panning && e.target === cv)
        cv.style.cursor = handleAt(w, selBoxCache) ? 'default' : rotateArcAt(w, selBoxCache) ? ROTATE_CURSOR
          : inSelBox(w, selBoxCache) ? 'move' : 'default';
      return;
    }
    if (d.mode === 'marquee') { d.cur = w; App.draw(); return; }
    if (d.mode === 'move') {
      let dx = w.x - d.start.x, dy = w.y - d.start.y;
      if (e.shiftKey) { if (Math.abs(dx) > Math.abs(dy)) dy = 0; else dx = 0; }
      if (App.state.snapGrid) { const g = App.doc.settings.gridSize; dx = Math.round(dx / g) * g; dy = Math.round(dy / g) * g; }
      restore(d.snaps);
      applyToSel(Mat.translate(dx, dy));
      d.moved = Math.abs(dx) + Math.abs(dy) > 1e-9;
      App.draw(); buildProps();
      return;
    }
    if (d.mode === 'scale') {
      const b = d.box, H = d.h;
      const ax = H.fx === 0 ? b.x1 : H.fx === 1 ? b.x0 : (b.x0 + b.x1) / 2;
      const ay = H.fy === 0 ? b.y1 : H.fy === 1 ? b.y0 : (b.y0 + b.y1) / 2;
      let sx = H.fx === .5 ? 1 : (w.x - ax) / ((H.fx === 0 ? b.x0 : b.x1) - ax);
      let sy = H.fy === .5 ? 1 : (w.y - ay) / ((H.fy === 0 ? b.y0 : b.y1) - ay);
      if (!isFinite(sx) || Math.abs(sx) < 1e-4) sx = 1e-4 * Math.sign(sx || 1);
      if (!isFinite(sy) || Math.abs(sy) < 1e-4) sy = 1e-4 * Math.sign(sy || 1);
      if (e.shiftKey || H.fx === .5 || H.fy === .5) {
        if (H.fx !== .5 && H.fy !== .5) { const s = Math.max(Math.abs(sx), Math.abs(sy)); sx = s * Math.sign(sx); sy = s * Math.sign(sy); }
      }
      restore(d.snaps);
      applyToSel(Mat.aroundPoint(Mat.scale(sx, sy), ax, ay));
      App.draw(); buildProps();
      return;
    }
    if (d.mode === 'rotate') {
      let a = Math.atan2(w.y - d.center.y, w.x - d.center.x) - d.a0;
      if (e.shiftKey) a = Math.round(a / (Math.PI / 12)) * (Math.PI / 12);
      restore(d.snaps);
      applyToSel(Mat.aroundPoint(Mat.rotate(a), d.center.x, d.center.y));
      // Winkel anzeigen (Shift rastet in 15°-Schritten ein)
      let deg = Math.round(a * 180 / Math.PI * 10) / 10;
      deg = ((deg + 180) % 360 + 360) % 360 - 180;
      hint(`↻ ${fmtNum(deg)}°`);
      App.draw(); buildProps();
    }
  },
  up(w, e) {
    const st = App.state, d = st.drag;
    st.overlay = null;
    if (!d) return;
    st.drag = null;
    if (d.mode === 'marquee') {
      const b = { x0: Math.min(d.start.x, d.cur.x), y0: Math.min(d.start.y, d.cur.y), x1: Math.max(d.start.x, d.cur.x), y1: Math.max(d.start.y, d.cur.y) };
      if (Math.abs(d.cur.x - d.start.x) > pxWorld(3)) setSel(shapesInBox(b), e.shiftKey);
      else App.draw();
      return;
    }
    if (d.mode === 'move' && !d.moved) { App.draw(); return; }
    if (d.mode === 'rotate') hint('');
    App.commit(d.mode === 'move' ? loc('Verschieben') : d.mode === 'scale' ? loc('Skalieren') : loc('Drehen'));
  },
  dbl(w) {
    const hit = hitTest(w, 0, true);
    if (hit && hit.locked) unlockShape(hit);
    else if (hit && hit.type === 'group') { ungroupOne(hit); App.commit('Gruppe betreten'); }
    else if (hit && hit.type === 'text') { setSel([hit]); buildProps(); const i = $('#txtInput'); if (i) { i.focus(); i.select(); } }
    else if (hit) { setSel([hit]); App.setTool('node'); }
  }
};

// Hilfsfunktionen für Erweiterungen (z. B. KI-Werkzeuge), siehe ext.js
const extHelpers = { setSel, viewCenter: () => viewCenter(), selectable: sh => selectable(sh), autoTrace: (src, w, hh, layer) => autoTrace(src, w, hh, layer) };

function snapshot() { return sel().map(s => ({ s, t: s.transform.slice() })); }
function restore(sn) { for (const r of sn) r.s.transform = r.t.slice(); }

/* --- Form-Zeichenwerkzeuge --- */
function drawTool(create, opts = {}) {
  return {
    down(w, e) {
      const p = snap(w);
      App.state.drag = { start: p, cur: p };
      App.state.overlay = (g, px) => {
        const d = App.state.drag; if (!d) return;
        g.strokeStyle = displayColor(App.doc.layers[App.state.activeLayer].color, App.state.dark);
        g.lineWidth = px * 1.2;
        opts.preview(g, d.start, d.cur, px, e);
      };
    },
    move(w, e) {
      const d = App.state.drag; if (!d) return;
      d.cur = snap(w); d.shift = e.shiftKey; d.alt = e.altKey;
      App.draw();
    },
    up(w, e) {
      const d = App.state.drag; if (!d) return;
      App.state.drag = null; App.state.overlay = null;
      const sh = create(d.start, snap(w), e);
      if (sh) {
        sh.layer = App.state.activeLayer;
        App.doc.shapes.push(sh);
        setSel([sh]);
        App.commit('Form erstellen');
        if (!App.state.stickyTool) App.setTool('select');
      } else App.draw();
    }
  };
}
tools.rect = drawTool((a, b, e) => {
  let x0 = Math.min(a.x, b.x), y0 = Math.min(a.y, b.y);
  let w = Math.abs(b.x - a.x), hh = Math.abs(b.y - a.y);
  if (e.shiftKey) { const s = Math.max(w, hh); w = hh = s; }
  if (w < 1e-3 || hh < 1e-3) return null;
  return Shape.rect(x0, y0, w, hh, 0, 0);
}, {
  preview: (g, a, b, px) => g.strokeRect(Math.min(a.x, b.x), Math.min(a.y, b.y), Math.abs(b.x - a.x), Math.abs(b.y - a.y))
});
tools.ellipse = drawTool((a, b, e) => {
  let rx = Math.abs(b.x - a.x) / 2, ry = Math.abs(b.y - a.y) / 2;
  if (e.shiftKey) rx = ry = Math.max(rx, ry);
  if (rx < 1e-3 || ry < 1e-3) return null;
  return Shape.ellipse((a.x + b.x) / 2, (a.y + b.y) / 2, rx, ry);
}, {
  preview: (g, a, b) => {
    g.beginPath();
    g.ellipse((a.x + b.x) / 2, (a.y + b.y) / 2, Math.abs(b.x - a.x) / 2, Math.abs(b.y - a.y) / 2, 0, 0, Math.PI * 2);
    g.stroke();
  }
});
tools.polygon = drawTool((a, b) => {
  const r = V.dist(a, b);
  if (r < 1e-3) return null;
  const s = Shape.polygon(a.x, a.y, r, App.state.polyN || 6, 0, App.state.polyStar || 0);
  return s;
}, {
  preview: (g, a, b) => {
    const r = V.dist(a, b), N = App.state.polyN || 6, star = App.state.polyStar || 0;
    g.beginPath();
    const cnt = star > 0 ? N * 2 : N;
    for (let i = 0; i < cnt; i++) {
      const ang = -Math.PI / 2 + i * (2 * Math.PI / cnt);
      const rr = star > 0 ? (i % 2 ? r * (1 - star) : r) : r;
      const x = a.x + Math.cos(ang) * rr, y = a.y + Math.sin(ang) * rr;
      i ? g.lineTo(x, y) : g.moveTo(x, y);
    }
    g.closePath(); g.stroke();
  }
});

/* --- Linienzug / Bezier (Stift) --- */
tools.pen = {
  down(w, e) {
    const p = snap(w);
    if (!pen) pen = { nodes: [], closed: false };
    if (pen.nodes.length > 2 && V.dist(p, pen.nodes[0]) < pxWorld(8)) { finishPen(true); return; }
    pen.nodes.push({ x: p.x, y: p.y, in: null, out: null });
    App.state.drag = { mode: 'penHandle', idx: pen.nodes.length - 1, start: p };
    setPenOverlay();
    App.draw();
  },
  move(w, e) {
    const d = App.state.drag;
    if (d && d.mode === 'penHandle') {
      const n = pen.nodes[d.idx];
      if (V.dist(w, d.start) > pxWorld(3)) {
        n.out = { x: w.x, y: w.y };
        n.in = { x: 2 * n.x - w.x, y: 2 * n.y - w.y };
      }
    }
    App.draw();
  },
  up() { App.state.drag = null; },
  dbl() { finishPen(false); }
};
function setPenOverlay() {
  App.state.overlay = (g, px) => {
    if (!pen || !pen.nodes.length) return;
    const L = App.doc.layers[App.state.activeLayer];
    g.strokeStyle = displayColor(L.color, App.state.dark); g.lineWidth = 1.3 * px;
    g.beginPath();
    const ns = pen.nodes;
    g.moveTo(ns[0].x, ns[0].y);
    for (let i = 1; i < ns.length; i++) {
      const a = ns[i - 1], b = ns[i];
      if (a.out || b.in) g.bezierCurveTo((a.out || a).x, (a.out || a).y, (b.in || b).x, (b.in || b).y, b.x, b.y);
      else g.lineTo(b.x, b.y);
    }
    const last = ns[ns.length - 1], m = App.state.mouse;
    if (last.out) g.bezierCurveTo(last.out.x, last.out.y, m.x, m.y, m.x, m.y); else g.lineTo(m.x, m.y);
    g.stroke();
    g.fillStyle = '#12a594';
    for (const n of ns) g.fillRect(n.x - 3 * px, n.y - 3 * px, 6 * px, 6 * px);
  };
}
function finishPen(close) {
  if (pen && pen.nodes.length > 1) {
    const sh = Shape.path([{ closed: close, nodes: pen.nodes }], App.state.activeLayer);
    App.doc.shapes.push(sh);
    setSel([sh]);
    App.commit('Pfad');
  }
  pen = null; App.state.overlay = null; App.draw();
}

tools.line = {
  down(w) {
    const p = snap(w);
    if (!polyDraw) polyDraw = { pts: [] };
    if (polyDraw.pts.length > 2 && V.dist(p, polyDraw.pts[0]) < pxWorld(8)) { finishPoly(true); return; }
    polyDraw.pts.push(p);
    App.state.overlay = (g, px) => {
      const L = App.doc.layers[App.state.activeLayer];
      g.strokeStyle = displayColor(L.color, App.state.dark); g.lineWidth = 1.3 * px;
      g.beginPath(); g.moveTo(polyDraw.pts[0].x, polyDraw.pts[0].y);
      for (const q of polyDraw.pts.slice(1)) g.lineTo(q.x, q.y);
      g.lineTo(App.state.mouse.x, App.state.mouse.y); g.stroke();
    };
    App.draw();
  },
  move() { App.draw(); },
  dbl() { finishPoly(false); }
};
function finishPoly(close) {
  if (polyDraw && polyDraw.pts.length > 1) {
    const sh = Shape.path([nodeSub(polyDraw.pts, close)], App.state.activeLayer);
    App.doc.shapes.push(sh); setSel([sh]); App.commit('Linienzug');
  }
  polyDraw = null; App.state.overlay = null; App.draw();
}

tools.text = {
  down(w) {
    const sh = Shape.text(w.x, w.y, loc('Text'), App.state.activeLayer);
    sh.size = App.state.lastFontSize || 20;
    sh.font = App.state.lastFont || 'Sans';
    App.doc.shapes.push(sh);
    setSel([sh]);
    App.commit('Text');
    App.setTool('select');
    setTimeout(() => { const i = $('#txtInput'); if (i) { i.focus(); i.select(); } }, 30);
  }
};

tools.measure = {
  down(w) {
    App.state.drag = { start: snap(w), cur: w };
    App.state.overlay = (g, px) => {
      const d = App.state.drag; if (!d) return;
      g.strokeStyle = '#ff9f43'; g.lineWidth = 1.4 * px;
      g.beginPath(); g.moveTo(d.start.x, d.start.y); g.lineTo(d.cur.x, d.cur.y); g.stroke();
      g.fillStyle = '#ff9f43';
      for (const p of [d.start, d.cur]) { g.beginPath(); g.arc(p.x, p.y, 3 * px, 0, 7); g.fill(); }
    };
  },
  move(w) {
    const d = App.state.drag; if (!d) return;
    d.cur = snap(w, []);
    const dx = d.cur.x - d.start.x, dy = d.cur.y - d.start.y;
    $('#hud').textContent = `Δ ${dx.toFixed(2)} × ${dy.toFixed(2)} mm | ${loc('Länge')} ${Math.hypot(dx, dy).toFixed(3)} mm | ${loc('Winkel')} ${(Math.atan2(dy, dx) * 180 / Math.PI).toFixed(2)}°`;
    App.draw();
  },
  up() { App.state.drag = null; }
};

/* --- Knoten-Editor --- */
tools.node = {
  down(w, e) {
    const st = App.state;
    const targets = sel().filter(s => s.type === 'path');
    if (!targets.length) { const hit = hitTest(w); if (hit) { setSel([hit]); if (hit.type !== 'path') convertToPath(); App.setTool('node'); } return; }
    const t = pxWorld(7);
    for (const sh of targets) {
      const m = sh.transform, mi = Mat.invert(m);
      const lp = Mat.apply(mi, w);
      const lt = t / Mat.scaleFactor(m);
      for (let si = 0; si < sh.subpaths.length; si++) {
        const sp = sh.subpaths[si];
        for (let ni = 0; ni < sp.nodes.length; ni++) {
          const n = sp.nodes[ni];
          for (const key of ['out', 'in']) {
            if (n[key] && V.dist(lp, n[key]) < lt) {
              st.drag = { mode: 'ctrl', sh, sp, n, key, alt: e.altKey };
              return;
            }
          }
          if (V.dist(lp, n) < lt) {
            if (e.altKey) { toggleSmooth(sp, ni); App.commit('Knotentyp'); return; }
            st.drag = { mode: 'node', sh, sp, n, off: { x: lp.x - n.x, y: lp.y - n.y } };
            st.nodeSel = [{ sh, sp, ni }];
            App.draw();
            return;
          }
        }
      }
    }
    st.nodeSel = [];
    App.draw();
  },
  move(w) {
    const d = App.state.drag; if (!d) return;
    const mi = Mat.invert(d.sh.transform);
    const lp = Mat.apply(mi, w);
    if (d.mode === 'node') {
      const dx = lp.x - d.off.x - d.n.x, dy = lp.y - d.off.y - d.n.y;
      d.n.x += dx; d.n.y += dy;
      if (d.n.in) { d.n.in.x += dx; d.n.in.y += dy; }
      if (d.n.out) { d.n.out.x += dx; d.n.out.y += dy; }
    } else if (d.mode === 'ctrl') {
      d.n[d.key] = { x: lp.x, y: lp.y };
      const other = d.key === 'in' ? 'out' : 'in';
      if (!d.alt && d.n[other]) {
        const len = V.dist(d.n, d.n[other]);
        const dir = V.norm(V.sub(d.n, d.n[d.key]));
        d.n[other] = { x: d.n.x + dir.x * len, y: d.n.y + dir.y * len };
      }
    }
    d.sh._v = (d.sh._v || 0) + 1;
    invalidateShape(d.sh);
    App.draw();
  },
  up() { if (App.state.drag) { App.state.drag = null; App.commit('Knoten bearbeiten'); } },
  dbl(w) {
    // Knoten auf Segment einfügen
    const targets = sel().filter(s => s.type === 'path');
    for (const sh of targets) {
      const mi = Mat.invert(sh.transform);
      const lp = Mat.apply(mi, w);
      const lt = pxWorld(7) / Mat.scaleFactor(sh.transform);
      for (const sp of sh.subpaths) {
        const n = sp.nodes;
        for (let i = 0; i < (sp.closed ? n.length : n.length - 1); i++) {
          const a = n[i], b = n[(i + 1) % n.length];
          if (!a.out && !b.in && distToSeg(lp, a, b) < lt) {
            n.splice(i + 1, 0, { x: lp.x, y: lp.y, in: null, out: null });
            sh._v = (sh._v || 0) + 1; invalidateShape(sh); App.commit('Knoten einfügen'); return;
          }
          if (a.out || b.in) {
            // Bezier: grob durch Abtastung
            for (let t = .05; t < 1; t += .05) {
              const p = bez(a, b, t);
              if (V.dist(lp, p) < lt) {
                splitBezier(sp, i, t); sh._v = (sh._v || 0) + 1; invalidateShape(sh); App.commit('Knoten einfügen'); return;
              }
            }
          }
        }
      }
    }
  }
};
function bez(a, b, t) {
  const p1 = a.out || a, p2 = b.in || b, mt = 1 - t;
  return {
    x: mt ** 3 * a.x + 3 * mt * mt * t * p1.x + 3 * mt * t * t * p2.x + t ** 3 * b.x,
    y: mt ** 3 * a.y + 3 * mt * mt * t * p1.y + 3 * mt * t * t * p2.y + t ** 3 * b.y
  };
}
function splitBezier(sp, i, t) {
  const n = sp.nodes, a = n[i], b = n[(i + 1) % n.length];
  const p0 = a, p1 = a.out || a, p2 = b.in || b, p3 = b;
  const l = V.lerp;
  const ab = l(p0, p1, t), bc = l(p1, p2, t), cd = l(p2, p3, t);
  const abc = l(ab, bc, t), bcd = l(bc, cd, t), m = l(abc, bcd, t);
  a.out = ab; b.in = cd;
  n.splice(i + 1, 0, { x: m.x, y: m.y, in: abc, out: bcd });
}
function toggleSmooth(sp, ni) {
  const n = sp.nodes[ni];
  if (n.in || n.out) { n.in = null; n.out = null; }
  else {
    const prev = sp.nodes[(ni - 1 + sp.nodes.length) % sp.nodes.length];
    const next = sp.nodes[(ni + 1) % sp.nodes.length];
    const dir = V.norm(V.sub(next, prev));
    const d1 = V.dist(n, prev) / 3, d2 = V.dist(n, next) / 3;
    n.in = { x: n.x - dir.x * d1, y: n.y - dir.y * d1 };
    n.out = { x: n.x + dir.x * d2, y: n.y + dir.y * d2 };
  }
}
function nodeOverlay(g, px) {
  if (App.state.tool !== 'node') return;
  for (const sh of sel()) {
    if (sh.type !== 'path') continue;
    const m = sh.transform;
    g.save(); g.transform(m[0], m[1], m[2], m[3], m[4], m[5]);
    const s = 1 / Mat.scaleFactor(m);
    for (const sp of sh.subpaths) {
      for (const n of sp.nodes) {
        g.strokeStyle = '#12a594'; g.lineWidth = px * s;
        for (const key of ['in', 'out']) {
          if (!n[key]) continue;
          g.beginPath(); g.moveTo(n.x, n.y); g.lineTo(n[key].x, n[key].y); g.stroke();
          g.fillStyle = '#ffb300';
          g.beginPath(); g.arc(n[key].x, n[key].y, 3 * px * s, 0, 7); g.fill();
        }
        g.fillStyle = (n.in || n.out) ? '#12a594' : '#ffffff';
        g.strokeStyle = '#0b3f7a';
        g.fillRect(n.x - 3.2 * px * s, n.y - 3.2 * px * s, 6.4 * px * s, 6.4 * px * s);
        g.strokeRect(n.x - 3.2 * px * s, n.y - 3.2 * px * s, 6.4 * px * s, 6.4 * px * s);
      }
    }
    g.restore();
  }
}

App.setTool = (t) => {
  if (pen) finishPen(false);
  if (polyDraw) finishPoly(false);
  const old = tools[App.state.tool];
  if (old && old.deactivate) old.deactivate();
  App.state.tool = t;
  App.state.drag = null;
  App.state.overlay = t === 'node' ? nodeOverlay : null;
  if (t === 'pen') setPenOverlay();
  if (tools[t] && tools[t].activate) tools[t].activate();
  cv.style.cursor = t === 'select' ? 'default' : 'crosshair';
  buildTools(); App.draw();
};

/* ============ Bearbeitungs-Befehle ============ */
function selPolys(shapes) {
  const out = [];
  for (const sh of shapes) for (const p of shapePolys(sh, App.ctxGeo)) if (p.closed && p.pts.length > 2) out.push(p.pts);
  return out;
}
function polysToShape(polys, layer) {
  const subs = polys.map(p => nodeSub(p, true));
  const sh = Shape.path(subs, layer);
  return sh;
}
// Boolesche Verknüpfung der Auswahl; base = Form, mit der begonnen wird (beim Abziehen die, die beschnitten wird)
function boolResult(s, op, base = s[0]) {
  const order = [base, ...s.filter(x => x !== base)];
  let acc = selPolys([order[0]]);
  for (let i = 1; i < order.length; i++) acc = boolOp(acc, selPolys([order[i]]), op);
  return acc;
}
function doBool(op, base, keep = false) {
  if (boolCtx) closeDock();   // direkter Knopf bei offenem Assistenten: Assistent schließen
  const s = sel();
  if (s.length < 2) return toast(loc('Mindestens zwei Objekte auswählen'), 'err');
  if (!s.includes(base)) base = s[0];
  const acc = boolResult(s, op, base);
  if (!acc.length) return toast(loc('Ergebnis ist leer'), 'err');
  if (!keep) for (const x of s) removeShape(App.doc.shapes, x);
  const sh = polysToShape(acc, base.layer);
  App.doc.shapes.push(sh);
  setSel([sh]);
  App.commit('Boolean ' + op);
}

/* ---- Assistent „Formen kombinieren" mit Live-Vorschau ----
   Angedockt rechts, die Zeichenfläche bleibt frei: Verknüpfung wählen, Ergebnis sofort sehen (türkis),
   Grundform wechseln (orange gestrichelt) und Objekte bei offenem Assistenten weiter verschieben. */
const BOOL_OPS = [
  { v: 'union', t: loc('Vereinigen'), title: loc('Alle Formen zu einer verbinden') },
  { v: 'subtract', t: loc('Abziehen'), title: loc('Die übrigen Formen aus der Grundform ausschneiden') },
  { v: 'intersect', t: loc('Schnittmenge'), title: loc('Nur den Bereich behalten, in dem sich alle überlappen') },
  { v: 'xor', t: loc('Exklusiv'), title: loc('Nur die Bereiche behalten, die sich nicht überlappen (XOR)') }
];
let boolCtx = null;
function boolDialog(op = 'union') {
  if (sel().length < 2) return toast(loc('Mindestens zwei Objekte auswählen'), 'err');
  closeDock();
  const cfg = { op, baseId: sel()[0].id, keep: false };
  const opBox = h('div');
  const baseInfo = h('span', { style: { flex: '1' } });
  const info = h('small', { class: 'hint' });
  const baseRow = h('div', { style: { display: 'flex', alignItems: 'center', gap: '6px', margin: '6px 0' } }, baseInfo,
    h('button', { class: 'tbtn', title: loc('Andere Form als Grundform nehmen'), onclick: () => {
      const s = sel(), i = s.findIndex(x => x.id === cfg.baseId);
      if (s.length) cfg.baseId = s[(i + 1) % s.length].id;
      App.draw();
    } }, '⇄ ' + loc('Wechseln')));
  // vier Knöpfe im 2×2-Raster (passen auch mit Übersetzungen in die schmale Leiste)
  const buildOps = () => {
    opBox.innerHTML = '';
    opBox.style.cssText = 'display:grid;grid-template-columns:1fr 1fr;gap:4px;margin:6px 0';
    for (const o of BOOL_OPS) opBox.appendChild(h('button', { class: 'tbtn' + (o.v === cfg.op ? ' on' : ''), title: o.title,
      style: { display: 'flex', alignItems: 'center', gap: '5px', justifyContent: 'center' },
      onclick: () => { cfg.op = o.v; buildOps(); App.draw(); } }, icon(o.v, 18), o.t));
  };
  buildOps();
  boolCtx = { cfg, key: '', polys: [], base: null, update() {
    const s = sel();
    baseRow.style.display = cfg.op === 'subtract' ? 'flex' : 'none';
    if (s.length < 2) { info.textContent = loc('Mindestens zwei Objekte auswählen'); return; }
    const i = Math.max(0, s.findIndex(x => x.id === cfg.baseId));
    baseInfo.textContent = loc('Grundform: Objekt {i} von {n}', { i: i + 1, n: s.length });
    info.textContent = !boolCtx.polys.length ? loc('Ergebnis ist leer')
      : (boolCtx.polys.length === 1 ? loc('Ergebnis: 1 Kontur') : loc('Ergebnis: {n} Konturen', { n: boolCtx.polys.length })) + ' · ' + loc('Objekte lassen sich weiter verschieben.');
  } };
  App.state.aux = [drawBoolOverlay];
  dockPanel(loc('Formen kombinieren'), h('div', {},
    h('small', { class: 'hint' }, loc('Das Ergebnis erscheint türkis auf der Zeichenfläche.')),
    opBox, baseRow,
    checkbox(cfg.keep, v => cfg.keep = v, loc('Originale behalten')),
    h('div', { style: { marginTop: '6px' } }, info)
  ), [
    { label: loc('Abbrechen') },
    { label: loc('Anwenden'), primary: true, click: () => {
      const s = sel();
      if (s.length < 2) { toast(loc('Mindestens zwei Objekte auswählen'), 'err'); return false; }
      if (!boolCtx.polys.length) { toast(loc('Ergebnis ist leer'), 'err'); return false; }
      const { op: o, baseId, keep } = cfg;
      endBool();
      doBool(o, s.find(x => x.id === baseId), keep);
    } }
  ], endBool);
  App.draw();
}
function endBool() {
  if (!boolCtx) return;
  boolCtx = null;
  App.state.aux = [];
  App.draw();
}
function drawBoolOverlay(g, px) {
  const c = boolCtx;
  if (!c) return;
  const s = sel(), cfg = c.cfg;
  // neu rechnen nur, wenn sich Auswahl, Verknüpfung, Grundform oder Lage geändert haben
  const key = cfg.op + '|' + cfg.baseId + '|' + s.map(x => x.id + ':' + x.transform.join(',')).join(';');
  if (key !== c.key) {
    c.key = key;
    const base = s.find(x => x.id === cfg.baseId) || s[0];
    c.base = base || null;
    c.polys = s.length >= 2 ? boolResult(s, cfg.op, base) : [];
    c.update();
  }
  g.save();
  g.lineJoin = 'round';
  if (cfg.op === 'subtract' && c.base) {
    const bp = new Path2D();
    for (const p of shapePolys(c.base, App.ctxGeo)) { p.pts.forEach((q, i) => bp[i ? 'lineTo' : 'moveTo'](q.x, q.y)); if (p.closed) bp.closePath(); }
    g.strokeStyle = '#f59e0b'; g.lineWidth = 2.2 * px; g.setLineDash([7 * px, 4 * px]); g.stroke(bp); g.setLineDash([]);
  }
  if (c.polys.length) {
    const rp = new Path2D();
    for (const poly of c.polys) { poly.forEach((q, i) => rp[i ? 'lineTo' : 'moveTo'](q.x, q.y)); rp.closePath(); }
    g.fillStyle = 'rgba(18,165,148,.28)'; g.fill(rp, 'evenodd');
    g.strokeStyle = '#0e7f74'; g.lineWidth = 2.2 * px; g.stroke(rp);
  }
  g.restore();
}
/* ---- Überlappungen verschmelzen (Weld) ----
   Schreibschriften laufen ineinander: die Buchstaben überlappen sich.
   Für den Laser muss daraus eine einzige Kontur werden, sonst werden
   die Überlappungen doppelt gebrannt bzw. quer durchschnitten. */
function weldSel() {
  const s = sel();
  if (!s.length) return toast(loc('Nichts ausgewählt'), 'err');
  const polys = selPolys(s);
  if (polys.length < 2) return toast(loc('Nichts zu verschmelzen'), 'err');
  const groups = groupPolys(polys);
  let acc = groups[0];
  for (let i = 1; i < groups.length; i++) acc = boolOp(acc, groups[i], 'union');
  if (!acc.length) return toast(loc('Ergebnis ist leer'), 'err');
  const layer = s[0].layer;
  for (const x of s) removeShape(App.doc.shapes, x);
  const sh = polysToShape(acc, layer);
  App.doc.shapes.push(sh);
  setSel([sh]);
  App.commit('Verschmelzen');
  toast(loc('{a} Konturen zu {b} verschmolzen', { a: polys.length, b: acc.length }), 'ok');
}
/* Liegt „inner" in „outer"? Mehrere Stichproben, damit einzelne Punkte auf
   der Kontur das Ergebnis nicht verfälschen. */
function polyInPoly(outer, inner) {
  const n = inner.length;
  let hit = 0, tries = 0;
  for (let k = 0; k < 7; k++) {
    const i = Math.floor(k * n / 7);
    const a = inner[i], b = inner[(i + 1) % n];
    tries++;
    if (pointInPoly({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }, outer)) hit++;
  }
  return hit * 2 > tries;
}
/* Polygone nach Verschachtelung gruppieren: jede äußere Kontur mit ihren Löchern */
function groupPolys(polys) {
  const area = polys.map(p => Math.abs(polyArea(p)));
  const order = polys.map((_, i) => i).sort((a, b) => area[b] - area[a]);
  const parent = new Array(polys.length).fill(-1);
  for (const i of order) {
    let best = -1, bestA = Infinity;
    for (const j of order) {
      if (j === i || area[j] <= area[i]) continue;
      if (area[j] < bestA && polyInPoly(polys[j], polys[i])) { best = j; bestA = area[j]; }
    }
    parent[i] = best;
  }
  const depth = i => { let d = 0, k = parent[i], guard = 0; while (k >= 0 && guard++ < 64) { d++; k = parent[k]; } return d; };
  const groups = new Map();
  for (let i = 0; i < polys.length; i++) if (depth(i) % 2 === 0) groups.set(i, [polys[i]]);
  for (let i = 0; i < polys.length; i++) {
    if (depth(i) % 2 === 0) continue;
    const g = groups.get(parent[i]);
    if (g) g.push(polys[i]); else groups.set(i, [polys[i]]);
  }
  return [...groups.values()];
}
function convertToPath() {
  const s = sel();
  if (!s.length) return;
  const news = [];
  for (const sh of s) {
    if (sh.type === 'group' || sh.type === 'image') continue;
    const p = toPath(sh, App.ctxGeo);
    p.layer = sh.layer;
    const i = App.doc.shapes.indexOf(sh);
    if (i >= 0) App.doc.shapes[i] = p; else continue;
    news.push(p);
  }
  if (news.length) { setSel(news); App.commit('In Pfad umwandeln'); }
}
function breakApart() {
  const s = sel(); const news = [];
  for (const sh of s) {
    const p = sh.type === 'path' ? sh : toPath(sh, App.ctxGeo);
    if (!p.subpaths || p.subpaths.length < 2) { news.push(sh); continue; }
    removeShape(App.doc.shapes, sh);
    for (const sp of p.subpaths) {
      const n = Shape.path([sp], sh.layer);
      n.transform = p.transform.slice();
      App.doc.shapes.push(n); news.push(n);
    }
  }
  setSel(news); App.commit('Trennen');
}
function groupSel() {
  const s = sel();
  if (s.length < 2) return;
  for (const x of s) removeShape(App.doc.shapes, x);
  const g = Shape.group(s, s[0].layer);
  App.doc.shapes.push(g);
  setSel([g]); App.commit('Gruppieren');
}
function ungroupOne(g) {
  const i = App.doc.shapes.indexOf(g);
  if (i < 0) return [];
  const kids = g.children.map(c => { c.transform = Mat.mul(c.transform, g.transform); return c; });
  App.doc.shapes.splice(i, 1, ...kids);
  return kids;
}
function ungroupSel() {
  let news = [];
  for (const s of sel().slice()) {
    if (s.type === 'group') news = news.concat(ungroupOne(s));
    else news.push(s);
  }
  setSel(news); App.commit('Gruppierung aufheben');
}
function deleteSel() {
  for (const s of sel()) removeShape(App.doc.shapes, s);
  setSel([]); App.commit('Löschen');
}
function duplicateSel(dx = 0, dy = 0) {
  const news = [];
  for (const s of sel()) {
    const c = JSON.parse(JSON.stringify(s));
    reid(c);
    c.transform = Mat.mul(c.transform, Mat.translate(dx, dy));
    App.doc.shapes.push(c); news.push(c);
  }
  setSel(news); App.commit('Duplizieren');
  return news;
}
function reid(s) { s.id = D.uid(); if (s.children) s.children.forEach(reid); }
function copySel() { App.state.clipboard = JSON.parse(JSON.stringify(sel())); toast(loc('{n} kopiert', { n: sel().length })); }
function cutSel() { App.state.clipboard = JSON.parse(JSON.stringify(sel())); deleteSel(); }
function raiseSel() { for (const s of sel()) { removeShape(App.doc.shapes, s); App.doc.shapes.push(s); } App.commit('Nach vorn'); }
function lowerSel() { for (const s of sel()) { removeShape(App.doc.shapes, s); App.doc.shapes.unshift(s); } App.commit('Nach hinten'); }

function alignSel(mode) {
  const s = sel();
  if (s.length < 1) return;
  const boxes = s.map(x => shapeBBox(x, App.ctxGeo));
  let ref = boxes.reduce((a, b) => a ? mergeBox(a, b) : b, null);
  if (mode === 'page') ref = { x0: 0, y0: 0, x1: App.doc.machine.width, y1: App.doc.machine.height };
  s.forEach((x, i) => {
    const b = boxes[i];
    let dx = 0, dy = 0;
    switch (mode) {
      case 'left': dx = ref.x0 - b.x0; break;
      case 'right': dx = ref.x1 - b.x1; break;
      case 'hcenter': dx = (ref.x0 + ref.x1) / 2 - (b.x0 + b.x1) / 2; break;
      case 'top': dy = ref.y1 - b.y1; break;
      case 'bottom': dy = ref.y0 - b.y0; break;
      case 'vcenter': dy = (ref.y0 + ref.y1) / 2 - (b.y0 + b.y1) / 2; break;
      case 'page': dx = (ref.x0 + ref.x1) / 2 - (b.x0 + b.x1) / 2; dy = (ref.y0 + ref.y1) / 2 - (b.y0 + b.y1) / 2; break;
    }
    x.transform = Mat.mul(x.transform, Mat.translate(dx, dy));
  });
  App.commit('Ausrichten');
}
function distributeSel(axis) {
  const s = sel();
  if (s.length < 3) return toast(loc('Mindestens 3 Objekte'), 'err');
  const items = s.map(x => ({ x, b: shapeBBox(x, App.ctxGeo) }));
  items.sort((a, c) => axis === 'h' ? (a.b.x0 + a.b.x1) - (c.b.x0 + c.b.x1) : (a.b.y0 + a.b.y1) - (c.b.y0 + c.b.y1));
  const first = items[0].b, last = items[items.length - 1].b;
  const span = axis === 'h' ? ((last.x0 + last.x1) - (first.x0 + first.x1)) / 2 : ((last.y0 + last.y1) - (first.y0 + first.y1)) / 2;
  const step = span / (items.length - 1);
  items.forEach((it, i) => {
    if (i === 0 || i === items.length - 1) return;
    const c = axis === 'h' ? (it.b.x0 + it.b.x1) / 2 : (it.b.y0 + it.b.y1) / 2;
    const target = (axis === 'h' ? (first.x0 + first.x1) / 2 : (first.y0 + first.y1) / 2) + step * i;
    it.x.transform = Mat.mul(it.x.transform, axis === 'h' ? Mat.translate(target - c, 0) : Mat.translate(0, target - c));
  });
  App.commit('Verteilen');
}
function flipSel(axis) {
  const s = sel(); if (!s.length) return;
  const b = shapesBBox(s, App.ctxGeo);
  const c = boxCenter(b);
  applyToSel(Mat.aroundPoint(axis === 'h' ? Mat.scale(-1, 1) : Mat.scale(1, -1), c.x, c.y));
  App.commit('Spiegeln');
}
function rotateSel(deg) {
  const s = sel(); if (!s.length) return;
  const c = boxCenter(shapesBBox(s, App.ctxGeo));
  applyToSel(Mat.aroundPoint(Mat.rotate(deg * Math.PI / 180), c.x, c.y));
  App.commit('Drehen');
}
function offsetDialog() {
  const s = sel();
  if (!s.length) return toast(loc('Nichts ausgewählt'), 'err');
  const cfg = { dist: 2, dir: 'out', corner: 'round', keep: true };
  const c = h('div', {}, h('div', { class: 'grid2' },
    field(loc('Abstand mm'), numInput(cfg.dist, .1, v => cfg.dist = v)),
    field(loc('Richtung'), selectInput(cfg.dir, [{ v: 'out', t: loc('Nach außen') }, { v: 'in', t: loc('Nach innen') }, { v: 'both', t: loc('Beides') }], v => cfg.dir = v)),
    field(loc('Ecken'), selectInput(cfg.corner, [{ v: 'round', t: loc('Rund') }, { v: 'miter', t: loc('Spitz') }], v => cfg.corner = v)),
    checkbox(cfg.keep, v => cfg.keep = v, loc('Original behalten'))));
  modal(loc('Offset / Kontur'), c, [{ label: loc('Abbrechen') }, {
    label: loc('Anwenden'), primary: true, click: () => {
      const polys = selPolys(s);
      if (!polys.length) return toast(loc('Keine geschlossenen Konturen'), 'err');
      const news = [];
      const dirs = cfg.dir === 'both' ? [cfg.dist, -cfg.dist] : [cfg.dir === 'out' ? cfg.dist : -cfg.dist];
      for (const d of dirs) {
        const res = offsetPolys(polys, d, cfg.corner);
        if (res.length) { const sh = polysToShape(res, s[0].layer); App.doc.shapes.push(sh); news.push(sh); }
      }
      if (!cfg.keep) for (const x of s) removeShape(App.doc.shapes, x);
      setSel(news); App.commit('Offset');
    }
  }]);
}
function arrayDialog() {
  const s = sel();
  if (!s.length) return toast(loc('Nichts ausgewählt'), 'err');
  const b = shapesBBox(s, App.ctxGeo);
  const cfg = { cols: 3, rows: 2, dx: boxW(b) + 5, dy: boxH(b) + 5, mode: 'grid', count: 8, radius: 50, arc: 360, rotate: true };
  const body = h('div');
  const rebuild = () => {
    body.innerHTML = '';
    body.appendChild(field(loc('Art'), selectInput(cfg.mode, [{ v: 'grid', t: loc('Raster') }, { v: 'circ', t: loc('Kreisförmig') }], v => { cfg.mode = v; rebuild(); })));
    if (cfg.mode === 'grid') body.appendChild(h('div', { class: 'grid2' },
      field(loc('Spalten'), numInput(cfg.cols, 1, v => cfg.cols = Math.max(1, v | 0))),
      field(loc('Zeilen'), numInput(cfg.rows, 1, v => cfg.rows = Math.max(1, v | 0))),
      field(loc('Abstand X'), numInput(cfg.dx, .5, v => cfg.dx = v)),
      field(loc('Abstand Y'), numInput(cfg.dy, .5, v => cfg.dy = v))));
    else body.appendChild(h('div', { class: 'grid2' },
      field(loc('Anzahl'), numInput(cfg.count, 1, v => cfg.count = Math.max(2, v | 0))),
      field(loc('Radius mm'), numInput(cfg.radius, 1, v => cfg.radius = v)),
      field(loc('Bogen °'), numInput(cfg.arc, 1, v => cfg.arc = v)),
      checkbox(cfg.rotate, v => cfg.rotate = v, loc('Objekte mitdrehen'))));
  };
  rebuild();
  modal(loc('Array / Vervielfältigen'), body, [{ label: loc('Abbrechen') }, {
    label: loc('Erstellen'), primary: true, click: () => {
      const news = [];
      const clone = (m) => {
        for (const x of s) {
          const c = JSON.parse(JSON.stringify(x)); reid(c);
          c.transform = Mat.mul(c.transform, m);
          App.doc.shapes.push(c); news.push(c);
        }
      };
      if (cfg.mode === 'grid') {
        for (let r = 0; r < cfg.rows; r++) for (let cI = 0; cI < cfg.cols; cI++) {
          if (r === 0 && cI === 0) continue;
          clone(Mat.translate(cI * cfg.dx, -r * cfg.dy));
        }
      } else {
        const cen = boxCenter(shapesBBox(s, App.ctxGeo));
        const c0 = { x: cen.x, y: cen.y - cfg.radius };
        const full = Math.abs(cfg.arc - 360) < .01;
        for (let i = 1; i < cfg.count; i++) {
          const a = (cfg.arc * Math.PI / 180) * (i / (full ? cfg.count : cfg.count - 1));
          let m = Mat.aroundPoint(Mat.rotate(a), c0.x, c0.y);
          if (!cfg.rotate) {
            const p = Mat.apply(m, cen);
            m = Mat.translate(p.x - cen.x, p.y - cen.y);
          }
          clone(m);
        }
      }
      setSel(s.concat(news)); App.commit('Array');
    }
  }]);
}
/* Zeichnet sofort in grober Auflösung und kurz darauf in voller – flüssige Regler */
let fastT = null;
function liveDraw() {
  App.state.fastPreview = true;
  App.draw();
  clearTimeout(fastT);
  fastT = setTimeout(() => { App.state.fastPreview = false; App.draw(); }, 200);
}

/* ============ Bild nachzeichnen – angedockt mit Live-Vorschau ============
   Das Bedienfeld liegt in der rechten Leiste, damit es das Bild nie verdeckt.
   Schwellwert & Co. wirken sofort: das Bild wird live schwarz/weiß dargestellt
   und die gefundenen Konturen werden darüber gezeichnet. */
const TRACE_DETAIL = [
  { v: '600', t: loc('Grob (schnell)') }, { v: '1200', t: loc('Normal') }, { v: '2000', t: loc('Fein') }, { v: '3000', t: loc('Sehr fein') }
];
let traceCtx = null;

function traceImageDialog() {
  const s = sel().filter(x => x.type === 'image');
  if (!s.length) return toast(loc('Bitte zuerst ein Bild auswählen'), 'err');
  closeDock();          // evtl. offenes Panel sauber beenden, bevor der neue Kontext steht
  const sh = s[0];
  const cfg = {
    threshold: 128, smooth: 1.0, invert: false, minArea: 0.5,
    detail: 1200, target: sh.layer, after: 'keep'
  };
  const info = h('small', { class: 'hint' }, loc('Vorschau wird berechnet …'));
  let raf = 0;
  const schedule = () => {
    if (raf) return;
    raf = requestAnimationFrame(() => { raf = 0; compute(); });
  };
  const compute = () => {
    if (!traceCtx) return;
    // Bild live binarisiert anzeigen – genau das, was nachgezeichnet wird
    sh._pv = { dither: 'threshold', threshold: cfg.threshold, invert: cfg.invert };
    const polys = tracePolys(sh, { ...cfg, maxDim: Math.min(560, cfg.detail) });
    traceCtx.polys = polys;
    const nodes = polys.reduce((a, p) => a + p.length, 0);
    info.textContent = polys.length
      ? loc('{n} Konturen · {k} Knoten (Vorschau)', { n: polys.length, k: nodes })
      : loc('Keine Konturen bei diesem Schwellwert');
    liveDraw();
  };
  traceCtx = { sh, cfg, polys: [] };
  App.state.aux = [drawTraceOverlay];
  ensureVisible(sh);   // Bild in den sichtbaren Bereich holen – sonst nützt die Live-Vorschau nichts

  const body = h('div', {},
    h('small', { class: 'hint' }, loc('Regler ziehen – die Vorschau auf der Zeichenfläche folgt sofort.')),
    slider(loc('Schwelle'), cfg.threshold, 0, 255, 1, v => { cfg.threshold = v; schedule(); }),
    slider(loc('Glättung'), cfg.smooth, 0, 4, .05, v => { cfg.smooth = v; schedule(); }),
    slider(loc('Min. Fläche'), cfg.minArea, 0, 25, .1, v => { cfg.minArea = v; schedule(); }),
    checkbox(cfg.invert, v => { cfg.invert = v; schedule(); }, loc('Invertieren (helle Flächen nachzeichnen)')),
    field(loc('Detailgrad'), selectInput(String(cfg.detail), TRACE_DETAIL, v => { cfg.detail = +v; schedule(); })),
    field(loc('Ziel-Ebene'), selectInput(String(cfg.target), App.doc.layers.filter(L => !L.isTool).map(L => ({
      v: String(L.index), t: layerLabel(L)
    })), v => cfg.target = +v)),
    field(loc('Bild danach'), selectInput(cfg.after, [
      { v: 'keep', t: loc('behalten') }, { v: 'hide', t: loc('ausblenden') }, { v: 'delete', t: loc('löschen') }
    ], v => cfg.after = v)),
    h('div', { style: { marginTop: '6px' } }, info),
    h('small', { class: 'hint' }, loc('Beim Nachzeichnen wird der volle Detailgrad verwendet.'))
  );

  dockPanel(loc('Bild nachzeichnen'), body, [
    { label: loc('Abbrechen') },
    {
      label: loc('Nachzeichnen'), primary: true, click: () => {
        const polys = tracePolys(sh, { ...cfg, maxDim: cfg.detail });
        if (!polys.length) { toast(loc('Keine Konturen gefunden – Schwellwert anpassen'), 'err'); return false; }
        const out = Shape.path(polys.map(p => nodeSub(p, true)), cfg.target);
        out.transform = sh.transform.slice();
        App.doc.shapes.push(out);
        if (cfg.after === 'hide') sh.hidden = true;
        if (cfg.after === 'delete') removeShape(App.doc.shapes, sh);
        endTrace();
        setSel([out]);
        App.commit('Bild nachzeichnen');
        toast(loc('{n} Konturen erzeugt', { n: polys.length }), 'ok');
      }
    }
  ], endTrace);
  compute();
}
/* Bild ohne Dialog nachzeichnen (AI Create): Schwarz-Weiß-Vorlage mit festen Einstellungen.
   Rückgabe: Pfad in der Größe w × hh mm (Bild liegt bei 0,0) oder null, wenn nichts gefunden wurde. */
async function autoTrace(src, w, hh, layer) {
  await loadImage(src);
  const sh = Shape.image(0, 0, w, hh, src, layer);
  try {
    const polys = tracePolys(sh, { threshold: 128, smooth: 1.0, invert: false, minArea: Math.max(0.02, w * hh / 50000), maxDim: 1600 });
    if (!polys.length) return null;
    const out = Shape.path(polys.map(p => nodeSub(p, true)), layer);
    out.transform = sh.transform.slice();
    return out;
  } finally {
    ImageCache.delete(src);   // große data:-URL nicht im Speicher behalten
  }
}
/* Sorgt dafür, dass eine Form groß genug und vollständig sichtbar ist */
function ensureVisible(shape) { ensureBoxVisible(shapesBBox([shape], App.ctxGeo)); }
function ensureBoxVisible(b) {
  if (!boxValid(b)) return;
  const w = cv.clientWidth, hh = cv.clientHeight, v = App.view;
  const a = v.toScreen({ x: b.x0, y: b.y0 }, hh), c = v.toScreen({ x: b.x1, y: b.y1 }, hh);
  const x0 = Math.min(a.x, c.x), x1 = Math.max(a.x, c.x), y0 = Math.min(a.y, c.y), y1 = Math.max(a.y, c.y);
  const inside = x0 > RULER && y0 > RULER && x1 < w && y1 < hh;
  const bigEnough = (x1 - x0) > w * 0.2 || (y1 - y0) > hh * 0.2;
  if (inside && bigEnough) return;
  v.fit(b, w, hh, 70);
  App.draw();
}

/* Schnellumschaltung des Gravur-Modus für alle ausgewählten Bilder */
function setImageMode(mode) {
  const list = sel().filter(x => x.type === 'image');
  if (!list.length) return toast(loc('Bitte zuerst ein Bild auswählen'), 'err');
  for (const im of list) { im.dither = mode; invalidateImagePreview(im.id); }
  App.state.imagePreview = true; saveUI();
  App.commit(mode === 'none' ? loc('Graustufen') : loc('Schwarz/Weiß'));
  toast(mode === 'none' ? loc('Bild als Graustufen-Gravur (Leistung moduliert)') : loc('Bild als Schwarz/Weiß-Gravur'), 'ok');
}
function endTrace() {
  if (traceCtx) { delete traceCtx.sh._pv; invalidateImagePreview(traceCtx.sh.id); }
  traceCtx = null;
  App.state.aux = [];
  App.draw();
}
function drawTraceOverlay(g, px) {
  if (!traceCtx || !traceCtx.polys.length) return;
  const m = traceCtx.sh.transform;
  g.save();
  g.transform(m[0], m[1], m[2], m[3], m[4], m[5]);
  const sf = Mat.scaleFactor(m) || 1;
  g.lineJoin = 'round'; g.lineCap = 'round';
  const paths = () => {
    g.beginPath();
    for (const poly of traceCtx.polys) {
      g.moveTo(poly[0].x, poly[0].y);
      for (let i = 1; i < poly.length; i++) g.lineTo(poly[i].x, poly[i].y);
      g.closePath();
    }
  };
  // dunkler Halo darunter, damit die Kontur auf Weiß und Schwarz sichtbar bleibt
  g.strokeStyle = 'rgba(0,0,0,.55)'; g.lineWidth = 3.6 * px / sf; paths(); g.stroke();
  g.strokeStyle = '#ff45c8'; g.lineWidth = 1.6 * px / sf; paths(); g.stroke();
  g.restore();
}

/* Marching Squares auf dem (aufbereiteten) Graustufenbild.
   Rückgabe: Polygone in lokalen Bildkoordinaten (mm). */
function tracePolys(sh, cfg) {
  const im = getImage(sh.src);
  if (!im.complete || !im.naturalWidth) return [];
  const maxDim = Math.max(64, cfg.maxDim || 1200);
  const sc = Math.min(1, maxDim / Math.max(im.naturalWidth, im.naturalHeight));
  const W = Math.max(2, Math.round(im.naturalWidth * sc)), H = Math.max(2, Math.round(im.naturalHeight * sc));
  // nutzt Helligkeit/Kontrast/Gamma/Transparenz des Bildes – Vorschau und Ergebnis passen zusammen
  const gray = grayscaleGrid(sh, W, H);
  if (!gray) return [];
  const t = cfg.threshold / 255;
  const val = (x, y) => {
    if (x < 0 || y < 0 || x >= W || y >= H) return 0;
    const l = gray[y * W + x];
    return (cfg.invert ? l > t : l < t) ? 1 : 0;
  };
  const segs = [];
  for (let y = -1; y < H; y++) for (let x = -1; x < W; x++) {
    const tl = val(x, y), tr = val(x + 1, y), br = val(x + 1, y + 1), bl = val(x, y + 1);
    const idx = tl * 8 + tr * 4 + br * 2 + bl;
    if (idx === 0 || idx === 15) continue;
    const T = { x: x + .5, y }, R = { x: x + 1, y: y + .5 }, B = { x: x + .5, y: y + 1 }, L = { x, y: y + .5 };
    const A = (a, b) => segs.push([a, b]);
    switch (idx) {
      case 1: A(L, B); break; case 2: A(B, R); break; case 3: A(L, R); break; case 4: A(T, R); break;
      case 6: A(T, B); break; case 7: A(L, T); break; case 8: A(T, L); break; case 9: A(T, B); break;
      case 11: A(T, R); break; case 12: A(L, R); break; case 13: A(B, R); break; case 14: A(L, B); break;
      case 5: A(L, T); A(B, R); break; case 10: A(T, R); A(L, B); break;
    }
  }
  const loops = stitchU(segs, .75);
  const kx = sh.w / W, ky = sh.h / H;
  const out = [];
  for (let lp of loops) {
    lp = rdpRingLocal(lp, Math.max(.2, cfg.smooth));
    if (lp.length < 3) continue;
    const pts = lp.map(p => ({ x: p.x * kx, y: sh.h - p.y * ky }));
    if (cfg.minArea > 0 && Math.abs(polyArea(pts)) < cfg.minArea) continue;
    out.push(pts);
  }
  return out;
}
function stitchU(segs, tol) {
  const k = p => Math.round(p.x * 1e5) + ',' + Math.round(p.y * 1e5);
  const map = new Map();
  segs.forEach((s, i) => { for (const p of s) { const kk = k(p); if (!map.has(kk)) map.set(kk, []); map.get(kk).push(i); } });
  const used = new Array(segs.length).fill(false), loops = [];
  for (let i = 0; i < segs.length; i++) {
    if (used[i]) continue;
    used[i] = true;
    const startK = k(segs[i][0]);
    const loop = [segs[i][0], segs[i][1]];
    for (let guard = 0; guard < segs.length; guard++) {
      const ek = k(loop[loop.length - 1]);
      if (ek === startK) break;
      const cand = (map.get(ek) || []).find(j => !used[j]);
      if (cand === undefined) break;
      used[cand] = true;
      const [a, b] = segs[cand];
      loop.push(k(a) === ek ? b : a);
    }
    if (loop.length >= 4) loops.push(loop);
  }
  return loops;
}

function rdpRingLocal(pts, eps) {
  if (pts.length < 4) return pts;
  const closed = Math.abs(pts[0].x - pts[pts.length - 1].x) < 1e-9 && Math.abs(pts[0].y - pts[pts.length - 1].y) < 1e-9;
  if (!closed) return rdpLocal(pts, eps);
  let mi = 1, md = -1;
  for (let i = 1; i < pts.length - 1; i++) {
    const d = (pts[i].x - pts[0].x) ** 2 + (pts[i].y - pts[0].y) ** 2;
    if (d > md) { md = d; mi = i; }
  }
  return rdpLocal(pts.slice(0, mi + 1), eps).concat(rdpLocal(pts.slice(mi), eps).slice(1));
}
function rdpLocal(pts, eps) {
  if (pts.length < 3) return pts;
  const keep = new Array(pts.length).fill(false);
  keep[0] = keep[pts.length - 1] = true;
  const st = [[0, pts.length - 1]];
  while (st.length) {
    const [s, e] = st.pop();
    let md = 0, mi = -1;
    const a = pts[s], b = pts[e], dx = b.x - a.x, dy = b.y - a.y, l = Math.hypot(dx, dy) || 1;
    for (let i = s + 1; i < e; i++) {
      const dd = Math.abs((pts[i].x - a.x) * dy - (pts[i].y - a.y) * dx) / l;
      if (dd > md) { md = dd; mi = i; }
    }
    if (md > eps && mi > 0) { keep[mi] = true; st.push([s, mi], [mi, e]); }
  }
  return pts.filter((_, i) => keep[i]);
}
App.setLayer = (i) => {
  for (const s of sel()) { s.layer = i; if (s.type === 'group') walk([s], x => x.layer = i); }
  App.state.activeLayer = i;
  App.commit('Ebene zuweisen');
};

/* ============ Datei-Ein/Ausgabe ============ */
function download(name, text, mime = 'text/plain') {
  const blob = new Blob([text], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = name;
  document.body.appendChild(a); a.click();
  setTimeout(() => { URL.revokeObjectURL(url); a.remove(); }, 1000);
}
App.download = download;

function openFiles() {
  const inp = $('#fileInput');
  inp.value = '';
  inp.onchange = async () => {
    for (const f of inp.files) await importFile(f);
  };
  inp.click();
}
async function importFile(f) {
  const ext = f.name.split('.').pop().toLowerCase();
  try {
    if (ext === 'svg') {
      const t = await f.text();
      const r = importSVG(t, App.doc, {});
      App.doc.shapes.push(...r.shapes);
      setSel(r.shapes);
      App.commit('SVG importieren');
      toast(loc('SVG importiert: {n} Objekte, {w}×{h} mm', { n: r.shapes.length, w: r.width.toFixed(1), h: r.height.toFixed(1) }), 'ok');
    } else if (ext === 'dxf') {
      const t = await f.text();
      const r = importDXF(t, App.doc, {});
      App.doc.shapes.push(...r.shapes);
      setSel(r.shapes);
      App.commit('DXF importieren');
      toast(loc('DXF importiert: {n} Objekte', { n: r.shapes.length }), 'ok');
    } else if (['png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp'].includes(ext)) {
      const url = await readDataURL(f);
      const im = await loadImage(url);
      const mmPerPx = 25.4 / 96;
      let w = im.naturalWidth * mmPerPx, hh = im.naturalHeight * mmPerPx;
      const maxW = App.doc.machine.width * .8;
      if (w > maxW) { const k = maxW / w; w *= k; hh *= k; }
      const sh = Shape.image(20, App.doc.machine.height - 20 - hh, w, hh, url, App.state.activeLayer);
      App.doc.shapes.push(sh); setSel([sh]); App.commit('Bild importieren');
      toast(loc('Bild importiert'), 'ok');
    } else if (ext === 'lbrn' || ext === 'lbrn2') {
      const t = await f.text();
      const r = importLBRN(t, App.doc);
      if (!r.shapes.length) throw new Error(loc('Keine Objekte in der Projektdatei gefunden'));
      App.doc.shapes.push(...r.shapes);
      invalidateAll();
      setSel(r.shapes);
      App.commit('LightBurn-Projekt importieren');
      let msg = loc('LightBurn-Projekt geladen: {n} Objekte, {l} Ebenen', { n: r.shapes.length, l: r.layers.length });
      if (r.warn.font) msg += ' – ' + loc('Textobjekte ohne gespeicherte Umrisse wurden nachgebildet');
      if (r.warn.types && r.warn.types.size) msg += ' – ' + loc('nicht unterstützt:') + ' ' + [...r.warn.types].join(', ');
      toast(msg, 'ok');
      fitAll();
    } else if (ext === 'lbdev') {
      applyLbdev(JSON.parse(await f.text()));
      toast(loc('Gerätedatei geladen'), 'ok');
    } else if (ext === 'ttf' || ext === 'otf' || ext === 'woff') {
      const name = await loadFontFile(f);
      App.state.lastFont = name;
      for (const s of sel()) if (s.type === 'text') { s.font = name; invalidateShape(s); }
      App.commit('Schriftart geladen');
      toast(loc('Schrift geladen: {name}', { name }), 'ok');
    } else if (ext === 'lsproj' || ext === 'json') {
      const j = JSON.parse(await f.text());
      if (j.shapes && j.layers) {
        // eine Projektdatei öffnet sich in einem eigenen Tab (noch ohne Verbindung zum Server)
        if (Projects.openData(j, f.name.replace(/\.[^.]+$/, ''))) toast(loc('Projekt geladen'), 'ok');
      } else if (j.DeviceList) { applyLbdev(j); toast(loc('Gerätedatei geladen'), 'ok'); }
    } else if (ext === 'gcode' || ext === 'nc' || ext === 'gc') {
      showGcode(await f.text(), f.name);
    } else toast(loc('Unbekanntes Format: .{ext}', { ext }), 'err');
  } catch (e) {
    console.error(e);
    toast(loc('Fehler beim Import: {msg}', { msg: e.message }), 'err');
  }
}
function readDataURL(f) {
  return new Promise((res, rej) => {
    const r = new FileReader();
    r.onload = () => res(r.result); r.onerror = rej;
    r.readAsDataURL(f);
  });
}
function applyLbdev(j) {
  const d = (j.DeviceList || [])[0];
  if (!d) return;
  const m = App.doc.machine;
  m.name = d.DisplayName || m.name;
  m.firmware = d.Name || 'GRBL';
  m.width = d.Width || m.width;
  m.height = d.Height || m.height;
  const s = d.Settings || {};
  m.sScale = s.S_Scale || 1000;
  m.baud = s.BaudRate || 115200;
  m.startGcode = s.StartGCode || '';
  m.endGcode = s.EndGCode || '';
  m.enableZ = !!s.EnableZ;
  m.negativeZ = !!s.NegativeZ;
  m.airAssistM7 = !!s.AirAssistM7;
  m.laserFirePower = s.LaserFire_Power || 3;
  m.boundsCheck = s.EnableBoundsCheck !== false;
  m.maxSpeedX = s.Sim_MaxSpeedX || 500;
  m.maxSpeedY = s.Sim_MaxSpeedY || 400;
  m.accelX = s.Sim_MaxAccelX || 3000;
  m.accelY = s.Sim_MaxAccelY || 3000;
  m.rapidSpeed = s.Sim_RapidSpeed || 400;
  m.homeOnStartup = !!d.HomeOnStartup;
  // Maschinen mit Referenzfahrt arbeiten in absoluten Maschinenkoordinaten
  // (Referenzfahrt beim Einschalten → Nullpunkt ist fest).
  if (m.homeOnStartup) m.jobOrigin = 'absolute';
  m.finishX = s.UserFinishX || 0; m.finishY = s.UserFinishY || 0;
  $('#devBadge').textContent = `${m.name} · ${m.width}×${m.height} mm · ${m.firmware}`;
  App.refresh();
}
App.applyLbdev = applyLbdev;

// Dateiname für Downloads: Name des Projekts bzw. Tabs, ohne Zeichen, die Dateisysteme nicht mögen
function fileBase(fallback) {
  const n = String(Projects.title || '').replace(/[\\/:*?"<>|\x00-\x1f]+/g, '_').replace(/^[\s.]+|[\s.]+$/g, '').slice(0, 100);
  return n || fallback;
}
// Projekt als Datei (.lsproj) herunterladen – mit Online-Speicher wird sonst dort gespeichert (projects.js)
function exportProjectFile() {
  const name = fileBase('projekt') + '.lsproj';
  download(name, JSON.stringify(docData()), 'application/json');
}
App.exportProjectFile = exportProjectFile;

/* ============ Tabs: mehrere Zeichnungen (Verwaltung in projects.js) ============ */
function setBadge() {
  const M = App.doc.machine;
  $('#devBadge').textContent = `${M.name} · ${M.width}×${M.height} mm · ${M.firmware}`;
}
// Standard-Ebenen sinnvoll vorbelegen
function layerDefaults(d) {
  const L = d.layers;
  L[0].mode = 'line'; L[0].speed = 10; L[0].maxPower = 80; L[0].name = loc('Schneiden');
  L[1].mode = 'line'; L[1].speed = 120; L[1].maxPower = 25; L[1].name = loc('Kontur leicht');
  L[2].mode = 'fill'; L[2].speed = 200; L[2].maxPower = 35; L[2].name = loc('Gravur');
}
// leere Zeichnung mit dem gerade gewählten Laser
App.blankDoc = () => {
  const d = newDoc();
  layerDefaults(d);
  d.machine = { ...App.doc.machine };
  return d;
};
// Zeichnung aus Projektdaten (Datei, Server oder Browser-Speicher)
App.docFromData = j => {
  const d = App.blankDoc();
  d.shapes = j.shapes || [];
  if (j.layers) d.layers = D.migrateLayers(j.layers);
  if (j.machine) d.machine = { ...defaultMachine(), ...j.machine };
  if (j.settings) d.settings = { ...d.settings, ...j.settings };
  return d;
};
// laufende Eingaben abschließen, bevor ein anderer Tab nach vorn kommt
App.endEdit = () => {
  if (pen) finishPen(false);
  if (polyDraw) finishPoly(false);
  closeDock();
};
// Zeichnung, Verlauf, Ansicht und aktive Ebene eines Tabs übernehmen
App.switchDoc = (t, fit) => {
  App.doc = t.doc; App.history = t.history;
  const st = App.state;
  st.selIds.clear(); st.nodeSel = []; st.rotateMode = false; st.preview = null; st.overlay = null;
  st.activeLayer = Math.min(t.layer || 0, App.doc.layers.length - 1);
  invalidateAll(); setBadge();
  // die Sitzung im Browser gehört ab jetzt zu diesem Tab
  clearTimeout(autosaveT); autosaveT = null; Session.save(App.doc, App.history);
  if (fit || !t.view) fitAll(); else Object.assign(App.view, t.view);
  App.refresh();
  preloadUsedFonts(App.doc.shapes).then(n => { if (n) { invalidateAll(); App.draw(); } });
};

/* ============ Eigenschaften-Panel ============ */
function buildProps() {
  const el = $('#propsBody');
  el.innerHTML = '';
  const s = sel();
  if (!s.length) {
    const L = App.doc.layers[App.state.activeLayer];
    el.appendChild(h('div', { class: 'row', style: { marginBottom: '6px' } },
      h('span', { class: 'swatch', style: { background: L.color } }),
      h('b', {}, loc('Aktive Ebene') + ' ' + layerLabel(L, false)),
      h('button', { class: 'tbtn', onclick: () => cutSettingsDialog(App, L) }, loc('Einstellungen…'))));
    el.appendChild(h('div', { class: 'grid2' },
      field(loc('Geschw.') + ' ' + speedUnit(), speedInput(L.speed, v => { L.speed = v; App.commit('Speed'); })),
      field(loc('Leistung %'), numInput(L.maxPower, 1, v => { L.maxPower = v; App.commit('Power'); }))));
    el.appendChild(h('hr', { style: { border: 0, borderTop: '1px solid var(--line)', margin: '8px 0' } }));
    el.appendChild(h('div', { class: 'grid2' },
      field(loc('Raster mm'), numInput(App.doc.settings.gridSize, 1, v => { App.doc.settings.gridSize = v; App.draw(); })),
      checkbox(App.state.snapGrid, v => { App.state.snapGrid = v; }, loc('Am Raster fangen')),
      checkbox(App.state.snapObj, v => { App.state.snapObj = v; }, loc('An Objekten fangen')),
      checkbox(App.state.showFill, v => { App.state.showFill = v; App.draw(); }, loc('Füllung anzeigen'))));
    el.appendChild(h('small', { class: 'hint' }, loc('{n} Objekte im Dokument', { n: countShapes() })));
    const nl = countLocked();
    if (nl) el.appendChild(h('div', { class: 'row', style: { marginTop: '6px' } },
      h('small', { class: 'hint', style: { flex: 1 } }, '🔒 ' + loc('{n} gesperrt', { n: nl })),
      h('button', { class: 'tbtn', onclick: unlockAll, title: keyName('Strg+Shift+L') }, loc('Alle entsperren'))));
    return;
  }
  const b = shapesBBox(s, App.ctxGeo);
  const one = s.length === 1 ? s[0] : null;
  el.appendChild(h('div', { class: 'row', style: { marginBottom: '4px' } },
    h('b', {}, s.length === 1 ? typeName(one) : loc('{n} Objekte', { n: s.length })),
    h('span', { style: { flex: 1 } }),
    h('span', { class: 'tag' }, layerLabel(App.doc.layers[s[0].layer], false))));
  const setBox = (nx, ny, nw, nh) => {
    const sx = nw / Math.max(1e-6, boxW(b)), sy = nh / Math.max(1e-6, boxH(b));
    for (const x of s) {
      let m = Mat.aroundPoint(Mat.scale(sx, sy), b.x0, b.y0);
      m = Mat.mul(m, Mat.translate(nx - b.x0, ny - b.y0));
      x.transform = Mat.mul(x.transform, m);
    }
    App.commit('Größe/Position');
  };
  const lock = App.state.lockAspect !== false;
  el.appendChild(h('div', { class: 'grid2' },
    field('X', numInput(b.x0, .1, v => setBox(v, b.y0, boxW(b), boxH(b)))),
    field('Y', numInput(b.y0, .1, v => setBox(b.x0, v, boxW(b), boxH(b)))),
    field(loc('Breite'), numInput(boxW(b), .1, v => setBox(b.x0, b.y0, v, lock ? boxH(b) * (v / boxW(b)) : boxH(b)))),
    field(loc('Höhe'), numInput(boxH(b), .1, v => setBox(b.x0, b.y0, lock ? boxW(b) * (v / boxH(b)) : boxW(b), v)))));
  el.appendChild(h('div', { class: 'row' },
    checkbox(lock, v => { App.state.lockAspect = v; }, loc('Seitenverhältnis sperren'))));
  el.appendChild(h('div', { class: 'row', style: { margin: '4px 0' } },
    h('button', { class: 'tbtn', title: loc('Drehen -90°'), onclick: () => rotateSel(-90) }, '⟲'),
    h('button', { class: 'tbtn', title: loc('Drehen +90°'), onclick: () => rotateSel(90) }, '⟳'),
    numInput(0, 1, v => rotateSel(v), { style: 'width:64px', title: loc('Winkel °') }),
    h('button', { class: 'tbtn', title: loc('Horizontal spiegeln'), onclick: () => flipSel('h') }, '↔'),
    h('button', { class: 'tbtn', title: loc('Vertikal spiegeln'), onclick: () => flipSel('v') }, '↕')));

  if (one) {
    if (one.type === 'rect') el.appendChild(field(loc('Eckenradius'), numInput(one.r || 0, .5, v => { one.r = Math.max(0, v); invalidateShape(one); App.commit('Radius'); })));
    if (one.type === 'polygon') el.appendChild(h('div', { class: 'grid2' },
      field(loc('Ecken'), numInput(one.n, 1, v => { one.n = Math.max(3, v | 0); invalidateShape(one); App.commit('Ecken'); })),
      field(loc('Stern 0–1'), numInput(one.star || 0, .05, v => { one.star = Math.max(0, Math.min(.95, v)); invalidateShape(one); App.commit('Stern'); }))));
    if (one.type === 'text') buildTextProps(el, one);
    if (one.type === 'image') buildImageProps(el, one);
    if (one.type === 'path') {
      const nodes = one.subpaths.reduce((a, sp) => a + sp.nodes.length, 0);
      el.appendChild(h('small', { class: 'hint' }, loc('{n} Teilpfade, {k} Knoten', { n: one.subpaths.length, k: nodes })));
      el.appendChild(h('div', { class: 'row', style: { marginTop: '4px' } },
        h('button', {
          class: 'tbtn', onclick: () => {
            for (const sp of one.subpaths) sp.closed = !sp.closed;
            invalidateShape(one); one._v = (one._v || 0) + 1; App.commit('Pfad schließen');
          }
        }, loc('Öffnen/Schließen')),
        h('button', { class: 'tbtn', onclick: () => App.setTool('node') }, loc('Knoten bearbeiten'))));
    }
  }
  el.appendChild(h('hr', { style: { border: 0, borderTop: '1px solid var(--line)', margin: '8px 0' } }));
  el.appendChild(h('div', { class: 'row', style: { flexWrap: 'wrap', gap: '4px' } },
    h('button', { class: 'tbtn', onclick: groupSel, title: 'Strg+G' }, loc('Gruppieren')),
    h('button', { class: 'tbtn', onclick: ungroupSel, title: 'Strg+U' }, loc('Auflösen')),
    h('button', { class: 'tbtn', onclick: convertToPath }, loc('In Pfad')),
    h('button', { class: 'tbtn', onclick: breakApart }, loc('Trennen')),
    h('button', { class: 'tbtn', onclick: lockSel, title: keyName('Strg+L') }, '🔒 ' + loc('Sperren'))));
}
function typeName(s) {
  const n = { rect: loc('Rechteck'), ellipse: loc('Ellipse'), polygon: loc('Polygon'), path: loc('Pfad'), text: loc('Text'), image: loc('Bild'), group: loc('Gruppe') }[s.type];
  return n ? loc(n) : s.type;
}
function countShapes() { let n = 0; walk(App.doc.shapes, () => n++); return n; }

function buildTextProps(el, t) {
  const ta = h('textarea', {
    id: 'txtInput', rows: 2, style: { resize: 'vertical' },
    oninput: e => { t.text = e.target.value; invalidateShape(t); App.draw(); },
    onchange: () => App.commit('Text ändern'),
    onkeydown: e => e.stopPropagation()
  });
  ta.value = t.text;
  el.appendChild(field(loc('Text'), ta));
  el.appendChild(field(loc('Schrift'), fontSelect(t.font, name => setFont(t, name))));
  el.appendChild(h('div', { class: 'row', style: { margin: '4px 0' } },
    h('button', { class: 'tbtn', style: { flex: '1' }, onclick: () => fontPickerPanel(t), title: loc('Alle Schriften mit Vorschau durchsehen') }, loc('🔤 Schrift wählen …')),
    h('button', { class: 'tbtn', onclick: () => $('#fileInput').click(), title: loc('Eigene TTF/OTF laden') }, loc('＋ Datei'))));
  el.appendChild(h('div', { class: 'grid2' },
    field(loc('Größe mm'), numInput(t.size, 1, v => { t.size = v; App.state.lastFontSize = v; invalidateShape(t); App.commit('Größe'); })),
    field(loc('Zeichenabst.'), numInput(t.hspace, .1, v => { t.hspace = v; invalidateShape(t); App.commit('Abstand'); })),
    field(loc('Zeilenabst.'), numInput(t.vspace, .5, v => { t.vspace = v; invalidateShape(t); App.commit('Abstand'); })),
    field(loc('Ausrichtung'), selectInput(t.align, [{ v: 'left', t: loc('Links') }, { v: 'center', t: loc('Zentriert') }, { v: 'right', t: loc('Rechts') }], v => { t.align = v; invalidateShape(t); App.commit('Ausrichtung'); }))));
  const exact = FontStore.fonts.has(t.font);
  el.appendChild(h('div', { class: 'row' },
    h('button', {
      class: 'tbtn' + (t.bold ? ' on' : ''), disabled: exact || null,
      title: exact ? loc('Fett gibt es nur bei Systemschriften – die mitgelieferten Schriften haben keinen Fett-Schnitt') : loc('Fett'),
      onclick: () => { t.bold = !t.bold; invalidateShape(t); App.commit('Fett'); }
    }, 'F'),
    h('button', {
      class: 'tbtn' + (t.italic ? ' on' : ''), title: loc('Kursiv'),
      onclick: () => { t.italic = !t.italic; invalidateShape(t); App.commit('Kursiv'); }
    }, 'K'),
    h('button', { class: 'tbtn', onclick: convertToPath, title: loc('Text in Vektorpfade umwandeln') }, loc('In Pfad')),
    h('button', { class: 'tbtn', onclick: weldSel, title: loc('Überlappende Buchstaben zu einer Kontur verschmelzen (Text wird zum Pfad)') }, loc('Verschmelzen')),
    h('span', { class: 'tag', style: { marginLeft: 'auto' } }, exact ? loc('exakte Kurven') : loc('nachgezeichnet'))));
  if (!exact && !isBundled(t.font))
    el.appendChild(h('small', { class: 'hint' }, loc('Systemschrift wird nachgezeichnet. Für exakte Kurven eine mitgelieferte Schrift oder eine .ttf/.otf wählen.')));
  const e = libraryEntry(t.font);
  if (e && e.cat === 'script')
    el.appendChild(h('small', { class: 'hint' }, loc('Schreibschrift: „Zeichenabst." auf 0 lassen, damit die Buchstaben verbunden bleiben. „Verschmelzen" macht aus den überlappenden Buchstaben eine einzige Kontur – nötig zum Schneiden, danach ist der Text ein Pfad.')));
}

/* Schrift setzen – lädt sie bei Bedarf nach und zeichnet dann neu */
function setFont(t, name) {
  t.font = name;
  App.state.lastFont = name;
  invalidateShape(t);
  FontStore.cache.clear();
  App.draw();
  if (isBundled(name) && !FontStore.fonts.has(name)) {
    Promise.resolve(ensureFont(name)).then(() => { invalidateShape(t); FontStore.cache.clear(); App.refresh(); });
  }
}

/* Auswahlfeld mit Gruppen: mitgelieferte Schriften nach Kategorie, dann System und geladene Dateien */
function fontSelect(active, onch) {
  const s = h('select', { onchange: () => onch(s.value) });
  const groups = new Map();
  for (const f of FontStore.library) {
    if (!groups.has(f.cat)) groups.set(f.cat, []);
    groups.get(f.cat).push(f.name);
  }
  for (const [cat, names] of groups) {
    const g = h('optgroup', { label: loc(FontStore.cats[cat] || cat) });
    for (const n of names) g.appendChild(h('option', { value: n, selected: n === active, style: { fontFamily: `"${n}"` } }, n));
    s.appendChild(g);
  }
  const loaded = [...FontStore.fonts.keys()].filter(n => !isBundled(n));
  if (loaded.length) {
    const g = h('optgroup', { label: loc('Geladene Dateien') });
    for (const n of loaded) g.appendChild(h('option', { value: n, selected: n === active }, n));
    s.appendChild(g);
  }
  const g2 = h('optgroup', { label: loc('Systemschriften') });
  for (const n of FontStore.systemFonts) g2.appendChild(h('option', { value: n, selected: n === active }, n));
  s.appendChild(g2);
  if (![...s.options].some(o => o.selected)) {
    const g3 = h('optgroup', { label: loc('Aktuell') });
    g3.appendChild(h('option', { value: active, selected: true }, active));
    s.insertBefore(g3, s.firstChild);
  }
  return s;
}

/* ============ Schrift-Panel mit Vorschau ============
   Dockt rechts an, damit der Text auf der Zeichenfläche sichtbar bleibt:
   ein Klick setzt die Schrift sofort – man sieht sie direkt im Werkstück. */
function fontPickerPanel(t) {
  closeDock();
  const original = t.font;
  let cat = 'all', q = '';
  const sample = () => {
    const first = String(t.text || '').split('\n')[0].trim();
    return first ? first.slice(0, 22) : loc('Hallo Laser');
  };
  const list = h('div', { class: 'fontlist' });
  const count = h('small', { class: 'hint' }, '');
  const draw = () => {
    list.innerHTML = '';
    const ql = q.trim().toLowerCase();
    const items = FontStore.library.filter(f =>
      (cat === 'all' || f.cat === cat) && (!ql || f.name.toLowerCase().includes(ql)));
    for (const f of items) {
      list.appendChild(h('div', {
        class: 'fontrow' + (f.name === t.font ? ' on' : ''),
        onclick: () => { setFont(t, f.name); draw(); }
      },
        h('div', { class: 'fp', style: { fontFamily: `"${f.name}"` } }, sample()),
        h('div', { class: 'fn' }, f.name)));
    }
    if (!items.length) list.appendChild(h('small', { class: 'hint' }, loc('Keine Schrift gefunden.')));
    count.textContent = loc('{n} von {total} Schriften · Klick setzt sie sofort', { n: items.length, total: FontStore.library.length });
  };
  const search = h('input', {
    type: 'text', placeholder: loc('Schrift suchen …'),
    oninput: e => { q = e.target.value; draw(); }, onkeydown: e => e.stopPropagation()
  });
  const cats = [{ v: 'all', t: loc('Alle') }, ...Object.entries(FontStore.cats).map(([v, tt]) => ({ v, t: loc(tt) }))];
  const body = h('div', { class: 'flexbody' },
    search,
    field(loc('Kategorie'), selectInput('all', cats, v => { cat = v; draw(); })),
    count, list);
  draw();
  const dp = dockPanel(loc('Schrift wählen'), body, [
    { label: loc('Abbrechen'), click: () => { setFont(t, original); App.refresh(); } },
    { label: loc('Übernehmen'), primary: true, click: () => App.commit('Schrift') }
  ]);
  // Suche und Kategorie bleiben oben stehen, nur die Liste scrollt
  dp.el.querySelector('.body').classList.add('flexbody');
  const act = list.querySelector('.fontrow.on');
  if (act) act.scrollIntoView({ block: 'center' });
}

function buildImageProps(el, im) {
  // Live: nur neu zeichnen. Beim Loslassen erst in die Undo-Historie schreiben.
  const live = () => { invalidateImagePreview(im.id); liveDraw(); };
  const done = (label) => { invalidateImagePreview(im.id); App.commit(label); };

  el.appendChild(h('h4', { class: 'sec' }, loc('Gravur-Modus')));
  el.appendChild(segmented([
    { v: 'none', t: loc('Graustufen'), title: loc('Leistung wird moduliert – Fotos, weiche Verläufe') },
    { v: 'threshold', t: loc('Schwelle'), title: loc('Reines Schwarz/Weiß ab Schwellwert') },
    { v: 'stucki', t: loc('Dither'), title: loc('Rasterpunkte (Stucki) – Fotos auf Holz') }
  ], (im.dither === 'none' || im.dither === 'grayscale') ? 'none' : (im.dither === 'threshold' ? 'threshold' : 'stucki'),
    v => { im.dither = v; App.state.imagePreview = true; done('Gravur-Modus'); }));
  el.appendChild(field(loc('Verfahren'), selectInput(im.dither, [
    { v: 'none', t: loc('Graustufen (Leistung moduliert)') }, { v: 'threshold', t: loc('Schwellwert (S/W)') },
    { v: 'ordered', t: loc('Geordnet (Bayer)') }, { v: 'floyd', t: 'Floyd-Steinberg' }, { v: 'jarvis', t: 'Jarvis' },
    { v: 'stucki', t: 'Stucki' }, { v: 'atkinson', t: 'Atkinson' }, { v: 'sierra', t: 'Sierra' }
  ], v => { im.dither = v; done('Verfahren'); })));

  el.appendChild(h('h4', { class: 'sec' }, loc('Bildanpassung (live)')));
  if (im.dither === 'threshold')
    el.appendChild(slider(loc('Schwelle'), im.threshold, 0, 255, 1, v => { im.threshold = v; live(); }, () => done('Schwelle')));
  el.appendChild(slider(loc('Helligkeit'), im.brightness, -100, 100, 1, v => { im.brightness = v; live(); }, () => done('Helligkeit')));
  el.appendChild(slider(loc('Kontrast'), im.contrast, -100, 100, 1, v => { im.contrast = v; live(); }, () => done('Kontrast')));
  el.appendChild(slider(loc('Gamma'), im.gamma, 0.1, 4, .05, v => { im.gamma = v; live(); }, () => done('Gamma')));
  el.appendChild(h('div', { class: 'row' },
    checkbox(im.invert, v => { im.invert = v; done('Invertieren'); }, loc('Negativ')),
    checkbox(im.transparency, v => { im.transparency = v; done('Transparenz'); }, loc('Transparenz = weiß'))));
  el.appendChild(h('div', { class: 'row', style: { marginTop: '4px' } },
    h('button', {
      class: 'tbtn', title: loc('Helligkeit, Kontrast, Gamma und Negativ zurücksetzen'),
      onclick: () => { im.brightness = 0; im.contrast = 0; im.gamma = 1; im.invert = false; done('Bild zurücksetzen'); }
    }, loc('Zurücksetzen')),
    h('button', { class: 'tbtn', onclick: traceImageDialog, title: loc('Konturen als Vektoren erzeugen') }, loc('Nachzeichnen…')),
    h('button', { class: 'tbtn', onclick: () => F.bgRemoveDialog(im), title: loc('Einfarbigen Hintergrund transparent machen') }, loc('Hintergrund…'))));
  el.appendChild(h('div', { class: 'row', style: { marginTop: '4px' } },
    checkbox(App.state.imagePreview !== false, v => { App.state.imagePreview = v; saveUI(); App.draw(); },
      loc('Gravur-Vorschau auf der Zeichenfläche'))));
  const L = App.doc.layers[im.layer];
  if (L.mode === 'line')
    el.appendChild(h('small', { class: 'hint', style: { color: 'var(--warn)' } },
      loc('⚠ Ebene {n} steht auf „Linie" – Bilder werden nur im Modus „Füllen" graviert.', { n: layerNo(im.layer) })));
  el.appendChild(h('small', { class: 'hint' },
    loc('Gravur-Auflösung folgt dem Zeilenabstand der Ebene ({mm} mm ≈ {dpi} DPI)', { mm: L.interval, dpi: Math.round(25.4 / L.interval) })));
  const src = getImage(im.src);
  if (src.complete && src.naturalWidth) {
    const dpi = src.naturalWidth / (Math.abs(im.w) / 25.4);
    el.appendChild(h('small', { class: 'hint', style: dpi < 25.4 / L.interval * 0.6 ? { color: 'var(--warn)' } : {} },
      loc('Bild: {w} × {h} px · {dpi} DPI bei {mm} mm Breite', { w: src.naturalWidth, h: src.naturalHeight, dpi: Math.round(dpi), mm: fmtNum(Math.abs(im.w)) })
      + (dpi < 25.4 / L.interval * 0.6 ? ' – ' + loc('Bild ist gröber als die Gravur, es wird hochskaliert.') : '')));
  }
}

/* ============ Laser-Panel ============ */
function buildLaser() {
  const el = $('#laserBody');
  el.innerHTML = '';
  const M = App.doc.machine;
  const anchor = h('div', { class: 'anchor' });
  for (let r = 2; r >= 0; r--) for (let c = 0; c < 3; c++) {
    const idx = r * 3 + c;
    anchor.appendChild(h('div', {
      class: M.jobOriginAnchor === idx ? 'on' : '', title: loc('Startpunkt'),
      onclick: () => { M.jobOriginAnchor = idx; buildLaser(); }
    }));
  }
  el.appendChild(h('div', { class: 'row', style: { alignItems: 'flex-start', gap: '10px' } },
    h('div', {}, h('small', { class: 'hint' }, loc('Startpunkt')), anchor),
    h('div', { style: { flex: 1 } },
      field(loc('Ursprung'), selectInput(M.jobOrigin, [
        { v: 'current', t: loc('Aktuelle Position') }, { v: 'absolute', t: loc('Absolute Koord.') }, { v: 'user', t: loc('Benutzer-Ursprung') }
      ], v => { M.jobOrigin = v; buildLaser(); })),
      M.jobOrigin === 'user' ? h('div', { class: 'grid2' },
        field('X', numInput(M.userX, 1, v => M.userX = v)), field('Y', numInput(M.userY, 1, v => M.userY = v))) : null)
  ));
  el.appendChild(checkbox(App.state.selectedOnly, v => { App.state.selectedOnly = v; },
    loc('Nur ausgewählte Objekte ausgeben')));
  el.appendChild(h('div', { class: 'row', style: { alignItems: 'center', gap: '8px' } },
    checkbox(M.frameBeforeJob !== 'off', v => { M.frameBeforeJob = v ? (M.frameLast || 'laser') : 'off'; App.persist(); buildLaser(); },
      loc('Vor dem Job den Rahmen abfahren')),
    M.frameBeforeJob !== 'off' ? selectInput(M.frameBeforeJob, [
      { v: 'laser', t: loc('mit schwachem Laser') }, { v: 'move', t: loc('nur Bewegung') }
    ], v => { M.frameBeforeJob = M.frameLast = v; App.persist(); }) : null));
  if (M.support === 'none' || M.support === 'limited') {
    el.appendChild(h('small', {
      class: 'hint', style: { color: M.support === 'none' ? 'var(--err)' : 'var(--warn)' }
    }, M.support === 'none'
      ? loc('⚠ {name} versteht kein GCode. Zeichnen und SVG-Export gehen, der Versand nicht – dafür die Software des Herstellers nutzen.', { name: M.name })
      : loc('⚠ {name} ist nur eingeschränkt kompatibel – vor dem ersten Job mit Restmaterial testen.', { name: M.name })));
  }
  const rng = outputRangeText();
  if (rng) {
    el.appendChild(h('div', {
      class: 'row',
      style: { marginTop: '4px', color: rng.bad ? 'var(--err)' : 'var(--fg2)', fontSize: '11.5px' }
    }, h('span', {}, rng.bad ? loc('⚠ Ausgabe:') : loc('Ausgabe:')), h('b', {}, rng.text)));
    if (rng.bad) el.appendChild(h('small', { class: 'hint', style: { color: 'var(--err)' } },
      M.jobOrigin === 'current'
        ? loc('Negative Koordinaten – nach der Referenzfahrt fährt der Kopf in den Endschalter. Ursprung auf „Absolute Koord." stellen.')
        : loc('Liegt außerhalb des Arbeitsbereichs.')));
  }
  el.appendChild(h('div', { class: 'laserGrid', style: { marginTop: '6px' } },
    h('button', { class: 'tbtn', onclick: showPreview }, loc('▶ Vorschau')),
    h('button', { class: 'tbtn', onclick: doFrame }, loc('⬚ Rahmen')),
    h('button', { class: 'tbtn', onclick: () => exportGcode(true) }, loc('⤓ GCode'))));

  // Verbindung
  const S = App.serial;
  const st = h('div', { class: 'row', style: { margin: '8px 0 4px' } },
    h('span', { class: 'badge', id: 'serState' }, S.connected ? (S.status.state || loc('verbunden')) : loc('getrennt')),
    h('span', { class: 'tag', id: 'serPos' }, ''),
    h('span', { style: { flex: 1 } }),
    h('button', {
      class: 'tbtn', onclick: async () => {
        if (S.connected) { await S.disconnect(); toast(loc('Getrennt')); buildLaser(); }
        else {
          try { await S.connect(App.doc.machine.baud); toast(loc('Verbunden'), 'ok'); buildLaser(); }
          catch (e) { toast(e.message, 'err'); }
        }
      }
    }, S.connected ? loc('Trennen') : loc('Verbinden')));
  el.appendChild(st);

  if (S.connected) {
    const jogStep = App.state.jogStep || 10;
    const jb = (dx, dy, label) => h('button', { class: 'tbtn', onclick: () => S.jog(dx * (App.state.jogStep || 10), dy * (App.state.jogStep || 10), 3000) }, label);
    el.appendChild(h('div', { class: 'jog' },
      jb(-1, 1, '↖'), jb(0, 1, '↑'), jb(1, 1, '↗'),
      jb(-1, 0, '←'), h('button', { class: 'tbtn', title: loc('Nullpunkt setzen'), onclick: () => S.zero() }, '⌂'), jb(1, 0, '→'),
      jb(-1, -1, '↙'), jb(0, -1, '↓'), jb(1, -1, '↘')));
    el.appendChild(h('div', { class: 'row', style: { marginTop: '5px' } },
      h('span', { class: 'tag' }, loc('Schritt')),
      selectInput(String(jogStep), ['0.1', '1', '5', '10', '50', '100'].map(v => ({ v, t: v + ' mm' })), v => { App.state.jogStep = parseFloat(v); })));
    el.appendChild(h('div', { class: 'laserGrid', style: { marginTop: '6px' } },
      h('button', { class: 'tbtn', title: loc('Kopf fährt an die Endschalter und bestimmt seine Position ($H)'), onclick: () => S.home() }, loc('Referenzfahrt')),
      h('button', { class: 'tbtn', title: loc('Alarm aufheben, damit der Laser wieder Befehle annimmt ($X)'), onclick: () => S.unlock() }, loc('Alarm lösen')),
      h('button', { class: 'tbtn', title: loc('Laser kurz testen'), onclick: () => S.laserTest(App.doc.machine.laserFirePower, App.doc.machine.sScale, 400) }, loc('✸ Test'))));
    el.appendChild(h('div', { class: 'laserGrid', style: { marginTop: '6px' } },
      h('button', { class: 'tbtn big go', onclick: startJob }, loc('▶ Start')),
      h('button', { class: 'tbtn', id: 'pauseBtn', onclick: () => { S.paused ? S.resume() : S.pause(); updPauseBtn(); toast(S.paused ? loc('Pausiert') : loc('Fortgesetzt')); } }, pauseLabel()),
      h('button', { class: 'tbtn big stop', onclick: () => { S.stop(); updPauseBtn(); toast(loc('Gestoppt'), 'err'); } }, loc('⏹ Stopp'))));
    el.appendChild(h('div', { style: { marginTop: '6px', height: '6px', background: 'var(--bg3)', borderRadius: '3px', overflow: 'hidden' } },
      h('div', { id: 'progBar', style: { height: '100%', width: '0%', background: 'var(--ok)' } })));
    el.appendChild(h('div', { class: 'row' }, h('small', { class: 'hint', id: 'progTxt' }, ''),
      h('span', { style: { flex: 1 } }),
      h('button', { class: 'tbtn', onclick: showConsole }, loc('Konsole'))));
  } else {
    el.appendChild(h('small', { class: 'hint' }, App.serial.supported
      ? loc('Verbinde den Laser per USB und klicke „Verbinden" (Chrome/Edge).')
      : loc('Web Serial nicht verfügbar – GCode speichern und per SD-Karte oder mit einem anderen Programm senden.')));
  }
}
// Pause-Knopf zeigt, was ein Klick bewirkt: pausieren oder fortsetzen
const pauseLabel = () => App.serial.paused ? loc('▶ Fortsetzen') : loc('⏸ Pause');
const updPauseBtn = () => { const b = $('#pauseBtn'); if (b) b.textContent = pauseLabel(); };
App.serial.onStatus = (s) => {
  updPauseBtn();
  const e = $('#serState'), p = $('#serPos');
  if (e) { e.textContent = s.state; e.style.color = s.state === 'Alarm' ? 'var(--err)' : s.state === 'Run' ? 'var(--ok)' : ''; }
  if (p) p.textContent = `X${(s.wpos[0] || 0).toFixed(1)} Y${(s.wpos[1] || 0).toFixed(1)}`;
};
App.serial.onProgress = (n, t) => {
  const b = $('#progBar'), x = $('#progTxt');
  if (b && t) b.style.width = (100 * n / t).toFixed(1) + '%';
  if (x && t) x.textContent = loc('{n}/{t} Zeilen', { n, t });
};
App.serial.onDone = () => { toast(loc('Job fertig ✓'), 'ok'); };

function buildOps() {
  const opts = {};
  if (App.state.selectedOnly && App.state.selection.length) {
    opts.only = new Set(App.state.selection.map(s => s.id));
  }
  return buildJob(App.doc, App.ctxGeo, opts);
}
/* Prüft die tatsächlich ausgegebenen Koordinaten und warnt, bevor die
   Maschine in einen Endschalter fährt. Gibt ein Promise<boolean> zurück. */
function checkOutputRange(ops) {
  const M = App.doc.machine;
  const off = jobOffset(App.doc, ops);
  const b = jobBounds(ops);
  if (!isFinite(b.x0)) return Promise.resolve(true);
  const r = { x0: b.x0 + off.x, x1: b.x1 + off.x, y0: b.y0 + off.y, y1: b.y1 + off.y };
  const neg = r.x0 < -0.01 || r.y0 < -0.01;
  const over = r.x1 > M.width + 0.01 || r.y1 > M.height + 0.01;
  if (!neg && !over) return Promise.resolve(true);
  if (!M.boundsCheck) return Promise.resolve(true);

  return new Promise(resolve => {
    const rng = h('div', { class: 'kv', style: { marginBottom: '10px' } },
      h('span', {}, loc('Ausgabe X:')), h('b', { style: { color: r.x0 < -0.01 || r.x1 > M.width ? 'var(--err)' : '' } },
        `${r.x0.toFixed(1)} … ${r.x1.toFixed(1)} mm`),
      h('span', {}, loc('Ausgabe Y:')), h('b', { style: { color: r.y0 < -0.01 || r.y1 > M.height ? 'var(--err)' : '' } },
        `${r.y0.toFixed(1)} … ${r.y1.toFixed(1)} mm`),
      h('span', {}, loc('Arbeitsbereich:')), h('b', {}, `0 … ${M.width} / 0 … ${M.height} mm`),
      h('span', {}, loc('Ursprung:')), h('b', {}, loc(({ absolute: loc('Absolute Koordinaten'), current: loc('Aktuelle Position'), user: loc('Benutzer-Ursprung') })[M.jobOrigin])));

    const msg = h('div');
    if (neg && M.jobOrigin === 'current') {
      msg.appendChild(h('p', {}, loc('Der Job enthält negative Koordinaten. Im Modus „Aktuelle Position" sind alle Werte relativ zum Startpunkt des Laserkopfs – die Maschine müsste {x} mm nach links und {y} mm nach vorn fahren.',
        { x: Math.abs(Math.min(0, r.x0)).toFixed(0), y: Math.abs(Math.min(0, r.y0)).toFixed(0) })));
      msg.appendChild(h('p', { style: { color: 'var(--warn)' } },
        loc('Steht der Kopf nach der Referenzfahrt in der Ecke, fährt er gegen den Endschalter und der Job wird falsch.')));
      msg.appendChild(h('p', {}, loc('Für Laser mit Referenzfahrt sind absolute Koordinaten fast immer die richtige Einstellung.')));
    } else if (neg) {
      msg.appendChild(h('p', {}, loc('Ein Teil der Zeichnung liegt außerhalb der Arbeitsfläche (negative Koordinaten). Verschiebe die Objekte in die Arbeitsfläche.')));
    } else {
      msg.appendChild(h('p', {}, loc('Der Job ragt über den Arbeitsbereich hinaus. Die Maschine würde am Endschalter anschlagen.')));
    }

    let done = false;
    const finish = v => { if (!done) { done = true; resolve(v); } };
    const btns = [
      { label: loc('Abbrechen'), click: () => finish(false) },
      { label: loc('Trotzdem fortfahren'), click: () => finish(true) }
    ];
    if (neg && M.jobOrigin === 'current') {
      btns.push({
        label: loc('Auf absolute Koordinaten umstellen'), primary: true, click: () => {
          App.doc.machine.jobOrigin = 'absolute';
          buildLaser();
          toast(loc('Ursprung auf „Absolute Koordinaten" umgestellt'), 'ok');
          finish(true);
        }
      });
    } else if (neg) {
      btns.push({
        label: loc('In Arbeitsfläche verschieben'), primary: true, click: () => {
          const dx = r.x0 < 0 ? -r.x0 + 5 : 0, dy = r.y0 < 0 ? -r.y0 + 5 : 0;
          for (const sh of App.doc.shapes) sh.transform = Mat.mul(sh.transform, Mat.translate(dx, dy));
          App.commit('In Arbeitsfläche verschieben');
          finish(false);
          toast(loc('Zeichnung verschoben – bitte GCode neu erzeugen'), 'ok');
        }
      });
    }
    const m = modal(loc('⚠ Job liegt außerhalb des Arbeitsbereichs'), h('div', {}, rng, msg), btns, { width: '520px', sticky: true });
    m.el.addEventListener('click', e => { if (e.target === m.el) finish(false); });
  });
}

/* Live-Anzeige des Ausgabebereichs im Laser-Panel */
function outputRangeText() {
  try {
    const M = App.doc.machine;
    const outLayers = new Set(App.doc.layers.filter(L => L.output && !L.isTool).map(L => L.index));
    const list = App.doc.shapes.filter(sh => {
      if (sh.hidden) return false;
      if (sh.type === 'group') return true;
      return outLayers.has(sh.layer);
    });
    if (!list.length) return null;
    const b = shapesBBox(list, App.ctxGeo);
    if (!boxValid(b)) return null;
    let off = { x: 0, y: 0 };
    if (M.jobOrigin === 'user') off = { x: -M.userX, y: -M.userY };
    else if (M.jobOrigin === 'current') {
      const ax = M.jobOriginAnchor % 3, ay = Math.floor(M.jobOriginAnchor / 3);
      off = { x: -(b.x0 + boxW(b) * (ax / 2)), y: -(b.y0 + boxH(b) * (ay / 2)) };
    }
    const r = { x0: b.x0 + off.x, x1: b.x1 + off.x, y0: b.y0 + off.y, y1: b.y1 + off.y };
    const bad = r.x0 < -0.01 || r.y0 < -0.01 || r.x1 > M.width + 0.01 || r.y1 > M.height + 0.01;
    return {
      text: `X ${r.x0.toFixed(1)}…${r.x1.toFixed(1)} · Y ${r.y0.toFixed(1)}…${r.y1.toFixed(1)} mm`,
      bad
    };
  } catch (e) { return null; }
}

async function exportGcode(show) {
  const ops = buildOps();
  if (!ops.length) return toast(loc('Keine ausgabefähigen Objekte (Ebene auf „Ausgabe" prüfen)'), 'err');
  if (!await checkOutputRange(ops)) return;
  const g = generateGCode(App.doc, ops, {});
  const name = fileBase('job') + '.gcode';
  if (show) showGcode(g, name);
  else download(name, g);
}
function showGcode(text, name) {
  const lines = text.split('\n');
  const shown = lines.length > 4000 ? lines.slice(0, 4000).join('\n') + '\n… (' + loc('{n} weitere Zeilen', { n: lines.length - 4000 }) + ')' : text;
  const c = h('div', {},
    h('div', { class: 'row', style: { marginBottom: '6px' } },
      h('span', { class: 'badge' }, loc('{n} Zeilen', { n: lines.length })),
      h('span', { class: 'badge' }, (new Blob([text]).size / 1024).toFixed(1) + ' KB')),
    h('pre', { class: 'code' }, shown));
  modal(loc('GCode') + ' – ' + name, c, [
    { label: loc('Kopieren'), click: () => { navigator.clipboard.writeText(text); toast(loc('Kopiert'), 'ok'); return false; }, keep: true },
    { label: loc('An Laser senden'), click: () => { sendToLaser(text); } },
    { label: loc('Speichern'), primary: true, click: () => download(name, text) }
  ], { width: '760px' });
}
async function sendToLaser(gcode) {
  const S = App.serial;
  if (!S.connected) {
    try { await S.connect(App.doc.machine.baud); buildLaser(); }
    catch (e) { return toast(e.message, 'err'); }
  }
  const n = S.stream(gcode);
  toast(loc('Sende {n} Zeilen an den Laser…', { n }), 'ok');
}
async function startJob() {
  const ops = buildOps();
  if (!ops.length) return toast(loc('Nichts auszugeben'), 'err');
  if (!await checkOutputRange(ops)) return;
  const est = estimateTime(App.doc, ops);
  const c = h('div', {}, h('div', { class: 'kv' },
    h('span', {}, loc('Geschätzte Dauer:')), h('b', {}, fmtTime(est.seconds)),
    h('span', {}, loc('Schnittlänge:')), h('b', {}, (est.cutLen / 1000).toFixed(2) + ' m'),
    h('span', {}, loc('Ursprung:')), h('b', {}, App.doc.machine.jobOrigin === 'current' ? loc('Aktuelle Position') : App.doc.machine.jobOrigin === 'absolute' ? loc('Absolut') : loc('Benutzer'))),
    h('p', { style: { color: 'var(--warn)' } }, loc('⚠ Schutzbrille tragen, Laser nie unbeaufsichtigt betreiben.')));
  modal(loc('Job starten?'), c, [{ label: loc('Abbrechen') }, {
    label: loc('Jetzt starten'), primary: true, click: () => sendToLaser(generateGCode(App.doc, ops, {}))
  }]);
}
async function doFrame() {
  const ops = buildOps();
  if (!ops.length) return toast(loc('Nichts auszugeben'), 'err');
  if (!await checkOutputRange(ops)) return;
  const g = frameGCode(App.doc, ops);
  if (!g) return;
  if (App.serial.connected) { sendToLaser(g); toast(loc('Rahmen wird abgefahren')); }
  else showGcode(g, fileBase('job') + ' – ' + loc('Rahmen') + '.gcode');
}

/* ============ Vorschau ============
   Dockt wie das Nachzeichnen rechts an: die Werkzeugwege bleiben frei sichtbar. */
function showPreview() {
  const ops = buildOps();
  if (!ops.length) return toast(loc('Keine Werkzeugwege'), 'err');
  closeDock();
  const est = estimateTime(App.doc, ops);
  App.state.preview = { ops, upto: ops.length, showTravel: App.state.showTravel };
  ensureBoxVisible(opsBBox(ops));
  App.draw();
  const pos = h('small', { class: 'hint' }, '');
  let timer = null;
  const stop = () => { clearInterval(timer); timer = null; play.textContent = loc('▶ Abspielen'); };
  const setUpto = i => {
    App.state.preview.upto = i;
    App.state.preview.head = i < ops.length ? pointAt(ops, i) : null;
    slider.value = i;
    pos.textContent = loc('Operation {i} von {n}', { i, n: ops.length });
    App.draw();
  };
  const slider = h('input', {
    type: 'range', min: 0, max: ops.length, value: ops.length, style: { width: '100%' },
    oninput: e => { stop(); setUpto(+e.target.value); }
  });
  const play = h('button', {
    class: 'tbtn', onclick: () => {
      if (timer) return stop();
      let i = +slider.value >= ops.length ? 0 : +slider.value;
      play.textContent = loc('⏸ Pause');
      timer = setInterval(() => {
        i += Math.max(1, Math.round(ops.length / 240));
        if (i >= ops.length) { i = ops.length; stop(); }
        setUpto(i);
      }, 30);
    }
  }, loc('▶ Abspielen'));
  const body = h('div', {},
    h('div', { class: 'kv', style: { marginBottom: '8px' } },
      h('span', {}, loc('Dauer:')), h('b', {}, fmtTime(est.seconds)),
      h('span', {}, loc('Schnittweg:')), h('b', {}, (est.cutLen / 1000).toFixed(2) + ' m'),
      h('span', {}, loc('Leerweg:')), h('b', {}, (est.rapidLen / 1000).toFixed(2) + ' m'),
      h('span', {}, loc('Operationen:')), h('b', {}, String(ops.length))),
    slider, pos,
    h('div', { class: 'row', style: { marginTop: '6px' } },
      play,
      checkbox(App.state.showTravel, v => { App.state.showTravel = v; App.state.preview.showTravel = v; App.draw(); }, loc('Leerwege zeigen'))),
    h('small', { class: 'hint', style: { marginTop: '6px' } },
      loc('Grün = Schneiden, Blau = Gravur (heller = weniger Leistung), Rot = Leerfahrt.')));
  setUpto(ops.length);
  dockPanel(loc('Vorschau'), body, [
    { label: loc('⬚ Rahmen'), keep: true, click: () => { doFrame(); } },
    { label: loc('Schließen'), primary: true }
  ], () => { stop(); App.state.preview = null; App.draw(); }, { keepLaser: true });
}
function opsBBox(ops) {
  const b = { x0: Infinity, y0: Infinity, x1: -Infinity, y1: -Infinity };
  for (const op of ops) for (const p of op.pts) {
    if (p.x < b.x0) b.x0 = p.x; if (p.x > b.x1) b.x1 = p.x;
    if (p.y < b.y0) b.y0 = p.y; if (p.y > b.y1) b.y1 = p.y;
  }
  return b;
}
function pointAt(ops, i) {
  const op = ops[Math.max(0, Math.min(ops.length - 1, i - 1))];
  if (!op) return null;
  return op.closed ? op.pts[0] : op.pts[op.pts.length - 1];
}

/* ============ Laser auswählen ============ */
async function deviceDialog() {
  await loadDevices();
  const ch = deviceChooser(App);
  modal(loc('Laser auswählen'), ch.el, [
    { label: loc('Abbrechen') },
    {
      label: loc('Übernehmen'), primary: true, click: () => {
        if (!ch.state.sel) { toast(loc('Bitte ein Gerät auswählen'), 'err'); return false; }
        applyDevice(App, ch.state.sel, {
          width: ch.state.width, height: ch.state.height, homing: ch.state.homing,
          sMax: ch.state.sMax, maxSpeed: ch.state.maxSpeed, accel: ch.state.accel
        });
        scheduleAutosave();
        toast(loc('Gerät übernommen: {name}', { name: App.doc.machine.name }), 'ok');
      }
    }
  ], { width: '880px' });
  setTimeout(() => ch.focus(), 50);
}

/* ============ Maschinen-Einstellungen ============ */
function machineDialog() {
  const M = App.doc.machine;
  const c = h('div', {},
    h('div', { class: 'row', style: { marginBottom: '8px' } },
      h('span', { class: 'tag' }, loc('Fertige Werte für dein Modell:')),
      h('button', { class: 'tbtn', onclick: () => deviceDialog() }, loc('🔍 Laser aus Liste wählen …'))),
    h('div', { class: 'grid2', style: { marginBottom: '6px' } },
      field(loc('Einheit für Geschwindigkeiten'), speedUnitSelect(() => { m.close(); machineDialog(); }))),
    h('div', { class: 'grid2' },
      field(loc('Name'), h('input', { type: 'text', value: M.name, onchange: e => M.name = e.target.value })),
      field(loc('Firmware'), selectInput(M.firmware, [{ v: 'GRBL', t: 'GRBL' }, { v: 'GRBL-M3', t: loc('GRBL-M3 (alt)') }, { v: 'Marlin', t: 'Marlin' }], v => M.firmware = v)),
      field(loc('Breite mm'), numInput(M.width, 1, v => { M.width = v; App.draw(); })),
      field(loc('Höhe mm'), numInput(M.height, 1, v => { M.height = v; App.draw(); })),
      field(loc('S-Wert max'), numInput(M.sScale, 1, v => M.sScale = v)),
      field(loc('Baudrate'), selectInput(String(M.baud), ['9600', '19200', '38400', '57600', '115200', '230400', '250000'].map(v => ({ v, t: v })), v => M.baud = +v)),
      field(loc('Eilgang') + ' ' + speedUnit(), speedInput(M.rapidSpeed, v => M.rapidSpeed = v)),
      field(loc('Max Speed X') + ' ' + speedUnit(), speedInput(M.maxSpeedX, v => M.maxSpeedX = v)),
      field(loc('Max Speed Y') + ' ' + speedUnit(), speedInput(M.maxSpeedY, v => M.maxSpeedY = v)),
      field(loc('Beschl. X'), numInput(M.accelX, 10, v => M.accelX = v)),
      field(loc('Beschl. Y'), numInput(M.accelY, 10, v => M.accelY = v)),
      field(loc('Junction Dev.'), numInput(M.junctionDeviation ?? 0.01, .001, v => M.junctionDeviation = v)),
      field(loc('Test-Leistung %'), numInput(M.laserFirePower, 1, v => M.laserFirePower = v))),
    h('div', { class: 'grid2', style: { marginTop: '6px' } },
      checkbox(M.enableZ, v => M.enableZ = v, loc('Z-Achse benutzen')),
      checkbox(M.negativeZ, v => M.negativeZ = v, loc('Z negativ')),
      checkbox(M.airAssistM7, v => M.airAssistM7 = v, loc('Luft über M7 (sonst M8)')),
      checkbox(M.boundsCheck, v => M.boundsCheck = v, loc('Bereichsprüfung')),
      checkbox(M.returnToFinish, v => M.returnToFinish = v, loc('Endposition anfahren'))),
    h('h4', { class: 'sec' }, loc('Rahmen vor dem Job')),
    h('div', { class: 'grid2' },
      field(loc('Rahmen'), selectInput(M.frameBeforeJob || 'off', [
        { v: 'off', t: loc('aus') }, { v: 'laser', t: loc('mit schwachem Laser') }, { v: 'move', t: loc('nur Bewegung') }
      ], v => { M.frameBeforeJob = v; if (v !== 'off') M.frameLast = v; })),
      field(loc('Geschw. mit Laser') + ' ' + speedUnit(), speedInput(M.frameSpeed ?? 60, v => M.frameSpeed = Math.max(1, v))),
      field(loc('Wiederholungen'), numInput(M.frameRepeat ?? 1, 1, v => M.frameRepeat = Math.max(1, Math.min(5, Math.round(v))))),
      field(loc('Pause danach s'), numInput(M.framePause ?? 1, .5, v => M.framePause = Math.max(0, v)))),
    h('small', { class: 'hint' }, loc('Der Laser fährt vor dem Lasern einmal das Rechteck um die Zeichnung ab – mit der Test-Leistung oder ausgeschaltet. So siehst du, ob das Werkstück richtig liegt.')),
    M.returnToFinish ? h('div', { class: 'grid2' },
      field(loc('Ende X'), numInput(M.finishX, 1, v => M.finishX = v)),
      field(loc('Ende Y'), numInput(M.finishY, 1, v => M.finishY = v))) : null,
    field(loc('Start-GCode'), h('textarea', { rows: 3, onchange: e => M.startGcode = e.target.value }, M.startGcode)),
    field(loc('End-GCode'), h('textarea', { rows: 3, onchange: e => M.endGcode = e.target.value }, M.endGcode)),
    h('div', { class: 'row', style: { marginTop: '8px' } },
      h('button', { class: 'tbtn', onclick: () => { $('#fileInput').click(); } }, loc('.lbdev-Datei laden…'))));
  const m = modal(loc('Geräte-Einstellungen'), c, [{ label: loc('Fertig'), primary: true, click: () => { App.refresh(); $('#devBadge').textContent = `${M.name} · ${M.width}×${M.height} mm · ${M.firmware}`; } }], { width: '560px' });
}

/* ============ Konsole ============ */
function showConsole() {
  const log = h('div', { id: 'console' });
  const inp = h('input', {
    type: 'text', placeholder: loc('GCode/Befehl senden (z. B. $$, G0 X10)…'),
    onkeydown: e => {
      e.stopPropagation();
      if (e.key === 'Enter' && e.target.value.trim()) { App.serial.command(e.target.value.trim()); e.target.value = ''; }
    }
  });
  const add = (cls, s) => { log.appendChild(h('div', { class: cls }, (cls === 'tx' ? '> ' : '') + s)); log.scrollTop = log.scrollHeight; };
  const prev = App.serial.onLine;
  App.serial.onLine = (k, s) => { add(k, s); };
  const c = h('div', {}, log, h('div', { style: { marginTop: '6px' } }, inp),
    h('div', { class: 'row', style: { marginTop: '6px' } },
      h('button', { class: 'tbtn', onclick: () => App.serial.command('$$') }, '$$ Einstellungen'),
      h('button', { class: 'tbtn', onclick: () => App.serial.command('$I') }, '$I Version'),
      h('button', { class: 'tbtn', onclick: () => App.serial.command('$G') }, '$G Zustand')));
  const m = modal(loc('Laser-Konsole'), c, [{ label: loc('Schließen'), primary: true, click: () => { App.serial.onLine = prev; } }], { width: '620px' });
}


/* ============ Materialbibliothek ============ */
function materialDialog() {
  const wrap = h('div');
  const render = () => {
    wrap.innerHTML = '';
    const mats = Library.materials();
    const L = App.doc.layers[App.state.activeLayer];
    wrap.appendChild(h('div', { class: 'row', style: { marginBottom: '8px' } },
      h('span', {}, loc('Ziel-Ebene:')),
      h('span', { class: 'swatch', style: { background: L.color } }),
      h('b', {}, layerLabel(L))));
    const list = h('div', { style: { maxHeight: '46vh', overflow: 'auto', border: '1px solid var(--line)', borderRadius: '8px' } });
    mats.forEach((m, i) => {
      list.appendChild(h('div', {
        class: 'row',
        style: { padding: '6px 9px', borderBottom: '1px solid #ffffff10', cursor: 'pointer' },
        ondblclick: () => { applyMaterial(m); }
      },
        h('div', { style: { flex: 1 } },
          h('div', {}, loc(m.name)),
          h('small', { class: 'hint' }, `${loc(({ line: loc('Linie'), fill: loc('Füllen'), 'fill+line': loc('Füllen+Linie'), offset: loc('Offset') })[m.mode] || m.mode)} · ${fmtSpeed(m.speed)} · ${m.maxPower} % · ${m.passes || 1}×${m.interval ? ' · ' + m.interval + ' mm' : ''}`)),
        h('button', { class: 'tbtn', onclick: (e) => { e.stopPropagation(); applyMaterial(m); } }, loc('Anwenden')),
        h('button', { class: 'tbtn', title: loc('Löschen'), onclick: (e) => { e.stopPropagation(); Library.removeMaterial(i); render(); } }, '✕')));
    });
    wrap.appendChild(list);
    wrap.appendChild(h('div', { class: 'row', style: { marginTop: '8px' } },
      h('button', {
        class: 'tbtn', onclick: () => {
          const name = prompt(loc('Name der Vorlage (z. B. „Sperrholz 4 mm – Schneiden")'), loc('Neue Vorlage'));
          if (!name) return;
          const L2 = App.doc.layers[App.state.activeLayer];
          Library.addMaterial({
            name, mode: L2.mode, speed: L2.speed, maxPower: L2.maxPower, minPower: L2.minPower,
            passes: L2.passes, interval: L2.interval, airAssist: L2.airAssist, constantPower: L2.constantPower,
            kerf: L2.kerf, angle: L2.angle, crosshatch: L2.crosshatch
          });
          render(); toast(loc('Vorlage gespeichert'), 'ok');
        }
      }, loc('+ Aktuelle Ebene speichern')),
      h('button', { class: 'tbtn', onclick: () => { Library.resetMaterials(); render(); } }, loc('Standard wiederherstellen')),
      h('span', { style: { flex: 1 } }),
      h('small', { class: 'hint' }, loc('Doppelklick = anwenden'))));
  };
  const applyMaterial = (m) => {
    const L = App.doc.layers[App.state.activeLayer];
    for (const k of ['mode', 'speed', 'maxPower', 'minPower', 'passes', 'interval', 'airAssist', 'constantPower', 'kerf', 'angle', 'crosshatch']) {
      if (m[k] !== undefined) L[k] = m[k];
    }
    App.commit('Material anwenden');
    toast(loc('„{name}" auf Ebene {n} angewendet', { name: loc(m.name), n: layerNo(L.index) }), 'ok');
  };
  render();
  modal(loc('Materialbibliothek'), wrap, [{ label: loc('Schließen'), primary: true }], { width: '560px' });
}


/* ============ Materialtest-Generator ============ */
function materialTestDialog() {
  const cfg = {
    cols: 5, rows: 5, pMin: 20, pMax: 100, sMin: 20, sMax: 200,
    cell: 12, gap: 4, mode: 'fill', labels: true, x: 30, y: 30, interval: 0.1, passes: 1
  };
  const body = h('div');
  const info = h('small', { class: 'hint' });
  const upd = () => {
    const n = cfg.cols * cfg.rows;
    const w = cfg.cols * (cfg.cell + cfg.gap) - cfg.gap;
    const hh = cfg.rows * (cfg.cell + cfg.gap) - cfg.gap;
    info.textContent = loc('{n} Felder · Gesamtgröße {w} × {h} mm', { n, w: w.toFixed(0), h: hh.toFixed(0) }) +
      (n > 30 ? ' · ' + loc('zu viele Felder (max. 30 Ebenen)') : '');
    info.style.color = n > 30 ? 'var(--err)' : '';
  };
  body.appendChild(h('div', { class: 'grid2' },
    field(loc('Spalten (Leistung)'), numInput(cfg.cols, 1, v => { cfg.cols = Math.max(1, v | 0); upd(); })),
    field(loc('Zeilen (Speed)'), numInput(cfg.rows, 1, v => { cfg.rows = Math.max(1, v | 0); upd(); })),
    field(loc('Leistung von %'), numInput(cfg.pMin, 1, v => cfg.pMin = v)),
    field(loc('bis %'), numInput(cfg.pMax, 1, v => cfg.pMax = v)),
    field(loc('Speed von') + ' ' + speedUnit(), speedInput(cfg.sMin, v => cfg.sMin = v)),
    field(loc('bis') + ' ' + speedUnit(), speedInput(cfg.sMax, v => cfg.sMax = v)),
    field(loc('Feldgröße mm'), numInput(cfg.cell, 1, v => { cfg.cell = v; upd(); })),
    field(loc('Abstand mm'), numInput(cfg.gap, 1, v => { cfg.gap = v; upd(); })),
    field(loc('Modus'), selectInput(cfg.mode, [{ v: 'fill', t: loc('Füllen (Gravur)') }, { v: 'line', t: loc('Linie (Schneiden)') }], v => cfg.mode = v)),
    field(loc('Zeilenabstand'), numInput(cfg.interval, .01, v => cfg.interval = v)),
    field(loc('Durchgänge'), numInput(cfg.passes, 1, v => cfg.passes = Math.max(1, v | 0))),
    field(loc('Position X / Y'), h('div', { class: 'row' },
      numInput(cfg.x, 1, v => cfg.x = v), numInput(cfg.y, 1, v => cfg.y = v)))));
  body.appendChild(checkbox(cfg.labels, v => cfg.labels = v, loc('Beschriftung gravieren')));
  body.appendChild(info); upd();
  modal(loc('Materialtest erstellen'), body, [{ label: loc('Abbrechen') }, {
    label: loc('Erstellen'), primary: true, click: () => {
      const n = cfg.cols * cfg.rows;
      if (n > 30) { toast(loc('Höchstens 30 Felder (eine Ebene pro Feld)'), 'err'); return false; }
      const news = [];
      const step = cfg.cell + cfg.gap;
      let li = 0;
      for (let r = 0; r < cfg.rows; r++) {
        const speed = cfg.rows === 1 ? cfg.sMin : cfg.sMin + (cfg.sMax - cfg.sMin) * (r / (cfg.rows - 1));
        for (let c = 0; c < cfg.cols; c++) {
          const power = cfg.cols === 1 ? cfg.pMin : cfg.pMin + (cfg.pMax - cfg.pMin) * (c / (cfg.cols - 1));
          const L = App.doc.layers[li];
          L.mode = cfg.mode; L.speed = Math.round(speed * 10) / 10;
          L.maxPower = Math.round(power * 10) / 10; L.minPower = cfg.mode === 'line' ? L.maxPower : 0;
          L.passes = cfg.passes; L.interval = cfg.interval; L.output = true; L.show = true;
          L.name = `${L.maxPower}% / ${fmtSpeed(L.speed)}`;
          const x = cfg.x + c * step;
          const y = cfg.y + (cfg.rows - 1 - r) * step;
          const sq = Shape.rect(x, y, cfg.cell, cfg.cell, li);
          App.doc.shapes.push(sq); news.push(sq);
          li++;
        }
      }
      if (cfg.labels) {
        const LL = App.doc.layers[29];
        LL.mode = 'fill'; LL.speed = Math.max(100, cfg.sMax); LL.maxPower = Math.min(35, cfg.pMax);
        LL.minPower = 0; LL.interval = 0.12; LL.passes = 1; LL.output = true; LL.name = loc('Beschriftung');
        const fs = Math.min(4, cfg.cell * 0.32);
        for (let c = 0; c < cfg.cols; c++) {
          const power = cfg.cols === 1 ? cfg.pMin : cfg.pMin + (cfg.pMax - cfg.pMin) * (c / (cfg.cols - 1));
          const t = Shape.text(cfg.x + c * step + cfg.cell / 2, cfg.y + cfg.rows * step - cfg.gap + 1, Math.round(power) + '%', 29);
          t.size = fs; t.align = 'center';
          App.doc.shapes.push(t); news.push(t);
        }
        for (let r = 0; r < cfg.rows; r++) {
          const speed = cfg.rows === 1 ? cfg.sMin : cfg.sMin + (cfg.sMax - cfg.sMin) * (r / (cfg.rows - 1));
          const y = cfg.y + (cfg.rows - 1 - r) * step + cfg.cell / 2 - fs / 2;
          const t = Shape.text(cfg.x - 2, y, Math.round(toDisp(speed)) + '', 29);
          t.size = fs; t.align = 'right';
          App.doc.shapes.push(t); news.push(t);
        }
        const title = Shape.text(cfg.x, cfg.y + cfg.rows * step + 3, loc('Leistung % →   /   Speed {u} ↓', { u: speedUnit() }), 29);
        title.size = fs; App.doc.shapes.push(title); news.push(title);
      }
      setSel(news);
      App.commit('Materialtest');
      toast(loc('Materialtest mit {n} Feldern erstellt – jedes Feld hat eine eigene Ebene', { n }), 'ok');
    }
  }], { width: '520px' });
}

/* ============ Symbol-Bibliothek ============
   Dockt rechts an; ein Klick fügt das Symbol in der Mitte der sichtbaren Fläche ein. */
function viewCenter() {
  const w = App.view.toWorld({ x: cv.clientWidth / 2, y: cv.clientHeight / 2 }, cv.clientHeight);
  const M = App.doc.machine;
  // außerhalb der Arbeitsfläche → Mitte der Arbeitsfläche
  if (w.x < 0 || w.y < 0 || w.x > M.width || w.y > M.height) return { x: M.width / 2, y: M.height / 2 };
  return w;
}
function symbolPanel() {
  closeDock();
  let cat = 'all', q = '', size = App.state.symbolSize || 40;
  const grid = h('div', { class: 'symgrid' });
  const count = h('small', { class: 'hint' }, '');
  const insert = sym => {
    const c = viewCenter();
    const sh = makeSymbolShape(sym, c.x, c.y, size, App.state.activeLayer);
    App.doc.shapes.push(sh); setSel([sh]); App.commit('Symbol einfügen');
  };
  const draw = () => {
    grid.innerHTML = '';
    const ql = q.trim().toLowerCase();
    const all = [...SYMBOLS, ...UserSymbols.asSymbols()];
    const items = all.filter(s => (cat === 'all' || s.cat === cat) &&
      (!ql || loc(s.name).toLowerCase().includes(ql) || s.name.toLowerCase().includes(ql)));
    for (const s of items) {
      const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
      svg.setAttribute('viewBox', '-4 -4 108 108');
      const p = document.createElementNS('http://www.w3.org/2000/svg', 'path');
      p.setAttribute('d', symbolSVG(s)); p.setAttribute('fill-rule', 'evenodd');
      svg.appendChild(p);
      grid.appendChild(h('div', { class: 'symcard', title: s.user ? s.name : loc(s.name), onclick: () => insert(s) },
        svg, h('div', { class: 'sn' }, s.user ? s.name : loc(s.name)),
        s.user ? h('span', {
          class: 'del', title: loc('Löschen'),
          onclick: e => { e.stopPropagation(); UserSymbols.remove(s.sid).catch(err => toast(err.message, 'err')); }
        }, '✕') : null));
    }
    if (!items.length) grid.appendChild(h('small', { class: 'hint' }, loc('Keine Symbole gefunden.')));
    count.textContent = loc('{n} Symbole · Klick fügt ein', { n: items.length });
  };
  const cats = [{ v: 'all', t: loc('Alle Kategorien') }, ...SYMBOL_CATS.map(([v, t]) => ({ v, t: loc(t) })),
    ...(UserSymbols.available ? [{ v: 'user', t: loc('Eigene Symbole') }] : [])];
  // eigene Symbole brauchen einen Online-Speicher (Erweiterung); ohne ihn kann die Erweiterung z. B. die Anmeldung anbieten
  const saveBtn = (UserSymbols.available || Ext.hooks.needStore) && h('button', {
    class: 'tbtn', title: loc('Die ausgewählten Objekte als eigenes Symbol speichern'),
    onclick: async () => {
      if (!UserSymbols.available) return Ext.hooks.needStore('symbol');
      const polys = selPolys(sel());
      if (!polys.length) return toast(loc('Bitte zuerst geschlossene Formen auswählen'), 'err');
      const name = prompt(loc('Name des Symbols'), loc('Mein Symbol'));
      if (!name) return;
      UserSymbols.add(name, polys).then(() => {
        cat = 'user'; catSel.value = 'user'; draw();
        toast(loc('Symbol gespeichert'), 'ok');
      }, err => err.status === 402 && Ext.hooks.limit ? Ext.hooks.limit(err.message)
        : toast(loc('Symbol konnte nicht gespeichert werden: {msg}', { msg: err.message }), 'err'));
    }
  }, loc('＋ Auswahl als Symbol speichern'));
  const catSel = selectInput('all', cats, v => { cat = v; draw(); });
  const body = h('div', { class: 'flexbody' },
    h('input', { type: 'text', placeholder: loc('Symbol suchen …'), oninput: e => { q = e.target.value; draw(); }, onkeydown: e => e.stopPropagation() }),
    h('div', { class: 'grid2' }, field(loc('Kategorie'), catSel),
      field(loc('Größe mm'), numInput(size, 5, v => { size = Math.max(1, v); App.state.symbolSize = size; }))),
    count, grid, saveBtn);
  draw();
  // eigene Symbole kommen aus dem Online-Speicher; die Ansicht folgt jeder Änderung, solange das Fenster offen ist
  const off = UserSymbols.onChange(draw);
  UserSymbols.load().catch(err => toast(loc('Eigene Symbole konnten nicht geladen werden: {msg}', { msg: err.message }), 'err'));
  const dp = dockPanel(loc('Symbole'), body, [{ label: loc('Schließen'), primary: true }], off);
  dp.el.querySelector('.body').classList.add('flexbody');
}

/* Alle mitgelieferten Schriften auf einen Blick */
function fontOverviewDialog() {
  const t = sel().find(x => x.type === 'text');
  const txt = t ? String(t.text).split('\n')[0].slice(0, 22) : loc('Hallo Laser 123');
  const box = h('div', { class: 'fontgrid' });
  const info = h('small', { class: 'hint' }, '');
  let cat = 'all', q = '';
  const draw = () => {
    box.innerHTML = '';
    const ql = q.trim().toLowerCase();
    const items = FontStore.library.filter(f => (cat === 'all' || f.cat === cat) && (!ql || f.name.toLowerCase().includes(ql)));
    for (const f of items) box.appendChild(h('div', {
      class: 'fontcard', title: f.name + ' · ' + loc(FontStore.cats[f.cat] || f.cat) + ' · ' + f.lic,
      onclick: () => {
        const list = sel().filter(x => x.type === 'text');
        if (!list.length) return toast(loc('Kein Text ausgewählt – Schrift nicht zugewiesen'), 'err');
        for (const x of list) setFont(x, f.name);
        App.commit('Schrift');
        toast(loc('Schrift: {name}', { name: f.name }), 'ok');
      }
    },
      h('div', { class: 'fp', style: { fontFamily: `"${f.name}"` } }, txt),
      h('div', { class: 'fn' }, f.name)));
    info.textContent = loc('{n} Schriften · Klick weist die Schrift dem ausgewählten Text zu', { n: items.length });
  };
  draw();
  const head = h('div', { class: 'row', style: { marginBottom: '8px' } },
    h('input', { type: 'text', placeholder: loc('suchen …'), oninput: e => { q = e.target.value; draw(); }, onkeydown: e => e.stopPropagation() }),
    selectInput('all', [{ v: 'all', t: loc('Alle Kategorien') }, ...Object.entries(FontStore.cats).map(([v, tt]) => ({ v, t: loc(tt) }))], v => { cat = v; draw(); }));
  modal(loc('Schriftübersicht'), h('div', {}, head, info, box), [{ label: loc('Schließen'), primary: true }], { width: '900px' });
}

/* ============ Menüs ============ */
const MENUS = {
  file: [
    { t: loc('Neu'), k: 'Strg+N', a: Projects.newProject },
    { t: loc('Tab schließen'), a: Projects.closeTab },
    { t: loc('Meine Projekte'), a: () => Projects.toggle(true), hide: () => !Projects.hasStore },
    { t: loc('Projekt speichern'), k: 'Strg+S', a: () => Projects.save({ quiet: false }) },
    { t: loc('Speichern unter…'), k: 'Strg+Shift+S', a: Projects.saveAs, hide: () => !Projects.hasStore },
    { sep: 1 },
    { t: loc('Datei öffnen / importieren…'), k: 'Strg+O', a: openFiles },
    { t: loc('LightBurn-Projekt (.lbrn2) öffnen…'), a: openFiles },
    { t: loc('Projekt als Datei exportieren (.lsproj)'), a: exportProjectFile },
    { sep: 1 },
    { t: loc('SVG exportieren'), a: () => download(fileBase('zeichnung') + '.svg', exportSVG(App.doc, App.ctxGeo), 'image/svg+xml') },
    { t: loc('GCode speichern…'), k: 'Strg+E', a: () => exportGcode(false) },
    { t: loc('GCode anzeigen'), a: () => exportGcode(true) },
    { sep: 1 },
    { t: loc('Laser auswählen…'), a: deviceDialog },
    { t: loc('Geräte-Einstellungen…'), a: machineDialog },
    { sep: 1 },
    { t: loc('Gespeicherte Sitzung verwerfen'), a: () => { Session.clear(); toast(loc('Sitzungsspeicher gelöscht')); } }
  ],
  edit: [
    { t: loc('Rückgängig'), k: 'Strg+Z', a: () => { if (App.history.undo(App.doc)) { invalidateAll(); App.refresh(); } } },
    { t: loc('Wiederholen'), k: 'Strg+Y', a: () => { if (App.history.redo(App.doc)) { invalidateAll(); App.refresh(); } } },
    { t: loc('Verlauf…'), k: 'Strg+H', a: F.historyPanel },
    { sep: 1 },
    { t: loc('Ausschneiden'), k: 'Strg+X', a: cutSel },
    { t: loc('Kopieren'), k: 'Strg+C', a: copySel },
    { t: loc('Einfügen'), k: 'Strg+V', a: pasteClip },
    { t: loc('Duplizieren'), k: 'Strg+D', a: () => duplicateSel(5, -5) },
    { t: loc('Löschen'), k: 'Entf', a: deleteSel },
    { sep: 1 },
    { t: loc('Alles auswählen'), k: 'Strg+A', a: () => setSel(App.doc.shapes.filter(selectable)) },
    { t: loc('Auswahl aufheben'), k: 'Esc', a: () => setSel([]) },
    { t: loc('Auswahl umkehren'), a: () => setSel(App.doc.shapes.filter(s => selectable(s) && !App.state.selIds.has(s.id))) },
    { sep: 1 },
    { t: loc('Auswahl sperren'), k: 'Strg+L', a: lockSel },
    { t: loc('Alle entsperren'), k: 'Strg+Shift+L', a: unlockAll }
  ],
  arrange: [
    { t: loc('Gruppieren'), k: 'Strg+G', a: groupSel },
    { t: loc('Gruppierung aufheben'), k: 'Strg+U', a: ungroupSel },
    { sep: 1 },
    { t: loc('Links ausrichten'), a: () => alignSel('left') },
    { t: loc('Horizontal zentrieren'), a: () => alignSel('hcenter') },
    { t: loc('Rechts ausrichten'), a: () => alignSel('right') },
    { t: loc('Oben ausrichten'), a: () => alignSel('top') },
    { t: loc('Vertikal zentrieren'), a: () => alignSel('vcenter') },
    { t: loc('Unten ausrichten'), a: () => alignSel('bottom') },
    { t: loc('Auf Arbeitsfläche zentrieren'), a: () => alignSel('page') },
    { t: loc('Automatisch anordnen…'), a: F.nestDialog },
    { sep: 1 },
    { t: loc('Horizontal verteilen'), a: () => distributeSel('h') },
    { t: loc('Vertikal verteilen'), a: () => distributeSel('v') },
    { sep: 1 },
    { t: loc('Horizontal spiegeln'), a: () => flipSel('h') },
    { t: loc('Vertikal spiegeln'), a: () => flipSel('v') },
    { t: loc('Drehen +90°'), a: () => rotateSel(90) },
    { t: loc('Drehen −90°'), a: () => rotateSel(-90) },
    { sep: 1 },
    { t: loc('Nach vorn'), a: raiseSel },
    { t: loc('Nach hinten'), a: lowerSel }
  ],
  tools: [
    { t: loc('Formen kombinieren… (Live-Vorschau)'), a: () => boolDialog() },
    { t: loc('Vereinigen (Union)'), a: () => doBool('union') },
    { t: loc('Abziehen (Subtract)'), a: () => doBool('subtract') },
    { t: loc('Schnittmenge'), a: () => doBool('intersect') },
    { t: loc('Exklusiv (XOR)'), a: () => doBool('xor') },
    { sep: 1 },
    { t: loc('Offset / Kontur…'), a: offsetDialog },
    { t: loc('Array / Vervielfältigen…'), a: arrayDialog },
    { sep: 1 },
    { t: loc('Überlappungen verschmelzen (Weld)'), a: weldSel },
    { t: loc('In Pfad umwandeln'), a: convertToPath },
    { t: loc('Pfade trennen'), a: breakApart },
    { t: loc('Bild nachzeichnen… (Live-Vorschau)'), a: traceImageDialog },
    { t: loc('Bild in Graustufen umwandeln'), a: () => setImageMode('none') },
    { t: loc('Bild in Schwarz/Weiß (Schwelle)'), a: () => setImageMode('threshold') },
    { sep: 1 },
    { t: loc('Symbole…'), k: 'Strg+K', a: symbolPanel },
    { t: loc('Box-Generator…'), a: F.boxDialog },
    { t: loc('Flexscharnier…'), a: F.hingeDialog },
    { t: loc('QR-Code / Barcode…'), a: F.codeDialog },
    { t: loc('Text auf Pfad…'), a: F.textPathDialog },
    { t: loc('Serientext (Nummern, CSV)…'), a: F.serialDialog },
    { sep: 1 },
    { t: loc('Schriftübersicht…'), a: fontOverviewDialog },
    { t: loc('Schriftdatei laden (.ttf/.otf)…'), a: openFiles },
    { sep: 1 },
    { t: loc('Materialbibliothek…'), k: 'Strg+M', a: materialDialog },
    { t: loc('Materialtest erstellen…'), a: materialTestDialog },
    { t: loc('Zeilenabstand- / Fokustest…'), a: F.testPatternDialog }
  ],
  laser: [
    { t: loc('Vorschau…'), k: 'Alt+P', a: showPreview },
    { t: loc('Rahmen abfahren'), a: doFrame },
    { t: loc('Job starten'), a: startJob },
    { sep: 1 },
    { t: loc('Verbinden / Trennen'), a: async () => { const S = App.serial; if (S.connected) await S.disconnect(); else { try { await S.connect(App.doc.machine.baud); } catch (e) { toast(e.message, 'err'); } } buildLaser(); } },
    { t: loc('Konsole öffnen'), a: showConsole },
    { t: loc('Referenzfahrt ($H)'), a: () => App.serial.home() },
    { t: loc('Alarm lösen ($X)'), a: () => App.serial.unlock() },
    { t: loc('Nullpunkt hier setzen'), a: () => App.serial.zero() }
  ],
  view: [
    { t: loc('Meine Projekte'), c: () => Projects.isOpen, a: () => Projects.toggle(), hide: () => !Projects.hasStore },
    { sep: 1, hide: () => !Projects.hasStore },
    { t: loc('Alles einpassen'), k: '0', a: fitAll },
    { t: loc('Arbeitsfläche einpassen'), k: '1', a: fitBed },
    { t: loc('Vergrößern'), k: '+', a: () => { App.view.scale *= 1.2; App.draw(); } },
    { t: loc('Verkleinern'), k: '−', a: () => { App.view.scale /= 1.2; App.draw(); } },
    { sep: 1 },
    {
      t: loc('Gravur-Vorschau für Bilder'), c: () => App.state.imagePreview !== false,
      a: () => { App.state.imagePreview = !App.state.imagePreview; saveUI(); App.refresh(); }
    },
    {
      t: loc('Geschwindigkeit in mm/min'), c: () => speedUnit() === 'mm/min',
      a: () => { setSpeedUnit(speedUnit() === 'mm/min' ? 'mm/s' : 'mm/min'); App.refresh(); }
    },
    { t: loc('Füllung anzeigen'), c: () => App.state.showFill, a: () => { App.state.showFill = !App.state.showFill; saveUI(); App.draw(); } },
    { t: loc('Helles Design'), c: () => !App.state.dark, a: () => setTheme(!App.state.dark) },
    { t: loc('Raster anzeigen'), c: () => App.doc.settings.gridSize > 0, a: () => { App.doc.settings.gridSize = App.doc.settings.gridSize ? 0 : 10; App.draw(); } },
    { sep: 1 },
    { t: loc('Rechte Leiste zurücksetzen'), a: () => { $('#right').style.width = RIGHT_DEFAULT + 'px'; ui.rightWidth = RIGHT_DEFAULT; const pl = $('#pLayers'); pl.style.height = ''; pl.style.maxHeight = '38%'; ui.layersHeight = 0; const pz = $('#pLaser'); pz.style.height = ''; pz.style.flex = '0 1 auto'; pz.style.maxHeight = '45%'; ui.laserHeight = 0; saveUI(); App.draw(); } }
  ],
  help: [
    { t: loc('Einrichtung / Erste Schritte…'), a: () => showOnboarding(App) },
    { t: loc('Laser auswählen…'), a: deviceDialog },
    { sep: 1 },
    { t: loc('Tastenkürzel'), a: shortcutsDialog },
    { t: '🌐 ' + loc('Sprache') + (loc('Sprache') === 'Language' ? '' : ' / Language') + '…', a: languageDialog },
    { sep: 1 },
    { t: loc('Lizenzen…'), a: licensesDialog },
    { t: loc('Über BeamSketch'), a: aboutDialog }
  ]
};
function pasteClip() {
  if (!App.state.clipboard) return;
  const news = [];
  for (const c0 of App.state.clipboard) {
    const c = JSON.parse(JSON.stringify(c0));
    reid(c);
    c.transform = Mat.mul(c.transform, Mat.translate(5, -5));
    App.doc.shapes.push(c); news.push(c);
  }
  setSel(news); App.commit('Einfügen');
}
function fillMenu(drop, items) {
  drop.innerHTML = '';
  for (const it of items) {
    if (it.hide && it.hide()) continue;
    if (it.sep) { drop.appendChild(h('div', { class: 'sep' })); continue; }
    const checked = it.c ? it.c() : null;
    drop.appendChild(h('div', {
      class: 'item' + (it.dis ? ' dis' : ''), onclick: () => { closeMenus(); it.a(); }
    }, h('span', {}, (checked === null ? '' : (checked ? '✓ ' : '   ')) + it.t), it.k ? h('kbd', {}, keyName(it.k)) : null));
  }
}
function buildMenus() {
  // Einträge aus Erweiterungen kommen in die letzte Gruppe des Menüs (Hilfe: vor „Lizenzen")
  for (const [key, extra] of Object.entries(Ext.menus)) {
    const items = MENUS[key];
    if (!items) continue;
    let i = items.length;
    while (i > 0 && !items[i - 1].sep) i--;
    items.splice(i, 0, ...extra);
  }
  for (const [key, items] of Object.entries(MENUS)) {
    const menu = document.querySelector(`.menu[data-menu="${key}"]`);
    if (!menu) continue;
    const drop = menu.querySelector('.drop');
    fillMenu(drop, items);
    menu.querySelector('button').onclick = (e) => {
      const open = menu.classList.contains('open');
      closeMenus();
      if (!open) { fillMenu(drop, items); menu.classList.add('open'); }
      e.stopPropagation();
    };
    menu.onmouseenter = () => {
      if (document.querySelector('.menu.open')) { closeMenus(); fillMenu(drop, items); menu.classList.add('open'); }
    };
  }
  document.addEventListener('click', closeMenus);
}
/* ---- Kontextmenü (Rechtsklick auf die Zeichenfläche) ----
   Auf einem Objekt: Befehle für die Auswahl; auf gesperrten Objekten: Entsperren;
   auf leerer Fläche: Einfügen, Auswahl, Ansicht. */
function contextMenu(e) {
  closeMenus();
  if (pen || polyDraw) return;
  const w = evtWorld(e);
  const hit = hitTest(w, 0, true);
  let items;
  if (hit && hit.locked) {
    items = [
      { t: '🔓 ' + loc('Objekt entsperren'), a: () => unlockShape(hit) },
      { t: loc('Alle entsperren'), k: 'Strg+Shift+L', a: unlockAll }
    ];
  } else if (hit) {
    if (!App.state.selIds.has(hit.id)) setSel([hit]);
    const s = sel(), one = s.length === 1 ? s[0] : null;
    const L = App.doc.layers[hit.layer];
    items = [
      { t: loc('Ausschneiden'), k: 'Strg+X', a: cutSel },
      { t: loc('Kopieren'), k: 'Strg+C', a: copySel },
      { t: loc('Einfügen'), k: 'Strg+V', a: pasteClip, dis: !App.state.clipboard },
      { t: loc('Duplizieren'), k: 'Strg+D', a: () => duplicateSel(5, -5) },
      { t: loc('Löschen'), k: 'Entf', a: deleteSel },
      { sep: 1 },
      { t: loc('Gruppieren'), k: 'Strg+G', a: groupSel, dis: s.length < 2 },
      { t: loc('Gruppierung aufheben'), k: 'Strg+U', a: ungroupSel, dis: !s.some(x => x.type === 'group') },
      { t: loc('Nach vorn'), a: raiseSel },
      { t: loc('Nach hinten'), a: lowerSel },
      { sep: 1 },
      { t: loc('Horizontal spiegeln'), a: () => flipSel('h') },
      { t: loc('Vertikal spiegeln'), a: () => flipSel('v') },
      { t: loc('Drehen +90°'), a: () => rotateSel(90) },
      { t: loc('Drehen −90°'), a: () => rotateSel(-90) },
      { sep: 1 },
      { t: loc('In Pfad umwandeln'), a: convertToPath, dis: s.every(x => x.type === 'path' || x.type === 'group' || x.type === 'image') },
      { t: loc('Knoten bearbeiten'), a: () => App.setTool('node'), dis: !(one && one.type !== 'group' && one.type !== 'image') },
      { t: loc('Schnitteinstellungen') + ' (' + layerLabel(L) + ')…', a: () => cutSettingsDialog(App, L), dis: !L || L.isTool },
      { sep: 1 },
      { t: '🔒 ' + loc('Auswahl sperren'), k: 'Strg+L', a: lockSel }
    ];
  } else {
    items = [
      { t: loc('Einfügen'), k: 'Strg+V', a: pasteClip, dis: !App.state.clipboard },
      { t: loc('Alles auswählen'), k: 'Strg+A', a: () => setSel(App.doc.shapes.filter(selectable)) },
      { t: loc('Alle entsperren'), k: 'Strg+Shift+L', a: unlockAll, dis: !countLocked() },
      { sep: 1 },
      { t: loc('Alles einpassen'), k: '0', a: fitAll },
      { t: loc('Arbeitsfläche einpassen'), k: '1', a: fitBed }
    ];
  }
  const drop = h('div', { class: 'drop ctxmenu' });
  fillMenu(drop, items);
  document.body.appendChild(drop);
  // im Fenster halten
  const r = drop.getBoundingClientRect();
  drop.style.left = Math.max(4, Math.min(e.clientX, innerWidth - r.width - 4)) + 'px';
  drop.style.top = Math.max(4, Math.min(e.clientY, innerHeight - r.height - 4)) + 'px';
}
/* Tastennamen: „Strg" heißt in anderen Sprachen „Ctrl" usw. */
function keyName(k) { return k.replace(/Strg/g, loc('Strg')).replace(/^Entf$/, loc('Entf')); }
// kleines Menü an einer Bildschirmposition (z. B. „⋯" an einer Projektkachel)
App.popupMenu = (x, y, items) => {
  closeMenus();
  const drop = h('div', { class: 'drop ctxmenu' });
  fillMenu(drop, items);
  document.body.appendChild(drop);
  const r = drop.getBoundingClientRect();
  drop.style.left = Math.max(4, Math.min(x, innerWidth - r.width - 4)) + 'px';
  drop.style.top = Math.max(4, Math.min(y, innerHeight - r.height - 4)) + 'px';
};
function closeMenus() {
  document.querySelectorAll('.menu.open').forEach(m => m.classList.remove('open'));
  document.querySelectorAll('.ctxmenu').forEach(m => m.remove());
}
// Kontextmenü schließt bei jedem Klick daneben, beim Scrollen/Zoomen und mit Esc
window.addEventListener('pointerdown', e => { if (!e.target.closest || !e.target.closest('.ctxmenu')) document.querySelectorAll('.ctxmenu').forEach(m => m.remove()); }, true);
window.addEventListener('wheel', () => document.querySelectorAll('.ctxmenu').forEach(m => m.remove()), { passive: true });
window.addEventListener('blur', () => document.querySelectorAll('.ctxmenu').forEach(m => m.remove()));

/* Umschalter mm/s ↔ mm/min; die Werte bleiben intern in mm/s */
function speedUnitSelect(after) {
  return selectInput(speedUnit(), [{ v: 'mm/s', t: 'mm/s' }, { v: 'mm/min', t: 'mm/min' }],
    v => { setSpeedUnit(v); App.refresh(); if (after) after(); });
}

function languageDialog() {
  const s = langSelect(() => { clearTimeout(autosaveT); Session.save(App.doc, App.history); saveUI(); });
  modal(loc('Sprache'), h('div', {}, s, h('small', { class: 'hint' }, loc('Die Seite wird neu geladen, deine Zeichnung bleibt erhalten.'))),
    [{ label: loc('Schließen'), primary: true }], { width: '360px' });
}

// Quellcode des Editors (AGPL-3.0: wer BeamSketch über das Netz nutzt, bekommt den Quellcode)
const SOURCE_URL = 'https://github.com/FelixStopa/beamsketch';

// Über BeamSketch; Erweiterungen können Zeilen ergänzen (z. B. Stand des Servers)
async function aboutDialog() {
  let extra = [];
  try { if (Ext.hooks.about) extra = await Ext.hooks.about() || []; } catch (e) { /* ohne */ }
  modal(loc('Über'), h('div', {},
    h('p', {}, loc('BeamSketch – browserbasierter Laser-Editor mit GCode-Ausgabe für GRBL.')),
    h('p', { class: 'hint' }, loc('Deine Zeichnungen bleiben im Browser auf deinem Rechner, solange du sie nicht online speicherst.')),
    h('p', { class: 'hint' }, loc('Freie Software unter der GNU Affero General Public License 3.0.'), ' ',
      h('a', { href: SOURCE_URL, target: '_blank', rel: 'noopener' }, loc('Quellcode'))),
    ...extra),
  [{ label: loc('OK'), primary: true }]);
}

// Lizenzen der mitgelieferten Teile – die Lizenzen verlangen, dass die Hinweise mitgeliefert werden
async function licensesDialog() {
  const th = t => h('th', { style: { textAlign: 'left', padding: '4px 8px 4px 0', position: 'sticky', top: 0, background: 'var(--bg2)' } }, t);
  const td = (t, extra = {}) => h('td', { style: { padding: '3px 8px 3px 0', verticalAlign: 'top', ...extra } }, t);
  const fontRows = h('tbody', {});
  const fontsHead = h('h3', { style: { margin: '16px 0 6px' } }, loc('Schriften'));
  modal(loc('Lizenzen'), h('div', {},
    h('p', { style: { marginTop: 0 } }, loc('BeamSketch nutzt freie Software und freie Schriften. Herzlichen Dank an ihre Autorinnen und Autoren.')),
    h('h3', { style: { margin: '12px 0 6px' } }, loc('Programmbibliotheken')),
    h('p', { style: { margin: 0 } }, h('b', {}, 'opentype.js'), ' – MIT License – Copyright (c) 2020 Frederik De Bleser · ',
      h('a', { href: 'vendor/LICENSE-opentype.txt', target: '_blank' }, loc('Lizenztext'))),
    fontsHead,
    h('p', { style: { margin: '0 0 6px' } }, 'SIL Open Font License 1.1 (',
      h('a', { href: 'fonts/OFL.txt', target: '_blank' }, loc('Lizenztext')), ') · Apache License 2.0 (',
      h('a', { href: 'fonts/LICENSE-APACHE-2.0.txt', target: '_blank' }, loc('Lizenztext')), ') · ',
      h('a', { href: 'fonts/LICENSES.md', target: '_blank' }, 'LICENSES.md')),
    h('div', { style: { maxHeight: '46vh', overflow: 'auto', border: '1px solid var(--line)', borderRadius: '6px', padding: '0 8px' } },
      h('table', { style: { borderCollapse: 'collapse', fontSize: '12px', width: '100%' } },
        h('thead', {}, h('tr', {}, th(loc('Schrift')), th(loc('Lizenz')), th('Copyright'))), fontRows))),
  [{ label: loc('OK'), primary: true }], { width: '760px' });
  try {
    const md = await (await fetch('fonts/LICENSES.md')).text();
    let n = 0;
    for (const line of md.split('\n')) {
      const c = line.split('|').map(x => x.trim());
      if (c.length < 6 || !c[1] || c[1] === 'Schrift' || c[1].startsWith('---')) continue;
      fontRows.appendChild(h('tr', { style: { borderTop: '1px solid var(--line)' } }, td(c[1], { whiteSpace: 'nowrap' }), td(c[3], { whiteSpace: 'nowrap' }), td(c[4])));
      n++;
    }
    fontsHead.textContent = loc('Schriften ({n})', { n });
  } catch (e) { fontRows.appendChild(h('tr', {}, td(loc('Liste konnte nicht geladen werden.')))); }
}

function shortcutsDialog() {
  const rows = [
    ['V / N', 'Auswahl / Knoten bearbeiten'], ['R / E / P', 'Rechteck / Ellipse / Polygon'],
    ['L / B / T', 'Linienzug / Bezier / Text'], ['M', 'Messen'],
    ['Strg+Z / Y', 'Rückgängig / Wiederholen'], ['Strg+C/V/X/D', 'Kopieren / Einfügen / Ausschneiden / Duplizieren'],
    ['Strg+G / U', 'Gruppieren / Auflösen'], ['Entf', loc('Löschen')],
    ['Strg+L', 'Auswahl sperren'], ['Strg+Shift+L', 'Alle entsperren'],
    ['Doppelklick (gesperrt)', 'Objekt entsperren'], ['Rechtsklick', 'Kontextmenü'],
    ['Pfeiltasten', 'Verschieben (Shift = 10×)'], ['0 / 1', 'Alles / Arbeitsfläche einpassen'],
    ['Leertaste + Ziehen', 'Ansicht verschieben'], ['Mausrad', 'Zoom'],
    ['Shift beim Ziehen', 'Proportional / gerade'], ['Klick auf Auswahl', 'Dreh-Modus umschalten'],
    ['Doppelklick (Pfad)', 'Knoten einfügen'], ['Alt+Klick (Knoten)', 'Ecke/Kurve umschalten']
  ];
  modal(loc('Tastenkürzel'), h('div', { class: 'kv' }, rows.flatMap(r => [h('kbd', { style: { color: 'var(--acc)' } }, keyName(loc(r[0]))), h('span', {}, loc(r[1]))])), [{ label: loc('OK'), primary: true }]);
}

/* ============ Aktionsleiste & Werkzeugpalette ============ */
function buildToolbar() {
  const bar = $('#actionbar');
  bar.innerHTML = '';
  // eigene Symbole statt Schriftzeichen – eindeutig, keine doppelten; der Name steht im Tooltip
  const b = (ic, title, fn, on) => h('button', { class: 'tbtn ibtn' + (on ? ' on' : ''), title, 'aria-label': title, onclick: fn }, icon(ic, 18));
  bar.append(
    b('undo', loc('Rückgängig (Strg+Z)'), () => { if (App.history.undo(App.doc)) { invalidateAll(); App.refresh(); } }),
    b('redo', loc('Wiederholen (Strg+Y)'), () => { if (App.history.redo(App.doc)) { invalidateAll(); App.refresh(); } }),
    h('div', { class: 'sepv' }),
    b('fitall', loc('Alles einpassen (0)'), fitAll),
    b('fitbed', loc('Arbeitsfläche (1)'), fitBed),
    h('div', { class: 'sepv' }),
    b('union', loc('Vereinigen'), () => doBool('union')),
    b('subtract', loc('Abziehen'), () => doBool('subtract')),
    b('intersect', loc('Schnittmenge'), () => doBool('intersect')),
    b('boolassist', loc('Formen kombinieren… (Live-Vorschau)'), () => boolDialog()),
    b('offset', loc('Offset/Kontur'), offsetDialog),
    h('div', { class: 'sepv' }),
    b('alignleft', loc('Links ausrichten'), () => alignSel('left')),
    b('alignright', loc('Rechts ausrichten'), () => alignSel('right')),
    b('aligntop', loc('Oben'), () => alignSel('top')),
    b('alignbottom', loc('Unten'), () => alignSel('bottom')),
    b('centerbed', loc('Zentrieren (Arbeitsfläche)'), () => alignSel('page')),
    h('div', { class: 'sepv' }),
    b('group', loc('Gruppieren'), groupSel),
    b('array', loc('Array'), arrayDialog),
    h('div', { class: 'sepv' }),
    b('material', loc('Materialbibliothek'), materialDialog),
    h('div', { class: 'sepv' }),
    b('preview', loc('Vorschau'), showPreview),
    b('frame', loc('Rahmen'), doFrame),
    b('gcode', loc('GCode'), () => exportGcode(true)),
    h('div', { class: 'sepv' }),
    h('span', { class: 'tag' }, loc('Werkzeug bleibt aktiv')),
    (() => { const c = h('input', { type: 'checkbox', style: { width: 'auto' }, checked: !!App.state.stickyTool, onchange: () => App.state.stickyTool = c.checked }); return c; })()
  );
}
const TOOLDEFS = () => [
  { id: 'select', ic: icon('select'), t: loc('Auswahl (V)') },
  { id: 'node', ic: icon('node'), t: loc('Knoten bearbeiten (N)') },
  { gap: 1 },
  { id: 'rect', ic: icon('rect'), t: loc('Rechteck (R)') },
  { id: 'ellipse', ic: icon('ellipse'), t: loc('Ellipse (E)') },
  { id: 'polygon', ic: icon('polygon'), t: loc('Polygon / Stern (P)') },
  { id: 'line', ic: icon('line'), t: loc('Linienzug (L) – Doppelklick beendet') },
  { id: 'pen', ic: icon('pen'), t: loc('Bezier-Stift (B) – ziehen für Kurven') },
  { id: 'text', ic: icon('text'), t: loc('Text (T)') },
  { gap: 1 },
  { id: 'measure', ic: icon('measure'), t: loc('Messen (M)') },
  // Werkzeuge aus Erweiterungen (ext.js)
  ...(Ext.tools.length ? [{ gap: 1 }, ...Ext.tools] : [])
];
function buildTools() {
  const el = $('#tools');
  el.innerHTML = '';
  for (const t of TOOLDEFS()) {
    if (t.gap) { el.appendChild(h('div', { class: 'gap' })); continue; }
    el.appendChild(h('button', {
      class: App.state.tool === t.id ? 'on' : '', title: t.t,
      onclick: () => App.setTool(t.id)
    }, t.ic));
  }
  el.appendChild(h('div', { class: 'gap' }));
  el.appendChild(h('button', { title: loc('Symbole (Strg+K)'), onclick: symbolPanel }, icon('symbols')));
  el.appendChild(h('button', { class: 'imp', title: loc('Bild/Datei importieren'), onclick: openFiles }, icon('import')));
}

/* ============ Layout: Breiten/Höhen der Leiste, gespeicherte UI-Einstellungen ============ */
/* Standardbreite der rechten Leiste – so breit, dass die Ebenen-Tabelle in allen
   Sprachen ohne Querscrollen passt (Französisch braucht am meisten, ~423 px). */
const RIGHT_DEFAULT = 440;
const RIGHT_OLD_DEFAULT = 330;   // frühere Standardbreite: gespeichert heißt „nie selbst verändert"
/* Beim allerersten Start dem Betriebssystem folgen (hell/dunkel) */
const systemDark = !(window.matchMedia && matchMedia('(prefers-color-scheme: light)').matches);
const UI_DEFAULT = { rightWidth: RIGHT_DEFAULT, layersHeight: 0, laserHeight: 0, imagePreview: true, dark: systemDark, showFill: true, collapsed: [] };
let ui = { ...UI_DEFAULT };

function saveUI() {
  const r = $('#right');
  if (r && r.clientWidth > 100) ui.rightWidth = r.clientWidth;
  ui.imagePreview = App.state.imagePreview !== false;
  ui.dark = App.state.dark;
  ui.showFill = App.state.showFill;
  Session.saveUI(ui);
}
App.saveUI = saveUI;

function applyUI() {
  const right = $('#right');
  if (!ui.rightWidth || ui.rightWidth === RIGHT_OLD_DEFAULT) ui.rightWidth = RIGHT_DEFAULT;
  right.style.width = Math.max(240, Math.min(900, ui.rightWidth)) + 'px';
  const pl = $('#pLayers');
  if (ui.layersHeight > 0) { pl.style.height = Math.max(64, ui.layersHeight) + 'px'; pl.style.maxHeight = 'none'; }
  const pz = $('#pLaser');
  if (ui.laserHeight > 0) { pz.style.height = Math.max(64, ui.laserHeight) + 'px'; pz.style.maxHeight = 'none'; }
  App.state.imagePreview = ui.imagePreview !== false;
  App.state.dark = ui.dark !== false;
  applyTheme();
  App.state.showFill = ui.showFill !== false;
  for (const id of ui.collapsed || []) { const p = document.getElementById(id); if (p) p.classList.add('collapsed'); }
}

/* Hell/Dunkel: färbt die ganze Oberfläche (CSS-Variablen über body.light) und die Zeichenfläche */
function applyTheme() {
  document.body.classList.toggle('light', !App.state.dark);
  const b = $('#themeBtn');
  if (b) { b.textContent = App.state.dark ? '☀' : '☾'; b.title = loc('Hell / Dunkel umschalten'); }
}
function setTheme(dark) {
  App.state.dark = dark;
  applyTheme(); saveUI(); App.draw();
}

function setupSplitters() {
  const right = $('#right'), vs = $('#vsplit'), main = $('#main');
  // Breite der rechten Leiste
  vs.addEventListener('pointerdown', e => {
    e.preventDefault();
    vs.setPointerCapture(e.pointerId);
    vs.classList.add('drag'); document.body.classList.add('resizing');
    const move = ev => {
      const w = Math.max(240, Math.min(main.clientWidth - 260, main.getBoundingClientRect().right - ev.clientX));
      right.style.width = w + 'px';
      ui.rightWidth = Math.round(w);
      App.draw();
    };
    const up = ev => {
      vs.releasePointerCapture(e.pointerId);
      vs.removeEventListener('pointermove', move); vs.removeEventListener('pointerup', up);
      vs.classList.remove('drag'); document.body.classList.remove('resizing');
      saveUI(); App.draw();
    };
    vs.addEventListener('pointermove', move); vs.addEventListener('pointerup', up);
  });
  vs.addEventListener('dblclick', () => { right.style.width = RIGHT_DEFAULT + 'px'; ui.rightWidth = RIGHT_DEFAULT; saveUI(); App.draw(); });

  // Höhe der Ebenenliste (Teiler darunter) und des Laser-Bereichs (Teiler darüber)
  const pl = $('#pLayers'), pz = $('#pLaser');
  hSplitter($('#hsplitLayers'), pl, ev => ev.clientY - pl.getBoundingClientRect().top, h => { ui.layersHeight = h; });
  hSplitter($('#hsplitLaser'), pz, ev => pz.getBoundingClientRect().bottom - ev.clientY, h => { ui.laserHeight = h; });
}
// Waagrechter Teiler: setzt die Höhe von panel. Wachsen darf es nur so weit, wie die
// Eigenschaften (bzw. das Seitenfenster) bis zu ihrer Mindesthöhe schrumpfen können.
function hSplitter(hs, panel, heightAt, store) {
  hs.addEventListener('pointerdown', e => {
    e.preventDefault();
    hs.setPointerCapture(e.pointerId);
    hs.classList.add('drag'); document.body.classList.add('resizing-v');
    panel.classList.remove('collapsed');
    // bei offenem Seitenfenster (Eigenschaften ausgeblendet) nimmt es deren Platz ein
    const props = $('#pProps').offsetParent ? $('#pProps') : ($('#right > .panel.dock') || $('#pProps'));
    const max = panel.offsetHeight + Math.max(0, props.offsetHeight - parseFloat(getComputedStyle(props).minHeight));
    const move = ev => {
      const hgt = Math.max(64, Math.min(max, heightAt(ev)));
      panel.style.height = hgt + 'px'; panel.style.flex = '0 1 auto'; panel.style.maxHeight = 'none';
      store(Math.round(hgt));
    };
    const up = () => {
      hs.releasePointerCapture(e.pointerId);
      hs.removeEventListener('pointermove', move); hs.removeEventListener('pointerup', up);
      hs.classList.remove('drag'); document.body.classList.remove('resizing-v');
      ui.collapsed = [...document.querySelectorAll('#right > .panel.collapsed')].map(p => p.id).filter(Boolean);
      saveUI();
    };
    hs.addEventListener('pointermove', move); hs.addEventListener('pointerup', up);
  });
}

/* ============ Ansicht ============ */
function fitBed() {
  App.view.fit({ x0: 0, y0: 0, x1: App.doc.machine.width, y1: App.doc.machine.height }, cv.clientWidth, cv.clientHeight);
  App.draw();
}
App.fitBed = fitBed;
App.fitAll = () => fitAll();
function fitAll() {
  // Hilfsebenen enthalten oft Hilfslinien mit riesigen Ausmaßen
  const list = App.doc.shapes.filter(sh => {
    const L = App.doc.layers[sh.layer];
    return !(L && L.isTool);
  });
  const b = shapesBBox(list.length ? list : App.doc.shapes, App.ctxGeo);
  if (!boxValid(b)) return fitBed();
  App.view.fit(b, cv.clientWidth, cv.clientHeight, 60);
  App.draw();
}

/* ============ Tastatur ============ */
window.addEventListener('keydown', e => {
  const tgt = e.target;
  if (tgt && (tgt.tagName === 'INPUT' || tgt.tagName === 'TEXTAREA' || tgt.tagName === 'SELECT')) return;
  const ctrl = e.ctrlKey || e.metaKey;
  const K = e.key.toLowerCase();
  if (e.code === 'Space') { spaceDown = true; cv.style.cursor = 'grab'; e.preventDefault(); return; }
  if (ctrl) {
    const map = {
      z: () => { if (e.shiftKey) { if (App.history.redo(App.doc)) { invalidateAll(); App.refresh(); } } else if (App.history.undo(App.doc)) { invalidateAll(); App.refresh(); } },
      y: () => { if (App.history.redo(App.doc)) { invalidateAll(); App.refresh(); } },
      a: () => setSel(App.doc.shapes.filter(selectable)),
      c: copySel,
      v: pasteClip,
      x: cutSel,
      d: () => duplicateSel(5, -5),
      g: groupSel, u: ungroupSel,
      l: () => { if (e.shiftKey) unlockAll(); else lockSel(); },
      s: () => e.shiftKey ? Projects.saveAs() : Projects.save({ quiet: false }), o: openFiles, e: () => exportGcode(false), m: materialDialog, k: symbolPanel, h: F.historyPanel,
      n: Projects.newProject
    };
    if (map[K]) { e.preventDefault(); map[K](); }
    return;
  }
  switch (e.key) {
    case 'Delete': case 'Backspace': e.preventDefault(); deleteSel(); break;
    case 'Escape':
      if (document.querySelector('.ctxmenu')) { closeMenus(); break; }
      if (hasDock()) { closeDock(); break; }
      if (pen) finishPen(false); else if (polyDraw) finishPoly(false);
      else if (App.state.tool !== 'select') App.setTool('select');
      else setSel([]);
      break;
    case 'Enter': if (pen) finishPen(false); if (polyDraw) finishPoly(false); break;
    case 'ArrowLeft': case 'ArrowRight': case 'ArrowUp': case 'ArrowDown': {
      if (!sel().length) return;
      e.preventDefault();
      const d = e.shiftKey ? 10 : (App.state.snapGrid ? App.doc.settings.gridSize : 1);
      const dx = e.key === 'ArrowLeft' ? -d : e.key === 'ArrowRight' ? d : 0;
      const dy = e.key === 'ArrowDown' ? -d : e.key === 'ArrowUp' ? d : 0;
      applyToSel(Mat.translate(dx, dy));
      App.commit('Verschieben');
      break;
    }
    case '0': fitAll(); break;
    case '1': fitBed(); break;
    case '+': case '=': App.view.scale *= 1.2; App.draw(); break;
    case '-': App.view.scale /= 1.2; App.draw(); break;
    default: {
      const tk = { v: 'select', n: 'node', r: 'rect', e: 'ellipse', p: 'polygon', l: 'line', b: 'pen', t: 'text', m: 'measure' };
      if (tk[K]) App.setTool(tk[K]);
    }
  }
});
window.addEventListener('keyup', e => {
  if (e.code === 'Space') { spaceDown = false; cv.style.cursor = App.state.tool === 'select' ? 'default' : 'crosshair'; }
});

/* Drag & Drop */
document.addEventListener('dragover', e => { e.preventDefault(); });
document.addEventListener('drop', async e => {
  e.preventDefault();
  for (const f of e.dataTransfer.files) await importFile(f);
});

/* ============ Start ============ */
// Handy: kein Editor (reiner Touch-Bildschirm, kurze Seite < 600 px) – nur ein Hinweis
function isPhone() {
  const touchOnly = matchMedia('(pointer: coarse)').matches && !matchMedia('(any-pointer: fine)').matches;
  return touchOnly && Math.min(screen.width, screen.height) < 600;
}
function phoneGate() {
  $('#app').style.display = 'none';
  const link = location.href;
  document.body.appendChild(h('div', { id: 'phoneGate' },
    h('div', { class: 'card' },
      h('div', { class: 'brand' }, $('#menubar .brand').cloneNode(true).childNodes[0], 'BeamSketch'),
      h('h1', {}, loc('Bitte am Computer öffnen')),
      h('p', {}, loc('BeamSketch ist ein Zeichenprogramm für große Bildschirme mit Maus oder Trackpad – auf dem Handy ist dafür zu wenig Platz. Öffne {url} am Computer oder Tablet.', { url: location.host })),
      h('p', { class: 'muted' }, loc('Zum Senden an den Laser per USB brauchst du Chrome oder Edge am Computer.')),
      navigator.share && h('div', { class: 'btns' },
        h('button', { onclick: () => navigator.share({ title: 'BeamSketch', url: link }).catch(() => { }) }, loc('Link an mich senden'))))));
}
// vor der ersten USB-Verbindung zum Laser: Sicherheitshinweise bestätigen
function guardSerial() {
  const S = App.serial, connect = S.connect.bind(S);
  S.connect = async (...a) => {
    if (!await confirmSafety()) throw new Error(loc('Abgebrochen'));
    return connect(...a);
  };
}

async function init() {
  translateDOM();
  // Sprachwahl in der Menüleiste; vor dem Neuladen die Sitzung sichern
  langSelect(() => { clearTimeout(autosaveT); Session.save(App.doc, App.history); saveUI(); }, $('#langSel'));
  // Panels ein-/ausklappbar machen
  document.querySelectorAll('#right > .panel > h3').forEach(hd => {
    hd.addEventListener('click', e => {
      if (e.target.closest('.tools')) return;
      hd.parentElement.classList.toggle('collapsed');
      ui.collapsed = [...document.querySelectorAll('#right > .panel.collapsed')].map(p => p.id).filter(Boolean);
      saveUI();
      App.draw();
    });
  });
  ui = { ...UI_DEFAULT, ...Session.loadUI() };
  applyUI();
  // Erweiterungen (Konto, Online-Speicher, KI …) vor dem Aufbau der Oberfläche
  await loadExtensions(App, extHelpers);
  for (const x of Ext.tools) tools[x.id] = x.tool;
  // Handy: nur Hinweis – nach applyUI, damit das gewählte Design (hell/dunkel) gilt
  if (isPhone()) return Ext.hooks.phone ? Ext.hooks.phone() : phoneGate();
  $('#themeBtn').onclick = () => setTheme(!App.state.dark);
  setupSplitters();
  guardSerial();
  for (const fn of Ext.start) if (await fn(App) === false) return;
  UserSymbols.load().catch(() => { });   // eigene Symbole vorab laden (übernimmt alte aus dem Browser)
  const nFonts = await loadFontLibrary();
  buildMenus();
  buildTools();
  buildToolbar();
  buildPalette(App);
  const savedMachine = Session.loadMachine();
  layerDefaults(App.doc);
  // gespeicherte Maschinen-/Sitzungsdaten wiederherstellen
  if (savedMachine) App.doc.machine = { ...App.doc.machine, ...savedMachine };
  const sess = Session.load();
  if (sess && sess.shapes && sess.shapes.length) {
    App.doc.shapes = sess.shapes;
    if (sess.layers) App.doc.layers = D.migrateLayers(sess.layers);
    if (sess.settings) App.doc.settings = { ...App.doc.settings, ...sess.settings };
    invalidateAll();
    toast(loc('Letzte Sitzung wiederhergestellt ({date})', { date: new Date(sess.t).toLocaleString(locale) }), 'ok');
  }
  // Schriften der wiederhergestellten Texte nachladen
  preloadUsedFonts(App.doc.shapes).then(n => { if (n) { invalidateAll(); App.draw(); } });
  setBadge();
  App.history.push(App.doc, 'Start');
  Projects.init(App);   // Tabs der letzten Sitzung; übernimmt App.doc in den aktiven Tab
  App.refresh();
  if (nFonts) toast(loc('{n} Schriften verfügbar (Werkzeuge → Schriftübersicht)', { n: nFonts }), 'ok');
  if (!wasOnboarded()) setTimeout(() => showOnboarding(App), 400);
  let firstFit = false;
  new ResizeObserver(() => {
    if (!firstFit && cv.clientHeight > 100) { firstFit = true; fitBed(); return; }
    App.draw();
  }).observe(cv);
  requestAnimationFrame(() => { if (!firstFit && cv.clientHeight > 100) { firstFit = true; fitBed(); } });
  window.addEventListener('resize', () => App.draw());
}
init();
