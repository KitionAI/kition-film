# Project files

Kition Film projects are `.kfilm` files: UTF-8 JSON with an explicit format version. Reading and
writing them is `crates/formats/format` (`kition-film-format`); the engine's `file.*` commands use it.

## Format

```json
{
  "format": "kition-film.project",
  "schema_version": 1,
  "generator": "Kition Film 0.1.0",
  "project": { "name": "…", "settings": { … }, "root": { … }, "items": { … }, "next_id": 48 },
  "view": { "open_sequences": [21, 50], "active_sequence": 50, "sequences": { "21": { "pps": 40.0, "scroll": 0.0, … } } }
}
```

- `schema_version` is the version of the whole document: 1. This build reads and writes
  `kition_film_format::SCHEMA_VERSION` and no other.
- `project` is the serialized `kition_film_project::Project` (bins, media clips, sequences, tracks,
  clips, effects, keyframes, markers). Media is referenced by path, never embedded.
- Files are written compact (no indentation). A 2,000-clip project is about 1.4 MB.
- `view` (optional) is what was open when the project was saved: the Timeline's sequence tabs in
  order, the active one, and each sequence's zoom, scroll and track heights
  (`kition_film_project::ProjectView`). It is beside the project, not in it: it is not part of the
  edit, never an undo step, and changing it does not mark the project as changed. Opening a
  project restores it when the Timeline preference "Restore open sequences when opening projects"
  is on. It is outside the project: ids that are not sequences and
  numbers out of range are dropped or clamped, and a `view` that cannot be read is ignored (the
  project opens on its first sequence, as it does without one or with no open sequence in it).
- A coordinate of an effect's point parameter may be `null`. Point parameters use NaN for "auto"
  (the frame centre, or the source centre for `anchor`), and JSON writes NaN as `null`; it reads back
  as "auto". Placing a clip resolves these points at once. An interchange import resolves them
  too, except the `anchor` of a clip whose media file was not found. That one stays "auto", and
  the renderer centres it, until Link Media (`media.relink`, `media.autoRelink`) reads the file
  and with it the real picture size; a file that merely comes back at its old path does not
  change it. `null` anywhere else is a damaged file.

### Other versions

There is no upgrade chain. A file whose `schema_version` is not 1 (a file from a development build
before the format was fixed, or one from a future build) is **refused**, not half-read:

> this project file is format version 13; this build of Kition Film reads version 1 only

Reading it partially and saving it back would silently drop or garble what the other version wrote.

## Saving is atomic

Every write of a project file, auto-save, recovery snapshot or preferences file goes through
`kition_film_format::atomic_write`:

1. write the bytes to a hidden temp file in the **same directory** (`.<name>.<pid>-<n>.tmp`);
2. `fsync` the temp file;
3. rename it over the target (an atomic replace on every supported OS);
4. `fsync` the directory so the rename itself is durable.

A crash, `kill -9` or power cut at any point leaves either the complete old file or the complete new
one. If a step fails, the temp file is removed and the old file is untouched.

## Commands

| Id | Menu | |
|---|---|---|
| `file.save {path?}` | File ▸ Save (⌘S) | write to the project's path (or `path`) |
| `file.saveAs {path}` | File ▸ Save As… (⇧⌘S) | write and adopt the new path |
| `file.saveCopy {path}` | File ▸ Save a Copy… (⌥⌘S) | write a copy; the project keeps its path and unsaved state |
| `file.revert` | File ▸ Revert | reload the last saved version, discarding changes |
| `file.open {path}` | File ▸ Open Project… (⌘O) | returns `{path, schemaVersion, missingMedia}` |

In the editor the host opens and saves the document: `file.open`, `file.save`, `file.saveAs`,
`file.saveCopy` and `file.revert` are not shown there (`web/src/menus/hidden.ts`).

## Auto Save

The engine implements Premiere's auto-save and a recovery journal
(`crates/engine/engine/src/autosave.rs`), but this kit starts neither: only tests call
`Session::start_autosave`, the kit's sessions reach files only through the host, and the editor
does not show File ▸ Recover. This section and the next describe the engine.

Preferences ▸ Auto Save works like Premiere's:

| Setting | Key | Default |
|---|---|---|
| Automatically save projects | `autoSave.enabled` | on |
| Automatically Save Every N minute(s) | `autoSave.intervalMinutes` | 5 (1–1440) |
| Maximum Project Versions | `autoSave.maxVersions` | 20 (1–1000) |
| Auto Save also saves the current project(s) | `autoSave.saveCurrentProject` | off |
| Keep a recovery copy of unsaved changes | `autoSave.recoveryJournal` | on |
| Update it at least every N second(s) | `autoSave.recoveryIntervalSeconds` | 5 (1–600) |

At each interval, if the project changed since the last auto-save, a copy is written to the
`Auto-Save` folder next to the project as `<name>-YYYY-MM-DD_HH-MM-SS.kfilm` (local time). An
unsaved project uses `<data dir>/Auto-Save/`. After each write the oldest copies beyond the limit are
deleted. Only files named exactly `<name>-<timestamp>.kfilm` are ever deleted. An auto-save is an
ordinary project file: open it with File ▸ Open Project. `file.listAutoSaves` lists them, newest
first.

The `prefs.*` commands read and change the preferences ([Settings](#settings)).

## Crash recovery

Premiere's auto-save can lose up to one interval of work. The engine's **recovery journal** covers that:

- Whenever the project has unsaved changes, a snapshot is written to
  `<data dir>/Recovery/<started>-<pid>[-<n>]/snapshot.kfilm`, plus `session.json` (time, revision, project
  name and path). It is written about 1 s after the last edit, or after at most
  `recoveryIntervalSeconds` while edits keep coming. Saving the project deletes the snapshot.
- Each running journal holds an OS file lock on `<session>/lock`. When the process dies (crash,
  `kill -9`, power loss) the OS releases the lock.
- When the journal starts, every other session directory whose lock can be taken and that has a
  snapshot is a recovery candidate (`file.recoveryList`). Stale directories without a snapshot are
  removed. Journals of running sessions are never touched.
- Recovering loads the snapshot as an **unsaved** project with its original path, so Save writes
  over the original file. The recovered state goes into the new session's own journal before the old
  journal is deleted.
- A clean shutdown with nothing unsaved removes the session directory; with unsaved changes it keeps
  the snapshot, marked `cleanExit`.

### Cost

The UI thread only gives the worker thread an `Arc<Project>`: the immutable snapshot the engine
already keeps for undo, passed through a channel. JSON encoding and all file I/O run on the
`kition-film-autosave` thread. Measured on the development Mac (release build) with a 2,000-clip project
(`cargo test --release -p kition-film-format --test fixtures -- --nocapture`):

| Step | Time | Size |
|---|---|---|
| encode, compact (what is written) | 2.5 ms | 1.4 MB |
| encode, pretty (not used) | 7.1 ms | 5.6 MB |
| decode | 4.6 ms | |
| atomic write + fsync (APFS SSD) | 30 ms | |

## Commands

| Id | |
|---|---|
| `file.recoveryList` | candidates: `id`, `projectName`, `projectPath`, `savedAt`, `revision`, `cleanExit`… |
| `file.recover {id?}` | recover (newest when no `id`) |
| `file.discardRecovery {id?, all?}` | delete a candidate's journal |
| `file.autoSaveNow` | write an auto-save now (if anything is unsaved) |
| `file.autoSaveStatus` | prefs, folders, last auto-save / journal times, last encode/write ms and bytes |
| `file.listAutoSaves` | auto-save files of the current project, newest first |
| `prefs.get {key?}` / `prefs.set {key, value}` or `{values:{…}}` / `prefs.reset {category?}` | settings (below) |

## Settings

Premiere's Settings dialog (app menu ▸ Settings ▸ <category> on macOS, Edit ▸ Preferences
elsewhere; General is Cmd+,; the window is titled "Preferences"). The values are user preferences,
not project data and never touch the `.kfilm` schema. The editor keeps them in its kit store
(`kit:film:prefs`, `web/src/session/prefsStore.ts` and `prefsSync.ts`) and loads them into the
engine with `loadPrefs`, which reads them as the engine reads a preferences file: older versions
are migrated, and unknown dropdown values, bad colours and out-of-range numbers are repaired to
defaults/limits.

Every value is a dotted key whose first segment is its category: `timeline.stillImageDuration`,
`labels.colors.rose.name`. `prefs.get` / `prefs.set` / `prefs.reset {category?}` are engine
commands; `prefs.set` rejects values that are not one of a dropdown's
choices. `prefs.schema {category?}` lists every category with its fields (label, kind, choices,
range, unit, current value, and `wired`: whether Kition Film acts on it yet). The editor does not
draw the Preferences window (`app.settings.<category>`) yet.

| Category | Takes effect |
|---|---|
| General | At Startup (Show Home = demo project, Open Most Recent, empty project; recent projects are remembered on open/save), Show Tool Tips |
| Appearance | Color Theme (Darkest / Dark / Light; View ▸ Appearance writes it too), highlight colour, accessible contrast |
| Audio | Automatch Time, Large Volume Adjustment, automation keyframe thinning (linear, minimum time) |
| Audio Hardware | device class, output device, I/O buffer size, sample rate, force document rate, Output Mapping (programme L/R → device channels) |
| Auto Save | the auto-save ring and the crash-recovery journal |
| Color | stored only (display colour management, EDR monitoring, HDR graphics white) |
| Graphics | new text layers: smart quotes, ligatures, default font |
| Labels | the 16 label names and colours (timeline, Project panel, Edit ▸ Label), label defaults for imported movies / video / audio / stills and new sequences |
| Media | Indeterminate Media Timebase (frame rate of stills), Default Media Scaling (Scale to / Set to frame size when a clip of another size is edited in), Enable proxies |
| Media Analysis & Transcription | auto-transcribe imported clips (scope "all imported"), speech model, default language / auto-detect, speaker labelling (defaults of `transcript.generate`) |
| Media Cache | location (`<data dir>/Media Cache` by default; unsaved projects' render previews live there), automatic deletion (older than N days / beyond N GB), Delete… (`mediaCache.clean {all?}`, `mediaCache.info`) |
| Memory | frame cache budget of the monitors and thumbnails |
| Playback | preroll / postroll (Play Around, trim loop), Step forward/back many |
| Plugins | stub (no plugins) |
| Timeline | video / audio transition and still image default durations (frames or seconds), playback auto-scrolling (none / page / smooth), snap playhead, return to beginning at playback end, play after rendering previews |
| Trim | Large Trim Offset, Selection tool picks roll (on the cut) / ripple (on the edge) without a modifier, playhead determines trim loop |

The remaining fields are kept for parity but have no effect yet (`wired: false`).

## Media: offline, relinking, proxies, ingest

Media is referenced by path. Each imported file also records its **identity**
(`MediaClip::identity`): the size and a 64-bit fingerprint of the size, the first MiB and the last
MiB. Reading 2 MiB is cheap on any file, and it tells a moved original from a different take with
the same name. The field is optional (`skip_serializing_if`): an item without one (a generator)
is relinked without the fingerprint check.

### Offline media

- **Opening a project** checks every file (`media.findMissing`). Missing items don't stop the open.
  They render the **offline slate** (`crates/render/render/src/offline.rs`, our own design: a red striped
  field, a warning triangle, "MEDIA NOT FOUND", the file name and a hint) and their audio is
  silent. `file.open` returns `missingMedia`.
- **Make Offline** (`media.makeOffline {items?, deleteFiles?}`) sets `MediaClip::offline`. The clip
  then shows "MEDIA SET OFFLINE" even though the file exists, until it is linked again. Files are
  deleted only with `deleteFiles: true`.
- The media pool caches sources per item **and** per reference (path, offline flag). So relinking,
  Make Offline and undoing either take effect on the next frame.

### Link Media

| Command | |
|---|---|
| `media.findMissing` | `{missing: [{item, name, fileName, path, status: missing\|offline\|proxyMissing, duration, startTimecode}]}` |
| `media.status {item?}` | per item: `online`, `missing`, `offline`, `unreadable` or `generated`, plus identity and proxy |
| `media.linkMedia` | File ▸ Link Media… (rescans; the editor opens its dialog) |
| `media.relink {item, path, force?, relinkOthers?=true, alignTimecode?, match?}` | check, link, then the others |
| `media.autoRelink {from, to}` / `{folder}` | batch relink: a folder-prefix remap, or a search of a folder tree |
| `media.search {folder, item?, exactName?=true}` | ranked candidates with `ok`, `identityMatch`, `problems` |
| `media.replaceFootage {item, path}` | relink without checks (Replace Footage) |
| `media.offlineAll` | close the dialog and leave the rest offline |

`match` selects which properties must agree. Each defaults as shown:

- `fileName` (true): the file name stem;
- `extension` (true);
- `clipId` (true): the fingerprint; a mismatch is refused with "not the same file…";
- `duration` (true): within one frame;
- `mediaStart` (false): the start timecode;
- `metadata` (true): frame size, frame rate and audio channels.

`force: true` links regardless. **Relink others automatically** works out the folder remap from the
file just linked, by dropping the common trailing path components (`/Volumes/A/shoot/a.mov` →
`/Users/me/shoot/a.mov` gives `/Volumes/A` → `/Users/me`). It applies the remap to the other missing
files and checks each one. It also looks in the new file's folder. Windows and macOS separators both
work. **Align Timecode** keeps clips on the same timecode when the new file starts at a different
timecode: the clips' source in-points, keyframes, marks and markers move with it
(`Project::shift_media_time`). One relink, together with the files it pulls along, is one undo step.

Link Media dialog automation ids: `linkMedia.row.<n>`,
`linkMedia.match.<fileName|extension|clipId|duration|mediaStart|metadata>`, `linkMedia.alignTimecode`,
`linkMedia.relinkOthers`, `linkMedia.folder`, `linkMedia.browse`, `linkMedia.exactName`,
`linkMedia.search`, `linkMedia.candidate.<n>`, `linkMedia.preview`, `linkMedia.link`,
`linkMedia.locate`, `linkMedia.offline`, `linkMedia.offlineAll`, `linkMedia.cancel`.
Make Offline: `makeOffline.keep|delete|ok|cancel`. In the Project panel, offline items get a
broken-link badge (`project.item.<id>.offline` in Icon view), and items with a proxy get a **P**
badge (`project.item.<id>.proxy`).

### Proxies

| Command | Menu | |
|---|---|---|
| `media.createProxies {items?, preset?, destination?, attach?=true, wait?}` | Clip ▸ Proxy ▸ Create Proxies… | background job; attaches when done |
| `media.attachProxies {item, path}` / `{items, paths}` | Attach Proxies… | duration within one frame and the same frame rate are required; size and aspect may differ |
| `media.detachProxies {items?}` | Detach Proxies | |
| `media.reconnectFullRes {item, path}` | Reconnect Full Resolution Media… | link the full-resolution file of a clip that has a proxy |
| `media.toggleProxies {enabled?}` | View ▸ Toggle Proxies, monitor button | Preferences ▸ Media ▸ `media.enableProxies` |
| `media.proxyPresets` | | |

The presets use our own encoders:

- `prores_proxy_quarter` (default), `prores_proxy_half`, `prores_lt_half`: ProRes 422 Proxy or LT
  in MOV with PCM audio;
- `h264_quarter`, `h264_half`: H.264 + AAC in MP4.

Proxies go to `<media folder>/Proxies/<name>_Proxy.<ext>`, or to the chosen folder. Job progress is
in `jobs.list`. `Session::poll_persistence`, which the kit calls from `jobsStep`, attaches
finished proxies. The editor does not show Create Proxies…: its job writes the proxy files into a
local folder, which the web engine cannot write.

With proxies enabled, monitors, thumbnails and playback read the proxy. The proxy source reports
the original's size. The compositor derives its pixel scale from the frame it gets, so Motion and
pixel-size effect parameters (blur radii…) give the same picture at the proxy's resolution. A
320×180 clip with Motion and Gaussian Blur and a ½-size ProRes Proxy measures 44 dB PSNR against
full resolution (48 dB at ½ playback resolution). **Export always uses full resolution**
(`MediaPool::full_res_provider`). Toggling proxies bumps the revision so caches refresh, but it is
not an edit and doesn't mark the project as modified.

**Cost.** These numbers are from `proxy_playback_perf_4k`, an ignored test: `RAYON_NUM_THREADS=1
cargo test --release -p kition-film-engine proxy_playback_perf_4k -- --ignored --nocapture`. It plays a
2 s 3840×2160 H.264 clip (ffmpeg `testsrc2`, libx264) on one core of the development Mac and reports
milliseconds per frame:

| | decode | CPU composite at ½ | CPU composite at ¼ | proxy creation |
|---|---|---|---|---|
| full resolution | 9.2 | 277 | 201 | |
| ProRes Proxy ¼ | 8.9 | 150 | 35 | 17.8 s |
| H.264 ¼ | 0.7 | 131 | 48 | 8.9 s |

The test pattern is unusually cheap for H.264 to decode, so real camera footage gains more from
proxies. The CPU composite (YUV→linear conversion and resampling) is what proxies cut most:
5.7× at ¼ resolution, where the proxy needs no resampling.

Monitor button: `control:transport.toggleProxies` in the editor. It is lit while proxies are on.

### Ingest settings

`project.ingestSettings {enabled, action: copy|transcode|createProxies|copyAndCreateProxies,
destination?, preset?}` (Project Settings ▸ Ingest) acts on every `file.import`:

- **copy** copies the file to the destination (default `<media folder>/Ingested Media`), checks the
  copy's fingerprint against the original, and then uses the copy;
- **transcode** writes the preset's format (default ProRes 422 LT) in the background and switches the
  clip to the result when it is done;
- **createProxies** makes proxies in the background and attaches them;
- **copyAndCreateProxies** does both.

`file.import` reports this under `ingest`.

## Project Manager

`file.projectManager` (File ▸ Project Manager…) makes a self-contained copy of a project:

```json
{"destination": "/path/Folder", "mode": "collect|consolidate", "sequences": [id], "excludeUnused": true,
 "handles": 30, "preset": "prores_lt", "includeProxies": true, "includePreviews": false,
 "projectName": "…", "dryRun": false, "overwrite": false, "wait": false}
```

- **collect** copies every media file that the chosen sequences use (following nested sequences and
  subclips), plus their proxies and render previews if asked.
- **consolidate** writes only the used range of each movie or audio file, plus `handles` frames on
  each side, with a transcode preset (`prores_lt`, `prores_hq`, `h264`). It then re-bases the clips'
  media time, so every edit, keyframe and marker stays in place. Stills are copied.
- **excludeUnused** drops media items and sequences that the chosen sequences don't use.
- **dryRun** returns the plan and the disk-space estimate (`originalBytes`, `resultBytes`, `files`)
  without writing anything.

The copy runs as a job. The project file (`<destination>/<name>.kfilm`) is written last, with the
new paths and fingerprints, so it opens with no missing media.

The editor does not show Project Manager: it copies into a local folder.

## Effect presets

Effect presets (Effects panel ▸ Presets; Effect Controls ▸ right-click an effect ▸ Save Preset…) are
not part of the project. Built-in presets are defined in code (`kition_film_engine::presets`); user
presets live in `<data dir>/effect-presets.json`, and `presets.export` / `presets.import` read and
write the same JSON format:

```json
{"format": "kition-film.effect-presets", "version": 1, "presets": [
  {"name": "My Vignette", "description": "", "keyframes": "AnchorToIn",
   "source_duration": 2540160000000, "source_size": [1920, 1080],
   "effects": [ /* EffectInstance, exactly as in .kfilm: effect, enabled, params, masks */ ]}
]}
```

Keyframe times are relative to the in point of the clip the preset was saved from
(`source_duration` is that clip's media length in ticks). Applying re-times them: `Scale` stretches
them over the target clip, `AnchorToIn` / `AnchorToOut` keep their distance from the target's in /
out point. Point parameters, mask paths, feather and expansion are scaled by the target / source
frame-size ratio. Intrinsic effects (Motion, Opacity…) replace the clip's own instance; other
effects are added. Applying is one undo step; saving, renaming, deleting and importing change the
library, not the project, and are not undoable. Files with another `format`, a newer `version` or
unknown effect ids are refused.
