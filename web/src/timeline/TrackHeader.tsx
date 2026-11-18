import { memo, useRef, type CSSProperties, type ReactNode, type PointerEvent as ReactPointerEvent } from 'react'
import { TesseraIcons } from '@kition/kit-editor'
import { useUi, type Phrases } from '@kition/kit-editor'
import type { FilmTrack } from '../film'

const Eye = TesseraIcons.EyeIcon
const EyeOff = TesseraIcons.EyeOffIcon
const Lock = TesseraIcons.LockIcon
const LockKeyhole = TesseraIcons.LockKeyholeIcon
const LockOpen = TesseraIcons.LockOpenIcon

export type TrackHeaderProps = {
  track: FilmTrack
  /** V1 and A1 are 0. */
  index: number
  top: number
  height: number
  width: number
  /** Source patching and targeting, as the engine keeps them. */
  patched: boolean
  targeted: boolean
  run: (command: string, params: Record<string, unknown>) => void
  /** A drag of the header's bottom edge: points the track grows by. */
  onResize: (kind: FilmTrack['kind'], delta: number) => void
  /** A double-click toggles the half's track height (upstream: under 50 grows to 64, else 30). */
  onToggleHeight: (kind: FilmTrack['kind']) => void
  phrase: Phrases
  /** A dialog's preview is open: the header's toggles are edits, so they take no press (its edge still resizes the view). */
  previewing?: boolean
}

/** A header control the host may hide or disable by its Kit UI id. */
function Control({ id, className, label, track, pressed, style, onPress, children, testId, off }: { id: string; className: string; label: string; track?: string; pressed?: boolean; style: CSSProperties; onPress: () => void; children: ReactNode; testId: string; off?: boolean }) {
  const state = useUi().state(id)
  if (state.hidden) return null
  return (
    <button
      type="button"
      className={className}
      style={style}
      title={label}
      aria-label={track ? `${label}, ${track}` : label}
      aria-pressed={pressed}
      disabled={state.disabled || off}
      tabIndex={0}
      onClick={(event) => {
        event.stopPropagation()
        onPress()
      }}
      onDoubleClick={(event) => event.stopPropagation()}
      data-kit-ui-id={id}
      data-testid={testId}
    >
      {children}
    </button>
  )
}

/**
 * One track header (upstream `draw_headers`): the source patch (drawn only while patched) and the
 * lock at the left, the target with the track's label, then on the upper line sync lock and, for
 * video, toggle output, for audio, mute and solo; the name on the lower line when the track is tall
 * enough. Its bottom edge resizes the track, and a double-click toggles its height.
 */
export const TrackHeader = memo(function TrackHeader({ track, index, top, height, width, patched, targeted, run, onResize, onToggleHeight, phrase, previewing }: TrackHeaderProps) {
  const label = `${track.kind === 'video' ? 'V' : 'A'}${index + 1}`
  const upper = Math.min(16, height / 2)
  const middle = height / 2
  const square = (x: number, y: number, size = 18) => ({ left: x - size / 2, top: y - size / 2, width: size, height: size })
  const patch = { left: 13, top: 1, width: 24, height: Math.max(0, height - 3) }
  const target = { left: 61, top: 1, width: 24, height: Math.max(0, height - 3) }
  const set = (params: Record<string, unknown>) => run('timeline.setTrack', { track: track.id, ...params })
  const resize = useRef<number | null>(null)
  const testId = `film-track-${label}`
  return (
    <div
      className="film-tl-header"
      data-kind={track.kind}
      data-locked={track.locked || undefined}
      data-previewing={previewing || undefined}
      style={{ top, height, width }}
      onDoubleClick={(event) => {
        // Upstream's double-click area: right of the target, below the upper line.
        const box = event.currentTarget.getBoundingClientRect()
        if (event.clientX - box.left >= 90 && event.clientY - box.top >= 26) onToggleHeight(track.kind)
      }}
      data-testid={`${testId}-header`}
    >
      <Control off={previewing} id="control:track.sourcePatch" track={label} className="film-tl-patch" label={phrase('Source patch')} pressed={patched} style={patch} onPress={() => run('timeline.setTargeting', { track: track.id, sourcePatch: !patched })} testId={`${testId}-patch`}>
        {patched ? label : null}
      </Control>
      <Control off={previewing} id="control:track.lock" track={label} className="film-tl-icon" label={phrase('Toggle Track Lock')} pressed={track.locked} style={square(49, middle)} onPress={() => set({ locked: !track.locked })} testId={`${testId}-lock`}>
        {track.locked ? <Lock size={13} aria-hidden="true" /> : <LockOpen size={13} aria-hidden="true" />}
      </Control>
      <Control off={previewing} id="control:track.target" track={label} className="film-tl-patch" label={phrase('Toggle track targeting')} pressed={targeted} style={target} onPress={() => run('timeline.setTargeting', { track: track.id, targeted: !targeted })} testId={`${testId}-target`}>
        {label}
      </Control>
      <Control off={previewing} id="control:track.syncLock" track={label} className="film-tl-icon" label={phrase('Toggle Sync Lock')} pressed={track.syncLock} style={square(102, upper)} onPress={() => set({ syncLock: !track.syncLock })} testId={`${testId}-sync`}>
        <LockKeyhole size={12} aria-hidden="true" />
      </Control>
      {track.kind === 'video' ? (
        <Control off={previewing} id="control:track.output" track={label} className="film-tl-icon" label={phrase('Toggle Track Output')} pressed={track.enabled} style={square(126, upper)} onPress={() => set({ enabled: !track.enabled })} testId={`${testId}-output`}>
          {track.enabled ? <Eye size={13} aria-hidden="true" /> : <EyeOff size={13} aria-hidden="true" />}
        </Control>
      ) : (
        <>
          <Control off={previewing} id="control:track.mute" track={label} className="film-tl-letter" label={phrase('Mute Track')} pressed={track.muted} style={square(126, upper, 14)} onPress={() => set({ muted: !track.muted })} testId={`${testId}-mute`}>
            M
          </Control>
          <Control off={previewing} id="control:track.solo" track={label} className="film-tl-letter" label={phrase('Solo Track')} pressed={track.solo} style={square(146, upper, 14)} onPress={() => set({ solo: !track.solo })} testId={`${testId}-solo`}>
            S
          </Control>
        </>
      )}
      {height >= 40 ? (
        <span className="film-tl-track-name" style={{ left: 94, top: 34 }}>
          {track.name}
        </span>
      ) : null}
      <div
        className="film-tl-header-edge"
        onPointerDown={(event: ReactPointerEvent<HTMLDivElement>) => {
          event.stopPropagation()
          event.currentTarget.setPointerCapture(event.pointerId)
          resize.current = event.clientY
        }}
        onPointerMove={(event) => {
          if (resize.current == null) return
          const delta = event.clientY - resize.current
          resize.current = event.clientY
          // Video tracks grow upward: dragging the edge down shrinks them, as upstream.
          if (delta) onResize(track.kind, track.kind === 'video' ? -delta : delta)
        }}
        onPointerUp={() => {
          resize.current = null
        }}
      />
    </div>
  )
})
