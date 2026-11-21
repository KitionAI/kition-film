import { useLayoutEffect, useMemo, useRef, useState } from 'react'
import { ToolRail, useKitEditor } from '@kition/sdk/editor'
import { FILM_TOOLS, groupsThatFit } from './catalog'

/** Upstream's long press that opens a group's flyout (`panels/tools.rs`: 0.35 s). */
const FLYOUT_PRESS_MS = 350

/**
 * The Tools panel (upstream `panels/tools.rs`): one column of upstream's 8 groups in the compact
 * `tools` frame. A group's button shows the active tool when it is in the group, else the group's
 * first (upstream draws `group[0]`, it does not remember), with a corner triangle when the group
 * has more; a click chooses that tool, and a right-click or a 350 ms press opens the group's flyout,
 * whose release chooses nothing. Tooltips read "Label (Key)". As upstream, only the groups that fit
 * the frame's height are drawn (`groupsThatFit`); the others are not in the page at all. Every
 * choice goes through `onChoose`, the editor's one policy check (a tool the host denies is never
 * chosen), as the keys do.
 */
export function ToolsPanel({ active, onChoose }: { active: string; onChoose: (tool: string) => boolean }) {
  const { phrase } = useKitEditor()
  const frame = useRef<HTMLDivElement>(null)
  const [groups, setGroups] = useState<number | null>(null)
  useLayoutEffect(() => {
    const node = frame.current
    if (!node) return undefined
    const measure = () => setGroups(groupsThatFit(node.getBoundingClientRect().height))
    measure()
    if (typeof ResizeObserver === 'undefined') return undefined
    const observer = new ResizeObserver(measure)
    observer.observe(node)
    return () => observer.disconnect()
  }, [])
  const tools = useMemo(
    () => (groups == null ? [] : FILM_TOOLS.filter((tool) => tool.group < groups).map((tool) => ({ id: tool.id, label: phrase(tool.label), icon: tool.icon, shortcut: tool.shortcut, group: tool.group }))),
    [groups, phrase],
  )
  return (
    <div ref={frame} className="film-tools" data-testid="film-tools" data-active={active} data-groups={groups ?? undefined}>
      <ToolRail tools={tools} active={active} onSelect={(tool) => void onChoose(tool)} columns={1} slotMemory={false} flyoutPressMs={FLYOUT_PRESS_MS} />
    </div>
  )
}
