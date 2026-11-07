// scadui.js — Fenster „OpenSCAD-Code“: Editor mit Live-Vorschau, Parameter wie im OpenSCAD-Customizer,
// Ergebnis als Pfad auf die Arbeitsfläche. Die Form merkt sich Code und Parameter – Doppelklick öffnet
// sie wieder, die Lage auf der Arbeitsfläche bleibt erhalten.
import { h, modal, field, numInput, selectInput, checkbox, toast, fmtNum } from './ui.js';
import { loc } from './i18n.js';
import { Shape, nodeSub, shapePolys, uid, LAYER_COLORS } from './doc.js';
import { Mat } from './geom.js';
import { run, scadParams } from './scad.js';
import { FontStore, ensureFont, isBundled } from './font.js';

const App = () => window.App;

export const SCAD_EXAMPLES = () => [
  {
    name: loc('Schlüsselanhänger mit Text'), code: `/* [Key tag] */
// Text on the tag
label = "BeamSketch";
// Width in mm
width = 70; // [30:150]
height = 22; // [10:60]
corner = 5; // [0:15]
hole = 5; // [2:10]

$fn = 64;
difference() {
  offset(r = corner) offset(delta = -corner) square([width, height]);
  translate([corner + hole / 2 + 2, height / 2]) circle(d = hole);
}
// red = its own layer (e.g. engraving), the rest is cut
color("red") translate([width / 2 + hole, height / 2])
  text(label, size = height * 0.35, halign = "center", valign = "center");
`
  },
  {
    name: loc('Lochplatte'), code: `/* [Plate] */
width = 120; // [40:300]
depth = 80; // [40:300]
// Hole diameter
d = 5; // [2:20]
spacing = 15; // [8:40]
margin = 10; // [5:30]

difference() {
  square([width, depth]);
  for (x = [margin : spacing : width - margin], y = [margin : spacing : depth - margin])
    translate([x, y]) circle(d = d, $fn = 32);
}
`
  },
  {
    name: loc('Rosette'), code: `/* [Rosette] */
petals = 12; // [3:36]
radius = 40; // [10:100]
petal_width = 9; // [2:30]

$fn = 48;
module petal() hull() { circle(r = petal_width / 3); translate([radius, 0]) circle(r = petal_width / 2); }
difference() {
  union() for (i = [0 : petals - 1]) rotate(i * 360 / petals) petal();
  circle(r = radius / 5);
}
`
  },
  {
    name: loc('Seitenteil mit Fingerzinken'), code: `/* [Side panel] */
length = 120; // [40:300]
height = 60; // [20:200]
// Material thickness
t = 3; // [1:0.5:10]
finger = 10; // [4:30]

module fingers(l) {
  n = floor(l / finger / 2) * 2 + 1;     // odd count
  f = l / n;
  for (i = [1 : 2 : n - 1]) translate([i * f, 0]) square([f, t]);
}
difference() {
  square([length, height]);
  fingers(length);
  translate([0, height - t]) fingers(length);
}
`
  }
];

/* Text für OpenSCAD text(): über die Schriften von BeamSketch (OpenSCAD-Größe ≈ Höhe über der Grundlinie) */
function textProvider(pending) {
  return (str, o) => {
    const want = String(o.font || '').toLowerCase();
    const lib = FontStore.library.find(f => f.name.toLowerCase() === want);
    let font = lib ? lib.name : (FontStore.systemFonts.find(f => f.toLowerCase() === want) || 'Sans');
    if (lib && !FontStore.fonts.has(lib.name)) pending.add(lib.name);
    const sh = Shape.text(0, 0, str, 0);
    sh.font = font; sh.size = o.size / 0.72; sh.bold = !!o.bold; sh.italic = !!o.italic;
    sh.hspace = (o.spacing - 1) * o.size * 0.6;
    const polys = shapePolys(sh, App().ctxGeo).filter(p => p.closed && p.pts.length > 2).map(p => p.pts);
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const p of polys) for (const q of p) { x0 = Math.min(x0, q.x); y0 = Math.min(y0, q.y); x1 = Math.max(x1, q.x); y1 = Math.max(y1, q.y); }
    if (!isFinite(x0)) return [];
    const dx = o.halign === 'center' ? -(x0 + x1) / 2 : o.halign === 'right' ? -x1 : 0;   // links: ab dem Ursprung
    const dy = o.valign === 'center' ? -(y0 + y1) / 2 : o.valign === 'top' ? -y1 : o.valign === 'bottom' ? -y0 : 0;
    return polys.map(p => p.map(q => ({ x: q.x + dx, y: q.y + dy })));
  };
}

/* Code auswerten; fehlende mitgelieferte Schriften werden nachgeladen und dann noch einmal gerechnet */
export function evalScad(code, params, onFonts) {
  const pending = new Set();
  const r = run(code, { params, text: textProvider(pending) });
  if (pending.size && onFonts) Promise.all([...pending].map(n => ensureFont(n))).then(onFonts);
  return r;
}

const toSubpaths = polys => polys.map(p => nodeSub(p, true));

/* Farbe aus color() → nächstliegende Laser-Ebene; ohne Farbe die aktive Ebene */
function rgbOf(c) {
  try {
    const g = document.createElement('canvas').getContext('2d');
    g.fillStyle = '#000'; g.fillStyle = c;
    const m = /^#([0-9a-f]{6})$/i.exec(g.fillStyle);
    if (m) return [0, 2, 4].map(i => parseInt(m[1].slice(i, i + 2), 16));
    const r = /rgba?\(([^)]+)\)/.exec(g.fillStyle);
    return r ? r[1].split(',').slice(0, 3).map(Number) : null;
  } catch (e) { return null; }
}
function layerForColor(color, active, used) {
  if (!color) return active;
  const rgb = rgbOf(color);
  if (!rgb) return active;
  let best = active, bd = Infinity;
  LAYER_COLORS.forEach((hex, i) => {
    if (used.has(i) && used.get(i) !== color) return;      // eine Ebene je Farbe
    const q = [1, 3, 5].map(k => parseInt(hex.slice(k, k + 2), 16));
    const d = (q[0] - rgb[0]) ** 2 + (q[1] - rgb[1]) ** 2 + (q[2] - rgb[2]) ** 2;
    if (d < bd) { bd = d; best = i; }
  });
  return best;
}
/* Ergebnis als Formen: eine je Farbe, alle mit derselben Verschiebung und demselben Satz */
function partShapes(result, gen, transform, active, prev = new Map()) {
  const used = new Map([[active, null]]);
  for (const [c, L] of prev) used.set(L, c);
  return result.parts.map(part => {
    // beim Bearbeiten behält jede Farbe ihre bisherige Ebene (auch wenn sie von Hand geändert wurde)
    const L = prev.has(part.color || null) ? prev.get(part.color || null) : layerForColor(part.color, active, used);
    used.set(L, part.color);
    const sh = Shape.path(toSubpaths(part.polys), L);
    sh.name = 'OpenSCAD' + (part.color ? ' (' + part.color + ')' : '');
    sh.gen = gen; sh.scadColor = part.color || null; sh.transform = transform.slice();
    return sh;
  });
}

export function scadDialog(edit = null) {
  const A = App();
  const prev = edit && edit.gen ? edit.gen : (A.state.scadLast || null);
  const st = { code: prev ? prev.code : SCAD_EXAMPLES()[0].code, params: { ...(prev && prev.params || {}) }, result: null, error: null };
  const ta = h('textarea', {
    spellcheck: false, value: st.code,
    style: { width: '100%', height: '380px', fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace', fontSize: '12.5px', lineHeight: '1.45', tabSize: 2, whiteSpace: 'pre', resize: 'vertical', direction: 'ltr' },
    onkeydown: e => {
      e.stopPropagation();
      if (e.key === 'Tab') { e.preventDefault(); const s = ta.selectionStart; ta.setRangeText('  ', s, ta.selectionEnd, 'end'); schedule(); }
      if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') { e.preventDefault(); compute(); }
    },
    oninput: () => schedule()
  });
  ta.value = st.code;            // bei textarea setzt das Attribut den Inhalt nicht
  const out = h('div', { style: { fontFamily: 'ui-monospace, monospace', fontSize: '11.5px', maxHeight: '110px', overflow: 'auto', whiteSpace: 'pre-wrap', marginTop: '6px', direction: 'ltr' } });
  const cv = h('canvas', { width: 900, height: 700, style: { width: '100%', height: '320px', background: 'var(--bg)', border: '1px solid var(--line)', borderRadius: '8px' } });
  const info = h('small', { class: 'hint' });
  const paramBox = h('div', { style: { maxHeight: '220px', overflow: 'auto' } });
  let timer = null;
  const schedule = () => { clearTimeout(timer); timer = setTimeout(compute, 350); };

  let paramSig = null;
  const buildParams = (force) => {
    const ps = scadParams(st.code);
    const sig = JSON.stringify(ps);
    if (!force && sig === paramSig) return;
    paramSig = sig;
    paramBox.innerHTML = '';
    if (!ps.length) { paramBox.appendChild(h('small', { class: 'hint' }, loc('Keine Parameter – Zuweisungen oben in der Datei (z. B. width = 50; // [10:200]) erscheinen hier als Felder.'))); return; }
    let group = null;
    for (const p of ps) {
      if (p.group && p.group !== group) { group = p.group; paramBox.appendChild(h('h4', { class: 'sec', style: { margin: '6px 0 2px' } }, p.group)); }
      const val = Object.prototype.hasOwnProperty.call(st.params, p.name) ? st.params[p.name] : p.value;
      const set = v => { st.params[p.name] = v; compute(); };
      let input;
      if (p.type === 'bool') input = checkbox(val, set);
      else if (p.options) input = selectInput(String(val), p.options.map(o => ({ v: String(o.v), t: o.t })), v => set(p.type === 'number' ? +v : v));
      else if (p.type === 'number' && p.min !== undefined) {
        const num = numInput(val, p.step || 'any', v => { rng.value = v; set(v); });
        const rng = h('input', { type: 'range', min: p.min, max: p.max, step: p.step || ((p.max - p.min) / 100), value: val, oninput: () => { num.value = rng.value; set(+rng.value); } });
        input = h('div', { class: 'row', style: { gap: '6px' } }, rng, h('div', { style: { width: '80px' } }, num));
      } else if (p.type === 'number') input = numInput(val, 'any', set);
      else if (p.type === 'string') input = h('input', { type: 'text', value: val, onkeydown: e => e.stopPropagation(), oninput: e => { st.params[p.name] = e.target.value; schedule(); } });
      else input = h('input', { type: 'text', value: JSON.stringify(val), onkeydown: e => e.stopPropagation(), onchange: e => { try { const v = JSON.parse(e.target.value); if (Array.isArray(v)) set(v); } catch (err) { /* ungültig */ } } });
      paramBox.appendChild(h('div', { title: p.desc || '' }, field(p.desc ? `${p.name} – ${p.desc}` : p.name, input)));
    }
  };

  const draw = () => {
    const g = cv.getContext('2d'), W = cv.width, H = cv.height;
    g.clearRect(0, 0, W, H);
    const polys = st.result ? st.result.polys : [];
    if (!polys.length) return;
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const p of polys) for (const q of p) { x0 = Math.min(x0, q.x); y0 = Math.min(y0, q.y); x1 = Math.max(x1, q.x); y1 = Math.max(y1, q.y); }
    const s = Math.min((W - 40) / Math.max(x1 - x0, 1e-3), (H - 40) / Math.max(y1 - y0, 1e-3));
    const ox = (W - (x1 - x0) * s) / 2 - x0 * s, oy = (H + (y1 - y0) * s) / 2 + y0 * s;
    for (const part of st.result.parts) {
      g.beginPath();
      for (const p of part.polys) { p.forEach((q, i) => i ? g.lineTo(ox + q.x * s, oy - q.y * s) : g.moveTo(ox + q.x * s, oy - q.y * s)); g.closePath(); }
      const col = part.color || '#0e7f74';
      g.save(); g.globalAlpha = 0.18; g.fillStyle = col; g.fill('evenodd'); g.restore();
      g.lineWidth = 1.5; g.strokeStyle = col; g.stroke();
    }
  };

  const compute = () => {
    st.code = ta.value;
    buildParams();
    out.innerHTML = '';
    try {
      st.result = evalScad(st.code, st.params, () => { FontStore.cache.clear(); compute(); });
      st.error = null;
      const r = st.result;
      let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
      for (const p of r.polys) for (const q of p) { x0 = Math.min(x0, q.x); y0 = Math.min(y0, q.y); x1 = Math.max(x1, q.x); y1 = Math.max(y1, q.y); }
      info.textContent = r.polys.length
        ? loc('{n} Umrisse · {w} × {h} mm', { n: r.polys.length, w: fmtNum(Math.round((x1 - x0) * 10) / 10), h: fmtNum(Math.round((y1 - y0) * 10) / 10) }) + (r.has3d ? ' · ' + loc('3D-Teile als Draufsicht übernommen') : '')
        : loc('Kein Ergebnis – der Code erzeugt keine Fläche.');
      for (const w of r.warnings) out.appendChild(h('div', { style: { color: 'var(--warn, #b7791f)' } }, '⚠ ' + w));
      for (const e of r.echo) out.appendChild(h('div', { style: { color: 'var(--fg2)' } }, 'ECHO: ' + e));
    } catch (e) {
      st.result = null; st.error = e;
      info.textContent = '';
      out.appendChild(h('div', { style: { color: 'var(--err, #c0392b)', fontWeight: 600 } }, '✖ ' + (e.line ? loc('Zeile {n}: ', { n: e.line }) : '') + e.message));
    }
    draw();
  };

  const loadFile = () => {
    const inp = h('input', { type: 'file', accept: '.scad,text/plain', style: { display: 'none' } });
    inp.onchange = async () => { const f = inp.files[0]; if (!f) return; ta.value = await f.text(); st.params = {}; st.code = ta.value; buildParams(true); compute(); };
    document.body.appendChild(inp); inp.click(); setTimeout(() => inp.remove(), 1000);
  };
  const saveFile = () => {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([ta.value], { type: 'text/plain' })); a.download = 'beamsketch.scad';
    document.body.appendChild(a); a.click(); a.remove();
  };
  const examples = selectInput('', [{ v: '', t: loc('Beispiel laden …') }, ...SCAD_EXAMPLES().map((x, i) => ({ v: String(i), t: x.name }))], v => {
    if (v === '') return;
    ta.value = SCAD_EXAMPLES()[+v].code; st.params = {}; st.code = ta.value; buildParams(true); compute();
  });

  const body = h('div', { style: { display: 'grid', gridTemplateColumns: 'minmax(0, 1.1fr) minmax(0, 1fr)', gap: '12px' } },
    h('div', {},
      h('div', { class: 'row', style: { gap: '6px', marginBottom: '6px', flexWrap: 'wrap' } },
        h('div', { style: { minWidth: '190px' } }, examples),
        h('button', { class: 'tbtn', onclick: loadFile }, loc('.scad öffnen …')),
        h('button', { class: 'tbtn', onclick: saveFile }, loc('Als .scad speichern')),
        h('button', { class: 'tbtn', title: 'Ctrl+Enter', onclick: () => compute() }, loc('▶ Rechnen'))),
      ta, out),
    h('div', {},
      cv, info,
      h('h4', { class: 'sec' }, loc('Parameter')), paramBox,
      h('small', { class: 'hint', style: { display: 'block', marginTop: '6px' } }, loc('Unterstützt die OpenSCAD-Sprache mit 2D-Formen, Transformationen, offset, hull und Booleschen Operationen. 3D-Körper werden als Draufsicht übernommen. include/use und import gehen nicht.'))));

  modal(loc('OpenSCAD-Code'), body, [
    { label: loc('Abbrechen') },
    {
      label: edit ? loc('Übernehmen') : loc('Einfügen'), primary: true, click: () => {
        compute();
        if (st.error) { toast(loc('Der Code enthält einen Fehler'), 'err'); return false; }
        if (!st.result || !st.result.polys.length) { toast(loc('Kein Ergebnis – der Code erzeugt keine Fläche.'), 'err'); return false; }
        const gen = { kind: 'scad', code: st.code, params: { ...st.params }, set: (edit && edit.gen && edit.gen.set) || uid() };
        A.state.scadLast = gen;
        if (edit) {
          // alle Teile desselben Satzes ersetzen, Lage und Ebene des bearbeiteten Teils bleiben
          const old = A.doc.shapes.filter(x => x === edit || (x.gen && x.gen.kind === 'scad' && gen.set && x.gen.set === gen.set));
          const at = A.doc.shapes.indexOf(old[0]);
          const prev = new Map(old.map(x => [x.scadColor || null, x.layer]));
          const base = prev.has(null) ? prev.get(null) : edit.layer;
          const news = partShapes(st.result, gen, edit.transform, base, prev);
          A.doc.shapes = A.doc.shapes.filter(x => !old.includes(x));
          A.doc.shapes.splice(Math.max(0, at), 0, ...news);
          A.setSel(news); A.commit(loc('OpenSCAD-Code'));
        } else {
          // ganz auf die Arbeitsfläche: links unten mit 10 mm Rand, sonst bleiben die OpenSCAD-Koordinaten
          let x0 = Infinity, y0 = Infinity;
          for (const p of st.result.polys) for (const q of p) { x0 = Math.min(x0, q.x); y0 = Math.min(y0, q.y); }
          const dx = x0 < 0 ? 10 - x0 : 0, dy = y0 < 0 ? 10 - y0 : 0;
          const news = partShapes(st.result, gen, Mat.translate(dx, dy), A.state.activeLayer);
          A.doc.shapes.push(...news); A.setSel(news); A.commit(loc('OpenSCAD-Code'));
          toast(news.length > 1
            ? loc('{n} Umrisse aus OpenSCAD eingefügt', { n: st.result.polys.length }) + ' · ' + loc('{k} Farben auf {k} Ebenen', { k: news.length })
            : loc('{n} Umrisse aus OpenSCAD eingefügt', { n: st.result.polys.length }), 'ok');
        }
      }
    }
  ], { width: '1180px', sticky: true });
  compute();
  setTimeout(() => ta.focus(), 30);
}

/* .scad-Datei öffnen: gleich im Fenster */
export async function openScadFile(file) {
  App().state.scadLast = { kind: 'scad', code: await file.text(), params: {} };
  scadDialog();
}
