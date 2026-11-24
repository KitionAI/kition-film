import { createContext, useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type KeyboardEvent, type MutableRefObject, type ReactNode, type RefObject } from 'react'
import { TesseraIcons } from '@kition/sdk/editor'
import {
  Button,
  FloatingPanels,
  MenuItem,
  MenuSeparator,
  IconButton,
  EditorFrame,
  KitEditorProvider,
  WorkspaceLayout,
  createKitStrings,
  editsDocument,
  isMac,
  toast,
  useKitEditorState,
  useFrameMode,
  useKitSession,
  useUi,
  useWorkspaces,
  workspaceTree,
  type FrameTab,
  type HostConnection,
  type KitCanvasHandle,
  type Phrases,
  type FloatingPanel,
  type RasterView,
  type WorkspaceNode,
} from '@kition/sdk/editor'
import { engineManifest } from './engine'
import { CATALOGS } from './strings'
import { withDeclaredLabels } from './i18n/phrases'
import { IMPORT_TYPES, MEDIA_TYPES, VIDEO_TYPES, TICKS_PER_SECOND, describe, projectItems, type FilmInfo } from './film'
import { jobStatus } from './session/jobPump'
import { FilmAudioPlayer } from './audio'
import { FaultBoundary } from './FaultBoundary'
import { exportMovie, type ExportProgress } from './movie'
import { SequenceRows, SequenceTabs, TimelinePanel } from './timeline/TimelinePanel'
import { createTimelineView, useTimelineView, type TimelineViewStore } from './timeline/view'
import { createTimelineMedia, type TimelineMedia } from './timeline/media'
import { isHiddenCommand } from './menus/hidden'
import { useFilmMenuTabs } from './menus/filmMenus'
import { HelpDialog, type HelpTopic } from './menus/AboutDialog'
import { DIALOGS, dialogRefusal, editorOpens, previewsInEngine, specProblems, type DialogContext, type DialogSpec } from './dialogs/registry'
import { documentReplaced, playbackRefresh } from './dialogs/preview'
import { DialogHost, type OpenDialog } from './dialogs/DialogHost'
import { createReadExtra } from './dialogs/extras'
import { PreviewContext, usePreviewController } from './dialogs/usePreview'
import { relativePath } from './menus/kitMenus'
import { relinkItem, relinkRefusal } from './dialogs/media'
import { DEFAULT_VIEWS, GUIDE_ROUTE, applyGuides, monitorOf, monitorViewCommand, servesMonitorView, setMonitorView, type MonitorId, type MonitorViews } from './monitors/monitorView'
import { addGuideDraft, createValueStore, deleteTemplates, saveTemplate, sameGeometry, type Guide, type GuideGeometry, type GuidePreview, type ValueStore } from './monitors/guideModel'
import { createGuideTemplates } from './monitors/guideTemplates'
import { GuideDialogs, type GuideDialogState } from './monitors/guideDialogs'
import { ProgramMonitor } from './monitors/ProgramMonitor'
import { createProxiesRead, useProxies, useSourceView, type ProxiesRead } from './monitors/useMonitorReads'
import { createInvoke, type InvokeOptions } from './session/invoke'
import { personMessage } from './session/errors'
import { closeGapTrack } from './timeline/closeGap'
import { createPreviewGate, type PreviewGate } from './session/previewGate'
import { applyEvents, type EngineEvent } from './session/events'
import { resolveKey } from './session/keys'
import { STATUS_MS, nextStatus, statusLeft, type StatusMessage } from './session/status'
import { useFilmSession, type FilmLabels, type FilmSessionState } from './session/useFilmSession'
import { createFilmViewState, type FilmViewStateKeeper } from './session/viewState'
import { usePlayback, type Playback } from './session/playback'
import { targetsSource } from './session/target'
import { createStatsStore, useStats, type StatsStore } from './stats'
import { SourceMonitor } from './monitors/SourceMonitor'
import { Placeholder } from './panels/Placeholder'
import { ProjectPanel, type ProjectThumbnails } from './panels/ProjectPanel'
import { EffectControls } from './panels/EffectControls'
import { EffectsPanel } from './panels/EffectsPanel'
import { localSelection } from './session/localSelection'
import { PropertiesPanel } from './panels/PropertiesPanel'
import { AudioMeters } from './panels/AudioMeters'
import { MarkersPanel } from './panels/MarkersPanel'
import { HistoryPanel } from './panels/HistoryPanel'
import { InfoPanel } from './panels/InfoPanel'
import { createMeterFeed, type MeterFeed } from './panels/meters'
import { ProjectMenu } from './panels/projectMenus'
import { FLOATING_BINS, binWindowFocus, binWindowOf, createProjectUi, findBin, shownBin, windowFocusFallback, type ProjectUi, type ProjectView } from './panels/projectModel'
import { shareTurnReads } from './panels/sharedRead'
import { giveKeysBack } from './workspace/editorFocus'
import { firstSizeReports, watchFloatingBoxes } from './workspace/floatingBoxes'
import { createProjectRoute, type ProjectRouteDeps } from './panels/projectRoute'
import { createThumbnails, frameCanvas, releaseCanvas } from './timeline/thumbnails'
import { FALLBACK_WORKSPACE, WEB_PANEL_IDS, WEB_WORKSPACES, showPanel } from './workspace/presets'
import { filmPanels, type PanelParts } from './workspace/panels'
import { focusPanelSearch } from './workspace/focusSearch'
import { createWorkspaceRoute } from './workspace/route'
import { Header } from './workspace/Header'
import { WorkspaceDialogs, type WorkspaceDialog } from './workspace/WorkspaceDialogs'
import { ToolsPanel } from './tools/ToolsPanel'
import { HomeTab } from './HomeTab'
import { cancelFilmDrag } from './timeline/drop'
import { DEFAULT_TOOL, FILM_TOOLS } from './tools/catalog'
import { toolHint } from './tools/hints'


const Download = TesseraIcons.DownloadIcon
const Loader2 = TesseraIcons.LoaderCircleIcon
const X = TesseraIcons.XIcon

/** Help's own dialog for each `dialog` route id that is not a registry dialog: upstream's Keyboard Shortcuts, and Kition's Help row. */
const HELP_TOPICS: Readonly<Record<string, HelpTopic>> = { 'app.keyboardShortcuts': 'shortcuts', 'help.shortcuts': 'shortcuts' }

/** The status bar's open time, render time, and frames shown per second while playing; it alone renders per frame. */
function StatsReadout({ stats, openMs, playing, t }: { stats: StatsStore; openMs: number | null; playing: boolean; t: (key: string, values?: Record<string, string | number>) => string }) {
  const { render, fps } = useStats(stats)
  return (
    <span className="tabular-nums" data-testid="film-stats">
      {[openMs != null ? t('stats.open', { ms: openMs }) : null, render ? t('stats.render', { ms: render.renderMs }) : null, playing && fps != null ? t('playbackFps', { fps }) : null].filter(Boolean).join(' · ')}
    </span>
  )
}

/**
 * The session's options. The Film engine paints nothing that neither its revision nor `inspect()`
 * shows (a playhead is in `inspect()`), so an agent step that moves neither (`project.select`) need
 * not repaint the Program. A stored replica opens whatever the file's stamp (`replicaMergesFile`,
 * Kit UI protocol UI-R1): the engine records a file changed outside Kition onto the replica as one
 * `import` change (`openWithReplica`), so the project keeps its identity and history. The person's
 * view is kept by the host after each save (`viewState`, see `session/viewState.ts`).
 */
const sessionOptions = (view: FilmViewStateKeeper) => ({ agentSkipsUnchangedPaint: true, replicaMergesFile: true, viewState: view.option }) as const

/** How long a status message shows; the flow test shortens it in development builds (`window.filmStatusMs`). */
/** The `file` group's queries a dialog may read through `ask` (Properties'): they read media and write nothing. */
const READ_FILE_QUERIES: ReadonlySet<string> = new Set(['file.mediaProperties', 'file.mediaPropertiesFile'])

const statusMs = () => (import.meta.env.DEV ? ((window as unknown as { filmStatusMs?: number }).filmStatusMs ?? STATUS_MS) : STATUS_MS)

/** The engine's `format_eta`: `12 s`, `3:04`, `1:02:03`. */
function etaText(seconds: number) {
  const s = Math.ceil(Math.max(0, seconds))
  const two = (n: number) => String(n).padStart(2, '0')
  if (s < 60) return `${s} s`
  if (s < 3600) return `${Math.floor(s / 60)}:${two(s % 60)}`
  return `${Math.floor(s / 3600)}:${two(Math.floor((s % 3600) / 60))}:${two(s % 60)}`
}

/**
 * The status bar's running job (upstream `lib.rs` `job_status`): "Exporting… 42% · 12 s left",
 * a 120 px progress bar, and Cancel. `verb` is upstream's: a render's label, else Exporting (the
 * document's own jobs, Scene Edit Detection's, say it too, as upstream's do).
 */
function StatusJob({ progress, verb, subject, onCancel, phrase }: { progress: ExportProgress; verb?: string; subject?: string | null; onCancel: () => void; phrase: Phrases }) {
  const fraction = Math.min(1, Math.max(0, progress.fraction))
  const left = progress.secondsLeft != null ? phrase(' · {time} left').replace('{time}', etaText(progress.secondsLeft)) : ''
  const percent = `${Math.round(fraction * 100)}%`
  return (
    <span className="film-status-job" data-testid="film-exporting">
      {/* `subject`: what is exported (the sequence's name), so the person knows which sequence the file will hold. */}
      <span className="film-status-job-text">{`${verb ?? phrase('Exporting')}… ${percent}${left}${subject ? ` · ${subject}` : ''}`}</span>
      <span className="film-status-job-bar" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(fraction * 100)} aria-label={`${percent}${left}`} data-kit-ui-id="control:status.job.progress" data-testid="film-exporting-progress">
        <span style={{ width: `${fraction * 100}%` }} />
      </span>
      <IconButton icon={X} label={phrase('Cancel')} onClick={onCancel} data-kit-ui-id="control:status.job.cancel" data-testid="film-exporting-cancel" />
    </span>
  )
}

/**
 * What the panels this file draws read on every render: the layout keeps each panel's `render`
 * stable, so they follow the editor through this context, not through props.
 */
type Live = {
  state: FilmInfo | null
  filmState: FilmSessionState | null
  doc: ReturnType<typeof useKitSession>['doc']
  playback: Playback
  clocks: ReturnType<typeof usePlayback>['state']
  /** The monitors' view options (the UI's own, upstream's `MonitorView`). */
  views: MonitorViews
  setShowTransport: (monitor: MonitorId, show: boolean) => void
  /** Where each monitor draws its picture (its guides' and rulers' geometry), a guide dialog's preview, and a guide drag's release. */
  guideGeometry: Readonly<Record<MonitorId, ValueStore<GuideGeometry>>>
  guidePreview: ValueStore<GuidePreview>
  setGuides: (monitor: MonitorId, guides: readonly Guide[], show: boolean) => void
  status: (text: string) => void
  /** The status bar for engine and error text (`errorStatus`): translated when the catalog has it, never noted as a missing label. */
  errorStatus: (text: string) => void
  /** Why an edit command would be refused now (a dialog's preview is open, `previewGate.ts`), or null. */
  editRefusal: (id: string) => string | null
  /** Moves the program playhead to `ticks` and refreshes the editor. */
  seekTicks: (ticks: number) => Promise<unknown>
  /** Repaints the program canvas without a document change, the playhead left at `ticks`. */
  repaint: (ticks: number) => Promise<unknown>
  /** Counts the playhead moves the editor asked for (commands, seeks): a resolution repaint sends no older position over a newer one. */
  playheadMoves: () => number
  proxiesRead: ProxiesRead
  focused: string
  setFocused: (panel: string) => void
  canvas: RefObject<KitCanvasHandle | null>
  viewMemory: MutableRefObject<RasterView | null>
  stats: StatsStore
  countFrame: () => void
  invoke: (id: string, params?: Record<string, unknown>, options?: InvokeOptions) => Promise<unknown>
  query: (id: string, params?: Record<string, unknown>) => Promise<unknown>
  seek: (seconds: number) => Promise<unknown>
  labels: FilmLabels | null
  /** The engine's revision, which keys a sequence item's thumbnails and peaks. */
  revision: number | null
  timelineView: TimelineViewStore
  media: TimelineMedia
  /** Moves when the media caches were emptied for another document. */
  mediaGeneration: number
  phrase: Phrases
  t: (key: string, values?: Record<string, string | number>) => string
  /** The tool (upstream's `app.ui.tool`, a manifest id) and the one way to choose it. */
  tool: string
  chooseTool: (tool: string) => boolean
  /** The keys the Program monitor's graphics tools take (the Pen's Enter and Escape), asked before the key router. */
  programKeys: MutableRefObject<((event: KeyboardEvent<HTMLElement>) => boolean) | null>
  /** The Program monitor's Begin Text Editing, set while it is shown. */
  programText: MutableRefObject<(() => Promise<unknown>) | null>
  /** Set while a channel display mode's picture covers the Program canvas (playback then leaves the canvas unpainted). */
  programCovered: MutableRefObject<boolean>
  noClips: string
  /** The Project panel's own state (upstream `ProjectPanelUi`), its thumbnails, and what its route reads. */
  projectUi: ProjectUi
  /** Moves when the Project panel's view may have changed with no revision (`useFilmSession`). */
  projectView: number
  projectThumbnails: ProjectThumbnails
  projectDeps: ProjectRouteDeps
  /** The Project panel's and its windows' reads: their view reads of one turn share one request. */
  projectQuery: (id: string, params?: Record<string, unknown>) => Promise<unknown>
  /** The sound as it is scheduled, which the Audio Meters take as the audio clock reaches it. */
  meterFeed: MeterFeed
}

const LiveContext = createContext<Live | null>(null)
const NO_LAYERS: readonly number[] = []
const NO_NAMES: readonly string[] = []
const NO_COMMANDS: ReadonlySet<string> = new Set()
const useLive = () => useContext(LiveContext)!

/** The Program panel (upstream `monitor.rs` with `Which::Program`), or upstream's "(no sequences)". */
function ProgramPanel() {
  const live = useLive()
  const { state, stats, clocks, countFrame } = live
  const proxies = useProxies(live.proxiesRead, live.revision, state?.activeSequence != null)
  if (!state || state.activeSequence == null) return <Placeholder text={live.phrase('(no sequences)')} panel="program" />
  return (
    <ProgramMonitor
      film={state}
      doc={live.doc}
      canvas={live.canvas}
      viewMemory={live.viewMemory}
      monitor={live.views.program}
      playback={live.playback}
      playing={clocks.program.playing}
      looping={clocks.program.looping}
      proxies={proxies}
      phrase={live.phrase}
      invoke={live.invoke}
      seekTicks={live.seekTicks}
      repaint={live.repaint}
      playheadMoves={live.playheadMoves}
      revision={live.revision}
      setScrubbing={live.media.setScrubbing}
      onShowTransport={(show) => live.setShowTransport('program', show)}
      tool={live.tool}
      graphicsKeys={live.programKeys}
      graphicsText={live.programText}
      textNotShown={live.t('textNotShown')}
      layerChanged={live.t('layerChanged')}
      graphicLayers={live.filmState?.graphicLayers ?? NO_LAYERS}
      editRefusal={live.editRefusal}
      status={live.status}
      errorStatus={live.errorStatus}
      onView={(_, next) => {
        if (!next) return
        stats.rendered(next)
        if (clocks.program.playing) countFrame()
      }}
      onFrameShown={countFrame}
      covered={live.programCovered}
      guideGeometry={live.guideGeometry.program}
      guidePreview={live.guidePreview}
      onGuides={(guides, show) => live.setGuides('program', guides, show)}
    />
  )
}

/**
 * The workspace in every display mode but Focus. Focus shows the Program monitor's picture alone
 * (kit-editor's display modes: the canvas and the Focus bar): no other panel, no frame's tab
 * strip, no bin window. The workspace's tree is kept, so leaving Focus shows it as it was.
 */
function FocusProgram({ children }: { children: ReactNode }) {
  const live = useLive()
  const focus = useFrameMode() === 'focus'
  const hidden = useUi().state('panel:program').hidden === true
  // Focus's picture is far larger than the panel's: it is placed on its own (fitted, or at the
  // magnification chosen), and the panel's view is there as it was on leaving.
  const panelMemory = live.viewMemory
  const focusMemory = useMemo<MutableRefObject<RasterView | null>>(() => ({ current: null }), [panelMemory, focus])
  if (!focus) return <>{children}</>
  return (
    <div className="film-focus-program" data-testid="film-focus-program">
      {hidden ? null : (
        <LiveContext.Provider value={{ ...live, viewMemory: focusMemory }}>
          <ProgramPanel />
        </LiveContext.Provider>
      )}
    </div>
  )
}

/** The Source panel (upstream `monitor.rs` with `Which::Source`), or a muted empty-state line when there is nothing to show. */
function SourcePanel() {
  const live = useLive()
  const { state, clocks, countFrame } = live
  const sourceView = useSourceView(live.query, live.playback, state?.sourceItem ?? null, live.revision, live.filmState?.sourcePlayhead ?? null)
  const shown = state?.sourceItem != null && sourceView != null && sourceView.item === state.sourceItem
  const proxies = useProxies(live.proxiesRead, live.revision, shown)
  if (state?.sourceItem == null || sourceView == null || sourceView.item !== state.sourceItem) return <Placeholder text={live.noClips} panel="source" />
  return (
    <SourceMonitor
      doc={live.doc}
      revision={live.revision}
      view={sourceView}
      monitor={live.views.source}
      playback={live.playback}
      playing={clocks.source.playing}
      looping={clocks.source.looping}
      proxies={proxies}
      tool={live.tool}
      phrase={live.phrase}
      invoke={live.invoke}
      status={live.status}
      name={projectItems(state.root).get(sourceView.item)?.name ?? ''}
      safeAreas={state.safeAreas}
      setScrubbing={live.media.setScrubbing}
      onShowTransport={(show) => live.setShowTransport('source', show)}
      onDrawn={clocks.source.playing ? countFrame : undefined}
      key={live.mediaGeneration}
      queue={live.media.queue}
      peaksRevision={projectItems(state.root).get(sourceView.media)?.type === 'Sequence' ? live.revision : null}
      guideGeometry={live.guideGeometry.source}
      guidePreview={live.guidePreview}
      onGuides={(guides, show) => live.setGuides('source', guides, show)}
    />
  )
}

/** The Timeline panel (upstream `panels/timeline.rs`). */
function TimelinePart() {
  const live = useLive()
  return (
    <TimelinePanel
      key={live.mediaGeneration}
      film={live.state}
      session={live.filmState}
      labels={live.labels}
      revision={live.revision}
      playback={live.playback}
      playing={live.clocks.program.playing}
      store={live.timelineView}
      media={live.media}
      tool={live.tool}
      invoke={live.invoke}
      query={live.query}
      seek={live.seek}
      phrase={live.phrase}
      t={live.t}
      doc={live.doc}
    />
  )
}

/** The Timeline frame's strip: its open sequences (`timeline/TimelinePanel.tsx`). */
function TimelineStrip({ active }: { active: boolean }) {
  const { state, filmState, invoke, phrase } = useLive()
  return <SequenceTabs active={active} film={state} session={filmState} invoke={invoke} phrase={phrase} />
}

/** The » list's rows for the Timeline frame. */
function TimelineMoreRows({ close }: { close: () => void }) {
  const { state, filmState, invoke } = useLive()
  return <SequenceRows film={state} session={filmState} invoke={invoke} close={close} />
}

/** Close Other Timeline Panels, right after Close Panel while a sequence is open (upstream `panel_menu_popup`). */
function TimelineAfterClose({ close }: { close: () => void }) {
  const { state, filmState, invoke, phrase } = useLive()
  if (state?.activeSequence == null) return null
  return (
    <MenuItem
      label={phrase('Close Other Timeline Panels')}
      disabled={(filmState?.openSequences.length ?? 0) <= 1}
      uiId="control:panel.menu.Timeline.closeOthers"
      testId="film-timeline-close-others"
      onSelect={() => {
        close()
        void invoke('sequence.closeOthers', {})
      }}
    />
  )
}

/** The Timeline's own panel menu rows: Reveal Sequence in Project, and the thumbnail and waveform switches. */
function TimelineMenu({ close }: { close: () => void }) {
  const { state, invoke, phrase, timelineView } = useLive()
  const view = useTimelineView(timelineView)
  return (
    <>
      <MenuSeparator />
      <MenuItem
        label={phrase('Reveal Sequence in Project')}
        disabled={state?.activeSequence == null}
        uiId="control:panel.menu.Timeline.revealSequence"
        testId="film-timeline-reveal"
        onSelect={() => {
          close()
          void invoke('sequence.revealInProject', {})
        }}
      />
      <MenuItem label={phrase('Video Thumbnails')} checked={view.showThumbnails} uiId="control:timeline.settings.showVideoThumbnails" testId="film-timeline-menu-thumbnails" onSelect={() => timelineView.set({ showThumbnails: !view.showThumbnails })} />
      <MenuItem label={phrase('Audio Waveforms')} checked={view.showWaveforms} uiId="control:timeline.settings.showAudioWaveform" testId="film-timeline-menu-waveforms" onSelect={() => timelineView.set({ showWaveforms: !view.showWaveforms })} />
    </>
  )
}

/** The Project panel (upstream `panels/project.rs`). */
function ProjectPart() {
  const live = useLive()
  // The bins change only with a revision (or another document): the panel does not draw again for a playhead move.
  const rootNow = live.state?.root ?? null
  const root = useMemo(() => rootNow, [live.revision, live.doc])
  const notAvailable = live.t('notAvailable')
  return (
    <ProjectPanel
      key={live.mediaGeneration}
      root={root}
      projectName={live.state?.project ?? ''}
      selection={live.filmState?.projectSelection ?? NO_LAYERS}
      labels={live.labels}
      revision={live.revision}
      ui={live.projectUi}
      viewRefresh={live.projectView}
      thumbnails={live.projectThumbnails}
      previewPictures={live.media.previewThumbnails}
      deps={live.projectDeps}
      invoke={live.invoke}
      query={live.projectQuery}
      phrase={live.phrase}
      notAvailable={notAvailable}
      status={live.status}
      errorStatus={live.errorStatus}
    />
  )
}

/** A floating bin window's body (upstream `project.rs` `floating`): the Project panel's, for the window's bin, in its own instance. */
function BinWindowPart({ id }: { id: string }) {
  const live = useLive()
  const rootNow = live.state?.root ?? null
  const root = useMemo(() => rootNow, [live.revision, live.doc])
  const ui = useMemo(() => live.projectUi.instance(id), [live.projectUi, id])
  return (
    <ProjectPanel
      key={live.mediaGeneration}
      window={id}
      root={root}
      projectName={live.state?.project ?? ''}
      selection={live.filmState?.projectSelection ?? NO_LAYERS}
      labels={live.labels}
      revision={live.revision}
      ui={ui}
      viewRefresh={live.projectView}
      thumbnails={live.projectThumbnails}
      previewPictures={live.media.previewThumbnails}
      deps={live.projectDeps}
      invoke={live.invoke}
      query={live.projectQuery}
      phrase={live.phrase}
      notAvailable={live.t('notAvailable')}
      status={live.status}
      errorStatus={live.errorStatus}
    />
  )
}

/**
 * The floating bin windows (upstream `project.rs` `floating`: an `egui::Window` titled "Bin: name",
 * or "Project: name" on the project's root) over the workspace, on kit-editor's `FloatingPanels`:
 * their rectangles in the kit store (`film.floatingBins`), shared by every Film page; which are
 * open is this page's (`ProjectUi.windows`). A window is a focus target (`projectBin.<id>`): it
 * takes the Project panel's keys and commands. Closing the focused one focuses the Project panel.
 */
function BinWindows() {
  const live = useLive()
  const { projectUi, phrase, setFocused } = live
  const windows = useSyncExternalStore(projectUi.subscribe, projectUi.windows)
  // The host may hide the windows (their Kit UI id): then none is drawn, and none keeps focus.
  const hidden = useUi().state('control:projectBin.window').hidden === true
  const rootNow = live.state?.root ?? null
  const root = useMemo(() => rootNow, [live.revision, live.doc])
  const projectName = live.state?.project ?? ''
  // Each window's body, made once while it is open, so the layer does not draw it again for a title change.
  const renders = useRef(new Map<string, () => ReactNode>())
  const panels = useMemo<FloatingPanel[]>(() => {
    for (const id of [...renders.current.keys()]) if (!windows.some((each) => each.id === id)) renders.current.delete(id)
    return windows.map((each) => {
      let render = renders.current.get(each.id)
      if (!render) {
        render = () => <BinWindowPart id={each.id} />
        renders.current.set(each.id, render)
      }
      const title = root != null && each.bin === root.id ? phrase('Project: {name}').replace('{name}', projectName) : phrase('Bin: {name}').replace('{name}', findBin(root, each.bin)?.name ?? '')
      return { id: each.id, title, render, uiId: 'control:projectBin.window' }
    })
  }, [windows, root, projectName, phrase])
  // Focus on a window no longer drawn (closed by its X, by `closeBinTab`, by its bin going, or
  // hidden) goes to the Project panel, and the editor takes the keys when focus went nowhere.
  const drawnKey = hidden ? '' : windows.map((each) => each.id).join('\n')
  useEffect(() => {
    const fallback = windowFocusFallback(live.focused, drawnKey ? drawnKey.split('\n') : [])
    if (!fallback) return
    setFocused(fallback)
    giveKeysBack(document)
  }, [live.focused, drawnKey, setFocused])
  // The windows' boxes, so a workspace panel one covers counts as not drawing a preview (the strip
  // lists its part): measured only when a window can have moved (`watchFloatingBoxes`).
  const drawers = useContext(PreviewContext)?.drawers
  useEffect(() => {
    const area = document.querySelector('.film-workspace-area')
    if (!drawers || !area) return undefined
    return watchFloatingBoxes(area, {
      layer: () => area.querySelector(':scope > .kui-floating-layer'),
      boxes: (layer) =>
        [...(layer as Element).querySelectorAll('.kui-floating-panel')].map((element) => {
          const box = element.getBoundingClientRect()
          return { x: box.left, y: box.top, width: box.width, height: box.height }
        }),
      frames: () => [...area.querySelectorAll('.kui-ws-frame')],
      observeMutations: (target, options, callback) => {
        const observer = new MutationObserver(callback)
        observer.observe(target as Node, options)
        return () => observer.disconnect()
      },
      observeSizes: (callback) => {
        if (typeof ResizeObserver === 'undefined') return { watch: () => undefined, stop: () => undefined }
        // The first callback after `observe` reports the size it starts at: not a change.
        const fresh = firstSizeReports()
        const observer = new ResizeObserver((entries) => {
          if (fresh.moved(entries.map((entry) => entry.target))) callback()
        })
        let watched: Element[] = []
        return {
          watch: (targets) => {
            const next = targets as Element[]
            for (const target of watched) if (!next.includes(target)) observer.unobserve(target)
            for (const target of next)
              if (!watched.includes(target)) {
                fresh.watch(target)
                observer.observe(target)
              }
            watched = next
          },
          stop: () => observer.disconnect(),
        }
      },
      onWindowResize: (callback) => {
        window.addEventListener('resize', callback)
        return () => window.removeEventListener('resize', callback)
      },
      frame: (callback) => {
        const id = requestAnimationFrame(callback)
        return () => cancelAnimationFrame(id)
      },
      floating: drawers.floating,
      changed: drawers.changed,
    })
  }, [drawers])
  const close = useCallback((id: string) => void projectUi.closeWindow(id), [projectUi])
  const focus = useCallback((id: string) => setFocused(binWindowFocus(id)), [setFocused])
  return <FloatingPanels kit={FLOATING_BINS.kit} store={FLOATING_BINS.store} panels={panels} onClose={close} focused={binWindowOf(live.focused)} onFocus={focus} testId="film-bin-windows" />
}

/** The Project panel's ≡ rows (upstream `project::panel_menu`), reading the view when the menu opens. */
function ProjectMenuPart({ close }: { close: () => void }) {
  const live = useLive()
  const [view, setView] = useState<ProjectView | null>(null)
  useEffect(() => {
    let open = true
    void live.query('project.view.get').then((answer) => {
      if (open) setView(answer as ProjectView | null)
    })
    return () => {
      open = false
    }
  }, [live.query])
  const ui = live.projectUi.get()
  const tab = live.projectUi.shownTab()
  const root = live.state?.root?.id ?? null
  const { bin } = shownBin(ui, live.state?.root ?? null)
  return (
    <ProjectMenu
      close={close}
      view={view}
      mode={tab?.mode ?? view?.view.mode ?? 'icon'}
      selection={live.filmState?.projectSelection ?? NO_LAYERS}
      ui={live.projectUi}
      parent={bin != null && bin !== root ? bin : null}
      invoke={live.invoke}
      query={live.query}
      phrase={live.phrase}
    />
  )
}

/** Effect Controls (upstream `effect_controls::show`). */
function EffectControlsPart() {
  const live = useLive()
  // Upstream asks for the selected clip first: before a document opens there is none.
  if (!live.state) return <Placeholder text={live.phrase('(no clip selected)')} panel="effectControls" />
  return <EffectControls film={live.state} doc={live.doc} revision={live.revision} playback={live.playback} invoke={live.invoke} seekTicks={live.seekTicks} phrase={live.phrase} />
}

/** Effects (upstream `panels/effects.rs` `show`): the effects, transitions, and presets to apply. */
function EffectsPart() {
  const live = useLive()
  return <EffectsPanel open={live.doc != null} query={live.query} invoke={live.invoke} phrase={live.phrase} />
}

/** Properties (upstream `effect_controls::properties_panel`). */
function PropertiesPart() {
  const live = useLive()
  if (!live.state) return <Placeholder text={live.phrase('Select a clip to see its properties')} panel="properties" />
  return <PropertiesPanel film={live.state} doc={live.doc} revision={live.revision} playback={live.playback} labels={live.labels} invoke={live.invoke} phrase={live.phrase} />
}

/** The Tools panel: upstream's 8 groups in one column. */
function ToolsPart() {
  const { tool, chooseTool } = useLive()
  return <ToolsPanel active={tool} onChoose={chooseTool} />
}

/** Audio Meters (upstream `panels/meters.rs`): the Mix while the program plays. */
function AudioMetersPart() {
  const { meterFeed, clocks } = useLive()
  return <AudioMeters feed={meterFeed} playing={clocks.program.playing} />
}

/** Markers (upstream `misc.rs` `markers`): the active sequence's. */
function MarkersPart() {
  const { state, filmState, invoke, phrase } = useLive()
  const hidden = filmState?.hiddenMarkerColors ?? NO_NAMES
  return (
    <MarkersPanel
      markers={state && state.activeSequence != null ? state.markers : null}
      sequence={state?.activeSequence ?? null}
      fps={state?.fps ?? 30}
      dropFrame={state?.dropFrame ?? false}
      ticksPerSecond={state?.ticksPerSecond ?? 1}
      hidden={hidden}
      invoke={invoke}
      phrase={phrase}
    />
  )
}

/** History (upstream `misc.rs` `history`). */
function HistoryPart() {
  const { revision, query, invoke, phrase } = useLive()
  return <HistoryPanel revision={revision} query={query} invoke={invoke} phrase={phrase} />
}

/** Info (upstream `misc.rs` `info`). */
function InfoPart() {
  const { state, doc, revision, filmState, playback, phrase } = useLive()
  return <InfoPanel film={state} doc={doc} revision={revision} item={filmState?.projectSelection[0] ?? null} playback={playback} phrase={phrase} />
}

/** The panels this editor draws so far; the others are placeholders (`workspace/panels.ts`). */
const PARTS: Readonly<Record<string, PanelParts>> = {
  tools: { render: () => <ToolsPart /> },
  program: { render: () => <ProgramPanel /> },
  source: { render: () => <SourcePanel /> },
  project: { render: () => <ProjectPart />, menu: (close) => <ProjectMenuPart close={close} /> },
  effectControls: { render: () => <EffectControlsPart /> },
  effects: { render: () => <EffectsPart /> },
  properties: { render: () => <PropertiesPart /> },
  audioMeters: { render: () => <AudioMetersPart /> },
  markers: { render: () => <MarkersPart /> },
  history: { render: () => <HistoryPart /> },
  info: { render: () => <InfoPart /> },
}

/**
 * The shown panel whose content lies under a point of the editor's window, or null: upstream's
 * `panel_under_pointer` reads the panels' content rects, so a frame's tab strip does not count.
 */
function panelAt(point: { x: number; y: number } | null): string | null {
  if (!point) return null
  return document.elementFromPoint(point.x, point.y)?.closest('.kui-workspace .kui-ws-body')?.closest('[data-panel]')?.getAttribute('data-panel') ?? null
}

/**
 * Moves off an active tool the host denies (now, or by a later `ui/configure`) to the first tool it
 * allows and does not hide, with or without a Tools frame on screen.
 */
function DeniedToolFallback({ tool, onTool }: { tool: string; onTool: (tool: string) => boolean }) {
  const ui = useUi()
  const replacement = ui.state(`tool:${tool}`).denied ? FILM_TOOLS.find((each) => !ui.state(`tool:${each.id}`).denied && !ui.state(`tool:${each.id}`).hidden)?.id : undefined
  useLayoutEffect(() => {
    if (replacement) onTool(replacement)
  }, [replacement, onTool])
  return null
}

/** Keeps the host's UI configuration readable outside the editor's provider (`useUi` works inside it only). */
function UiReader({ into }: { into: MutableRefObject<ReturnType<typeof useUi>['state'] | null> }) {
  into.current = useUi().state
  return null
}

/**
 * `phrase` draws labels (and, in development builds, notes any its catalog lacks); `quietPhrase`
 * draws engine and error text, translated when the catalog has it and shown as it is otherwise.
 */
export function App({ host, phrase, quietPhrase = phrase }: { host: HostConnection; phrase: Phrases; quietPhrase?: Phrases }) {
  const t = useMemo(() => withDeclaredLabels(createKitStrings(CATALOGS, host.init.locale), phrase), [host, phrase])
  const manifest = useMemo(engineManifest, [])
  // Every command runs through the targeted session (see `useFilmSession`), the editor's menus too.
  // The engine's events (toasts, the panels to show), handled with this render's workspace and Project panel.
  const engineEvents = useRef<(events: EngineEvent[]) => void>(() => undefined)
  const onEngineEvents = useCallback((events: EngineEvent[]) => engineEvents.current(events), [])
  // While a dialog's preview is open the document is not editable (`session/previewGate.ts`): set once the preview exists, below.
  const previewGate = useRef<PreviewGate | null>(null)
  // What the preferences' sync could not do (a load that failed after its tries), in the status bar.
  const prefsError = useRef<(message: string) => void>(() => undefined)
  const viewState = useMemo(() => createFilmViewState(host), [host])
  const options = useMemo(() => sessionOptions(viewState), [viewState])
  const { session, focused, setFocused, focusedNow, filmState, labels, keys, shortcuts, isReserved, job, cancelJob, projectView, checkPrefs } = useFilmSession(useKitSession(host, manifest, describe, options), host.init.shortcuts, onEngineEvents, previewGate, prefsError, viewState)
  // The status bar's message (upstream's `app.ui.status`): why the last command failed, or what
  // an export did. As upstream, it clears after 8 seconds or when the status bar is clicked;
  // kit-editor's failures (menus, dialogs, panels) come here too. Only the engine's own toasts
  // (`takeEvents`) show as toasts.
  const [message, setMessage] = useState<StatusMessage | null>(null)
  // The same text again keeps its first time (upstream `status_seen`): only a new text starts the 8 seconds over.
  const status = useCallback((text: string) => setMessage((shown) => nextStatus(shown, phrase(text), performance.now())), [phrase])
  // Engine and error text (a refusal, a failed command), in the person's words (`personMessage`: never a
  // command id, the engine's reasons translated when the catalog has them), never noted as a missing label.
  const errorStatus = useCallback((text: string) => setMessage((shown) => nextStatus(shown, personMessage(text, t, quietPhrase), performance.now())), [quietPhrase, t])
  prefsError.current = errorStatus
  const report = useCallback((title: string, error: unknown) => errorStatus(error instanceof Error ? error.message : String(error ?? '') || title), [errorStatus])
  const kitEditor = useKitEditorState(session, host, t, 'film', phrase, undefined, { report })
  // kit-editor's menus, context menus, and palette open a command's dialog through the editor's `run`
  // (no params) and `ask`: a command with an upstream dialog opens Film's, through `invoke`.
  const dialogInvoke = useRef<(id: string, params: Record<string, unknown>, ask?: boolean) => Promise<unknown>>(async () => null)
  const editor = {
    ...kitEditor,
    // A menu row and the palette call run(id), kit-editor's shortcut fallback run(id, {}): both open it.
    run: (async (id: string, params?: Record<string, unknown>) => {
      if (editorOpens(id, params)) return dialogInvoke.current(id, {})
      // Reserved shortcuts and toolbar history must share Film's pending Source edit queue.
      if (id === 'edit.undo' || id === 'edit.redo') return dialogInvoke.current(id, params ?? {})
      return kitEditor.run(id, params)
    }) as typeof kitEditor.run,
    // ask opens it with its values as the dialog's starting params.
    ask: (id: string, values?: Record<string, unknown>) => (DIALOGS.has(id) ? void dialogInvoke.current(id, values ?? {}, true) : kitEditor.ask(id, values)),
  }
  const { state } = session
  const canvas = useRef<KitCanvasHandle>(null)
  // A remembered pan/fit is expressed in this sequence's frame coordinates. Reusing it for a
  // different frame leaves a tiny picture at the old origin while the menu still says Fit.
  const viewMemory = useMemo<MutableRefObject<RasterView | null>>(
    () => ({ current: null }),
    [session.doc, state?.activeSequence, state?.width, state?.height],
  )
  // The render time and frames-shown readout, outside React state: the canvas reports every frame.
  const stats = useMemo(createStatsStore, [])
  // Moving the playhead is not an edit: it goes to the engine without the editor's notices.
  const runQuietly = session.run
  // Every playhead move the editor asks for (a command through `invoke`, a seek) counts here.
  const moves = useRef(0)
  const seek = useCallback((seconds: number) => ((moves.current += 1), runQuietly('playhead.set', { seconds: Math.max(0, seconds) }).catch(() => undefined)), [runQuietly])
  const [progress, setProgress] = useState<ExportProgress | null>(null)
  // The name of the sequence an export in progress writes, which the status bar shows with its progress.
  const [exporting, setExporting] = useState<string | null>(null)
  const abort = useRef<AbortController | null>(null)
  const canPick = host.init.capabilities.includes('pick-file')
  /** The project's folder, which picked files are named relative to (as File ▸ Import names them). */
  const projectFolder = () => host.init.document.path.split('/').filter(Boolean).slice(0, -1).join('/')
  // The tool (upstream's `app.ui.tool`, a manifest id), which the Tools panel, the timeline, and the status bar's hint read.
  const [tool, setTool] = useState(DEFAULT_TOOL)
  // The Program monitor's graphics keys (the Pen's Enter and Escape), set while it is shown.
  const programKeys = useRef<((event: KeyboardEvent<HTMLElement>) => boolean) | null>(null)
  const programText = useRef<(() => Promise<unknown>) | null>(null)
  // Whether a dialog's picture preview covers the Program monitor now (set once the preview exists).
  const previewCovers = useRef<() => boolean>(() => false)
  const programCovered = useRef(false)
  const stateForClock = useRef<FilmInfo | null>(null)
  useEffect(() => {
    if (!message) return undefined
    const timer = window.setTimeout(() => setMessage((shown) => (shown === message ? null : shown)), statusLeft(message, performance.now(), statusMs()))
    return () => window.clearTimeout(timer)
  }, [message])
  const query = editor.query
  // Guide templates: in the engine's preferences (`prefs.guides.templates`, as upstream's), kept
  // across reloads and pages with every preference (`session/prefsSync.ts`).
  // Read and written with the preferences' revision (`prefsValue`, the conditional `loadPrefs`), so
  // a write never lands over preferences another page's load brought in between.
  const templateDoc = useRef(session.doc)
  templateDoc.current = session.doc
  const guideTemplates = useMemo(
    () => {
      const doc = () => {
        const open = templateDoc.current
        if (!open) throw new Error(t('notAvailable'))
        return open
      }
      return createGuideTemplates({
        read: async () => JSON.parse(await doc().invoke<string>('prefsValue')) as { version: number; values: Record<string, unknown> },
        write: async (values, expected) => JSON.parse(await doc().invoke<string>('loadPrefs', JSON.stringify(values), expected)) as { loaded: boolean; version: number; values: Record<string, unknown> },
        changed: () => checkPrefs(),
      })
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  )
  useEffect(() => () => guideTemplates.dispose(), [guideTemplates])
  // A new session, another page's preferences, or a refresh with no revision (an agent's prefs.set) may have changed them.
  useEffect(() => {
    if (session.doc) void guideTemplates.refresh().catch(() => undefined)
  }, [session.doc, projectView, guideTemplates])
  const docNow = useRef(session.doc)
  docNow.current = session.doc
  // File operations may outlive the permissions that opened them. A later configuration
  // restoration starts new intent; it never revives an outstanding picker or export.
  const fileIntentEpoch = useRef(0)
  useLayoutEffect(() => host.ui.subscribe(() => {
    fileIntentEpoch.current += 1
    cancelFilmDrag()
    abort.current?.abort()
  }), [host])
  // HTML drags can survive a project/sequence replacement, even while the Timeline is hidden.
  const dragProjectEpoch = (session.info?.inspected as { project?: { epoch?: number } } | null)?.project?.epoch
  useLayoutEffect(() => cancelFilmDrag(), [session.doc, dragProjectEpoch, state?.activeSequence])
  // Pending and queued Source steps cannot carry over to a replacement project/item,
  // including a switch away and back to the same ID. Ordinary seeks keep the token.
  const sourceContext = useMemo(() => ({}), [session.doc, dragProjectEpoch, state?.sourceItem])
  const sourceContextNow = useRef(sourceContext)
  sourceContextNow.current = sourceContext
  // What the Audio Meters show: the sound output's chunks as its clock reaches them.
  const meterFeed = useMemo(() => createMeterFeed(), [])
  // Upstream's two clocks (program and source) and the shuttle; the sound output is made in the first play gesture.
  const { playback, state: clocks } = usePlayback({
    program: () => (state ? { playhead: state.playhead, duration: state.duration, in: state.in, out: state.out, frame: state.frame, sourceItem: state.sourceItem } : null),
    sourceContext: () => sourceContextNow.current,
    query: (id, params) => query(id, params),
    // While playing, the program playhead repaints the monitor only and the source playhead refreshes nothing; a stop refreshes everything once.
    // While a picture preview covers the Program monitor, playback leaves the program unpainted: the preview draws there.
    // So does a channel display mode, whose picture the Program monitor draws from a reduced copy.
    run: async (id, params, refresh) => {
      const context = sourceContextNow.current
      const opened = docNow.current
      const answer = await runQuietly(id, params, null, { refresh: playbackRefresh(refresh, previewCovers.current() || programCovered.current) })
      // A source seek acknowledged after the Source was replaced brings the engine's info as it was
      // then (its Source clip): read the info again, so the editor never shows the old Source.
      if (id === 'source.setPlayhead' && opened && docNow.current === opened && sourceContextNow.current !== context) await opened.refreshInfo().catch(() => undefined)
      return answer
    },
    audio: () => {
      const player = new FilmAudioPlayer(() => docNow.current, { onError: status })
      // The Audio Meters read the Mix as it is scheduled, on the player's own clock; source playback is not metered, as upstream.
      player.onChunk = (samples, when, rate, kind) => {
        if (kind === 'program') meterFeed.push(samples, when, rate)
      }
      player.onSilence = () => meterFeed.clear()
      meterFeed.setClock(() => player.heardTime)
      return player
    },
    onError: status,
  })
  // The monitors' view options (upstream's `MonitorView`, the UI's own), which the View menu changes and checks.
  const [views, setViews] = useState<MonitorViews>(DEFAULT_VIEWS)
  const viewsNow = useRef(views)
  const setShowTransport = useCallback((monitor: MonitorId, show: boolean) => {
    viewsNow.current = setMonitorView(viewsNow.current, monitor, { showTransport: show })
    setViews(viewsNow.current)
  }, [])
  // Rulers and guides (upstream `monitor_view.rs`): a guide drag's release, each monitor's picture
  // geometry, and the guide dialogs' preview, all UI state (rule 5).
  const setGuides = useCallback((monitor: MonitorId, guides: readonly Guide[], show: boolean) => {
    viewsNow.current = setMonitorView(viewsNow.current, monitor, show ? { guides, showGuides: true } : { guides })
    setViews(viewsNow.current)
  }, [])
  const guideGeometry = useMemo(() => ({ program: createValueStore<GuideGeometry>(null, sameGeometry), source: createValueStore<GuideGeometry>(null, sameGeometry) }), [])
  const guidePreview = useMemo(() => createValueStore<GuidePreview>(null), [])
  const [guideDialog, setGuideDialog] = useState<GuideDialogState | null>(null)
  const guideSerial = useRef(0)
  const playheadMoves = useCallback(() => moves.current, [])
  const queryNow = useRef<(id: string, params?: Record<string, unknown>) => Promise<unknown>>(async () => null)
  queryNow.current = query
  // The person's `run` for development builds' `filmPreview.run` (the browser tests): the session's
  // `run`, after which the Source monitor reads its clip again for a source command, as `invoke`'s does.
  const personRun = useRef<(id: string, params: Record<string, unknown>) => Promise<string | null>>(async () => null)
  personRun.current = async (id, params) => {
    try {
      return await session.run(id, params)
    } finally {
      if (id.startsWith('source.') || targetsSource(focusedNow.current, params)) void playback.readSource()
    }
  }
  const proxiesRead = useMemo(() => createProxiesRead(() => queryNow.current), [])
  const projectQuery = useMemo(() => shareTurnReads((id, params) => queryNow.current(id, params), new Set(['project.view.get'])), [])
  const seekTicks = useCallback((ticks: number) => (moves.current += 1, runQuietly('playhead.set', { time: Math.max(0, Math.round(ticks)) }).catch(() => undefined)), [runQuietly])
  // The canvas repaints through a run that leaves the playhead where the monitor shows it.
  const repaint = useCallback((ticks: number) => runQuietly('playhead.set', { time: Math.max(0, Math.round(ticks)) }, null, { refresh: 'repaint' }).catch(() => undefined), [runQuietly])
  // Help ▸ Keyboard Shortcuts.
  const [help, setHelp] = useState<HelpTopic | null>(null)
  // The open dialog (upstream's `app.dialog` and drafts; one at a time) and the editor's one preview.
  const [dialog, setDialog] = useState<OpenDialog | null>(null)
  const dialogNow = useRef<OpenDialog | null>(null)
  dialogNow.current = dialog
  const dialogSerial = useRef(0)
  // The program playhead the dialogs' strips read, and its moves (playing, or resting).
  stateForClock.current = state
  const playheadClock = useMemo(() => ({ get: () => playback.programTime() ?? stateForClock.current?.playhead ?? 0, subscribe: playback.subscribeProgramTime }), [playback])
  const previewContext = usePreviewController(session.doc, session.info?.inspected ?? null)
  // The open dialog's own commands, which its OK runs even while its preview stays open (Find, Link Media).
  const byIdNow = useRef(editor.byId)
  byIdNow.current = editor.byId
  previewGate.current ??= createPreviewGate({
    open: () => previewContext.preview.get().open,
    own: () => (dialogNow.current ? new Set([dialogNow.current.spec.id, ...(dialogNow.current.spec.runs ?? [])]) : NO_COMMANDS),
    blocked: () => (dialogNow.current?.spec.previewBlocks ? new Set(dialogNow.current.spec.previewBlocks) : NO_COMMANDS),
    journaled: (id) => byIdNow.current.get(id)?.mutates ?? null,
    message: t('previewBusy'),
  })
  const editRefusal = useCallback((id: string) => previewGate.current?.refusal(id) ?? null, [])
  previewCovers.current = () => {
    const shown = previewContext.preview.get()
    return shown.open && shown.kinds.includes('picture') && previewContext.drawers.drawn('picture')
  }
  const openDialog = useRef<(id: string, params: Record<string, unknown>) => Promise<unknown>>(async () => null)
  /** Development builds: opens a dialog from a spec the flow test makes (a dialog task's preview before its dialog exists). */
  const openSpec = useRef<(spec: DialogSpec) => Promise<void>>(async () => undefined)
  const filmStateNow = useRef(filmState)
  filmStateNow.current = filmState
  // File ▸ Import and File ▸ Export ▸ Media (upstream's file dialogs), read at each call: they use this render's host and session.
  const fileDialog = useRef<(id: string, params: Record<string, unknown>) => Promise<unknown>>(async () => null)
  // Frames shown per second while a clock plays: the program canvas's renders or the Source monitor's draws.
  const countFrame = useCallback(() => stats.frame(), [stats])
  // The workspace (upstream's `ui.dock` and `WorkspacePrefs`): the live frame tree of the one mode
  // this editor has, and the named workspaces in the kit store, shared by every Film page.
  const workspaces = useWorkspaces('film', { mode: 'edit', builtins: WEB_WORKSPACES, fallback: FALLBACK_WORKSPACE, known: WEB_PANEL_IDS })
  const workspacesNow = useRef(workspaces)
  workspacesNow.current = workspaces
  const treeNow = useRef(workspaces.tree)
  treeNow.current = workspaces.tree
  const setTree = useCallback((tree: WorkspaceNode) => {
    treeNow.current = tree
    workspacesNow.current.setTree(tree)
  }, [])
  // The frame maximized by ` or Shift+` (upstream's `keys.maximized`): the tree is kept.
  const [maximized, setMaximizedState] = useState<string | null>(null)
  const maximizedNow = useRef(maximized)
  const setMaximized = useCallback((panel: string | null) => {
    maximizedNow.current = panel
    setMaximizedState(panel)
  }, [])
  const [workspaceDialog, setWorkspaceDialog] = useState<WorkspaceDialog | null>(null)
  // Where the pointer last was, for Maximize Frame Under Cursor.
  const pointer = useRef<{ x: number; y: number } | null>(null)
  useEffect(() => {
    const onMove = (event: PointerEvent) => {
      pointer.current = { x: event.clientX, y: event.clientY }
    }
    window.addEventListener('pointermove', onMove, { passive: true })
    return () => window.removeEventListener('pointermove', onMove)
  }, [])
  const uiState = useRef<ReturnType<typeof useUi>['state'] | null>(null)
  // Every way of choosing a tool (the Tools panel's buttons and flyouts, the keys, `tool.*` from the
  // agent or a menu) comes here: a tool the host denies is never chosen, and the answer says so.
  const chooseTool = useCallback((next: string) => {
    if (uiState.current?.(`tool:${next}`).denied) return false
    setTool(next)
    return true
  }, [])
  // The Timeline's view (zoom, scroll, heights, toggles) outside React, which `invoke`'s view commands change too.
  const timelineView = useMemo(() => createTimelineView('film'), [])
  useEffect(() => () => timelineView.dispose(), [timelineView])
  // The Timeline's thumbnails and peaks: one queue on the engine worker, idle while a clock plays.
  const clocksNow = useRef(clocks)
  clocksNow.current = clocks
  const media = useMemo(() => createTimelineMedia(() => docNow.current, () => clocksNow.current.program.playing || clocksNow.current.source.playing), [])
  // The Project panel's icons and Preview Area: their own cache, asked through the Timeline's queue, so the engine worker serves one frame at a time.
  const projectThumbnails = useMemo<ProjectThumbnails>(
    () =>
      createThumbnails({
        invoke: (name: string, ...args: unknown[]) => (docNow.current ? docNow.current.invoke(name, ...args) : Promise.reject(new Error('no document'))),
        queue: media.queue,
        max: 96,
        decode: frameCanvas,
        release: releaseCanvas,
        prefix: 'project',
      }),
    [media],
  )
  // The Project panel's UI state (search, open bins, bin shown, tabs, rename), kept while another tab is shown.
  const projectUi = useMemo(createProjectUi, [])
  // Another document: empty caches (item ids repeat across documents), and a new Timeline that asks again.
  const [mediaGeneration, setMediaGeneration] = useState(0)
  const mediaDoc = useRef(session.doc)
  useEffect(() => {
    if (mediaDoc.current === session.doc) return
    const had = mediaDoc.current
    mediaDoc.current = session.doc
    if (!had) return
    media.reset()
    projectThumbnails.clear()
    projectUi.reset()
    setMediaGeneration((generation) => generation + 1)
  }, [media, projectThumbnails, projectUi, session.doc])
  useEffect(() => {
    if (!clocks.program.playing && !clocks.source.playing) media.pump()
  }, [media, clocks.program.playing, clocks.source.playing])
  const stateNow = useRef(state)
  stateNow.current = state
  // A floating bin window whose bin is gone (deleted, or not in another document) closes, as
  // upstream's `floating`; the Project panel takes focus when the window had it (`BinWindows`).
  const rootForWindows = state?.root ?? null
  useEffect(() => {
    projectUi.pruneWindows(rootForWindows)
  }, [projectUi, rootForWindows])
  /** The Project panel instance the focus targets: a focused floating bin window's, else the panel's. */
  const projectTarget = () => projectUi.instance(binWindowOf(focusedNow.current))
  const workspaceRoute = useMemo(
    () =>
      createWorkspaceRoute({
        workspaces: () => workspacesNow.current,
        tree: () => treeNow.current,
        setTree,
        focused: () => focusedNow.current,
        setFocused,
        maximized: () => maximizedNow.current,
        setMaximized,
        shown: (panel) => !uiState.current?.(`panel:${panel}`).hidden,
        underCursor: () => panelAt(pointer.current),
        dialog: setWorkspaceDialog,
        focusSearch: focusPanelSearch,
      }),
    [focusedNow, setFocused, setMaximized, setTree],
  )
  // What the Project panel's route (`projectPanel.*`) and its bin opening read and run.
  const projectDeps = useMemo<ProjectRouteDeps>(
    () => ({ ui: projectUi, root: () => stateNow.current?.root ?? null, run: (id, params) => session.run(id, params), query: (id, params) => query(id, params), target: () => binWindowOf(focusedNow.current) }),
    [focusedNow, projectUi, query, session.run],
  )
  /**
   * Upstream's guide routes (`monitor_view.rs` `route`), on the monitor `params.monitor` names, else
   * the focused one: Add Guide… with no position and Save Guides as Template… with no name open
   * their dialogs (Save refuses with no guides); Manage Guides… opens its own; Save with a name,
   * Apply, and Delete read and write the templates in the engine's preferences.
   */
  const guideRoute = useRef<(id: string, params: Record<string, unknown>) => Promise<unknown>>(async () => null)
  guideRoute.current = async (id, params) => {
    const monitor = monitorOf(focusedNow.current, params)
    const open = (dialog: GuideDialogState) => {
      guideSerial.current += 1
      setGuideDialog({ ...dialog, serial: guideSerial.current })
    }
    const named = typeof params.name === 'string' ? params.name : ''
    const missing = () => new Error(phrase('no guide template `{name}`').replace('{name}', named))
    switch (id) {
      case 'view.addGuide': {
        const sequence = stateNow.current
        const frame = monitor === 'program' ? (sequence?.activeSequence != null ? { width: sequence.width, height: sequence.height } : null) : (guideGeometry.source.get()?.frame ?? null)
        open({ kind: 'add', monitor, draft: addGuideDraft(frame), serial: 0 })
        return { dialog: 'addGuide' }
      }
      case 'view.guideTemplates.save': {
        const guides = viewsNow.current[monitor].guides
        if (typeof params.name !== 'string') {
          if (guides.length === 0) throw new Error(phrase('there are no guides to save'))
          open({ kind: 'save', monitor, name: phrase('Guides'), serial: 0 })
          return { dialog: 'saveGuides' }
        }
        if (!named.trim()) throw new Error(phrase('the template needs a name'))
        await guideTemplates.change((list) => saveTemplate(list, named, guides))
        return { saved: named.trim() }
      }
      case 'view.guideTemplates.manage': {
        const list = await guideTemplates.refresh().catch(() => guideTemplates.list())
        open({ kind: 'manage', monitor, serial: 0 })
        return { dialog: 'manageGuides', templates: list.map((template) => template.name) }
      }
      case 'view.guideTemplates.apply': {
        const list = await guideTemplates.refresh().catch(() => guideTemplates.list())
        const template = list.find((each) => each.name === named)
        if (!template) throw missing()
        viewsNow.current = applyGuides(viewsNow.current, monitor, template.guides)
        setViews(viewsNow.current)
        return { monitor, guides: template.guides.length }
      }
      case 'view.guideTemplates.delete': {
        await guideTemplates.change((list) => {
          if (!list.some((template) => template.name === named)) throw missing()
          return deleteTemplates(list, [named])
        })
        return { deleted: named }
      }
      default:
        throw new Error(t('notAvailable'))
    }
  }
  const invoke = useMemo(
    () =>
      createInvoke({
        run: async (id, params, options) => {
          moves.current += 1
          // Delete in Effect Controls removes the effect selected there (upstream `keys.rs`'s
          // `selected_effect`; there the key's binding is the panel-less `project.delete`); in the
          // Timeline, a selected transition cannot be removed on its own (the engine has no such
          // command), so Delete says so instead of acting on nothing.
          if ((id === 'edit.clear' || id === 'edit.rippleDelete' || id === 'project.delete') && Object.keys(params).length === 0) {
            const chosen = localSelection.get()
            if (focusedNow.current === 'effectControls' && chosen.effect) {
              localSelection.set({ effect: null })
              return await session.run('effects.remove', { clip: chosen.effect.clip, index: chosen.effect.index }, null, options)
            }
            if (id !== 'project.delete' && focusedNow.current === 'timeline' && chosen.transition != null && (stateNow.current?.selection.length ?? 0) === 0) throw new Error(t('transition.cannotDelete'))
          }
          // Sequence ▸ Close Gap names no track: the gap the playhead is in (`closeGapTrack`), or why not.
          if (id === 'sequence.closeGap' && params.track === undefined) {
            const film = stateNow.current
            const track = film ? closeGapTrack(film.tracks, film.playhead, film.frame) : null
            if (track == null) throw new Error(t('closeGap.noGap'))
            params = { ...params, track }
          }
          try {
            return await session.run(id, params, null, options)
          } finally {
            // A source command (a step, a mark) may move the source playhead: the Source monitor reads it again.
            if (id.startsWith('source.') || targetsSource(focusedNow.current, params)) void playback.readSource()
          }
        },
        query: (id, params) => query(id, params),
        focused: () => focusedNow.current,
        sourceContext: () => sourceContextNow.current,
        settleSource: playback.settleSource,
        sourceMarkTime: playback.sourceMarkTime,
        // invoke's status says why a command failed: engine or error text.
        status: errorStatus,
        tool: chooseTool,
        workspace: workspaceRoute,
        playback: Object.assign((id: string, params: Record<string, unknown>) => playback.invoke(id, params, focusedNow.current), { serves: playback.serves }),
        timelineView: (id: string, params: Record<string, unknown>) => timelineView.command(id, params, stateNow.current?.playhead ?? 0),
        monitorView: Object.assign(
          (id: string, params: Record<string, unknown>) => {
            // The guide routes that open a dialog or read the templates (Add Guide with a position runs here).
            if (GUIDE_ROUTE.has(id) && !(id === 'view.addGuide' && typeof params.position === 'number')) return guideRoute.current(id, params)
            // Comparison and Set Comparison Reference take the program playhead as the monitor shows it.
            const playhead = Math.round((playback.programTime() ?? playback.restingProgram(stateNow.current?.playhead ?? 0)) * (stateNow.current?.ticksPerSecond ?? TICKS_PER_SECOND))
            const next = monitorViewCommand(viewsNow.current, id, params, focusedNow.current, playhead)
            viewsNow.current = next.views
            setViews(next.views)
            return next.result
          },
          { serves: servesMonitorView },
        ),
        // Upstream's routes: Help's dialogs, and every registry dialog (`dialogs/registry.ts`) a command opens with no params.
        dialog: Object.assign(
          (id: string, params: Record<string, unknown>) => {
            const topic = HELP_TOPICS[id]
            if (!topic) return openDialog.current(id, params)
            setHelp(topic)
            return { dialog: topic }
          },
          { serves: (id: string) => HELP_TOPICS[id] != null || DIALOGS.has(id) },
        ),
        fileDialog: (id: string, params: Record<string, unknown>) => fileDialog.current(id, params),
        projectPanel: createProjectRoute(projectDeps),
        // Begin Text Editing shows the Program monitor first, as upstream's `show_panel`, and waits for it to mount.
        program: async () => {
          if (!programText.current) {
            workspaceRoute('window.panel.program', {})
            // Bounded by time, not by animation frames, which a hidden page does not run.
            const until = performance.now() + 1000
            while (!programText.current && performance.now() < until) await new Promise((done) => window.setTimeout(done, 16))
          } else setFocused('program')
          if (!programText.current) throw new Error(t('notAvailable'))
          return programText.current()
        },
        unavailable: t('notAvailable'),
      }),
    [chooseTool, focusedNow, playback, query, session.run, setFocused, status, errorStatus, t, workspaceRoute, timelineView, projectDeps],
  )

  dialogInvoke.current = (id, params, ask) => invoke(id, params, ask ? { dialog: true } : undefined)

  /** A dialog's reads of the engine's extras (only those `DIALOG_EXTRAS` allows), their JSON parsed. */
  const readExtra = useMemo(() => createReadExtra(() => docNow.current), [])
  // A dialog's query whose failure is the engine's error (upstream's `?`): only a command that does not edit the document.
  const askQuery = useCallback(
    async (id: string, values?: Record<string, unknown>) => {
      const doc = docNow.current
      const command = editor.byId.get(id)
      // Properties' file queries read only, though their group edits (`file.projectManager`, also
      // not journaled, writes files): only those named here, beside the queries that do not edit.
      if (!doc || !command || (!READ_FILE_QUERIES.has(id) && editsDocument(command))) throw new Error(t('notAvailable'))
      return JSON.parse(await doc.execute(id, values ?? {})) as unknown
    },
    [editor.byId, t],
  )
  /**
   * Opens `id`'s dialog, as upstream's routes do: a command the engine cannot run now opens
   * nothing, and the status bar says why (its own reason, read on the scratch session, which
   * changes nothing). The draft is the dialog's `defaults()` for the document as it is.
   */
  useLayoutEffect(() => {
    // Defaults can wait on the Worker. Only the newest dialog request for this
    // document and host configuration may publish the draft it read.
    const beginDialog = (spec: DialogSpec) => {
      const opened = docNow.current
      const inspected = opened?.info.inspected
      const sequence = stateNow.current?.activeSequence
      const configuration = fileIntentEpoch.current
      const serial = ++dialogSerial.current
      const alive = () => dialogSerial.current === serial && docNow.current === opened
        && !documentReplaced(inspected, opened?.info.inspected)
        && (!spec.sequenceBound || stateNow.current?.activeSequence === sequence)
      return {
        serial,
        alive,
        current: () => alive() && fileIntentEpoch.current === configuration,
        captureSubmit: () => {
          const configuration = fileIntentEpoch.current
          return () => alive() && fileIntentEpoch.current === configuration
        },
      }
    }
    openDialog.current = async (id, params) => {
      const spec = DIALOGS.get(id)
      if (!spec) throw new Error(t('notAvailable'))
      const intent = beginDialog(spec)
      const command = editor.byId.get(spec.id)
      const refusal = dialogRefusal(spec, {
        denied: uiState.current?.(`command:${spec.id}`).denied === true,
        readOnly: editor.host.readOnly === true,
        edits: command ? editsDocument(command) : true,
        enabled: editor.enabled(spec.id),
      })
      if (refusal === 'denied') throw new Error(t('notAvailable'))
      if (refusal === 'readOnly') throw new Error(t('viewOnly'))
      if (refusal === 'disabled') {
        // The engine's own reason, read on the scratch session (which changes nothing). A begin
        // that succeeds stays open until the dialog's own begin replaces it: no end is sent, so
        // none can end a dialog's preview opened meanwhile.
        const doc = session.doc
        let reason: string | null = t('notAvailable')
        if (doc && previewsInEngine(spec.preview) && !previewContext.preview.busy()) {
          reason = await doc
            .invoke('previewBegin', spec.id, '{}')
            .then(() => null)
            .catch((error: unknown) => (error instanceof Error ? error.message : String(error)))
        }
        // The engine runs it after all (the menus' states were a step behind): the dialog opens.
        if (reason != null) throw new Error(reason)
      }
      if (!intent.current()) return null
      const ctx: DialogContext = {
        film: stateNow.current,
        session: filmStateNow.current,
        params,
        query: (each, values) => query(each, values),
        ask: askQuery,
        read: readExtra,
        focused: focusedNow.current,
        projectSearch: projectUi.get().search,
        // The bin the Project panel (or the focused floating bin window) shows and its Freeform view's width (Save Arrangement's, upstream's `view_of`).
        projectBin: shownBin(projectTarget().get(), stateNow.current?.root ?? null).bin,
        freeformWidth: projectTarget().get().freeformWidth,
        command: id,
        phrase,
      }
      const draft = await spec.defaults(ctx)
      if (!intent.current()) return null
      setDialog({ spec, draft, ctx, serial: intent.serial, current: intent.alive, captureSubmit: intent.captureSubmit })
      return { dialog: spec.prefix }
    }
    openSpec.current = async (spec) => {
      const problems = specProblems(spec)
      if (problems.length) throw new Error(problems.join('; '))
      const intent = beginDialog(spec)
      const ctx: DialogContext = { film: stateNow.current, session: filmStateNow.current, params: {}, query: (each, values) => query(each, values), read: readExtra, phrase }
      const draft = await spec.defaults(ctx)
      if (!intent.current()) return
      setDialog({ spec, draft, ctx, serial: intent.serial, current: intent.alive, captureSubmit: intent.captureSubmit })
    }
  })
  // A preview's pictures (the Timeline's and the Project panel's) go when it closes.
  useEffect(() => previewContext.preview.subscribe(() => {
    if (!previewContext.preview.get().open) media.closePreview()
  }), [previewContext, media])
  // Development builds: what the flow test reads of the preview and the replica (`tests/flow.mjs` `previewThenCancel`).
  useEffect(() => {
    if (!import.meta.env.DEV) return undefined
    const film = window as unknown as { filmPreview?: unknown }
    film.filmPreview = {
      state: () => previewContext.preview.get(),
      // The person's undo history, as the History panel reads it (the agent's is its own).
      history: () => queryNow.current('history.list'),
      // A command run as the person, through the session's `run` as a menu or a key runs it, but
      // aimed at no monitor unless its params name one (`target`, `monitor`): the browser tests
      // set up and edit as the person, since an agent's `ai/run` acts in an editor state and an
      // undo history of its own (KHP C3b, KitModel 1.1 M12a). Answers the command's result,
      // parsed; throws the engine's refusal.
      run: async (command: string, params: Record<string, unknown> = {}) => {
        const aimed = 'target' in params || 'monitor' in params ? params : { ...params, monitor: 'program' }
        const answer = await personRun.current(command, aimed)
        if (typeof answer !== 'string') return answer
        try {
          return JSON.parse(answer) as unknown
        } catch {
          return answer
        }
      },
      inspect: () => previewContext.preview.inspect(),
      // What the open preview changed, read from the engine whatever its kinds (a picture-only
      // preview reads no diff of its own): the flow checks a frame hold or a field option by it.
      diff: async () => {
        const raw = await previewContext.preview.engine()?.invoke<string>('previewDiff').catch(() => null)
        return typeof raw === 'string' ? (JSON.parse(raw) as unknown) : null
      },
      open: (spec: DialogSpec) => openSpec.current(spec),
      // A read-only query on the open preview's copy (`previewQuery`), its answer as the engine gives it.
      query: (command: string, params: Record<string, unknown>) => previewContext.preview.engine()?.invoke('previewQuery', command, JSON.stringify(params)).catch(() => null) ?? null,
      replica: async () => {
        const bytes = await docNow.current?.replicaVersion?.().catch(() => null)
        return bytes ? Array.from(new Uint8Array(bytes)).join(',') : null
      },
    }
    return () => {
      delete film.filmPreview
    }
  }, [previewContext])

  // Upstream's frame loop (`lib.rs` `drain_events`): a toast shows; a sequence opened restores and
  // brings forward the Timeline; a source opened brings forward the Source monitor where it is
  // docked; Reveal in Project shows the item in the Project panel.
  engineEvents.current = (events) =>
    applyEvents(events, {
      // The engine's own text: translated when the catalog has it, never noted as a missing label.
      toast: (level, message) => toast(level, quietPhrase(message)),
      showTimeline: () => setTree(showPanel(treeNow.current, 'timeline')),
      activate: (panel) => setTree(workspaceTree.activate(treeNow.current, panel)),
      reveal: (item) =>
        void query('project.view.get')
          .catch(() => null)
          .then((view) => {
            projectUi.reveal(item, stateNow.current?.root ?? null, (view as ProjectView | null)?.view.mode !== 'icon' && (view as ProjectView | null)?.view.mode !== 'freeform')
            setTree(showPanel(treeNow.current, 'project'))
            setFocused('project')
          }),
    })

  const exportStart = async () => {
    if (!session.doc || abort.current) return
    const controller = new AbortController()
    abort.current = controller
    const sequence = stateNow.current?.name ?? ''
    setExporting(sequence || null)
    setProgress({ fraction: 0, secondsLeft: null })
    try {
      const written = await exportMovie(session.doc, host, setProgress, controller.signal)
      status(t('exported', { sequence, name: written.split('/').pop() ?? written }))
    } catch (error) {
      if (!controller.signal.aborted) errorStatus(`${t('exportFailed')}: ${error instanceof Error ? error.message : String(error)}`)
    } finally {
      abort.current = null
      setProgress(null)
      setExporting(null)
    }
  }
  useEffect(() => () => abort.current?.abort(), [])

  /**
   * Upstream's `file_dialog`, read by `invoke` at each call. File ▸ Import: the media the person
   * picks through the host join the project, named relative to it, in `params.bin` or the bin
   * the Project panel shows; as upstream, it imports only, and import errors
   * show in the status bar. Get Media File Properties for ▸ File…: the file the person picks shows
   * in Properties (upstream's `menu_dialogs.rs` route). File ▸ Export ▸ Media runs the stepped MP4
   * export. Attach Proxies… and Reconnect Full Resolution Media… link the Project selection's
   * first item to a video file the person picks (upstream's `media_dialogs.rs` route: a file picker,
   * no dialog). Each first asks the engine whether the command can run, as upstream's `execute`
   * does.
   */
  useLayoutEffect(() => {
    fileDialog.current = async (id, params) => {
      const opened = docNow.current
      if (!opened) return null
      const inspected = opened.info.inspected
      const intent = fileIntentEpoch.current
      const current = () => docNow.current === opened && fileIntentEpoch.current === intent && !documentReplaced(inspected, opened.info.inspected)
      if (!editor.enabled(id)) {
        // The engine says why (`command … is not available right now: …`).
        await session.doc?.execute(id, {})
        throw new Error(id === 'file.exportMedia' ? t('exportUnavailable') : t('notAvailable'))
      }
      if (id === 'file.exportMedia') return exportStart()
      if (!canPick) throw new Error(t('notAvailable'))
      const relinks = id === 'media.attachProxies' || id === 'media.reconnectFullRes'
      // The item the Project item menu names, else the selection's first (upstream's route); the
      // menu's selection lands later than its call.
      const item = relinkItem(params, filmStateNow.current?.projectSelection)
      if (relinks) {
        // Upstream asks for the item before it opens the picker; Reconnect needs a proxy (the
        // engine's refusal, asked here before the picker rather than after it).
        if (item == null) throw new Error(phrase('select a clip in the Project panel'))
        const refusal = relinkRefusal(id, await query('media.status', { item }))
        if (!current()) return null
        if (refusal) throw new Error(phrase(refusal))
      }
      const picked = await host.pick('media', relinks ? VIDEO_TYPES : id === 'file.mediaPropertiesFile' ? MEDIA_TYPES : IMPORT_TYPES)
      if (!picked || !current()) return null
      const folder = projectFolder()
      if (relinks) return session.run(id, { item, path: relativePath(folder, picked) })
      if (id === 'file.mediaPropertiesFile') {
        const file = await askQuery(id, { path: relativePath(folder, picked) })
        if (!current()) return null
        return openDialog.current('file.mediaProperties', { properties: [file] })
      }
      // Into the bin the Project panel (or the focused floating bin window) shows, as upstream's `import_bin`, unless the call names one.
      const bin = params.bin ?? shownBin(projectTarget().get(), state?.root ?? null).bin
      const answer = await session.run('file.import', { paths: [relativePath(folder, picked)], ...(bin != null ? { bin } : {}) })
      const result = answer ? (JSON.parse(answer) as { errors?: string[] }) : null
      if (result?.errors?.length) errorStatus(result.errors.join('; '))
      return result
    }
  })

  /**
   * Keys go through upstream's key router, then `invoke`; a key that runs a command is not passed
   * on. A key whose command no part of the editor serves yet is, so the browser's or the system's
   * own key (Cmd+M minimizes) still works. Keys that compose text (an input method) are left alone.
   */
  const keyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (!state || event.nativeEvent.isComposing || event.keyCode === 229) return false
    if (programKeys.current?.(event)) return true
    // A key bound to a command nothing serves yet falls to its next binding (`resolveKey`); a
    // served command runs through `invoke` and keeps the key even when the engine refuses it.
    const id = resolveKey(event, focusedNow.current, keys, (command) => invoke.serves(command))
    if (!id || !invoke.serves(id)) return false
    void invoke(id, {})
    return true
  }

  const video = state?.tracks.filter((track) => track.kind === 'video').length ?? 0
  const audio = state?.tracks.filter((track) => track.kind === 'audio').length ?? 0

  // The Timeline's parts: Close Panel closes the active sequence and keeps the panel, as upstream,
  // and closes the panel only when no sequence is open.
  const invokeNow = useRef(invoke)
  invokeNow.current = invoke
  const parts = useMemo<Readonly<Record<string, PanelParts>>>(
    () => ({
      ...PARTS,
      timeline: {
        render: () => <TimelinePart />,
        strip: (active) => <TimelineStrip active={active} />,
        onClose: () => {
          if (stateNow.current?.activeSequence != null) void invokeNow.current('sequence.close', {})
          else setTree(workspaceTree.closePanel(treeNow.current, 'timeline'))
        },
        afterClose: (close) => <TimelineAfterClose close={close} />,
        menu: (close) => <TimelineMenu close={close} />,
        moreRows: (close) => <TimelineMoreRows close={close} />,
      },
    }),
    [setTree],
  )
  const panels = useMemo(() => filmPanels(phrase, t('notAvailable'), parts), [phrase, t, parts])
  const live: Live = {
    state,
    filmState,
    doc: session.doc,
    playback,
    clocks,
    views,
    setShowTransport,
    guideGeometry,
    guidePreview,
    setGuides,
    status,
    errorStatus,
    editRefusal,
    playheadMoves,
    proxiesRead,
    seekTicks,
    repaint,
    focused,
    setFocused,
    canvas,
    viewMemory,
    stats,
    countFrame,
    invoke,
    query,
    seek,
    labels,
    revision: session.info?.revision ?? null,
    timelineView,
    media,
    mediaGeneration,
    phrase,
    t,
    tool,
    chooseTool,
    programKeys,
    programCovered,
    programText,
    noClips: phrase('No clips yet. Import media to start.'),
    projectUi,
    projectView,
    projectThumbnails,
    projectDeps,
    projectQuery,
    meterFeed,
  }
  // Upstream's title: the project's name, and " - Edited" while it has unsaved changes.
  const title = state ? (session.dirty ? phrase('{name} - Edited').replace('{name}', state.project) : state.project) : ''
  // Upstream's status bar shows the tool's hint while there is no message (`lib.rs` `hint_text`).
  const hint = toolHint(tool, isMac())
  const runWorkspace = (command: string, params: Record<string, unknown>) => invoke(command, params)
  const onMenuInvoke = useCallback((command: string) => void invoke(command, {}), [invoke])
  const menuTabs = useFilmMenuTabs({ labels, shortcuts, workspaces: workspaces.names, state: { workspace: workspaces.current, views, focused }, timelineView, reserved: isReserved, onInvoke: onMenuInvoke, phrase })
  // Home first (its own ribbon; a drop-down panel in Menus), then upstream's menus.
  const homeLabel = t('homeTab')
  // The Focus bar names the active tool: the Tools panel, which shows it otherwise, is not drawn there.
  const toolEntry = FILM_TOOLS.find((each) => each.id === tool)
  const focusTool = useMemo(() => (toolEntry ? { label: phrase(toolEntry.label), icon: toolEntry.icon } : null), [toolEntry, phrase])
  const tabs = useMemo<FrameTab[]>(() => [{ id: 'home', label: homeLabel, ribbon: <HomeTab tool={tool} onTool={chooseTool} onInvoke={onMenuInvoke} /> }, ...menuTabs], [homeLabel, tool, chooseTool, onMenuInvoke, menuTabs])

  return (
    <KitEditorProvider editor={editor}>
      <PreviewContext.Provider value={previewContext}>
      <UiReader into={uiState} />
      <DeniedToolFallback tool={tool} onTool={chooseTool} />
      {/* The whole shell's boundary (menus, header, status bar, dialogs); the workspace has its own inside. */}
      <FaultBoundary place="shell" title={t('error.title')} phrase={phrase} onSave={() => void editor.save()} onFault={playback.stopProgram}>
        <EditorFrame
          tabs={tabs}
          defaultTab="home"
          focusTool={focusTool}
          options={
            <Header
              title={title}
              names={workspaces.names}
              current={workspaces.current}
              onInvoke={(command) => void invoke(command, {})}
              status={status}
              phrase={phrase}
              notAvailable={t('notAvailable')}
            />
          }
          actions={
            <Button variant="ghost" disabled={!state?.duration || progress != null} onClick={() => void invoke('file.exportMedia', {})} data-testid="film-export" data-kit-ui-id="control:appBar.exportMovie">
              {progress ? <Loader2 size={14} className="kui-spin" aria-hidden="true" /> : <Download size={14} aria-hidden="true" />}
              {t('exportMovie')}
            </Button>
          }
          canvas={canvas}
          onKeyDown={keyDown}
          // A click anywhere on the status bar clears the message, as upstream's (`lib.rs`: the whole bar is one click target).
          onStatusClick={() => setMessage(null)}
          hiddenCommands={isHiddenCommand}
          status={
            state ? (
              <>
                {/* Upstream's left side: the message, else the tool's hint, on one line (a long one is cut with an ellipsis). */}
                <span className="film-message" data-kit-ui-id="control:status.message" data-testid={message ? 'film-message' : hint ? 'film-hint' : 'film-status-empty'} title={message ? message.text : hint ? phrase(hint) : undefined}>
                  {message ? message.text : hint ? phrase(hint) : null}
                </span>
                <span className="film-status-summary" data-testid="film-status">
                  {t('summary', { width: state.width, height: state.height, fps: Number.isInteger(state.fps) ? state.fps : state.fps.toFixed(3), video, audio })}
                </span>
              </>
            ) : null
          }
          statusEnd={
            <>
              {progress ? (
                <StatusJob progress={progress} subject={exporting} onCancel={() => abort.current?.abort()} phrase={phrase} />
              ) : job ? (
                <StatusJob progress={{ fraction: jobStatus(job, phrase).fraction, secondsLeft: job.etaSeconds }} verb={jobStatus(job, phrase).verb} onCancel={() => cancelJob(job.id)} phrase={phrase} />
              ) : null}
              <StatsReadout stats={stats} openMs={session.openMs} playing={clocks.program.playing || clocks.source.playing} t={t} />
            </>
          }
        >
          <FaultBoundary place="workspace" title={t('error.title')} phrase={phrase} onSave={() => void editor.save()} onFault={playback.stopProgram}>
            <LiveContext.Provider value={live}>
              <FocusProgram>
              {/* The floating bin windows stay inside the workspace's area, over its frames. */}
              <div className="film-workspace-area">
                <WorkspaceLayout
                  tree={workspaces.tree}
                  onTree={setTree}
                  panels={panels}
                  focused={focused}
                  onFocus={setFocused}
                  maximized={maximized}
                  onMaximized={setMaximized}
                  onRestore={() => void invoke('window.workspace.reset', {})}
                  testId="film-workspace"
                />
                <BinWindows />
              </div>
              </FocusProgram>
            </LiveContext.Provider>
          </FaultBoundary>
          {workspaceDialog ? (
            <WorkspaceDialogs
              dialog={workspaceDialog}
              names={workspaces.names}
              saved={workspaces.saved}
              isBuiltin={workspaces.isBuiltin}
              run={runWorkspace}
              onClose={() => setWorkspaceDialog(null)}
              phrase={phrase}
            />
          ) : null}
          {help ? <HelpDialog topic={help} reserved={isReserved} onClose={() => setHelp(null)} /> : null}
          {guideDialog ? (
            <GuideDialogs
              dialog={guideDialog}
              views={views}
              templates={guideTemplates}
              preview={guidePreview}
              run={(id, params) => invoke(id, params, { throws: true })}
              applyGuides={(monitor, guides) => {
                viewsNow.current = applyGuides(viewsNow.current, monitor, guides)
                setViews(viewsNow.current)
              }}
              onClose={() => setGuideDialog((shown) => (shown === guideDialog ? null : shown))}
              t={t}
              phrase={phrase}
            />
          ) : null}
          {dialog ? (
            <DialogHost
              key={dialog.serial}
              open={dialog}
              film={state}
              revision={session.info?.revision ?? null}
              viewRefresh={projectView}
              session={filmState}
              documentInspect={session.doc?.info.inspected ?? null}
              playhead={playheadClock}
              invoke={(id, params, options) => invoke(id, params ?? {}, options)}
              pick={(kind, types) => (canPick ? host.pick(kind, [...types]).then((picked) => (picked ? relativePath(projectFolder(), picked) : null)) : Promise.resolve(null))}
              onClose={() => setDialog((shown) => (shown === dialog ? null : shown))}
              status={status}
              t={t}
              phrase={phrase}
            />
          ) : null}
        </EditorFrame>
      </FaultBoundary>
      </PreviewContext.Provider>
    </KitEditorProvider>
  )
}
