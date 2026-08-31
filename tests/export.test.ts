import { afterAll, describe, expect, it } from 'vitest'
import fsp from 'node:fs/promises'
import Papa from 'papaparse'
import { parquetReadObjects } from 'hyparquet'
import { writeExport } from '@shared/export'
import { applyEdits } from '@shared/patch'
import {
  buildFlatRows,
  buildObjects,
  collectAvailablePaths,
  defaultColumns,
  defaultPathLabel,
  serializeCsv,
  serializeJsonArray,
  serializeJsonl,
  suggestedExtension,
  validateExportConfig,
  INDEX_COLUMN
} from '@shared/serialize'
import { pathKey } from '@shared/jsonpath'
import type { DataRecord, ExportConfig, Json } from '@shared/types'
import { cleanup, readText, tmpDir, writeFile } from './helpers'

afterAll(cleanup)

function records(): DataRecord[] {
  return [
    {
      id: '0',
      index: 0,
      data: {
        instruction: '翻译',
        output: '你好',
        messages: [
          { role: 'user', content: 'hi' },
          { role: 'assistant', content: '你好' }
        ],
        score: 4.5,
        flagged: false
      }
    },
    {
      id: '1',
      index: 1,
      data: {
        instruction: '总结',
        output: '摘要',
        messages: [{ role: 'user', content: 'long text' }],
        score: 3,
        flagged: true
      }
    }
  ]
}

function config(overrides: Partial<ExportConfig> = {}): ExportConfig {
  return {
    format: 'jsonl',
    columns: defaultColumns(['instruction', 'output', 'messages', 'score', 'flagged'], false),
    scope: 'all',
    indent: 2,
    delimiter: ',',
    flattenIndent: null,
    includeIndex: false,
    ...overrides
  }
}

describe('序列化', () => {
  it('JSONL 一行一条，末尾换行', () => {
    const text = serializeJsonl(buildObjects(records(), config()))
    const lines = text.trim().split('\n')
    expect(lines).toHaveLength(2)
    expect(JSON.parse(lines[0]).instruction).toBe('翻译')
    expect(text.endsWith('\n')).toBe(true)
  })

  it('JSON 数组支持缩进与紧凑两种输出', () => {
    const objects = buildObjects(records(), config())
    expect(serializeJsonArray(objects, 2)).toContain('\n  {\n    "instruction"')
    expect(serializeJsonArray(objects, null)).not.toContain('\n')
  })

  it('空数据集序列化为空串', () => {
    expect(serializeJsonl([])).toBe('')
  })

  it('CSV 生成表头并按列顺序输出', () => {
    const { columns, rows } = buildFlatRows(records(), config({ format: 'csv' }))
    const text = serializeCsv(columns, rows, ',')
    const parsed = Papa.parse<Record<string, string>>(text, { header: true })
    expect(parsed.meta.fields).toEqual(['instruction', 'output', 'messages', 'score', 'flagged'])
    expect(parsed.data[0].instruction).toBe('翻译')
    expect(parsed.data[1].flagged).toBe('true')
  })

  it('CSV 支持自定义分隔符', () => {
    const { columns, rows } = buildFlatRows(records(), config({ format: 'csv' }))
    expect(serializeCsv(columns, rows, ';').split('\n')[0].replace(/\r$/, '')).toBe(
      'instruction;output;messages;score;flagged'
    )
  })

  it('CSV 对含逗号与引号的单元格做转义', () => {
    const data: DataRecord[] = [{ id: '0', index: 0, data: { text: 'a,b "quoted"' } }]
    const { columns, rows } = buildFlatRows(data, config({ format: 'csv', columns: defaultColumns(['text'], false) }))
    const parsed = Papa.parse<Record<string, string>>(serializeCsv(columns, rows, ','), { header: true })
    expect(parsed.data[0].text).toBe('a,b "quoted"')
  })

  it('建议的扩展名与格式对应', () => {
    expect(suggestedExtension('jsonl')).toBe('jsonl')
    expect(suggestedExtension('json')).toBe('json')
    expect(suggestedExtension('csv')).toBe('csv')
    expect(suggestedExtension('parquet')).toBe('parquet')
  })
})

describe('扁平化', () => {
  it('嵌套对象与数组被序列化为 JSON 字符串', () => {
    const { rows } = buildFlatRows(records(), config({ format: 'csv' }))
    expect(typeof rows[0].messages).toBe('string')
    expect(JSON.parse(rows[0].messages as string)[0].content).toBe('hi')
  })

  it('紧凑与缩进两种扁平化方式', () => {
    const compact = buildFlatRows(records(), config({ format: 'csv', flattenIndent: null }))
    const pretty = buildFlatRows(records(), config({ format: 'csv', flattenIndent: 2 }))
    expect(compact.rows[0].messages).not.toContain('\n')
    expect(pretty.rows[0].messages).toContain('\n')
  })

  it('布尔与数字保持原始类型', () => {
    const { rows } = buildFlatRows(records(), config({ format: 'parquet' }))
    expect(rows[0].flagged).toBe(false)
    expect(rows[0].score).toBe(4.5)
  })
})

describe('字段映射', () => {
  it('默认列与字段顺序一致', () => {
    const columns = defaultColumns(['a', 'b'], false)
    expect(columns.map((c) => c.label)).toEqual(['a', 'b'])
    expect(columns[0].path).toEqual(['a'])
  })

  it('附带行号列时排在最前', () => {
    const columns = defaultColumns(['a'], true)
    expect(columns[0].label).toBe(INDEX_COLUMN)
    const { rows } = buildFlatRows(records(), config({ columns: defaultColumns(['instruction'], true) }))
    expect(rows[0][INDEX_COLUMN]).toBe(0)
    expect(rows[1][INDEX_COLUMN]).toBe(1)
  })

  it('重命名列会改变输出列名', () => {
    const columns = defaultColumns(['instruction'], false).map((c) => ({ ...c, label: 'prompt' }))
    const objects = buildObjects(records(), config({ columns }))
    expect(Object.keys(objects[0])).toEqual(['prompt'])
  })

  it('调整列顺序会改变输出顺序', () => {
    const columns = defaultColumns(['instruction', 'output'], false).reverse()
    expect(Object.keys(buildObjects(records(), config({ columns }))[0])).toEqual(['output', 'instruction'])
  })

  it('禁用的列不会出现在输出里', () => {
    const columns = defaultColumns(['instruction', 'output'], false).map((c) =>
      c.label === 'output' ? { ...c, enabled: false } : c
    )
    expect(Object.keys(buildObjects(records(), config({ columns }))[0])).toEqual(['instruction'])
  })

  it('自定义路径可以取到对话里某一轮的内容', () => {
    const columns = [
      { id: 'c1', label: 'question', path: ['messages', 0, 'content'], enabled: true },
      { id: 'c2', label: 'answer', path: ['messages', 1, 'content'], enabled: true }
    ]
    const objects = buildObjects(records(), config({ columns }))
    expect(objects[0]).toEqual({ question: 'hi', answer: '你好' })
    // 第二条只有一轮，缺失的值补 null
    expect(objects[1]).toEqual({ question: 'long text', answer: null })
  })

  it('空列导出为 null / 空单元格', () => {
    const columns = [{ id: 'c1', label: 'note', path: null, enabled: true }]
    const objects = buildObjects(records(), config({ columns }))
    expect(objects[0].note).toBeNull()
    const { rows } = buildFlatRows(records(), config({ columns, format: 'csv' }))
    expect(rows[0].note).toBeNull()
  })

  it('路径标签可读', () => {
    expect(defaultPathLabel(['messages', 0, 'content'])).toBe('messages_0_content')
  })

  it('可用路径列表覆盖嵌套结构', () => {
    const options = collectAvailablePaths(records())
    const labels = options.map((o) => o.label)
    expect(labels).toContain('messages[0].content')
    expect(labels).toContain('messages[1].role')
    expect(labels).toContain('score')
  })
})

describe('配置校验', () => {
  it('至少保留一列', () => {
    expect(validateExportConfig(config({ columns: [] }))).toBe('至少要保留一列')
    expect(
      validateExportConfig(config({ columns: [{ id: 'x', label: 'a', path: ['instruction'], enabled: false }] }))
    ).toBe('至少要保留一列')
  })

  it('列名不能为空或重复', () => {
    expect(validateExportConfig(config({ columns: [{ id: 'x', label: ' ', path: null, enabled: true }] }))).toBe(
      '列名不能为空'
    )
    const dup = [
      { id: 'a', label: 'same', path: ['instruction'], enabled: true },
      { id: 'b', label: 'same', path: ['output'], enabled: true }
    ]
    expect(validateExportConfig(config({ columns: dup }))).toBe('列名不能重复')
  })

  it('CSV 分隔符不能为空', () => {
    expect(validateExportConfig(config({ format: 'csv', delimiter: '' }))).toBe('CSV 分隔符不能为空')
  })

  it('合法配置通过校验', () => {
    expect(validateExportConfig(config())).toBeNull()
  })
})

describe('写文件', () => {
  it('JSONL：编辑过的内容会被写入', async () => {
    const source = records()
    const edits = { 0: { [pathKey(['instruction'])]: '改写的指令' } }
    const patched = applyEdits(source, edits)
    const dest = await writeFile('out.jsonl', '')
    const result = await writeExport(patched, config(), dest)
    expect(result.recordCount).toBe(2)
    const lines = (await readText(dest)).trim().split('\n')
    expect(JSON.parse(lines[0]).instruction).toBe('改写的指令')
    expect(JSON.parse(lines[1]).instruction).toBe('总结')
  })

  it('JSON 数组', async () => {
    const dest = await writeFile('out.json', '')
    await writeExport(records(), config({ format: 'json', indent: 2 }), dest)
    const parsed = JSON.parse(await readText(dest)) as Array<Record<string, Json>>
    expect(parsed).toHaveLength(2)
  })

  it('CSV：带 BOM，中文不乱码；嵌套结构成字符串', async () => {
    const dest = await writeFile('out.csv', '')
    await writeExport(records(), config({ format: 'csv' }), dest)
    const text = await readText(dest)
    expect(text.charCodeAt(0)).toBe(0xfeff)
    const parsed = Papa.parse<Record<string, string>>(text, { header: true })
    expect(parsed.data[0].instruction).toBe('翻译')
    expect(typeof parsed.data[0].messages).toBe('string')
  })

  it('没有记录时跳过列校验，导出成空文件', async () => {
    // 刚新建的空数据集，一条记录都没有，导出成空文件是合理的操作，
    // 不该用「至少要保留一列」把它挡下来 —— 那时根本还没有列可言。
    const dest = await writeFile('empty.jsonl', '')
    const result = await writeExport([], config({ columns: [] }), dest)
    expect(result.recordCount).toBe(0)
    expect(result.bytes).toBe(0)
    expect(await readText(dest)).toBe('')
  })

  it('Parquet：可被读回，类型保持', async () => {
    const dest = (await tmpDir()) + '/out.parquet'
    await writeExport(records(), config({ format: 'parquet' }), dest)
    const buffer = await fsp.readFile(dest)
    const ab = buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength) as ArrayBuffer
    const rows = await parquetReadObjects({
      file: { byteLength: ab.byteLength, slice: (s, e) => Promise.resolve(ab.slice(s, e)) }
    })
    expect(rows).toHaveLength(2)
    expect(rows[0].instruction).toBe('翻译')
    expect(rows[0].flagged).toBe(false)
    expect(rows[1].flagged).toBe(true)
    expect(Number(rows[0].score)).toBeCloseTo(4.5)
    expect(typeof rows[0].messages).toBe('string')
  })

  it('非法配置不会写文件', async () => {
    const dest = await writeFile('invalid.jsonl', '')
    await expect(writeExport(records(), config({ columns: [] }), dest)).rejects.toThrow('至少要保留一列')
  })

  it('返回导出的字节数', async () => {
    const dest = await writeFile('size.jsonl', '')
    const result = await writeExport(records(), config(), dest)
    expect(result.bytes).toBeGreaterThan(0)
  })
})
