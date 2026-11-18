/**
 * A panel this editor does not draw (upstream `dock.rs` `placeholder`): one line of faint text in
 * the middle of the frame. A compact frame (Tools, Audio Meters: 64 and 116 px wide) keeps the text
 * as its tooltip instead, so it is not broken into a column of words.
 */
export function Placeholder({ text, panel, compact = false }: { text: string; panel: string; compact?: boolean }) {
  return (
    <div className="film-placeholder" title={compact ? text : undefined} data-testid={`film-placeholder-${panel}`}>
      {compact ? null : text}
    </div>
  )
}
