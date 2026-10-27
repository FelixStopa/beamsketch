// onboarding.js — Einrichtungs-Assistent beim ersten Start:
// erklärt das Programm, lässt den Laser aus einer Liste wählen und kann die
// echten Werte über USB direkt von der Steuerung auslesen.
import { h, $, modal, toast, field, numInput, checkbox, selectInput, fmtNum, langSelect } from './ui.js';
import { loc } from './i18n.js';

const KEY = 'laserstudio.onboarded';
const VERSION = 1;

let catalog = null;   // {version, note, support, devices:[…]}

export async function loadDevices(base = 'devices/') {
  if (catalog) return catalog;
  try {
    const r = await fetch(base + 'devices.json');
    if (!r.ok) throw new Error('devices.json ' + r.status);
    catalog = await r.json();
  } catch (e) {
    console.warn('Geräteliste nicht ladbar:', e.message);
    catalog = { devices: [], note: '', support: {} };
  }
  return catalog;
}

export function wasOnboarded() {
  try { return +(localStorage.getItem(KEY) || 0) >= VERSION; } catch (e) { return false; }
}
function markOnboarded() {
  try { localStorage.setItem(KEY, String(VERSION)); } catch (e) { /* egal */ }
}
export function resetOnboarding() {
  try { localStorage.removeItem(KEY); } catch (e) { /* egal */ }
}

const SUPPORT_LABEL = {
  full: { t: loc('GCode direkt nutzbar'), c: 'ok' },
  limited: { t: loc('eingeschränkt'), c: 'warn' },
  none: { t: loc('kein GCode möglich'), c: 'err' }
};

/* Anzeigename; die allgemeinen Einträge (Marke „Allgemein") werden übersetzt */
function devName(d) { return d.brand === 'Allgemein' ? loc(d.model) : d.brand + ' ' + d.model; }

/* Übernimmt ein Gerät aus der Liste in die Maschinen-Einstellungen */
export function applyDevice(App, d, over = {}) {
  const m = App.doc.machine;
  const homing = over.homing !== undefined ? over.homing : (d.homing === true);
  m.name = devName(d);
  m.firmware = d.ctrl || 'GRBL';
  m.width = Math.max(10, over.width != null ? over.width : d.width);
  m.height = Math.max(10, over.height != null ? over.height : d.height);
  m.sScale = over.sMax != null ? over.sMax : (d.sMax || 1000);
  m.baud = over.baud != null ? over.baud : (d.baud || 115200);
  m.maxSpeedX = over.maxSpeed != null ? over.maxSpeed : (d.maxSpeed || 300);
  m.maxSpeedY = Math.round(m.maxSpeedX * 0.8);
  m.accelX = m.accelY = over.accel != null ? over.accel : (d.accel || 3000);
  m.rapidSpeed = m.maxSpeedX;
  m.homeOnStartup = homing;
  // Ohne Referenzfahrt kennt die Steuerung keinen Maschinennullpunkt:
  // dann muss der Job dort starten, wo der Kopf gerade steht.
  m.jobOrigin = homing ? 'absolute' : 'current';
  m.absoluteCoords = homing;
  m.deviceId = d.id;
  m.support = d.support || 'full';
  const badge = $('#devBadge');
  if (badge) badge.textContent = `${m.name} · ${m.width}×${m.height} mm · ${m.firmware}`;
  App.refresh();
  if (App.fitBed) App.fitBed();
  if (App.persist) App.persist();   // Gerät bleibt über Neustarts erhalten
  return m;
}

/* ---------------- Geräteauswahl (auch einzeln verwendbar) ---------------- */
export function deviceChooser(App, onPick) {
  const state = { sel: null, width: 0, height: 0, homing: false, filter: 'all', q: '' };
  const list = h('div', { class: 'devlist' });
  const detail = h('div', { class: 'devdetail' });
  const count = h('small', { class: 'hint' }, '');

  const renderDetail = () => {
    detail.innerHTML = '';
    const d = state.sel;
    if (!d) {
      detail.appendChild(h('small', { class: 'hint' }, loc('Wähle links deinen Laser aus. Findest du ihn nicht, nimm „Beliebiger GRBL-Laser" und trage die Maße ein – oder lies sie unten direkt vom Gerät aus.')));
      return;
    }
    const sup = SUPPORT_LABEL[d.support] || SUPPORT_LABEL.full;
    detail.appendChild(h('div', { class: 'row', style: { marginBottom: '6px' } },
      h('b', {}, devName(d)),
      h('span', { class: 'sup ' + sup.c }, sup.t)));
    if (d.note) detail.appendChild(h('small', { class: 'hint' }, loc(d.note)));
    if (d.support === 'none')
      detail.appendChild(h('small', { class: 'hint', style: { color: 'var(--err)' } },
        loc('Zeichnen, Bild bearbeiten und SVG-Export funktionieren. Der GCode-Versand nicht – dafür brauchst du die Software deines Herstellers.')));
    detail.appendChild(h('div', { class: 'grid2', style: { marginTop: '6px' } },
      field(loc('Breite mm'), numInput(state.width, 1, v => state.width = v)),
      field(loc('Höhe mm'), numInput(state.height, 1, v => state.height = v))));
    detail.appendChild(h('div', { style: { marginTop: '4px' } },
      checkbox(state.homing, v => { state.homing = v; renderDetail(); },
        loc('Laser fährt beim Start eine Referenzfahrt (Endschalter vorhanden)'))));
    detail.appendChild(h('small', { class: 'hint' }, state.homing
      ? loc('Der Job wird in absoluten Maschinenkoordinaten ausgegeben – die Position auf der Arbeitsfläche stimmt dann mit der Zeichnung überein.')
      : loc('Ohne Endschalter startet der Job an der aktuellen Kopfposition. Den Kopf vorher von Hand an die gewünschte Ecke fahren.')));
    if (d.src) detail.appendChild(h('small', { class: 'hint' },
      loc('Werte laut Hersteller.') + ' ', h('a', { href: d.src, target: '_blank', rel: 'noreferrer', style: { color: 'var(--acc)' } }, loc('Quelle'))));
    detail.appendChild(readFromMachine(App, (m) => {
      state.width = m.width; state.height = m.height; state.homing = m.homing;
      if (m.sMax) state.sMax = m.sMax;
      if (m.maxSpeed) state.maxSpeed = m.maxSpeed;
      if (m.accel) state.accel = m.accel;
      renderDetail();
    }));
  };

  const draw = () => {
    list.innerHTML = '';
    const q = state.q.trim().toLowerCase();
    const items = (catalog.devices || []).filter(d => {
      if (state.filter === 'ok' && d.support !== 'full') return false;
      if (!q) return true;
      return (d.brand + ' ' + d.model + ' ' + devName(d) + ' ' + (d.alias || '')).toLowerCase().includes(q);
    });
    for (const d of items) {
      const sup = SUPPORT_LABEL[d.support] || SUPPORT_LABEL.full;
      list.appendChild(h('div', {
        class: 'devrow' + (state.sel && state.sel.id === d.id ? ' on' : ''),
        onclick: () => {
          state.sel = d; state.width = d.width; state.height = d.height;
          state.homing = d.homing === true;
          state.sMax = d.sMax; state.maxSpeed = d.maxSpeed; state.accel = d.accel;
          draw(); renderDetail();
          if (onPick) onPick(state);
        }
      },
        h('div', { class: 'dn' }, devName(d)),
        h('div', { class: 'dm' },
          h('span', {}, `${d.width} × ${d.height} mm`),
          h('span', { class: 'sup ' + sup.c }, loc(d.ctrl)))));
    }
    if (!items.length) list.appendChild(h('small', { class: 'hint' },
      loc('Nichts gefunden. Nimm „Beliebiger GRBL-Laser" – fast alle Diodenlaser sprechen GRBL.')));
    count.textContent = loc('{n} von {total} Geräten', { n: items.length, total: (catalog.devices || []).length });
  };

  const search = h('input', {
    type: 'text', placeholder: loc('Marke oder Modell suchen, z. B. „Falcon" oder „S30" …'),
    oninput: e => { state.q = e.target.value; draw(); }, onkeydown: e => e.stopPropagation()
  });
  const box = h('div', {},
    h('div', { class: 'row' }, search,
      selectInput('all', [{ v: 'all', t: loc('Alle Geräte') }, { v: 'ok', t: loc('Nur direkt nutzbare') }],
        v => { state.filter = v; draw(); })),
    count,
    h('div', { class: 'devcols' }, list, detail));
  draw(); renderDetail();
  return { el: box, state, focus: () => search.focus() };
}

/* Werte per USB direkt aus der GRBL-Steuerung lesen */
function readFromMachine(App, onRead) {
  const out = h('small', { class: 'hint' }, '');
  const btn = h('button', {
    class: 'tbtn', style: { marginTop: '6px' },
    onclick: async () => {
      const S = App.serial;
      out.textContent = '';
      try {
        if (!S.supported) throw new Error(loc('Dieser Browser kann kein USB (Web Serial). Nutze Chrome, Edge oder Opera am Desktop.'));
        if (!S.connected) { btn.textContent = loc('Verbinde …'); await S.connect(App.doc.machine.baud); }
        btn.textContent = loc('Lese $$ …');
        const g = await S.readSettings();
        const res = {
          width: Math.round(Math.abs(g['$130'] || 0)) || null,
          height: Math.round(Math.abs(g['$131'] || 0)) || null,
          sMax: g['$30'] || null,
          maxSpeed: g['$110'] ? Math.round(g['$110'] / 60) : null,
          accel: g['$120'] ? Math.round(g['$120']) : null,
          homing: g['$22'] === 1
        };
        if (!res.width || !res.height)
          throw new Error(loc('Die Steuerung meldet keine Verfahrwege ($130/$131). Maße bitte von Hand eintragen.'));
        onRead(res);
        out.style.color = 'var(--ok)';
        out.textContent = loc('Gelesen: {w} × {h} mm, S-max {s}, Referenzfahrt {homing}.', {
          w: res.width, h: res.height, s: res.sMax || '?', homing: res.homing ? loc('aktiv') : loc('aus')
        });
      } catch (e) {
        out.style.color = 'var(--err)';
        out.textContent = e.message;
      }
      btn.textContent = loc('⟲ Werte vom Laser auslesen (USB)');
    }
  }, loc('⟲ Werte vom Laser auslesen (USB)'));
  return h('div', { style: { marginTop: '8px', borderTop: '1px solid var(--line)', paddingTop: '8px' } },
    h('small', { class: 'hint' }, loc('Am sichersten: Laser anschließen und die echten Werte auslesen ($130/$131/$30/$110/$22).')),
    btn, out);
}

/* ---------------- Der Assistent ---------------- */
export async function showOnboarding(App, opts = {}) {
  await loadDevices();
  let step = opts.step || 0;
  const chooser = deviceChooser(App);
  const content = h('div', { class: 'content wizbody' });
  const dots = h('div', { class: 'wizdots' });
  const back = h('button', { class: 'tbtn', onclick: () => go(step - 1) }, loc('Zurück'));
  const next = h('button', { class: 'tbtn big', onclick: () => go(step + 1) }, loc('Weiter'));
  const skip = h('span', { class: 'wizskip', onclick: () => finish(false) }, loc('Überspringen'));

  const steps = [
    { t: loc('Willkommen bei BeamSketch'), build: stepWelcome },
    { t: loc('Welchen Laser hast du?'), build: () => chooser.el },
    { t: loc('So arbeitest du damit'), build: stepHowto },
    { t: loc('Bevor es losgeht'), build: stepSafety }
  ];

  const M = modal(loc('Einrichtung'), content, [], { width: '900px', sticky: true });
  M.el.querySelector('.modal').classList.add('wizard');
  const titleEl = h('span', {}, '');
  const head = M.el.querySelector('.modal h2');
  head.innerHTML = '';
  head.append(titleEl, h('span', { style: { flex: '1' } }), skip,
    h('span', { class: 'x', title: loc('Schließen'), onclick: () => finish(false) }, '✕'));
  const foot = h('div', { class: 'foot' }, back, dots, h('span', { style: { flex: '1' } }), next);
  M.el.querySelector('.modal').appendChild(foot);

  function go(n) {
    if (n < 0) return;
    if (n >= steps.length) return finish(true);
    // Gerät übernehmen, sobald man den Geräteschritt verlässt
    if (step === 1 && n > 1 && chooser.state.sel) {
      applyDevice(App, chooser.state.sel, {
        width: chooser.state.width, height: chooser.state.height, homing: chooser.state.homing,
        sMax: chooser.state.sMax, maxSpeed: chooser.state.maxSpeed, accel: chooser.state.accel
      });
      toast(loc('Gerät übernommen: {name}', { name: App.doc.machine.name }), 'ok');
    }
    step = n;
    titleEl.textContent = steps[step].t;
    content.innerHTML = '';
    content.appendChild(steps[step].build());
    back.style.visibility = step === 0 ? 'hidden' : 'visible';
    next.textContent = step === steps.length - 1 ? loc('Los geht’s') : loc(loc('Weiter'));
    dots.innerHTML = '';
    steps.forEach((_, i) => dots.appendChild(h('span', { class: 'dot' + (i === step ? ' on' : '') })));
    if (step === 1) setTimeout(() => chooser.focus(), 50);
  }
  function finish(done) {
    if (done && step === 1 && chooser.state.sel) go(2);
    markOnboarded();
    M.close();
    if (done) toast(loc('Viel Erfolg! Die Einrichtung findest du jederzeit unter Hilfe.'), 'ok');
  }
  go(step);
  return M;
}

function stepWelcome() {
  const f = (icon, t, d) => h('div', { class: 'feat' }, h('div', { class: 'fi' }, icon),
    h('div', {}, h('b', {}, t), h('div', { class: 'fd' }, d)));
  return h('div', {},
    h('div', { class: 'row', style: { justifyContent: 'flex-end', marginBottom: '6px' } },
      h('span', {}, '🌐 ' + loc('Sprache')), h('div', { style: { width: '160px' } }, langSelect())),
    h('p', { class: 'lead' }, loc('BeamSketch ist ein Laser-Editor, der komplett im Browser läuft. Du zeichnest oder importierst deine Vorlage, legst fest wie geschnitten oder graviert wird, und bekommst GCode für deinen GRBL-Laser – wahlweise als Datei oder direkt per USB.')),
    h('div', { class: 'feats' },
      f('✏️', loc('Zeichnen & Importieren'), loc('Rechteck, Ellipse, Polygon, Bezier, Text mit 138 Schriften. Dazu SVG, DXF, LightBurn-Projekte und Bilder.')),
      f('🎨', loc('Ebenen statt Farben'), loc('Jede Farbe ist ein Schnitt-Satz: Geschwindigkeit, Leistung, Durchgänge, Füllen oder Schneiden.')),
      f('🖼️', loc('Bildgravur'), loc('Graustufen, Schwellwert und Dithering – live auf der Zeichenfläche so dargestellt, wie es graviert wird.')),
      f('👁️', loc('Vorschau & Rahmen'), loc('Werkzeugwege mit Laufzeitschätzung ansehen und den Rahmen abfahren, bevor der Laser zündet.')),
      f('🔌', loc('Direkt an den Laser'), loc('GCode speichern oder per USB senden (Chrome/Edge), mit Jog-Pad, Konsole und Not-Stopp.')),
      f('🔒', loc('Ohne Installation'), loc('Gezeichnet wird direkt im Browser – ohne Installation und ohne Anmeldung. Deine Zeichnungen bleiben auf deinem Rechner.'))),
    h('small', { class: 'hint' }, loc('In den nächsten Schritten richtest du deinen Laser ein – das dauert keine Minute.')));
}

function stepHowto() {
  const step = (n, t, d) => h('div', { class: 'feat' }, h('div', { class: 'fi num' }, n),
    h('div', {}, h('b', {}, t), h('div', { class: 'fd' }, d)));
  return h('div', {},
    h('div', { class: 'uimap' }, uiDiagram()),
    h('div', { class: 'feats' },
      step(1, loc('Vorlage anlegen'), loc('Werkzeuge links, oder Datei → Öffnen/Importieren für SVG, DXF, .lbrn2 und Bilder. Alles lässt sich per Drag & Drop ins Fenster ziehen.')),
      step(2, loc('Ebene zuweisen'), loc('Objekt auswählen und unten eine Farbe anklicken. Jede Farbe ist eine Ebene mit eigenen Schnitteinstellungen.')),
      step(3, loc('Schnitt einstellen'), loc('Ebene rechts doppelklicken: Modus (Linie/Füllen), Geschwindigkeit, Leistung, Durchgänge. Oder eine Vorlage aus der Materialbibliothek nehmen (Strg+M).')),
      step(4, loc('Vorschau prüfen'), loc('Laser → Vorschau zeigt die Wege und schätzt die Laufzeit. Der Ausgabebereich im Laser-Panel warnt, wenn etwas außerhalb liegt.')),
      step(5, loc('Rahmen abfahren'), loc('Mit „Rahmen" umfährt der Kopf die Zeichnung auf dem Material – so siehst du, ob die Position passt.')),
      step(6, loc('Schneiden oder gravieren'), loc('GCode speichern (Strg+E) oder „Verbinden" und „Start" für den direkten Versand per USB.'))),
    h('small', { class: 'hint' }, loc('Tipp: Ein Materialtest (Werkzeuge → Materialtest) brennt ein Raster mit gestufter Leistung und Geschwindigkeit – die schnellste Art, gute Werte für ein neues Material zu finden.')));
}

/* Kleine Übersicht der Programmoberfläche */
function uiDiagram() {
  const NS = 'http://www.w3.org/2000/svg';
  // Farben an die Oberfläche koppeln, damit die Grafik auch im hellen Design passt
  const THEME = { '#14161a': '--bg', '#1b1d22': '--bg', '#1b1e24': '--bg2', '#22262e': '--bg3', '#2e333d': '--line',
    '#96a0b0': '--fg2', '#dfe4ec': '--fg', '#2e8bff': '--acc' };
  const el = (n, a = {}, ...k) => {
    const e = document.createElementNS(NS, n);
    for (const [x, v] of Object.entries(a)) {
      e.setAttribute(x, v);
      if ((x === 'fill' || x === 'stroke') && THEME[v]) e.style[x] = `var(${THEME[v]})`;
    }
    k.forEach(c => e.appendChild(typeof c === 'object' ? c : document.createTextNode(String(c))));
    return e;
  };
  const svg = el('svg', { viewBox: '0 0 560 190', width: '100%', height: '190' });
  const box = (x, y, w, hh, fill, stroke) => svg.appendChild(el('rect',
    { x, y, width: w, height: hh, rx: 4, fill, stroke: stroke || '#2e333d' }));
  const label = (x, y, t, anchor = 'start', size = 10, fill = '#96a0b0') =>
    svg.appendChild(el('text', { x, y, 'text-anchor': anchor, 'font-size': size, fill, 'font-family': 'system-ui' }, t));
  box(0, 0, 560, 190, '#14161a', '#2e333d');
  box(6, 6, 548, 16, '#1b1e24');       label(12, 18, loc('Menü: Datei · Bearbeiten · Anordnen · Werkzeuge · Laser · Ansicht'));
  box(6, 26, 548, 16, '#1b1e24');      label(12, 38, loc('Aktionsleiste: Rückgängig, Ausrichten, Boolesche Operationen, Vorschau, GCode'));
  box(6, 46, 28, 116, '#1b1e24');
  const tools = el('text', { x: 20, y: 104, 'text-anchor': 'middle', 'font-size': 9, fill: '#96a0b0',
    'font-family': 'system-ui', transform: 'rotate(-90 20 104)' }, loc('Werkzeuge'));
  svg.appendChild(tools);
  box(38, 46, 340, 116, '#1b1d22');    label(208, 100, loc('Zeichenfläche = deine Arbeitsfläche'), 'middle', 11, '#dfe4ec');
  label(208, 116, loc('mit Linealen, Raster und Live-Vorschau'), 'middle', 9);
  box(382, 46, 172, 40, '#22262e');    label(390, 62, loc('Ebenen / Schnitte'), 'start', 10, '#dfe4ec');
  label(390, 76, loc('Farbe = Geschwindigkeit, Leistung …'), 'start', 8.5);
  box(382, 90, 172, 38, '#22262e');    label(390, 106, loc('Eigenschaften'), 'start', 10, '#dfe4ec');
  label(390, 119, loc('Größe, Text, Bild, Nachzeichnen'), 'start', 8.5);
  box(382, 132, 172, 30, '#22262e');   label(390, 148, loc('Laser: Vorschau · Rahmen · Start'), 'start', 9, '#dfe4ec');
  box(6, 166, 548, 18, '#1b1e24');     label(12, 178, loc('Farbpalette: Klick weist der Auswahl eine Ebene zu'));
  svg.appendChild(el('line', { x1: 378, y1: 46, x2: 378, y2: 162, stroke: '#2e8bff', 'stroke-width': 2 }));
  label(552, 44, loc('ziehbar ↔'), 'end', 8.5, '#2e8bff');
  return svg;
}

function safetyBox() {
  const li = t => h('li', {}, t);
  return h('div', { class: 'warnbox' },
    h('b', {}, loc('⚠ Sicherheit')),
    h('ul', {},
      li(loc('Schutzbrille tragen, die zur Wellenlänge deines Lasers passt – auch bei kurzen Tests.')),
      li(loc('Den Laser nie unbeaufsichtigt laufen lassen und einen Feuerlöscher bereithalten.')),
      li(loc('Für Abluft oder Filterung sorgen; viele Materialien geben giftige Dämpfe ab.')),
      li(loc('PVC, Vinyl und andere chlorhaltige Kunststoffe niemals schneiden – es entsteht Salzsäure.')),
      li(loc('Vor dem ersten Job den Rahmen abfahren und mit kleiner Leistung an Restmaterial testen.'))));
}

// Vor der ersten USB-Verbindung einmal bestätigen lassen (je Browser): Sicherheitshinweise gelesen,
// Verantwortung für den Betrieb liegt beim Nutzer (AGB § 8). Liefert true, wenn bestätigt.
const SAFETY_KEY = 'laserstudio.safetyOk';
export function confirmSafety() {
  try { if (localStorage.getItem(SAFETY_KEY)) return Promise.resolve(true); } catch (e) { /* weiter */ }
  return new Promise(resolve => {
    let ok = false;
    const go = h('button', { class: 'tbtn big', disabled: true }, loc('Verbinden'));
    const cb = h('input', { type: 'checkbox', onchange: () => { go.disabled = !cb.checked; } });
    const m = modal(loc('Bevor du den Laser verbindest'), h('div', {},
      safetyBox(),
      h('label', { class: 'consent' }, cb, h('span', {},
        loc('Ich habe die Sicherheitshinweise gelesen. Für den sicheren Betrieb meines Lasers bin ich selbst verantwortlich und prüfe jeden Auftrag, bevor ich ihn starte.'), ' ',
        h('a', { href: '/agb', target: '_blank' }, loc('Nutzungsbedingungen (§ 8)'))))),
      [{ label: loc('Abbrechen') }], { width: '520px' });
    m.el.querySelector('.foot').appendChild(go);
    go.onclick = () => {
      ok = true;
      try { localStorage.setItem(SAFETY_KEY, String(Date.now())); } catch (e) { /* egal */ }
      m.close();
    };
    // Fenster zu (Abbrechen, ✕, Klick daneben) → nicht verbinden
    new MutationObserver((_, obs) => { if (!m.el.isConnected) { obs.disconnect(); resolve(ok); } })
      .observe(document.body, { childList: true });
  });
}

function stepSafety() {
  return h('div', {},
    safetyBox(),
    h('p', { class: 'lead' }, loc('Noch zwei Dinge, die viel Ärger sparen:')),
    h('div', { class: 'feats' },
      h('div', { class: 'feat' }, h('div', { class: 'fi' }, '📐'),
        h('div', {}, h('b', {}, loc('Arbeitsfläche prüfen')),
          h('div', { class: 'fd' }, loc('Fahre den Kopf einmal in alle vier Ecken (Jog-Pad im Laser-Panel). Stimmen die Maße nicht, unter Datei → Geräte-Einstellungen korrigieren.')))),
      h('div', { class: 'feat' }, h('div', { class: 'fi' }, '🎯'),
        h('div', {}, h('b', {}, loc('Nullpunkt verstehen')),
          h('div', { class: 'fd' }, loc('Mit Endschalter arbeitet BeamSketch in absoluten Koordinaten. Ohne Endschalter startet der Job dort, wo der Kopf gerade steht – vorher an die richtige Stelle fahren.'))))),
    h('small', { class: 'hint' }, loc('Diesen Assistenten findest du jederzeit wieder unter Hilfe → Einrichtung.')));
}
