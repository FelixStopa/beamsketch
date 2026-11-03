// calibrate.js — Passungs-Kalibrierung: Testteile (Quadrat für die Schnittfuge, Schlitzkamm mit gestuften
// Breiten) lasern, messen, eintragen – BeamSketch berechnet Kerf und Spiel und nimmt sie als Standard für
// Fugen-Werkzeug, Box- und Teile-Generator.
import { h, modal, field, numInput, selectInput, toast, fmtNum } from './ui.js';
import { loc } from './i18n.js';
import { Shape, nodeSub } from './doc.js';

const App = () => window.App;
const KEY = 'beamsketch.fitcal';
export const OFFSETS = [-0.3, -0.2, -0.1, 0, 0.1, 0.2, 0.3];

/* Geometrie der Testteile (mm, Ursprung unten links): Quadrat 20 × 20 und Kamm mit 7 Schlitzen */
export function fitTestGeometry(t) {
  const square = [{ x: 0, y: 0 }, { x: 20, y: 0 }, { x: 20, y: 20 }, { x: 0, y: 20 }];
  const pitch = Math.max(8, t + 6), depth = 10, H = 22, W = pitch * (OFFSETS.length + 1);
  const comb = [{ x: 0, y: 0 }, { x: W, y: 0 }, { x: W, y: H }];
  const slots = [];
  // Schlitze von oben, von rechts nach links (Umlauf gegen den Uhrzeigersinn)
  for (let i = OFFSETS.length - 1; i >= 0; i--) {
    const cx = pitch * (i + 1), w = Math.max(0.2, t + OFFSETS[i]);
    comb.push({ x: cx + w / 2, y: H }, { x: cx + w / 2, y: H - depth }, { x: cx - w / 2, y: H - depth }, { x: cx - w / 2, y: H });
    slots.push({ n: i + 1, x: cx, w });
  }
  comb.push({ x: 0, y: H });
  return { square, comb, slots: slots.reverse(), size: { w: W, h: H }, depth };
}

/* Auswertung: gemessenes Quadrat (nominell 20 mm) und Nummer des besten Schlitzes */
export function evaluateFit(measured, best) {
  const kerf = Math.max(0, Math.round((20 - measured) * 1000) / 1000);
  const offset = OFFSETS[best - 1] ?? 0;
  // Schlitz w = t + offset passt am besten. Bei gleichem Kerf ist das das Spiel, das Fugen brauchen.
  return { kerf, clearance: Math.round(offset * 1000) / 1000 };
}

export const loadFitCal = () => { try { return JSON.parse(localStorage.getItem(KEY) || 'null'); } catch (e) { return null; } };
const saveFitCal = c => { try { localStorage.setItem(KEY, JSON.stringify(c)); } catch (e) { /* egal */ } };

export function fitCalibrationDialog() {
  const A = App();
  const prev = loadFitCal();
  const cfg = { t: prev ? prev.t : 3, layer: A.state.activeLayer, numbers: Math.min(29, A.state.activeLayer + 1), measured: 20, best: 4 };
  const result = h('div', { class: 'hint', style: { minHeight: '36px' } });
  const show = () => {
    const r = evaluateFit(cfg.measured, cfg.best);
    result.textContent = loc('Kerf {k} mm · Spiel {c} mm (für Schlitze in {t} mm Material)', { k: fmtNum(r.kerf), c: fmtNum(r.clearance), t: fmtNum(cfg.t) });
  };
  const layerOpts = A.doc.layers.filter(L => !L.isTool).map(L => ({ v: String(L.index), t: loc('Ebene') + ' ' + String(L.index + 1).padStart(2, '0') + (L.name ? ' – ' + L.name : '') }));
  const body = h('div', {},
    h('h4', { class: 'sec' }, loc('1. Testteile lasern')),
    h('div', { class: 'grid2' },
      field(loc('Materialstärke mm'), numInput(cfg.t, 0.1, v => { cfg.t = Math.max(0.2, v); show(); })),
      field(loc('Schneiden auf'), selectInput(String(cfg.layer), layerOpts, v => cfg.layer = +v)),
      field(loc('Nummern auf'), selectInput(String(cfg.numbers), layerOpts, v => cfg.numbers = +v))),
    h('button', { class: 'tbtn', style: { marginTop: '6px' }, onclick: () => createTestParts(cfg) }, loc('Testteile erstellen')),
    h('small', { class: 'hint' }, loc('Ein Quadrat 20 × 20 mm und ein Kamm mit 7 Schlitzen: Materialstärke −0,3 bis +0,3 mm (Schlitz 4 = genau die Materialstärke).')),
    h('h4', { class: 'sec' }, loc('2. Messen und eintragen')),
    h('div', { class: 'grid2' },
      field(loc('Quadrat gemessen mm'), numInput(cfg.measured, 0.01, v => { cfg.measured = v; show(); })),
      field(loc('Bester Schlitz (Nummer)'), selectInput(String(cfg.best), [1, 2, 3, 4, 5, 6, 7].map(n => ({ v: String(n), t: String(n) })), v => { cfg.best = +v; show(); }))),
    h('small', { class: 'hint' }, loc('Den Schlitz wählen, in dem ein Reststück des Materials stramm, aber ohne Gewalt sitzt.')),
    result,
    prev ? h('small', { class: 'hint' }, loc('Aktuell gespeichert: Kerf {k} mm, Spiel {c} mm bei {t} mm', { k: fmtNum(prev.kerf), c: fmtNum(prev.clearance), t: fmtNum(prev.t) })) : null);
  show();
  modal(loc('Passung kalibrieren'), body, [{ label: loc('Schließen') }, {
    label: loc('Als Standard übernehmen'), primary: true, click: () => {
      const r = evaluateFit(cfg.measured, cfg.best);
      const cal = { t: cfg.t, kerf: r.kerf, clearance: r.clearance };
      saveFitCal(cal);
      applyFitCal(A, cal);
      toast(loc('Kerf und Spiel übernommen – gelten für Fugen, Box- und Teile-Generator'), 'ok');
    }
  }], { width: '560px' });
}

/* Kalibrierung als Standard in Fugen-Werkzeug, Box- und Teile-Generator eintragen */
export function applyFitCal(A, cal) {
  A.state.jointCfg = { ...(A.state.jointCfg || {}), t: cal.t, kerf: cal.kerf, clearance: cal.clearance };
  A.state.boxCfg = { ...(A.state.boxCfg || {}), t: cal.t, kerf: cal.kerf };
  const pc = A.state.partsCfg = A.state.partsCfg || {};
  for (const k of ['gear', 'gearPair', 'rack', 'pulley', 'cam', 'box', 'drawer']) pc[k] = { ...(pc[k] || {}), kerf: cal.kerf };
  for (const k of ['insert', 'shelf']) pc[k] = { ...(pc[k] || {}), t: cal.t, kerf: cal.kerf, clearance: cal.clearance };
  pc.box = { ...pc.box, t: cal.t }; pc.drawer = { ...(pc.drawer || {}), t: cal.t };
}

function createTestParts(cfg) {
  const A = App();
  const g = fitTestGeometry(cfg.t);
  const x0 = 10, y0 = 10;
  const mv = (pts, dx, dy) => pts.map(p => ({ x: p.x + dx, y: p.y + dy }));
  const sq = Shape.path([nodeSub(mv(g.square, x0, y0), true)], cfg.layer); sq.name = loc('Kerf-Quadrat 20 mm');
  const comb = Shape.path([nodeSub(mv(g.comb, x0 + 30, y0), true)], cfg.layer); comb.name = loc('Schlitzkamm');
  const news = [sq, comb];
  for (const s of g.slots) {
    const t = Shape.text(x0 + 30 + s.x - 1.2, y0 + 3, String(s.n), cfg.numbers); t.size = 4;
    news.push(t);
  }
  A.doc.shapes.push(...news);
  A.setSel(news); A.commit(loc('Passung kalibrieren'));
  toast(loc('Testteile erstellt – Nummern-Ebene mit wenig Leistung gravieren, dann schneiden'), 'ok');
}
