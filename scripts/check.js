'use strict';

const path = require('path');
const { spawnSync } = require('child_process');

const root = path.resolve(__dirname, '..');
const files = [
  'capture-parallel.js',
  'capture-deck2.js',
  'capture-deck2-vt.js',
  'vt-probe.js',
  'scripts/render-vt.js',
  'scripts/smoke-test.js',
];

for (const file of files) {
  const result = spawnSync(process.execPath, ['--check', path.join(root, file)], {
    stdio: 'inherit',
  });
  if (result.status !== 0) process.exit(result.status || 1);
}

console.log('Syntax check passed for ' + files.length + ' files.');
