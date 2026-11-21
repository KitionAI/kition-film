import { useLayoutEffect, useRef, useState } from 'react'
import { TesseraIcons } from '@kition/sdk/editor'
import { ContextMenu, MenuItem, MenuSeparator, type ContextMenuPoint, type Phrases } from '@kition/sdk/editor'
import { workspaceSlug } from '../menus/catalog'

const Bell = TesseraIcons.BellIcon
const PanelsTopLeft = TesseraIcons.PanelsTopLeftIcon
const Search = TesseraIcons.SearchIcon
const Volume2 = TesseraIcons.Volume2Icon

/** Upstream's three modes; only Edit exists in this editor (Import and Export are wave 3). */
const MODES = [
  { id: 'import', label: 'Import', enabled: false },
  { id: 'edit', label: 'Edit', enabled: true },
  { id: 'export', label: 'Export', enabled: false },
] as const

export type HeaderProps = {
  /** The project's name (upstream adds " - Edited" while it has unsaved changes). */
  title: string
  names: readonly string[]
  current: string
  /** Runs a command through `invoke`. */
  onInvoke: (command: string) => void
  /** Shows a message in the status bar (upstream's English; the status bar translates it). */
  status: (message: string) => void
  phrase: Phrases
  notAvailable: string
}

/**
 * The header bar (upstream `header.rs`): the Import, Edit, and Export modes, the document title
 * in the middle, and at the right the workspace name and menu, Progress, Search, and Volume. It
 * is the row under the menu bar, as upstream's header is under macOS's own menu bar (in-window
 * menus beside the modes leave no room for the title in a 1100 px window). Home (the host's start screen), Discord (upstream's former community), full screen
 * (the host's window), and Quick Export (wave 3) are not drawn.
 */
export function Header({ title, names, current, onInvoke, status, phrase, notAvailable }: HeaderProps) {
  const [popup, setPopup] = useState<ContextMenuPoint | null>(null)
  const button = useRef<HTMLButtonElement>(null)
  /**
   * Whether the popup was open when its button was pressed: that press closes it (a press outside
   * a menu does), and the click that follows must not open it again. Read in a window listener
   * added before the menu's own, so it sees the popup still open.
   */
  const wasOpen = useRef(false)
  const openNow = useRef(false)
  openNow.current = popup !== null
  useLayoutEffect(() => {
    const onDown = (event: PointerEvent) => {
      if (button.current?.contains(event.target as Node)) wasOpen.current = openNow.current
    }
    window.addEventListener('pointerdown', onDown, true)
    return () => window.removeEventListener('pointerdown', onDown, true)
  }, [])
  return (
    <div className="film-header" data-testid="film-header">
      <div className="film-modes" role="tablist" aria-label={phrase('Mode')}>
        {MODES.map((mode) => (
          <button
            key={mode.id}
            type="button"
            role="tab"
            className="film-mode"
            aria-selected={mode.id === 'edit'}
            disabled={!mode.enabled}
            title={mode.enabled ? phrase(mode.label) : notAvailable}
            data-testid={`film-mode-${mode.id}`}
            data-kit-ui-id={`control:header.mode.${mode.id}`}
            onClick={() => onInvoke(`mode.${mode.id}`)}
          >
            {phrase(mode.label)}
          </button>
        ))}
      </div>
      <div className="film-title" data-testid="film-title" title={title}>
        {title}
      </div>
      <div className="film-header-end">
        <button
          ref={button}
          type="button"
          className="film-header-workspace"
          aria-haspopup="menu"
          aria-expanded={popup !== null}
          title={phrase('Workspaces')}
          data-testid="film-header-workspaces"
          data-kit-ui-id="control:header.workspaces"
          onClick={() => {
            const box = button.current?.getBoundingClientRect()
            setPopup(wasOpen.current || !box ? null : { x: box.left, y: box.bottom + 4 })
            wasOpen.current = false
          }}
        >
          <span>{phrase(current).toUpperCase()}</span>
          <PanelsTopLeft size={16} aria-hidden="true" />
        </button>
        <button
          type="button"
          className="kui-icon-button"
          aria-label={phrase('Progress')}
          title={notAvailable}
          disabled
          data-testid="film-header-notifications"
          data-kit-ui-id="control:header.notifications"
        >
          <Bell size={16} aria-hidden="true" />
        </button>
        <button type="button" className="kui-icon-button" aria-label={phrase('Search')} title={phrase('Search')} data-testid="film-header-search" data-kit-ui-id="control:header.search" onClick={() => onInvoke('window.panel.Effects')}>
          <Search size={16} aria-hidden="true" />
        </button>
        <button
          type="button"
          className="kui-icon-button"
          aria-label={phrase('Volume')}
          title={phrase('Volume')}
          data-testid="film-header-volume"
          data-kit-ui-id="control:header.volume"
          onClick={() => status('Master volume: use the Audio Track Mixer')}
        >
          <Volume2 size={16} aria-hidden="true" />
        </button>
      </div>
      <ContextMenu
        at={popup}
        onClose={() => setPopup(null)}
        label={phrase('Workspaces')}
        testId="film-workspaces-popup"
      >
        {names.map((name) => (
          <MenuItem key={name} label={phrase(name)} checked={name === current} uiId={`control:window.workspace.${workspaceSlug(name)}`} testId={`film-workspaces-${workspaceSlug(name)}`} onSelect={() => onInvoke(`window.workspace.${workspaceSlug(name)}`)} />
        ))}
        <MenuSeparator />
        <MenuItem label={phrase('Reset to Saved Layout')} uiId="control:window.workspace.reset" testId="film-workspaces-reset" onSelect={() => onInvoke('window.workspace.reset')} />
      </ContextMenu>
    </div>
  )
}
