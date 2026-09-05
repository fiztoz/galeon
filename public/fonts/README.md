# Vendored fonts

Galeon ships its own font files so that launching the app makes **no third-party
network request**. Previously `src/index.css` pulled Inter, JetBrains Mono and
Space Grotesk from Google Fonts at every start, which leaked the user's IP to
Google and made the "offline by design" claim only partly true.

| File | Family | Axes used | Subset |
|---|---|---|---|
| `inter-*.woff2` | Inter | `opsz 14..32`, `wght 100..900` | latin, latin-ext |
| `jetbrains-mono-*.woff2` | JetBrains Mono | `wght 100..800` | latin, latin-ext |
| `space-grotesk-*.woff2` | Space Grotesk | `wght 300..700` | latin, latin-ext |

Roman only — the UI has no italic text, so the italic faces were not vendored.
Subsets beyond latin/latin-ext (Cyrillic, Greek, Vietnamese, …) were skipped: they
roughly triple the payload and no UI string needs them. Each `@font-face` carries a
`unicode-range`, so the browser only ever reads the file it needs — and without it a
later face for the same family+weight would replace the earlier one entirely, which
would break basic Latin.

## License

All three are the **SIL Open Font License 1.1**; the text for each family is in
`OFL-*.txt` alongside these files, with its copyright notice. The OFL requires that
the license and copyright notice stay with the fonts, which is why they are
committed rather than stripped.

- Inter — Copyright 2020 The Inter Project Authors (https://github.com/rsms/inter)
- JetBrains Mono — Copyright 2020 The JetBrains Mono Project Authors (https://github.com/JetBrains/JetBrainsMono)
- Space Grotesk — Copyright 2020 The Space Grotesk Project Authors (https://github.com/floriankarsten/space-grotesk)

## Refreshing

Re-fetch from the upstream release if a font update is wanted; do not pull from the
Google Fonts CDN at runtime.
