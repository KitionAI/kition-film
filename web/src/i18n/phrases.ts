// Imports carry `.ts` so `node --test` loads this module as it is.
import type { Phrases } from '@kition/sdk/editor'

/**
 * Whether `english` has words to translate: not a number or a symbol, and not an id (`project.bin`:
 * a Kit UI declaration upstream registers with no label of its own carries its id).
 */
export const needsPhrase = (english: string) => /[A-Za-z]{2}/.test(english) && !/^[a-z][A-Za-z0-9]*(\.[A-Za-z0-9]+)+$/.test(english)

/**
 * `phrase` that also notes every English label it was asked for that `has` lacks, for a locale
 * that is not English: what development builds report as `window.filmPhrases.missing()`, so the
 * flow test can fail on a label drawn without a catalog entry.
 */
export function coveredPhrases(phrase: Phrases, has: (english: string) => boolean) {
  const missing = new Set<string>()
  const covered: Phrases = (english) => {
    if (typeof english === 'string' && !missing.has(english) && needsPhrase(english) && !has(english)) missing.add(english)
    return phrase(english)
  }
  return { phrase: covered, missing: () => [...missing].sort() }
}

type Strings = (key: string, values?: Record<string, string | number>) => string

/**
 * `t` that translates, through `phrase`, a text no catalog has as a key: the Kit UI declaration's
 * labels (`filmUi.ts`) are upstream's English, which kit-editor's catalog shows a host through `t`.
 * A key of the editor's or kit-editor's strings reads as before.
 */
export function withDeclaredLabels(t: Strings, phrase: Phrases): Strings {
  return (key, values) => {
    const text = t(key, values)
    return text === key && values === undefined ? phrase(key) : text
  }
}
