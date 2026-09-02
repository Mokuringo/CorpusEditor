import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import fsp from 'node:fs/promises'
import os from 'node:os'
import nodePath from 'node:path'
import type { WebContents } from 'electron'
import { detectFormat, isSupportedFile, parseBuffer, supportedExtensions } from '@shared/parse'
import { defaultColumns } from '@shared/serialize'
import { writeExport } from '@shared/export'
import type { DataRecord, ExportConfig, ExportFormat, SourceFormat } from '@shared/types'
import { cleanup, readText } from './helpers'

const mocks = vi.hoisted(() => ({ userData: '' as string }))

vi.mock('electron', () => ({
  app: {
    getPath: () => mocks.userData,
    getVersion: () => '0.0.0-test'
  }
}))

const { openSource, runExport, dropWorkspace } = await import('../electron/main/workspace')
const { createDataset } = await import('../electron/main/workspace')

const sender = { send: () => undefined } as unknown as WebContents

beforeAll(async () => {
  mocks.userData = await fsp.mkdtemp(nodePath.join(os.tmpdir(), 'corpuseditor-formats-'))
})

afterAll(async () => {
  await cleanup()
  await fsp.rm(mocks.userData, { recursive: true, force: true }).catch(() => {})
})

/* ------------------------------------------------------------------ */
/* 格式识别                                                            */
/* ------------------------------------------------------------------ */

describe('扩展名到解析器的映射', () => {
  it('每种格式至少有一个扩展名，且都能被识别', () => {
    const formats = new Set(supportedExtensions().map((ext) => detectFormat(`x${ext}`)))
    expect([...formats].sort()).toEqual(['csv', 'json', 'jsonl', 'parquet', 'tsv', 'txt', 'yaml'])
  })

  it('同义扩展名落到同一个解析器', () => {
    expect(detectFormat('a.ndjson')).toBe('jsonl')
    expect(detectFormat('a.jl')).toBe('jsonl')
    expect(detectFormat('a.jsonl')).toBe('jsonl')
    expect(detectFormat('a.tab')).toBe('tsv')
    expect(detectFormat('a.tsv')).toBe('tsv')
    expect(detectFormat('a.yml')).toBe('yaml')
    expect(detectFormat('a.yaml')).toBe('yaml')
    expect(detectFormat('a.pq')).toBe('parquet')
    expect(detectFormat('a.parquet')).toBe('parquet')
  })

  it('大写扩展名一样认', () => {
    expect(detectFormat('a.JSONL')).toBe('jsonl')
    expect(detectFormat('a.CSV')).toBe('csv')
  })

  it('不支持的扩展名按 JSONL 兜底，但 isSupportedFile 要认出来', () => {
    expect(isSupportedFile('a.jsonl')).toBe(true)
    expect(isSupportedFile('a.docx')).toBe(false)
  })
})

/* ------------------------------------------------------------------ */
/* 新建数据集：5 种格式都要能建、能开                                    */
/* ------------------------------------------------------------------ */

const NEW_FORMATS: Array<{ format: 'jsonl' | 'json' | 'csv' | 'tsv' | 'yaml'; ext: string }> = [
  { format: 'jsonl', ext: 'jsonl' },
  { format: 'json', ext: 'json' },
  { format: 'csv', ext: 'csv' },
  { format: 'tsv', ext: 'tsv' },
  { format: 'yaml', ext: 'yaml' }
]

describe('新建数据集', () => {
  for (const { format, ext } of NEW_FORMATS) {
    it(`${format}：建出来是空文件，能被打开且 0 条记录`, async () => {
      const dir = await fsp.mkdtemp(nodePath.join(os.tmpdir(), 'corpuseditor-new-'))
      try {
        const dest = nodePath.join(dir, `新建.${ext}`)
        await createDataset({ destPath: dest, format, columns: ['instruction', 'output'] })
        const opened = await openSource({ filePath: dest, sender })
        expect(opened.recordCount).toBe(0)
        // CSV / TSV 的空文件也要把表头当字段顺序，否则「新增一条」会退化成空白模板
        if (format === 'csv' || format === 'tsv') {
          expect(opened.fieldOrder).toEqual(['instruction', 'output'])
        }
        await dropWorkspace(opened.sessionId)
      } finally {
        await fsp.rm(dir, { recursive: true, force: true }).catch(() => {})
      }
    })
  }

  it('json / yaml 的初始内容是空数组，不是空字符串', async () => {
    const dir = await fsp.mkdtemp(nodePath.join(os.tmpdir(), 'corpuseditor-new-'))
    try {
      for (const format of ['json', 'yaml'] as const) {
        const dest = nodePath.join(dir, `x.${format}`)
        await createDataset({ destPath: dest, format, columns: [] })
        expect((await readText(dest)).trim()).toBe('[]')
      }
    } finally {
      await fsp.rm(dir, { recursive: true, force: true }).catch(() => {})
    }
  })

  it('csv / tsv 带 BOM，Excel 打开中文不乱码', async () => {
    const dir = await fsp.mkdtemp(nodePath.join(os.tmpdir(), 'corpuseditor-new-'))
    try {
      for (const [format, ext, sep] of [
        ['csv', 'csv', ','],
        ['tsv', 'tsv', '\t']
      ] as const) {
        const dest = nodePath.join(dir, `x.${ext}`)
        await createDataset({ destPath: dest, format, columns: ['指令', '回复'] })
        const raw = await readText(dest)
        expect(raw.charCodeAt(0), `${format} 缺 BOM`).toBe(0xfeff)
        expect(raw.slice(1).trim()).toBe(`指令${sep}回复`)
      }
    } finally {
      await fsp.rm(dir, { recursive: true, force: true }).catch(() => {})
    }
  })

  it('字段名含逗号或引号时，表头要正确转义且能被读回来', async () => {
    const dir = await fsp.mkdtemp(nodePath.join(os.tmpdir(), 'corpuseditor-new-'))
    try {
      const dest = nodePath.join(dir, 'x.csv')
      const columns = ['instruction', 'we,ird', 'say "hi"']
      await createDataset({ destPath: dest, format: 'csv', columns })
      const opened = await openSource({ filePath: dest, sender })
      expect(opened.fieldOrder).toEqual(columns)
      await dropWorkspace(opened.sessionId)
    } finally {
      await fsp.rm(dir, { recursive: true, force: true }).catch(() => {})
    }
  })

  it('已存在的文件绝不覆盖', async () => {
    const dir = await fsp.mkdtemp(nodePath.join(os.tmpdir(), 'corpuseditor-new-'))
    try {
      const dest = nodePath.join(dir, 'x.jsonl')
      await createDataset({ destPath: dest, format: 'jsonl', columns: ['a'] })
      await expect(createDataset({ destPath: dest, format: 'jsonl', columns: ['b'] })).rejects.toThrow(
        'CE:FILE_EXISTS'
      )
      expect((await readText(dest)).trim()).toBe('')
    } finally {
      await fsp.rm(dir, { recursive: true, force: true }).catch(() => {})
    }
  })
})

/* ------------------------------------------------------------------ */
/* 打开 X 格式 → 导出 Y 格式 的往返矩阵                                 */
/* ------------------------------------------------------------------ */

const SAMPLE = [
  { instruction: '翻译成中文', input: 'hello', output: '你好' },
  { instruction: '总结一下', input: '很长的一段话', output: '摘要' }
]

/** 往指定目录里写文件。不用 helpers.writeFile —— 它只认相对名字，会把路径拼到共享临时目录里。 */
async function put(dir: string, name: string, content: string): Promise<string> {
  const file = nodePath.join(dir, name)
  await fsp.writeFile(file, content)
  return file
}

/** 用同一份数据在各源格式下造一个文件，返回路径。 */
async function makeSourceFile(format: SourceFormat, dir: string): Promise<string> {
  if (format === 'jsonl') {
    return put(dir, 'sample.jsonl', SAMPLE.map((r) => JSON.stringify(r)).join('\n') + '\n')
  }
  if (format === 'json') {
    return put(dir, 'sample.json', JSON.stringify(SAMPLE, null, 2))
  }
  if (format === 'csv' || format === 'tsv') {
    const sep = format === 'csv' ? ',' : '\t'
    const head = ['instruction', 'input', 'output'].join(sep)
    const rows = SAMPLE.map((r) => [r.instruction, r.input, r.output].join(sep))
    return put(dir, `sample.${format}`, [head, ...rows].join('\n') + '\n')
  }
  if (format === 'yaml') {
    const body = SAMPLE.map(
      (r) => `- instruction: ${r.instruction}\n  input: ${r.input}\n  output: ${r.output}`
    ).join('\n')
    return put(dir, 'sample.yaml', `${body}\n`)
  }
  if (format === 'txt') {
    return put(dir, 'sample.txt', SAMPLE.map((r) => r.instruction).join('\n') + '\n')
  }
  // parquet：借导出器写一份再当源格式读回来 —— hyparquet 读写是同一套类型
  const records: DataRecord[] = SAMPLE.map((r, i) => ({ id: String(i), index: i, data: r }))
  const dest = nodePath.join(dir, 'sample.parquet')
  await writeExport(records, exportConfig('parquet', ['instruction', 'input', 'output']), dest)
  return dest
}

function exportConfig(format: ExportFormat, fieldOrder: string[]): ExportConfig {
  return {
    format,
    columns: defaultColumns(fieldOrder, false),
    scope: 'all',
    indent: format === 'jsonl' ? null : 2,
    delimiter: ',',
    flattenIndent: null,
    includeIndex: false
  }
}

describe('打开 → 导出 的往返矩阵', () => {
  const dirs: string[] = []

  async function freshDir(): Promise<string> {
    const dir = await fsp.mkdtemp(nodePath.join(os.tmpdir(), 'corpuseditor-matrix-'))
    dirs.push(dir)
    return dir
  }

  afterAll(async () => {
    for (const dir of dirs) await fsp.rm(dir, { recursive: true, force: true }).catch(() => {})
  })

  const SOURCE_FORMATS: SourceFormat[] = ['jsonl', 'json', 'csv', 'tsv', 'yaml', 'txt', 'parquet']

  for (const format of SOURCE_FORMATS) {
    it(`${format} 源文件能打开，条数与字段顺序都对`, async () => {
      const dir = await freshDir()
      const file = await makeSourceFile(format, dir)
      const opened = await openSource({ filePath: file, sender })
      expect(opened.recordCount).toBe(SAMPLE.length)
      if (format !== 'txt') {
        expect(opened.fieldOrder).toEqual(['instruction', 'input', 'output'])
      } else {
        // 纯文本按「一行一条」读入，字段名固定 text
        expect(opened.fieldOrder).toEqual(['text'])
      }
      await dropWorkspace(opened.sessionId)
    })

    it(`${format} → jsonl 导出后能被重新解析，内容一条不少`, async () => {
      const dir = await freshDir()
      const file = await makeSourceFile(format, dir)
      const opened = await openSource({ filePath: file, sender })
      const dest = nodePath.join(dir, 'out.jsonl')
      const result = await runExport({
        sessionId: opened.sessionId,
        config: exportConfig('jsonl', opened.fieldOrder),
        destPath: dest,
        scope: 'all',
        ids: []
      })
      expect(result.recordCount).toBe(SAMPLE.length)
      const reparsed = await parseBuffer('jsonl', await fsp.readFile(dest))
      expect(reparsed.records).toHaveLength(SAMPLE.length)
      // txt 会把每行包成 { text }，所以内容断言要按源格式分别取
      const expected =
        format === 'txt' ? { text: SAMPLE[0].instruction } : (SAMPLE[0] as Record<string, unknown>)
      expect(reparsed.records[0].data).toMatchObject(expected)
      await dropWorkspace(opened.sessionId)
    })
  }

  const EXPORT_FORMATS: ExportFormat[] = ['jsonl', 'json', 'csv', 'parquet']

  for (const target of EXPORT_FORMATS) {
    it(`jsonl 源 → ${target} 导出，产物能被解析回来`, async () => {
      const dir = await freshDir()
      const file = await makeSourceFile('jsonl', dir)
      const opened = await openSource({ filePath: file, sender })
      const dest = nodePath.join(dir, `out.${target === 'parquet' ? 'parquet' : target}`)
      const result = await runExport({
        sessionId: opened.sessionId,
        config: exportConfig(target, opened.fieldOrder),
        destPath: dest,
        scope: 'all',
        ids: []
      })
      expect(result.recordCount).toBe(SAMPLE.length)
      expect(result.bytes).toBeGreaterThan(0)
      // 四种导出的产物都要能重新解析回来，条数一致
      const reparsed = await parseBuffer(target as SourceFormat, await fsp.readFile(dest))
      expect(reparsed.records).toHaveLength(SAMPLE.length)
      await dropWorkspace(opened.sessionId)
    })
  }

  // 星形覆盖（每种源 → jsonl、jsonl → 每种目标）能证明「每种格式都读得进、每种格式都写得出」，
  // 但证明不了「同格式往返时类型不漂移」—— 补一条对角线专门盯这个。
  for (const format of ['jsonl', 'json', 'csv', 'parquet'] as const) {
    it(`${format} → ${format} 同格式往返，内容不变`, async () => {
      const dir = await freshDir()
      const file = await makeSourceFile(format, dir)
      const opened = await openSource({ filePath: file, sender })
      const dest = nodePath.join(dir, `same.${format}`)
      await runExport({
        sessionId: opened.sessionId,
        config: exportConfig(format, opened.fieldOrder),
        destPath: dest,
        scope: 'all',
        ids: []
      })
      const reparsed = await parseBuffer(format, await fsp.readFile(dest))
      expect(reparsed.records).toHaveLength(SAMPLE.length)
      expect(reparsed.records[0].data.instruction).toBe('翻译成中文')
      expect(reparsed.records[0].data.output).toBe('你好')
      await dropWorkspace(opened.sessionId)
    })
  }

  it('导出过程中源文件一个字节都没变', async () => {
    const dir = await freshDir()
    const file = await makeSourceFile('jsonl', dir)
    const before = await fsp.readFile(file)
    const opened = await openSource({ filePath: file, sender })
    await runExport({
      sessionId: opened.sessionId,
      config: exportConfig('csv', opened.fieldOrder),
      destPath: nodePath.join(dir, 'out.csv'),
      scope: 'all',
      ids: []
    })
    expect(await fsp.readFile(file)).toEqual(before)
    await dropWorkspace(opened.sessionId)
  })
})
