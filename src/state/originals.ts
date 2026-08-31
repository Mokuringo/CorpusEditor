import { api } from '../lib/api'
import type { Json } from '@shared/types'

const MAX_ENTRIES = 240
const cache = new Map<string, Record<string, Json>>()
const pending = new Map<string, Promise<Record<string, Json> | null>>()

function cacheKey(sessionId: string, recordId: string): string {
  return `${sessionId}|${recordId}`
}

function touch(key: string, value: Record<string, Json>): void {
  cache.delete(key)
  cache.set(key, value)
  while (cache.size > MAX_ENTRIES) {
    const oldest = cache.keys().next().value
    if (oldest === undefined) break
    cache.delete(oldest)
  }
}

/** 读取某条记录的原始内容（用于「改动对照」与「还原」）。带 LRU 缓存。 */
export async function getOriginalRecord(
  sessionId: string,
  recordId: string
): Promise<Record<string, Json> | null> {
  const key = cacheKey(sessionId, recordId)
  const hit = cache.get(key)
  if (hit) {
    touch(key, hit)
    return hit
  }
  const inflight = pending.get(key)
  if (inflight) return inflight

  const task = api
    .getOriginal(sessionId, recordId)
    .then((data) => {
      if (data) touch(key, data)
      return data
    })
    .finally(() => pending.delete(key))
  pending.set(key, task)
  return task
}

export function peekOriginalRecord(sessionId: string, recordId: string): Record<string, Json> | null {
  return cache.get(cacheKey(sessionId, recordId)) ?? null
}

export function clearOriginals(): void {
  cache.clear()
  pending.clear()
}
