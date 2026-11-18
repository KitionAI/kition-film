import type { ComponentType } from 'react'
import type { Phrases } from '@kition/kit-editor'
import { AboutTabs } from '../menus/AboutDialog'
import { AudioGainBody, InterpretBody } from './clipBodies'
import { AudioChannelsBody, SourceSettingsBody, SyncBody } from './clipStructureBodies'
import { LinkMediaBody, MakeOfflineBody } from './mediaBodies'
import { PropertiesBody, UpdateMetadataBody } from './menuBodies'
import { ManagePresetsBody, MetadataDisplayBody } from './projectBodies'
import type { DialogContext, DialogSpec, Draft, Params } from './registry'

/**
 * What a custom body can do besides editing its draft: run a command at once through the
 * editor's `invoke` (Link Media's Offline, the Manage dialogs' actions), close the dialog, and
 * pick a file through the host (Locate…; null when the person cancels or the host cannot pick).
 */
export type DialogActions = {
  run: (command: string, params: Params) => Promise<unknown>
  close: () => void
  pick: (kind: string, types: readonly string[]) => Promise<string | null>
}

export type DialogBodyProps = {
  spec: DialogSpec
  draft: Draft
  set: (field: string, value: unknown) => void
  ctx: DialogContext
  /** The document's revision now (what a body's own reads key on, as upstream's per-revision caches). */
  revision: number | null
  phrase: Phrases
  /** The editor's own strings (Kition's, beside upstream's labels through `phrase`). */
  t: (key: string, values?: Record<string, string | number>) => string
  actions: DialogActions
}

/** A custom body (one `fields.tsx` cannot draw), by dialog id. Each dialog task adds its own. */
export const BODIES: Readonly<Record<string, ComponentType<DialogBodyProps>>> = {
  'help.about': AboutTabs,
  'clip.audioGain': AudioGainBody,
  'clip.interpretFootage': InterpretBody,
  'clip.audioChannels': AudioChannelsBody,
  'clip.synchronize': SyncBody,
  'clip.mergeClips': SyncBody,
  'clip.sourceSettings': SourceSettingsBody,
  'clip.updateMetadata': UpdateMetadataBody,
  'file.mediaProperties': PropertiesBody,
  'media.linkMedia': LinkMediaBody,
  'media.makeOffline': MakeOfflineBody,
  'project.columns.set': MetadataDisplayBody,
  'projectPanel.manageViewPresets': ManagePresetsBody,
}
