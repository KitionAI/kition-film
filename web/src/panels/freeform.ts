// The Freeform view's model (upstream `panels/project_views.rs` `freeform_view`, `card`,
// `cards_stack`, `card_menu`): the cards where the engine's `project.freeform.layout` puts them,
// drawn deepest first, hit-tested as drawn, and a card drag that moves the selection and whole
// stacks with one `project.freeform.move` on release. React-free, so `node --test` runs it.
// Imports carry `.ts` so `node --test` loads this module as it is.
import { matchesSearch, type ProjectRow } from './projectModel.ts'

/** One card of `project.freeform.layout` (upstream `project_panel::Card`): where it sits, its width, and its stack (the stack's first item). */
export type FreeformCard = { item: number; x: number; y: number; size: number; placed: boolean; stack: number | null }

/** Freeform View Options (upstream `project_panel::FreeformOptions`, `project.view.get`'s `freeform`). */
export type FreeformOptions = { grid: number; snap: boolean; showNames: boolean; showDurations: boolean; cardSize: number }

/** Upstream's `FreeformOptions::default`. */
export const DEFAULT_FREEFORM: FreeformOptions = { grid: 20, snap: false, showNames: true, showDurations: true, cardSize: 128 }

/** The width `project.freeform.*` lays the auto-placed cards out for when the panel's is unknown (the engine's default). */
export const LAYOUT_WIDTH = 800

/** A card's height: its 16:9 picture and the name line (upstream `r`: `size * 9 / 16 + 20`). */
export const cardHeight = (size: number) => (size * 9) / 16 + 20

/** A card's box, where a press reaches it (upstream `card`'s `r.expand(2.0)`). */
export const cardBox = (card: Pick<FreeformCard, 'x' | 'y' | 'size'>) => ({ x: card.x - 2, y: card.y - 2, width: card.size + 4, height: cardHeight(card.size) + 4 })

/** The options of `project.view.get`'s answer, with upstream's defaults for any it lacks. */
export function freeformOptions(answer: unknown): FreeformOptions {
  const raw = ((answer as { freeform?: Partial<FreeformOptions> } | null)?.freeform ?? {}) as Partial<FreeformOptions>
  return {
    grid: typeof raw.grid === 'number' ? raw.grid : DEFAULT_FREEFORM.grid,
    snap: typeof raw.snap === 'boolean' ? raw.snap : DEFAULT_FREEFORM.snap,
    showNames: typeof raw.showNames === 'boolean' ? raw.showNames : DEFAULT_FREEFORM.showNames,
    showDurations: typeof raw.showDurations === 'boolean' ? raw.showDurations : DEFAULT_FREEFORM.showDurations,
    cardSize: typeof raw.cardSize === 'number' ? raw.cardSize : DEFAULT_FREEFORM.cardSize,
  }
}

/** The cards of `project.freeform.layout`'s answer, or null for an answer that is none. */
export function layoutCards(answer: unknown): FreeformCard[] | null {
  const cards = (answer as { cards?: unknown } | null)?.cards
  if (!Array.isArray(cards)) return null
  return cards.flatMap((raw) => {
    const card = raw as Partial<FreeformCard> | null
    if (!card || typeof card.item !== 'number' || typeof card.x !== 'number' || typeof card.y !== 'number' || typeof card.size !== 'number') return []
    return [{ item: card.item, x: card.x, y: card.y, size: card.size, placed: card.placed === true, stack: typeof card.stack === 'number' ? card.stack : null }]
  })
}

/**
 * The cards in the order upstream draws them: a stack's first card after the cards stacked behind
 * it (`order.sort_by_key(stack == Some(item))`, a stable sort), so it is on top. A later card is
 * drawn over an earlier one.
 */
export function drawOrder<C extends Pick<FreeformCard, 'item' | 'stack'>>(cards: readonly C[]): C[] {
  const lead = (card: C) => card.stack === card.item
  return [...cards.filter((card) => !lead(card)), ...cards.filter(lead)]
}

/** The card a press at (`x`, `y`) on the canvas reaches: the last one drawn whose box holds the point, or null for the empty canvas. */
export function cardAt<C extends FreeformCard>(cards: readonly C[], x: number, y: number): C | null {
  const order = drawOrder(cards)
  for (let index = order.length - 1; index >= 0; index -= 1) {
    const box = cardBox(order[index])
    if (x >= box.x && x <= box.x + box.width && y >= box.y && y <= box.y + box.height) return order[index]
  }
  return null
}

/** How many cards each stack holds, by its first item (the "×N" badge). */
export function stackSizes(cards: readonly Pick<FreeformCard, 'stack'>[]): ReadonlyMap<number, number> {
  const sizes = new Map<number, number>()
  for (const card of cards) if (card.stack != null) sizes.set(card.stack, (sizes.get(card.stack) ?? 0) + 1)
  return sizes
}

/** Upstream `cards_stack`: the stack `item`'s card is in, or null. */
export const stackOf = (cards: readonly Pick<FreeformCard, 'item' | 'stack'>[], item: number) => cards.find((card) => card.item === item)?.stack ?? null

/**
 * The cards that move with a drag of `dragged` (upstream `moving`): the card itself, the
 * selection when the card is in it, and every card of its stack.
 */
export function movesWith(cards: readonly Pick<FreeformCard, 'item' | 'stack'>[], dragged: number, selection: readonly number[]): ReadonlySet<number> {
  const stack = stackOf(cards, dragged)
  const selected = selection.includes(dragged)
  return new Set(cards.filter((card) => card.item === dragged || (selected && selection.includes(card.item)) || (stack != null && card.stack === stack)).map((card) => card.item))
}

/** `project.freeform.move`'s params. */
export type MoveParams = { items: number[]; x: number; y: number; width: number }

/**
 * What a drag of `dragged` by `offset` sends on release inside the panel (upstream `released`):
 * the card, then the rest of the selection when it is in it, then the rest of its stack, the
 * stack's first card leading so the others keep their places beside it; the lead goes to its
 * place plus the offset (never above or left of the canvas). Null for a drag of a point or less,
 * or of a card that is gone.
 */
export function moveParams(cards: readonly FreeformCard[], dragged: number, selection: readonly number[], offset: { x: number; y: number }, width: number): MoveParams | null {
  if (Math.hypot(offset.x, offset.y) <= 1) return null
  const card = cards.find((each) => each.item === dragged)
  if (!card) return null
  const items = [dragged]
  if (selection.includes(dragged)) items.push(...selection.filter((item) => item !== dragged))
  const stack = stackOf(cards, dragged)
  if (stack != null) {
    for (const each of cards) if (each.stack === stack && !items.includes(each.item)) items.push(each.item)
    const at = items.indexOf(stack)
    if (at >= 0) items.splice(at, 1)
    items.unshift(stack)
  }
  const lead = cards.find((each) => each.item === items[0]) ?? card
  return { items, x: Math.max(0, lead.x + offset.x), y: Math.max(0, lead.y + offset.y), width }
}

/** A card drag in progress: the card, where the press began, and how far it has moved. */
export type CardDrag = { item: number; from: { x: number; y: number }; offset: { x: number; y: number } }

/**
 * One tracker for a card drag (lesson 3: one press tracker per gesture). `start` on the press,
 * `move` as the pointer goes (the cards that move with it draw at the offset), `drop` on release
 * inside the panel sends `project.freeform.move` once (through `send`), and `cancel` (Escape, a
 * drag dropped elsewhere or abandoned) sends nothing and puts the cards back. Whatever ends it,
 * nothing more is sent for that drag.
 */
export function createCardDrag({ cards, selection, width, send, onChange }: { cards: () => readonly FreeformCard[]; selection: () => readonly number[]; width: () => number; send: (params: MoveParams) => void; onChange: (drag: CardDrag | null) => void }) {
  let drag: CardDrag | null = null
  const set = (next: CardDrag | null) => {
    drag = next
    onChange(next)
  }
  return {
    active: () => drag,
    start(item: number, at: { x: number; y: number }) {
      set({ item, from: at, offset: { x: 0, y: 0 } })
    },
    move(at: { x: number; y: number }) {
      if (!drag) return
      const offset = { x: at.x - drag.from.x, y: at.y - drag.from.y }
      if (offset.x === drag.offset.x && offset.y === drag.offset.y) return
      set({ ...drag, offset })
    },
    /** Released inside the panel at `at` (or where it last moved): the move is sent once, or nothing for a drag of a point. */
    drop(at?: { x: number; y: number }) {
      if (!drag) return null
      if (at) this.move(at)
      const ended = drag
      set(null)
      const params = ended ? moveParams(cards(), ended.item, selection(), ended.offset, width()) : null
      if (params) send(params)
      return params
    },
    cancel() {
      if (drag) set(null)
    },
  }
}

export type CardDragTracker = ReturnType<typeof createCardDrag>

/** A pointer point in the page (the browser's client space), with its screen x where the event gives one. */
export type ClientPoint = { x: number; y: number; screenX?: number }

/**
 * Some engines send a dragover with every coordinate 0 (at the edges, in frames): it says nothing
 * of where the pointer is, and is ignored rather than jumping the cards.
 */
const blank = (at: ClientPoint) => at.x === 0 && at.y === 0 && (at.screenX ?? 0) === 0

/**
 * The browser's drag events for a card drag, on its one tracker, in canvas coordinates
 * (`toCanvas`: a page point less the canvas's place now, which moves as the canvas scrolls; the
 * browsers scroll it themselves during a drag, and a wheel may too), so the cards stay under the
 * pointer and a drop reaches what scrolled into view.
 * - `move` for every dragover in the editor (the document's, so the cards keep following the
 *   pointer outside the canvas and the panel, as upstream's drawn offset does), applied once per
 *   animation frame (`schedule`), converted then, with `onFrame` told where the pointer is;
 * - `drop` for a release over the view (the move, once);
 * - `end` for the drag's end, which comes after a drop, after a drop elsewhere (the Timeline took
 *   the item), after Escape (a dragend with no drop), and when the dragend never comes (the card's
 *   node went mid-drag: a drop anywhere in the document, or a pointer move with no button down,
 *   `pointer`): it sends nothing, puts the cards back, and ends the item drag (`endDrag`) only
 *   when this tracker had one.
 */
export function createDragEvents({ tracker, toCanvas, schedule, endDrag, onFrame = () => undefined }: { tracker: CardDragTracker; toCanvas: (at: ClientPoint) => { x: number; y: number } | null; schedule: (task: () => void) => () => void; endDrag: () => void; onFrame?: (at: ClientPoint) => void }) {
  let pending: ClientPoint | null = null
  let last: ClientPoint | null = null
  // The kind of pointer the drag was pressed with (a finger, a pen, a mouse).
  let pressedWith: string | null = null
  let cancelFrame: (() => void) | null = null
  const flush = () => {
    cancelFrame?.()
    cancelFrame = null
  }
  const end = () => {
    const had = tracker.active() != null
    flush()
    pending = null
    last = null
    tracker.cancel()
    if (had) endDrag()
  }
  return {
    /** Starts the tracker on `item` from the page point `at`; false when the canvas is not there. */
    start(item: number, at: ClientPoint, pointerType: string | null = null) {
      const from = toCanvas(at)
      if (!from) return false
      last = at
      pressedWith = pointerType
      tracker.start(item, from)
      return true
    },
    /** The pointer at `at` while a card drags; false when no card drags (another drag). */
    move(at: ClientPoint) {
      if (!tracker.active()) return false
      if (blank(at)) return true
      pending = at
      last = at
      if (!cancelFrame)
        cancelFrame = schedule(() => {
          cancelFrame = null
          const point = pending ? toCanvas(pending) : null
          if (!pending || !point || !tracker.active()) return
          tracker.move(point)
          onFrame(pending)
        })
      return true
    },
    /** Released over the view at `at` (or where it last was, for a blank point): the move is sent once. False when no card drags. */
    drop(at: ClientPoint) {
      if (!tracker.active()) return false
      const where = blank(at) ? last : at
      const point = where ? toCanvas(where) : null
      flush()
      pending = null
      last = null
      endDrag()
      tracker.drop(point ?? undefined)
      return true
    },
    end,
    /**
     * A pointer move with `buttons` down: none, from the primary pointer of the kind the drag was
     * pressed with, means the drag is over, whether or not its dragend came. Another pointer (a
     * Pencil or a trackpad hovering beside a finger's drag on iPadOS) ends nothing.
     */
    pointer(buttons: number, { isPrimary = true, pointerType = null }: { isPrimary?: boolean; pointerType?: string | null } = {}) {
      if (buttons !== 0 || !tracker.active() || !isPrimary) return
      if (pressedWith != null && pointerType !== pressedWith) return
      end()
    },
  }
}

/**
 * The item a drag starts on: the card element it starts from (`data-item`, the card's whole box
 * with its face), not a preview's ghost (added or removed, drawn only); null for anything else.
 */
export function draggedItem(target: { closest: (selector: string) => { getAttribute: (name: string) => string | null } | null } | null): number | null {
  const card = target?.closest('[data-item]')
  if (!card) return null
  const mark = card.getAttribute('data-preview')
  if (mark === 'added' || mark === 'removed') return null
  const item = Number(card.getAttribute('data-item'))
  return Number.isFinite(item) ? item : null
}

/** The cards a search shows (upstream `cards.retain(matches_filter)`): those of the items listed, whose name holds the search. */
export function visibleCards<C extends Pick<FreeformCard, 'item'>>(cards: readonly C[], rows: ReadonlyMap<number, Pick<ProjectRow, 'name'>>, search: string): C[] {
  return cards.filter((card) => {
    const row = rows.get(card.item)
    return row != null && matchesSearch(row, search)
  })
}

/**
 * The cards read again, each unchanged card keeping the object it had, so a revision that moves
 * one card draws that card again and no other (lesson 5). The same list when nothing changed.
 */
export function shareCards(previous: readonly FreeformCard[] | null | undefined, next: FreeformCard[]): FreeformCard[] {
  if (!previous?.length) return next
  const old = new Map(previous.map((card) => [card.item, card]))
  let same = previous.length === next.length
  const shared = next.map((card, index) => {
    const before = old.get(card.item)
    const kept = before && before.x === card.x && before.y === card.y && before.size === card.size && before.placed === card.placed && before.stack === card.stack ? before : card
    if (kept !== previous[index]) same = false
    return kept
  })
  return same ? (previous as FreeformCard[]) : shared
}

/**
 * The cards a Project preview draws in the Freeform view: the preview's (each unchanged card the
 * document's own object), then each card the preview no longer lists, at its document place (a
 * removed row, drawn faded as the List and Icon views draw it).
 */
export function previewFreeformCards(document: readonly FreeformCard[], preview: readonly FreeformCard[]): FreeformCard[] {
  const shared = shareCards(document, [...preview])
  const kept = new Set(preview.map((card) => card.item))
  return [...shared, ...document.filter((card) => !kept.has(card.item))]
}

/** The canvas's size: the panel's, or more where cards lie beyond it (upstream `extent`). */
export function canvasExtent(cards: readonly Pick<FreeformCard, 'x' | 'y' | 'size'>[], width: number, height: number) {
  let w = width
  let h = height
  for (const card of cards) {
    w = Math.max(w, card.x + card.size + 40)
    h = Math.max(h, card.y + (card.size * 9) / 16 + 60)
  }
  return { width: w, height: h }
}

/** The items a card menu acts on (upstream `card_menu`): the selection when the card is in it, else the card alone. */
export const cardMenuItems = (selection: readonly number[], item: number) => (selection.includes(item) ? [...selection] : [item])

/**
 * The key a Freeform layout is read under (lesson 6): the document, the bin, the revision, the
 * width it wraps the auto-placed cards for, and the options (which change with no revision). An
 * answer read under another key is dropped.
 */
export const layoutKey = (key: { document: unknown; bin: number | null; revision: number | null; width: number; options: FreeformOptions | null }) => JSON.stringify([key.document ?? null, key.bin, key.revision, Math.round(key.width), key.options])

/**
 * The cards read under `read` (a `layoutKey`) while `wanted` is the key wanted: only those of the
 * same document and bin (lesson 6: another document's or bin's places never show, not even while
 * the next read is in flight). A newer revision, width, or options of the same bin keeps the last
 * cards until the next read lands, as every view keeps its last rows, so a resize or an edit does
 * not blank the canvas.
 */
export function layoutFor<C>(read: { key: string; cards: C } | null, wanted: string | null): C | null {
  if (!read || wanted == null) return null
  if (read.key === wanted) return read.cards
  const [document, bin] = JSON.parse(read.key) as unknown[]
  const [wantedDocument, wantedBin] = JSON.parse(wanted) as unknown[]
  return document === wantedDocument && bin === wantedBin ? read.cards : null
}

/**
 * Reads under the latest key wanted, one read in flight (lesson 6): a key wanted while a read is
 * in flight is read once it answers, and an answer is applied only while its key is still the
 * one wanted, so a late answer never overwrites a newer one.
 */
export function createLatestRead<V>({ read, apply }: { read: (key: string) => Promise<V | null>; apply: (key: string, value: V) => void }) {
  let wanted: string | null = null
  // The key whose answer is drawn: wanted again, it is not read again.
  let settled: string | null = null
  let running = false
  let stopped = false
  // Moves with `again`: a read begun before it answers for what was there before.
  let generation = 0
  const run = async () => {
    running = true
    try {
      while (!stopped && wanted != null && wanted !== settled) {
        const key = wanted
        const begun = generation
        const value = await read(key).catch(() => null)
        if (stopped) return
        if (key === wanted && begun === generation) {
          // A failed read leaves the key unsettled: the next want reads it again.
          if (value != null) {
            settled = key
            apply(key, value)
          }
          return
        }
      }
    } finally {
      running = false
    }
  }
  return {
    want(key: string | null) {
      wanted = key
      if (key != null && !running && key !== settled) void run()
    },
    /** Reads the key wanted again (an outside change the key does not show). */
    again() {
      generation += 1
      settled = null
      if (wanted != null && !running) void run()
    },
    stop() {
      stopped = true
    },
  }
}
