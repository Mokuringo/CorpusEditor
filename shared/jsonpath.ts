import type { Json, Path } from './types'

/** 路径 -> 稳定的字符串键（用于 PatchMap 的键）。 */
export function pathKey(path: Path): string {
  return JSON.stringify(path)
}

export function parsePathKey(key: string): Path {
  try {
    const value = JSON.parse(key)
    return Array.isArray(value) ? (value as Path) : []
  } catch {
    return []
  }
}

/** 人类可读路径，例如 messages[2].content。 */
export function formatPath(path: Path): string {
  return path.reduce<string>((acc, seg) => {
    if (typeof seg === 'number') return `${acc}[${seg}]`
    return acc ? `${acc}.${seg}` : String(seg)
  }, '')
}

export function getAtPath(root: unknown, path: Path): unknown {
  let cur: any = root
  for (const seg of path) {
    if (cur == null || typeof cur !== 'object') return undefined
    cur = cur[seg]
  }
  return cur
}

export function hasAtPath(root: unknown, path: Path): boolean {
  return getAtPath(root, path) !== undefined
}

/** 就地写入。路径中间的容器不存在时按需创建（数组下标 -> 数组，否则对象）。 */
export function setAtPath(root: any, path: Path, value: unknown): boolean {
  if (path.length === 0) return false
  let cur: any = root
  for (let i = 0; i < path.length - 1; i++) {
    const seg = path[i]
    if (cur == null || typeof cur !== 'object') return false
    const next = path[i + 1]
    const existing = cur[seg]
    if (existing === null || existing === undefined) {
      // 中间层不存在时按需创建（数组下标 -> 数组，否则对象）
      cur[seg] = typeof next === 'number' ? [] : {}
    } else if (typeof existing !== 'object') {
      // 中间层是标量，继续往下写会破坏数据，直接失败
      return false
    }
    cur = cur[seg]
  }
  const last = path[path.length - 1]
  if (cur == null || typeof cur !== 'object') return false
  cur[last] = value as Json
  return true
}

export function deleteAtPath(root: any, path: Path): boolean {
  if (path.length === 0) return false
  let cur: any = root
  for (let i = 0; i < path.length - 1; i++) {
    if (cur == null || typeof cur !== 'object') return false
    cur = cur[path[i]]
  }
  const last = path[path.length - 1]
  if (cur == null || typeof cur !== 'object') return false
  if (typeof last === 'number' && Array.isArray(cur)) {
    if (last < 0 || last >= cur.length) return false
    cur.splice(last, 1)
    return true
  }
  if (!(last in cur)) return false
  delete cur[last]
  return true
}

export interface StringLeaf {
  path: Path
  value: string
}

/** 收集对象树上所有字符串叶子节点（只遍历对象与数组的值，不含键名）。 */
export function collectStringLeaves(root: unknown, base: Path = [], out: StringLeaf[] = []): StringLeaf[] {
  if (typeof root === 'string') {
    out.push({ path: base, value: root })
    return out
  }
  if (Array.isArray(root)) {
    for (let i = 0; i < root.length; i++) collectStringLeaves(root[i], [...base, i], out)
    return out
  }
  if (root !== null && typeof root === 'object') {
    for (const [k, v] of Object.entries(root)) collectStringLeaves(v, [...base, k], out)
    return out
  }
  return out
}

/** 结构相等的深比较，键顺序不敏感。 */
export function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true
  if (typeof a !== typeof b) return false
  if (a === null || b === null) return false
  if (typeof a !== 'object') return false
  if (Array.isArray(a) !== Array.isArray(b)) return false
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return false
    for (let i = 0; i < a.length; i++) if (!deepEqual(a[i], b[i])) return false
    return true
  }
  const ao = a as Record<string, unknown>
  const bo = b as Record<string, unknown>
  const ak = Object.keys(ao)
  const bk = Object.keys(bo)
  if (ak.length !== bk.length) return false
  for (const k of ak) {
    if (!Object.prototype.hasOwnProperty.call(bo, k)) return false
    if (!deepEqual(ao[k], bo[k])) return false
  }
  return true
}

export function cloneJson<T>(value: T): T {
  if (value === null || typeof value !== 'object') return value
  if (Array.isArray(value)) return value.map(cloneJson) as unknown as T
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) out[k] = cloneJson(v)
  return out as T
}

/** 把值收敛为可 JSON 序列化的形态（处理 bigint / Date / undefined / NaN）。 */
export function toJsonSafe(value: unknown): Json {
  if (value === null || value === undefined) return null
  if (typeof value === 'bigint') return Number(value)
  if (typeof value === 'number') return Number.isFinite(value) ? value : null
  if (typeof value === 'boolean' || typeof value === 'string') return value
  if (value instanceof Date) return value.toISOString()
  if (Array.isArray(value)) return value.map(toJsonSafe)
  if (typeof value === 'object') {
    const out: Record<string, Json> = {}
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) out[k] = toJsonSafe(v)
    return out
  }
  return String(value)
}
