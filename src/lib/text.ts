import type { Locale, TFunc, Vars } from '@shared/locales'
import type { Json } from '@shared/types'

const DEFAULT_LOCALE: Locale = 'zh-CN'

const SUMMARY_PRIORITY = [
  'instruction',
  'prompt',
  'question',
  'query',
  'input',
  'text',
  'content',
  'output',
  'response',
  'answer',
  'completion',
  'system'
]

function firstString(node: unknown, depth = 0): string {
  if (typeof node === 'string') return node
  if (depth > 3 || node === null || typeof node !== 'object') return ''
  if (Array.isArray(node)) {
    for (const item of node) {
      const found = firstString(item, depth + 1)
      if (found) return found
    }
    return ''
  }
  for (const value of Object.values(node as Record<string, unknown>)) {
    const found = firstString(value, depth + 1)
    if (found) return found
  }
  return ''
}

/** 列表里展示记录摘要：优先取常见提问/指令字段，否则取第一个字符串。 */
export function pickSummary(data: Record<string, Json>, tr?: TFunc): string {
  for (const key of SUMMARY_PRIORITY) {
    const value = data[key]
    if (typeof value === 'string' && value.trim()) return value
    if (value && typeof value === 'object') {
      const nested = firstString(value)
      if (nested) return nested
    }
  }
  for (const value of Object.values(data)) {
    if (typeof value === 'string' && value.trim()) return value
    if (value && typeof value === 'object') {
      const nested = firstString(value)
      if (nested) return nested
    }
  }
  return tr ? tr('record.empty') : '（空记录）'
}

function appendStrings(node: unknown, out: string[]): void {
  if (typeof node === 'string') {
    out.push(node)
    return
  }
  if (Array.isArray(node)) {
    for (const item of node) appendStrings(item, out)
    return
  }
  if (node !== null && typeof node === 'object') {
    for (const value of Object.values(node as Record<string, unknown>)) appendStrings(value, out)
  }
}

const INDEX_LIMIT = 600

/** 为搜索建索引：取记录里所有字符串拼成小写文本，单条上限 600 字符以控制内存。 */
export function searchBlob(data: Record<string, Json>): string {
  const parts: string[] = []
  appendStrings(data, parts)
  return parts.join(' ').slice(0, INDEX_LIMIT).toLowerCase()
}

/** 千分位。整数在 zh-CN 与 en-US 下输出一致（都是 1,200），小数与货币才看得出差别。 */
export function formatCount(n: number, locale: Locale = DEFAULT_LOCALE): string {
  return n.toLocaleString(locale)
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  return `${(n / 1024 / 1024).toFixed(1)} MB`
}

export function formatTime(ts: number): string {
  const d = new Date(ts)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

/** 相对时间。四个分支都带数量插值，必须走翻译而不是拼字符串。 */
export function relativeTime(ts: number, tr?: TFunc): string {
  const diff = Date.now() - ts
  const at = (count: number): Vars => ({ count })
  if (diff < 60_000) return tr ? tr('time.justNow') : '刚刚'
  if (diff < 3_600_000) {
    const count = Math.floor(diff / 60_000)
    return tr ? tr('time.minutesAgo', at(count)) : `${count} 分钟前`
  }
  if (diff < 86_400_000) {
    const count = Math.floor(diff / 3_600_000)
    return tr ? tr('time.hoursAgo', at(count)) : `${count} 小时前`
  }
  if (diff < 7 * 86_400_000) {
    const count = Math.floor(diff / 86_400_000)
    return tr ? tr('time.daysAgo', at(count)) : `${count} 天前`
  }
  return formatTime(ts)
}
