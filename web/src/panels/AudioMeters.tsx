import { memo, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { LevelMeter, meterLayout, useKitEditor, type LevelMeterHandle, type MeterBox } from '@kition/kit-editor'
import { dbToLinear, metersAtRest, silentMeters, stepMeters, type MeterFeed, type MeterLevels } from './meters'

/** Upstream's stereo Mix: one bar per channel, named as the channel layout names them, captioned "S" under each. */
const CHANNELS = ['L', 'R'] as const
const CAPTIONS = ['S', 'S']

export type AudioMetersProps = {
  /** The sound as it is scheduled, per window on the audio clock (`meters.ts`). */
  feed: MeterFeed
  /** Whether the program clock plays: upstream meters the Mix only while it does. */
  playing: boolean
}

/** A channel's automation label, as upstream registers it (`"L -12.3 dB"`). */
const channelLabel = (name: string, db: number) => `${name} ${db.toFixed(1)} dB`

/**
 * Audio Meters (upstream `panels/meters.rs`): stereo peak meters of the Mix on a 0 to −60 dB
 * scale, fed by the chunks the sound output schedules, taken as the audio clock reaches them, and
 * moved by upstream's ballistics (`stepMeters`). It draws once per animation frame while the
 * program plays, and after a stop only until the levels have fallen below the scale; a hidden
 * meter (another tab, or a closed frame) is unmounted and does nothing. The bars carry upstream's
 * `audioMeters.channel.*` ids and their level in dB, and the meter area `audioMeters`.
 */
export const AudioMeters = memo(function AudioMeters({ feed, playing }: AudioMetersProps) {
  const { phrase } = useKitEditor()
  const meter = useRef<LevelMeterHandle>(null)
  const box = useRef<HTMLDivElement>(null)
  const channels = useRef<Array<HTMLDivElement | null>>([])
  const levels = useRef<MeterLevels>(silentMeters(CHANNELS.length))
  const [size, setSize] = useState<{ width: number; height: number } | null>(null)

  // Only a shown meter listens: the feed keeps nothing for a hidden one.
  useEffect(() => feed.listen(), [feed])

  // The bars' boxes for the channels' ids, read again only when the meter's size changes.
  useLayoutEffect(() => {
    const element = box.current
    if (!element) return
    setSize({ width: element.clientWidth, height: element.clientHeight })
    if (typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(() => setSize({ width: element.clientWidth, height: element.clientHeight }))
    observer.observe(element)
    return () => observer.disconnect()
  }, [])

  useEffect(() => {
    if (!playing) feed.clear()
    if (!playing && metersAtRest(levels.current)) return
    let last: number | null = null
    let frame = 0
    const show = (next: MeterLevels) => {
      meter.current?.draw(next.level.map(dbToLinear), next.hold.map(dbToLinear))
      next.level.forEach((db, index) => {
        const element = channels.current[index]
        const text = db.toFixed(1)
        // Only a change the readout shows touches the DOM.
        if (!element || element.dataset.db === text) return
        element.dataset.db = text
        element.setAttribute('aria-label', channelLabel(CHANNELS[index], db))
      })
    }
    const tick = (time: number) => {
      const seconds = last == null ? 0 : (time - last) / 1000
      last = time
      const now = feed.now()
      const fresh = playing && now != null ? feed.take(now) : null
      levels.current = stepMeters(levels.current, seconds, fresh)
      show(levels.current)
      if (playing || !metersAtRest(levels.current)) frame = requestAnimationFrame(tick)
    }
    frame = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(frame)
  }, [feed, playing])

  const bars: MeterBox[] = size ? meterLayout(size.width, size.height, CHANNELS.length, 'vertical', true).bars : []
  return (
    <div className="film-meters" data-testid="film-audio-meters">
      <div ref={box} className="film-meters-area" data-kit-ui-id="control:audioMeters" aria-label={phrase('Audio Meters')}>
        <LevelMeter ref={meter} peaks={[0, 0]} holds={[0, 0]} labels={CAPTIONS} testId="film-meters-canvas" />
        {CHANNELS.map((name, index) => {
          const bar = bars[index]
          return (
            <div
              key={name}
              ref={(element) => {
                channels.current[index] = element
              }}
              className="film-meters-channel"
              data-kit-ui-id="control:audioMeters.channel"
              data-testid={`film-meters-channel-${name}`}
              data-db={levels.current.level[index].toFixed(1)}
              aria-label={channelLabel(name, levels.current.level[index])}
              style={bar ? { left: bar.x, top: bar.y, width: bar.w, height: bar.h } : { display: 'none' }}
            />
          )
        })}
      </div>
    </div>
  )
})
