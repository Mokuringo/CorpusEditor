import { collectStringLeaves, deepEqual, formatPath, getAtPath, pathKey } from './jsonpath'
import { detectConversation, detectPairs, fieldStringPaths, normalizeRole } from './inspect'
import type { ErrorCode, Vars } from './errors'
import type { DataRecord, Json, PatchMap, Path, ReplaceOptions, ReplacePlan, ReplaceSample, ReplaceTarget } from './types'

export function escapeRegExp(input: string): string {
  return input.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * 匹配失败的返回值。
 * error 是错误码而不是文案，detail 带上正则引擎给的原文 —— 那部分跟随操作系统语言，
 * 我们管不到，只能原样接在翻译好的前缀后面。
 */
export interface MatcherResult {
  regex: RegExp | null
  error: ErrorCode | null
  detail?: Vars
}

const WORD_GUARD_LEFT = '(?<![\\p{L}\\p{N}_])'
const WORD_GUARD_RIGHT = '(?![\\p{L}\\p{N}_])'

export function buildMatcher(options: ReplaceOptions): MatcherResult {
  if (!options.find) return { regex: null, error: 'REPLACE_FIND_EMPTY' }
  let source = options.useRegex ? options.find : escapeRegExp(options.find)
  if (options.wholeWord) source = `${WORD_GUARD_LEFT}(?:${source})${WORD_GUARD_RIGHT}`
  // 全字匹配依赖 \p{L} 与后行断言，必须带 u 标志；其余场景不加 u 以兼容旧式正则写法。
  const flags = `g${options.caseSensitive ? '' : 'i'}${options.wholeWord ? 'u' : ''}`
  try {
    return { regex: new RegExp(source, flags), error: null }
  } catch (err) {
    return { regex: null, error: 'REPLACE_REGEX_INVALID', detail: { detail: (err as Error).message } }
  }
}

interface Slot {
  recordId: string
  recordIndex: number
  path: Path
  text: string
}

function slotsForRecord(record: DataRecord, target: ReplaceTarget): Slot[] {
  const slots: Slot[] = []
  const push = (path: Path, text: string) => {
    slots.push({ recordId: record.id, recordIndex: record.index, path, text })
  }

  const walk = (node: unknown, base: Path): void => {
    if (typeof node === 'string') {
      push(base, node)
      return
    }
    if (Array.isArray(node)) {
      const shape = node.length <= 500 ? detectConversation([node]) : null
      if (shape) {
        // 对话数组里只把「内容」当文本；角色名属于结构信息，不参与替换
        pushContent(node, shape, base)
        return
      }
      node.forEach((item, i) => walk(item, [...base, i]))
      return
    }
    if (node !== null && typeof node === 'object') {
      for (const [key, value] of Object.entries(node)) walk(value, [...base, key])
    }
  }

  const pushContent = (
    items: unknown[],
    shape: { roleKey: string; contentKey: string },
    base: Path
  ): void => {
    items.forEach((item, i) => {
      const obj = (item && typeof item === 'object' ? item : {}) as Record<string, unknown>
      const path = [...base, i, shape.contentKey]
      const content = obj[shape.contentKey]
      if (typeof content === 'string') {
        push(path, content)
        return
      }
      for (const leaf of collectStringLeaves(content, path)) push(leaf.path, leaf.value)
    })
  }

  if (target.type === 'everything') {
    walk(record.data, [])
    return slots
  }

  const container = record.data[target.field]

  if (target.type === 'field') {
    if (Array.isArray(container)) {
      const shape = detectConversation([container])
      if (shape) {
        pushContent(container, shape, [target.field])
        return slots
      }
    }
    for (const path of fieldStringPaths(record.data, target.field)) {
      const value = getAtPath(record.data, path)
      if (typeof value === 'string') push(path, value)
    }
    return slots
  }

  // 按角色：只处理对话数组里该角色的 content
  if (!Array.isArray(container)) return slots

  // 键即角色的形态：键名本身就是角色，命中哪个键就替换哪个键的值
  const pairs = detectPairs([container])
  if (pairs) {
    container.forEach((item, i) => {
      if (!item || typeof item !== 'object' || Array.isArray(item)) return
      for (const [key, value] of Object.entries(item as Record<string, unknown>)) {
        if (normalizeRole(key) !== normalizeRole(target.role)) continue
        if (typeof value !== 'string') return
        push([target.field, i, key], value)
      }
    })
    return slots
  }

  const shape = detectConversation([container])
  if (!shape) return slots
  container.forEach((item, i) => {
    const obj = (item && typeof item === 'object' ? item : {}) as Record<string, unknown>
    const role = typeof obj[shape.roleKey] === 'string' ? String(obj[shape.roleKey]) : ''
    if (normalizeRole(role) !== normalizeRole(target.role)) return
    const path = [target.field, i, shape.contentKey]
    const content = obj[shape.contentKey]
    if (typeof content === 'string') {
      push(path, content)
      return
    }
    for (const leaf of collectStringLeaves(content, path)) push(leaf.path, leaf.value)
  })
  return slots
}

export interface ReplaceScope {
  /** null 表示全部记录。 */
  ids: Set<string> | null
}

const SAMPLE_LIMIT = 12
const SNIPPET_RADIUS = 140

function snippetAround(text: string, index: number, radius = SNIPPET_RADIUS): string {
  if (text.length <= radius * 2 + 24) return text
  const start = Math.max(0, index - radius)
  const end = Math.min(text.length, index + radius)
  return `${start > 0 ? '…' : ''}${text.slice(start, end)}${end < text.length ? '…' : ''}`
}

/**
 * 计算替换计划（不修改任何数据）。
 * 返回正向补丁与反向补丁，调用方据此执行 / 撤销。
 */
export function planReplace(
  records: DataRecord[],
  target: ReplaceTarget,
  options: ReplaceOptions,
  scope: ReplaceScope = { ids: null }
): { plan: ReplacePlan | null; error: ErrorCode | null; detail?: Vars } {
  const { regex, error, detail } = buildMatcher(options)
  if (!regex) return { plan: null, error, detail }

  const patch: PatchMap = {}
  const inverse: PatchMap = {}
  const samples: ReplaceSample[] = []
  let matchCount = 0
  let affectedRecords = 0

  for (const record of records) {
    if (scope.ids && !scope.ids.has(record.id)) continue
    let recordTouched = false
    for (const slot of slotsForRecord(record, target)) {
      if (!slot.text) continue
      regex.lastIndex = 0
      const matches = slot.text.match(regex)
      if (!matches || matches.length === 0) continue
      const next = options.useRegex
        ? slot.text.replace(regex, options.replace)
        : slot.text.replace(regex, () => options.replace)
      if (next === slot.text) continue

      const key = pathKey(slot.path)
      ;(patch[record.id] ??= {})[key] = next as Json
      ;(inverse[record.id] ??= {})[key] = slot.text as Json
      matchCount += matches.length
      recordTouched = true

      if (samples.length < SAMPLE_LIMIT) {
        regex.lastIndex = 0
        const at = slot.text.search(regex)
        samples.push({
          recordId: record.id,
          recordIndex: record.index,
          pathKey: key,
          pathLabel: formatPath(slot.path),
          before: snippetAround(slot.text, at < 0 ? 0 : at),
          after: snippetAround(next, at < 0 ? 0 : at)
        })
      }
    }
    if (recordTouched) affectedRecords++
  }

  return {
    plan: { matchCount, affectedRecords, samples, patch, inverse },
    error: null,
    detail: undefined
  }
}

/** 把替换计划落到编辑补丁上（正向或反向）。 */
export function commitPlan(edits: PatchMap, plan: ReplacePlan, direction: 'forward' | 'backward'): PatchMap {
  const incoming = direction === 'forward' ? plan.patch : plan.inverse
  const out: PatchMap = { ...edits }
  for (const [recordId, entry] of Object.entries(incoming)) {
    out[recordId] = { ...(out[recordId] ?? {}), ...entry }
  }
  return out
}

/** 判断一条字符串在给定选项下是否命中（用于列表高亮预览）。 */
export function testMatch(text: string, options: ReplaceOptions): boolean {
  const { regex } = buildMatcher(options)
  if (!regex) return false
  regex.lastIndex = 0
  return regex.test(text)
}

export function sameValue(a: unknown, b: unknown): boolean {
  return deepEqual(a, b)
}
