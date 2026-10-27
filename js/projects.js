// projects.js — Tabs und Projekte: mehrere geöffnete Zeichnungen als Tabs, Speichern (Strg+S),
// Speichern unter; mit Online-Speicher zusätzlich Seitenleiste „Meine Projekte" mit Vorschaubildern,
// Umbenennen, Duplizieren, Löschen.
// Jeder Tab hat eigene Zeichnung, Rückgängig-Verlauf, Ansicht und aktive Ebene. Ein einmal
// gespeichertes Projekt bleibt verbunden: Änderungen gehen nach kurzer Pause automatisch an den
// Speicher – auch aus Tabs im Hintergrund. Neue Zeichnungen speichert der Nutzer bewusst mit Namen.
// Gleichzeitige Änderungen (zweites Fenster, anderer Rechner) erkennt der Speicher am Zeitstempel.
//
// Online-Speicher kommt aus einer Erweiterung (setStore), Fehler tragen status (402 Grenze erreicht,
// 404 gelöscht, 409 woanders geändert, 413 zu groß):
//   list() → { projects: [{ id, name, updatedAt, size, thumb }], used, quota, maxCount }
//   get(id) → { project, data }      create({ name, thumb, data }) → project
//   save(id, { thumb, base, force, data }) → project
//   rename(id, name) → { name }      duplicate(id, name)      remove(id)
// Ohne Speicher wird als Projektdatei (.lsproj) gespeichert.
//
// Browser-Speicher: die Zeichnung des aktiven Tabs sichert main.js (Session, mit Tab-Kennung),
// die Zeichnungen der Tabs im Hintergrund liegen unter TABDOC + Kennung, die Tab-Liste unter TABS.
import { h, $, toast, modal, field } from './ui.js';
import { loc, locale } from './i18n.js';
import { View, render, RULER } from './render.js';
import { History, shapesBBox } from './doc.js';
import { boxValid } from './geom.js';
import { Ext } from './ext.js';
import { storage } from './storage.js';
import { Session } from './library.js';

const TABS = 'laserstudio.tabs';
const TABDOC = 'laserstudio.tabdoc.';
const OLD_KEY = 'laserstudio.project';   // vor den Tabs: ein verbundenes Projekt
const PANEL_KEY = 'laserstudio.project.open';
const SAVE_DELAY = 3000;
const MAX_TABS = 12;
const THUMB_W = 320, THUMB_H = 240;

let App = null;
let tabs = [], active = null;
let store = null;        // Online-Speicher (Erweiterung) – ohne: Speichern als Datei
let data = null;         // letzte Übersicht aus dem Speicher
let query = '';

/* Tab: { key, project: { id, name, updatedAt } | null, title, doc, history, view, layer,
          dirty, conflict, linkedAt, saveT, busy, stored } */
const newKey = () => 'T' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
function makeTab(doc, project = null, title = '', hist = null) {
  const t = { key: newKey(), project: project ? { id: project.id, name: project.name, updatedAt: project.updatedAt } : null,
    title, doc: null, history: null, view: null, layer: 0, dirty: false, conflict: false, linkedAt: Date.now(), saveT: null, busy: null, stored: true, edits: 0 };
  if (doc) setDoc(t, doc, hist);
  return t;
}
// hist: gespeicherter Rückgängig-Verlauf (Projekt auf dem Server oder Browser-Sitzung), sonst neu
function setDoc(t, doc, hist = null) {
  t.doc = doc; doc.tabKey = t.key;
  t.history = History.from(hist, doc);
  t.view = null;
}
// Projektdaten für den Speicher: Zeichnung samt Rückgängig-Verlauf (höchstens etwa 4 MB Verlauf)
function projData(t, withHistory = true) {
  const d = docData(t.doc);
  if (withHistory && t.history) {
    try { const h = t.history.serialize(t.doc, { maxBytes: 4e6, maxSteps: 100 }); if (h) d.history = h; } catch (e) { /* ohne Verlauf */ }
  }
  return d;
}
// Speichern; ist das Projekt mit Verlauf zu groß oder der Speicherplatz knapp, noch einmal ohne Verlauf
async function saveWith(fn, t) {
  try { return await fn(projData(t)); }
  catch (e) { if (e.status === 413 || e.status === 402) return fn(projData(t, false)); throw e; }
}
// Grenze des Speichers erreicht: Erweiterung entscheidet (z. B. Angebot), sonst nur die Meldung
const limit = e => Ext.hooks.limit ? Ext.hooks.limit(e.message) : toast(e.message, 'err');
const nameOf = t => t.project ? t.project.name : (t.title || loc('Unbenannt'));
const isBlank = t => !t.project && !t.dirty && t.doc && !t.doc.shapes.length;

/* ---------- Browser-Speicher ---------- */
const ls = {
  get(k) { try { return JSON.parse(storage.getItem(k)); } catch (e) { return null; } },
  set(k, v) { try { storage.setItem(k, JSON.stringify(v)); return true; } catch (e) { return false; } },
  del(k) { storage.removeItem(k); }
};
function persist() {
  ls.set(TABS, { active: active && active.key, tabs: tabs.map(t => ({ key: t.key, project: t.project, title: t.title, dirty: t.dirty, linkedAt: t.linkedAt })) });
}
// Zeichnung eines Tabs im Hintergrund sichern (die des aktiven Tabs sichert main.js)
function storeDoc(t) {
  if (!t.doc) return;
  t.stored = ls.set(TABDOC + t.key, { t: Date.now(), doc: { shapes: t.doc.shapes, layers: t.doc.layers, machine: t.doc.machine, settings: t.doc.settings } });
}

export const docData = (doc = App.doc) => ({ shapes: doc.shapes, layers: doc.layers, machine: doc.machine, settings: doc.settings, app: 'BeamSketch', v: 1 });

/* ---------- Vorschaubild ---------- */
// Die Zeichnung mit dem normalen Renderer in eine unsichtbare Fläche zeichnen (hell, ohne Auswahl
// und Raster), dann ohne Lineale verkleinert als WebP (Safari: JPEG) ausgeben.
function thumbnail(doc) {
  try {
    const host = h('canvas', { style: { position: 'fixed', left: '-10000px', top: '0', width: THUMB_W + RULER + 'px', height: THUMB_H + RULER + 'px' } });
    document.body.appendChild(host);
    const list = doc.shapes.filter(sh => !sh.hidden && !(doc.layers[sh.layer] || {}).isTool);
    let b = list.length ? shapesBBox(list, App.ctxGeo) : null;
    if (!b || !boxValid(b)) b = { x0: 0, y0: 0, x1: doc.machine.width, y1: doc.machine.height };
    const view = new View();
    view.fit(b, THUMB_W + RULER, THUMB_H + RULER, 10);
    const state = { ...App.state, dark: false, selection: [], selIds: new Set(), overlay: null, aux: [], preview: null, nodeSel: [], rotateMode: false };
    render(host, { ...doc, settings: { ...doc.settings, gridSize: 0 } }, view, state, App.ctxGeo);
    const dpr = host.width / host.clientWidth;
    const out = h('canvas', { width: THUMB_W, height: THUMB_H });
    out.getContext('2d').drawImage(host, RULER * dpr, RULER * dpr, THUMB_W * dpr, THUMB_H * dpr, 0, 0, THUMB_W, THUMB_H);
    host.remove();
    let url = out.toDataURL('image/webp', 0.75);
    if (!url.startsWith('data:image/webp')) url = out.toDataURL('image/jpeg', 0.8);
    return url.length < 190 * 1024 ? url : null;
  } catch (e) { console.warn('Vorschaubild', e); return null; }
}

/* ---------- Speichern ---------- */
function link(t, p) {
  t.project = p ? { id: p.id, name: p.name, updatedAt: p.updatedAt } : null;
  t.dirty = false; t.conflict = false; t.linkedAt = Date.now();
  persist(); renderTabs();
}

// nach jeder Änderung (aus main.js): verbundenes Projekt nach kurzer Pause speichern
function changed() {
  const t = active;
  if (!t) return;
  t.edits++;
  if (!t.project) { if (!t.dirty && t.doc.shapes.length) { t.dirty = true; persist(); } renderTabs(); return; }
  t.dirty = true; persist(); renderTabs();
  schedule(t);
}
function schedule(t, delay = SAVE_DELAY) {
  clearTimeout(t.saveT);
  if (!t.conflict && t.project) t.saveT = setTimeout(() => save(t).catch(() => { }), delay);
}

// Projekt eines Tabs speichern; force = trotz fremder Änderung überschreiben
async function save(t = active, { force = false, quiet = true } = {}) {
  if (!t.project) return saveAs(t);
  clearTimeout(t.saveT);
  if (t.busy) { await t.busy.catch(() => { }); if (!t.dirty && !force) return; }
  if (!t.doc) return;
  const id = t.project.id, thumb = thumbnail(t.doc);
  t.dirty = false; renderTabs();
  const base = t.project.updatedAt;
  t.busy = saveWith(data => store.save(id, { thumb, base, force, data }), t);
  renderTabs();
  try {
    const p = await t.busy;
    if (t.project && t.project.id === id) { t.project.updatedAt = p.updatedAt; t.conflict = false; }
    if (!quiet) toast(loc('Gespeichert: {name}', { name: p.name }), 'ok');
    updateCard(p, thumb);
  } catch (e) {
    if (t.project && t.project.id === id) t.dirty = true;
    if (e.status === 409) { t.conflict = true; if (t === active) conflictDialog(t); }
    else if (e.status === 404) { toast(loc('Das Projekt gibt es auf dem Server nicht mehr – bitte neu speichern.'), 'err'); t.title = nameOf(t); link(t, null); t.dirty = true; }
    else toast(loc('Speichern fehlgeschlagen: {msg}', { msg: e.message }), 'err');
    throw e;
  } finally {
    t.busy = null; persist(); renderTabs();
    // während des Speicherns geändert → gleich noch einmal
    if (t.dirty && t.project && t.project.id === id && !t.conflict) schedule(t);
  }
}

function conflictDialog(t) {
  modal(loc('Projekt wurde woanders geändert'),
    h('p', {}, loc('„{name}" wurde inzwischen in einem anderen Fenster oder auf einem anderen Gerät gespeichert. Was soll mit deinen Änderungen hier passieren?', { name: nameOf(t) })),
    [
      { label: loc('Als Kopie speichern'), click: () => { saveAs(t, loc('{name} (Kopie)', { name: nameOf(t) })); } },
      { label: loc('Hier überschreiben'), primary: true, click: () => { save(t, { force: true, quiet: false }).catch(() => { }); } }
    ], { sticky: true });
}

// ohne Online-Speicher: die Erweiterung fragen (z. B. Anmeldung anbieten), sonst als Datei speichern
async function saveFile(t) {
  if (Ext.hooks.needStore && await Ext.hooks.needStore('project')) return null;
  if (t !== active) activate(t);
  App.exportProjectFile();
  t.dirty = false; persist(); renderTabs();
  return true;
}

// Zeichnung eines Tabs als neues Projekt anlegen (Name abfragen)
function saveAs(t = active, suggest) {
  if (!store) return saveFile(t);
  return new Promise(resolve => {
    const inp = h('input', { type: 'text', value: suggest || (t.project ? loc('{name} (Kopie)', { name: t.project.name }) : t.title), placeholder: loc('z. B. Türschild Familie Müller'), maxlength: 120,
      onkeydown: e => { e.stopPropagation(); if (e.key === 'Enter') go(); } });
    const go = async () => {
      const name = inp.value.trim();
      if (!name) return inp.focus();
      m.close();
      try {
        const thumb = thumbnail(t.doc);
        const p = await saveWith(data => store.create({ name, thumb, data }), t);
        clearTimeout(t.saveT);
        link(t, p);
        toast(loc('Gespeichert: {name}', { name: p.name }), 'ok');
        await refresh();
        resolve(p);
      } catch (e) {
        if (e.status === 402) limit(e);
        else toast(loc('Speichern fehlgeschlagen: {msg}', { msg: e.message }), 'err');
        resolve(null);
      }
    };
    const m = modal(loc('Projekt speichern'), h('div', {},
      field(loc('Name'), inp),
      h('small', { class: 'hint' }, loc('Das Projekt wird in deinem Konto gespeichert und erscheint unter „Meine Projekte". Weitere Änderungen werden automatisch gesichert.'))),
      [{ label: loc('Abbrechen'), click: () => resolve(null) }, { label: loc('Speichern'), primary: true, keep: true, click: () => { go(); return false; } }]);
    setTimeout(() => { inp.focus(); inp.select(); }, 0);
  });
}

/* ---------- Tabs ---------- */
// Tab in den Vordergrund holen: Zustand des bisherigen merken, Zeichnung des neuen anzeigen
function activate(t, { fit = false } = {}) {
  if (t === active) return;
  const prev = active;
  if (prev && tabs.includes(prev)) App.endEdit();
  if (prev && tabs.includes(prev)) {
    prev.view = { scale: App.view.scale, ox: App.view.ox, oy: App.view.oy };
    prev.layer = App.state.activeLayer;
    storeDoc(prev);
  }
  active = t;
  if (!t.doc) restoreLazy(t);
  ls.del(TABDOC + t.key);    // ab jetzt sichert main.js die Zeichnung
  App.switchDoc(t, fit || !t.view);
  persist(); renderTabs(); renderList();
  if (t.conflict) conflictDialog(t);
}

function addTab(t, { replaceBlank = true } = {}) {
  if (tabs.length >= MAX_TABS && !(replaceBlank && active && isBlank(active))) {
    toast(loc('Höchstens {n} Tabs gleichzeitig – bitte einen schließen.', { n: MAX_TABS }), 'err');
    return false;
  }
  // eine leere, unbenannte Zeichnung im Vordergrund wird ersetzt (wie im Browser)
  const old = replaceBlank && active && isBlank(active) ? active : null;
  if (old) tabs.splice(tabs.indexOf(old), 1, t);
  else tabs.splice(active ? tabs.indexOf(active) + 1 : tabs.length, 0, t);
  activate(t, { fit: true });
  return true;
}

async function closeTab(t) {
  if (t.project && (t.dirty || t.busy)) {
    try { await save(t); } catch (e) { if (!await askDiscard(t)) return; }
  } else if (!t.project && t.doc && t.doc.shapes.length) {
    if (t !== active) activate(t);
    if (!await askUnsaved(t)) return;
  }
  clearTimeout(t.saveT);
  ls.del(TABDOC + t.key);
  const i = tabs.indexOf(t);
  tabs.splice(i, 1);
  if (!tabs.length) tabs.push(makeTab(App.blankDoc()));
  if (t === active) { active = null; activate(tabs[Math.min(i, tabs.length - 1)]); }
  else { persist(); renderTabs(); renderList(); }
}

// ungespeicherte Zeichnung: Abbrechen, Verwerfen oder erst speichern
function askUnsaved(t) {
  return new Promise(resolve => {
    modal(loc('Zeichnung nicht gespeichert'), h('p', {}, loc('„{name}" ist noch nicht als Projekt gespeichert.', { name: nameOf(t) })), [
      { label: loc('Abbrechen'), click: () => resolve(false) },
      { label: loc('Verwerfen'), click: () => resolve(true) },
      { label: loc('Erst speichern…'), primary: true, click: () => { saveAs(t).then(p => resolve(!!p)); } }
    ], { sticky: true });
  });
}
function askDiscard(t) {
  return new Promise(resolve => {
    modal(loc('Speichern nicht möglich'), h('p', {}, loc('Die letzten Änderungen an „{name}" konnten nicht gespeichert werden. Tab trotzdem schließen?', { name: nameOf(t) })), [
      { label: loc('Abbrechen'), primary: true, click: () => resolve(false) },
      { label: loc('Schließen und Änderungen verwerfen'), click: () => resolve(true) }
    ], { sticky: true });
  });
}

// Zeichnung eines Tabs aus der letzten Sitzung: aus dem Browser-Speicher, sonst vom Server
function restoreLazy(t) {
  const st = ls.get(TABDOC + t.key);
  setDoc(t, st && st.doc ? App.docFromData(st.doc) : App.blankDoc());
  const local = !!(st && st.doc && st.t >= t.linkedAt);
  if (t.project && !store) { t.title = nameOf(t); link(t, null); t.dirty = true; }
  else if (t.project) {
    if (local && t.dirty) schedule(t, 1500);
    else syncFromServer(t, local);
  }
}

// Stand vom Server übernehmen, wenn er neuer ist oder die lokale Zeichnung nicht sicher passt
async function syncFromServer(t, local) {
  const id = t.project.id, edits = t.edits;
  // nicht sicher zugeordnete lokale Änderungen gelten nicht – der Server-Stand zählt
  if (!local) t.dirty = false;
  t.loading = true; renderTabs();
  try {
    const j = await store.get(id);
    if (!tabs.includes(t) || !t.project || t.project.id !== id) return;
    if (t.edits !== edits) {
      // während des Ladens gezeichnet: bei passender Zeichnung normal weiter, sonst lieber trennen
      if (!local) { t.title = nameOf(t); link(t, null); t.dirty = true; }
      return;
    }
    if (local && j.project.updatedAt === t.project.updatedAt) return;
    replaceDoc(t, j.data);
    link(t, j.project);
  } catch (e) {
    if (!tabs.includes(t) || !t.project || t.project.id !== id) return;
    if (e.status === 404) { toast(loc('Das Projekt gibt es auf dem Server nicht mehr – bitte neu speichern.'), 'err'); t.title = nameOf(t); link(t, null); }
    // nicht prüfbar: lieber trennen als ein Projekt mit einer fremden Zeichnung zu überschreiben
    else if (!local) { t.title = nameOf(t); link(t, null); }
  } finally { t.loading = false; renderTabs(); }
}
function replaceDoc(t, d) {
  setDoc(t, App.docFromData(d), d && d.history);
  if (t === active) App.switchDoc(t, true);
}

/* ---------- Öffnen, Neu ---------- */
async function openProject(id) {
  const open = tabs.find(t => t.project && t.project.id === id);
  if (open) return activate(open);
  try {
    const j = await store.get(id);
    if (tabs.find(t => t.project && t.project.id === id)) return activate(tabs.find(t => t.project && t.project.id === id));
    if (addTab(makeTab(App.docFromData(j.data), j.project, '', j.data && j.data.history))) toast(loc('Projekt geöffnet: {name}', { name: j.project.name }), 'ok');
  } catch (e) { toast(loc('Öffnen fehlgeschlagen: {msg}', { msg: e.message }), 'err'); }
}

function newProject() { addTab(makeTab(App.blankDoc()), { replaceBlank: false }); }

// Projektdatei (.lsproj) in einem eigenen Tab öffnen, noch ohne Verbindung zum Server
function openData(d, title) {
  const t = makeTab(App.docFromData(d), null, title);
  t.dirty = true;
  return addTab(t);
}

/* ---------- Tab-Leiste ---------- */
function stateOf(t) {
  if (t.loading) return 'loading';
  if (t.busy) return 'saving';
  if (t.conflict) return 'conflict';
  if (!t.project) return t.doc && t.doc.shapes.length || t.dirty ? 'unsaved' : 'blank';
  return t.dirty ? 'dirty' : 'saved';
}
const STATE_TEXT = () => ({
  loading: loc('Lade …'), saving: loc('speichert …'), conflict: loc('Konflikt'), unsaved: loc('nicht gespeichert'),
  dirty: loc('ungespeichert'), saved: loc('gespeichert'), blank: loc('Neue, leere Zeichnung')
});

function renderTabs() {
  const bar = $('#tabList');
  if (!bar) return;
  bar.innerHTML = '';
  const txt = STATE_TEXT();
  for (const t of tabs) {
    const st = stateOf(t);
    const el = h('div', { class: 'tab' + (t === active ? ' on' : '') + ' ' + st, title: nameOf(t) + ' – ' + txt[st],
      onclick: () => activate(t),
      onauxclick: e => { if (e.button === 1) { e.preventDefault(); closeTab(t); } },
      ondblclick: () => { if (t.project) renameDialog(t.project); } },
      h('span', { class: 'tdot' }),
      h('span', { class: 'tname' }, nameOf(t)),
      h('button', { class: 'tx', title: loc('Tab schließen'), onclick: e => { e.stopPropagation(); closeTab(t); } }, '×'));
    el.addEventListener('contextmenu', e => { e.preventDefault(); tabMenu(e, t); });
    bar.appendChild(el);
  }
  const on = bar.querySelector('.tab.on');
  if (on) on.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  // Karte des aktiven Projekts in der Seitenleiste
  if (isOpen() && active && active.project) {
    const d = $(`#projList .pcard[data-id="${active.project.id}"] .pdate`);
    if (d) d.textContent = ['saving', 'dirty'].includes(stateOf(active)) ? loc('wird gespeichert …') : fmtDate(active.project.updatedAt);
  }
}

function tabMenu(e, t) {
  App.popupMenu(e.clientX, e.clientY, [
    { t: loc('Projekt speichern'), a: () => { activate(t); save(t, { quiet: false }).catch(() => { }); } },
    { t: loc('Speichern unter…'), a: () => saveAs(t) },
    { t: loc('Umbenennen…'), a: () => renameDialog(t.project), dis: !t.project },
    { sep: 1 },
    { t: loc('Tab schließen'), a: () => closeTab(t) },
    { t: loc('Andere Tabs schließen'), a: () => closeOthers(t), dis: tabs.length < 2 }
  ]);
}
async function closeOthers(keep) {
  activate(keep);
  for (const t of tabs.slice()) if (t !== keep) await closeTab(t);
}

/* ---------- Seitenleiste ---------- */
const panel = () => $('#projPanel');
const isOpen = () => !!store && !!panel() && !panel().hidden;

function toggle(force) {
  if (!store) return;
  const open = force === undefined ? !isOpen() : force;
  panel().hidden = !open;
  $('#projToggle').classList.toggle('on', open);
  ls.set(PANEL_KEY, open ? '1' : '0');
  if (open) refresh();
  App.draw();
}

async function refresh() {
  try { data = await store.list(); }
  catch (e) { data = data || { projects: [], error: e.message }; }
  renderList();
}

function fmtDate(ms) {
  const d = (Date.now() - ms) / 1000;
  if (d < 60) return loc('gerade eben');
  if (d < 3600) return loc('vor {n} Min.', { n: Math.floor(d / 60) });
  if (d < 86400 && new Date(ms).getDate() === new Date().getDate()) return loc('heute, {t}', { t: new Date(ms).toLocaleTimeString(locale, { hour: '2-digit', minute: '2-digit' }) });
  return new Date(ms).toLocaleDateString(locale, { day: 'numeric', month: 'short', year: 'numeric' });
}
const fmtMB = b => b < 104858 ? '< ' + (0.1).toLocaleString(locale) + ' MB' : (b / 1048576).toLocaleString(locale, { maximumFractionDigits: b < 10 * 1048576 ? 1 : 0 }) + ' MB';

function updateCard(p, thumb) {
  if (!data) return;
  const i = data.projects.findIndex(x => x.id === p.id);
  if (i >= 0) {
    const old = data.projects[i];
    data.used += p.size - old.size;
    data.projects.splice(i, 1);
    data.projects.unshift({ ...old, ...p, thumb: thumb || old.thumb });
  }
  renderList();
}

function renderList() {
  const body = $('#projList'), foot = $('#projFoot');
  if (!body || !isOpen()) return;
  body.innerHTML = '';
  if (!data) { body.appendChild(h('div', { class: 'pempty' }, loc('Lade …'))); return; }
  if (data.error) body.appendChild(h('div', { class: 'pempty err' }, data.error));
  const qq = query.trim().toLowerCase();
  const items = data.projects.filter(p => !qq || p.name.toLowerCase().includes(qq));
  if (!data.projects.length && !data.error)
    body.appendChild(h('div', { class: 'pempty' }, loc('Noch keine Projekte. Mit Strg+S speicherst du die aktuelle Zeichnung hier.')));
  else if (!items.length && qq) body.appendChild(h('div', { class: 'pempty' }, loc('Nichts gefunden')));
  for (const p of items) {
    const cur = active && active.project && active.project.id === p.id;
    const open = tabs.some(t => t.project && t.project.id === p.id);
    const card = h('div', { class: 'pcard' + (cur ? ' cur' : open ? ' open' : ''), 'data-id': p.id,
      title: p.name + (open && !cur ? ' – ' + loc('in einem Tab geöffnet') : ''), onclick: () => openProject(p.id) },
      h('div', { class: 'pthumb' }, p.thumb ? h('img', { src: p.thumb, alt: '', loading: 'lazy', draggable: 'false' }) : h('span', {}, '–')),
      h('div', { class: 'pinfo' },
        h('div', { class: 'pname' }, p.name),
        h('div', { class: 'pdate' }, cur && ['saving', 'dirty'].includes(stateOf(active)) ? loc('wird gespeichert …') : fmtDate(p.updatedAt))),
      h('button', { class: 'pmore', title: loc('Mehr …'), onclick: e => { e.stopPropagation(); cardMenu(e, p); } }, '⋯'));
    card.addEventListener('contextmenu', e => { e.preventDefault(); cardMenu(e, p); });
    body.appendChild(card);
  }
  foot.textContent = data.quota ? loc('{used} von {quota} belegt', { used: fmtMB(data.used), quota: fmtMB(data.quota) })
    + (data.maxCount ? ' · ' + loc('{n} von {max} Projekten (kostenlos)', { n: data.projects.length, max: data.maxCount }) : '') : '';
}

function cardMenu(e, p) {
  App.popupMenu(e.clientX, e.clientY, [
    { t: loc('Öffnen'), a: () => openProject(p.id) },
    { t: loc('Umbenennen…'), a: () => renameDialog(p) },
    { t: loc('Duplizieren'), a: () => duplicate(p) },
    { sep: 1 },
    { t: loc('Löschen…'), a: () => removeDialog(p) }
  ]);
}

function renameDialog(p) {
  const inp = h('input', { type: 'text', value: p.name, maxlength: 120, onkeydown: e => { e.stopPropagation(); if (e.key === 'Enter') go(); } });
  const go = async () => {
    m.close();
    try {
      const r = await store.rename(p.id, inp.value);
      for (const t of tabs) if (t.project && t.project.id === p.id) t.project.name = r.name;
      const c = data && data.projects.find(x => x.id === p.id);
      if (c) c.name = r.name;
      persist(); renderTabs(); renderList();
    } catch (e) { toast(e.message, 'err'); }
  };
  const m = modal(loc('Projekt umbenennen'), field(loc('Name'), inp),
    [{ label: loc('Abbrechen') }, { label: loc('Umbenennen'), primary: true, keep: true, click: () => { go(); return false; } }]);
  setTimeout(() => { inp.focus(); inp.select(); }, 0);
}

async function duplicate(p) {
  try {
    const t = tabs.find(x => x.project && x.project.id === p.id);
    if (t && (t.dirty || t.busy)) await save(t);
    await store.duplicate(p.id, loc('{name} (Kopie)', { name: p.name }));
    await refresh();
  } catch (e) {
    if (e.status === 402) limit(e);
    else toast(e.message, 'err');
  }
}

function removeDialog(p) {
  modal(loc('Projekt löschen'), h('p', {}, loc('„{name}" endgültig löschen? Das lässt sich nicht rückgängig machen.', { name: p.name })), [
    { label: loc('Abbrechen') },
    { label: loc('Löschen'), primary: true, click: async () => {
      try {
        await store.remove(p.id);
        // geöffnete Tabs behalten die Zeichnung, sind aber nicht mehr verbunden
        for (const t of tabs) if (t.project && t.project.id === p.id) { clearTimeout(t.saveT); t.title = p.name; link(t, null); t.dirty = true; }
        persist();
        await refresh();
        toast(loc('Projekt gelöscht'));
      } catch (e) { toast(e.message, 'err'); }
    } }
  ]);
}

/* ---------- Start ---------- */
// Tabs der letzten Sitzung wiederherstellen; die Zeichnung des aktiven Tabs hat main.js schon
// aus der Sitzung geladen (App.doc), die übrigen werden erst beim Anklicken geladen.
function restore() {
  let saved = ls.get(TABS);
  if (!saved || !Array.isArray(saved.tabs) || !saved.tabs.length) {
    // Umstieg von der Fassung ohne Tabs
    const old = ls.get(OLD_KEY);
    saved = old && old.id ? { active: 'old', tabs: [{ key: 'old', project: { id: old.id, name: old.name, updatedAt: old.updatedAt }, dirty: !!old.dirty, linkedAt: old.linkedAt || 0 }] } : null;
    ls.del(OLD_KEY);
  }
  const sess = Session.load();
  for (const s of (saved && saved.tabs) || []) {
    const t = makeTab(null, s.project, s.title || '');
    t.key = s.key; t.dirty = !!s.dirty; t.linkedAt = s.linkedAt || 0;
    tabs.push(t);
  }
  let t = tabs.find(x => x.key === (saved && saved.active)) || tabs[0];
  if (!t) { t = makeTab(null); tabs.push(t); }
  // die Sitzung gehört nur dann zu diesem Tab, wenn sie seine Kennung trägt (ältere Sitzungen:
  // nur bei einem einzigen Tab) und nach dem Verbinden gesichert wurde
  const mine = !!sess && (sess.tab ? sess.tab === t.key : tabs.length === 1);
  let local;
  if (mine) { setDoc(t, App.doc, sess.history); local = sess.t >= t.linkedAt; }
  else {
    const st = ls.get(TABDOC + t.key);
    setDoc(t, st && st.doc ? App.docFromData(st.doc) : App.blankDoc());
    local = !!(st && st.doc && st.t >= t.linkedAt);
  }
  ls.del(TABDOC + t.key);
  active = t;
  App.switchDoc(t, !mine);
  if (t.project && !store) { t.title = nameOf(t); link(t, null); t.dirty = true; }
  else if (t.project) {
    if (local && t.dirty) schedule(t, 1500);
    else syncFromServer(t, local);
  }
  // Tabs im Hintergrund: ungespeicherte Zeichnungen und noch nicht gesicherte Änderungen gleich
  // laden (und speichern); unveränderte Projekte erst beim Anklicken vom Server holen
  for (const x of tabs) if (x !== t && (!x.project || x.dirty)) restoreLazy(x);
  persist();
}

function init(app) {
  App = app;
  $('#tabbar').append(
    h('div', { id: 'tabList' }),
    h('button', { id: 'tabAdd', title: loc('Neue, leere Zeichnung in einem neuen Tab'), onclick: newProject }, '+'));
  if (store) buildPanel();

  restore();
  renderTabs();
  window.addEventListener('beforeunload', e => {
    let warn = false;
    for (const t of tabs) {
      if (t.project && (t.dirty || t.busy)) { save(t).catch(() => { }); warn = true; }
      // Zeichnung im Hintergrund, die nicht in den Browser-Speicher passte
      if (t !== active && !t.project && !t.stored && t.doc && t.doc.shapes.length) warn = true;
    }
    if (warn) e.preventDefault();
  });
  if (!store) return;

  // Übersicht beim Start: zuletzt offen, oder leere Zeichnung und es gibt schon Projekte
  const wasOpen = ls.get(PANEL_KEY);
  if (wasOpen === '1') toggle(true);
  else if (tabs.length === 1 && !App.doc.shapes.length)
    store.list().then(d => { data = d; if (d.projects.length && !App.doc.shapes.length) toggle(true); }).catch(() => { });
}

// Seitenleiste „Meine Projekte" und Knopf davor in der Tab-Leiste
function buildPanel() {
  const search = h('input', { type: 'search', placeholder: loc('Projekte suchen …'),
    oninput: e => { query = e.target.value; renderList(); }, onkeydown: e => e.stopPropagation() });
  panel().append(
    h('h3', {}, h('span', {}, loc('Meine Projekte')), h('span', { class: 'x', title: loc('Schließen'), onclick: () => toggle(false) }, '✕')),
    h('div', { class: 'pbar' }, search,
      h('div', { class: 'row' },
        h('button', { class: 'tbtn', onclick: newProject, title: loc('Neue, leere Zeichnung in einem neuen Tab') }, '+ ' + loc('Neu')),
        h('button', { class: 'tbtn big', onclick: () => save(active, { quiet: false }).catch(() => { }), title: loc('Projekt speichern') }, loc('Speichern')))),
    h('div', { id: 'projList' }),
    h('div', { id: 'projFoot' }));
  $('#tabbar').prepend(h('button', { id: 'projToggle', title: loc('Meine Projekte'), onclick: () => toggle() }, '☰ ' + loc('Projekte')));
}

export const Projects = {
  init, changed, openData, newProject, toggle,
  // vor init setzen (Erweiterung beim Start)
  setStore(s) { store = s; },
  get hasStore() { return !!store; },
  save: opts => save(active, opts).catch(() => { }),
  saveAs: () => saveAs(active),
  closeTab: () => closeTab(active),
  get current() { return active && active.project; },
  // Name des aktiven Tabs: Projektname, sonst Titel (z. B. Name einer geöffneten Datei), sonst ''
  get title() { return active ? (active.project ? active.project.name : active.title) || '' : ''; },
  get isOpen() { return isOpen(); }
};
