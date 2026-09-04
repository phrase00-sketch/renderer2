'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const root = path.resolve(__dirname, '..');
const fixture = path.join(__dirname, 'fixtures', 'om-seek-contract.dc.html');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'renderer2-om-seek-'));
const output = path.join(temp, 'om-seek.mp4');
const trace = path.join(temp, 'trace.jsonl');

try {
  const result = spawnSync(process.execPath, [path.join(root, 'capture-deck2-vt.js'), fixture], {
    cwd: root,
    env: {
      ...process.env,
      BOOT_MS: '2000',
      DURATION: '0.4',
      FORMAT: 'jpeg',
      FPS: '10',
      JPEG_Q: '80',
      NOAUDIO: '1',
      OUT: output,
      PORT: '8897',
      PRESET: 'ultrafast',
      TRACE_FILE: trace,
      WARMUP_MS: '1',
    },
    encoding: 'utf8',
    timeout: 60000,
  });

  if (result.status !== 0) {
    process.stdout.write(result.stdout || '');
    process.stderr.write(result.stderr || '');
  }
  assert.strictEqual(result.status, 0, 'VT renderer must complete the OM seek fixture.');
  assert.strictEqual(fs.existsSync(output), true, 'OM seek fixture must emit an MP4.');
  const rows = fs.readFileSync(trace, 'utf8').trim().split(/\r?\n/).map(JSON.parse);
  assert.strictEqual(rows.length, 4, 'Fixture must capture four frames.');
  assert.strictEqual(rows[0].sceneId, 'om-0.000');
  assert.strictEqual(rows[rows.length - 1].sceneId, 'om-0.300');
  assert.notStrictEqual(rows[0].sceneId, rows[rows.length - 1].sceneId);
  console.log('Continuous-composition seek contract test passed.');
} finally {
  fs.rmSync(temp, { recursive: true, force: true });
}
