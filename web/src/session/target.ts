/**
 * Upstream's source targeting (`menus.rs` `targets_source`, and the first lines of `invoke`): the
 * commands the engine lists as source commands (its `sourceCommands` extra, upstream's
 * `source_monitor::source_command`) act on the Source monitor's clip while the Source monitor has
 * focus, or when their params name it (`monitor: "source"`). The engine routes them there when
 * their params say `target: "source"`; the editor adds it. Pure, so `node --test` runs it.
 */

type Params = Record<string, unknown>

/** Whether a command with `params` targets the Source monitor: an explicit `monitor` wins over the focused panel. */
export function targetsSource(focused: string, params: Params) {
  const monitor = params.monitor
  if (typeof monitor === 'string') return monitor === 'source'
  return focused === 'source'
}

/**
 * `params` with `target: "source"` when `command` is a source command that targets the Source
 * monitor and names no target. The editor's `monitor` hint is never sent: the engine takes
 * `target`, and a command refuses a parameter it does not name (engine rule E7a).
 */
export function withSourceTarget(command: string, params: Params, sources: ReadonlySet<string>, focused: string): Params {
  const toSource = sources.has(command) && params.target === undefined && targetsSource(focused, params)
  const { monitor: _hint, ...sent } = params
  return toSource ? { ...sent, target: 'source' } : 'monitor' in params ? sent : params
}

/** The engine's source commands, or none when it cannot name them (an engine without the extra). */
export async function sourceCommandsOf(doc: { invoke: <T>(name: string) => Promise<T> }): Promise<ReadonlySet<string>> {
  try {
    const answer: unknown = JSON.parse(await doc.invoke<string>('sourceCommands'))
    return new Set(Array.isArray(answer) ? answer.filter((id): id is string => typeof id === 'string') : [])
  } catch {
    return new Set()
  }
}

/**
 * `run`, aimed as upstream's `invoke` aims: each command is checked against the source commands
 * and the panel focused at the moment it runs.
 */
export function targetedRun<R, Rest extends unknown[]>(
  run: (command: string, params: Params, ...rest: Rest) => Promise<R>,
  sources: () => Promise<ReadonlySet<string>>,
  focused: () => string,
) {
  return async (command: string, params: Params = {}, ...rest: Rest): Promise<R> => run(command, withSourceTarget(command, params, await sources(), focused()), ...rest)
}
