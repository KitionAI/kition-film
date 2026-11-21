import { Fragment, useMemo } from 'react'
import { CommandItem, ContextMenu, MenuItem, MenuSeparator, SubMenu, useUi, type ContextMenuPoint, type Phrases } from '@kition/sdk/editor'
import type { FilmInfo } from '../film'
import { FILM_MENUS } from '../menus/catalog'
import { isHiddenCommand } from '../menus/hidden'
import type { FilmLabels } from '../session/useFilmSession'
import { CLIP_MENU, clipMenuState, opensDialog } from './clipMenuRows'

const LABEL_ROW = 'edit.label.'

/** Upstream's label rows (`Label::ALL`, the Edit ▸ Label rows): the engine's name (`Violet`) and its key (`violet`). */
const LABELS = FILM_MENUS.filter((row) => row.command.startsWith(LABEL_ROW) && row.path.join('/') === 'Edit/Label').map((row) => ({ name: row.label, key: row.command.slice(LABEL_ROW.length) }))

export type ClipMenuProps = {
  at: ContextMenuPoint | null
  onClose: () => void
  film: FilmInfo
  labels: FilmLabels | null
  /** The clip right-clicked: Unlink leaves only it selected. */
  clip: number | null
  invoke: (id: string, params?: Record<string, unknown>) => Promise<unknown>
  /** A read-only engine query: Unlink reads the selection the link leaves. */
  query: (id: string, params?: Record<string, unknown>) => Promise<unknown>
  phrase: Phrases
}

/** A command row drawn disabled while no clip is selected, under the same id (a host's hide still applies). */
function DisabledRow({ command, label }: { command: string; label: string }) {
  if (useUi().state(`command:${command}`).hidden) return null
  return <MenuItem label={label} disabled onSelect={() => undefined} uiId={`command:${command}`} testId={`film-cmd-${command}`} />
}

/**
 * The clip context menu (upstream `interact`'s `context_menu`): `CLIP_MENU`'s groups with
 * upstream's labels, Enable checked when every selected clip is enabled, Link reading Unlink when
 * one is linked, the Label submenu with the label preferences' names, and Multi-Camera disabled
 * until wave 3. With no clip selected every command row is disabled (upstream
 * `add_enabled(!sel.is_empty() && is_enabled(cmd))`); the Label submenu's rows are not (upstream
 * draws them before that check). Rows run through `invoke`; a "…" row opens its command's dialog.
 */
export function ClipMenu({ at, onClose, film, labels, clip, invoke, query, phrase }: ClipMenuProps) {
  const picked = useMemo(() => {
    const selected = new Set(film.selection)
    return film.tracks.flatMap((track) => track.clips).filter((each) => selected.has(each.id))
  }, [film])
  const state = clipMenuState(picked)
  const run = (command: string) => {
    void invoke(command, {}).then(async (answer) => {
      // Unlink: keep only the clip right-clicked selected, so it can be dragged away from the
      // others, if the selection the unlink leaves still holds it (upstream reads it after the command).
      if (command !== 'clip.link' || (answer as { linked?: boolean } | null)?.linked !== false || clip == null) return
      const selection = ((await query('state.inspect')) as { selection?: number[] } | null)?.selection ?? []
      if (selection.includes(clip)) await invoke('timeline.select', { clips: [clip] })
    })
  }
  return (
    <ContextMenu at={at} onClose={onClose} label={phrase('Clip')} testId="film-clip-menu">
      {CLIP_MENU.map((group, index) => (
        <Fragment key={group[0][1]}>
          {index > 0 ? <MenuSeparator /> : null}
          {group.map(([label, command]) => {
            // A row the web hides (a local file, the host's) is not drawn, as in the menu bar.
            if (isHiddenCommand(command)) return null
            if (command === 'edit.label')
              return (
                <SubMenu key={command} label={label} path="Edit/Label">
                  {LABELS.map((row) => (
                    <MenuItem key={row.key} label={phrase(labels?.colors[row.key]?.name ?? row.name)} uiId={`command:${LABEL_ROW}${row.key}`} testId={`film-clip-menu-label-${row.key}`} onSelect={() => void invoke('edit.label', { label: row.name })} />
                  ))}
                </SubMenu>
              )
            if (command === 'clip.multicam') return <MenuItem key={command} label={phrase(label)} disabled onSelect={() => undefined} uiId="control:timeline.clipMenu.clip.multicam" testId="film-clip-menu-multicam" />
            const shown = command === 'clip.link' && state.linked ? 'Unlink' : label
            if (!state.any) return <DisabledRow key={command} command={command} label={phrase(shown)} />
            return (
              <CommandItem
                key={command}
                command={command}
                label={phrase(shown)}
                shortcut={null}
                checked={command === 'clip.enable' ? state.allEnabled : undefined}
                ask={opensDialog(label) ? true : undefined}
                onRun={run}
              />
            )
          })}
        </Fragment>
      ))}
    </ContextMenu>
  )
}

