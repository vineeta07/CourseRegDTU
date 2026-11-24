// scripts/start.js — launch Electron with ELECTRON_RUN_AS_NODE removed.
// VS Code (and tools started from it) set that variable, which makes Electron
// behave like plain Node, so require('electron') has no `app` and nothing runs.
// Usage: node scripts/start.js [entry]   (entry defaults to the app folder)

const { spawn } = require('child_process');
const path = require('path');
const electron = require('electron'); // path to the binary when run under Node

const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
const target = process.argv[2] || path.join(__dirname, '..');
const child = spawn(electron, [target], { stdio: 'inherit', env });
child.on('exit', code => process.exit(code == null ? 1 : code));
