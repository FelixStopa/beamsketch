// features.js — Werkzeug-Dialoge: Box-Generator, Flexscharnier, QR-/Barcode, Text auf Pfad,
// Serientext, Automatisch anordnen, Testmuster, Undo-Verlauf, Bild-Hintergrund entfernen.
// Nutzt das globale App-Objekt aus main.js (App.doc, App.commit, App.setSel …).
import { h, modal, field, numInput, selectInput, checkbox, toast, speedInput, dockPanel, slider } from './ui.js';
import { loadImage, invalidateImagePreview } from './raster.js';
import { invalidateAll } from './render.js';
import { loc } from './i18n.js';
import { Shape, nodeSub, shapePolys, shapesBBox, removeShape, uid, walk, layerNo } from './doc.js';
import { locale, lang } from './i18n.js';
import { textSubpaths, charAdvances } from './font.js';
import { Mat } from './geom.js';
import { boxParts, hingeLines } from './generators.js';
import { qrEncode, code128Widths } from './qrcode.js';
import { speedUnit } from './units.js';

const App = () => window.App;

/* Teile zeilenweise ab (x0,y0) auf der Arbeitsfläche verteilen.
   items: [{ w, h, place(dx, dy) }] – place verschiebt das Teil an seine Stelle */
function layoutRows(items, gap = 5, x0 = 10, y0 = 10) {
  const M = App().doc.machine;
  let x = x0, y = y0, rowH = 0;
  for (const it of items) {
    if (x > x0 && x + it.w > M.width - 5) { x = x0; y += rowH + gap; rowH = 0; }
    it.place(x, y);
    x += it.w + gap; rowH = Math.max(rowH, it.h);
  }
}
/* Mittelpunkt des sichtbaren Bereichs (bzw. der Arbeitsfläche, falls außerhalb) */
export function viewCenter() {
  const A = App(), cv = document.getElementById('cv');
  const w = A.view.toWorld({ x: cv.clientWidth / 2, y: cv.clientHeight / 2 }, cv.clientHeight);
  const M = A.doc.machine;
  if (w.x < 0 || w.y < 0 || w.x > M.width || w.y > M.height) return { x: M.width / 2, y: M.height / 2 };
  return w;
}
const warnLineLayer = () => {
  const L = App().doc.layers[App().state.activeLayer];
  if (L && L.mode === 'line') toast(loc('Hinweis: Ebene {n} steht auf „Linie" – zum Gravieren auf „Füllen" stellen.', { n: layerNo(L.index) }), 'err');
};

/* Umriss aus einem Raster dunkler Zellen: gemeinsame Kanten fallen weg, der Rest wird
   zu geschlossenen Polygonen verbunden (mit Löchern). grid[r][c], Zeile 0 = oben. */
export function gridOutline(grid, cell, x0, y0) {
  const R = grid.length, C = grid[0].length;
  const edges = new Map();   // "x,y" → [{x,y}] ausgehende Kanten (Gitterpunkte, y nach oben)
  const k = (x, y) => x + ',' + y;
  const add = (ax, ay, bx, by) => {
    const rk = k(bx, by), list = edges.get(rk);
    const i = list ? list.findIndex(e => e.x === ax && e.y === ay) : -1;
    if (i >= 0) { list.splice(i, 1); return; }          // Gegenkante vorhanden → innen, beide weg
    if (!edges.has(k(ax, ay))) edges.set(k(ax, ay), []);
    edges.get(k(ax, ay)).push({ x: bx, y: by });
  };
  for (let r = 0; r < R; r++) for (let c = 0; c < C; c++) if (grid[r][c]) {
    const x = c, y = R - 1 - r;      // linke untere Ecke der Zelle, gegen den Uhrzeigersinn
    add(x, y, x + 1, y); add(x + 1, y, x + 1, y + 1); add(x + 1, y + 1, x, y + 1); add(x, y + 1, x, y);
  }
  const polys = [];
  for (const [sk, list] of edges) {
    while (list.length) {
      const [sx, sy] = sk.split(',').map(Number);
      const loop = [{ x: sx, y: sy }];
      let px = sx, py = sy, cur = list.shift(), dx = cur.x - px, dy = cur.y - py, guard = 0;
      while (!(cur.x === sx && cur.y === sy) && guard++ < 1e6) {
        loop.push({ x: cur.x, y: cur.y });
        const out = edges.get(k(cur.x, cur.y));
        // bei mehreren Möglichkeiten (Ecken berühren sich) links abbiegen → Zellen bleiben getrennt
        let bi = 0, bs = -Infinity;
        out.forEach((e, i) => { const ex = e.x - cur.x, ey = e.y - cur.y; const s = dx * ey - dy * ex; if (s > bs) { bs = s; bi = i; } });
        const nx = out.splice(bi, 1)[0];
        dx = nx.x - cur.x; dy = nx.y - cur.y; cur = nx;
      }
      // Punkte auf geraden Kanten entfernen
      const simp = loop.filter((p, i) => {
        const a = loop[(i - 1 + loop.length) % loop.length], b = loop[(i + 1) % loop.length];
        return (p.x - a.x) * (b.y - p.y) - (p.y - a.y) * (b.x - p.x) !== 0;
      });
      polys.push(simp.map(p => ({ x: x0 + p.x * cell, y: y0 + p.y * cell })));
    }
  }
  return polys;
}

/* ============ Text auf Pfad ============
   Jeder Buchstabe wird einzeln erzeugt und an seiner Stelle entlang des Pfads gedreht.
   Pfad: Kreis um die Textmitte oder die erste Kontur eines zweiten ausgewählten Objekts. */
function polyWalker(pts, closed) {
  const P = closed ? [...pts, pts[0]] : pts, cum = [0];
  for (let i = 1; i < P.length; i++) cum.push(cum[i - 1] + Math.hypot(P[i].x - P[i - 1].x, P[i].y - P[i - 1].y));
  const L = cum[cum.length - 1];
  const at = s => {
    if (closed) s = ((s % L) + L) % L; else s = Math.max(0, Math.min(L, s));
    let i = 1; while (i < cum.length - 1 && cum[i] < s) i++;
    const a = P[i - 1], b = P[i], t = (s - cum[i - 1]) / Math.max(1e-9, cum[i] - cum[i - 1]);
    return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t, ang: Math.atan2(b.y - a.y, b.x - a.x) };
  };
  return { L, at };
}
export function textOnPath(t, walker, cfg) {
  const sf = Mat.scaleFactor(t.transform) || 1;
  const base = { ...t, size: t.size * sf, hspace: (t.hspace || 0) * sf, align: 'left' };
  const chars = [...String(t.text).split('\n')[0]];
  const adv = charAdvances(base);
  const total = adv.reduce((a, b) => a + b, 0);
  let s = (walker.mid ?? walker.L / 2) + (cfg.center - 50) / 100 * walker.L - total / 2;
  const subs = [];
  chars.forEach((ch, i) => {
    const w = adv[i];
    if (ch.trim()) {
      const g = textSubpaths({ ...base, text: ch });
      const p = walker.at(s + w / 2), c = Math.cos(p.ang), sn = Math.sin(p.ang);
      const tr = q => q && { x: p.x + (q.x - w / 2) * c - (q.y + cfg.offset) * sn, y: p.y + (q.x - w / 2) * sn + (q.y + cfg.offset) * c };
      for (const sp of g) subs.push({ closed: sp.closed, nodes: sp.nodes.map(n => ({ ...tr(n), in: tr(n.in), out: tr(n.out) })) });
    }
    s += w;
  });
  return { subs, total };
}
export function textPathDialog() {
  const A = App();
  const sel = A.state.selection;
  const t = sel.find(s => s.type === 'text');
  if (!t) return toast(loc('Bitte einen Text auswählen (und optional eine Kontur als Pfad)'), 'err');
  const other = sel.find(s => s !== t && s.type !== 'text' && s.type !== 'image');
  const b = shapesBBox([t], A.ctxGeo), cx = (b.x0 + b.x1) / 2, cy = (b.y0 + b.y1) / 2;
  const sf = Mat.scaleFactor(t.transform) || 1;
  const cfg = { mode: other ? 'path' : 'circle', radius: Math.max(10, Math.round((b.x1 - b.x0) / 2)), pos: 'top', center: 50, offset: 0, reverse: false, circle: true, keep: false };
  const body = h('div');
  const rebuild = () => {
    body.innerHTML = '';
    body.appendChild(h('div', { class: 'grid2' },
      field(loc('Pfad'), selectInput(cfg.mode, [{ v: 'circle', t: loc('Kreis') }, ...(other ? [{ v: 'path', t: loc('Ausgewählte Kontur') }] : [])], v => { cfg.mode = v; rebuild(); })),
      cfg.mode === 'circle'
        ? field(loc('Position'), selectInput(cfg.pos, [{ v: 'top', t: loc('Oben (außen)') }, { v: 'bottom', t: loc('Unten (lesbar)') }], v => { cfg.pos = v; cfg.offset = v === 'bottom' ? -Math.round(t.size * sf * 0.72 * 10) / 10 : 0; rebuild(); }))
        : field(loc('Mitte bei %'), numInput(cfg.center, 1, v => cfg.center = v)),
      cfg.mode === 'circle' ? field(loc('Radius mm'), numInput(cfg.radius, 1, v => cfg.radius = Math.max(1, v))) : checkbox(cfg.reverse, v => cfg.reverse = v, loc('Richtung umkehren')),
      field(loc('Abstand zur Linie mm'), numInput(cfg.offset, 0.5, v => cfg.offset = v)),
      cfg.mode === 'circle' ? checkbox(cfg.circle, v => cfg.circle = v, loc('Kreis mit einzeichnen')) : null,
      checkbox(cfg.keep, v => cfg.keep = v, loc('Originaltext behalten'))));
    body.appendChild(h('small', { class: 'hint' }, loc('Der Text wird dabei in Pfade umgewandelt. Mit „Originaltext behalten" bleibt der normale Text zusätzlich stehen, um ihn später zu ändern und neu anzuwenden.')));
  };
  rebuild();
  modal(loc('Text auf Pfad'), body, [{ label: loc('Abbrechen') }, {
    label: loc('Anwenden'), primary: true, click: () => {
      let walker, news = [];
      if (cfg.mode === 'circle') {
        const n = 720, r = cfg.radius, top = cfg.pos === 'top';
        // oben: im Uhrzeigersinn ab unten (Textmitte oben); unten: gegen den Uhrzeigersinn ab oben
        const pts = Array.from({ length: n }, (_, i) => {
          const a = (top ? 270 - 360 * i / n : 90 + 360 * i / n) * Math.PI / 180;
          return { x: cx + Math.cos(a) * r, y: cy + Math.sin(a) * r };
        });
        walker = polyWalker(pts, true);
        cfg.center = 50;
        if (cfg.circle) { const c = Shape.ellipse(cx, cy, r, r, t.layer); news.push(c); }
      } else {
        const polys = shapePolys(other, A.ctxGeo).filter(p => p.pts.length > 1);
        if (!polys.length) { toast(loc('Die Kontur ist leer'), 'err'); return false; }
        let pts = polys[0].pts.slice();
        const closed = polys[0].closed;
        if (closed) {
          // Textmitte an den höchsten Punkt, Leserichtung dort von links nach rechts
          let top = 0; pts.forEach((q, i) => { if (q.y > pts[top].y) top = i; });
          pts = pts.slice(top).concat(pts.slice(0, top));
          const nx = pts[1 % pts.length], pv = pts[pts.length - 1];
          if (nx.x - pv.x < 0) pts = [pts[0], ...pts.slice(1).reverse()];
        } else if (pts[pts.length - 1].x < pts[0].x) pts.reverse();   // offener Pfad: nicht auf dem Kopf
        if (cfg.reverse) pts = closed ? [pts[0], ...pts.slice(1).reverse()] : pts.reverse();
        walker = polyWalker(pts, closed);
        if (closed) walker.mid = 0;
      }
      const { subs, total } = textOnPath(t, walker, cfg);
      if (!subs.length) { toast(loc('Kein Text zum Anordnen'), 'err'); return false; }
      if (total > walker.L) toast(loc('Der Text ist länger als der Pfad – er überlappt sich.'), 'err');
      const sh = Shape.path(subs, t.layer); sh.name = loc('Text auf Pfad') + ': ' + String(t.text).slice(0, 24);
      news.unshift(sh);
      if (!cfg.keep) removeShape(A.doc.shapes, t);
      A.doc.shapes.push(...news); A.setSel(news); A.commit('Text auf Pfad');
    }
  }], { width: '520px' });
}

/* ============ Serientext ============
   Vorlage (ausgewählte Objekte) mit Platzhaltern im Text wird vervielfältigt:
   {n} fortlaufende Nummer, {datum}/{date} heutiges Datum, {Spalte} bzw. {1},{2}… aus einer CSV-Liste. */
export function parseCSV(text) {
  const lines = String(text).replace(/\r/g, '').split('\n').filter(l => l.trim());
  if (!lines.length) return { head: [], rows: [] };
  const delim = [';', '\t', ','].sort((a, b) => lines[0].split(b).length - lines[0].split(a).length)[0];
  const split = l => {
    const out = []; let cur = '', q = false;
    for (let i = 0; i < l.length; i++) {
      const ch = l[i];
      if (ch === '"') { if (q && l[i + 1] === '"') { cur += '"'; i++; } else q = !q; }
      else if (ch === delim && !q) { out.push(cur.trim()); cur = ''; }
      else cur += ch;
    }
    out.push(cur.trim()); return out;
  };
  const [head, ...rows] = lines.map(split);
  return { head, rows };
}
export function fillTemplate(str, vals) {
  return String(str).replace(/\{([^{}]+)\}/g, (m, k) => (k in vals ? vals[k] : m));
}
export function serialDialog() {
  const A = App();
  const tpl = A.state.selection.slice();
  if (!tpl.some(s => { let f = false; walk([s], x => { if (x.type === 'text') f = true; }); return f; }))
    return toast(loc('Bitte die Vorlage auswählen – mindestens ein Text mit Platzhalter wie {p1} oder {p2}', { p1: '{n}', p2: '{Name}' }), 'err');
  const b = shapesBBox(tpl, A.ctxGeo);
  const cfg = Object.assign({ src: 'num', start: 1, count: 10, step: 1, digits: 3, csv: '', cols: 5, gx: 3, gy: 3, keep: false }, A.state.serialCfg || {}, { csv: (A.state.serialCfg || {}).csv || '' });
  const info = h('small', { class: 'hint' });
  const records = () => {
    const today = new Date().toLocaleDateString(locale);
    if (cfg.src === 'num') return Array.from({ length: Math.max(0, cfg.count | 0) }, (_, i) => {
      const n = String(cfg.start + i * cfg.step).padStart(cfg.digits, '0');
      return { n, nr: n, '#': n, datum: today, date: today };
    });
    const { head, rows } = parseCSV(cfg.csv);
    return rows.map((r, i) => {
      const v = { n: String(i + 1), nr: String(i + 1), datum: today, date: today };
      head.forEach((hd, j) => { v[hd] = r[j] ?? ''; v[String(j + 1)] = r[j] ?? ''; });
      return v;
    });
  };
  const body = h('div');
  const upd = () => {
    const rec = records();
    info.textContent = loc('{n} Kopien', { n: rec.length }) + (rec[0] ? ' · ' + loc('Beispiel: {t}', { t: texts(rec[0]).join(' / ').slice(0, 80) }) : '');
  };
  const texts = v => { const out = []; walk(tpl, x => { if (x.type === 'text') out.push(fillTemplate(x.text, v)); }); return out; };
  const fileBtn = h('input', { type: 'file', accept: '.csv,.txt', style: { display: 'none' }, onchange: async e => {
    const f = e.target.files[0]; if (!f) return; cfg.csv = await f.text(); rebuild(); } });
  const rebuild = () => {
    body.innerHTML = '';
    body.appendChild(field(loc('Quelle'), selectInput(cfg.src, [{ v: 'num', t: loc('Fortlaufende Nummern') }, { v: 'csv', t: loc('Liste / CSV') }], v => { cfg.src = v; rebuild(); })));
    if (cfg.src === 'num') body.appendChild(h('div', { class: 'grid2' },
      field(loc('Startwert'), numInput(cfg.start, 1, v => { cfg.start = v; upd(); })),
      field(loc('Anzahl'), numInput(cfg.count, 1, v => { cfg.count = Math.max(1, Math.min(1000, v | 0)); upd(); })),
      field(loc('Schrittweite'), numInput(cfg.step, 1, v => { cfg.step = v; upd(); })),
      field(loc('Stellen'), numInput(cfg.digits, 1, v => { cfg.digits = Math.max(1, Math.min(10, v | 0)); upd(); }))));
    else {
      const ta = h('textarea', { rows: 6, placeholder: 'Name;Ort\nAnna;Berlin\nBen;Hamburg', onkeydown: e => e.stopPropagation(), oninput: e => { cfg.csv = e.target.value; upd(); } });
      ta.value = cfg.csv;
      body.appendChild(ta);
      body.appendChild(h('div', { class: 'row', style: { margin: '4px 0' } },
        h('button', { class: 'tbtn', onclick: () => fileBtn.click() }, loc('CSV-Datei laden…')),
        h('small', { class: 'hint' }, loc('Erste Zeile = Spaltennamen. Trennzeichen ; , oder Tab.'))));
    }
    body.appendChild(h('div', { class: 'grid3', style: { marginTop: '6px' } },
      field(loc('Spalten'), numInput(cfg.cols, 1, v => cfg.cols = Math.max(1, v | 0))),
      field(loc('Abstand X'), numInput(cfg.gx, 1, v => cfg.gx = v)),
      field(loc('Abstand Y'), numInput(cfg.gy, 1, v => cfg.gy = v))));
    body.appendChild(checkbox(cfg.keep, v => cfg.keep = v, loc('Vorlage behalten')));
    body.appendChild(h('small', { class: 'hint' }, loc('Platzhalter im Text: {p1} = Nummer, {p2} = heutiges Datum, {p3} oder {p4}, {p5} … = Werte aus der Liste.',
      { p1: '{n}', p2: lang === 'de' ? '{datum}' : '{date}', p3: '{' + loc('Spaltenname') + '}', p4: '{1}', p5: '{2}' })));
    body.appendChild(info); body.appendChild(fileBtn);
    upd();
  };
  rebuild();
  modal(loc('Serientext'), body, [{ label: loc('Abbrechen') }, {
    label: loc('Erstellen'), primary: true, click: () => {
      const rec = records();
      if (!rec.length) { toast(loc('Keine Einträge'), 'err'); return false; }
      A.state.serialCfg = { ...cfg };
      const w = b.x1 - b.x0, hh = b.y1 - b.y0, news = [];
      const reid = s => { s.id = uid(); if (s.children) s.children.forEach(reid); };
      rec.forEach((v, i) => {
        const dx = (i % cfg.cols) * (w + cfg.gx), dy = -Math.floor(i / cfg.cols) * (hh + cfg.gy);
        for (const s of tpl) {
          const c = JSON.parse(JSON.stringify(s)); reid(c);
          c.transform = Mat.mul(c.transform, Mat.translate(dx, dy));
          walk([c], x => { if (x.type === 'text') x.text = fillTemplate(x.text, v); });
          A.doc.shapes.push(c); news.push(c);
        }
      });
      if (!cfg.keep) for (const s of tpl) removeShape(A.doc.shapes, s);
      A.setSel(news); A.commit('Serientext');
      toast(loc('{n} Kopien erstellt', { n: rec.length }), 'ok');
    }
  }], { width: '540px' });
}

/* ============ Automatisch anordnen (Nesting) ============
   Regal-Verfahren über die Umrissrechtecke: Teile nach Höhe sortiert in Reihen von
   vorne links (Maschinennullpunkt) nach rechts, dann die nächste Reihe dahinter. */
export function nestPlan(sizes, W, H, gap, margin, rotate) {
  const items = sizes.map((s, i) => {
    let w = s.w, hh = s.h, rot = false;
    // flach legen (lange Seite waagerecht), wenn erlaubt – oder drehen, wenn es sonst nicht passt
    if (rotate && (hh > w || w > W - 2 * margin) && hh <= W - 2 * margin) { [w, hh] = [hh, w]; rot = true; }
    return { i, w, h: hh, rot };
  }).sort((a, b) => b.h - a.h || b.w - a.w);
  let x = margin, y = margin, rowH = 0, overflow = 0;
  const pos = [];
  for (const it of items) {
    if (x > margin && x + it.w > W - margin) { x = margin; y += rowH + gap; rowH = 0; }
    if (y + it.h > H - margin) overflow++;
    pos[it.i] = { x, y, rot: it.rot, w: it.w, h: it.h };
    x += it.w + gap; rowH = Math.max(rowH, it.h);
  }
  return { pos, overflow, used: { w: W, h: y + rowH } };
}
export function nestDialog() {
  const A = App();
  const list = A.state.selection.length ? A.state.selection.slice() : A.doc.shapes.filter(s => !s.hidden && !s.locked && !(A.doc.layers[s.layer] || {}).isTool);
  if (!list.length) return toast(loc('Nichts zum Anordnen'), 'err');
  const cfg = Object.assign({ gap: 3, margin: 5, rotate: true }, A.state.nestCfg || {});
  const body = h('div', {},
    h('div', { class: 'grid2' },
      field(loc('Abstand mm'), numInput(cfg.gap, 0.5, v => cfg.gap = Math.max(0, v))),
      field(loc('Rand mm'), numInput(cfg.margin, 1, v => cfg.margin = Math.max(0, v))),
      checkbox(cfg.rotate, v => cfg.rotate = v, loc('Drehen um 90° erlauben'))),
    h('small', { class: 'hint' }, loc('{n} Objekte werden von vorne links beginnend in Reihen auf der Arbeitsfläche verteilt. Ohne Auswahl werden alle Objekte angeordnet.', { n: list.length })));
  modal(loc('Automatisch anordnen'), body, [{ label: loc('Abbrechen') }, {
    label: loc('Anordnen'), primary: true, click: () => {
      A.state.nestCfg = { ...cfg };
      const M = A.doc.machine;
      const boxes = list.map(s => shapesBBox([s], A.ctxGeo));
      const plan = nestPlan(boxes.map(b => ({ w: b.x1 - b.x0, h: b.y1 - b.y0 })), M.width, M.height, cfg.gap, cfg.margin, cfg.rotate);
      list.forEach((s, i) => {
        const b = boxes[i], p = plan.pos[i];
        const cx = (b.x0 + b.x1) / 2, cy = (b.y0 + b.y1) / 2;
        let m = Mat.translate(-cx, -cy);
        if (p.rot) m = Mat.mul(m, Mat.rotate(Math.PI / 2));
        m = Mat.mul(m, Mat.translate(p.x + p.w / 2, p.y + p.h / 2));
        s.transform = Mat.mul(s.transform, m);
      });
      A.setSel(list); A.commit('Anordnen');
      if (plan.overflow) toast(loc('{n} Objekte passen nicht mehr auf die Arbeitsfläche', { n: plan.overflow }), 'err');
      else toast(loc('{n} Objekte angeordnet', { n: list.length }), 'ok');
    }
  }], { width: '460px' });
}

/* ============ Bild-Hintergrund entfernen ============
   Farbabstand zur Hintergrundfarbe (vom Rand ermittelt oder per Klick gewählt).
   'edge': nur zusammenhängende Flächen ab dem Bildrand, 'all': diese Farbe überall.
   Entfernte Pixel werden transparent – transparente Stellen werden nicht graviert. */
function bgColorFromBorder(d, w, hh) {
  const cnt = new Map();
  const take = i => { const k = (d[i] >> 4) << 8 | (d[i + 1] >> 4) << 4 | (d[i + 2] >> 4); if (d[i + 3] > 128) cnt.set(k, (cnt.get(k) || 0) + 1); };
  for (let x = 0; x < w; x++) { take(x * 4); take(((hh - 1) * w + x) * 4); }
  for (let y = 0; y < hh; y++) { take(y * w * 4); take((y * w + w - 1) * 4); }
  let best = -1, bk = 0xfff;
  for (const [k, n] of cnt) if (n > best) { best = n; bk = k; }
  // Mittelwert aller Randpixel dieser Farbklasse
  let r = 0, g = 0, b = 0, n = 0;
  const acc = i => { const k = (d[i] >> 4) << 8 | (d[i + 1] >> 4) << 4 | (d[i + 2] >> 4); if (k === bk && d[i + 3] > 128) { r += d[i]; g += d[i + 1]; b += d[i + 2]; n++; } };
  for (let x = 0; x < w; x++) { acc(x * 4); acc(((hh - 1) * w + x) * 4); }
  for (let y = 0; y < hh; y++) { acc(y * w * 4); acc((y * w + w - 1) * 4); }
  return n ? [r / n, g / n, b / n] : [255, 255, 255];
}
export function removeBackground(src, w, hh, opt) {
  const d = new Uint8ClampedArray(src), N = w * hh;
  const [R, G, B] = opt.color;
  const tol = opt.tolerance / 100 * 441.7, soft = Math.max(1, tol * opt.feather / 100);
  const dist = new Float32Array(N);
  for (let p = 0; p < N; p++) {
    const i = p * 4;
    dist[p] = d[i + 3] < 8 ? 0 : Math.hypot(d[i] - R, d[i + 1] - G, d[i + 2] - B);
  }
  const bg = new Uint8Array(N);
  if (opt.mode === 'all') { for (let p = 0; p < N; p++) if (dist[p] <= tol) bg[p] = 1; }
  else {
    const st = new Int32Array(N); let sp = 0;
    const seed = p => { if (!bg[p] && dist[p] <= tol) { bg[p] = 1; st[sp++] = p; } };
    for (let x = 0; x < w; x++) { seed(x); seed((hh - 1) * w + x); }
    for (let y = 0; y < hh; y++) { seed(y * w); seed(y * w + w - 1); }
    for (const s of opt.seeds || []) seed(s);
    while (sp) {
      const p = st[--sp], x = p % w;
      if (x > 0) seed(p - 1); if (x < w - 1) seed(p + 1);
      if (p >= w) seed(p - w); if (p < N - w) seed(p + w);
    }
  }
  let removed = 0;
  for (let p = 0; p < N; p++) {
    if (bg[p]) { d[p * 4 + 3] = 0; removed++; continue; }
    if (!opt.feather) continue;
    // weiche Kante: Pixel neben entferntem Hintergrund, die der Farbe noch ähneln
    const x = p % w;
    if ((x > 0 && bg[p - 1]) || (x < w - 1 && bg[p + 1]) || (p >= w && bg[p - w]) || (p < N - w && bg[p + w])) {
      const a = Math.min(1, (dist[p] - tol) / soft);
      d[p * 4 + 3] = Math.round(d[p * 4 + 3] * Math.max(0, a));
    }
  }
  return { data: d, removed };
}
export async function bgRemoveDialog(im) {
  const A = App();
  let img;
  try { img = await loadImage(im.src); } catch { toast(loc('Bild konnte nicht geladen werden'), 'err'); return; }
  const w = img.naturalWidth, hh = img.naturalHeight;
  const cv = document.createElement('canvas'); cv.width = w; cv.height = hh;
  const cx = cv.getContext('2d'); cx.drawImage(img, 0, 0);
  const orig = cx.getImageData(0, 0, w, hh);
  const cfg = Object.assign({ tolerance: 12, feather: 30, mode: 'edge' }, A.state.bgCfg || {});
  cfg.color = bgColorFromBorder(orig.data, w, hh); cfg.seeds = [];
  // Vorschau verkleinert rechnen, damit die Regler flüssig bleiben
  const ps = Math.min(1, 360 / Math.max(w, hh)), pw = Math.max(1, Math.round(w * ps)), ph = Math.max(1, Math.round(hh * ps));
  const pc = document.createElement('canvas'); pc.width = pw; pc.height = ph;
  const pcx = pc.getContext('2d'); pcx.drawImage(img, 0, 0, pw, ph);
  const small = pcx.getImageData(0, 0, pw, ph);
  const view = h('canvas', { width: pw, height: ph, class: 'bgprev', title: loc('Klicken, um die Hintergrundfarbe zu wählen') });
  const swatch = h('span', { class: 'swatch' });
  const info = h('small', { class: 'hint' });
  const vcx = view.getContext('2d');
  const draw = () => {
    const seeds = cfg.seeds.map(([x, y]) => Math.min(ph - 1, Math.round(y * ps)) * pw + Math.min(pw - 1, Math.round(x * ps)));
    const r = removeBackground(small.data, pw, ph, { ...cfg, seeds });
    vcx.clearRect(0, 0, pw, ph);
    vcx.putImageData(new ImageData(r.data, pw, ph), 0, 0);
    swatch.style.background = `rgb(${cfg.color.map(Math.round).join(',')})`;
    info.textContent = loc('{p} % des Bildes werden transparent', { p: Math.round(r.removed / (pw * ph) * 100) });
  };
  view.addEventListener('click', e => {
    const rc = view.getBoundingClientRect();
    const x = Math.floor((e.clientX - rc.left) / rc.width * w), y = Math.floor((e.clientY - rc.top) / rc.height * hh);
    const i = (y * w + x) * 4;
    cfg.color = [orig.data[i], orig.data[i + 1], orig.data[i + 2]];
    cfg.seeds = [[x, y]];
    draw();
  });
  const body = h('div', {},
    h('div', { class: 'bgwrap' }, view),
    h('div', { class: 'row', style: { alignItems: 'center', gap: '8px', margin: '6px 0' } }, h('span', {}, loc('Hintergrundfarbe')), swatch,
      h('button', { class: 'tbtn', onclick: () => { cfg.color = bgColorFromBorder(orig.data, w, hh); cfg.seeds = []; draw(); } }, loc('Vom Rand ermitteln'))),
    field(loc('Bereich'), selectInput(cfg.mode, [
      { v: 'edge', t: loc('Zusammenhängend vom Rand') }, { v: 'all', t: loc('Diese Farbe im ganzen Bild') }
    ], v => { cfg.mode = v; draw(); })),
    slider(loc('Toleranz'), cfg.tolerance, 0, 60, 1, v => { cfg.tolerance = v; draw(); }),
    slider(loc('Weiche Kante'), cfg.feather, 0, 100, 5, v => { cfg.feather = v; draw(); }),
    info,
    h('small', { class: 'hint' }, loc('Tipp: Ins Bild klicken wählt die Farbe an dieser Stelle. Karomuster = wird nicht graviert.')));
  draw();
  modal(loc('Hintergrund entfernen'), body, [{ label: loc('Abbrechen') }, {
    label: loc('Entfernen'), primary: true, click: () => {
      A.state.bgCfg = { tolerance: cfg.tolerance, feather: cfg.feather, mode: cfg.mode };
      const r = removeBackground(orig.data, w, hh, { ...cfg, seeds: cfg.seeds.map(([x, y]) => y * w + x) });
      cx.putImageData(new ImageData(r.data, w, hh), 0, 0);
      im.src = cv.toDataURL('image/png');
      im.transparency = true;
      loadImage(im.src).then(() => { invalidateImagePreview(im.id); A.commit('Hintergrund entfernen'); });
    }
  }], { width: '440px' });
}

/* ============ Undo-Verlauf als Liste ============
   Zeigt alle Schritte der History; ein Klick springt direkt zu diesem Stand.
   Spätere Schritte bleiben erhalten (ausgegraut), bis eine neue Änderung sie verwirft. */
const histLabel = l => !l ? '' : l.startsWith('Boolean ') ? loc('Boolesche Operation') : loc(l);
export function historyPanel() {
  const A = App(), H = A.history;
  const list = h('div', { class: 'histlist' });
  const info = h('small', { class: 'hint' });
  let sig = '';
  const draw = (force) => {
    const s = H.stack.length + ':' + H.pos + ':' + (H.stack[H.stack.length - 1] || {}).label;
    if (!force && s === sig) return;
    sig = s;
    list.innerHTML = '';
    H.stack.forEach((e, i) => {
      list.appendChild(h('div', {
        class: 'histrow' + (i === H.pos ? ' on' : '') + (i > H.pos ? ' future' : ''),
        title: i === H.pos ? loc('Aktueller Stand') : loc('Zu diesem Stand springen'),
        onclick: () => jump(i)
      }, h('span', { class: 'hn' }, String(i + 1)), h('span', {}, i === 0 ? loc('Start') : histLabel(e.label))));
    });
    info.textContent = loc('{n} Schritte · Stand {p}', { n: H.stack.length, p: H.pos + 1 });
    const on = list.querySelector('.on');
    if (on) on.scrollIntoView({ block: 'nearest' });
  };
  const jump = i => {
    if (i === H.pos) return;
    H.pos = i; H.restore(A.doc);
    invalidateAll(); A.setSel([]); A.refresh(); A.persist();
  };
  const dp = dockPanel(loc('Verlauf'), h('div', {}, info, list), [
    { label: '↶ ' + loc('Rückgängig'), keep: true, click: () => { if (H.pos > 0) jump(H.pos - 1); } },
    { label: '↷ ' + loc('Wiederholen'), keep: true, click: () => { if (H.pos < H.stack.length - 1) jump(H.pos + 1); } }
  ], () => { if (A.onHistory === draw) A.onHistory = null; });
  A.onHistory = draw;
  draw(true);
  return dp;
}

/* ============ Testmuster: Zeilenabstand und Fokus ============
   Jedes Feld bekommt eine eigene freie Ebene (vorhandene Ebenen bleiben unangetastet). */
function freeLayers(n) {
  const A = App(), used = new Set();
  walk(A.doc.shapes, s => used.add(s.layer));
  const free = A.doc.layers.filter(L => !L.isTool && !used.has(L.index)).map(L => L.index);
  return free.length >= n ? free.slice(0, n) : null;
}
export function testPatternDialog() {
  const A = App();
  const M = A.doc.machine, L0 = A.doc.layers[A.state.activeLayer];
  const cfg = Object.assign({ type: 'interval', count: 8, from: 0.05, to: 0.3, cell: 10, zFrom: -3, zTo: 3, len: 100, speed: L0.speed, power: L0.maxPower, labels: true },
    A.state.testCfg || {}, { speed: L0.speed, power: L0.maxPower });
  const body = h('div'), info = h('small', { class: 'hint' });
  const rebuild = () => {
    body.innerHTML = '';
    body.appendChild(field(loc('Test'), selectInput(cfg.type, [
      { v: 'interval', t: loc('Zeilenabstand (Füllung)') }, { v: 'focusZ', t: loc('Fokus mit Z-Achse') }, { v: 'ramp', t: loc('Fokus-Rampe (ohne Z-Achse)') }
    ], v => { cfg.type = v; rebuild(); })));
    const g = h('div', { class: 'grid2' });
    if (cfg.type === 'interval') g.append(
      field(loc('Anzahl Felder'), numInput(cfg.count, 1, v => cfg.count = Math.max(2, Math.min(20, v | 0)))),
      field(loc('Feldgröße mm'), numInput(cfg.cell, 1, v => cfg.cell = Math.max(3, v))),
      field(loc('Zeilenabstand von mm'), numInput(cfg.from, 0.01, v => cfg.from = Math.max(0.01, v))),
      field(loc('bis mm'), numInput(cfg.to, 0.01, v => cfg.to = Math.max(0.01, v))));
    else if (cfg.type === 'focusZ') g.append(
      field(loc('Anzahl Linien'), numInput(cfg.count, 1, v => cfg.count = Math.max(2, Math.min(20, v | 0)))),
      field(loc('Linienlänge mm'), numInput(cfg.len, 5, v => cfg.len = Math.max(10, v))),
      field(loc('Z-Versatz von mm'), numInput(cfg.zFrom, 0.5, v => cfg.zFrom = v)),
      field(loc('bis mm'), numInput(cfg.zTo, 0.5, v => cfg.zTo = v)));
    else g.append(field(loc('Linienlänge mm'), numInput(cfg.len, 5, v => cfg.len = Math.max(20, v))));
    g.append(field(loc('Geschw.') + ' ' + speedUnit(), speedInput(cfg.speed, v => cfg.speed = v)),
      field(loc('Leistung %'), numInput(cfg.power, 1, v => cfg.power = Math.max(1, Math.min(100, v)))));
    if (cfg.type !== 'ramp') g.append(checkbox(cfg.labels, v => cfg.labels = v, loc('Beschriftung gravieren')));
    body.appendChild(g);
    const tips = {
      interval: loc('Graviert Felder mit wachsendem Zeilenabstand. Das Feld, das gerade noch gleichmäßig dunkel ohne Streifen ist, zeigt den besten Abstand für Füllungen.'),
      focusZ: loc('Jede Linie wird mit einem anderen Z-Versatz gelasert. Die dünnste, schärfste Linie zeigt den richtigen Fokus. Braucht „Z-Achse benutzen" in den Geräte-Einstellungen.'),
      ramp: loc('Ein Brett schräg unterlegen (ein Ende 5–10 mm höher) und die lange Linie lasern. Wo die Linie am dünnsten ist, stimmt der Fokus – dort die Höhe nachmessen.')
    };
    body.appendChild(h('small', { class: 'hint' }, tips[cfg.type]));
    if (cfg.type === 'focusZ' && !M.enableZ) body.appendChild(h('small', { class: 'hint', style: { color: 'var(--warn)' } }, loc('⚠ Die Z-Achse ist in den Geräte-Einstellungen ausgeschaltet – ohne Z nimm die Fokus-Rampe.')));
    body.appendChild(info);
  };
  rebuild();
  modal(loc('Testmuster'), body, [{ label: loc('Abbrechen') }, {
    label: loc('Erstellen'), primary: true, click: () => {
      A.state.testCfg = { ...cfg };
      const n = cfg.type === 'ramp' ? 1 : cfg.count;
      const layers = freeLayers(n + (cfg.labels && cfg.type !== 'ramp' ? 1 : 0));
      if (!layers) { toast(loc('Nicht genug freie Ebenen – bitte unbenutzte Objekte löschen oder weniger Felder wählen.'), 'err'); return false; }
      const c = viewCenter(), news = [];
      const lbLayer = cfg.labels && cfg.type !== 'ramp' ? A.doc.layers[layers[n]] : null;
      if (lbLayer) Object.assign(lbLayer, { mode: 'fill', speed: Math.max(cfg.speed, 50), maxPower: Math.min(cfg.power, 30), minPower: 0, interval: 0.1, passes: 1, output: true, show: true, name: loc('Beschriftung') });
      const label = (txt, x, y, size) => { const t = Shape.text(x, y, txt, lbLayer.index); t.size = size; t.align = 'center'; news.push(t); };
      const setL = (L, props) => Object.assign(L, { passes: 1, output: true, show: true, minPower: 0, maxPower: cfg.power, speed: cfg.speed, zOffset: 0 }, props);
      if (cfg.type === 'interval') {
        const step = cfg.cell + 3, cols = Math.min(n, 5), rows = Math.ceil(n / cols);
        const x0 = c.x - (cols * step) / 2, y0 = c.y + (rows * step) / 2;
        for (let i = 0; i < n; i++) {
          const iv = +(cfg.from + (cfg.to - cfg.from) * i / (n - 1)).toFixed(3);
          const L = A.doc.layers[layers[i]];
          setL(L, { mode: 'fill', interval: iv, name: iv + ' mm' });
          const x = x0 + (i % cols) * step, y = y0 - Math.floor(i / cols) * step - cfg.cell;
          news.push(Shape.rect(x, y, cfg.cell, cfg.cell, L.index));
          if (lbLayer) label(String(iv), x + cfg.cell / 2, y - 3, Math.min(2.5, cfg.cell * 0.25));
        }
      } else if (cfg.type === 'focusZ') {
        const gap = 4, x0 = c.x - cfg.len / 2, y0 = c.y + (n * gap) / 2;
        for (let i = 0; i < n; i++) {
          const z = +(cfg.zFrom + (cfg.zTo - cfg.zFrom) * i / (n - 1)).toFixed(2);
          const L = A.doc.layers[layers[i]];
          setL(L, { mode: 'line', zOffset: z, minPower: cfg.power, name: 'Z ' + z });
          const y = y0 - i * gap;
          news.push(Shape.path([nodeSub([{ x: x0, y }, { x: x0 + cfg.len, y }], false)], L.index));
          if (lbLayer) { const t = Shape.text(x0 - 2, y - 1, (z > 0 ? '+' : '') + z, lbLayer.index); t.size = 2.5; t.align = 'right'; news.push(t); }
        }
      } else {
        const L = A.doc.layers[layers[0]];
        setL(L, { mode: 'line', minPower: cfg.power, name: loc('Fokus-Rampe') });
        const x0 = c.x - cfg.len / 2;
        news.push(Shape.path([nodeSub([{ x: x0, y: c.y }, { x: x0 + cfg.len, y: c.y }], false)], L.index));
        // Markierungen alle 10 mm zum Wiederfinden der Stelle
        for (let x = 0; x <= cfg.len + 1e-6; x += 10)
          news.push(Shape.path([nodeSub([{ x: x0 + x, y: c.y + 2 }, { x: x0 + x, y: c.y + (x % 50 === 0 ? 6 : 4) }], false)], L.index));
      }
      A.doc.shapes.push(...news); A.setSel(news); A.commit('Testmuster');
      toast(loc('Testmuster erstellt – jedes Feld hat eine eigene Ebene'), 'ok');
    }
  }], { width: '520px' });
}

/* ============ QR-Code & Barcode ============ */
export function codeDialog() {
  const A = App();
  const cfg = Object.assign({ type: 'qr', text: 'https://', ecl: 'M', size: 30, quiet: false, label: true }, A.state.codeCfg || {});
  const ta = h('textarea', { rows: 3, onkeydown: e => e.stopPropagation(), oninput: e => { cfg.text = e.target.value; upd(); } });
  ta.value = cfg.text;
  const info = h('small', { class: 'hint' });
  const preview = h('canvas', { width: 160, height: 160, style: { background: '#fff', borderRadius: '6px', border: '1px solid var(--line)', alignSelf: 'center' } });
  const opts = h('div');
  const upd = () => {
    opts.innerHTML = '';
    opts.appendChild(h('div', { class: 'grid2' },
      field(loc('Art'), selectInput(cfg.type, [{ v: 'qr', t: 'QR-Code' }, { v: 'c128', t: loc('Barcode (Code 128)') }], v => { cfg.type = v; upd(); })),
      cfg.type === 'qr'
        ? field(loc('Fehlerkorrektur'), selectInput(cfg.ecl, [{ v: 'L', t: 'L (7 %)' }, { v: 'M', t: 'M (15 %)' }, { v: 'Q', t: 'Q (25 %)' }, { v: 'H', t: 'H (30 %)' }], v => { cfg.ecl = v; upd(); }))
        : checkbox(cfg.label, v => cfg.label = v, loc('Klartext darunter')),
      field(cfg.type === 'qr' ? loc('Größe mm') : loc('Breite mm'), numInput(cfg.size, 1, v => { cfg.size = Math.max(5, v); upd(); })),
      checkbox(cfg.quiet, v => { cfg.quiet = v; }, loc('Ruhezone als Rahmen'))));
    const g = preview.getContext('2d'); g.clearRect(0, 0, 160, 160);
    try {
      if (cfg.type === 'qr') {
        const q = qrEncode(cfg.text, cfg.ecl), s = 150 / q.size;
        g.fillStyle = '#000';
        q.modules.forEach((row, r) => row.forEach((b, c) => b && g.fillRect(5 + c * s, 5 + r * s, s + .3, s + .3)));
        info.style.color = '';
        info.textContent = loc('Version {v} · {n}×{n} Module · Modul {m} mm', { v: q.version, n: q.size, m: +(cfg.size / q.size).toFixed(2) });
      } else {
        const w = code128Widths(cfg.text), tot = [...w].reduce((a, d) => a + +d, 0), s = 150 / tot;
        let x = 5; g.fillStyle = '#000';
        [...w].forEach((d, i) => { if (i % 2 === 0) g.fillRect(x, 40, d * s, 80); x += d * s; });
        info.style.color = '';
        info.textContent = loc('{n} Module · Strich {m} mm', { n: tot, m: +(cfg.size / tot).toFixed(2) });
      }
    } catch (e) {
      info.style.color = 'var(--err)';
      info.textContent = cfg.type === 'qr' ? loc('Text zu lang für einen QR-Code') : loc('Code 128 erlaubt nur Zeichen ohne Umlaute (ASCII)');
    }
  };
  upd();
  const body = h('div', {}, field(loc('Inhalt'), ta), opts, h('div', { class: 'row', style: { gap: '12px', marginTop: '6px' } }, preview, h('div', { style: { flex: 1 } }, info,
    h('small', { class: 'hint' }, loc('Tipp: Module unter 0,4 mm werden mit Diodenlasern oft unscharf – dann größer machen oder die Fehlerkorrektur senken.')))));
  modal(loc('QR-Code / Barcode'), body, [{ label: loc('Abbrechen') }, {
    label: loc('Erstellen'), primary: true, click: () => {
      A.state.codeCfg = { ...cfg };
      const c = viewCenter(), news = [];
      let polys, W, H;
      try {
        if (cfg.type === 'qr') {
          const q = qrEncode(cfg.text, cfg.ecl), cell = cfg.size / q.size;
          W = H = cfg.size;
          polys = gridOutline(q.modules, cell, c.x - W / 2, c.y - H / 2);
        } else {
          const w = code128Widths(cfg.text), tot = [...w].reduce((a, d) => a + +d, 0), cell = cfg.size / tot;
          W = cfg.size; H = Math.max(10, cfg.size * 0.3);
          polys = []; let x = c.x - W / 2;
          [...w].forEach((d, i) => {
            if (i % 2 === 0) polys.push([{ x, y: c.y - H / 2 }, { x: x + d * cell, y: c.y - H / 2 }, { x: x + d * cell, y: c.y + H / 2 }, { x, y: c.y + H / 2 }]);
            x += d * cell;
          });
        }
      } catch (e) { toast(info.textContent, 'err'); return false; }
      const sh = Shape.path(polys.map(p => nodeSub(p, true)), A.state.activeLayer);
      sh.name = cfg.type === 'qr' ? 'QR: ' + cfg.text.slice(0, 30) : 'Code128: ' + cfg.text.slice(0, 30);
      news.push(sh);
      if (cfg.quiet) {
        const qz = cfg.type === 'qr' ? W / 8 : W / 12;   // Ruhezone: 4 Module QR bzw. ~10 Module Barcode
        const fr = Shape.rect(c.x - W / 2 - qz, c.y - H / 2 - qz, W + 2 * qz, H + 2 * qz, A.state.activeLayer);
        news.push(fr);
      }
      if (cfg.type === 'c128' && cfg.label) {
        const t = Shape.text(c.x, c.y - H / 2 - Math.max(3, H * 0.18) - 1, cfg.text, A.state.activeLayer);
        t.size = Math.max(3, H * 0.18); t.align = 'center'; t.font = 'Monospace';
        news.push(t);
      }
      A.doc.shapes.push(...news); A.setSel(news); A.commit('Code erstellen');
      warnLineLayer();
    }
  }], { width: '520px' });
}

const shift = (poly, dx, dy) => poly.map(p => ({ x: p.x + dx, y: p.y + dy }));
const bbox = polys => {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const p of polys) for (const q of p) { x0 = Math.min(x0, q.x); y0 = Math.min(y0, q.y); x1 = Math.max(x1, q.x); y1 = Math.max(y1, q.y); }
  return { x0, y0, x1, y1 };
};

/* ============ Box-Generator ============ */
export function boxDialog() {
  const A = App();
  const cfg = Object.assign({ w: 100, d: 80, h: 60, t: 3, finger: 10, kerf: 0.1, inner: false, lid: 'open', dividers: 0 }, A.state.boxCfg || {});
  const info = h('small', { class: 'hint' });
  const upd = () => {
    if (cfg.finger < cfg.t * 1.5) { info.textContent = loc('Fingerbreite sollte mindestens das 1,5-Fache der Materialstärke sein.'); info.style.color = 'var(--warn)'; return; }
    const r = boxParts(cfg);
    info.style.color = '';
    info.textContent = loc('{n} Teile · Außenmaß {w} × {d} × {h} mm', { n: r.parts.length, w: +r.outer.w.toFixed(1), d: +r.outer.d.toFixed(1), h: +r.outer.h.toFixed(1) });
  };
  const num = (k, step, min = 0) => numInput(cfg[k], step, v => { cfg[k] = Math.max(min, v); upd(); });
  const body = h('div', {},
    h('div', { class: 'grid2' },
      field(loc('Maße sind'), selectInput(cfg.inner ? 'in' : 'out', [{ v: 'out', t: loc('Außenmaße') }, { v: 'in', t: loc('Innenmaße') }], v => { cfg.inner = v === 'in'; upd(); })),
      field(loc('Deckel'), selectInput(cfg.lid, [{ v: 'open', t: loc('offen') }, { v: 'closed', t: loc('geschlossen') }], v => { cfg.lid = v; upd(); })),
      field(loc('Breite mm'), num('w', 1, 10)), field(loc('Tiefe mm'), num('d', 1, 10)),
      field(loc('Höhe mm'), num('h', 1, 5)), field(loc('Materialstärke mm'), num('t', 0.1, 0.5)),
      field(loc('Fingerbreite mm'), num('finger', 1, 1)), field(loc('Kerf mm'), num('kerf', 0.01, 0)),
      field(loc('Trennwände'), numInput(cfg.dividers, 1, v => { cfg.dividers = Math.max(0, Math.min(10, v | 0)); upd(); }))),
    h('small', { class: 'hint' }, loc('Kerf = Breite der Schnittfuge. Die Zinken werden um die halbe Fuge breiter, damit die Box stramm sitzt. Tipp: erst mit einem kleinen Teststück prüfen.')),
    info);
  upd();
  modal(loc('Box-Generator'), body, [{ label: loc('Abbrechen') }, {
    label: loc('Erstellen'), primary: true, click: () => {
      if (cfg.finger < cfg.t * 1.5) { toast(loc('Fingerbreite sollte mindestens das 1,5-Fache der Materialstärke sein.'), 'err'); return false; }
      A.state.boxCfg = { ...cfg };
      const { parts } = boxParts(cfg);
      const news = [];
      layoutRows(parts.map(p => {
        const b = bbox([p.outline]);
        return {
          w: b.x1 - b.x0, h: b.y1 - b.y0, place: (x, y) => {
            const dx = x - b.x0, dy = y - b.y0;
            const sh = Shape.path([p.outline, ...p.holes].map(pl => nodeSub(shift(pl, dx, dy), true)), A.state.activeLayer);
            sh.name = loc(p.name);
            A.doc.shapes.push(sh); news.push(sh);
          }
        };
      }));
      A.setSel(news); A.commit('Box erstellen');
      toast(loc('Box mit {n} Teilen erstellt', { n: news.length }), 'ok');
    }
  }], { width: '520px' });
}

/* ============ Flexscharnier ============ */
export function hingeDialog() {
  const A = App();
  const cfg = Object.assign({ w: 80, h: 60, spacing: 2, cut: 20, bridge: 3, frame: true }, A.state.hingeCfg || {});
  const num = (k, step, min) => numInput(cfg[k], step, v => cfg[k] = Math.max(min, v));
  const body = h('div', {},
    h('div', { class: 'grid2' },
      field(loc('Breite mm'), num('w', 1, 5)), field(loc('Höhe mm'), num('h', 1, 5)),
      field(loc('Reihenabstand mm'), num('spacing', 0.1, 0.5)), field(loc('Schlitzlänge mm'), num('cut', 1, 2)),
      field(loc('Steg mm'), num('bridge', 0.5, 0.5)),
      checkbox(cfg.frame, v => cfg.frame = v, loc('Rahmen um das Feld'))),
    h('small', { class: 'hint' }, loc('Die Schlitze machen Holz biegbar (z. B. für runde Boxecken). Kleinerer Reihenabstand = biegsamer, aber empfindlicher. Für 3 mm Sperrholz sind 1,5–2,5 mm üblich.')));
  modal(loc('Flexscharnier (Living Hinge)'), body, [{ label: loc('Abbrechen') }, {
    label: loc('Erstellen'), primary: true, click: () => {
      A.state.hingeCfg = { ...cfg };
      const c = viewCenter(), x0 = c.x - cfg.w / 2, y0 = c.y - cfg.h / 2;
      const subs = hingeLines(cfg).map(l => nodeSub(shift(l, x0, y0), false));
      const sh = Shape.path(subs, A.state.activeLayer); sh.name = loc('Flexscharnier');
      const news = [sh];
      if (cfg.frame) {
        const fr = Shape.rect(x0, y0, cfg.w, cfg.h, A.state.activeLayer); fr.name = loc('Rahmen');
        news.push(fr);
      }
      A.doc.shapes.push(...news);
      A.setSel(news); A.commit('Flexscharnier');
      toast(loc('{n} Schlitze erzeugt', { n: subs.length }), 'ok');
    }
  }], { width: '480px' });
}
