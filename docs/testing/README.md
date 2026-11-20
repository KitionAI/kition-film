# Testing

```sh
cargo test --workspace                          # everything; oracle tests skip without ffmpeg
cargo test -p kition-film-h264                    # one crate
cargo test --release -p kition-film-hevc          # codec tests are much faster in release
cargo xtask ci                                  # all gates (fmt, clippy, tests, layers, assets, wasm)
cargo xtask fixtures                            # pre-generate the ffmpeg fixture matrix
KITION_FILM_REQUIRE_ORACLES=1 cargo test --workspace   # CI: missing ffmpeg fails instead of skipping
```

## 1. Kinds of tests

| Kind | Where | Examples |
|---|---|---|
| Unit | `src/` `#[cfg(test)]` modules, `src/tests.rs` | CABAC engines, VLC tables (prefix-freeness, Kraft sums), colour matrices, frame cache |
| Property (`proptest`) | `time`, `bitstream`, `edit`, `isobmff/tests/roundtrip.rs`, `interchange/tests/*` | tick↔frame round trips for every rate, DF timecode, edit invariants (no overlaps, durations conserved), mux→demux round trips, interchange export→import |
| Synthetic streams | `h264/src/synth_tests.rs`, `hevc/src/synth_tests.rs` | hand-built bitstreams for features the reference encoders don't emit; expected output known exactly |
| Editor | `web/src/**/*.test.mjs`, `web/parity/check.test.mjs`, `web/tests/flow.mjs`, `web/tests/modes.mjs`, `web/tests/scenarios/` | the editor's own modules under `node --test` (key router, playback clocks, monitor view options, dialogs, timeline gestures), its labels and their translations, the flow and every display mode in Chromium and WebKit, and the regression scenarios (§4) |
| Graphics menu | `crates/engine/engine/src/graphics_tests.rs` | new text and shape layers, vertical text, align to frame / as group / to selection, distribute (centres and gaps), arrange, select next/previous graphic and layer, reset parameters / duration, New Layer from file |
| Settings | `crates/engine/engine/src/settings_tests.rs` | schema keys and defaults, persistence in the data directory, v1 → v2 migration and repair of bad values, validation, per-category reset; each wired setting (still / transition durations, step many, label defaults and colours, media scaling, timebase, recent projects, media cache policy, output mapping, smart quotes, auto-transcribe) |
| Scopes and panels | `crates/engine/scopes/src/tests.rs`, `crates/engine/engine/src/{scopes,panels}_tests.rs` | scope maths on generated frames (flat colours → exact histogram bins, ramps → waveform row = code value, 75 % bars → parade levels and vectorscope target cells for BT.601/709/2020, HLS hue angles, YC chroma, Clamp Signal, decimation, NaN); `scopes.read` on a colour matte (exact bins, 78.43 %) and on Bars and Tone (the six targets); metadata edits (one undo step, read-only fields refused, saved in the project), the event log (failed / disabled commands, repeats, jobs started / finished / failed / cancelled); `perf_scopes_at_1080p` (ignored) times each scope |
| Keyframe navigator | `crates/engine/engine/src/tests.rs` (`add_keyframe_toggles_the_keyframe_at_the_playhead`) | `effects.addKeyframe` adds a keyframe at the playhead or removes the one there (the value falls back to the remaining keyframes; undo, redo, parameters that name nothing) |
| Engine / command | `crates/engine/engine/src/tests.rs` | run commands on the demo project, assert the sequence, undo/redo, disabled cases |
| Render | `crates/render/render/src/tests.rs` | compositing, opacity, Motion, cross dissolve midpoint, ½-res vs full, frame plan (`render::plan`) vs reference, audio mix, audio-effect continuity |
| Multi-camera / sync | `crates/engine/audio-dsp/src/sync.rs`, `crates/engine/engine/src/multicam_tests.rs` | audio offsets within one sample: Rust-generated multi-mic speech (gains −20…+10 dB, SNR 40/25/10/3 dB, zero-phase colouring, fractional delays, a 0 dB-SNR room with a −4 dB echo) and ffmpeg-made camera/recorder files (pink-noise bursts, independent noise; exact lags recovered); timecode (± hours) and marker sync within a frame; Merge Clips; timeline Synchronize keeps frame-aligned starts; multicam structure, angle render (PSNR vs the camera), Switch Audio mix = the angle's track, live switching from a simulated playback clock (cuts, healing, one undo step), Ctrl+N cuts, flatten (frames identical), save/load; 20 angles: paging (auto / 2×2 / 3×3), page-relative keys, absolute cameras beyond 16, a page decoding only its angles at the cell scale (recording source), Auto-Adjust scale, Selection Top Down; `perf_grid_of_four_1080p_angles` (ignored) prints the grid cost |
| Project panel and Media Browser | `crates/engine/engine/src/{project_panel,media_browser}_tests.rs` | view settings and their preference round trip; Metadata Display columns (custom fields, Freeform keys hidden), numeric vs text sorting, view presets (save / save as / restore / rename / delete, ten slots, persisted in `preferences.json`); Freeform moves keeping offsets, snapping, Align to Grid, Clip Size, stacks, arrangements, Reset (each one undo step, saved in the project); bin rename / nesting; the Media Browser against a fake filesystem (folders first, hidden and unsupported files left out, file-type filter, back / forward / up, recent directories, Favorites, import of a selection or a folder, Open in Source Monitor, ingest, probe columns) |
| Menu long tail | `crates/render/render/src/scene.rs`, `crates/engine/engine/src/{scene_detect,sequence_extras,project_tools}_tests.rs`, `crates/formats/interchange/src/ale.rs`, `crates/engine/project/src/find.rs` | Scene Edit Detection on synthetic frames (hard cuts vs pans, flashes, sensitivity) and on generated movies with known cut points (our own ProRes render of demo scenes; an ffmpeg-made H.264 concat of testsrc2 / SMPTE bars / Mandelbrot): cuts with linked audio, clip markers, subclips, one undo step, background job and cancel; Normalize Mix Track to a target peak; Simplify Sequence; Find / Find Next and search bins; Automate to Sequence (overlap, transitions, insert, unnumbered markers); ALE round trip; Project Settings and scratch disks |
| Mixer | `crates/render/render/src/mixer_tests.rs`, `crates/engine/engine/src/mixer_tests.rs` | sample-exact fader gain and pan laws, automation at block boundaries (bit-identical however requests are cut), solo/mute/solo-safe, sends and submix routing, latency-compensation alignment, render-vs-playback identity, Touch ramp-back, recorder modes (Latch/Touch/Write), thinning, Audio Gain, transition curves; `perf_24_tracks_3_effects_realtime_factor` prints the realtime factor |
| 5.1 / multichannel | `crates/engine/audio-dsp/src/channels.rs`, `crates/render/render/src/mixer_tests.rs`, `crates/formats/export/src/surround_tests.rs`, `crates/engine/engine/src/mixer_tests.rs` | BS.775 downmix / upmix coefficients exact, mixdown types; 5.1 panner point gains equal-power (Σg² = 1 over a 21×21 grid × 3 centre settings), speaker positions exact, 5.1 through the default puck bit-exact identity; graph: stereo/mono tracks into a 5.1 Mix (L/R, C, rear right, room centre −6 dB each, LFE = mean), 5.1 track through a 5.1 Mix and folded into stereo, a 5.1 submix, `pan51` automation block-invariant, six-channel meters; export: 6-ch WAV (`WAVE_FORMAT_EXTENSIBLE`, mask 0x3F) and ProRes MOV (6 × 24-bit PCM) decoded by ffmpeg **sample-exact**, ffprobe `channels` 6 / `channel_layout` 5.1; AAC 5.1 in MP4: every decoded channel's own tone ≥ 30 dB above the others' (no swapped channels), stereo export of a 5.1 Mix = BS.775 within 2·10⁻⁶; `sequence.settings {mix}`, `file.newSequence {mix, trackType}`, panner lanes, Write pass records the puck |
| Audio Clip Mixer automation | `crates/engine/engine/src/mixer_tests.rs` | Touch: a 201-point fader ramp thins to ≤ 6 clip keyframes, values within 0.1 dB, live override while held, values outside the gesture unchanged, one undo step; Latch holds until stop; Write records volume and pan from the start; a gesture across two clips writes both; Read commits once without a pass |
| Voice-over | `crates/engine/engine/src/voiceover_tests.rs` | synthetic click train lands in `mix_sequence` exactly at R + k·period (pre-roll dropped, exact sample count), punch-in between In/Out (ramp source, every sample checked), one undo step + undo/redo, take numbering, record-arm/targeting track choice, sync/discard/zero-length/locked cases, cue times |
| Remix | `crates/engine/audio-dsp/src/remix.rs`, `crates/render/render/src/remix.rs`, `crates/engine/engine/src/remix_tests.rs` | generated rhythmic music (Rust-synthesised drums, bass, chord sections at 90–128 BPM, 22.05/44.1/48 kHz): tempo within 0.3 BPM, every beat within 10 ms (measured ≤ 8.9 ms); remix targets from 0.4× to 2.2× the source within one beat (measured ≤ 12 ms at default sliders), every cut on a detected beat, intro and outro kept, pieces ≥ 4 beats, deterministic; silence, tone and noise refused; rendering independent of request cuts, source-exact outside the 20 ms equal-power crossfades, no clicks; the engine's mix equals the source pieces (< 1e-5); undo, redo and revert exact; overlaps refused |
| Oracle | `crates/*/tests/*oracle*.rs`, `conformance.rs` | compare with ffmpeg/ffprobe (§2) |
| Robustness / fuzz | `*/tests/robustness.rs`, `*/tests/fuzz.rs` | seeded mutation and truncation of real and synthetic files; nothing may panic |
| Performance | `*/tests/perf.rs` (`#[ignore]`) | §5 |

Commit `*.proptest-regressions` files so failing cases are re-run.

## 2. ffmpeg oracle tests

ffmpeg and ffprobe are **external processes** used to generate fixtures and to check results. They
are never linked or shipped ([AGENTS.md](../../AGENTS.md) §2).

- The tools are found by `kition-film-testkit` (a dev-dependency-only crate, `crates/support/testkit`), in
  this order: `KITION_FILM_FFMPEG` / `KITION_FILM_FFPROBE` (explicit paths; a wrong path is an error),
  then every directory on `PATH` (`ffmpeg` and `ffmpeg.exe`), then well-known install directories
  (`/opt/homebrew/bin`, `/usr/local/bin`, `/usr/bin`, `C:\ffmpeg\bin`, …).
- If a tool is missing the test prints `SKIPPED (<test>): ffmpeg not found …` and passes. Set
  **`KITION_FILM_REQUIRE_ORACLES=1`** (CI) to make every such skip a failure. In new tests use
  `let ff = kition_film_testkit::require_ffmpeg!();` (also `require_ffprobe!`, `require_oracles!`).
- The oracles are version-dependent: fixtures are written by the ffmpeg at hand and checked
  against its ffprobe, and older releases differ (FFmpeg 6.1 has no APV support, fails libvpx-vp9
  two-pass encodes, and its ffprobe gives the trimmed final AC-3 block of a Matroska fixture a full
  frame's duration where the demuxer reads 8 ms).
  The tests are kept green against FFmpeg 9.0; CI installs a pinned, checksum-verified static
  FFmpeg 9.0.2 build (`.github/workflows/film-scenarios.yml`) instead of the distribution's
  package. The APV oracle treats an ffmpeg without an APV decoder (before 8.0) like a missing one.
- Fixtures are generated on first use into `<workspace>/target/fixtures/<crate>/`
  (`kition_film_testkit::fixtures_dir`; independent of `CARGO_TARGET_DIR`, so agents with private
  target dirs share them; `KITION_FILM_FIXTURES_DIR` overrides the root) and reused afterwards.
  Generators write to a per-process/thread temporary name (`testkit::temp_path`) and rename it into
  place, so concurrent tests never see half-written files. Delete the directory to regenerate.
  Never commit media.
- Every crate's `tests/common/mod.rs` delegates discovery and fixture paths to testkit, except
  `crates/media/codecs/src/tests.rs`, which has its own lookup.
- `cargo xtask fixtures [crate…]` pre-generates the whole fixture matrix up front (useful before a
  parallel test run or on a fresh machine). It runs each crate's ignored `generate_fixtures` test —
  the same generators the oracle tests call — for `h264`, `hevc`, `isobmff`, `matroska`, `dnx`,
  `prores`, `mpeg2v`, `ac3` and `codecs` (MXF, Ogg and MPEG TS / PS), and prints one `made` / `cached` / `skipped` line per fixture plus a summary. The
  `aac`, `opus` and `h264enc` oracles generate small per-test signals on demand and are not part of
  the matrix.
- Fixture sources are synthetic: `testsrc2`, `mandelbrot`, SMPTE bars, noise and fades, sine tones.
  H.264 and HEVC fixtures need ffmpeg built with libx264 and libx265. The VP9 and AV1 fixtures
  (libvpx-vp9, libaom-av1; 360p, 1080p, 2160p, hidden alt-ref frames, two GOPs) need an ffmpeg with
  those encoders.

### Pass criteria per codec

| Crate | Oracle check | Criterion |
|---|---|---|
| `h264` | decode every fixture single-threaded and frame-threaded; compare with `ffmpeg -f rawvideo -pix_fmt yuv420p` | **bit-exact**, every frame |
| `hevc` | same, `yuv420p` / `yuv420p10le` | **bit-exact** (8- and 10-bit) |
| `h264enc` | `ffmpeg -v warning -err_detect +crccheck+bitstream+buffer+explode` decodes our stream | no output at all (a `corrupt decoded frame` warning fails; a negative control checks dropped and truncated slices are reported), exact frame count, **bit-identical to the encoder's reconstruction**; B-frame order checked with ffprobe; rate-control targets |
| `prores` decode | ffmpeg `prores_ks` / `prores_aw` fixtures, compared at native depth | within **±1 LSB** (different integer IDCT); alpha bit-exact |
| `prores` encode | ffmpeg decodes with `-xerror` | no errors; agrees with our decoder within ±1 |
| `dnx` decode | ffmpeg VC-3 fixtures (13 DNxHD CIDs, DNxHR LB/SQ/HQ/HQX/444), compared at native depth | within **±2 LSB**, ≤ 100 samples per million beyond ±1 (ffmpeg's integer IDCT; we evaluate the exact IDCT) |
| `dnx` encode | ffmpeg decodes with `-xerror` | no errors; agrees with our decoder within ±2; HQ luma PSNR ≥ 45 dB |
| `aac` decode | ffmpeg's decode of the same stream | max abs error ~1e-7 (float) |
| `aac` encode | ffmpeg decodes our stream | no errors, no clipping, CBR within ±5% of target; SNR reported |
| `isobmff` | `ffprobe -show_packets` on ffmpeg-made MP4/MOV | packet offsets, sizes, pts/dts, durations, key flags and stream parameters equal; remuxed files decode with `ffmpeg -v error` silent |
| `matroska` | `ffprobe -show_packets` | every packet (stream, size, key flag, pts, duration) equal; seeks land on the latest keyframe ≤ target |
| `audio-dsp` loudness | `tests/loudness_oracle.rs`: signals generated in Rust (997 Hz sine, pink noise at 48/96 kHz, speech-like bursts at 48/44.1 kHz, stereo with silence and sub-gate passages, an fs/4 inter-sample-peak tone) written as float WAV and measured with `ffmpeg -af ebur128=peak=true:metadata=1` | momentary and short-term every 100 ms **±0.1 LU**, integrated **±0.1 LU**, LRA **±0.5 LU**, true peak **±0.2 dB** (against the analytic value when one exists). Measured: ΔM/ΔS ≤ 0.0005 LU, ΔI ≤ 0.007 LU, ΔLRA ≤ 0.04 LU, ΔTP ≤ 0.045 dB against ffmpeg. On the fs/4 tone ffmpeg's own true peak is +0.6 dB high (−0.32 vs the analytic −0.92 dBTP); ours is −0.05 dB |
| `audio-dsp` effects | `src/effects/premiere_tests.rs`, `src/design.rs`, registry tests in `src/effects/mod.rs`: generated tones, noise and impulses | every effect: neutral settings = delayed identity (≤ 2·10⁻⁴), bit-exact determinism, latency constant and equal to where an impulse lands, block-size independence, finite / denormal-free tails at extreme settings, > 1× realtime; per effect a level or frequency-response check (measured tone vs analytic `response_db` within 0.1–0.2 dB, Butterworth vs closed form 10⁻⁶ dB, Chebyshev/elliptic ripple and stop-band bounds, LR4 crossover sum flat within 0.02 dB, comb-notch depth, echo positions to the sample, Schroeder RT60 of generated impulses within 25 %, click repair −20 dB) |
| `mxf` (via `codecs/tests/mxf_oracle.rs`) | ffmpeg-written OP1a / OP-Atom / D-10 files decoded by ffmpeg | H.264 (long GOP, B pictures without temporal offsets) **bit-exact** every frame and at 25 random seeks; DNxHR ±2, ProRes ±1; PCM / AES3 **sample-exact**; frame count = ffprobe packets; timecode (25 fps, 29.97 DF); MPEG-2 long GOP, XDCAM HD422 (1080i 4:2:2) and D-10 / IMX (720×608 4:2:2) within ±4 (`mpeg2v` criterion); truncation/mutation never panics |
| `mpeg2v` | ffmpeg-encoded MPEG-1/2 elementary streams (progressive, TFF/BFF interlaced, 4:2:2 intra and long GOP, 1080i, escapes + custom matrices, MPEG-1) and our synthetic streams with field pictures / 16x8 / dual prime / concealment vectors, decoded by ffmpeg (`-xerror`) | per frame max ±4 and PSNR ≥ 58 dB, ≤ 3 % of samples differing (ffmpeg's integer IDCT vs our IEEE 1180-accurate one; measured max ±1-3, 65-75 dB); frame count, display order, picture types, interlacing and field order **exact** (ffprobe); IEEE 1180 procedure passes |
| MPEG TS / PS (via `codecs/tests/mpeg_oracle.rs`) | ffmpeg-written TS (MPEG-2 + MP2, H.264 + AAC, HEVC + LATM AAC), BDAV `.m2ts` / `.mts` (H.264 + Blu-ray LPCM / AC-3), VOB (MPEG-2 + MP2 / DVD LPCM 16 and 24-bit / AC-3), MPEG-1 system streams, `.m2v`; MPEG-2 in MOV (XDCAM `xd5c`), MP4 (`mp4v`), MKV | frame count and every frame's **PTS exact** (ffprobe); H.264 / HEVC **bit-exact**, MPEG-2 within the `mpeg2v` criterion; random seeks = sequential decode; LPCM **sample-exact**; AAC ≤ 2.1·10⁻⁷, MP2 (symphonia) ≤ 3.2·10⁻⁵, AC-3 ≤ 5·10⁻³ (decoder-specific dither; measured 2.3·10⁻³); random-access audio = sequential |
| `ac3` | ffmpeg AC-3 encodes (2/0 with coupling and rematrixing, 1/0 32 kHz, 3/2+LFE 448 kb/s, noise) decoded by ffmpeg | SNR per channel ≥ 40-60 dB on tonal content (measured 66-94 dB), ≥ 18 dB on noise (27.7 dB, the same as between two of our own dither seeds) |
| `ogg` (via `codecs/tests/ogg_oracle.rs`) | ffmpeg (libopus, Vorbis) files decoded by libopus / ffmpeg | length **exact** (pre-skip, end trimming); SNR ≥ 50 dB CELT (measured 77.7), ≥ 10 dB SILK, Vorbis 139 dB; random seeks within 6·10⁻⁶ of the continuous decode |
| MP4 audio at another rate (`codecs/tests/mp4_oracle.rs`) | ffmpeg-written AAC in MP4 (48 kHz, edit list skipping the priming) | reads resampled to 44.1 kHz in frame-sized requests equal the native decode interpolated at the same times (difference < 10⁻⁴, peak ≤ the source level) |
| image sequences / BWF (`codecs/tests/media_oracle.rs`) | ffmpeg-written PNG/TIFF/BMP/JPEG stills read by ffmpeg's image2 demuxer; ffmpeg BWF (`-write_bext`) | PNG/TIFF/BMP **exact**, JPEG ±12 (measured 3); missing frames hold the previous one; BWF TimeReference = ffprobe's, start timecode, samples exact |
| `export` | our own demuxer/decoder reads the file back; ffprobe counts frames when present | expected size, duration, colour, audio level; exact frame count |
| `export` settings and presets | `export/src/settings_tests.rs`, engine `export_tests.rs`: every built-in preset exports a slice of the demo sequence; ffprobe reads codec, profile, size, rate, audio format and data rate; our decoders read pixels back | codec / profile / container / size / `r_frame_rate` / sample format exact; H.264 bitrate ≤ VBR max × 1.1 and ≥ ½ target over 3 s; ProRes ≤ 1.5 × nominal; DNxHR within 25 % of nominal; loudness normalization within **0.5 LU** of the target (WAV and AAC), true peak ≤ ceiling + 0.1 dB; image sequences numbered `<name>000…`; limiter, overlays, metadata (`title`/`copyright` tags), MOV multiplexer, two-pass/CBR progress |

Each codec README has the full fixture matrix and the measured results.

## 3. Rendering: the CPU compositor

This repository has no GPU compositor: `kition-film-render` renders every frame on the CPU, for the
editor's monitors and for export.

- Its tests check computed values (opacity blends, dissolve midpoints, Motion placement,
  ½-resolution against downsampled full resolution) and that `render::plan` matches
  `render_sequence` (`plan_matches_reference_renderer`).
- Per-effect unit tests live in `crates/render/render/src/vfx/tests.rs` (identity at neutral
  parameters, determinism, range, a known value each, temporal/track effects through the
  compositor).
- **Video transitions** (`crates/render/render/src/transitions/tests.rs`) are checked for every transition
  (84 modern, 21 Legacy, 7 hidden Obsolete): p = 0 is exactly the outgoing frame and p = 1 exactly
  the incoming one, near both ends the output is close to that frame (continuity), the midpoint differs
  from both, the output is finite and deterministic (also on 1×1 / odd sizes and NaN progress), every
  parameter visibly changes the picture, and every direction differs. Golden *fingerprints* (4×4 mean
  RGB grid at p = 0.25/0.5/0.75, ±4 levels) live in `src/transitions/goldens.txt`; re-bless with
  `KITION_FILM_BLESS=1 cargo test -p kition-film-render golden_fingerprints` and review the diff.
  `KITION_FILM_TRANSITION_SHEETS=<dir> cargo test -p kition-film-render contact_sheets -- --ignored`
  writes one contact-sheet PNG per folder for eyeballing (never commit them).

### Audio mixing and colour

Audio mixing engine tests (`crates/engine/engine/src/audio_mixing_tests.rs`) build projects from
generated speech-like and tonal WAVs: Auto-Match lands within ±0.5 LU of the target (measured: 0.000 LU,
with and without a repair/clarity chain) and measures a mono clip as one channel (3.01 LU below the
same signal as dual mono, within 0.1 LU of a one-channel meter over the file); ducking on a dialogue +
music project gives keyframes within 60 ms of the expected times (measured 20 ms) and −15.00 dB in the
mix; each repair stage improves its metric through the render path (hum −39 dB, rumble −22 dB, noise
floor −13 dB, sibilance −19 dB, reverb tail −10 dB); the mix is bit-identical however requests are cut
and the WAV export equals it.
`perf_full_dialogue_chain_realtime_factor` (ignored; run with `--release`) prints the realtime factor of
all nine Dialogue effects on one clip (22× on one core).

Colour science tests: `kition-film-color` (curve round trips and published reference values per
camera log curve, BT.709/BT.2087 matrices, BT.2390 EETF, gamut mapping, LUT tetrahedral vs a
brute-force barycentric reference, `.cube`/`.3dl` round trips), `render::colorman`,
`render::color_match`, engine `color_tests.rs`, and `export::tests::hdr_exports_signal_pq_and_hlg`
(PQ/HLG exports read back by our demuxer and by ffprobe: `color_transfer`, `color_primaries`,
`color_space`, mastering display and content light side data).

## 4. The editor (`web/`)

The editor's tests run from `web/` (build the engine first with `pnpm engine`):

| Command | What it runs |
|---|---|
| `pnpm test:unit` | the editor's own modules under `node --test` (`src/**/*.test.mjs`) |
| `pnpm test:parity` | `parity/check.test.mjs`: the parity manifest's items against its status file, the menus against the engine's commands, and a Chinese catalog entry for every label the editor draws |
| `pnpm test:flow` | `tests/flow.mjs` in Chromium and WebKit: the editor's flow through the development host, a PASS or FAIL per step |
| `pnpm test:modes` | `tests/modes.mjs` in Chromium and WebKit: the editor in each display mode |
| `pnpm test:scenarios` | the Playwright regression scenarios in `tests/scenarios/` ([scenarios.md](scenarios.md)) |
| `pnpm test:ci`, `pnpm test:ci:full` | `scripts/test-ci.mjs`: every stage once, with logs ([scenarios.md](scenarios.md)) |

### Interactive checks

For visual work, run the editor in the development host and drive it:

```sh
cd web && pnpm install && pnpm engine && pnpm dev   # then open web/dev.html
```

`node web/tests/shots.mjs [webkit|chromium]` writes screenshots of the editor at two sizes, dark and
light, to `web/tests/shots/` (gitignored, never committed). Look at every screenshot. Agents drive
the same engine headless through `kition-film` (`cargo build -p kition-film`); the kit's tools are in
[agent/guide.md](../../agent/guide.md).

## 5. Performance

| Benchmark | Command |
|---|---|
| H.264 decode, 1080p, threads sweep | `cargo test --release -p kition-film-h264 --test perf -- --ignored --nocapture` |
| HEVC decode, 1080p / 2160p | `cargo test --release -p kition-film-hevc --test perf -- --ignored --nocapture` |
| ProRes decode/encode | `cargo test --release -p kition-film-prores --test perf -- --ignored --nocapture` |
| Encoder speed / PSNR / bitrate | `cargo run --release -p kition-film-h264enc --example h264enc_synth -- …` |
| CPU compositor, ms per frame | `cargo run --release -p kition-film-render --example frame_bench` |
| Coding-tool coverage of the fixtures | `cargo test --release -p kition-film-h264 --test conformance coverage_report -- --ignored --nocapture` (same for `hevc`) |

The perf tests check bit-exactness before they time anything. Results go in the crate README's
performance table, with machine and thread count. Measure on an idle machine: parallel agent
builds distort timings.

### Audio mixer throughput

`perf_24_tracks_3_effects_realtime_factor` (24 tracks, 72 inserts and a compressed submix on one
core) must run at least 4x realtime in release builds (1x in debug). On Unix it times the test
thread's CPU time, so it runs with the rest of the suite. Hosts without a per-thread CPU clock
(Windows) fall back to wall time, which depends on load, so there it is ignored by default; run it
explicitly with
`cargo test --release -p kition-film-render --lib perf_24_tracks_3_effects_realtime_factor -- --ignored --nocapture`
and record the machine with the result.
