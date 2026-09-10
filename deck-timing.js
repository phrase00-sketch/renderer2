'use strict';

// Stage declarations are authoritative; legacy numeric JS assignments are a
// fallback. Never evaluate source code just to discover its duration.
function sourceDuration(html) {
  const source = String(html || '').replace(/<!--[\s\S]*?-->/g, '');
  const tags = source.match(/<[a-z][^>]*>/gi) || [];
  function attr(tag, name) {
    const m = tag.match(new RegExp('(?:\\s)' + name + '\\s*=\\s*(?:"([^"]*)"|\'([^\']*)\'|([^\\s>]+))', 'i'));
    return m ? (m[1] ?? m[2] ?? m[3]) : null;
  }
  for (const kind of ['cde', 'om']) {
    for (const tag of tags) {
      if (kind === 'cde' && !/\sdata-cde-stage(?:\s|=|>)/i.test(tag)) continue;
      const n = Number(attr(tag, kind === 'cde' ? 'data-duration' : 'data-om-exportable-video-with-duration-secs'));
      if (Number.isFinite(n) && n > 0) return n;
    }
  }
  const m = source.match(/\bduration\s*[:=]\s*([0-9]+(?:\.[0-9]+)?)/);
  const n = m ? Number(m[1]) : 0;
  return Number.isFinite(n) && n > 0 ? n : 0;
}

// Self-contained: Puppeteer serializes this function into the deck document.
function runtimeDuration(sourceFallback) {
  const stage = document.querySelector('[data-cde-stage][data-duration]');
  const om = document.querySelector('[data-om-exportable-video-with-duration-secs]');
  const slider = document.querySelector('input[type=range]');
  for (const raw of [stage?.getAttribute('data-duration'),
    om?.getAttribute('data-om-exportable-video-with-duration-secs'),
    window.__DECK__?.duration, sourceFallback, window.duration, slider?.max]) {
    const n = Number(raw);
    if (Number.isFinite(n) && n > 0) return n;
  }
  return 0;
}

module.exports = { sourceDuration, runtimeDuration };
