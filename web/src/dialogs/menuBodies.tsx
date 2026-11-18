import type { DialogBodyProps } from './bodies'
import { propertyLines } from './menu'

/**
 * Update Metadata (upstream `menu_dialogs.rs` `show`, `clip.updateMetadata`): its question, with the
 * count of the selected clips, and that XMP files other applications wrote are left alone.
 */
export function UpdateMetadataBody({ draft, phrase }: DialogBodyProps) {
  const count = (draft.info as { count?: unknown } | null)?.count
  return (
    <>
      <p className="film-dialog-label" data-testid="film-dialog-updateMetadata-question">
        {phrase('Write the metadata of the selected clip(s) ({n}) to XMP files next to their media?').replace('{n}', String(typeof count === 'number' ? count : 0))}
      </p>
      <p className="kui-muted film-dialog-empty">{phrase('Existing XMP files written by other applications are left unchanged.')}</p>
    </>
  )
}

/**
 * Properties (upstream `menu_dialogs.rs` `show`, `file.mediaProperties`): each file's name, then
 * its lines, in a scrolled list of at most 420 px.
 */
export function PropertiesBody({ draft, phrase }: DialogBodyProps) {
  const list = Array.isArray(draft.info) ? (draft.info as Array<{ name?: unknown }>) : []
  return (
    <div className="film-dialog-properties" data-testid="film-dialog-properties-list">
      {list.map((file, index) => (
        <section key={index} className="film-dialog-properties-file" data-testid={`film-dialog-properties-file-${index}`}>
          <h3 className="film-dialog-heading">{typeof file.name === 'string' ? file.name : ''}</h3>
          {propertyLines(file, phrase).map((line) => (
            <p key={line} className="film-dialog-properties-line">
              {line}
            </p>
          ))}
        </section>
      ))}
    </div>
  )
}
