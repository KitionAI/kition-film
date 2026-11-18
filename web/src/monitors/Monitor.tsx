import { useState, useSyncExternalStore, type ReactNode, type Ref } from 'react'
import { TesseraIcons } from '@kition/kit-editor'
import { FrameChrome, MenuButton, MenuItem, MenuSeparator, SubMenu, TimecodeField, TransportBar, formatTimecode, useUi, type Phrases, type TransportButton } from '@kition/kit-editor'
import { TICKS_PER_SECOND } from '../film'
import { RESOLUTIONS, ZOOMS, type MonitorView, type Resolution } from './monitorView'
import type { DisplayMode } from './displayModes'
import { PROGRAM_TRANSPORT, SOURCE_TRANSPORT, monitorSpan, shownDuration, transportAction, zoomLabel, type Rate, type Span, type TransportEntry, type Which } from './model'
import { transportIcon } from './icons'
import { MiniTimeline, type MiniMarker, type RangeChange } from './MiniTimeline'


const ChevronDown = TesseraIcons.ChevronDownIcon
const Plus = TesseraIcons.PlusIcon
const Wrench = TesseraIcons.WrenchIcon

/** A monitor's playhead in ticks, read per animation frame while its clock plays (`useSyncExternalStore`). */
export type MonitorClock = { subscribe: (listener: () => void) => () => void; get: () => number }

/** The marks and span a monitor shows, in ticks (`source.inspect`, or the sequence). */
export type MonitorMarks = { start: number; end: number; markIn: number | null; markOut: number | null }

const RESOLUTION_KEYS = Object.keys(RESOLUTIONS) as Resolution[]

/** A menu row the host may hide or disable by its Kit UI id (`disabled`: a row no part of the editor serves yet). */
function Row({ uiId, label, checked, disabled, onSelect, testId }: { uiId: string; label: string; checked?: boolean; disabled?: boolean; onSelect: () => void; testId: string }) {
  const state = useUi().state(uiId)
  if (state.hidden) return null
  return <MenuItem label={label} checked={checked} disabled={state.disabled || disabled} uiId={uiId} testId={testId} onSelect={() => !state.denied && onSelect()} />
}

/** The wrench's RGBA Channels submenu (`wrench_items`). */
const CHANNELS: ReadonlyArray<readonly [DisplayMode, string]> = [
  ['alpha', 'Alpha'],
  ['red', 'Red'],
  ['green', 'Green'],
  ['blue', 'Blue'],
]

/**
 * The wrench's guide rows (`wrench_items`): Show Rulers and Show Guides; Lock Guides and Clear
 * Guides once the monitor has guides; and on the Program monitor, Snap in Program Monitor.
 */
const GUIDE_ROWS: ReadonlyArray<readonly [string, string]> = [
  ['showRulers', 'Show Rulers'],
  ['showGuides', 'Show Guides'],
]

/** The playhead timecode (upstream's accent timecode at the row's left): it renders per frame alone; typing or dragging seeks. */
function PlayheadTimecode({ clock, fps, dropFrame, label, testId, onSeek }: { clock: MonitorClock; fps: number; dropFrame: boolean; label: string; testId: string; onSeek: (ticks: number, final: boolean) => void }) {
  const ticks = useSyncExternalStore(clock.subscribe, clock.get)
  return (
    <TimecodeField
      value={ticks / TICKS_PER_SECOND}
      fps={fps}
      dropFrame={dropFrame}
      accent
      label={label}
      uiId="control:monitor.timecode"
      testId={testId}
      onChange={(seconds, final) => onSeek(Math.round(seconds * TICKS_PER_SECOND), final)}
    />
  )
}

/** A dropdown's button: its value and a chevron (upstream `widgets::dropdown_text`). */
function Dropdown({ text, label, uiId, testId, open, toggle }: { text: string; label: string; uiId: string; testId: string; open: boolean; toggle: () => void }) {
  const state = useUi().state(uiId)
  if (state.hidden) return null
  return (
    <button type="button" className="film-monitor-dropdown" title={label} aria-label={label} aria-haspopup="menu" aria-expanded={open} disabled={state.disabled} data-kit-ui-id={uiId} data-testid={testId} onClick={toggle}>
      <span>{text}</span>
      <ChevronDown size={12} aria-hidden="true" />
    </button>
  )
}

export type MonitorProps = {
  which: Which
  /** The monitor's root element (a panel that draws a preview says where it is, for the dialog's occlusion). */
  rootRef?: Ref<HTMLDivElement>
  view: MonitorView
  marks: MonitorMarks
  rate: Rate
  fps: number
  dropFrame: boolean
  markers: readonly MiniMarker[]
  clock: MonitorClock
  playing: boolean
  looping: boolean
  proxies: boolean
  /** Whether the marked range can be dragged (a subclip's cannot; the Program's needs its marks). */
  editable: boolean
  /** The item the marks belong to and the engine's revision (a range drag holds while both do). */
  item: number | null
  revision: number | null
  /** The magnification shown when the picture was zoomed another way (the wheel), in place of the view's. */
  zoomShown?: number | null
  /** The picture area's content. */
  picture: ReactNode
  /** Between the zoom and resolution dropdowns (the Source monitor's drag buttons). */
  middle?: ReactNode
  phrase: Phrases
  /** Runs a command through the session's `invoke`. */
  invoke: (id: string, params?: Record<string, unknown>) => unknown
  /** Moves the monitor's playhead: while scrubbing (`final` false) and once at the end. */
  onSeek: (ticks: number, final: boolean) => void
  /** End an interrupted scrub without sending a final seek. */
  onCancelSeek: () => void
  /** A Source transport button that moves the source playhead (`source_nav`). */
  onSourceNav?: (seek: 'goIn' | 'goOut' | 'stepBack' | 'stepFwd') => void
  /** A marked range dragged and released (`source_range::interact`); its start stops the monitor's clock. */
  onRange: (change: RangeChange) => void
  onShowTransport: (show: boolean) => void
}

/**
 * Upstream's monitor (`panels/monitor.rs` `show`), shared by Source and Program: the picture
 * area, the row with the playhead timecode, the magnification and playback resolution dropdowns,
 * the wrench menu, and the duration (or In to Out); the scrub bar (`mini_timeline`); and the
 * transport buttons, centred, with the Button Editor at the right. Every command runs through
 * `invoke` with `monitor` set, so the Source monitor's are Source-targeted.
 */
export function Monitor(props: MonitorProps) {
  const { which, view, marks, rate, fps, dropFrame, markers, clock, playing, looping, proxies, editable, picture, middle, phrase, invoke, zoomShown } = props
  const zoom = zoomShown !== undefined ? zoomShown : view.zoom
  // A range being dragged shows in place of the marks (`source_range::preview_for`), in the duration too.
  const [draft, setDraft] = useState<Span | null>(null)
  const span = monitorSpan(which, marks, rate, draft)
  const params = { monitor: which }
  const rows = which === 'source' ? SOURCE_TRANSPORT : PROGRAM_TRANSPORT
  const press = (entry: TransportEntry) => {
    const action = transportAction(which, entry.key)
    if ('disabled' in action) return
    if ('seek' in action) props.onSourceNav?.(action.seek)
    else void invoke(action.command, action.params)
  }
  const buttons: TransportButton[] = rows.map((entry) => ({
    id: entry.key,
    label: phrase(entry.label),
    icon: transportIcon(entry.icon, playing),
    large: entry.icon === 'play',
    pressed: entry.icon === 'play' ? playing : entry.key === 'media.toggleProxies' ? proxies : undefined,
    // Export Frame opens upstream's frame export dialog, which comes in wave 3.
    disabled: entry.key === 'exportFrame',
    uiId: entry.uiId,
    onPress: () => press(entry),
  }))
  const testId = `film-${which}`
  return (
    <div ref={props.rootRef} className="film-monitor" data-monitor={which} data-testid={`film-monitor-${which}`}>
      <div className="film-monitor-picture-area">{picture}</div>
      {/* Focus shows the picture alone: the row, the scrub bar, and the transport are the monitor's bars. */}
      <FrameChrome>
      <div className="film-monitor-row">
        <PlayheadTimecode clock={clock} fps={fps} dropFrame={dropFrame} label={phrase('Timecode')} testId={which === 'program' ? 'film-timecode' : 'film-source-time'} onSeek={props.onSeek} />
        <MenuButton trigger={({ open, toggle }) => <Dropdown text={phrase(zoomLabel(zoom))} label={phrase('Select Zoom Level')} uiId="control:monitor.zoom" testId={`${testId}-zoom`} open={open} toggle={toggle} />}>
          <Row uiId="control:view.magnification.fit" label={phrase('Fit')} checked={zoom == null} testId={`${testId}-zoom-fit`} onSelect={() => void invoke('view.magnification.fit', params)} />
          <MenuSeparator />
          {ZOOMS.map(([level, factor]) => (
            <Row key={level} uiId={`control:view.magnification.${level}`} label={`${level}%`} checked={zoom === factor} testId={`${testId}-zoom-${level}`} onSelect={() => void invoke(`view.magnification.${level}`, params)} />
          ))}
        </MenuButton>
        <span className="film-monitor-middle">{middle}</span>
        <MenuButton align="end" trigger={({ open, toggle }) => <Dropdown text={phrase(RESOLUTIONS[view.res].label)} label={phrase('Select Playback Resolution')} uiId="control:monitor.resolution" testId={`${testId}-resolution`} open={open} toggle={toggle} />}>
          {RESOLUTION_KEYS.map((res) => (
            <Row key={res} uiId={`control:view.playbackRes.${res}`} label={phrase(RESOLUTIONS[res].label)} checked={view.res === res} testId={`${testId}-resolution-${res}`} onSelect={() => void invoke(`view.playbackRes.${res}`, params)} />
          ))}
        </MenuButton>
        <MenuButton align="end" trigger={({ open, toggle }) => <WrenchButton label={phrase('Settings')} testId={`${testId}-settings`} open={open} toggle={toggle} />}>
          <Row uiId="control:view.display.composite" label={phrase('Composite Video')} checked={view.display === 'composite'} testId={`${testId}-settings-display-composite`} onSelect={() => void invoke('view.display.composite', params)} />
          <SubMenu label="RGBA Channels" path="RGBA Channels" uiId="control:monitor.settings.rgbaChannels" testId={`${testId}-settings-rgba`}>
            {CHANNELS.map(([mode, label]) => (
              <Row key={mode} uiId={`control:view.display.${mode}`} label={phrase(label)} checked={view.display === mode} testId={`${testId}-settings-display-${mode}`} onSelect={() => void invoke(`view.display.${mode}`, params)} />
            ))}
          </SubMenu>
          {which === 'program' ? (
            <Row uiId="control:view.display.comparison" label={phrase('Comparison View')} checked={view.display === 'comparison'} testId={`${testId}-settings-display-comparison`} onSelect={() => void invoke('view.display.comparison', params)} />
          ) : (
            <>
              <Row uiId="control:view.display.audioWaveform" label={phrase('Audio Waveform')} checked={view.display === 'audioWaveform'} testId={`${testId}-settings-display-audioWaveform`} onSelect={() => void invoke('view.display.audioWaveform', params)} />
              <Row uiId="control:view.display.videoAndWaveform" label={phrase('Video and Audio Waveform Split')} checked={view.display === 'videoAndWaveform'} testId={`${testId}-settings-display-videoAndWaveform`} onSelect={() => void invoke('view.display.videoAndWaveform', params)} />
            </>
          )}
          <MenuSeparator />
          <SubMenu label="Playback Resolution" path="View/Playback Resolution">
            {RESOLUTION_KEYS.map((res) => (
              <Row key={res} uiId={`control:view.playbackRes.${res}`} label={phrase(RESOLUTIONS[res].label)} checked={view.res === res} testId={`${testId}-settings-playbackRes-${res}`} onSelect={() => void invoke(`view.playbackRes.${res}`, params)} />
            ))}
          </SubMenu>
          <SubMenu label="Paused Resolution" path="View/Paused Resolution">
            {RESOLUTION_KEYS.map((res) => (
              <Row key={res} uiId={`control:view.pausedRes.${res}`} label={phrase(RESOLUTIONS[res].label)} checked={view.pausedRes === res} testId={`${testId}-settings-pausedRes-${res}`} onSelect={() => void invoke(`view.pausedRes.${res}`, params)} />
            ))}
          </SubMenu>
          <Row uiId="control:view.highQualityPlayback" label={phrase('High Quality Playback')} checked={view.highQuality} testId={`${testId}-settings-highQuality`} onSelect={() => void invoke('view.highQualityPlayback', params)} />
          <MenuSeparator />
          {GUIDE_ROWS.map(([key, label]) => (
            <Row key={key} uiId={`control:view.${key}`} label={phrase(label)} checked={key === 'showRulers' ? view.showRulers : view.showGuides} testId={`${testId}-settings-${key}`} onSelect={() => void invoke(`view.${key}`, params)} />
          ))}
          {view.guides.length > 0 ? (
            <>
              <Row uiId="control:view.lockGuides" label={phrase('Lock Guides')} checked={view.lockGuides} testId={`${testId}-settings-lockGuides`} onSelect={() => void invoke('view.lockGuides', params)} />
              <Row uiId="control:view.clearGuides" label={phrase('Clear Guides')} testId={`${testId}-settings-clearGuides`} onSelect={() => void invoke('view.clearGuides', params)} />
            </>
          ) : null}
          {which === 'program' ? <Row uiId="control:view.snapInProgramMonitor" label={phrase('Snap in Program Monitor')} checked={view.snap} testId={`${testId}-settings-snapInProgramMonitor`} onSelect={() => void invoke('view.snapInProgramMonitor', params)} /> : null}
          <MenuSeparator />
          <Row uiId="control:view.safeMargins" label={phrase('Safe Margins')} checked={view.safeMargins} testId={`${testId}-settings-safeMargins`} onSelect={() => void invoke('view.safeMargins', params)} />
          <Row uiId="control:monitor.showTransport" label={phrase('Show Transport Controls')} checked={view.showTransport} testId={`${testId}-settings-showTransport`} onSelect={() => props.onShowTransport(!view.showTransport)} />
          {which === 'source' ? (
            <Row uiId="control:source.settings.loop" label={phrase('Loop marked range')} checked={looping} testId={`${testId}-settings-loop`} onSelect={() => void invoke('playback.loop', params)} />
          ) : (
            <>
              <MenuSeparator />
              {/* Upstream's checkbox shows and hides the scopes (`app.ui.show_scopes`); here it opens the panel, which Task 30 builds. */}
              <Row uiId="control:window.panel.Scopes" label={phrase('Scopes')} testId={`${testId}-settings-scopes`} onSelect={() => void invoke('window.panel.Scopes', {})} />
              <Row uiId="control:monitor.loop" label={phrase('Loop')} checked={looping} testId={`${testId}-settings-loop`} onSelect={() => void invoke('playback.loop', params)} />
            </>
          )}
        </MenuButton>
        <span className="film-monitor-duration" data-testid={`${testId}-duration`}>
          {formatTimecode(shownDuration(span) / TICKS_PER_SECOND, fps, dropFrame)}
        </span>
      </div>
      <MiniTimeline
        which={which}
        span={span}
        marks={marks}
        markers={markers}
        clock={clock}
        editable={editable}
        item={props.item}
        revision={props.revision}
        phrase={phrase}
        onSeek={props.onSeek}
        onCancelSeek={props.onCancelSeek}
        onDraft={setDraft}
        onRange={props.onRange}
      />
      {view.showTransport ? (
        <div className="film-monitor-transport">
          <TransportBar buttons={buttons} testId={`${testId}-transport`} />
          <ButtonEditor label={phrase('Button Editor')} />
        </div>
      ) : null}
      </FrameChrome>
    </div>
  )
}

/** The wrench (upstream's `Settings`): the monitor's view options. */
function WrenchButton({ label, testId, open, toggle }: { label: string; testId: string; open: boolean; toggle: () => void }) {
  const state = useUi().state('control:monitor.settings')
  if (state.hidden) return null
  return (
    <button type="button" className="film-monitor-wrench" title={label} aria-label={label} aria-haspopup="menu" aria-expanded={open} disabled={state.disabled} data-kit-ui-id="control:monitor.settings" data-testid={testId} onClick={toggle}>
      <Wrench size={14} aria-hidden="true" />
    </button>
  )
}

/** Upstream's "+" Button Editor at the transport row's right, which upstream draws without an action yet: drawn, and disabled. */
function ButtonEditor({ label }: { label: string }) {
  const state = useUi().state('control:transport.buttonEditor')
  if (state.hidden) return null
  return (
    <button type="button" className="film-monitor-button-editor" title={label} aria-label={label} disabled data-kit-ui-id="control:transport.buttonEditor">
      <Plus size={13} aria-hidden="true" />
    </button>
  )
}
