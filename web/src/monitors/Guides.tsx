import { useCallback, useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore, type MutableRefObject, type PointerEvent as ReactPointerEvent, type RefObject } from 'react'
import { useUi } from '@kition/sdk/editor'
import { GUIDE_GRAB, dragGuides, endGuideDrag, guideAt, shownGuides, type Guide, type GuideDrag, type GuideGeometry, type GuidePreview, type Point, type SnapLine, type ValueStore } from './guideModel'
import type { MonitorId, MonitorView } from './monitorView'
import { Rulers } from './Rulers'

type Props = {
  monitor: MonitorId
  view: MonitorView
  /** Where the monitor draws its picture (`GuideGeometry`), set as it lays out; never per playback frame. */
  geometry: ValueStore<GuideGeometry>
  /** An open guide dialog's preview (Add Guide's guide, Manage ▸ Apply's template). */
  preview: ValueStore<GuidePreview>
  /** The picture element the geometry is measured in. */
  root: RefObject<HTMLElement | null>
  /** A drag released: the monitor's guides (`show`: a guide dragged out of a ruler shows the guides, as upstream). */
  onGuides: (guides: readonly Guide[], show: boolean) => void
  /** Set while a press on a ruler or a guide is held (the Source picture's own drag waits). */
  busy?: MutableRefObject<boolean>
}

/** What a drag shows: the guides as they would be, whether the pointer is outside the picture area, and a new guide's line. */
type Shown = { kind: GuideDrag['kind']; index: number | null; guides: readonly Guide[]; outside: boolean; line: SnapLine | null }

/** One press on a ruler or a guide, to its release, Escape, or a lost capture. */
type Press = { drag: GuideDrag; base: readonly Guide[]; origin: { left: number; top: number }; pointer: number; element: HTMLElement; last: Point; done: boolean; frame: number; stop: () => void }

/**
 * A monitor's guides and rulers (upstream `guides` and `rulers`): the guides over the picture
 * area, each dragged to move it (unless guides are locked) and dropped outside the area to remove
 * it; a ruler dragged into the area makes a new guide. One press tracker per drag: the drag shows
 * at most once per animation frame and changes nothing until it is released; Escape, a lost
 * capture, or a lost window focus drops it, so the guides stay exactly as they were. An open
 * dialog's preview guides draw over them, marked.
 */
export function GuideLayer({ monitor, view, geometry, preview, root, onGuides, busy }: Props) {
  const geo = useSyncExternalStore(geometry.subscribe, geometry.get)
  const previewing = useSyncExternalStore(preview.subscribe, preview.get)
  const ui = useUi()
  const grab = ui.state('control:monitor.guide')
  const [shown, setShown] = useState<Shown | null>(null)
  const latest = useRef({ view, geo, onGuides })
  latest.current = { view, geo, onGuides }
  const press = useRef<Press | null>(null)

  const finish = useCallback(
    (commit: boolean) => {
      const current = press.current
      if (!current || current.done) return
      current.done = true
      press.current = null
      current.stop()
      if (busy) busy.current = false
      setShown(null)
      const { view: now, geo: at, onGuides: commitGuides } = latest.current
      // The guides changed under the drag (a menu row, a dialog's OK): the drag is dropped.
      if (!commit || !at || now.guides !== current.base) return
      const next = endGuideDrag(current.base, current.drag, current.last, at.area, at.pic, at.frame)
      if (next !== current.base) commitGuides(next, current.drag.kind === 'new')
    },
    [busy],
  )
  useEffect(() => () => finish(false), [finish])
  // A held press belongs to the configuration that accepted it. Cancel synchronously:
  // a disable/enable pair can arrive before React renders either configuration.
  useLayoutEffect(() => ui.store.subscribe(() => finish(false)), [ui.store, finish])

  const start = useCallback(
    (drag: GuideDrag, event: ReactPointerEvent<HTMLElement>) => {
      const element = root.current
      if (event.button !== 0 || !element || press.current || !latest.current.geo) return
      event.preventDefault()
      event.stopPropagation()
      const target = event.currentTarget
      target.setPointerCapture?.(event.pointerId)
      const box = element.getBoundingClientRect()
      const origin = { left: box.left, top: box.top }
      const at = (clientX: number, clientY: number): Point => ({ x: clientX - origin.left, y: clientY - origin.top })
      const show = () => {
        const current = press.current
        const now = latest.current.geo
        if (!current || !now) return
        current.frame = 0
        const next = dragGuides(current.base, current.drag, current.last, now.area, now.pic, now.frame)
        setShown({ kind: current.drag.kind, index: current.drag.kind === 'move' ? current.drag.index : null, ...next })
      }
      const move = (moved: PointerEvent) => {
        const current = press.current
        if (!current || moved.pointerId !== current.pointer) return
        current.last = at(moved.clientX, moved.clientY)
        if (!current.frame) current.frame = requestAnimationFrame(show)
      }
      const up = (released: PointerEvent) => {
        const current = press.current
        if (!current || released.pointerId !== current.pointer) return
        current.last = at(released.clientX, released.clientY)
        finish(true)
      }
      const key = (pressed: KeyboardEvent) => {
        if (pressed.key !== 'Escape') return
        // Escape is the drag's alone: the guides stay as they were, and nothing else hears it.
        pressed.preventDefault()
        pressed.stopPropagation()
        finish(false)
      }
      const lost = () => finish(false)
      target.addEventListener('pointermove', move)
      target.addEventListener('pointerup', up)
      target.addEventListener('pointercancel', lost)
      target.addEventListener('lostpointercapture', lost)
      window.addEventListener('keydown', key, true)
      window.addEventListener('blur', lost)
      const record: Press = {
        drag,
        base: latest.current.view.guides,
        origin,
        pointer: event.pointerId,
        element: target,
        last: at(event.clientX, event.clientY),
        done: false,
        frame: 0,
        stop: () => {
          if (record.frame) cancelAnimationFrame(record.frame)
          target.removeEventListener('pointermove', move)
          target.removeEventListener('pointerup', up)
          target.removeEventListener('pointercancel', lost)
          target.removeEventListener('lostpointercapture', lost)
          window.removeEventListener('keydown', key, true)
          window.removeEventListener('blur', lost)
          if (target.hasPointerCapture?.(event.pointerId)) target.releasePointerCapture(event.pointerId)
        },
      }
      press.current = record
      if (busy) busy.current = true
      // A new guide shows at once where the press is (upstream draws it while the drag lasts).
      show()
    },
    [root, finish, busy],
  )
  const onRuler = useCallback((vertical: boolean, event: ReactPointerEvent<HTMLElement>) => start({ kind: 'new', vertical }, event), [start])

  if (!geo) return null
  const { area, pic, frame } = geo
  const kx = pic.width / Math.max(1, frame.width)
  const ky = pic.height / Math.max(1, frame.height)
  const guides = shownGuides({ showGuides: view.showGuides, guides: shown ? shown.guides : view.guides }, previewing, monitor)
  const movable = !view.lockGuides && !grab.disabled && !grab.denied && !grab.hidden
  const own = guides.filter((each) => !each.preview).length
  return (
    <>
      {view.showRulers ? <Rulers monitor={monitor} area={area} pic={pic} kx={kx} ky={ky} onPress={onRuler} /> : null}
      <div
        className="film-guides"
        style={{ left: area.x, top: area.y, width: area.width, height: area.height }}
        data-testid={`film-${monitor}-guides`}
        data-count={own}
        data-previewing={guides.length - own}
        data-locked={view.lockGuides || undefined}
        data-dragging={shown ? shown.kind : undefined}
        aria-hidden="true"
      >
        {guides.map(({ guide, preview: marked, index }) => {
          const at = guideAt(guide, pic, frame) - (guide.vertical ? area.x : area.y)
          const removing = shown?.kind === 'move' && shown.index === index && shown.outside && !marked
          const place = guide.vertical ? { left: at - GUIDE_GRAB, width: GUIDE_GRAB * 2 + 1 } : { top: at - GUIDE_GRAB, height: GUIDE_GRAB * 2 + 1 }
          if (marked)
            return <span key={`preview${index}`} className="film-guide" style={place} data-vertical={guide.vertical} data-position={guide.position} data-preview="true" data-testid={`film-${monitor}-guide-preview-${index}`} />
          return (
            <span
              key={`guide${index}`}
              className="film-guide"
              style={place}
              data-vertical={guide.vertical}
              data-position={guide.position}
              data-removing={removing || undefined}
              data-movable={movable || undefined}
              data-kit-ui-id={grab.hidden ? undefined : 'control:monitor.guide'}
              data-testid={`film-${monitor}-guide-${index}`}
              onPointerDown={movable ? (event) => start({ kind: 'move', index }, event) : undefined}
              onMouseDown={movable ? (event) => event.preventDefault() : undefined}
            />
          )
        })}
        {shown?.line ? <span className="film-guide film-guide-new" style={shown.line.vertical ? { left: shown.line.at - area.x - GUIDE_GRAB, width: GUIDE_GRAB * 2 + 1 } : { top: shown.line.at - area.y - GUIDE_GRAB, height: GUIDE_GRAB * 2 + 1 }} data-vertical={shown.line.vertical} data-testid={`film-${monitor}-guide-new`} /> : null}
      </div>
    </>
  )
}
