// pages.js — mehrseitige Projekte. Die Formen der aktuellen Seite liegen wie bisher in doc.shapes, damit alle
// Werkzeuge, Export und Laser unverändert auf „der Zeichnung" arbeiten; die übrigen Seiten liegen in
// doc.settings.pages (wird mit dem Projekt gespeichert). Lasern und Exportieren betreffen die aktuelle Seite.
import { uid, walk } from './doc.js';

export function pageList(doc) {
  const s = doc.settings;
  if (!Array.isArray(s.pages) || !s.pages.length) s.pages = [{ name: '', shapes: null }];
  if (!(s.page >= 0 && s.page < s.pages.length)) s.page = 0;
  return s.pages;
}
export const pageIndex = doc => { pageList(doc); return doc.settings.page; };

/* zur Seite i wechseln; gibt true zurück, wenn gewechselt wurde */
export function switchPage(doc, i) {
  const p = pageList(doc), cur = doc.settings.page;
  if (i === cur || i < 0 || i >= p.length) return false;
  p[cur].shapes = doc.shapes;
  doc.shapes = p[i].shapes || [];
  p[i].shapes = null;
  doc.settings.page = i;
  return true;
}

const cloneShapes = list => {
  const c = JSON.parse(JSON.stringify(list));
  walk(c, x => { x.id = uid(); });
  return c;
};

/* neue Seite hinter der aktuellen (leer oder als Kopie) und dorthin wechseln */
export function addPage(doc, copy = false) {
  const p = pageList(doc), cur = doc.settings.page;
  p.splice(cur + 1, 0, { name: '', shapes: copy ? cloneShapes(doc.shapes) : [] });
  switchPage(doc, cur + 1);
  return cur + 1;
}

/* aktuelle Seite löschen (die letzte Seite bleibt immer, wird nur geleert) */
export function deletePage(doc) {
  const p = pageList(doc), cur = doc.settings.page;
  if (p.length === 1) { doc.shapes = []; return 0; }
  const target = cur > 0 ? cur - 1 : 1;
  switchPage(doc, target);
  p.splice(cur, 1);
  doc.settings.page = target > cur ? target - 1 : target;
  return doc.settings.page;
}

/* Formen auf eine andere Seite verschieben */
export function moveToPage(doc, shapes, i) {
  const p = pageList(doc), cur = doc.settings.page;
  if (i === cur || i < 0 || i >= p.length) return 0;
  const set = new Set(shapes);
  doc.shapes = doc.shapes.filter(s => !set.has(s));
  p[i].shapes = (p[i].shapes || []).concat(shapes);
  return shapes.length;
}

/* Seite von a nach b verschieben (Reihenfolge) */
export function movePage(doc, a, b) {
  const p = pageList(doc);
  if (a === b || a < 0 || b < 0 || a >= p.length || b >= p.length) return;
  const cur = doc.settings.page;
  const [pg] = p.splice(a, 1);
  p.splice(b, 0, pg);
  // die aktuelle Seite behält ihren Inhalt in doc.shapes – nur der Index wandert mit
  doc.settings.page = cur === a ? b : (a < cur && b >= cur ? cur - 1 : a > cur && b <= cur ? cur + 1 : cur);
}

export const pageName = (doc, i) => (pageList(doc)[i].name || '');
