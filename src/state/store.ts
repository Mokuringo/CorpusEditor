import { create } from 'zustand'
import { api } from '../lib/api'
import { clearOriginals, getOriginalRecord } from './originals'
import { resetSearchIndex } from './search'
import { applyTheme, loadStoredTheme, resolveTheme, storeTheme } from './theme'
import { flushDrafts } from '../lib/dom'
import {
  applyEdits,
  applyIndexDelta,
  mergeEdits,
  recordStatus,
  shiftAddedPos,
  shiftHistory,
  shiftIndexArray,
  shiftPatchIndices,
  sortEntryKeys
} from '@shared/patch'
import { cloneJson, deepEqual, getAtPath, parsePathKey, pathKey, setAtPath } from '@shared/jsonpath'
import { inspectFields } from '@shared/inspect'
import type { FieldInfo } from '@shared/inspect'
import { defaultColumns } from '@shared/serialize'
import type {
  AddedRecord,
  DataRecord,
  ExportConfig,
  ExportResult,
  ExportScope,
  FilterMode,
  HistoryEntry,
  Json,
  PatchMap,
  Path,
  RecordTemplate,
  ReplacePlan,
  SessionSummary,
  Settings,
  SourceMeta,
  ViewState
} from '@shared/types'
import type { ResolvedTheme, ThemeMode } from './theme'

const HISTORY_LIMIT = 200
const SAVE_DEBOUNCE = 600

export interface DatasetInfo {
  id: string
  source: SourceMeta
  fieldOrder: string[]
  warnings: string[]
  recordCount: number
  resumed: boolean
  sourceChanged: boolean
  lastExportPath: string | null
}

export interface Toast {
  id: number
  kind: 'info' | 'success' | 'error' | 'warn'
  message: string
}

export type SaveState = 'saved' | 'saving' | 'error' | 'idle'

export interface Busy {
  label: string
  progress: number | null
}

interface AppState {
  ready: boolean
  theme: ThemeMode
  resolvedTheme: ResolvedTheme
  toasts: Toast[]
  busy: Busy | null
  sessions: SessionSummary[]
  /** 应用设置的完整快照。写回时必须带着它，否则会把别人的字段抹掉。 */
  settings: Settings | null

  dataset: DatasetInfo | null
  records: DataRecord[]
  fields: FieldInfo[]
  edits: PatchMap
  deleted: Set<number>
  /** 用户新建的记录，按 pos 合并进源记录序列。与 edits 一样要落盘。 */
  added: AddedRecord[]
  /** 已确认下标集合，与 edits 正交：改过且定了、或看过认定没问题，都在这里。 */
  confirmed: Set<number>
  view: ViewState
  undoStack: HistoryEntry[]
  redoStack: HistoryEntry[]
  saveState: SaveState
  lastSavedAt: number | null
  exportConfig: ExportConfig | null

  replaceOpen: boolean
  exportOpen: boolean
  newRecordOpen: boolean
  /** 新建记录的插入位置；null 表示追加到末尾。 */
  newRecordAt: number | null
  warningsDismissed: boolean
}

interface AppActions {
  init: () => Promise<void>
  setTheme: (mode: ThemeMode) => void
  toast: (message: string, kind?: Toast['kind']) => void
  dismissToast: (id: number) => void

  refreshSessions: () => Promise<void>
  openFile: (filePath: string, fresh?: boolean) => Promise<void>
  createDataset: (destPath: string, template: RecordTemplate) => Promise<void>
  saveTemplates: (templates: RecordTemplate[]) => void
  closeDataset: () => Promise<void>
  forgetSession: (sessionId: string) => Promise<void>
  verifySource: (sessionId: string) => Promise<{ intact: boolean; missing: boolean }>

  selectRecord: (index: number) => void
  setQuery: (query: string) => void
  setFilter: (filter: FilterMode) => void
  setScrollTop: (top: number) => void
  /** 批量（多选）模式的开关与勾选。勾选复用 ViewState.selectedIds，不引入新状态。 */
  toggleMultiSelect: () => void
  toggleSelected: (recordId: string) => void
  clearSelected: () => void

  editValue: (recordId: string, path: Path, value: Json) => void
  setMessages: (recordId: string, field: string, nextArray: Json[], label: string) => void
  setRecordData: (recordId: string, nextData: Record<string, Json>) => void
  revertField: (recordId: string, path: Path) => Promise<void>
  revertRecord: (recordId: string) => Promise<void>
  deleteRecord: (index: number) => void
  restoreRecord: (index: number) => void
  /** 在 pos 处插入一条新建记录；pos 缺省为末尾。会整体平移受影响的六处下标。 */
  addRecord: (data: Record<string, Json>, pos?: number) => void
  confirmRecord: (index: number) => void
  unconfirmRecord: (index: number) => void
  /** 批量确认：无论多少条，在撤销栈里只占一格。 */
  confirmMany: (indices: number[]) => void
  undo: () => void
  redo: () => void

  applyReplace: (plan: ReplacePlan, label: string) => void
  openReplace: () => void
  closeReplace: () => void
  openExport: () => void
  closeExport: () => void
  openNewRecord: (at?: number | null) => void
  closeNewRecord: () => void
  saveExportConfig: (config: ExportConfig) => void
  runExport: (config: ExportConfig, destPath: string, scope: ExportScope) => Promise<ExportResult | null>

  flush: () => Promise<void>
}

export type Store = AppState & AppActions

/* ------------------------------------------------------------------ */
/* 自动保存：只把「脏」的部分增量发给主进程                              */
/* ------------------------------------------------------------------ */

let saveTimer: number | null = null
let dirtyIds = new Set<string>()
let dirtyDeleted = false
let dirtyAdded = false
let dirtyConfirmed = false
let dirtyView = false
let dirtyExport = false
let flushing = false
let toastSeq = 0

function markEditsDirty(recordId: string): void {
  dirtyIds.add(recordId)
}

/**
 * 等分块推送收齐。
 *
 * 记录不是 openSource 的返回值带回来的，而是主进程用 `dataset:chunk` 事件逐块推、
 * 渲染进程在回调里攒起来的。两者是**两条独立的 IPC 消息**：主进程虽然先发完块再回响应，
 * 但渲染进程先处理哪一条没有保证。响应若先到，openFile 就会在块还没派发完时
 * off() 掉订阅，攒出一份残缺的记录 —— 表现为「打开成功，列表却是空的」。
 *
 * 所以响应回来后先等数量对上。setTimeout(0) 是有意的：让出宏任务，
 * 好让已排队的 IPC 消息被派发。收不齐宁可报错，也不能拿残缺数据往下走。
 */
async function awaitChunks(chunks: DataRecord[], expected: number, timeoutMs = 10000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (chunks.length < expected) {
    if (Date.now() > deadline) {
      throw new Error(`只收到 ${chunks.length} / ${expected} 条记录，文件没读全，请重开一次`)
    }
    await new Promise((r) => setTimeout(r, 0))
  }
}

/**
 * immediate 给「结构性操作」用：新增记录、确认、删除这些不能等 600ms。
 * 丢一个字符还能重打，丢一整条新建记录或一次 128 条批量确认，代价完全不一样。
 */
function scheduleSave(get: () => Store, set: (partial: Partial<AppState>) => void, immediate = false): void {
  if (!get().dataset) return
  set({ saveState: 'saving' })
  if (saveTimer !== null) window.clearTimeout(saveTimer)
  saveTimer = window.setTimeout(
    () => {
      saveTimer = null
      void doFlush(get, set)
    },
    immediate ? 0 : SAVE_DEBOUNCE
  )
}

async function doFlush(get: () => Store, set: (partial: Partial<AppState>) => void): Promise<void> {
  const state = get()
  const dataset = state.dataset
  if (!dataset) return
  if (flushing) return
  flushing = true
  try {
    const payload: Parameters<typeof api.persist>[0] = { sessionId: dataset.id }
    const touched = [...dirtyIds]
    if (touched.length) {
      const edits: Record<string, Record<string, Json> | null> = {}
      for (const id of touched) edits[id] = get().edits[id] ?? null
      payload.edits = edits
      dirtyIds = new Set()
    }
    if (dirtyDeleted) {
      payload.deleted = [...get().deleted]
      dirtyDeleted = false
    }
    if (dirtyAdded) {
      payload.added = get().added
      dirtyAdded = false
    }
    if (dirtyConfirmed) {
      payload.confirmed = [...get().confirmed]
      dirtyConfirmed = false
    }
    if (dirtyView) {
      payload.view = get().view
      dirtyView = false
    }
    if (dirtyExport) {
      payload.exportConfig = get().exportConfig
      payload.lastExportPath = get().dataset?.lastExportPath ?? null
      dirtyExport = false
    }

    if (
      !payload.edits &&
      !payload.deleted &&
      !payload.added &&
      !payload.confirmed &&
      !payload.view &&
      !payload.exportConfig
    ) {
      set({ saveState: 'saved' })
      return
    }

    const result = await api.persist(payload)
    if (!result.ok) {
      set({ saveState: 'error' })
      return
    }
    if (result.cleared?.length) {
      const next = { ...get().edits }
      for (const id of result.cleared) delete next[id]
      set({ edits: next })
    }
    set({ saveState: 'saved', lastSavedAt: result.updatedAt })
  } catch {
    set({ saveState: 'error' })
  } finally {
    flushing = false
  }
}

/* ------------------------------------------------------------------ */

const emptyView: ViewState = {
  selectedIndex: 0,
  scrollTop: 0,
  filter: 'all',
  query: '',
  selectedIds: [],
  multiSelect: false
}

export const useStore = create<Store>((set, get) => {
  const schedule = (immediate = false) => scheduleSave(get, set, immediate)

  /**
   * 应用一批补丁（编辑 / 替换 / 确认 / 删除记录 / 恢复记录的公共通路）。
   * entry.deleted 与 entry.confirmed 是两条独立的下标集合变更，一次操作可以同时改到它们。
   */
  function applyBatch(input: HistoryEntry, immediate = false): void {
    const { records, edits, deleted, confirmed, undoStack } = get()
    const nextRecords = Object.keys(input.forward).length ? patchRecords(records, input.forward) : records
    const nextEdits = mergeEdits(edits, input.forward, input.replace)
    const nextDeleted = applyIndexDelta(deleted, input.deleted, 'do')
    // 数据一改，之前那次「确认」就作废：被改到的记录退回待确认，要求重新过一遍。
    // 退回动作要写进 history entry，撤销时才能把确认状态一起恢复回来。
    const dropped = input.confirmed ? [] : confirmedAmong(Object.keys(input.forward), confirmed)
    const nextConfirmed = input.confirmed
      ? applyIndexDelta(confirmed, input.confirmed, 'do')
      : removeIndices(confirmed, dropped)
    const entry: HistoryEntry = dropped.length
      ? { ...input, confirmed: { add: [], remove: dropped } }
      : input

    set({
      records: nextRecords,
      edits: nextEdits,
      deleted: nextDeleted,
      confirmed: nextConfirmed,
      undoStack: [...undoStack, entry].slice(-HISTORY_LIMIT),
      redoStack: []
    })
    for (const id of Object.keys(input.forward)) markEditsDirty(id)
    if (nextDeleted !== deleted) dirtyDeleted = true
    if (nextConfirmed !== confirmed) dirtyConfirmed = true
    schedule(
      immediate || Boolean(entry.deleted) || Boolean(entry.confirmed) || dropped.length > 0
    )
  }

  /** 撤销 / 重做：不进历史栈，只更新数据与补丁。 */
  function applyHistoryEntry(entry: HistoryEntry, direction: 'undo' | 'redo'): void {
    const { records, edits, deleted, confirmed, undoStack, redoStack } = get()
    const patch = direction === 'undo' ? entry.inverse : entry.forward
    const way = direction === 'undo' ? 'undo' : 'do'
    const nextRecords = Object.keys(patch).length ? patchRecords(records, patch) : records
    const nextEdits = mergeEdits(edits, patch, entry.replace)
    const nextDeleted = applyIndexDelta(deleted, entry.deleted, way)
    const nextConfirmed = applyIndexDelta(confirmed, entry.confirmed, way)
    set({
      records: nextRecords,
      edits: nextEdits,
      deleted: nextDeleted,
      confirmed: nextConfirmed,
      undoStack: direction === 'undo' ? undoStack.slice(0, -1) : [...undoStack, entry],
      redoStack: direction === 'undo' ? [...redoStack, entry] : redoStack.slice(0, -1)
    })
    for (const id of Object.keys(patch)) markEditsDirty(id)
    if (nextDeleted !== deleted) dirtyDeleted = true
    if (nextConfirmed !== confirmed) dirtyConfirmed = true
    schedule(true)
  }

  /**
   * 插入 / 移除一条新增记录：记录序列与所有存了下标的地方一起平移。
   * 撤销栈的重排交给 undo / redo —— 触发这次插入的那个 entry 不能跟着平移，
   * 它的 pos 记的是新下标空间里的位置。
   */
  function shiftRecordSequence(pos: number, data: Record<string, Json> | null): void {
    const state = get()
    const insert = data !== null
    const mode = insert ? 'insert' : 'remove'
    const delta = insert ? 1 : -1
    const seed = data === null ? null : cloneJson(data)
    const nextRecords: DataRecord[] = []
    for (let i = 0; i < state.records.length; i++) {
      if (seed !== null && i === pos) {
        nextRecords.push({
          id: String(nextRecords.length),
          index: nextRecords.length,
          data: seed,
          origin: 'new'
        })
      }
      if (!insert && i === pos) continue
      nextRecords.push({ ...state.records[i], id: String(nextRecords.length), index: nextRecords.length })
    }
    if (seed !== null && pos >= state.records.length) {
      nextRecords.push({ id: String(nextRecords.length), index: nextRecords.length, data: seed, origin: 'new' })
    }
    const nextEdits = shiftPatchIndices(state.edits, pos, delta, mode)
    const nextDeleted = new Set(shiftIndexArray([...state.deleted], pos, delta, mode))
    const nextConfirmed = new Set(shiftIndexArray([...state.confirmed], pos, delta, mode))
    const nextAdded = shiftAddedPos(state.added, pos, delta, mode)
    const selectedIndex = shiftIndexArray([state.view.selectedIndex], pos, delta, mode)[0]
    const selectedIds = shiftIndexArray(
      state.view.selectedIds.map(Number).filter(Number.isFinite),
      pos,
      delta,
      mode
    ).map(String)
    // 下标整体错位后，按 recordId 缓存的原始值全部失效
    clearOriginals()
    resetSearchIndex()
    set({
      records: nextRecords,
      edits: nextEdits,
      deleted: nextDeleted,
      confirmed: nextConfirmed,
      added: nextAdded,
      view: {
        ...state.view,
        selectedIndex: Math.max(0, Math.min(selectedIndex, Math.max(0, nextRecords.length - 1))),
        selectedIds
      }
    })
    dirtyAdded = true
    dirtyConfirmed = true
    dirtyDeleted = true
    dirtyIds = new Set(Object.keys(nextEdits))
    schedule(true)
  }

  /** 记录 id 列表里落在「已确认」集合中的那些下标。 */
  function confirmedAmong(recordIds: string[], confirmed: Set<number>): number[] {
    const out: number[] = []
    for (const id of recordIds) {
      const index = Number(id)
      if (Number.isFinite(index) && confirmed.has(index)) out.push(index)
    }
    return out
  }

  function removeIndices(set: Set<number>, indices: number[]): Set<number> {
    if (indices.length === 0) return set
    const next = new Set(set)
    for (const index of indices) next.delete(index)
    return next
  }

  return {
    ready: false,
    theme: loadStoredTheme(),
    resolvedTheme: resolveTheme(loadStoredTheme()),
    toasts: [],
    busy: null,
    sessions: [],
    settings: null,

    dataset: null,
    records: [],
    fields: [],
    edits: {},
    deleted: new Set<number>(),
    added: [],
    confirmed: new Set<number>(),
    view: emptyView,
    undoStack: [],
    redoStack: [],
    saveState: 'idle',
    lastSavedAt: null,
    exportConfig: null,

    replaceOpen: false,
    exportOpen: false,
    newRecordOpen: false,
    newRecordAt: null,
    warningsDismissed: false,

    async init() {
      const mode = get().theme
      set({ resolvedTheme: resolveTheme(mode) })
      applyTheme(resolveTheme(mode))
      window.matchMedia?.('(prefers-color-scheme: dark)').addEventListener('change', () => {
        if (get().theme !== 'system') return
        const next = resolveTheme('system')
        set({ resolvedTheme: next })
        applyTheme(next)
      })

      api.onFlushRequest(() => {
        void (async () => {
          // 强制失焦，让 AutoTextarea / NumberInput 的草稿先提交到 store
          flushDrafts()
          if (saveTimer !== null) {
            window.clearTimeout(saveTimer)
            saveTimer = null
          }
          await doFlush(get, set)
          api.flushed()
        })()
      })

      try {
        const settings = await api.getSettings()
        set({ settings })
        if (settings?.theme && settings.theme !== get().theme) {
          set({ theme: settings.theme, resolvedTheme: resolveTheme(settings.theme) })
          applyTheme(resolveTheme(settings.theme))
        }
      } catch {
        // 设置读取失败不影响使用
      }

      await get().refreshSessions()
      set({ ready: true })
    },

    setTheme(mode) {
      const resolved = resolveTheme(mode)
      storeTheme(mode)
      set({ theme: mode, resolvedTheme: resolved })
      applyTheme(resolved)
      // 带着整份设置写回：只发 theme 会把自定义模板之类的字段抹掉
      const base: Settings = get().settings ?? defaultSettings()
      const next: Settings = { ...base, theme: mode }
      set({ settings: next })
      void api.setSettings(next)
    },

    saveTemplates(templates) {
      const base: Settings = get().settings ?? defaultSettings()
      const next: Settings = { ...base, recordTemplates: templates }
      set({ settings: next })
      void api.setSettings(next)
    },

    toast(message, kind = 'info') {
      const id = ++toastSeq
      set({ toasts: [...get().toasts, { id, kind, message }] })
      window.setTimeout(() => get().dismissToast(id), kind === 'error' ? 8000 : 4000)
    },

    dismissToast(id) {
      set({ toasts: get().toasts.filter((t) => t.id !== id) })
    },

    async refreshSessions() {
      try {
        const sessions = await api.listSessions()
        set({ sessions })
      } catch {
        set({ sessions: [] })
      }
    },

    async openFile(filePath, fresh = false) {
      set({ busy: { label: '正在读取文件…', progress: 0 }, saveState: 'idle', warningsDismissed: false })
      const chunks: DataRecord[] = []
      let total = 0
      const off = api.onDatasetChunk((chunk) => {
        for (const record of chunk.records) chunks.push(record)
        total = chunk.total
        set({
          busy: {
            label: `正在载入 ${chunks.length.toLocaleString('zh-CN')} / ${total.toLocaleString('zh-CN')} 条`,
            progress: total ? chunks.length / total : 0
          }
        })
      })
      try {
        const result = await api.openSource(filePath, fresh)
        // 先等块收齐再 off()，否则会拿到一份不完整的记录（awaitChunks 的注释说明了原委）
        await awaitChunks(chunks, result.recordCount)
        off()
        const records = applyEdits(chunks, result.edits)
        // 扫描全部记录的键，避免靠后的记录里有新字段却被漏掉；每个字段只取前 200 个样本判定类型
        const fields = inspectFields(records)
        const view = result.view ?? emptyView
        if (view.selectedIndex >= records.length) view.selectedIndex = 0
        resetSearchIndex()
        clearOriginals()
        dirtyIds = new Set()
        dirtyDeleted = false
        dirtyAdded = false
        dirtyConfirmed = false
        dirtyView = false
        dirtyExport = false
        const resumedAdded = result.added?.length ?? 0
        const resumedConfirmed = result.confirmed?.length ?? 0
        set({
          dataset: {
            id: result.sessionId,
            source: result.source,
            fieldOrder: result.fieldOrder,
            warnings: result.warnings,
            recordCount: result.recordCount,
            resumed: result.resumed,
            sourceChanged: result.sourceChanged,
            lastExportPath: result.lastExportPath
          },
          records,
          fields,
          edits: result.edits ?? {},
          deleted: new Set(result.deleted ?? []),
          added: result.added ?? [],
          confirmed: new Set(result.confirmed ?? []),
          view,
          exportConfig: result.exportConfig,
          undoStack: [],
          redoStack: [],
          busy: null,
          saveState: 'saved',
          lastSavedAt: Date.now()
        })
        await get().refreshSessions()
        if (result.resumed) {
          const modified = Object.keys(result.edits ?? {}).length
          const parts = [`${records.length.toLocaleString('zh-CN')} 条记录`]
          if (modified > 0) parts.push(`${modified.toLocaleString('zh-CN')} 条改动`)
          if (resumedAdded > 0) parts.push(`${resumedAdded.toLocaleString('zh-CN')} 条新建`)
          if (resumedConfirmed > 0) parts.push(`${resumedConfirmed.toLocaleString('zh-CN')} 条已确认`)
          get().toast(`已恢复上次进度：${parts.join('，')}`, 'success')
        }
      } catch (err) {
        off()
        set({ busy: null })
        get().toast(`打开失败：${(err as Error).message}`, 'error')
        throw err
      }
    },

    async closeDataset() {
      // 关文件前先让焦点元素失焦，提交未失焦的草稿
      flushDrafts()
      if (saveTimer !== null) {
        window.clearTimeout(saveTimer)
        saveTimer = null
      }
      await doFlush(get, set)
      clearOriginals()
      resetSearchIndex()
      dirtyAdded = false
      dirtyConfirmed = false
      set({
        dataset: null,
        records: [],
        fields: [],
        edits: {},
        deleted: new Set<number>(),
        added: [],
        confirmed: new Set<number>(),
        view: emptyView,
        undoStack: [],
        redoStack: [],
        exportConfig: null,
        saveState: 'idle',
        lastSavedAt: null,
        replaceOpen: false,
        exportOpen: false,
        newRecordOpen: false,
        newRecordAt: null
      })
      await get().refreshSessions()
    },

    /** 新建一个空数据集文件并立刻打开它。模板只写 CSV 表头，不预置记录。 */
    async createDataset(destPath, template) {
      const ext = destPath.slice(destPath.lastIndexOf('.')).toLowerCase()
      const format: 'jsonl' | 'json' | 'csv' | 'tsv' | 'yaml' =
        ext === '.json'
          ? 'json'
          : ext === '.csv'
            ? 'csv'
            : ext === '.tsv' || ext === '.tab'
              ? 'tsv'
              : ext === '.yaml' || ext === '.yml'
                ? 'yaml'
                : 'jsonl'
      try {
        await api.createDataset({ destPath, format, columns: template.fields.map((f) => f.name) })
      } catch (err) {
        get().toast(`新建失败：${(err as Error).message}`, 'error')
        throw err
      }
      await get().openFile(destPath)
    },

    async forgetSession(sessionId) {
      if (!window.confirm('丢弃这份文件的全部编辑进度？此操作不可撤销。')) return
      try {
        await api.forgetSession(sessionId)
      } catch (err) {
        get().toast(`丢弃失败：${(err as Error).message}`, 'error')
        return
      }
      if (get().dataset?.id === sessionId) await get().closeDataset()
      else await get().refreshSessions()
    },

    async verifySource(sessionId) {
      try {
        return await api.verifySource(sessionId)
      } catch {
        return { intact: false, missing: true }
      }
    },

    selectRecord(index) {
      const { view } = get()
      if (view.selectedIndex === index) return
      // 切记录前先失焦，让 AutoTextarea 的草稿先提交到 store
      flushDrafts()
      set({ view: { ...view, selectedIndex: index } })
      dirtyView = true
      schedule()
    },

    setQuery(query) {
      set({ view: { ...get().view, query } })
      dirtyView = true
      schedule()
    },

    setFilter(filter) {
      set({ view: { ...get().view, filter } })
      dirtyView = true
      schedule()
    },

    setScrollTop(top) {
      const { view } = get()
      if (Math.abs(view.scrollTop - top) < 4) return
      set({ view: { ...view, scrollTop: top } })
      dirtyView = true
    },

    toggleMultiSelect() {
      const { view } = get()
      // 退出多选时清空勾选，视图恢复原样
      const nextIds = view.multiSelect ? [] : view.selectedIds
      set({ view: { ...view, multiSelect: !view.multiSelect, selectedIds: nextIds } })
      dirtyView = true
      schedule()
    },

    toggleSelected(recordId) {
      const { view } = get()
      const set$ = new Set(view.selectedIds)
      if (set$.has(recordId)) set$.delete(recordId)
      else set$.add(recordId)
      set({ view: { ...view, selectedIds: [...set$] } })
      dirtyView = true
      schedule()
    },

    clearSelected() {
      const { view } = get()
      if (view.selectedIds.length === 0) return
      set({ view: { ...view, selectedIds: [] } })
      dirtyView = true
      schedule()
    },

    editValue(recordId, path, value) {
      const { records, edits, undoStack } = get()
      const index = Number(recordId)
      const record = records[index]
      if (!record) return
      const before = getAtPath(record.data, path)
      if (deepEqual(before, value)) return
      const key = pathKey(path)
      const data = cloneJson(record.data)
      if (!setAtPath(data, path, value)) return
      const nextRecords = records.slice()
      nextRecords[index] = { ...record, data }
      const entry: HistoryEntry = {
        label: '编辑字段',
        forward: { [recordId]: { [key]: value } },
        inverse: { [recordId]: { [key]: (before === undefined ? null : before) as Json } }
      }
      set({
        records: nextRecords,
        edits: { ...edits, [recordId]: { ...(edits[recordId] ?? {}), [key]: value } },
        undoStack: [...undoStack, entry].slice(-HISTORY_LIMIT),
        redoStack: []
      })
      markEditsDirty(recordId)
      schedule()
    },

    /**
     * 整体重写对话数组（增删轮次）。
     * 因为会改变下标，该记录下的补丁条目必须整体替换，否则撤销/重做会串位。
     */
    setMessages(recordId, field, nextArray, label) {
      const { records, edits, undoStack } = get()
      const index = Number(recordId)
      const record = records[index]
      if (!record) return
      const oldArray = record.data[field]
      if (!Array.isArray(oldArray)) return
      const fieldKey = pathKey([field])
      const previous = edits[recordId] ?? {}
      const kept: Record<string, Json> = {}
      const subEdits: Record<string, Json> = {}
      for (const [key, value] of Object.entries(previous)) {
        const path = parsePathKey(key)
        if (path.length > 0 && path[0] === field) subEdits[key] = value
        else kept[key] = value
      }
      const data = cloneJson(record.data)
      if (!setAtPath(data, [field], nextArray as Json)) return
      const nextRecords = records.slice()
      nextRecords[index] = { ...record, data }
      const forwardEntry: Record<string, Json> = { ...kept, [fieldKey]: nextArray as Json }
      const inverseEntry: Record<string, Json> = { ...kept, ...subEdits, [fieldKey]: cloneJson(oldArray) as Json }
      set({
        records: nextRecords,
        edits: { ...edits, [recordId]: forwardEntry },
        undoStack: [
          ...undoStack,
          {
            label,
            forward: { [recordId]: forwardEntry },
            inverse: { [recordId]: inverseEntry },
            replace: [recordId]
          }
        ].slice(-HISTORY_LIMIT),
        redoStack: []
      })
      markEditsDirty(recordId)
      schedule()
    },

    /**
     * 还原单个字段。
     * 会一并清掉该字段下的所有子路径补丁（例如对话里某一轮的改动），
     * 否则父级先写回原始数组、子级补丁再覆盖一次，还原就失效了。
     */
    async revertField(recordId, path) {
      const dataset = get().dataset
      if (!dataset) return
      const state = get()
      const index = Number(recordId)
      const record = state.records[index]
      if (!record) return

      const [original] = await api.getOriginals(dataset.id, [{ recordId, pathKey: pathKey(path) }])
      const current = getAtPath(record.data, path)
      if (current === undefined && (original === null || original === undefined)) return
      if (deepEqual(current, original)) {
        // 值已经和原始一致，只需清掉残留的子路径补丁
      }

      const prefix = pathKey(path)
      const previous = state.edits[recordId] ?? {}
      const kept: Record<string, Json> = {}
      const removed: Record<string, Json> = {}
      for (const [key, value] of Object.entries(previous)) {
        const parsed = parsePathKey(key)
        const under = parsed.length > path.length && path.every((seg, i) => parsed[i] === seg)
        if (key === prefix || under) removed[key] = value
        else kept[key] = value
      }

      const data = cloneJson(record.data)
      setAtPath(data, path, (original === undefined ? null : original) as Json)
      const nextRecords = state.records.slice()
      nextRecords[index] = { ...record, data }

      const nextEntry: Record<string, Json> =
        original === undefined || original === null ? { ...kept } : { ...kept, [prefix]: original as Json }
      const nextEdits: PatchMap = { ...state.edits }
      if (Object.keys(nextEntry).length === 0) delete nextEdits[recordId]
      else nextEdits[recordId] = nextEntry

      const inverseEntry: Record<string, Json> = {
        ...kept,
        ...removed,
        ...(current === undefined ? {} : { [prefix]: current as Json })
      }

      set({
        records: nextRecords,
        edits: nextEdits,
        undoStack: [
          ...state.undoStack,
          {
            label: '还原字段',
            forward: { [recordId]: nextEntry },
            inverse: { [recordId]: inverseEntry },
            replace: [recordId]
          }
        ].slice(-HISTORY_LIMIT),
        redoStack: []
      })
      markEditsDirty(recordId)
      schedule()
    },

    /** 以 JSON 整体重写一条记录（整条 JSON 编辑器使用）。 */
    setRecordData(recordId, nextData) {
      const state = get()
      const index = Number(recordId)
      const record = state.records[index]
      if (!record) return
      const forward: Record<string, Json> = {}
      const inverse: Record<string, Json> = {}
      for (const key of new Set([...Object.keys(nextData), ...Object.keys(record.data)])) {
        const path: Path = [key]
        const before = getAtPath(record.data, path)
        const after = getAtPath(nextData, path)
        if (deepEqual(before, after)) continue
        forward[pathKey(path)] = (after === undefined ? null : after) as Json
        inverse[pathKey(path)] = (before === undefined ? null : before) as Json
      }
      if (Object.keys(forward).length === 0) return
      const nextRecords = state.records.slice()
      nextRecords[index] = { ...record, data: cloneJson(nextData) }
      set({
        records: nextRecords,
        edits: { ...state.edits, [recordId]: forward },
        undoStack: [
          ...state.undoStack,
          {
            label: '整条 JSON 编辑',
            forward: { [recordId]: forward },
            inverse: { [recordId]: inverse },
            replace: [recordId]
          }
        ].slice(-HISTORY_LIMIT),
        redoStack: []
      })
      markEditsDirty(recordId)
      schedule()
    },

    async revertRecord(recordId) {
      const dataset = get().dataset
      const { records } = get()
      if (!dataset) return
      const index = Number(recordId)
      const record = records[index]
      if (!record) return
      const original = await getOriginalRecord(dataset.id, recordId)
      if (!original) return
      const forward: Record<string, Json> = {}
      const inverse: Record<string, Json> = {}
      const keys = new Set([...Object.keys(original), ...Object.keys(record.data)])
      for (const key of keys) {
        const path: Path = [key]
        const before = getAtPath(record.data, path)
        const after = getAtPath(original, path)
        if (deepEqual(before, after)) continue
        forward[pathKey(path)] = (after === undefined ? null : after) as Json
        inverse[pathKey(path)] = (before === undefined ? null : before) as Json
      }
      if (Object.keys(forward).length === 0) return
      applyBatch({ label: '还原整条记录', forward: { [recordId]: forward }, inverse: { [recordId]: inverse } })
    },

    deleteRecord(index) {
      if (get().deleted.has(index)) return
      applyBatch({
        label: `删除第 ${index + 1} 条`,
        forward: {},
        inverse: {},
        deleted: { add: [index], remove: [] }
      })
    },

    restoreRecord(index) {
      if (!get().deleted.has(index)) return
      applyBatch({
        label: `恢复第 ${index + 1} 条`,
        forward: {},
        inverse: {},
        deleted: { add: [], remove: [index] }
      })
    },

    addRecord(data, pos) {
      const { records } = get()
      const at = Math.max(0, Math.min(pos ?? records.length, records.length))
      // 先平移历史栈：现有 entry 里的下标都是旧空间的，插入后要整体 +1
      const undoStack = shiftHistory(get().undoStack, at, 1, 'insert')
      const redoStack = shiftHistory(get().redoStack, at, 1, 'insert')
      set({ undoStack, redoStack })
      shiftRecordSequence(at, data)
      const item: AddedRecord = { pos: at, data: cloneJson(data) }
      set({
        added: [...get().added, item],
        undoStack: [
          ...get().undoStack,
          { label: `新增第 ${at + 1} 条`, forward: {}, inverse: {}, added: item }
        ].slice(-HISTORY_LIMIT),
        redoStack: [],
        view: { ...get().view, selectedIndex: at }
      })
      dirtyAdded = true
      schedule(true)
    },

    confirmRecord(index) {
      if (get().confirmed.has(index)) return
      // 已删除的记录不需要确认：它连导出都进不去，确认它没有意义。
      // 这里必须和 confirmMany 的过滤条件一致，否则单条能确认、批量却跳过，行为自相矛盾。
      if (get().deleted.has(index)) return
      applyBatch({
        label: `确认第 ${index + 1} 条`,
        forward: {},
        inverse: {},
        confirmed: { add: [index], remove: [] }
      })
    },

    unconfirmRecord(index) {
      if (!get().confirmed.has(index)) return
      applyBatch({
        label: `退回第 ${index + 1} 条`,
        forward: {},
        inverse: {},
        confirmed: { add: [], remove: [index] }
      })
    },

    confirmMany(indices) {
      const { confirmed, deleted } = get()
      const add = [...new Set(indices)].filter((i) => !confirmed.has(i) && !deleted.has(i)).sort((a, b) => a - b)
      if (add.length === 0) return
      // 无论多少条，在撤销栈里只占一格
      applyBatch({
        label: `确认 ${add.length} 条`,
        forward: {},
        inverse: {},
        confirmed: { add, remove: [] }
      })
    },

    undo() {
      const { undoStack, redoStack } = get()
      const entry = undoStack[undoStack.length - 1]
      if (!entry) return
      if (entry.added) {
        const pos = entry.added.pos
        const rest = undoStack.slice(0, -1)
        // 先摘掉自己再平移：entry 的 pos 记的是新空间，不能被一起挪
        set({ undoStack: shiftHistory(rest, pos, -1, 'remove') })
        set({ redoStack: shiftHistory(redoStack, pos, -1, 'remove') })
        shiftRecordSequence(pos, null)
        set({ added: get().added.filter((a) => a !== entry.added), redoStack: [...get().redoStack, entry] })
        dirtyAdded = true
        schedule(true)
        return
      }
      applyHistoryEntry(entry, 'undo')
    },

    redo() {
      const { undoStack, redoStack } = get()
      const entry = redoStack[redoStack.length - 1]
      if (!entry) return
      if (entry.added) {
        const pos = entry.added.pos
        set({ redoStack: shiftHistory(redoStack.slice(0, -1), pos, 1, 'insert') })
        set({ undoStack: shiftHistory(undoStack, pos, 1, 'insert') })
        shiftRecordSequence(pos, entry.added.data)
        set({ added: [...get().added, entry.added], undoStack: [...get().undoStack, entry] })
        dirtyAdded = true
        schedule(true)
        return
      }
      applyHistoryEntry(entry, 'redo')
    },

    applyReplace(plan, label) {
      applyBatch({ label, forward: plan.patch, inverse: plan.inverse })
    },

    openReplace() {
      set({ replaceOpen: true })
    },

    closeReplace() {
      set({ replaceOpen: false })
    },

    openExport() {
      set({ exportOpen: true })
    },

    closeExport() {
      set({ exportOpen: false })
    },

    openNewRecord(at = null) {
      set({ newRecordOpen: true, newRecordAt: at })
    },

    closeNewRecord() {
      set({ newRecordOpen: false, newRecordAt: null })
    },

    saveExportConfig(config) {
      set({ exportConfig: config })
      dirtyExport = true
      schedule()
    },

    // 注意：这里不能用全局 busy，否则 App 会把工作区换成加载页，
    // 导出弹窗被卸载重挂，导出结果就显示不出来了。进度反馈交给弹窗自己。
    async runExport(config, destPath, scope) {
      const dataset = get().dataset
      if (!dataset) return null
      try {
        const visibleIds = scope === 'filtered' ? computeExportIds(get()) : []
        const result = await api.runExport({
          sessionId: dataset.id,
          config,
          destPath,
          scope,
          ids: visibleIds
        })
        set({
          dataset: { ...dataset, lastExportPath: result.destPath },
          exportConfig: config
        })
        dirtyExport = true
        if (saveTimer !== null) {
          window.clearTimeout(saveTimer)
          saveTimer = null
        }
        await doFlush(get, set)
        return result
      } catch (err) {
        get().toast(`导出失败：${(err as Error).message}`, 'error')
        return null
      }
    },

    async flush() {
      if (saveTimer !== null) {
        window.clearTimeout(saveTimer)
        saveTimer = null
      }
      await doFlush(get, set)
    }
  }
})

function patchRecords(records: DataRecord[], patch: PatchMap): DataRecord[] {
  const next = records.slice()
  for (const [recordId, entry] of Object.entries(patch)) {
    const index = Number(recordId)
    const record = next[index]
    if (!record) continue
    const data = cloneJson(record.data)
    for (const [key, value] of sortEntryKeys(entry)) {
      setAtPath(data, parsePathKey(key), value)
    }
    next[index] = { ...record, data }
  }
  return next
}

function computeExportIds(state: Store): string[] {
  const { records, edits, deleted, confirmed, view } = state
  const query = view.query.trim().toLowerCase()
  const out: string[] = []
  for (const record of records) {
    if (deleted.has(record.index)) continue
    if (query && !JSON.stringify(record.data).toLowerCase().includes(query)) continue
    const status = recordStatus(record.index, false, edits, deleted, confirmed)
    if (view.filter === 'pending' && status !== 'pending') continue
    if (view.filter === 'confirmed' && status !== 'confirmed') continue
    if (view.filter === 'unmodified' && status !== 'unmodified') continue
    out.push(record.id)
  }
  return out
}

/** 设置还没从主进程读回来时的兜底值。 */
function defaultSettings(): Settings {
  return { theme: 'system', locale: 'zh-CN', lastOpenDir: null, recentSessionIds: [], recordTemplates: [] }
}

/** 生成导出面板的默认列配置。 */
export function buildDefaultExportConfig(fieldOrder: string[]): ExportConfig {
  return {
    format: 'jsonl',
    columns: defaultColumns(fieldOrder, false),
    scope: 'all',
    indent: 2,
    delimiter: ',',
    flattenIndent: null,
    includeIndex: false
  }
}
