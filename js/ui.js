// ui.js — Panels, Menüs, Dialoge
import { LAYER_COLORS, CUT_MODES, layerNo } from './doc.js';
import { fmtTime } from './gcode.js';
import { loc, lang, LANGS, setLang } from './i18n.js';
import { speedUnit, toDisp, fromDisp, speedStep } from './units.js';

/* Beschriftung einer Ebene: „03 Gravur" bzw. „Hilfsebene 1" */
export function layerLabel(L, withName = true) {
  if (L.isTool) return loc('Hilfsebene {n}', { n: L.index - 29 });
  return layerNo(L.index) + (withName && L.name ? ' ' + L.name : '');
}
export function h(tag, attrs = {}, ...kids) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') e.className = v;
    else if (k === 'style' && typeof v === 'object') Object.assign(e.style, v);
    else if (k.startsWith('on') && typeof v === 'function') e.addEventListener(k.slice(2), v);
    else if (v !== null && v !== undefined && v !== false) e.setAttribute(k, v === true ? '' : v);
  }
  for (const k of kids.flat()) {
    if (k === null || k === undefined || k === false) continue;
    e.appendChild(typeof k === 'object' ? k : document.createTextNode(String(k)));
  }
  return e;
}
export const $ = s => document.querySelector(s);

export function toast(msg, kind = '') {
  const el = $('#stMsg');
  el.textContent = msg;
  el.style.color = kind === 'err' ? 'var(--err)' : kind === 'ok' ? 'var(--ok)' : 'var(--fg2)';
  clearTimeout(toast._t);
  toast._t = setTimeout(() => { el.textContent = ''; }, 6000);
}
export function hint(msg) {
  const el = $('#hint');
  if (!msg) { el.classList.remove('show'); return; }
  el.textContent = msg; el.classList.add('show');
}

export function modal(title, contentEl, buttons = [], opts = {}) {
  const bg = h('div', { class: 'modalbg' });
  const close = () => bg.remove();
  const foot = h('div', { class: 'foot' },
    buttons.map(b => h('button', {
      class: 'tbtn' + (b.primary ? ' big' : ''),
      onclick: () => { if (b.click) { if (b.click(close) === false) return; } if (!b.keep) close(); }
    }, b.label)));
  const m = h('div', { class: 'modal', style: opts.width ? { width: opts.width } : {} },
    h('h2', {}, title, h('span', { class: 'x', onclick: close }, '✕')),
    contentEl.classList && contentEl.classList.contains('content') ? contentEl : h('div', { class: 'content' }, contentEl),
    buttons.length ? foot : null);
  bg.appendChild(m);
  bg.addEventListener('mousedown', e => { if (e.target === bg && !opts.sticky) close(); });
  document.body.appendChild(bg);
  return { el: bg, close };
}

export function field(label, input) {
  return h('label', { class: 'f' }, h('span', {}, label), input);
}
export function numInput(val, step, onch, attrs = {}) {
  const i = h('input', { type: 'number', step: step || 'any', value: fmtNum(val), ...attrs });
  const fire = () => { const v = parseFloat(i.value); if (isFinite(v)) onch(v); };
  i.addEventListener('change', fire);
  i.addEventListener('keydown', e => { if (e.key === 'Enter') { fire(); i.blur(); } e.stopPropagation(); });
  return i;
}
/* Zahlenfeld für Geschwindigkeiten: zeigt die gewählte Einheit, liefert mm/s */
export function speedInput(val, onch, attrs = {}) {
  return numInput(toDisp(val), speedStep(), v => onch(fromDisp(v)), { class: 'spd', ...attrs });
}
export function fmtNum(v) { return (Math.round((v || 0) * 10000) / 10000).toString(); }
export function selectInput(val, options, onch) {
  const s = h('select', { onchange: e => onch(s.value) },
    options.map(o => h('option', { value: o.v, selected: o.v === val }, o.t)));
  return s;
}
/* Schieberegler + Zahlenfeld, beide synchron.
   onLive feuert während des Ziehens (Live-Vorschau), onDone beim Loslassen. */
export function slider(label, val, min, max, step, onLive, onDone) {
  const num = h('input', { type: 'number', min, max, step, value: fmtNum(val) });
  const rng = h('input', { type: 'range', min, max, step, value: val });
  const clamp = v => Math.max(min, Math.min(max, v));
  rng.addEventListener('input', () => { const v = parseFloat(rng.value); num.value = fmtNum(v); if (onLive) onLive(v); });
  rng.addEventListener('change', () => { const v = parseFloat(rng.value); if (onDone) onDone(v); });
  const fromNum = (done) => {
    const v = parseFloat(num.value);
    if (!isFinite(v)) return;
    const c = clamp(v);
    num.value = fmtNum(c); rng.value = c;
    if (onLive) onLive(c);
    if (done && onDone) onDone(c);
  };
  num.addEventListener('input', () => fromNum(false));
  num.addEventListener('change', () => fromNum(true));
  num.addEventListener('keydown', e => { if (e.key === 'Enter') { fromNum(true); num.blur(); } e.stopPropagation(); });
  const el = h('div', { class: 'slider' }, h('span', { class: 'lbl' }, label), rng, num);
  el.setValue = v => { rng.value = v; num.value = fmtNum(v); };
  return el;
}

/* Reihe zusammenhängender Umschalt-Buttons */
export function segmented(items, active, onch) {
  const box = h('div', { class: 'seg' });
  items.forEach(it => box.appendChild(h('button', {
    class: 'tbtn' + (it.v === active ? ' on' : ''), title: it.title || '',
    onclick: () => onch(it.v)
  }, it.t)));
  return box;
}

/* ---------------- Angedocktes Werkzeug-Panel ----------------
   Liegt in der rechten Leiste und verdeckt die Zeichenfläche nie. */
let openDock = null;
export function dockPanel(title, content, buttons = [], onClose, opts = {}) {
  closeDock();
  const right = $('#right');
  const p = h('div', { class: 'panel dock' });
  const close = () => {
    if (openDock && openDock.el === p) openDock = null;
    p.remove();
    right.classList.remove('dockopen', 'keeplaser');
    if (onClose) onClose();
  };
  const head = h('h3', {}, h('span', {}, title), h('span', { class: 'x', title: loc('Schließen (Esc)'), onclick: e => { e.stopPropagation(); close(); } }, '✕'));
  head.addEventListener('click', e => { if (!e.target.classList.contains('x')) p.classList.toggle('collapsed'); });
  p.appendChild(head);
  p.appendChild(h('div', { class: 'body' }, content));
  if (buttons.length) p.appendChild(h('div', { class: 'dockfoot' },
    buttons.map(b => h('button', {
      class: 'tbtn' + (b.primary ? ' big' : ''),
      onclick: () => { if (b.click) { if (b.click(close) === false) return; } if (!b.keep) close(); }
    }, b.label))));
  right.insertBefore(p, right.firstChild);
  right.classList.add('dockopen');
  if (opts.keepLaser) right.classList.add('keeplaser');
  openDock = { el: p, close };
  return { el: p, close };
}
export function closeDock() { if (openDock) openDock.close(); }
export function hasDock() { return !!openDock; }

/* Sprachauswahl – ein Wechsel lädt die Seite neu (Sitzung wird vorher gespeichert) */
export function langSelect(beforeReload, sel) {
  const s = sel || h('select');
  s.innerHTML = '';
  for (const l of LANGS) s.appendChild(h('option', { value: l.code, selected: l.code === lang }, l.name));
  s.onchange = () => { if (beforeReload) beforeReload(); setLang(s.value); };
  return s;
}

export function checkbox(val, onch, label) {
  const c = h('input', { type: 'checkbox', checked: !!val, style: { width: 'auto' }, onchange: () => onch(c.checked) });
  return label ? h('label', { class: 'f', style: { gap: '5px' } }, c, h('span', { style: { flex: '1' } }, label)) : c;
}

/* ---------------- Ebenen-Tabelle ---------------- */
const isControl = el => !!(el && el.closest && el.closest('input, select, textarea, button, label'));
export function buildLayers(App) {
  const t = $('#layerTable');
  t.innerHTML = '';
  const used = new Set();
  const scan = list => { for (const s of list) { if (s.type === 'group') scan(s.children); else used.add(s.layer); } };
  scan(App.doc.shapes);
  const head = h('tr', {},
    h('th', {}, ''), h('th', {}, loc('Ebene')), h('th', {}, loc('Modus')), h('th', {}, loc('Speed'), h('small', { class: 'unit' }, speedUnit())), h('th', {}, loc('Power')),
    h('th', {}, 'Ø'), h('th', {}, loc('Out')), h('th', {}, loc('An')));
  t.appendChild(h('thead', {}, head));
  const body = h('tbody');
  // in Laser-Reihenfolge; per Ziehen umsortierbar
  for (const L of layersByPriority(App.doc)) {
    if (!used.has(L.index) && L.index !== App.state.activeLayer && !L.isTool) continue;
    const tr = h('tr', {
      class: L.index === App.state.activeLayer ? 'sel' : '',
      // Klicks in Eingabefeldern/Dropdowns nicht als Zeilenklick werten: der
      // Neuaufbau der Tabelle würde das gerade geöffnete Dropdown schließen.
      ondblclick: e => { if (!isControl(e.target)) cutSettingsDialog(App, L); },
      onclick: e => {
        if (isControl(e.target) || App.state.activeLayer === L.index) return;
        App.state.activeLayer = L.index; App.refresh();
      }
    },
      h('td', { class: 'grip', title: loc('Ziehen: Laser-Reihenfolge ändern') }, h('span', { class: 'swatch', style: { background: L.color } })),
      h('td', { title: layerLabel(L) + ' · ' + loc('Doppelklick öffnet die Schnitteinstellungen') }, layerLabel(L)),
      h('td', {}, L.isTool ? '–' : selectInput(L.mode, CUT_MODES.map(m => ({ v: m, t: loc({ line: 'Linie', fill: 'Füllen', 'fill+line': 'Füllen+Linie', offset: 'Offset' }[m]) })), v => { L.mode = v; App.commit(loc('Modus')); })),
      h('td', { class: 'num' }, L.isTool ? '' : speedInput(L.speed, v => { L.speed = v; App.commit('Speed'); })),
      h('td', { class: 'num' }, L.isTool ? '' : numInput(L.maxPower, 1, v => { L.maxPower = v; App.commit(loc('Power')); })),
      h('td', { class: 'num' }, L.isTool ? '' : numInput(L.passes, 1, v => { L.passes = Math.max(1, Math.round(v)); App.commit(loc('Durchgänge')); }, { style: 'width:30px' })),
      h('td', {}, L.isTool ? '' : checkbox(L.output, v => { L.output = v; App.refresh(); })),
      h('td', {}, checkbox(L.show, v => { L.show = v; App.draw(); App.refresh(); }))
    );
    tr._layer = L;
    tr.addEventListener('pointerdown', e => startLayerDrag(e, tr, body, App));
    body.appendChild(tr);
  }
  t.appendChild(body);
}
const layersByPriority = doc => doc.layers.slice().sort((a, b) => a.priority - b.priority || a.index - b.index);
/* Zeile halten und ziehen: ändert die Priorität (= Reihenfolge im Job). Erst ab ein paar
   Pixeln Bewegung, damit Klick und Doppelklick auf die Zeile weiter funktionieren. */
function startLayerDrag(e, tr, body, App) {
  if (e.button !== 0 || isControl(e.target)) return;
  const y0 = e.clientY, rows = [...body.children];
  let active = false, target = null, after = false;
  const mark = () => rows.forEach(r => r.classList.remove('drop-before', 'drop-after'));
  const move = ev => {
    if (!active) {
      if (Math.abs(ev.clientY - y0) < 5) return;
      active = true;
      tr.classList.add('dragging'); document.body.classList.add('dragging-layer');
    }
    target = rows[rows.length - 1]; after = true;
    for (const r of rows) {
      const b = r.getBoundingClientRect();
      if (ev.clientY < b.top + b.height / 2) { target = r; after = false; break; }
    }
    mark();
    target.classList.add(after ? 'drop-after' : 'drop-before');
  };
  const up = () => {
    window.removeEventListener('pointermove', move);
    window.removeEventListener('pointerup', up);
    if (!active) return;
    mark(); tr.classList.remove('dragging'); document.body.classList.remove('dragging-layer');
    // den Klick nach dem Loslassen nicht als Zeilenklick werten
    const eat = ev => ev.stopPropagation();
    window.addEventListener('click', eat, { capture: true, once: true });
    setTimeout(() => window.removeEventListener('click', eat, { capture: true }), 0);
    const L = tr._layer, T = target && target._layer;
    if (!T || T === L) return;
    const order = layersByPriority(App.doc).filter(x => x !== L);
    order.splice(order.indexOf(T) + (after ? 1 : 0), 0, L);
    if (order.every((x, i) => x.priority === i)) return;
    order.forEach((x, i) => { x.priority = i; });
    App.commit(loc('Ebenen-Reihenfolge'));
  };
  window.addEventListener('pointermove', move);
  window.addEventListener('pointerup', up);
}

/* ---------------- Schnitt-Einstellungen ---------------- */
export function cutSettingsDialog(App, L) {
  const c = h('div');
  const rebuild = () => {
    c.innerHTML = '';
    c.appendChild(h('div', { class: 'row', style: { marginBottom: '8px' } },
      h('span', { class: 'swatch', style: { background: L.color, width: '26px', height: '20px' } }),
      h('b', {}, layerLabel(L, false)),
      h('input', { type: 'text', value: L.name, placeholder: loc('Ebenenname'), onchange: e => { L.name = e.target.value; App.refresh(); } })
    ));
    c.appendChild(h('div', { class: 'grid2' },
      field(loc('Modus'), selectInput(L.mode, CUT_MODES.map(m => ({ v: m, t: loc({ line: 'Linie', fill: 'Füllen', 'fill+line': 'Füllen + Linie', offset: 'Offset-Füllung' }[m]) })), v => { L.mode = v; rebuild(); App.refresh(); })),
      field(loc('Priorität'), numInput(L.priority, 1, v => { L.priority = v; App.refresh(); })),
      field(loc('Geschw.') + ' ' + speedUnit(), speedInput(L.speed, v => { L.speed = v; App.refresh(); })),
      field(loc('Durchgänge'), numInput(L.passes, 1, v => { L.passes = Math.max(1, v | 0); App.refresh(); })),
      field(loc('Max. Leistung %'), numInput(L.maxPower, 1, v => { L.maxPower = v; App.refresh(); })),
      field(loc('Min. Leistung %'), numInput(L.minPower, 1, v => { L.minPower = v; App.refresh(); }))
    ));
    if (L.mode !== 'line') {
      c.appendChild(h('h4', { style: { margin: '10px 0 4px', color: 'var(--fg2)' } }, loc('Füllung')));
      c.appendChild(h('div', { class: 'grid2' },
        field(loc('Zeilenabstand mm'), numInput(L.interval, .01, v => { L.interval = Math.max(.005, v); App.refresh(); })),
        field('DPI', numInput(Math.round(25.4 / L.interval), 1, v => { L.interval = 25.4 / Math.max(1, v); App.refresh(); })),
        field(loc('Winkel °'), numInput(L.angle, 1, v => { L.angle = v; App.refresh(); })),
        field(loc('Overscan %'), numInput(L.overscan, 1, v => { L.overscan = v; App.refresh(); })),
        L.mode === 'offset' ? field(loc('Offset-Anzahl'), numInput(L.offsetCount, 1, v => { L.offsetCount = Math.max(0, v | 0); App.refresh(); })) : null,
        checkbox(L.crosshatch, v => { L.crosshatch = v; App.refresh(); }, loc('Kreuzschraffur')),
        checkbox(L.bidir, v => { L.bidir = v; App.refresh(); }, loc('Bidirektional'))
      ));
    }
    c.appendChild(h('h4', { style: { margin: '10px 0 4px', color: 'var(--fg2)' } }, loc('Erweitert')));
    c.appendChild(h('div', { class: 'grid2' },
      field(loc('Kerf-Ausgleich mm'), numInput(L.kerf, .01, v => { L.kerf = v; App.refresh(); })),
      field(loc('Z-Offset mm'), numInput(L.zOffset, .1, v => { L.zOffset = v; App.refresh(); })),
      field(loc('Z pro Durchg.'), numInput(L.zStep, .1, v => { L.zStep = v; App.refresh(); })),
      checkbox(L.airAssist, v => { L.airAssist = v; App.refresh(); }, loc('Luftunterstützung')),
      checkbox(L.constantPower, v => { L.constantPower = v; App.refresh(); }, loc('Konstante Leistung (M3)')),
      checkbox(L.dotMode, v => { L.dotMode = v; App.refresh(); }, loc('Punktmodus')),
      L.dotMode ? field(loc('Punktzeit ms'), numInput(L.dotTime, .1, v => { L.dotTime = v; App.refresh(); })) : null
    ));
    c.appendChild(h('h4', { style: { margin: '10px 0 4px', color: 'var(--fg2)' } }, loc('Stege (Tabs)')));
    c.appendChild(h('div', { class: 'grid3' },
      checkbox(L.tabs.enabled, v => { L.tabs.enabled = v; App.refresh(); }, loc('Aktiv')),
      field(loc('Anzahl'), numInput(L.tabs.count, 1, v => { L.tabs.count = Math.max(1, v | 0); App.refresh(); })),
      field(loc('Größe mm'), numInput(L.tabs.size, .1, v => { L.tabs.size = v; App.refresh(); }))
    ));
  };
  rebuild();
  modal(loc('Schnitteinstellungen'), c, [{ label: loc('Fertig'), primary: true, click: () => App.commit(loc('Schnitteinstellungen')) }], { width: '520px' });
}

/* ---------------- Farbpalette ---------------- */
export function buildPalette(App) {
  const p = $('#palette');
  p.innerHTML = '';
  p.appendChild(h('span', { class: 'lbl' }, loc('Ebene:')));
  LAYER_COLORS.forEach((c, i) => {
    p.appendChild(h('div', {
      class: 'sw', style: { background: c }, title: loc('Ebene') + ' ' + layerNo(i),
      onclick: () => {
        if (App.state.selection.length) { App.setLayer(i); }
        else { App.state.activeLayer = i; App.refresh(); }
      }
    }));
  });
  p.appendChild(h('span', { class: 'lbl', style: { marginLeft: '10px' } }, loc('Klick = aktive Ebene / Auswahl zuweisen')));
}
