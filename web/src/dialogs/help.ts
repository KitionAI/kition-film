// Help ▸ About (upstream `panels/dialogs.rs` `about`). Imports carry `.ts` so `node --test` loads
// this module as it is.
import type { DialogSpec } from './registry.ts'

/** Upstream's About tabs, in order (`about.tab.<id>`). */
export const ABOUT_TABS = [
  ['about', 'About'],
  ['contributors', 'Contributors'],
  ['models', 'Models'],
] as const

export type AboutTab = (typeof ABOUT_TABS)[number][0]

/**
 * About Kition Film, in upstream's three tabs: About (the kit's version, the upstream release it
 * ports, and the licences), Contributors, and Models (the credits upstream compiles in; this copy
 * carries none). Upstream's community and website links (`about.<link>`) go to its former sites
 * and are not drawn, as Help's own links are hidden.
 */
const about: DialogSpec = {
  id: 'help.about',
  aliases: ['app.about'],
  family: 'help',
  title: 'About Kition Film',
  prefix: 'about',
  upstream: 'about',
  preview: ['none'],
  note: 'Shows information; nothing to preview.',
  engine: false,
  hideOk: true,
  cancelLabel: 'Close',
  controls: ABOUT_TABS.map(([tab, label]) => ({ field: `tab.${tab}`, label, upstream: [`about.tab.${tab}`] })),
  defaults: () => ({ tab: 'about' }),
  toParams: () => null,
}

export const HELP_DIALOGS: readonly DialogSpec[] = [about]
