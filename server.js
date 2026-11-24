// easyeda2KicadGuiTool - Node.js web front end for easyeda2kicad.py
const express = require('express');
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');
const { findPython, runConverter } = require('./lib/python');

const ROOT = __dirname;
const DATA_DIR = process.env.E2K_DATA_DIR || path.join(ROOT, 'data');
const LEDGER_FILE = path.join(DATA_DIR, 'ledger.json');
const SETTINGS_FILE = path.join(DATA_DIR, 'settings.json');
const CACHE_DIR = path.join(DATA_DIR, 'cache'); // cwd for python -> .easyeda_cache lives here
const HOST = '127.0.0.1';
const BASE_PORT = Number(process.env.PORT) || 3780;
const NO_OPEN = process.argv.includes('--no-open') || process.env.E2K_NO_OPEN === '1';

fs.mkdirSync(CACHE_DIR, { recursive: true });

const DEFAULT_SETTINGS = {
  pythonPath: '',
  outputDir: path.join(os.homedir(), 'Documents', 'KiCad', 'easyeda2kicad'),
  projectDir: '',
  libName: 'easyeda2kicad',
  names: { symbol: 'easyeda2kicad', footprint: 'easyeda2kicad', model: 'easyeda2kicad', svg: 'easyeda2kicad' },
  linkNames: true,
  modelPathMode: 'project',
  customModelPrefix: '',
  modelExt: 'wrl',
  overwrite: false,
  useCache: true,
  updateLibTables: true,
  downloadDatasheets: true,
  customFields: [],
  defaults: { symbol: true, footprint: true, model3d: true, svg: false },
  recentDirs: [],
};

// ------------------------------------------------------------------ helpers
async function readJson(file, fallback) {
  try { return JSON.parse(await fsp.readFile(file, 'utf8')); } catch { return fallback; }
}
async function writeJson(file, data) {
  await fsp.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  await fsp.writeFile(tmp, JSON.stringify(data, null, 2), 'utf8');
  await fsp.rename(tmp, file);
}
async function getSettings() {
  const s = await readJson(SETTINGS_FILE, {});
  return { ...DEFAULT_SETTINGS, ...s, names: { ...DEFAULT_SETTINGS.names, ...(s.names || {}) }, defaults: { ...DEFAULT_SETTINGS.defaults, ...(s.defaults || {}) } };
}
async function python(refresh = false) {
  const s = await getSettings();
  return findPython({ preferred: s.pythonPath || undefined, refresh });
}
function bad(res, msg, code = 400) { res.status(code).json({ error: msg }); }

// ------------------------------------------------------------------ app
const app = express();
app.use(express.json({ limit: '5mb' }));
app.use(express.static(path.join(ROOT, 'public')));

// Only accept requests addressed to localhost (DNS-rebinding protection).
app.use('/api', (req, res, next) => {
  const host = (req.headers.host || '').split(':')[0];
  if (!['127.0.0.1', 'localhost', '[::1]'].includes(host)) return bad(res, 'Forbidden host', 403);
  next();
});

// ---- status / setup
app.get('/api/status', async (req, res) => {
  const py = await python(req.query.refresh === '1');
  if (!py) return res.json({ python: null, ok: false, error: 'No Python 3 interpreter found' });
  let check = null;
  await runConverter(py, 'check', undefined, (ev) => { if (ev.event === 'check') check = ev; }).promise;
  res.json({ python: [py.cmd, ...py.args].join(' '), ...(check || { ok: false, error: 'check failed' }), platform: process.platform });
});

app.post('/api/install', async (req, res) => {
  // Same installer as `make install`: creates .venv and pip-installs easyeda2kicad into it.
  res.setHeader('Content-Type', 'text/plain; charset=utf-8');
  const child = spawn(process.execPath, [path.join(ROOT, 'scripts', 'install.js')], { windowsHide: true, cwd: ROOT });
  child.stdout.pipe(res, { end: false });
  child.stderr.pipe(res, { end: false });
  child.on('close', (code) => { res.end(`\n[exit code ${code}]\n`); findPython({ refresh: true }); });
  child.on('error', (e) => res.end(`\nFailed: ${e.message}\n`));
});

// ---- settings & ledger persistence
app.get('/api/settings', async (req, res) => res.json(await getSettings()));
app.put('/api/settings', async (req, res) => {
  const merged = { ...(await getSettings()), ...req.body };
  await writeJson(SETTINGS_FILE, merged);
  res.json(merged);
});
app.get('/api/ledger', async (req, res) => res.json(await readJson(LEDGER_FILE, { parts: [] })));
app.put('/api/ledger', async (req, res) => {
  if (!req.body || !Array.isArray(req.body.parts)) return bad(res, 'Expected { parts: [] }');
  await writeJson(LEDGER_FILE, { parts: req.body.parts, savedAt: new Date().toISOString() });
  res.json({ ok: true });
});

// ---- filesystem browser
function listRoots() {
  const roots = [];
  if (process.platform === 'win32') {
    for (let c = 67; c <= 90; c++) {
      const d = `${String.fromCharCode(c)}:\\`;
      try { fs.accessSync(d); roots.push({ name: d, path: d }); } catch { /* none */ }
    }
  } else roots.push({ name: '/', path: '/' });
  const home = os.homedir();
  const quick = [
    { name: 'Home', path: home },
    { name: 'Documents', path: path.join(home, 'Documents') },
    { name: 'KiCad projects', path: path.join(home, 'Documents', 'KiCad') },
    { name: 'Desktop', path: path.join(home, 'Desktop') },
  ].filter((q) => fs.existsSync(q.path));
  return { roots, quick };
}

app.get('/api/fs/roots', async (req, res) => {
  const s = await getSettings();
  res.json({ ...listRoots(), recent: (s.recentDirs || []).filter((d) => fs.existsSync(d)) });
});

app.get('/api/fs/list', async (req, res) => {
  const raw = String(req.query.path || '').trim();
  const p = !raw || raw === '~' ? os.homedir() : path.resolve(raw.replace(/^~(?=[\\/])/, os.homedir()));
  try {
    const entries = await fsp.readdir(p, { withFileTypes: true });
    const dirs = [];
    const kicad = { projects: [], symbolLibs: [], footprintLibs: [], modelDirs: [] };
    for (const e of entries) {
      const n = e.name;
      if (e.isDirectory()) {
        if (n.endsWith('.pretty')) kicad.footprintLibs.push(n.slice(0, -7));
        else if (n.endsWith('.3dshapes')) kicad.modelDirs.push(n.slice(0, -9));
        if (!n.startsWith('.') && !n.startsWith('$')) dirs.push(n);
      } else if (n.endsWith('.kicad_pro')) kicad.projects.push(n);
      else if (n.endsWith('.kicad_sym')) kicad.symbolLibs.push(n.slice(0, -10));
    }
    dirs.sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }));
    const parent = path.dirname(p);
    res.json({ path: p, parent: parent === p ? null : parent, sep: path.sep, dirs, kicad });
  } catch (err) {
    bad(res, `Cannot read folder: ${err.message}`);
  }
});

app.post('/api/fs/mkdir', async (req, res) => {
  const { parent, name } = req.body || {};
  if (!parent || !name || /[<>:"/\\|?*]/.test(name)) return bad(res, 'Invalid folder name');
  const p = path.join(path.resolve(parent), name);
  try { await fsp.mkdir(p, { recursive: true }); res.json({ path: p }); } catch (e) { bad(res, e.message); }
});

app.post('/api/fs/native-pick', (req, res) => {
  if (process.platform !== 'win32') return bad(res, 'Native picker is only available on Windows', 501);
  const ps = [
    'Add-Type -AssemblyName System.Windows.Forms',
    '$d = New-Object System.Windows.Forms.FolderBrowserDialog',
    '$d.Description = $env:E2K_TITLE',
    '$d.ShowNewFolderButton = $true',
    'if ($env:E2K_START -and (Test-Path -LiteralPath $env:E2K_START)) { $d.SelectedPath = $env:E2K_START }',
    '$f = New-Object System.Windows.Forms.Form -Property @{TopMost=$true; ShowInTaskbar=$false}',
    'if ($d.ShowDialog($f) -eq [System.Windows.Forms.DialogResult]::OK) { [Console]::Out.Write($d.SelectedPath) }',
  ].join('; ');
  const child = spawn('powershell.exe', ['-NoProfile', '-STA', '-Command', ps], {
    env: { ...process.env, E2K_START: String(req.body?.start || ''), E2K_TITLE: String(req.body?.title || 'Select folder') },
    windowsHide: false,
  });
  let out = '';
  child.stdout.on('data', (c) => { out += c; });
  child.on('close', () => res.json({ path: out.trim() || null }));
  child.on('error', (e) => bad(res, e.message, 500));
});

app.post('/api/fs/open', (req, res) => {
  const p = String(req.body?.path || '');
  if (!p || !fs.existsSync(p)) return bad(res, 'Path does not exist');
  const cmd = process.platform === 'win32' ? 'explorer.exe' : process.platform === 'darwin' ? 'open' : 'xdg-open';
  const child = spawn(cmd, [p], { detached: true, stdio: 'ignore' });
  child.on('error', () => { if (!res.headersSent) bad(res, `No file manager available (${cmd} not found)`, 501); });
  child.on('spawn', () => { child.unref(); if (!res.headersSent) res.json({ ok: true }); });
});

app.get('/api/svg', (req, res) => {
  const p = path.resolve(String(req.query.path || ''));
  if (!p.toLowerCase().endsWith('.svg') || !fs.existsSync(p)) return bad(res, 'Not an SVG file', 404);
  res.type('image/svg+xml').sendFile(p);
});

// ---- conversion
app.post('/api/info', async (req, res) => {
  const ids = (req.body?.ids || []).map(String).filter(Boolean).slice(0, 50);
  if (!ids.length) return bad(res, 'No ids');
  const py = await python();
  if (!py?.hasModule) return bad(res, 'easyeda2kicad is not installed', 500);
  const s = await getSettings();
  const results = [];
  const logs = [];
  await runConverter(py, 'info', { ids, use_cache: s.useCache, svg: req.body?.svg !== false }, (ev) => {
    if (ev.event === 'part_info') results.push(ev);
    else if (ev.event === 'log' || ev.event === 'fatal') logs.push(ev);
  }, { cwd: CACHE_DIR }).promise;
  res.json({ results, logs });
});

let activeJob = null;
app.post('/api/export', async (req, res) => {
  if (activeJob) return bad(res, 'An export is already running', 409);
  const job = req.body || {};
  if (!job.output_dir) return bad(res, 'Choose an output folder');
  if (!Array.isArray(job.parts) || !job.parts.length) return bad(res, 'No parts selected');
  const py = await python();
  if (!py?.hasModule) return bad(res, 'easyeda2kicad is not installed - use the Setup button', 500);

  // remember recent folders
  const s = await getSettings();
  const recent = [job.output_dir, job.project_dir, ...(s.recentDirs || [])].filter(Boolean);
  s.recentDirs = [...new Set(recent)].slice(0, 8);
  await writeJson(SETTINGS_FILE, s);

  res.setHeader('Content-Type', 'application/x-ndjson; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache');
  res.flushHeaders();
  const { promise, child } = runConverter(py, 'export', job, (ev) => res.write(JSON.stringify(ev) + '\n'), { cwd: CACHE_DIR });
  activeJob = child;
  res.on('close', () => { if (activeJob === child && child.exitCode === null) child.kill(); });
  const code = await promise;
  activeJob = null;
  res.end(JSON.stringify({ event: 'exit', code }) + '\n');
});

app.post('/api/export/cancel', (req, res) => {
  if (activeJob) { activeJob.kill(); activeJob = null; return res.json({ cancelled: true }); }
  res.json({ cancelled: false });
});

app.post('/api/relink', async (req, res) => {
  const py = await python();
  if (!py?.hasModule) return bad(res, 'easyeda2kicad is not installed', 500);
  const events = [];
  const code = await runConverter(py, 'relink', req.body || {}, (ev) => events.push(ev), { cwd: CACHE_DIR }).promise;
  res.json({ code, events });
});

// ------------------------------------------------------------------ start
function openBrowser(url) {
  const headless = process.platform === 'linux' && !process.env.DISPLAY && !process.env.WAYLAND_DISPLAY;
  if (headless) {
    console.log('No desktop session detected. Open the URL above in a browser');
    console.log(`(over SSH:  ssh -L ${url.split(':').pop()}:localhost:${url.split(':').pop()} <user>@<this-host>  then browse to ${url}).`);
    return;
  }
  const cmd = process.platform === 'win32' ? 'cmd' : process.platform === 'darwin' ? 'open' : 'xdg-open';
  const args = process.platform === 'win32' ? ['/c', 'start', '""', url] : [url];
  try {
    const child = spawn(cmd, args, { detached: true, stdio: 'ignore', windowsHide: true });
    child.on('error', () => console.log(`Could not open a browser automatically. Open ${url} manually.`));
    child.unref();
  } catch {
    console.log(`Could not open a browser automatically. Open ${url} manually.`);
  }
}

function listen(port, attempts = 10) {
  const server = app.listen(port, HOST, () => {
    const url = `http://localhost:${port}`;
    console.log(`easyeda2KicadGuiTool running at ${url}  (Ctrl+C to stop)`);
    if (!NO_OPEN) openBrowser(url);
  });
  server.on('error', (err) => {
    if (err.code === 'EADDRINUSE' && attempts > 0) listen(port + 1, attempts - 1);
    else { console.error(err); process.exit(1); }
  });
}

if (require.main === module) listen(BASE_PORT);
module.exports = app;
