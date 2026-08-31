// RENDERER2 capture v4.14 OSS (virtual-time VT worker)
// - v4.14 OSS: WebGLの初回boot失敗とcontext未生成をready契約＋後方互換ガードで検出する。
// - v4.13 OSS: WebGLコンテキスト喪失を検出し、黒いJPEGを成功扱いせず段階再試行へ返す。
// - v4.12 OSS: 最初のフレームが出ないワーカーの起動監視と、段階別の性能計測を追加。
// - v4.11 OSS: ローカル配信用のパス境界検証と入力ファイル検証を追加。
// - v4.10: <video data-vin="秒"> をCDE2と同じ意味の素材開始位置として反映（2026-08-04）
// - v4.9: デッキが uploads/○○_指示一式/ の下にあるCDE2 ZIPでROOTをZIPルートまで遡上（2026-08-01）
// - v4.7.1: シーク完了待ちの保険ポーリング上限を 1000ms→3000ms に延長（長GOP素材対応）（2026-07-17）
// - v4.7: デッキ側JSが同じフレームで先に <video> のシークを始めている場合、currentTime は
//         「シーク先」を返すため pending=0 と誤判し、ポーリング待ちをスキップしていた。
//         シーク進行中（v.seeking）も pending に数えて待つよう修正（2026-07-17）
// - v4.6: 時計ブリッジ有効時、rAFコールバックのタイムスタンプ引数と document.timeline.currentTime も
//         凍結クロック（手動performance.now時計）へ統一。仮想時間クロックとブリッジ時計の
//         二重時計で自走プレイヤーが暴走する問題を修正（2026-07-15）
// - v4.5: スライダーを持たないCDE2デッキも、手動performance.now時計で
//         シーン選択・CSS/WAAPI・<video>を同じシーン相対時刻へ同期
// - v4.5: class field形式の duration = ... を正しく抽出
// - v4.3: ステージ寸法の自動検出（1920×1080固定を撤廃。1080×1920などの縦・任意サイズのデッキに対応）
// ---------------------------------------------------------------------------
// PURPOSE
//   Capture a multi-scene Claude Design deck (.dc.html) using the CDP
//   virtual-time clock, so that requestAnimationFrame / <canvas> / WebGL /
//   setTimeout based animations render DETERMINISTICALLY per frame. This is the
//   "new expression" production path. The classic capture-deck2.js uses the
//   getAnimations()-seek method (CSS / WAAPI only) and stays as the fast path
//   for decks that do not use new expressions.
//
// HOW IT WORKS (key differences vs capture-deck2.js)
//   1. The whole page is loaded UNDER virtual time (Page.navigate + advance),
//      never page.goto, so the page clock is fully controlled with no
//      real-time contamination (page.goto's load wait deadlocks a paused clock).
//   2. Scene selection is still driven by writing the deck's slider each frame
//      (audio-synced autoplay does not advance under virtual time).
//   3. The virtual clock is advanced by exactly one frame (1000/FPS ms) per
//      output frame. A scene's rAF/canvas animation anchors its t0 at the
//      virtual instant it MOUNTS (when the slider crosses its boundary), so
//      after N advanced frames its elapsed == N*frameMs == the desired
//      in-scene elapsed. Scene-boundary crossings are handled automatically by
//      the per-frame slider write (React remounts the scene fresh).
//   4. Scene 0 is special: it mounts during boot warmup, so its clock is
//      already contaminated. Before the capture loop we TOGGLE the slider to a
//      different scene and back, forcing a fresh remount so its t0 re-anchors.
//
// SHARDING (parallel)
//   capture-parallel.js launches CONC copies with SHARDS/SHARD/FRAMES_DIR.
//   Because each scene anchors independently at mount, a shard whose range
//   starts mid-deck only needs to (a) toggle to mount its first scene fresh and
//   (b) warm-step from that scene's start frame up to startF (no screenshot).
//   Warmup is therefore bounded by ONE scene length, not the whole deck.
//
//   Usage (single process):  node capture-deck2-vt.js "deck.dc.html"
//   env: FPS=30 DURATION=sec BOUNDS="[...]" CRF=16 FORMAT=png|jpeg JPEG_Q=92
//        PRESET= PORT=8753 NOAUDIO=1 OUT=deck.mp4 AUDIO=path
//        (sharded, set by orchestrator) SHARDS, SHARD, FRAMES_DIR
//        WARMUP_MS=4000  BOOT_MS=60000  (tuning knobs)

const fs = require('fs');
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');
const puppeteer = require('puppeteer');

let DECK = process.argv[2];
if (!DECK) {
  const here = fs.readdirSync(process.cwd()).filter(f => /\.dc\.html$/i.test(f));
  if (here.length === 1) { DECK = here[0]; console.log('deck auto-detected:', DECK); }
  else if (here.length === 0) { console.error('このフォルダに .dc.html が見つかりません。'); process.exit(1); }
  else { console.error('.dc.html が複数あります。引数で指定してください:\n  ' + here.join('\n  ')); process.exit(1); }
}
const DECK_ABS = path.resolve(DECK);
if (!fs.existsSync(DECK_ABS) || !fs.statSync(DECK_ABS).isFile()) {
  console.error('デッキが見つかりません: ' + DECK_ABS);
  process.exit(1);
}
// v4.9: CDE2のZIPは support.js / _ds / assets / audio / manifest.json を「ZIPルート側」に置き、
// デッキ本体だけが uploads/○○_指示一式/ の下に入っていることがある（編集用にアップした
// 指示フォルダごと再梱包されるため）。ROOTをデッキの隣に取ると support.js も _ds も assets も
// 404 になり、Reactが載らずBOOT失敗＝0フレームで終わる（2026-08-01 実事故）。
// デッキの隣に support.js が無いときは、support.js と manifest.json が揃う祖先まで4段遡る。
function resolveDeckRoot(deckAbs) {
  const start = path.dirname(deckAbs);
  if (fs.existsSync(path.join(start, 'support.js'))) return start;
  let d = start;
  for (let i = 0; i < 4; i++) {
    const p = path.dirname(d);
    if (!p || p === d) break;
    d = p;
    if (fs.existsSync(path.join(d, 'support.js')) && fs.existsSync(path.join(d, 'manifest.json'))) return d;
  }
  return start;
}
const ROOT = resolveDeckRoot(DECK_ABS);
if (ROOT !== path.dirname(DECK_ABS)) console.log('ROOT hoisted ->', ROOT, '(デッキは配下の uploads/... にあります)');
const FILE = path.basename(DECK_ABS);
const NFC = (s) => { try { return s.normalize('NFC'); } catch (e) { return s; } };

const FPS = Number(process.env.FPS || 30);
const CRF = String(process.env.CRF || 16);
const FORMAT = (process.env.FORMAT || 'jpeg').toLowerCase();
const JPEG_Q = Number(process.env.JPEG_Q || 92);
const PRESET = process.env.PRESET || '';
const SHARDS = Math.max(1, Number(process.env.SHARDS || 1));
const SHARD = Math.max(0, Number(process.env.SHARD || 0));
const FRAMES_DIR = process.env.FRAMES_DIR || '';
const PORT = Number(process.env.PORT || 8753);
const OUT = process.env.OUT || 'deck.mp4';
const NOAUDIO = process.env.NOAUDIO === '1';
const TRACE_TEMPLATE = process.env.TRACE_FILE || '';
const TRACE_FILE = TRACE_TEMPLATE ? TRACE_TEMPLATE.replace('{shard}', String(SHARD)) : '';
const WARMUP_MS = Number(process.env.WARMUP_MS || 4000);
const BOOT_MS = Number(process.env.BOOT_MS || 60000);
const frameMs = 1000 / FPS;
const MAXSEC = Number(process.env.MAXSEC || 0); // >0なら先頭N秒だけ書き出し（検証用の時短ラン）
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
function boundedTimeoutFromEnv(name, fallback) {
  const raw = process.env[name];
  const value = Number(raw == null || String(raw).trim() === '' ? fallback : raw);
  if (!Number.isFinite(value) || value < 0 || value > 900000) {
    throw new Error(name + ' must be a number between 0 and 900000 milliseconds');
  }
  return Math.floor(value);
}
const STARTUP_STALL_TIMEOUT = boundedTimeoutFromEnv('STARTUP_STALL_TIMEOUT', 0);
const WEBGL_CONTEXT_GUARD = process.env.WEBGL_CONTEXT_GUARD === '1';
const WEBGL_READY_TIMEOUT = boundedTimeoutFromEnv('WEBGL_READY_TIMEOUT', 15000);
let activeBrowser = null;
let activeServer = null;
let startupGuard = null;

function disarmStartupGuard() {
  if (startupGuard) clearTimeout(startupGuard);
  startupGuard = null;
}

function armStartupGuard() {
  if (!(STARTUP_STALL_TIMEOUT > 0)) return;
  startupGuard = setTimeout(async () => {
    startupGuard = null;
    console.error('\n[VT] STARTUP_STALL: no first frame after ' + STARTUP_STALL_TIMEOUT + 'ms; retrying with lower concurrency.');
    const hardExit = setTimeout(() => process.exit(124), 2500);
    try { if (activeBrowser) await activeBrowser.close(); } catch (e) {}
    try { if (activeServer) activeServer.close(); } catch (e) {}
    clearTimeout(hardExit);
    process.exit(124);
  }, STARTUP_STALL_TIMEOUT);
}

// --- BOUNDS: env > デッキhtmlから正規抽出 > デフォルト ---
const htmlText = fs.readFileSync(DECK_ABS, 'utf8');
let BOUNDS;
if (process.env.BOUNDS) {
  BOUNDS = JSON.parse(process.env.BOUNDS);
} else {
  const m = htmlText.match(/BOUNDS\s*=\s*(\[[^\]]*\])/);
  BOUNDS = m ? JSON.parse(m[1]) : [0];
}
const md = htmlText.match(/\bduration\s*=\s*([0-9]+(?:\.[0-9]+)?)/);
const HTML_DURATION = md ? Number(md[1]) : 0;
const HAS_TIMELINE = BOUNDS.length > 1;
const USE_CLOCK_BRIDGE = HAS_TIMELINE && /\bperformance\.now\s*\(/.test(htmlText);
const EXPECTS_DC_RUNTIME = /id\s*=\s*["']dc-root["']|<x-dc\b|\bsupport\.js\b|\bReactDOM\b|\bcreateRoot\s*\(/i.test(htmlText);
console.log('[VT] BOUNDS', JSON.stringify(BOUNDS), '(' + BOUNDS.length + ' scenes)');
if (HTML_DURATION) console.log('[VT] HTML duration', HTML_DURATION);
if (USE_CLOCK_BRIDGE) console.log('[VT] CLOCK deterministic performance.now bridge enabled');

// --- ファイル basename 索引（NFC正規化でサブフォルダも拾う） ---
const indexByName = {};
const wavFiles = [];
(function walk(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name === 'node_modules' || e.name === '_frames_tmp') continue;
    const fp = path.join(dir, e.name);
    if (e.isDirectory()) walk(fp);
    else {
      const key = NFC(e.name);
      if (!(key in indexByName)) indexByName[key] = fp;
      if (/\.wav$/i.test(e.name)) wavFiles.push(fp);
    }
  }
})(ROOT);

function resolveReq(p) {
  const rootReal = fs.realpathSync(ROOT);
  const direct = path.resolve(rootReal, String(p).replace(/^[/\\]+/, ''));
  const inside = (candidate) => {
    const rel = path.relative(rootReal, candidate);
    return rel === '' || (!rel.startsWith('..' + path.sep) && rel !== '..' && !path.isAbsolute(rel));
  };
  if (inside(direct) && fs.existsSync(direct) && !fs.statSync(direct).isDirectory()) {
    const real = fs.realpathSync(direct);
    if (inside(real)) return real;
  }
  const base = NFC(path.basename(p));
  if (indexByName[base]) {
    const real = fs.realpathSync(indexByName[base]);
    if (inside(real)) return real;
  }
  return null;
}

// --- 音声解決（シングルプロセス時のみ合成；シャード時は親が合成） ---
let AUDIO = null;
if (!NOAUDIO) {
  if (process.env.AUDIO) {
    AUDIO = path.resolve(process.env.AUDIO);
  } else {
    // CDE2のRENDERER2用ZIPはデッキが export/ 配下、manifest.json / .dc-audio.json / audio/ が
    // ZIPルート側にある。デッキのフォルダ(ROOT)だけでなく親フォルダも2段まで探す。
    const audioDirs = [ROOT];
    let _d = ROOT;
    for (let _k = 0; _k < 2; _k++) { const _p = path.dirname(_d); if (!_p || _p === _d) break; audioDirs.push(_p); _d = _p; }
    for (const dir of audioDirs) {
      const defs = [
        { file: 'manifest.json', pick: function (o) { return o && o.audio; } },
        { file: '.dc-audio.json', pick: function (o) { return o && o.path; } },
      ];
      for (const def of defs) {
        const fp = path.join(dir, def.file);
        if (!fs.existsSync(fp)) continue;
        try {
          const rel = def.pick(JSON.parse(fs.readFileSync(fp, 'utf8')));
          if (!rel) continue;
          const cand = path.join(dir, String(rel));
          if (fs.existsSync(cand)) { AUDIO = cand; break; }
          const byName = indexByName[NFC(path.basename(String(rel)))];
          if (byName) { AUDIO = byName; break; }
        } catch (e) {}
      }
      if (AUDIO) break;
      const ad = path.join(dir, 'audio');
      if (fs.existsSync(ad) && fs.statSync(ad).isDirectory()) {
        const w = fs.readdirSync(ad).filter(function (f) { return /\.(wav|mp3|m4a|aac|ogg)$/i.test(f); });
        if (w.length === 1) { AUDIO = path.join(ad, w[0]); break; }
      }
    }
    if (!AUDIO && wavFiles.length === 1) AUDIO = wavFiles[0];
  }
  if (AUDIO && !fs.existsSync(AUDIO)) { console.log('audio not found, skip:', AUDIO); AUDIO = null; }
}
console.log('[VT] audio ->', AUDIO || '(none)');

const MIME = { '.html':'text/html','.js':'text/javascript','.css':'text/css',
  '.json':'application/json','.png':'image/png','.jpg':'image/jpeg','.jpeg':'image/jpeg',
  '.gif':'image/gif','.svg':'image/svg+xml','.webp':'image/webp','.mp4':'video/mp4','.wav':'audio/wav',
  '.woff':'font/woff','.woff2':'font/woff2','.ttf':'font/ttf','.otf':'font/otf' };

function startServer() {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      try {
        let p = decodeURIComponent(req.url.split('?')[0]);
        if (p === '/') p = '/' + FILE;
        const fp = resolveReq(p);
        if (!fp) { res.writeHead(404); res.end('not found'); return; }
        // Range対応（必須）: ブラウザの <video> シークは 206 応答前提。
        // 非対応だと currentTime への明示シークが失敗し、動画が固まる。
        const ctype = MIME[path.extname(fp).toLowerCase()] || 'application/octet-stream';
        const stat = fs.statSync(fp);
        const rm = req.headers.range && /bytes=(\d+)-(\d*)/.exec(req.headers.range);
        if (rm) {
          const start = Number(rm[1]);
          const end = rm[2] ? Math.min(Number(rm[2]), stat.size - 1) : stat.size - 1;
          if (start >= stat.size || start > end) { res.writeHead(416, { 'content-range': 'bytes */' + stat.size }); res.end(); return; }
          res.writeHead(206, { 'content-type': ctype, 'accept-ranges': 'bytes',
            'content-range': 'bytes ' + start + '-' + end + '/' + stat.size, 'content-length': end - start + 1 });
          fs.createReadStream(fp, { start, end }).pipe(res);
        } else {
          res.writeHead(200, { 'content-type': ctype, 'accept-ranges': 'bytes', 'content-length': stat.size });
          fs.createReadStream(fp).pipe(res);
        }
      } catch (e) { res.writeHead(500); res.end(String(e)); }
    });
    server.listen(PORT, '127.0.0.1', () => resolve(server));
  });
}

// scene index for a given time T (deck with slider). Returns last boundary <= T.
function sceneIndexOf(T) {
  let n = 0;
  for (let k = 0; k < BOUNDS.length; k++) if (T >= BOUNDS[k]) n = k;
  return n;
}

(async () => {
  const workerStartedAt = Date.now();
  const server = await startServer();
  activeServer = server;
  armStartupGuard();
  const url = 'http://127.0.0.1:' + PORT + '/' + encodeURIComponent(FILE);
  console.log('[VT] serving', ROOT, '->', url);

  const launchOptions = {
    headless: true,
    // 1枚のスクショが数十秒かかっても耐えるが、無限待ちにはしない
    // （真のハングはエラーで出す）。
    protocolTimeout: Number(process.env.PROTO_TIMEOUT || 90000),
    args: [
      '--force-color-profile=srgb', '--disable-lcd-text',
      // 仮想時間下でスクショが固まる既定問題への対策。
      // 各フレームでコンポジタを最後まで描き切ってから取得させる。
      '--run-all-compositor-stages-before-draw',
      '--disable-new-content-rendering-timeout',
      '--disable-threaded-animation',
      '--disable-threaded-scrolling',
      '--disable-checker-imaging',
      '--disable-image-animation-resync',
    ],
  };
  if (process.env.PUPPETEER_EXECUTABLE_PATH) launchOptions.executablePath = process.env.PUPPETEER_EXECUTABLE_PATH;
  const browser = await puppeteer.launch(launchOptions);
  activeBrowser = browser;
  const page = await browser.newPage();
  const browserReadyAt = Date.now();
  const failed = [];
  page.on('requestfailed', r => failed.push(r.url() + ' :: ' + (r.failure() && r.failure().errorText)));
  page.on('console', m => { if (m.type() === 'error') console.log('[page-error]', m.text()); });
  await page.setViewport({ width: 1920, height: 1160, deviceScaleFactor: 1 });
  await page.evaluateOnNewDocument(() => { try { localStorage.clear(); } catch (e) {} });
  if (WEBGL_CONTEXT_GUARD) {
    await page.evaluateOnNewDocument(() => {
      const nativeGetContext = HTMLCanvasElement.prototype.getContext;
      const contexts = [];
      let lostEvents = 0;
      let contextRequests = 0;
      let nullContexts = 0;
      HTMLCanvasElement.prototype.getContext = function (type, ...args) {
        const kind = String(type || '').toLowerCase();
        const isWebGL = kind === 'webgl' || kind === 'webgl2';
        if (isWebGL) contextRequests++;
        const context = nativeGetContext.call(this, type, ...args);
        if (isWebGL && !context) nullContexts++;
        if (context && (kind === 'webgl' || kind === 'webgl2') && !contexts.includes(context)) {
          contexts.push(context);
          this.addEventListener('webglcontextlost', () => { lostEvents++; });
        }
        return context;
      };
      Object.defineProperty(window, '__renderer2WebGLHealth', {
        configurable: false,
        value: () => ({
          contexts: contexts.length,
          contextRequests,
          nullContexts,
          lostEvents,
          contextLost: contexts.some((context) => {
            try { return context.isContextLost(); } catch (e) { return true; }
          }),
        }),
      });
    });
  }
  if (USE_CLOCK_BRIDGE) {
    // ブート用に仮想時間を進めても、デッキのシーン時計は0秒に留める。
    // 各frameStep直前に出力時刻へ設定するため、シャードごとの実行順に依存しない。
    await page.evaluateOnNewDocument(() => {
      const nativeNow = performance.now.bind(performance);
      const base = nativeNow();
      let rendererMs = 0;
      Object.defineProperty(window, '__rendererSetTime', {
        configurable: false,
        value: (ms) => { rendererMs = Number.isFinite(ms) ? ms : 0; },
      });
      try {
        Object.defineProperty(performance, 'now', {
          configurable: true,
          value: () => base + rendererMs,
        });
      } catch (e) {}
      // v4.6: rAFコールバックのタイムスタンプ引数も凍結クロックへ統一する。
      // performance.now() だけ固定しても rAF引数は実時間のまま流れ続けるため、
      // rAF引数で時を刻む自走プレイヤー（スライダー＋autoplay＋previewLoop型）は
      // シーク再アンカー（凍結時計）と自走ループ（実時間）が別時計になり暴走する（2026-07-15 実事故）。
      try {
        const nativeRaf = window.requestAnimationFrame.bind(window);
        window.requestAnimationFrame = (cb) => nativeRaf(() => cb(performance.now()));
      } catch (e) {}
      // v4.6: document.timeline.currentTime を時間源に選んだデッキも同じ時計に載せる。
      try {
        const tlProto = Object.getPrototypeOf(document.timeline);
        Object.defineProperty(tlProto, 'currentTime', { configurable: true, get: () => performance.now() });
      } catch (e) {}
    });
  }

  // --- virtual-time helper ------------------------------------------------
  const client = await page.target().createCDPSession();
  let onExpired = null;
  client.on('Emulation.virtualTimeBudgetExpired', () => {
    if (onExpired) { const f = onExpired; onExpired = null; f(); }
  });
  function advance(ms) {
    return new Promise(async (res) => {
      onExpired = res;
      await client.send('Emulation.setVirtualTimePolicy', {
        policy: 'advance',
        budget: ms,
        maxVirtualTimeTaskStarvationCount: 1000000,
      });
    });
  }

  // Freeze clock, START navigation (no lifecycle await), boot under virtual time.
  await client.send('Page.enable');
  await client.send('Emulation.setVirtualTimePolicy', { policy: 'pause' });
  const navigationStartedAt = Date.now();
  await client.send('Page.navigate', { url });

  // --- boot detection: advance the clock in chunks; let localhost fetches
  //     settle with brief real sleeps (virtual clock stays put during sleep,
  //     so no page animation progresses, but network/decoding completes). ---
  function bootProbe() {
    const stage = document.querySelector('.stage') || Array.from(document.querySelectorAll('div'))
      .find(d => /^\d+px$/.test(d.style.width) && /^\d+px$/.test(d.style.height) && parseInt(d.style.width) >= 320 && parseInt(d.style.height) >= 320);
    return {
      hasReact: !!window.React, hasReactDOM: !!window.ReactDOM,
      dcRoot: !!document.getElementById('dc-root'),
      sliders: document.querySelectorAll('input[type=range]').length,
      stageOK: !!stage && stage.getBoundingClientRect().width > 100,
      children: stage ? stage.children.length : -1,
    };
  }
  let boot = null, advanced = 0;
  while (advanced < BOOT_MS) {
    await advance(500); advanced += 500;
    await sleep(60); // let pending localhost responses settle (real time)
    boot = await page.evaluate(bootProbe);
    const runtimeReady = !EXPECTS_DC_RUNTIME || (boot.hasReact && boot.hasReactDOM && boot.dcRoot);
    if (boot.stageOK && runtimeReady) break;
  }
  console.log('[VT] BOOT', JSON.stringify(boot));
  if (failed.length) console.log('[VT] FAILED REQUESTS:\n  ' + failed.join('\n  '));

  const hasSlider = !!(boot && boot.sliders > 0);
  const deckLike = hasSlider || HAS_TIMELINE;
  const runtimeReady = boot && (!EXPECTS_DC_RUNTIME || (boot.hasReact && boot.hasReactDOM && boot.dcRoot));
  if (!boot || !boot.stageOK || !runtimeReady) {
    console.error('\n⛔ デッキが起動しませんでした。上の BOOT / FAILED REQUESTS を貼ってください。');
    await browser.close(); server.close(); process.exit(2);
  }
  const bootReadyAt = Date.now();
  console.log('[VT] ✅ 起動OK。');

  // v4.3: ステージ寸法を自動検出してビューポートを合わせる（縦・任意サイズ対応）
  const stageDims = await page.evaluate(() => {
    const st = document.querySelector('.stage') || Array.from(document.querySelectorAll('div'))
      .find(d => /^\d+px$/.test(d.style.width) && /^\d+px$/.test(d.style.height) && parseInt(d.style.width) >= 320 && parseInt(d.style.height) >= 320);
    const r = st ? st.getBoundingClientRect() : { width: 1920, height: 1080 };
    return { w: Math.round(r.width), h: Math.round(r.height) };
  });
  console.log('[VT] STAGE', stageDims.w + 'x' + stageDims.h);
  await page.setViewport({ width: Math.max(stageDims.w, 640), height: stageDims.h + 80, deviceScaleFactor: 1 });

  // 画像・フォントの読み込みを仮想時間＋実時間で十分に待つ
  await advance(WARMUP_MS);
  await sleep(800);
  await advance(WARMUP_MS);
  await sleep(400);
  const warmupReadyAt = Date.now();

  // --- 尺(DURATION): env > slider.max > BOUNDS末尾+6 ---
  let DURATION = Number(process.env.DURATION || HTML_DURATION || 0);
  if (!DURATION && hasSlider) {
    DURATION = await page.evaluate(() => {
      const s = document.querySelector('input[type=range]');
      const m = s && parseFloat(s.max);
      return (m && isFinite(m)) ? m : 0;
    });
  }
  if (!DURATION) DURATION = BOUNDS[BOUNDS.length - 1] + 6;
  console.log('[VT] DURATION', DURATION, 'sec / FPS', FPS, '/ scenes', BOUNDS.length);

  // --- 画像スロットの寸法確定（capture-deck2.js と同一の修正） ---
  await page.addStyleTag({
    content:
      // CDE2は <image-slot> 自身の inline style に width/height を持つ（一律上書きするとレイアウトが崩壊）。
      // 100%拡大は旧構造（x-importラッパー内で寸法を持たないスロット）だけに適用する。
      'image-slot:not([style*="width"]){display:block!important;width:100%!important;height:100%!important}' +
      'image-slot{display:block!important}' +
      'image-slot::part(image){' +
      'position:absolute!important;left:50%!important;top:50%!important;' +
      'width:100%!important;height:100%!important;max-width:none!important;max-height:none!important;' +
      'transform:translate(-50%,-50%)!important;' +
      'object-fit:cover!important;object-position:50% 50%!important}',
  });

  // --- スライダー書き込み（シーン選択）＋プレイヤーUI非表示 ---
  async function setSlider(T) {
    if (!deckLike) return;
    await page.evaluate((T, hasSlider, useClockBridge) => {
      if (useClockBridge && typeof window.__rendererSetTime === 'function') {
        window.__rendererSetTime(T * 1000);
      }
      const sl = document.querySelector('input[type=range]');
      if (!hasSlider || !sl) {
        // no-slider の自走デッキは、シャード先頭で1回だけ rAF を進めても
        // 「state更新→React commit」の2段階が終わらない。現在時刻のsceneを
        // 直接同期commitしてから仮想時間を進め、並列分割位置に依存させない。
        if (useClockBridge) {
          try {
            const host = document.querySelector('#dc-root') && document.querySelector('#dc-root').firstElementChild;
            const key = host && Object.keys(host).find(k => k.startsWith('__reactFiber$'));
            let root = key ? host[key] : null;
            while (root && root.return) root = root.return;
            const stack = root ? [root] : [];
            let logic = null;
            while (stack.length) {
              const f = stack.pop();
              const s = f && f.stateNode;
              if (s && s.logic && Array.isArray(s.logic.BOUNDS)) { logic = s.logic; break; }
              if (f && f.sibling) stack.push(f.sibling);
              if (f && f.child) stack.push(f.child);
            }
            if (logic) {
              if (typeof logic._t0 === 'number') logic._t0 = performance.now() - T * 1000;
              let n = 0; for (let i = 0; i < logic.BOUNDS.length; i++) if (T >= logic.BOUNDS[i]) n = i;
              if (logic.state && logic.state.idx !== n) {
                if (window.ReactDOM && typeof window.ReactDOM.flushSync === 'function') {
                  window.ReactDOM.flushSync(() => logic.setState({ idx: n }));
                } else logic.setState({ idx: n });
              }
            }
          } catch (e) {}
        }
        return;
      }
      const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(sl), 'value').set;
      setter.call(sl, String(T));
      sl.dispatchEvent(new Event('input', { bubbles: true }));
      const stageEl = document.querySelector('.stage') || Array.from(document.querySelectorAll('div'))
        .find(d => /^\d+px$/.test(d.style.width) && /^\d+px$/.test(d.style.height) && parseInt(d.style.width) >= 320 && parseInt(d.style.height) >= 320);
      if (stageEl) {
        let bar = sl;
        while (bar.parentElement && !bar.parentElement.contains(stageEl)) bar = bar.parentElement;
        if (bar && bar !== document.body && !bar.contains(stageEl)) {
          bar.style.setProperty('visibility', 'hidden', 'important');
          bar.style.setProperty('opacity', '0', 'important');
        }
        // デッキ組み込みの中央再生ボタンなど、ステージに重なるオーバーレイUIを隠す
        // （RENDERER2は常に「一時停止中」扱いのため再生ゲートが出っぱなしになる）
        const _r = stageEl.getBoundingClientRect();
        const _pts = [
          [_r.left + _r.width / 2, _r.top + _r.height / 2],
          [_r.left + _r.width / 2, _r.top + _r.height * 0.25],
          [_r.left + _r.width / 2, _r.top + _r.height * 0.75],
        ];
        for (const _pt of _pts) {
          for (const _e of document.elementsFromPoint(_pt[0], _pt[1])) {
            if (_e === stageEl || stageEl.contains(_e) || _e.contains(stageEl)) continue;
            _e.style.setProperty('visibility', 'hidden', 'important');
          }
        }
      }
    }, T, hasSlider, USE_CLOCK_BRIDGE);
  }

  // CSS/WAAPI アニメを「シーン相対時刻」へ明示シーク＆一時停止する。
  // これは既知の正常方式（capture-deck2.js）と同一の処理。
  // 仮想時間の自由再生だけだと、デッキ全体の単一タイムライン設計で
  // 起動・ウォームアップのクロックオフセットがタイミングズレ（速すぎ）になるため。
  // （rAF/canvas/WebGL/setTimeout などの新表現は getAnimations に含まれず、advance で進む）
  async function freezeCssAnims(T) {
    await page.evaluate((T, BOUNDS, hasSlider) => {
      let el;
      if (hasSlider) { let n = 0; for (let k = 0; k < BOUNDS.length; k++) if (T >= BOUNDS[k]) n = k; el = (T - BOUNDS[n]) * 1000; }
      else { el = T * 1000; }
      for (const a of document.getAnimations()) { try { a.pause(); a.currentTime = el; } catch (e) {} }
    }, T, BOUNDS, deckLike);
  }

  // --- <video> 同期（早送りループ対策） ---
  // <video> のメディアクロックは仮想時間にも getAnimations() にも乗らず、実時間で自走する
  // （＝コマ撮りでは出力上の早送りになり、loop属性で周回する）。
  // 毎フレーム、一時停止してシーン相対時刻へ明示シークする。
  // 注意: このワーカーはページ内タイマーが仮想時間下にあるため、seek完了待ちは
  // ページ内 setTimeout ではなく Node 側の実時間ポーリングで行う（仮想時間停止中でも
  // メディアのデコード・seek完了は実時間で進む）。
  async function syncVideos(T) {
    await page.evaluate(() => {
      for (const v of document.querySelectorAll('video')) {
        try {
          if (!v.paused) v.pause();
          if (v.preload !== 'auto') v.preload = 'auto';
        } catch (e) {}
      }
    });
    // シャード先頭が動画sceneの場合も、metadataが来るまで実時間で短く待つ。
    const tm = Date.now();
    while (Date.now() - tm < 1200) {
      const loading = await page.evaluate(() => Array.from(document.querySelectorAll('video'))
        .some(v => !isFinite(v.duration) || v.duration <= 0));
      if (!loading) break;
      // メディアイベントは仮想時計を完全停止すると配送されないことがある。
      // 1msだけ進めてmetadataを反映する（scene時計は別ブリッジで固定済み）。
      await advance(1);
      await sleep(15);
    }
    const pending = await page.evaluate((T, BOUNDS, hasSlider) => {
      let el;
      if (hasSlider) { let n = 0; for (let k = 0; k < BOUNDS.length; k++) if (T >= BOUNDS[k]) n = k; el = T - BOUNDS[n]; }
      else { el = T; }
      let seeking = 0;
      for (const v of document.querySelectorAll('video')) {
        try {
          if (!v.paused) v.pause();
          if (v.preload !== 'auto') v.preload = 'auto';
          const dur = v.duration;
          if (!isFinite(dur) || dur <= 0) continue; // メタデータ未着はスキップ（次フレームで追いつく）
          const vin = Math.max(0, parseFloat(v.getAttribute('data-vin') || '0') || 0);
          const hi = Math.max(vin, dur - 0.05);
          const span = Math.max(0.001, dur - vin);
          const target = v.loop ? vin + (el % span) : Math.max(vin, Math.min(vin + el, hi));
          // v4.7: デッキ側JSが先にシークを始めていると currentTime は「シーク先」を返すため、
          // 差がなくても v.seeking なら pending に数えてポーリング待ちに乗せる。
          if (Math.abs((v.currentTime || 0) - target) > 0.0005) { v.currentTime = target; seeking++; }
          else if (v.seeking) { seeking++; }
        } catch (e) {}
      }
      return seeking;
    }, T, BOUNDS, deckLike);
    if (pending) {
      const t0 = Date.now();
      while (Date.now() - t0 < 3000) { // 保険つき実時間ポーリング（v4.7.1: 長GOPシーク対応で1000→3000ms）
        const busy = await page.evaluate(() => {
          let n = 0;
          for (const v of document.querySelectorAll('video')) { if (v.seeking) n++; }
          return n;
        });
        if (!busy) break;
        await advance(1);
        await sleep(15);
      }
    }
    await page.evaluate(() => {
      // 新規マウント直後の autoplay が seek 完了後に再発火する場合があるため、撮影直前に再停止する。
      for (const v of document.querySelectorAll('video')) { try { if (!v.paused) v.pause(); } catch (e) {} }
    });
  }

  async function readWebGLSnapshot() {
    return page.evaluate(() => {
      const health = typeof window.__renderer2WebGLHealth === 'function'
        ? window.__renderer2WebGLHealth()
        : { contexts: 0, contextRequests: 0, nullContexts: 0, lostEvents: 0, contextLost: false };
      let status = null;
      try {
        const raw = window.__RENDERER2_STATUS__;
        if (raw && typeof raw === 'object') {
          const err = raw.error && typeof raw.error === 'object' ? raw.error : null;
          status = {
            version: Number(raw.version) || 0,
            kind: String(raw.kind || ''),
            state: String(raw.state || ''),
            frameSerial: Number(raw.frameSerial) || 0,
            lastRenderedTime: Number.isFinite(Number(raw.lastRenderedTime)) ? Number(raw.lastRenderedTime) : null,
            error: err ? {
              name: String(err.name || 'Error'),
              message: String(err.message || ''),
              stack: String(err.stack || '').slice(0, 2000),
            } : (raw.error == null ? null : { name: 'Error', message: String(raw.error), stack: '' }),
          };
        }
      } catch (error) {
        status = { version: 0, kind: 'webgl', state: 'error', frameSerial: 0,
          lastRenderedTime: null, error: { name: 'StatusReadError', message: String(error), stack: '' } };
      }
      return { health, status };
    });
  }

  function assertWebGLNotFailed(snapshot) {
    const health = snapshot.health || {};
    const status = snapshot.status;
    if (health.contextLost || health.lostEvents > 0) {
      throw new Error('WEBGL_CONTEXT_LOST contexts=' + (health.contexts || 0)
        + ' events=' + (health.lostEvents || 0));
    }
    if (status && status.kind === 'webgl') {
      if (status.version < 1 || !['booting', 'ready', 'error'].includes(status.state)) {
        throw new Error('WEBGL_STATUS_INVALID ' + JSON.stringify(status));
      }
      if (status.state === 'error') {
        throw new Error('WEBGL_BOOT_ERROR ' + JSON.stringify(status.error || {}));
      }
      if (status.state === 'ready' && !(health.contexts > 0)) {
        throw new Error('WEBGL_NOT_INITIALIZED contexts=0 status=ready');
      }
      if (status.state === 'ready' && !(status.frameSerial > 0)) {
        throw new Error('WEBGL_NOT_RENDERED frameSerial=' + status.frameSerial);
      }
    }
  }

  async function waitForWebGLReady(T) {
    const started = Date.now();
    let snapshot = null;
    while (true) {
      snapshot = await readWebGLSnapshot();
      assertWebGLNotFailed(snapshot);
      const health = snapshot.health || {};
      const status = snapshot.status;
      if (status && status.kind === 'webgl' && status.state === 'ready') {
        console.log('[VT] WEBGL READY contract=v' + status.version + ' contexts=' + health.contexts
          + ' frameSerial=' + status.frameSerial);
        return;
      }
      if ((!status || status.kind !== 'webgl') && health.contexts > 0) {
        console.log('[VT] WEBGL READY legacy contexts=' + health.contexts);
        return;
      }
      if (Date.now() - started >= WEBGL_READY_TIMEOUT) {
        throw new Error('WEBGL_NOT_INITIALIZED contexts=' + (health.contexts || 0)
          + ' requests=' + (health.contextRequests || 0)
          + ' null=' + (health.nullContexts || 0)
          + ' status=' + (status ? status.state || 'invalid' : 'absent')
          + ' timeout=' + WEBGL_READY_TIMEOUT + 'ms');
      }
      await setSlider(T);
      await advance(Math.max(1, Math.min(frameMs, 50)));
      await sleep(25);
    }
  }

  // one frame step: position slider for time T, advance the clock 1 frame so
  // React commits + rAF/canvas/timers fire, then pin CSS/WAAPI anims to the
  // exact scene-relative time (same as the known-good getAnimations method).
  async function frameStep(T) {
    await setSlider(T);
    await advance(frameMs);
    await freezeCssAnims(T);
    await syncVideos(T);
    if (WEBGL_CONTEXT_GUARD) {
      assertWebGLNotFailed(await readWebGLSnapshot());
    }
  }

  // stage 位置（撮影クリップ）
  await frameStep(0);
  if (WEBGL_CONTEXT_GUARD) await waitForWebGLReady(0);
  const rect = await page.evaluate(() => {
    const st = document.querySelector('.stage') || Array.from(document.querySelectorAll('div'))
      .find(d => /^\d+px$/.test(d.style.width) && /^\d+px$/.test(d.style.height) && parseInt(d.style.width) >= 320 && parseInt(d.style.height) >= 320);
    const r = st.getBoundingClientRect();
    return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) };
  });

  let total = Math.round(DURATION * FPS);
  if (MAXSEC > 0) { total = Math.min(total, Math.ceil(MAXSEC * FPS)); console.log('[VT] MAXSEC=' + MAXSEC + ' -> 先頭 ' + total + ' フレームのみ書き出し'); }
  const ext = FORMAT === 'jpeg' ? 'jpg' : 'png';
  const shotType = FORMAT === 'jpeg' ? 'jpeg' : 'png';
  const startF = FRAMES_DIR ? Math.floor(total * SHARD / SHARDS) : 0;
  const endF = FRAMES_DIR ? Math.floor(total * (SHARD + 1) / SHARDS) : total;
  if (TRACE_FILE) {
    fs.mkdirSync(path.dirname(path.resolve(TRACE_FILE)), { recursive: true });
    fs.writeFileSync(TRACE_FILE, '');
  }
  if (FRAMES_DIR) console.log('[VT] shard ' + SHARD + '/' + SHARDS + ' frames [' + startF + ',' + endF + ')');

  // --- ffmpeg sink: シングルプロセスはパイプ(+音声)、シャードはファイル書き出し ---
  let ff = null, ffClosed = false;
  if (FRAMES_DIR) {
    fs.mkdirSync(FRAMES_DIR, { recursive: true });
  } else {
    const ffArgs = ['-y', '-f', 'image2pipe', '-framerate', String(FPS), '-i', 'pipe:0'];
    if (AUDIO) ffArgs.push('-i', AUDIO);
    ffArgs.push('-vf', 'scale=trunc(iw/2)*2:trunc(ih/2)*2');
    ffArgs.push('-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-crf', CRF);
    if (PRESET) ffArgs.push('-preset', PRESET);
    if (AUDIO) ffArgs.push('-c:a', 'aac', '-b:a', '192k', '-shortest');
    ffArgs.push(OUT);
    ff = spawn('ffmpeg', ffArgs, { stdio: ['pipe', 'inherit', 'inherit'] });
    ff.stdin.setMaxListeners(0);
    ff.stdin.on('error', () => {});
    ff.on('close', () => { ffClosed = true; });
  }

  // --- re-anchor: scene 0 mounted during boot (clock contaminated). Toggle to
  //     a different scene so the first captured scene remounts fresh. ---
  async function reanchorBefore(frameIndex) {
    if (!deckLike) return;
    const sIdx = sceneIndexOf(frameIndex / FPS);
    // pick a different scene to force unmount of the target scene
    let otherT;
    if (BOUNDS.length <= 1) otherT = DURATION; // single scene: jump to end then back
    else if (sIdx > 0) otherT = BOUNDS[sIdx - 1];
    else otherT = BOUNDS[1];
    await frameStep(otherT);
  }

  // --- shard warmup: mount the shard's first scene fresh, then warm-step from
  //     that scene's start frame up to startF (no screenshot). Bounded by one
  //     scene length. ---
  const preRollStartedAt = Date.now();
  let preRollFrames = 0;
  if (startF > 0) {
    await reanchorBefore(startF);
    const sIdx = deckLike ? sceneIndexOf(startF / FPS) : 0;
    const sceneStartFrame = deckLike ? Math.round(BOUNDS[sIdx] * FPS) : 0;
    preRollFrames = Math.max(0, startF - Math.max(0, sceneStartFrame));
    for (let j = Math.max(0, sceneStartFrame); j < startF; j++) {
      await frameStep(j / FPS);
    }
  } else {
    await reanchorBefore(0);
  }
  const preRollReadyAt = Date.now();

  // --- capture loop ---
  let tStep = 0, tShot = 0, tWrite = 0; const tStart = Date.now();
  for (let i = startF; i < endF; i++) {
    const _e0 = Date.now();
    await frameStep(i / FPS); // boundary crossings remount scenes fresh automatically
    tStep += Date.now() - _e0;

    if (TRACE_FILE) {
      const trace = await page.evaluate((T, BOUNDS) => {
        let n = 0; for (let k = 0; k < BOUNDS.length; k++) if (T >= BOUNDS[k]) n = k;
        const sceneStart = BOUNDS[n] || 0;
        const videos = Array.from(document.querySelectorAll('video')).map(v => {
          const dur = Number(v.duration);
          const rel = T - sceneStart;
          const vin = Math.max(0, parseFloat(v.getAttribute('data-vin') || '0') || 0);
          const hi = Math.max(vin, dur - 0.05);
          const span = Math.max(0.001, dur - vin);
          const target = isFinite(dur) && dur > 0 ? (v.loop ? vin + (rel % span) : Math.max(vin, Math.min(vin + rel, hi))) : null;
          return { src: decodeURIComponent((v.currentSrc || v.src || '').split('/').pop() || ''), vin, currentTime: v.currentTime, target, duration: dur, paused: v.paused, seeking: v.seeking, readyState: v.readyState };
        });
        const times = document.getAnimations().map(a => Number(a.currentTime)).filter(Number.isFinite);
        const scene = document.querySelector('[data-screen-label]');
        return { T, sceneIndex: n, sceneStart, sceneId: scene ? scene.id : null, animationMinMs: times.length ? Math.min(...times) : null, animationMaxMs: times.length ? Math.max(...times) : null, videos };
      }, i / FPS, BOUNDS);
      fs.appendFileSync(TRACE_FILE, JSON.stringify({ frame: i, ...trace }) + '\n');
    }

    const _s0 = Date.now();
    const buf = await page.screenshot({ type: shotType,
      ...(shotType === 'jpeg' ? { quality: JPEG_Q } : {}),
      captureBeyondViewport: false, // 仮想時間下でのスクショハング回避（clipだけで足りる）
      optimizeForSpeed: true,
      clip: { x: rect.x, y: rect.y, width: (rect.w || 1920) & ~1, height: (rect.h || 1080) & ~1 } });
    tShot += Date.now() - _s0;

    const _w0 = Date.now();
    if (FRAMES_DIR) {
      fs.writeFileSync(path.join(FRAMES_DIR, 'frame-' + String(i).padStart(6, '0') + '.' + ext), buf);
    } else {
      if (ffClosed || ff.stdin.destroyed || ff.stdin.writableEnded) break;
      if (!ff.stdin.write(buf)) {
        await new Promise(r => { ff.stdin.once('drain', r); ff.stdin.once('error', r); });
      }
    }
    disarmStartupGuard();
    tWrite += Date.now() - _w0;
    if (i % 60 === 0) {
      const _el = (Date.now() - tStart) / 1000;
      const done = i - startF + 1;
      process.stdout.write('\r[VT] ' + i + ' / ' + total + '  capFPS=' + (done / _el).toFixed(2) +
        '  step=' + (tStep / done).toFixed(0) + 'ms shot=' + (tShot / done).toFixed(0) + 'ms write=' + (tWrite / done).toFixed(0) + 'ms   ');
    }
  }

  if (ff) {
    if (!ff.stdin.destroyed && !ff.stdin.writableEnded) ff.stdin.end();
    if (!ffClosed) await new Promise(r => ff.on('close', r));
  }
  disarmStartupGuard();
  await browser.close();
  server.close();
  const _elapsed = (Date.now() - tStart) / 1000;
  const _cap = endF - startF;
  console.log('\n[VT] --- 速度計測 ---');
  console.log('[VT] frames=' + _cap + '  elapsed=' + _elapsed.toFixed(1) + 's  captureFPS=' + (_cap / _elapsed).toFixed(2));
  console.log('[VT] avg/frame: step=' + (tStep / _cap).toFixed(0) + 'ms  screenshot=' + (tShot / _cap).toFixed(0) + 'ms  ' + (FRAMES_DIR ? 'fileWrite=' : 'pipeWrite=') + (tWrite / _cap).toFixed(0) + 'ms');
  console.log('[VT] FORMAT=' + FORMAT + (FORMAT === 'jpeg' ? '(q' + JPEG_Q + ')' : '') + '  PRESET=' + (PRESET || '(default)') + '  CRF=' + CRF);
  console.log('[VT] ' + (FRAMES_DIR ? ('shard ' + SHARD + ' done -> ' + _cap + ' frames') : ('done -> ' + OUT)));
  console.log('RENDERER2_METRICS ' + JSON.stringify({
    shard: SHARD,
    shards: SHARDS,
    startFrame: startF,
    endFrame: endF,
    frames: _cap,
    preRollFrames: preRollFrames,
    launchMs: browserReadyAt - workerStartedAt,
    bootMs: bootReadyAt - navigationStartedAt,
    warmupMs: warmupReadyAt - bootReadyAt,
    preRollMs: preRollReadyAt - preRollStartedAt,
    captureMs: Math.round(_elapsed * 1000),
    totalMs: Date.now() - workerStartedAt,
    avgStepMs: Number((tStep / _cap).toFixed(1)),
    avgScreenshotMs: Number((tShot / _cap).toFixed(1)),
    avgWriteMs: Number((tWrite / _cap).toFixed(1)),
  }));
})().catch(e => { disarmStartupGuard(); console.error('\n[VT] 失敗:', e && e.stack || e); process.exit(1); });
