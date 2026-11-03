// printcut.js — Print & Cut: Ein ausgedrucktes Motiv (Aufkleber, Papier, bedrucktes Holz) liegt irgendwo im Laser.
// Zwei Passermarken werden mit dem Laserkopf angefahren; BeamSketch dreht und verschiebt die Zeichnung so,
// dass die Schnittlinien genau auf dem Druck liegen.
import { h, modal, field, numInput, selectInput, checkbox, toast, fmtNum } from './ui.js';
import { loc } from './i18n.js';
import { Shape, nodeSub, shapesBBox, walk } from './doc.js';
import { Mat } from './geom.js';

const App = () => window.App;

/* Transformation, die die Marken a1, a2 (Zeichnung) auf b1, b2 (gemessen) bringt.
   keepScale: nur Drehung und Verschiebung (Maßstab 1, Fehler wird auf beide Marken verteilt). */
export function alignTransform(a1, a2, b1, b2, keepScale = true) {
  const da = { x: a2.x - a1.x, y: a2.y - a1.y }, db = { x: b2.x - b1.x, y: b2.y - b1.y };
  const la = Math.hypot(da.x, da.y), lb = Math.hypot(db.x, db.y);
  if (la < 1e-9 || lb < 1e-9) return null;
  const rot = Math.atan2(db.y, db.x) - Math.atan2(da.y, da.x);
  const scale = lb / la, k = keepScale ? 1 : scale;
  const R = Mat.mul(Mat.rotate(rot), Mat.scale(k));
  // Mittelpunkte der Marken aufeinander legen
  const ca = { x: (a1.x + a2.x) / 2, y: (a1.y + a2.y) / 2 }, cb = { x: (b1.x + b2.x) / 2, y: (b1.y + b2.y) / 2 };
  const m = Mat.mul(Mat.mul(Mat.translate(-ca.x, -ca.y), R), Mat.translate(cb.x, cb.y));
  return { m, rot: rot * 180 / Math.PI, scale, err: Math.abs(lb - la) / 2 };
}

/* Passermarke: Kreis 6 mm mit Kreuz */
function markShape(p, layer, n) {
  const ring = Shape.ellipse(p.x, p.y, 3, 3, layer);
  const cross = Shape.path([nodeSub([{ x: p.x - 5, y: p.y }, { x: p.x + 5, y: p.y }], false), nodeSub([{ x: p.x, y: p.y - 5 }, { x: p.x, y: p.y + 5 }], false)], layer);
  const g = Shape.group([ring, cross], layer);
  g.name = loc('Passermarke {n}', { n }); g.regGroup = n; ring.regMark = n;   // Mitte des Kreises = Marke
  return g;
}
const findMarks = shapes => { const r = {}; walk(shapes, (s, m) => { if (s.regMark) r[s.regMark] = Mat.apply(m, { x: 0, y: 0 }); }); return r; };

export function printCutDialog() {
  const A = App(), M = A.doc.machine, S = A.serial;
  const free = A.doc.layers.filter(L => !L.isTool);
  const cfg = A.state.printCut = A.state.printCut || { layer: free[free.length - 1].index, keepScale: true, meas: [null, null] };
  const posTxt = [h('span', { class: 'tag' }), h('span', { class: 'tag' })];
  const result = h('div', { class: 'hint', style: { minHeight: '20px' } });
  const show = () => cfg.meas.forEach((p, i) => { posTxt[i].textContent = p ? `X ${fmtNum(Math.round(p.x * 100) / 100)} · Y ${fmtNum(Math.round(p.y * 100) / 100)}` : loc('noch nicht gemessen'); });
  const toDoc = w => M.jobOrigin === 'user' ? { x: w[0] + (M.userX || 0), y: w[1] + (M.userY || 0) } : { x: w[0], y: w[1] };
  const take = i => {
    if (!S.connected) return toast(loc('Nicht verbunden'), 'err');
    if (M.jobOrigin === 'current') return toast(loc('Print & Cut braucht den Ursprung „Absolute Koord." oder „Benutzer-Ursprung".'), 'err');
    cfg.meas[i] = toDoc(S.status.wpos); show();
  };
  const addMarks = () => {
    const sel = A.state.selection.length ? A.state.selection : A.doc.shapes;
    const b = shapesBBox(sel, A.ctxGeo);
    if (!isFinite(b.x0)) return toast(loc('Nichts zum Ausrichten'), 'err');
    const L = A.doc.layers[cfg.layer]; if (L) L.output = false;     // Marken werden gedruckt, nicht gelasert
    A.doc.shapes = A.doc.shapes.filter(s => !s.regGroup);
    const news = [markShape({ x: b.x0 - 10, y: b.y1 + 10 }, cfg.layer, 1), markShape({ x: b.x1 + 10, y: b.y0 - 10 }, cfg.layer, 2)];
    A.doc.shapes.push(...news); A.setSel(news); A.commit(loc('Passermarken'));
    toast(loc('Passermarken angelegt – mit dem Motiv ausdrucken (PDF/SVG), die Ebene der Marken wird nicht gelasert'), 'ok');
  };
  const jb = (dx, dy, t) => h('button', { class: 'tbtn', onclick: () => S.connected ? S.jog(dx * (A.state.jogStep || 1), dy * (A.state.jogStep || 1), 3000) : toast(loc('Nicht verbunden'), 'err') }, t);
  const layerOpts = free.map(L => ({ v: String(L.index), t: loc('Ebene') + ' ' + String(L.index + 1).padStart(2, '0') + (L.name ? ' – ' + L.name : '') }));
  const body = h('div', {},
    h('h4', { class: 'sec' }, loc('1. Marken anlegen und drucken')),
    h('div', { class: 'grid2' }, field(loc('Ebene der Marken'), selectInput(String(cfg.layer), layerOpts, v => cfg.layer = +v))),
    h('button', { class: 'tbtn', style: { marginTop: '4px' }, onclick: addMarks }, loc('Passermarken anlegen')),
    h('small', { class: 'hint' }, loc('Zwei Marken diagonal um die Auswahl. Motiv mit Marken drucken – gelasert werden nur die Schnittebenen.')),
    h('h4', { class: 'sec' }, loc('2. Marken anfahren')),
    h('div', { class: 'row', style: { gap: '12px', alignItems: 'flex-start' } },
      h('div', { class: 'jog' }, jb(-1, 1, '↖'), jb(0, 1, '↑'), jb(1, 1, '↗'), jb(-1, 0, '←'), h('span'), jb(1, 0, '→'), jb(-1, -1, '↙'), jb(0, -1, '↓'), jb(1, -1, '↘')),
      h('div', { style: { flex: 1 } },
        field(loc('Schritt'), selectInput(String(A.state.jogStep || 1), ['0.1', '0.5', '1', '5', '10', '50'].map(v => ({ v, t: v + ' mm' })), v => A.state.jogStep = parseFloat(v))),
        h('button', { class: 'tbtn', style: { marginTop: '4px' }, title: loc('Laser kurz testen'), onclick: () => S.connected && S.laserTest(Math.min(M.laserFirePower, 2), M.sScale, 150) }, loc('✸ Punkt markieren')),
        ...[0, 1].map(i => h('div', { class: 'row', style: { gap: '6px', marginTop: '6px' } },
          h('b', {}, loc('Marke {n}', { n: i + 1 })), posTxt[i], h('span', { style: { flex: 1 } }),
          h('button', { class: 'tbtn', onclick: () => take(i) }, loc('Position übernehmen')))))),
    h('small', { class: 'hint' }, loc('Kopf genau über die Mitte der Marke fahren (roter Punkt oder ganz schwacher Testpuls), dann „Position übernehmen".')),
    h('h4', { class: 'sec' }, loc('3. Ausrichten')),
    checkbox(cfg.keepScale, v => cfg.keepScale = v, loc('Maßstab beibehalten (nur drehen und verschieben)')),
    result);
  show();
  modal(loc('Print & Cut'), body, [{ label: loc('Schließen') }, {
    label: loc('Zeichnung ausrichten'), primary: true, click: () => {
      const mk = findMarks(A.doc.shapes);
      if (!mk[1] || !mk[2]) { toast(loc('Keine Passermarken in der Zeichnung'), 'err'); return false; }
      if (!cfg.meas[0] || !cfg.meas[1]) { toast(loc('Bitte beide Marken anfahren und übernehmen'), 'err'); return false; }
      const t = alignTransform(mk[1], mk[2], cfg.meas[0], cfg.meas[1], cfg.keepScale);
      if (!t) { toast(loc('Marken liegen zu dicht beieinander'), 'err'); return false; }
      for (const s of A.doc.shapes) s.transform = Mat.mul(s.transform, t.m);
      A.commit(loc('Print & Cut'));
      result.textContent = loc('Gedreht um {r}°, Druckmaßstab {s} %, Abweichung {e} mm', { r: fmtNum(Math.round(t.rot * 100) / 100), s: fmtNum(Math.round(t.scale * 1000) / 10), e: fmtNum(Math.round(t.err * 100) / 100) });
      toast(result.textContent, Math.abs(t.scale - 1) > 0.02 ? 'err' : 'ok');
      cfg.meas = [null, null]; show();
      return false;
    }
  }], { width: '600px' });
}
