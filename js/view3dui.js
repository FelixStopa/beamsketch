// view3dui.js — Fenster „3D-Ansicht": zeigt Baugruppen aus dem Teile-Generator zusammengebaut und alle
// übrigen geschlossenen Formen als Platten der gewählten Höhe, mit Materialoptik, Auseinanderziehen,
// PNG-Export und STL-Export (z. B. für den 3D-Druck).
import { h, modal, field, numInput, selectInput, slider, toast } from './ui.js';
import { loc } from './i18n.js';
import { shapePolys } from './doc.js';
import { View3D, prismMesh } from './view3d.js';
import { exportSTL } from './mesh.js';
import { buildScene, assemblyPlates } from './assembly.js';

const App = () => window.App;

// Oberfläche und Schnittkante (Holz an der Kante dunkel verkohlt, Acryl poliert)
const MATERIALS = () => ({
  poplar: { t: loc('Pappelsperrholz'), top: [0.9, 0.79, 0.6], side: [0.42, 0.3, 0.18] },
  birch: { t: loc('Birkensperrholz'), top: [0.93, 0.85, 0.7], side: [0.45, 0.33, 0.2] },
  beech: { t: loc('Buche'), top: [0.86, 0.66, 0.47], side: [0.4, 0.27, 0.16] },
  walnut: { t: loc('Nussbaum'), top: [0.45, 0.31, 0.22], side: [0.22, 0.14, 0.09] },
  mdf: { t: 'MDF', top: [0.74, 0.6, 0.45], side: [0.3, 0.22, 0.15] },
  cardboard: { t: loc('Karton'), top: [0.8, 0.68, 0.5], side: [0.55, 0.43, 0.3] },
  acrylClear: { t: loc('Acryl klar'), top: [0.8, 0.9, 0.95], side: [0.65, 0.82, 0.9] },
  acrylBlack: { t: loc('Acryl schwarz'), top: [0.12, 0.12, 0.13], side: [0.25, 0.25, 0.27] },
  acrylRed: { t: loc('Acryl rot'), top: [0.82, 0.12, 0.12], side: [0.95, 0.3, 0.3] },
  aluminium: { t: loc('Aluminium eloxiert'), top: [0.72, 0.74, 0.78], side: [0.85, 0.86, 0.88] },
  slate: { t: loc('Schiefer'), top: [0.25, 0.27, 0.3], side: [0.35, 0.37, 0.4] }
});

export function view3dDialog(opts = {}) {
  const A = App();
  const usable = s => !s.hidden && !(A.doc.layers[s.layer] || {}).isTool;
  const list = (A.state.selection.length ? A.state.selection : A.doc.shapes).filter(usable);
  // generierte Sätze (ganze Baugruppe, auch wenn nur ein Teil gewählt ist) und übrige Formen
  const sets = new Map(), flat = [];
  for (const s of list) {
    if (s.gen && s.gen.set && assemblyPlates(s.gen.kind, s.gen.cfg)) { if (!sets.has(s.gen.set)) sets.set(s.gen.set, { kind: s.gen.kind, cfg: s.gen.cfg }); continue; }
    const polys = shapePolys(s, A.ctxGeo).filter(p => p.closed && p.pts.length >= 3).map(p => p.pts);
    if (polys.length) flat.push({ polys, layer: s.layer });
  }
  if (!sets.size && !flat.length) return toast(loc('Keine geschlossenen Formen für die 3D-Ansicht'), 'err');
  const cfg = Object.assign({ material: 'poplar', t: 3, explode: 0 }, A.state.view3dCfg || {});
  cfg.layerH = { ...(cfg.layerH || {}) };            // Höhe je Ebene (fehlt = cfg.t)
  const layersUsed = [...new Set(flat.map(f => f.layer))].sort((a, b) => a - b);
  const heightOf = L => cfg.layerH[L] ?? cfg.t;
  const canvas = h('canvas', { style: { width: '100%', height: '460px', borderRadius: '8px', border: '1px solid var(--line)', cursor: 'grab', touchAction: 'none' } });
  const info = h('div', { class: 'hint' });
  let view = null, scene = [];

  const apply = () => {
    A.state.view3dCfg = { ...cfg };
    const mat = MATERIALS()[cfg.material] || MATERIALS().poplar;
    scene = buildScene([...sets.values()], flat.map(f => ({ polys: f.polys, t: heightOf(f.layer) })), cfg.t);
    // Auseinanderziehen: jede Platte vom Mittelpunkt ihrer Baugruppe weg
    let cx = 0, cy = 0, cz = 0, n = 0;
    const centers = scene.map(pl => {
      let x = 0, y = 0, z = 0, k = 0;
      for (const p of pl.polys[0] || []) { const q = pl.map(p.x, p.y, (pl.z0 + pl.z1) / 2); x += q[0]; y += q[1]; z += q[2]; k++; }
      const c = k ? [x / k, y / k, z / k] : [0, 0, 0];
      cx += c[0]; cy += c[1]; cz += c[2]; n++;
      return c;
    });
    const C = [cx / n, cy / n, cz / n];
    const parts = scene.map((pl, i) => {
      const off = centers[i].map((v, j) => (v - C[j]) * cfg.explode / 10);
      const m = pl.map;
      return { ...pl, color: mat.top, sideColor: mat.side, map: (u, v, w) => { const p = m(u, v, w); return [p[0] + off[0], p[1] + off[1], p[2] + off[2]]; } };
    });
    if (view && view.ok) view.setParts(parts);
    info.textContent = loc('{a} Baugruppen, {f} flache Teile', { a: sets.size, f: flat.length }) + ' · ' + loc('Maus ziehen = drehen, Rad = zoomen, Shift + ziehen = verschieben');
  };
  const matOpts = Object.entries(MATERIALS()).map(([v, m]) => ({ v, t: m.t }));
  const controls = h('div', { class: 'row', style: { gap: '8px', flexWrap: 'wrap', alignItems: 'end', marginTop: '6px' } },
    ...[['3d', '3D'], ['top', loc('Oben')], ['front', loc('Vorne')]].map(([v, t]) => h('button', { class: 'tbtn', onclick: () => view && view.setView(v) }, t)),
    h('div', { style: { minWidth: '160px' } }, field(loc('Material'), selectInput(cfg.material, matOpts, v => { cfg.material = v; apply(); }))),
    layersUsed.length === 1
      ? h('div', { style: { width: '170px' } }, field(loc('Höhe flacher Teile mm'), numInput(heightOf(layersUsed[0]), 0.5, v => { cfg.t = Math.max(0.2, v); if (layersUsed.length) cfg.layerH[layersUsed[0]] = cfg.t; apply(); })))
      : null,
    h('div', { style: { flex: 1, minWidth: '200px' } }, slider(loc('Auseinanderziehen'), cfg.explode, 0, 20, 0.5, v => { cfg.explode = v; apply(); })));
  // mehrere Ebenen: eigene Höhe je Ebene (z. B. Platte 3 mm, Schrift 5 mm – die Schrift steht 2 mm hervor)
  const perLayer = layersUsed.length > 1 ? h('div', { class: 'row', style: { gap: '10px', flexWrap: 'wrap', alignItems: 'end', marginTop: '6px' } },
    h('span', { class: 'tag' }, loc('Höhe je Ebene mm')),
    ...layersUsed.map(L => {
      const lay = A.doc.layers[L] || {};
      return h('div', { style: { display: 'flex', alignItems: 'center', gap: '5px' } },
        h('span', { style: { width: '14px', height: '14px', borderRadius: '3px', background: lay.color || '#888', display: 'inline-block' } }),
        h('small', {}, String(L + 1).padStart(2, '0') + (lay.name ? ' ' + lay.name : '')),
        h('div', { style: { width: '80px' } }, numInput(heightOf(L), 0.5, v => { cfg.layerH[L] = Math.max(0.2, v); apply(); })));
    })) : null;
  modal(loc('3D-Ansicht'), h('div', {}, canvas, controls, perLayer, info), [
    {
      label: loc('Bild speichern …'), keep: true, click: () => {
        if (!view || !view.ok) return false;
        const a = document.createElement('a');
        a.href = view.snapshot(); a.download = 'beamsketch-3d.png';
        document.body.appendChild(a); a.click(); a.remove();
        return false;
      }
    },
    {
      label: loc('Als STL herunterladen'), keep: true, click: () => {
        // ohne Auseinanderziehen: die Teile liegen so, wie sie zusammengehören
        const mesh = prismMesh(scene);
        if (!mesh.pos.length) { toast(loc('Keine geschlossenen Formen für die 3D-Ansicht'), 'err'); return false; }
        const blob = new Blob([exportSTL(mesh.pos, 'BeamSketch')], { type: 'model/stl' });
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob); a.download = (opts.name || 'beamsketch') + '.stl';
        document.body.appendChild(a); a.click(); a.remove();
        setTimeout(() => URL.revokeObjectURL(a.href), 5000);
        toast(loc('STL gespeichert: {n} Dreiecke', { n: mesh.pos.length / 9 }), 'ok');
        return false;
      }
    },
    { label: loc('Schließen'), primary: true }
  ], { width: '980px' });
  view = new View3D(canvas);
  if (!view.ok) canvas.replaceWith(h('div', { class: 'hint' }, loc('3D-Vorschau nicht verfügbar (WebGL ist im Browser ausgeschaltet).')));
  apply();
}
