// What the status bar says when the engine or the editor refuses: the person's language, never a command id.
import test from 'node:test'
import assert from 'node:assert/strict'
import { createKitStrings } from '@kition/sdk/editor'
import { CATALOGS } from '../strings.ts'
import { readCatalog } from '../../parity/i18n.mjs'
import { ENGINE_REASONS, personMessage } from './errors.ts'

const zhTable = readCatalog(new URL('../i18n/upstream/zh-hans.tsv', import.meta.url)).table
const zh = { t: createKitStrings(CATALOGS, 'zh-CN'), phrase: (english) => zhTable.get(english) ?? english }
const en = { t: createKitStrings(CATALOGS, 'en-US'), phrase: (english) => english }
const say = (locale, text) => personMessage(text, locale.t, locale.phrase)

test('"command `x` is not available right now: <reason>" never shows the id, and the reason is in Chinese', () => {
  assert.equal(say(zh, 'command `edit.clear` is not available right now: nothing selected'), '现在不能这样做：没有选中任何片段')
  assert.equal(say(en, 'command `edit.clear` is not available right now: nothing selected'), 'Not available right now: nothing selected')
  assert.equal(say(zh, 'command `trim.extendToPlayhead` is not available right now: no edit points selected'), '现在不能这样做：没有选中编辑点')
  // A reason the catalog lacks stays as the engine gave it, still without the id.
  assert.equal(say(zh, 'command `x.y` is not available right now: something new'), '现在不能这样做：something new')
})

test('a sync-lock refusal says which track header to change, in both locales', () => {
  const text = 'edit failed: this edit would break sync: V2 is sync-locked and has a clip in the way (turn off its sync lock, or lock the track, to make this edit)'
  assert.equal(say(zh, text), '这次编辑会让 V2 失去同步：它开着同步锁定，而且有片段挡在那里。请在 V2 的轨道头上关闭同步锁定（或锁定这条轨道）后再试。')
  assert.match(say(en, text), /^This edit would put V2 out of sync: .*Turn off sync lock on the V2 track header/)
})

test('a locked track, offline media, bad parameters, and the editor\'s own refusals read in Chinese', () => {
  assert.equal(say(zh, 'edit failed: track is locked'), '没有完成这次编辑：轨道已锁定：请先在轨道头上解锁')
  assert.equal(say(zh, 'media: media offline: clips/a.mp4'), '媒体脱机：clips/a.mp4')
  assert.equal(say(zh, 'invalid parameters for `clip.multicamFlatten`: select multi-camera clips to flatten'), '无法完成：请先选择要拼合的多机位剪辑')
  assert.equal(say(zh, 'select an item or bin to rename'), '请先在“项目”面板中选择要重命名的项目或素材箱')
  assert.equal(say(zh, 'no active sequence'), '没有打开的序列')
  for (const text of ['command `a.b` is not available right now: nothing selected', 'invalid parameters for `a.b`: select a clip']) assert.ok(!say(zh, text).includes('a.b'), text)
})

test('every reason of the core flow has a Chinese entry', () => {
  const missing = ENGINE_REASONS.map(({ reason }) => reason).filter((reason) => !zhTable.has(reason))
  assert.deepEqual(missing, [])
})
