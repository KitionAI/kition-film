import type { MenuRow } from '@kition/kit-editor'

const HOST_FILE = 'The host opens, saves, and closes documents.'
const HOST_OPENS = 'Opens another project; the host opens documents.'
const LOCAL_FILES = 'Needs the local file system.'
const FORMER_SITE = "Links to upstream's former website."
const PREVIEWS = 'Renders previews into a local preview folder.'
const CREATE_PROXIES = 'Writes proxy files into a local folder next to the media, which the web engine cannot write.'

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
  'media.createProxies': CREATE_PROXIES,
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
]

/** Why a browser editor hides `command`, or null when it shows it. */
export function hiddenReason(command: string): string | null {
  if (HIDDEN[command]) return HIDDEN[command]
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
  // The Project item menu's Create Proxies… row, as its menu row (`media.createProxies`).
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
