import { createHash } from 'node:crypto'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { app } from 'electron'
import type {
  AddedRecord,
  ExportConfig,
  FilterMode,
  SessionState,
  SessionSummary,
  Settings,
  ViewState
} from '@shared/types'
import { quickFingerprint } from '@shared/parse'
import { modifiedRecordCount } from '@shared/patch'
import { appError } from '@shared/errors'

const DEFAULT_SETTINGS: Settings = {
  theme: 'system',
  locale: 'zh-CN',
  lastOpenDir: null,
  recentSessionIds: []
}

let cacheDir: string | null = null

export function sessionsDir(): string {
  if (!cacheDir) cacheDir = path.join(app.getPath('userData'), 'sessions')
  return cacheDir
}

function settingsFile(): string {
  return path.join(app.getPath('userData'), 'settings.json')
}

/**
 * 会话 id 只由源文件绝对路径决定。
 * 这样即使源文件被改动（体积/时间变化），重新打开同一个文件仍然能找到同一份编辑进度，
 * 内容差异通过 fingerprint 单独检测并提示用户。
 */
export function makeSessionId(filePath: string): string {
  const hash = createHash('sha1')
  hash.update(path.resolve(filePath))
  return hash.digest('hex').slice(0, 32)
}

/**
 * 会话 id 必须严格匹配 32 位十六进制。
 * 它会被拼进文件路径（读 / 写 / 删），一旦允许任意字符串，`..` 就能把操作引到目录之外。
 */
const SESSION_ID_RE = /^[a-f0-9]{32}$/

export function isSessionId(value: unknown): value is string {
  return typeof value === 'string' && SESSION_ID_RE.test(value)
}

/** 把外部传入的删除标记收敛成合法的下标数组。 */
export function sanitizeDeleted(value: unknown): number[] {
  if (!Array.isArray(value)) return []
  const out: number[] = []
  for (const item of value) {
    if (typeof item === 'number' && Number.isInteger(item) && item >= 0) out.push(item)
  }
  return [...new Set(out)].sort((a, b) => a - b)
}

async function atomicWrite(file: string, payload: string): Promise<void> {
  await fsp.mkdir(path.dirname(file), { recursive: true })
  const tmp = `${file}.${process.pid}.tmp`
  await fsp.writeFile(tmp, payload, 'utf8')
  try {
    const stat = await fsp.stat(file)
    if (stat.isFile()) await fsp.copyFile(file, `${file}.bak`)
  } catch {
    // 首次写入，没有旧文件可备份
  }
  await fsp.rename(tmp, file)
}

async function readJson<T>(file: string): Promise<T | null> {
  try {
    const text = await fsp.readFile(file, 'utf8')
    return JSON.parse(text) as T
  } catch {
    // 主文件损坏时回退到备份
    try {
      const text = await fsp.readFile(`${file}.bak`, 'utf8')
      return JSON.parse(text) as T
    } catch {
      return null
    }
  }
}

export async function loadSettings(): Promise<Settings> {
  const stored = await readJson<Partial<Settings>>(settingsFile())
  return { ...DEFAULT_SETTINGS, ...(stored ?? {}) }
}

export async function saveSettings(settings: Settings): Promise<void> {
  await atomicWrite(settingsFile(), JSON.stringify(settings, null, 2))
}

export function sessionFile(sessionId: string): string {
  if (!isSessionId(sessionId)) throw appError('INVALID_SESSION_ID', { id: String(sessionId) })
  return path.join(sessionsDir(), `${sessionId}.json`)
}

export function createSessionState(
  id: string,
  source: SessionState['source'],
  recordCount: number
): SessionState {
  const now = Date.now()
  return {
    id,
    source,
    edits: {},
    deleted: [],
    view: defaultView(),
    exportConfig: null,
    lastExportPath: null,
    recordCount,
    createdAt: now,
    updatedAt: now,
    appVersion: app.getVersion()
  }
}

export function defaultView(): ViewState {
  return { selectedIndex: 0, scrollTop: 0, filter: 'all', query: '', selectedIds: [], multiSelect: false }
}

/**
 * 视图状态兼容：老会话里存的是 filter: 'modified'，
 * 加了「已确认」之后它改叫 'pending'，读出来时统一迁过去。
 */
export function normalizeView(view: ViewState | null | undefined): ViewState | null {
  if (!view) return null
  const legacy = view.filter as string
  const filter: FilterMode =
    legacy === 'modified'
      ? 'pending'
      : (['all', 'pending', 'confirmed', 'unmodified', 'deleted'] as const).includes(view.filter)
        ? view.filter
        : 'all'
  return {
    ...defaultView(),
    ...view,
    filter,
    selectedIds: Array.isArray(view.selectedIds) ? view.selectedIds : []
  }
}

export async function loadSession(sessionId: string): Promise<SessionState | null> {
  if (!isSessionId(sessionId)) return null
  return readJson<SessionState>(sessionFile(sessionId))
}

export async function saveSession(state: SessionState): Promise<void> {
  await atomicWrite(sessionFile(state.id), JSON.stringify({ ...state, updatedAt: Date.now() }))
}

/**
 * 删除会话文件 —— 这是全项目唯一会真正删文件的地方。
 * id 不合法时直接返回，绝不拿未校验的字符串去拼删除路径。
 */
export async function deleteSession(sessionId: string): Promise<boolean> {
  if (!isSessionId(sessionId)) return false
  for (const file of [sessionFile(sessionId), `${sessionFile(sessionId)}.bak`]) {
    // force 只表示「不存在也不报错」；对目录 Node 仍然会拒绝，不会递归删除
    await fsp.rm(file, { force: true })
  }
  return true
}

export async function listSessions(): Promise<SessionSummary[]> {
  const dir = sessionsDir()
  let entries: string[]
  try {
    entries = await fsp.readdir(dir)
  } catch {
    return []
  }
  const out: SessionSummary[] = []
  for (const entry of entries) {
    if (!entry.endsWith('.json')) continue
    const id = entry.slice(0, -'.json'.length)
    if (!isSessionId(id)) continue // 跳过不是本应用产生的文件
    const state = await readJson<SessionState>(path.join(dir, entry))
    if (!state?.source?.path) continue
    let sourceIntact = true
    let sourceMissing = false
    try {
      const stat = await fsp.stat(state.source.path)
      const fingerprint = await quickFingerprint(state.source.path, stat.size)
      sourceIntact = fingerprint === state.source.fingerprint
    } catch {
      sourceMissing = true
      sourceIntact = false
    }
    out.push({
      id: state.id,
      sourcePath: state.source.path,
      sourceName: state.source.name,
      format: state.source.format,
      recordCount: state.recordCount,
      modifiedCount: modifiedRecordCount(state.edits ?? {}),
      deletedCount: state.deleted?.length ?? 0,
      addedCount: state.added?.length ?? 0,
      confirmedCount: state.confirmed?.length ?? 0,
      createdAt: state.createdAt,
      updatedAt: state.updatedAt,
      sourceIntact,
      sourceMissing
    })
  }
  return out.sort((a, b) => b.updatedAt - a.updatedAt)
}

export interface SessionPatchInput {
  edits?: Record<string, Record<string, unknown> | null>
  replaceEdits?: boolean
  deleted?: number[]
  view?: ViewState | null
  exportConfig?: ExportConfig | null
  lastExportPath?: string | null
  added?: AddedRecord[]
  confirmed?: number[]
}

export async function patchSession(sessionId: string, input: SessionPatchInput): Promise<SessionState | null> {
  const state = await loadSession(sessionId)
  if (!state) return null
  if (input.edits) {
    const merged = { ...(state.edits ?? {}) }
    for (const [recordId, entry] of Object.entries(input.edits)) {
      if (entry === null) delete merged[recordId]
      else merged[recordId] = { ...(merged[recordId] ?? {}), ...(entry as Record<string, never>) }
    }
    state.edits = merged
  }
  if (input.deleted) state.deleted = sanitizeDeleted(input.deleted)
  if (input.view) state.view = normalizeView(input.view) ?? defaultView()
  if (input.exportConfig !== undefined) state.exportConfig = input.exportConfig
  if (input.lastExportPath !== undefined) state.lastExportPath = input.lastExportPath
  if (input.added !== undefined) state.added = input.added
  if (input.confirmed !== undefined) state.confirmed = sanitizeDeleted(input.confirmed)
  await saveSession(state)
  return state
}
