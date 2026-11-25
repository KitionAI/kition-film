// The command ids of 2026-11-25. `film-upstream.json` and `film-status.json` keep the ids the
// manifest was extracted with (upstream's menus, keys, dialogs and elements name them, and the status
// file's keys are built from them); the engine's commands follow the command naming standard since
// then. `renames.json` is the table between the two: the id the manifest has -> the engine's id
// (a copy of kition-plan's `tools/command-renames/maps/film.json`). Everything that joins the
// manifest or the status file with the kit's own commands goes through this file.
//
// Element ids (`project.newItem.file.newBarsAndTone`) are interface ids, not command ids: they stay
// as the manifest has them, and a control that builds one from its command uses `upstreamCommand`.
import renames from './renames.json' with { type: 'json' }

const TO_KIT: ReadonlyMap<string, string> = new Map(Object.entries(renames))
const TO_UPSTREAM: ReadonlyMap<string, string> = new Map(Object.entries(renames).map(([was, now]) => [now, was]))

/** The engine's id of the command the manifest calls `id` (ids the rename left alone are returned as they are). */
export const kitCommand = (id: string): string => TO_KIT.get(id) ?? id

/** The id the manifest and the status file have for the engine's command `id`. */
export const upstreamCommand = (id: string): string => TO_UPSTREAM.get(id) ?? id

type Commanded = { command?: string }
type Manifest = { menus?: readonly Commanded[]; keys?: readonly Commanded[]; elements?: readonly Commanded[]; dialogs?: readonly string[] }

/**
 * `manifest` with every command under the engine's id: the `command` of its menus, keys and
 * elements, and its dialogs. Element ids, labels and everything else are untouched. A status key
 * of one of its rows is built with `upstreamCommand(row.command)`.
 */
export function kitManifest<M extends Manifest>(manifest: M): M {
  const rows = <R extends Commanded>(list: readonly R[]): R[] => list.map((row) => (row.command == null ? row : { ...row, command: kitCommand(row.command) }))
  return {
    ...manifest,
    ...(manifest.menus ? { menus: rows(manifest.menus) } : {}),
    ...(manifest.keys ? { keys: rows(manifest.keys) } : {}),
    ...(manifest.elements ? { elements: rows(manifest.elements) } : {}),
    ...(manifest.dialogs ? { dialogs: manifest.dialogs.map(kitCommand) } : {}),
  }
}
