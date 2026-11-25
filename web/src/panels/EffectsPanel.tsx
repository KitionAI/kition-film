import { useEffect, useMemo, useState, type DragEvent as ReactDragEvent } from 'react'
import { ContextMenu, MenuItem, TesseraIcons, type ContextMenuPoint, type Phrases } from '@kition/sdk/editor'
import { focusAfterBlur } from '../workspace/editorFocus'
import { endEffectDrag, startEffectDrag } from '../timeline/effectDrag'
import { effectDefsOf, effectRows, isTransition, presetsOf, type EffectDef, type EffectPayload, type EffectPreset, type EffectRow } from './effectsTree'

const ChevronDown = TesseraIcons.ChevronDownIcon
const ChevronRight = TesseraIcons.ChevronRightIcon
const Folder = TesseraIcons.FolderIcon
const Search = TesseraIcons.SearchIcon

type Invoke = (id: string, params?: Record<string, unknown>) => Promise<unknown>
type Query = (id: string, params?: Record<string, unknown>) => Promise<unknown>

/** The folders a person opened (upstream `app.ui.expanded_fx`), and the search, kept while the panel is hidden. */
const opened = new Set<string>()
let searched = ''

export type EffectsPanelProps = {
  /** Whether a document is open (the lists are the engine's). */
  open: boolean
  query: Query
  invoke: Invoke
  phrase: Phrases
}

/**
 * The Effects panel (upstream `panels/effects.rs` `show`): a search box over the folder tree of
 * presets, audio effects and transitions, video effects and transitions, and the legacy ones.
 * Double-click applies an effect to the selected clips (a transition at the edit point nearest the
 * playhead on the targeted tracks, a preset to the selected clips); a drag takes it to a clip or a
 * cut in the Timeline, or to the clip Effect Controls shows. Right-click a transition to make it the
 * default one (Cmd+D).
 */
export function EffectsPanel({ open, query, invoke, phrase }: EffectsPanelProps) {
  const [defs, setDefs] = useState<EffectDef[]>([])
  const [presets, setPresets] = useState<EffectPreset[]>([])
  const [search, setSearch] = useState(searched)
  const [folds, setFolds] = useState(0)
  const [chosen, setChosen] = useState<string | null>(null)
  const [menu, setMenu] = useState<{ at: ContextMenuPoint; effect: string } | null>(null)
  useEffect(() => {
    if (!open) return undefined
    let live = true
    void Promise.all([query('effect.list'), query('preset.list')]).then(([effects, saved]) => {
      if (!live) return
      setDefs(effectDefsOf(effects))
      setPresets(presetsOf(saved))
    })
    return () => {
      live = false
    }
  }, [open, query])
  const rows = useMemo(() => effectRows(defs, presets, search, opened, phrase), [defs, presets, search, phrase, folds])
  const toggle = (key: string) => {
    if (opened.has(key)) opened.delete(key)
    else opened.add(key)
    setFolds((count) => count + 1)
  }
  const apply = (row: EffectRow) => {
    if (row.kind === 'effect') void invoke('effect.apply', { effect: row.def.id })
    else if (row.kind === 'preset') void invoke('preset.apply', { preset: row.preset.name })
  }
  const payloadOf = (row: EffectRow): EffectPayload | null => (row.kind === 'effect' ? { effect: row.def.id, kind: row.def.kind } : row.kind === 'preset' ? { preset: row.preset.name } : null)
  const keyOf = (row: EffectRow) => (row.kind === 'folder' ? `folder:${row.key}` : row.kind === 'effect' ? `effect:${row.def.id}` : `preset:${row.preset.name}`)
  return (
    <div className="film-fx" data-testid="film-effects">
      <div className="film-fx-search-row">
        <label className="film-project-search film-fx-search" data-kit-ui-id="control:effects.search">
          <Search size={13} aria-hidden="true" />
          <input
            type="search"
            value={search}
            placeholder={phrase('Search effects')}
            aria-label={phrase('Search effects')}
            data-testid="film-effects-search"
            onChange={(event) => {
              searched = event.target.value
              setSearch(event.target.value)
            }}
            onKeyDown={(event) => {
              event.stopPropagation()
              if (event.key === 'Escape') focusAfterBlur(event.currentTarget, document)
            }}
          />
        </label>
      </div>
      <div className="film-fx-tree" role="tree" aria-label={phrase('Effects')} data-testid="film-effects-tree">
        {rows.length === 0 && defs.length > 0 ? <p className="film-fx-empty">{phrase('No effects')}</p> : null}
        {rows.map((row) => {
          const key = keyOf(row)
          const indent = { paddingLeft: 8 + row.depth * 16 }
          if (row.kind === 'folder') {
            return (
              <div
                key={key}
                role="treeitem"
                aria-expanded={row.open}
                className="film-fx-row film-fx-folder"
                style={indent}
                data-kit-ui-id="control:effects.folder"
                data-testid={`film-effects-folder-${row.key}`}
                onClick={() => {
                  if (search.trim() === '') toggle(row.key)
                }}
              >
                {row.open ? <ChevronDown size={11} aria-hidden="true" /> : <ChevronRight size={11} aria-hidden="true" />}
                <Folder size={13} aria-hidden="true" />
                <span className="film-fx-name">{phrase(row.name)}</span>
              </div>
            )
          }
          const payload = payloadOf(row)
          const transition = row.kind === 'effect' && isTransition(row.def.kind)
          const name = row.kind === 'effect' ? row.def.name : row.preset.name
          return (
            <div
              key={key}
              role="treeitem"
              aria-selected={chosen === key}
              className="film-fx-row film-fx-item"
              style={indent}
              draggable
              title={row.kind === 'preset' && row.preset.description ? phrase(row.preset.description) : phrase(name)}
              data-kit-ui-id={row.kind === 'effect' ? 'control:effects.item' : 'control:effects.preset'}
              data-testid={row.kind === 'effect' ? `film-effects-item-${row.def.id}` : `film-effects-preset-${row.preset.name}`}
              onClick={() => setChosen(key)}
              onDoubleClick={() => apply(row)}
              onDragStart={(event: ReactDragEvent<HTMLDivElement>) => {
                setChosen(key)
                if (payload) startEffectDrag(event.nativeEvent, payload)
              }}
              onDragEnd={() => endEffectDrag()}
              onContextMenu={(event) => {
                event.preventDefault()
                setChosen(key)
                if (transition && row.kind === 'effect') setMenu({ at: { x: event.clientX, y: event.clientY }, effect: row.def.id })
              }}
            >
              <span className="film-fx-chevron" />
              <span className="film-fx-icon" data-transition={transition || undefined} data-preset={row.kind === 'preset' || undefined} aria-hidden="true" />
              <span className="film-fx-name">{phrase(name)}</span>
            </div>
          )
        })}
      </div>
      {menu ? (
        <ContextMenu at={menu.at} onClose={() => setMenu(null)} label={phrase('Effects')} testId="film-effects-menu">
          <MenuItem
            label={phrase('Set Selected as Default Transition')}
            uiId="control:effects.itemMenu.setDefaultTransition"
            testId="film-effects-menu-default"
            onSelect={() => void invoke('effect.setDefaultTransition', { effect: menu.effect })}
          />
        </ContextMenu>
      ) : null}
    </div>
  )
}
