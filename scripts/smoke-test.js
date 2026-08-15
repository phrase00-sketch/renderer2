'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const root = path.resolve(__dirname, '..');
const virtualTime = process.argv.includes('--vt');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'renderer2-smoke-'));
const output = path.join(temp, 'smoke.mp4');

function requireCommand(command, args) {
  const result = spawnSync(command, args, { encoding: 'utf8' });
  if (result.error || result.status !== 0) {
    throw new Error(command + ' is required but was not available.');
  }
}

try {
  requireCommand('ffmpeg', ['-version']);
  requireCommand('ffprobe', ['-version']);

  const result = spawnSync(
    process.execPath,
    [
      path.join(root, virtualTime ? 'scripts/render-vt.js' : 'capture-parallel.js'),
      path.join(root, 'examples', 'sample-deck.dc.html'),
    ],
    {
      cwd: root,
      env: {
        ...process.env,
        BOUNDS: '[0]',
        CONC: '1',
        DURATION: '0.5',
        FORMAT: 'jpeg',
        FPS: '10',
        JPEG_Q: '80',
        NOAUDIO: '1',
        OUT: output,
        PRESET: 'ultrafast',
      },
      stdio: 'inherit',
    },
  );

  if (result.status !== 0) throw new Error('Renderer exited with code ' + result.status + '.');
  if (!fs.existsSync(output) || fs.statSync(output).size < 1000) {
    throw new Error('Smoke output was not created or was unexpectedly small.');
  }

  console.log((virtualTime ? 'Virtual-time' : 'CSS') + ' smoke render passed: ' + fs.statSync(output).size + ' bytes.');
} finally {
  fs.rmSync(temp, { recursive: true, force: true });
}
