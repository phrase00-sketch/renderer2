# WebGL deck contract

RENDERER2 can protect existing heavy-WebGL decks by requiring at least one real WebGL context before the first screenshot. New decks should also publish explicit boot and first-render state through the optional versioned contract below.

## Status object

Create the object before renderer boot begins:

```js
const renderer2Status = window.__RENDERER2_STATUS__ = {
  version: 1,
  kind: 'webgl',
  state: 'booting', // booting | ready | error
  error: null,
  frameSerial: 0,
  lastRenderedTime: null,
};
```

Do not report `ready` merely because a module loaded. Set it only after all of the following are true:

1. the WebGL renderer and context exist;
2. the context is not lost;
3. the output canvas is attached to the intended stage;
4. one real render of the captured output has completed.

After every successful deterministic `render(t)` call:

```js
renderer2Status.frameSerial += 1;
renderer2Status.lastRenderedTime = t;
renderer2Status.state = 'ready';
```

If boot or rendering fails, keep the page alive only if useful for diagnostics, but publish the error:

```js
function reportRenderer2Error(error) {
  renderer2Status.state = 'error';
  renderer2Status.error = {
    name: error?.name || 'Error',
    message: error?.message || String(error),
    stack: error?.stack || '',
  };
}
```

The error must be serializable. Do not store live WebGL, DOM, or Error objects in `status.error`.

## Capture behavior

For a heavy-WebGL virtual-time worker, RENDERER2:

- fails immediately on contract state `error` with `WEBGL_BOOT_ERROR`;
- accepts contract state `ready` only after a context exists and `frameSerial > 0`;
- waits up to `WEBGL_READY_TIMEOUT` while state is `booting`;
- falls back for older decks to requiring at least one context before capture;
- reports missing initialization as `WEBGL_NOT_INITIALIZED`;
- continues to report later context loss as `WEBGL_CONTEXT_LOST`.

Near-black output is not itself an error. Legitimate dark scenes must pass when context and ready state are healthy.

## Deterministic deck requirements

- Stop autonomous `requestAnimationFrame` rendering while `navigator.webdriver === true`.
- Let RENDERER2 request the exact output time and render only that state.
- Make `render(t)` produce the same visual state for the same `t` after an isolated reload or shard start.
- Reconstruct state from time instead of relying on prior frames.
- Report first-render completion through the status contract.
- Report context loss and boot/render exceptions instead of only logging and continuing.
- Bind WebGL to the intended final canvas only after that canvas is mounted. Dispose the old renderer before rebinding a replacement canvas.

`preserveDrawingBuffer` is an output-path decision. Do not switch it off while a deck still copies from a hidden WebGL canvas into a 2D canvas. Test it separately after direct final-canvas rendering is stable.
