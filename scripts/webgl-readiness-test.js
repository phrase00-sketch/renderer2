'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const root = path.resolve(__dirname, '..');
const fixtures = path.join(__dirname, 'fixtures');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'renderer2-webgl-ready-'));
let portOffset = 0;

function run(name, options = {}) {
  const output = path.join(temp, name.replace(/\.dc\.html$/i, '') + '.mp4');
  const result = spawnSync(process.execPath, [path.join(root, 'capture-deck2-vt.js'), path.join(fixtures, name)], {
    cwd: root,
    env: {
      ...process.env,
      DURATION: '0.2',
      FORMAT: 'jpeg',
      FPS: '5',
      JPEG_Q: '80',
      NOAUDIO: '1',
      OUT: output,
      PORT: String(9600 + portOffset++),
      STARTUP_STALL_TIMEOUT: '0',
      VT: '1',
      WEBGL_CONTEXT_GUARD: '1',
      WEBGL_READY_TIMEOUT: String(options.readyTimeout || 3000),
    },
    encoding: 'utf8',
    timeout: 120000,
  });
  return { result, output, combined: (result.stdout || '') + '\n' + (result.stderr || '') };
}

try {
  const missing = run('webgl-not-initialized.dc.html', { readyTimeout: 300 });
  assert.notStrictEqual(missing.result.status, 0, 'A legacy heavy-WebGL deck with no context must fail.');
  assert.match(missing.combined, /WEBGL_NOT_INITIALIZED/, 'Missing-context failure must be explicit.');
  assert.strictEqual(fs.existsSync(missing.output), false, 'Missing-context failure must not emit an MP4.');

  const explicitError = run('webgl-status-error.dc.html');
  assert.notStrictEqual(explicitError.result.status, 0, 'An explicit WebGL boot error must fail.');
  assert.match(explicitError.combined, /WEBGL_BOOT_ERROR/, 'Status-contract boot failure must be explicit.');
  assert.strictEqual(fs.existsSync(explicitError.output), false, 'Boot-error failure must not emit an MP4.');

  const dark = run('webgl-dark-ready.dc.html');
  assert.strictEqual(dark.result.status, 0, 'A valid near-black WebGL frame must not be rejected by luminance.');
  assert.match(dark.combined, /WEBGL READY contract=v1/, 'The versioned ready contract must be recognized.');
  assert.strictEqual(fs.existsSync(dark.output), true, 'A valid dark WebGL deck must emit an MP4.');

  const delayed = run('webgl-delayed-ready.dc.html');
  assert.strictEqual(delayed.result.status, 0, 'A delayed ready contract must succeed within its deadline.');
  assert.match(delayed.combined, /WEBGL READY contract=v1/, 'Delayed ready must be logged as contract-ready.');
  assert.strictEqual(fs.existsSync(delayed.output), true, 'A delayed-ready WebGL deck must emit an MP4.');

  console.log('WebGL initialization and ready-contract tests passed.');
} finally {
  fs.rmSync(temp, { recursive: true, force: true });
}
