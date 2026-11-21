import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type DragEvent as ReactDragEvent, type MouseEvent as ReactMouseEvent, type PointerEvent as ReactPointerEvent } from 'react'
import { RenameField, type Phrases } from '@kition/sdk/editor'
import { endFilmDrag, startFilmDrag } from '../timeline/drop'
import { CardArt, OFFLINE, shortDuration, type ProjectThumbnails } from './projectCards'
import { LAYOUT_WIDTH, canvasExtent, cardAt, createCardDrag, createDragEvents, createLatestRead, draggedItem, drawOrder, layoutCards, layoutFor, layoutKey, movesWith, shareCards, stackSizes, type CardDrag, type FreeformCard, type FreeformOptions, type MoveParams } from './freeform'
import type { ProjectRow, ProjectUi, ProjectUiState } from './projectModel'
import type { RowMark } from './projectPreview'

type Query = (id: string, params?: Record<string, unknown>) => Promise<unknown>

/**
 * The bin's Freeform layout (`project.freeform.layout {bin, width}`), read once per document,
 * bin, revision, width, and options (which change with no revision), one read in flight; a late
 * answer for another key is dropped, and the cards of another document or bin are never returned
 * (lesson 6, `layoutFor`); unchanged cards keep their objects (lesson 5).
 * Off (another view shown, no width measured yet): nothing is read.
 */
export function useFreeformLayout(query: Query, { on, document, bin, revision, width, options }: { on: boolean; document: unknown; bin: number | null; revision: number | null; width: number; options: FreeformOptions | null }) {
  const [cards, setCards] = useState<{ key: string; cards: FreeformCard[] } | null>(null)
  const params = useRef({ bin, width })
  const reader = useMemo(
    () =>
      createLatestRead<{ key: string; cards: FreeformCard[] }>({
        read: async (key) => {
          const { bin: shown, width: wide } = params.current
          const cards = layoutCards(await query('project.freeform.layout', { ...(shown != null ? { bin: shown } : {}), width: wide }))
          return cards ? { key, cards } : null
        },
        apply: (_key, value) => setCards((shown) => ({ key: value.key, cards: shareCards(shown?.cards, value.cards) })),
      }),
    [query],
  )
  useEffect(() => () => reader.stop(), [reader])
  const key = on && width > 0 ? layoutKey({ document, bin, revision, width, options }) : null
  useEffect(() => {
    params.current = { bin, width: Math.round(width) }
    reader.want(key)
  }, [reader, key, bin, width])
  // Another document's or bin's cards never show (lesson 6).
  return on ? layoutFor(cards, key) : null
}

/** What a card draws of an open preview: its mark, whether the preview selects it, and where its picture comes from. */
export type FreeformPreview = { marks: ReadonlyMap<string, RowMark>; selection: ReadonlySet<number> | null; picture: (row: ProjectRow) => { thumbnails: ProjectThumbnails; stamp: string | null } }

/** What the cards do, the same object for the panel's life (the memoized cards do not draw again for it). */
export type FreeformActions = {
  clickItem: (event: ReactMouseEvent, item: number) => void
  openItem: (row: ProjectRow) => void
  renameText: (text: string) => void
  renameDone: (commit: boolean) => void
  /** A right-click on a card (upstream `card_menu`). */
  cardMenu: (event: ReactMouseEvent, row: ProjectRow, card: FreeformCard) => void
  /** A right-click on the empty canvas (upstream `canvas_menu`). */
  canvasMenu: (event: ReactMouseEvent) => void
  /** A click and a double-click on the empty canvas. */
  emptyClick: () => void
  emptyDoubleClick: () => void
  /** Release inside the panel: `project.freeform.move`, once. */
  move: (params: MoveParams) => void
}

export type FreeformViewProps = {
  /** The cards the search shows, where the engine (or an open preview) puts them. */
  cards: readonly FreeformCard[]
  rows: ReadonlyMap<number, ProjectRow>
  options: FreeformOptions
  font: number
  hoverScrub: boolean
  touchScrub: boolean
  selection: readonly number[]
  selected: ReadonlySet<number>
  state: ProjectUiState
  colors: (row: ProjectRow) => string
  revision: number | null
  preview: FreeformPreview
  ui: ProjectUi
  actions: FreeformActions
  phrase: Phrases
}

const NO_OFFSET = null

/**
 * The Freeform view (upstream `freeform_view`): clip cards on a canvas where
 * `project.freeform.layout` puts them, a grid when snapping, stacks drawn deepest first with a
 * "×N" badge on their first card, and each card's picture, In/Out bar, badges, name, and
 * duration (as Freeform View Options shows them). A press reaches the card drawn on top
 * (`cardAt`); a drag moves the card with the selection or its whole stack, and its release in
 * the panel runs `project.freeform.move` once; out of the panel the drag is the item's own, which
 * drops on the Timeline; Escape puts the cards back and sends nothing. The canvas grows to hold
 * the cards, and its width is what the engine lays the other cards out for.
 */
export function FreeformView({ cards, rows, options, font, hoverScrub, touchScrub, selection, selected, state, colors, revision, preview, ui, actions, phrase }: FreeformViewProps) {
  const scroller = useRef<HTMLDivElement>(null)
  const canvas = useRef<HTMLDivElement>(null)
  const ghost = useRef<HTMLDivElement>(null)
  const pressedWith = useRef<string | null>(null)
  const [room, setRoom] = useState({ width: 0, height: 0 })
  // The panel's width, which the engine lays the auto-placed cards out for (upstream `rect.width()`):
  // its whole width, so a scrollbar coming or going (cards laid out taller) does not lay them out again.
  useLayoutEffect(() => {
    const element = scroller.current
    if (!element) return undefined
    const measure = () => {
      const width = Math.round(element.offsetWidth)
      const height = Math.round(element.clientHeight)
      const inner = Math.round(element.clientWidth)
      setRoom((shown) => (shown.width === inner && shown.height === height ? shown : { width: inner, height }))
      if (width > 0 && ui.get().freeformWidth !== width) ui.set({ freeformWidth: width })
    }
    measure()
    if (typeof ResizeObserver === 'undefined') return undefined
    const observer = new ResizeObserver(measure)
    observer.observe(element)
    return () => observer.disconnect()
  }, [ui])
  // Hover Scrub turned off: no card's time stays behind for I and O.
  useEffect(() => {
    if (!hoverScrub) ui.hover.current = null
  }, [hoverScrub, ui])

  // What the handlers read when they act: the latest cards and selection.
  const now = useRef({ cards, selection, actions })
  now.current = { cards, selection, actions }
  // The cards a press reaches: not a preview's ghosts (added or removed), which are only shown.
  const hittable = useMemo(() => cards.filter((card) => !preview.marks.has(`i${card.item}`) || preview.marks.get(`i${card.item}`)?.mark === 'changed'), [cards, preview.marks])
  const hitNow = useRef(hittable)
  hitNow.current = hittable

  const [drag, setDrag] = useState<CardDrag | null>(null)
  const tracker = useMemo(
    () =>
      createCardDrag({
        cards: () => now.current.cards,
        selection: () => now.current.selection,
        width: () => ui.get().freeformWidth || LAYOUT_WIDTH,
        send: (params) => now.current.actions.move(params),
        onChange: setDrag,
      }),
    [ui],
  )
  // Where the pointer is while a card drags out of the view: upstream's drag ghost (the item's name) follows it there.
  const [outside, setOutside] = useState<{ x: number; y: number } | null>(null)
  const events = useMemo(
    () =>
      createDragEvents({
        tracker,
        // The canvas's place now, as it scrolls (its box moves with the scroll).
        toCanvas: (at) => {
          const rect = canvas.current?.getBoundingClientRect()
          return rect ? { x: at.x - rect.left, y: at.y - rect.top } : null
        },
        schedule: (task) => {
          const id = requestAnimationFrame(task)
          return () => cancelAnimationFrame(id)
        },
        endDrag: endFilmDrag,
        onFrame: (at) => {
          const rect = scroller.current?.getBoundingClientRect()
          const inside = rect != null && at.x >= rect.left && at.x <= rect.right && at.y >= rect.top && at.y <= rect.bottom
          setOutside((shown) => (inside ? null : shown && shown.x === at.x && shown.y === at.y ? shown : at))
        },
      }),
    [tracker],
  )
  // Every dragover in the editor moves the cards (the pointer may be over another panel); only the
  // view accepts the drop. A drop anywhere (after the view's own, or the Timeline's) and a pointer
  // move with no button down end what is left of a drag whose dragend never came (its card went).
  useEffect(() => {
    const over = (event: DragEvent) => void events.move({ x: event.clientX, y: event.clientY, screenX: event.screenX })
    const dropped = () => events.end()
    const pointer = (event: PointerEvent) => events.pointer(event.buttons, { isPrimary: event.isPrimary, pointerType: event.pointerType })
    document.addEventListener('dragover', over, true)
    document.addEventListener('drop', dropped)
    document.addEventListener('pointermove', pointer)
    return () => {
      document.removeEventListener('dragover', over, true)
      document.removeEventListener('drop', dropped)
      document.removeEventListener('pointermove', pointer)
      events.end()
    }
  }, [events])
  const moving = useMemo(() => (drag ? movesWith(cards, drag.item, selection) : null), [drag?.item, cards, selection])

  const local = (event: { clientX: number; clientY: number }) => {
    const rect = canvas.current?.getBoundingClientRect()
    return rect ? { x: event.clientX - rect.left, y: event.clientY - rect.top } : null
  }
  const cardUnder = (event: { clientX: number; clientY: number }) => {
    const at = local(event)
    return at ? cardAt(hitNow.current, at.x, at.y) : null
  }
  const handlers = {
    // The kind of pointer a drag is pressed with (its dragstart does not say).
    onPointerDown(event: ReactPointerEvent) {
      pressedWith.current = event.pointerType || null
    },
    onClick(event: ReactMouseEvent) {
      if (event.detail > 1) return
      const card = cardUnder(event)
      if (card) now.current.actions.clickItem(event, card.item)
      else now.current.actions.emptyClick()
    },
    onDoubleClick(event: ReactMouseEvent) {
      const card = cardUnder(event)
      const row = card ? rows.get(card.item) : null
      if (row) now.current.actions.openItem(row)
      else if (!card) now.current.actions.emptyDoubleClick()
    },
    onContextMenu(event: ReactMouseEvent) {
      event.preventDefault()
      const card = cardUnder(event)
      const row = card ? rows.get(card.item) : null
      if (card && row) now.current.actions.cardMenu(event, row, card)
      else now.current.actions.canvasMenu(event)
    },
    onDragStart(event: ReactDragEvent) {
      // The card pressed (the drag's own element, its face ring included), not the one under the
      // pointer by the time the browser starts the drag.
      const item = draggedItem(event.target as Element | null)
      if (item == null || state.rename || !events.start(item, { x: event.clientX, y: event.clientY }, pressedWith.current)) {
        event.preventDefault()
        return
      }
      // The item's own drag (onto the Timeline, a monitor); in the panel the cards move instead of a picture.
      startFilmDrag(event.nativeEvent, { item })
      if (ghost.current) event.dataTransfer.setDragImage(ghost.current, 0, 0)
    },
    onDragOver(event: ReactDragEvent) {
      if (!tracker.active()) return
      event.preventDefault()
      event.dataTransfer.dropEffect = 'copy'
    },
    onDrop(event: ReactDragEvent) {
      if (events.drop({ x: event.clientX, y: event.clientY, screenX: event.screenX })) event.preventDefault()
    },
    // Dropped elsewhere (the Timeline took it), or Escape: the cards go back and nothing more is sent.
    onDragEnd() {
      events.end()
      setOutside(null)
    },
  }

  const order = useMemo(() => drawOrder(cards), [cards])
  const stacks = useMemo(() => stackSizes(cards), [cards])
  const extent = canvasExtent(cards, room.width, room.height)
  const grid = Math.max(4, options.grid)
  const canvasStyle: CSSProperties = { width: extent.width, height: extent.height, ...(options.snap ? { backgroundSize: `${grid}px ${grid}px` } : {}) }
  return (
    <div ref={scroller} className="film-freeform" data-testid="film-project-freeform">
      <div ref={canvas} className="film-freeform-canvas" style={canvasStyle} data-snap={options.snap || undefined} data-kit-ui-id="control:project.freeform" data-testid="film-project-freeform-canvas" {...handlers}>
        {order.map((card) => {
          const row = rows.get(card.item)
          if (!row) return null
          const key = `i${card.item}`
          const picture = preview.picture(row)
          const leads = card.stack === card.item ? (stacks.get(card.item) ?? null) : null
          return (
            <FreeformCardView
              key={key}
              card={card}
              row={row}
              mark={preview.marks.get(key)?.mark}
              previewSelected={preview.selection?.has(card.item) ?? false}
              selected={selected.has(card.item)}
              offset={drag && moving?.has(card.item) ? drag.offset : NO_OFFSET}
              stack={leads}
              showName={options.showNames}
              showDuration={options.showDurations}
              font={font}
              hoverScrub={hoverScrub}
              touchScrub={touchScrub}
              renaming={state.rename && state.rename.item === card.item ? state.rename.text : null}
              color={colors(row)}
              revision={row.kind === 'sequence' ? revision : null}
              thumbnails={picture.thumbnails}
              stamp={picture.stamp}
              ui={ui}
              actions={actions}
              phrase={phrase}
            />
          )
        })}
      </div>
      {/* The browser's drag picture: nothing (in the view the cards themselves move). */}
      <div ref={ghost} className="film-freeform-ghost" aria-hidden="true" />
      {/* Out of the view, upstream's drag ghost: the item's name beside the pointer. */}
      {drag && outside ? (
        <div className="film-freeform-drag-label" style={{ left: outside.x + 12, top: outside.y + 8 }} data-testid="film-project-freeform-drag-label">
          {rows.get(drag.item)?.name ?? ''}
        </div>
      ) : null}
    </div>
  )
}

type CardViewProps = {
  card: FreeformCard
  row: ProjectRow
  mark?: RowMark['mark']
  previewSelected: boolean
  selected: boolean
  offset: { x: number; y: number } | null
  /** The stack's size, on the stack's first card. */
  stack: number | null
  showName: boolean
  showDuration: boolean
  font: number
  hoverScrub: boolean
  touchScrub: boolean
  renaming: string | null
  color: string
  revision: number | null
  thumbnails: ProjectThumbnails
  stamp: string | null
  ui: ProjectUi
  actions: FreeformActions
  phrase: Phrases
}

/**
 * One card (upstream `card` in `freeform_view`) at its place on the canvas, by the drag's offset
 * while it moves with one; its box is where a press reaches it. It draws again only when its
 * place, row, or state changes.
 */
const FreeformCardView = memo(function FreeformCardView({ card, row, mark, previewSelected, selected, offset, stack, showName, showDuration, font, hoverScrub, touchScrub, renaming, color, revision, thumbnails, stamp, ui, actions, phrase }: CardViewProps) {
  const item = card.item
  const ghosted = mark === 'added' || mark === 'removed'
  return (
    <div
      className="film-project-card film-freeform-card"
      style={{ left: card.x - 2 + (offset?.x ?? 0), top: card.y - 2 + (offset?.y ?? 0), width: card.size + 4 }}
      aria-selected={selected}
      data-preview={mark}
      data-preview-selected={previewSelected || undefined}
      data-moving={offset ? true : undefined}
      draggable={renaming == null && !ghosted}
      data-item={item}
      data-kit-ui-id="control:project.item"
      data-testid={`film-project-item-${item}`}
    >
      <CardArt row={row} width={card.size} hoverScrub={hoverScrub} touchScrub={touchScrub} revision={revision} thumbnails={thumbnails} stamp={stamp} ui={ui} phrase={phrase} />
      <span className="film-project-card-line" style={{ fontSize: font - 0.5 }}>
        {renaming != null ? (
          // The rename's own presses stay in its field.
          <span className="film-project-rename" data-kit-ui-id="control:project.rename" onClick={(event) => event.stopPropagation()} onDoubleClick={(event) => event.stopPropagation()} onContextMenu={(event) => event.stopPropagation()}>
            <RenameField value={renaming} label={phrase('Rename')} onChange={actions.renameText} onDone={actions.renameDone} testId={`film-project-rename-${item}`} />
          </span>
        ) : (
          <>
            {showName ? (
              <>
                <span className="film-project-card-chip" style={{ background: color }} data-kit-ui-id="control:project.item.label" />
                <span className="film-project-text" style={row.offline ? { color: OFFLINE } : undefined}>
                  {row.name}
                </span>
              </>
            ) : (
              <span className="film-project-text" />
            )}
            {showDuration ? (
              <span className="film-project-card-duration" style={{ fontSize: font - 1 }} data-testid={`film-project-duration-${item}`}>
                {shortDuration(row.duration ?? 0)}
              </span>
            ) : null}
          </>
        )}
      </span>
      {stack != null ? (
        <span className="film-freeform-stack" title={phrase('Stack of {n}').replace('{n}', String(stack))} data-kit-ui-id="control:project.stack" data-testid={`film-project-stack-${item}`}>
          {`×${stack}`}
        </span>
      ) : null}
    </div>
  )
})
