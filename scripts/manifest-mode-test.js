'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const root = path.resolve(__dirname, '..');
const exportScript = path.join(root, 'scripts', 'windows', 'export.ps1');
const source = fs.readFileSync(exportScript, 'utf8');
const helperStart = source.indexOf('function Show-Error');
const helperEndMatch = /\r?\ntry \{\r?\n  Assert-Command/.exec(source.slice(helperStart));
assert(helperStart >= 0 && helperEndMatch, 'Could not isolate Windows launcher helpers');
const helpers = source.slice(helperStart, helperStart + helperEndMatch.index);

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'renderer2-manifest-mode-'));
try {
  const fixture = path.join(temp, 'fixture');
  fs.mkdirSync(path.join(fixture, 'src'), { recursive: true });
  fs.writeFileSync(path.join(fixture, 'deck.dc.html'), '<!doctype html><html><body><div style="width:640px;height:360px">module deck</div></body></html>');
  fs.writeFileSync(path.join(fixture, 'src', 'stage.mjs'), "canvas.getContext('webgl2');");
  fs.writeFileSync(path.join(fixture, 'manifest.json'), JSON.stringify({
    generator: 'CDE2',
    manifestVersion: 1,
    deck: 'deck.dc.html',
    renderMode: 'vt',
  }));

  const zip = path.join(temp, 'fixture.zip');
  const makeZip = spawnSync('powershell.exe', [
    '-NoProfile', '-Command',
    `Compress-Archive -Path '${fixture.replaceAll("'", "''")}\\*' -DestinationPath '${zip.replaceAll("'", "''")}' -Force`,
  ], { encoding: 'utf8' });
  assert.strictEqual(makeZip.status, 0, makeZip.stderr || makeZip.stdout);

  const harness = path.join(temp, 'harness.ps1');
  const escapedRoot = root.replaceAll("'", "''");
  const escapedTemp = path.join(temp, 'extract').replaceAll("'", "''");
  const escapedZip = zip.replaceAll("'", "''");
  fs.mkdirSync(path.join(temp, 'extract'), { recursive: true });
  fs.writeFileSync(harness, '\uFEFF' + [
    "$ErrorActionPreference = 'Stop'",
    `Add-Type -AssemblyName System.Windows.Forms | Out-Null`,
    `$repoRoot = '${escapedRoot}'`,
    `$tempRoot = '${escapedTemp}'`,
    helpers,
    `$resolved = Resolve-Deck '${escapedZip}'`,
    `if ($resolved.RenderMode -ne 'vt') { throw 'manifest renderMode was not preserved' }`,
    `if (-not (Test-Path -LiteralPath $resolved.Deck)) { throw 'manifest deck was not resolved' }`,
    `Remove-SafeTemp $resolved.Temp`,
  ].join('\r\n'), 'utf8');

  const result = spawnSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', harness], { encoding: 'utf8' });
  assert.strictEqual(result.status, 0, result.stderr || result.stdout);
  console.log('Manifest renderMode test passed.');
} finally {
  fs.rmSync(temp, { recursive: true, force: true });
}
