import { CommandItem, ContextMenu, MenuItem, MenuSeparator, type ContextMenuPoint, type Phrases } from '@kition/sdk/editor'
import type { FilmInfo } from '../film'
import { laneMenuState, rulerTicks } from './menusAt'

type Invoke = (id: string, params?: Record<string, unknown>) => Promise<unknown>

/**
 * The ruler's menu (upstream `ruler_menu`), at the time right-clicked rather than the playhead: Mark
 * In and Mark Out there, Clear In and Out, Add Marker there; on a marker, Edit Marker… and Clear
 * Selected Marker (upstream's marker menu), the playhead put on the marker first as upstream does.
 * Each row is one engine command, one undo step.
 */
export function RulerMenu({ at, seconds, marker, film, invoke, onClose, phrase }: { at: ContextMenuPoint; seconds: number; marker: number | null; film: FilmInfo; invoke: Invoke; onClose: () => void; phrase: Phrases }) {
  const time = rulerTicks(seconds, film.fps, film.ticksPerSecond)
  const run = (id: string, params: Record<string, unknown> = {}) => {
    onClose()
    void invoke(id, params)
  }
  const found = marker != null ? film.markers.find((each) => each.id === marker) : undefined
  return (
    <ContextMenu at={at} onClose={onClose} label={phrase('time ruler')} testId="film-ruler-menu">
      {found ? (
        <>
          <MenuItem label={phrase('Edit Marker…')} uiId="control:timeline.markerMenu.edit" testId="film-ruler-menu-edit-marker" onSelect={() => run('markers.edit', { marker: found.id })} />
          <MenuItem
            label={phrase('Clear Selected Marker')}
            uiId="control:timeline.markerMenu.clear"
            testId="film-ruler-menu-clear-marker"
            onSelect={() => {
              onClose()
              // Clear Selected Marker clears the marker at the playhead: the playhead goes to this one first (no edit).
              void invoke('playhead.set', { time: Math.round(found.start * film.ticksPerSecond) }).then(() => invoke('markers.clearCurrent', {}))
            }}
          />
          <MenuSeparator />
        </>
      ) : null}
      <MenuItem label={phrase('Mark In')} uiId="control:timeline.rulerMenu.markIn" testId="film-ruler-menu-mark-in" onSelect={() => run('markers.markIn', { time })} />
      <MenuItem label={phrase('Mark Out')} uiId="control:timeline.rulerMenu.markOut" testId="film-ruler-menu-mark-out" onSelect={() => run('markers.markOut', { time })} />
      <MenuSeparator />
      <MenuItem label={phrase('Clear In and Out')} disabled={film.in == null && film.out == null} uiId="control:timeline.rulerMenu.clearInOut" testId="film-ruler-menu-clear-in-out" onSelect={() => run('markers.clearInOut', {})} />
      <MenuSeparator />
      <MenuItem label={phrase('Add Marker')} uiId="control:timeline.rulerMenu.addMarker" testId="film-ruler-menu-add-marker" onSelect={() => run('markers.add', { time })} />
    </ContextMenu>
  )
}

/**
 * The menu of empty track space (upstream's gap menu, and Premiere's): Paste at the time
 * right-clicked (the playhead goes there, as Paste reads it), Close Gap when the click is in a gap
 * before a clip (`sequence.closeGap` on this track: Premiere's Ripple Delete of a gap), select this
 * track's clips from here on (the Track Select Forward tool's click with Shift), and Add Track next
 * to this one. Each edit is one engine command, one undo step.
 */
export function LaneMenu({ at, track, seconds, film, invoke, onClose, phrase, t }: { at: ContextMenuPoint; track: number; seconds: number; film: FilmInfo; invoke: Invoke; onClose: () => void; phrase: Phrases; t: (key: string, values?: Record<string, string | number>) => string }) {
  const found = film.tracks.find((each) => each.id === track)
  if (!found) return null
  const state = laneMenuState(found, seconds, film.frame)
  const time = rulerTicks(seconds, film.fps, film.ticksPerSecond)
  const label = `${found.kind === 'video' ? 'V' : 'A'}${film.tracks.filter((each) => each.kind === found.kind).indexOf(found) + 1}`
  const run = (id: string, params: Record<string, unknown>) => {
    onClose()
    void invoke(id, params)
  }
  return (
    <ContextMenu at={at} onClose={onClose} label={phrase('tracks')} testId="film-lane-menu">
      <CommandItem
        command="edit.paste"
        label={phrase('Paste')}
        shortcut={null}
        onRun={() => {
          onClose()
          void invoke('playhead.set', { time }).then(() => invoke('edit.paste', {}))
        }}
      />
      <MenuSeparator />
      <MenuItem label={phrase('Close Gap')} disabled={!state.gap || found.locked} uiId="control:timeline.gapMenu.closeGap" testId="film-lane-menu-close-gap" onSelect={() => run('sequence.closeGap', { track, time })} />
      <MenuItem label={t('timeline.selectForward')} disabled={!state.forward.length} uiId="control:timeline.gapMenu.selectForward" testId="film-lane-menu-select-forward" onSelect={() => run('timeline.select', { clips: state.forward })} />
      <MenuSeparator />
      <MenuItem label={phrase('Add Track')} uiId="control:timeline.gapMenu.addTrack" testId="film-lane-menu-add-track" onSelect={() => run('sequence.addTracks', found.kind === 'video' ? { video: 1, audio: 0, videoAfter: label } : { video: 0, audio: 1, audioAfter: label })} />
    </ContextMenu>
  )
}
