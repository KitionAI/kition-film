/**
 * Upstream `panels/timeline.rs` `CLIP_MENU`: the clip context menu, groups (separated by rules) of
 * (label, command). Rows whose label ends in "…" open their dialog, as the same row of the Clip
 * menu does. Label is a submenu of the label names; Multi-Camera is a submenu of the selected
 * nests' cameras (wave 3).
 */
export const CLIP_MENU: ReadonlyArray<ReadonlyArray<readonly [label: string, command: string]>> = [
  [
    ['Cut', 'edit.cut'],
    ['Copy', 'edit.copy'],
    ['Paste Attributes…', 'edit.pasteAttributes'],
    ['Remove Attributes…', 'edit.removeAttributes'],
    ['Clear', 'edit.clear'],
    ['Ripple Delete', 'edit.rippleDelete'],
  ],
  [
    ['Edit Original', 'edit.editOriginal'],
    ['Replace With Clip From Source Monitor', 'clip.replaceFromSource'],
  ],
  [
    ['Enable', 'clip.enable'],
    ['Link', 'clip.link'],
    ['Group', 'clip.group'],
    ['Ungroup', 'clip.ungroup'],
    ['Synchronize…', 'clip.synchronize'],
    ['Merge Clips…', 'clip.mergeClips'],
    ['Nest…', 'clip.nest'],
    ['Make Subsequence', 'sequence.makeSubsequence'],
    ['Reveal Nested Sequence', 'sequence.revealNested'],
    ['Multi-Camera', 'clip.multicam'],
  ],
  [['Label', 'edit.label']],
  [['Speed/Duration…', 'clip.speedDuration']],
  [
    ['Frame Hold Options…', 'clip.frameHoldOptions'],
    ['Add Frame Hold', 'clip.frameHold'],
    ['Insert Frame Hold Segment', 'clip.insertFrameHoldSegment'],
    ['Field Options…', 'clip.fieldOptions'],
    ['Scale to Frame Size', 'clip.scaleToFrameSize'],
    ['Fit to frame', 'clip.fitToFrame'],
    ['Fill frame', 'clip.fillFrame'],
  ],
  [
    ['Reveal in Project', 'clip.revealInProject'],
    ['Join Through Edits', 'sequence.joinThroughEdits'],
  ],
]

/** A row opens its dialog (upstream's "…" rows, through `menus::invoke`). */
export const opensDialog = (label: string) => label.endsWith('…')

/** What the menu reads of the selected clips. */
export type MenuClip = { enabled: boolean; link: number | null }

/**
 * The rows' states: Enable is checked when every selected clip is enabled, Link reads Unlink when
 * one is linked, and nothing runs with no clip selected.
 */
export function clipMenuState(picked: readonly MenuClip[]) {
  return {
    any: picked.length > 0,
    allEnabled: picked.length > 0 && picked.every((clip) => clip.enabled),
    linked: picked.some((clip) => clip.link != null),
  }
}
