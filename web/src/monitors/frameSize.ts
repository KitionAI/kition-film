// Pure, so `node --test` runs it.

/** The widest picture `itemFrame` gives (its `maxWidth` cap); wider monitors scale it up. */
const MAX_FRAME_WIDTH = 2048
/** The most pixels `itemFrame` gives (the engine's cap); a larger monitor scales the picture up. */
const MAX_FRAME_PIXELS = 4_194_304

/** The width to ask `itemFrame` for: the drawn width × device scale, within the engine's width and pixel caps for a picture of `aspect` (height / width). */
export function frameWidth(cssWidth: number, scale: number, aspect: number | null) {
  const byPixels = aspect && aspect > 0 ? Math.floor(Math.sqrt(MAX_FRAME_PIXELS / aspect)) : MAX_FRAME_WIDTH
  return Math.max(1, Math.min(MAX_FRAME_WIDTH, byPixels, Math.round(cssWidth * scale)))
}
