'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const root = path.resolve(__dirname, '..');
const fixture = path.join(__dirname, 'fixtures', 'webgl-context-loss.dc.html');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'renderer2-context-loss-'));
const output = path.join(temp, 'must-not-exist.mp4');

try {
  const result = spawnSync(process.execPath, [path.join(root, 'capture-parallel.js'), fixture], {
    cwd: root,
    env: {
      ...process.env,
      CONC: '1',
      DURATION: '0.3',
      FORMAT: 'jpeg',
      FPS: '10',
      JPEG_Q: '80',
      NOAUDIO: '1',
      OUT: output,
      RENDERER2_TEMP: temp,
      RETRY_FAILED_SHARDS: '0',
      VT: '1',
    },
    encoding: 'utf8',
    timeout: 120000,
  });

  const combined = (result.stdout || '') + '\n' + (result.stderr || '');
  assert.notStrictEqual(result.status, 0, 'A lost WebGL context must fail the shard.');
  assert.match(combined, /WEBGL_CONTEXT_LOST/, 'Failure output must identify WebGL context loss.');
  assert.strictEqual(fs.existsSync(output), false, 'A context-lost render must not produce an MP4.');
  console.log('WebGL context-loss guard test passed.');
} finally {
  fs.rmSync(temp, { recursive: true, force: true });
}
