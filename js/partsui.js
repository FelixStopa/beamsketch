// partsui.js — Dialog „Teile-Generator": Zahnrad, Zahnradpaar, Zahnstange, Zahnriemenscheibe, Nocke,
// Einsatz mit Fächern, Steckregal, Schublade. Die Teile behalten ihre Parameter (shape.gen) –
// ein Doppelklick öffnet den Generator wieder und berechnet alle Teile des Satzes neu.
import { h, modal, field, numInput, selectInput, checkbox, toast, fmtNum } from './ui.js';
import { loc } from './i18n.js';
import { Shape, nodeSub, shapesBBox } from './doc.js';
import { PART_KINDS } from './parts.js';

const App = () => window.App;

const KIND_NAMES = () => ({
  box: loc('Box mit Fingerzinken'),
  gear: loc('Zahnrad'), gearPair: loc('Zahnradpaar'), rack: loc('Zahnstange'), pulley: loc('Zahnriemenscheibe'),
  cam: loc('Nocke (Kurvenscheibe)'), insert: loc('Einsatz mit Fächern'), shelf: loc('Steckregal'), drawer: loc('Schublade')
});
const BORE = () => [{ v: 'round', t: loc('rund') }, { v: 'd', t: loc('D-Welle') }, { v: 'key', t: loc('mit Nut') }];
// Felder je Teil: [Schlüssel, Beschriftung, Schritt | Auswahl, min, max]
const FIELDS = () => ({
  box: [['w', loc('Breite mm'), 1, 10, 3000], ['d', loc('Tiefe mm'), 1, 10, 3000], ['h', loc('Höhe mm'), 1, 5, 3000], ['t', loc('Materialstärke mm'), 0.1, 0.5, 30], ['finger', loc('Fingerbreite mm'), 1, 1, 200], ['inner', loc('Innenmaße statt Außenmaße')], ['lid', loc('Deckel'), [{ v: 'open', t: loc('offen') }, { v: 'closed', t: loc('geschlossen') }]], ['dividers', loc('Trennwände'), 1, 0, 10], ['kerf', loc('Kerf mm'), 0.01, 0, 2]],
  gear: [['teeth', loc('Zähne'), 1, 5, 400], ['module', loc('Modul mm'), 0.1, 0.2, 20], ['pressure', loc('Eingriffswinkel °'), 0.5, 10, 30], ['shift', loc('Profilverschiebung'), 0.05, -1, 1], ['backlash', loc('Flankenspiel mm'), 0.01, 0, 2], ['bore', loc('Bohrung mm (0 = keine)'), 0.5, 0, 500], ['boreType', loc('Bohrung'), BORE()], ['kerf', loc('Kerf mm'), 0.01, 0, 2]],
  gearPair: [['teeth', loc('Zähne Rad 1'), 1, 5, 400], ['teeth2', loc('Zähne Rad 2'), 1, 5, 400], ['module', loc('Modul mm'), 0.1, 0.2, 20], ['pressure', loc('Eingriffswinkel °'), 0.5, 10, 30], ['shift', loc('Profilverschiebung'), 0.05, -1, 1], ['backlash', loc('Flankenspiel mm'), 0.01, 0, 2], ['bore', loc('Bohrung mm (0 = keine)'), 0.5, 0, 500], ['boreType', loc('Bohrung'), BORE()], ['plate', loc('Grundplatte mit Achslöchern')], ['axle', loc('Achsdurchmesser mm'), 0.5, 1, 100], ['kerf', loc('Kerf mm'), 0.01, 0, 2]],
  rack: [['teeth', loc('Zähne'), 1, 1, 400], ['module', loc('Modul mm'), 0.1, 0.2, 20], ['pressure', loc('Eingriffswinkel °'), 0.5, 10, 30], ['backlash', loc('Flankenspiel mm'), 0.01, 0, 2], ['height', loc('Höhe unter den Zähnen mm'), 1, 1, 500], ['kerf', loc('Kerf mm'), 0.01, 0, 2]],
  pulley: [['belt', loc('Riemen'), [{ v: 'GT2-2', t: 'GT2 2 mm' }, { v: 'GT2-3', t: 'GT2 3 mm' }, { v: 'GT2-5', t: 'GT2 5 mm' }, { v: 'HTD-3M', t: 'HTD 3M' }, { v: 'HTD-5M', t: 'HTD 5M' }]], ['teeth', loc('Zähne'), 1, 8, 300], ['groove', loc('Spiel in der Zahnlücke mm'), 0.05, 0, 1], ['bore', loc('Bohrung mm (0 = keine)'), 0.5, 0, 500], ['boreType', loc('Bohrung'), BORE()], ['kerf', loc('Kerf mm'), 0.01, 0, 2]],
  cam: [['base', loc('Grundkreis-Radius mm'), 1, 2, 500], ['lift', loc('Hub mm'), 0.5, 0, 500], ['rise', loc('Hubwinkel °'), 5, 5, 355], ['dwell', loc('Rast oben °'), 5, 0, 350], ['ret', loc('Rückhubwinkel °'), 5, 5, 355], ['motion', loc('Bewegung'), [{ v: 'cycloid', t: loc('zykloidisch') }, { v: 'poly', t: loc('Polynom 3-4-5') }, { v: 'harmonic', t: loc('harmonisch') }]], ['follower', loc('Stößel'), [{ v: 'knife', t: loc('Spitze') }, { v: 'roller', t: loc('Rolle') }]], ['roller', loc('Rollenradius mm'), 0.5, 0.5, 100], ['bore', loc('Bohrung mm (0 = keine)'), 0.5, 0, 500], ['boreType', loc('Bohrung'), BORE()], ['kerf', loc('Kerf mm'), 0.01, 0, 2]],
  insert: [['W', loc('Innenbreite der Box mm'), 1, 10, 2000], ['D', loc('Innentiefe der Box mm'), 1, 10, 2000], ['H', loc('Höhe mm'), 1, 5, 1000], ['t', loc('Materialstärke mm'), 0.1, 0.5, 30], ['nx', loc('Fächer in der Breite'), 1, 1, 30], ['ny', loc('Fächer in der Tiefe'), 1, 1, 30], ['clearance', loc('Spiel im Schlitz mm'), 0.05, -1, 2], ['endClear', loc('Luft an den Enden mm'), 0.1, 0, 10], ['kerf', loc('Kerf mm'), 0.01, 0, 2]],
  shelf: [['W', loc('Breite der Böden mm'), 1, 50, 3000], ['D', loc('Tiefe mm'), 1, 30, 1000], ['H', loc('Höhe der Seiten mm'), 1, 50, 3000], ['t', loc('Materialstärke mm'), 0.1, 1, 40], ['shelves', loc('Anzahl Böden'), 1, 1, 20], ['overhang', loc('Überstand der Böden mm'), 1, 0, 300], ['foot', loc('Höhe des untersten Bodens mm'), 1, 0, 1000], ['clearance', loc('Spiel im Schlitz mm'), 0.05, -1, 2], ['kerf', loc('Kerf mm'), 0.01, 0, 2]],
  drawer: [['W', loc('Breite der Öffnung mm'), 1, 30, 2000], ['H', loc('Höhe der Öffnung mm'), 1, 20, 1000], ['D', loc('Tiefe mm'), 1, 30, 2000], ['t', loc('Materialstärke mm'), 0.1, 1, 30], ['finger', loc('Fingerbreite mm'), 1, 3, 100], ['clearance', loc('Spiel rundum mm'), 0.1, 0, 10], ['overlay', loc('Überstand der Front mm'), 1, 0, 100], ['handle', loc('Griff'), [{ v: 'slot', t: loc('Griffschlitz') }, { v: 'hole', t: loc('Griffloch') }, { v: 'none', t: loc('keiner') }]], ['kerf', loc('Kerf mm'), 0.01, 0, 2]]
});
const INFO = (kind, i) => ({
  box: () => loc('{n} Teile · Außenmaß {w} × {d} × {h} mm', { n: i.count, w: fmtNum(i.outer.w), d: fmtNum(i.outer.d), h: fmtNum(i.outer.h) }),
  gear: () => loc('Teilkreis {p} mm · Kopfkreis {o} mm · Fußkreis {f} mm', { p: fmtNum(i.pitchD), o: fmtNum(i.outerD), f: fmtNum(i.rootD) }) + (i.pointed ? ' – ' + loc('⚠ Zähne werden spitz, Kopf gekürzt') : ''),
  gearPair: () => loc('Achsabstand {d} mm · Teilkreise {a} / {b} mm', { d: fmtNum(i.distance), a: fmtNum(i.d1), b: fmtNum(i.d2) }),
  rack: () => loc('Länge {l} mm · Teilung {p} mm', { l: fmtNum(i.length), p: fmtNum(i.pitch) }),
  pulley: () => loc('Außendurchmesser {o} mm · Wirkdurchmesser {p} mm', { o: fmtNum(i.outerD), p: fmtNum(i.pitchD) }),
  cam: () => (i.rest < 0 ? loc('⚠ Die Winkel ergeben zusammen mehr als 360°.') : loc('Größter Durchmesser {d} mm · Rast unten {r}°', { d: fmtNum(i.maxD), r: fmtNum(i.rest) })),
  insert: () => loc('{n} Fächer, je ca. {w} × {d} mm', { n: i.cells, w: fmtNum(i.cellW), d: fmtNum(i.cellD) }),
  shelf: () => loc('{n} Böden in {h} mm Höhe', { n: i.levels.length, h: i.levels.map(v => Math.round(v)).join(' / ') }),
  drawer: () => loc('Schubkasten außen {w} × {d} × {h} mm', { w: fmtNum(i.box.w), d: fmtNum(i.box.d), h: fmtNum(i.box.h) })
}[kind] || (() => ''))();

/* Teile in Reihen ab (x0, y0) legen; gibt die neuen Formen zurück */
function placeParts(A, parts, gen, x0, y0, gap = 5) {
  const M = A.doc.machine, layer = A.state.activeLayer, out = [];
  let x = x0, y = y0, rowH = 0;
  parts.forEach((p, i) => {
    let bx0 = Infinity, by0 = Infinity, bx1 = -Infinity, by1 = -Infinity;
    for (const q of p.outline) { bx0 = Math.min(bx0, q.x); by0 = Math.min(by0, q.y); bx1 = Math.max(bx1, q.x); by1 = Math.max(by1, q.y); }
    const w = bx1 - bx0, hh = by1 - by0;
    if (x > x0 && x + w > M.width - gap) { x = x0; y += rowH + gap; rowH = 0; }
    const dx = x - bx0, dy = y - by0, mv = pl => pl.map(q => ({ x: q.x + dx, y: q.y + dy }));
    const sh = Shape.path([nodeSub(mv(p.outline), true), ...p.holes.map(hl => nodeSub(mv(hl), true)), ...(p.lines || []).map(l => nodeSub(mv(l), false))], layer);
    sh.name = loc(p.name);
    sh.gen = { ...gen, part: i };
    out.push(sh);
    x += w + gap; rowH = Math.max(rowH, hh);
  });
  return out;
}

export function partsDialog(kind = 'gear', edit = null) {
  const A = App();
  const set = edit ? edit.gen.set : 'G' + Date.now().toString(36);
  let cfg = { ...PART_KINDS[kind].defaults, ...((A.state.partsCfg || {})[kind] || {}), ...(edit ? edit.gen.cfg : {}) };
  const canvas = h('canvas', { style: { width: '100%', height: '300px', border: '1px solid var(--line)', borderRadius: '8px', background: 'var(--bg)' } });
  const info = h('div', { class: 'hint', style: { minHeight: '18px' } });
  const fieldsEl = h('div');
  let result = null;

  const draw = () => {
    const g = canvas.getContext('2d'), dpr = window.devicePixelRatio || 1;
    canvas.width = canvas.clientWidth * dpr; canvas.height = canvas.clientHeight * dpr;
    g.clearRect(0, 0, canvas.width, canvas.height);
    if (!result) return;
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    // Vorschau: Teile nebeneinander wie beim Erstellen
    const placed = placeParts({ doc: { machine: { width: 1e9 } }, state: { activeLayer: 0 } }, result.parts, {}, 0, 0, 5);
    const polys = placed.flatMap(s => s.subpaths.map(sp => ({ pts: sp.nodes, closed: sp.closed })));
    for (const p of polys) for (const q of p.pts) { x0 = Math.min(x0, q.x); y0 = Math.min(y0, q.y); x1 = Math.max(x1, q.x); y1 = Math.max(y1, q.y); }
    const W = canvas.width, H = canvas.height, pad = 16 * dpr;
    const k = Math.min((W - 2 * pad) / (x1 - x0 || 1), (H - 2 * pad) / (y1 - y0 || 1));
    const ox = (W - (x1 - x0) * k) / 2, oy = (H - (y1 - y0) * k) / 2;
    g.strokeStyle = getComputedStyle(document.body).getPropertyValue('--fg') || '#222';
    g.lineWidth = 1.2 * dpr;
    for (const p of polys) {
      g.beginPath();
      p.pts.forEach((q, i) => { const X = ox + (q.x - x0) * k, Y = H - (oy + (q.y - y0) * k); i ? g.lineTo(X, Y) : g.moveTo(X, Y); });
      if (p.closed) g.closePath();
      g.stroke();
    }
  };
  const upd = () => {
    try { result = PART_KINDS[kind].make(cfg); info.style.color = ''; info.textContent = INFO(kind, result.info); }
    catch (e) { result = null; info.style.color = 'var(--err)'; info.textContent = e.message; }
    draw();
  };
  const build = () => {
    fieldsEl.innerHTML = '';
    const grid = h('div', { class: 'grid2' });
    for (const [key, label, a, min, max] of FIELDS()[kind]) {
      if (key === 'roller' && cfg.follower !== 'roller') continue;
      if (key === 'axle' && !cfg.plate) continue;
      if (a === undefined) grid.appendChild(checkbox(!!cfg[key], v => { cfg[key] = v; build(); upd(); }, label));
      else if (Array.isArray(a)) grid.appendChild(field(label, selectInput(cfg[key], a, v => { cfg[key] = v; build(); upd(); })));
      else grid.appendChild(field(label, numInput(cfg[key], a, v => { cfg[key] = Math.max(min, Math.min(max, v)); upd(); })));
    }
    fieldsEl.appendChild(grid);
  };
  const kindSel = selectInput(kind, Object.entries(KIND_NAMES()).map(([v, t]) => ({ v, t })), v => {
    kind = v; cfg = { ...PART_KINDS[kind].defaults, ...((A.state.partsCfg || {})[kind] || {}) }; build(); upd();
  });
  if (edit) kindSel.disabled = true;
  const body = h('div', {},
    h('div', { class: 'grid2', style: { gridTemplateColumns: '1fr 1.1fr', gap: '14px', alignItems: 'start' } },
      h('div', {}, field(loc('Teil'), kindSel), fieldsEl),
      h('div', {}, canvas, info)));
  build();
  modal(edit ? loc('Teil bearbeiten') : loc('Teile-Generator'), body, [{ label: loc('Abbrechen') }, {
    label: edit ? loc('Übernehmen') : loc('Erstellen'), primary: true, click: () => {
      if (!result) return false;
      A.state.partsCfg = { ...(A.state.partsCfg || {}), [kind]: { ...cfg } };
      let x0 = 10, y0 = 10;
      if (edit) {
        const old = A.doc.shapes.filter(s => s.gen && s.gen.set === set);
        const b = shapesBBox(old, A.ctxGeo);
        if (isFinite(b.x0)) { x0 = b.x0; y0 = b.y0; }
        A.doc.shapes = A.doc.shapes.filter(s => !(s.gen && s.gen.set === set));
      }
      const news = placeParts(A, result.parts, { kind, cfg: { ...cfg }, set }, x0, y0);
      A.doc.shapes.push(...news);
      A.setSel(news);
      A.commit(edit ? loc('Teil bearbeiten') : KIND_NAMES()[kind]);
      toast(loc('{n} Teile erstellt', { n: news.length }), 'ok');
    }
  }], { width: '900px' });
  requestAnimationFrame(upd);
}

/* Doppelklick auf ein generiertes Teil */
export function editPart(sh) {
  if (!sh || !sh.gen || !PART_KINDS[sh.gen.kind]) return false;
  partsDialog(sh.gen.kind, sh);
  return true;
}
