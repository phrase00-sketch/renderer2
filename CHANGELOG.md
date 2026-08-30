# Changelog

## 1.2.0 — 2026-08-30

- Start heavy Three.js / WebGL virtual-time decks with four capture workers.
- Step failed heavy-WebGL shards down from four workers to at most two, then one with the extended protocol timeout.
- Preserve successful frame ranges across every retry stage and keep manual 1 / 2 / 4 initial-concurrency choices available.
- Add deterministic retry-policy tests, heavy-WebGL profile coverage, and a synthetic WebGL smoke fixture.

## 1.1.0 — 2026-08-28

- Detect Three.js and heavy WebGL virtual-time decks and default them to one capture worker.
- Retry only failed capture shards sequentially with an extended protocol timeout.
- Add `RENDERER2_CONC`, protocol-timeout, and retry controls to the Windows and command-line workflows.
- Keep explicit concurrency settings authoritative and preserve the four-worker default for standard decks.

## 1.0.0 — 2026-08-15

- First public release, extracted from a daily production workflow.
- Parallel CSS/WAAPI capture and deterministic virtual-time capture.
- CDE2 package layout, audio composition, and `data-vin` support.
- Unique temporary frame directories for safe concurrent runs.
- Local asset-server path boundary checks.
- Synthetic 12-second vertical sample deck.
