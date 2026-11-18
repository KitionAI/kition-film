import { NumberField } from '@kition/kit-editor'
import type { DialogBodyProps } from './bodies'
import { CHANNEL_FORMATS, SYNC_METHODS, addAudioClips, channelFormat, channelInfo, setChannel } from './clipStructure'
import { fieldId, optionId, type Draft } from './registry'

const lists = (raw: unknown): number[][] => (Array.isArray(raw) ? raw.map((each) => (Array.isArray(each) ? each.filter((c): c is number => typeof c === 'number') : [])) : [])

/**
 * Modify Clip: Audio Channels (upstream `clip_dialogs.rs` `show`, `clip.audioChannels`): for a
 * project item, the Clip Channel Format radios (each resets the map to the format's), the Number
 * of Audio Clips (1 to the source's channels), and the clip × source channel matrix; for the
 * timeline's audio clips, one box per source channel (two at least). Each change sets the
 * draft's map (and the format a radio picks).
 */
export function AudioChannelsBody({ spec, draft, set, phrase }: DialogBodyProps) {
  const { channels, items } = channelInfo(draft)
  const replace = (next: Draft) => {
    if (items) {
      if (next.format !== draft.format) set('format', next.format)
      set('clips', next.clips)
    } else set('channels', next.channels)
  }
  const channelIds = Array.from({ length: items ? channels : Math.max(channels, 2) }, (_, c) => c)
  const box = (clip: number, channel: number, on: boolean, id: string, label: string) => (
    <input type="checkbox" checked={on} aria-label={label} onChange={(event) => replace(setChannel(draft, clip, channel, event.target.checked))} data-kit-ui-id={id} data-testid={`film-dialog-audioChannels-clip-${clip}-ch-${channel}`} />
  )
  if (!items) {
    const on = Array.isArray(draft.channels) ? (draft.channels as unknown[]) : []
    return (
      <>
        <span>{phrase('Source channels the selected audio clips play:')}</span>
        <div className="film-dialog-row film-dialog-wrap">
          {channelIds.map((c) => {
            const label = phrase('Ch. {n}').replace('{n}', String(c + 1))
            return (
              <label key={c} className="kui-checkbox film-dialog-check">
                {box(0, c, on.includes(c), fieldId(spec, 'channel'), label)}
                {label}
              </label>
            )
          })}
        </div>
      </>
    )
  }
  const clips = lists(draft.clips)
  return (
    <>
      <div className="film-dialog-row film-dialog-wrap" role="radiogroup" aria-label={phrase('Clip Channel Format:')}>
        <span>{phrase('Clip Channel Format:')}</span>
        {CHANNEL_FORMATS.map(([format, label]) => (
          <label key={format} className="kui-checkbox film-dialog-check">
            <input type="radio" name={fieldId(spec, 'format')} checked={draft.format === format} onChange={() => replace(channelFormat(draft, format))} data-kit-ui-id={optionId(spec, 'format', format)} data-testid={`film-dialog-audioChannels-format-${format}`} />
            {phrase(label)}
          </label>
        ))}
      </div>
      <div className="film-dialog-row">
        <NumberField label={phrase('Number of Audio Clips:')} value={clips.length} min={1} max={channels} step={1} width={220} onChange={(count) => replace(addAudioClips(draft, count, channels))} uiId={fieldId(spec, 'count')} testId="film-dialog-audioChannels-count" />
      </div>
      <h3 className="film-dialog-heading">{phrase('Media Source Channels')}</h3>
      <div className="film-dialog-matrix" role="grid" data-testid="film-dialog-audioChannels-matrix">
        <table>
          <thead>
            <tr>
              <th />
              {channelIds.map((c) => (
                <th key={c} scope="col">
                  {phrase('Ch. {n}').replace('{n}', String(c + 1))}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {clips.map((list, clip) => {
              const name = phrase('Clip {n}').replace('{n}', String(clip + 1))
              return (
                <tr key={clip}>
                  <th scope="row">{name}</th>
                  {channelIds.map((c) => (
                    <td key={c}>{box(clip, c, list.includes(c), fieldId(spec, 'clip.channel'), `${name} ${phrase('Ch. {n}').replace('{n}', String(c + 1))}`)}</td>
                  ))}
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
    </>
  )
}

/**
 * Synchronize Clips and Merge Clips (upstream `multicam.rs` `show_dialog`): Merge's Clip Name and
 * its clips, or how many clips Synchronize moves; the Synchronize Point, each method a radio with
 * Timecode's Ignore Hours and Clip Marker's name beside it, enabled while chosen; the Offset in
 * frames; then Synchronize's Reference track or Merge's Remove Audio from AV Clip.
 */
export function SyncBody({ spec, draft, set, ctx, phrase }: DialogBodyProps) {
  const merge = spec.prefix === 'merge'
  const names = Array.isArray((draft.info as { names?: unknown } | null)?.names) ? ((draft.info as { names: unknown[] }).names.filter((each) => typeof each === 'string') as string[]) : []
  const testId = (field: string) => `film-dialog-${spec.prefix}-${field}`
  const method = typeof draft.method === 'string' ? draft.method : 'audio'
  return (
    <>
      {merge ? (
        <>
          <label className="film-dialog-row">
            <span>{phrase('Clip Name:')}</span>
            <input className="kui-field" type="text" value={String(draft.name ?? '')} style={{ flex: 'none', width: 300, boxSizing: 'border-box' }} onChange={(event) => set('name', event.target.value)} data-kit-ui-id={fieldId(spec, 'name')} data-testid={testId('name')} />
          </label>
          <p className="kui-muted film-dialog-empty film-dialog-small" data-testid={testId('clips')}>
            {phrase('{n} clip(s): {names}').replace('{n}', String(names.length)).replace('{names}', names.join(', '))}
          </p>
        </>
      ) : (
        <p className="kui-muted film-dialog-empty film-dialog-small" data-testid={testId('selected')}>
          {phrase('{n} clip(s) selected; the clip on the reference track stays put.').replace('{n}', String(ctx.film?.selection.length ?? 0))}
        </p>
      )}
      <fieldset className="film-dialog-group">
        <legend className="film-dialog-heading">{phrase('Synchronize Point')}</legend>
        {SYNC_METHODS.map(([value, label]) => (
          <div key={value} className="film-dialog-row">
            <label className="kui-checkbox film-dialog-check">
              <input type="radio" name={fieldId(spec, 'method')} checked={method === value} onChange={() => set('method', value)} data-kit-ui-id={optionId(spec, 'method', value)} data-testid={testId(`method-${value}`)} />
              {phrase(label)}
            </label>
            {value === 'timecode' ? (
              <label className="kui-checkbox film-dialog-check" data-disabled={method !== 'timecode' || undefined}>
                <input type="checkbox" checked={draft.ignoreHours === true} disabled={method !== 'timecode'} onChange={(event) => set('ignoreHours', event.target.checked)} data-kit-ui-id={fieldId(spec, 'ignoreHours')} data-testid={testId('ignoreHours')} />
                {phrase('Ignore Hours')}
              </label>
            ) : null}
            {value === 'marker' ? (
              <input className="kui-field" type="text" value={String(draft.marker ?? '')} placeholder={phrase('first marker')} aria-label={phrase('Clip Marker')} disabled={method !== 'marker'} style={{ flex: 'none', width: 140, boxSizing: 'border-box' }} onChange={(event) => set('marker', event.target.value)} data-kit-ui-id={fieldId(spec, 'marker')} data-testid={testId('marker')} />
            ) : null}
          </div>
        ))}
        <div className="film-dialog-row">
          <NumberField label={phrase(merge ? 'Offset Audio by:' : 'Offset:')} value={Math.trunc(Number(draft.offset) || 0)} min={-100_000} max={100_000} step={1} unit={phrase('frames')} width={merge ? 220 : 160} onChange={(value) => set('offset', Math.round(value))} uiId={fieldId(spec, 'offset')} testId={testId('offset')} />
        </div>
      </fieldset>
      {merge ? (
        <label className="kui-checkbox film-dialog-check">
          <input type="checkbox" checked={draft.removeVideoAudio === true} onChange={(event) => set('removeVideoAudio', event.target.checked)} data-kit-ui-id={fieldId(spec, 'removeVideoAudio')} data-testid={testId('removeVideoAudio')} />
          {phrase('Remove Audio from AV Clip')}
        </label>
      ) : (
        <label className="film-dialog-row">
          <span>{phrase('Reference track:')}</span>
          <input className="kui-field" type="text" value={String(draft.track ?? '')} placeholder={phrase('lowest (V1…)')} style={{ flex: 'none', width: 90, boxSizing: 'border-box' }} onChange={(event) => set('track', event.target.value)} data-kit-ui-id={fieldId(spec, 'track')} data-testid={testId('track')} />
        </label>
      )}
    </>
  )
}

/** Source Settings (upstream `menu_dialogs.rs` `show`, `clip.sourceSettings`): the codec, and why it has no settings here. */
export function SourceSettingsBody({ draft, phrase }: DialogBodyProps) {
  const info = (draft.info ?? {}) as { codec?: unknown; message?: unknown }
  return (
    <>
      <span data-testid="film-dialog-sourceSettings-codec">{phrase('Codec: {codec}').replace('{codec}', typeof info.codec === 'string' ? info.codec : '')}</span>
      <p className="kui-muted film-dialog-empty" data-testid="film-dialog-sourceSettings-message">
        {typeof info.message === 'string' ? info.message : ''}
      </p>
    </>
  )
}
