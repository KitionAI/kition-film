// The editor's catalogs as a page loads them: Chinese for every Simplified Chinese locale tag, and
// the helpers the completeness check reads the source with.
import { readFileSync, readdirSync } from 'node:fs'
import test from 'node:test'
import assert from 'node:assert/strict'
import { loadPhrases, createStrings } from '@kition/kit-editor'
import { CATALOGS } from '../strings.ts'
import { optionText } from '../dialogs/registry.ts'
import { readCatalog, withoutComments } from '../../parity/i18n.mjs'
import { coveredPhrases, needsPhrase, withDeclaredLabels } from './phrases.ts'

const upstream = new URL('./upstream/', import.meta.url)
/** `main.tsx`'s `import.meta.glob('./i18n/upstream/*.tsv')`, read from disk. */
const LOADERS = Object.fromEntries(readdirSync(upstream).filter((name) => name.endsWith('.tsv')).map((name) => [`./i18n/upstream/${name}`, async () => readFileSync(new URL(name, upstream), 'utf8')]))
const zh = readCatalog(new URL('zh-hans.tsv', upstream)).table

test('every Simplified Chinese locale tag (zh-CN, zh-SG, zh-Hans, zh) loads the Chinese catalog, and t() is Chinese for it too', async () => {
  for (const locale of ['zh-CN', 'zh-SG', 'zh-Hans', 'zh']) {
    const phrase = await loadPhrases(LOADERS, locale)
    assert.equal(phrase('Project'), zh.get('Project'), locale)
    assert.notEqual(phrase('Project'), 'Project', locale)
    assert.equal(createStrings(CATALOGS, locale)('close'), CATALOGS['zh-CN'].close, locale)
  }
  // English stays English.
  assert.equal((await loadPhrases(LOADERS, 'en-US'))('Project'), 'Project')
})

test("an option's values fill its translated template as they are: `$&` and `$$` in a name are text", () => {
  const phrase = (text) => (text === 'After {name}' ? '[after] {name}' : text)
  assert.equal(optionText(['1', 'After {name}', { name: 'V$&' }], phrase), '[after] V$&')
  assert.equal(optionText(['1', 'After {name}', { name: "A$$B$'" }], phrase), "[after] A$$B$'")
})

test('the recorder notes a label its catalog lacks once, and never an id or a symbol', () => {
  const covered = coveredPhrases((text) => text, (text) => text === 'Known')
  for (const text of ['Known', 'Unknown', 'Unknown', 'project.bin', '1/2', '']) covered.phrase(text)
  assert.deepEqual(covered.missing(), ['Unknown'])
  assert.equal(needsPhrase('project.item.label'), false)
  // A declared label no catalog has as a key goes through phrase(); a key reads as before.
  const t = withDeclaredLabels((key) => (key === 'close' ? 'Close!' : key), (text) => `<${text}>`)
  assert.equal(t('close'), 'Close!')
  assert.equal(t('Audio Meters'), '<Audio Meters>')
})

test('the check reads source without comments, keeping `//` and `/*` inside strings', () => {
  const text = "const a = 'http://x' // note 'Gone'\nconst b = \"/* kept */\" /* 'Gone too' */\nconst c = `// also kept`"
  assert.equal(withoutComments(text), "const a = 'http://x' \nconst b = \"/* kept */\" \nconst c = `// also kept`")
})
