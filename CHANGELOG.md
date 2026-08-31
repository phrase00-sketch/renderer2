# Changelog

## 1.4.0 — 2026-08-31

- Detect WebGL context loss inside heavy virtual-time workers instead of accepting later black frames as successful JPEG output.
- Route context-lost shards through the existing 4 → 2 → 1 adaptive retry path while preserving successful ranges.
- Add a real Chromium regression fixture that forces `WEBGL_lose_context` and verifies that no MP4 is emitted.

## 1.3.0 — 2026-08-30

- Detect heavy-WebGL multi-worker stages that produce no first frame within 100 seconds and step down early.
- Collapse the final retry into one full-deck browser when every shard stalls at both four and two workers, avoiding repeated browser startup and scene pre-roll.
- Report per-shard launch, boot, pre-roll, capture, screenshot, and frame-write timing to expose stragglers.
- Validate the startup watchdog timeout and keep successful partial ranges for ordinary shard failures.

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
