// agentapi.js — führt Werkzeuge von KI-Agenten im offenen Editor aus (Liste: agenttools.js).
// Jede Änderung ist ein eigener Rückgängig-Schritt („KI-Agent: …“). Laser verbinden oder starten geht nicht.
// Ergebnis im Format des Model Context Protocol: { content: [{ type: 'text' | 'image', … }], isError? }
import { Shape, nodeSub, shapesBBox, walk, findById, removeShape, uid } from './doc.js';
import { Mat, boxValid } from './geom.js';
import { View, render, invalidateAll, invalidateShape } from './render.js';
import { importSVG, exportSVG, parsePathData } from './svg.js';
import { exportDXF } from './formats.js';
import { buildJob, jobBounds } from './cam.js';
import { generateGCode, estimateTime } from './gcode.js';
import { checkDesign } from './check.js';
import { isGalvo } from './galvo.js';
import { evalScad, partShapes } from './scadui.js';
import { ensureFont, isBundled, libraryEntry, FontStore } from './font.js';
import { AGENT_TOOL_NAMES } from './agenttools.js';

const text = obj => ({ content: [{ type: 'text', text: typeof obj === 'string' ? obj : JSON.stringify(obj, null, 1) }] });
const fail = msg => ({ content: [{ type: 'text', text: msg }], isError: true });
const r2 = v => Math.round(v * 100) / 100;
const box = b => boxValid(b) ? { x0: r2(b.x0), y0: r2(b.y0), x1: r2(b.x1), y1: r2(b.y1), width: r2(b.x1 - b.x0), height: r2(b.y1 - b.y0) } : null;

class AgentError extends Error { }
const need = (cond, msg) => { if (!cond) throw new AgentError(msg); };

function layerIndex(App, n) {
  if (n === undefined || n === null) return App.state.activeLayer;
  need(Number.isInteger(n) && n >= 1 && n <= 32, `layer must be 1–32, got ${n}`);
  need(App.doc.layers[n - 1], `layer ${n} does not exist`);
  return n - 1;
}
const layerInfo = L => ({
  layer: L.index + 1, name: L.name || (L.isTool ? `Helper ${L.index - 29}` : ''), color: L.color, helper: !!L.isTool,
  ...(L.isTool ? {} : { mode: L.mode, output: L.output, speed: L.speed, power: L.maxPower, min_power: L.minPower, passes: L.passes, interval: L.interval, angle: L.angle, air_assist: L.airAssist })
});

function finish(App, label, shapes) {
  invalidateAll();
  if (shapes) App.setSel(shapes);
  App.commit('KI-Agent: ' + label);
  if (App.onAgentChange) App.onAgentChange(label);
}

/* ---------------- einzelne Werkzeuge ---------------- */
const TOOLS = {
  get_document(App, a) {
    const d = App.doc, M = d.machine;
    const used = new Set(); walk(d.shapes, s => used.add(s.layer));
    const out = {
      units: 'mm', coordinates: 'origin bottom-left, y up',
      work_area: { width: M.width, height: M.height },
      machine: { name: M.name, firmware: M.firmware, origin: M.jobOrigin },
      active_layer: App.state.activeLayer + 1,
      layers: d.layers.filter(L => used.has(L.index) || L.index === App.state.activeLayer || L.isTool).map(layerInfo),
      shape_count: d.shapes.length,
      selection: App.state.selection.map(s => s.id),
      drawing_bbox: box(shapesBBox(d.shapes, App.ctxGeo))
    };
    if (a.include_shapes !== false) {
      out.shapes = d.shapes.slice(0, 500).map(s => {
        const o = { id: s.id, type: s.type, layer: s.layer + 1, bbox: box(shapesBBox([s], App.ctxGeo)) };
        if (s.name) o.name = s.name;
        if (s.type === 'text') { o.text = s.text; o.font = s.font; o.size = s.size; }
        if (s.type === 'group') o.children = s.children.length;
        if (s.gen) o.generated = s.gen.kind;
        if (s.locked) o.locked = true;
        if (s.hidden) o.hidden = true;
        return o;
      });
      if (d.shapes.length > 500) out.shapes_truncated = true;
    }
    return text(out);
  },

  get_preview(App, a) {
    const W = Math.max(300, Math.min(1600, Math.round(a.width || 900))), H = Math.round(W * 0.75);
    const cv = document.createElement('canvas');
    cv.style.cssText = `position:fixed;left:-${W + 100}px;top:0;width:${W}px;height:${H}px`;
    document.body.appendChild(cv);
    try {
      const view = new View(), M = App.doc.machine;
      const b = a.area === 'work_area' ? null : shapesBBox(App.doc.shapes.filter(s => !(App.doc.layers[s.layer] || {}).isTool), App.ctxGeo);
      view.fit(b && boxValid(b) ? b : { x0: 0, y0: 0, x1: M.width, y1: M.height }, W, H, 30);
      const state = { ...App.state, selection: [], overlay: null, aux: null };
      render(cv, App.doc, view, state, App.ctxGeo);
      // auf Retina-Bildschirmen zeichnet render() doppelt so groß – auf die gewünschte Breite bringen
      const out = document.createElement('canvas');
      out.width = W; out.height = H;
      out.getContext('2d').drawImage(cv, 0, 0, W, H);
      const data = out.toDataURL('image/png').split(',')[1];
      return { content: [{ type: 'image', data, mimeType: 'image/png' }, { type: 'text', text: `Preview ${W}×${H} px, ${a.area === 'work_area' ? 'whole work area' : 'fitted to the drawing'}; rulers in mm.` }] };
    } finally { cv.remove(); }
  },

  async add_shapes(App, a) {
    need(Array.isArray(a.shapes) && a.shapes.length, 'shapes must be a non-empty array');
    const def = layerIndex(App, a.layer), news = [], fonts = new Set();
    for (const [i, s] of a.shapes.entries()) {
      const L = s.layer !== undefined ? layerIndex(App, s.layer) : def;
      const n = k => { need(typeof s[k] === 'number' && isFinite(s[k]), `shapes[${i}].${k} must be a number`); return s[k]; };
      let sh;
      switch (s.type) {
        case 'rect': sh = Shape.rect(n('x'), n('y'), n('width'), n('height'), L, s.radius || 0); break;
        case 'ellipse': sh = Shape.ellipse(n('cx'), n('cy'), n('rx'), n('ry'), L); break;
        case 'polygon': sh = Shape.polygon(n('cx'), n('cy'), n('radius'), Math.max(3, Math.round(n('sides'))), L, s.star || 0); break;
        case 'text': {
          need(typeof s.text === 'string' && s.text, `shapes[${i}].text is missing`);
          sh = Shape.text(n('x'), n('y'), s.text, L);
          sh.size = typeof s.size === 'number' ? s.size : 10;
          if (s.align) sh.align = s.align;
          if (s.font) {
            const e = libraryEntry(s.font) || FontStore.library.find(f => f.name.toLowerCase() === String(s.font).toLowerCase());
            sh.font = e ? e.name : s.font;
            if (e) fonts.add(e.name);
          }
          break;
        }
        case 'path': {
          need(typeof s.d === 'string' && s.d.trim(), `shapes[${i}].d is missing`);
          let subs;
          try { subs = parsePathData(s.d); } catch (e) { throw new AgentError(`shapes[${i}].d is not valid SVG path data`); }
          sh = Shape.path(subs, L); break;
        }
        case 'polyline': {
          need(Array.isArray(s.points) && s.points.length >= 2, `shapes[${i}].points needs at least 2 points`);
          sh = Shape.path([nodeSub(s.points.map(p => ({ x: +p[0], y: +p[1] })), !!s.closed)], L); break;
        }
        default: throw new AgentError(`shapes[${i}].type "${s.type}" is unknown`);
      }
      if (s.name) sh.name = String(s.name);
      news.push(sh);
    }
    // mitgelieferte Schriften erst laden, sonst wird der Text mit der Ersatzschrift umgerechnet
    await Promise.all([...fonts].filter(isBundled).map(f => ensureFont(f)));
    FontStore.cache.clear();
    App.doc.shapes.push(...news);
    finish(App, 'add_shapes', news);
    return text({ added: news.map(s => ({ id: s.id, type: s.type, layer: s.layer + 1, bbox: box(shapesBBox([s], App.ctxGeo)) })) });
  },

  add_svg(App, a) {
    need(typeof a.svg === 'string' && /<svg[\s>]/i.test(a.svg), 'svg must be an SVG document');
    const r = importSVG(a.svg, App.doc);
    need(r.shapes.length, 'the SVG contains no shapes');
    if (a.layer !== undefined) { const L = layerIndex(App, a.layer); walk(r.shapes, s => { s.layer = L; }); }
    let b = shapesBBox(r.shapes, App.ctxGeo);
    if (a.width > 0 && boxValid(b)) {
      const k = a.width / Math.max(1e-6, b.x1 - b.x0);
      for (const s of r.shapes) s.transform = Mat.mul(s.transform, Mat.aroundPoint(Mat.scale(k), b.x0, b.y0));
      b = shapesBBox(r.shapes, App.ctxGeo);
    }
    if ((a.x !== undefined || a.y !== undefined) && boxValid(b)) {
      const t = Mat.translate(a.x !== undefined ? a.x - b.x0 : 0, a.y !== undefined ? a.y - b.y0 : 0);
      for (const s of r.shapes) s.transform = Mat.mul(s.transform, t);
    }
    App.doc.shapes.push(...r.shapes);
    finish(App, 'add_svg', r.shapes);
    return text({ added: r.shapes.map(s => s.id), bbox: box(shapesBBox(r.shapes, App.ctxGeo)) });
  },

  async run_openscad(App, a) {
    need(typeof a.code === 'string' && a.code.trim(), 'code is missing');
    let r = evalScad(a.code, a.params || {});
    // Schriften für text() werden beim ersten Lauf geladen – danach noch einmal rechnen
    const pending = FontStore.library.filter(f => new RegExp(`font\\s*=\\s*"${f.name}`, 'i').test(a.code) && !FontStore.fonts.has(f.name));
    if (pending.length) { await Promise.all(pending.map(f => ensureFont(f.name))); FontStore.cache.clear(); r = evalScad(a.code, a.params || {}); }
    if (!r.parts.length) return fail('The code produces no 2D area. ' + (r.warnings.length ? 'Warnings: ' + r.warnings.join('; ') : ''));
    let x0 = Infinity, y0 = Infinity;
    for (const p of r.polys) for (const q of p) { x0 = Math.min(x0, q.x); y0 = Math.min(y0, q.y); }
    const dx = a.x !== undefined ? a.x - x0 : (x0 < 0 ? 10 - x0 : 0), dy = a.y !== undefined ? a.y - y0 : (y0 < 0 ? 10 - y0 : 0);
    const gen = { kind: 'scad', code: a.code, params: { ...(a.params || {}) }, set: uid() };
    const news = partShapes(r, gen, Mat.translate(dx, dy), App.state.activeLayer);
    App.doc.shapes.push(...news);
    finish(App, 'run_openscad', news);
    return text({
      added: news.map(s => ({ id: s.id, layer: s.layer + 1, color: s.scadColor, bbox: box(shapesBBox([s], App.ctxGeo)) })),
      outlines: r.polys.length, warnings: r.warnings, echo: r.echo
    });
  },

  modify_shapes(App, a) {
    need(Array.isArray(a.ids) && a.ids.length, 'ids must be a non-empty array');
    const list = a.ids.map(id => { const s = findById(App.doc.shapes, id); need(s, `no shape with id ${id}`); return s; });
    if (a.delete) {
      for (const s of list) removeShape(App.doc.shapes, s);
      finish(App, 'delete', []);
      return text({ deleted: list.length });
    }
    const b = shapesBBox(list, App.ctxGeo);
    need(boxValid(b), 'the shapes have no extent');
    const cx = (b.x0 + b.x1) / 2, cy = (b.y0 + b.y1) / 2;
    let m = Mat.id();
    if (a.scale !== undefined) { need(a.scale > 0, 'scale must be > 0'); m = Mat.mul(m, Mat.aroundPoint(Mat.scale(a.scale), cx, cy)); }
    if (a.rotate) m = Mat.mul(m, Mat.aroundPoint(Mat.rotate(a.rotate * Math.PI / 180), cx, cy));
    if (a.translate) m = Mat.mul(m, Mat.translate(+a.translate[0] || 0, +a.translate[1] || 0));
    for (const s of list) { s.transform = Mat.mul(s.transform, m); invalidateShape(s); }
    if (a.move_to) {
      const b2 = shapesBBox(list, App.ctxGeo), t = Mat.translate(a.move_to[0] - b2.x0, a.move_to[1] - b2.y0);
      for (const s of list) s.transform = Mat.mul(s.transform, t);
    }
    if (a.layer !== undefined) { const L = layerIndex(App, a.layer); for (const s of list) walk([s], x => { x.layer = L; }); }
    if (a.name !== undefined) for (const s of list) s.name = String(a.name);
    finish(App, 'modify_shapes', list);
    return text({ modified: list.map(s => ({ id: s.id, layer: s.layer + 1, bbox: box(shapesBBox([s], App.ctxGeo)) })) });
  },

  set_layer(App, a) {
    const i = layerIndex(App, a.layer), L = App.doc.layers[i];
    need(!L.isTool, 'helper layers have no cut settings');
    const map = { name: 'name', mode: 'mode', speed: 'speed', power: 'maxPower', min_power: 'minPower', passes: 'passes', interval: 'interval', angle: 'angle', output: 'output', air_assist: 'airAssist' };
    for (const [k, f] of Object.entries(map)) if (a[k] !== undefined) L[f] = a[k];
    if (a.power !== undefined && a.min_power === undefined && L.minPower > L.maxPower) L.minPower = L.maxPower;
    finish(App, 'set_layer');
    return text(layerInfo(L));
  },

  select_shapes(App, a) {
    const list = (a.ids || []).map(id => findById(App.doc.shapes, id)).filter(Boolean);
    App.setSel(list); App.draw();
    return text({ selected: list.map(s => s.id) });
  },

  design_check(App) {
    const found = checkDesign(App.doc, App.ctxGeo, {});
    const hint = { duplicate: 'identical shape on top of another – would be cut twice', shared: 'edges shared by two shapes – cut twice', almostClosed: 'path is almost closed (small gap)', openOnFill: 'open path on a fill layer – will not be engraved', imageOnLine: 'image on a line layer – will not be engraved', tiny: 'very small part', bridge: 'thin bridge between cuts – may break', outside: 'outside the work area' };
    return text({
      ok: !found.length,
      findings: found.map(f => ({ type: f.type, level: f.level === 'err' ? 'error' : 'warning', meaning: hint[f.type] || f.type, shapes: f.shapes.map(s => s.id), ...(f.d !== undefined ? { distance_mm: r2(f.d) } : {}), ...(f.size !== undefined ? { size_mm: r2(f.size) } : {}), ...(f.n !== undefined ? { count: f.n } : {}) }))
    });
  },

  estimate_job(App) {
    const ops = buildJob(App.doc, App.ctxGeo, {});
    if (!ops.length) return text({ operations: 0, note: 'Nothing would be lasered (check that layers have output enabled and are not helper layers).' });
    const t = estimateTime(App.doc, ops);
    const per = {};
    for (const op of ops) { const k = (op.layer ?? (op.layerRef && op.layerRef.index) ?? 0) + 1; per[k] = (per[k] || 0) + 1; }
    return text({ seconds: Math.round(t.seconds), minutes: r2(t.seconds / 60), cut_length_mm: Math.round(t.cutLen), travel_mm: Math.round(t.rapidLen), operations: ops.length, operations_per_layer: per, bbox: box(jobBounds(ops)), work_area: { width: App.doc.machine.width, height: App.doc.machine.height } });
  },

  export_file(App, a) {
    if (a.format === 'svg') return text(exportSVG(App.doc, App.ctxGeo));
    if (a.format === 'dxf') return text(exportDXF(App.doc, App.ctxGeo));
    if (a.format === 'gcode') {
      need(!isGalvo(App.doc.machine), 'the configured machine is a galvo laser – it does not use G-code');
      const ops = buildJob(App.doc, App.ctxGeo, {});
      need(ops.length, 'nothing to output');
      const g = generateGCode(App.doc, ops, {});
      return text(g.length > 900000 ? g.slice(0, 900000) + '\n; … truncated (file too large for the response)' : g);
    }
    throw new AgentError('format must be svg, dxf or gcode');
  },

  undo(App, a) {
    const n = Math.max(1, Math.min(50, a.steps || 1));
    let done = 0;
    for (let i = 0; i < n; i++) if (App.history.undo(App.doc)) done++; else break;
    invalidateAll(); App.refresh(); App.persist();
    return text({ undone: done });
  }
};

/* Werkzeug ausführen; Fehler in den Parametern gehen als Text an den Agenten zurück */
export async function runAgentTool(App, name, args = {}) {
  if (!AGENT_TOOL_NAMES.has(name) || !TOOLS[name]) return fail(`Unknown tool: ${name}`);
  try { return await TOOLS[name](App, args || {}); }
  catch (e) {
    if (e instanceof AgentError) return fail(e.message);
    console.error('Agent-Werkzeug', name, e);
    return fail(`${name} failed: ${e.message || e}`);
  }
}
