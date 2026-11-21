import { memo, type PointerEvent as ReactPointerEvent } from 'react'
import { useUi } from '@kition/sdk/editor'
import { RULER, rulerTicks, type Rect } from './guideModel'
import type { MonitorId } from './monitorView'

/** Upstream's `RULER * 0.6` and `RULER * 0.25`: a major and a minor tick's length. */
const MAJOR = RULER * 0.6
const MINOR = RULER * 0.25

type Props = {
  monitor: MonitorId
  /** The picture area under the rulers and the picture in it, in the monitor's picture element's pixels. */
  area: Rect
  pic: Rect
  /** Points per frame pixel across and down. */
  kx: number
  ky: number
  /** A press on a ruler: the top ruler drags out a horizontal guide, the left one a vertical guide. */
  onPress: (vertical: boolean, event: ReactPointerEvent<HTMLDivElement>) => void
}

/**
 * One ruler (upstream `rulers`): ticks a fifth of `nice_step` apart in frame pixels, every fifth
 * one longer and labelled, drawn as SVG once per geometry (never per playback frame).
 */
function Ruler({ vertical, monitor, length, origin, k, onPress }: { vertical: boolean; monitor: MonitorId; length: number; origin: number; k: number; onPress: Props['onPress'] }) {
  const uiId = vertical ? 'control:monitor.ruler.left' : 'control:monitor.ruler.top'
  const state = useUi().state(uiId)
  if (state.hidden) return null
  const ticks = rulerTicks(0, length, origin, k)
  return (
    <div
      className={`film-ruler film-ruler-${vertical ? 'left' : 'top'}`}
      style={vertical ? { top: RULER, height: length } : { left: RULER, width: length }}
      data-kit-ui-id={uiId}
      data-testid={`film-${monitor}-ruler-${vertical ? 'left' : 'top'}`}
      data-step={ticks.length > 1 ? Math.abs(ticks[1].value - ticks[0].value) * 5 : undefined}
      aria-label={vertical ? 'left ruler' : 'top ruler'}
      onPointerDown={(event) => !state.disabled && !state.denied && onPress(vertical, event)}
      onMouseDown={(event) => event.preventDefault()}
    >
      <svg className="film-ruler-ticks" aria-hidden="true">
        {ticks.map((tick) =>
          vertical ? (
            <line key={tick.value} x1={RULER - (tick.major ? MAJOR : MINOR)} x2={RULER} y1={tick.at + 0.5} y2={tick.at + 0.5} />
          ) : (
            <line key={tick.value} x1={tick.at + 0.5} x2={tick.at + 0.5} y1={RULER - (tick.major ? MAJOR : MINOR)} y2={RULER} />
          ),
        )}
        {ticks
          .filter((tick) => tick.major)
          .map((tick) =>
            vertical ? (
              <text key={`label${tick.value}`} x={1} y={tick.at + 2} dominantBaseline="hanging">
                {tick.value}
              </text>
            ) : (
              <text key={`label${tick.value}`} x={tick.at + 2} y={1} dominantBaseline="hanging">
                {tick.value}
              </text>
            ),
          )}
      </svg>
    </div>
  )
}

/**
 * The rulers along the top and left of a monitor's picture area (upstream `rulers`), in frame
 * pixels from the picture's top left, with the corner between them. Pressing one and dragging
 * into the picture area drags out a guide.
 */
export const Rulers = memo(function Rulers({ monitor, area, pic, kx, ky, onPress }: Props) {
  // Each ruler's coordinates start where it does: the top one at the picture area's left, the left one at its top.
  const width = Math.max(0, area.x + area.width - RULER)
  const height = Math.max(0, area.y + area.height - RULER)
  return (
    <>
      <span className="film-ruler-corner" aria-hidden="true" />
      <Ruler vertical={false} monitor={monitor} length={width} origin={pic.x - RULER} k={kx} onPress={onPress} />
      <Ruler vertical monitor={monitor} length={height} origin={pic.y - RULER} k={ky} onPress={onPress} />
    </>
  )
})
