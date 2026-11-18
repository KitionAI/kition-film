# Attribution

Every non-code asset in Kition Film, with its author, source and license. Each file listed here also has
a `<file>.attribution` sidecar with full details. The rules are in [AGENTS.md](../AGENTS.md) §1: no Adobe
iconography, images or other Adobe assets; open licenses only; every asset attributed.
`cargo xtask assets` checks that this index and the sidecars cover every asset in the repository.

## Asset files

| Asset | Author | Source | License |
|---|---|---|---|
| `conformance/golden/basic.png` | Kition contributors | rendered by `bindings/wasm/examples/checks.rs` with this kit's engine | Apache-2.0 |
| `conformance/golden/basic-scale-2.png` | Kition contributors | rendered by `bindings/wasm/examples/checks.rs` with this kit's engine | Apache-2.0 |
| `assets/fonts/Inter-Regular.ttf` | The Inter Project Authors | https://github.com/rsms/inter | OFL-1.1 (`assets/fonts/OFL-Inter.txt`) |
| `assets/fonts/Inter-Medium.ttf` | The Inter Project Authors | https://github.com/rsms/inter | OFL-1.1 (`assets/fonts/OFL-Inter.txt`) |
| `assets/fonts/Inter-SemiBold.ttf` | The Inter Project Authors | https://github.com/rsms/inter | OFL-1.1 (`assets/fonts/OFL-Inter.txt`) |
| `assets/fonts/Inter-Bold.ttf` | The Inter Project Authors | https://github.com/rsms/inter | OFL-1.1 (`assets/fonts/OFL-Inter.txt`) |
| `assets/fonts/Inter-Italic.ttf` | The Inter Project Authors | https://github.com/rsms/inter | OFL-1.1 (`assets/fonts/OFL-Inter.txt`) |
| `assets/fonts/NotoSerif-Regular.ttf` | The Noto Project Authors | https://github.com/notofonts/latin-greek-cyrillic | OFL-1.1 (`assets/fonts/OFL-NotoSerif.txt`) |
| `assets/fonts/JetBrainsMono-Regular.ttf` | The JetBrains Mono Project Authors | https://github.com/JetBrains/JetBrainsMono | OFL-1.1 (`assets/fonts/OFL-JetBrainsMono.txt`) |
| `web/public/sample/clips/bars.mp4` | the Kition authors | Original work: procedurally generated colour bars and tone, bundled as a sample clip | Apache-2.0 |
| `assets/readme/hero.png` | the Kition authors | Screenshot of Kition Film's editor on the showcase sample six-places-beat-montage (`web/scripts/readme-shots.mjs`) | Apache-2.0 |
| `assets/readme/see-1.png` | the Kition authors | Screenshot of Kition Film's editor: the Timeline and the Markers panel (six-places-beat-montage) | Apache-2.0 |
| `assets/readme/see-2.png` | the Kition authors | Screenshot of Kition Film's editor: a title selected in the Program monitor (aurora-title-card) | Apache-2.0 |
| `assets/readme/see-3.png` | the Kition authors | Screenshot of Kition Film's editor: Effect Controls with keyframes (aurora-title-card) | Apache-2.0 |
| `assets/readme/see-4.png` | the Kition authors | Screenshot of Kition Film's editor: video transitions and a music clip's audio (six-places-beat-montage) | Apache-2.0 |
| `assets/readme/made-1.png` | the Kition authors | Rendered by Kition Film from the showcase sample product-launch-title | Apache-2.0 |
| `assets/readme/made-2.png` | the Kition authors | Rendered by Kition Film from the showcase sample four-up-video-wall | Apache-2.0 |
| `assets/readme/made-3.png` | the Kition authors | Rendered by Kition Film from the showcase sample neon-glitch-stream-intro | Apache-2.0 |
| `assets/readme/made-4.png` | the Kition authors | Rendered by Kition Film from the showcase sample matchday-versus-split | Apache-2.0 |

## Assets drawn or generated in code

These are original work by upstream contributors (see NOTICE) under the MIT License (see NOTICE). None
is traced or derived from Adobe artwork.

| Asset | Where |
|---|---|
| Demo footage (ocean sunset, aurora, city night, dunes, forest, plasma), bars and tone, counting leader, colour matte | `crates/media/media/src/generators.rs` |
| Built-in graphics templates (Lower Third – Slab / Rule, Ticker – Crawl, Title – Centered / Boxed, End Credits – Roll, Callout – Pointer / Tag) and their placeholder text | `crates/engine/project/src/gtemplate.rs` (`builtin_templates`): original designs defined in code with the bundled Inter font; thumbnails are rendered at runtime, no template, image or font files |
| Color effect "Look" presets (Teal & Orange, Warm Film, …) | `crates/render/render/src/effects.rs` (`apply_look`): procedural colour transforms, not LUT files |
| Color Presets (Effects panel: Cinematic, Film Emulation, Monochrome, Technical) and their preview picture | `crates/render/render/src/color_presets.rs`: Color effect parameter values chosen by contributors, descriptive names, and a procedural preview picture (dusk sky, ridges, lake, grey ramp, colour chips) |

## Optional build input: kition-fonts

These fonts are **not files in this repository**. A native build made with the optional build
input `KITION_FONTS_DIR` (a local [KitionAI/kition-fonts](https://github.com/KitionAI/kition-fonts)
checkout; see [docs/development.md](development.md#building-with-kition-fonts)) embeds every font
in that checkout's `fonts/manifest.txt`, unmodified; each file, its author, pinned upstream source
and license text are listed in its
[ATTRIBUTION.md](https://github.com/KitionAI/kition-fonts/blob/main/ATTRIBUTION.md). The web build
embeds none of them (`crates/support/text/build.rs` keeps only BIZ UDPGothic Regular for the web,
which kition-fonts does not hold), and Kition's published kit package does not build with the
checkout.

| Font | License |
|---|---|
| Droid Sans Fallback | Apache-2.0 |
| Inter, Lora, JetBrains Mono, Bricolage Grotesque, Carlito, Caladea, Tinos, Cousine, Arimo, Noto Color Emoji, Ma Shan Zheng | OFL-1.1 |

## Interface translations

| Catalog | Author | Source | License |
|---|---|---|---|
| `web/src/i18n/upstream/es.tsv` | upstream contributors (see NOTICE) | Imported unchanged with the upstream project | MIT (see NOTICE) |
| `web/src/i18n/upstream/ja.tsv` | upstream contributors (see NOTICE) | Imported unchanged with the upstream project | MIT (see NOTICE) |
| `web/src/i18n/upstream/pt-br.tsv` | upstream contributors (see NOTICE; added upstream by vangel76) | Imported unchanged with the upstream project | MIT (see NOTICE) |
| `web/src/i18n/upstream/zh-hans.tsv` | the Kition authors | Written for Kition Film's web editor | Apache-2.0 |

## Downloaded at runtime

These files are never in the repository or the kit package. Kition Film downloads them into the
per-user data directory (`<data dir>/models/<id>/`) only after the user confirms a dialog that shows
the size, the source URL and the license. Every file is pinned to a revision and checked against its
SHA-256 (`crates/engine/speech/src/models.rs`, `docs/features/transcripts.md`).

| Asset | Author | Source | License |
|---|---|---|---|
| Whisper tiny / base / small speech-recognition weights (`model.safetensors`, `config.json`, `generation_config.json`, `tokenizer.json`) | OpenAI | `https://huggingface.co/openai/whisper-{tiny,base,small}` (revisions `169d4a43…`, `e37978b9…`, `973afd24…`); weights released with `https://github.com/openai/whisper` | MIT (weights and code, github.com/openai/whisper); the Hugging Face conversion is labelled Apache-2.0 |
