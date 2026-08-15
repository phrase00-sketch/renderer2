# Contributing

Bug reports and small, reproducible deck fixtures are welcome. Do not attach private production media, personal data, copyrighted footage, access tokens, or runtime files whose redistribution terms are unclear.

Before submitting a change:

```bash
npm ci
npm run check
npm test
```

Keep fixtures synthetic and small. A rendering change should describe whether it affects the CSS/WAAPI path, the virtual-time path, audio composition, or all of them.
