# easyeda2KicadGuiTool

A local web GUI (Node.js front end + Python back end) for
[easyeda2kicad.py](https://github.com/uPesy/easyeda2kicad.py). Keep a **ledger** of
LCSC / JLCPCB part numbers, choose what to generate for each part, pick **where** the
library goes and **what it's called**, and export KiCad symbols, footprints and 3D
models. The 3D models are linked **relative to your KiCad project**, so they show up
in the 3D viewer straight away.

## Features

- **Parts ledger**: add LCSC IDs (`C2040 C20197, C163691`, or just the numbers), import a
  JLCPCB BOM / any CSV (the LCSC column is detected automatically), add notes, filter, and save back to CSV.
  The ledger is saved automatically to `data/ledger.json`.
- **Per-part options**, matching the easyeda2kicad CLI:

  | GUI column | CLI flag |
  |---|---|
  | Full | `--full` (symbol + footprint + 3D) |
  | Sym | `--symbol` |
  | FP | `--footprint` |
  | 3D | `--3d` |
  | SVG | `--svg` (SVG preview, no KiCad conversion) |

  Click a column header to toggle it for every visible row.
- **Look up / preview**: fetches the part name, manufacturer, MPN and package, whether a 3D
  model exists, and renders the symbol and footprint.
- **Visual export location**: a built-in folder browser (plus the native Windows dialog) that
  recognises `.kicad_pro`, `.kicad_sym`, `.pretty` and `.3dshapes` folders. A live tree shows
  exactly what will be written and where.
- **Independent names** for the symbol library (`.kicad_sym`), footprint library (`.pretty`),
  3D model folder (`.3dshapes`) and SVG folder. Tick *Same for all* to link them.
- **Project-relative 3D models**: every exported footprint gets
  `(model "${KIPRJMOD}/<path>/<Lib>.3dshapes/<model>.wrl" …)`, computed from the KiCad
  project folder you select (not from the current working directory). Absolute paths or a
  custom prefix such as `${MY_3D_LIBS}/Parts.3dshapes` are also available.
- **Automatic lib-table registration**: adds or updates the libraries in the project's
  `sym-lib-table` and `fp-lib-table` with `${KIPRJMOD}` URIs. Symbols' *Footprint* fields
  already point at your footprint library name, so parts drop straight onto the PCB with
  their 3D bodies.
- **Relink tool**: rewrites the 3D paths of every footprint in an existing `.pretty`
  folder, e.g. after moving a library into a project.
- `--overwrite`, `--use-cache` and `--custom-field KEY:VALUE` options, plus an *Equivalent CLI*
  view of each export.

## Requirements

- [Node.js](https://nodejs.org/) 18+
- [Python](https://www.python.org/downloads/) 3.9+ (`easyeda2kicad` is installed automatically)
- KiCad 6 or newer

## Quick start

```bash
git clone https://github.com/LucaLanzi/easyeda2KicadGuiTool.git
cd easyeda2KicadGuiTool
```

**Windows:** double-click `start.bat`.
**macOS / Linux:** `./start.sh`

Or manually:

```bash
npm install
npm run setup     # pip install -r requirements.txt with the detected Python
npm start         # opens http://localhost:3780
```

If easyeda2kicad is missing, the header shows **Install easyeda2kicad**. If Python isn't
found automatically, set the interpreter path under *Options*.

## Typical workflow

1. Add part numbers to the ledger, or import your JLCPCB BOM.
2. *Look up selected* to check names, packages and 3D availability (optional).
3. Set **KiCad project folder** to the folder that contains your `.kicad_pro`.
   If the output folder is empty, it defaults to `<project>/libs`.
4. Set the library name(s). The tree preview shows the result:

   ```
   MyBoard/  ◆ MyBoard.kicad_pro
   ├─ sym-lib-table  + "MyParts"
   ├─ fp-lib-table   + "MyParts"
   └─ libs/
      ├─ MyParts.kicad_sym
      ├─ MyParts.pretty/
      └─ MyParts.3dshapes/  .wrl + .step
   ```
   Footprint 3D model path: `${KIPRJMOD}/libs/MyParts.3dshapes/<model>.wrl`
5. **Export selected** or **Export all**. Re-open the project in KiCad; the libraries are
   already registered.

## Notes

- Footprints reference the `.wrl` model by default. easyeda2kicad also downloads a `.step`,
  but it does not bake the placement offset into STEP files, so some STEP models can
  appear shifted. You can switch to `.step` under *3D model linking*.
- The server only listens on `127.0.0.1`.
- App state (ledger, settings, API cache) is stored in `data/`, which is git-ignored. Set
  `E2K_DATA_DIR` to move it, and `PORT` to change the port.
- On Windows systems with Application Control policies, `pip`-generated `.exe` launchers
  can be blocked. This tool calls the library through Python directly, so it isn't affected.

## Project structure

```
server.js            Express server: REST API, folder browser, streams export progress
lib/python.js        Python discovery + NDJSON bridge to the backend
backend/converter.py Python backend driving the easyeda2kicad library
public/              Front end (vanilla HTML/CSS/JS, no build step)
scripts/             setup + environment check helpers
```

## Credits & license

All conversion work is done by [easyeda2kicad.py](https://github.com/uPesy/easyeda2kicad.py)
by uPesy (AGPL-3.0). This GUI imports that library, so it is also released under the
**GNU AGPL v3.0**; see [LICENSE](LICENSE).

Not affiliated with EasyEDA, LCSC, JLCPCB or KiCad.
