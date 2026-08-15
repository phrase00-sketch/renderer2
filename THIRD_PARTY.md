# Third-party components

RENDERER2 source code is licensed under MIT.

- [Puppeteer](https://pptr.dev/) is installed through npm and is licensed under Apache-2.0.
- Chromium is downloaded by Puppeteer during installation. Chromium contains components under multiple open-source licenses; see Chromium's bundled credits for details.
- [FFmpeg](https://ffmpeg.org/) and `ffprobe` are required external programs and are not redistributed in this repository. The license of an FFmpeg build depends on how that build was configured.
- The two WebP files under `examples/assets/` were generated specifically for this public sample. See the adjacent provenance README.

RENDERER2 does not redistribute package-specific runtimes such as `support.js` or `image-slot.js`. If a deck requires them, they must be supplied by the deck package under terms that permit their use.
