# Changelog

Changes to Kition Film, newest first. A version is the kit package version in `kit.json`;
each package is published with a `package-v<version>` tag.

## 0.1.1

- A host asks the document id a project file carries (`document.identity`) and forks a copied project (`document.fork`), Kit Process Protocol section 5.6 (kition-sdk 6672663). A `.kfilm` is the project as JSON and embeds no replica, so it carries no identity and its fork is the same bytes.
- The headless program speaks Kit Process Protocol version 1 (`headless.protocol` is `kition-kit/1`), as hosts on kition-sdk from bb1b07b require.

## 0.1.0

First public release of the source, under the Apache License 2.0. It contains:

- The Rust engine: projects of bins, sequences, video and audio tracks and clips; razor, trims,
  roll, slip, slide and rate stretch on exact integer time; markers and In/Out points; titles with
  CJK text; effects, keyframes and masks; video and audio transitions and the audio mix; captions,
  multi-camera editing and color grading. Every feature is a command with a stable id.
- Pure-Rust media written from public specifications: decoders and containers for MP4/MOV, MKV/WebM,
  MXF, MPEG TS/PS and Ogg, and export to MP4 with H.264 and AAC, with no ffmpeg.
- The kit engine (`kition-film-kit`), native and WebAssembly: the project is a KDM replica,
  replicas merge concurrent edits, and the person and the agent each undo their own steps. A check
  catalogue reports offline or missing media, gaps and other problems a project cannot carry.
- The headless kit (`kition-film`) for agents over the Kit Protocol: it reads a project's timeline,
  edits it with the editor's own commands, previews a frame or a contact sheet, and works in drafts.
  A write names the revision it read and is refused when someone else changed what it rests on. It
  reads nothing outside its workspace.
- The kit's editor (`web/`): the Source and Program monitors, the multi-track timeline, Effect
  Controls, the Markers panel and the Project panel, in kit-editor's frame.
- NOTICE and docs/attribution.md list the upstream work, the fonts and every asset, and Loro
  (MIT), bundled by the editor and linked by the engine.
