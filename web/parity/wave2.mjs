// The task of the Film UI parity plan's wave 2 (Tasks 9–41) that closes each wave-2 item and each
// wave-2 follow-up, from the rules of the plan's Scope section, and what Task 1 moved to wave 3,
// hid, or dropped. `check.test.mjs` checks that every wave-2 item maps to exactly one task, prints
// the counts per task against SCOPE, and with FILM_TASK=<n> that task n's items are all done or
// hidden and its follow-ups closed. Node, no dependencies.
//
// A later task that moves one of its items to wave 3 (with a reason), or hands an item or a
// follow-up to another task, updates SCOPE with it.

/** The Scope table: items and follow-ups each task closes (the follow-ups still open, at most). */
export const SCOPE = {
  items: { 9: 6, 10: 0, 11: 45, 12: 39, 13: 47, 14: 52, 15: 33, 16: 24, 17: 30, 18: 19, 19: 19, 20: 3, 21: 27, 22: 28, 23: 3, 24: 0, 25: 30, 26: 17, 27: 2, 28: 10, 29: 9, 30: 17, 31: 18, 32: 47, 33: 49, 34: 14, 35: 2, 36: 41, 37: 19, 38: 1 },
  followUps: { 12: 1, 14: 1, 15: 1, 16: 1, 18: 3, 19: 2, 20: 1, 21: 5, 22: 2, 23: 1, 24: 2, 25: 1, 26: 2, 27: 1, 29: 1, 30: 1, 34: 1, 35: 2, 38: 16, 39: 2, 41: 1 },
  /** Task 1's moves: wave-2 items set to wave 3, items hidden, follow-ups moved to wave 3, and follow-ups dropped with a note. */
  movedItems: 51,
  hiddenItems: 25,
  movedFollowUps: 2,
  droppedFollowUps: 1,
}

/** Items Task 1 moved to wave 3: [reason, test of the status key]. */
export const WAVE3_ITEMS = [
  [
    "The Text panel's Transcript tab and its word navigation need speech-to-text: upstream's transcript.* commands are wave 3.",
    (key) => (key.startsWith('key:textPanel.') && !['key:textPanel.delete', 'key:textPanel.rippleDelete'].includes(key)) || key.startsWith('element:text.transcript.'),
  ],
  ["Transcribe Sequence's field: sequence.transcribe (speech-to-text) is wave 3.", (key) => key === 'element:{}.diarize' || key.startsWith('element:transcribe.')],
  ["Records a voice-over, which the design puts in wave 3.", (key) => key === 'element:mixer.transport.voiceover.recordToggle'],
  ["Project Manager's field: file.projectManager is wave 3.", (key) => key.startsWith('element:pm.')],
  ['The Preferences window (settings.rs) opens only from app.settings.*, which are wave 3.', (key) => key.startsWith('element:settings.')],
  ['Motion Graphics templates are wave 3 (the design puts graphics templates there).', (key) => key.startsWith('menu:') && /\/graphics\.template\.(export|install)$/.test(key)],
  ['The Multi-Camera display mode comes with Multi-Camera, in wave 3.', (key) => key === 'menu:View/Display Mode/view.display.multicam' || key === 'element:program.settings.display.multicam'],
]

const HOST_FILE = 'The host opens, saves, and closes documents.'
const SCRATCH_DISKS = 'Sets local folders for captures, previews, and auto-saves.'
const LINK_SEARCH = 'Searches local folders for the missing file; Locate… picks it through the host.'
const PROXY_FOLDER = 'A local folder for proxies; proxies go next to the project.'
/**
 * Items Task 1 hid, with the reason each is hidden (rule 2; the dialog fields are also in
 * `web/src/menus/hidden.ts`'s isHiddenField). Kept here, not derived from hidden.ts, so a later
 * task that hides another field leaves these counts alone.
 */
export const TASK1_HIDDEN = Object.fromEntries([
  ...['captured', 'videoPreviews', 'audioPreviews', 'autoSave'].flatMap((row) => [`projectSettings.scratch.${row}`, `projectSettings.scratch.${row}.browse`, `projectSettings.scratch.${row}.same`].map((id) => [`element:${id}`, SCRATCH_DISKS])),
  ['element:projectSettings.tab.scratchDisks', SCRATCH_DISKS],
  ...['folder', 'browse', 'search', 'exactName', 'candidate.{}', 'preview'].map((field) => [`element:linkMedia.${field}`, LINK_SEARCH]),
  ['element:proxies.destination', PROXY_FOLDER],
  ['element:proxies.browse', PROXY_FOLDER],
  ['element:makeOffline.delete', 'Deleting media files belongs to the host.'],
  // Close Project's save prompt (clip_dialogs.rs), whose menu row is hidden: the host closes documents.
  ['element:{}.save', HOST_FILE],
  ['element:{}.dontSave', HOST_FILE],
  // Ingest's destination is a local folder ("Next to the media").
  ['element:projectSettings.ingest.destination', 'Ingests into a local folder next to the media; the host keeps media files.'],
])

/** The reason Task 1 moved `key` to wave 3, or null. */
export const wave3Reason = (key) => WAVE3_ITEMS.find(([, test]) => test(key))?.[0] ?? null

/** Follow-ups Task 1 moved to wave 3: [status key, text test]. */
export const WAVE3_FOLLOW_UPS = [
  ['menu:File/file.import', /Pick several files at once/],
  ['element:tools.{}', /^Chinese names for wave-1 labels/],
]
/** Follow-ups Task 1 dropped, each replaced by a `note` on its entry. */
export const DROPPED_FOLLOW_UPS = [['panel:info', /Info's UI line/]]

const PANEL_TASKS = { effects: 26, color: 28, scopes: 30, graphicsTemplates: 25, audioMixing: 32, audioTrackMixer: 33, audioClipMixer: 34, text: 36, metadata: 37, timecode: 37, events: 37, progress: 37 }

/** Menu rows, keys, and elements that run a command, by command (exact ids, or a prefix ending in "."). */
const COMMAND_TASKS = {
  11: ['edit.pasteAttributes', 'edit.removeAttributes', 'clip.interpretFootage', 'clip.frameHoldOptions', 'clip.fieldOptions', 'clip.audioGain', 'clip.speedDuration'],
  12: ['clip.rename', 'clip.makeSubclip', 'clip.editSubclip', 'clip.editOffline', 'clip.sourceSettings', 'clip.audioChannels', 'clip.modifyTimecode', 'clip.nest', 'clip.synchronize', 'clip.mergeClips', 'file.newOfflineFile'],
  13: ['file.newSequence', 'sequence.settings', 'sequence.colorSettings'],
  14: ['file.newAdjustmentLayer', 'file.newBarsAndTone', 'file.newBlackVideo', 'file.newColorMatte', 'file.newCountingLeader', 'file.newTransparentVideo', 'sequence.normalizeMixTrack', 'sequence.simplify', 'sequence.addTracks', 'sequence.deleteTracks', 'mixer.addSubmix'],
  15: ['edit.find', 'file.newSearchBin', 'clip.automateToSequence', 'window.openSearch', 'panel.selectFindBox'],
  16: ['clip.sceneEditDetection', 'markers.addChapter', 'markers.addFlashCue', 'clip.updateMetadata', 'file.mediaPropertiesFile', 'file.mediaProperties', 'file.projectSettings.general', 'project.ingestSettings'],
  17: ['media.linkMedia', 'media.makeOffline', 'media.createProxies', 'media.attachProxies', 'media.reconnectFullRes'],
  18: ['projectPanel.metadataDisplay', 'projectPanel.saveViewPresetAs', 'projectPanel.manageViewPresets'],
  19: ['projectPanel.freeformOptions', 'projectPanel.saveArrangement', 'project.freeform.'],
  20: ['projectPanel.newPanel'],
  21: ['view.display.', 'view.compare.'],
  22: ['view.showRulers', 'view.showGuides', 'view.lockGuides', 'view.addGuide', 'view.clearGuides', 'view.snapInProgramMonitor', 'view.guideTemplates.'],
  25: ['graphics.newFromFile', 'file.replaceFonts'],
  36: ['captions.', 'textPanel.delete', 'textPanel.rippleDelete'],
}

/**
 * The fields of upstream's dialogs whose automation id starts with the dialog's prefix, drawn
 * `{}.<field>` in the manifest (clip_dialogs.rs, menu_dialogs.rs, multicam.rs): by field, the
 * task of the dialog that has it. A field several dialogs draw goes to the LAST task that draws
 * one of them, so that task finds every dialog drawing it built (`{}.name`: Nest and Merge Clips
 * in 12, Create Search Bin in 15, Flash Cue Marker in 16 → 16). The exceptions are `{}.ok` and
 * `{}.cancel`, every dialog's, which the dialog framework (Task 9) owns. Automate to Sequence's
 * transition checkboxes (`videoTransition`, `audioTransition`) are its own, not New Offline
 * File's `video` and `audio`. Close Project's `save` and `dontSave` are hidden (TASK1_HIDDEN).
 */
const DIALOG_FIELD_TASKS = {
  9: ['ok', 'cancel'],
  // Paste and Remove Attributes (with their intrinsic checkboxes), Frame Hold Options, Field Options, Clip Speed / Duration.
  11: ['effect.{}', 'scaleTimes', 'motion', 'opacity', 'timeRemapping', 'volume', 'channelVolume', 'panner', 'enabled', 'holdOn.{}', 'holdFilters', 'reverseFieldDominance', 'processing.none', 'processing.alwaysDeinterlace', 'processing.flickerRemoval', 'speed', 'reverse', 'ripple', 'interpolation.{}'],
  // Audio Channels, Make and Edit Subclip, Modify Timecode, New and Edit Offline File, Synchronize Clips and Merge Clips.
  12: ['clip.{}.ch.{}', 'clip.0.ch.{}', 'format.{}', 'count', 'convertToMaster', 'startFrame', 'endFrame', 'restrictTrims', 'timecode', 'reset', 'audio', 'video', 'description', 'fileName', 'tapeName', 'fps', 'mediaName', 'scene', 'shot', 'logNote', 'ignoreHours', 'marker', 'offset'],
  // New Colour Matte, Normalize Mix Track, Simplify Sequence.
  14: ['seconds', 'width', 'height', 'color', 'db', 'keep.{}', 'removeAudioEffects', 'removeDisabled', 'removeEmptyTracks', 'closeGaps', 'moveClipsDown', 'removeText', 'removeVideoEffects'],
  // Find, Create Search Bin, Automate To Sequence (whose method radios Synchronize Clips also draws).
  15: ['scope.{}', 'caseSensitive', 'in.{}', 'text', 'ordering.{}', 'placement.{}', 'method.{}', 'overlapFrames', 'stillFrames', 'videoTransition', 'audioTransition', 'ignoreAudio', 'ignoreVideo'],
  // Scene Edit Detection, Flash Cue Marker (whose name Nest, Merge Clips, and Create Search Bin also draw).
  16: ['applyCuts', 'createSubclips', 'generateMarkers', 'name', 'comment'],
}

/** Elements by id: [task, test]. An element that runs a command also maps by COMMAND_TASKS (the same task). */
const ELEMENT_TASKS = [
  [9, (id) => id === 'about.{}' || id.startsWith('about.tab.')],
  [11, (id) => id.startsWith('audioGain.') || id.startsWith('colorDialog.space.')],
  // Synchronize Clips' reference track and Merge Clips' audio choice (multicam.rs show_dialog).
  [12, (id) => id === 'sync.track' || id === 'merge.removeVideoAudio'],
  // Sequence ▸ Colour Settings, the last of the two colour dialogs (Interpret Footage's is Task 11), owns their OK and Cancel.
  [13, (id) => id.startsWith('sequenceSettings.') || ['colorDialog.working.{}', 'colorDialog.autoToneMap', 'colorDialog.wideGamut', 'colorDialog.ok', 'colorDialog.cancel'].includes(id)],
  [14, (id) => id.startsWith('addTracks.') || id.startsWith('deleteTracks.')],
  [15, (id) => id.startsWith('find.') || id.startsWith('searchBin.') || id === 'project.searchBin.{}' || ['project.find', 'project.button.find', 'project.button.clip.automateToSequence'].includes(id)],
  [16, (id) => id.startsWith('sceneDetect.') || /^projectSettings\.(tab\.(general|ingest)|ingest\.|actionSafe\.|titleSafe\.|renderer$|videoDisplay$|audioDisplay$|captureFormat$)/.test(id)],
  [17, (id) => /^(linkMedia|makeOffline|proxies)\./.test(id)],
  [18, (id) => (id.startsWith('projectDialog.') && !FREEFORM_OPTIONS.includes(id)) || ['project.menu.metadataDisplay', 'project.menu.saveViewPresetAs', 'project.menu.manageViewPresets'].includes(id)],
  [19, (id) => FREEFORM_OPTIONS.includes(id) || /^project\.(stack\.|freeform$|cardMenu\.|canvasMenu\.)/.test(id) || id === 'project.menu.freeformOptions'],
  [20, (id) => id === 'project.binMenu.newWindow' || id.startsWith('projectBin.')],
  [21, (id) => id === 'source.waveform' || id.startsWith('program.compare.')],
  [22, (id) => /^(program|source)\.(ruler|guide)\./.test(id) || id.startsWith('guides.')],
  [23, (id) => id.startsWith('program.layer.')],
  [25, (id) => id.startsWith('graphics.')],
  [26, (id) => id === 'effectControls.effect.{}.savePreset' || /^(effects|savePreset)\./.test(id)],
  [27, (id) => id === 'effectControls.{}.graph.keyframe.{}' || id === 'effectControls.{}.{}.graphs'],
  [28, (id) => id === 'color.section.{}' || (id.startsWith('color.') && !COLOR_29.test(id))],
  [29, (id) => COLOR_29.test(id)],
  [30, (id) => id.startsWith('scopes.')],
  [31, (id) => /^effectControls\.\{\}\.mask/.test(id) || /^program\.mask/.test(id)],
  [32, (id) => id.startsWith('audioMixing.')],
  [33, (id) => id.startsWith('mixer.')],
  [34, (id) => id.startsWith('clipMixer.') || /^timeline\.track\.(\{\}\.keyframes|A\{\}\.lane)/.test(id)],
  // Custom Setup ▸ Edit… opens the audio effect editor (upstream effect_controls.rs custom_setup_row).
  [35, (id) => id === 'audioMeters.loudness' || id === 'effectControls.effect.{}.edit'],
  [36, (id) => (id.startsWith('text.') && !id.startsWith('text.transcript.')) || /^timeline\.caption(Track)?\./.test(id)],
  [37, (id) => /^(metadata|timecode|events|progress)\./.test(id)],
  [38, (id) => id === 'timeline.clip.{}.empty'],
]
const FREEFORM_OPTIONS = ['projectDialog.cardSize', 'projectDialog.grid', 'projectDialog.showNames', 'projectDialog.showDurations', 'projectDialog.snap']
const COLOR_29 = /^color\.(switch\.Curves|section\.Curves|match\.|param\.(hsl_|curves_hdr_range))/

const commandTasks = (command) =>
  Object.entries(COMMAND_TASKS)
    .filter(([, ids]) => ids.some((id) => (id.endsWith('.') ? command.startsWith(id) : command === id)))
    .map(([task]) => Number(task))

/** Every task a rule gives `key` (a status key): one for a wave-2 item, none for others. */
export function wave2Tasks(key, manifest) {
  const kind = key.slice(0, key.indexOf(':'))
  const id = key.slice(kind.length + 1)
  const tasks = new Set()
  if (kind === 'panel' && PANEL_TASKS[id]) tasks.add(PANEL_TASKS[id])
  if (kind === 'menu' || kind === 'key') for (const task of commandTasks(kind === 'menu' ? id.slice(id.lastIndexOf('/') + 1) : id)) tasks.add(task)
  if (kind === 'element') {
    const element = manifest.elements.find((each) => each.id === id)
    if (element?.command) for (const task of commandTasks(element.command)) tasks.add(task)
    if (id.startsWith('{}.')) {
      for (const [task, fields] of Object.entries(DIALOG_FIELD_TASKS)) if (fields.includes(id.slice(3))) tasks.add(Number(task))
    } else for (const [task, test] of ELEMENT_TASKS) if (test(id)) tasks.add(task)
  }
  // What Task 1 moved to wave 3 or hid is no task's.
  if (wave3Reason(key) || Object.hasOwn(TASK1_HIDDEN, key)) return []
  return [...tasks].sort((a, b) => a - b)
}

/** The task (9–41) that closes the wave-2 item `key`, or null for items no wave-2 rule names (or more than one does). */
export function wave2Task(key, manifest) {
  const tasks = wave2Tasks(key, manifest)
  return tasks.length === 1 ? tasks[0] : null
}

/** Wave-2 follow-ups by the status key they sit on and their text: [task, key test, text test]. */
const FOLLOW_UP_TASKS = [
  [38, (key) => key.startsWith('key:playback.'), /end_preroll/],
  [23, (key) => key === 'tool:Selection', /graphic layers on the Program monitor/],
  [34, (key) => key === 'tool:Pen', /automation keyframes/],
  [24, (key) => key === 'tool:Type' || key === 'element:program.textEdit', /engine's text layout/],
  [19, (key) => key === 'panel:project' || key === 'element:project.view.{}', /^Freeform view/],
  [20, (key) => key === 'panel:project', /floating bin panels/],
  [14, (key) => key === 'panel:project', /Color Matte/],
  [18, (key) => key === 'panel:project', /Metadata Display/],
  [39, (key) => key === 'panel:project' || key === 'panel:source', /^Performance:|^Source playback commits/],
  [16, (key) => key === 'panel:markers', /marker dialog/],
  [21, (key) => key === 'panel:source' || key === 'panel:program' || key === 'element:source.settings.{}' || key === 'element:program.settings.{}', /display modes|dropped-frame dot|display mode, RGBA/],
  // Task 21's review: the wrench rows it draws that Tasks 22 (rulers, guides, snap) and 30 (Scopes) serve.
  [22, (key) => key === 'element:source.settings.{}' || key === 'element:program.settings.{}', /^Show Rulers, Show Guides/],
  [30, (key) => key === 'element:program.settings.{}', /^Scopes opens/],
  [27, (key) => key === 'panel:effectControls', /value and velocity graphs/],
  [29, (key) => key === 'panel:effectControls', /^Curve, colour wheel/],
  // Save Preset… on the effect menu, and keeping the effect presets (b481769's preference store leaves them out).
  [26, (key) => key === 'panel:effectControls', /^Save Preset…/],
  [35, (key) => key === 'panel:effectControls', /Custom Setup/],
  [38, (key) => key === 'panel:timeline' || key === 'element:timeline.throughEdit.{}', /timeline_views|normalise a waveform|modified intrinsics|frame holds and multi-camera/],
  // Task 17's review: the Timeline keys a clip's head on inspect()'s peer-stable stamp.
  [38, (key) => ['menu:View/media.toggleProxies', 'element:timeline.clip.{}', 'element:source.transport.media.toggleProxies', 'element:program.transport.media.toggleProxies'].includes(key), /^Timeline clip head thumbnails redraw/],
  [41, (key) => key === 'panel:tools', /two columns/],
  [35, (key) => key === 'panel:audioMeters', /5\.1 Mix/],
  [25, (key) => key === 'panel:properties', /graphics properties/],
  [12, (key) => key === 'element:project.itemMenu.{}', /subclip dialogs/],
  [15, (key) => key === 'element:project.menu.{}', /search bin/],
  [18, (key) => key === 'element:project.menu.thumbnailsShowEffects', /^the thumbnails follow it/],
  [18, (key) => key === 'element:project.menu.thumbnailControlsAllDevices', /^with it on, a touch drag across a card scrubs it/],
]

/** Every task a rule gives the wave-2 follow-up `item` on the status key `key`. */
export const followUpTasks = (key, item) => [...new Set(FOLLOW_UP_TASKS.filter(([, keyTest, text]) => keyTest(key) && text.test(item)).map(([task]) => task))]
