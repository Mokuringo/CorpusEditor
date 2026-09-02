import { contextBridge, ipcRenderer } from 'electron'
import type {
  ExportConfig,
  ExportFormat,
  ExportResult,
  ExportScope,
  Json,
  OpenResult,
  SessionSummary,
  Settings
} from '@shared/types'

type Unsubscribe = () => void

export interface DatasetChunk {
  sessionId: string
  offset: number
  total: number
  records: Array<{ id: string; index: number; data: Record<string, Json> }>
}

export interface WindowState {
  maximized: boolean
}

const corpuseditor = {
  info: () =>
    ipcRenderer.invoke('app:info') as Promise<{
      version: string
      platform: string
      userData: string
      /** GUI 测试用：启动参数 --locale 的值（无则缺省）。 */
      locale?: string
    }>,

  windowMinimize: () => ipcRenderer.invoke('window:minimize') as Promise<void>,
  windowMaximize: () => ipcRenderer.invoke('window:maximize') as Promise<boolean>,
  windowClose: () => ipcRenderer.invoke('window:close') as Promise<void>,
  onWindowState: (callback: (state: WindowState) => void): Unsubscribe => {
    const handler = (_event: unknown, state: WindowState) => callback(state)
    ipcRenderer.on('window:state', handler)
    return () => ipcRenderer.removeListener('window:state', handler)
  },

  getSettings: () => ipcRenderer.invoke('settings:get') as Promise<Settings>,
  setSettings: (settings: Settings) => ipcRenderer.invoke('settings:set', settings) as Promise<void>,

  openSourceDialog: (startDir?: string | null) =>
    ipcRenderer.invoke('dialog:openSource', startDir ?? null) as Promise<string | null>,
  saveExportDialog: (defaultPath: string, format: ExportFormat) =>
    ipcRenderer.invoke('dialog:saveExport', { defaultPath, format }) as Promise<string | null>,
  saveNewDatasetDialog: (defaultPath: string) =>
    ipcRenderer.invoke('dialog:saveNewDataset', defaultPath) as Promise<string | null>,

  createDataset: (input: {
    destPath: string
    format: 'jsonl' | 'json' | 'csv' | 'tsv' | 'yaml'
    columns: string[]
  }) => ipcRenderer.invoke('dataset:create', input) as Promise<{ path: string }>,

  listSessions: () => ipcRenderer.invoke('session:list') as Promise<SessionSummary[]>,
  forgetSession: (sessionId: string) => ipcRenderer.invoke('session:forget', sessionId) as Promise<boolean>,

  openSource: (filePath: string, fresh?: boolean) =>
    ipcRenderer.invoke('source:open', { filePath, fresh }) as Promise<OpenResult>,

  onDatasetChunk: (callback: (chunk: DatasetChunk) => void): Unsubscribe => {
    const handler = (_event: unknown, chunk: DatasetChunk) => callback(chunk)
    ipcRenderer.on('dataset:chunk', handler)
    return () => ipcRenderer.removeListener('dataset:chunk', handler)
  },

  persist: (input: {
    sessionId: string
    edits?: Record<string, Record<string, Json> | null>
    deleted?: number[]
    view?: unknown
    exportConfig?: ExportConfig | null
    lastExportPath?: string | null
    added?: Array<{ pos: number; data: Record<string, Json> }>
    confirmed?: number[]
  }) =>
    ipcRenderer.invoke('session:persist', input) as Promise<{
      ok: boolean
      updatedAt: number
      cleared: string[]
    }>,

  getOriginal: (sessionId: string, recordId: string) =>
    ipcRenderer.invoke('source:original', { sessionId, recordId }) as Promise<Record<string, Json> | null>,

  getOriginals: (sessionId: string, entries: Array<{ recordId: string; pathKey: string }>) =>
    ipcRenderer.invoke('source:originals', { sessionId, entries }) as Promise<Json[]>,

  verifySource: (sessionId: string) =>
    ipcRenderer.invoke('source:verify', sessionId) as Promise<{ intact: boolean; missing: boolean }>,

  runExport: (input: {
    sessionId: string
    config: ExportConfig
    destPath: string
    scope: ExportScope
    ids: string[]
  }) => ipcRenderer.invoke('export:run', input) as Promise<ExportResult>,

  showItemInFolder: (fullPath: string) => ipcRenderer.invoke('shell:showItemInFolder', fullPath) as Promise<boolean>,

  onFlushRequest: (callback: () => void): Unsubscribe => {
    const handler = () => callback()
    ipcRenderer.on('app:flush', handler)
    return () => ipcRenderer.removeListener('app:flush', handler)
  },
  flushed: () => ipcRenderer.send('app:flushed')
}

contextBridge.exposeInMainWorld('corpuseditor', corpuseditor)

export type CorpusEditorApi = typeof corpuseditor
