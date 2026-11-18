// Every stage runs once. Logs survive a later browser failure and the runner propagates failures.
import { spawn } from 'node:child_process'
import { mkdirSync, createWriteStream, writeFileSync, readFileSync, readdirSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const web = fileURLToPath(new URL('..', import.meta.url))
const repo = path.dirname(web)
// A local isolated UI checkout may reuse an identical native checkout's build cache.
// CI uses its own repository by default. Refuse a different Rust source tree.
const nativeRepo = process.env.FILM_CARGO_ROOT ? path.resolve(process.env.FILM_CARGO_ROOT) : repo
function nativeSource(root) {
  const hash = createHash('sha256')
  const visit = relative => {
    const absolute = path.join(root, relative)
    for (const entry of readdirSync(absolute, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      if (['target', '.git'].includes(entry.name)) continue
      const next = path.join(relative, entry.name)
      if (entry.isDirectory()) visit(next)
      else if (entry.isFile()) { hash.update(next); hash.update('\0'); hash.update(readFileSync(path.join(root, next))) }
    }
  }
  for (const file of ['Cargo.toml', 'Cargo.lock', 'kit.json']) { hash.update(file); hash.update(readFileSync(path.join(root, file))) }
  for (const directory of ['crates', 'bindings', 'tools/xtask', '.cargo', 'assets']) visit(directory)
  return hash.digest('hex')
}
const nativeSha256 = nativeSource(repo)
if (nativeRepo !== repo && nativeSource(nativeRepo) !== nativeSha256) throw new Error('FILM_CARGO_ROOT must contain identical Rust sources, manifests, and Cargo configuration')
const output = path.join(web, 'test-results', 'ci')
mkdirSync(output, { recursive: true })
const full = process.argv.includes('--full')
const stages = [
  ['format', 'cargo', ['fmt', '--all', '--check'], nativeRepo],
  ['layers', 'cargo', ['xtask', 'layers'], nativeRepo],
  ['assets', 'cargo', ['xtask', 'assets'], nativeRepo],
  ['build', 'pnpm', ['build'], web],
  ['unit', 'pnpm', ['test:unit'], web],
  ['parity', 'pnpm', ['test:parity'], web],
  ...(full ? [['clippy', 'cargo', ['clippy', '--locked', '--workspace', '--all-targets', '--', '-D', 'warnings'], nativeRepo]] : []),
  ['engine', 'cargo', full
    ? ['test', '--locked', '--workspace', '--no-fail-fast', '--', '--show-output']
    : ['test', '--locked', '-p', 'kition-film-time', '-p', 'kition-film-edit', '-p', 'kition-film-engine', '-p', 'kition-film-kit', '--', '--show-output'], nativeRepo],
  ['browser', 'pnpm', ['exec', 'playwright', 'test', ...(full ? [] : ['--project=chromium'])], web],
  ...(full ? [
    ['modes', 'pnpm', ['test:modes'], web],
    ['flow-chromium', 'node', ['tests/flow.mjs', 'chromium'], web],
    ['flow-webkit', 'node', ['tests/flow.mjs', 'webkit'], web],
  ] : []),
]
const results = []
for (const [name, command, args, cwd] of stages) {
  console.log(`\n[film-ci] ${name}: ${command} ${args.join(' ')}`)
  const started = Date.now()
  const log = createWriteStream(path.join(output, `${name}.log`))
  const code = await new Promise(resolve => {
    const child = spawn(command, args, { cwd, env: process.env, stdio: ['ignore', 'pipe', 'pipe'] })
    child.stdout.on('data', data => { process.stdout.write(data); log.write(data) })
    child.stderr.on('data', data => { process.stderr.write(data); log.write(data) })
    child.on('error', error => { log.write(`${error.stack}\n`); console.error(error); resolve(1) })
    child.on('close', code => resolve(code ?? 1))
  })
  await new Promise(resolve => log.end(resolve))
  results.push({ name, code, seconds: (Date.now() - started) / 1000 })
  writeFileSync(path.join(output, 'stages.json'), JSON.stringify({ full, repo, nativeRepo, nativeSha256, results }, null, 2) + '\n')
  writeFileSync(path.join(output, 'stages.xml'), `<?xml version="1.0" encoding="UTF-8"?>\n<testsuite name="Film CI stages" tests="${results.length}" failures="${results.filter(result => result.code !== 0).length}">${results.map(result => `<testcase name="${result.name}" time="${result.seconds}">${result.code ? `<failure message="Exit ${result.code}; see ${result.name}.log"/>` : ''}</testcase>`).join('')}</testsuite>\n`)
  if (code !== 0) process.exit(code)
}
