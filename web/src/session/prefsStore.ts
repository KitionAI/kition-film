import { kitStoreKey, readKitStore, writeKitStore } from '@kition/kit-editor'
import type { PrefsStore } from './prefsSync.ts'

/** The kit store's name of Film's user preferences: `kit:film:prefs`, shared by every Film page. */
export const PREFS_STORE = 'prefs'

/** Film's user preferences in the kit store (`prefsSync.ts`); another page's write arrives by the `storage` event. */
export function kitPrefsStore(): PrefsStore {
  return {
    read: () => readKitStore<unknown>('film', PREFS_STORE, (raw) => raw),
    write: (value) => writeKitStore('film', PREFS_STORE, value),
    subscribe(listener) {
      const key = kitStoreKey('film', PREFS_STORE)
      const heard = (event: StorageEvent) => {
        if (event.key !== key) return
        let raw: unknown = null
        try {
          raw = event.newValue == null ? null : (JSON.parse(event.newValue) as unknown)
        } catch {
          // Unreadable: no copy, which keeps this page's.
        }
        listener(raw)
      }
      window.addEventListener('storage', heard)
      return () => window.removeEventListener('storage', heard)
    },
  }
}

/** This page, in the preferences' stamps. */
export const PREFS_PAGE = typeof crypto !== 'undefined' && 'randomUUID' in crypto ? crypto.randomUUID() : `page-${Math.random().toString(36).slice(2)}`
