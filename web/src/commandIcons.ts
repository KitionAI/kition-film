/**
 * Tessera icons for the Film engine's commands that kit-editor's rules cannot read (they draw
 * the neutral command mark otherwise): its own vocabulary, by command id. Registered once, when the
 * editor loads (`main.tsx`); ribbons and menus built from engine commands draw them.
 */
import { TesseraIcons, registerCommandIcons } from '@kition/kit-editor'

registerCommandIcons({
  "effects.setDefaultTransition": TesseraIcons.StarIcon,
  "export.quick": TesseraIcons.ZapIcon,
  "help.systemReport": TesseraIcons.ClipboardListIcon,
  "color.setInputLut": TesseraIcons.SwatchBookIcon,
  "color.setLook": TesseraIcons.ApertureIcon,
  "shortcuts.registerExternal": TesseraIcons.KeyboardIcon,
  "transcript.downloadModel": TesseraIcons.DownloadIcon,
  "transcript.generate": TesseraIcons.CaptionsIcon,
})
