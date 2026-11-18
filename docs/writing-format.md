# Film writing format

How a model writes Kition Film documents: the steps it sends, how it names what it changes,
what a new document starts with, the named values commands accept, and worked examples.
The package ships the short version for models as [agent/guide.md](../agent/guide.md); this file is
the complete reference it is drawn from. Everything below comes from the engine itself
(its 677 commands and their parameter schemas, and what `inspect` reports) and from the guide.

## What a model writes

A model never writes the file bytes. It calls the kit's agent tools (prefix `film`), and the
engine applies each change, keeps it in undo history and saves the file:

- `film_inspect`: read the document; `film_commands`: find commands by keyword;
- `film_run`: run steps `{command, params}` in order;
- `film_check`: list problems.

## Syntax

A step is one engine command with its parameters, as JSON:

```json
{"command": "<command id>", "params": {"<name>": <value>}}
```

`film_run` takes a list of steps and runs them in order, stopping at the first failure. Parameter
names, types and required fields come from each command's schema; `film_commands` returns them.
Commands by namespace (the part of the id before the first dot):

| Namespace | Commands | Change the document | Open to the agent | Examples |
| --- | ---: | ---: | ---: | --- |
| `audio` | 5 | 5 | 5 | `audio.voiceover.settings`, `audio.voiceover.start`, `audio.voiceover.sync` |
| `audioMixing` | 9 | 8 | 9 | `audioMixing.inspect`, `audioMixing.setType`, `audioMixing.clearType` |
| `captions` | 22 | 21 | 22 | `captions.newTrack`, `captions.deleteTrack`, `captions.setTrack` |
| `clip` | 57 | 54 | 57 | `clip.rename`, `clip.makeSubclip`, `clip.editSubclip` |
| `clipMixer` | 4 | 2 | 4 | `clipMixer.set`, `clipMixer.setMode`, `clipMixer.touch` |
| `color` | 8 | 5 | 8 | `color.spaces`, `color.presets`, `color.applyPreset` |
| `command` | 1 | 0 | 1 | `command.list` |
| `edit` | 37 | 36 | 37 | `edit.undo`, `edit.redo`, `edit.cut` |
| `effects` | 13 | 12 | 13 | `effects.apply`, `effects.remove`, `effects.setParam` |
| `events` | 2 | 1 | 2 | `events.list`, `events.clear` |
| `export` | 19 | 13 | 19 | `export.presets.list`, `export.presets.get`, `export.presets.save` |
| `file` | 56 | 49 | 56 | `file.newProject`, `file.openDemoProject`, `file.newSequence` |
| `fonts` | 1 | 0 | 1 | `fonts.list` |
| `graphics` | 82 | 77 | 82 | `graphics.newText`, `graphics.newShape`, `graphics.setText` |
| `help` | 1 | 0 | 1 | `help.systemReport` |
| `history` | 1 | 0 | 1 | `history.list` |
| `jobs` | 2 | 1 | 2 | `jobs.list`, `jobs.cancel` |
| `lut` | 4 | 2 | 4 | `lut.import`, `lut.list`, `lut.remove` |
| `markers` | 31 | 31 | 31 | `markers.markIn`, `markers.markOut`, `markers.markClip` |
| `masks` | 11 | 9 | 11 | `masks.add`, `masks.remove`, `masks.set` |
| `media` | 16 | 8 | 16 | `media.colorInfo`, `media.findMissing`, `media.status` |
| `mediaBrowser` | 10 | 7 | 10 | `mediaBrowser.roots`, `mediaBrowser.list`, `mediaBrowser.navigate` |
| `mediaCache` | 2 | 1 | 2 | `mediaCache.info`, `mediaCache.clean` |
| `metadata` | 2 | 1 | 2 | `metadata.get`, `metadata.set` |
| `mixer` | 20 | 17 | 20 | `mixer.addSubmix`, `mixer.inspect`, `mixer.setStrip` |
| `multicam` | 35 | 32 | 35 | `multicam.switchAngle`, `multicam.recordStart`, `multicam.cut` |
| `perf` | 1 | 0 | 1 | `perf.stats` |
| `playhead` | 14 | 14 | 14 | `playhead.set`, `playhead.step`, `playhead.stepForward` |
| `prefs` | 4 | 2 | 4 | `prefs.get`, `prefs.set`, `prefs.reset` |
| `presets` | 7 | 5 | 7 | `presets.list`, `presets.save`, `presets.apply` |
| `project` | 39 | 30 | 39 | `project.matteColor`, `project.select`, `project.delete` |
| `scopes` | 1 | 0 | 1 | `scopes.read` |
| `sequence` | 44 | 41 | 44 | `sequence.revealInProject`, `sequence.open`, `sequence.close` |
| `shortcuts` | 17 | 9 | 17 | `shortcuts.registerExternal`, `shortcuts.list`, `shortcuts.get` |
| `source` | 5 | 4 | 5 | `source.open`, `source.setPlayhead`, `source.inspect` |
| `state` | 1 | 0 | 1 | `state.inspect` |
| `timeline` | 55 | 55 | 55 | `timeline.place`, `timeline.select`, `timeline.move` |
| `transcript` | 14 | 11 | 14 | `transcript.generate`, `transcript.set`, `transcript.delete` |
| `trim` | 24 | 22 | 24 | `trim.edit`, `trim.applyDefaultTransition`, `trim.selectEditPoint` |

### The project

- A project holds **items**: media (footage, stills, generators such as colour mattes), sequences,
  subclips. `film_inspect` answers them as `details.project.root.children`, each with its `item`
  id, `name`, `type` (`Sequence`, `Synthetic`, `Movie`, …) and `duration`.
- The **active sequence** (`details.project.activeSequence`) has video tracks (`V1`, `V2`, …) and
  audio tracks (`A1`, …) under `details.sequence`. Each track lists its clips (`items`), each with
  a clip id, its project `item`, `start` and `duration`.
- A sequence renders what its tracks hold at each moment; the preview is the program monitor at the
  playhead.

### Time and addressing

- **Ticks:** times in the project are ticks, 254,016,000,000 per second. Many commands take
  `"seconds"` instead (`timeline.place { "seconds": 2 }`, `file.newColorMatte { "seconds": 2 }`);
  use seconds where the schema offers them. Times in diagnostics and their fixes are ticks: pass
  them on unchanged.
- **Tracks** are named `V1`, `V2`, … and `A1`, `A2`, … in commands, counted from 1. Their display
  names ("Video 1") are not accepted.
- **Ids:** items and clips have numeric ids. Commands answer the ids they make
  (`file.newColorMatte` → `{ "item": 8 }`, `timeline.place` → `{ "clips": [9] }`).

## Text writing format

The engine reads no text writing format; a model writes through the commands above.

## Defaults

What a new, empty document starts with:

- File name `Untitled film.kfilm`, size 1920 × 1080 (`kit.json` `creates`).

What `film_inspect` reports for a new document made at that size (generated from the engine; lists shortened to 20 entries):

```json
{
  "canRedo": false,
  "canUndo": true,
  "playhead": 0,
  "project": {
    "activeSequence": 7,
    "dirty": false,
    "epoch": 1,
    "name": "Untitled film",
    "path": null,
    "revision": 3,
    "root": {
      "children": [
        {
          "duration": 0,
          "item": 7,
          "label": "Forest",
          "name": "Sequence 01",
          "type": "Sequence"
        }
      ],
      "id": 0,
      "name": "Untitled film"
    },
    "safeAreas": {
      "action": [
        10,
        10
      ],
      "title": [
        20,
        20
      ]
    },
    "sourceItem": null
  },
  "sequence": {
    "audio": [
      {
        "enabled": true,
        "id": 4,
        "items": [],
        "locked": false,
        "muted": false,
        "name": "Audio 1",
        "solo": false,
        "syncLock": true,
        "transitions": []
      },
      {
        "enabled": true,
        "id": 5,
        "items": [],
        "locked": false,
        "muted": false,
        "name": "Audio 2",
        "solo": false,
        "syncLock": true,
        "transitions": []
      },
      {
        "enabled": true,
        "id": 6,
        "items": [],
        "locked": false,
        "muted": false,
        "name": "Audio 3",
        "solo": false,
        "syncLock": true,
        "transitions": []
      }
    ],
    "duration": 0,
    "durationFrames": 0,
    "id": 7,
    "in": null,
    "markers": [],
    "name": "Sequence 01",
    "out": null,
    "playhead": null,
    "selection": [],
    "settings": {
      "audio_master": "Stereo",
      "color": {
        "auto_tone_map": true,
        "wide_gamut": false,
        "working": "Rec709"
      },
      "drop_frame": false,
      "frame_rate": {
        "den": 1001,
        "num": 24000
      },
      "height": 1080,
      "max_bit_depth": false,
      "max_render_quality": false,
      "par": [
        1,
        1
      ],
      "preset": "1920x1080 23.976",
      "preview_codec": "ProRes 422",
      "sample_rate": 48000,
      "width": 1920,
      "working_space": "Rec. 709"
    },
    "split": {
      "audioIn": null,
      "audioOut": null,
      "videoIn": null,
      "videoOut": null
    },
    "video": [
      {
        "enabled": true,
        "id": 1,
        "items": [],
        "locked": false,
        "muted": false,
        "name": "Video 1",
        "solo": false,
        "syncLock": true,
        "transitions": []
      },
      {
        "enabled": true,
        "id": 2,
        "items": [],
        "locked": false,
        "muted": false,
        "name": "Video 2",
        "solo": false,
        "syncLock": true,
        "transitions": []
      },
      {
        "enabled": true,
        "id": 3,
        "items": [],
        "locked": false,
        "muted": false,
        "name": "Video 3",
        "solo": false,
        "syncLock": true,
        "transitions": []
      }
    ]
  },
  "ticksPerSecond": 254016000000
}
```

## Themes, layouts and other named values

Parameters that take one of a fixed list of names (themes, layouts, presets, styles, kinds, modes,
units and similar), from the command schemas. A parameter not listed here takes free values; its
schema says which.

| Parameter | Values | Used by |
| --- | --- | --- |
| `align` | `left`, `center`, `right` | `captions.setStyle` |
| `align` | `left`, `hcenter`, `right`, `top`, `vcenter`, `bottom` | `graphics.align` |
| `anchor` | `top`, `middle`, `bottom` | `captions.setStyle` |
| `audioFormat` | `wav`, `aiff`, `mxf` | `file.exportAaf` |
| `audioFormat` | `wav`, `aiff` | `file.exportOmf` |
| `audioType` | `standard`, `5.1`, `adaptive`, `mono` | `sequence.addTracks` |
| `bitrateMode` | `cbr`, `vbr1Pass`, `vbr2Pass` | `file.exportMedia` |
| `caps` | `normal`, `all caps`, `small caps` | `graphics.setCharStyle` |
| `captionSidecar` | `srt`, `vtt` | `file.exportMedia` |
| `captureFormat` | `DV`, `HDV` | `file.projectSettings.general` |
| `direction` | `forward`, `reverse` | `trim.shuttle` |
| `direction` | `forward`, `backward` | `masks.track` |
| `effect` | `volume`, `panner` | `clipMixer.set` |
| `effect` | `constant_power`, `constant_gain`, `exponential_fade`, `<video transition>` | `effects.setDefaultTransition` |
| `fileTypes` | `all`, `video`, `audio`, `image`, `project`, `caption`, `<ext>` | `mediaBrowser.settings` |
| `fontSize` | `small`, `medium`, `large`, `extraLarge` | `project.view.set` |
| `format` | `edl`, `xml`, `fcpxml`, `otio`, `aaf`, `omf` | `file.exportInterchange` |
| `format` | `h264`, `hevc`, `prores`, `dnxhr`, `apv`, `mjpeg`, `mxf-op1a`, `mxf-opatom`, `png`, `tiff`, `bmp`, `gif`, `wav`, `aiff` | `file.exportMedia` |
| `format` | `mono`, `stereo`, `5.1`, `adaptive` | `clip.audioChannels` |
| `format` | `Subtitle`, `CEA-608`, `CEA-708`, `Teletext` | `captions.newTrack` |
| `format` | `srt`, `vtt`, `scc`, `mcc`, `stl`, `ttml`, `dfxp` | `captions.export` |
| `format` | `cube`, `3dl` | `lut.export` |
| `format` | `png`, `jpeg`, `tiff`, `bmp` | `file.exportFrame` |
| `kind` | `text`, `color`, `slider`, `checkbox`, `font`, `position` | `file.exportGraphicsTemplate`, `graphics.template.export` |
| `kind` | `trim`, `ripple`, `roll` | `trim.selectEditPoint` |
| `kind` | `rippleIn`, `rippleOut`, `roll`, `trimIn`, `trimOut` | `trim.selectNearest` |
| `kind` | `Video`, `Audio`, `VideoTransition`, `AudioTransition` | `effects.list` |
| `layout` | `auto`, `2x2`, `3x3`, `4x4` | `multicam.gridLayout` |
| `mixdownFormat` | `mov`, `mxf` | `file.exportAaf` |
| `mode` | `Off`, `Read`, `Latch`, `Touch`, `Write` | `clipMixer.setMode`, `mixer.setStrip` |
| `mode` | `set`, `adjust`, `normalizeMax`, `normalizeAll` | `clip.audioGain` |
| `mode` | `regular`, `ripple` | `timeline.trim` |
| `mode` | `off`, `roll`, `crawlLeft`, `crawlRight` | `graphics.setRoll` |
| `mode` | `collect`, `consolidate` | `file.projectManager` |
| `mode` | `none`, `add`, `subtract`, `intersect`, `lighten`, `darken`, `difference` | `masks.set` |
| `mode` | `frameSampling`, `frameBlending`, `opticalFlow` | `clip.setTimeInterpolation` |
| `paradeType` | `rgb`, `yuv`, `rgbWhite` | `scopes.read` |
| `preset` | `prores_proxy_quarter`, `prores_proxy_half`, `prores_lt_half`, `h264_quarter`, `h264_half` | `media.createProxies` |
| `shape` | `rectangle`, `ellipse`, `polygon`, `path` | `graphics.newShape` |
| `shape` | `ellipse`, `polygon`, `bezier` | `masks.add` |
| `submixType` | `stereo`, `5.1`, `adaptive`, `mono` | `sequence.addTracks` |
| `trackType` | `Standard`, `Mono`, `5.1`, `Adaptive` | `file.newSequence` |
| `type` | `dialogue`, `music`, `sfx`, `ambience` | `audioMixing.applyPreset`, `audioMixing.deletePreset`, `audioMixing.setType` |
| `type` | `point`, `paragraph` | `graphics.setTextType` |
| `waveformType` | `rgb`, `luma`, `yc`, `ycNoChroma` | `scopes.read` |

## Examples

### Example 1: a colour matte at the start of an empty sequence

On a new project, `film_check` answers `film.empty-sequence` for `Sequence 01` (`sequence:7`).

```json
film_run { "path": "edit.kfilm", "steps": [{ "command": "file.newColorMatte", "params": { "color": "#1f4e8c", "seconds": 2 } }] }
```

It answers `{ "item": 8 }`. Place that item:

```json
film_run { "path": "edit.kfilm", "steps": [{ "command": "timeline.place", "params": { "item": 8, "track": "V1", "seconds": 0 } }] }
```

It answers `{ "clips": [9] }`, and `film_check` then answers `the kit found nothing wrong`.

### Example 2: close a gap the check reports

```json
film_check { "path": "gap.kfilm" }
```

It answers `{ "code": "film.gap", "message": "Video 1 has 1 s of black between \"Color Matte\" and
\"Color Matte\" at 2 s.", "target": { "path": "sequence:7/clip:11" }, "fix": { "command":
"sequence.closeGap", "params": { "track": "V1", "time": 508540032000 } } }`. Run the fix as given:

```json
film_run { "path": "gap.kfilm", "steps": [{ "command": "sequence.closeGap", "params": { "track": "V1", "time": 508540032000 } }] }
```

`film_check` then answers `the kit found nothing wrong`.

## Workflow

1. `film_inspect` for the items, the sequence's tracks and clips, and a preview.
2. `film_commands` with specific words (`place clip`, `color matte`, `split`, `close gap`,
   `cross dissolve`). Follow each schema; don't invent ids.
3. `film_run`. **A step can't use an earlier step's answer:** `"$0.item"` is not substituted, so run
   the step that makes an item, read its id from the answer, then run the step that uses it.
4. `film_check`, then fix what it reports. A gap's diagnostic carries `sequence.closeGap` with the
   track and time; a disabled clip's carries `clip.enable`.

## Pitfalls

- **A failed step** stops the run and the kit undoes the steps before it, so the project is as it
  was before the call and nothing is saved (an item made in step 0 is gone). Read `error.index`
  for the failing step, fix it, and send the whole run again.
- **Offline media** (`film.offline-media`, error) renders the offline slate; relinking needs the
  person's file.
- **Missing media** (`film.missing-media`, error): the clip's file is not in the workspace (the kit
  reads media only through its host), so it renders the offline slate.
- **Missing items** (`film.missing-item`, error): a clip whose project item is gone. Replace or
  delete the clip.
- **Past the media's end** (`film.past-media-end`, warning): a clip reads beyond its footage, so
  its last frames freeze. Shorten it or move its source in. Stills and generators have no end.
- **Gaps** on V1 show black (`film.gap`, info). Close them only when the person wants a continuous
  cut.
- **Empty sequence** (`film.empty-sequence`, warning): nothing to render yet.
