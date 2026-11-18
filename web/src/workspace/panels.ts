import { createElement, type ReactNode } from 'react'
import type { Phrases, WorkspacePanel } from '@kition/kit-editor'
import upstream from '../../parity/film-upstream.json' with { type: 'json' }
import { Placeholder } from '../panels/Placeholder'

/** What an editor part adds to its panel: how it draws, and its own strip, menu rows, and close. */
export type PanelParts = Omit<WorkspacePanel, 'id' | 'label' | 'compact'>

/** Panels upstream itself draws as a placeholder (`panels/mod.rs` `show`'s last arm). */
const UPSTREAM_PLACEHOLDERS = new Set(['libraries'])

/**
 * Upstream's 26 panels (`PanelKind::ALL`) for kit-editor's `WorkspaceLayout`: upstream titles through
 * `phrase`, Tools and Audio Meters compact. A panel the editor draws comes from `parts`; any other
 * draws a placeholder: upstream's own text for the panels upstream does not build, and
 * `notAvailable` for those a later wave builds. Build it once per `phrase` and `parts`: the
 * layout redraws every frame when the array changes.
 */
export function filmPanels(phrase: Phrases, notAvailable: string, parts: Readonly<Record<string, PanelParts>>): WorkspacePanel[] {
  return upstream.panels.map((panel) => {
    const label = phrase(panel.title)
    const text = UPSTREAM_PLACEHOLDERS.has(panel.id) ? phrase('{panel} — coming in a later milestone').replace('{panel}', label) : notAvailable
    const own: PanelParts = parts[panel.id] ?? { render: (): ReactNode => createElement(Placeholder, { text, panel: panel.id, compact: panel.compact }) }
    return { ...own, id: panel.id, label, ...(panel.compact ? { compact: true } : {}) }
  })
}
