// icons.js — Strich-Icons der Werkzeugleiste (24×24, Farbe über currentColor)

const P = {
  select: '<path d="M5.5 3.5 19 10.8l-6 1.7-3 6z" fill="currentColor"/>',
  node: '<circle cx="18" cy="5.5" r="2.2"/><circle cx="6" cy="18.5" r="2.2"/>' +
    '<path d="M15.8 5.5H10a3.25 3.25 0 0 0 0 6.5h4a3.25 3.25 0 0 1 0 6.5H8.2"/>',
  rect: '<rect x="3.5" y="5.5" width="17" height="13" rx="2"/>',
  ellipse: '<circle cx="12" cy="12" r="8.5"/>',
  polygon: '<path d="M12 3.2 19.6 7.6v8.8L12 20.8l-7.6-4.4V7.6z"/>',
  line: '<path d="M5 19 19 5"/>',
  pen: '<path d="M3.5 19.5c1.5-2.5 3-2.5 4 0s2.5 1.5 3.2-.8"/>' +
    '<path d="M12.5 15.2 19.3 8.4a1.6 1.6 0 0 0-2.3-2.3l-6.8 6.8-.8 3.1z"/>',
  text: '<text x="12" y="17" text-anchor="middle" font-size="13.5" font-weight="600" ' +
    'font-family="system-ui,-apple-system,Segoe UI,sans-serif" fill="currentColor" stroke="none">Aa</text>',
  measure: '<rect x="2.5" y="8" width="19" height="8" rx="1.5"/><path d="M6.5 8v3M10 8v4M13.5 8v3M17 8v4"/>',
  symbols: '<path d="M12 19.5s-7.5-4.6-7.5-10.2A4.1 4.1 0 0 1 12 7a4.1 4.1 0 0 1 7.5 2.3c0 5.6-7.5 10.2-7.5 10.2z"/>',
  import: '<rect x="3" y="4.5" width="15" height="13" rx="2"/><circle cx="8" cy="9" r="1.4"/>' +
    '<path d="m3.5 15.5 4-4 3.5 3.5 2-2 4.5 4.5"/>' +
    '<circle cx="18.5" cy="17.5" r="4.5" fill="currentColor" stroke="var(--bg2)" stroke-width="1.5"/>' +
    '<path d="M18.5 15.3v4.4M16.3 17.5h4.4" stroke="#fff" stroke-width="1.6"/>',
  // obere Leiste
  undo: '<path d="M9 14 4 9l5-5"/><path d="M4 9h10.5a5.5 5.5 0 0 1 0 11H11"/>',
  redo: '<path d="m15 14 5-5-5-5"/><path d="M20 9H9.5a5.5 5.5 0 0 0 0 11H13"/>',
  fitall: '<path d="M4 8.5V5a1 1 0 0 1 1-1h3.5M15.5 4H19a1 1 0 0 1 1 1v3.5M20 15.5V19a1 1 0 0 1-1 1h-3.5M8.5 20H5a1 1 0 0 1-1-1v-3.5"/>' +
    '<rect x="8" y="9" width="5" height="5" rx=".8"/><circle cx="15.5" cy="14.5" r="2"/>',
  fitbed: '<rect x="3" y="4.5" width="18" height="15" rx="1.5"/><path d="M3 8.5h18M7 4.5v15"/>',
  union: '<path d="M12 7.5A6 6 0 1 0 12 16.5A6 6 0 1 0 12 7.5Z" fill="currentColor" fill-opacity=".3"/>',
  subtract: '<path d="M12 7.5A6 6 0 1 0 12 16.5A6 6 0 0 1 12 7.5Z" fill="currentColor" fill-opacity=".3"/>' +
    '<circle cx="16" cy="12" r="6" stroke-dasharray="2 2" stroke-width="1.3"/>',
  intersect: '<circle cx="8" cy="12" r="6" stroke-width="1.3"/><circle cx="16" cy="12" r="6" stroke-width="1.3"/>' +
    '<path d="M12 7.5A6 6 0 0 1 12 16.5A6 6 0 0 1 12 7.5Z" fill="currentColor" fill-opacity=".55"/>',
  xor: '<path d="M12 7.5A6 6 0 1 0 12 16.5A6 6 0 1 0 12 7.5ZM12 7.5A6 6 0 0 1 12 16.5A6 6 0 0 1 12 7.5Z" fill="currentColor" fill-opacity=".3" fill-rule="evenodd"/>' +
    '<path d="M12 7.5A6 6 0 0 1 12 16.5A6 6 0 0 1 12 7.5Z" stroke-width="1.3"/>',
  // Assistent „Formen kombinieren": zwei Kreise mit Auge (Live-Vorschau)
  boolassist: '<circle cx="8.5" cy="9" r="5.5"/><circle cx="15.5" cy="9" r="5.5" stroke-dasharray="2 2" stroke-width="1.4"/>' +
    '<path d="M6.5 19.5c3-3.3 8-3.3 11 0-3 3.3-8 3.3-11 0z" stroke-width="1.5"/><circle cx="12" cy="19.5" r="1.3" fill="currentColor" stroke="none"/>',
  offset: '<rect x="8.5" y="8.5" width="7" height="7" rx="1"/><rect x="4" y="4" width="16" height="16" rx="4.5" stroke-dasharray="2.6 2.2"/>',
  alignleft: '<path d="M4 3v18"/><rect x="7.5" y="6" width="12" height="4.5" rx="1"/><rect x="7.5" y="13.5" width="7" height="4.5" rx="1"/>',
  alignright: '<path d="M20 3v18"/><rect x="4.5" y="6" width="12" height="4.5" rx="1"/><rect x="9.5" y="13.5" width="7" height="4.5" rx="1"/>',
  aligntop: '<path d="M3 4h18"/><rect x="6" y="7.5" width="4.5" height="12" rx="1"/><rect x="13.5" y="7.5" width="4.5" height="7" rx="1"/>',
  alignbottom: '<path d="M3 20h18"/><rect x="6" y="4.5" width="4.5" height="12" rx="1"/><rect x="13.5" y="9.5" width="4.5" height="7" rx="1"/>',
  centerbed: '<rect x="3" y="3" width="18" height="18" rx="2"/><rect x="9" y="9" width="6" height="6" rx="1"/>' +
    '<path d="M12 3v3.5M12 17.5V21M3 12h3.5M17.5 12H21" stroke-width="1.4"/>',
  group: '<rect x="3" y="3" width="18" height="18" rx="2" stroke-dasharray="3 2.4" stroke-width="1.4"/>' +
    '<rect x="6.5" y="6.5" width="6" height="6" rx="1"/><circle cx="15" cy="15" r="3"/>',
  array: '<rect x="4" y="4" width="6.5" height="6.5" rx="1"/><rect x="13.5" y="4" width="6.5" height="6.5" rx="1"/>' +
    '<rect x="4" y="13.5" width="6.5" height="6.5" rx="1"/><rect x="13.5" y="13.5" width="6.5" height="6.5" rx="1"/>',
  material: '<rect x="3" y="6" width="18" height="12" rx="1.5"/><path d="M3 10.5c5 1.2 10-1.2 18 0M3 14.5c6 1 11-1.2 18 0" stroke-width="1.3"/>',
  preview: '<path d="M8 5.5v13l10.5-6.5z" fill="currentColor" fill-opacity=".2"/>',
  frame: '<rect x="4.5" y="4.5" width="15" height="15" rx="1" stroke-dasharray="3 2.4"/><circle cx="4.5" cy="4.5" r="2" fill="currentColor"/>',
  gcode: '<path d="M12 3.5v11M7.5 10l4.5 4.5 4.5-4.5"/><path d="M4 16.5V19a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-2.5"/>'
};

// weitere Icons (z. B. für Werkzeuge aus einer Erweiterung)
export function addIcons(map) { Object.assign(P, map); }

export function icon(name, size = 22) {
  const s = document.createElement('span');
  s.className = 'ic';
  s.innerHTML = '<svg viewBox="0 0 24 24" width="' + size + '" height="' + size + '" fill="none" stroke="currentColor" ' +
    'stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + (P[name] || '') + '</svg>';
  return s;
}
