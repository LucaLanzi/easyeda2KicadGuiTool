// Exit 0 if a Python 3 with easyeda2kicad is available, 1 otherwise.
const { findPython } = require('../lib/python');

(async () => {
  const py = await findPython({ requireModule: true });
  if (py && py.hasModule) {
    console.log(`Python OK: ${py.cmd} ${py.args.join(' ')}`.trim());
    process.exit(0);
  }
  console.log(py ? 'easyeda2kicad is not installed for this Python.' : 'No Python 3 interpreter found.');
  process.exit(1);
})();
