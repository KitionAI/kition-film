# Gaps

> **Last updated:** 2026-11-17 · **Source:** `features.yaml` (updated 2026-11-17) and the engine's command list

Every known shortfall of Kition Film, from the feature catalogue: features that are not yet `has`,
then the differences recorded on features that work. Update the feature in `features.yaml` when you
land work, then this list. The comparison with the target application is in
[parity/target-app-parity.md](parity/target-app-parity.md); the order of work is in [roadmap.md](roadmap.md).

## Features not done

- `film.agent.premises` (P0, partial): A write with basis is refused only for others' changes to what its command reads, and a place in time is replayed exactly.
- `film.audio.mixing` (P1, partial): Audio track and clip mixers, the Audio Mixing panel, scrubbing and voice-over. The engine has these commands; no case yet shows the area working end to end in the editor and surviving save and reopen.
- `film.captions.edit` (P1, partial): Caption tracks, captions, styles, import and export. The engine has these commands; no case yet shows the area working end to end in the editor and surviving save and reopen.
- `film.clip.properties` (P1, partial): Clip properties, subclips, speed, frame hold, audio gain, linking, nesting and multicam clips. The engine has these commands; no case yet shows the area working end to end in the editor and surviving save and reopen.
- `film.color.grade` (P1, partial): Colour grading, LUTs, colour spaces and scopes. The engine has these commands; no case yet shows the area working end to end in the editor and surviving save and reopen.
- `film.edit.history` (P1, partial): Undo, redo, history, cut, copy, paste, paste attributes, clear and ripple delete. The engine has these commands; no case yet shows the area working end to end in the editor and surviving save and reopen.
- `film.edit.select-find` (P1, partial): Select, find, remove unused, consolidate duplicates and edit original. The engine has these commands; no case yet shows the area working end to end in the editor and surviving save and reopen.
- `film.effects.keyframes` (P1, partial): Effects, keyframes, transitions and masks. The engine has these commands; no case yet shows the area working end to end in the editor and surviving save and reopen.
- `film.export.media` (P1, partial): Export media and graphics templates; the export queue and background jobs. The engine has these commands; no case yet shows the area working end to end in the editor and surviving save and reopen.
- `film.file.import` (P1, partial): Import, replace and other File menu commands. The engine has these commands; no case yet shows the area working end to end in the editor and surviving save and reopen.
- `film.file.interchange` (P1, partial): EDL, AAF, OMF, ALE, OTIO and Final Cut XML interchange. The engine has these commands; no case yet shows the area working end to end in the editor and surviving save and reopen.
- `film.file.new-items` (P1, partial): New sequences, bins and synthetic media (bars and tone, mattes, leaders). The engine has these commands; no case yet shows the area working end to end in the editor and surviving save and reopen.
- `film.file.projects` (P1, partial): Create, open, close, save, save as, save a copy and revert projects; project settings. The engine has these commands; no case yet shows the area working end to end in the editor and surviving save and reopen.
- `film.file.recovery` (P1, partial): Auto-save and recovery of projects. The engine has these commands; no case yet shows the area working end to end in the editor and surviving save and reopen.
- `film.graphics.template` (P1, partial): Motion graphics templates. The engine has these commands; no case yet shows the area working end to end in the editor and surviving save and reopen.
- `film.graphics.titles` (P1, partial): Graphics and titles: text, shapes, layers, alignment and fonts. The engine has these commands; no case yet shows the area working end to end in the editor and surviving save and reopen.
- `film.markers.in-out` (P1, partial): In and out points, markers, chapters and flash cues. The engine has these commands; no case yet shows the area working end to end in the editor and surviving save and reopen.
- `film.media.management` (P1, partial): Media status, relink, offline, proxies and the media cache. The engine has these commands; no case yet shows the area working end to end in the editor and surviving save and reopen.
- `film.multicam.edit` (P1, partial): Multi-camera editing. The engine has these commands; no case yet shows the area working end to end in the editor and surviving save and reopen.
- `film.project.panel` (P1, partial): Project panel: bins, views, columns, freeform layout, metadata and the media browser. The engine has these commands; no case yet shows the area working end to end in the editor and surviving save and reopen.
- `film.sequence.manage` (P1, partial): Sequences: tabs, settings, render, match frame, transitions, gaps, tracks, nesting and through edits. The engine has these commands; no case yet shows the area working end to end in the editor and surviving save and reopen.
- `film.source.playhead` (P1, partial): Source monitor and playhead navigation. The engine has these commands; no case yet shows the area working end to end in the editor and surviving save and reopen.
- `film.timeline.edit` (P1, partial): Place, move, trim, roll, slip, slide, rate stretch and razor clips; track targeting. The engine has these commands; no case yet shows the area working end to end in the editor and surviving save and reopen.
- `film.transcript.edit` (P1, partial): Transcripts, text-based editing and captions from transcripts. The engine has these commands; no case yet shows the area working end to end in the editor and surviving save and reopen.
- `film.trim.mode` (P1, partial): Trim mode and edit points. The engine has these commands; no case yet shows the area working end to end in the editor and surviving save and reopen.
- `film.app.presets` (P2, partial): Effect presets. The engine has these commands; no case yet shows the area working end to end in the editor and surviving save and reopen.
- `film.app.shortcuts` (P2, partial): Keyboard shortcuts, preferences, help and diagnostics. The engine has these commands; no case yet shows the area working end to end in the editor and surviving save and reopen.
- `film.edit.labels` (P2, partial): Label colours. The engine has these commands; no case yet shows the area working end to end in the editor and surviving save and reopen.
- `film.export.presets` (P2, partial): Export presets. The engine has these commands; no case yet shows the area working end to end in the editor and surviving save and reopen.

## Differences on working features

- `film.timeline.basics`: The playhead is not saved: a reopened project starts at 0, where Premiere Pro reopens a sequence where it was left.

## Catalogue

The catalogue has 48 features: 19 `has`, 29 not yet.
