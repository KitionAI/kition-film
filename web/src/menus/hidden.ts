// Imports carry `.ts` and the JSON its import attribute so `node --test` loads this module as it is.
import type { MenuRow } from '@kition/sdk/editor'
import upstream from '../../parity/film-upstream.json' with { type: 'json' }

const HOST_FILE = 'The host opens, saves, and closes documents.'
const HOST_OPENS = 'Opens another project; the host opens documents.'
const LOCAL_FILES = 'Needs the local file system.'
const FORMER_SITE = "Links to upstream's former website."
const PREVIEWS = 'Renders previews into a local preview folder.'
const CREATE_PROXIES = 'Writes proxy files into a local folder next to the media, which the web engine cannot write.'
const NOT_DRAWN = 'The Preferences window is not drawn yet; its page said only "Not available in this editor yet".'
const INTERCHANGE = 'Writes an interchange file at a path no dialog asks for; interchange export is not in scope before the launch (agents run it with a path).'
const REMIX = 'Remix is not in scope before the launch; it refused on most music ("no beat found").'
const MULTICAM = 'Multi-Camera display is not drawn yet.'
const PANEL_LATER = 'The editor does not draw this panel yet; its tab said only "Not available in this editor yet".'

/**
 * Commands a browser editor never shows or binds, with the reason each is hidden (rule 2 of the
 * Film UI plan): the host's own file commands, those that open another project, those that need a
 * local file system, the host's appearance, language, and window, and links to upstream's former
 * websites. Their menu rows are not drawn, and their keys resolve to nothing (`session/keys.ts`),
 * so the shell's own Save runs.
 */
const HIDDEN: Readonly<Record<string, string>> = {
  'file.open': HOST_FILE,
  'file.close': HOST_FILE,
  'file.closeProject': HOST_FILE,
  'file.closeAllProjects': HOST_FILE,
  'file.closeAllOtherProjects': HOST_FILE,
  'file.save': HOST_FILE,
  'file.saveAs': HOST_FILE,
  'file.saveCopy': HOST_FILE,
  'file.saveAll': HOST_FILE,
  'file.revert': 'The host reverts a document to its saved copy.',
  'app.quit': 'The host owns the window and quitting.',
  'file.newProject': HOST_OPENS,
  'file.openDemoProject': HOST_OPENS,
  'file.newProjectFromTemplate': HOST_OPENS,
  'file.saveAsTemplate': 'Writes a project template to a local folder.',
  'file.recover': 'Recovers from autosave files in a local folder.',
  'file.importFromMediaBrowser': 'Imports from local folders through the Media Browser.',
  'file.importImageSequence': 'Imports a numbered image sequence from a local folder.',
  'media.relink': 'Links media to other local files.',
  // Its job writes the proxy files into a local folder next to the media; the web engine cannot
  // write them (the job fails at its first file), so Create Proxies… is hidden with its fields.
  'media.addProxies': CREATE_PROXIES,
  'media.findMissing': 'Searches local folders for missing media.',
  'media.autoRelink': 'Searches local folders for missing media.',
  // Upstream opens Project Settings at Scratch Disks: local folders for captures, render previews,
  // and auto-saves. A browser has none: previews are hidden and the host keeps the document.
  'file.projectSettings.scratchDisks': 'Sets local folders for captures, previews, and auto-saves.',
  'projectPanel.revealProject': 'Shows the project file in the operating system file manager.',
  'help.revealLogFiles': 'Shows log files in the operating system file manager.',
  // The engine renders previews into a local folder, and Project Manager copies into one: run
  // with no folder (as in a browser), they refuse.
  'sequence.renderEffectsInToOut': PREVIEWS,
  'sequence.renderInToOut': PREVIEWS,
  'sequence.renderSelection': PREVIEWS,
  'sequence.renderAudio': PREVIEWS,
  'sequence.deleteRenderFiles': 'Preview files never exist on the web.',
  'sequence.deleteRenderFilesInToOut': 'Preview files never exist on the web.',
  'file.projectManager': 'Copies the project and its media into a local folder.',
  'window.toggleFullScreen': 'The host owns the window.',
  'help.discord': "Links to upstream's former community chat.",
  'help.website': FORMER_SITE,
  'help.appPage': FORMER_SITE,
  'help.github': "Links to upstream's former source repository.",
  'help.reportIssue': "Links to upstream's former issue tracker.",
  'help.kitionFilmHelp': "Opens online help the kit does not have.",
  'app.about': "Describes upstream's app; Kition's About (kit:help.about) replaces it.",
}

/** Hidden by prefix: the media cache's local folders, and the host's appearance and language. */
const HIDDEN_PREFIXES: ReadonlyArray<readonly [string, string]> = [
  ['mediaCache.', 'Manages the media cache in a local folder.'],
  ['view.theme.', 'The host owns the appearance.'],
  ['app.language.', 'The host owns the language.'],
  // The Preferences window's pages are not drawn yet: each row only said "Not available in this editor yet".
  ['app.settings.', NOT_DRAWN],
]

/**
 * Phase 1 of the plan "Film usable by hand" (no dead ends): what a person met that only said "Not
 * available in this editor yet", failed at once for want of a parameter no dialog asks for, or did
 * nothing on the web. The engine keeps every command (agents still run them, with their
 * parameters); only the menus, keys, and panels a person sees leave them out.
 */
const DEAD_ENDS: Readonly<Record<string, string>> = {
  // Interchange formats write a file at a path no dialog asks for (not in scope before the launch).
  'file.exportEdl': INTERCHANGE,
  'file.exportAle': INTERCHANGE,
  'file.exportOtio': INTERCHANGE,
  'file.exportFcp7Xml': INTERCHANGE,
  'file.exportFcpxml': INTERCHANGE,
  'file.exportAaf': INTERCHANGE,
  'file.exportOmf': INTERCHANGE,
  // Export mode (File ▸ Export ▸ Export, Cmd+M) is not drawn; Export Media and the app bar's Export MP4 export.
  'mode.export': 'Export mode is not drawn yet; File ▸ Export ▸ Media and Export MP4 export the sequence.',
  'graphics.newFromFile': 'Places a picture file at a path no dialog asks for; File ▸ Import brings pictures into the project.',
  'graphics.template.install': 'Installs a Motion Graphics template from a path no dialog asks for; templates are not in scope before the launch.',
  'file.replaceFonts': 'Needs the font to replace, which no dialog asks for; not in scope before the launch.',
  'clip.remix.enable': REMIX,
  'clip.remix.properties': REMIX,
  'clip.remix.revert': REMIX,
  'view.display.multicam': MULTICAM,
  'multicam.toggleView': MULTICAM,
  'help.systemCompatibilityReport': 'The System Compatibility Report is not drawn.',
  'edit.editOriginal': 'Opens the media in another application, which a browser editor cannot start.',
  'clip.generateAudioWaveform': 'The web editor draws waveforms by itself: there is nothing to generate.',
}

/** Upstream's panels the editor does not draw (Window ▸ <panel> and every workspace leave them out), with why. */
const HIDDEN_PANELS: Readonly<Record<string, string>> = {
  mediaBrowser: 'Browses local folders; File ▸ Import picks media through the host.',
  libraries: 'Libraries are not built.',
  audioClipMixer: PANEL_LATER,
  metadata: PANEL_LATER,
  color: PANEL_LATER,
  scopes: PANEL_LATER,
  graphicsTemplates: PANEL_LATER,
  audioMixing: PANEL_LATER,
  text: PANEL_LATER,
  events: PANEL_LATER,
  progress: PANEL_LATER,
  referenceMonitor: PANEL_LATER,
  timecode: PANEL_LATER,
}

/** Built-in workspaces left out: every panel they are for is one the editor does not draw. */
const HIDDEN_WORKSPACES: Readonly<Record<string, string>> = {
  Color: 'Its panels (Color, Scopes) are not drawn; without them it is Assembly.',
  Audio: 'Its Audio Clip Mixer and Audio Mixing panels are not drawn; the Audio Track Mixer opens from Window ▸ Audio Track Mixer.',
  'Captions and Graphics': 'Its panels (Text, Graphics Templates) are not drawn; without them it is Editing.',
}

/** `window.panel.<Kind>` (upstream's Window rows) and `window.workspace.<slug>` of what is hidden, with the reason. */
const HIDDEN_WINDOW_ROWS: Readonly<Record<string, string>> = Object.fromEntries([
  ...upstream.panels.filter((panel) => HIDDEN_PANELS[panel.id]).map((panel) => [`window.panel.${panel.kind}`, HIDDEN_PANELS[panel.id]]),
  ...Object.entries(HIDDEN_WORKSPACES).map(([name, reason]) => [`window.workspace.${name.toLowerCase().replaceAll(' ', '')}`, reason]),
])

/** Why the editor does not draw the panel `panel` (a lowerCamel id), or null when it draws it. */
export function hiddenPanelReason(panel: string): string | null {
  return HIDDEN_PANELS[panel] ?? null
}

/** Why the built-in workspace `name` is left out, or null when it is offered. */
export function hiddenWorkspaceReason(name: string): string | null {
  return HIDDEN_WORKSPACES[name] ?? null
}

/** Why a browser editor hides `command`, or null when it shows it. */
export function hiddenReason(command: string): string | null {
  const reason = HIDDEN[command] ?? DEAD_ENDS[command] ?? HIDDEN_WINDOW_ROWS[command]
  if (reason) return reason
  return HIDDEN_PREFIXES.find(([prefix]) => command.startsWith(prefix))?.[1] ?? null
}

/** Whether `command` is hidden on the web: its keys resolve to nothing (`EditorFrame`'s `hiddenCommands`). */
export function isHiddenCommand(command: string) {
  return hiddenReason(command) != null
}

/** Whether a catalog row is never shown on the web (`catalogTabs`'s `hidden`): its command's, a Kition `kit:` row's by the upstream id it carries. */
export function isHiddenOnWeb(row: MenuRow) {
  return isHiddenCommand(row.command.startsWith('kit:') ? row.command.slice('kit:'.length) : row.command)
}

const SCRATCH_DISKS = 'Sets local folders for captures, previews, and auto-saves.'
const LINK_SEARCH = 'Searches local folders for the missing file; Locate… picks it through the host.'
const PROXY_FOLDER = 'A local folder for proxies; proxies go next to the project.'

/**
 * Dialog fields a browser editor never draws (rule 2 of the Film UI plan), by upstream's
 * automation id (`<prefix>.<field>`; a `{}` segment stands for any value), with the reason each
 * is hidden: Project Settings ▸ Scratch Disks and Ingest's destination, Link Media's folder
 * search, Create Proxies' destination, and Make Offline's choice to delete media files.
 */
const HIDDEN_FIELDS: Readonly<Record<string, string>> = {
  'projectSettings.tab.scratchDisks': SCRATCH_DISKS,
  'linkMedia.folder': LINK_SEARCH,
  'linkMedia.browse': LINK_SEARCH,
  'linkMedia.search': LINK_SEARCH,
  'linkMedia.exactName': LINK_SEARCH,
  'linkMedia.preview': LINK_SEARCH,
  'proxies.destination': PROXY_FOLDER,
  'proxies.browse': PROXY_FOLDER,
  'makeOffline.delete': 'Deleting media files belongs to the host.',
  'projectSettings.ingest.destination': 'Ingests into a local folder next to the media; the host keeps media files.',
  // The Project item menu's Create Proxies… row, as its menu row (`media.addProxies`).
  'project.itemMenu.createProxies': CREATE_PROXIES,
}
/** Hidden fields by id prefix: every Scratch Disks row, Link Media's candidate files, and Create Proxies' others (its command is hidden). */
const HIDDEN_FIELD_PREFIXES: ReadonlyArray<readonly [string, string]> = [
  ['projectSettings.scratch.', SCRATCH_DISKS],
  ['linkMedia.candidate.', LINK_SEARCH],
  ['proxies.', CREATE_PROXIES],
]

/** Why a browser editor hides the dialog field `id` (`control:dialog.` may lead it), or null when it draws it. */
export function hiddenFieldReason(id: string): string | null {
  const field = id.startsWith('control:dialog.') ? id.slice('control:dialog.'.length) : id
  if (HIDDEN_FIELDS[field]) return HIDDEN_FIELDS[field]
  return HIDDEN_FIELD_PREFIXES.find(([prefix]) => field.startsWith(prefix))?.[1] ?? null
}

/** Whether a dialog skips the field `id` (`dialogs/fields.tsx`). */
export function isHiddenField(id: string) {
  return hiddenFieldReason(id) != null
}
