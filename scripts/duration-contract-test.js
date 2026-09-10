'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const root = path.resolve(process.env.RENDERER2_TEST_ROOT || path.join(__dirname, '..'));
const { sourceDuration } = require(path.join(root, 'deck-timing'));
for (const [html, expected] of [
  ['<div data-cde-stage data-duration="49.065"></div><script>const duration=99</script>',49.065],
  ["<section data-cde-stage='1' data-duration='2.125'></section>",2.125],
  ['<div data-om-exportable-video-with-duration-secs=2.125></div>',2.125],
  ['<!-- <div data-cde-stage data-duration="99"> --><script>this.duration=2.125;</script>',2.125],
  ['<div data-cde-stage data-duration="Infinity"></div>',0],
  ['<div data-cde-stage data-duration="-1"></div>',0],
]) assert.equal(sourceDuration(html), expected);

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'renderer2-duration-'));
for (const worker of ['capture-deck2.js', 'capture-deck2-vt.js']) {
  for (const mode of ['stage','om','runtime','legacy','override']) {
    const out = path.join(dir, worker + '-' + mode);fs.mkdirSync(out);
    const attr = mode==='stage'||mode==='override' ? 'data-cde-stage data-duration="0.6"'
      : mode==='om' ? 'data-om-exportable-video-with-duration-secs="0.6"' : '';
    const script = mode==='runtime' ? 'const DUR=0.6;window.__DECK__={duration:DUR};' : mode==='legacy'?'const duration=0.6;':'';
    const deck=path.join(out,'fixture.html');
    fs.writeFileSync(deck,`<!doctype html><style>body{margin:0}.stage{width:640px;height:360px;background:#123}</style><div class="stage" ${attr}>Duration</div><script>const BOUNDS=[0];${script}</script>`);
    const env={...process.env,FPS:'10',NOAUDIO:'1',SHARDS:'1',SHARD:'0',FRAMES_DIR:out,FORMAT:'jpeg',PORT:'8959',WARMUP_MS:'50',DURATION:''};
    if(mode==='override')env.DURATION='0.4';
    const result=spawnSync(process.execPath,[path.join(root,worker),deck],{encoding:'utf8',timeout:90000,env});
    assert.equal(result.status,0,result.stdout+result.stderr);
    assert.equal(fs.readdirSync(out).filter(f=>/\.(jpg|png)$/.test(f)).length,mode==='override'?4:6,result.stdout);
    console.log('PASS',worker,mode);
  }
}
console.log('Evidence:',dir);
