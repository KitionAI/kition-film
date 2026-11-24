// Imports carry `.ts` and the JSON its import attribute so `node --test` loads this module as it is.
import type { KitUiDeclaration, KitUiItem } from '@kition/sdk/editor'
import upstream from '../parity/film-upstream.json' with { type: 'json' }
import { FILM_TOOLS } from './tools/catalog.ts'
import { FILM_MENUS } from './menus/catalog.ts'
import { isHiddenField, isHiddenOnWeb } from './menus/hidden.ts'
import { DIALOGS, dialogDeclarations } from './dialogs/registry.ts'
import { GUIDE_DIALOG_BUTTONS, GUIDE_DIALOG_DECLARATIONS } from './monitors/guideModel.ts'

/** Upstream's three modes in the header (`header.rs`): `control:header.mode.<id>`. */
const MODES: readonly KitUiItem[] = [
  { id: 'control:header.mode.import', label: 'Import' },
  { id: 'control:header.mode.edit', label: 'Edit' },
  { id: 'control:header.mode.export', label: 'Export' },
]

/** The header's buttons (`header.rs`). */
const HEADER: readonly KitUiItem[] = [
  { id: 'control:header.workspaces', label: 'Workspaces' },
  { id: 'control:header.notifications', label: 'Progress' },
  { id: 'control:header.search', label: 'Search' },
  { id: 'control:header.volume', label: 'Volume' },
]

/** Save as New Workspace and Edit Workspaces (`panels/workspaces.rs`). */
const WORKSPACE_DIALOGS: readonly KitUiItem[] = [
  { id: 'control:workspaces.save.name', label: 'Name' },
  { id: 'control:workspaces.save.ok', label: 'OK' },
  { id: 'control:workspaces.save.cancel', label: 'Cancel' },
  { id: 'control:workspaces.edit.row', label: 'Workspace' },
  { id: 'control:workspaces.edit.name', label: 'Name' },
  { id: 'control:workspaces.edit.rename', label: 'Rename' },
  { id: 'control:workspaces.edit.delete', label: 'Delete' },
  { id: 'control:workspaces.edit.close', label: 'Close' },
]

/**
 * The Timeline (`panels/timeline.rs`, its tab strip in `dock.rs`, its panel menu in
 * `panels/mod.rs`): upstream's own element ids, without their run-time parts.
 */
const TIMELINE: readonly KitUiItem[] = [
  { id: 'control:timeline.tab', label: 'Sequence' },
  { id: 'control:timeline.tab.close', label: 'Close Sequence' },
  { id: 'control:timeline.tabs.list', label: 'Sequence' },
  { id: 'control:panel.menu.Timeline.closeOthers', label: 'Close Other Timeline Panels' },
  { id: 'control:panel.menu.Timeline.revealSequence', label: 'Reveal Sequence in Project' },
  { id: 'control:timeline.timecode', label: 'Timecode' },
  { id: 'control:timeline.toggle.nest', label: 'Insert and overwrite sequences as nests or individual clips' },
  { id: 'control:timeline.toggle.snap', label: 'Snap in Timeline (S)' },
  { id: 'control:timeline.toggle.linked', label: 'Linked Selection' },
  { id: 'control:timeline.toggle.marker', label: 'Add Marker (M)' },
  { id: 'control:timeline.toggle.settings', label: 'Timeline Display Settings' },
  { id: 'control:timeline.settings.showVideoThumbnails', label: 'Show Video Thumbnails' },
  { id: 'control:timeline.settings.showAudioWaveform', label: 'Show Audio Waveform' },
  { id: 'control:timeline.settings.showThroughEdits', label: 'Show Through Edits' },
  { id: 'control:timeline.settings.expandAllTracks', label: 'Expand All Tracks' },
  { id: 'control:timeline.settings.minimizeAllTracks', label: 'Minimize All Tracks' },
  { id: 'control:timeline.ruler', label: 'time ruler' },
  { id: 'control:timeline.marker', label: 'Marker' },
  { id: 'control:timeline.renderBar', label: 'Render bar' },
  { id: 'control:timeline.clip', label: 'Clip' },
  { id: 'control:timeline.transition', label: 'Transition' },
  { id: 'control:timeline.throughEdit', label: 'Through edit' },
  { id: 'control:timeline.zoomBar', label: 'zoom scroll bar' },
  { id: 'control:timeline.clipMenu.clip.multicam', label: 'Multi-Camera' },
]

/**
 * Track header controls, one id for every track (rule 3: `control:track.lock` serves every
 * header), each standing for upstream's per-track ids (`timeline.track.V{}.locked`, `…A{}.locked`).
 */
export const TRACK_ALIASES: Readonly<Record<string, readonly string[]>> = {
  'control:track.sourcePatch': ['timeline.track.V{}.sourcePatch', 'timeline.track.A{}.sourcePatch'],
  'control:track.lock': ['timeline.track.V{}.locked', 'timeline.track.A{}.locked'],
  'control:track.target': ['timeline.track.V{}.target', 'timeline.track.A{}.target'],
  'control:track.syncLock': ['timeline.track.V{}.syncLock', 'timeline.track.A{}.syncLock'],
  'control:track.output': ['timeline.track.V{}.enabled', 'timeline.track.A{}.enabled'],
  // Upstream registers mute and solo ids for video tracks too, but draws them on audio tracks only.
  'control:track.mute': ['timeline.track.A{}.muted'],
  'control:track.solo': ['timeline.track.A{}.solo'],
}

const TRACK: readonly KitUiItem[] = [
  { id: 'control:track.sourcePatch', label: 'Source patch' },
  { id: 'control:track.lock', label: 'Toggle Track Lock' },
  { id: 'control:track.target', label: 'Toggle track targeting' },
  { id: 'control:track.syncLock', label: 'Toggle Sync Lock' },
  { id: 'control:track.output', label: 'Toggle Track Output' },
  { id: 'control:track.mute', label: 'Mute Track' },
  { id: 'control:track.solo', label: 'Solo Track' },
]

/**
 * The Source and Program monitors (`panels/monitor.rs`, `monitor_view.rs`, `source_range.rs`,
 * `source_drag.rs`). A control with the same meaning in both carries one id (rule 3), standing
 * for upstream's two (`MONITOR_ALIASES`); the Source-only drag buttons and Loop marked range keep
 * upstream's own ids. The zoom, resolution, and wrench rows reuse the View menu's ids
 * (`control:view.magnification.200`), which mean the same.
 */
export const MONITOR_ALIASES: Readonly<Record<string, readonly string[]>> = {
  'control:monitor.picture': ['program.picture', 'source.picture'],
  'control:monitor.timecode': ['program.timecode', 'source.timecode'],
  'control:monitor.zoom': ['program.zoom', 'source.zoom'],
  'control:monitor.resolution': ['program.resolution', 'source.resolution'],
  'control:monitor.settings': ['program.settings', 'source.settings'],
  'control:monitor.scrubBar': ['program.scrubBar', 'source.scrubBar'],
  'control:monitor.playhead': ['program.playhead', 'source.playhead'],
  'control:monitor.range.body': ['program.range.body', 'source.range.body'],
  'control:monitor.range.in': ['program.range.in', 'source.range.in'],
  'control:monitor.range.out': ['program.range.out', 'source.range.out'],
  'control:transport.addMarker': ['program.transport.markers.add', 'source.transport.markers.add'],
  'control:transport.markIn': ['program.transport.markers.markIn', 'source.transport.src.markIn'],
  'control:transport.markOut': ['program.transport.markers.markOut', 'source.transport.src.markOut'],
  'control:transport.goToIn': ['program.transport.markers.goToIn', 'source.transport.src.goIn'],
  'control:transport.stepBack': ['program.transport.playhead.stepBack', 'source.transport.src.stepBack'],
  'control:transport.play': ['program.transport.playback.toggle', 'source.transport.source.playback.toggle'],
  'control:transport.stepForward': ['program.transport.playhead.stepForward', 'source.transport.src.stepFwd'],
  'control:transport.goToOut': ['program.transport.markers.goToOut', 'source.transport.src.goOut'],
  'control:transport.insert': ['source.transport.source.insert'],
  'control:transport.overwrite': ['source.transport.source.overwrite'],
  'control:transport.lift': ['program.transport.sequence.lift'],
  'control:transport.extract': ['program.transport.sequence.extract'],
  'control:transport.toggleProxies': ['program.transport.media.toggleProxies', 'source.transport.media.toggleProxies'],
  'control:transport.buttonEditor': ['program.transport.buttonEditor', 'source.transport.buttonEditor'],
  // The rulers and guides (`monitor_view.rs` `rulers`, `guides`): one id each for both monitors.
  'control:monitor.ruler.top': ['program.ruler.top', 'source.ruler.top'],
  'control:monitor.ruler.left': ['program.ruler.left', 'source.ruler.left'],
  'control:monitor.guide': ['program.guide.{}', 'source.guide.{}'],
}

/**
 * Effect Controls and Properties (`panels/effect_controls.rs`): one id per meaning (rule 3), each
 * standing for upstream's ids. The keyframe navigator's buttons serve both panels' rows.
 */
export const EFFECT_ALIASES: Readonly<Record<string, readonly string[]>> = {
  // The Effects panel's folders (`effects.rs` `folder_row`), top folders and sub-folders alike.
  'control:effects.folder': ['effects.folder.{}/{}'],
  'control:effects.effect': ['effectControls.effect.{}'],
  'control:effects.effect.savePreset': ['effectControls.effect.{}.savePreset'],
  'control:effects.effect.clear': ['effectControls.effect.{}.clear'],
  'control:effects.stopwatch': ['effectControls.{}.{}.stopwatch'],
  'control:effects.text': ['effectControls.text.{}.{}'],
  'control:effects.keyframe': ['effectControls.{}.{}.keyframe.{}'],
  'control:effects.addKeyframe': ['effectControls.{}.{}.addKeyframe', 'properties.motion.{}.addKeyframe', 'properties.opacity.opacity.addKeyframe', 'properties.crop.{}.addKeyframe', 'properties.volume.level.addKeyframe'],
  'control:effects.prevKeyframe': ['effectControls.{}.{}.prevKeyframe', 'properties.motion.{}.prevKeyframe', 'properties.opacity.opacity.prevKeyframe', 'properties.crop.{}.prevKeyframe', 'properties.volume.level.prevKeyframe'],
  'control:effects.nextKeyframe': ['effectControls.{}.{}.nextKeyframe', 'properties.motion.{}.nextKeyframe', 'properties.opacity.opacity.nextKeyframe', 'properties.crop.{}.nextKeyframe', 'properties.volume.level.nextKeyframe'],
  'control:effects.lane': ['effectControls.lane'],
  'control:effects.ruler': ['effectControls.ruler'],
  'control:effects.playhead': ['effectControls.playhead'],
  ...Object.fromEntries(['linear', 'bezier', 'autoBezier', 'continuousBezier', 'hold', 'easeIn', 'easeOut', 'clear'].map((key) => [`control:effects.keyframeMenu.${key}`, [`effectControls.keyframeMenu.${key}`]])),
}

const EFFECT_LABELS: Readonly<Record<string, string>> = {
  'control:effects.folder': 'Folder',
  'control:effects.effect': 'Effect',
  'control:effects.effect.savePreset': 'Save Preset…',
  'control:effects.effect.clear': 'Clear',
  'control:effects.stopwatch': 'Toggle animation',
  'control:effects.text': 'Text',
  'control:effects.keyframe': 'keyframe',
  'control:effects.addKeyframe': 'Add/Remove Keyframe',
  'control:effects.prevKeyframe': 'Go to previous keyframe',
  'control:effects.nextKeyframe': 'Go to next keyframe',
  'control:effects.lane': 'keyframe lane',
  'control:effects.ruler': 'time ruler',
  'control:effects.playhead': 'playhead',
  'control:effects.keyframeMenu.linear': 'Linear',
  'control:effects.keyframeMenu.bezier': 'Bezier',
  'control:effects.keyframeMenu.autoBezier': 'Auto Bezier',
  'control:effects.keyframeMenu.continuousBezier': 'Continuous Bezier',
  'control:effects.keyframeMenu.hold': 'Hold',
  'control:effects.keyframeMenu.easeIn': 'Ease In',
  'control:effects.keyframeMenu.easeOut': 'Ease Out',
  'control:effects.keyframeMenu.clear': 'Clear',
}

const EFFECTS: readonly KitUiItem[] = [
  ...Object.keys(EFFECT_ALIASES).map((id) => ({ id, label: EFFECT_LABELS[id] ?? id })),
  // The Effects panel's rows (`effects.rs`, `presets.rs`): an effect or transition, and a saved preset.
  { id: 'control:effects.item', label: 'Effect' },
  { id: 'control:effects.preset', label: 'Preset' },
]

/**
 * What upstream draws for effects and transitions without registering an id the manifest reads:
 * the Effects panel's search box and a transition row's menu, a transition's menu on the Timeline
 * and the preview of an effect dragged over it, and the Set Transition Duration dialog.
 */
const EFFECTS_PANEL_UNREGISTERED: readonly KitUiItem[] = [
  { id: 'control:effects.search', label: 'Search effects' },
  { id: 'control:effects.itemMenu.setDefaultTransition', label: 'Set Selected as Default Transition' },
  { id: 'control:timeline.transitionMenu.setDuration', label: 'Set Transition Duration…' },
  { id: 'control:timeline.transitionMenu.clear', label: 'Clear Transition' },
  { id: 'control:timeline.effectDrop', label: 'Effect drop' },
  { id: 'control:transitionDuration.value', label: 'Duration:' },
  { id: 'control:transitionDuration.alignment', label: 'Alignment' },
  { id: 'control:transitionDuration.ok', label: 'OK' },
  { id: 'control:transitionDuration.cancel', label: 'Cancel' },
]

/**
 * The controls upstream draws in Effect Controls and Properties without registering an id: an
 * effect's `fx` switch and reset (Properties' section resets are the same `effects.reset`), every
 * parameter's value, and Properties' section folds.
 */
const EFFECTS_UNREGISTERED: readonly KitUiItem[] = [
  { id: 'control:effects.enabled', label: 'Toggle Effect' },
  { id: 'control:effects.reset', label: 'Reset Effect' },
  { id: 'control:effects.value', label: 'Value' },
  { id: 'control:properties.section', label: 'Section' },
  // The Text section's alignment and style buttons (upstream `graphics.prop.align.<n>`, `graphics.prop.faux_bold|faux_italic`).
  { id: 'control:properties.text.align', label: 'Alignment' },
  { id: 'control:properties.text.style', label: 'Style' },
]

/**
 * The dialogs' ids (rule 3, `dialogs/registry.ts`): `control:dialog.<prefix>.<field>` for each
 * field, standing for upstream's `<prefix>.<field>`, and the shared `control:dialog.ok` and
 * `control:dialog.cancel` for every dialog's OK and Cancel. Preview and the sound strip's Play
 * are Kition's (upstream's dialogs have no preview).
 */
const REGISTRY_ITEMS = dialogDeclarations(DIALOGS)
/**
 * Upstream's guide dialogs (`monitor_view.rs` `dialogs`, `monitors/guideDialogs.tsx`), outside the
 * registry: their fields, and their OK (Manage's Close) and Cancel under the shared ids.
 */
const DIALOG_ITEMS = [
  ...REGISTRY_ITEMS.map((item) =>
    item.id === 'control:dialog.ok' ? { ...item, upstream: [...item.upstream, ...GUIDE_DIALOG_BUTTONS.ok] } : item.id === 'control:dialog.cancel' ? { ...item, upstream: [...item.upstream, ...GUIDE_DIALOG_BUTTONS.cancel] } : item,
  ),
  ...GUIDE_DIALOG_DECLARATIONS.map((item) => ({ ...item, upstream: [...item.upstream] })),
]
export const DIALOG_ALIASES: Readonly<Record<string, readonly string[]>> = Object.fromEntries(DIALOG_ITEMS.filter((item) => item.upstream.length > 0).map((item) => [item.id, item.upstream]))
const DIALOG_CONTROLS: readonly KitUiItem[] = DIALOG_ITEMS.filter((item) => item.upstream.length > 0).map(({ id, label }) => ({ id, label }))
const DIALOG_KITION: readonly KitUiItem[] = DIALOG_ITEMS.filter((item) => item.upstream.length === 0).map(({ id, label }) => ({ id, label }))

/** Every shared id and the upstream ids it stands for. */
export const SHARED_ALIASES: Readonly<Record<string, readonly string[]>> = { ...TRACK_ALIASES, ...MONITOR_ALIASES, ...EFFECT_ALIASES, ...DIALOG_ALIASES }

const MONITOR_LABELS: Readonly<Record<string, string>> = {
  'control:monitor.picture': 'picture',
  'control:monitor.timecode': 'Timecode',
  'control:monitor.zoom': 'Select Zoom Level',
  'control:monitor.resolution': 'Select Playback Resolution',
  'control:monitor.settings': 'Settings',
  'control:monitor.scrubBar': 'scrub bar',
  'control:monitor.playhead': 'Scrub playhead',
  'control:monitor.range.body': 'Move marked range',
  'control:monitor.range.in': 'Drag In point',
  'control:monitor.range.out': 'Drag Out point',
  'control:transport.addMarker': 'Add Marker (M)',
  'control:transport.markIn': 'Mark In (I)',
  'control:transport.markOut': 'Mark Out (O)',
  'control:transport.goToIn': 'Go to In (Shift+I)',
  'control:transport.stepBack': 'Step Back 1 Frame (Left)',
  'control:transport.play': 'Play-Stop Toggle (Space)',
  'control:transport.stepForward': 'Step Forward 1 Frame (Right)',
  'control:transport.goToOut': 'Go to Out (Shift+O)',
  'control:transport.insert': 'Insert (,)',
  'control:transport.overwrite': 'Overwrite (.)',
  'control:transport.lift': 'Lift (;)',
  'control:transport.extract': "Extract (')",
  'control:transport.toggleProxies': 'Toggle Proxies',
  'control:transport.buttonEditor': 'Button Editor',
  'control:monitor.ruler.top': 'top ruler',
  'control:monitor.ruler.left': 'left ruler',
  'control:monitor.guide': 'guide',
}

const MONITOR: readonly KitUiItem[] = [
  ...Object.keys(MONITOR_ALIASES).map((id) => ({ id, label: MONITOR_LABELS[id] ?? id })),
  { id: 'control:source.drag.video', label: 'Drag Video Only' },
  { id: 'control:source.drag.audio', label: 'Drag Audio Only' },
  { id: 'control:source.drag.both', label: 'Drag Video and Audio' },
  { id: 'control:source.settings.loop', label: 'Loop marked range' },
  { id: 'control:program.textEdit', label: 'Text layer' },
  // A selected graphic layer's box, its eight handles, and its anchor point (`monitor_overlay`, `program.layer.<clip>.<layer>[.handle.<n>|.anchor]`).
  { id: 'control:program.layer', label: 'Graphic layer' },
  // Each handle names itself as upstream: "resize handle" on paragraph text, "scale handle" otherwise.
  { id: 'control:program.layer.handle', label: 'Layer handle' },
  { id: 'control:program.layer.anchor', label: 'anchor point' },
  // The Comparison View's reference frame and its bar (`compare_bar`), and the Source waveform (`waveform`).
  { id: 'control:program.compare.reference', label: 'reference frame' },
  { id: 'control:program.compare.prev', label: 'Reference: previous frame' },
  { id: 'control:program.compare.next', label: 'Reference: next frame' },
  { id: 'control:program.compare.set', label: 'Set the reference to the playhead' },
  { id: 'control:source.waveform', label: 'audio waveform' },
]

/**
 * The Project panel (`panels/project.rs`, `project_views.rs`): upstream's own element ids without
 * their run-time parts, each once (`project.menu.{}` is `control:project.menu`; the Freeform view's
 * `project.stack.{}` badge is `control:project.stack`; a floating bin window, `projectBin.{}.window`,
 * is `control:projectBin.window`, and the panel body it draws carries the panel's own ids).
 */
const PROJECT: readonly KitUiItem[] = [
  // A search bin's row (`menu_dialogs.rs` `search_bin_rows`, `project.searchBin.<id>`).
  { id: 'control:project.searchBin', label: 'Search bin' },
  ...new Map(
    upstream.elements
      // A row hidden on the web (Create Proxies…, `menus/hidden.ts`) is never drawn, so never declared.
      .filter((element) => /^project(Bin)?\./.test(element.id) && element.files.some((file: string) => /panels\/project(_views)?\.rs$/.test(file)) && !isHiddenField(element.id))
      .map((element) => {
        const id = `control:${element.id.replace(/\.?\{\}/g, '')}`
        return [id, { id, label: element.label || element.id.replace(/\.?\{\}/g, '') }] as const
      }),
  ).values(),
]

/**
 * Sort Icons' column rows: upstream builds their id at run time (`{pre}.sortIcons.{column}`, the
 * other arm of the `if` the extractor reads `userOrder` from), so the manifest lacks it; and the
 * rows upstream draws with no id at all.
 */
const PROJECT_UNREAD: readonly KitUiItem[] = [
  { id: 'control:project.sortIcons.column', label: 'Sort Icons column' },
  // Delete Search Bin, which upstream's search bin row menu draws without an id (`search_bin_rows`).
  { id: 'control:project.searchBin.delete', label: 'Delete Search Bin' },
  // Metadata Display… on a List view column header's menu, which upstream draws without an id (`list_view`).
  { id: 'control:project.list.header.metadataDisplay', label: 'Metadata Display…' },
  // The Freeform card menu's Clip Size submenu and the canvas menu's arrangement submenus and their
  // rows, one id each, which upstream draws without one (`card_menu`, `canvas_menu`).
  { id: 'control:project.cardMenu.clipSize', label: 'Clip Size' },
  { id: 'control:project.canvasMenu.restoreArrangement', label: 'Restore Arrangement' },
  { id: 'control:project.canvasMenu.deleteArrangement', label: 'Delete Arrangement' },
]

/**
 * The wrench rows upstream draws without registering an id: Show Transport Controls (both
 * monitors), the Program monitor's Loop, and the RGBA Channels submenu (its rows are the View
 * menu's `control:view.display.*`).
 */
const MONITOR_UNREGISTERED: readonly KitUiItem[] = [
  { id: 'control:monitor.showTransport', label: 'Show Transport Controls' },
  { id: 'control:monitor.loop', label: 'Loop' },
  { id: 'control:monitor.settings.rgbaChannels', label: 'RGBA Channels' },
  // The selected video clip's Motion box, its eight handles, and its anchor point: upstream's
  // `transform_handles.rs` registers them (`program.transform.box|handle.<n>|anchor`), but the
  // parity extract predates that file, so they are listed here.
  { id: 'control:program.transform.box', label: 'Motion' },
  { id: 'control:program.transform.handle', label: 'scale handle' },
  { id: 'control:program.transform.anchor', label: 'anchor point' },
]

/**
 * Audio Meters and Markers (`panels/meters.rs`, `misc.rs`): upstream's own element ids without
 * their run-time parts (`audioMeters.channel.{}` is `control:audioMeters.channel` for every
 * channel). The loudness readout (`audioMeters.loudness`) waits for wave 2.
 */
const METERS_AND_MARKERS: readonly KitUiItem[] = [
  { id: 'control:audioMeters', label: 'Audio Meters' },
  { id: 'control:audioMeters.channel', label: 'Channel level' },
  { id: 'control:markers.filter', label: 'Show or hide marker colour' },
  { id: 'control:markers.row', label: 'Marker' },
]

/**
 * The status bar and the caught-fault window (`lib.rs`): the running job's progress bar and
 * Cancel (`status.job.*`), and Save Project and Continue (`error.*`).
 */
const STATUS: readonly KitUiItem[] = [
  { id: 'control:status.job.progress', label: 'Export progress' },
  { id: 'control:status.job.cancel', label: 'Cancel' },
  { id: 'control:error.save', label: 'Save Project' },
  { id: 'control:error.dismiss', label: 'Continue' },
]

/** History's rows, which upstream draws without registering an id (`misc.rs` `history`). */
const HISTORY_UNREGISTERED: readonly KitUiItem[] = [{ id: 'control:history.row', label: 'History step' }]

/**
 * Controls upstream does not register, which Kition draws: Export MP4 in the app bar (until
 * Export mode, wave 3), the status bar's message (upstream's whole bar is one click target), the monitors' wrench rows upstream draws without an id, the Project
 * panel's Sort Icons column rows, whose id upstream builds at run time, and Effect Controls' and
 * Properties' unregistered switches, resets, and values, and History's rows. Every other
 * declared control is an element upstream registers (`film-upstream.json` `elements`, without
 * its run-time `{}` parts), or a shared id standing for some (`SHARED_ALIASES`).
 */
export const KITION_ONLY: readonly KitUiItem[] = [{ id: 'control:appBar.exportMovie', label: 'exportMovie' }, { id: 'control:status.message', label: 'Status' }, ...MONITOR_UNREGISTERED, ...PROJECT_UNREAD, ...EFFECTS_UNREGISTERED, ...EFFECTS_PANEL_UNREGISTERED, ...HISTORY_UNREGISTERED, ...DIALOG_KITION]

/**
 * Every element the Film editor draws (Kit UI protocol section 9). Ids are public: a host hides or
 * disables them by these names.
 * - `tool:<UpstreamToolName>` for upstream's 17 tools (`state.rs` `Tool`);
 * - `panel:<kind>` for upstream's 26 panels (`PanelKind::ALL`, lowerCamel); a frame and its strip
 *   carry their active tab's id;
 * - `control:<area>.<field>` for the controls, shared wherever the meaning is the same;
 * - the menu catalog the menu bar draws (`FILM_MENUS` without the rows a browser hides).
 */
export const FILM_UI: KitUiDeclaration & { tools: KitUiItem[]; panels: KitUiItem[] } = {
  tabs: [{ id: 'tab:home', label: 'homeTab' }],
  tools: FILM_TOOLS.map((tool) => ({ id: `tool:${tool.id}`, label: tool.label })),
  panels: upstream.panels.map((panel) => ({ id: `panel:${panel.id}`, label: panel.title })),
  controls: [...MODES, ...HEADER, ...WORKSPACE_DIALOGS, ...TIMELINE, ...TRACK, ...MONITOR, ...PROJECT, ...EFFECTS, ...METERS_AND_MARKERS, ...STATUS, ...DIALOG_CONTROLS, ...KITION_ONLY],
  menus: FILM_MENUS.filter((row) => !isHiddenOnWeb(row)),
}
