# Changelog

## 1.8.1 - 2026-09-11

- Allow inert x-dc wrappers in static HTML without waiting for a React runtime. Native runtime evidence still requires readiness.
- Add a static x-dc CSS timing regression and align scene identity / preview geometry documentation with CDE2 36.0.4.

## 1.8.0 — 2026-09-10

- Drive explicit `__DECK__.renderAt(T)` / `window.renderAt(T)` hooks during CSS capture without overwriting their independent cue clocks.
- Support `data-cde-time-mode="absolute|scene-relative"` independently of CSS/VT mode. Infer older static CSS clocks from computed scene delays, allowing arbitrary CSS variable names and global overlay siblings.
- Honor `data-t0` as global media start in CSS capture, with nearest animated-wrapper delay as an absolute-CSS fallback and `data-vin` retained as source offset.
- Add real Chromium clock regressions and a shared authoring-contract reference. Preserve public file-boundary checks, runtime detection, and output dimension normalization.


## 1.7.0 — 2026-09-05

- Drive CDE2 continuous-composition stages through `data-om-seek-to-time-frame` on every virtual-time output frame.
- Keep deck-side preview loops stopped under WebDriver while still providing the exact absolute render time.
- Add a real Chromium regression proving that a no-slider stage receives frame times from 0.0 through 0.3 seconds instead of remaining on its initial frame.

## 1.6.0 — 2026-08-31

- Treat CDE2 `manifest.json` `renderMode` as the authoritative CSS / virtual-time selection for ZIP inputs.
- Keep `data-render-mode` and source inspection as the fallback for direct HTML and older packages.
- Add a regression that resolves a ZIP whose WebGL implementation is hidden behind a module graph and confirms the manifest still selects virtual time.
- Keep ZIP extraction compatible with Windows PowerShell 5.1 by using the supported `New-Item -Path` form.

## 1.5.0 — 2026-08-31

- Reject heavy-WebGL workers that reach capture without creating a WebGL context instead of accepting text-only output.
- Add the optional versioned `window.__RENDERER2_STATUS__` contract for explicit `booting`, `ready`, and `error` states.
- Require contract-aware decks to finish one real render before reporting ready, while keeping a context-based fallback for existing decks.
- Add real-Chromium regressions for swallowed boot failures, explicit boot errors, delayed readiness, and valid near-black WebGL output.

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
