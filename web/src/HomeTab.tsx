import { type IconComponent } from '@kition/tessera/icons/react'
import { ArrowLeftToLineIcon as ArrowLeftToLine, ArrowRightToLineIcon as ArrowRightToLine, AudioLinesIcon as AudioLines, BetweenHorizontalStartIcon as BetweenHorizontalStart, BlendIcon as Blend, CircleIcon as Circle, ClapperboardIcon as Clapperboard, ClipboardPasteIcon as ClipboardPaste, CopyIcon as Copy, DeleteIcon as Delete, DownloadIcon as Download, FileInputIcon as FileInput, MagnetIcon as Magnet, MapPinIcon as MapPin, ReplaceIcon as Replace, ScissorsIcon as Scissors, SquareSplitHorizontalIcon as SquareSplitHorizontal, SquareIcon as Square, TypeIcon as Type } from '@kition/tessera/icons/react'
import { CommandButton, RibbonButton, RibbonGroup, RibbonStack, useKitEditor, useUi } from '@kition/sdk/editor'
import { FILM_TOOLS } from './tools/catalog'
import { KIT_TAKEOVERS } from './menus/kitMenus'

/** One of upstream's tools, chosen as the Tools panel chooses it (the host may hide, disable, or deny it). */
function HomeTool({ id, tool, onTool, primary }: { id: string; tool: string; onTool: (id: string) => unknown; primary?: boolean }) {
  const { phrase } = useKitEditor()
  const ui = useUi()
  const entry = FILM_TOOLS.find((item) => item.id === id)
  const state = ui.state(`tool:${id}`)
  if (!entry || state.hidden) return null
  return (
    <RibbonButton
      icon={entry.icon}
      label={phrase(entry.label)}
      size="large"
      pressed={tool === id}
      disabled={state.disabled}
      onClick={() => {
        if (!state.denied) onTool(id)
      }}
      data-testid={`film-home-tool-${id}`}
      data-kit-ui-id={`tool:${id}`}
      primary={primary}
    />
  )
}

/**
 * A command Kition serves another way (File ▸ Import's picker, Export ▸ Media's MP4 export): it
 * always runs through `invoke`, even though the engine's command wants values, and it is the
 * same element as its menu row (`control:<command>`), so a host that hides the row hides it too.
 */
function TakeoverButton({ command, label, icon, onInvoke, size, primary }: { command: keyof typeof KIT_TAKEOVERS & string; label?: string; icon: IconComponent; onInvoke: (command: string) => void; size?: 'large' | 'small'; primary?: boolean }) {
  const { phrase, byId, enabled } = useKitEditor()
  const ui = useUi()
  const id = `control:${KIT_TAKEOVERS[command].slice('kit:'.length)}`
  const state = ui.state(id)
  if (state.hidden) return null
  return (
    <RibbonButton
      icon={icon}
      label={label ?? phrase(byId.get(command)?.title ?? command)}
      size={size}
      disabled={state.disabled || !enabled(command)}
      onClick={() => {
        if (!state.denied) onInvoke(command)
      }}
      data-testid={`film-cmd-${command}`}
      data-kit-ui-id={id}
      primary={primary}
    />
  )
}

/**
 * Film's Home tab: the editing tasks done most, in every display mode (a drop-down panel in
 * Menus). Every command runs through Film's own `invoke`, as the menus' rows do (File ▸ Import's
 * picker, the status bar on failure); group names are upstream's menu names.
 */
export function HomeTab({ tool, onTool, onInvoke }: { tool: string; onTool: (id: string) => unknown; onInvoke: (command: string) => void }) {
  const { phrase: p, t } = useKitEditor()
  const big = (command: string, icon: IconComponent) => <CommandButton command={command} icon={icon} size="large" onRun={onInvoke} primary />
  const small = (command: string, icon: IconComponent, label?: string) => <CommandButton key={command} command={command} icon={icon} label={label} onRun={onInvoke} />
  return (
    <>
      <RibbonGroup label={p('File')} icon={FileInput}>
        <TakeoverButton command="file.import" icon={FileInput} onInvoke={onInvoke} size="large" primary />
        {/* Upstream's rows read "Sequence…" and "Media" under File ▸ New and File ▸ Export; on their own they need the verb. */}
        <RibbonStack>
          {small('file.newSequence', Clapperboard, t('home.newSequence'))}
          <TakeoverButton command="file.exportMedia" label={t('home.exportMedia')} icon={Download} onInvoke={onInvoke} />
        </RibbonStack>
      </RibbonGroup>

      <RibbonGroup label={p('Edit')} icon={Scissors}>
        <HomeTool id="Selection" tool={tool} onTool={onTool} />
        <HomeTool id="Razor" tool={tool} onTool={onTool} />
        {big('sequence.addEdit', SquareSplitHorizontal)}
        {big('edit.rippleDelete', Delete)}
        <RibbonStack>
          {small('edit.cut', Scissors)}
          {small('edit.copy', Copy)}
          {small('edit.paste', ClipboardPaste)}
        </RibbonStack>
      </RibbonGroup>

      <RibbonGroup label={p('Clip')} icon={BetweenHorizontalStart}>
        {big('source.insert', BetweenHorizontalStart)}
        {big('source.overwrite', Replace)}
      </RibbonGroup>

      <RibbonGroup label={p('Sequence')} icon={Clapperboard}>
        {big('sequence.applyVideoTransition', Blend)}
        {big('sequence.snap', Magnet)}
        <RibbonStack>
          {small('sequence.applyAudioTransition', AudioLines)}
          {small('sequence.lift', ArrowLeftToLine)}
          {small('sequence.extract', ArrowRightToLine)}
        </RibbonStack>
      </RibbonGroup>

      <RibbonGroup label={p('Markers')} icon={MapPin}>
        {big('markers.add', MapPin)}
        <RibbonStack>
          {small('markers.markIn', ArrowRightToLine)}
          {small('markers.markOut', ArrowLeftToLine)}
        </RibbonStack>
      </RibbonGroup>

      <RibbonGroup label={p('Graphics and Titles')} icon={Type}>
        {big('graphics.newText', Type)}
        <RibbonStack>
          {small('graphics.newRectangle', Square)}
          {small('graphics.newEllipse', Circle)}
        </RibbonStack>
      </RibbonGroup>
    </>
  )
}
