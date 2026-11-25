# Monitor view options

The View menu and each monitor's wrench menu set how the Source and Program monitors show their
picture. It is the editor's state, not the engine's: the `view.*` UI commands change it. Commands
act on `params.monitor` (`"program"` / `"source"`), else on the focused monitor (Program by
default). Code: `web/src/monitors/monitorView.ts`.

| Command | Menu | Effect |
|---|---|---|
| `view.playbackRes.<full\|half\|quarter\|eighth\|sixteenth>` | View ▸ Playback Resolution | render scale while playing |
| `view.pausedRes.<…>` | View ▸ Paused Resolution | render scale while stopped (default Full) |
| `view.highQualityPlayback` | View ▸ High Quality Playback | play at the paused resolution when it is higher |
| `view.display.<composite\|alpha\|red\|green\|blue>` | View ▸ Display Mode | composite, or one channel as greyscale (colour channels premultiplied) |
| `view.display.multicam` | Display Mode ▸ Multi-Camera | the Program's multi-camera view (`multicam.toggleView`) |
| `view.display.audioWaveform`, `view.display.videoAndWaveform` | Display Mode ▸ Audio Waveform / Video and Audio Waveform Split | Source Monitor: the clip's waveform (click to move the source playhead); audio-only clips always show it |
| `view.display.comparison` | Display Mode ▸ Comparison View | Program: the reference frame (left) beside the current frame; the reference starts at the playhead and is stepped or reset with the buttons under it, or `view.compare.setReference {time\|seconds}` |
| `view.magnification.<fit\|10\|25\|50\|75\|100\|150\|200\|400\|800\|1600>` | View ▸ Magnification and the zoom dropdown | 100% = one frame pixel per screen pixel; scroll or drag with the Hand tool to pan |
| `view.showRulers`, `view.showGuides`, `view.lockGuides`, `view.clearGuides` | View | toggles take `{"enabled": bool}` |
| `view.addGuide` | View ▸ Add Guide… | dialog, or `{"orientation": "vertical\|horizontal", "position": px}` |
| `view.snapInProgramMonitor` | View ▸ Snap in Program Monitor | graphic moves snap to the frame edges / centre and the guides (6 pt) |
| `view.safeMargins` | Guide Templates ▸ Safe Margins | action- and title-safe boxes |
| `view.guideTemplates.save`, `.manage`, `.apply`, `.delete` | Guide Templates ▸ Save Guides as Template… / Manage Guides… | templates are stored in the user preferences (`guides.templates`) |

Guides are in frame pixels. Drag out of the top ruler for a horizontal guide or the left ruler for
a vertical one; drag a guide to move it (unless locked) and drop it outside the picture to remove it.

Automation ids: `<monitor>.zoom`, `<monitor>.zoom.<level>`, `<monitor>.settings.<command suffix>`
(wrench menu items, e.g. `program.settings.display.alpha`), `<monitor>.ruler.top|left`,
`<monitor>.guide.<n>`, `program.compare.reference|prev|next|set`, `source.waveform`, and in the
dialogs `guides.add.vertical|horizontal|position|ok|cancel`, `guides.save.name|ok|cancel`,
`guides.manage.row.<n>|apply|delete|close`.

## Source playback

Video files, audio files, generated media and media subclips play in the Source monitor with its
Play/Pause button or Space while Source has focus. The Source clock and playhead are independent
of the active sequence; auditioning does not create timeline clips or change the project. Starting
Source stops Program playback, and starting Program stops Source, so only one monitor owns audio.
Scrubbing while playing seeks the Source clock and restarts its audio at that position. Replacing
the open source stops playback. Playback stops at the last frame, and Play there starts again.
Play auditions the full source span by default. Play In to Out and Play to Out
address the marked Source range when Source has focus. The Source wrench menu can loop the
marked range; Program keeps its separate loop setting.

Normal forward playback has sound. L starts normal forward Source playback, K stops, and the
left/right frame-step keys address Source when it has focus. Reverse and shuttle-speed Source
playback and source sequences are not yet supported and report an explanatory error. A failed
audio device leaves the picture advancing with a status message; a decoding error stops Source.

Commands: `source.playback.play`, `source.playback.stop`, `source.playback.toggle` (no parameters),
which the editor runs (`web/src/session/playback.ts`). `playback.toggle` also accepts
`monitor: "source"|"program"` to override focus. Tests: `web/src/session/playback*.test.mjs` and
`web/src/session/source-*.test.mjs`.

## Drag a marked Source range to the timeline

An unmarked Source clip shows In at its beginning and Out on its last frame. These are implicit
limits: opening a clip does not write marks or dirty the project. Set In/Out with I/O or the
transport buttons; the saved marks are reused when reopening that clip. Out includes its frame.

Drag the **Video only**, **Audio only**, or **Video + audio** icons between Fit and playback
resolution to an open
sequence. Drop video on a video track and audio on an audio track. Both uses the dropped track
and its corresponding track of the other kind, creating linked clips in one undoable edit.
Unavailable stream choices are disabled. Dragging the video picture also brings its available
streams; a vertical drag from an audio waveform brings sound, while a horizontal drag scrubs.
The drag captures the selected range at its start. Source playback pauses when lifting a clip.
A locked or unavailable destination reports an error without partially placing the pair.

Automation ids: `source.drag.video`, `source.drag.audio`, `source.drag.both`, `source.picture`,
and `source.waveform`. Placement dispatches `timeline.place` with `sourceIn`, `duration`, `video`
and `audio`; the stream flags default to true for existing callers. Engine tests cover range
bounds, stream choices, linked placement, invalid parameters and undo/redo. The editor's flow
test (`pnpm test:flow`) drags from the Source monitor in a browser.

Ctrl+Shift+X (Cmd+Shift+X on macOS) clears In/Out on the focused Source clip, including split
points, and restores the implicit full span. It is undoable and leaves Program marks unchanged.
The command `marker.clearInOut` accepts `target: "source"|"program"`; omitting it addresses Program.

Source range braces use the playhead's theme color and the gray selection band is translucent,
so the ruler ticks remain visible. The clear shortcut uses the primary modifier: Ctrl on
Windows/Linux, Cmd on macOS; I/O, Space and the three drag gestures are the same everywhere.

## Adjust Source marks on the ruler

Drag either In/Out handle to trim the selected span, or drag the interior gray band to move
both marks while keeping the duration. Handles show an original red bracket and arrows on
hover. Edits snap to source frames, stay within the clip and retain at least one frame.
A gesture previews without editing the project and commits one undoable `project.setMarks`
command on release. Escape cancels; opening another source or a concurrent project edit
also cancels the draft. Subclip handles are currently disabled.

Automation ids are `source.range.in`, `source.range.out`, `source.range.body` and
`source.settings.loop`. Clicking the band's interior still scrubs.

Source-focused Go to In/Out, clear individual/both marks, clip-marker commands and
previous/next marker address the open Source clip. Shift+Left/Right step multiple Source
frames using the preference. UI callers can override focus with `monitor: "source"|"program"`;
engine marker/navigation commands accept `target: "source"|"program"` and default to Program.
Source marker edits leave sequence markers and the Program playhead unchanged.

Coverage: engine `source_monitor::tests` validates frame bounds and hostile inputs.

## Program range handles

Program uses the same In/Out hover cues, frame-snapped trimming, duration-preserving range
movement and one-edit undo behavior. It targets the active sequence through `project.setMarks`
and leaves an independently opened Source clip's marks and playhead unchanged. Program shows only explicitly set marks; clearing them hides the corresponding handles.
Range movement requires both Program marks. Empty sequences disable the handles.
Changing the active sequence cancels an unfinished draft. Automation ids: `program.range.in`,
`program.range.out` and `program.range.body`. Both monitors share the original brace artwork,
playhead-blue color and translucent gray band.

The playhead has drag priority above the range band and trim handles, including a full-span
selection. Drag it to scrub; the unoccupied upper ruler can also scrub. Drag the gray band away
from the playhead to translate the marked range.

## Export Frame

The engine's `file.exportFrame` command writes one frame of either monitor to an image file. In the
editor, the camera button in either monitor is drawn but disabled: the Export Frame dialog it opens
is not built yet.

PNG and TIFF support 8 or 16 bits per channel. The 16-bit path quantizes directly from the
float image, preserving precision beyond 8 bits. JPEG (quality 95) and BMP support 8-bit output.
The command rejects unsupported format/depth combinations. `import` adds the saved still to the
project as one undoable edit.

Export uses the original full-resolution media, even with proxies or reduced preview resolution
enabled. Source exports the source picture at its media playhead; Program exports the sequence
composite, effects and captions at its timeline playhead. Audio-only Source clips have no picture
to export.

`file.exportFrame` accepts `target: "source" | "program"` (Program by default),
`format: "png" | "jpeg" | "tiff" | "bmp"`, `depth: 8 | 16` (default 8),
optional `item` for Source or `sequence` for Program, an exact integer `time` in ticks, and the
`path` to write.
