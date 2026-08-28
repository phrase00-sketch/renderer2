# Changelog

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
