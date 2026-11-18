// While a dialog's preview is open the document is not editable (Task 10's review): upstream's
// dialogs are modal, and Film's preview dialogs are non-modal only so the playhead can be scrubbed
// and the document looked at.
import test from 'node:test'
import assert from 'node:assert/strict'
import { createPreviewGate, previewAllows } from './previewGate.ts'

test('a preview allows the playhead, transport, selection, view, and queries, and no edit', () => {
  for (const id of ['playhead.set', 'playhead.stepForward', 'playback.toggle', 'source.playback.play', 'source.setPlayhead', 'source.open', 'timeline.select', 'project.select', 'edit.selectAll', 'edit.deselectAll', 'trim.selectEditPoint', 'edit.find', 'markers.goNext', 'sequence.open', 'sequence.snap', 'view.zoomIn', 'project.view.set', 'markers.filterColors']) assert.equal(previewAllows(id, true), true, id)
  for (const id of ['edit.clear', 'edit.rippleDelete', 'edit.undo', 'edit.redo', 'timeline.move', 'timeline.razor', 'timeline.setTrack', 'markers.add', 'markers.markIn', 'project.setMarks', 'clip.rename', 'project.moveToBin', 'file.import', 'file.newBin', 'file.save', 'effects.setParam', 'sequence.close', 'sequence.moveTab', 'sequence.closeOthers', 'timeline.place']) assert.equal(previewAllows(id, true), false, id)
  assert.equal(previewAllows('clip.audioPeak', false), true, 'a query writes no journal entry')
})

test("the gate refuses an edit while a preview is open, except the open dialog's own commands", () => {
  let open = false
  let own = new Set()
  const gate = createPreviewGate({ open: () => open, own: () => own, journaled: () => true, message: 'Finish or cancel the dialog first' })
  assert.equal(gate.refusal('edit.clear'), null, 'no preview: everything runs')
  open = true
  assert.equal(gate.refusal('edit.clear'), 'Finish or cancel the dialog first')
  assert.equal(gate.refusal('playhead.set'), null)
  own = new Set(['edit.find', 'clip.speedDuration'])
  assert.equal(gate.refusal('clip.speedDuration'), null, "the dialog's OK (a dialog that keeps its preview open)")
})
