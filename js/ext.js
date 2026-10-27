// ext.js — Erweiterungen: Funktionen außerhalb des Editors, z. B. Konto, Online-Speicher und
// KI-Werkzeuge auf beamsketch.com. Die Seite nennt sie in
//   <meta name="beamsketch-ext" content="/pfad/a.js, /pfad/b.js">
// Jede Datei exportiert setup(App, helpers) und wird vor dem Aufbau der Oberfläche geladen.
// Ohne Erweiterung läuft der Editor vollständig im Browser: Projekte werden als Datei gespeichert.
//
// Eine Erweiterung kann …
//   Ext.addTool(id, tool, { ic, t })     ein Werkzeug in die Werkzeugleiste setzen
//   Ext.addMenu(menu, items)             Einträge in ein Menü (file, help …) einfügen
//   Ext.onStart(fn)                      fn(App) vor dem Laden der Sitzung; false bricht den Start ab
//   Ext.hooks.phone = fn                 statt des Handy-Hinweises eine eigene Seite zeigen
//   Ext.hooks.limit = fn(message)        Grenze des Online-Speichers erreicht (z. B. Angebot zeigen)
//   Ext.hooks.needStore = fn(kind)       Speichern ohne Online-Speicher ('project' | 'symbol');
//                                        true = erledigt, sonst speichert der Editor als Datei
//   Ext.hooks.about = fn()               zusätzliche Zeilen (Knoten) für „Über BeamSketch"
// Online-Speicher: Projects.setStore (projects.js), UserSymbols.setStore (symbols.js),
// Browser-Speicher je Konto: setStorageArea (storage.js).
export const Ext = {
  tools: [],
  menus: {},
  start: [],
  hooks: {},
  addTool(id, tool, def) { Ext.tools.push({ id, tool, ...def }); },
  addMenu(menu, items) { (Ext.menus[menu] = Ext.menus[menu] || []).push(...items); },
  onStart(fn) { Ext.start.push(fn); }
};

export async function loadExtensions(App, helpers) {
  const meta = document.querySelector('meta[name="beamsketch-ext"]');
  const urls = meta ? meta.content.split(',').map(s => s.trim()).filter(Boolean) : [];
  for (const url of urls) {
    try {
      const m = await import(new URL(url, location.href).href);
      if (m.setup) await m.setup(App, helpers);
    } catch (e) { console.error('Erweiterung nicht ladbar:', url, e); }
  }
}
