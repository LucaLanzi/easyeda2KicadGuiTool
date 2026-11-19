#!/usr/bin/env node
// Python side of the installation (called by `make install` / `npm run setup`).
//
//   1. find a Python >= 3.9 (installs one with winget / Homebrew if missing)
//   2. create a project-local virtual environment in .venv
//   3. pip install -r requirements.txt into it
//   4. verify that the converter backend can import easyeda2kicad
//
// Only Node built-ins are used, so this runs before `npm install`.
const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const { findPython, VENV_DIR, VENV_PYTHON, CONVERTER } = require('../lib/python');

const ROOT = path.join(__dirname, '..');
const REQUIREMENTS = path.join(ROOT, 'requirements.txt');
const MIN_PY = [3, 9];
const args = process.argv.slice(2);
const NO_VENV = args.includes('--no-venv') || process.env.E2K_NO_VENV === '1';
const UPGRADE = args.includes('--upgrade');

const c = (code) => (s) => (process.stdout.isTTY ? `\x1b[${code}m${s}\x1b[0m` : s);
const bold = c('1'); const green = c('32'); const yellow = c('33'); const red = c('31');
const step = (msg) => console.log(`\n${bold('==>')} ${bold(msg)}`);
const ok = (msg) => console.log(`    ${green('✓')} ${msg}`);
const warn = (msg) => console.log(`    ${yellow('!')} ${msg}`);
function fail(msg, hint) {
  console.error(`\n${red('✗ ' + msg)}`);
  if (hint) console.error(hint);
  process.exit(1);
}
function run(cmd, cmdArgs, opts = {}) {
  console.log(`    $ ${[cmd, ...cmdArgs].map((a) => (/\s/.test(a) ? `"${a}"` : a)).join(' ')}`);
  const r = spawnSync(cmd, cmdArgs, { stdio: 'inherit', ...opts });
  return r.status === 0;
}
function has(cmd) {
  const r = spawnSync(process.platform === 'win32' ? 'where' : 'which', [cmd], { stdio: 'ignore' });
  return r.status === 0;
}
function pyVersion(py) {
  const r = spawnSync(py.cmd, [...py.args, '-c', 'import sys;print("%d.%d.%d" % sys.version_info[:3])'], { encoding: 'utf8' });
  return r.status === 0 ? r.stdout.trim() : null;
}
const versionOk = (v) => {
  const [a, b] = v.split('.').map(Number);
  return a > MIN_PY[0] || (a === MIN_PY[0] && b >= MIN_PY[1]);
};

async function findBasePython() {
  const py = await findPython({ requireModule: false, refresh: true, includeVenv: false });
  if (!py) return null;
  const v = pyVersion(py);
  return v && versionOk(v) ? { ...py, version: v } : null;
}

async function ensurePython() {
  step('Checking for Python 3.9+');
  let py = await findBasePython();
  if (py) { ok(`Python ${py.version}: ${[py.cmd, ...py.args].join(' ')}`); return py; }

  warn('No suitable Python found, trying to install it');
  let installed = false;
  if (process.platform === 'win32' && has('winget')) {
    installed = run('winget', ['install', '-e', '--id', 'Python.Python.3.12', '--accept-package-agreements', '--accept-source-agreements']);
  } else if (process.platform === 'darwin' && has('brew')) {
    installed = run('brew', ['install', 'python@3.12']);
  }
  if (installed) py = await findBasePython();
  if (py) { ok(`Python ${py.version} installed: ${py.cmd}`); return py; }

  const hints = {
    win32: '  Install it with:  winget install -e --id Python.Python.3.12\n  or download it from https://www.python.org/downloads/ (tick "Add python.exe to PATH").',
    darwin: '  Install it with:  brew install python@3.12   (or from https://www.python.org/downloads/)',
    linux: '  Debian/Ubuntu:  sudo apt install python3 python3-venv python3-pip\n  Fedora:         sudo dnf install python3 python3-pip\n  Arch:           sudo pacman -S python python-pip',
  };
  return fail('Python 3.9+ is required but was not found.',
    `${hints[process.platform] || hints.linux}\n  Then open a new terminal and run "make install" again.`);
}

function ensureVenv(py) {
  step(`Creating virtual environment in ${path.relative(ROOT, VENV_DIR) || VENV_DIR}`);
  if (fs.existsSync(VENV_PYTHON)) {
    const v = pyVersion({ cmd: VENV_PYTHON, args: [] });
    if (v) { ok(`Already exists (Python ${v})`); return { cmd: VENV_PYTHON, args: [] }; }
    warn('Existing .venv is broken, recreating it');
    fs.rmSync(VENV_DIR, { recursive: true, force: true });
  }
  if (run(py.cmd, [...py.args, '-m', 'venv', VENV_DIR]) && fs.existsSync(VENV_PYTHON)) {
    ok('Created');
    return { cmd: VENV_PYTHON, args: [] };
  }
  fs.rmSync(VENV_DIR, { recursive: true, force: true });
  warn('Could not create a virtual environment (Debian/Ubuntu need: sudo apt install python3-venv).');
  return null;
}

const hasPip = (py) => spawnSync(py.cmd, [...py.args, '-m', 'pip', '--version'], { stdio: 'ignore' }).status === 0;

// Used when .venv could not be created: an activated venv, or a Python that has pip.
function fallbackPython(base) {
  const active = process.env.VIRTUAL_ENV || process.env.CONDA_PREFIX;
  if (active) {
    const exe = process.platform === 'win32' ? path.join(active, active === process.env.VIRTUAL_ENV ? 'Scripts' : '', 'python.exe') : path.join(active, 'bin', 'python');
    if (fs.existsSync(exe) && hasPip({ cmd: exe, args: [] })) {
      warn(`Installing into the active environment instead: ${active}`);
      warn('Remember to activate it before starting the app.');
      return { py: { cmd: exe, args: [] }, user: false };
    }
  }
  if (hasPip(base)) {
    warn('Falling back to a per-user pip install.');
    return { py: base, user: process.platform !== 'win32' };
  }
  return fail('Python has no pip and no virtual environment could be created.',
    '  Debian/Ubuntu:  sudo apt install python3-venv python3-pip\n'
    + '  Fedora:         sudo dnf install python3-pip\n'
    + '  Then run "make install" again.');
}

function pipInstall(py, user) {
  step('Installing Python packages (easyeda2kicad)');
  const base = [...py.args, '-m', 'pip'];
  run(py.cmd, [...base, 'install', '--upgrade', 'pip', '--quiet', '--disable-pip-version-check']);
  const extra = [...(user ? ['--user'] : []), ...(UPGRADE ? ['--upgrade'] : [])];
  if (!run(py.cmd, [...base, 'install', ...extra, '--disable-pip-version-check', '-r', REQUIREMENTS])) {
    fail('pip install failed.', '  Check your internet connection / proxy and try again.');
  }
  ok('easyeda2kicad installed');
}

function verify(py) {
  step('Verifying the conversion backend');
  const r = spawnSync(py.cmd, [...py.args, CONVERTER, 'check'], { encoding: 'utf8' });
  let info = null;
  try { info = JSON.parse(r.stdout.trim().split(/\r?\n/).pop()); } catch { /* ignore */ }
  if (!info?.ok) fail('The backend could not import easyeda2kicad.', r.stdout + r.stderr);
  ok(`easyeda2kicad ${info.easyeda2kicad} on Python ${info.pyversion}`);
}

(async () => {
  const base = await ensurePython();
  const venv = NO_VENV ? null : ensureVenv(base);
  const { py, user } = venv ? { py: venv, user: false } : fallbackPython(base);
  pipInstall(py, user);
  verify(py);
  console.log(`\n${green(bold('Installation complete.'))} Start the app with ${bold('make start')} (or start.bat / ./start.sh).\n`);
})();
