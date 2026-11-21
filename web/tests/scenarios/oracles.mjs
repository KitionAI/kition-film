// Playwright's global setup: the scenarios decode what the editor exports with FFmpeg, an external
// test oracle that is never linked or shipped (AGENTS.md section 2). `KITION_FILM_FFMPEG` (and
// `KITION_FILM_FFPROBE`) name it, else `ffmpeg` on the PATH. On CI (`CI` set) with neither, the
// pinned static build the Rust oracle tests are kept green against is fetched once, checked against
// its digest, and named for the test workers; elsewhere nothing is fetched.
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const BUILD = 'ffmpeg-n9.0.2-39-g7adfbe40dc-linux64-gpl-9.0'
const URL_ = `https://github.com/BtbN/FFmpeg-Builds/releases/download/autobuild-2026-10-31-12-59/${BUILD}.tar.xz`
const SHA256 = '73e29a56974ae5a651133a04584c7483b21afe941e17dc91d79814a758b608d3'

const runs = (tool) => {
  try {
    execFileSync(tool, ['-hide_banner', '-version'], { stdio: 'ignore', timeout: 30_000 })
    return true
  } catch {
    return false
  }
}

export default async function oracles() {
  if (process.env.KITION_FILM_FFMPEG || runs('ffmpeg') || !process.env.CI || process.platform !== 'linux' || process.arch !== 'x64') return
  const cache = fileURLToPath(new URL('../../node_modules/.cache/kition-film-oracles/', import.meta.url))
  const bin = path.join(cache, BUILD, 'bin')
  if (!existsSync(path.join(bin, 'ffmpeg'))) {
    mkdirSync(cache, { recursive: true })
    const response = await fetch(URL_)
    if (!response.ok) throw new Error(`FFmpeg oracle download failed: ${response.status} ${URL_}`)
    const bytes = Buffer.from(await response.arrayBuffer())
    const digest = createHash('sha256').update(bytes).digest('hex')
    if (digest !== SHA256) throw new Error(`FFmpeg oracle digest ${digest}, expected ${SHA256}`)
    const archive = path.join(cache, `${BUILD}.tar.xz`)
    writeFileSync(archive, bytes)
    execFileSync('tar', ['-xJf', archive, '-C', cache], { stdio: 'inherit' })
  }
  process.env.KITION_FILM_FFMPEG = path.join(bin, 'ffmpeg')
  process.env.KITION_FILM_FFPROBE = path.join(bin, 'ffprobe')
  execFileSync(process.env.KITION_FILM_FFMPEG, ['-hide_banner', '-version'], { stdio: 'inherit' })
}
