// Locates a usable Python 3 interpreter and runs the converter backend.
const { spawn, spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

const CONVERTER = path.join(__dirname, '..', 'backend', 'converter.py');

function candidates(preferred) {
  const list = [];
  if (preferred) list.push({ cmd: preferred, args: [] });
  if (process.env.PYTHON) list.push({ cmd: process.env.PYTHON, args: [] });
  if (process.platform === 'win32') {
    // Real installs first - the WindowsApps "python.exe" is often a Store stub.
    const roots = [
      path.join(process.env.LOCALAPPDATA || '', 'Programs', 'Python'),
      'C:\\Program Files',
      'C:\\Python',
    ];
    for (const root of roots) {
      try {
        for (const d of fs.readdirSync(root).filter((n) => /^Python3\d+$/i.test(n)).sort().reverse()) {
          const exe = path.join(root, d, 'python.exe');
          if (fs.existsSync(exe)) list.push({ cmd: exe, args: [] });
        }
      } catch { /* ignore */ }
    }
    list.push({ cmd: 'py', args: ['-3'] });
    list.push({ cmd: 'python', args: [] });
  } else {
    list.push({ cmd: 'python3', args: [] }, { cmd: 'python', args: [] });
  }
  return list;
}

function probe(c) {
  const code = 'import sys,importlib.util as u;print(sys.version_info[0]);print(1 if u.find_spec("easyeda2kicad") else 0)';
  try {
    const r = spawnSync(c.cmd, [...c.args, '-c', code], { encoding: 'utf8', timeout: 15000, windowsHide: true });
    if (r.status !== 0 || !r.stdout) return null;
    const [major, hasMod] = r.stdout.trim().split(/\r?\n/);
    if (major !== '3') return null;
    return { ...c, hasModule: hasMod === '1' };
  } catch {
    return null;
  }
}

let cached = null;
async function findPython({ preferred, requireModule = true, refresh = false } = {}) {
  if (cached && !refresh && (!preferred || cached.cmd === preferred)) return cached;
  let fallback = null;
  for (const c of candidates(preferred)) {
    const p = probe(c);
    if (!p) continue;
    if (p.hasModule || !requireModule) { cached = p; return p; }
    fallback = fallback || p;
  }
  cached = fallback;
  return fallback;
}

/**
 * Run the converter with a command and JSON job. Calls onEvent for every NDJSON
 * event. Resolves with the exit code. Returns { promise, child }.
 */
function runConverter(py, command, job, onEvent, { cwd } = {}) {
  const child = spawn(py.cmd, [...py.args, '-u', CONVERTER, command], {
    cwd: cwd || os.tmpdir(),
    windowsHide: true,
    env: { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1' },
  });
  let buf = '';
  let errBuf = '';
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    buf += chunk;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (!line) continue;
      try { onEvent(JSON.parse(line)); } catch { onEvent({ event: 'log', level: 'info', message: line }); }
    }
  });
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (c) => { errBuf += c; });
  const promise = new Promise((resolve) => {
    child.on('error', (err) => { onEvent({ event: 'fatal', error: `Failed to start Python: ${err.message}` }); resolve(1); });
    child.on('close', (code) => {
      if (buf.trim()) { try { onEvent(JSON.parse(buf.trim())); } catch { /* ignore */ } }
      if (errBuf.trim()) onEvent({ event: 'log', level: code ? 'error' : 'debug', message: errBuf.trim() });
      resolve(code ?? 1);
    });
  });
  if (job !== undefined) child.stdin.end(JSON.stringify(job));
  else child.stdin.end();
  return { promise, child };
}

module.exports = { findPython, runConverter, CONVERTER };
