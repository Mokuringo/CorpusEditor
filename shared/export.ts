import fsp from 'node:fs/promises'
import { parquetWriteBuffer } from 'hyparquet-writer'
import { appError } from './errors'
import type { FlatRow } from './serialize'
import {
  buildFlatRows,
  buildObjects,
  serializeCsv,
  serializeJsonArray,
  serializeJsonl,
  validateExportConfig
} from './serialize'
import type { DataRecord, ExportColumn, ExportConfig, ExportResult } from './types'

function buildColumnSource(column: ExportColumn, rows: FlatRow[]) {
  const name = column.label.trim()
  const values = rows.map((r) => (r[name] === undefined ? null : r[name]))
  const nonNull = values.filter((v) => v !== null)
  if (nonNull.length > 0 && nonNull.every((v) => typeof v === 'boolean')) {
    return { name, data: values as boolean[], type: 'BOOLEAN' as const, nullable: true }
  }
  if (nonNull.length > 0 && nonNull.every((v) => typeof v === 'number')) {
    return { name, data: values as number[], type: 'DOUBLE' as const, nullable: true }
  }
  return {
    name,
    data: values.map((v) => (v === null ? null : String(v))) as Array<string | null>,
    type: 'STRING' as const,
    nullable: true
  }
}

export async function writeExport(
  records: DataRecord[],
  config: ExportConfig,
  destPath: string
): Promise<ExportResult> {
  // 没有记录时跳过列校验：空数据集导出成空文件是合理的操作，不是「列配置错了」。
  // 校验的是「要导出的列有没有配好」，一条都没有的时候这个问题不成立。
  const error = records.length > 0 ? validateExportConfig(config) : null
  if (error) throw appError(error)

  if (config.format === 'jsonl' || config.format === 'json') {
    const objects = buildObjects(records, config)
    const text =
      config.format === 'jsonl' ? serializeJsonl(objects) : serializeJsonArray(objects, config.indent)
    await fsp.writeFile(destPath, text, 'utf8')
    return { destPath, recordCount: records.length, bytes: Buffer.byteLength(text, 'utf8') }
  }

  const { columns, rows } = buildFlatRows(records, config)

  if (config.format === 'csv') {
    const text = serializeCsv(columns, rows, config.delimiter)
    // 写 BOM，保证 Excel 正确识别 UTF-8 中文
    const payload = `﻿${text}`
    await fsp.writeFile(destPath, payload, 'utf8')
    return { destPath, recordCount: records.length, bytes: Buffer.byteLength(payload, 'utf8') }
  }

  const columnData = config.columns.filter((c) => c.enabled).map((c) => buildColumnSource(c, rows))
  const buffer = parquetWriteBuffer({ columnData, codec: 'SNAPPY' })
  const bytes = new Uint8Array(buffer)
  await fsp.writeFile(destPath, bytes)
  return { destPath, recordCount: records.length, bytes: bytes.byteLength }
}
