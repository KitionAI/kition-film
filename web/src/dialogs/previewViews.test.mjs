// Previews drawn in the Timeline, Project, and Markers panels (Task 10): the diff (`previewDiff`,
// Task 3's "As shipped") mapped onto what each panel draws, and what stays the same object so the
// memoized rows draw again only where the diff names them.
import test from 'node:test'
import assert from 'node:assert/strict'
import { describe as describeFilm } from '../film.ts'
import { previewClickable, previewCommands, previewMarkers, previewOnlyItems, previewPictureItems, previewTimeline, sequenceMarks } from './previewViews.ts'
import { previewProjectRows, previewProjectSelection } from '../panels/projectPreview.ts'
import { createDrawers, describeDiff, previewNames, stripListing, stripShows } from './preview.ts'

const T = 254_016_000_000
const SEQ = 50

/** A FilmInfo from inspect()-shaped tracks: `video` and `audio` are lists of `[trackId, [[clipId, startSeconds, durationSeconds, item?]]]`. */
function film({ video = [], audio = [], selection = [], markers = [], sequence = SEQ, duration = 0, items = [] } = {}) {
  const track = ([id, clips]) => ({ id, name: `T${id}`, items: clips.map(([clip, start, length, item = 8]) => ({ clip, item, name: `clip ${clip}`, start: start * T, duration: length * T, sourceIn: 0, sourceOut: length * T, speed: 1 })) })
  return describeFilm({
    width: 1920,
    height: 1080,
    canUndo: true,
    canRedo: false,
    inspected: {
      ticksPerSecond: T,
      playhead: 0,
      project: { name: 'P', activeSequence: sequence, root: { id: 1, name: 'root', children: [{ item: 8, name: 'bars', type: 'Movie', duration: 60 * T }, ...items] } },
      sequence: {
        name: 'Seq',
        duration: duration * T,
        video: video.map(track),
        audio: audio.map(track),
        selection,
        markers: markers.map(([id, start, name = '', color = 'Green']) => ({ id, start: start * T, duration: 0, kind: 'Comment', name, comment: '', color })),
      },
    },
  })
}

const part = (added = [], removed = [], changed = []) => ({ added, removed, changed })
const clipsOf = (shown) => new Map(shown.tracks.flatMap((track) => track.clips.map((clip) => [clip.id, clip])))

test('the diff marks only the shown sequence: a clip Nest moves away is removed here and added elsewhere', () => {
  const diff = {
    clips: part([{ id: 7, sequence: 99, track: 1 }], [{ id: 7, sequence: SEQ, track: 1 }, { id: 9, sequence: SEQ, track: 1 }], [{ id: 3, sequence: SEQ, track: 1, fields: ['start'] }, { id: 3, sequence: 99, track: 1, fields: ['name'] }]),
    tracks: part([{ id: 4, sequence: SEQ }, { id: 5, sequence: 99 }]),
    markers: part([{ id: 2, owner: SEQ, ownerKind: 'sequence', sequence: SEQ }, { id: 6, owner: 3, ownerKind: 'clip', sequence: SEQ }, { id: 11, owner: 8, ownerKind: 'item' }]),
  }
  const marks = sequenceMarks(diff, SEQ)
  assert.equal(marks.clips.get(7)?.mark, 'removed', 'moved out of the shown sequence')
  assert.equal(marks.clips.get(9)?.mark, 'removed')
  assert.deepEqual(marks.clips.get(3), { mark: 'changed', fields: ['start'] })
  assert.equal(marks.tracks.get(4), 'added')
  assert.equal(marks.tracks.has(5), false, "another sequence's track")
  assert.deepEqual([...marks.markers], [[2, 'added']], "only the shown sequence's own markers")
  const other = sequenceMarks(diff, 99)
  assert.equal(other.clips.get(7)?.mark, 'added', 'and added where it went')
  assert.deepEqual(sequenceMarks(null, SEQ).clips.size, 0)
})

test('the Timeline lays out the preview: added clips and tracks marked, removed ones ghosted, changed ones at their new place with a ghost of the old', () => {
  const doc = film({ video: [[1, [[10, 0, 4], [11, 4, 2], [12, 8, 2]]]], audio: [[3, [[20, 0, 4]]], [6, []]], selection: [10] })
  // Speed 50% with ripple on 10: 10 doubles, 11 shifts, 12 is removed, 13 is new, a new audio track 4, track 6 deleted.
  const shown = film({ video: [[1, [[10, 0, 8], [11, 8, 2], [13, 12, 1]]]], audio: [[3, [[20, 0, 4]]], [4, []]], selection: [10, 11] })
  const diff = {
    clips: part([{ id: 13, sequence: SEQ, track: 1 }], [{ id: 12, sequence: SEQ, track: 1 }], [{ id: 10, sequence: SEQ, track: 1, fields: ['duration', 'speed'] }, { id: 11, sequence: SEQ, track: 1, fields: ['start'] }]),
    tracks: part([{ id: 4, sequence: SEQ }], [{ id: 6, sequence: SEQ }]),
  }
  const view = previewTimeline(doc, shown, diff, ['timeline'])
  const clips = clipsOf(view.film)
  assert.equal(clips.get(10).duration, 8, "the preview's place")
  assert.equal(view.clips.get(10), 'changed')
  assert.equal(view.clips.get(11), 'changed')
  assert.equal(view.clips.get(13), 'added')
  assert.equal(view.clips.has(20), false)
  assert.equal(clips.get(20), doc.tracks.find((track) => track.id === 3).clips[0], 'an unchanged clip is the document\'s own object: its row does not draw again')
  assert.equal(view.film.tracks.find((track) => track.id === 3), doc.tracks.find((track) => track.id === 3), 'so is an unchanged track')
  assert.deepEqual(view.film.tracks.map((track) => track.id), [1, 3, 6, 4], 'the deleted track stays where it was: right after the track it followed')
  assert.equal(view.tracks.get(4), 'added')
  assert.equal(view.tracks.get(6), 'removed')
  assert.deepEqual(view.film.tracks.find((track) => track.id === 6).clips, [], "a deleted track's clips are drawn as ghosts")
  const ghosts = view.ghosts.get(1).map((ghost) => [ghost.kind, ghost.clip.id, ghost.clip.start, ghost.clip.duration])
  assert.deepEqual(ghosts.sort(), [['removed', 12, 8, 2], ['was', 10, 0, 4], ['was', 11, 4, 2]].sort(), 'the removed clip, and the old places of the moved ones')
  assert.deepEqual(view.film.selection, [10], 'the real selection, not the preview\'s')
  assert.equal(clips.get(11).selected, false, 'a clip the preview selects is not drawn selected')
  assert.equal(view.selected, null, 'no selection highlight without the selection kind')
  assert.equal(view.film.canUndo, true)
})

test('a field that is not a place marks the clip changed without a ghost of its old place', () => {
  const doc = film({ video: [[1, [[10, 0, 4]]]] })
  const shown = film({ video: [[1, [[10, 0, 4]]]] })
  const view = previewTimeline(doc, shown, { clips: part([], [], [{ id: 10, sequence: SEQ, track: 1, fields: ['effects'] }]) }, ['timeline'])
  assert.equal(view.clips.get(10), 'changed')
  assert.equal(view.ghosts.size, 0)
})

test('a preview that opens another sequence (New Sequence) lays it out with everything added and nothing of the document ghosted', () => {
  const doc = film({ video: [[1, [[10, 0, 4]]]] })
  const shown = film({ sequence: 77, video: [[1, []], [2, []]], audio: [[3, []]] })
  const diff = { sequences: part([{ id: 77 }]), tracks: part([{ id: 1, sequence: 77 }, { id: 2, sequence: 77 }, { id: 3, sequence: 77 }]) }
  const view = previewTimeline(doc, shown, diff, ['timeline'])
  assert.equal(view.sequence, 77)
  assert.deepEqual([...view.tracks.values()], ['added', 'added', 'added'])
  assert.equal(view.ghosts.size, 0, "the document's clips belong to another sequence")
})

test('without the timeline kind the Timeline keeps the document and draws only the markers and the selection asked for', () => {
  const doc = film({ video: [[1, [[10, 0, 4], [11, 4, 2]]]], markers: [[1, 2, 'a'], [2, 5, 'b']], selection: [10] })
  const shown = film({ video: [[1, [[10, 0, 4], [11, 4, 2]]]], markers: [[1, 3, 'a'], [3, 6, 'new']], selection: [11] })
  const diff = {
    markers: part([{ id: 3, owner: SEQ, ownerKind: 'sequence', sequence: SEQ }], [{ id: 2, owner: SEQ, ownerKind: 'sequence', sequence: SEQ }], [{ id: 1, owner: SEQ, ownerKind: 'sequence', sequence: SEQ, fields: ['start'] }]),
    selection: part([{ id: 11 }], [{ id: 10 }]),
  }
  const view = previewTimeline(doc, shown, diff, ['markers', 'selection'])
  assert.equal(view.film.tracks, doc.tracks, "the document's tracks, untouched")
  assert.deepEqual(view.film.markers.map((marker) => [marker.id, marker.start]), [[1, 3], [2, 5], [3, 6]])
  assert.deepEqual([...view.markers].sort(), [[1, 'changed'], [2, 'removed'], [3, 'added']])
  assert.deepEqual([...view.selected], [11], "the preview's selection is highlighted")
  assert.deepEqual(view.film.selection, [10], 'and the real selection is unchanged')
  assert.equal(clipsOf(view.film).get(10).selected, true)
  assert.equal(clipsOf(view.film).get(11).selected, false)
})

test("the Markers panel's list: unchanged markers keep their objects, removed ones stay where they were", () => {
  const doc = film({ markers: [[1, 2], [2, 5], [4, 9]] }).markers
  const shown = film({ markers: [[1, 2], [3, 6], [4, 9, 'renamed']] }).markers
  const diff = { markers: part([{ id: 3, owner: SEQ, ownerKind: 'sequence', sequence: SEQ }], [{ id: 2, owner: SEQ, ownerKind: 'sequence', sequence: SEQ }], [{ id: 4, owner: SEQ, ownerKind: 'sequence', sequence: SEQ, fields: ['name'] }]) }
  const list = previewMarkers(doc, shown, diff, SEQ)
  assert.deepEqual(list.markers.map((marker) => marker.id), [1, 2, 3, 4])
  assert.equal(list.markers[0], doc[0], 'unchanged: the same object')
  assert.equal(list.markers[3].name, 'renamed')
  assert.deepEqual([...list.marks].sort(), [[2, 'removed'], [3, 'added'], [4, 'changed']])
})

test('with 202 clips, a preview that changes one clip and shifts three draws again only those four (and the ghosts)', () => {
  const many = (shift) => Array.from({ length: 101 }, (_, index) => [100 + index, index * 2 + (index > 50 && index <= 53 ? shift : 0), 2])
  const doc = film({ video: [[1, many(0)], [2, many(0).map(([id, start, length]) => [id + 1000, start, length])]] })
  const shown = film({ video: [[1, many(0.5).map(([id, start, length]) => [id, start, id === 150 ? 2.5 : length])], [2, many(0).map(([id, start, length]) => [id + 1000, start, length])]] })
  const changed = [150, 151, 152, 153].map((id) => ({ id, sequence: SEQ, track: 1, fields: id === 150 ? ['duration'] : ['start'] }))
  const view = previewTimeline(doc, shown, { clips: part([], [], changed) }, ['timeline'])
  const before = clipsOf(doc)
  const after = clipsOf(view.film)
  const redrawn = [...after].filter(([id, clip]) => before.get(id) !== clip).map(([id]) => id)
  assert.equal(after.size, 202)
  assert.deepEqual(redrawn.sort(), [150, 151, 152, 153])
  assert.equal(view.film.tracks.find((track) => track.id === 2), doc.tracks.find((track) => track.id === 2), 'the untouched track is the same object')
  // The next preview (a draft dragged further) keeps the ghosts of the old places it shares.
  const next = previewTimeline(doc, film({ video: [[1, many(0.75)], [2, many(0).map(([id, start, length]) => [id + 1000, start, length])]] }), { clips: part([], [], changed) }, ['timeline'])
  assert.equal(next.ghosts.get(1).length, 3, '150 keeps its place in this one')
  assert.ok(next.ghosts.get(1).every((ghost) => view.ghosts.get(1).includes(ghost)), 'the same ghost objects')
})

test('items whose picture comes from the preview: added items and sequences, and items whose media, colour, or content changed', () => {
  const diff = {
    items: part([{ id: 30 }], [{ id: 31 }], [{ id: 32, fields: ['name'] }, { id: 33, fields: ['media'] }, { id: 34, fields: ['contents', 'duration'] }]),
    sequences: part([{ id: 35 }]),
  }
  assert.deepEqual([...previewPictureItems(diff)].sort(), [30, 33, 34, 35])
  assert.equal(previewPictureItems(null).size, 0)
})

test('while a preview is open a press on the tracks only selects clips the document has', () => {
  const doc = new Set([10, 11])
  assert.deepEqual(previewCommands([{ id: 'timeline.select', params: { clips: [11] } }], doc), [{ id: 'timeline.select', params: { clips: [11] } }])
  assert.deepEqual(previewCommands([{ id: 'timeline.select', params: { clips: [] } }], doc), [{ id: 'timeline.select', params: { clips: [] } }], 'a press on nothing deselects')
  assert.deepEqual(previewCommands([{ id: 'timeline.select', params: { clips: [13] } }], doc), [], 'a clip only the preview has')
  assert.deepEqual(previewCommands([{ id: 'timeline.razor', params: { time: 3 } }, { id: 'trim.selectEditPoint', params: { clip: 10 } }, { id: 'timeline.move', params: {} }], doc), [], 'no edit')
})

const row = (item, name, cells = {}, extra = {}) => ({ item, name, depth: 0, cells: { 'Media Duration': '00:00:04:00', ...cells }, kind: 'media', hasVideo: true, ...extra })

test("the Project panel's rows: added rows outlined, removed rows kept where they were, changed cells named", () => {
  const doc = [{ bin: 2, name: 'Selects', depth: 0 }, row(8, 'bars'), row(9, 'tone'), row(10, 'matte')]
  const shown = [{ bin: 2, name: 'Selects', depth: 0 }, row(8, 'bars'), row(10, 'matte', { 'Media Duration': '00:00:08:00' }), row(40, 'Color Matte')]
  const diff = { items: part([{ id: 40 }], [{ id: 9 }], [{ id: 10, fields: ['duration'] }]) }
  const { rows, marks } = previewProjectRows(doc, shown, diff)
  assert.deepEqual(rows.map((each) => each.bin ?? each.item), [2, 8, 9, 10, 40])
  assert.equal(rows[1], doc[1], 'an unchanged row is the same object')
  assert.equal(rows[0], doc[0])
  assert.deepEqual(marks.get('i40'), { mark: 'added', cells: '' })
  assert.deepEqual(marks.get('i9'), { mark: 'removed', cells: '' })
  assert.deepEqual(marks.get('i10'), { mark: 'changed', cells: 'Media Duration' })
  assert.equal(marks.has('i8'), false)
  assert.equal(rows[2], doc[2], 'the removed row draws from the document')
})

test('a row the diff names as changed with nothing shown changing is marked, without cells', () => {
  const doc = [row(8, 'bars')]
  const { rows, marks } = previewProjectRows(doc, [row(8, 'bars')], { items: part([], [], [{ id: 8, fields: ['metadata'] }]) })
  assert.equal(rows[0], doc[0])
  assert.deepEqual(marks.get('i8'), { mark: 'changed', cells: '' })
})

test('with 200 items, a preview that adds one item draws one row again', () => {
  const doc = Array.from({ length: 200 }, (_, index) => row(100 + index, `item ${index}`))
  const shown = [...doc.slice(0, 120).map((each) => ({ ...each, cells: { ...each.cells } })), row(999, 'new'), ...doc.slice(120).map((each) => ({ ...each, cells: { ...each.cells } }))]
  const { rows, marks } = previewProjectRows(doc, shown, { items: part([{ id: 999 }]) })
  assert.equal(rows.length, 201)
  const redrawn = rows.filter((each) => !doc.includes(each))
  assert.deepEqual(redrawn.map((each) => each.item), [999])
  assert.deepEqual([...marks.keys()], ['i999'])
})

test('a row the preview names by name only (a rename) marks the Name cell', () => {
  const { marks } = previewProjectRows([row(8, 'bars')], [row(8, 'Bars renamed')], { items: part([], [], [{ id: 8, fields: ['name'] }]) })
  assert.deepEqual(marks.get('i8'), { mark: 'changed', cells: 'Name' })
})

const t = (key, values = {}) => {
  const text = { 'preview.on': '{what} on {track}', 'preview.noun.markers': 'marker', 'preview.noun.clips': 'clip', 'preview.noun.captions': 'caption', 'preview.noun.tracks': 'track', 'preview.adds': 'Adds {what}', 'preview.selects': 'Selects {what}', 'preview.noun.items': 'item', 'preview.project': 'Project: {fields}', 'preview.count.clips': '{count} clips' }[key] ?? key
  return text.replace(/\{(\w+)\}/g, (_, name) => String(values[name]))
}
const names = previewNames(null, null)

/** The drawers of a Timeline showing `sequence` and a Project panel drawing `items` (keys `i<id>`), as the panels register them. */
function panels({ sequence = SEQ, items = null, timeline = true } = {}) {
  const drawers = createDrawers()
  if (timeline) {
    drawers.add('timeline', () => (part, entry) => (part === 'sequences' ? entry.id === sequence : entry.sequence === sequence))
    drawers.add('markers', () => (part, entry) => entry.ownerKind === 'sequence' && entry.owner === sequence)
    drawers.add('selection:timeline')
  }
  if (items) {
    drawers.add('project', () => (part, entry) => items.has(`${part === 'bins' ? 'b' : 'i'}${entry.id}`))
    drawers.add('selection:project', () => (_, entry) => items.has(`i${entry.id}`))
  }
  return drawers
}

test("the strip lists what the panels on screen do not draw: another sequence's clips, captions, and the project's fields", () => {
  const diff = {
    project: { changed: ['settings'] },
    clips: part([{ id: 3, sequence: SEQ, track: 1 }, { id: 4, sequence: 99, track: 1 }]),
    captions: part([{ id: 5, sequence: SEQ, track: 9, name: 'Hello' }]),
  }
  const listed = stripListing(['timeline', 'project'], panels({ items: new Set() }))
  assert.deepEqual(describeDiff(diff, names, t, listed), ['Project: settings', 'Adds clip #4 on #1', 'Adds caption Hello'])
  assert.deepEqual(describeDiff(diff, names, t, stripListing(['picture'], panels())), [], 'a kind the dialog does not preview is never listed')
})

test("the strip lists clip and item markers while the rulers draw the sequence's", () => {
  const diff = { markers: part([{ id: 1, owner: SEQ, ownerKind: 'sequence', sequence: SEQ, name: 'Seq cue' }, { id: 2, owner: 3, ownerKind: 'clip', sequence: SEQ, name: 'Clip cue' }, { id: 4, owner: 8, ownerKind: 'item', name: 'Item cue' }]) }
  assert.deepEqual(describeDiff(diff, names, t, stripListing(['markers'], panels())), ['Adds marker Clip cue, marker Item cue'])
  assert.deepEqual(describeDiff(diff, names, t, stripListing(['markers'], panels({ timeline: false }))), ['Adds marker Seq cue, marker Clip cue, marker Item cue'])
})

test("the strip lists the Project panel's entries it does not draw (outside the bin shown, in a folded bin), and the selections apart", () => {
  const diff = { items: part([{ id: 30 }, { id: 31 }]), selection: part([{ id: 3 }]), projectSelection: part([{ id: 8 }, { id: 31 }]) }
  const drawers = panels({ items: new Set(['i30', 'i8']), timeline: false })
  const listed = stripListing(['project', 'selection'], drawers)
  assert.deepEqual(describeDiff(diff, names, t, listed), ['Adds item #31', 'Selects 1 clip', 'Selects 1 item'])
})

test('a drawer that leaves the screen, or changes what it covers, lists its entries again', () => {
  let sequence = SEQ
  const drawers = createDrawers()
  let told = 0
  drawers.subscribe(() => (told += 1))
  const stop = drawers.add('timeline', () => (_, entry) => entry.sequence === sequence)
  const diff = { clips: part([{ id: 3, sequence: SEQ, track: 1 }]) }
  assert.deepEqual(describeDiff(diff, names, t, stripListing(['timeline'], drawers)), [])
  sequence = 99
  drawers.changed()
  assert.deepEqual(describeDiff(diff, names, t, stripListing(['timeline'], drawers)), ['Adds clip #3 on #1'])
  stop()
  assert.equal(drawers.drawn('timeline'), false)
  assert.ok(told >= 3)
})

test('the strip shows only while it has something no panel on screen draws', () => {
  const diff = { clips: part([{ id: 3, sequence: SEQ, track: 1, fields: ['speed'] }]) }
  const all = panels()
  all.add('picture')
  // Speed / Duration with the Program monitor and the Timeline on screen: nothing left for the strip.
  assert.equal(stripShows(['picture', 'timeline'], diff, all, null), false)
  assert.equal(stripShows(['picture', 'timeline'], diff, panels(), null), true, 'the small frame')
  const picture = createDrawers()
  picture.add('picture')
  assert.equal(stripShows(['picture', 'timeline'], diff, picture, null), true, 'the timeline as text')
  assert.equal(stripShows(['markers'], { markers: part([{ id: 2, owner: 3, ownerKind: 'clip', sequence: SEQ }]) }, all, null), true, "a clip's marker, which no panel draws")
  assert.equal(stripShows(['timeline'], null, createDrawers(), null), true, 'no panel: the strip says what changes, or that nothing does')
  assert.equal(stripShows(['sound'], null, all, null), true, 'Play')
  assert.equal(stripShows(['summary'], null, all, null), true)
  assert.equal(stripShows(['timeline'], diff, all, 0.5), true, "a job's progress")
})

test('a clip draws no waveform only when its item is not in the document (a nest, a new matte), not for an item whose picture changed', () => {
  const doc = film({ items: [{ item: 9, name: 'tone', type: 'Audio', duration: 4 * T }] })
  const shown = film({ items: [{ item: 9, name: 'tone', type: 'Audio', duration: 4 * T }, { item: 40, name: 'Nest A', type: 'Sequence', duration: 4 * T }] })
  assert.deepEqual([...previewOnlyItems(doc, shown)], [40])
  assert.equal(previewOnlyItems(doc, doc).size, 0)
})

test("a press under a preview selects only clips of the document's own sequence: a Duplicate Sequence preview shares their ids", () => {
  const doc = film({ video: [[1, [[10, 0, 4]]]] })
  const same = previewTimeline(doc, film({ video: [[1, [[10, 0, 4]]]] }), null, ['timeline'])
  assert.deepEqual([...previewClickable(doc, same)], [10])
  const duplicate = previewTimeline(doc, film({ sequence: 77, video: [[1, [[10, 0, 4]]]] }), { sequences: part([{ id: 77 }]) }, ['timeline'])
  assert.equal(previewClickable(doc, duplicate).size, 0, 'the clips shown are the copy\'s')
  assert.deepEqual([...previewClickable(doc, null)], [10], 'no timeline drawn: the document\'s clips')
})

test("the Project panel's preview selection: the document's, less what the preview deselects, with what it selects", () => {
  assert.deepEqual([...previewProjectSelection([8, 9], { projectSelection: part([{ id: 12 }], [{ id: 9 }]) })].sort(), [12, 8].sort())
  assert.deepEqual([...previewProjectSelection([8], null)], [8])
})

// ---- Task 12 review: the strip names what it lists

const stripText = (key, values = {}) => {
  const text = { 'preview.on': '{what} on {track}', 'preview.noun.tracks': 'track', 'preview.noun.clips': 'clip', 'preview.noun.bins': 'bin', 'preview.noun.sequences': 'sequence', 'preview.adds': 'Adds {what}', 'preview.changesFields': 'Changes {what}: {fields}' }[key] ?? key
  return text.replace(/\{(\w+)\}/g, (_, name) => String(values[name]))
}

test("the strip names another sequence's tracks and clips from that sequence (\"Nest A: Video 1\"), and the root bin", () => {
  const document = { project: { activeSequence: 1, root: { id: 0, name: '', children: [{ item: 1, name: 'Sequence 01' }, { id: 4, name: 'Selects', children: [] }] } }, sequence: { id: 1, video: [{ id: 2, name: 'Video 1', items: [] }] } }
  const previewed = { project: { activeSequence: 1, root: { id: 0, name: '', children: [{ item: 1, name: 'Sequence 01' }, { item: 9, name: 'Nest A' }] } }, sequence: { id: 1, video: [{ id: 2, name: 'Video 1', items: [{ clip: 12, name: 'Nest A' }] }] } }
  const nest = { id: 9, name: 'Nest A', video: [{ id: 50, name: 'Video 1', items: [{ clip: 10, name: 'bars.mp4' }] }], audio: [{ id: 51, name: 'Audio 1', items: [] }] }
  const diff = {
    tracks: { added: [{ id: 50, sequence: 9 }, { id: 51, sequence: 9 }], removed: [], changed: [] },
    clips: { added: [{ id: 10, sequence: 9, track: 50 }, { id: 12, sequence: 1, track: 2 }], removed: [], changed: [] },
    bins: { added: [], removed: [], changed: [{ id: 0, fields: ['items'] }, { id: 4, fields: ['name'] }] },
  }
  const names = previewNames(document, previewed, { sequences: [nest], root: 'Root' })
  assert.deepEqual(describeDiff(diff, names, stripText), [
    'Adds track Nest A: Video 1, track Nest A: Audio 1',
    'Adds clip bars.mp4 on Nest A: Video 1, clip Nest A on Video 1',
    'Changes bin Root: items',
    'Changes bin Selects: name',
  ])
  // Without the other sequence's inspect, a track it alone has is still named by id.
  assert.equal(previewNames(document, previewed).track(50, 9), '#50')
  assert.equal(previewNames(document, previewed).bin(0), '#0', 'no root name given')
})

test("the Project panel claims a bin's items change when it draws the rows added to and removed from it", async () => {
  const { projectCovers } = await import('../panels/projectPreview.ts')
  const diff = {
    items: { added: [{ id: 9 }], removed: [{ id: 7 }], changed: [] },
    sequences: { added: [{ id: 9 }], removed: [], changed: [] },
    bins: { added: [], removed: [], changed: [{ id: 0, fields: ['items'] }, { id: 4, fields: ['items', 'name'] }] },
  }
  const covers = projectCovers(new Set(['i9', 'i7', 'i1']), diff)
  assert.equal(covers('bins', { id: 0, fields: ['items'] }), true, 'every row it adds and removes is drawn')
  assert.equal(covers('bins', { id: 4, fields: ['items', 'name'] }), false, 'its own row (the name) is not drawn')
  assert.equal(covers('items', { id: 9 }), true)
  assert.equal(projectCovers(new Set(['i9']), diff)('bins', { id: 0, fields: ['items'] }), false, 'a removed row not drawn')
  assert.equal(projectCovers(new Set(['b4']), diff)('bins', { id: 4, fields: ['items', 'name'] }), true, 'its row drawn')
  // A bin whose items only moved (items changed bin) is claimed when those rows are drawn.
  const moved = { items: { added: [], removed: [], changed: [{ id: 3, fields: ['bin'] }] }, bins: { added: [], removed: [], changed: [{ id: 0, fields: ['items'] }] } }
  assert.equal(projectCovers(new Set(['i3']), moved)('bins', { id: 0, fields: ['items'] }), true)
  assert.equal(projectCovers(new Set([]), moved)('bins', { id: 0, fields: ['items'] }), false)
})
