// vt-probe — RENDERER2 「新表現」検証用カスタム要素（v3 ・ 曖昧さを排した診断版）。
//
// 目的: 「仮想クロックが本当に等速で進んでいるか」を一目で判定できるようにする。
// v2の「12本スポークの扱風機」は30°周期の回転対称があり、
// 30fpsのサンプリングと干渉してストロボ（ワゴンホイール）現象を起こし、
// 等速でもカクツク/逆回転に見えた。v3はそれを排除する：
//   - 回転は「対称なしの1本針」を1回転/4秒の低速で→ストロボなし
//   - 「直線スイープバー」を等速で動かし→一定速で進むか一目で分かる
//   - 色と動きを分離（色は連続、タイマー検証は別枚の点滅で）
// すべて時間（performance.now）基準。仮想クロックが等速なら滑らかに見える。
//
// 使い方: デックと同じフォルダに置き、<head> で <script src="./vt-probe.js"></script> を読み込み、
//   <vt-probe style="position:absolute;left:40px;top:40px;width:420px;height:230px;z-index:99999"></vt-probe>
// を置く。

(() => {
  if (window.customElements && customElements.get('vt-probe')) return;

  class VtProbe extends HTMLElement {
    connectedCallback() {
      const root = this.attachShadow ? this.attachShadow({ mode: 'open' }) : this;
      const W = 420, H = 230;
      root.innerHTML =
        '<style>:host{display:block}canvas{display:block;width:100%;height:100%;' +
        'border:3px solid #00e5ff;border-radius:10px;background:#001016;' +
        'box-shadow:0 0 24px rgba(0,229,255,.5)}</style>' +
        '<canvas width="' + (W * 2) + '" height="' + (H * 2) + '"></canvas>';
      const cv = root.querySelector('canvas');
      const ctx = cv.getContext('2d');
      ctx.scale(2, 2);

      this._frames = 0;
      this._blink = false;            // setTimeout で 0.5秒ごとにトグル（タイマー検証）
      const tickBlink = () => { this._blink = !this._blink; this._to = setTimeout(tickBlink, 500); };
      this._to = setTimeout(tickBlink, 500);

      const cx = 92, cy = 118, r = 66;

      const draw = (ts) => {
        const t = (typeof ts === 'number' ? ts : performance.now()) / 1000;
        ctx.clearRect(0, 0, W, H);

        // 文字盤（目盛り）
        ctx.strokeStyle = 'rgba(0,229,255,.35)';
        ctx.lineWidth = 2;
        ctx.beginPath(); ctx.arc(cx, cy, r, 0, Math.PI * 2); ctx.stroke();
        ctx.strokeStyle = 'rgba(0,229,255,.2)';
        ctx.lineWidth = 1;
        for (let k = 0; k < 12; k++) {
          const a = k * Math.PI / 6;
          ctx.beginPath();
          ctx.moveTo(cx + Math.cos(a) * (r - 8), cy + Math.sin(a) * (r - 8));
          ctx.lineTo(cx + Math.cos(a) * r, cy + Math.sin(a) * r);
          ctx.stroke();
        }

        // 対称なしの1本針（1回転/4秒 = 90°/秒 = 3°/フレーム）。
        // 対称がないのでストロボ現象が起きず、等速なら滑らかに回る。
        const ang = -Math.PI / 2 + t * (Math.PI * 2 / 4);
        ctx.strokeStyle = '#ff4d6d';
        ctx.lineWidth = 6; ctx.lineCap = 'round';
        ctx.beginPath(); ctx.moveTo(cx, cy); ctx.lineTo(cx + Math.cos(ang) * (r - 6), cy + Math.sin(ang) * (r - 6)); ctx.stroke();
        ctx.fillStyle = '#ffd166';
        ctx.beginPath(); ctx.arc(cx + Math.cos(ang) * (r - 6), cy + Math.sin(ang) * (r - 6), 7, 0, Math.PI * 2); ctx.fill();
        ctx.fillStyle = '#dffaff';
        ctx.beginPath(); ctx.arc(cx, cy, 5, 0, Math.PI * 2); ctx.fill();

        // 直線スイープバー（等速で往復：60px/秒）。一定速で進むかを見る。
        const trackX = 186, trackW = 210, trackY = 168;
        ctx.strokeStyle = 'rgba(255,255,255,.25)';
        ctx.lineWidth = 2; ctx.beginPath(); ctx.moveTo(trackX, trackY); ctx.lineTo(trackX + trackW, trackY); ctx.stroke();
        const tri = (x) => { x = x % 2; return x < 1 ? x : 2 - x; }; // 0..1..0 三角波
        const sx = trackX + tri(t * 0.5) * trackW; // 1往復 4秒
        ctx.fillStyle = '#00e5ff';
        ctx.beginPath(); ctx.arc(sx, trackY, 9, 0, Math.PI * 2); ctx.fill();

        // テキスト：経過時間（主指標）と rAF 発火回数（診断）
        this._frames++;
        ctx.fillStyle = '#dffaff';
        ctx.font = '700 24px monospace'; ctx.fillText('VT-PROBE', 184, 40);
        ctx.font = '700 34px monospace'; ctx.fillText('t=' + t.toFixed(2) + 's', 184, 84);
        ctx.font = '600 15px monospace'; ctx.fillText('rAF#' + this._frames, 184, 112);

        // タイマー検証用の点滅（0.5秒ごとにオンオフ、動きとは分離）
        ctx.fillStyle = this._blink ? '#7CFC00' : 'rgba(124,252,0,.18)';
        ctx.beginPath(); ctx.arc(404, 20, 7, 0, Math.PI * 2); ctx.fill();

        this._raf = requestAnimationFrame(draw);
      };
      this._raf = requestAnimationFrame(draw);
    }
    disconnectedCallback() {
      if (this._raf) cancelAnimationFrame(this._raf);
      if (this._to) clearTimeout(this._to);
    }
  }

  customElements.define('vt-probe', VtProbe);
})();
