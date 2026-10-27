// raster.js — Bildgravur: Graustufen, Dithering, Scanzeilen mit Leistungsmodulation
import { Mat } from './geom.js';

export const ImageCache = new Map(); // src -> HTMLImageElement
export function getImage(src) {
  if (ImageCache.has(src)) return ImageCache.get(src);
  const im = new Image();
  im.src = src;
  ImageCache.set(src, im);
  return im;
}
export function loadImage(src) {
  return new Promise((res, rej) => {
    const im = getImage(src);
    if (im.complete && im.naturalWidth) return res(im);
    im.onload = () => res(im); im.onerror = rej;
  });
}

const BAYER8 = [
  [0, 32, 8, 40, 2, 34, 10, 42], [48, 16, 56, 24, 50, 18, 58, 26],
  [12, 44, 4, 36, 14, 46, 6, 38], [60, 28, 52, 20, 62, 30, 54, 22],
  [3, 35, 11, 43, 1, 33, 9, 41], [51, 19, 59, 27, 49, 17, 57, 25],
  [15, 47, 7, 39, 13, 45, 5, 37], [63, 31, 55, 23, 61, 29, 53, 21]
];

export function grayscaleGrid(sh, cols, rows) {
  const im = getImage(sh.src);
  if (!im.complete || !im.naturalWidth) return null;
  const cv = document.createElement('canvas');
  cv.width = cols; cv.height = rows;
  const g = cv.getContext('2d', { willReadFrequently: true });
  g.fillStyle = '#fff'; g.fillRect(0, 0, cols, rows);
  g.imageSmoothingQuality = 'high';
  g.drawImage(im, 0, 0, cols, rows);
  const d = g.getImageData(0, 0, cols, rows).data;
  const gray = new Float32Array(cols * rows);
  const bri = (sh.brightness || 0) / 100, con = (sh.contrast || 0) / 100, gam = sh.gamma || 1;
  for (let i = 0; i < cols * rows; i++) {
    const a = d[i * 4 + 3] / 255;
    let v = (0.299 * d[i * 4] + 0.587 * d[i * 4 + 1] + 0.114 * d[i * 4 + 2]) / 255;
    if (sh.transparency && a < 1) v = v * a + (1 - a); // transparent = weiß
    v = v + bri;
    v = (v - 0.5) * (1 + con) + 0.5;
    if (gam !== 1) v = Math.pow(Math.max(0, Math.min(1, v)), 1 / gam);
    if (sh.negative) v = 1 - v;
    gray[i] = Math.max(0, Math.min(1, v));
  }
  return gray;
}

function dither(gray, cols, rows, mode, threshold) {
  const out = new Float32Array(cols * rows);
  const t = threshold / 255;
  if (mode === 'none' || mode === 'grayscale') { for (let i = 0; i < gray.length; i++) out[i] = 1 - gray[i]; return out; }
  if (mode === 'threshold') { for (let i = 0; i < gray.length; i++) out[i] = gray[i] < t ? 1 : 0; return out; }
  if (mode === 'ordered') {
    for (let y = 0; y < rows; y++) for (let x = 0; x < cols; x++) {
      const th = (BAYER8[y & 7][x & 7] + 0.5) / 64;
      out[y * cols + x] = gray[y * cols + x] < th ? 1 : 0;
    }
    return out;
  }
  const kernels = {
    floyd: [[1, 0, 7 / 16], [-1, 1, 3 / 16], [0, 1, 5 / 16], [1, 1, 1 / 16]],
    jarvis: [[1, 0, 7 / 48], [2, 0, 5 / 48], [-2, 1, 3 / 48], [-1, 1, 5 / 48], [0, 1, 7 / 48], [1, 1, 5 / 48], [2, 1, 3 / 48],
    [-2, 2, 1 / 48], [-1, 2, 3 / 48], [0, 2, 5 / 48], [1, 2, 3 / 48], [2, 2, 1 / 48]],
    stucki: [[1, 0, 8 / 42], [2, 0, 4 / 42], [-2, 1, 2 / 42], [-1, 1, 4 / 42], [0, 1, 8 / 42], [1, 1, 4 / 42], [2, 1, 2 / 42],
    [-2, 2, 1 / 42], [-1, 2, 2 / 42], [0, 2, 4 / 42], [1, 2, 2 / 42], [2, 2, 1 / 42]],
    atkinson: [[1, 0, 1 / 8], [2, 0, 1 / 8], [-1, 1, 1 / 8], [0, 1, 1 / 8], [1, 1, 1 / 8], [0, 2, 1 / 8]],
    sierra: [[1, 0, 5 / 32], [2, 0, 3 / 32], [-2, 1, 2 / 32], [-1, 1, 4 / 32], [0, 1, 5 / 32], [1, 1, 4 / 32], [2, 1, 2 / 32],
    [-1, 2, 2 / 32], [0, 2, 3 / 32], [1, 2, 2 / 32]]
  };
  const K = kernels[mode] || kernels.stucki;
  const buf = Float32Array.from(gray);
  for (let y = 0; y < rows; y++) {
    for (let x = 0; x < cols; x++) {
      const i = y * cols + x;
      const old = buf[i];
      const nv = old < 0.5 ? 0 : 1;
      out[i] = nv === 0 ? 1 : 0;
      const err = old - nv;
      for (const [dx, dy, w] of K) {
        const nx = x + dx, ny = y + dy;
        if (nx < 0 || nx >= cols || ny >= rows) continue;
        buf[ny * cols + nx] += err * w;
      }
    }
  }
  return out;
}

/* Erzeugt Scanzeilen im Weltkoordinatensystem.
   Rückgabe: [{pts:[a,b], cells:Float32Array(0..1), n, power}] */
export function imageScanLines(sh, layer, doc, ctx) {
  const im = getImage(sh.src);
  if (!im.complete || !im.naturalWidth) return [];
  const interval = Math.max(0.01, layer.interval);
  const cols = Math.max(1, Math.round(Math.abs(sh.w) / interval));
  const rows = Math.max(1, Math.round(Math.abs(sh.h) / interval));
  if (cols * rows > 30e6) return [];
  const gray = grayscaleGrid(sh, cols, rows);
  if (!gray) return [];
  let vals = dither(gray, cols, rows, sh.dither, sh.threshold);
  if (sh.invert) for (let i = 0; i < vals.length; i++) vals[i] = 1 - vals[i];
  const m = sh.worldMat || sh.transform;
  const dx = sh.w / cols, dy = sh.h / rows;
  const out = [];
  const ovCells = Math.ceil(((layer.overscan || 0) / 100 * 10) / Math.max(dx, 1e-6));
  for (let r = 0; r < rows; r++) {
    const y = sh.h - (r + 0.5) * dy;   // Bildzeile 0 ist oben
    let first = -1, last = -1;
    for (let c = 0; c < cols; c++) { if (vals[r * cols + c] > 0.002) { if (first < 0) first = c; last = c; } }
    if (first < 0) continue;
    const rev = layer.bidir && (r & 1);
    const cells = new Float32Array(last - first + 1);
    for (let c = first; c <= last; c++) cells[c - first] = vals[r * cols + c];
    const xa = first * dx, xb = (last + 1) * dx;
    const over = ovCells * dx;
    const a = { x: rev ? xb + over : xa - over, y };
    const b = { x: rev ? xa - over : xb + over, y };
    out.push({
      pts: [Mat.apply(m, a), Mat.apply(m, b)],
      cells: rev ? cells.slice().reverse() : cells,
      lead: over, n: cells.length, power: layer.maxPower,
      grayscale: (sh.dither === 'none' || sh.dither === 'grayscale')
    });
  }
  return out;
}

/* ============================================================
   Live-Vorschau: Bild so darstellen, wie es graviert wird
   (Graustufen, Schwellwert, Dithering, Helligkeit/Kontrast/Gamma)
   ============================================================ */
const previewCache = new Map(); // shape.id -> {sig, canvas, cols, rows}

export function invalidateImagePreview(id) {
  if (id === undefined) previewCache.clear(); else previewCache.delete(id);
}

/* Liefert ein Canvas mit dem verarbeiteten Bild (weiß = keine Gravur).
   `interval` = Zeilenabstand der Ebene in mm, damit das Dither-Muster
   der späteren Gravur entspricht. `override` überschreibt einzelne
   Bildparameter (z. B. für die Vorschau beim Nachzeichnen). */
export function imagePreviewCanvas(sh, interval, override, maxPixels) {
  const im = getImage(sh.src);
  if (!im.complete || !im.naturalWidth) return null;
  const eff = override ? { ...sh, ...override } : sh;
  const iv = Math.max(0.02, interval || 0.1);
  let cols = Math.max(1, Math.round(Math.abs(sh.w) / iv));
  let rows = Math.max(1, Math.round(Math.abs(sh.h) / iv));
  // Auflösung des Originals nicht überschreiten und Obergrenze einhalten
  const natMax = Math.max(im.naturalWidth, im.naturalHeight) * 2;
  const dimMax = Math.max(cols, rows);
  if (dimMax > natMax) { const k = natMax / dimMax; cols = Math.max(1, Math.round(cols * k)); rows = Math.max(1, Math.round(rows * k)); }
  const MAXPX = Math.max(2e4, maxPixels || 2.2e6);
  if (cols * rows > MAXPX) {
    const k = Math.sqrt(MAXPX / (cols * rows));
    cols = Math.max(1, Math.round(cols * k)); rows = Math.max(1, Math.round(rows * k));
  }
  const sig = [cols, rows, eff.dither, eff.threshold, eff.brightness, eff.contrast, eff.gamma,
    eff.invert, eff.negative, eff.transparency, sh.src.length].join('|');
  const c = previewCache.get(sh.id);
  if (c && c.sig === sig) return c.canvas;

  const gray = grayscaleGrid(eff, cols, rows);
  if (!gray) return null;
  const vals = dither(gray, cols, rows, eff.dither, eff.threshold);
  if (eff.invert) for (let i = 0; i < vals.length; i++) vals[i] = 1 - vals[i];
  const cv = document.createElement('canvas');
  cv.width = cols; cv.height = rows;
  const g = cv.getContext('2d');
  const img = g.createImageData(cols, rows);
  const dd = img.data;
  for (let i = 0; i < vals.length; i++) {
    const v = Math.max(0, Math.min(255, Math.round(255 * (1 - vals[i]))));
    dd[i * 4] = dd[i * 4 + 1] = dd[i * 4 + 2] = v;
    dd[i * 4 + 3] = 255;
  }
  g.putImageData(img, 0, 0);
  if (previewCache.size > 40) previewCache.clear();
  previewCache.set(sh.id, { sig, canvas: cv, cols, rows });
  return cv;
}
