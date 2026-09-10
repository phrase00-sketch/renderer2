'use strict';
// Real Chromium regression: explicit hooks, independent cue clocks, legacy slider/CSS.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'renderer2-render-at-'));
for (const mode of (process.env.TEST_MODE ? [process.env.TEST_MODE] : ['deck-hook', 'window-hook', 'slider', 'css', 'absolute-css', 'renamed-overlays', 'declared-absolute','static-xdc', 'declared-relative', 'media-starts'])) {
  const dir = path.join(root, mode);
  fs.mkdirSync(dir);
  const hook = mode.endsWith('hook');
  let html = `<!doctype html><style>
    body{margin:0} .stage{width:640px;height:360px;background:#123}
    #box{width:100px;height:100px;background:#fc0;animation:move 2s linear both}
    @keyframes move{to{transform:translateX(300px)}}
    </style><div id="dc-root"><div class="stage"><div id="first" data-screen-label="scene"><div id="box"></div></div></div></div>
    ${mode === 'slider' ? '<input type="range" min="0" max="1" step="0.01">' : ''}
    <script>
    // BOUNDS=${mode === 'css' ? '[0]' : '[0,0.5]'} duration=1
    window.React={}; window.ReactDOM={};
    function seek(t){
      document.querySelector('[data-screen-label]').id=t>=0.5?'second':'first';
      for(const a of document.getAnimations()){a.pause();a.currentTime=(t>=0.75?t-0.75:t)*1000;}
    }
    ${mode === 'deck-hook' ? "window.__DECK__={tag:42,renderAt(t){if(this.tag!==42)throw Error('lost receiver');seek(t)}};window.renderAt=()=>{throw Error('wrong priority')};" : ''}
    ${mode === 'window-hook' ? 'window.renderAt=async(t)=>{await Promise.resolve();seek(t)};' : ''}
    ${mode === 'slider' ? "document.querySelector('input').addEventListener('input',e=>seek(+e.target.value));" : ''}
    </script>`;
  if (['absolute-css','renamed-overlays','declared-absolute','static-xdc','declared-relative','media-starts'].includes(mode)) html = `<!doctype html><style>
    .stage{width:640px;height:360px;position:relative}section{position:absolute;inset:0;opacity:0;animation:on .5s linear forwards;animation-delay:var(--t0)}@keyframes on{0%,99.99%{opacity:1}100%{opacity:0}}</style>
    <div id="dc-root"><div class="stage" data-cde-stage data-render-mode="css" data-bounds="[0,0.5]"><section id="first" data-screen-label="first" style="--t0:0s;background:red"></section><section id="second" data-screen-label="second" style="--t0:.5s;background:blue"></section></div></div>
    <script>window.React={};window.ReactDOM={}; // BOUNDS=[0,0.5] duration=1
    </script>`;
  if(mode==='renamed-overlays')html=html.replaceAll('--t0','--s').replace('</div></div>','<aside>Overlay</aside></div></div>');
  if(mode==='static-xdc')html=html.replace('window.React={};window.ReactDOM={};','').replace('<div id="dc-root">','<x-dc>').replace('</div></div>','</div></x-dc>').replaceAll('section','article').replace('data-bounds="[0,0.5]"','data-bounds="[0,0.5]" data-cde-time-mode="absolute"');
  if(mode==='declared-absolute')html=html.replace('data-bounds="[0,0.5]"','data-cde-time-mode="absolute"');
  if(mode==='declared-relative')html=html.replace('data-bounds="[0,0.5]"','data-bounds="[0,0.5]" data-cde-time-mode="scene-relative"');
  if(mode==='media-starts'){
    const made=spawnSync('ffmpeg',['-v','error','-f','lavfi','-i','color=c=red:s=64x64:r=30:d=2','-c:v','libx264','-pix_fmt','yuv420p',path.join(dir,'clip.mp4')],{encoding:'utf8'});
    assert.equal(made.status,0,made.stderr);
    html=html.replace('</section></div></div>',`<video src="clip.mp4" data-t0="0.625" data-vin="0.1" muted preload="auto"></video><div style="animation:on .001s linear .625s forwards"><video src="clip.mp4" data-vin="0.1" muted preload="auto"></video></div></section></div></div>`);
  }
  const deck = path.join(dir, 'fixture.dc.html');
  fs.writeFileSync(deck, html);
  const trace = path.join(dir, 'trace.jsonl');
  const result = spawnSync(process.execPath, [path.join(__dirname, '..', 'capture-deck2.js'), deck], {
    encoding: 'utf8', timeout: 90000,
    env: { ...process.env, FPS: '4', DURATION: '1', BOUNDS: mode === 'css' ? '[0]' : '[0,0.5]',
      NOAUDIO: '1', SHARDS: '1', SHARD: '0', FRAMES_DIR: dir, FORMAT: 'jpeg',
      TRACE_FILE: trace, PORT: '8958' },
  });
  assert.strictEqual(result.status, 0, result.stdout + result.stderr);
  const rows = fs.readFileSync(trace, 'utf8').trim().split('\n').map(JSON.parse);
  assert.strictEqual(rows.length, 4);
  for(const r of rows){
    assert.strictEqual(r.sceneId, ['css','declared-relative'].includes(mode) || r.T < 0.5 ? 'first' : 'second');
    const expected = hook ? (r.T >= 0.75 ? r.T - 0.75 : r.T) * 1000
      : (r.T - (['slider','declared-relative'].includes(mode) && r.T >= 0.5 ? 0.5 : 0)) * 1000;
    if(mode==='media-starts')for(const v of r.videos)assert(Math.abs(v.currentTime-(.1+Math.max(0,r.T-.625)))<.002,JSON.stringify(v));
    assert(Math.abs(r.animationMaxMs - expected) < 1, `${mode}: ${JSON.stringify(r)} expected ${expected}`);
  }
  console.log('PASS', mode);
}
console.log('Evidence:', root);
