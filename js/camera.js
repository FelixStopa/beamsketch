// camera.js — Kamera über der Arbeitsfläche: Webcam-Bild aufnehmen, über vier bekannte Punkte entzerren
// (Homographie) und als Hintergrund unter die Zeichnung legen – zum Ausrichten auf Werkstücken.
// Mit einem Raster aus 3×3 oder 5×5 Kreuzen wird zusätzlich die Verzeichnung des Objektivs (radial, k1/k2)
// geschätzt – Webcams mit Weitwinkel biegen gerade Linien zum Rand hin nach außen.
import { h, modal, field, selectInput, slider, checkbox, toast, fmtNum } from './ui.js';
import { loc } from './i18n.js';
import { Shape, nodeSub } from './doc.js';

const App = () => window.App;
const KEY = 'beamsketch.camera';

/* Homographie H (3×3, zeilenweise) mit H·src[i] ≅ dst[i] für vier Punktpaare */
export function homography(src, dst) {
  const A = [], b = [];
  for (let i = 0; i < 4; i++) {
    const { x, y } = src[i], { x: u, y: v } = dst[i];
    A.push([x, y, 1, 0, 0, 0, -u * x, -u * y]); b.push(u);
    A.push([0, 0, 0, x, y, 1, -v * x, -v * y]); b.push(v);
  }
  // Gauß mit Pivotsuche
  for (let c = 0; c < 8; c++) {
    let p = c;
    for (let r = c + 1; r < 8; r++) if (Math.abs(A[r][c]) > Math.abs(A[p][c])) p = r;
    if (Math.abs(A[p][c]) < 1e-12) return null;
    [A[c], A[p]] = [A[p], A[c]]; [b[c], b[p]] = [b[p], b[c]];
    for (let r = 0; r < 8; r++) {
      if (r === c) continue;
      const f = A[r][c] / A[c][c];
      if (!f) continue;
      for (let k = c; k < 8; k++) A[r][k] -= f * A[c][k];
      b[r] -= f * b[c];
    }
  }
  return [...b.map((v, i) => v / A[i][i]), 1];
}
export function applyH(H, p) {
  const w = H[6] * p.x + H[7] * p.y + H[8];
  return { x: (H[0] * p.x + H[1] * p.y + H[2]) / w, y: (H[3] * p.x + H[4] * p.y + H[5]) / w };
}

/* Kamerabild (RGBA, sw×sh) → Bild der Arbeitsfläche (W×H mm bei res px/mm). H bildet mm → Kamerapixel ab.
   Zeile 0 des Ergebnisses ist y = 0 (unten) – passend zur gespiegelten Zeichenfläche. */
export function rectify(src, sw, sh, H, W, Hmm, res) {
  const map = typeof H === 'function' ? H : p => applyH(H, p);
  const ow = Math.max(1, Math.round(W * res)), oh = Math.max(1, Math.round(Hmm * res));
  const out = new Uint8ClampedArray(ow * oh * 4);
  for (let j = 0; j < oh; j++) for (let i = 0; i < ow; i++) {
    const q = map({ x: (i + 0.5) / res, y: (j + 0.5) / res });
    const x = q.x - 0.5, y = q.y - 0.5, x0 = Math.floor(x), y0 = Math.floor(y);
    const o = (j * ow + i) * 4;
    if (!(x0 >= 0 && y0 >= 0 && x0 < sw - 1 && y0 < sh - 1)) continue;
    const fx = x - x0, fy = y - y0;
    for (let c = 0; c < 4; c++) {
      const a = src[(y0 * sw + x0) * 4 + c], b2 = src[(y0 * sw + x0 + 1) * 4 + c];
      const d = src[((y0 + 1) * sw + x0) * 4 + c], e = src[((y0 + 1) * sw + x0 + 1) * 4 + c];
      out[o + c] = (a * (1 - fx) + b2 * fx) * (1 - fy) + (d * (1 - fx) + e * fx) * fy;
    }
  }
  return { data: out, w: ow, h: oh };
}

/* Zielpunkte in mm: Ecken der Arbeitsfläche oder Kalibrierkreuze 20 mm vom Rand (unten links, unten rechts,
   oben rechts, oben links) */
export function targetPoints(M, mode) {
  const i = mode === 'corners' ? 0 : Math.min(20, M.width / 4, M.height / 4);
  const n = gridN(mode);
  if (n === 2) return [{ x: i, y: i }, { x: M.width - i, y: i }, { x: M.width - i, y: M.height - i }, { x: i, y: M.height - i }];
  // Raster zeilenweise von unten links: unterste Reihe links → rechts, dann die nächste Reihe darüber
  const out = [];
  for (let r = 0; r < n; r++) for (let c = 0; c < n; c++)
    out.push({ x: i + (M.width - 2 * i) * c / (n - 1), y: i + (M.height - 2 * i) * r / (n - 1) });
  return out;
}
export const gridN = mode => mode === 'grid5' ? 5 : mode === 'grid3' ? 3 : 2;
const cornerIdx = n => n === 2 ? [0, 1, 2, 3] : [0, n - 1, n * n - 1, n * (n - 1)];

/* Kameramodell anpassen: Arbeitsfläche (mm) → Kamerapixel. Bei 4 Punkten nur Perspektive; ab 6 Punkten
   zusätzlich radiale Verzeichnung um die Bildmitte, p_verz = p·(1 + k1·r² + k2·r⁴), per Levenberg-Marquardt.
   Ergebnis: { map(p) → Pixel, rms (Pixel), k1, k2 } oder null. */
export function fitCamera(bed, img, sw, sh, n = 2) {
  const cx = sw / 2, cy = sh / 2, s = Math.hypot(sw, sh) / 2;
  const bs = Math.max(...bed.map(p => Math.max(Math.abs(p.x), Math.abs(p.y)))) || 1;
  const B = bed.map(p => ({ x: p.x / bs, y: p.y / bs }));
  const I = img.map(p => ({ x: (p.x - cx) / s, y: (p.y - cy) / s }));
  const ci = cornerIdx(n);
  const H0 = homography(ci.map(k => B[k]), ci.map(k => I[k]));
  if (!H0) return null;
  const model = P => p => {
    const H = [...P.slice(0, 8), 1], q = applyH(H, p);
    const r2 = q.x * q.x + q.y * q.y, f = 1 + P[8] * r2 + P[9] * r2 * r2;
    return { x: q.x * f, y: q.y * f };
  };
  const resid = P => { const m = model(P); return B.flatMap((p, k) => { const q = m(p); return [q.x - I[k].x, q.y - I[k].y]; }); };
  let P = [...H0.slice(0, 8), 0, 0];
  if (bed.length >= 6) {
    const np = bed.length >= 9 ? 10 : 9;            // wenige Punkte: nur k1
    let lam = 1e-3, r = resid(P), cost = r.reduce((a, v) => a + v * v, 0);
    for (let it = 0; it < 200; it++) {
      const J = [];                                     // numerische Ableitungen
      for (let j = 0; j < np; j++) {
        const Q = P.slice(), e = 1e-7 * Math.max(1, Math.abs(P[j])); Q[j] += e;
        const rq = resid(Q); J.push(rq.map((v, k) => (v - r[k]) / e));
      }
      const A = J.map(a => J.map(b => a.reduce((t, v, k) => t + v * b[k], 0)));
      const g = J.map(a => -a.reduce((t, v, k) => t + v * r[k], 0));
      let improved = false;
      for (let tries = 0; tries < 10 && !improved; tries++) {
        const Al = A.map((row, i) => row.map((v, j) => i === j ? v * (1 + lam) + 1e-12 : v));
        const d = solve(Al, g.slice());
        if (!d) { lam *= 10; continue; }
        const Q = P.slice(); d.forEach((v, j) => Q[j] += v);
        const rq = resid(Q), c2 = rq.reduce((a, v) => a + v * v, 0);
        if (c2 < cost) { P = Q; r = rq; improved = cost - c2 > 1e-16 ? true : 'done'; cost = c2; lam = Math.max(1e-9, lam / 10); }
        else lam *= 10;
      }
      if (!improved || improved === 'done') break;
    }
  }
  const m = model(P);
  const map = p => { const q = m({ x: p.x / bs, y: p.y / bs }); return { x: q.x * s + cx, y: q.y * s + cy }; };
  const err = bed.map((p, k) => { const q = map(p); return Math.hypot(q.x - img[k].x, q.y - img[k].y); });
  return { map, rms: Math.sqrt(err.reduce((a, v) => a + v * v, 0) / err.length), k1: P[8], k2: P[9] };
}
function solve(A, b) {
  const n = b.length;
  for (let c = 0; c < n; c++) {
    let p = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(A[r][c]) > Math.abs(A[p][c])) p = r;
    if (Math.abs(A[p][c]) < 1e-18) return null;
    [A[c], A[p]] = [A[p], A[c]]; [b[c], b[p]] = [b[p], b[c]];
    for (let r = c + 1; r < n; r++) { const f = A[r][c] / A[c][c]; for (let k = c; k < n; k++) A[r][k] -= f * A[c][k]; b[r] -= f * b[c]; }
  }
  const x = new Array(n);
  for (let i = n - 1; i >= 0; i--) { let t = b[i]; for (let k = i + 1; k < n; k++) t -= A[i][k] * x[k]; x[i] = t / A[i][i]; }
  return x;
}
/* mittlerer Abstand benachbarter Kalibrierpunkte: mm pro Kamerapixel (für die Fehleranzeige) */
export function mmPerPx(bed, img) {
  let a = 0, b = 0;
  for (let k = 1; k < bed.length; k++) { a += Math.hypot(bed[k].x - bed[k - 1].x, bed[k].y - bed[k - 1].y); b += Math.hypot(img[k].x - img[k - 1].x, img[k].y - img[k - 1].y); }
  return b ? a / b : 0;
}

export const loadCamCal = () => { try { return JSON.parse(localStorage.getItem(KEY) || 'null'); } catch (e) { return null; } };
const saveCamCal = c => { try { localStorage.setItem(KEY, JSON.stringify(c)); } catch (e) { /* egal */ } };

/* ---------- Kamera und Überlagerung ---------- */
const cam = { stream: null, video: null, live: null, opacity: 0.8, canvas: null };

async function openStream(deviceId) {
  closeStream();
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) throw new Error(loc('Dieser Browser bietet keinen Kamerazugriff.'));
  cam.stream = await navigator.mediaDevices.getUserMedia({ video: deviceId ? { deviceId: { exact: deviceId }, width: { ideal: 1920 } } : { width: { ideal: 1920 } } });
  cam.video = h('video', { autoplay: true, muted: true, playsInline: true });
  cam.video.srcObject = cam.stream;
  await cam.video.play().catch(() => { });
  for (let i = 0; i < 50 && !cam.video.videoWidth; i++) await new Promise(r => setTimeout(r, 50));
  return cam.video;
}
function closeStream() {
  if (cam.stream) for (const t of cam.stream.getTracks()) t.stop();
  cam.stream = null;
}
function grab() {
  const v = cam.video;
  if (!v || !v.videoWidth) return null;
  const c = document.createElement('canvas');
  c.width = v.videoWidth; c.height = v.videoHeight;
  c.getContext('2d').drawImage(v, 0, 0);
  return c;
}

/* aktuelles Kamerabild entzerren und unter die Zeichnung legen */
function updateOverlay(cal) {
  const A = App(), M = A.doc.machine;
  const shot = grab();
  if (!shot || !cal) return false;
  const tgt = targetPoints(M, cal.mode);
  const imgPts = cal.pts.map(p => ({ x: p.x * shot.width, y: p.y * shot.height }));
  if (imgPts.length !== tgt.length) return false;
  const fit = fitCamera(tgt, imgPts, shot.width, shot.height, gridN(cal.mode));
  if (!fit) return false;
  const H = fit.map;
  const res = Math.min(3, 1600 / Math.max(M.width, M.height));
  const src = shot.getContext('2d').getImageData(0, 0, shot.width, shot.height).data;
  const r = rectify(src, shot.width, shot.height, H, M.width, M.height, res);
  const c = cam.canvas || (cam.canvas = document.createElement('canvas'));
  c.width = r.w; c.height = r.h;
  c.getContext('2d').putImageData(new ImageData(r.data, r.w, r.h), 0, 0);
  A.state.drawUnder = g => {
    g.save(); g.globalAlpha = cam.opacity;
    // Zeile 0 = y 0: die Zeichenfläche ist in y gespiegelt, das Bild steht dadurch richtig
    g.drawImage(c, 0, 0, M.width, M.height);
    g.restore();
  };
  A.draw();
  return true;
}
function hideOverlay() {
  const A = App();
  clearInterval(cam.live); cam.live = null;
  A.state.drawUnder = null; A.draw();
}

/* Kalibrierung: Standbild zeigen, Punkte der Reihe nach anklicken (Lupe für genaues Treffen,
   Rechtsklick nimmt den letzten Punkt zurück) */
function calibrate(mode, done) {
  const shot = grab();
  if (!shot) return toast(loc('Kein Kamerabild'), 'err');
  const n = gridN(mode), total = n === 2 ? 4 : n * n;
  const pts = [];
  const names = [loc('unten links'), loc('unten rechts'), loc('oben rechts'), loc('oben links')];
  // Rasterposition (Spalte, Reihe von unten) des k-ten Punkts
  const cell = k => n === 2 ? [[0, 0], [1, 0], [1, 1], [0, 1]][k] : [k % n, Math.floor(k / n)];
  const info = h('div', { class: 'hint', style: { margin: '4px 0', flex: 1 } });
  const map = h('canvas', { width: 64, height: 64, style: { width: '64px', height: '64px', flex: 'none' } });
  const cv = h('canvas', { width: shot.width, height: shot.height, style: { width: '100%', cursor: 'crosshair', background: '#000', display: 'block' } });
  const loupe = h('canvas', { width: 160, height: 160, style: { position: 'absolute', width: '160px', height: '160px', border: '2px solid #ff2d55', borderRadius: '50%', pointerEvents: 'none', display: 'none' } });
  const g = cv.getContext('2d');
  const drawMap = () => {
    const m = map.getContext('2d'), st = 52 / (n === 2 ? 1 : n - 1);
    m.clearRect(0, 0, 64, 64);
    m.strokeStyle = '#888'; m.strokeRect(4, 4, 56, 56);
    const nn = n === 2 ? 2 : n;
    for (let r = 0; r < nn; r++) for (let c = 0; c < nn; c++) {
      const k = n === 2 ? [[0, 1], [3, 2]][r][c] : r * n + c;
      m.fillStyle = k < pts.length ? '#2a9d8f' : k === pts.length ? '#ff2d55' : '#999';
      m.beginPath(); m.arc(6 + c * st, 58 - r * st, k === pts.length ? 5 : 3, 0, 7); m.fill();
    }
  };
  const draw = () => {
    g.drawImage(shot, 0, 0);
    g.lineWidth = Math.max(2, shot.width / 600); g.strokeStyle = '#ff2d55'; g.fillStyle = '#ff2d55';
    g.font = Math.round(shot.width / 50) + 'px sans-serif';
    pts.forEach((p, i) => {
      const x = p.x * shot.width, y = p.y * shot.height, r = shot.width / 80;
      g.beginPath(); g.moveTo(x - r, y); g.lineTo(x + r, y); g.moveTo(x, y - r); g.lineTo(x, y + r); g.stroke();
      g.fillText(String(i + 1), x + r * 0.5, y - r * 0.5);
    });
    let where = '';
    if (pts.length < total) {
      const [c, r] = cell(pts.length);
      where = n === 2 ? names[pts.length] : loc('Reihe {r} von unten, Spalte {c} von links', { r: r + 1, c: c + 1 });
    }
    info.textContent = pts.length < total
      ? loc('Klicke Punkt {i} von {n}: {w}', { i: pts.length + 1, n: total, w: where }) + ' – ' + (mode === 'corners' ? loc('Ecke der Arbeitsfläche') : loc('Mitte des Kalibrierkreuzes')) + '. ' + loc('Rechtsklick: letzten Punkt zurücknehmen.')
      : loc('Alle Punkte gesetzt.');
    drawMap();
  };
  const pos = e => { const r = cv.getBoundingClientRect(); return { x: (e.clientX - r.left) / r.width, y: (e.clientY - r.top) / r.height, r }; };
  cv.addEventListener('click', e => { if (pts.length >= total) return; const p = pos(e); pts.push({ x: p.x, y: p.y }); draw(); });
  cv.addEventListener('contextmenu', e => { e.preventDefault(); pts.pop(); draw(); });
  cv.addEventListener('mousemove', e => {
    const p = pos(e), lg = loupe.getContext('2d'), z = 40;              // 40 Kamerapixel → 160 px Lupe
    const ix = p.x * shot.width, iy = p.y * shot.height;
    lg.imageSmoothingEnabled = false;
    lg.fillStyle = '#000'; lg.fillRect(0, 0, 160, 160);
    lg.drawImage(shot, ix - z / 2, iy - z / 2, z, z, 0, 0, 160, 160);
    lg.strokeStyle = '#ff2d55'; lg.beginPath(); lg.moveTo(80, 60); lg.lineTo(80, 100); lg.moveTo(60, 80); lg.lineTo(100, 80); lg.stroke();
    const ox = e.clientX - p.r.left, oy = e.clientY - p.r.top;
    loupe.style.left = (ox + (ox > p.r.width - 190 ? -180 : 20)) + 'px';
    loupe.style.top = (oy + (oy > p.r.height - 190 ? -180 : 20)) + 'px';
    loupe.style.display = 'block';
  });
  cv.addEventListener('mouseleave', () => { loupe.style.display = 'none'; });
  draw();
  modal(loc('Kamera kalibrieren'), h('div', {},
    h('div', { class: 'row', style: { gap: '10px', alignItems: 'center' } }, map, info),
    h('div', { style: { position: 'relative' } }, cv, loupe)), [
    { label: loc('Zurücksetzen'), keep: true, click: () => { pts.length = 0; draw(); return false; } },
    { label: loc('Abbrechen') },
    {
      label: loc('Übernehmen'), primary: true, click: () => {
        if (pts.length < total) { toast(loc('Bitte alle Punkte anklicken'), 'err'); return false; }
        const M = App().doc.machine, bed = targetPoints(M, mode);
        const img = pts.map(p => ({ x: p.x * shot.width, y: p.y * shot.height }));
        const fit = fitCamera(bed, img, shot.width, shot.height, n);
        if (!fit) { toast(loc('Die Punkte passen nicht zusammen – bitte in der richtigen Reihenfolge anklicken'), 'err'); return false; }
        done(pts.slice(), total > 4 ? fit.rms * mmPerPx(bed, img) : null);
      }
    }
  ], { width: '960px' });
}

/* Kalibrierkreuze zum Gravieren anlegen (4 Stück oder Raster 3×3 / 5×5, 20 mm vom Rand) */
function addMarks(mode) {
  const A = App(), M = A.doc.machine, s = 5;
  const news = targetPoints(M, mode === 'corners' ? 'marks' : mode).map(p => {
    const sh = Shape.path([nodeSub([{ x: p.x - s, y: p.y }, { x: p.x + s, y: p.y }], false), nodeSub([{ x: p.x, y: p.y - s }, { x: p.x, y: p.y + s }], false)], A.state.activeLayer);
    sh.name = loc('Kalibrierkreuz');
    return sh;
  });
  A.doc.shapes.push(...news); A.setSel(news); A.commit(loc('Kalibrierkreuze'));
  toast(loc('Kreuze angelegt – schwach gravieren, dann die Kamera kalibrieren'), 'ok');
}

const MODES = () => [
  { v: 'grid3', t: loc('Raster 3 × 3 mit Linsenkorrektur (empfohlen)') },
  { v: 'grid5', t: loc('Raster 5 × 5 mit Linsenkorrektur (am genauesten)') },
  { v: 'marks', t: loc('4 Kalibrierkreuze (ohne Linsenkorrektur)') },
  { v: 'corners', t: loc('Ecken der Arbeitsfläche (ohne Linsenkorrektur)') }];

export async function cameraDialog() {
  const A = App();
  let cal = loadCamCal() || { deviceId: '', mode: 'grid3', pts: null };
  const preview = h('div', { style: { background: '#000', minHeight: '200px', display: 'flex', alignItems: 'center', justifyContent: 'center' } });
  const state = h('div', { class: 'hint' });
  const showState = () => {
    const m = (MODES().find(x => x.v === cal.mode) || {}).t || '';
    state.textContent = cal.pts ? loc('Kalibriert: {m}.', { m }) + (cal.err != null ? ' ' + loc('Restfehler an den Kreuzen ca. {e} mm.', { e: fmtNum(Math.round(cal.err * 10) / 10) }) : '') : loc('Noch nicht kalibriert.');
  };
  const devSel = h('select', { onchange: () => start(devSel.value) });
  const start = async id => {
    try {
      const v = await openStream(id);
      cal.deviceId = id || (cam.stream.getVideoTracks()[0].getSettings().deviceId || '');
      v.style.width = '100%';
      preview.innerHTML = ''; preview.appendChild(v);
      const devs = (await navigator.mediaDevices.enumerateDevices()).filter(d => d.kind === 'videoinput');
      devSel.innerHTML = '';
      devs.forEach((d, i) => devSel.appendChild(h('option', { value: d.deviceId, selected: d.deviceId === cal.deviceId }, d.label || loc('Kamera {i}', { i: i + 1 }))));
    } catch (e) { preview.innerHTML = ''; preview.appendChild(h('div', { style: { color: '#fff', padding: '20px' } }, e.message)); }
  };
  const body = h('div', {},
    h('div', { class: 'grid2' },
      field(loc('Kamera'), devSel),
      field(loc('Bezugspunkte'), selectInput(cal.mode, MODES(), v => { if (v !== cal.mode) { cal.mode = v; cal.pts = null; cal.err = null; showState(); } }))),
    preview,
    h('div', { class: 'row', style: { gap: '6px', marginTop: '6px', flexWrap: 'wrap' } },
      h('button', { class: 'tbtn', onclick: () => addMarks(cal.mode) }, loc('Kalibrierkreuze anlegen')),
      h('button', { class: 'tbtn', onclick: () => calibrate(cal.mode, (pts, err) => { cal.pts = pts; cal.err = err; saveCamCal(cal); showState(); updateOverlay(cal); }) }, loc('Kalibrieren…'))),
    state,
    h('h4', { class: 'sec' }, loc('Auf der Arbeitsfläche')),
    slider(loc('Deckkraft'), cam.opacity, 0.1, 1, 0.05, v => { cam.opacity = v; A.draw(); }),
    checkbox(!!cam.live, v => {
      clearInterval(cam.live); cam.live = null;
      if (v) cam.live = setInterval(() => { if (cam.stream && cal.pts) updateOverlay(cal); }, 2000);
    }, loc('Live aktualisieren (alle 2 s)')),
    h('small', { class: 'hint' }, loc('Die Kamera fest über dem Laser montieren. Nach jedem Verschieben der Kamera neu kalibrieren. Das Kamerabild wird nie gelasert.')),
    h('small', { class: 'hint' }, loc('Ablauf: Kalibrierkreuze anlegen, mit wenig Leistung auf ein Brett gravieren, Brett liegen lassen, dann „Kalibrieren…" und die Kreuze der Reihe nach anklicken.')));
  showState();
  modal(loc('Kamera'), body, [
    { label: loc('Ausblenden'), click: () => { hideOverlay(); closeStream(); } },
    { label: loc('Schließen'), click: () => { if (!cam.live) closeStream(); } },
    {
      label: loc('Bild auf Arbeitsfläche legen'), primary: true, click: () => {
        if (!cal.pts) { toast(loc('Bitte zuerst kalibrieren'), 'err'); return false; }
        if (!updateOverlay(cal)) { toast(loc('Kein Kamerabild'), 'err'); return false; }
        saveCamCal(cal);
        if (!cam.live) closeStream();
      }
    }
  ], { width: '720px', sticky: true });
  start(cal.deviceId);
}
