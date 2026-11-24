import { createRoot } from 'react-dom/client'
import { catalogNames, connectHost, createKitStrings, loadPhrases, parsePhrases, withPhrases, type Phrases } from '@kition/sdk/editor'
import '@kition/sdk/editor/styles.css'
import './app.css'
import { App } from './App'
import { CATALOGS, PHRASES } from './strings'
import { FILM_UI } from './filmUi'
import { coveredPhrases } from './i18n/phrases'
import manifest from '../../kit.json'
import './commandIcons'

const root = createRoot(document.getElementById('root')!)

// Opened outside a host, the page says where it belongs instead of waiting forever.
const alone = window.setTimeout(() => {
  const t = createKitStrings(CATALOGS, navigator.language)
  root.render(<div className="kui-alone">{t('noHost')}</div>)
}, 3000)

// Upstream's translations of its English labels and command titles, and this editor's own.
const UPSTREAM = import.meta.glob('./i18n/upstream/*.tsv', { query: '?raw', import: 'default' })

// `replica`: in a host that keeps replicas, an `.kfilm` keeps its KDM replica (identity,
// collaboration) across saves; elsewhere the editor opens and saves files as before.
// `checkpoints`: the host's named versions of the document (kit-editor's history). `view-state`:
// the person's view (open sequences, how each is shown) is kept by the host, never in the file.
void connectHost({ id: 'kit.film', version: '0.1.1', capabilities: ['ai', 'replica', 'checkpoints', 'view-state'], brand: manifest.ui.brand, display: manifest.ui.display, ui: FILM_UI }).then(async (host) => {
  window.clearTimeout(alone)
  const locale = host.init.locale
  // `quiet` translates engine and error text when the catalog has it, and is never recorded (`errorStatus`).
  const quiet: Phrases = withPhrases(await loadPhrases(UPSTREAM, locale), PHRASES, locale)
  let phrase: Phrases = quiet
  // Development builds note every label drawn without an entry in the page's catalog (`window.filmPhrases`), which the flow test reads.
  if (import.meta.env.DEV && !locale.toLowerCase().startsWith('en')) {
    const name = catalogNames(locale).find((candidate) => Object.keys(UPSTREAM).some((path) => path.toLowerCase().endsWith(`/${candidate}.tsv`)))
    const path = name ? Object.keys(UPSTREAM).find((each) => each.toLowerCase().endsWith(`/${name}.tsv`)) : undefined
    const table = path ? parsePhrases(String(await UPSTREAM[path]())) : new Map<string, string>()
    const extra = Object.entries(PHRASES).find(([tag]) => catalogNames(locale).includes(tag.toLowerCase()))?.[1] ?? {}
    const covered = coveredPhrases(quiet, (english) => table.has(english) || english in extra)
    phrase = covered.phrase
    ;(window as unknown as { filmPhrases?: unknown }).filmPhrases = { missing: covered.missing }
  }
  // No StrictMode: its doubled effects would open the document twice, in two engine workers.
  root.render(<App host={host} phrase={phrase} quietPhrase={quiet} />)
})
