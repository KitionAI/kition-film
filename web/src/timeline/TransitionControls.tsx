import { useState } from 'react'
import { Button, ContextMenu, Dialog, MenuItem, TimecodeField, type ContextMenuPoint, type Phrases } from '@kition/sdk/editor'
import type { FilmInfo } from '../film'
import { findTransition } from './useGestures'
import { appliedTransition, durationCommand, maxFrames } from './transitions'
import { localSelection } from '../session/localSelection'

/**
 * A transition's menu on the Timeline: Set Transition Duration…. The engine has no command that
 * removes one transition or moves it along its cut, so neither Clear nor an alignment is offered
 * (Undo takes back the step that added it).
 */
export function TransitionMenu({ at, onClose, onDuration, phrase }: { at: ContextMenuPoint; onClose: () => void; onDuration: () => void; phrase: Phrases }) {
  return (
    <ContextMenu at={at} onClose={onClose} label={phrase('Transition')} testId="film-transition-menu">
      <MenuItem label={phrase('Set Transition Duration…')} uiId="control:timeline.transitionMenu.setDuration" testId="film-transition-menu-duration" onSelect={onDuration} />
    </ContextMenu>
  )
}

/**
 * Set Transition Duration (upstream `transition_controls.rs` `duration_dialog`, which a
 * double-click on a transition opens): its length as timecode, from one frame to what the clips it
 * joins allow. OK applies it again with the new length (`durationCommand`), one undo step.
 */
export function TransitionDurationDialog({ id, film, invoke, onClose, phrase }: { id: number; film: FilmInfo | null; invoke: (id: string, params?: Record<string, unknown>) => Promise<unknown>; onClose: () => void; phrase: Phrases }) {
  const found = findTransition(film, id)
  const frame = film ? Math.round(film.frame * film.ticksPerSecond) : 0
  const [frames, setFrames] = useState(() => (found && frame > 0 ? Math.max(1, Math.round(found.info.duration / frame)) : 1))
  if (!found || !film || !(frame > 0)) return null
  const limit = maxFrames(found.info, found.clips, frame)
  const ok = async () => {
    const command = durationCommand(found.info, found.kind, Math.min(limit, Math.max(1, frames)))
    onClose()
    if (!command) return
    const applied = appliedTransition(await invoke(command.id, command.params))
    if (applied != null) localSelection.set({ transition: applied })
  }
  return (
    <Dialog
      title={phrase('Set Transition Duration')}
      onClose={onClose}
      actions={
        <>
          <Button data-testid="film-transition-duration-cancel" data-kit-ui-id="control:transitionDuration.cancel" onClick={onClose}>
            {phrase('Cancel')}
          </Button>
          <Button variant="primary" data-testid="film-transition-duration-ok" data-kit-ui-id="control:transitionDuration.ok" onClick={() => void ok()}>
            {phrase('OK')}
          </Button>
        </>
      }
    >
      <div className="film-dialog-row">
        <span>{phrase('Duration:')}</span>
        <TimecodeField
          label={phrase('Duration:')}
          value={frames / film.fps}
          fps={film.fps}
          dropFrame={film.dropFrame}
          onChange={(seconds) => setFrames(Math.min(limit, Math.max(1, Math.round(seconds * film.fps))))}
          uiId="control:transitionDuration.value"
          testId="film-transition-duration-value"
        />
      </div>
    </Dialog>
  )
}
