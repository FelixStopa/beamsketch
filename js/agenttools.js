// agenttools.js — Werkzeuge für KI-Agenten (Model Context Protocol): Namen, Beschreibungen und Parameter
// als JSON Schema. Nur Daten – der Server liest die Liste für „tools/list“, der Editor führt sie aus
// (agentapi.js). Absichtlich nicht dabei: Laser verbinden, Auftrag starten, Dateien des Rechners lesen.
// Beschreibungen auf Englisch: Agenten verstehen sie so am zuverlässigsten.

const num = (description, extra = {}) => ({ type: 'number', description, ...extra });
const layerProp = { type: 'integer', minimum: 1, maximum: 32, description: 'Layer number as shown in BeamSketch (1–30 = laser layers, 31–32 = helper layers that are never lasered). Default: the active layer.' };

export const AGENT_TOOLS = [
  {
    name: 'get_document',
    description: 'Read the drawing that is open in the user\'s BeamSketch editor: work area (mm), machine, layers with their cut settings, and the shapes (id, type, layer, bounding box in mm). Coordinates are millimetres, origin bottom-left, y pointing up. Call this first.',
    inputSchema: { type: 'object', properties: { include_shapes: { type: 'boolean', description: 'List the shapes (default true; at most 500).' } } },
    annotations: { readOnlyHint: true }
  },
  {
    name: 'get_preview',
    description: 'Render a PNG image of the drawing as the user sees it (with rulers in mm). Use it to check your work visually.',
    inputSchema: { type: 'object', properties: { area: { type: 'string', enum: ['drawing', 'work_area'], description: 'Fit the drawing (default) or the whole work area.' }, width: num('Image width in pixels (300–1600, default 900).') } },
    annotations: { readOnlyHint: true }
  },
  {
    name: 'add_shapes',
    description: 'Add vector shapes to the drawing. All values in mm, origin bottom-left, y up. Returns the ids of the new shapes. Each call is one undo step for the user.',
    inputSchema: {
      type: 'object', required: ['shapes'],
      properties: {
        layer: layerProp,
        shapes: {
          type: 'array', minItems: 1, maxItems: 500,
          items: {
            type: 'object', required: ['type'],
            description: 'rect: x, y, width, height, radius? · ellipse: cx, cy, rx, ry · polygon: cx, cy, radius, sides, star? (0–1) · text: x, y (baseline start), text, size (font size mm), font?, align? (left|center|right) · path: d (SVG path data, y up) · polyline: points [[x,y],…], closed?',
            properties: {
              type: { type: 'string', enum: ['rect', 'ellipse', 'polygon', 'text', 'path', 'polyline'] },
              x: { type: 'number' }, y: { type: 'number' }, width: { type: 'number' }, height: { type: 'number' }, radius: { type: 'number' },
              cx: { type: 'number' }, cy: { type: 'number' }, rx: { type: 'number' }, ry: { type: 'number' },
              sides: { type: 'integer' }, star: { type: 'number' },
              text: { type: 'string' }, size: { type: 'number' }, font: { type: 'string' }, align: { type: 'string', enum: ['left', 'center', 'right'] },
              d: { type: 'string' }, points: { type: 'array', items: { type: 'array', items: { type: 'number' } } }, closed: { type: 'boolean' },
              layer: layerProp, name: { type: 'string' }
            }
          }
        }
      }
    }
  },
  {
    name: 'add_svg',
    description: 'Import SVG markup into the drawing (paths, shapes, text as outlines). Optionally place it at x/y (bottom-left corner, mm) and scale it to a width in mm.',
    inputSchema: { type: 'object', required: ['svg'], properties: { svg: { type: 'string', description: 'Complete SVG document.' }, x: num('Left edge in mm.'), y: num('Bottom edge in mm.'), width: num('Scale to this width in mm (keeps aspect ratio).'), layer: layerProp } }
  },
  {
    name: 'run_openscad',
    description: 'Run OpenSCAD code with BeamSketch\'s built-in interpreter and insert the 2D result (3D solids are taken as top view). color("red") etc. puts parts on separate layers (e.g. engraving vs. cut). Top-level assignments are parameters that can be overridden with params. Not supported: include/use, import, surface. The user can reopen the code by double-clicking the result.',
    inputSchema: { type: 'object', required: ['code'], properties: { code: { type: 'string' }, params: { type: 'object', description: 'Override top-level variables, e.g. {"width": 80}.' }, x: num('Move the result so its left edge is here (mm).'), y: num('Move the result so its bottom edge is here (mm).') } }
  },
  {
    name: 'modify_shapes',
    description: 'Change existing shapes by id: move, scale, rotate, change layer, rename, or delete. Transformations use the common bounding box of the given shapes as reference.',
    inputSchema: {
      type: 'object', required: ['ids'],
      properties: {
        ids: { type: 'array', items: { type: 'string' }, minItems: 1 },
        translate: { type: 'array', items: { type: 'number' }, minItems: 2, maxItems: 2, description: '[dx, dy] in mm.' },
        move_to: { type: 'array', items: { type: 'number' }, minItems: 2, maxItems: 2, description: 'Move so the bounding box bottom-left is at [x, y] mm.' },
        scale: { type: 'number', description: 'Uniform scale factor around the bounding box centre.' },
        rotate: { type: 'number', description: 'Degrees counter-clockwise around the bounding box centre.' },
        layer: layerProp,
        name: { type: 'string' },
        delete: { type: 'boolean' }
      }
    }
  },
  {
    name: 'set_layer',
    description: 'Change a layer\'s cut settings. mode: line = cut/score along the outline, fill = engrave the area, fill+line = both, offset = offset fill. Speed in mm/s, power in percent.',
    inputSchema: {
      type: 'object', required: ['layer'],
      properties: {
        layer: { ...layerProp, description: 'Layer number 1–30.' },
        name: { type: 'string' }, mode: { type: 'string', enum: ['line', 'fill', 'fill+line', 'offset'] },
        speed: num('mm/s'), power: num('Maximum power in %', { minimum: 0, maximum: 100 }), min_power: num('Minimum power in %', { minimum: 0, maximum: 100 }),
        passes: { type: 'integer', minimum: 1, maximum: 50 }, interval: num('Line interval for fills in mm'), angle: num('Fill angle in degrees'),
        output: { type: 'boolean', description: 'false = layer is not lasered.' }, air_assist: { type: 'boolean' }
      }
    }
  },
  {
    name: 'select_shapes',
    description: 'Select shapes in the editor (to show the user what you mean). Empty list clears the selection.',
    inputSchema: { type: 'object', required: ['ids'], properties: { ids: { type: 'array', items: { type: 'string' } } } }
  },
  {
    name: 'design_check',
    description: 'Run BeamSketch\'s design check: duplicate lines, outlines cut twice, almost closed paths, open paths on fill layers, tiny parts, thin bridges, parts outside the work area.',
    inputSchema: { type: 'object', properties: {} },
    annotations: { readOnlyHint: true }
  },
  {
    name: 'estimate_job',
    description: 'Estimate the laser job: duration, cut length, travel, bounding box of the output, number of operations per layer.',
    inputSchema: { type: 'object', properties: {} },
    annotations: { readOnlyHint: true }
  },
  {
    name: 'export_file',
    description: 'Export the drawing as text: svg, dxf or gcode (GRBL, for the configured machine). Does not send anything to the laser.',
    inputSchema: { type: 'object', required: ['format'], properties: { format: { type: 'string', enum: ['svg', 'dxf', 'gcode'] } } },
    annotations: { readOnlyHint: true }
  },
  {
    name: 'undo',
    description: 'Undo the last changes in the editor (yours or the user\'s).',
    inputSchema: { type: 'object', properties: { steps: { type: 'integer', minimum: 1, maximum: 50 } } }
  }
];

export const AGENT_TOOL_NAMES = new Set(AGENT_TOOLS.map(t => t.name));
