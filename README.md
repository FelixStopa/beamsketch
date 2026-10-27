# BeamSketch – laser editor in your browser

BeamSketch is a browser-based design tool for **GRBL laser engravers and cutters** – diode lasers such as
Creality Falcon, Ortur, Atomstack, Sculpfun, NEJE, xTool D1, Longer, TwoTrees and CO2 conversions with
GRBL/Smoothie. Draw or import your design, assign cut settings per layer, preview the toolpaths and get
GCode – as a file or streamed straight to the laser over USB (Web Serial).

Everything runs in the browser: no installation, no account, no build step. Your designs stay on your
computer.

**Try it:** [beamsketch.com](https://beamsketch.com) (hosted version, free – the optional account adds
online storage and AI tools, which are not part of this repository).

## Features

- **Drawing:** rectangle, ellipse, polygon/star, polyline, bezier pen, text, images; node editor,
  boolean operations, offset, align/distribute, arrays, snapping, unlimited undo with history panel
- **138 bundled fonts** (92 script fonts with connected letters), system fonts and your own `.ttf`/`.otf`
- **Import:** SVG, DXF, LightBurn projects (`.lbrn`/`.lbrn2`), PNG/JPG/WEBP/GIF/BMP with tracing
- **Export:** GCode, SVG, project file (`.lsproj`)
- **Layers with cut settings:** line, fill, fill+line, offset fill; speed, power, passes, interval,
  angle, cross-hatch, overscan, kerf, Z offset, air assist, M3/M4, tabs
- **Image engraving** with live preview on the canvas: grayscale, threshold, ordered and error-diffusion
  dithering (Floyd–Steinberg, Jarvis, Stucki, Atkinson, Sierra)
- **Generators:** finger-joint boxes, living hinges, QR codes and Code 128 barcodes, text on path,
  serial text from CSV, material and focus test patterns, auto nesting
- **Symbol library** with 97 ready-made shapes
- **Laser:** GRBL GCode with safety checks, toolpath preview with time estimate, framing, direct USB
  connection with jog pad, homing, console, pause/stop
- **Setup assistant** with a searchable list of 54 laser models; reads `$130`, `$131`, `$30`, … directly
  from the controller
- **13 languages:** German, English, Spanish, French, Italian, Portuguese, Dutch, Polish, Turkish,
  Russian, Japanese, Chinese, Korean
- Light and dark theme, multiple drawings in tabs

## Run it locally

You need [Node.js](https://nodejs.org) 18 or newer – no packages to install.

```bash
node serve.js          # → http://localhost:8080
node serve.js 3000     # other port
```

Any static web server works too (the app is plain HTML, CSS and ES modules). For the USB connection to
your laser, open it in **Chrome, Edge or Opera** on a desktop computer: Web Serial only works on
`localhost` or over HTTPS. Firefox and Safari can do everything else – save the GCode and send it another
way.

## Structure

| Path | Content |
|---|---|
| `index.html`, `css/` | Page and styles |
| `js/main.js` | Application core: tools, commands, panels, dialogs |
| `js/geom.js` | Matrices, bezier, polygon booleans, offset, scanline fill |
| `js/doc.js` | Document model, shapes, layers, undo |
| `js/render.js` | Canvas rendering, rulers, selection, preview |
| `js/cam.js`, `js/gcode.js` | Toolpaths and GRBL GCode with time estimate |
| `js/raster.js` | Image engraving, dithering, live preview |
| `js/font.js` | Text to vector, font library, kerning |
| `js/svg.js`, `js/dxf.js`, `js/lbrn.js` | Import/export |
| `js/serial.js` | Web Serial connection to GRBL |
| `js/projects.js` | Tabs, saving projects |
| `js/symbols.js` | Symbol library |
| `js/features.js`, `js/generators.js`, `js/qrcode.js` | Generators and dialogs |
| `js/onboarding.js`, `devices/devices.json` | Setup assistant, laser models |
| `js/library.js`, `js/storage.js` | Material library, session in the browser |
| `js/ext.js` | Extension interface (see below) |
| `js/i18n.js`, `js/locales/` | Translations |
| `fonts/`, `vendor/` | Bundled fonts and opentype.js, with their licenses |

## Extensions

The editor works on its own. A page can load extensions via
`<meta name="beamsketch-ext" content="/path/extension.js">`; each module exports
`setup(App, helpers)` and can add tools, menu entries, an online store for projects and symbols, or a
per-account browser storage area. The hooks are documented at the top of `js/ext.js`. beamsketch.com
uses this for accounts, online storage and the AI tools.

## Translations

User-facing text is wrapped in `loc('…')`; the German original is the key. Translations live in
`js/locales/<lang>.js` – missing entries fall back to German. Placeholders: `loc('{n} objects', { n })`.

## Safety

Lasers can cause fires, burns and permanent eye damage. Wear laser safety glasses, never leave the laser
unattended, ensure ventilation and keep a fire extinguisher at hand. Never cut PVC or other
chlorine-containing plastics. You are responsible for checking the generated GCode and the machine
settings before running a job.

## Contributing

Issues and pull requests are welcome – please read [CONTRIBUTING.md](CONTRIBUTING.md) first.

## License

Copyright (C) 2026 Felix Stopa

This program is free software: you can redistribute it and/or modify it under the terms of the
**GNU Affero General Public License, version 3** as published by the Free Software Foundation – see
[LICENSE](LICENSE). It is distributed in the hope that it will be useful, but WITHOUT ANY WARRANTY.

If you run a modified version for others over a network, the AGPL requires you to offer them its source
code – change `SOURCE_URL` in `js/main.js` (shown in *Help → About*) to point to your version.

Bundled third-party parts keep their own licenses: the fonts in `fonts/` (SIL Open Font License 1.1 or
Apache License 2.0, see `fonts/LICENSES.md`) and opentype.js in `vendor/` (MIT).

The name **BeamSketch** and its logo identify the official project and the service at beamsketch.com.
Please use a different name for modified versions you publish or host.
