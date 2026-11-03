// view3d.js — kleine 3D-Ansicht (WebGL) für Platten aus Umrissen: Schichtmodelle und Baugruppen.
// Jede Platte ist ein Prisma: Umrisse (außen gegen, Löcher im Uhrzeigersinn) zwischen z0 und z1.
// Maus ziehen = drehen, Rad = zoomen, Rechtsklick/Shift ziehen = verschieben.
import earcut from '../vendor/earcut.js';
import { pointInPoly, polyArea } from './geom.js';

/* Umrisse in Außenkonturen mit ihren Löchern gruppieren */
function groupHoles(polys) {
  const outers = polys.filter(p => polyArea(p) > 0).map(o => ({ outer: o, holes: [] }));
  for (const h of polys.filter(p => polyArea(p) < 0)) {
    // kleinste Außenkontur, die das Loch enthält
    let best = null, ba = Infinity;
    for (const g of outers) { const a = polyArea(g.outer); if (a < ba && pointInPoly(h[0], g.outer)) { ba = a; best = g; } }
    if (best) best.holes.push(h);
  }
  return outers;
}

/* Dreiecke für alle Platten: Positionen, Normalen, Farben (je Ecke) */
export function prismMesh(parts) {
  const pos = [], nrm = [], col = [];
  let map = null, flip = false;
  // Dreieck (optional in den Raum abgebildet); die Normale folgt der Abbildung
  const tri = (a, b, c, n, cl) => {
    if (map) {
      a = map(...a); b = map(...b); c = map(...c);
      if (flip) [b, c] = [c, b];
      const u = [b[0] - a[0], b[1] - a[1], b[2] - a[2]], v = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
      const x = u[1] * v[2] - u[2] * v[1], y = u[2] * v[0] - u[0] * v[2], z = u[0] * v[1] - u[1] * v[0], l = Math.hypot(x, y, z) || 1;
      n = [x / l, y / l, z / l];
    }
    pos.push(...a, ...b, ...c); for (let i = 0; i < 3; i++) { nrm.push(...n); col.push(...cl); }
  };
  for (const part of parts) {
    map = part.map || null;
    if (map) {
      // Spiegelnde Abbildung (Determinante < 0) dreht den Umlaufsinn: Dreiecke umdrehen
      const o = map(0, 0, 0), ex = map(1, 0, 0), ey = map(0, 1, 0), ez = map(0, 0, 1);
      const d = (A, B) => [A[0] - B[0], A[1] - B[1], A[2] - B[2]];
      const [X, Y, Z] = [d(ex, o), d(ey, o), d(ez, o)];
      flip = X[0] * (Y[1] * Z[2] - Y[2] * Z[1]) - X[1] * (Y[0] * Z[2] - Y[2] * Z[0]) + X[2] * (Y[0] * Z[1] - Y[1] * Z[0]) < 0;
    }
    const { z0, z1 } = part, cl = part.color || [0.8, 0.65, 0.45];
    const side = part.sideColor || cl.map(v => v * 0.8);
    for (const g of groupHoles(part.polys)) {
      const rings = [g.outer, ...g.holes];
      const flat = [], holeIdx = [];
      for (const r of rings) { if (flat.length) holeIdx.push(flat.length / 2); for (const p of r) flat.push(p.x, p.y); }
      const idx = earcut(flat, holeIdx);
      const P = i => [flat[i * 2], flat[i * 2 + 1]];
      for (let i = 0; i < idx.length; i += 3) {
        const a = P(idx[i]), b = P(idx[i + 1]), c = P(idx[i + 2]);
        // earcut liefert die Dreiecke im Umlaufsinn der Außenkontur nicht garantiert – Normale setzt die Richtung
        const ccw = (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]) > 0;
        const [u, v] = ccw ? [b, c] : [c, b];
        tri([a[0], a[1], z1], [u[0], u[1], z1], [v[0], v[1], z1], [0, 0, 1], cl);
        tri([a[0], a[1], z0], [v[0], v[1], z0], [u[0], u[1], z0], [0, 0, -1], cl);
      }
      for (const r of rings) for (let i = 0; i < r.length; i++) {
        const a = r[i], b = r[(i + 1) % r.length];
        const dx = b.x - a.x, dy = b.y - a.y, l = Math.hypot(dx, dy) || 1;
        const n = [dy / l, -dx / l, 0];
        tri([a.x, a.y, z0], [b.x, b.y, z0], [b.x, b.y, z1], n, side);
        tri([a.x, a.y, z0], [b.x, b.y, z1], [a.x, a.y, z1], n, side);
      }
    }
  }
  return { pos: new Float32Array(pos), nrm: new Float32Array(nrm), col: new Float32Array(col) };
}

/* ---------------- Matrizen (Spaltenreihenfolge wie WebGL) ---------------- */
const perspective = (fov, asp, n, f) => {
  const t = 1 / Math.tan(fov / 2);
  return [t / asp, 0, 0, 0, 0, t, 0, 0, 0, 0, (f + n) / (n - f), -1, 0, 0, 2 * f * n / (n - f), 0];
};
const mul = (a, b) => {
  const o = new Array(16).fill(0);
  for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++) for (let k = 0; k < 4; k++) o[c * 4 + r] += a[k * 4 + r] * b[c * 4 + k];
  return o;
};
const lookAt = (eye, ctr, up) => {
  const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
  const norm = v => { const l = Math.hypot(...v) || 1; return v.map(x => x / l); };
  const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
  const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  const z = norm(sub(eye, ctr)), x = norm(cross(up, z)), y = cross(z, x);
  return [x[0], y[0], z[0], 0, x[1], y[1], z[1], 0, x[2], y[2], z[2], 0, -dot(x, eye), -dot(y, eye), -dot(z, eye), 1];
};

const VS = `attribute vec3 p; attribute vec3 n; attribute vec3 c; uniform mat4 mvp; uniform mat4 view;
varying vec3 vn; varying vec3 vc;
void main(){ gl_Position = mvp * vec4(p,1.0); vn = mat3(view) * n; vc = c; }`;
const FS = `precision mediump float; varying vec3 vn; varying vec3 vc;
void main(){ vec3 l = normalize(vec3(0.35,0.55,1.0)); float d = max(dot(normalize(vn), l), 0.0);
  float rim = 0.12 * max(dot(normalize(vn), normalize(vec3(-0.6,-0.2,0.4))), 0.0);
  gl_FragColor = vec4(vc * (0.38 + 0.62 * d) + rim, 1.0); }`;

export class View3D {
  constructor(canvas) {
    this.canvas = canvas;
    this.gl = canvas.getContext('webgl', { antialias: true, preserveDrawingBuffer: true });
    this.yaw = -0.7; this.pitch = 0.55; this.zoom = 1; this.pan = [0, 0];
    this.count = 0;
    if (!this.gl) return;
    const gl = this.gl;
    const sh = (type, src) => { const s = gl.createShader(type); gl.shaderSource(s, src); gl.compileShader(s); return s; };
    const pr = gl.createProgram();
    gl.attachShader(pr, sh(gl.VERTEX_SHADER, VS)); gl.attachShader(pr, sh(gl.FRAGMENT_SHADER, FS));
    gl.linkProgram(pr); gl.useProgram(pr);
    this.prog = pr;
    this.buf = { p: gl.createBuffer(), n: gl.createBuffer(), c: gl.createBuffer() };
    this.loc = { p: gl.getAttribLocation(pr, 'p'), n: gl.getAttribLocation(pr, 'n'), c: gl.getAttribLocation(pr, 'c'), mvp: gl.getUniformLocation(pr, 'mvp'), view: gl.getUniformLocation(pr, 'view') };
    gl.enable(gl.DEPTH_TEST);
    this._bindInput();
  }
  get ok() { return !!this.gl; }

  setParts(parts) {
    if (!this.gl) return;
    const m = prismMesh(parts), gl = this.gl;
    for (const k of ['p', 'n', 'c']) {
      gl.bindBuffer(gl.ARRAY_BUFFER, this.buf[k]);
      gl.bufferData(gl.ARRAY_BUFFER, k === 'p' ? m.pos : k === 'n' ? m.nrm : m.col, gl.STATIC_DRAW);
    }
    this.count = m.pos.length / 3;
    // Mittelpunkt und Größe für die Kamera
    let x0 = Infinity, y0 = Infinity, z0 = Infinity, x1 = -Infinity, y1 = -Infinity, z1 = -Infinity;
    for (let i = 0; i < m.pos.length; i += 3) {
      x0 = Math.min(x0, m.pos[i]); x1 = Math.max(x1, m.pos[i]);
      y0 = Math.min(y0, m.pos[i + 1]); y1 = Math.max(y1, m.pos[i + 1]);
      z0 = Math.min(z0, m.pos[i + 2]); z1 = Math.max(z1, m.pos[i + 2]);
    }
    if (isFinite(x0)) { this.center = [(x0 + x1) / 2, (y0 + y1) / 2, (z0 + z1) / 2]; this.radius = Math.hypot(x1 - x0, y1 - y0, z1 - z0) / 2 || 10; }
    this.render();
  }

  render() {
    const gl = this.gl;
    if (!gl) return;
    const c = this.canvas, dpr = window.devicePixelRatio || 1;
    const w = Math.max(1, Math.round(c.clientWidth * dpr)), h = Math.max(1, Math.round(c.clientHeight * dpr));
    if (c.width !== w || c.height !== h) { c.width = w; c.height = h; }
    gl.viewport(0, 0, w, h);
    const dark = matchMedia('(prefers-color-scheme: dark)').matches || document.documentElement.classList.contains('dark');
    gl.clearColor(...(dark ? [0.13, 0.14, 0.16] : [0.94, 0.95, 0.96]), 1);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    if (!this.count || !this.center) return;
    const fov = 0.7, r = this.radius, dist = r / Math.sin(fov / 2) * 1.05 / this.zoom;
    const ce = this.center;
    const eye = [ce[0] + dist * Math.cos(this.pitch) * Math.cos(this.yaw), ce[1] + dist * Math.cos(this.pitch) * Math.sin(this.yaw), ce[2] + dist * Math.sin(this.pitch)];
    let view = lookAt(eye, ce, [0, 0, 1]);
    view[12] += this.pan[0] * r; view[13] += this.pan[1] * r;
    const proj = perspective(fov, w / h, Math.max(0.1, dist - r * 3), dist + r * 3);
    gl.uniformMatrix4fv(this.loc.mvp, false, mul(proj, view));
    gl.uniformMatrix4fv(this.loc.view, false, view);
    for (const k of ['p', 'n', 'c']) {
      gl.bindBuffer(gl.ARRAY_BUFFER, this.buf[k]);
      gl.enableVertexAttribArray(this.loc[k]);
      gl.vertexAttribPointer(this.loc[k], 3, gl.FLOAT, false, 0, 0);
    }
    gl.drawArrays(gl.TRIANGLES, 0, this.count);
  }

  /* feste Ansichten: '3d', 'top', 'front' */
  setView(v) {
    if (v === 'top') { this.yaw = -Math.PI / 2; this.pitch = 1.55; }
    else if (v === 'front') { this.yaw = -Math.PI / 2; this.pitch = 0.02; }
    else { this.yaw = -0.7; this.pitch = 0.55; }
    this.zoom = 1; this.pan = [0, 0];
    this.render();
  }

  _bindInput() {
    const c = this.canvas;
    let drag = null;
    c.addEventListener('contextmenu', e => e.preventDefault());
    c.addEventListener('pointerdown', e => { drag = { x: e.clientX, y: e.clientY, pan: e.button === 2 || e.shiftKey }; c.setPointerCapture(e.pointerId); });
    c.addEventListener('pointermove', e => {
      if (!drag) return;
      const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
      drag.x = e.clientX; drag.y = e.clientY;
      if (drag.pan) { this.pan[0] += dx / c.clientWidth * 2 / this.zoom; this.pan[1] -= dy / c.clientHeight * 2 / this.zoom; }
      else { this.yaw -= dx * 0.008; this.pitch = Math.max(-1.55, Math.min(1.55, this.pitch + dy * 0.008)); }
      this.render();
    });
    c.addEventListener('pointerup', () => { drag = null; });
    c.addEventListener('wheel', e => { e.preventDefault(); this.zoom = Math.max(0.2, Math.min(20, this.zoom * Math.exp(-e.deltaY * 0.0015))); this.render(); }, { passive: false });
  }

  /* Bild der aktuellen Ansicht (PNG-Daten-URL) */
  snapshot() { this.render(); return this.canvas.toDataURL('image/png'); }
}
