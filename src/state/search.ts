import { searchBlob } from '../lib/text'
import type { DataRecord, FilterMode, PatchMap } from '@shared/types'

let cachedIndex: string[] | null = null
let cachedFor: DataRecord[] | null = null

export function resetSearchIndex(): void {
  cachedIndex = null
  cachedFor = null
}

/** 首次搜索时构建全文索引；之后复用，编辑会让它按引用失效。 */
export function ensureIndex(records: DataRecord[]): string[] {
  if (cachedIndex && cachedFor === records) return cachedIndex
  const index = new Array<string>(records.length)
  for (let i = 0; i < records.length; i++) index[i] = searchBlob(records[i].data)
  cachedIndex = index
  cachedFor = records
  return index
}

export function hasIndexFor(records: DataRecord[]): boolean {
  return cachedIndex !== null && cachedFor === records
}

export interface VisibilityArgs {
  records: DataRecord[]
  edits: PatchMap
  deleted: Set<number>
  confirmed: Set<number>
  filter: FilterMode
  query: string
}

/** 依据筛选条件与搜索词算出可见记录的数组下标。 */
export function computeVisibleIndices({
  records,
  edits,
  deleted,
  confirmed,
  filter,
  query
}: VisibilityArgs): number[] {
  const q = query.trim().toLowerCase()
  const index = q ? ensureIndex(records) : null
  const out: number[] = []
  for (let i = 0; i < records.length; i++) {
    const record = records[i]
    const isDeleted = deleted.has(record.index)
    if (filter === 'deleted') {
      if (!isDeleted) continue
    } else if (isDeleted) {
      continue
    }
    if (filter !== 'all') {
      const modified = Boolean(edits[record.id] && Object.keys(edits[record.id]).length > 0)
      const isConfirmed = confirmed.has(record.index)
      // 已确认优先：确认过的记录即使后来又被改动，在「已确认」页签里也还在，
      // 只是状态徽章会退回待确认 —— 不玩「确认完就从列表消失」的把戏。
      if (filter === 'confirmed' && !isConfirmed) continue
      if (filter === 'pending' && (!modified || isConfirmed)) continue
      if (filter === 'unmodified' && (modified || isConfirmed)) continue
    }
    if (index && !index[i].includes(q)) continue
    out.push(i)
  }
  return out
}
