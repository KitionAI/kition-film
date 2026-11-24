import type { KitModuleManifest } from '@kition/sdk/editor'

/** The engine, from this package's own folder. */
export function engineManifest(): KitModuleManifest {
  return {
    kitId: 'kit.film',
    base: new URL('./engine/', document.baseURI).href,
    module: 'kition_film_kit',
    documentClass: 'FilmDocument',
    // The web build embeds no CJK face, so Chinese titles drew as boxes: the engine is given this
    // one (`addFont`) before a document opens (build-engine.sh copies it from kition-fonts). A
    // missing file is skipped, and those characters stay boxes.
    fonts: [new URL('./fonts/DroidSansFallbackFull.ttf', document.baseURI).href],
  }
}
