import type { Json } from '@shared/types'

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
export function pickSummary(data: Record<string, Json>): string {
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
  return '（空记录）'
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

export function formatCount(n: number): string {
  return n.toLocaleString('zh-CN')
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

export function relativeTime(ts: number): string {
  const diff = Date.now() - ts
  if (diff < 60_000) return '刚刚'
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} 分钟前`
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)} 小时前`
  if (diff < 7 * 86_400_000) return `${Math.floor(diff / 86_400_000)} 天前`
  return formatTime(ts)
}
