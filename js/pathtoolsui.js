// pathtoolsui.js — Dialoge und Befehle der Pfad-Werkzeuge (Geometrie in pathtools.js)
import { h, modal, field, numInput, selectInput, checkbox, slider, toast } from './ui.js';
import { loc } from './i18n.js';
import { Shape, nodeSub, shapePolys, shapesBBox } from './doc.js';
import { warpPolys, cornerSubpath, closeSubpaths, joinSubpaths, reverseSubpath, setStart, trimPolyline } from './pathtools.js';
import { bakePath } from './joints.js';

const App = () => window.App;
const editable = s => ['path', 'rect', 'polygon', 'ellipse'].includes(s.type);
const sel = () => App().state.selection.filter(s => !s.locked);

/* gestrichelte Vorschau der Polylinien auf der Arbeitsfläche */
function previewOverlay(getPolys) {
  const A = App();
  const fn = (g, px) => {
    const polys = getPolys();
    if (!polys) return;
    g.strokeStyle = '#f59e0b'; g.lineWidth = 1.6 * px; g.setLineDash([4 * px, 3 * px]);
    for (const p of polys) { g.beginPath(); p.pts.forEach((q, i) => i ? g.lineTo(q.x, q.y) : g.moveTo(q.x, q.y)); if (p.closed) g.closePath(); g.stroke(); }
    g.setLineDash([]);
  };
  A.state.aux = (A.state.aux || []).concat([fn]);
  A.draw();
  return () => { A.state.aux = (A.state.aux || []).filter(f => f !== fn); A.draw(); };
}
// Dialog-Ende (auch ✕ / Esc) erkennen
const onClose = (m, fn) => new MutationObserver((_, obs) => { if (!m.el.isConnected) { obs.disconnect(); fn(); } }).observe(document.body, { childList: true });

/* ---------------- Verzerren ---------------- */
export function warpDialog() {
  const A = App(), list = sel().filter(s => s.type !== 'image');
  if (!list.length) return toast(loc('Bitte Formen oder Texte auswählen'), 'err');
  const cfg = Object.assign({ mode: 'arc', amount: 40, rot90: false }, A.state.warpCfg || {});
  const box = shapesBBox(list, A.ctxGeo);
  const src = list.map(s => shapePolys(s, A.ctxGeo).map(p => ({ pts: p.pts, closed: p.closed })));
  const result = () => src.map(ps => warpPolys(ps, box, cfg.mode, cfg.amount, cfg.rot90));
  let cache = result();
  const stop = previewOverlay(() => cache.flat());
  const upd = () => { cache = result(); A.draw(); };
  const body = h('div', {},
    h('div', { class: 'grid2' },
      field(loc('Art'), selectInput(cfg.mode, [
        { v: 'arc', t: loc('Bogen') }, { v: 'arcUpper', t: loc('Bogen oben') }, { v: 'arcLower', t: loc('Bogen unten') },
        { v: 'bulge', t: loc('Wölbung') }, { v: 'flag', t: loc('Fahne') }, { v: 'perspective', t: loc('Perspektive') }], v => { cfg.mode = v; upd(); })),
      checkbox(cfg.rot90, v => { cfg.rot90 = v; upd(); }, loc('um 90° gedreht'))),
    slider(loc('Stärke %'), cfg.amount, -100, 100, 1, v => { cfg.amount = v; upd(); }),
    h('small', { class: 'hint' }, loc('Formen und Texte werden über den Rahmen der Auswahl verbogen und dabei zu Pfaden. Bilder bleiben unverändert.')));
  const m = modal(loc('Verzerren'), body, [{ label: loc('Abbrechen') }, {
    label: loc('Anwenden'), primary: true, click: () => {
      A.state.warpCfg = { ...cfg };
      const news = list.map((s, i) => {
        const p = Shape.path(cache[i].map(pl => nodeSub(pl.pts, pl.closed)), s.layer);
        p.name = s.name; return p;
      });
      A.doc.shapes = A.doc.shapes.flatMap(s => { const i = list.indexOf(s); return i >= 0 ? [news[i]] : [s]; });
      A.setSel(news); A.commit(loc('Verzerren'));
    }
  }], { width: '480px' });
  onClose(m, stop);
}

/* ---------------- Ecken abrunden / fasen ---------------- */
export function cornersDialog() {
  const A = App();
  const nodeSel = A.state.tool === 'node' ? A.state.nodeSel || [] : [];
  const list = sel().filter(editable);
  if (!list.length) return toast(loc('Bitte Formen mit Ecken auswählen'), 'err');
  const cfg = Object.assign({ r: 3, mode: 'round' }, A.state.cornerCfg || {});
  const info = h('small', { class: 'hint' });
  // nur die im Knoten-Editor gewählten Knoten, sonst alle Ecken
  const which = (sh, si) => {
    const ns = nodeSel.filter(n => n.sh === sh && sh.subpaths[si] === n.sp);
    return ns.length ? new Set(ns.map(n => n.ni)) : null;
  };
  let res = [];
  const compute = () => {
    let n = 0;
    res = list.map(s => {
      const p = bakePath(s, A.ctxGeo);
      p.subpaths.forEach((sp, si) => { n += cornerSubpath(sp, cfg.r, cfg.mode, s.type === 'path' ? which(s, si) : null); });
      p.layer = s.layer; return p;
    });
    info.textContent = loc('{n} Ecken', { n });
    A.draw();
  };
  const stop = previewOverlay(() => res.flatMap(p => shapePolys(p, A.ctxGeo)));
  const body = h('div', {},
    h('div', { class: 'grid2' },
      field(loc('Art'), selectInput(cfg.mode, [{ v: 'round', t: loc('abrunden') }, { v: 'chamfer', t: loc('fasen') }, { v: 'inward', t: loc('nach innen runden') }], v => { cfg.mode = v; compute(); })),
      field(cfg.mode === 'chamfer' ? loc('Abstand mm') : loc('Radius mm'), numInput(cfg.r, 0.5, v => { cfg.r = Math.max(0.01, v); compute(); }))),
    info,
    h('small', { class: 'hint' }, nodeSel.length ? loc('Nur die im Knoten-Editor gewählten Ecken werden bearbeitet.') : loc('Alle Ecken zwischen zwei geraden Kanten werden bearbeitet. Im Knoten-Editor lassen sich einzelne Ecken wählen. Zu kurze Kanten verkleinern den Radius.')));
  compute();
  const m = modal(loc('Ecken abrunden / fasen'), body, [{ label: loc('Abbrechen') }, {
    label: loc('Anwenden'), primary: true, click: () => {
      A.state.cornerCfg = { ...cfg };
      A.doc.shapes = A.doc.shapes.map(s => { const i = list.indexOf(s); return i >= 0 ? res[i] : s; });
      A.setSel(res); A.commit(loc('Ecken'));
    }
  }], { width: '440px' });
  onClose(m, stop);
}

/* ---------------- Offene Pfade schließen ---------------- */
export function closeDialog() {
  const A = App();
  const list = (sel().length ? sel() : A.doc.shapes).filter(s => s.type === 'path' && !s.locked);
  const openCount = tol => list.reduce((n, s) => n + s.subpaths.filter(sp => !sp.closed && sp.nodes.length >= 3 && Math.hypot(sp.nodes[0].x - sp.nodes[sp.nodes.length - 1].x, sp.nodes[0].y - sp.nodes[sp.nodes.length - 1].y) * Math.hypot(s.transform[0], s.transform[1]) <= tol).length, 0);
  const cfg = Object.assign({ tol: 0.5, how: 'line' }, A.state.closeCfg || {});
  const info = h('small', { class: 'hint' });
  const upd = () => { info.textContent = loc('{n} offene Pfade werden geschlossen', { n: openCount(cfg.tol) }); };
  const body = h('div', {},
    slider(loc('Toleranz mm'), cfg.tol, 0.01, 20, 0.01, v => { cfg.tol = v; upd(); }),
    field(loc('Art'), selectInput(cfg.how, [{ v: 'line', t: loc('Linie einfügen') }, { v: 'pull', t: loc('Enden zusammenziehen') }], v => { cfg.how = v; })),
    info);
  upd();
  modal(loc('Pfade schließen'), body, [{ label: loc('Abbrechen') }, {
    label: loc('Schließen'), primary: true, click: () => {
      A.state.closeCfg = { ...cfg };
      let n = 0;
      for (const s of list) n += closeSubpaths(s.subpaths, cfg.tol / Math.hypot(s.transform[0], s.transform[1]), cfg.how);
      A.commit(loc('Pfade schließen'));
      toast(loc('{n} Pfade geschlossen', { n }), 'ok');
    }
  }], { width: '440px' });
}

/* ---------------- Verbinden / Umkehren / Startpunkt ---------------- */
export function joinSel() {
  const A = App(), list = sel().filter(editable);
  if (!list.length) return toast(loc('Bitte Pfade auswählen'), 'err');
  const subs = list.flatMap(s => bakePath(s, A.ctxGeo).subpaths);
  const r = joinSubpaths(subs, 0.05);
  const p = Shape.path(r.subpaths, list[0].layer);
  A.doc.shapes = A.doc.shapes.filter(s => !list.includes(s)).concat([p]);
  A.setSel([p]); A.commit(loc('Pfade verbinden'));
  toast(loc('{n} Verbindungen', { n: r.joined }), r.joined ? 'ok' : 'err');
}
export function reverseSel() {
  const A = App(), list = sel().filter(editable);
  if (!list.length) return toast(loc('Bitte Pfade auswählen'), 'err');
  const news = list.map(s => { const p = bakePath(s, A.ctxGeo); p.subpaths.forEach(reverseSubpath); p.layer = s.layer; return p; });
  A.doc.shapes = A.doc.shapes.map(s => { const i = list.indexOf(s); return i >= 0 ? news[i] : s; });
  A.setSel(news); A.commit(loc('Richtung umkehren'));
}
export function setStartFromNode() {
  const A = App(), ns = (A.state.nodeSel || [])[0];
  if (A.state.tool !== 'node' || !ns) return toast(loc('Im Knoten-Editor einen Knoten auf einer geschlossenen Kontur wählen'), 'err');
  if (!setStart(ns.sp, ns.ni)) return toast(loc('Der Startpunkt lässt sich nur auf geschlossenen Konturen setzen'), 'err');
  A.state.nodeSel = [];
  A.commit(loc('Startpunkt setzen'));
  toast(loc('Startpunkt gesetzt – der Schnitt beginnt an diesem Knoten'), 'ok');
}

/* ---------------- Trimmen ----------------
   Unter dem Mauszeiger: Stück einer Form zwischen den nächsten Schnittpunkten; Klick entfernt es. */
export function trimAt(w, tolMm) {
  const A = App();
  const shapes = A.doc.shapes.filter(s => !s.hidden && !s.locked && s.type !== 'image' && s.type !== 'group' && !(A.doc.layers[s.layer] || {}).isTool);
  const all = shapes.flatMap(s => shapePolys(s, A.ctxGeo).map((p, k) => ({ ...p, owner: s, k })));
  let best = null, bd = tolMm;
  for (const p of all) {
    const pts = p.closed ? p.pts.concat([p.pts[0]]) : p.pts;
    for (let i = 1; i < pts.length; i++) {
      const a = pts[i - 1], b = pts[i], dx = b.x - a.x, dy = b.y - a.y, l2 = dx * dx + dy * dy;
      const t = l2 ? Math.max(0, Math.min(1, ((w.x - a.x) * dx + (w.y - a.y) * dy) / l2)) : 0;
      const d = Math.hypot(w.x - a.x - dx * t, w.y - a.y - dy * t);
      if (d < bd) { bd = d; best = p; }
    }
  }
  if (!best) return null;
  return { target: best, ...trimPolyline(best, all, w) };
}
export function applyTrim(hit) {
  const A = App(), s = hit.target.owner;
  const polys = shapePolys(s, A.ctxGeo);
  const subs = [];
  for (const [k, p] of polys.entries()) {
    if (k === hit.target.k) for (const pc of hit.pieces) subs.push(nodeSub(pc, false));
    else subs.push(nodeSub(p.pts, p.closed));
  }
  const i = A.doc.shapes.indexOf(s);
  if (i < 0) return;
  if (!subs.length) A.doc.shapes.splice(i, 1);
  else { const p = Shape.path(subs, s.layer); p.name = s.name; A.doc.shapes[i] = p; }
  A.commit(loc('Trimmen'));
}
