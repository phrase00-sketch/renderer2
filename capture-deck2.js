// RENDERER2 capture v4.11 OSS
// - v4.11 OSS: ローカル配信用のパス境界検証と入力ファイル検証を追加。
// - v4.10: <video data-vin="秒"> をCDE2と同じ意味の素材開始位置として反映（2026-08-04）
// - v4.9: デッキが uploads/○○_指示一式/ の下にあるCDE2 ZIP（support.js等はZIPルート側）で
//         support.js/_ds/assetsが404になりBOOT失敗していたのを修正。ROOTをZIPルートまで遡上（2026-08-01）
// - v4.8: スライダーなしデッキのシーン切替待ちを「rAF固定2回」から「表示中の [data-scene] が
//         期待シーンに一致するまで（上限付き・判定不能なデッキは従来どおり2rAF）」に強化。
//         高負荷時にReactのcommitがrAF2回に間に合わず旧シーンのまま撮影されるレースの保険（2026-07-27）
// - v4.7.1: シーク完了待ちの保険タイムアウトを 800ms→2500ms に延長（長GOP素材のGOP後半への
//           シークはキーフレームからの再デコードで800msを超え得るため）（2026-07-17）
// - v4.7: デッキ側JSが同じフレームで先に <video> のシークを始めている場合、currentTime は
//         「シーク先」を返すため従来判定では待たずに撮影していた。シーク進行中（v.seeking）は
//         自分がシークしなくても seeked 完了を待つよう修正（2026-07-17）
// - v4.6: 時計ブリッジ有効時、rAFコールバックのタイムスタンプ引数と document.timeline.currentTime も
//         凍結クロックへ統一。スライダー＋自走ループ（rAF引数駆動）＋previewLoop型プレイヤーの
//         シーン順暴走を修正（2026-07-15）。ブリッジ発動条件はv4.5と同一（BOUNDS複数＋performance.now使用）
// - v4.5: スライダーを持たないCDE2デッキの performance.now() を出力時刻へ固定し、
//         シーン選択・CSS/WAAPI・<video> を同じシーン相対時刻で同期
// - v4.5: class field形式の duration = ... を正しく抽出
// - v4.3: ステージ寸法の自動検出（1920×1080固定を撤廃。1080×1920などの縦・任意サイズのデッキに対応）
// - <video> を毎フレーム一時停止＋シーン相対時刻へ明示シーク（早送りループ対策）
// - シャード先頭で動画メタデータ到着と事前シーク完了を待つ（並列書き出しでシャード境界が一瞬カクつく対策）
// - ローカルHTTPサーバー越しに開く（React/画像フェッチが正しく動く。Range対応＝動画シークに必須）
// - BOUNDSと尺をデッキから自動抽出（デッキごとに違う値に自動対応）
// - support.js / image-slot.js がサブフォルダにあっても自動で見つける（文字正規化も吸収）
// - .dc-audio.json があれば音声を自動合成
// - 撮影中はプレイヤー操作UI（再生/シークバー）を隠す
// - PNGを大量に吐かず、フレームを直接 ffmpeg に流し込む（高速）
//
// 使い方: node capture-deck2.js "デッキ.dc.html"
// 出力: deck.mp4
// 環境変数(任意): FPS=30 DURATION=秒 BOUNDS="[...]" CRF=16 FORMAT=png|jpeg PORT=8753 NOAUDIO=1 OUT=deck.mp4

const fs = require('fs');
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');
const puppeteer = require('puppeteer');

let DECK = process.argv[2];
if (!DECK) {
  // 引数省略時はカレントフォルダの .dc.html を自動検出（ファイル名を打たなくてよい）
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
const FORMAT = (process.env.FORMAT || 'png').toLowerCase();
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
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

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
console.log('BOUNDS', JSON.stringify(BOUNDS), '(' + BOUNDS.length + ' scenes)');
if (HTML_DURATION) console.log('HTML duration', HTML_DURATION);
if (USE_CLOCK_BRIDGE) console.log('CLOCK deterministic performance.now bridge enabled');

// --- ファイル basename 索引（文字正規化 NFC でキー化してサブフォルダも拾う） ---
const indexByName = {};
const wavFiles = [];
(function walk(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name === 'node_modules') continue;
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

// --- 音声: .dc-audio.json > 同名探索 > 唱一の wav ---
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
console.log('audio ->', AUDIO || '(none)');

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

(async () => {
  const server = await startServer();
  const url = 'http://127.0.0.1:' + PORT + '/' + encodeURIComponent(FILE);
  console.log('serving', ROOT, '->', url);

  const launchOptions = {
    headless: true,
    args: ['--force-color-profile=srgb', '--disable-lcd-text'],
  };
  if (process.env.PUPPETEER_EXECUTABLE_PATH) launchOptions.executablePath = process.env.PUPPETEER_EXECUTABLE_PATH;
  const browser = await puppeteer.launch(launchOptions);
  const page = await browser.newPage();
  const failed = [];
  page.on('requestfailed', r => failed.push(r.url() + ' :: ' + (r.failure() && r.failure().errorText)));
  page.on('console', m => { if (m.type() === 'error') console.log('[page-error]', m.text()); });
  await page.setViewport({ width: 1920, height: 1160, deviceScaleFactor: 1 });
  await page.evaluateOnNewDocument(() => { try { localStorage.clear(); } catch (e) {} });
  if (USE_CLOCK_BRIDGE) {
    // CDE2の自走デッキはスライダーを持たず、performance.now() でシーンを選ぶ。
    // v4.6: スライダー付きでも自走ループを持つデッキがあるため、ブリッジは時計を丸ごと（now/rAF引数/timeline）固定する。
    // 各シャードの実時間に任せるとシーン順が壊れるため、ページ起動前から時計を固定する。
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
  // 未完了リクエストの追跡（起動失敗時の診断用）
  const pendingReqs = new Set();
  page.on('request', r => pendingReqs.add(r));
  page.on('requestfinished', r => pendingReqs.delete(r));
  page.on('requestfailed', r => pendingReqs.delete(r));
  // networkidle0 は外部CDN（unpkgのReact/Babel・Google Fonts）の応答停滞が1本あるだけで
  // 120秒タイムアウトになり並列時に脆い。起動��実質的な確認は直下のBOOTループが行うため、
  // ここはDOM構築完了（domcontentloaded）まで待てば十分。
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 120000 });

  // --- 起動検知 ---
  let boot = null;
  // domcontentloaded化に伴い、CDN読み込みの待ちはこのループが引き受ける（既定60秒・環境変数で調整可）
  const BOOT_TIMEOUT_MS = Number(process.env.BOOT_TIMEOUT_MS || 60000);
  const t0 = Date.now();
  while (Date.now() - t0 < BOOT_TIMEOUT_MS) {
    boot = await page.evaluate(() => {
      const stage = (() => {
        const byClass = document.querySelector('.stage');
        if (byClass) return byClass;
        return Array.from(document.querySelectorAll('div')).find(d => {
          if (/^\d+px$/.test(d.style.width) && /^\d+px$/.test(d.style.height) && parseInt(d.style.width) >= 320 && parseInt(d.style.height) >= 320) return true;
          const cs = getComputedStyle(d);
          return cs.width === '1920px' && cs.height === '1080px';
        });
      })();
      return {
        hasReact: !!window.React, hasReactDOM: !!window.ReactDOM,
        dcRoot: !!document.getElementById('dc-root'),
        sliders: document.querySelectorAll('input[type=range]').length,
        stageOK: !!stage && stage.getBoundingClientRect().width > 100,
        children: stage ? stage.children.length : -1,
        hasBOUNDS: Array.isArray(window.BOUNDS),
        duration: typeof window.duration === 'number' ? window.duration : 0,
      };
    });
    const runtimeReady = !EXPECTS_DC_RUNTIME || (boot.hasReact && boot.hasReactDOM && boot.dcRoot);
    if (boot.stageOK && runtimeReady) break;
    await sleep(500);
  }
  console.log('BOOT', JSON.stringify(boot));
  if (failed.length) console.log('FAILED REQUESTS:\n  ' + failed.join('\n  '));

  const hasSlider = !!(boot && boot.sliders > 0);
  const deckLike = hasSlider || HAS_TIMELINE;
  const runtimeReady = boot && (!EXPECTS_DC_RUNTIME || (boot.hasReact && boot.hasReactDOM && boot.dcRoot));
  if (!boot || !boot.stageOK || !runtimeReady) {
    const stuck = Array.from(pendingReqs, r => r.url()).filter(u => !u.startsWith('data:'));
    if (stuck.length) console.error('未完了のまま止まっているリクエスト:\n  ' + stuck.join('\n  '));
    console.error('\n⛔ デッキが起動しませんでした。上の BOOT / FAILED REQUESTS / 未完了リクエスト を貼ってください。');
    await browser.close(); server.close(); process.exit(2);
  }
  console.log('✅ 起動OK。');

  // v4.3: ステージ寸法を自動検出してビューポートを合わせる（縦・任意サイズ対応）
  const stageDims = await page.evaluate(() => {
    const st = (() => {
      const byClass = document.querySelector('.stage');
      if (byClass) return byClass;
      return Array.from(document.querySelectorAll('div')).find(d => {
        if (/^\d+px$/.test(d.style.width) && /^\d+px$/.test(d.style.height) && parseInt(d.style.width) >= 320 && parseInt(d.style.height) >= 320) return true;
        const cs = getComputedStyle(d);
        return cs.width === '1920px' && cs.height === '1080px';
      });
    })();
    const r = st ? st.getBoundingClientRect() : { width: 1920, height: 1080 };
    return { w: Math.round(r.width), h: Math.round(r.height) };
  });
  console.log('STAGE', stageDims.w + 'x' + stageDims.h);
  await page.setViewport({ width: Math.max(stageDims.w, 640), height: stageDims.h + 80, deviceScaleFactor: 1 });

  // フォント読み込み完了を待つ（networkidle0待ちを外した分の置き換え。最大15秒で打ち切り）
  try {
    await Promise.race([
      page.evaluate(() => (document.fonts && document.fonts.status !== 'loaded') ? document.fonts.ready.then(() => {}) : null),
      sleep(15000),
    ]);
  } catch (e) {}

  // --- 尺(DURATION): env > slider.max > BOUNDS末尾+6 ---
  let DURATION = Number(process.env.DURATION || HTML_DURATION || 0);
  if (!DURATION) {
    DURATION = await page.evaluate(() => {
      if (typeof window.duration === 'number' && isFinite(window.duration) && window.duration > 0) return window.duration;
      const s = document.querySelector('input[type=range]');
      const m = s && parseFloat(s.max);
      return (m && isFinite(m)) ? m : 0;
    });
  }
  if (!DURATION) DURATION = BOUNDS[BOUNDS.length - 1] + 6;
  console.log('DURATION', DURATION, 'sec / FPS', FPS, '/ audio', AUDIO ? 'yes' : 'no');

  // 画像・フォントの読み込み待ち
  await sleep(2500);

  // --- 画像スロットの「ハマり方」を確定させる修正（真因） ---
  // HTML では <x-import style="width:100%;height:100%" hint-size="100%,100%"> だが、
  // support.js は x-import の style を外側ラッパー(.sc-host-x)にだけ適用し、
  // 内側の <image-slot> には寸法を渡さない。そのため <image-slot> は既定の
  // :host{width:240px;height:160px} のままで、大きな赤枠の左上に 240x160 で小さく残る。
  // ホスト自体を枠いっぱいに広げる（= hint-size の本来の意図）のが正しい修正。
  // <image-slot> は本文書の light DOM にあるので、外側CSSで :host を上書きできる。
  // さらに ::part(image) で中身のimgを cover 固定し、_applyView のタイミングに依存せず枠を埋める。
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

  // stage の位置
  const rect = await page.evaluate(() => {
    const st = (() => {
      const byClass = document.querySelector('.stage');
      if (byClass) return byClass;
      return Array.from(document.querySelectorAll('div')).find(d => {
        if (/^\d+px$/.test(d.style.width) && /^\d+px$/.test(d.style.height) && parseInt(d.style.width) >= 320 && parseInt(d.style.height) >= 320) return true;
        const cs = getComputedStyle(d);
        return cs.width === '1920px' && cs.height === '1080px';
      });
    })();
    const r = st.getBoundingClientRect();
    return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) };
  });

  // ffmpeg をパイプで起動（音声���あれば第2入力として合成）
  // 出力先: FRAMES_DIR 指定時はファイル書き出し（並列ワーカー用。ffmpegは親が後でまとめて実行）
  const ext = FORMAT === 'jpeg' ? 'jpg' : 'png';
  let ff = null;
  let ffClosed = false;
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

  const total = Math.round(DURATION * FPS);
  const shotType = FORMAT === 'jpeg' ? 'jpeg' : 'png';
  const startF = FRAMES_DIR ? Math.floor(total * SHARD / SHARDS) : 0;
  const endF = FRAMES_DIR ? Math.floor(total * (SHARD + 1) / SHARDS) : total;
  if (TRACE_FILE) {
    fs.mkdirSync(path.dirname(path.resolve(TRACE_FILE)), { recursive: true });
    fs.writeFileSync(TRACE_FILE, '');
  }
  if (FRAMES_DIR) console.log('shard ' + SHARD + '/' + SHARDS + ' frames [' + startF + ',' + endF + ')');
  // --- v4.2: シャード先頭ウォームアップ ---
  // シャード先頭では slider セットで新しいシーンがマウントされ、<video> の
  // メタデータ未着で初回シークがスキップされる（＝先頭1フレームだけ絵が飛ぶ）。
  // 事前に slider を先頭時刻へ合わせ、全<video>の準備完了とシーク完了を待つ。
  if (deckLike) {
    const T0 = startF / FPS;
    await page.evaluate(async (T, hasSlider, useClockBridge) => {
      if (useClockBridge && typeof window.__rendererSetTime === 'function') {
        window.__rendererSetTime(T * 1000);
      }
      const sl = document.querySelector('input[type=range]');
      if (hasSlider && sl) {
        const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(sl), 'value').set;
        setter.call(sl, String(T));
        sl.dispatchEvent(new Event('input', { bubbles: true }));
      }
      await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
    }, T0, hasSlider, USE_CLOCK_BRIDGE);
    const tw0 = Date.now();
    while (Date.now() - tw0 < 8000) {
      const ready = await page.evaluate(() => {
        const vs = Array.from(document.querySelectorAll('video'));
        return vs.every(v => isFinite(v.duration) && v.duration > 0 && v.readyState >= 2);
      });
      if (ready) break;
      await sleep(100);
    }
    await page.evaluate(async (T, BOUNDS) => {
      let n = 0; for (let k = 0; k < BOUNDS.length; k++) if (T >= BOUNDS[k]) n = k;
      const el = T - BOUNDS[n];
      const waits = [];
      for (const v of document.querySelectorAll('video')) {
        try {
          if (!v.paused) v.pause();
          if (v.preload !== 'auto') v.preload = 'auto';
          const dur = v.duration;
          if (!isFinite(dur) || dur <= 0) continue;
          const vin = Math.max(0, parseFloat(v.getAttribute('data-vin') || '0') || 0);
          const hi = Math.max(vin, dur - 0.05);
          const span = Math.max(0.001, dur - vin);
          const target = v.loop ? vin + (el % span) : Math.max(vin, Math.min(vin + el, hi));
          waits.push(new Promise((res) => {
            let done = false;
            const fin = () => { if (done) return; done = true; v.removeEventListener('seeked', fin); res(); };
            v.addEventListener('seeked', fin);
            setTimeout(fin, 1500);
            try { v.currentTime = target; } catch (e) { fin(); }
          }));
        } catch (e) {}
      }
      if (waits.length) await Promise.all(waits);
      await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
    }, T0, BOUNDS);
    await sleep(200);
  }
  let tEval = 0, tShot = 0, tWrite = 0; const tStart = Date.now();
  for (let i = startF; i < endF; i++) {
    const T = i / FPS;
    const _e0 = Date.now();
    await page.evaluate(async (T, BOUNDS, hasSlider, isTimeline, useClockBridge) => {
      if (useClockBridge && typeof window.__rendererSetTime === 'function') {
        window.__rendererSetTime(T * 1000);
      }
      if (hasSlider) {
        const sl = document.querySelector('input[type=range]');
        const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(sl), 'value').set;
        setter.call(sl, String(T));
        sl.dispatchEvent(new Event('input', { bubbles: true }));
        await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
        // 撮影時だけプレイヤー操作UIを隠す（ステージの外側のスライダーコンテナ）
        const stageEl = (() => {
          const byClass = document.querySelector('.stage');
          if (byClass) return byClass;
          return Array.from(document.querySelectorAll('div')).find(d => {
            if (/^\d+px$/.test(d.style.width) && /^\d+px$/.test(d.style.height) && parseInt(d.style.width) >= 320 && parseInt(d.style.height) >= 320) return true;
            const cs = getComputedStyle(d);
            return cs.width === '1920px' && cs.height === '1080px';
          });
        })();
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
      }
      if (!hasSlider && useClockBridge) {
        // v4.8: 従来は「performance.now() を更新した次のrAFでReact stateが切り替わる」前提の
        // rAF固定2回待ちだったが、高負荷時はcommitが間に合わず旧シーンのまま撮影されうる。
        // 表示中の [data-scene] が期待シーンに一致するまで待つ（上限10rAF）。
        // ラベルを特定できないデッキや一致しないデッキは従来どおり2rAFで進む（挙動不変）。
        let expected = null;
        if (isTimeline && !window.__sceneWaitOff) {
          try {
            if (window.__sceneLabels === undefined) {
              const src = document.querySelector('x-dc');
              const ms = src ? (src.innerHTML.match(/data-scene\s*=\s*"([^"]+)"/g) || []).map(s => s.slice(s.indexOf('"') + 1, -1)) : [];
              window.__sceneLabels = (ms.length === BOUNDS.length) ? ms : false;
            }
            if (window.__sceneLabels) {
              let n = 0; for (let k = 0; k < BOUNDS.length; k++) if (T >= BOUNDS[k]) n = k;
              expected = window.__sceneLabels[n];
            }
          } catch (e) {}
        }
        let matched = false;
        for (let w = 0; w < 10; w++) {
          await new Promise(r => requestAnimationFrame(r));
          if (!expected) { if (w >= 1) break; continue; }
          const els = document.querySelectorAll('#dc-root [data-scene]');
          if (els.length === 1 && els[0].getAttribute('data-scene') === expected) { matched = true; break; }
        }
        if (expected && !matched) window.__sceneWaitOff = 1; // 契約外デッキ：以後は従来動作に戻す
      }
      let el;
      if (isTimeline) { let n = 0; for (let k = 0; k < BOUNDS.length; k++) if (T >= BOUNDS[k]) n = k; el = (T - BOUNDS[n]) * 1000; }
      else { el = T * 1000; }
      const freeze = () => { for (const a of document.getAnimations()) { try { a.pause(); a.currentTime = el; } catch (e) {} } };
      freeze();
      await new Promise(r => requestAnimationFrame(r));
      freeze();
      // --- <video> 同期（早送りループ対策） ---
      // <video> のメディアクロックは WAAPI ではないため getAnimations() では止まらず、
      // 実時間で自走する（＝コマ撮りでは出力上の早送りになり、loop属性で周回する）。
      // 毎フレーム、一時停止してシーン相対時刻へ明示シークし、seek完了を待ってから撮影する。
      const seekWaits = [];
      for (const v of document.querySelectorAll('video')) {
        try {
          if (!v.paused) v.pause();
          if (v.preload !== 'auto') v.preload = 'auto';
          const dur = v.duration;
          if (!isFinite(dur) || dur <= 0) continue; // メタデータ未着はスキップ（次フレームで追いつく）
          const t = el / 1000;
          const vin = Math.max(0, parseFloat(v.getAttribute('data-vin') || '0') || 0);
          const hi = Math.max(vin, dur - 0.05);
          const span = Math.max(0.001, dur - vin);
          const target = v.loop ? vin + (t % span) : Math.max(vin, Math.min(vin + t, hi));
          // v4.7: デッキ側JS（内蔵プレイヤーの syncVideo 等）が slider input で先にシークを
          // 始めていると、currentTime は「シーク先の時刻」を返す（HTML仕様）。
          // 従来の「もう合っているなら continue」は進行中のシークを待たず撮影してしまう。
          const needSeek = Math.abs((v.currentTime || 0) - target) >= 0.0005;
          if (!needSeek && !v.seeking) continue;
          seekWaits.push(new Promise((res) => {
            let done = false;
            const fin = () => { if (done) return; done = true; v.removeEventListener('seeked', fin); res(); };
            v.addEventListener('seeked', fin);
            setTimeout(fin, 2500); // 保険：デコード不能でも固まらない（v4.7.1: 長GOPシーク対応で800→2500ms）
            if (needSeek) { try { v.currentTime = target; } catch (e) { fin(); } }
            // needSeekでない場合はデッキ側が始めたシークの seeked を待つだけ
          }));
        } catch (e) {}
      }
      if (seekWaits.length) {
        await Promise.all(seekWaits);
        // シーク結果が画面合成に反映されるのを待つ（取りこぼし保険）
        await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
      }
      // 新規マウント直後の autoplay が seek 完了後に再発火する場合がある。
      // 撮影直前にもう一度止めて、実時間ぶんの微小な進みも残さない。
      for (const v of document.querySelectorAll('video')) { try { if (!v.paused) v.pause(); } catch (e) {} }
    }, T, BOUNDS, hasSlider, deckLike, USE_CLOCK_BRIDGE);
    tEval += Date.now() - _e0;

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
      }, T, BOUNDS);
      fs.appendFileSync(TRACE_FILE, JSON.stringify({ frame: i, ...trace }) + '\n');
    }

    const _s0 = Date.now();
    const buf = await page.screenshot({ type: shotType,
      ...(shotType === 'jpeg' ? { quality: JPEG_Q } : {}),
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
    tWrite += Date.now() - _w0;
    if (i % 60 === 0) {
      const _el = (Date.now() - tStart) / 1000;
      process.stdout.write('\r' + i + ' / ' + total + '  capFPS=' + ((i + 1) / _el).toFixed(2) + '  eval=' + (tEval / (i + 1)).toFixed(0) + 'ms shot=' + (tShot / (i + 1)).toFixed(0) + 'ms write=' + (tWrite / (i + 1)).toFixed(0) + 'ms   ');
    }
  }
  if (ff) {
    if (!ff.stdin.destroyed && !ff.stdin.writableEnded) ff.stdin.end();
    if (!ffClosed) await new Promise(r => ff.on('close', r));
  }
  await browser.close();
  server.close();
  const _elapsed = (Date.now() - tStart) / 1000;
  const _cap = endF - startF;
  console.log('\n--- 速度計測 ---');
  console.log('frames=' + _cap + '  elapsed=' + _elapsed.toFixed(1) + 's  captureFPS=' + (_cap / _elapsed).toFixed(2));
  console.log('avg/frame: eval=' + (tEval / _cap).toFixed(0) + 'ms  screenshot=' + (tShot / _cap).toFixed(0) + 'ms  ' + (FRAMES_DIR ? 'fileWrite=' : 'pipeWrite=') + (tWrite / _cap).toFixed(0) + 'ms');
  console.log('FORMAT=' + FORMAT + (FORMAT === 'jpeg' ? '(q' + JPEG_Q + ')' : '') + '  PRESET=' + (PRESET || '(default)') + '  CRF=' + CRF);
  console.log(FRAMES_DIR ? ('shard ' + SHARD + ' done -> ' + _cap + ' frames') : ('done -> ' + OUT));
})();
