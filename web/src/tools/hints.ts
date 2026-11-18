// Imports carry the JSON its import attribute so `node --test` loads this module as it is.
import upstream from '../../parity/film-upstream.json' with { type: 'json' }

const HINTS: ReadonlyMap<string, string> = new Map(upstream.hints.map((hint) => [hint.tool, hint.text]))

/**
 * Upstream's `lib.rs` `hint_text`: the status bar's hint for `tool` (a manifest id), in English, or
 * an empty string for the tools upstream gives none (Pen, the shapes, and Type). The manifest keeps
 * the macOS wording; elsewhere upstream says Alt for Opt and Ctrl for Cmd. Show it through `phrase`.
 */
export function toolHint(tool: string, mac: boolean): string {
  const text = HINTS.get(tool) ?? ''
  return mac ? text : text.replace(/\bOpt\b/g, 'Alt').replace(/\bCmd\b/g, 'Ctrl')
}
