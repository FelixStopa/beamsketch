// jig.js — Vorrichtung (Jig) für Serien: Eine Platte mit Taschen wird ausgeschnitten und fest auf das Bett gelegt;
// in jede Tasche kommt ein Werkstück (Anhänger, Untersetzer, Feuerzeug …) und das Motiv wird in allen
// Taschen auf einmal graviert. Die Taschen landen auf einer eigenen Seite, die Motiv-Kopien auf der aktuellen.
import { h, modal, field, numInput, selectInput, checkbox, toast, fmtNum } from './ui.js';
import { loc } from './i18n.js';
import { Shape, nodeSub, shapesBBox, shapePolys, uid, walk } from './doc.js';
import { Mat, offsetPolys, polyArea } from './geom.js';
import { pageList, pageIndex } from './pages.js';

const App = () => window.App;

/* Raster der Taschen. Werkstück w×h, Spiel clearance, Abstand gap, Rand margin, Platte ab (x0, y0). */
export function jigLayout(c) {
  const pw = c.w + 2 * c.clearance, ph = c.h + 2 * c.clearance;
  const slots = [];
  for (let r = 0; r < c.rows; r++) for (let k = 0; k < c.cols; k++)
    slots.push({ x: c.x0 + c.margin + pw / 2 + k * (pw + c.gap), y: c.y0 + c.margin + ph / 2 + r * (ph + c.gap) });
  const board = { x: c.x0, y: c.y0, w: 2 * c.margin + c.cols * pw + (c.cols - 1) * c.gap, h: 2 * c.margin + c.rows * ph + (c.rows - 1) * c.gap };
  return { slots, board, pw, ph };
}

const clone = list => { const c = JSON.parse(JSON.stringify(list)); walk(c, x => { x.id = uid(); }); return c; };

/* Taschenform um den Ursprung: Rechteck, Ellipse oder Umriss der Auswahl (+ Spiel) */
function pocketShape(cfg, L, outline, at, layer) {
  if (cfg.form === 'ellipse') return Shape.ellipse(at.x, at.y, L.pw / 2, L.ph / 2, layer);
  if (cfg.form === 'outline' && outline) {
    return Shape.path([nodeSub(outline.map(p => ({ x: p.x + at.x, y: p.y + at.y })), true)], layer);
  }
  return Shape.rect(at.x - L.pw / 2, at.y - L.ph / 2, L.pw, L.ph, layer, cfg.radius);
}

export function jigDialog() {
  const A = App(), M = A.doc.machine, sel = A.state.selection;
  if (!sel.length) return toast(loc('Bitte zuerst das Motiv auswählen'), 'err');
  const b = shapesBBox(sel, A.ctxGeo);
  const free = A.doc.layers.filter(L => !L.isTool);
  const prev = A.state.jigCfg || {};
  const cfg = {
    form: 'rect', radius: 0, clearance: 0.2, rows: 2, cols: 3, gap: 6, margin: 10, x0: 0, y0: 0,
    cutLayer: free[0].index, board: true, ...prev,
    w: Math.round((b.x1 - b.x0) * 10) / 10, h: Math.round((b.y1 - b.y0) * 10) / 10
  };
  const info = h('div', { class: 'hint' });
  const upd = () => {
    const L = jigLayout(cfg);
    const fits = L.board.x + L.board.w <= M.width + 1e-6 && L.board.y + L.board.h <= M.height + 1e-6;
    info.textContent = loc('{n} Taschen, Platte {w} × {h} mm', { n: L.slots.length, w: fmtNum(Math.round(L.board.w * 10) / 10), h: fmtNum(Math.round(L.board.h * 10) / 10) }) + (fits ? '' : ' – ' + loc('passt nicht auf die Arbeitsfläche'));
  };
  const n = (label, key, step, min = 0) => field(label, numInput(cfg[key], step, v => { cfg[key] = Math.max(min, v); upd(); }));
  const layerOpts = free.map(L => ({ v: String(L.index), t: loc('Ebene') + ' ' + String(L.index + 1).padStart(2, '0') + (L.name ? ' – ' + L.name : '') }));
  const body = h('div', {},
    h('h4', { class: 'sec' }, loc('Werkstück')),
    h('div', { class: 'grid2' },
      n(loc('Breite mm'), 'w', 0.1, 1), n(loc('Höhe mm'), 'h', 0.1, 1),
      field(loc('Taschenform'), selectInput(cfg.form, [{ v: 'rect', t: loc('Rechteck') }, { v: 'ellipse', t: loc('Ellipse') }, { v: 'outline', t: loc('Umriss des Motivs') }], v => cfg.form = v)),
      n(loc('Eckenradius mm'), 'radius', 0.5), n(loc('Spiel mm'), 'clearance', 0.05)),
    h('h4', { class: 'sec' }, loc('Anordnung')),
    h('div', { class: 'grid2' },
      n(loc('Spalten'), 'cols', 1, 1), n(loc('Zeilen'), 'rows', 1, 1), n(loc('Abstand mm'), 'gap', 0.5), n(loc('Rand mm'), 'margin', 1),
      n(loc('Platte X mm'), 'x0', 1), n(loc('Platte Y mm'), 'y0', 1),
      field(loc('Taschen schneiden auf'), selectInput(String(cfg.cutLayer), layerOpts, v => cfg.cutLayer = +v))),
    checkbox(cfg.board, v => cfg.board = v, loc('Plattenumriss mit ausschneiden')),
    info,
    h('small', { class: 'hint' }, loc('Die Taschen kommen auf eine neue Seite „Vorrichtung": zuerst diese Seite schneiden, die Platte nicht mehr bewegen, Werkstücke einlegen, dann die Motiv-Seite gravieren. Ursprung „Absolute Koord." verwenden.')));
  upd();
  modal(loc('Vorrichtung (Jig)'), body, [{ label: loc('Abbrechen') }, {
    label: loc('Erstellen'), primary: true, click: () => {
      cfg.rows = Math.round(cfg.rows); cfg.cols = Math.round(cfg.cols);
      A.state.jigCfg = { ...cfg };
      const L = jigLayout(cfg), cx = (b.x0 + b.x1) / 2, cy = (b.y0 + b.y1) / 2;
      // Umriss des Motivs (größte geschlossene Kontur + Spiel), um den Mittelpunkt
      let outline = null;
      if (cfg.form === 'outline') {
        const polys = sel.flatMap(s => shapePolys(s, A.ctxGeo)).filter(p => p.closed && p.pts.length > 2).map(p => p.pts.map(q => ({ x: q.x - cx, y: q.y - cy })));
        const off = polys.length ? offsetPolys(polys, cfg.clearance) : [];
        outline = off.sort((a, c) => Math.abs(polyArea(c)) - Math.abs(polyArea(a)))[0] || null;
        if (!outline) toast(loc('Kein geschlossener Umriss – nehme ein Rechteck'));
      }
      const tool = A.doc.layers.find(x => x.isTool);
      const jigShapes = L.slots.map(s => pocketShape(cfg, L, outline, s, cfg.cutLayer));
      if (cfg.board) { const r = Shape.rect(L.board.x, L.board.y, L.board.w, L.board.h, cfg.cutLayer); r.name = loc('Vorrichtung'); jigShapes.push(r); }
      // aktuelle Seite: Motiv in jeder Tasche, Taschen als Hilfsumriss (wird nicht gelasert)
      const copies = [];
      for (const s of L.slots) {
        const c = clone(sel), t = Mat.translate(s.x - cx, s.y - cy);
        for (const x of c) x.transform = Mat.mul(x.transform, t);
        copies.push(...c);
        if (tool) { const r = pocketShape(cfg, L, outline, s, tool.index); r.locked = true; r.name = loc('Tasche'); copies.push(r); }
      }
      const del = new Set(sel);
      A.doc.shapes = A.doc.shapes.filter(s => !del.has(s)).concat(copies);
      const pages = pageList(A.doc);
      pages.splice(pageIndex(A.doc) + 1, 0, { name: loc('Vorrichtung'), shapes: jigShapes });
      A.setSel(copies.filter(s => !s.locked)); A.commit(loc('Vorrichtung (Jig)'));
      toast(loc('{n} Kopien angelegt, Taschen auf Seite {p}', { n: L.slots.length, p: pageIndex(A.doc) + 2 }), 'ok');
    }
  }], { width: '560px' });
}
