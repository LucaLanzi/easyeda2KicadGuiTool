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
- **Offline datasheets**: every exported part's datasheet PDF is downloaded to a
  `datasheets/` folder next to the libraries, named `<LCSC>_<part>.pdf` (e.g.
  `C2040_RP2040.pdf`). Sources tried in order: the EasyEDA datasheet link, the LCSC
  product API, the JLCPCB parts API, then the LCSC product page. Existing files are kept
  unless *overwrite* is on. Toggle it under *Options*.
- `--overwrite`, `--use-cache` and `--custom-field KEY:VALUE` options, plus an *Equivalent CLI*
  view of each export.

## Installation

### 1. Prerequisites

| | Version | Notes |
|---|---|---|
| [Node.js](https://nodejs.org/) | 18+ | runs the web front end |
| [Python](https://www.python.org/downloads/) | 3.9+ | runs the easyeda2kicad conversion |
| [GNU Make](https://www.gnu.org/software/make/) | any | only needed for `make install` |
| [Git](https://git-scm.com/) | any | to clone the repo |
| [KiCad](https://www.kicad.org/) | 6 – 10 | to use the generated libraries |

<details>
<summary><b>Linux (Debian / Ubuntu)</b></summary>

```bash
sudo apt install git make python3 python3-venv python3-pip
# Node.js 18+ (the distro package is often too old), e.g. with nvm:
curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.3/install.sh | bash
nvm install --lts
```
Fedora: `sudo dnf install git make python3 python3-pip nodejs`.
Arch: `sudo pacman -S git make python python-pip nodejs npm`.
</details>

<details>
<summary><b>macOS</b></summary>

```bash
xcode-select --install          # git + make
brew install node python@3.12
```
</details>

<details>
<summary><b>Windows</b></summary>

From PowerShell (open a **new** terminal afterwards so `PATH` is refreshed):

```powershell
winget install -e --id Git.Git
winget install -e --id OpenJS.NodeJS.LTS
winget install -e --id Python.Python.3.12
winget install -e --id ezwinports.make
```
`make` works in PowerShell, cmd and Git Bash. If you'd rather not install Make, use
`start.bat` (see *Without make* below).
</details>

If Node.js or Python is missing, `make install` tries to install it for you (winget on
Windows, Homebrew on macOS). On Linux it prints the command to run instead.

### 2. Install

```bash
git clone https://github.com/LucaLanzi/easyeda2KicadGuiTool.git
cd easyeda2KicadGuiTool
make install
```

`make install` runs these steps:

1. **check-node**: checks for Node.js 18+.
2. **node-deps**: runs `npm install` (Express).
3. **python-deps**: finds Python 3.9+, creates a project-local virtual environment in
   `.venv/`, and runs `pip install -r requirements.txt` (easyeda2kicad) inside it. Nothing is
   installed into your system Python, so the Debian/Ubuntu *"externally-managed-environment"*
   and *"No module named pip"* errors don't apply.
4. **verify**: checks that the backend can import easyeda2kicad.

### 3. Run

```bash
make start        # starts the server and opens http://localhost:3780
```

On a headless machine or over SSH, use `make dev` (no browser), then forward the port from
your desktop with `ssh -L 3780:localhost:3780 user@host` and browse to
<http://localhost:3780>. The server only listens on `127.0.0.1`.

### Make targets

| Target | What it does |
|---|---|
| `make install` | full installation (all steps above) |
| `make start` | start the app and open the browser |
| `make dev` | start without opening a browser |
| `make verify` | check Python + easyeda2kicad |
| `make update` | update npm packages and upgrade easyeda2kicad |
| `make clean` | delete `node_modules/` and `.venv/` (your ledger in `data/` is kept) |
| `make reinstall` | `clean` + `install` |
| `make help` | list all targets |

Variables can be overridden, e.g. `make start PORT=8080` or `make install NODE=/opt/node/bin/node`.

### Without make

- **Windows:** double-click `start.bat`.
- **macOS / Linux:** `./start.sh`

Both scripts run `npm install` and the Python installer (`node scripts/install.js`, which
creates the same `.venv`) the first time, then start the app. By hand, that's
`npm install && npm run setup && npm start`.

### Troubleshooting

- **"Python 3 not found" / wrong interpreter:** set the path under *Options → Python
  interpreter* in the app, or run with `PYTHON=/path/to/python`. The app looks for Python in
  this order: that setting, `$PYTHON`, the project `.venv`, an activated virtualenv/conda env,
  then the system Python.
- **Debian/Ubuntu: "ensurepip is not available":** run `sudo apt install python3-venv`, then `make install` again.
- **Windows: "Python was not found; run without arguments to install from the Microsoft Store":**
  that's the Store stub. Install Python with winget (above). The installer detects the real
  install even before `PATH` is refreshed.
- **Windows Application Control blocks `easyeda2kicad.exe`:** not a problem. The app runs
  easyeda2kicad through Python, not through the generated `.exe`.
- **Something is broken:** run `make reinstall`.

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
scripts/install.js   Python installer (.venv + easyeda2kicad), used by make / start scripts
scripts/check-python.js  environment check
Makefile             make install / start / update / clean ...
start.bat, start.sh  one-click launchers
```

## Credits & license

All conversion work is done by [easyeda2kicad.py](https://github.com/uPesy/easyeda2kicad.py)
by uPesy (AGPL-3.0). This GUI imports that library, so it is also released under the
**GNU AGPL v3.0**; see [LICENSE](LICENSE).

Not affiliated with EasyEDA, LCSC, JLCPCB or KiCad.
