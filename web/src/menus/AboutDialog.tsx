import { useEffect, useState } from 'react'
import { Button, Dialog, useKitEditor } from '@kition/sdk/editor'
import kit from '../../../kit.json' with { type: 'json' }
import upstream from '../../parity/film-upstream.json' with { type: 'json' }
import { shortcutList, type ShortcutItem, type ShortcutListRow } from './kitMenus'
import { ABOUT_TABS, type AboutTab } from '../dialogs/help'

/** Help's read-only dialog that `invoke`'s `dialog` route opens itself: Keyboard Shortcuts (Edit ▸ Keyboard Shortcuts… too). About is a registry dialog (`dialogs/help.ts`). */
export type HelpTopic = 'shortcuts'

/** Help ▸ Keyboard Shortcuts: the read-only list of shortcuts. */
export function HelpDialog({ reserved, onClose }: { topic: HelpTopic; reserved: (keys: string) => boolean; onClose: () => void }) {
  const { t, phrase, testId } = useKitEditor()
  const close = (
    <Button variant="primary" onClick={onClose} data-testid={`${testId}-help-close`}>
      {t('close')}
    </Button>
  )
  return (
    <Dialog title={phrase('Keyboard Shortcuts')} actions={close} onClose={onClose}>
      <ShortcutsList reserved={reserved} />
    </Dialog>
  )
}

/**
 * About's body (upstream `dialogs.rs` `about`): its three tabs. About shows the kit's version, the
 * upstream release it ports, and the licences (upstream's own wordmark, blurb, and links name its
 * former product and sites, and are not drawn). Contributors and Models show the credits
 * upstream compiles in from its contributors file (`credits.rs`); this copy carries none, so each
 * shows upstream's own line for that (and the credits' Show, Sort, and view switches, which act
 * on that data, are not drawn).
 */
export function AboutTabs({ draft, set }: { draft: Record<string, unknown>; set: (field: string, value: unknown) => void }) {
  const { t, phrase } = useKitEditor()
  const tab = (draft.tab as AboutTab | undefined) ?? 'about'
  return (
    <div className="film-about" data-testid="film-about">
      <div className="film-about-tabs" role="tablist">
        {ABOUT_TABS.map(([id, label]) => (
          <button key={id} type="button" role="tab" className="film-about-tab" aria-selected={tab === id} onClick={() => set('tab', id)} data-kit-ui-id={`control:dialog.about.tab.${id}`} data-testid={`film-about-tab-${id}`}>
            {phrase(label)}
          </button>
        ))}
      </div>
      <div className="film-about-body" role="tabpanel" data-testid={`film-about-${tab}`}>
        {tab === 'about' ? (
          <>
            <p>
              <strong>Kition Film</strong>
            </p>
            <p>{t('help.version', { version: kit.version })}</p>
            <p className="kui-muted">{t('help.upstream', { version: upstream.source.tag })}</p>
            <p className="kui-muted film-about-licence">{t('help.licence')}</p>
          </>
        ) : (
          <p className="kui-muted">{phrase(tab === 'contributors' ? 'No contributor data was built into this copy.' : 'No model credits were built into this copy.')}</p>
        )}
      </div>
    </div>
  )
}

/** The engine's shortcuts (`shortcut.list`) and upstream's UI keys, by menu; read-only until the Keyboard Shortcuts editor (wave 3). */
function ShortcutsList({ reserved }: { reserved: (keys: string) => boolean }) {
  const { t, phrase, testId, query } = useKitEditor()
  // Null while reading; 'failed' when the engine could not answer (`query` answers null then).
  const [items, setItems] = useState<ShortcutItem[] | 'failed' | null>(null)
  useEffect(() => {
    let stale = false
    void query<ShortcutListRow[]>('shortcut.list').then((rows) => {
      if (!stale) setItems(rows ? shortcutList(rows, upstream, reserved) : 'failed')
    })
    return () => {
      stale = true
    }
  }, [query, reserved])
  const groups = new Map<string, ShortcutItem[]>()
  for (const item of Array.isArray(items) ? items : []) groups.set(item.category || t('help.otherKeys'), [...(groups.get(item.category || t('help.otherKeys')) ?? []), item])
  return (
    <div className="film-shortcuts" data-testid={`${testId}-shortcuts`}>
      {items == null ? <p className="kui-muted">{t('help.loading')}</p> : null}
      {items === 'failed' ? (
        <p className="kui-muted" role="alert" data-testid={`${testId}-shortcuts-failed`}>
          {t('help.shortcutsFailed')}
        </p>
      ) : null}
      {[...groups].map(([category, rows]) => (
        <section key={category}>
          <h3>{phrase(category)}</h3>
          <dl>
            {rows.map((item) => (
              <div key={`${item.command} ${item.keys} ${item.panel ?? ''}`}>
                <dt>
                  {phrase(item.label)}
                  {item.panel ? <span className="kui-muted"> · {phrase(item.panel)}</span> : null}
                </dt>
                <dd>
                  <kbd>{item.keys}</kbd>
                </dd>
              </div>
            ))}
          </dl>
        </section>
      ))}
    </div>
  )
}
