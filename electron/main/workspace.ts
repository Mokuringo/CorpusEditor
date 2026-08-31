import fsp from 'node:fs/promises'
import path from 'node:path'
import type { WebContents } from 'electron'
import { readSourceFile, quickFingerprint } from '@shared/parse'
import { applyEdits, filterValidEdits, mergeAddedIntoRecords } from '@shared/patch'
import { writeExport } from '@shared/export'
import { defaultColumns } from '@shared/serialize'
import { cloneJson, deepEqual, getAtPath, parsePathKey } from '@shared/jsonpath'
import type {
  DataRecord,
  ExportConfig,
  ExportResult,
  ExportScope,
  OpenResult,
  SessionState,
  ViewState
} from '@shared/types'
import {
  createSessionState,
  loadSession,
  saveSession,
  makeSessionId,
  patchSession,
  sessionsDir
} from './store'

interface Workspace {
  sessionId: string
  state: SessionState
  /** 源文件解析出的原始数据，永不修改；导出时与 edits 合并。 */
  records: DataRecord[]
  byId: Map<string, DataRecord>
  fieldOrder: string[]
  warnings: string[]
}

const workspaces = new Map<string, Workspace>()
const CHUNK_SIZE = 1000

export function dropWorkspace(sessionId: string): void {
  workspaces.delete(sessionId)
}

async function sendChunks(sender: WebContents, sessionId: string, records: DataRecord[]): Promise<void> {
  for (let offset = 0; offset < records.length; offset += CHUNK_SIZE) {
    sender.send('dataset:chunk', {
      sessionId,
      offset,
      total: records.length,
      records: records.slice(offset, offset + CHUNK_SIZE)
    })
    if (offset % (CHUNK_SIZE * 20) === 0) await new Promise((r) => setImmediate(r))
  }
}

export interface OpenOptions {
  filePath: string
  sender: WebContents
  fresh?: boolean
}

export async function openSource({ filePath, sender, fresh }: OpenOptions): Promise<OpenResult> {
  const stat = await fsp.stat(filePath)
  if (!stat.isFile()) throw new Error('选择的路径不是一个文件')

  const sessionId = makeSessionId(filePath)
  let state = fresh ? null : await loadSession(sessionId)

  const parsed = await readSourceFile(filePath, state?.source.format)
  const samePath = state && path.resolve(state.source.path) === path.resolve(filePath)
  const resumed = Boolean(samePath)
  const sourceChanged = Boolean(state && state.source.fingerprint !== parsed.fingerprint)

  if (fresh || !samePath) {
    state = createSessionState(sessionId, toSourceMeta(parsed, filePath), parsed.records.length)
  } else if (state) {
    state.source = { ...state.source, ...toSourceMeta(parsed, filePath) }
    state.recordCount = parsed.records.length
  }
  const session = state as SessionState

  // 合并源记录与新增记录，得到最终序列。mergeAddedIntoRecords 已经按 pos 重新编号。
  const added = session.added ?? []
  const mergedRecords = mergeAddedIntoRecords(parsed.records, added)

  let edits = session.edits ?? {}
  let dropped = 0
  if (sourceChanged || resumed) {
    // 过滤要在合并空间上做：edits 的 key 是合并后的下标，源记录是它的子集。
    const filtered = filterValidEdits(mergedRecords, edits)
    edits = filtered.edits
    dropped = filtered.dropped
  }
  session.edits = edits

  const warnings = [...parsed.warnings]
  if (dropped > 0) {
    warnings.push(`源文件已发生变化，有 ${dropped} 处编辑找不到对应位置，已自动忽略。`)
  }

  // 删除标记记的是数组下标，源文件行数一变就会指向别的记录。
  // 宁可让用户重新标记一次，也不能静默删错，所以内容变化时整体作废并明确告知。
  const previousDeleted = session.deleted ?? []
  if (sourceChanged && previousDeleted.length > 0) {
    session.deleted = []
    warnings.push(
      `源文件已发生变化，已清除 ${previousDeleted.length} 个删除标记，请重新确认要删除哪些记录。`
    )
  } else {
    session.deleted = previousDeleted.filter((i) => i < mergedRecords.length)
  }

  // 已确认下标是合并空间的位置：源文件变了之后可能越界或指错对象，夹到有效范围。
  const previousConfirmed = session.confirmed ?? []
  session.confirmed = previousConfirmed.filter((i) => i >= 0 && i < mergedRecords.length)

  // 字段顺序：以源文件里的为主，新记录的字段追加在末尾（去重保持首次出现）
  const fieldOrder = mergeFieldOrder(parsed.fieldOrder, added)

  workspaces.set(sessionId, {
    sessionId,
    state: session,
    records: mergedRecords,
    byId: new Map(mergedRecords.map((r) => [r.id, r])),
    fieldOrder,
    warnings
  })

  if (!session.exportConfig) {
    session.exportConfig = {
      format: parsed.format === 'parquet' ? 'parquet' : parsed.format === 'jsonl' ? 'jsonl' : 'jsonl',
      columns: defaultColumns(fieldOrder, false),
      scope: 'all',
      indent: 2,
      delimiter: ',',
      flattenIndent: null,
      includeIndex: false
    }
  }
  await saveSession(session)

  await sendChunks(sender, sessionId, mergedRecords)

  return {
    sessionId,
    source: session.source,
    recordCount: mergedRecords.length,
    fieldOrder,
    warnings,
    edits: session.edits,
    deleted: session.deleted,
    view: session.view ?? null,
    exportConfig: session.exportConfig,
    lastExportPath: session.lastExportPath,
    resumed,
    sourceChanged,
    added: session.added,
    confirmed: session.confirmed
  }
}

/** 字段顺序：源文件里的字段先出现，新增记录里的新字段按首次出现的次序追加。 */
function mergeFieldOrder(sourceOrder: string[], added: import('@shared/types').AddedRecord[]): string[] {
  const out: string[] = [...sourceOrder]
  const seen = new Set(out)
  for (const a of added) {
    for (const key of Object.keys(a.data)) {
      if (!seen.has(key)) {
        seen.add(key)
        out.push(key)
      }
    }
  }
  return out
}

function toSourceMeta(parsed: Awaited<ReturnType<typeof readSourceFile>>, filePath: string) {
  return {
    path: filePath,
    name: filePath.split(/[\\/]/).pop() ?? filePath,
    ext: filePath.slice(filePath.lastIndexOf('.')).toLowerCase(),
    size: parsed.size,
    mtimeMs: parsed.mtimeMs,
    fingerprint: parsed.fingerprint,
    format: parsed.format
  }
}

export interface CreateInput {
  destPath: string
  format: 'jsonl' | 'json' | 'csv' | 'tsv' | 'yaml'
  /** 只用来写 CSV 的表头，不预置任何记录。 */
  columns: string[]
}

/**
 * 新建一个空的数据集文件。
 * 两条硬校验保住「源文件只读」的红线精神：不覆盖已存在的文件，不落在应用进度目录里。
 */
export async function createDataset(input: CreateInput): Promise<{ path: string }> {
  const dest = path.resolve(input.destPath)

  const sessionsRoot = path.resolve(sessionsDir())
  if (dest === sessionsRoot || dest.startsWith(sessionsRoot + path.sep)) {
    throw new Error('不能把数据集建在应用的进度目录里，请另选一个位置。')
  }

  try {
    await fsp.access(dest)
    throw new Error('这个位置已经有文件了。CorpusEditor 不会覆盖已有文件，请换一个文件名。')
  } catch (err) {
    // access 抛 ENOENT 正是我们要的「不存在」；上面那条覆盖错误要继续往外抛
    if ((err as Error).message.startsWith('这个位置')) throw err
  }

  await fsp.mkdir(path.dirname(dest), { recursive: true })
  await fsp.writeFile(dest, initialContent(input), 'utf8')
  return { path: dest }
}

/** 新文件一律是空的：模板只决定「新增记录」时的字段骨架，不预置任何记录。 */
function initialContent(input: CreateInput): string {
  switch (input.format) {
    case 'json':
    case 'yaml':
      return '[]\n'
    case 'csv':
      return `\ufeff${csvHeader(input.columns, ',')}`
    case 'tsv':
      return `\ufeff${csvHeader(input.columns, '\t')}`
    default:
      return ''
  }
}

function csvHeader(columns: string[], delimiter: string): string {
  if (columns.length === 0) return ''
  const escape = (value: string) =>
    /[",\n\r\t]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value
  return `${columns.map(escape).join(delimiter)}\n`
}

export interface PersistInput {
  sessionId: string
  edits?: Record<string, Record<string, unknown> | null>
  deleted?: number[]
  view?: ViewState | null
  exportConfig?: ExportConfig | null
  lastExportPath?: string | null
  added?: import('@shared/types').AddedRecord[]
  confirmed?: number[]
}

export interface PersistResult {
  ok: boolean
  updatedAt: number
  /** 值已回到原始内容、因此被清空的记录 id；渲染进程据此同步本地编辑状态。 */
  cleared: string[]
}

export async function persist(input: PersistInput): Promise<PersistResult> {
  const ws = workspaces.get(input.sessionId)
  const state =
    (await patchSession(input.sessionId, {
      edits: input.edits,
      deleted: input.deleted,
      view: input.view,
      exportConfig: input.exportConfig,
      lastExportPath: input.lastExportPath,
      added: input.added,
      confirmed: input.confirmed
    })) ?? null
  if (!state) return { ok: false, updatedAt: Date.now(), cleared: [] }

  const cleared = ws ? pruneEqualToOriginal(ws, state, Object.keys(input.edits ?? {})) : []
  if (cleared.length) await saveSession(state)

  if (ws) {
    ws.state.edits = state.edits
    ws.state.deleted = state.deleted
    if (input.view) ws.state.view = input.view
    if (input.exportConfig !== undefined) ws.state.exportConfig = input.exportConfig
    if (input.lastExportPath !== undefined) ws.state.lastExportPath = input.lastExportPath
    if (input.added) ws.state.added = input.added
    if (input.confirmed) ws.state.confirmed = input.confirmed
  }
  return { ok: true, updatedAt: Date.now(), cleared }
}

/** 值被改回原样后清掉补丁，保证「已修改」标记始终准确。 */
function pruneEqualToOriginal(ws: Workspace, state: SessionState, touched: string[]): string[] {
  const cleared: string[] = []
  for (const recordId of touched) {
    const entry = state.edits[recordId]
    if (!entry) continue
    const record = ws.byId.get(recordId)
    if (!record) {
      delete state.edits[recordId]
      cleared.push(recordId)
      continue
    }
    for (const [key, value] of Object.entries(entry)) {
      const original = getAtPath(record.data, parsePathKey(key))
      if (deepEqual(original, value)) delete entry[key]
    }
    if (Object.keys(entry).length === 0) {
      delete state.edits[recordId]
      cleared.push(recordId)
    }
  }
  return cleared
}

export function getOriginal(sessionId: string, recordId: string): Record<string, unknown> | null {
  const ws = workspaces.get(sessionId)
  if (!ws) return null
  const record = ws.records.find((r) => r.id === recordId)
  return record ? cloneJson(record.data) : null
}

export function getOriginalValues(
  sessionId: string,
  entries: Array<{ recordId: string; pathKey: string }>
): Array<unknown> {
  const ws = workspaces.get(sessionId)
  if (!ws) return entries.map(() => null)
  const byId = new Map(ws.records.map((r) => [r.id, r]))
  return entries.map(({ recordId, pathKey }) => {
    const record = byId.get(recordId)
    if (!record) return null
    const value = getAtPath(record.data, parsePathKey(pathKey))
    return value === undefined ? null : cloneJson(value)
  })
}

export interface ExportInput {
  sessionId: string
  config: ExportConfig
  destPath: string
  scope: ExportScope
  ids: string[]
}

export async function runExport(input: ExportInput): Promise<ExportResult> {
  const ws = workspaces.get(input.sessionId)
  if (!ws) throw new Error('会话已失效，请重新打开文件')

  const sourceResolved = path.resolve(ws.state.source.path)
  const destResolved = path.resolve(input.destPath)
  if (sourceResolved === destResolved) {
    throw new Error('不能导出到源文件本身 —— 原文件必须保持不变，请另选一个输出路径。')
  }

  // 进度目录里存着会话文件，导出到那儿会把进度本身覆盖掉
  const sessionsRoot = path.resolve(sessionsDir())
  if (destResolved === sessionsRoot || destResolved.startsWith(sessionsRoot + path.sep)) {
    throw new Error('不能导出到应用的进度目录，请另选一个输出路径。')
  }

  const deleted = new Set(ws.state.deleted ?? [])
  const confirmed = new Set(ws.state.confirmed ?? [])
  const idSet = input.ids.length ? new Set(input.ids) : null
  let selected = ws.records.filter((r) => !deleted.has(r.index))

  if (input.scope === 'modified') {
    const edited = ws.state.edits ?? {}
    selected = selected.filter((r) => edited[r.id] && Object.keys(edited[r.id]).length > 0)
  } else if (input.scope === 'confirmed') {
    selected = selected.filter((r) => confirmed.has(r.index))
  } else if (input.scope === 'filtered' || input.scope === 'selected') {
    selected = selected.filter((r) => idSet?.has(r.id))
  }

  const patched = applyEdits(selected, ws.state.edits ?? {})
  const result = await writeExport(patched, input.config, destResolved)
  await persist({ sessionId: input.sessionId, lastExportPath: destResolved, exportConfig: input.config })
  return result
}

export async function refreshSourceState(sessionId: string): Promise<{ intact: boolean; missing: boolean }> {
  const ws = workspaces.get(sessionId)
  if (!ws) return { intact: false, missing: true }
  try {
    const stat = await fsp.stat(ws.state.source.path)
    const fingerprint = await quickFingerprint(ws.state.source.path, stat.size)
    return { intact: fingerprint === ws.state.source.fingerprint, missing: false }
  } catch {
    return { intact: false, missing: true }
  }
}
