import { useMemo, useSyncExternalStore } from 'react'
import { catalogTabs, type FrameTab, type Phrases } from '@kition/kit-editor'
import { FILM_MENUS, menuChecked, withLabelNames, withLiveShortcuts, withWorkspaces, type MenuState } from './catalog'
import { isHiddenOnWeb } from './hidden'
import type { FilmLabels } from '../session/useFilmSession'
import type { ShortcutRow } from '../session/keys'
import type { TimelineViewStore } from '../timeline/view'

/** Menus kept in a read-only document. */
const VIEW_MENUS = ['View', 'Window', 'Help']

/** The rows each menu tab shows in Single line's row (Premiere's most-used), by menu; `kit:` rows keep their prefix. */
const FILM_PRIMARY: Record<string, readonly string[]> = {
  File: ['kit:file.import', 'file.newSequence', 'kit:file.exportMedia', 'file.newBin'],
  Edit: ['edit.undo', 'edit.redo', 'edit.cut', 'edit.copy', 'edit.paste', 'edit.rippleDelete', 'edit.clear', 'edit.duplicate'],
  Clip: ['source.insert', 'source.overwrite'],
  Sequence: ['sequence.addEdit', 'sequence.applyVideoTransition', 'sequence.applyAudioTransition', 'sequence.lift', 'sequence.extract', 'sequence.snap'],
  Markers: ['markers.add', 'markers.markIn', 'markers.markOut', 'markers.markClip', 'markers.goNext', 'markers.goPrev'],
  'Graphics and Titles': ['graphics.newText', 'graphics.newRectangle', 'graphics.newEllipse'],
}

/**
 * Film's menus as the editor frame's tabs, as upstream's `menus.rs` `menu_bar`: upstream's nine
 * menus without the rows a browser hides, every row run through `invoke` (`onInvoke`, with no
 * values; a row whose command needs values opens kit-editor's parameters dialog). Rows show the
 * engine's live bindings, Edit > Label rows the label names, Window > Workspaces every workspace
 * in `workspaces` (the built-in ones and the person's own, `workspaces::menu`), and the workspace
 * in use and the focused monitor's view options are checked. Keep `onInvoke` stable.
 */
export function useFilmMenuTabs({ labels, shortcuts, workspaces, state, timelineView, reserved, onInvoke, phrase }: { labels: FilmLabels | null; shortcuts: readonly ShortcutRow[] | null; workspaces: readonly string[]; state: MenuState; timelineView: TimelineViewStore; reserved: (keys: string) => boolean; onInvoke: (command: string) => void; phrase: Phrases }): FrameTab[] {
  const catalog = useMemo(() => withLiveShortcuts(withLabelNames(withWorkspaces(FILM_MENUS, workspaces), labels), shortcuts, reserved), [labels, shortcuts, workspaces, reserved])
  const { workspace, views, focused } = state
  // Only Dynamic Audio Waveforms of the Timeline's view: its zoom frames do not build the menus again.
  const dynamicWaveforms = useSyncExternalStore(timelineView.subscribe, () => timelineView.get().dynamicWaveforms)
  const checked = useMemo(() => menuChecked({ workspace, views, focused, dynamicWaveforms }), [workspace, views, focused, dynamicWaveforms])
  return useMemo(() => catalogTabs(catalog, { phrase, hidden: isHiddenOnWeb, onKitCommand: (command) => onInvoke(command.slice('kit:'.length)), onCommand: onInvoke, checked, view: VIEW_MENUS, primary: FILM_PRIMARY }), [catalog, checked, onInvoke, phrase])
}
