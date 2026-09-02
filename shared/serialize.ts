import Papa from 'papaparse'
import { formatPath, getAtPath, pathKey } from './jsonpath'
import type { ErrorCode } from './errors'
import type { DataRecord, ExportColumn, ExportConfig, Json, Path } from './types'

export const INDEX_COLUMN = '__index'

export type FlatCell = string | number | boolean | null
export type FlatRow = Record<string, FlatCell>

export function defaultPathLabel(path: Path): string {
  return formatPath(path)
    .replace(/\[(\d+)\]/g, '_$1')
    .replace(/\./g, '_')
}

export function makeColumnId(): string {
  return `c_${Math.random().toString(36).slice(2, 10)}`
}

/** 依据字段顺序生成默认列配置。 */
export function defaultColumns(fieldOrder: string[], includeIndex: boolean): ExportColumn[] {
  const columns: ExportColumn[] = []
  if (includeIndex) {
    columns.push({ id: makeColumnId(), label: INDEX_COLUMN, path: null, enabled: true })
  }
  for (const field of fieldOrder) {
    columns.push({ id: makeColumnId(), label: field, path: [field], enabled: true })
  }
  return columns
}

function resolveCell(record: DataRecord, column: ExportColumn): Json | undefined {
  if (column.label === INDEX_COLUMN) return record.index
  if (!column.path) return undefined
  const value = getAtPath(record.data, column.path)
  return value === undefined ? undefined : (value as Json)
}

/** 生成嵌套结构完整的对象（JSONL / JSON 数组导出使用）。 */
export function buildObjects(records: DataRecord[], config: ExportConfig): Record<string, Json>[] {
  const enabled = config.columns.filter((c) => c.enabled)
  return records.map((record) => {
    const obj: Record<string, Json> = {}
    for (const column of enabled) {
      const value = resolveCell(record, column)
      obj[column.label] = value === undefined ? null : value
    }
    return obj
  })
}

function flatten(value: Json | undefined, indent: number | null): FlatCell {
  if (value === undefined || value === null) return null
  if (typeof value === 'string') return value
  if (typeof value === 'number') return Number.isFinite(value) ? value : null
  if (typeof value === 'boolean') return value
  // space 为 null 时 JSON.stringify 不接受，用 0 表示紧凑输出
  try {
    return JSON.stringify(value, null, indent === null ? 0 : indent)
  } catch {
    return String(value)
  }
}

/** 生成扁平化行（CSV / Parquet 导出使用），嵌套结构会被 JSON 序列化。 */
export function buildFlatRows(records: DataRecord[], config: ExportConfig): { columns: string[]; rows: FlatRow[] } {
  const enabled = config.columns.filter((c) => c.enabled)
  const columns = enabled.map((c) => c.label)
  const rows = records.map((record) => {
    const row: FlatRow = {}
    for (const column of enabled) {
      row[column.label] = flatten(resolveCell(record, column), config.flattenIndent)
    }
    return row
  })
  return { columns, rows }
}

export function serializeJsonl(objects: Record<string, Json>[]): string {
  if (objects.length === 0) return ''
  return objects.map((o) => JSON.stringify(o)).join('\n') + '\n'
}

export function serializeJsonArray(objects: Record<string, Json>[], indent: number | null): string {
  if (indent === null || indent === 0) return JSON.stringify(objects)
  return JSON.stringify(objects, null, indent) + '\n'
}

export function serializeCsv(columns: string[], rows: FlatRow[], delimiter: string): string {
  const data = rows.map((row) => columns.map((c) => row[c] ?? ''))
  return Papa.unparse({ fields: columns, data }, { delimiter, newline: '\r\n' })
}

/**
 * 导出配置校验。放在这里而不是 export.ts，好让渲染进程不用引入 node 模块。
 * 返回错误码而不是文案：对话框里由渲染进程翻译，导出时由主进程转成 AppError。
 */
export function validateExportConfig(config: ExportConfig): ErrorCode | null {
  const enabled = config.columns.filter((c) => c.enabled)
  if (enabled.length === 0) return 'EXPORT_NO_COLUMN'
  const labels = enabled.map((c) => c.label.trim())
  if (labels.some((l) => !l)) return 'EXPORT_COLUMN_EMPTY'
  if (new Set(labels).size !== labels.length) return 'EXPORT_COLUMN_DUPLICATE'
  if (config.format === 'csv' && !config.delimiter) return 'EXPORT_DELIMITER_EMPTY'
  return null
}

export function suggestedExtension(format: ExportConfig['format']): string {
  switch (format) {
    case 'jsonl':
      return 'jsonl'
    case 'json':
      return 'json'
    case 'csv':
      return 'csv'
    case 'parquet':
      return 'parquet'
    default:
      return 'txt'
  }
}

/** 扫描前若干条记录，列出所有可取值的路径（供「添加列」选择器使用）。 */
export interface PathOption {
  path: Path
  label: string
  key: string
  sample: string
}

export function collectAvailablePaths(records: DataRecord[], maxRecords = 40, maxPaths = 400): PathOption[] {
  const seen = new Set<string>()
  const out: PathOption[] = []
  const limited = records.slice(0, maxRecords)
  for (const record of limited) {
    walk(record.data, [])
    if (out.length >= maxPaths) break
  }
  return out

  function walk(node: unknown, base: Path): void {
    if (out.length >= maxPaths) return
    if (node !== null && typeof node === 'object') {
      const entries = Array.isArray(node)
        ? node.map((v, i) => [String(i), v] as [string, unknown])
        : Object.entries(node as Record<string, unknown>)
      for (const [k, v] of entries) {
        const next: Path = [...base, Array.isArray(node) ? Number(k) : k]
        const key = pathKey(next)
        if (!seen.has(key)) {
          seen.add(key)
          out.push({
            path: next,
            label: formatPath(next),
            key,
            sample: preview(v)
          })
        }
        walk(v, next)
      }
      return
    }
    if (base.length > 0) {
      const key = pathKey(base)
      if (!seen.has(key)) {
        seen.add(key)
        out.push({ path: base, label: formatPath(base), key, sample: preview(node) })
      }
    }
  }
}

function preview(value: unknown): string {
  if (value === null || value === undefined) return 'null'
  if (typeof value === 'string') return value.length > 60 ? `${value.slice(0, 60)}…` : value
  if (typeof value === 'object') {
    const text = JSON.stringify(value)
    return text && text.length > 60 ? `${text.slice(0, 60)}…` : text ?? ''
  }
  return String(value)
}
