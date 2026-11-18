import type { HostConnection, KitEngine } from '@kition/kit-editor'

const EXPORT_STEP_MS = 150

export type ExportProgress = { fraction: number; secondsLeft: number | null }
type ExportReport = { finished: boolean; progress?: number; etaSeconds?: number | null; result?: { error?: string } | null }

/**
 * Exports the active sequence as an H.264 MP4 beside the project: the engine encodes it step by
 * step in its worker (WebAssembly has no threads), then the host writes it as a new file under an
 * unused name. Returns the path the host wrote.
 */
export async function exportMovie(doc: KitEngine, host: HostConnection, onProgress: (progress: ExportProgress) => void, signal: AbortSignal) {
  if (signal.aborted) throw new DOMException('Export cancelled', 'AbortError')
  const target = host.init.document.path.replace(/\.[^./]+$/, '') + '.mp4'
  const fileName = target.split('/').pop() ?? target
  const started = JSON.parse(await doc.execute('file.exportMedia', { path: fileName, format: 'h264' })) as { job?: number }
  if (started.job == null) throw new Error('the export did not start')
  let report: ExportReport
  do {
    if (signal.aborted) await doc.invoke('cancelJob', started.job)
    report = JSON.parse(await doc.invoke<string>('exportStep', started.job, EXPORT_STEP_MS)) as ExportReport
    onProgress({ fraction: report.progress ?? 0, secondsLeft: report.etaSeconds ?? null })
  } while (!report.finished)
  if (signal.aborted) throw new DOMException('Export cancelled', 'AbortError')
  if (report.result?.error) throw new Error(report.result.error)
  const bytes = await doc.invoke<Uint8Array | undefined>('takeFile', fileName)
  // Cancellation may arrive while the worker transfers the completed movie. Do not write it.
  if (signal.aborted) throw new DOMException('Export cancelled', 'AbortError')
  if (!bytes) throw new Error('the export produced no file')
  return host.exportFile(target, bytes)
}
