# Target-app parity

> **Last updated:** 2026-11-17 · **Source:** `features.yaml` (updated 2026-11-17) and the engine's command list

Each feature in `features.yaml` records its status against what the feature promises and, where it
has one, the target application it is compared with (Premiere Pro 2026 (26.5)).
The difference column is the feature's recorded gap.

| Feature | Priority | Status | Target | Difference |
| --- | --- | --- | --- | --- |
| `film.agent.act` An agent trims clips in frames | P0 | has | — | — |
| `film.agent.context` An agent's call names the sequence, time and clips it acts on, and leaves the editor's playhead, open sequence, targets and selection as they were | P0 | has | — | — |
| `film.agent.ids` Receipts, others and the premise guard name bins, items, tracks, clips and transitions by the ids film_inspect lists, which the file keeps | P0 | has | — | — |
| `film.agent.observe` An agent reads the timeline and marks what it finds | P0 | has | — | — |
| `film.agent.places` A write by time or track has as premise the clips under that place, and a clip's start and duration are its place, not its content | P0 | has | — | — |
| `film.agent.premises` A write with basis is refused only for others' changes to what its command reads, and a place in time is replayed exactly | P0 | partial | — | — |
| `film.agent.recover` An agent fixes what the check reports | P0 | has | — | — |
| `film.audio.basics` Clip gain, clip volume keyframes, track volume and pan, and the mix level survive saving and reopening | P0 | has | Premiere Pro 2026 (26.5) | — |
| `film.effects.basics` Applied effects, parameter values, keyframes and masks survive saving and reopening | P0 | has | Premiere Pro 2026 (26.5) | — |
| `film.graphics.text-basics` A title with CJK text, its fill, scale and rotation survives saving and reopening | P0 | has | Premiere Pro 2026 (26.5) | — |
| `film.markers.basics` Sequence markers with names, comments, colours and durations, and In/Out points survive saving and reopening | P0 | has | Premiere Pro 2026 (26.5) | — |
| `film.sequence.add-edit` Cut linked clips at a time (Add Edit); the cut survives undo, redo, saving and reopening | P0 | has | Premiere Pro 2026 (26.5) | — |
| `film.timeline.basics` Razor cuts, trims, track settings, clip names and speed survive saving and reopening | P0 | has | Premiere Pro 2026 (26.5) | The playhead is not saved: a reopened project starts at 0, where Premiere Pro reopens a sequence where it was left. |
| `film.transitions.basics` Video and audio transitions survive saving and reopening | P0 | has | Premiere Pro 2026 (26.5) | — |
| `film.agent.draft` An agent works in a draft over a conversation | P1 | has | — | — |
| `film.agent.preview` An agent previews a sequence at a time, or a contact sheet over a range, whatever the editor shows | P1 | has | — | — |
| `film.audio.mixing` Audio track and clip mixers, the Audio Mixing panel, scrubbing and voice-over | P1 | partial | Premiere Pro 2026 (26.5) | The engine has these commands; no case yet shows the area working end to end in the editor and surviving save and reopen. |
| `film.captions.edit` Caption tracks, captions, styles, import and export | P1 | partial | Premiere Pro 2026 (26.5) | The engine has these commands; no case yet shows the area working end to end in the editor and surviving save and reopen. |
| `film.clip.properties` Clip properties, subclips, speed, frame hold, audio gain, linking, nesting and multicam clips | P1 | partial | Premiere Pro 2026 (26.5) | The engine has these commands; no case yet shows the area working end to end in the editor and surviving save and reopen. |
| `film.color.grade` Colour grading, LUTs, colour spaces and scopes | P1 | partial | Premiere Pro 2026 (26.5) | The engine has these commands; no case yet shows the area working end to end in the editor and surviving save and reopen. |
| `film.edit.history` Undo, redo, history, cut, copy, paste, paste attributes, clear and ripple delete | P1 | partial | Premiere Pro 2026 (26.5) | The engine has these commands; no case yet shows the area working end to end in the editor and surviving save and reopen. |
| `film.edit.select-find` Select, find, remove unused, consolidate duplicates and edit original | P1 | partial | Premiere Pro 2026 (26.5) | The engine has these commands; no case yet shows the area working end to end in the editor and surviving save and reopen. |
| `film.editor.display-modes` The editor in each display mode (Menus, Single line, Classic, Focus); Focus shows the Program monitor alone | P1 | has | — | — |
| `film.effects.keyframes` Effects, keyframes, transitions and masks | P1 | partial | Premiere Pro 2026 (26.5) | The engine has these commands; no case yet shows the area working end to end in the editor and surviving save and reopen. |
| `film.export.media` Export media and graphics templates; the export queue and background jobs | P1 | partial | Premiere Pro 2026 (26.5) | The engine has these commands; no case yet shows the area working end to end in the editor and surviving save and reopen. |
| `film.file.import` Import, replace and other File menu commands | P1 | partial | Premiere Pro 2026 (26.5) | The engine has these commands; no case yet shows the area working end to end in the editor and surviving save and reopen. |
| `film.file.interchange` EDL, AAF, OMF, ALE, OTIO and Final Cut XML interchange | P1 | partial | Premiere Pro 2026 (26.5) | The engine has these commands; no case yet shows the area working end to end in the editor and surviving save and reopen. |
| `film.file.new-items` New sequences, bins and synthetic media (bars and tone, mattes, leaders) | P1 | partial | Premiere Pro 2026 (26.5) | The engine has these commands; no case yet shows the area working end to end in the editor and surviving save and reopen. |
| `film.file.projects` Create, open, close, save, save as, save a copy and revert projects; project settings | P1 | partial | Premiere Pro 2026 (26.5) | The engine has these commands; no case yet shows the area working end to end in the editor and surviving save and reopen. |
| `film.file.recovery` Auto-save and recovery of projects | P1 | partial | Premiere Pro 2026 (26.5) | The engine has these commands; no case yet shows the area working end to end in the editor and surviving save and reopen. |
| `film.graphics.template` Motion graphics templates | P1 | partial | Premiere Pro 2026 (26.5) | The engine has these commands; no case yet shows the area working end to end in the editor and surviving save and reopen. |
| `film.graphics.titles` Graphics and titles: text, shapes, layers, alignment and fonts | P1 | partial | Premiere Pro 2026 (26.5) | The engine has these commands; no case yet shows the area working end to end in the editor and surviving save and reopen. |
| `film.markers.in-out` In and out points, markers, chapters and flash cues | P1 | partial | Premiere Pro 2026 (26.5) | The engine has these commands; no case yet shows the area working end to end in the editor and surviving save and reopen. |
| `film.media.management` Media status, relink, offline, proxies and the media cache | P1 | partial | Premiere Pro 2026 (26.5) | The engine has these commands; no case yet shows the area working end to end in the editor and surviving save and reopen. |
| `film.multicam.edit` Multi-camera editing | P1 | partial | Premiere Pro 2026 (26.5) | The engine has these commands; no case yet shows the area working end to end in the editor and surviving save and reopen. |
| `film.platform.document-text` document.text: titles and captions as plain text for a host's search, cut at a limit | P1 | has | — | — |
| `film.platform.engine-contract-2` Engine contract 2 with the KDM schema, served headless with the replica methods and the object model | P1 | has | — | — |
| `film.project.panel` Project panel: bins, views, columns, freeform layout, metadata and the media browser | P1 | partial | Premiere Pro 2026 (26.5) | The engine has these commands; no case yet shows the area working end to end in the editor and surviving save and reopen. |
| `film.sequence.manage` Sequences: tabs, settings, render, match frame, transitions, gaps, tracks, nesting and through edits | P1 | partial | Premiere Pro 2026 (26.5) | The engine has these commands; no case yet shows the area working end to end in the editor and surviving save and reopen. |
| `film.source.playhead` Source monitor and playhead navigation | P1 | partial | Premiere Pro 2026 (26.5) | The engine has these commands; no case yet shows the area working end to end in the editor and surviving save and reopen. |
| `film.text.add-font` A program adds a font file for text the bundled faces do not cover | P1 | has | — | — |
| `film.timeline.edit` Place, move, trim, roll, slip, slide, rate stretch and razor clips; track targeting | P1 | partial | Premiere Pro 2026 (26.5) | The engine has these commands; no case yet shows the area working end to end in the editor and surviving save and reopen. |
| `film.transcript.edit` Transcripts, text-based editing and captions from transcripts | P1 | partial | Premiere Pro 2026 (26.5) | The engine has these commands; no case yet shows the area working end to end in the editor and surviving save and reopen. |
| `film.trim.mode` Trim mode and edit points | P1 | partial | Premiere Pro 2026 (26.5) | The engine has these commands; no case yet shows the area working end to end in the editor and surviving save and reopen. |
| `film.app.presets` Effect presets | P2 | partial | Premiere Pro 2026 (26.5) | The engine has these commands; no case yet shows the area working end to end in the editor and surviving save and reopen. |
| `film.app.shortcuts` Keyboard shortcuts, preferences, help and diagnostics | P2 | partial | Premiere Pro 2026 (26.5) | The engine has these commands; no case yet shows the area working end to end in the editor and surviving save and reopen. |
| `film.edit.labels` Label colours | P2 | partial | Premiere Pro 2026 (26.5) | The engine has these commands; no case yet shows the area working end to end in the editor and surviving save and reopen. |
| `film.export.presets` Export presets | P2 | partial | Premiere Pro 2026 (26.5) | The engine has these commands; no case yet shows the area working end to end in the editor and surviving save and reopen. |

| Priority | has | partial | missing |
| --- | ---: | ---: | ---: |
| P0 | 13 | 1 | 0 |
| P1 | 6 | 24 | 0 |
| P2 | 0 | 4 | 0 |
