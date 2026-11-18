// What the Project panel draws of a dialog's preview (Task 10): the preview's rows
// (`previewQuery('project.items', …)`) with the document's own row objects wherever nothing shown
// changed, so the memoized rows and cards draw again only where the preview changes them, and the
// marks on the others. React-free, so `node --test` runs it. Imports carry `.ts` so `node --test`
// loads this module as it is.
import type { FilmSearchBin } from '../film.ts'
import type { PreviewDiff } from '../dialogs/preview.ts'
import { withRemoved, type PreviewMark } from '../dialogs/previewViews.ts'
import type { ProjectRow } from './projectModel.ts'

/** A row's mark: added (outlined), removed (faded), or changed, with the changed cells' column names joined by newlines (`Name` for the name). */
export type RowMark = { mark: PreviewMark; cells: string }

/** A row's key: its bin or item (as the panel keys its rows). */
export const previewRowKey = (row: ProjectRow) => (row.bin != null ? `b${row.bin}` : `i${row.item}`)

const same = (a: ProjectRow, b: ProjectRow) => JSON.stringify(a) === JSON.stringify(b)

/** The columns both rows show (a preview of Metadata Display shows other columns: a cell only one side has is no change of the item). */
const sharedColumns = (was: ProjectRow, row: ProjectRow) => Object.keys(was.cells ?? {}).filter((column) => Object.hasOwn(row.cells ?? {}, column))

/** `row` without the cells `was` does not show, to compare what both show. */
const shownBoth = (row: ProjectRow, columns: readonly string[]): ProjectRow => (row.cells ? { ...row, cells: Object.fromEntries(columns.map((column) => [column, row.cells?.[column] ?? ''])) } : row)

/** The cells of `row` that `was` shows otherwise: each column both show, the name, and the label. */
function changedCells(was: ProjectRow, row: ProjectRow): string[] {
  const cells: string[] = []
  if (was.name !== row.name) cells.push('Name')
  for (const column of sharedColumns(was, row)) if ((was.cells?.[column] ?? '') !== (row.cells?.[column] ?? '') && column !== 'Name') cells.push(column)
  if (was.label !== row.label && !cells.includes('Label')) cells.push('Label')
  return cells
}

/**
 * The rows a Project preview draws, from the document's rows of the same bin and view and the
 * preview's: each preview row (an unchanged one is the document's own object), the rows it no
 * longer lists put back where they were (removed: deleted, or moved out of the bin shown), and a
 * mark for each row that is new, gone, or changed (with the cells that changed). A row the diff
 * names as changed that shows nothing new is marked changed with no cells.
 */
export function previewProjectRows(document: readonly ProjectRow[], preview: readonly ProjectRow[], diff: PreviewDiff | null): { rows: ProjectRow[]; marks: ReadonlyMap<string, RowMark> } {
  const marks = new Map<string, RowMark>()
  const before = new Map(document.map((row) => [previewRowKey(row), row]))
  const named = new Set<string>([...(diff?.items?.changed ?? []).map((entry) => `i${entry.id}`), ...(diff?.sequences?.changed ?? []).map((entry) => `i${entry.id}`), ...(diff?.bins?.changed ?? []).map((entry) => `b${entry.id}`)])
  const shown = preview.map((row) => {
    const key = previewRowKey(row)
    const was = before.get(key)
    if (!was) {
      marks.set(key, { mark: 'added', cells: '' })
      return row
    }
    if (same(was, row)) {
      if (named.has(key)) marks.set(key, { mark: 'changed', cells: '' })
      return was
    }
    // Only the columns shown differ (Metadata Display): the preview's row, with the cells it shows, unmarked unless the diff names it.
    const columns = sharedColumns(was, row)
    if (same(shownBoth(was, columns), shownBoth(row, columns))) {
      if (named.has(key)) marks.set(key, { mark: 'changed', cells: '' })
      return row
    }
    marks.set(key, { mark: 'changed', cells: changedCells(was, row).join('\n') })
    return row
  })
  const kept = new Set(preview.map(previewRowKey))
  const rows = withRemoved(shown, document, previewRowKey, (row) => !kept.has(previewRowKey(row)))
  for (const row of document) if (!kept.has(previewRowKey(row))) marks.set(previewRowKey(row), { mark: 'removed', cells: '' })
  return { rows, marks }
}

/**
 * The Project selection as the preview has it: the document's, less the items the diff deselects,
 * with those it selects (`projectSelection`). The scratch copy's own session state is not read: a
 * query runs on a throwaway copy of it. A dialog's `highlight` (Find's every match) is drawn in
 * its place: an item already selected is not in the diff.
 */
export function previewProjectSelection(document: readonly number[], diff: PreviewDiff | null, highlight?: readonly number[] | null): ReadonlySet<number> {
  if (highlight) return new Set(highlight)
  const removed = new Set((diff?.projectSelection?.removed ?? []).map((entry) => entry.id))
  return new Set([...document.filter((id) => !removed.has(id)), ...(diff?.projectSelection?.added ?? []).map((entry) => entry.id)])
}

/**
 * What the Project panel draws of a preview, by the rows it shows (`drawn`, their `previewRowKey`s):
 * an item, a sequence, or a selected item whose row is drawn, a bin whose row is drawn, and a bin
 * whose only change is its `items` once every row the diff adds, removes, or moves between bins is
 * drawn (the rows themselves show the change; the root bin has no row of its own).
 */
export function projectCovers(drawn: ReadonlySet<string>, diff: PreviewDiff | null) {
  const rows = [
    ...(diff?.items?.added ?? []),
    ...(diff?.items?.removed ?? []),
    ...(diff?.items?.changed ?? []).filter((entry) => (entry.fields ?? []).includes('bin')),
    ...(diff?.sequences?.added ?? []),
    ...(diff?.sequences?.removed ?? []),
  ].map((entry) => `i${entry.id}`)
  const rowsDrawn = rows.length > 0 && rows.every((key) => drawn.has(key))
  return (part: string, entry: { id: number; fields?: string[] }) => {
    if (part !== 'bins') return drawn.has(`i${entry.id}`)
    if (drawn.has(`b${entry.id}`)) return true
    const fields = entry.fields ?? []
    return fields.length > 0 && fields.every((field) => field === 'items') && rowsDrawn
  }
}

/**
 * A search bin's matches as the List view lists them: each item's own row object (the List view's
 * depth is drawn by the row's `depth` prop), so memoized rows draw again only where they change.
 * An item the List view does not list is left out.
 */
export function searchBinMatches<Row>(searchBin: Pick<FilmSearchBin, 'items'>, byItem: ReadonlyMap<number, Row>): Row[] {
  return searchBin.items.flatMap((item) => {
    const row = byItem.get(item)
    return row ? [row] : []
  })
}

/** Whether the panel lists its search bins (upstream `search_bin_rows`): in the List view of the main panel's project root. */
export const searchBinsShown = ({ mode, tab, bin, root }: { mode: string; tab: boolean; bin: number | null; root: number | null }) => mode === 'list' && !tab && (bin == null || bin === root)

/** A search bin row of the List view: the document's (the same object while unchanged), or one only the preview has, marked added. */
export type SearchBinRow = FilmSearchBin & { mark?: PreviewMark }

/**
 * The search bins the List view lists after the root's rows (upstream `search_bin_rows`): the
 * document's, then those only the preview has (Create Search Bin's ghost bin with its matches),
 * marked added.
 */
export function previewSearchBins(document: readonly FilmSearchBin[], added: readonly FilmSearchBin[] | null): readonly SearchBinRow[] {
  if (!added?.length) return document
  const known = new Set(document.map((each) => each.bin))
  return [...document, ...added.filter((each) => !known.has(each.bin)).map((each) => ({ ...each, mark: 'added' as const }))]
}

/**
 * The stamp a row's thumbnail is keyed on: the preview row's own when its picture comes from the
 * preview (`previewItemFrame`), else the document's row's. A preview row's stamp (the copy's
 * media) on the document's cache would file the document's frame under the copy's media, which
 * the document has once OK runs, and draw it then in place of the new picture.
 */
export function thumbStamp(row: Pick<ProjectRow, 'item' | 'stamp'>, fromPreview: boolean, documentStamps: ReadonlyMap<number, string | null | undefined>): string | null {
  if (fromPreview || row.item == null || !documentStamps.has(row.item)) return row.stamp ?? null
  return documentStamps.get(row.item) ?? null
}
