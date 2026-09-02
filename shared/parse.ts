import { createHash } from 'node:crypto'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import Papa from 'papaparse'
import * as YAML from 'js-yaml'
import { parquetReadObjects } from 'hyparquet'
import { toJsonSafe } from './jsonpath'
import { findListField } from './inspect'
import { appError, warn, type Warning } from './errors'
import type { DataRecord, Json, SourceFormat } from './types'

export const MAX_BYTES = 800 * 1024 * 1024
export const MAX_RECORDS = 1_000_000
export const FINGERPRINT_CHUNK = 256 * 1024

const EXT_MAP: Record<string, SourceFormat> = {
  '.jsonl': 'jsonl',
  '.ndjson': 'jsonl',
  '.jl': 'jsonl',
  '.json': 'json',
  '.csv': 'csv',
  '.tsv': 'tsv',
  '.tab': 'tsv',
  '.yaml': 'yaml',
  '.yml': 'yaml',
  '.parquet': 'parquet',
  '.pq': 'parquet',
  '.txt': 'txt'
}

export function detectFormat(fileName: string): SourceFormat {
  const ext = fileName.slice(fileName.lastIndexOf('.')).toLowerCase()
  return EXT_MAP[ext] ?? 'jsonl'
}

export function isSupportedFile(fileName: string): boolean {
  const ext = fileName.slice(fileName.lastIndexOf('.')).toLowerCase()
  return ext in EXT_MAP
}

export function supportedExtensions(): string[] {
  return Object.keys(EXT_MAP)
}

function stripBom(text: string): string {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text
}

export interface ParsedSource {
  records: DataRecord[]
  fieldOrder: string[]
  warnings: Warning[]
}

export async function parseBuffer(format: SourceFormat, buffer: Buffer, name = ''): Promise<ParsedSource> {
  switch (format) {
    case 'jsonl':
      return parseJsonl(buffer)
    case 'json':
      return parseJson(buffer)
    case 'csv':
      return parseDelimited(buffer, undefined, name)
    case 'tsv':
      return parseDelimited(buffer, '\t', name)
    case 'yaml':
      return parseYaml(buffer)
    case 'parquet':
      return parseParquet(buffer)
    case 'txt':
      return parseTxt(buffer)
    default:
      throw appError('PARSE_UNSUPPORTED_FORMAT', { format })
  }
}

function fromValue(value: unknown, warnings: Warning[]): unknown[] {
  if (Array.isArray(value)) return value
  if (value !== null && typeof value === 'object') {
    const listField = findListField(value)
    if (listField) {
      warnings.push(warn('PARSE_TOP_LEVEL_DICT', { field: listField }))
      return (value as Record<string, unknown>)[listField] as unknown[]
    }
    return [value]
  }
  if (value === null || value === undefined) return []
  return [value]
}

function toRecords(items: unknown[], warnings: Warning[]): ParsedSource {
  const records: DataRecord[] = []
  const fieldOrder: string[] = []
  const seen = new Set<string>()
  let wrapped = 0
  let truncated = 0

  for (let i = 0; i < items.length; i++) {
    if (records.length >= MAX_RECORDS) {
      truncated = items.length - MAX_RECORDS
      break
    }
    const item = items[i]
    let data: Record<string, Json>
    if (item !== null && typeof item === 'object' && !Array.isArray(item)) {
      data = toJsonSafe(item) as Record<string, Json>
    } else {
      data = { text: toJsonSafe(item) }
      wrapped++
    }
    for (const key of Object.keys(data)) {
      if (!seen.has(key)) {
        seen.add(key)
        fieldOrder.push(key)
      }
    }
    records.push({ id: String(i), index: i, data })
  }

  if (wrapped > 0) warnings.push(warn('PARSE_WRAPPED', { count: wrapped }))
  if (truncated > 0) warnings.push(warn('PARSE_TRUNCATED', { limit: MAX_RECORDS, dropped: truncated }))
  if (records.length === 0) warnings.push(warn('PARSE_NO_RECORDS'))

  return { records, fieldOrder, warnings }
}

function parseJsonl(buffer: Buffer): ParsedSource {
  const text = stripBom(buffer.toString('utf8'))
  if (!text.trim()) {
    return { records: [], fieldOrder: [], warnings: [warn('PARSE_EMPTY_FILE')] }
  }
  const lines = text.split(/\r?\n/)
  const items: unknown[] = []
  let failed = 0
  for (const line of lines) {
    const trimmed = line.trim()
    if (!trimmed) continue
    try {
      items.push(JSON.parse(trimmed))
    } catch {
      failed++
    }
  }
  const warnings: Warning[] = []
  if (items.length === 0) {
    // 一行都解析不出来：可能是整体 JSON，也可能其实是纯文本。
    if (looksLikeJsonDocument(text)) return parseJson(buffer)
    const result = parseTxt(buffer)
    result.warnings.unshift(warn('PARSE_JSONL_FALLBACK_TXT'))
    return result
  }
  if (failed > 0) warnings.push(warn('PARSE_JSONL_BAD_LINES', { count: failed }))
  return toRecords(items, warnings)
}

/** 判断整段文本是否像一个单独的 JSON 文档（数组 / 对象），用于 JSONL 解析失败时的兜底。 */
function looksLikeJsonDocument(text: string): boolean {
  const trimmed = text.trim()
  return trimmed.startsWith('[') || trimmed.startsWith('{')
}

function parseJson(buffer: Buffer): ParsedSource {
  const text = stripBom(buffer.toString('utf8'))
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch (err) {
    throw appError('PARSE_JSON_FAILED', { detail: (err as Error).message })
  }
  const warnings: Warning[] = []
  return toRecords(fromValue(value, warnings), warnings)
}

function parseDelimited(buffer: Buffer, delimiter: string | undefined, name: string): ParsedSource {
  const text = stripBom(buffer.toString('utf8'))
  const warnings: Warning[] = []
  const result = Papa.parse<Record<string, string>>(text, {
    header: true,
    delimiter,
    skipEmptyLines: 'greedy',
    dynamicTyping: false,
    transformHeader: (h) => h.trim()
  })
  if (result.errors?.length) {
    const first = result.errors.slice(0, 3).map((e) => `第 ${e.row ?? '?'} 行：${e.message}`)
    warnings.push(
      warn('PARSE_DELIMITED_ERRORS', { count: result.errors.length, examples: first.join('；') })
    )
  }
  const fields = result.meta.fields ?? []
  const dup = fields.filter((f, i) => fields.indexOf(f) !== i)
  if (dup.length) {
    warnings.push(warn('PARSE_DUPLICATE_HEADERS', { names: [...new Set(dup)].join('、') }))
  }
  const rows = result.data.map((row) => {
    const out: Record<string, Json> = {}
    for (const f of fields) out[f] = row[f] ?? ''
    return out
  })
  const parsed = toRecords(rows, warnings)
  // 只有表头、还没有数据行时，把表头当成字段顺序。新建的 CSV 数据集刚打开就是这种状态，
  // 不补上字段的话「新增一条」会退化成空白模板，用户选的列就白选了。
  if (parsed.records.length === 0 && fields.length > 0) {
    parsed.fieldOrder = [...new Set(fields)]
    // 「只有表头」这条已经把情况说清了，再叠一条「没有解析到任何记录」是噪音。
    // 按码过滤而不是按文案 —— 早先按子串 '没有解析到数据行' 过滤时与实际文案对不上，
    // 这个过滤一直是死的，改成码之后才真的生效。
    parsed.warnings = warnings.filter((w) => w.code !== 'PARSE_NO_RECORDS')
    if (name) parsed.warnings.push(warn('PARSE_HEADER_ONLY', { name }))
  }
  return parsed
}

function parseYaml(buffer: Buffer): ParsedSource {
  const text = stripBom(buffer.toString('utf8'))
  const warnings: Warning[] = []
  let docs: unknown[]
  try {
    docs = YAML.loadAll(text) as unknown[]
  } catch (err) {
    throw appError('PARSE_YAML_FAILED', { detail: (err as Error).message })
  }
  const meaningful = docs.filter((d) => d !== null && d !== undefined)
  if (meaningful.length === 0) throw appError('PARSE_YAML_EMPTY')
  if (meaningful.length > 1) warnings.push(warn('PARSE_YAML_MULTI_DOC', { count: meaningful.length }))
  return toRecords(fromValue(meaningful[0], warnings), warnings)
}

async function parseParquet(buffer: Buffer): Promise<ParsedSource> {
  const ab = buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength) as ArrayBuffer
  const file = {
    byteLength: ab.byteLength,
    slice: (start: number, end?: number) => Promise.resolve(ab.slice(start, end))
  }
  const rows = await parquetReadObjects({ file })
  const warnings: Warning[] = []
  return toRecords(rows, warnings)
}

function parseTxt(buffer: Buffer): ParsedSource {
  const text = stripBom(buffer.toString('utf8'))
  const lines = text.split(/\r?\n/)
  const warnings: Warning[] = []
  let blank = 0
  const items: unknown[] = []
  for (const line of lines) {
    if (!line.trim()) {
      blank++
      continue
    }
    items.push({ text: line })
  }
  if (blank > 0) warnings.push(warn('PARSE_SKIPPED_BLANKS', { count: blank }))
  warnings.push(warn('PARSE_TXT_MODE'))
  return toRecords(items, warnings)
}

export interface ReadSourceResult extends ParsedSource {
  size: number
  mtimeMs: number
  fingerprint: string
  format: SourceFormat
}

/** 以只读方式打开并解析源文件，全程不会对该文件做任何写入。 */
export async function readSourceFile(filePath: string, formatHint?: SourceFormat): Promise<ReadSourceResult> {
  const stat = await fsp.stat(filePath)
  if (!stat.isFile()) throw appError('PATH_NOT_FILE')
  if (stat.size > MAX_BYTES) {
    throw appError('FILE_TOO_LARGE', {
      size: (stat.size / 1024 / 1024).toFixed(1),
      limit: MAX_BYTES / 1024 / 1024
    })
  }
  const format = formatHint ?? detectFormat(filePath)
  const handle = await fsp.open(filePath, fs.constants.O_RDONLY)
  let buffer: Buffer
  try {
    buffer = await handle.readFile()
  } finally {
    await handle.close()
  }
  const parsed = await parseBuffer(format, buffer, filePath.split(/[\\/]/).pop())
  return {
    ...parsed,
    size: stat.size,
    mtimeMs: stat.mtimeMs,
    fingerprint: fingerprintOf(buffer),
    format
  }
}

export function fingerprintOf(buffer: Buffer): string {
  const hash = createHash('sha256')
  hash.update(String(buffer.length))
  if (buffer.length <= FINGERPRINT_CHUNK * 2) {
    hash.update(buffer)
  } else {
    hash.update(buffer.subarray(0, FINGERPRINT_CHUNK))
    hash.update(buffer.subarray(buffer.length - FINGERPRINT_CHUNK))
  }
  return hash.digest('hex')
}

/** 快速指纹（只读取首末各 256KB），用于校验源文件是否被改动。 */
export async function quickFingerprint(filePath: string, size: number): Promise<string> {
  const hash = createHash('sha256')
  hash.update(String(size))
  const handle = await fsp.open(filePath, fs.constants.O_RDONLY)
  try {
    if (size <= FINGERPRINT_CHUNK * 2) {
      hash.update(await handle.readFile())
    } else {
      const head = Buffer.alloc(FINGERPRINT_CHUNK)
      const tail = Buffer.alloc(FINGERPRINT_CHUNK)
      await handle.read(head, 0, FINGERPRINT_CHUNK, 0)
      await handle.read(tail, 0, FINGERPRINT_CHUNK, size - FINGERPRINT_CHUNK)
      hash.update(head)
      hash.update(tail)
    }
  } finally {
    await handle.close()
  }
  return hash.digest('hex')
}
