import test from 'node:test'
import assert from 'node:assert/strict'
import { effectDefsOf, effectRows, fitsTrack, matchesQuery, presetsOf } from './effectsTree.ts'

const defs = effectDefsOf([
  { id: 'motion', name: 'Motion', kind: 'Video', category: [] },
  { id: 'gaussian_blur', name: 'Gaussian Blur', kind: 'Video', category: ['Video Effects', 'Blur & Sharpen'] },
  { id: 'sharpen', name: 'Sharpen', kind: 'Video', category: ['Video Effects', 'Blur & Sharpen'] },
  { id: 'old', name: 'Old Thing', kind: 'Video', category: ['Video Effects', 'Obsolete'] },
  { id: 'tint', name: 'Tint', kind: 'Video', category: ['Video Effects', 'Color Correction'] },
  { id: 'cross_dissolve', name: 'Cross Dissolve', kind: 'VideoTransition', category: ['Video Transitions', 'Dissolve'] },
  { id: 'iris', name: 'Iris Box', kind: 'VideoTransition', category: ['Obsolete', 'Video Transitions'] },
  { id: 'volume_x', name: 'Mute', kind: 'Audio', category: ['Audio Effects'] },
  { id: 'amplify', name: 'Amplify', kind: 'Audio', category: ['Audio Effects', 'Amplitude and Compression'] },
  { bad: true },
])
const presets = presetsOf({ presets: [{ name: 'Blur In', description: 'blur' }, { nope: 1 }] })

test('the tree lists upstream top folders in order, without folder-less or obsolete-top effects', () => {
  const all = new Set(['Presets', 'Audio Effects', 'Audio Effects/Amplitude and Compression', 'Video Effects', 'Video Effects/Blur & Sharpen', 'Video Effects/Obsolete', 'Video Effects/Color Correction', 'Video Transitions', 'Video Transitions/Dissolve'])
  const rows = effectRows(defs, presets, '', all)
  const tops = rows.filter((row) => row.kind === 'folder' && row.depth === 0).map((row) => row.name)
  assert.deepEqual(tops, ['Presets', 'Audio Effects', 'Video Effects', 'Video Transitions'])
  const names = rows.filter((row) => row.kind === 'effect').map((row) => row.def.id)
  assert.ok(!names.includes('motion') && !names.includes('iris'))
  // Video Effects sorts by sub-folder (Obsolete last), then name; a loose audio effect follows the sub-folders.
  const video = rows.filter((row) => row.kind === 'folder' && row.depth === 1 && row.key.startsWith('Video Effects/')).map((row) => row.name)
  assert.deepEqual(video, ['Blur & Sharpen', 'Color Correction', 'Obsolete'])
  const audio = rows.filter((row) => (row.kind === 'effect' && row.def.kind === 'Audio') || (row.kind === 'folder' && row.key.startsWith('Audio Effects/')))
  assert.equal(audio.at(-1).kind, 'effect')
  assert.equal(audio.at(-1).def.id, 'volume_x')
})

test('a closed folder hides what it holds; a search opens every folder with a match and drops the rest', () => {
  const closed = effectRows(defs, presets, '', new Set())
  assert.ok(closed.every((row) => row.kind === 'folder' && row.depth === 0))
  const found = effectRows(defs, presets, 'blur', new Set())
  assert.deepEqual(found.filter((row) => row.kind !== 'folder').map((row) => (row.kind === 'effect' ? row.def.id : row.preset.name)), ['Blur In', 'gaussian_blur'])
  assert.ok(found.every((row) => row.kind !== 'folder' || row.open))
  // The translated name matches too.
  const zh = (text) => ({ 'Gaussian Blur': '高斯模糊' })[text] ?? text
  assert.ok(matchesQuery('Gaussian Blur', '高斯', zh))
  assert.ok(matchesQuery('Gaussian Blur', 'GAUSS blur', zh))
  assert.ok(!matchesQuery('Gaussian Blur', 'sharp', zh))
})

test('effects fit the clips of their kind of track', () => {
  assert.ok(fitsTrack('Video', 'video') && fitsTrack('VideoTransition', 'video') && fitsTrack('Audio', 'audio') && fitsTrack('AudioTransition', 'audio'))
  assert.ok(!fitsTrack('Video', 'audio') && !fitsTrack('AudioTransition', 'video'))
})
