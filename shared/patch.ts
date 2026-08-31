import { cloneJson, getAtPath, parsePathKey, pathKey, setAtPath } from './jsonpath'
import type {
  AddedRecord,
  DataRecord,
  HistoryEntry,
  IndexDelta,
  Json,
  PatchMap,
  Path
} from './types'

export function emptyPatch(): PatchMap {
  return {}
}

/**
 * 应用一次操作对某个下标集合（删除标记 / 已确认）的增删。
 * direction 为 'undo' 时把 add 与 remove 对调，正好得到反向操作。
 * 未发生变化时返回原集合引用，调用方可以据此判断要不要标脏。
 */
export function applyIndexDelta(
  set: Set<number>,
  delta: IndexDelta | undefined,
  direction: 'do' | 'undo' = 'do'
): Set<number> {
  if (!delta) return set
  const add = direction === 'undo' ? delta.remove : delta.add
  const remove = direction === 'undo' ? delta.add : delta.remove
  if (add.length === 0 && remove.length === 0) return set
  const next = new Set(set)
  for (const index of add) next.add(index)
  for (const index of remove) next.delete(index)
  return next
}

export function patchSize(edits: PatchMap): number {
  let n = 0
  for (const rid of Object.keys(edits)) n += Object.keys(edits[rid] ?? {}).length
  return n
}

export function modifiedRecordCount(edits: PatchMap): number {
  return Object.keys(edits).length
}

/**
 * 一个记录条目里的补丁按键的路径长度升序排列：先写父级再写子级。
 * 这样「整体替换数组」与「修改数组某一项」同时存在时结果仍然确定。
 */
export function sortEntryKeys(entry: Record<string, Json>): Array<[string, Json]> {
  return Object.entries(entry).sort((a, b) => pathLength(a[0]) - pathLength(b[0]))
}

function pathLength(key: string): number {
  return parsePathKey(key).length
}

/** 把补丁应用到记录数组上。只克隆被改动过的记录，未改动的记录直接复用引用。 */
export function applyEdits(records: DataRecord[], edits: PatchMap): DataRecord[] {
  if (!edits || Object.keys(edits).length === 0) return records
  return records.map((record) => {
    const entry = edits[record.id]
    if (!entry || Object.keys(entry).length === 0) return record
    const data = cloneJson(record.data)
    for (const [key, value] of sortEntryKeys(entry)) {
      setAtPath(data, parsePathKey(key), value)
    }
    return { ...record, data }
  })
}

/** 计算补丁的反操作：需要 pristine 记录来取旧值。 */
export function invertEdits(records: DataRecord[], edits: PatchMap): PatchMap {
  const byId = new Map(records.map((r) => [r.id, r]))
  const inverse: PatchMap = {}
  for (const [recordId, entry] of Object.entries(edits)) {
    const record = byId.get(recordId)
    if (!record) continue
    const target: Record<string, Json> = {}
    for (const key of Object.keys(entry)) {
      const old = getAtPath(record.data, parsePathKey(key))
      target[key] = (old === undefined ? null : old) as Json
    }
    inverse[recordId] = target
  }
  return inverse
}

/**
 * 把 incoming 合并进 base（incoming 覆盖 base）。返回新对象，不修改入参。
 * replace 里列出的记录 id 表示「整条替换」，用于数组结构变更的场景。
 */
export function mergeEdits(base: PatchMap, incoming: PatchMap, replace?: string[]): PatchMap {
  const out: PatchMap = { ...base }
  const replaceSet = replace?.length ? new Set(replace) : null
  for (const [recordId, entry] of Object.entries(incoming)) {
    if (replaceSet?.has(recordId)) {
      out[recordId] = { ...entry }
      continue
    }
    const existing = out[recordId]
    if (!existing) {
      out[recordId] = { ...entry }
      continue
    }
    out[recordId] = { ...existing, ...entry }
  }
  return out
}

/** 移除记录级补丁（用于「还原整条记录」）。 */
export function dropRecordEdits(edits: PatchMap, recordIds: string[]): PatchMap {
  if (recordIds.length === 0) return edits
  const out: PatchMap = { ...edits }
  let changed = false
  for (const id of recordIds) {
    if (id in out) {
      delete out[id]
      changed = true
    }
  }
  return changed ? out : edits
}

/** 删除单条路径补丁；若该记录已无补丁则一并移除整条记录键。 */
export function unsetPath(edits: PatchMap, recordId: string, path: Path): PatchMap {
  const entry = edits[recordId]
  if (!entry) return edits
  const key = pathKey(path)
  if (!(key in entry)) return edits
  const nextEntry: Record<string, Json> = {}
  for (const [k, v] of Object.entries(entry)) {
    if (k !== key) nextEntry[k] = v
  }
  const out: PatchMap = { ...edits }
  if (Object.keys(nextEntry).length === 0) delete out[recordId]
  else out[recordId] = nextEntry
  return out
}

export function setPathValue(edits: PatchMap, recordId: string, path: Path, value: Json): PatchMap {
  const key = pathKey(path)
  const existing = edits[recordId]
  if (existing && existing[key] !== undefined && Object.is(existing[key], value)) return edits
  return { ...edits, [recordId]: { ...(existing ?? {}), [key]: value } }
}

export function getEditedPaths(edits: PatchMap, recordId: string): string[] {
  return Object.keys(edits[recordId] ?? {})
}

/** 判断两个补丁是否作用在同一批路径上（用于撤销栈去重校验，当前仅做浅比较）。 */
export function patchEntryCount(edits: PatchMap, recordId: string): number {
  return Object.keys(edits[recordId] ?? {}).length
}

/**
 * 恢复会话时过滤掉在当前数据上已经不存在的路径。
 * 源文件被改过时会发生这种情况，避免凭空造出字段。
 */
export function filterValidEdits(
  records: DataRecord[],
  edits: PatchMap
): { edits: PatchMap; dropped: number } {
  const byId = new Map(records.map((r) => [r.id, r]))
  const out: PatchMap = {}
  let dropped = 0
  for (const [recordId, entry] of Object.entries(edits)) {
    const record = byId.get(recordId)
    if (!record) {
      dropped += Object.keys(entry).length
      continue
    }
    const kept: Record<string, Json> = {}
    for (const [key, value] of Object.entries(entry)) {
      const path = parsePathKey(key)
      if (path.length === 0) {
        dropped++
        continue
      }
      const parent = getAtPath(record.data, path.slice(0, -1))
      if (parent === null || typeof parent !== 'object' || !isValidSlot(parent, path[path.length - 1])) {
        dropped++
        continue
      }
      kept[key] = value
    }
    if (Object.keys(kept).length > 0) out[recordId] = kept
  }
  return { edits: out, dropped }
}

function isValidSlot(parent: object, segment: string | number): boolean {
  if (Array.isArray(parent)) {
    return typeof segment === 'number' && Number.isInteger(segment) && segment >= 0 && segment < parent.length
  }
  return segment in (parent as Record<string, unknown>)
}

/* ------------------------------------------------------------------ *
 *  下标平移：插入 / 删除新增记录时，对 patches、deleted、confirmed、  *
 *  added[].pos、undoStack / redoStack 的相关下标统一做 ±1 偏移。     *
 *  原则：插入到 pos N 时用「>= N」+1；撤销（移除 pos N 的新增）时   *
 *  用「> N」-1。这样 insert ↔ undo 互为严格逆操作。                   *
 * ------------------------------------------------------------------ */

type ShiftMode = 'insert' | 'remove'

/** 移位方向。'insert' 表示插入时用 `>= fromIndex` 推后；'remove' 表示撤销时用 `> fromIndex` 推前。 */
const SHIFT_RANGES: Record<ShiftMode, (k: number, from: number) => boolean> = {
  insert: (k, from) => k >= from,
  remove: (k, from) => k > from
}

/** 把 PatchMap 里所有受影响的下标键按 mode 平移 delta。delta 通常是 +1（插入）或 -1（撤销）。 */
export function shiftPatchIndices(
  patches: PatchMap,
  fromIndex: number,
  delta: number,
  mode: ShiftMode = 'insert'
): PatchMap {
  if (delta === 0) return patches
  const test = SHIFT_RANGES[mode]
  let changed = false
  const out: PatchMap = {}
  for (const [key, value] of Object.entries(patches)) {
    const k = Number(key)
    if (Number.isFinite(k) && test(k, fromIndex)) {
      out[String(k + delta)] = value
      changed = true
    } else {
      out[key] = value
    }
  }
  return changed ? out : patches
}

/** deleted / confirmed 这类下标数组。返回新数组，原数组不变。 */
export function shiftIndexArray(
  indices: number[],
  fromIndex: number,
  delta: number,
  mode: ShiftMode = 'insert'
): number[] {
  if (delta === 0) return indices
  const test = SHIFT_RANGES[mode]
  let changed = false
  const out: number[] = []
  for (const v of indices) {
    if (test(v, fromIndex)) {
      out.push(v + delta)
      changed = true
    } else {
      out.push(v)
    }
  }
  return changed ? out : indices
}

/** added 数组里 pos 受影响的记录平移 delta；保持数组次序稳定。 */
export function shiftAddedPos(
  added: AddedRecord[],
  fromIndex: number,
  delta: number,
  mode: ShiftMode = 'insert'
): AddedRecord[] {
  if (delta === 0) return added
  const test = SHIFT_RANGES[mode]
  let changed = false
  const out: AddedRecord[] = []
  for (const a of added) {
    if (test(a.pos, fromIndex)) {
      out.push({ pos: a.pos + delta, data: a.data })
      changed = true
    } else {
      out.push(a)
    }
  }
  return changed ? out : added
}

/** 把 added 按 pos 合并进源记录。返回新数组，每个 id = String(index)，origin 已标好。
 *  多个 added 可以共享同一个 pos（保持它们在 added 里的次序）。
 *  pos 越界（>= 合并后总长）会被追加到末尾；负数按 0 处理。
 */
export function mergeAddedIntoRecords(
  parsed: DataRecord[],
  added: AddedRecord[]
): DataRecord[] {
  if (added.length === 0) {
    return parsed.map((r, i) => ({ id: String(i), index: i, data: cloneJson(r.data), origin: 'source' as const }))
  }
  // 把 added 按 pos 分桶；同 pos 的保持原数组次序
  const total = parsed.length + added.length
  const buckets = new Map<number, AddedRecord[]>()
  const tail: AddedRecord[] = []
  for (const a of added) {
    if (a.pos >= 0 && a.pos < total) {
      const pos = Math.max(0, a.pos)
      const list = buckets.get(pos) ?? []
      list.push(a)
      buckets.set(pos, list)
    } else {
      tail.push(a)
    }
  }

  const out: DataRecord[] = []
  let src = 0
  for (let pos = 0; pos < total; pos++) {
    const bucket = buckets.get(pos)
    if (bucket && bucket.length > 0) {
      for (const a of bucket) {
        out.push({
          id: String(out.length),
          index: out.length,
          data: cloneJson(a.data),
          origin: 'new'
        })
      }
    } else if (src < parsed.length) {
      out.push({
        id: String(out.length),
        index: out.length,
        data: cloneJson(parsed[src].data),
        origin: 'source'
      })
      src++
    }
    // 全部源记录都消费完但还有桶没处理：这种情况不会发生（total - added.length = parsed.length）
  }
  for (const a of tail) {
    out.push({
      id: String(out.length),
      index: out.length,
      data: cloneJson(a.data),
      origin: 'new'
    })
  }
  return out
}

/** 新增记录的下标集合，用于「这是新建的」快速判定。 */
export function newRecordIndexSet(added: AddedRecord[]): Set<number> {
  const s = new Set<number>()
  for (const a of added) s.add(a.pos)
  return s
}

/**
 * 撤销栈 / 重做栈的整体下标平移。
 * 插入一条记录会让后面所有下标 +1，历史里存的下标必须跟着走，否则 Ctrl+Z 会改错记录。
 * 只平移「已有」的 entry：触发这次插入的那个 entry 是在平移之后才 push 进去的。
 */
export function shiftHistory(
  stack: HistoryEntry[],
  fromIndex: number,
  delta: number,
  mode: ShiftMode = 'insert'
): HistoryEntry[] {
  if (delta === 0 || stack.length === 0) return stack
  let changed = false
  const out = stack.map((entry) => {
    const forward = shiftPatchIndices(entry.forward, fromIndex, delta, mode)
    const inverse = shiftPatchIndices(entry.inverse, fromIndex, delta, mode)
    const next: HistoryEntry = { ...entry, forward, inverse }
    if (forward !== entry.forward || inverse !== entry.inverse) changed = true

    if (entry.deleted) {
      next.deleted = shiftDelta(entry.deleted, fromIndex, delta, mode)
      if (next.deleted !== entry.deleted) changed = true
    }
    if (entry.confirmed) {
      next.confirmed = shiftDelta(entry.confirmed, fromIndex, delta, mode)
      if (next.confirmed !== entry.confirmed) changed = true
    }
    if (entry.added) {
      const shifted = shiftAddedPos([entry.added], fromIndex, delta, mode)[0]
      next.added = shifted
      if (shifted !== entry.added) changed = true
    }
    return next
  })
  return changed ? out : stack
}

function shiftDelta(
  delta: IndexDelta,
  fromIndex: number,
  deltaValue: number,
  mode: ShiftMode
): IndexDelta {
  return {
    add: shiftIndexArray(delta.add, fromIndex, deltaValue, mode),
    remove: shiftIndexArray(delta.remove, fromIndex, deltaValue, mode)
  }
}

/* ------------------------------------------------------------------ *
 *  状态判定：「已修改」「已确认」「已删除」「新建」抽象成一个函数，   *
 *  散在 5 处的重复实现收口。                                          *
 * ------------------------------------------------------------------ */

/** 与 FilterMode 对齐（多了 'new' —— 来源维度，不是筛选维度）。 */
export type RecordStatus = 'unmodified' | 'pending' | 'confirmed' | 'deleted' | 'new'

/**
 * 判定一条记录的状态。
 *  - deleted 优先级最高：被打了删除标记的源记录永远是 deleted
 *  - new：来自 added 的新记录
 *  - confirmed：被「确认」过（不论有没有改过）
 *  - pending：edits 里挂了这条的路径，但还没确认
 *  - unmodified：其它
 */
export function recordStatus(
  index: number,
  isNew: boolean,
  edits: PatchMap,
  deleted: Set<number>,
  confirmed: Set<number>
): RecordStatus {
  if (deleted.has(index)) return 'deleted'
  if (isNew) return 'new'
  if (confirmed.has(index)) return 'confirmed'
  const entry = edits[String(index)]
  if (entry && Object.keys(entry).length > 0) return 'pending'
  return 'unmodified'
}
