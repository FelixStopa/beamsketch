// storage.js — Browser-Speicher für Zeichnungen, Tabs und Materialien.
// Ohne Erweiterung liegt alles in einem lokalen Bereich (Präfix laserstudio.local.). Eine
// Erweiterung kann einen eigenen Bereich setzen (z. B. je Konto getrennt), siehe setStorageArea.
const PREFIX = 'laserstudio.local.';

export const localArea = {
  prefix: PREFIX,
  getItem: k => localStorage.getItem(PREFIX + k),
  setItem: (k, v) => localStorage.setItem(PREFIX + k, v),
  removeItem: k => localStorage.removeItem(PREFIX + k)
};
let area = localArea;

// a: { getItem, setItem, removeItem } – darf beim Schreiben werfen (dann wird nichts gespeichert)
export function setStorageArea(a) { area = a || localArea; }

export const storage = {
  getItem(k) { try { return area.getItem(k); } catch (e) { return null; } },
  setItem(k, v) { area.setItem(k, v); },
  removeItem(k) { try { area.removeItem(k); } catch (e) { /* egal */ } }
};
