import type { Path } from './types'

/** 常见「对话容器」字段名。 */
export const CONTAINER_KEYS = [
  'messages',
  'conversations',
  'conversation',
  'dialog',
  'dialogue',
  'turns',
  'chat',
  'history',
  'chats'
]
/** 常见「角色」字段名。 */
export const ROLE_KEYS = ['role', 'from', 'speaker', 'author', 'sender', 'who']
/** 常见「内容」字段名。 */
export const CONTENT_KEYS = ['content', 'value', 'text', 'message', 'utterance', 'body']

export type RoleKind = 'system' | 'user' | 'assistant' | 'tool' | 'other'

export type FieldKind =
  | { type: 'messages'; roleKey: string; contentKey: string; roles: string[] }
  /** 「键即角色」的对话写法：数组元素形如 { human: '...', assistant: '...' }，键名本身就是角色。 */
  | { type: 'pairs'; keys: string[] }
  | { type: 'text'; long: boolean }
  | { type: 'number' }
  | { type: 'boolean' }
  | { type: 'empty' }
  | { type: 'json' }

/** 一轮里最多认这么多角色键，超过就当普通结构处理，避免把字典误判成对话。 */
const MAX_PAIR_KEYS = 6

export function normalizeRole(role: unknown): RoleKind {
  const r = String(role ?? '').toLowerCase().trim()
  if (!r) return 'other'
  if (r === 'system' || r === 'sys') return 'system'
  if (r === 'user' || r === 'human' || r === 'customer' || r === 'prompter') return 'user'
  if (r === 'assistant' || r === 'gpt' || r === 'bot' || r === 'model' || r === 'ai' || r === 'chatbot') {
    return 'assistant'
  }
  if (r === 'tool' || r === 'function' || r === 'function_call' || r === 'observation' || r === 'tool_call') {
    return 'tool'
  }
  return 'other'
}

export function roleLabel(role: string): string {
  const kind = normalizeRole(role)
  const map: Record<RoleKind, string> = {
    system: 'System',
    user: 'User',
    assistant: 'Assistant',
    tool: 'Tool',
    other: 'Other'
  }
  return map[kind] === 'Other' && role ? role : map[kind]
}

interface MessageShape {
  roleKey: string
  contentKey: string
}

function detectMessageShape(item: unknown): MessageShape | null {
  if (!item || typeof item !== 'object' || Array.isArray(item)) return null
  const obj = item as Record<string, unknown>
  const roleKey = ROLE_KEYS.find((k) => typeof obj[k] === 'string')
  if (!roleKey) return null
  const contentKey = CONTENT_KEYS.find((k) => k in obj)
  if (!contentKey) return null
  return { roleKey, contentKey }
}

/**
 * 判定某个字段是否为「对话数组」。
 * 取所有记录里该字段的值做多数表决：超过半数是非空数组且元素符合 {role, content} 形态即认为是对话。
 */
export function detectConversation(values: unknown[]): { roleKey: string; contentKey: string; roles: string[] } | null {
  const samples = values.filter((v) => v !== null && v !== undefined)
  if (samples.length === 0) return null
  let hits = 0
  let shape: MessageShape | null = null
  const roles = new Set<string>()
  for (const value of samples) {
    if (!Array.isArray(value) || value.length === 0) continue
    const shapes = value.map(detectMessageShape)
    const valid = shapes.filter((s): s is MessageShape => s !== null)
    if (valid.length === 0) continue
    hits++
    shape = valid[0]
    for (const item of value) {
      const obj = item as Record<string, unknown> | null
      if (obj && typeof obj[shape.roleKey] === 'string') roles.add(String(obj[shape.roleKey]))
    }
  }
  if (!shape || hits < Math.max(1, Math.ceil(samples.length / 2))) return null
  return { roleKey: shape.roleKey, contentKey: shape.contentKey, roles: [...roles] }
}

/** 判断单个对象是不是「键即角色」的写法：键名本身是角色、值是字符串。 */
function detectPairShape(item: unknown): string[] | null {
  if (!item || typeof item !== 'object' || Array.isArray(item)) return null
  const obj = item as Record<string, unknown>
  // 带 role / from 这类角色键的是标准对话形态，交给 detectMessageShape，别抢
  if (ROLE_KEYS.some((k) => k in obj)) return null
  const keys = Object.keys(obj)
  if (keys.length === 0 || keys.length > MAX_PAIR_KEYS) return null
  for (const key of keys) {
    if (normalizeRole(key) === 'other') return null
    if (typeof obj[key] !== 'string') return null
  }
  return keys
}

/**
 * 判定某个字段是否为「键即角色」的对话数组。
 * ShareGPT 有一种常见变体把一轮写成 { human: '...', assistant: '...' } 而不是
 * [{ from: 'human', value: '...' }]，这两种都要能编辑。
 * 判定同样走多数表决：超过半数的非空数组元素是键即角色形态即认为命中。
 */
export function detectPairs(values: unknown[]): { keys: string[] } | null {
  const samples = values.filter((v) => v !== null && v !== undefined)
  if (samples.length === 0) return null
  let hits = 0
  const keys: string[] = []
  for (const value of samples) {
    if (!Array.isArray(value) || value.length === 0) continue
    const shapes = value.map(detectPairShape)
    if (shapes.some((s) => s === null)) continue
    hits++
    for (const shape of shapes as string[][]) {
      for (const key of shape) if (!keys.includes(key)) keys.push(key)
    }
  }
  if (hits < Math.max(1, Math.ceil(samples.length / 2))) return null
  return keys.length > 0 ? { keys } : null
}

const LONG_TEXT_THRESHOLD = 120

/** 依据字段在所有记录中的取值，推断应该用什么编辑器渲染。 */
export function inspectField(values: unknown[]): FieldKind {
  // 顺序有讲究：标准对话（role + content）比键即角色更严格，先判它，
  // 两种形态天然互斥（content 归一化后是 other，进不了 pairs），但显式排序更好读。
  const conv = detectConversation(values)
  if (conv) return { type: 'messages', ...conv }
  const pairs = detectPairs(values)
  if (pairs) return { type: 'pairs', ...pairs }

  const present = values.filter((v) => v !== null && v !== undefined && v !== '')
  if (present.length === 0) return { type: 'empty' }
  const allString = present.every((v) => typeof v === 'string')
  if (allString) {
    const avg = present.reduce((sum, v) => sum + String(v).length, 0) / present.length
    return { type: 'text', long: avg > LONG_TEXT_THRESHOLD || present.some((v) => String(v).includes('\n')) }
  }
  if (present.every((v) => typeof v === 'number')) return { type: 'number' }
  if (present.every((v) => typeof v === 'boolean')) return { type: 'boolean' }
  return { type: 'json' }
}

export interface FieldInfo {
  name: string
  kind: FieldKind
}

/** 扫描数据集，返回每个顶层字段的推断结果。 */
export function inspectFields(records: Array<{ data: Record<string, unknown> }>): FieldInfo[] {
  const buckets = new Map<string, unknown[]>()
  for (const record of records) {
    for (const [key, value] of Object.entries(record.data)) {
      let bucket = buckets.get(key)
      if (!bucket) {
        bucket = []
        buckets.set(key, bucket)
      }
      if (bucket.length < 200) bucket.push(value)
    }
  }
  return [...buckets.entries()].map(([name, values]) => ({ name, kind: inspectField(values) }))
}

/** 生成一个字段下所有「可编辑文本」的路径与角色信息。 */
export interface ContentSlot {
  path: Path
  /** 对话场景下为消息下标，普通字段为 -1。 */
  messageIndex: number
  role: string | null
}

export function fieldContentSlots(data: Record<string, unknown>, field: string, kind: FieldKind): ContentSlot[] {
  const value = data[field]
  if (kind.type === 'messages') {
    if (!Array.isArray(value)) return []
    return value.map((item, i) => {
      const obj = (item && typeof item === 'object' ? item : {}) as Record<string, unknown>
      const role = typeof obj[kind.roleKey] === 'string' ? String(obj[kind.roleKey]) : ''
      return { path: [field, i, kind.contentKey], messageIndex: i, role }
    })
  }
  // 键即角色：每个角色键都给一个可编辑槽位，role 就是键名本身
  if (kind.type === 'pairs') {
    if (!Array.isArray(value)) return []
    const out: ContentSlot[] = []
    value.forEach((item, i) => {
      if (!item || typeof item !== 'object' || Array.isArray(item)) return
      for (const [key, content] of Object.entries(item as Record<string, unknown>)) {
        if (typeof content !== 'string') continue
        out.push({ path: [field, i, key], messageIndex: i, role: key })
      }
    })
    return out
  }
  return [{ path: [field], messageIndex: -1, role: null }]
}

/** 生成一个字段下所有字符串叶子的路径（用于「整个字段」替换）。 */
export function fieldStringPaths(data: Record<string, unknown>, field: string): Path[] {
  const value = data[field]
  if (value === undefined) return []
  if (typeof value === 'string') return [[field]]
  return collectPathsRecursive(value, [field])
}

function collectPathsRecursive(node: unknown, base: Path): Path[] {
  const out: Path[] = []
  if (typeof node === 'string') {
    out.push(base)
    return out
  }
  if (Array.isArray(node)) {
    node.forEach((v, i) => out.push(...collectPathsRecursive(v, [...base, i])))
    return out
  }
  if (node !== null && typeof node === 'object') {
    for (const [k, v] of Object.entries(node)) out.push(...collectPathsRecursive(v, [...base, k]))
    return out
  }
  return out
}

/** 从任意对象里挑出代表「列表」的数组字段。 */
export function findListField(value: unknown): string | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const candidates = [
    'data',
    'records',
    'rows',
    'examples',
    'instances',
    'samples',
    'items',
    'list',
    'dataset',
    'annotations',
    'train',
    'conversations'
  ]
  for (const key of candidates) {
    const v = (value as Record<string, unknown>)[key]
    if (Array.isArray(v)) return key
  }
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (Array.isArray(v) && v.length > 0 && v.every((x) => x && typeof x === 'object' && !Array.isArray(x))) return k
  }
  return null
}
