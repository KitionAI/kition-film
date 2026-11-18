// Makes public/sample/films/Sample.kfilm with the engine itself: clips/bars.mp4 on V1, named
// relative to the project ("../clips/bars.mp4"), as the development host lends public/sample/.
import fs from 'node:fs/promises'
import fsSync from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const web = fileURLToPath(new URL('..', import.meta.url))
const films = path.join(web, 'public/sample/films')
// Lent files, the way a host's engine worker reads them.
Object.assign(globalThis, {
  kitionHost: {
    size: (file) => fsSync.statSync(path.join(films, file)).size,
    readRange: (file, offset, length) => new Uint8Array(fsSync.readFileSync(path.join(films, file)).subarray(offset, offset + length)),
  },
})
const engine = await import(pathToFileURL(`${web}public/engine/kition_film_kit.js`).href)
await engine.default({ module_or_path: await fs.readFile(`${web}public/engine/kition_film_kit_bg.wasm`) })
const doc = engine.FilmDocument.create('Sample.kfilm', 1280, 720)
const imported = JSON.parse(doc.execute('file.import', JSON.stringify({ paths: ['../clips/bars.mp4'] })))
doc.execute('timeline.place', JSON.stringify({ item: imported.items[0], track: 'V1', seconds: 0 }))
await fs.writeFile(path.join(films, 'Sample.kfilm'), doc.save())
console.log('wrote public/sample/films/Sample.kfilm')
