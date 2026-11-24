import type { HostConnection, KitEngine } from '@kition/sdk/editor'

const EXPORT_STEP_MS = 150

export type ExportProgress = { fraction: number; secondsLeft: number | null }

/**
 * What the Export dialog chooses (`file.exportMedia`'s own parameters): the sequence (else the
 * active one), the range (`entire` or `inOut`; none: In to Out when both are set, else the whole
 * sequence), the frame size and rate (none: the sequence's), and H.264 constant quality (0 to 100)
 * or an average bitrate in kb/s (none: the engine's default, as the one-click export). The file's
 * name never changes: it is the project's, beside it.
 */
export type ExportOptions = { sequence?: number; range?: 'entire' | 'inOut'; width?: number; height?: number; fps?: number; quality?: number; bitrateKbps?: number }

/** The name the export writes: the project's, with `.mp4` (the host may number it when that file exists). */
export const exportTarget = (documentPath: string) => documentPath.replace(/\.[^./]+$/, '') + '.mp4'
type ExportReport = { finished: boolean; progress?: number; etaSeconds?: number | null; result?: { error?: string } | null }

/**
 * Exports the active sequence as an H.264 MP4 beside the project: the engine encodes it step by
 * step in its worker (WebAssembly has no threads), then the host writes it as a new file under an
 * unused name. Returns the path the host wrote.
 */
export async function exportMovie(doc: KitEngine, host: HostConnection, onProgress: (progress: ExportProgress) => void, signal: AbortSignal, options: ExportOptions = {}) {
  if (signal.aborted) throw new DOMException('Export cancelled', 'AbortError')
  const target = exportTarget(host.init.document.path)
  const fileName = target.split('/').pop() ?? target
  const started = JSON.parse(await doc.execute('file.exportMedia', { path: fileName, format: 'h264', ...options })) as { job?: number }
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
