// The key router, as upstream's `menus.rs` `bindings` and `lib.rs` `handle_shortcuts`: the engine's
// shortcut set plus upstream's UI commands, most modifiers first, the focused panel's bindings
// before application-wide ones, and hidden commands resolving to nothing.
import { existsSync, readFileSync } from 'node:fs'
import test from 'node:test'
import assert from 'node:assert/strict'
import { externalCommands, keyTable, parseShortcut, resolveKey } from './keys.ts'

const manifest = JSON.parse(readFileSync(new URL('../../parity/film-upstream.json', import.meta.url), 'utf8'))

/** A fake engine's `shortcuts.list` (its rows carry the panel's title, as the engine does). */
const SHORTCUTS = [
  { id: 'edit.undo', shortcuts: [{ keys: 'Cmd+Z', panel: null }, { keys: 'Left', panel: 'History' }] },
  { id: 'edit.redo', shortcuts: [{ keys: 'Cmd+Shift+Z', panel: null }, { keys: 'Right', panel: 'History' }] },
  { id: 'playhead.stepBack', shortcuts: [{ keys: 'Left', panel: null }] },
  { id: 'playhead.stepBack5', shortcuts: [{ keys: 'Shift+Left', panel: null }] },
  { id: 'markers.markIn', shortcuts: [{ keys: 'I', panel: null }] },
  { id: 'markers.goToIn', shortcuts: [{ keys: 'Shift+I', panel: null }] },
  { id: 'file.save', shortcuts: [{ keys: 'Cmd+S', panel: null }] },
  { id: 'edit.selectAll', shortcuts: [{ keys: 'Cmd+A', panel: null }] },
  { id: 'source.overwrite', shortcuts: [{ keys: '.', panel: null }] },
  { id: 'sequence.close', shortcuts: [{ keys: 'Cmd+W', panel: 'Timeline' }] },
  { id: 'clip.nudgeUp', shortcuts: [] },
]

const mac = keyTable(SHORTCUTS, manifest, true)
const pc = keyTable(SHORTCUTS, manifest, false)

/** A browser key event: `key` as the browser reports it, `code` its physical key. */
const press = (key, modifiers = {}, code = undefined) => ({
  key,
  code: code ?? (/^[a-z]$/i.test(key) ? `Key${key.toUpperCase()}` : /^\d$/.test(key) ? `Digit${key}` : ''),
  metaKey: false,
  ctrlKey: false,
  shiftKey: false,
  altKey: false,
  ...modifiers,
})

test('Left in History is Undo; Left in the Timeline steps back a frame', () => {
  assert.equal(resolveKey(press('ArrowLeft'), 'history', mac), 'edit.undo')
  assert.equal(resolveKey(press('ArrowLeft'), 'timeline', mac), 'playhead.stepBack')
})

test('Shift+I is Go to In, not Mark In: more modifiers win', () => {
  assert.equal(resolveKey(press('I', { shiftKey: true }), 'timeline', mac), 'markers.goToIn')
  assert.equal(resolveKey(press('i'), 'timeline', mac), 'markers.markIn')
  assert.equal(resolveKey(press('ArrowLeft', { shiftKey: true }), 'timeline', mac), 'playhead.stepBack5')
})

test('Cmd+S resolves to nothing, because file.save is hidden: the shell saves', () => {
  assert.equal(resolveKey(press('s', { metaKey: true }), 'timeline', mac), null)
  assert.equal(resolveKey(press('s', { ctrlKey: true }), 'timeline', pc), null)
})

test("L is Shuttle Right and ` maximizes the frame under the pointer (upstream's UI keys)", () => {
  assert.equal(resolveKey(press('l'), 'timeline', mac), 'playback.forward')
  assert.equal(resolveKey(press('`', {}, 'Backquote'), 'timeline', mac), 'window.maximizeFrameUnderCursor')
  assert.equal(resolveKey(press('~', { shiftKey: true }, 'Backquote'), 'timeline', mac), 'window.maximizeFrame', 'Shift+` arrives as ~, which falls back to its physical key')
  assert.equal(resolveKey(press(' ', {}, 'Space'), 'timeline', mac), 'playback.toggle')
  assert.equal(resolveKey(press('v'), 'timeline', mac), 'tool.selection')
  assert.equal(resolveKey(press('A', { shiftKey: true }), 'timeline', mac), 'tool.trackSelectBackward')
})

test('panel-scoped bindings apply only in their panel', () => {
  assert.equal(resolveKey(press('w', { metaKey: true }), 'timeline', mac), 'sequence.close')
  // Cmd+W in another panel is upstream's File > Close, which the host owns.
  assert.equal(resolveKey(press('w', { metaKey: true }), 'program', mac), null)
})

test('Cmd is the Command key on macOS and Control elsewhere; Ctrl is Control on macOS', () => {
  assert.equal(resolveKey(press('z', { metaKey: true }), 'timeline', mac), 'edit.undo')
  assert.equal(resolveKey(press('z', { ctrlKey: true }), 'timeline', mac), null)
  assert.equal(resolveKey(press('z', { ctrlKey: true }), 'timeline', pc), 'edit.undo')
  // Ctrl+Shift+. (Select Next Panel) is Control on a Mac.
  assert.equal(resolveKey(press('>', { ctrlKey: true, shiftKey: true }, 'Period'), 'timeline', mac), 'window.nextPanel')
  // A bare key never stands in for a chord.
  assert.equal(resolveKey(press('i', { metaKey: true }), 'timeline', mac), null)
})

test('a shifted punctuation key also matches its US glyph', () => {
  // Shift+= (Expand All Tracks) arrives as +.
  assert.equal(resolveKey(press('+', { shiftKey: true }, 'Equal'), 'timeline', mac), 'timeline.expandAllTracks')
  assert.equal(resolveKey(press('=', {}, 'Equal'), 'timeline', mac), 'view.zoomIn')
  assert.equal(resolveKey(press('.', {}, 'Period'), 'timeline', mac), 'source.overwrite')
})

test('Alt on a Mac changes the character, not the key', () => {
  // Alt+K (Play In to Out) arrives as ˚ on a US Mac keyboard.
  assert.equal(resolveKey(press('˚', { altKey: true }, 'KeyK'), 'timeline', mac), 'playback.inToOut')
  // Alt+Shift+1 is the Editing workspace.
  assert.equal(resolveKey(press('⁄', { altKey: true, shiftKey: true }, 'Digit1'), 'timeline', mac), 'window.workspace.editing')
})

test('Select All in the Project panel selects its items', () => {
  assert.equal(resolveKey(press('a', { metaKey: true }), 'project', mac), 'project.selectAll')
  assert.equal(resolveKey(press('a', { metaKey: true }), 'timeline', mac), 'edit.selectAll')
})

test("a floating bin window (focus `projectBin.<id>`) takes the Project panel's keys", () => {
  const table = keyTable([...SHORTCUTS, { id: 'projectPanel.moveEnd', shortcuts: [{ keys: 'End', panel: 'Project' }] }], manifest, true)
  assert.equal(resolveKey(press('End'), 'projectBin.bin7', table), 'projectPanel.moveEnd')
  assert.equal(resolveKey(press('End'), 'project', table), 'projectPanel.moveEnd')
  assert.notEqual(resolveKey(press('End'), 'timeline', table), 'projectPanel.moveEnd')
  assert.equal(resolveKey(press('a', { metaKey: true }), 'projectBin.bin7', mac), 'project.selectAll')
})

test("panels' window shortcuts come from the manifest", () => {
  assert.equal(resolveKey(press('!', { shiftKey: true }, 'Digit1'), 'timeline', mac), 'window.panel.Project')
})

test('parses chords as upstream parse_shortcut', () => {
  assert.deepEqual(parseShortcut('Cmd+Shift+K', true), { key: 'K', command: true, ctrl: false, shift: true, alt: false })
  assert.deepEqual(parseShortcut('Ctrl+Z', true), { key: 'Z', command: false, ctrl: true, shift: false, alt: false })
  assert.deepEqual(parseShortcut('Ctrl+Z', false), { key: 'Z', command: true, ctrl: false, shift: false, alt: false })
  assert.equal(parseShortcut('+', true)?.key, '+')
  assert.equal(parseShortcut('Cmd+Shift', true), null)
})

test("Kition's reserved keys and the host's own keys are left to the host", () => {
  // kit-editor's RESERVED_SHORTCUTS, and a host that forwards Cmd+K to itself.
  const reserved = ['Cmd+N', 'Cmd+W', 'Cmd+O', 'Cmd+P', 'Cmd+Q', 'Cmd+,', 'Cmd+S', 'Cmd+Shift+S', 'Cmd+T', 'Cmd+K']
  const hosted = keyTable([...SHORTCUTS, { id: 'sequence.addEdit', shortcuts: [{ keys: 'Cmd+K', panel: null }] }], manifest, true, reserved)
  assert.equal(resolveKey(press('w', { metaKey: true }), 'timeline', hosted), null, 'Close Sequence gives Cmd+W to the host')
  assert.equal(resolveKey(press(',', { metaKey: true }, 'Comma'), 'timeline', hosted), null, 'Preferences gives Cmd+, to the host')
  assert.equal(resolveKey(press('k', { metaKey: true }), 'timeline', hosted), null, "the host's own key")
  // Off macOS the reserved Cmd+W is Ctrl+W.
  const pcHosted = keyTable(SHORTCUTS, manifest, false, reserved)
  assert.equal(resolveKey(press('w', { ctrlKey: true }), 'timeline', pcHosted), null)
  // Other keys still resolve.
  assert.equal(resolveKey(press('i'), 'timeline', hosted), 'markers.markIn')
  assert.equal(resolveKey(press('z', { metaKey: true }), 'timeline', hosted), 'edit.undo')
})

test("upstream's UI commands are registered with the engine, as upstream's external_commands, so the panel tables bind them", () => {
  const commands = externalCommands(manifest)
  const byId = new Map(commands.map((command) => [command.id, command]))
  // The Project panel's moves have no default of their own: only the engine's panel table binds them.
  assert.ok(byId.has('projectPanel.moveRight'))
  assert.equal(byId.get('playback.toggle')?.shortcut, 'Space')
  assert.deepEqual(byId.get('projectPanel.newPanel')?.menu, ['Window'])
  assert.equal(new Set(commands.map((command) => command.id)).size, commands.length, 'each command once')
  assert.ok(commands.every((command) => !command.id.startsWith('kit:')))
})

test("once the engine lists a UI command, its bindings are the engine's: the panel table's, and a rebinding replaces the default", () => {
  const listed = [
    ...SHORTCUTS,
    { id: 'projectPanel.moveRight', shortcuts: [{ keys: 'Right', panel: 'Project' }] },
    { id: 'projectPanel.extendUp', shortcuts: [{ keys: 'Shift+Up', panel: 'Project' }] },
    // Shuttle Right rebound from L to Alt+L.
    { id: 'playback.forward', shortcuts: [{ keys: 'Alt+L', panel: null }] },
  ]
  const table = keyTable(listed, manifest, true)
  assert.equal(resolveKey(press('ArrowRight', {}, 'ArrowRight'), 'project', table), 'projectPanel.moveRight')
  assert.equal(resolveKey(press('ArrowUp', { shiftKey: true }, 'ArrowUp'), 'project', table), 'projectPanel.extendUp')
  assert.equal(resolveKey(press('ArrowRight', {}, 'ArrowRight'), 'timeline', table), null)
  assert.equal(resolveKey(press('l', { altKey: true }, 'KeyL'), 'timeline', table), 'playback.forward')
  assert.equal(resolveKey(press('l'), 'timeline', table), null)
})

test('a binding whose command nothing serves yet gives way to the next match, so the key still runs a Film command', () => {
  const listed = [
    ...SHORTCUTS,
    // A focused panel's wave-2 commands over app-wide engine ones (the engine's tables, once registered).
    { id: 'view.showRulers', shortcuts: [{ keys: 'Cmd+Shift+R', panel: 'Program' }] },
    { id: 'graphics.alignTextRight', shortcuts: [{ keys: 'Cmd+Shift+R', panel: null }] },
    { id: 'textPanel.rippleDelete', shortcuts: [{ keys: 'Backspace', panel: 'Text' }] },
    { id: 'edit.clear', shortcuts: [{ keys: 'Backspace', panel: null }] },
    { id: 'textPanel.showProgramTranscript', shortcuts: [{ keys: 'Shift+X', panel: 'Text' }] },
    { id: 'markers.markClip', shortcuts: [{ keys: 'X', panel: null }] },
  ]
  const table = keyTable(listed, manifest, true)
  const serves = (id) => !id.startsWith('view.showRulers') && !id.startsWith('textPanel.')
  assert.equal(resolveKey(press('r', { metaKey: true, shiftKey: true }, 'KeyR'), 'program', table, serves), 'graphics.alignTextRight')
  assert.equal(resolveKey(press('Backspace', {}, 'Backspace'), 'text', table, serves), 'edit.clear')
  assert.equal(resolveKey(press('X', { shiftKey: true }, 'KeyX'), 'text', table, serves), 'markers.markClip')
  // Without a predicate every binding counts, as the shortcuts list shows them.
  assert.equal(resolveKey(press('r', { metaKey: true, shiftKey: true }, 'KeyR'), 'program', table), 'view.showRulers')
})

test("no Film binding takes a key kit-editor reserves for Kition (RESERVED_SHORTCUTS, Cmd+. the command palette among them)", async () => {
  const { RESERVED_SHORTCUTS } = await import('@kition/sdk/editor')
  assert.ok(RESERVED_SHORTCUTS.has('Cmd+.'), "kit-editor reserves Cmd+. for Kition's command palette")
  // Engine rows that would claim every reserved key, in the Timeline and application-wide.
  const claims = [...RESERVED_SHORTCUTS].map((keys, index) => ({ id: `claim.${index}`, shortcuts: [{ keys, panel: null }, { keys, panel: 'Timeline' }] }))
  for (const mac of [true, false]) {
    const table = keyTable([...SHORTCUTS, ...claims], manifest, mac, RESERVED_SHORTCUTS)
    for (const keys of RESERVED_SHORTCUTS) {
      const chord = parseShortcut(keys, mac)
      const named = { '.': ['.', 'Period'], ',': [',', 'Comma'] }[chord.key] ?? [chord.key.toLowerCase(), undefined]
      const event = press(named[0], { metaKey: mac && chord.command, ctrlKey: !mac && chord.command, shiftKey: chord.shift }, named[1])
      for (const panel of ['timeline', 'program', 'project']) assert.equal(resolveKey(event, panel, table), null, `${keys} in ${panel} (${mac ? 'macOS' : 'elsewhere'}) reaches the host`)
    }
    assert.ok(!table.bindings.some((binding) => binding.command.startsWith('claim.')), 'no claim is left in the table')
  }
})

const engineDir = new URL('../../public/engine/', import.meta.url)
const engineBuilt = existsSync(new URL('kition_film_kit_bg.wasm', engineDir))

test("every wave-1 key the status file does not hide runs its command in its panel, with the engine's own shortcut set", { skip: !engineBuilt && 'the web engine is not built (pnpm --dir web engine)' }, async () => {
  const { RESERVED_SHORTCUTS } = await import('@kition/sdk/editor')
  const { routeOf } = await import('./invoke.ts')
  const status = JSON.parse(readFileSync(new URL('../../parity/film-status.json', import.meta.url), 'utf8'))
  const sdk = await import(new URL('kition_film_kit.js', engineDir).href)
  sdk.initSync({ module: readFileSync(new URL('kition_film_kit_bg.wasm', engineDir)) })
  const doc = sdk.FilmDocument.create('Untitled', 1920, 1080)
  doc.execute('shortcuts.registerExternal', JSON.stringify({ commands: externalCommands(manifest) }))
  const rows = JSON.parse(doc.execute('shortcuts.list', '{}'))
  const table = keyTable(rows, manifest, true, RESERVED_SHORTCUTS)
  const panelIds = new Map(manifest.panels.map((panel) => [panel.title, panel.id]))
  const KEYS = { Left: 'ArrowLeft', Right: 'ArrowRight', Up: 'ArrowUp', Down: 'ArrowDown', Space: ' ' }
  const CODES = { ',': 'Comma', '.': 'Period', '[': 'BracketLeft', ']': 'BracketRight', "'": 'Quote', '`': 'Backquote', ';': 'Semicolon', '/': 'Slash', '\\': 'Backslash', '-': 'Minus', '=': 'Equal' }
  const pressOf = (chord) => ({
    key: KEYS[chord.key] ?? (chord.key.length === 1 ? chord.key.toLowerCase() : chord.key),
    code: /^[A-Z]$/.test(chord.key) ? `Key${chord.key}` : /^\d$/.test(chord.key) ? `Digit${chord.key}` : (CODES[chord.key] ?? ''),
    metaKey: chord.command,
    ctrlKey: chord.ctrl,
    shiftKey: chord.shift,
    altKey: chord.alt,
  })
  const wrong = []
  for (const [key, value] of Object.entries(status)) {
    if (!key.startsWith('key:') || value.wave !== 1 || value.status === 'hidden') continue
    const command = key.slice(4)
    // "Served" is the router's word: `routeOf` gives the command to a part of the editor (the
    // engine session or a UI route), not `unavailable`. That the engine then runs it is the next test.
    if (routeOf(command, {}, 'timeline') === 'unavailable') wrong.push(`${command}: no part of the editor serves it`)
    const listed = rows.find((row) => row.id === command)
    for (const binding of listed ? listed.shortcuts : (manifest.keys.find((each) => each.command === command)?.bindings ?? [])) {
      const panel = binding.panel ? (panelIds.get(binding.panel) ?? binding.panel) : 'info'
      const got = resolveKey(pressOf(parseShortcut(binding.keys, true)), panel, table)
      if (got !== command) wrong.push(`${command}: ${binding.keys} in ${panel} runs ${got}`)
    }
  }
  assert.deepEqual(wrong, [], 'a reserved key is hidden in the status file with its reason; any other key runs its command')
})

test('every engine-routed wave-1 key command runs in a fixture project: it changes the project or the session, or the engine says why not', { skip: !engineBuilt && 'the web engine is not built (pnpm --dir web engine)' }, async () => {
  const { routeOf } = await import('./invoke.ts')
  const status = JSON.parse(readFileSync(new URL('../../parity/film-status.json', import.meta.url), 'utf8'))
  const sdk = await import(new URL('kition_film_kit.js', engineDir).href)
  sdk.initSync({ module: readFileSync(new URL('kition_film_kit_bg.wasm', engineDir)) })
  const TICKS = 254016000000
  /** Two bars clips on V1 and A1 (0 s and 12 s), a text graphic from 2 s, the playhead at 3 s, the clip `selected` (0 or 1) selected. */
  const fixture = (selected) => {
    const doc = sdk.FilmDocument.create('Untitled', 640, 360)
    const run = (command, params = {}) => JSON.parse(doc.execute(command, JSON.stringify(params)))
    const bars = run('file.newBarsAndTone')
    for (const seconds of [0, 12]) run('timeline.place', { item: bars.item ?? bars.items[0], track: 1, audioTrack: 4, seconds })
    run('graphics.newText', { text: 'Title', seconds: 4, time: 2 * TICKS })
    run('playhead.set', { seconds: 3 })
    run('timeline.select', { clips: [JSON.parse(doc.inspect()).sequence.video[0].items[selected].clip] })
    return doc
  }
  const seen = (doc) => doc.inspect() + doc.execute('state.inspect', '{}') + doc.execute('prefs.get', '{}')
  const wrong = []
  let ran = 0
  for (const [key, value] of Object.entries(status)) {
    if (!key.startsWith('key:') || value.wave !== 1 || value.status === 'hidden') continue
    const command = key.slice(4)
    if (routeOf(command, {}, 'timeline') !== 'session') continue
    ran += 1
    const outcomes = [0, 1].map((selected) => {
      const doc = fixture(selected)
      const before = seen(doc)
      try {
        doc.execute(command, '{}')
        return seen(doc) !== before ? 'changed' : 'nothing'
      } catch (error) {
        return `refused: ${error instanceof Error ? error.message : String(error)}`
      }
    })
    if (outcomes.some((outcome) => /unknown command/.test(outcome))) wrong.push(`${command}: ${outcomes.join(' | ')}`)
    else if (!outcomes.includes('changed') && !outcomes.some((outcome) => outcome.startsWith('refused'))) wrong.push(`${command}: ran and changed nothing`)
  }
  assert.ok(ran > 60, `${ran} engine commands`)
  assert.deepEqual(wrong, [])
})

test('Shift+Delete and Shift+Backspace ripple-delete in the Timeline; Delete and Backspace there clear', () => {
  // The engine's own bindings (`shortcuts.list` of the Kition Film Default set).
  const rows = [
    { id: 'edit.clear', shortcuts: [{ keys: 'Backspace', panel: null }, { keys: 'Delete', panel: 'Timeline' }, { keys: 'Backspace', panel: 'Properties' }] },
    { id: 'edit.rippleDelete', shortcuts: [{ keys: 'Shift+Delete', panel: null }] },
    { id: 'project.delete', shortcuts: [{ keys: 'Delete', panel: null }, { keys: 'Backspace', panel: 'Project' }] },
  ]
  for (const table of [keyTable(rows, manifest, true), keyTable(rows, manifest, false)]) {
    for (const panel of ['timeline', 'program', 'source']) {
      assert.equal(resolveKey(press('Delete', { shiftKey: true }, 'Delete'), panel, table), 'edit.rippleDelete', `Shift+Delete in ${panel}`)
      assert.equal(resolveKey(press('Backspace', { shiftKey: true }, 'Backspace'), panel, table), 'edit.rippleDelete', `Shift+Backspace in ${panel}`)
    }
    assert.equal(resolveKey(press('Delete', {}, 'Delete'), 'timeline', table), 'edit.clear')
    assert.equal(resolveKey(press('Backspace', {}, 'Backspace'), 'timeline', table), 'edit.clear')
    // A chord the set binds on Backspace keeps it: Backspace in the Project panel deletes items.
    assert.equal(resolveKey(press('Backspace', {}, 'Backspace'), 'project', table), 'project.delete')
  }
})
