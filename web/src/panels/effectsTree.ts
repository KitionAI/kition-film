// Imports carry `.ts` so `node --test` loads this module as it is.

/**
 * The Effects panel's model (upstream `panels/effects.rs` `show`): the engine's effects
 * (`effect.list`) and saved presets (`preset.list`) as a folder tree in upstream's top-folder
 * order, filtered by the search box, with the folders a person opened. Pure, so `node --test`
 * runs it.
 */

export type EffectKind = 'Video' | 'Audio' | 'VideoTransition' | 'AudioTransition'

/** An effect as `effect.list` gives it: `category` is its folder path (`["Video Effects", "Blur & Sharpen"]`). */
export type EffectDef = { id: string; name: string; kind: EffectKind; category: readonly string[] }

/** A saved effect preset as `preset.list` gives it. */
export type EffectPreset = { name: string; description?: string; effects?: readonly string[] }

/**
 * Upstream's top folders, in its order (`vtransition::EFFECT_TOP_FOLDERS`), without Color Presets
 * (the Color panel is not drawn yet, so its looks have nowhere to be graded). Effects in no folder
 * (the fixed ones: Motion, Opacity, Volume…) and the obsolete transitions are not listed, as upstream.
 */
export const EFFECT_TOP_FOLDERS = ['Presets', 'Audio Effects', 'Audio Transitions', 'Video Effects', 'Video Transitions', 'Legacy'] as const

/** What a drag from the panel carries: an effect or transition by id, or a preset by name. */
export type EffectPayload = { effect: string; kind: EffectKind } | { preset: string }

export const isTransition = (kind: EffectKind) => kind === 'VideoTransition' || kind === 'AudioTransition'

/** A row of the tree: a folder (its key `<top>` or `<top>/<folder>`), an effect, or a preset. */
export type EffectRow =
  | { kind: 'folder'; key: string; name: string; depth: number; open: boolean }
  | { kind: 'effect'; def: EffectDef; depth: number }
  | { kind: 'preset'; preset: EffectPreset; depth: number }

type Phrase = (text: string) => string

/**
 * Upstream's `matches_query` on the label in the interface language: the query's words, without
 * case, all in the label. The English name matches too, so a person reading Chinese can still type
 * the name a tutorial uses.
 */
export function matchesQuery(name: string, query: string, phrase: Phrase = (text) => text): boolean {
  const words = query.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean)
  if (words.length === 0) return true
  const shown = phrase(name).toLocaleLowerCase()
  const english = name.toLocaleLowerCase()
  return words.every((word) => shown.includes(word)) || words.every((word) => english.includes(word))
}

/** Upstream sorts these folders alphabetically, by sub-folder then name, obsolete ones last. */
const SORTED_TOPS = new Set(['Video Effects', 'Legacy'])

/**
 * The rows the panel shows: every top folder that has something (with a search, only those with a
 * match, all opened), then its sub-folders in definition order (sorted for Video Effects and
 * Legacy), and the effects with no sub-folder last, outside any folder (upstream: Audio Effects ▸
 * Balance, Mute, Volume). `open` holds the folder keys a person opened.
 */
export function effectRows(defs: readonly EffectDef[], presets: readonly EffectPreset[], query: string, open: ReadonlySet<string>, phrase: Phrase = (text) => text): EffectRow[] {
  const searching = query.trim() !== ''
  const isOpen = (key: string) => searching || open.has(key)
  const rows: EffectRow[] = []
  for (const top of EFFECT_TOP_FOLDERS) {
    if (top === 'Presets') {
      const shown = presets.filter((preset) => matchesQuery(preset.name, query, phrase))
      if (shown.length === 0) continue
      rows.push({ kind: 'folder', key: top, name: top, depth: 0, open: isOpen(top) })
      if (isOpen(top)) for (const preset of shown) rows.push({ kind: 'preset', preset, depth: 1 })
      continue
    }
    const items = defs.filter((def) => def.category[0] === top && matchesQuery(def.name, query, phrase))
    if (SORTED_TOPS.has(top)) {
      const sub = (def: EffectDef) => def.category[1] ?? ''
      items.sort((a, b) => Number(sub(a) === 'Obsolete') - Number(sub(b) === 'Obsolete') || compare(sub(a), sub(b)) || compare(a.name.toLowerCase(), b.name.toLowerCase()))
    }
    if (items.length === 0) continue
    rows.push({ kind: 'folder', key: top, name: top, depth: 0, open: isOpen(top) })
    if (!isOpen(top)) continue
    const subs: string[] = []
    for (const def of items) {
      const sub = def.category[1] ?? ''
      if (!subs.includes(sub)) subs.push(sub)
    }
    // Loose items (no sub-folder) come last.
    subs.sort((a, b) => Number(a === '') - Number(b === ''))
    for (const sub of subs) {
      const key = `${top}/${sub}`
      if (sub !== '') {
        rows.push({ kind: 'folder', key, name: sub, depth: 1, open: isOpen(key) })
        if (!isOpen(key)) continue
      }
      for (const def of items) if ((def.category[1] ?? '') === sub) rows.push({ kind: 'effect', def, depth: sub === '' ? 1 : 2 })
    }
  }
  return rows
}

const compare = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0)

/** The engine's `effect.list` answer as definitions (an array, or `{ effects }`), dropping what is malformed. */
export function effectDefsOf(answer: unknown): EffectDef[] {
  const list = Array.isArray(answer) ? answer : ((answer as { effects?: unknown } | null)?.effects ?? [])
  if (!Array.isArray(list)) return []
  const kinds = new Set(['Video', 'Audio', 'VideoTransition', 'AudioTransition'])
  return list.flatMap((each) => {
    const def = each as { id?: unknown; name?: unknown; kind?: unknown; category?: unknown }
    if (typeof def.id !== 'string' || typeof def.name !== 'string' || typeof def.kind !== 'string' || !kinds.has(def.kind)) return []
    const category = Array.isArray(def.category) ? def.category.filter((part): part is string => typeof part === 'string') : []
    return [{ id: def.id, name: def.name, kind: def.kind as EffectKind, category }]
  })
}

/** The engine's `preset.list` answer as presets. */
export function presetsOf(answer: unknown): EffectPreset[] {
  const list = (answer as { presets?: unknown } | null)?.presets
  if (!Array.isArray(list)) return []
  return list.flatMap((each) => {
    const preset = each as { name?: unknown; description?: unknown; effects?: unknown }
    if (typeof preset.name !== 'string') return []
    return [{ name: preset.name, description: typeof preset.description === 'string' ? preset.description : undefined, effects: Array.isArray(preset.effects) ? preset.effects.filter((name): name is string => typeof name === 'string') : undefined }]
  })
}

/** Every label the panel can draw from the engine's lists: folder names, effect and preset names, and the presets' descriptions (their tooltips). */
export function effectLabels(defs: readonly EffectDef[], presets: readonly EffectPreset[]): Set<string> {
  const labels = new Set<string>()
  for (const row of effectRows(defs, presets, '', new Set(allFolderKeys(defs).concat('Presets')))) {
    if (row.kind === 'folder') labels.add(row.name)
    else if (row.kind === 'effect') labels.add(row.def.name)
    else {
      labels.add(row.preset.name)
      if (row.preset.description) labels.add(row.preset.description)
    }
  }
  return labels
}

/** Every folder key of the tree (to open them all). */
export function allFolderKeys(defs: readonly EffectDef[]): string[] {
  const keys = new Set<string>()
  for (const def of defs) {
    const [top, sub] = def.category
    if (!top) continue
    keys.add(top)
    if (sub) keys.add(`${top}/${sub}`)
  }
  return [...keys]
}

/** Whether an effect of `kind` goes on a clip of a `track` kind: video effects on video clips, audio on audio. */
export function fitsTrack(kind: EffectKind, track: 'video' | 'audio') {
  return (kind === 'Video' || kind === 'VideoTransition') === (track === 'video')
}

/**
 * The parameter names and choice options Effect Controls draws for the engine's effects, from
 * `effect.list` with `detail` (each effect's `paramInfo`).
 */
export function paramLabels(answer: unknown): Set<string> {
  const labels = new Set<string>()
  const list = Array.isArray(answer) ? answer : []
  for (const each of list) {
    const info = (each as { paramInfo?: unknown }).paramInfo
    if (!Array.isArray(info)) continue
    for (const param of info as Array<{ label?: unknown; options?: unknown }>) {
      if (typeof param.label === 'string') labels.add(param.label)
      if (Array.isArray(param.options)) for (const option of param.options) if (typeof option === 'string') labels.add(option)
    }
  }
  return labels
}
