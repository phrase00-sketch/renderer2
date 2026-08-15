# Security policy

## Supported version

Security fixes are applied to the latest version on the `main` branch.

## Reporting a vulnerability

Please use GitHub's private vulnerability reporting feature if it is available for this repository. Otherwise, open an issue that contains no exploit details and ask the maintainer for a private contact route.

## Trust boundary

RENDERER2 opens a supplied HTML deck in a local headless Chromium browser. A deck can run JavaScript and can make network requests. Render only packages you created yourself or obtained from a source you trust, and inspect packages before rendering confidential material.

The local asset server binds to `127.0.0.1` and restricts file responses to the resolved deck root. RENDERER2 does not upload decks or media itself. External URLs embedded in a deck may still be requested by Chromium.

Do not run RENDERER2 with administrator or root privileges. Keep Node.js, Puppeteer/Chromium, and FFmpeg updated.
