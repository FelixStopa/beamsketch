// library.js — Materialbibliothek und Sitzungsspeicherung (localStorage)
import { storage as area } from './storage.js';
// Zeichnung und Materialien je Speicherbereich (Konto/lokal), Gerät und Oberfläche für den ganzen Browser
const storage = key => [KEY_DOC, KEY_LIB].includes(key) ? area : localStorage;
const KEY_DOC = 'laserstudio.session';
const KEY_LIB = 'laserstudio.materials';
const KEY_MACH = 'laserstudio.machine';
const KEY_UI = 'laserstudio.ui';

export const DEFAULT_MATERIALS = [
  { name: 'Sperrholz 3 mm – Schneiden', mode: 'line', speed: 4, maxPower: 100, minPower: 100, passes: 3, airAssist: true, constantPower: false, interval: 0.1 },
  { name: 'Sperrholz 3 mm – Gravur', mode: 'fill', speed: 180, maxPower: 30, minPower: 0, passes: 1, interval: 0.08, airAssist: true },
  { name: 'MDF 3 mm – Schneiden', mode: 'line', speed: 3, maxPower: 100, minPower: 100, passes: 4, airAssist: true },
  { name: 'Karton 1 mm – Schneiden', mode: 'line', speed: 12, maxPower: 60, minPower: 60, passes: 1, airAssist: true },
  { name: 'Papier – Schneiden', mode: 'line', speed: 30, maxPower: 25, minPower: 25, passes: 1, airAssist: true },
  { name: 'Leder 2 mm – Schneiden', mode: 'line', speed: 8, maxPower: 80, minPower: 80, passes: 2, airAssist: true },
  { name: 'Leder – Gravur', mode: 'fill', speed: 250, maxPower: 20, minPower: 0, passes: 1, interval: 0.1 },
  { name: 'Acryl schwarz 3 mm – Schneiden', mode: 'line', speed: 2, maxPower: 100, minPower: 100, passes: 4, airAssist: true },
  { name: 'Acryl – Gravur', mode: 'fill', speed: 200, maxPower: 45, minPower: 0, passes: 1, interval: 0.06 },
  { name: 'Bambus – Gravur', mode: 'fill', speed: 220, maxPower: 35, minPower: 0, passes: 1, interval: 0.07 },
  { name: 'Eloxiertes Alu – Markieren', mode: 'fill', speed: 150, maxPower: 100, minPower: 0, passes: 1, interval: 0.05 },
  { name: 'Glas – Mattieren', mode: 'fill', speed: 120, maxPower: 60, minPower: 0, passes: 1, interval: 0.06 },
  { name: 'Testlinie (schwach)', mode: 'line', speed: 200, maxPower: 8, minPower: 8, passes: 1, airAssist: false }
];

function read(key, fallback) {
  try { const s = storage(key).getItem(key); return s ? JSON.parse(s) : fallback; }
  catch (e) { return fallback; }
}
function write(key, val) {
  try { storage(key).setItem(key, JSON.stringify(val)); return true; }
  catch (e) { return false; }
}

export const Library = {
  materials() {
    const m = read(KEY_LIB, null);
    return (m && m.length) ? m : DEFAULT_MATERIALS.slice();
  },
  saveMaterials(list) { return write(KEY_LIB, list); },
  addMaterial(mat) { const l = this.materials(); l.push(mat); this.saveMaterials(l); },
  removeMaterial(i) { const l = this.materials(); l.splice(i, 1); this.saveMaterials(l); },
  resetMaterials() { try { area.removeItem(KEY_LIB); } catch (e) { } }
};

export const Session = {
  save(doc, history) {
    // tab: zu welchem Tab die Zeichnung gehört (projects.js); history: Rückgängig-Verlauf (doc.js),
    // damit er nach dem Neuladen der Seite erhalten bleibt – passt er nicht in den Speicher, ohne ihn
    const payload = { shapes: doc.shapes, layers: doc.layers, settings: doc.settings, tab: doc.tabKey, t: Date.now() };
    let hist = null;
    try { hist = history ? history.serialize(doc, { maxBytes: 1.5e6, maxSteps: 100 }) : null; } catch (e) { /* ohne Verlauf */ }
    const ok = (hist && write(KEY_DOC, { ...payload, history: hist })) || write(KEY_DOC, payload);
    write(KEY_MACH, doc.machine);
    return ok;
  },
  load() { return read(KEY_DOC, null); },
  loadMachine() { return read(KEY_MACH, null); },
  loadUI() { return read(KEY_UI, null) || {}; },
  saveUI(ui) { return write(KEY_UI, ui); },
  clear() { try { area.removeItem(KEY_DOC); } catch (e) { } }
};
