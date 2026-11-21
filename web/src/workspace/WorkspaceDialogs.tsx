import { useState } from 'react'
import { Button, Dialog, type Phrases } from '@kition/sdk/editor'

export type WorkspaceDialog = 'saveAs' | 'edit'

type Props = {
  dialog: WorkspaceDialog
  names: readonly string[]
  /** Names with a saved layout: a built-in among them offers Restore Original. */
  saved: readonly string[]
  isBuiltin: (name: string) => boolean
  /** Runs `window.workspace.*` through `invoke`: null when it failed (the status bar says why). */
  run: (command: string, params: Record<string, unknown>) => Promise<unknown>
  onClose: () => void
  phrase: Phrases
}

/**
 * Save as New Workspace… and Edit Workspaces… (upstream `panels/workspaces.rs` `dialogs`). Both
 * act through `window.workspace.*`, so a refusal shows in the status bar and the dialog stays
 * open. Save closes on success; Edit Workspaces stays open until Close (or Escape).
 */
export function WorkspaceDialogs(props: Props) {
  return props.dialog === 'saveAs' ? <SaveAs {...props} /> : <EditWorkspaces {...props} />
}

function SaveAs({ run, onClose, phrase }: Props) {
  const [name, setName] = useState(() => phrase('Untitled Workspace'))
  const save = async () => {
    if ((await run('window.workspace.saveAs', { name })) != null) onClose()
  }
  return (
    <Dialog
      title={phrase('New Workspace')}
      onClose={onClose}
      actions={
        <>
          <Button data-testid="film-workspace-save-cancel" data-kit-ui-id="control:workspaces.save.cancel" onClick={onClose}>
            {phrase('Cancel')}
          </Button>
          <Button variant="primary" data-testid="film-workspace-save-ok" data-kit-ui-id="control:workspaces.save.ok" onClick={() => void save()}>
            {phrase('OK')}
          </Button>
        </>
      }
    >
      <label className="film-dialog-row">
        <span>{phrase('Name:')}</span>
        <input
          className="kui-field"
          value={name}
          autoFocus
          onFocus={(event) => event.currentTarget.select()}
          onChange={(event) => setName(event.currentTarget.value)}
          onKeyDown={(event) => {
            // Not while an input method composes text: its Enter commits the composition.
            if (event.key === 'Enter' && !event.nativeEvent.isComposing && event.keyCode !== 229) void save()
          }}
          data-testid="film-workspace-save-name"
          data-kit-ui-id="control:workspaces.save.name"
        />
      </label>
    </Dialog>
  )
}

function EditWorkspaces({ names, saved, isBuiltin, run, onClose, phrase }: Props) {
  const [selected, setSelected] = useState<string | null>(null)
  const [name, setName] = useState('')
  const chosen = selected !== null && names.includes(selected) ? selected : null
  const own = chosen !== null && !isBuiltin(chosen)
  // A built-in can't be deleted; its saved changes can (Restore Original).
  const restore = chosen !== null && isBuiltin(chosen) && saved.includes(chosen)
  return (
    <Dialog
      title={phrase('Edit Workspaces')}
      onClose={onClose}
      actions={
        <Button data-testid="film-workspace-edit-close" data-kit-ui-id="control:workspaces.edit.close" onClick={onClose}>
          {phrase('Close')}
        </Button>
      }
    >
      <div className="film-workspace-list" role="listbox" aria-label={phrase('Workspaces')}>
        {names.map((item, index) => (
          <button
            key={item}
            type="button"
            role="option"
            aria-selected={item === chosen}
            className="film-workspace-row"
            data-testid={`film-workspace-edit-row-${index}`}
            data-kit-ui-id="control:workspaces.edit.row"
            onClick={() => {
              setSelected(item)
              setName(item)
            }}
          >
            {phrase(item)}
          </button>
        ))}
      </div>
      <div className="film-dialog-row">
        <span>{phrase('Name:')}</span>
        <input className="kui-field" value={name} disabled={!own} onChange={(event) => setName(event.currentTarget.value)} data-testid="film-workspace-edit-name" data-kit-ui-id="control:workspaces.edit.name" />
        <Button
          disabled={!own || chosen === name.trim()}
          data-testid="film-workspace-edit-rename"
          data-kit-ui-id="control:workspaces.edit.rename"
          onClick={() => {
            if (chosen === null) return
            void run('window.workspace.rename', { from: chosen, to: name })
            setSelected(name.trim())
          }}
        >
          {phrase('Rename')}
        </Button>
        <Button
          disabled={!own && !restore}
          data-testid="film-workspace-edit-delete"
          data-kit-ui-id="control:workspaces.edit.delete"
          onClick={() => {
            if (chosen === null) return
            void run('window.workspace.delete', { name: chosen })
            if (own) {
              setSelected(null)
              setName('')
            }
          }}
        >
          {restore ? phrase('Restore Original') : phrase('Delete')}
        </Button>
      </div>
    </Dialog>
  )
}
