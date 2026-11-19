// Installs the Python dependency (easyeda2kicad) using the detected Python.
const { findPython } = require('../lib/python');
const { spawnSync } = require('child_process');
const path = require('path');

(async () => {
  const py = await findPython({ requireModule: false });
  if (!py) {
    console.error('No Python 3 interpreter found. Install Python 3.9+ (https://www.python.org/downloads/) and re-run.');
    process.exit(1);
  }
  console.log(`Using Python: ${py.cmd} ${py.args.join(' ')}`);
  const req = path.join(__dirname, '..', 'requirements.txt');
  const r = spawnSync(py.cmd, [...py.args, '-m', 'pip', 'install', '--upgrade', '-r', req], { stdio: 'inherit' });
  process.exit(r.status ?? 1);
})();
