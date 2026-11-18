// Where keyboard focus goes when the element holding it goes away or lets it go (lesson 2): to the
// editor, and only when focus went nowhere (`document.activeElement` is the body) while the
// editor's page has focus, so it is never pulled from another field or from the host. Imports
// carry `.ts` so `node --test` loads this module as it is.

type Focusable = { focus: (options?: { preventScroll?: boolean }) => void }
type Closest = { closest: (selector: string) => Focusable | null }

/** What these read of the page's document. */
export type FocusDocument = {
  hasFocus: () => boolean
  readonly activeElement: unknown
  readonly body: unknown
  querySelector: (selector: string) => Focusable | null
}

/** Whether focus went nowhere on a page that has it. */
const wentNowhere = (doc: FocusDocument) => doc.hasFocus() && (doc.activeElement == null || doc.activeElement === doc.body)

/**
 * Once the element that had focus is gone (a floating window closed by its X, by its bin going, by
 * a command, or hidden), on the next frame: the editor (`.kui-app`) takes focus, so its keys work
 * again without a click.
 */
export function giveKeysBack(doc: FocusDocument, schedule: (task: () => void) => void = (task) => void requestAnimationFrame(task)) {
  schedule(() => {
    if (wentNowhere(doc)) doc.querySelector('.kui-app')?.focus({ preventScroll: true })
  })
}

/**
 * A field let go of focus (Escape blurs a search field): the floating window holding it takes
 * focus, else the editor, so the keys stay where the person was.
 */
export function focusAfterBlur(field: Closest & { blur: () => void }, doc: FocusDocument) {
  const home = field.closest('.kui-floating-panel') ?? field.closest('.kui-app')
  field.blur()
  if (home && wentNowhere(doc)) home.focus({ preventScroll: true })
}
