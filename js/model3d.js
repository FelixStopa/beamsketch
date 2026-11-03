// model3d.js — Schicht- oder Rippenmodell aus einer 3D-Datei (STL/OBJ): Einstellungen, 3D-Vorschau,
// Teile mit eingravierter Nummer auf die Arbeitsfläche legen.
import { h, modal, field, numInput, selectInput, checkbox, slider, toast } from './ui.js';
import { loc } from './i18n.js';
import { Shape, nodeSub, layerNo } from './doc.js';
import { parseMesh, orientMesh, layeredModel, labelPoint, meshBounds } from './mesh.js';
import { View3D } from './view3d.js';
import { ribModel, ribPlates } from './ribs.js';
import { polyArea } from './geom.js';

const App = () => window.App;

/* Holzfarben im Wechsel, damit man die Schichten unterscheidet */
const WOOD = [[0.86, 0.71, 0.5], [0.8, 0.63, 0.42]];

export function pickModelFile() {
  const inp = h('input', { type: 'file', accept: '.stl,.obj', style: { display: 'none' } });
  inp.onchange = () => { if (inp.files[0]) layeredModelDialog(inp.files[0]); inp.remove(); };
  document.body.appendChild(inp);
  inp.click();
}

export async function layeredModelDialog(file) {
  const A = App();
  let raw;
  try { raw = parseMesh(file.name, await file.arrayBuffer()); }
  catch (e) { return toast(loc('Die Datei ist kein lesbares 3D-Modell (STL oder OBJ).'), 'err'); }
  if (!raw.length) return toast(loc('Die Datei ist kein lesbares 3D-Modell (STL oder OBJ).'), 'err');

  const b0 = meshBounds(raw);
  const longest = Math.max(b0.x1 - b0.x0, b0.y1 - b0.y0, b0.z1 - b0.z0);
  const cfg = Object.assign({ mode: 'layers', up: 'z', thickness: 3, section: 'mid', minArea: 1, numbers: true, gap: 4, axis: 'x', spacing: 15, spineOffset: 0, inset: 0, clearance: 0.2, kerf: 0.1 },
    A.state.layerModelCfg || {}, { size: Math.round(Math.min(200, longest) || 100) });
  cfg.numberLayer = cfg.numberLayer ?? Math.min(29, A.state.activeLayer + 1);
  let result = null, explode = 0;

  const canvas = h('canvas', { class: 'view3d', style: { width: '100%', height: '340px', borderRadius: '8px', border: '1px solid var(--line)', cursor: 'grab', touchAction: 'none' } });
  const info = h('div', { class: 'hint', style: { minHeight: '34px' } });
  const warn = h('div', { class: 'hint', style: { color: 'var(--warn)' } });
  let view = null;

  const parts = () => {
    if (result.ribs) {
      // Rippen auseinander entlang ihrer Achse, Rückgrat bleibt
      return ribPlates(result).map((pl, i) => {
        const m = pl.map, off = pl.spine ? 0 : (i - result.ribs.length / 2) * explode;
        return { ...pl, color: pl.spine ? [0.72, 0.55, 0.36] : WOOD[i % 2], map: (u, v, w) => { const q = m(u, v, w); const d = result.phys(off, 0, 0); return [q[0] + d[0], q[1] + d[1], q[2] + d[2]]; } };
      });
    }
    return result.layers.map((L, i) => ({ polys: L.polys, z0: L.z0 + i * explode, z1: L.z1 + i * explode, color: WOOD[i % 2] }));
  };
  const recompute = () => {
    info.textContent = loc('Berechne …');
    clearTimeout(recompute.t);
    recompute.t = setTimeout(() => {
      const tris = orientMesh(raw, cfg.up, cfg.size);
      if (cfg.mode === 'ribs') {
        result = ribModel(tris, { axis: cfg.axis, t: cfg.thickness, spacing: cfg.spacing, spineOffset: cfg.spineOffset, inset: cfg.inset, clearance: cfg.clearance, kerf: cfg.kerf, minArea: cfg.minArea });
        result.size = (() => { const b = meshBounds(tris); return { x: b.x1 - b.x0, y: b.y1 - b.y0, z: b.z1 - b.z0 }; })();
        const s = result.size;
        info.textContent = loc('{n} Rippen und ein Rückgrat · Modell {x} × {y} × {z} mm', { n: result.ribs.length, x: Math.round(s.x), y: Math.round(s.y), z: Math.round(s.z) });
        const w = [];
        if (result.warnings.noSpine) w.push(loc('Das Rückgrat trifft das Modell nicht – Versatz ändern.'));
        if (result.warnings.dropped) w.push(loc('{n} Rippenteile ohne Halt am Rückgrat weggelassen', { n: result.warnings.dropped }));
        warn.textContent = w.length ? '⚠ ' + w.join(' · ') : '';
        if (view && view.ok) view.setParts(parts());
        return;
      }
      result = layeredModel(tris, { thickness: cfg.thickness, section: cfg.section, minArea: cfg.minArea });
      const s = result.size;
      const area = result.layers.reduce((a, L) => a + L.polys.reduce((x, p) => x + polyArea(p), 0), 0);
      info.textContent = loc('{n} Schichten à {t} mm · Modell {x} × {y} × {z} mm · Plattenfläche gesamt ca. {a} cm²',
        { n: result.layers.length, t: cfg.thickness, x: Math.round(s.x), y: Math.round(s.y), z: Math.round(s.z), a: Math.round(area / 100) });
      const w = [];
      if (result.empty) w.push(loc('{n} leere Schichten', { n: result.empty }));
      if (result.multi) w.push(loc('{n} Schichten aus mehreren Teilen (beim Kleben ausrichten)', { n: result.multi }));
      if (result.bridged) w.push(loc('{n} Lücken im Modell überbrückt', { n: result.bridged }));
      if (result.dropped) w.push(loc('{n} offene Kanten ignoriert – das Modell ist nicht dicht', { n: result.dropped }));
      if (result.layers.length > 80) w.push(loc('Sehr viele Schichten – größere Materialstärke oder kleineres Modell wählen.'));
      warn.textContent = w.length ? '⚠ ' + w.join(' · ') : '';
      if (view && view.ok) view.setParts(parts());
    }, 60);
  };

  const num = (k, step, min, max) => numInput(cfg[k], step, v => { cfg[k] = Math.max(min, Math.min(max, v)); recompute(); });
  const layerOpts = A.doc.layers.filter(L => !L.isTool).map(L => ({ v: String(L.index), t: loc('Ebene') + ' ' + layerNo(L.index) + (L.name ? ' – ' + L.name : '') }));
  const settings = h('div');
  const buildSettings = () => {
    settings.innerHTML = '';
    const ribs = cfg.mode === 'ribs';
    settings.appendChild(h('div', { class: 'grid2' },
      field(loc('Art'), selectInput(cfg.mode, [{ v: 'layers', t: loc('Schichtmodell (gestapelt)') }, { v: 'ribs', t: loc('Rippenmodell (gesteckt)') }], v => { cfg.mode = v; buildSettings(); recompute(); })),
      field(loc('Oben ist in der Datei'), selectInput(cfg.up, [{ v: 'z', t: 'Z' }, { v: 'y', t: 'Y' }, { v: 'x', t: 'X' }], v => { cfg.up = v; recompute(); })),
      field(loc('Längste Seite mm'), num('size', 1, 5, 5000)),
      field(loc('Materialstärke mm'), num('thickness', 0.1, 0.3, 100)),
      ribs ? field(loc('Achse der Rippen'), selectInput(cfg.axis, [{ v: 'x', t: loc('links – rechts') }, { v: 'y', t: loc('vorne – hinten') }, { v: 'z', t: loc('unten – oben') }], v => { cfg.axis = v; recompute(); })) : null,
      ribs ? field(loc('Rippenabstand mm'), num('spacing', 1, 3, 1000)) : null,
      ribs ? field(loc('Versatz des Rückgrats mm'), num('spineOffset', 1, -1000, 1000)) : null,
      ribs ? field(loc('Rückgrat-Einzug mm'), num('inset', 0.5, 0, 200)) : null,
      ribs ? field(loc('Spiel im Schlitz mm'), num('clearance', 0.05, -1, 2)) : null,
      ribs ? field(loc('Kerf mm'), num('kerf', 0.01, 0, 2)) : null,
      ribs ? null : field(loc('Querschnitt'), selectInput(cfg.section, [
        { v: 'mid', t: loc('Mitte der Schicht') }, { v: 'outside', t: loc('außen (nichts fehlt, Stufen abschleifen)') }, { v: 'inside', t: loc('innen (nichts steht über)') }
      ], v => { cfg.section = v; recompute(); })),
      field(loc('Kleinste Fläche mm²'), num('minArea', 0.5, 0, 10000)),
      field(loc('Abstand der Teile mm'), num('gap', 1, 0, 100))));
    settings.appendChild(h('div', { class: 'row', style: { marginTop: '6px', gap: '8px', alignItems: 'center' } },
      checkbox(cfg.numbers, v => { cfg.numbers = v; }, ribs ? loc('Rippennummern eingravieren auf') : loc('Schichtnummer eingravieren auf')),
      selectInput(String(cfg.numberLayer), layerOpts, v => { cfg.numberLayer = +v; })));
    settings.appendChild(h('small', { class: 'hint' }, ribs
      ? loc('Die Rippen sind von unten geschlitzt, das Rückgrat von oben: Rippen von oben auf das Rückgrat stecken. Unter jedem Schlitz im Rückgrat steht die Nummer der passenden Rippe.')
      : loc('Die Nummer zählt von unten und zeigt beim Kleben die Reihenfolge. Die Nummern-Ebene am besten auf „Linie" mit wenig Leistung stellen, damit sie nur graviert wird.')));
  };
  buildSettings();

  const viewBtns = h('div', { class: 'row', style: { gap: '6px', marginTop: '6px', alignItems: 'center' } },
    ...[['3d', '3D'], ['top', loc('Oben')], ['front', loc('Vorne')]].map(([v, t]) => h('button', { class: 'tbtn', onclick: () => view && view.setView(v) }, t)),
    h('div', { style: { flex: 1, marginLeft: '8px' } },
      slider(loc('Auseinanderziehen'), 0, 0, 20, 0.5, v => { explode = v; if (view && result) view.setParts(parts()); })));

  const body = h('div', { class: 'model3d' },
    h('div', { class: 'grid2', style: { gridTemplateColumns: '1fr 1.25fr', gap: '14px', alignItems: 'start' } },
      settings,
      h('div', {}, canvas, viewBtns)),
    info, warn);

  modal(loc('Modell aus 3D-Datei') + ' – ' + file.name, body, [{ label: loc('Abbrechen') }, {
    label: loc('Teile erstellen'), primary: true, click: () => {
      if (!result) return false;
      A.state.layerModelCfg = { ...cfg, size: undefined };
      if (result.ribs) createRibParts(A, result, cfg, file.name);
      else createParts(A, result, cfg, file.name);
    }
  }], { width: '940px' });
  view = new View3D(canvas);
  if (!view.ok) canvas.replaceWith(h('div', { class: 'hint' }, loc('3D-Vorschau nicht verfügbar (WebGL ist im Browser ausgeschaltet).')));
  recompute();
}

/* Schichten als Gruppen (Umriss + Nummer) in Reihen auf die Arbeitsfläche legen */
function createParts(A, result, cfg, fileName) {
  const M = A.doc.machine, cutLayer = A.state.activeLayer;
  const items = result.layers.filter(L => L.polys.length).map(L => {
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const p of L.polys) for (const q of p) { x0 = Math.min(x0, q.x); y0 = Math.min(y0, q.y); x1 = Math.max(x1, q.x); y1 = Math.max(y1, q.y); }
    return { L, x0, y0, w: x1 - x0, h: y1 - y0 };
  });
  const news = [];
  let x = cfg.gap, y = cfg.gap, rowH = 0, outside = 0;
  for (const it of items) {
    if (x > cfg.gap && x + it.w > M.width - cfg.gap) { x = cfg.gap; y += rowH + cfg.gap; rowH = 0; }
    const dx = x - it.x0, dy = y - it.y0;
    const children = [Shape.path(it.L.polys.map(p => nodeSub(p.map(q => ({ x: q.x + dx, y: q.y + dy })), true)), cutLayer)];
    if (cfg.numbers) {
      const lp = labelPoint(it.L.polys);
      if (lp) {
        const label = String(it.L.index + 1);
        const size = Math.max(2, Math.min(8, lp.room * 0.9));
        const t = Shape.text(lp.x + dx - size * 0.28 * label.length, lp.y + dy - size * 0.35, label, cfg.numberLayer);
        t.size = size;
        children.push(t);
      }
    }
    const g = Shape.group(children, cutLayer);
    g.name = loc('Schicht {n}', { n: it.L.index + 1 });
    A.doc.shapes.push(g); news.push(g);
    if (y + it.h > M.height) outside++;
    x += it.w + cfg.gap; rowH = Math.max(rowH, it.h);
  }
  A.setSel(news);
  A.commit(loc('Schichtmodell'));
  let msg = loc('{n} Schichten aus {file} erstellt', { n: news.length, file: fileName });
  if (outside) msg += ' – ' + loc('{n} Teile liegen außerhalb der Arbeitsfläche; mit „Nur ausgewählte Objekte ausgeben" in mehreren Durchgängen lasern.', { n: outside });
  toast(msg, outside ? 'err' : 'ok');
}

/* Rippen und Rückgrat als Gruppen (Umriss + Nummern) in Reihen auf die Arbeitsfläche legen */
function createRibParts(A, model, cfg, fileName) {
  if (!model.spine || !model.spine.length) return toast(loc('Das Rückgrat trifft das Modell nicht – Versatz ändern.'), 'err');
  const M = A.doc.machine, cutLayer = A.state.activeLayer;
  const label = (x, y, text, size) => { const t = Shape.text(x - size * 0.28 * text.length, y - size * 0.35, text, cfg.numberLayer); t.size = size; return t; };
  const items = model.ribs.map(r => ({ polys: r.polys, name: loc('Rippe {n}', { n: r.index + 1 }), texts: cfg.numbers ? (() => { const lp = labelPoint(r.polys); return lp ? [[lp.x, lp.y, String(r.index + 1), Math.max(2, Math.min(8, lp.room * 0.9))]] : []; })() : [] }));
  // Rückgrat: Nummer der Rippe unter jedem Schlitz
  items.unshift({ polys: model.spine, name: loc('Rückgrat'), texts: cfg.numbers ? model.ribs.map(r => [r.a, r.slotH - 5, String(r.index + 1), 3.5]) : [] });
  const news = [];
  let x = cfg.gap, y = cfg.gap, rowH = 0, outside = 0;
  for (const it of items.filter(i => i.polys.length)) {
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const p of it.polys) for (const q of p) { x0 = Math.min(x0, q.x); y0 = Math.min(y0, q.y); x1 = Math.max(x1, q.x); y1 = Math.max(y1, q.y); }
    const w = x1 - x0, hh = y1 - y0;
    if (x > cfg.gap && x + w > M.width - cfg.gap) { x = cfg.gap; y += rowH + cfg.gap; rowH = 0; }
    const dx = x - x0, dy = y - y0;
    const children = [Shape.path(it.polys.map(p => nodeSub(p.map(q => ({ x: q.x + dx, y: q.y + dy })), true)), cutLayer)];
    for (const [tx, ty, txt, size] of it.texts) children.push(label(tx + dx, ty + dy, txt, size));
    const g = Shape.group(children, cutLayer);
    g.name = it.name;
    A.doc.shapes.push(g); news.push(g);
    if (y + hh > M.height) outside++;
    x += w + cfg.gap; rowH = Math.max(rowH, hh);
  }
  A.setSel(news);
  A.commit(loc('Rippenmodell'));
  let msg = loc('{n} Rippen und ein Rückgrat aus {file} erstellt', { n: model.ribs.length, file: fileName });
  if (outside) msg += ' – ' + loc('{n} Teile liegen außerhalb der Arbeitsfläche; mit „Nur ausgewählte Objekte ausgeben" in mehreren Durchgängen lasern.', { n: outside });
  toast(msg, outside ? 'err' : 'ok');
}
