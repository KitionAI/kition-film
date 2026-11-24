import { useState } from 'react'
import { Button, Choice, ContextMenu, Dialog, MenuItem, TimecodeField, type ContextMenuPoint, type Phrases } from '@kition/sdk/editor'
import type { FilmInfo } from '../film'
import { findTransition } from './useGestures'
import { ALIGNMENT_LABELS, alignedMaxFrames, alignmentAt, boundsOf, durationCommand, type Alignment } from './transitions'
import { localSelection } from '../session/localSelection'

/**
 * A transition's menu on the Timeline: Set Transition Duration… and Clear Transition (upstream's
 * transition context menu; Clear is `sequence.removeTransition`, one undo step).
 */
export function TransitionMenu({ at, onClose, onDuration, onClear, phrase }: { at: ContextMenuPoint; onClose: () => void; onDuration: () => void; onClear: () => void; phrase: Phrases }) {
  return (
    <ContextMenu at={at} onClose={onClose} label={phrase('Transition')} testId="film-transition-menu">
      <MenuItem label={phrase('Set Transition Duration…')} uiId="control:timeline.transitionMenu.setDuration" testId="film-transition-menu-duration" onSelect={onDuration} />
      <MenuItem label={phrase('Clear Transition')} uiId="control:timeline.transitionMenu.clear" testId="film-transition-menu-clear" onSelect={onClear} />
    </ContextMenu>
  )
}

/**
 * Set Transition Duration (upstream `transition_controls.rs` `duration_dialog`, which a
 * double-click on a transition opens): its length as timecode, from one frame to what the clips it
 * joins allow with the alignment chosen, and, between two clips, its alignment (Center, Start or
 * End at Cut; one moved off them reads Custom Start until another is chosen). OK sends one
 * `sequence.setTransition` (`durationCommand`), one undo step.
 */
export function TransitionDurationDialog({ id, film, invoke, onClose, phrase }: { id: number; film: FilmInfo | null; invoke: (id: string, params?: Record<string, unknown>) => Promise<unknown>; onClose: () => void; phrase: Phrases }) {
  const found = findTransition(film, id)
  const frame = film ? Math.round(film.frame * film.ticksPerSecond) : 0
  const [frames, setFrames] = useState(() => (found && frame > 0 ? Math.max(1, Math.round(found.info.duration / frame)) : 1))
  const bounds = found ? boundsOf(found.info, found.clips) : null
  const initial = found && bounds ? alignmentAt(found.info, bounds.cut, frame) : 'center'
  const [alignment, setAlignment] = useState<Alignment | 'custom'>(initial)
  if (!found || !film || !(frame > 0)) return null
  const two = found.info.from != null && found.info.to != null
  const limit = alignedMaxFrames(found.info, found.clips, alignment, frame)
  const ok = async () => {
    const align = alignment !== 'custom' && alignment !== initial ? alignment : undefined
    const command = durationCommand(found.info, found.kind, Math.min(limit, Math.max(1, frames)), align)
    onClose()
    if (!command) return
    await invoke(command.id, command.params)
    localSelection.set({ transition: id })
  }
  const choices = (['center', 'start', 'end', ...(initial === 'custom' ? ['custom' as const] : [])] as const).map((value) => [value, phrase(ALIGNMENT_LABELS[value])] as const)
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
          value={Math.min(frames, limit) / film.fps}
          fps={film.fps}
          dropFrame={film.dropFrame}
          onChange={(seconds) => setFrames(Math.min(limit, Math.max(1, Math.round(seconds * film.fps))))}
          uiId="control:transitionDuration.value"
          testId="film-transition-duration-value"
        />
      </div>
      {two ? (
        <div className="film-dialog-row">
          <span>{phrase('Alignment')}</span>
          <span className="film-ec-choice" data-kit-ui-id="control:transitionDuration.alignment">
            <Choice quiet label={phrase('Alignment')} value={alignment} choices={choices} onChange={(next) => setAlignment(next as Alignment | 'custom')} testId="film-transition-duration-alignment" />
          </span>
        </div>
      ) : null}
    </Dialog>
  )
}
