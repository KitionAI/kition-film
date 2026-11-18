// The plan's wave rules (Film UI parity, wave 1, Task 1 step 2), shared by extract.mjs, which
// writes the first status of every item with them, and check.test.mjs, which checks that every
// `todo` entry without a reason or a note still carries the wave they give. Node, no dependencies.

/** `dock.rs` `slug`: `Captions and Graphics` → `captionsandgraphics`. */
export const slug = (name) => name.toLowerCase().replaceAll(' ', '')

const WAVE3_PREFIXES = ['multicam.', 'clip.multicam', 'clip.createMulticam', 'clip.remix', 'voiceover.', 'transcript.', 'sequence.transcribe', 'mode.', 'file.export', 'file.projectManager', 'app.settings.', 'app.keyboardShortcuts', 'help.systemCompatibilityReport', 'trim.monitor']
// `textPanel.` is the Text panel's (wave 2) navigation, like the other wave-2 panels' prefixes.
const WAVE2_PREFIXES = ['captions.', 'color.', 'audioMixing', 'mixer.', 'clipMixer.', 'graphics.template', 'masks.', 'view.guideTemplates', 'view.display.', 'view.compare.', 'textPanel.']
const WAVE2_IDS = ['view.addGuide', 'view.showRulers', 'view.showGuides', 'view.lockGuides', 'view.clearGuides', 'view.snapInProgramMonitor', 'window.openSearch', 'panel.selectFindBox']
/**
 * Wave-1 commands despite a rule above: File ▸ Import (Task 18 imports through it), Save as New
 * Workspace… and Edit Workspaces… (Task 12 builds their dialogs), and the Edit mode (wave 1's
 * whole editor; only Import and Export modes wait for wave 3).
 */
const WAVE1_EXCEPTIONS = ['file.import', 'window.workspace.saveAs', 'window.workspace.edit', 'mode.edit']

/**
 * The wave of a command (a menu row, a key, or the command an element runs). `dialogs` are the
 * commands upstream answers with a dialog (the manifest's `dialogs`).
 */
export function commandWave(command, label, dialogs) {
  if (WAVE1_EXCEPTIONS.includes(command)) return 1
  if (WAVE3_PREFIXES.some((prefix) => command.startsWith(prefix)) || command.startsWith('file.import')) return 3
  if (WAVE2_PREFIXES.some((prefix) => command.startsWith(prefix)) || WAVE2_IDS.includes(command) || label?.endsWith('…') || dialogs.includes(command)) return 2
  return 1
}

const PANEL_WAVES = {
  1: ['project', 'source', 'program', 'timeline', 'tools', 'effectControls', 'properties', 'audioMeters', 'markers', 'history', 'info', 'libraries'],
  2: ['effects', 'color', 'scopes', 'graphicsTemplates', 'audioMixing', 'audioTrackMixer', 'audioClipMixer', 'text', 'metadata', 'timecode', 'events', 'progress'],
  3: ['mediaBrowser', 'referenceMonitor'],
}
/** A panel's wave; 0 when the plan names none (extract.mjs refuses that). */
export const panelWave = (id) => Number(Object.entries(PANEL_WAVES).find(([, ids]) => ids.includes(id))?.[0] ?? 0)

const FILE_WAVES = {
  1: ['header.rs', 'dock.rs', 'lib.rs', 'mod.rs', 'tools.rs', 'timeline.rs', 'timeline_hit.rs', 'monitor.rs', 'monitor_view.rs', 'source_range.rs', 'source_drag.rs', 'project.rs', 'project_views.rs', 'effect_controls.rs', 'meters.rs', 'misc.rs', 'workspaces.rs', 'keyboard.rs'],
  2: ['lumetri.rs', 'scopes.rs', 'essential_sound.rs', 'mixer.rs', 'audio_fx_editor.rs', 'text.rs', 'timeline_captions.rs', 'timeline_automation.rs', 'effects.rs', 'presets.rs', 'graphics.rs', 'masks.rs', 'dialogs.rs', 'clip_dialogs.rs', 'color_dialogs.rs', 'menu_dialogs.rs', 'media_dialogs.rs', 'project_dialogs.rs', 'sequence_settings.rs', 'metadata.rs', 'timecode.rs', 'events.rs', 'settings.rs'],
}
/** An upstream file's wave, by its name (`panels/timeline.rs` is `timeline.rs`); every other file is wave 3. */
export const fileWave = (file) => Number(Object.entries(FILE_WAVES).find(([, names]) => names.includes(file.split('/').pop()))?.[0] ?? 3)

/**
 * multicam.rs's `show_dialog` also draws Synchronize Clips and Merge Clips, wave-2 dialogs (the
 * wave-2 plan's Task 12): their own fields are wave 2, though the file's multi-camera parts are wave 3.
 */
const SYNC_AND_MERGE = ['{}.ignoreHours', '{}.marker', '{}.offset', 'sync.track', 'merge.removeVideoAudio']

/**
 * An element's wave: the lowest wave of the files that register its id, then no earlier than the
 * command it runs (its wave counts the "…" rule), or than 2 when its label ends in "…".
 */
export function elementWave(element, dialogs) {
  if (SYNC_AND_MERGE.includes(element.id)) return 2
  const files = Math.min(...element.files.map(fileWave))
  if (element.command) return Math.max(files, commandWave(element.command, element.label, dialogs))
  return element.label?.endsWith('…') ? Math.max(files, 2) : files
}

/**
 * A key's wave: its command's, and when every binding is scoped to panels, no earlier than the
 * earliest of those panels (Media Browser's keys wait for the Media Browser).
 */
export function keyWave(key, manifest) {
  const wave = commandWave(key.command, key.label, manifest.dialogs)
  const scoped = key.bindings.length > 0 && key.bindings.every((binding) => binding.panel)
  if (!scoped) return wave
  const byTitle = new Map(manifest.panels.map((panel) => [panel.title, panel.id]))
  return Math.max(wave, Math.min(...key.bindings.map((binding) => panelWave(byTitle.get(binding.panel)) || 1)))
}

/** Every status key the manifest implies, with the wave the rules give it, in manifest order. */
export function ruleWaves(manifest) {
  const items = new Map()
  for (const row of manifest.menus) items.set(`menu:${row.path.join('/')}/${row.command}`, commandWave(row.command, row.label, manifest.dialogs))
  for (const key of manifest.keys) items.set(`key:${key.command}`, keyWave(key, manifest))
  for (const tool of manifest.tools) items.set(`tool:${tool.id}`, tool.id === 'Remix' ? 3 : 1)
  for (const panel of manifest.panels) items.set(`panel:${panel.id}`, panelWave(panel.id))
  for (const workspace of manifest.workspaces) items.set(`workspace:${slug(workspace.name)}`, 1)
  for (const element of manifest.elements) items.set(`element:${element.id}`, elementWave(element, manifest.dialogs))
  for (const hint of manifest.hints) items.set(`hint:${hint.tool}`, 1)
  return items
}
