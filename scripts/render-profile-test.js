'use strict';

const assert = require('assert');
const path = require('path');
const { spawnSync } = require('child_process');

const root = path.resolve(__dirname, '..');
const fixture = path.join(__dirname, 'fixtures', 'heavy-webgl-smoke.dc.html');
const env = {
  ...process.env,
  AUDIO_SCAN_ONLY: '1',
  VT: '1',
};
delete env.CONC;
const result = spawnSync(process.execPath, [path.join(root, 'capture-parallel.js'), fixture], {
  cwd: root,
  env: env,
  encoding: 'utf8',
});

if (result.status !== 0) {
  process.stderr.write(result.stdout || '');
  process.stderr.write(result.stderr || '');
  process.exit(result.status || 1);
}

const line = result.stdout.split(/\r?\n/).find(function (entry) { return entry.startsWith('AUDIO_SCAN '); });
assert.ok(line, 'AUDIO_SCAN profile was not emitted.');
const profile = JSON.parse(line.slice('AUDIO_SCAN '.length)).renderProfile;
assert.strictEqual(profile.virtualTime, true);
assert.strictEqual(profile.heavyWebGL, true);
assert.strictEqual(profile.concurrency, 4);
assert.strictEqual(profile.concurrencySource, 'automatic');
assert.strictEqual(profile.protocolTimeout, 180000);
assert.strictEqual(profile.retryProtocolTimeout, 300000);
assert.deepStrictEqual(profile.retryConcurrency, [2, 1]);

console.log('Heavy WebGL render profile test passed.');
