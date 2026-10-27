<p align="center">
  <img src="docs/img/logo.png" alt="BeamSketch" width="420">
</p>

<h3 align="center">The laser editor that runs in your browser</h3>

<p align="center">
  Design, engrave and cut with your GRBL laser – no installation, no account, no build step.<br>
  Draw or import, set cuts per layer, preview the toolpaths and send GCode straight to the laser over USB.
</p>

<p align="center">
  <a href="https://beamsketch.com"><img alt="Try it online" src="https://img.shields.io/badge/try_it-beamsketch.com-0e7f74?style=for-the-badge"></a>
  <a href="LICENSE"><img alt="License: AGPL-3.0" src="https://img.shields.io/badge/license-AGPL--3.0-0e7f74?style=for-the-badge"></a>
  <img alt="No dependencies" src="https://img.shields.io/badge/dependencies-none-0e7f74?style=for-the-badge">
  <img alt="13 languages" src="https://img.shields.io/badge/languages-13-0e7f74?style=for-the-badge">
</p>

<p align="center">
  <a href="#features">Features</a> ·
  <a href="#quick-start">Quick start</a> ·
  <a href="#supported-lasers">Supported lasers</a> ·
  <a href="#contributing">Contributing</a> ·
  <a href="#license">License</a>
</p>

<img src="docs/img/editor-light.png" alt="BeamSketch editor with a mountain wall-art design, layer list with cut settings and laser panel">

---

## Features

<table>
  <tr>
    <td width="50%" valign="top">
      <h3>Draw & import</h3>
      Rectangle, ellipse, polygon/star, polyline, bezier pen and text. Node editor, boolean operations,
      offset, align & distribute, arrays, snapping and unlimited undo with a history panel.
      Import <b>SVG</b>, <b>DXF</b>, <b>LightBurn</b> projects (<code>.lbrn</code>/<code>.lbrn2</code>)
      and images with tracing.
    </td>
    <td width="50%" valign="top">
      <h3>Layers instead of colors</h3>
      Every color is a cut setting: line, fill, fill + line or offset fill – with speed, power, passes,
      interval, angle, cross-hatch, overscan, kerf, Z offset, air assist, M3/M4 and tabs.
      A material library keeps your favourite settings.
    </td>
  </tr>
  <tr>
    <td valign="top">
      <h3>Image engraving</h3>
      Grayscale, threshold and dithering (Floyd–Steinberg, Jarvis, Stucki, Atkinson, Sierra, ordered) –
      shown <b>live on the canvas</b> exactly as it will be engraved, with brightness, contrast and gamma
      sliders.
    </td>
    <td valign="top">
      <h3>Straight to the laser</h3>
      GRBL GCode with safety checks, toolpath preview with time estimate and framing.
      Connect over <b>USB (Web Serial)</b> with jog pad, homing, console, pause and stop –
      or save the GCode for the SD card.
    </td>
  </tr>
  <tr>
    <td valign="top">
      <h3>Generators</h3>
      Finger-joint boxes, living hinges, QR codes and Code&nbsp;128 barcodes, text on a path or circle,
      serial numbers from CSV, material and focus test patterns and automatic nesting.
    </td>
    <td valign="top">
      <h3>138 fonts & 97 symbols</h3>
      Bundled fonts with real kerning – 92 of them connected script fonts – plus system fonts and your own
      <code>.ttf</code>/<code>.otf</code>. A symbol library with hearts, stars, animals, holidays and more.
    </td>
  </tr>
</table>

### See it in action

<table>
  <tr>
    <td width="50%"><img src="docs/img/preview.png" alt="Toolpath preview with duration, cut path length and travel moves"></td>
    <td width="50%"><img src="docs/img/box.png" alt="Finger-joint box generated as five parts"></td>
  </tr>
  <tr>
    <td align="center"><b>Toolpath preview</b> – duration, path length and travel moves before the laser fires</td>
    <td align="center"><b>Box generator</b> – finger joints, kerf compensation, lids and dividers</td>
  </tr>
  <tr>
    <td><img src="docs/img/fonts.png" alt="Font overview with script fonts"></td>
    <td><img src="docs/img/symbols.png" alt="Symbol library next to inserted symbols"></td>
  </tr>
  <tr>
    <td align="center"><b>Font overview</b> – 138 fonts, click to apply</td>
    <td align="center"><b>Symbol library</b> – 97 ready-to-cut shapes</td>
  </tr>
</table>

<details>
<summary><b>More screenshots</b></summary>
<br>
<img src="docs/img/editor-dark.png" alt="BeamSketch in dark mode">
<p align="center">Dark mode.</p>
<img src="docs/img/setup.png" alt="Setup assistant on first start">
<p align="center">The setup assistant picks your laser from a list of 54 models – or reads the real values from the controller.</p>
<img src="docs/img/box-dialog.png" alt="Box generator dialog">
<p align="center">Box generator settings.</p>
</details>

### And also

- **Setup assistant** with a searchable list of 54 laser models; reads `$130`, `$131`, `$30`, `$110` … directly from the controller
- **Tabs** – several designs open at once, each with its own undo history
- **Light and dark theme**, following your system on first start
- **13 languages** – English, German, Spanish, French, Italian, Portuguese, Dutch, Polish, Turkish, Russian, Japanese, Chinese, Korean
- **Private by design** – everything runs locally in your browser; your designs never leave your computer

## Quick start

**Online:** open **[beamsketch.com](https://beamsketch.com)** and click *Start now* – no sign-up needed.
(The hosted version adds an optional free account for online storage and AI tools; those parts are not
in this repository.)

**Locally:** you need [Node.js](https://nodejs.org) 18 or newer – there is nothing to install.

```bash
git clone https://github.com/FelixStopa/beamsketch.git
cd beamsketch
node serve.js          # → http://localhost:8080
```

Any static web server works too – BeamSketch is plain HTML, CSS and ES modules.

> [!NOTE]
> For the **USB connection** to your laser use **Chrome, Edge or Opera** on a desktop computer. Web Serial
> only works on `localhost` or over HTTPS. Firefox and Safari can do everything else – save the GCode and
> send it another way.

### From design to cut

1. Pick your laser in the setup assistant
2. Draw or import your design
3. Assign layers with the color palette at the bottom
4. Double-click a layer to set speed, power and passes (or use the material library)
5. Check the **Preview** – paths and run time
6. **Frame** the job to check the position on the material
7. **Save GCode** – or **Connect** and **Start**

## Supported lasers

| Controller | Status |
|---|---|
| GRBL / GRBL-LPC / grblHAL (almost all diode lasers) | ✅ save GCode **and** send directly via USB |
| Smoothieware (K40 conversions, Cohesion3D) | ✅ GCode |
| xTool D1 / D1 Pro | ✅ GCode (they behave like GRBL) |
| Marlin (3D printer / CNC with laser module) | ⚠️ limited – adjust the start GCode |
| xTool S1, Snapmaker 2.0 | ⚠️ limited – own protocol |
| Ruida (OMTech, Thunder …), Glowforge, xTool F1/M1/P2, LaserPecker, K40 with M2 Nano | ❌ no GCode – drawing and SVG export work |

Creality Falcon, Ortur, Atomstack, Sculpfun, NEJE, Longer, TwoTrees, AlgoLaser, Mecpow, Wainlux, Comgrow
and many more are in the device list (`devices/devices.json`). Missing yours? A pull request with the
model and its work area is very welcome.

## Keyboard shortcuts

| Key | Action | Key | Action |
|---|---|---|---|
| `V` / `N` | Select / edit nodes | `Ctrl+Z` / `Y` | Undo / redo |
| `R` / `E` / `P` | Rectangle / ellipse / polygon | `Ctrl+G` / `U` | Group / ungroup |
| `L` / `B` / `T` | Polyline / bezier / text | `Ctrl+K` | Symbol library |
| `M` | Measure | `Ctrl+M` | Material library |
| `0` / `1` | Fit all / fit work area | `Ctrl+E` | Save GCode |
| `Space` + drag | Pan | `Ctrl+H` | History |

## Project structure

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
| `js/ext.js` | Extension interface |
| `js/i18n.js`, `js/locales/` | Translations |
| `fonts/`, `vendor/` | Bundled fonts and opentype.js, with their licenses |

<details>
<summary><b>Extensions</b></summary>
<br>

The editor works on its own. A page can load extensions via
`<meta name="beamsketch-ext" content="/path/extension.js">`; each module exports `setup(App, helpers)` and
can add tools, menu entries, an online store for projects and symbols, or a per-account browser storage
area. The hooks are documented at the top of `js/ext.js`. beamsketch.com uses this for accounts, online
storage and the AI tools.
</details>

<details>
<summary><b>Translations</b></summary>
<br>

User-facing text is wrapped in `loc('…')`; the German original is the key. Translations live in
`js/locales/<lang>.js` – missing entries fall back to German. Placeholders: `loc('{n} objects', { n })`.
Improvements to existing translations are very welcome.
</details>

## Safety

Lasers can cause fires, burns and permanent eye damage. **Wear laser safety glasses, never leave the laser
unattended, ensure ventilation and keep a fire extinguisher at hand.** Never cut PVC or other
chlorine-containing plastics. You are responsible for checking the generated GCode and your machine
settings before running a job.

## Contributing

Bug reports, laser models, translations and code are all welcome – please read
[CONTRIBUTING.md](CONTRIBUTING.md) first. For bigger changes, open an issue so we can agree on the approach.

## License

Copyright © 2026 Felix Stopa

BeamSketch is free software: you can redistribute it and/or modify it under the terms of the
**GNU Affero General Public License, version 3** – see [LICENSE](LICENSE). It is distributed in the hope
that it will be useful, but WITHOUT ANY WARRANTY.

If you run a modified version for others over a network, the AGPL requires you to offer them its source
code – change `SOURCE_URL` in `js/main.js` (shown in *Help → About*) to point to your version.

Bundled third-party parts keep their own licenses: the fonts in `fonts/` (SIL Open Font License 1.1 or
Apache License 2.0, see `fonts/LICENSES.md`) and opentype.js in `vendor/` (MIT).

The name **BeamSketch** and its logo identify the official project and the service at beamsketch.com.
Please use a different name for modified versions you publish or host.
