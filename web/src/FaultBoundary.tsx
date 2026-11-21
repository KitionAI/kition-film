import { Component, useSyncExternalStore, type ErrorInfo, type ReactNode } from 'react'
import { Button, Dialog, useKitEditor, useUi, type Phrases } from '@kition/sdk/editor'

/** Where an injected fault fails: the workspace (the panels) or the whole shell (menus, header, status bar). */
export type FaultPlace = 'workspace' | 'shell'

type Props = {
  children: ReactNode
  /** Which part this boundary covers, for the development builds' injected fault. */
  place: FaultPlace
  /** Saves the project (Save Project). */
  onSave: () => void
  /** Called once when a part of the editor fails to draw (upstream stops the program clock). */
  onFault: () => void
  title: string
  phrase: Phrases
}

/** Development builds only: upstream's `panic_next_frame`, which the flow test sets. */
const DEV = import.meta.env?.DEV === true

/**
 * Upstream's caught UI panic (`lib.rs` `ui` and `error_window`): a part of the editor that fails
 * to draw does not close the editor or leave it blank. The session stays open, and a window says
 * what happened, with Save Project and Continue (`error.save`, `error.dismiss`). Continue draws
 * the part again. Save Project is offered as the app bar's Save is: not for a read-only document
 * or when the host hides Save, and disabled when the host disables it.
 */
export class FaultBoundary extends Component<Props, { error: string | null; generation: number }> {
  state = { error: null as string | null, generation: 0 }

  static getDerivedStateFromError(error: unknown) {
    return { error: error instanceof Error ? error.message : String(error) }
  }

  componentDidCatch(_error: unknown, _info: ErrorInfo) {
    // An injected fault fails one draw (React draws a failing part twice before giving up).
    if (faulty === this.props.place) faulty = null
    this.props.onFault()
  }

  render() {
    const { error, generation } = this.state
    const { phrase, place } = this.props
    if (error == null)
      return DEV ? (
        <FaultInjector key={generation} place={place}>
          {this.props.children}
        </FaultInjector>
      ) : (
        <FaultFree key={generation}>{this.props.children}</FaultFree>
      )
    const dismiss = () => this.setState({ error: null, generation: generation + 1 })
    return (
      <Dialog
        title={this.props.title}
        onClose={dismiss}
        actions={
          <>
            <SaveProject label={phrase('Save Project')} onSave={this.props.onSave} />
            <Button variant="primary" onClick={dismiss} data-kit-ui-id="control:error.dismiss" data-testid="film-error-dismiss">
              {phrase('Continue')}
            </Button>
          </>
        }
      >
        <p>{phrase('Something went wrong while drawing the window. Your project is still open; save it to be safe.')}</p>
        <pre className="film-error-detail" data-testid="film-error-detail">
          {error}
        </pre>
      </Dialog>
    )
  }
}

/** Save Project, under the same rules as kit-editor's Save (`action:save`, a read-only document). */
function SaveProject({ label, onSave }: { label: string; onSave: () => void }) {
  const ui = useUi()
  const { host } = useKitEditor()
  const save = ui.state('action:save')
  if (save.hidden || host.readOnly === true) return null
  return (
    <Button variant="ghost" disabled={save.disabled} onClick={onSave} data-kit-ui-id="control:error.save" data-testid="film-error-save">
      {label}
    </Button>
  )
}

function FaultFree({ children }: { children: ReactNode }) {
  return <>{children}</>
}

let faulty: FaultPlace | null = null
const faultListeners = new Set<() => void>()
if (DEV && typeof window !== 'undefined') {
  ;(window as unknown as { filmInjectFault?: (place?: FaultPlace) => void }).filmInjectFault = (place = 'workspace') => {
    faulty = place
    for (const listener of faultListeners) listener()
  }
}
const subscribeFault = (listener: () => void) => {
  faultListeners.add(listener)
  return () => faultListeners.delete(listener)
}

/** Fails to draw while a fault is injected for its place (`window.filmInjectFault(place)`). */
function FaultInjector({ place, children }: { place: FaultPlace; children: ReactNode }) {
  const fail = useSyncExternalStore(subscribeFault, () => faulty === place)
  if (fail) throw new Error('injected UI fault')
  return <>{children}</>
}
