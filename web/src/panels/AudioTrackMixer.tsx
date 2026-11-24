import { memo, useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react'
import type { Phrases } from '@kition/sdk/editor'
import { faderDb, faderY, levelText, panText, stripsOf, type MixerStrip } from './mixerModel'
import { dbToLinear, metersAtRest, silentMeters, stepMeters, type MeterFeed, type MeterLevels } from './meters'
import { FADER_MIN_DB } from '../timeline/volumeBand'

type Invoke = (id: string, params?: Record<string, unknown>) => Promise<unknown>

export type AudioTrackMixerProps = {
  /** The engine's revision: the strips are read again after every change. */
  revision: number | null
  /** The active sequence (none: nothing to mix). */
  sequence: number | null
  query: (id: string, params?: Record<string, unknown>) => Promise<unknown>
  invoke: Invoke
  /** The sound as it is scheduled (the Mix only), for the Mix strip's meter. */
  feed: MeterFeed
  playing: boolean
  phrase: Phrases
}

/** The fader's track, in points. */
const FADER_HEIGHT = 160

/**
 * The Mix strip's stereo meter, fed as the Audio Meters are (`meters.ts`): it moves while the
 * program plays and falls back after a stop. The tracks have no meter: the engine mixes the
 * sequence in one pass and reports no level per track.
 */
const MixMeter = memo(function MixMeter({ feed, playing }: { feed: MeterFeed; playing: boolean }) {
  const bars = useRef<Array<HTMLDivElement | null>>([])
  const levels = useRef<MeterLevels>(silentMeters(2))
  useEffect(() => feed.listen(), [feed])
  useEffect(() => {
    if (!playing) feed.clear()
    if (!playing && metersAtRest(levels.current)) return
    let last: number | null = null
    let frame = 0
    const tick = (time: number) => {
      const seconds = last == null ? 0 : (time - last) / 1000
      last = time
      const now = feed.now()
      levels.current = stepMeters(levels.current, seconds, playing && now != null ? feed.take(now) : null)
      levels.current.level.forEach((db, index) => {
        const bar = bars.current[index]
        if (!bar) return
        // 0 dB at the top, −60 dB at the foot, as the Audio Meters draw.
        const fill = Math.min(1, Math.max(0, (db + 60) / 60))
        bar.style.setProperty('--film-mixer-level', String(fill))
        bar.dataset.db = db.toFixed(1)
      })
      if (playing || !metersAtRest(levels.current)) frame = requestAnimationFrame(tick)
    }
    frame = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(frame)
  }, [feed, playing])
  return (
    <div className="film-mixer-meter" data-kit-ui-id="control:mixer.meter" data-testid="film-mixer-meter-Mix">
      {[0, 1].map((channel) => (
        <div
          key={channel}
          ref={(element) => {
            bars.current[channel] = element
          }}
          className="film-mixer-meter-bar"
          data-db={levels.current.level[channel].toFixed(1)}
          data-testid={`film-mixer-meter-Mix-${channel === 0 ? 'L' : 'R'}`}
        />
      ))}
    </div>
  )
})

/**
 * One strip (upstream `mixer.rs` `strip`): the track's name, its pan, Mute and Solo (not on the
 * Mix), the fader with its level, and on the Mix the meter. A fader or pan drag is heard as it
 * moves (`mixer.touch`, the engine's live mix) and becomes one undo step on release
 * (`mixer.release`); a double-click puts the fader at 0 dB and the pan in the middle.
 */
function Strip({ strip, invoke, feed, playing, phrase }: { strip: MixerStrip; invoke: Invoke; feed: MeterFeed; playing: boolean; phrase: Phrases }) {
  const [dragDb, setDragDb] = useState<number | null>(null)
  const [dragPan, setDragPan] = useState<number | null>(null)
  // A drag's latest value waits while one is on its way; the release goes after the last.
  const sending = useRef<{ busy: boolean; next: { lane: string; value: number } | null; done: Promise<unknown> }>({ busy: false, next: null, done: Promise.resolve() })
  const touch = (lane: string, value: number) => {
    const state = sending.current
    if (state.busy) {
      state.next = { lane, value }
      return
    }
    state.busy = true
    const send = async (first: { lane: string; value: number }) => {
      let next: { lane: string; value: number } | null = first
      while (next) {
        const now: { lane: string; value: number } = next
        state.next = null
        await invoke('mixer.touch', { strip: strip.ref, lane: now.lane, value: now.value }).catch(() => undefined)
        next = state.next
      }
      state.busy = false
    }
    state.done = send({ lane, value })
  }
  // Releases and one-step changes go out in order, after the drag's last touch.
  const after = useRef<Promise<unknown>>(Promise.resolve())
  const later = (send: () => Promise<unknown>) => {
    const state = sending.current
    after.current = Promise.all([state.done, after.current]).then(send).catch(() => undefined)
  }
  const release = (lane: string) => later(() => invoke('mixer.release', { strip: strip.ref, lane }))
  const track = useRef<HTMLDivElement>(null)
  const dbAt = (event: { clientY: number }) => {
    const box = track.current?.getBoundingClientRect()
    return box ? faderDb(box.height, event.clientY - box.top) : 0
  }
  const shownDb = dragDb ?? strip.volumeDb
  const shownPan = dragPan ?? strip.pan
  const id = strip.ref
  const label = strip.kind === 'mix' ? phrase('Mix') : `${strip.ref} ${strip.name}`
  // A fader drag in progress (a ref: a quick click's release comes before React draws its press).
  const dragging = useRef(false)
  const faderDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return
    event.preventDefault()
    event.currentTarget.setPointerCapture(event.pointerId)
    dragging.current = true
    const db = dbAt(event)
    setDragDb(db)
    touch('volume', db)
  }
  const faderMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!dragging.current) return
    const db = dbAt(event)
    setDragDb(db)
    touch('volume', db)
  }
  const faderUp = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!dragging.current) return
    dragging.current = false
    event.currentTarget.releasePointerCapture?.(event.pointerId)
    release('volume')
    // The level shown stays the dragged one until the engine's next read has it.
    window.setTimeout(() => setDragDb(null), 400)
  }
  // Whether the pan moved since its last release (a key that moved nothing releases nothing).
  const panMoved = useRef(false)
  const panTo = (value: number, final: boolean) => {
    if (!final || value !== Math.round(dragPan ?? strip.pan)) {
      setDragPan(value)
      touch('pan', value)
      panMoved.current = true
    }
    if (final && panMoved.current) {
      panMoved.current = false
      release('pan')
      window.setTimeout(() => setDragPan(null), 400)
    }
  }
  return (
    <div className="film-mixer-strip" data-kind={strip.kind} data-testid={`film-mixer-strip-${id}`}>
      <div className="film-mixer-pan">
        <input
          type="range"
          min={-100}
          max={100}
          step={1}
          value={Math.round(shownPan)}
          aria-label={`${phrase('Pan')} ${label}`}
          title={phrase('Pan')}
          data-kit-ui-id="control:mixer.pan"
          data-testid={`film-mixer-pan-${id}`}
          onChange={(event) => panTo(Number(event.target.value), false)}
          onPointerUp={(event) => panTo(Number(event.currentTarget.value), true)}
          onKeyUp={(event) => panTo(Number(event.currentTarget.value), true)}
          onDoubleClick={() => panTo(0, true)}
        />
        <span className="film-mixer-value" data-testid={`film-mixer-pan-value-${id}`}>
          {panText(shownPan)}
        </span>
      </div>
      {strip.kind === 'audio' ? (
        <div className="film-mixer-buttons">
          <button type="button" className="film-mixer-toggle" aria-pressed={strip.muted} title={phrase('Mute Track')} aria-label={`${phrase('Mute Track')} ${label}`} data-kit-ui-id="control:mixer.mute" data-testid={`film-mixer-mute-${id}`} onClick={() => void invoke('mixer.setStrip', { strip: strip.ref, muted: !strip.muted })}>
            M
          </button>
          <button type="button" className="film-mixer-toggle" data-solo aria-pressed={strip.solo} title={phrase('Solo Track')} aria-label={`${phrase('Solo Track')} ${label}`} data-kit-ui-id="control:mixer.solo" data-testid={`film-mixer-solo-${id}`} onClick={() => void invoke('mixer.setStrip', { strip: strip.ref, solo: !strip.solo })}>
            S
          </button>
        </div>
      ) : (
        <div className="film-mixer-buttons" />
      )}
      <div className="film-mixer-body">
        <div
          ref={track}
          className="film-mixer-fader"
          style={{ height: FADER_HEIGHT }}
          role="slider"
          tabIndex={0}
          aria-orientation="vertical"
          aria-valuemin={FADER_MIN_DB}
          aria-valuemax={15}
          aria-valuenow={Number(shownDb.toFixed(1))}
          aria-valuetext={`${levelText(shownDb)} dB`}
          aria-label={`${phrase('Volume')} ${label}`}
          data-kit-ui-id="control:mixer.fader"
          data-testid={`film-mixer-fader-${id}`}
          data-dragging={dragDb != null || undefined}
          onPointerDown={faderDown}
          onPointerMove={faderMove}
          onPointerUp={faderUp}
          onPointerCancel={faderUp}
          onDoubleClick={() => later(() => invoke('mixer.setValue', { strip: strip.ref, lane: 'volume', value: 0 }))}
          onKeyDown={(event) => {
            const step = event.key === 'ArrowUp' ? 1 : event.key === 'ArrowDown' ? -1 : 0
            if (!step) return
            event.preventDefault()
            event.stopPropagation()
            void invoke('mixer.setValue', { strip: strip.ref, lane: 'volume', value: Math.max(FADER_MIN_DB, Math.round(strip.volumeDb + step)) })
          }}
        >
          <span className="film-mixer-zero" style={{ top: faderY(FADER_HEIGHT, 0) }} />
          <span className="film-mixer-knob" style={{ top: faderY(FADER_HEIGHT, shownDb) }} data-testid={`film-mixer-knob-${id}`} />
        </div>
        {strip.kind === 'mix' ? <MixMeter feed={feed} playing={playing} /> : null}
      </div>
      <span className="film-mixer-value" data-kit-ui-id="control:mixer.value" data-testid={`film-mixer-level-${id}`}>
        {levelText(shownDb)}
      </span>
      <span className="film-mixer-name" title={label} data-kit-ui-id="control:mixer.name" data-testid={`film-mixer-name-${id}`}>
        {strip.kind === 'mix' ? phrase('Mix') : `${strip.ref}  ${strip.name}`}
      </span>
    </div>
  )
}

/**
 * Audio Track Mixer (upstream `panels/mixer.rs`), the minimum: one strip per audio track and the
 * Mix, each with its fader (upstream's taper), pan, Mute and Solo, its name, and on the Mix a meter
 * that moves while the program plays. Its Mute and Solo are the tracks' own, the ones the Timeline's
 * track headers show. Automation modes, effects and sends, submixes and per-track meters are not
 * drawn.
 */
export const AudioTrackMixer = memo(function AudioTrackMixer({ revision, sequence, query, invoke, feed, playing, phrase }: AudioTrackMixerProps) {
  const [strips, setStrips] = useState<MixerStrip[] | null>(null)
  useEffect(() => {
    if (sequence == null) {
      setStrips(null)
      return
    }
    let open = true
    void query('mixer.inspect')
      .catch(() => null)
      .then((answer) => {
        if (open) setStrips(answer ? stripsOf(answer) : null)
      })
    return () => {
      open = false
    }
  }, [query, revision, sequence])
  if (sequence == null || !strips)
    return (
      <div className="film-mixer film-mixer-empty" data-testid="film-mixer">
        {phrase('(no sequences)')}
      </div>
    )
  return (
    <div className="film-mixer" data-testid="film-mixer">
      {strips.map((strip) => (
        <Strip key={strip.ref} strip={strip} invoke={invoke} feed={feed} playing={playing} phrase={phrase} />
      ))}
    </div>
  )
})
