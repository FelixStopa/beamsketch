// i18n.js — Übersetzungen. Der deutsche Text ist gleichzeitig der Schlüssel:
// loc('Datei') liefert in der gewählten Sprache die Übersetzung, sonst Deutsch.
// Platzhalter: loc('{n} Objekte', { n: 3 }).
// Die Sprachdatei wird per Top-Level-await geladen, bevor irgendein anderes
// Modul Texte erzeugt – ein Sprachwechsel lädt die Seite neu.

const KEY = 'laserstudio.lang';

export const LANGS = [
  { code: 'de', name: 'Deutsch' },
  { code: 'en', name: 'English' },
  { code: 'es', name: 'Español' },
  { code: 'fr', name: 'Français' },
  { code: 'it', name: 'Italiano' },
  { code: 'pt', name: 'Português' },
  { code: 'nl', name: 'Nederlands' },
  { code: 'pl', name: 'Polski' },
  { code: 'tr', name: 'Türkçe' },
  { code: 'ru', name: 'Русский' },
  { code: 'ja', name: '日本語' },
  { code: 'zh', name: '简体中文' },
  { code: 'ko', name: '한국어' }
];

function detect() {
  try {
    const saved = localStorage.getItem(KEY);
    if (saved && LANGS.some(l => l.code === saved)) return saved;
  } catch (e) { /* egal */ }
  for (const full of navigator.languages || [navigator.language || '']) {
    const c = String(full).toLowerCase().split('-')[0];
    if (LANGS.some(l => l.code === c)) return c;
  }
  return 'en';
}

export const lang = detect();
// dem Server die Sprache mitteilen: Kontoseite und E-Mails folgen ihr (Deutsch oder sonst Englisch)
try { document.cookie = `ls_lang=${lang}; path=/; max-age=31536000; samesite=lax`; } catch (e) { /* egal */ }
let dict = {};
if (lang !== 'de') {
  try { dict = (await import(`./locales/${lang}.js`)).default || {}; }
  catch (e) { console.warn('Sprachdatei nicht ladbar:', lang, e.message); }
}

// weitere Übersetzungen (z. B. aus einer Erweiterung) – vorhandene Einträge bleiben
export function addTranslations(d) { dict = { ...(d || {}), ...dict }; }

export function loc(s, params) {
  let r = dict[s];
  if (r === undefined || r === '') r = s;
  if (params) r = r.replace(/\{(\w+)\}/g, (m, k) => (k in params ? String(params[k]) : m));
  return r;
}

/* Sprachkürzel für toLocaleString & Co. */
export const locale = { de: 'de-DE', en: 'en-GB', zh: 'zh-CN', pt: 'pt-BR' }[lang] || lang;

export function setLang(code) {
  try { localStorage.setItem(KEY, code); } catch (e) { /* egal */ }
  location.reload();
}

/* Statische Texte in index.html: data-i18n (Text) und data-i18n-title (Tooltip) */
export function translateDOM(root = document) {
  document.documentElement.lang = lang;
  root.querySelectorAll('[data-i18n]').forEach(el => { el.textContent = loc(el.getAttribute('data-i18n') || el.textContent.trim()); });
  root.querySelectorAll('[data-i18n-title]').forEach(el => { el.title = loc(el.getAttribute('data-i18n-title')); });
  document.title = loc('BeamSketch – Online Laser-Editor');
}
