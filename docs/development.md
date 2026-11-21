# Development

## Repository layout

| Path | Contents |
|---|---|
| `crates/` | The engine, in groups: `media/` (time base, bitstream reader, frames, media sources, the container and codec crates, and `codecs`, which joins them), `engine/` (`project`, `edit`, `engine`, `audio-dsp`, `captions`, `speech`, `scopes`), `render/` (the compositor, effects, transitions and audio mix), `formats/` (`format`, the `.kfilm` file; `export`, `interchange`, `cfb`), `support/` (`geom`, `color`, `text`, `testkit`) and `kdm/` (`kdm-model`) |
| `bindings/` | `wasm`: `kition-film-kit`, the engine behind the Kition SDK's `KitDocument`, compiled to WebAssembly for the editor; `headless`: `kition-film`, the headless executable that Kition's agent drives |
| `web/` | The editor (React, on `@kition/sdk/editor`); a host shows it in an iframe, and `web/dev.html` is a host for development |
| `kit.json` | The kit manifest |
| `agent/` | The agent guide (`guide.md`) and checks |
| `conformance/` | The agent conformance fixtures (`.kfilm` projects) that cases and tests refer to |
| `features.yaml`, `cases/` | The feature catalogue and its cases ([quality.md](quality.md)) |
| `docs/` | These documents: the entry documents, `features/` (one document per feature), `parity/` (the comparison with the target application) and `testing/` (how the engine and the editor are tested, and the regression scenarios) |
| `assets/` | The bundled Latin fonts (`assets/fonts/`) and the README's pictures (`assets/readme/`), each with its `.attribution` sidecar |
| `tools/` | `tools/xtask`: `cargo xtask layers`, `assets`, `wasm`, `fixtures`, `ci` and `ai` |

Crates are named `kition-film-<dir>` (`crates/media/time` is `kition-film-time`); the exception is
`crates/kdm/kdm-model`, which is `kdm-model`. Layers and what each crate does are in
[architecture.md](architecture.md) §1.

Setup, the check every change passes and the pull-request rules are in
[CONTRIBUTING.md](../.github/CONTRIBUTING.md). The rules that must never be broken (never crash, assets,
clean-room code) are in [AGENTS.md](../AGENTS.md) and override everything here. This document
holds what is specific to working inside this repository. Read
[architecture.md](architecture.md) and the README of the crate you will change first.

## Build and test

```sh
cargo build -p kition-film                                    # the headless executable
cargo build --release -p kition-film                          # the same, optimized
cd web && pnpm install && pnpm engine && pnpm dev             # the editor, served at web/dev.html
cd web && pnpm test:flow                                      # the editor's flow tests
cargo test --workspace                                        # the engine
cargo xtask ci                                                # the check every change passes (docs/quality.md)
```

The Rust engine pins the public SDK revision in `Cargo.toml`.

Dev builds compile dependencies at `opt-level = 2` and workspace crates at `opt-level = 1` (the
codec crates listed in `Cargo.toml` at 3). For codec speed, use `--release`.

By default `pnpm install` in `web/` installs the published `@kition/sdk` and `@kition/tessera`
packages from npm, at the versions the committed `web/pnpm-lock.yaml` pins, so the editor needs no
other checkout. To work against local checkouts instead, run `KITION_LINK=1 pnpm install` in
`web/`: `web/.pnpmfile.cjs` then links `@kition/sdk` to the kition-sdk checkout's `packages/sdk`
and `@kition/tessera` to the kition-tessera checkout's `packages/tessera` next to this repository
(or the ones `KITION_SDK` and `KITION_TESSERA` name), each one whose package is there. Both
packages' `exports` point at their built `dist/`, so build them in the checkouts first. The linked
install rewrites `web/pnpm-lock.yaml`; do not commit that lockfile.

ffmpeg and ffprobe are optional: they are the test oracle and fixture generator only, and oracle
tests skip without them ([testing/README.md](testing/README.md) §2). H.264 and HEVC fixtures need an ffmpeg
built with libx264 and libx265.

`cargo xtask` is an alias in `.cargo/config.toml` for `cargo run -p xtask --`. Besides `ci`:
`cargo xtask layers` checks the dependency layering ([architecture.md](architecture.md) §1),
`cargo xtask assets` checks asset attribution, and `cargo xtask wasm` checks every L0–L4 crate and
`kition-film-kit` for `wasm32-unknown-unknown`.

The workspace takes its members by glob (`crates/*/*`, `bindings/*`, `tools/xtask`), so one broken
`Cargo.toml` breaks every build: keep every manifest valid, including half-finished crates. A
private `CARGO_TARGET_DIR` is fine: test fixtures always go to `<repo>/target/fixtures/`.

### Take the README pictures

The README's editor pictures (`assets/readme/hero.png`, `see-1.png` … `see-4.png`) are taken by
[`web/scripts/readme-shots.mjs`](../web/scripts/readme-shots.mjs) on kition-sdk's shared runner
(`tools/readme-shots/shots.mjs`). It starts the development host and opens the showcase samples
`film/six-places-beat-montage` and `film/aurora-title-card` from a kition-showcase checkout next to
this repository (or the one `KITION_SHOWCASE` names); both use the kit's procedural demo footage.
Each picture is taken at 1440 × 900, device scale 2, in the Classic display mode, light theme and
English. It needs the built engine in `web/public/` and a kition-sdk checkout next to this
repository (or `KITION_SDK`); it is a tool, not a test.

```sh
cd web
node scripts/readme-shots.mjs              # every picture, or name some: hero see-3
pngquant --quality 70-90 --force --ext .png ../assets/readme/hero.png ../assets/readme/see-*.png
```

Look at every picture before committing it, and keep each one under 400 KB. `made-1.png` …
`made-4.png` are the `thumb.png` of four showcase samples (`product-launch-title`,
`four-up-video-wall`, `neon-glitch-stream-intro`, `matchday-versus-split`), copied as they are.
Every picture has its `.attribution` sidecar and a row in [attribution.md](attribution.md)
(`cargo xtask assets`).

### Publish

Kition ships the kit's package, `kition-film-<version>.tgz` (the `film-ui/` folder), a release
asset of this repository tagged `package-v<version>`. It is built on GitHub, never on a developer
machine: the Package workflow (`.github/workflows/package.yml`, which calls Kition's reusable
`kit-package.yml`) builds the commit it is started on, with `gh workflow run package.yml -R
KitionAI/kition-film`, and publishes the Release with the package's lock entry,
`kition-film-<version>.json`. Kition pins it with `node scripts/pin-kits.mjs film` (see
`docs/kits.md` there). A version is published once: bump `version` in `kit.json` to publish a
change.

### Building with kition-fonts

Font assets live in [KitionAI/kition-fonts](https://github.com/KitionAI/kition-fonts), never in this
repo. It is an optional build input, not a Cargo dependency:

```sh
git clone https://github.com/KitionAI/kition-fonts ../kition-fonts
KITION_FONTS_DIR="$PWD/../kition-fonts" cargo build -p kition-film-kit
```

Use an absolute path: `build.rs` runs in `crates/support/text`, so a relative `KITION_FONTS_DIR` would
resolve from there. `crates/support/text/build.rs` reads its `fonts/manifest.txt` and embeds the fonts as
`kition_film_text::fonts::KITION_FONTS`. Without `KITION_FONTS_DIR`, `KITION_FONTS` is empty and the
kit uses its bundled fonts and those the host adds. A `KITION_FONTS_DIR` that is not a checkout is a
build warning, or an error with `KITION_FONTS_REQUIRED=1`. Tests on these fonts' glyphs skip when
it is empty; when you touch fonts, run the gates both with and without it.

## How to add…

### A command

1. Add a `cmd!` (action) or `query!` (read-only) entry to `build()` in
   `crates/engine/engine/src/commands.rs`. This is the real entry for `sequence.lift`:
   ```rust
   cmd!("sequence.lift", "Lift", ["Sequence"], Some(";"), "{}", has_in_out, |s, _| {
       let r = in_out_range(s)?;
       let tg = s.targeting().targeted;
       s.edit_sequence("Lift", |q, ctx, _| Ok(edit::lift(q, &tg, r, ctx)))?;
       Ok(Value::Null)
   }),
   ```
   - Id: `area.camelCase`, following the menu it appears in.
   - `enabled`: reuse a predicate (`always`, `has_seq`, `has_selection`, `has_in_out`, …) or write
     one that returns `Err("human reason")`.
   - Read time with `time_p` so `time`, `frame`, `seconds` and `timecode` all work.
   - Mutate only through `s.edit(…)` or `s.edit_sequence(…)`, so the change is undoable and
     validated.
   - Put pure timeline logic in `kition-film-edit` as a function on `&mut Sequence`, with unit or
     property tests there.
2. Add tests to `crates/engine/engine/src/tests.rs`: execute, assert, undo, redo, and check the disabled
   case.
3. The kit describes every command to agents in `bindings/wasm/src`: `descriptions.rs` says what it
   does and `reads.json` which editor state it reads (see `sequence.lift` in both);
   `bindings/wasm/tests/commands_described.rs` and `tests/acts.rs` check them. A new feature also
   gets an entry in `features.yaml` and a case ([quality.md](quality.md)).

### A video effect

1. Define it in `build_effects()` in `crates/engine/project/src/effect.rs` with the `video(id, name,
   CATEGORY, params)` helper. Parameter helpers cover floats with slider ranges, choices, bools,
   angles, points, colours, curves and wheels.
2. Implement it as a match arm in `render::effects::apply` (`crates/render/render/src/effects.rs`). It
   works on a linear-light premultiplied f32 `Image`. Scale pixel-size parameters by `cx.px_scale`
   so reduced-resolution playback matches full resolution. Unknown ids are a no-op.
3. Add a test in `crates/render/render/src/tests.rs`. This repository has no GPU compositor: every
   effect runs on the CPU.

Audio effects implement `AudioEffect` in `crates/engine/audio-dsp` and register in its `effects()`
registry. Then add an `audio(…)` definition in `effect.rs` and a `Mapping` from project parameters
to DSP parameters in `crates/render/render/src/audio_fx.rs`. The DSP must give the same output however the
stream is cut into blocks (there are tests for this).

### A transition

1. Define video transitions with `tr(id, name, FOLDER, badges, params)` in
   `crates/engine/project/src/vtransition.rs` (folders follow Premiere 26: ten `Video Transitions/*`
   folders plus `Legacy/Video Transitions`). Parameters are not animatable. Never rename an id:
   projects store it. Audio transitions are `EffectKind::AudioTransition` defs in `effect.rs`.
2. Implement it in the matching module of `crates/render/render/src/transitions/` (`wipe`, `motion`,
   `dissolve`, `lights`, `grunge`, `special`, `legacy`): read params through `Tx`, build pixels with
   `paint`, shape wipes with `wipe::field_wipe` (feather/border/anti-aliasing for free) and 3D moves
   with `cards`. Audio crossfade curves go in `transitions::audio_gains`. The property tests run over
   every transition automatically; re-bless `goldens.txt` (see [testing/README.md](testing/README.md) §3).
3. It can then be applied with `sequence.applyVideoTransition {"effect": "<id or name>", "params":
   {...}, "reverse": bool}` and edited with `sequence.setTransition`; `effects.list {"folder":
   "Video Transitions/Wipe", "detail": true}` lists it with its parameters.

### A codec or container crate

1. **Spec first.** Work only from the public specification (ITU-T, ISO/IEC, IETF RFCs, SMPTE,
   published container specs). Never copy GPL/LGPL code, and follow AGENTS.md §2 on reading other
   implementations. Name the spec edition in the crate README.
2. Create `crates/media/<name>` as an L0 crate that depends only on `kition-film-bitstream` (plus
   `thiserror` and optional `rayon` behind a `threads` feature). Add `[lints] workspace = true`, add
   it to `[workspace.dependencies]`, and add it to `LAYERS` in `tools/xtask/src/main.rs`. It must build
   for wasm32.
3. Test it against ffmpeg as an oracle (see [testing/README.md](testing/README.md)):
   - generate fixtures with ffmpeg on first use into `target/fixtures/<crate>/`;
   - skip with a message when ffmpeg is missing;
   - never commit media.
4. Wire it in:
   - decoders: a `VideoDecoderFactory` in `crates/media/codecs` (`video.rs`, default list in `lib.rs`);
   - containers: an `Opener` in `codecs::openers()`;
   - encoders: an `export::VideoEncoder` / audio encoder plus a `Format` in `crates/formats/export`.
5. Write the README: features, API, test matrix, accuracy and speed numbers, limitations. Use
   `crates/media/h264/README.md` as the model.

### An editor panel or widget

- The editor's panels live in `web/src/` (React, on `@kition/sdk/editor`). Project changes go through
  the engine's commands, never by mutating the document directly.
- Every label the editor draws needs its Chinese entry in the same change ([AGENTS.md](../AGENTS.md));
  `pnpm --dir web test:parity` checks it.
- Look at the result: `cd web && pnpm dev` and drive it in `web/dev.html`.

## Assets

The rules are in [AGENTS.md §1](../AGENTS.md#1-assets-no-adobe-artwork-every-asset-licensed-and-attributed).
In short:

- No Adobe iconography, images, fonts, LUTs, presets or other Adobe assets, in any form, including
  traced or "inspired-by" copies.
- Open licenses only (MIT, Apache-2.0, BSD, ISC, zlib, OFL, CC0, CC BY, CC BY-SA, or your own
  work under Apache-2.0). No NC or ND licenses. If the license is unclear, leave the asset out.
- Screenshots show only Kition Film (or other open projects) with media we generated or that is
  openly licensed.
- **Fonts live in [KitionAI/kition-fonts](https://github.com/KitionAI/kition-fonts), not here.**
  Don't commit new font files to this repo (the Latin fonts already in `assets/fonts/` stay): add
  the font to kition-fonts and use it through `kition_film_text::fonts::KITION_FONTS`. See
  [Building with kition-fonts](#building-with-kition-fonts).

For each asset file `X`, commit a sidecar `X.attribution` with the fields AGENTS.md §1 lists
(`assets/fonts/Inter-Regular.ttf.attribution` is an example). For your own work, use
`source: original work` and the project license (`Apache-2.0`).

Then add a row to [attribution.md](attribution.md) with the path in backticks. `cargo xtask
assets` checks every tracked file with a media extension (images, fonts, LUTs, audio, video, PDF,
project files…):

- the sidecar exists;
- `asset`, `title`, `author`, `source`, `license` and `added` are filled in;
- the license is not NC, ND, Adobe or proprietary;
- the path appears in `docs/attribution.md`;
- the path does not mention Adobe or Premiere;
- no sidecar is orphaned.

## Clean-room code

The rules are in [AGENTS.md §2](../AGENTS.md#2-clean-room-code). In short:

- Never read, disassemble or copy anything inside Adobe application bundles.
- Never copy GPL/LGPL/AGPL code. Implement codecs and formats from public specifications, and do
  not read the source of other decoders or encoders while implementing a format.
- ffmpeg and ffprobe are external test oracles and fixture generators only; they are never
  linked, bundled or shipped.
- Dependencies use permissive licenses (the list is in AGENTS.md §2).
