// units.js — Anzeige-Einheit für Geschwindigkeiten.
// Intern (Dokument, Vorlagen, GCode-Berechnung) wird immer in mm/s gerechnet;
// umgerechnet wird nur bei Anzeige und Eingabe.
const KEY = 'laserstudio.speedUnit';

let unit = 'mm/s';
try { if (localStorage.getItem(KEY) === 'mm/min') unit = 'mm/min'; } catch (e) { /* egal */ }

export const speedUnit = () => unit;
export function setSpeedUnit(u) {
  unit = u === 'mm/min' ? 'mm/min' : 'mm/s';
  try { localStorage.setItem(KEY, unit); } catch (e) { /* egal */ }
}
/* mm/s → Anzeige-Einheit */
export const toDisp = v => unit === 'mm/min' ? v * 60 : v;
/* Anzeige-Einheit → mm/s */
export const fromDisp = v => unit === 'mm/min' ? v / 60 : v;
export const speedStep = () => unit === 'mm/min' ? 10 : 1;
/* „350 mm/min" bzw. „5.8 mm/s" */
export const fmtSpeed = v => (Math.round(toDisp(v) * 10) / 10) + ' ' + unit;
