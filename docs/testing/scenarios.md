# Independent Film regression scenarios

These tests run against Kition Film alone and require no other app, source checkout, server, or generated expected-output files. The existing two-second sample is original project media; export fixtures are generated as color mattes, bars and tone by Film, or as original H.264 footage by external FFmpeg. Expected frame colors, linear-light blends, timing and audio gain come from explicit constants and formulas, never another application's output file.

| ID | Scenario and observable outcome | Coverage |
| --- | --- | --- |
| F01 | Razor cuts linked picture and sound; durations conserved; undo/redo/save/reopen | Chromium + WebKit |
| F02 | Host-denied timeline move changes nothing; a fresh allowed drag succeeds | Chromium + WebKit |
| F03 | Deny/allow during a held move cancels the old intent | Chromium + WebKit |
| F04 | Viewer can seek but cannot cut via keyboard or Razor | Chromium + WebKit |
| F05 | Pending media picker cannot import into a replacement project | Chromium + WebKit |
| F06 | Revoking/restoring import permission cancels the outstanding picker | Chromium + WebKit |
| F07 | Graphic creation interrupted by permissions or new project; no late shape | Two variants per browser |
| F08 | Cancel while export bytes transfer: no output; subsequent export succeeds | Chromium + WebKit |
| F09 | Tail trim shortens linked video/audio by 12 frames; history and reopen | Chromium + WebKit |
| F10 | Locked video is unchanged by Add Edit while unlocked audio splits | Chromium + WebKit |
| F11 | Clear removes linked clips; undo and save/reopen restore their ranges | Chromium + WebKit |
| F12 | Export six red frames: ffprobe verifies H.264, 64×36, 24 fps, 0.25 s; ffmpeg checks every frame; repeat export preserves first file | Chromium + WebKit + external oracles |
| F13 | Inclusive source In/Out inserted or overwritten into a four-second matte; exact ranges, linked sound, sequence marks, undo/redo/reopen | Two variants per browser |
| F14 | Unfinished Pen path is cancelled on project or sequence replacement; no graphic or history entry leaks | Two variants per browser |
| F15 | Permission interruption while Type waits for real layer data closes the pending field and discards early typing | Chromium + WebKit |
| F16 | Pending Sequence Settings defaults discarded after replacement project/sequence or permission interruption | Three variants per browser |
| F17 | Huge forward frame step preserves direction; a subsequent ordinary cut and undo still work | Chromium + WebKit |
| F18 | Sequence Settings preview/Cancel changes no content or history; OK/undo/redo/save/reopen preserve new size and Unicode name | Chromium + WebKit |
| F19 | UI 50% speed with ripple doubles middle linked clip length and moves following video/audio once; undo/redo/reopen; no ResizeObserver errors | Chromium + WebKit |
| F20 | AAC export has stereo 48 kHz, 1 kHz test tone and expected RMS; muted-track export decodes to silence | Chromium + WebKit + FFmpeg/ffprobe |
| F21 | Make Offline scratch preview/Cancel leaves live media online; commit/relink/undo/redo/reopen retain exact clip ranges | Chromium + WebKit |
| F22 | Delayed older dialog cannot replace the newer dialog or discard its typed draft | Chromium + WebKit |
| F23 | Type accepts Unicode and multiline text; Escape restores shortcuts; undo/redo/save/reopen retain content | Chromium + WebKit |
| F24 | Pending Begin Text Editing is cancelled across a permission interruption; a fresh shortcut still works | Chromium + WebKit |
| F25 | Nest two colored shots through UI/history/reopen; child source ranges exact; actual export has six red then six blue frames | Chromium + WebKit + FFmpeg |
| F26 | Lift retains In/Out and a gap; Extract clears marks and closes the gap; both retain exact linked source ranges/history/reopen | Two variants per browser |
| F27 | Host storage failure is visible, writes no partial output, preserves the document, and permits a fresh export | Chromium + WebKit |
| F28 | Export permission revoke/restore during byte transfer cancels the old export; fresh export succeeds | Chromium + WebKit |
| F29 | Real truncated media over HTTP range reads is rejected without project changes; valid import/history/reopen recover | Chromium + WebKit |
| F30 | 24, 25, 29.97 and 59.94 fps: fixed-seed mixed edits preserve exact linked ranges, no overlaps, each undo/redo, and reopen; action logs attached | Four variants per browser, 24 edits each |
| F31 | Original FFmpeg-generated H.264 imports through real ranged reads; normal and 2× reverse exports have every expected colored frame; history/reopen | Chromium + WebKit + FFmpeg |
| F32 | Focused numeric field: one OK click commits, Cancel discards, dragging away commits nothing | Three variants per browser |
| F33 | Pending dialog submit is cancelled across replacement project, permission interruption or newer dialog; a fresh authorized OK still submits an existing draft | Four variants per browser |
| F34 | Cross Dissolve retains handles/history/reopen and exports the expected linear-light blend on all 24 frames | Chromium + WebKit + FFmpeg |
| F35 | Real HTTP 404 reports media missing; restoring and relinking recovers online status without changing edit ranges | Chromium + WebKit |
| F36 | Audio Gain Cancel preserves content; +6 dB survives undo/redo/reopen and multiplies decoded stereo RMS by the expected factor | Chromium + WebKit + FFmpeg |
| F37 | Copy/Paste Insert duplicates linked picture/sound, ripples once, and creates an independent link; clear/history/reopen | Chromium + WebKit |
| F38 | Project save storage failure preserves old bytes, timeline and dirty status; retry/reopen succeeds | Chromium + WebKit |
| F39 | An edit during pending storage write remains dirty; second save/reopen retains both edits | Chromium + WebKit |
| F40 | Two-track opacity keyframes export the exact linear-light blend; disabling upper clip reveals lower track; history/reopen | Chromium + WebKit + FFmpeg |
| F41 | 29.97/59.94 fps exports retain exact frame counts, red/blue cut boundary and AAC duration | Two variants per browser + FFmpeg/ffprobe |
| F42 | Project replacement reusing sequence/clip IDs cancels a held drag; fresh drag/undo still work | Chromium + WebKit |
| F43 | Native source drag held across permission revoke/restore is discarded, including browser-retained data; fresh linked drag/undo works | Chromium + WebKit |
| F44 | Original H.264 with verified B-frames imports through ranged reads; nonzero source trim/reopen/reverse exports retain every expected presentation frame | Chromium + WebKit + FFmpeg/ffprobe |
| F45 | Cross-sequence Paste / Paste Insert refuse missing tracks; adding tracks preserves both layers, history and reopen | Two variants per browser |
| F46 | Deleted clipboard sources are refused atomically; undo restores a usable clipboard | Two variants per browser |
| F47 | Clipboard cannot nest a sequence into itself; new project clears old clipboard despite reused IDs | Chromium + WebKit |
| N11 | Missing video/audio destination tracks cannot collapse layers or drop linked sound | Native SDK |
| N12 | Deleted source refusal preserves saved bytes, selection/history; undo and paste/reopen recover | Native SDK |
| F48 | Held master fader is cancelled on project/sequence change; fresh volume edits retain history/reopen | Two variants per browser |
| F49 | Old audio automation cannot target reused IDs; fresh Latch pass writes one undoable set of saved keyframes | Chromium + WebKit |
| F50 | Old multicam pass cannot reapply cuts to a replacement project; fresh cuts retain undo/redo/reopen | Chromium + WebKit |
| N13–N15 | Automation, held master fader, and multicam recording cannot mutate replacement contexts | Native SDK |
| F51 | Multicam switch and Flatten preserve all 48 red/blue export frames, source ranges, history and reopen | Chromium + WebKit + FFmpeg |
| N16 | Real background proxy/transcode results cannot mutate a replacement project or relinked source | Native engine, four cases |
| F52 | Real proxy attachment changes monitor pixels; export retains full-resolution originals; wrong duration is refused and reopen retains references | Chromium + WebKit + FFmpeg |
| F53 | Fit and 200% remain centered after frame/context changes; edits preserve the view and reopen remains usable | Two variants per browser |
| F54 | Latch recording holds released gain until the next touch; decoded stereo RMS follows the saved envelope | Chromium + WebKit + FFmpeg |
| F55 | Invalid first caption is atomic; initial cue/track use one undo step and survive reopen | Chromium + WebKit |
| F56 | Caption pixels obey cue boundaries and track visibility after reopen | Chromium + WebKit |
| N17–N18 | Actual scene analysis and mask tracking cannot apply old results after reopening a project | Native engine |
| N19–N20 | Invalid first-caption transactions preserve bytes/history; successful initial cue and track undo together | Native SDK |
| F57 | Deleting a parent source/bin refuses when a dependent subclip survives; explicit deletion, undo/reopen restore usable red video | Two variants per browser |
| F58 | Remix cannot reuse music analysis after replacement project or relink to silence; real music recovers through history/reopen | Two variants per browser |
| F59 | A nonzero subclip range preserves linked video/audio, history/reopen, 12 exported picture frames and real stereo 1 kHz tone | Chromium + WebKit + FFmpeg |
| N21–N22 | Parent-source/bin deletion preserves surviving subclips; explicit combined deletion remains undoable | Native SDK |
| N23 | Remix cache cannot apply another document's beats to silent media with reused IDs | Native engine |
| N24–N25 | Subclips use parent image dimensions and preserve linked, actually audible parent audio | Native engine |
| F60 | Moving a clip discards obsolete scene-analysis cuts; fresh analysis uses its new position, one history step and reopen | Chromium + WebKit |
| N26 | Scene analysis cannot apply obsolete cuts/markers/subclips after moving, deleting or relinking its inputs | Native engine, three cases |
| N27 | Removing a tracked mask cannot redirect old paths into the next mask at its former index | Native engine |
| N28 | Unrelated track renaming and switching active sequences preserve valid scene results and their undo step | Native engine |
| F61 / N29 | Import BOM/CRLF Unicode multiline captions into an empty project as one complete undo/redo/reopen operation, via captions and file import | Browser + native engine |
| N30 | An old synthetic voice-over take cannot write files or insert clips after project replacement; discard and fresh recording recover with real PCM | Native engine |
| F62 / N31 | Undo/redo restores an otherwise missing sequence tab; ordinary history respects deliberately closed tabs | Browser + native engine |
| F63 | Changing timeline selection while Begin Text Editing awaits a real Worker reply cancels the old field; fresh editing, undo and reopen still work | Browser |
| F64 | Convert a subclip to independent master media, remove its former parent, undo/redo/reopen and decode all 12 exported frames | Chromium + WebKit + FFmpeg |
| F65 / N32 | Audio-only subclips inherit the first channel map, including split-to-mono tracks; decoded output includes 880 Hz and excludes 440 Hz | Browser + native engine |
| F66 / N33 | Invalid source/timeline audio channel integers and types fail atomically; valid mapping still supports history and persistence | Browser + native engine |
| F67 / N34 | Replace from Bin, Source and Source Match Frame updates linked subclip video/audio and channel mapping together; history and reopen | Browser + native engine |
| N35 | Audio-only, video-only and AV subclip rows display the same stream flags and format metadata as their actual parent media | Native engine |
| F68 / N36 | Linked replacement cannot modify locked video or audio tracks; failure is atomic and unlocking restores normal replacement | Browser + native engine |
| F69 / N37 | A 60 fps subclip Source monitor and item-frame API use its parent rate; exact media frames and Project-row frame duration agree | Browser + native SDK |
| F70 | Agent-driven Source seeks refresh the resting clock and picture without a document revision, including ordinary media | Chromium + WebKit |
| F71 / N39 | Short, nonzero subclip ranges draw and scrub only their own frames in Icon/Freeform views, with correct cursor position and reopen | Browser + native engine |
| F72 / N38 | Explicit 60 fps poster frames keep the exact parent/subclip image through cache changes, undo/redo and reopen | Browser + native engine |
| F73 / N40 | New Sequence From Clip remains one complete history step at capacity; a compound operation preserves all but one old step even when its intermediates exceed the limit | Browser + native engine |
| F74 / N41 | Failed Automate to Sequence rolls back its insert gap, editor state and full history at capacity; a fresh valid command remains undoable and persistent | Browser + native engine |
| F75 / N42 | Consolidate Duplicates preserves distinct source dimensions/rates and actual pixels; true duplicates still remap dependent subclips through history/reopen | Browser + native engine |
| F76 / N43–N45 | Cross-rate consecutive Paste / Paste Insert preserves preceding linked clips; shared cuts/markers conform together, colliding short cuts refuse atomically, and one short clip still fits a frame | Browser + native engine |
| F77 / N46 | New Sequence From Clip refuses atomically when an empty sequence cannot be placed as individual clips; preserve project, active context and redo branch before/after history capacity, then verify successful creation, undo/redo and reopen | Browser + native engine |
| F78 / N47 | Applying a graphics template and changing multiple template controls each remain one complete undo step at history capacity; preserve older steps, redo and saved text | Browser + native engine |
| F79 / N48 | Invalid template application or property batches restore content, editor context and an existing redo branch, including after 205 edits; valid recovery survives reopen | Browser + native engine |
| F80 / N49 | Upgrading multiple captions to graphics remains one complete undo step at history capacity; undo restores captions and removes all generated graphics, redo/reopen preserve the result | Browser + native engine |
| F81 / N50 | Upgrading a locked caption refuses without leaving generated graphics or changing history; unlock, upgrade, undo/redo and reopen recover normally | Browser + native engine |
| F82 / N51 | Exporting a graphics template preserves source content and ordinary/full history, including an existing redo branch; repeated exports are deterministic, exported controls work independently, undo/redo and project reopen retain content | Four variants per browser + native engine |
| F83 | A render arriving before the Program viewport's first layout cannot consume the chosen 200% magnification; releasing the real delayed ResizeObserver preserves that choice, including through a subsequent edit | Chromium + WebKit |
| F84 | Disabling a held guide or ruler drag cancels it immediately, including when restored before release; Program/Source guides stay unchanged, fresh creation/movement works, and sequence content/history are untouched | Twelve variants per browser |
| F85 | Program/Source In, Out and marked-range movement cancel on permission interruption or real pointer-capture loss; marks, draft and history are unchanged, and fresh edits support undo/redo/reopen | Twelve variants per browser |
| F86 | Interrupted Program/Source scrubbing stops pending seeks; a held or subsequently released pointer cannot revive it, an external seek updates the clock, and a fresh scrub works | Four variants per browser |
| F87 | Held Source waveform scrubbing cancels on source replacement or permission interruption in audio-only and split views; replacement starts at zero, old input cannot seek, fresh clicking works, and sequence/history are unchanged | Four variants per browser |
| F88 | Out-of-order proxy preference replies cannot revert Program/Source toggle indicators; enabled and disabled states agree with the real engine, fresh toggles work, and sequence/history stay unchanged | Two variants per browser + deferred-read unit tests |
| F89 | Pending Source inspect/preferences and queued frame-step keys cancel on source replacement, project replacement with reused IDs, or switching away and back; fresh one/five-frame steps preserve order and sequence/history | Six variants per browser + three async-stage unit cases |
| F90 | Fresh Source keys progress while the former context’s inspect/preferences reply is held; releasing the old queue preserves the new playhead and ordered one/five-frame steps | Six variants per browser + three async-stage unit cases |
| F91 | Pending Source play, In-to-Out, to-Out and preroll requests cancel on Stop, source replacement or project replacement with reused IDs; fresh playback works without changing sequence/history | Twelve variants per browser + 22 playback unit cases |
| F92 | Queued Source scrubs cannot seek a replacement source/project, including reused item IDs; Stop settles the current source’s latest seek, fresh scrubs recover without sequence/history edits | Three variants per browser + seven queue unit cases |
| F93 | Source Play/to-Out starts at the latest queued scrub; range playback waits before seeking its explicit start; fresh scrubs progress while obsolete source/project replies remain held | Six variants per browser + seven handoff unit cases |
| F94 | Source keyboard frame steps wait for the latest scrub, preserve forward/backward and configured multi-frame offsets, and retain every rapid key; Go to In/Out transport destinations remain correct | Six variants per browser + seven invoke/playback integration unit cases |
| F95 | Source Shift+I/O replaces queued scrubs and reanchors running playback/audio; stale navigation reads cancel on source/project replacement or newer navigation/scrub, with explicit target precedence and unmarked boundaries | Four variants per browser + twelve invoke/playback integration unit cases |
| F96 | Source I/O keys and buttons capture the latest queued/playing frame without waiting for seek acknowledgements; marks retain order, context, frame bounds and undo/redo/save persistence | Six variants per browser + fourteen invoke/playback integration unit cases |
| F97 | Source clear In/Out/both and explicit-time marks follow earlier implicit marks; queued edits retain target/context, cancel on replacement, and preserve clear undo/redo/save order | Three variants per browser + ten invoke queue unit cases |
| F98 | Pending Source I/O and Undo/Redo retain input order through shortcuts, menus and toolbar; later marks branch history correctly, context replacement cancels old queued intent, and save/reopen retains final marks | Five variants per browser + twelve invoke history unit cases |
| N01–N10 | Native exact linked cuts, locked partner movement, atomic rejected multi-move, linked trim, hostile parameters, redo branching, extreme playhead stepping, Unicode subtitle split/merge/lock/SRT, damaged-project mutations; 205 edits exercise the 200-step undo limit, complete undo/redo and branching; save/reopen | Rust SDK integration |
| Time extremes | Saturating signed arithmetic, direction preservation, rational timestamp and damaged-rate boundaries; normal/exotic-rate round trips retained | Rust time crate |

Browser fixtures start a private Vite server with watching/HMR disabled, a new browser context per test, and the actual WASM Worker. Delayed host/Worker requests are released to the real implementation; successful replies are never fabricated. Scenarios use zero retries and one browser worker to keep failures visible and avoid overlapping long flows.


## Running

Install `web/` dependencies with `pnpm --dir web install --frozen-lockfile`, which takes the published `@kition/*` packages from npm as CI does; only `KITION_LINK=1` makes `web/.pnpmfile.cjs` link `kition-sdk` and `kition-tessera` checkouts instead. Rust SDK is pinned separately in the Cargo manifests/lockfile. The current CI uses Node 22.19.0, pnpm 10.16.1, Rust 1.99.0, wasm-pack 0.13.1 and Playwright 1.59.1.

```sh
pnpm --dir web engine
pnpm --dir web exec playwright install chromium webkit
pnpm --dir web test:scenarios
pnpm --dir web test:ci
pnpm --dir web test:ci:full
```

ffmpeg and ffprobe must be on PATH for the export browser oracle, or set `KITION_FILM_FFMPEG` and `KITION_FILM_FFPROBE`. They are external test tools, never linked or shipped. CI installs them and sets `KITION_FILM_REQUIRE_ORACLES=1`. Image-sequence and codec fixture helpers fail when a required fixture cannot be generated. A local FFmpeg build needs the relevant encoders, including `libwebp` for WebP; a binary being present alone does not prove those checks ran. Rust logs include successful-test output so internal skips remain visible.

The PR gate checks formatting/layers/asset attribution, builds, runs unit/parity/native checks (including the complete engine unit suite and SDK scenarios) and Chromium scenarios. Main/nightly/manual full runs add WebKit, the display modes, existing long browser flows, all Rust workspace tests (including media/container/export oracles), and strict workspace Clippy. CI needs no secrets. Two optional task-specific parity checks skip when `FILM_TASK` is unset. Optional external font/model fixtures and hardware encoders are separate coverage boundaries; inspect the Rust stage log for their skip messages.

`web/test-results/browser.xml` and `web/playwright-report/` contain per-scenario results. Failed tests retain screenshot/trace artifacts. `web/test-results/ci/` contains each stage's actual output, exit status, elapsed time and stage-level JUnit. A later failure never converts an earlier failure into a pass, and remote CI must still be run after publication.

For a local isolated web checkout, `FILM_CARGO_ROOT=/absolute/path/to/native/checkout` may reuse its native build artifacts. The CI runner hashes Rust sources, manifests, Cargo configuration and bundled assets in both roots and refuses mismatches. Normal CI needs no override; the chosen roots and source hash are recorded in `stages.json`.

The mixed-edit scenario defaults to 24 actions per rate/browser for CI. An extended deterministic session can run up to 180 actions (below the separate 200-step retention test):

```sh
FILM_EDIT_WALK_STEPS=180 pnpm --dir web exec playwright test edit-walk.spec.mjs
```

Each action log records the rate, seed, requested step count and actual commands. Assertions check exact linked ranges, frame alignment, no overlaps and undo/redo at every step.

## Reproducing a specific failure

Browser scenario IDs are stable and appear in test titles, logs and the JUnit report. Native scenarios generally use an `nNN_` test-name prefix; N16–N18 retain descriptive test names. Search the test sources for the ID to find a scenario. For example, run the pending-dialog cases only in WebKit:

```sh
pnpm --dir web exec playwright test --project=webkit --grep '^F33 '
cargo test --locked -p kition-film-kit --test editing_scenarios
cargo test --locked -p kition-film-time --test extremes
pnpm --dir web exec playwright show-report
```

For CI failures, download the workflow artifact and inspect the failed stage log first. Browser artifacts include the failing screenshot and Playwright trace. Long-flow failures print their document/Worker state and recent console errors into the stage log; the separate `web/tests/shots.mjs` tool produces visual-review screenshots and is not a pixel-diff gate.

The 180-action session is an optional extended run; standard CI uses 24 actions per rate/browser. With a custom reporter, include JSON or HTML to preserve the attached deterministic action list; list/JUnit alone records results without retaining those in-memory attachments.
