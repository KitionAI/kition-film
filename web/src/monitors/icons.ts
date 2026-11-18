import { TesseraIcons, type IconComponent } from '@kition/kit-editor'
import type { TransportEntry } from './model'

const Bookmark = TesseraIcons.BookmarkIcon
const Camera = TesseraIcons.CameraIcon
const Layers = TesseraIcons.LayersIcon
const Pause = TesseraIcons.PauseIcon
const Play = TesseraIcons.PlayIcon
const StepBack = TesseraIcons.StepBackIcon
const StepForward = TesseraIcons.StepForwardIcon

// The transport glyphs upstream draws itself (`icons.rs`), redrawn as Tessera tool icons.
const MarkIn = TesseraIcons.MarkInIcon
const MarkOut = TesseraIcons.MarkOutIcon
const GoToIn = TesseraIcons.GoToInIcon
const GoToOut = TesseraIcons.GoToOutIcon
const Insert = TesseraIcons.ClipInsertIcon
const Overwrite = TesseraIcons.ClipOverwriteIcon
const Lift = TesseraIcons.ClipLiftIcon
const Extract = TesseraIcons.ClipExtractIcon

const ICONS: Readonly<Record<TransportEntry['icon'], IconComponent>> = {
  marker: Bookmark,
  markIn: MarkIn,
  markOut: MarkOut,
  goToIn: GoToIn,
  stepBack: StepBack,
  play: Play,
  stepForward: StepForward,
  goToOut: GoToOut,
  insert: Insert,
  overwrite: Overwrite,
  lift: Lift,
  extract: Extract,
  camera: Camera,
  proxy: Layers,
}

/** A transport button's icon; the play button shows Pause while its clock plays. */
export function transportIcon(icon: TransportEntry['icon'], playing: boolean): IconComponent {
  return icon === 'play' && playing ? Pause : ICONS[icon]
}
