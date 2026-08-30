// RENDERER2 capture-parallel v4.13 OSS（並列キャプチャ・オーケストレータ）
// - v4.13 OSS: VTのThree.js/WebGLデッキは4並列で開始し、失敗区間だけを
//              2並列、最後に1並列＋長いPuppeteer制限時間で段階再試行する。
// - v4.12 OSS: VTのThree.js/WebGLデッキは未指定時の並列数を1へ自動調整し、
//              失敗したシャードだけを長いPuppeteer制限時間で直列再試行する。
// - v4.11 OSS: 実行ごとに固有のフレーム一時フォルダを作り、並行実行時の衝突と
//              固定パスの再帰削除を避ける。公開版向けに入力値検証も追加。
// - v4.9: デッキが uploads/○○_指示一式/ の下にあるCDE2 ZIP（support.js等はZIPルート側）で
//         ROOTを取り違え、support.js/_ds/assetsが404→BOOT失敗していたのを修正。
//         ROOTをZIPルートまで遡上する resolveDeckRoot() を追加（2026-08-01）
// - v4.5: <video> の音声を既定OFFに変更。data-audio="1" を付けた動画だけ合成する
//         （全動画を強制ON: VIDAUDIO=1 ／ 全動画を強制OFF: VIDAUDIO=0）。
//         <audio> タグとナレーション音声は VIDAUDIO の影響を受けず、従来どおり合成する。
// - v4.4: デッキ内 <audio> タグ（効果音・ナレーション内蔵型デッキ）の音声も自動合成
//         （開始時刻の推定: data-render-start属性 → スクリプト定数(NARR_T0等)の自動検出 → シーン開始 → 0秒。
//          手動上書き: AUDSTART="ファイル名.wav=3.0,…" ／ 全音声無効化: NOAUDIO=1）
// - v4.3: デッキ内 <video> の埋め込み音声を書き出しMP4に自動合成
//         （音声は各動画のシーン開始時刻に配置。loop属性の動画はシーン尺まで音声も反復。
//          動画音声の音量: VIDVOL=0.8 等 ／ 検出結果表示: VIDAUDIO_DEBUG=1）
// 使い方: node capture-parallel.js "デッキ.dc.html"
// 環境変数: CONC=初回並列数(既定4、重いVTは失敗時2→1へ自動縮退) FORMAT=jpeg(既定) JPEG_Q=92 FPS=30 CRF=16 PRESET= OUT=deck.mp4
//              PORT=8800(基準) KEEP_FRAMES=1 PROTO_TIMEOUT=ms RETRY_PROTO_TIMEOUT=ms RETRY_FAILED_SHARDS=0|1
// 各ワーカー(capture-deck2.js)が担当フレーム区間を FRAMES_DIR に書き出し、最後に親が1回だけ ffmpeg で結合＋音声合成する。
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');
const { captureWithFallback } = require('./scripts/adaptive-retry');

let DECK = process.argv[2];
if (!DECK) {
  const here = fs.readdirSync(process.cwd()).filter(function (f) { return /\.dc\.html$/i.test(f); });
  if (here.length === 1) DECK = here[0];
  else { console.error('デッキ(.dc.html)を引数で指定してください。'); process.exit(1); }
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
const NFC = function (s) { try { return s.normalize('NFC'); } catch (e) { return s; } };

function isPathInside(parent, candidate) {
  const relative = path.relative(path.resolve(parent), path.resolve(candidate));
  return relative !== '' && !relative.startsWith('..' + path.sep) && relative !== '..' && !path.isAbsolute(relative);
}

// デッキ本体と、同じパッケージROOT内で参照される独自JavaScriptだけを負荷判定に使う。
// 外部URL、ROOT外への相対参照、共通ランタイムは読み込まない。
function readDeckCodeBundle(deckAbs, root) {
  const html = fs.readFileSync(deckAbs, 'utf8');
  const parts = [html];
  const seen = new Set();
  const scriptRe = /<script\b[^>]*\bsrc\s*=\s*["']([^"']+)["']/gi;
  let match;
  while ((match = scriptRe.exec(html)) && seen.size < 64) {
    let source = match[1].split(/[?#]/, 1)[0];
    if (!source || /^(?:https?:|data:|blob:|\/\/)/i.test(source)) continue;
    try { source = decodeURIComponent(source); } catch (e) {}
    const name = path.basename(source.replace(/\\/g, '/'));
    if (/^(?:support|image-slot)\.js$/i.test(name)) continue;
    const candidate = /^[\\/]/.test(source)
      ? path.resolve(root, source.replace(/^[\\/]+/, ''))
      : path.resolve(path.dirname(deckAbs), source);
    if (!isPathInside(root, candidate) || seen.has(candidate)) continue;
    if (!fs.existsSync(candidate) || !fs.statSync(candidate).isFile()) continue;
    if (fs.statSync(candidate).size > 5 * 1024 * 1024) continue;
    seen.add(candidate);
    parts.push(fs.readFileSync(candidate, 'utf8'));
  }
  return parts.join('\n');
}

const VT = process.env.VT === '1';
let HEAVY_WEBGL_HITS = [];
if (VT) {
  try {
    const code = readDeckCodeBundle(DECK_ABS, ROOT);
    const rules = [
      ['Three.js', /\bTHREE\s*\.|WebGLRenderer\s*\(|\bthree(?:\.module|\.min)?\.js\b|\bthree(?:@|\/)\d/i],
      ['WebGL', /getContext\s*\(\s*["']webgl(?:2)?["']|\bwebgl2?\b/i],
      ['WebGL high-load settings', /preserveDrawingBuffer|shadowMap\s*\.|\.shadowMapSize\b/i],
    ];
    HEAVY_WEBGL_HITS = rules.filter(function (rule) { return rule[1].test(code); }).map(function (rule) { return rule[0]; });
  } catch (e) {
    console.log('負荷自動判定: コードを読み取れないため標準設定を使用 (' + e.message + ')');
  }
}
const HEAVY_WEBGL = HEAVY_WEBGL_HITS.length > 0;

function finiteNumber(name, fallback, min, max) {
  const value = Number(process.env[name] == null ? fallback : process.env[name]);
  if (!Number.isFinite(value) || value < min || value > max) {
    throw new Error(name + ' は ' + min + '〜' + max + ' の数値で指定してください');
  }
  return value;
}
const CONC_WAS_SET = process.env.CONC != null && String(process.env.CONC).trim() !== '';
const CONC = Math.floor(finiteNumber('CONC', 4, 1, 32));
const FPS = finiteNumber('FPS', 30, 1, 120);
const CRF = String(Math.floor(finiteNumber('CRF', 16, 0, 51)));
const FORMAT = (process.env.FORMAT || 'jpeg').toLowerCase();
if (!['jpeg', 'png'].includes(FORMAT)) throw new Error('FORMAT は jpeg または png を指定してください');
const JPEG_Q = String(Math.floor(finiteNumber('JPEG_Q', 92, 1, 100)));
const PRESET = process.env.PRESET || '';
const OUT = path.resolve(process.env.OUT || 'deck.mp4');
const NOAUDIO = process.env.NOAUDIO === '1';
const VIDEO_AUDIO_MODE = process.env.VIDAUDIO === '1' ? 'all' : (process.env.VIDAUDIO === '0' ? 'off' : 'opt-in');
const BASEPORT = Math.floor(finiteNumber('PORT', 8800, 1024, 65535 - CONC));
const EXT = FORMAT === 'jpeg' ? 'jpg' : 'png';
const RETRY_FAILED_SHARDS = process.env.RETRY_FAILED_SHARDS !== '0';
const PROTOCOL_TIMEOUT = Math.floor(finiteNumber('PROTO_TIMEOUT', HEAVY_WEBGL ? 180000 : 90000, 1000, 900000));
const RETRY_PROTO_TIMEOUT = Math.floor(finiteNumber('RETRY_PROTO_TIMEOUT', Math.max(300000, PROTOCOL_TIMEOUT), PROTOCOL_TIMEOUT, 900000));
const tempBase = process.env.RENDERER2_TEMP
  ? path.resolve(process.env.RENDERER2_TEMP)
  : os.tmpdir();
let FRAMES_DIR = null;

const indexByName = {};
const wavFiles = [];
(function walk(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name === 'node_modules' || /^renderer2-frames-/.test(e.name)) continue;
    const fp = path.join(dir, e.name);
    if (e.isDirectory()) walk(fp);
    else {
      const k = NFC(e.name);
      if (!(k in indexByName)) indexByName[k] = fp;
      if (/\.wav$/i.test(e.name)) wavFiles.push(fp);
    }
  }
})(ROOT);
let AUDIO = null;
if (!NOAUDIO) {
  if (process.env.AUDIO) AUDIO = path.resolve(process.env.AUDIO);
  else {
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
          const c = path.join(dir, String(rel));
          if (fs.existsSync(c)) { AUDIO = c; break; }
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
  if (AUDIO && !fs.existsSync(AUDIO)) AUDIO = null;
}

// --- v4.3-v4.5: デッキ内 <video>/<audio> の音声を検出 ---
// RENDERER2はコマ撮り（画像のみ）なので、音声は元ファイルから取り出して合成する。
// v4.5: <video> は data-audio="1" の明示指定がある場合だけ既定で音声を合成する。
// <audio> はナレーション・効果音として常に対象。NOAUDIO=1 の場合のみ全音声を無効化する。
let VIDCLIPS = [];
if (!NOAUDIO) {
  try {
    const html = fs.readFileSync(DECK_ABS, 'utf8');
    let bounds = null, durTotal = null;
    try { const bm = html.match(/BOUNDS\s*=\s*(\[[^\]]*\])/); if (bm) bounds = JSON.parse(bm[1]); } catch (e) {}
    const dm = html.match(/duration\s*=\s*([0-9.]+)/); if (dm) durTotal = Number(dm[1]);
    if (process.env.BOUNDS) { try { bounds = JSON.parse(process.env.BOUNDS); } catch (e) {} }
    if (process.env.DURATION) durTotal = Number(process.env.DURATION);
    if (!Array.isArray(bounds) || !bounds.length) bounds = [0];
    if (!isFinite(durTotal) || !(durTotal > 0)) durTotal = null;
    // v4.4: 開始時刻の手動上書き AUDSTART="ファイル名=秒,..."（basename一致）
    const AUDSTART = {};
    if (process.env.AUDSTART) {
      for (const kv of process.env.AUDSTART.split(',')) {
        const i = kv.lastIndexOf('=');
        if (i > 0) AUDSTART[NFC(kv.slice(0, i).trim())] = Number(kv.slice(i + 1));
      }
    }
    const resolveSrc = function (tag) {
      const srcm = tag.match(/\bsrc\s*=\s*["']([^"']+)["']/i);
      if (!srcm) return null;
      let rel = srcm[1];
      try { rel = decodeURIComponent(rel); } catch (e) {}
      if (/^(https?:|data:|blob:)/i.test(rel)) return null;
      let file = path.resolve(ROOT, rel);
      if (!fs.existsSync(file)) { const alt = indexByName[NFC(path.basename(rel))]; if (alt) file = alt; }
      if (!fs.existsSync(file)) { console.log('メディア音声: 元ファイルが見つからずスキップ -> ' + rel); return null; }
      return file;
    };
    const videoAudioOptedIn = function (tag) {
      const m = tag.match(/\bdata-audio(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/i);
      if (!m) return false;
      const raw = m[1] != null ? m[1] : (m[2] != null ? m[2] : m[3]);
      return raw == null || raw === '' || /^(?:1|true|yes|on)$/i.test(String(raw).trim());
    };
    const pushClip = function (tag, start, end, kind) {
      kind = kind === 'video' ? 'video' : 'audio';
      if (kind === 'video') {
        const enabled = VIDEO_AUDIO_MODE === 'all' || (VIDEO_AUDIO_MODE === 'opt-in' && videoAudioOptedIn(tag));
        if (!enabled) {
          if (process.env.VIDAUDIO_DEBUG === '1') {
            const srcm = tag.match(/\bsrc\s*=\s*["']([^"']+)["']/i);
            console.log('動画音声: 既定OFFのためスキップ -> ' + (srcm ? srcm[1] : '(src不明)'));
          }
          return;
        }
      }
      const file = resolveSrc(tag);
      if (!file) return;
      // 優先順: AUDSTART > data-render-start属性 > 引数の start
      const dam = tag.match(/\bdata-render-start\s*=\s*["']([0-9.]+)["']/i);
      if (dam) start = Number(dam[1]);
      const ov = AUDSTART[NFC(path.basename(file))];
      if (ov != null && isFinite(ov)) start = ov;
      const lenSec = (end != null && isFinite(end)) ? Math.max(0, end - start) : null;
      VIDCLIPS.push({ kind: kind, file: file, startSec: Math.max(0, start), lenSec: lenSec, loop: /\bloop\b/i.test(tag) });
    };
    // v4.4: <audio id="x"> がスクリプトで「t - this.定数」で頭出しされていれば、その定数値を開始時刻とみなす
    const detectScriptedStart = function (tag) {
      const idm = tag.match(/\bid\s*=\s*["']([^"']+)["']/i);
      if (!idm) return null;
      try {
        const vm2 = html.match(new RegExp("(\\w+)\\s*:\\s*document\\.getElementById\\(['\"]" + idm[1] + "['\"]\\)"));
        if (!vm2) return null;
        const cm = html.match(new RegExp(vm2[1] + "\\.currentTime\\s*=\\s*[^;\\n]*?-\\s*this\\.(\\w+)"));
        if (!cm) return null;
        const km = html.match(new RegExp(cm[1] + "\\s*=\\s*([0-9.]+)"));
        return km ? Number(km[1]) : null;
      } catch (e) { return null; }
    };
    // シーンごとに <video>/<audio> の src を拾う（sc-if の出現順 = BOUNDS の並び順。規約E）
    const sceneBodies = [];
    const scRe = /<sc-if\b[^>]*>([\s\S]*?)<\/sc-if>/g;
    let scm;
    while ((scm = scRe.exec(html))) sceneBodies.push(scm[1]);
    const bodies = sceneBodies.length ? sceneBodies : [html];
    for (let si = 0; si < bodies.length; si++) {
      const start = bounds[si] != null ? Number(bounds[si]) : 0;
      const end = bounds[si + 1] != null ? Number(bounds[si + 1]) : durTotal;
      const vre = /<(video|audio)\b[^>]*>/gi;
      let vm;
      while ((vm = vre.exec(bodies[si]))) pushClip(vm[0], start, end, vm[1].toLowerCase());
    }
    // v4.4: sc-if の外（デッキ全体）に置かれた <audio> はシーンに属さないので別扱い
    if (sceneBodies.length) {
      const globalHtml = html.replace(scRe, '');
      const are = /<audio\b[^>]*>/gi;
      let am;
      while ((am = are.exec(globalHtml))) {
        let start = detectScriptedStart(am[0]);
        if (start == null) start = 0;
        pushClip(am[0], start, durTotal, 'audio');
      }
    }
    if (VIDCLIPS.length) {
      // 音声トラックが実在するメディアだけ残す（ffprobeで確認。ffprobeが無い環境ではスキップ）
      const { spawnSync } = require('child_process');
      let probeMissing = false;
      VIDCLIPS = VIDCLIPS.filter(function (c) {
        if (probeMissing) return false;
        const pr = spawnSync('ffprobe', ['-v', 'error', '-select_streams', 'a', '-show_entries', 'stream=codec_type', '-of', 'csv=p=0', c.file], { encoding: 'utf8' });
        if (pr.error) { probeMissing = true; console.log('メディア音声: ffprobe が見つからないため <video>/<audio> の音声合成をスキップします'); return false; }
        return typeof pr.stdout === 'string' && pr.stdout.indexOf('audio') >= 0;
      });
    }
    if (process.env.VIDAUDIO_DEBUG === '1') console.log('メディア音声 検出結果: ' + JSON.stringify(VIDCLIPS));
  } catch (e) { console.log('メディア音声: 解析に失敗したためスキップ (' + e.message + ')'); VIDCLIPS = []; }
}
// v4.4: デッキ内タグで配置済みの音声ファイルをナレーション扱いで二重合成しない
if (AUDIO && VIDCLIPS.some(function (c) { return c.file === path.resolve(AUDIO); })) {
  console.log('メディア音声: ' + path.basename(AUDIO) + ' はデッキ内タグで配置済みのためナレーション扱いを解除');
  AUDIO = null;
}
// 音声ポリシーだけを高速確認する診断モード（フレーム書き出しは行わない）
if (process.env.AUDIO_SCAN_ONLY === '1') {
  console.log('AUDIO_SCAN ' + JSON.stringify({
    videoAudioMode: VIDEO_AUDIO_MODE,
    narrationAudio: AUDIO,
    mediaClips: VIDCLIPS,
    renderProfile: {
      virtualTime: VT,
      heavyWebGL: HEAVY_WEBGL,
      reasons: HEAVY_WEBGL_HITS,
      concurrency: CONC,
      concurrencySource: CONC_WAS_SET ? 'explicit' : 'automatic',
      protocolTimeout: PROTOCOL_TIMEOUT,
      retryProtocolTimeout: RETRY_PROTO_TIMEOUT,
      retryConcurrency: HEAVY_WEBGL && CONC > 2 ? [2, 1] : [1],
    },
  }));
  process.exit(0);
}

(async function () {
  fs.mkdirSync(tempBase, { recursive: true });
  FRAMES_DIR = fs.mkdtempSync(path.join(tempBase, 'renderer2-frames-'));
  console.log('並列キャプチャ: CONC=' + CONC + ' / FORMAT=' + FORMAT + ' / audio=' + (AUDIO ? 'yes' : 'no'));
  if (HEAVY_WEBGL) {
    console.log('負荷自動判定: 重いWebGL/3D (' + HEAVY_WEBGL_HITS.join(', ') + ')'
      + ' / CONC=' + CONC + (CONC_WAS_SET ? ' (明示設定)' : ' (自動)')
      + ' / PROTO_TIMEOUT=' + PROTOCOL_TIMEOUT + 'ms');
  }
  console.log('frames -> ' + FRAMES_DIR);
  const t0 = Date.now();
  // VT=1 で仮想時間ワーカー（rAF/canvas/setTimeout対応の新表現経路）を選択。
  // 未指定時は従来の高速CSS経路（getAnimationsシーク）。
  const worker = path.join(__dirname, VT ? 'capture-deck2-vt.js' : 'capture-deck2.js');
  console.log('worker: ' + path.basename(worker) + (VT ? '  (virtual-time / 新表現解禁)' : '  (CSS高速)'));

  const hb = setInterval(function () {
    let n = 0;
    try { n = fs.readdirSync(FRAMES_DIR).length; } catch (e) {}
    const el = ((Date.now() - t0) / 1000).toFixed(0);
    process.stdout.write('\r  capturing... ' + n + ' frames  ' + el + 's   ');
  }, 2000);

  function runShard(s, stage) {
    const env = Object.assign({}, process.env, {
      SHARDS: String(CONC),
      SHARD: String(s),
      FRAMES_DIR: FRAMES_DIR,
      FORMAT: FORMAT,
      JPEG_Q: JPEG_Q,
      FPS: String(FPS),
      PORT: String(BASEPORT + s),
      NOAUDIO: '1',
      PROTO_TIMEOUT: String(stage.timeout),
    });
    if (stage.name !== 'initial') {
      console.log('\n  再試行(' + stage.concurrency + '並列): shard ' + s + '/' + CONC
        + ' / PROTO_TIMEOUT=' + env.PROTO_TIMEOUT + 'ms');
    }
    const p = spawn(process.execPath, [worker, DECK_ABS], { env: env, stdio: ['ignore', 'ignore', 'inherit'] });
    return new Promise(function (resolve) {
      let settled = false;
      function finish(code, error) {
        if (settled) return;
        settled = true;
        resolve({ shard: s, code: code, error: error || null });
      }
      p.on('close', function (code) { finish(code == null ? 1 : code, null); });
      p.on('error', function (error) { finish(1, error); });
    });
  }

  const failed = await captureWithFallback({
    shards: Array.from({ length: CONC }, function (_, index) { return index; }),
    initialConcurrency: CONC,
    protocolTimeout: PROTOCOL_TIMEOUT,
    retryProtocolTimeout: RETRY_PROTO_TIMEOUT,
    retryEnabled: RETRY_FAILED_SHARDS,
    adaptive: HEAVY_WEBGL,
    runShard: runShard,
    onStage: function (stage) {
      if (stage.name === 'adaptive') {
        console.log('\n初回キャプチャで ' + stage.shards.length + ' 区間が失敗。'
          + '成功済みフレームを残し、失敗区間だけを最大2並列で再試行します。');
      } else if (stage.name === 'final') {
        const lead = HEAVY_WEBGL && CONC > 2 ? '2並列での再試行後も ' : '初回キャプチャで ';
        console.log('\n' + lead + stage.shards.length + ' 区間が未完了。'
          + '失敗区間だけを1本ずつ、長い通信待ち時間で最終再試行します。');
      }
    },
  });

  if (failed.length) {
    const detail = failed.map(function (result) {
      return 'worker ' + result.shard + ' exited ' + result.code
        + (result.error ? ' (' + result.error.message + ')' : '');
    }).join(', ');
    throw new Error(detail);
  }
  clearInterval(hb);
  const capSec = (Date.now() - t0) / 1000;
  const n = fs.readdirSync(FRAMES_DIR).filter(function (f) { return f.endsWith('.' + EXT); }).length;
  console.log('\nキャプチャ完了: ' + n + ' frames / ' + capSec.toFixed(1) + 's (capFPS=' + (n / capSec).toFixed(2) + ')');

  const ffArgs = ['-y', '-framerate', String(FPS), '-i', path.join(FRAMES_DIR, 'frame-%06d.' + EXT)];
  if (!VIDCLIPS.length) {
    // 従来どおり（ナレーション音声のみ）
    if (AUDIO) ffArgs.push('-i', AUDIO);
    ffArgs.push('-vf', 'scale=trunc(iw/2)*2:trunc(ih/2)*2');
    ffArgs.push('-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-crf', CRF);
    if (PRESET) ffArgs.push('-preset', PRESET);
    if (AUDIO) ffArgs.push('-c:a', 'aac', '-b:a', '192k', '-shortest');
  } else {
    // v4.3-v4.5: <video>/<audio> の音声を開始時刻に合成（loopはシーン尺まで反復）
    const fc = [];
    const labels = [];
    let inIdx = 1;
    if (AUDIO) { ffArgs.push('-i', AUDIO); fc.push('[' + inIdx + ':a]anull[a' + inIdx + ']'); labels.push('[a' + inIdx + ']'); inIdx++; }
    const VIDVOL = String(process.env.VIDVOL || '1');
    for (const c of VIDCLIPS) {
      if (c.loop && c.lenSec != null) ffArgs.push('-stream_loop', '-1');
      ffArgs.push('-i', c.file);
      const parts = [];
      if (c.lenSec != null) parts.push('atrim=0:' + c.lenSec.toFixed(3));
      parts.push('asetpts=PTS-STARTPTS');
      if (c.kind === 'video' && VIDVOL !== '1') parts.push('volume=' + VIDVOL);
      const ms = Math.round(c.startSec * 1000);
      if (ms > 0) parts.push('adelay=' + ms + ':all=1');
      fc.push('[' + inIdx + ':a]' + parts.join(',') + '[a' + inIdx + ']');
      labels.push('[a' + inIdx + ']');
      inIdx++;
    }
    // apad: 音声が映像より短いと -shortest が映像を切って総尺が縮むため、無音で映像尺まで埋める
    if (labels.length > 1) fc.push(labels.join('') + 'amix=inputs=' + labels.length + ':duration=longest:normalize=0,apad[aout]');
    else fc.push(labels[0] + 'apad[aout]');
    ffArgs.push('-filter_complex', fc.join(';'));
    ffArgs.push('-map', '0:v', '-map', '[aout]');
    ffArgs.push('-vf', 'scale=trunc(iw/2)*2:trunc(ih/2)*2');
    ffArgs.push('-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-crf', CRF);
    if (PRESET) ffArgs.push('-preset', PRESET);
    ffArgs.push('-c:a', 'aac', '-b:a', '192k', '-shortest');
  }
  ffArgs.push(OUT);
  const videoClipCount = VIDCLIPS.filter(function (c) { return c.kind === 'video'; }).length;
  const audioTagCount = VIDCLIPS.filter(function (c) { return c.kind === 'audio'; }).length;
  console.log('ffmpeg 結合 -> ' + OUT + (AUDIO ? ' (+narration)' : '') + (videoClipCount ? ' (+video音声 x' + videoClipCount + ')' : '') + (audioTagCount ? ' (+audioタグ x' + audioTagCount + ')' : ''));
  await new Promise(function (res, rej) {
    const ff = spawn('ffmpeg', ffArgs, { stdio: ['ignore', 'inherit', 'inherit'] });
    ff.on('close', function (code) { code === 0 ? res() : rej(new Error('ffmpeg exited ' + code)); });
    ff.on('error', rej);
  });
  const total = (Date.now() - t0) / 1000;
  console.log('\n--- 並列計測 ---');
  console.log('CONC=' + CONC + '  frames=' + n + '  capture=' + capSec.toFixed(1) + 's  total=' + total.toFixed(1) + 's');
  console.log('done -> ' + OUT);
  if (process.env.KEEP_FRAMES !== '1') fs.rmSync(FRAMES_DIR, { recursive: true, force: true });
})().catch(function (e) {
  console.error('\n並列キャプチャ失敗:', e.message);
  if (process.env.KEEP_FRAMES !== '1' && FRAMES_DIR) fs.rmSync(FRAMES_DIR, { recursive: true, force: true });
  process.exit(1);
});
