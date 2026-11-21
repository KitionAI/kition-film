import type { KitModuleManifest } from '@kition/sdk/editor'

/** The engine, from this package's own folder. */
export function engineManifest(): KitModuleManifest {
  return {
    kitId: 'kit.film',
    base: new URL('./engine/', document.baseURI).href,
    module: 'kition_film_kit',
    documentClass: 'FilmDocument',
  }
}
