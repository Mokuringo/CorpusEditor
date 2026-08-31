import { afterAll, describe, expect, it } from 'vitest'
import fsp from 'node:fs/promises'
import { parquetWriteBuffer } from 'hyparquet-writer'
import {
  detectFormat,
  fingerprintOf,
  parseBuffer,
  quickFingerprint,
  readSourceFile
} from '@shared/parse'
import { cleanup, tmpDir, writeFile } from './helpers'

afterAll(cleanup)

describe('格式识别', () => {
  it('按扩展名映射到正确的解析器', () => {
    expect(detectFormat('a.jsonl')).toBe('jsonl')
    expect(detectFormat('a.ndjson')).toBe('jsonl')
    expect(detectFormat('a.json')).toBe('json')
    expect(detectFormat('a.csv')).toBe('csv')
    expect(detectFormat('a.tsv')).toBe('tsv')
    expect(detectFormat('train.yaml')).toBe('yaml')
    expect(detectFormat('train.yml')).toBe('yaml')
    expect(detectFormat('a.parquet')).toBe('parquet')
    expect(detectFormat('a.txt')).toBe('txt')
  })
})

describe('解析各类微调数据格式', () => {
  it('JSONL：逐行解析并保留字段顺序', async () => {
    const file = await writeFile(
      'data.jsonl',
      [
        JSON.stringify({ instruction: '翻译', input: 'hello', output: '你好' }),
        JSON.stringify({ instruction: '总结', input: 'long text', output: '摘要' }),
        ''
      ].join('\n')
    )
    const result = await readSourceFile(file)
    expect(result.records).toHaveLength(2)
    expect(result.records[0].data).toEqual({ instruction: '翻译', input: 'hello', output: '你好' })
    expect(Object.keys(result.records[0].data)).toEqual(['instruction', 'input', 'output'])
    expect(result.fieldOrder).toEqual(['instruction', 'input', 'output'])
    expect(result.format).toBe('jsonl')
    expect(result.records[1].index).toBe(1)
  })

  it('JSONL：非对象行被包装成 { text }', async () => {
    const file = await writeFile('plain.jsonl', '"一行文本"\n"另一行文本"\n')
    const result = await readSourceFile(file)
    expect(result.records).toHaveLength(2)
    expect(result.records[0].data).toEqual({ text: '一行文本' })
    expect(result.warnings.join()).toContain('不是对象')
  })

  it('JSONL：整份都不是 JSON 时退化为纯文本逐行读入', async () => {
    const file = await writeFile('notjson.jsonl', '一行文本\n另一行文本\n')
    const result = await readSourceFile(file)
    expect(result.records).toHaveLength(2)
    expect(result.records[0].data).toEqual({ text: '一行文本' })
    expect(result.warnings.join()).toContain('纯文本')
  })

  it('JSON 数组', async () => {
    const file = await writeFile('array.json', JSON.stringify([{ a: 1 }, { a: 2 }]))
    const result = await readSourceFile(file)
    expect(result.records).toHaveLength(2)
    expect(result.records[0].data.a).toBe(1)
  })

  it('JSON 对象：自动取内部数组字段', async () => {
    const file = await writeFile('dict.json', JSON.stringify({ version: 1, data: [{ a: 1 }, { a: 2 }] }))
    const result = await readSourceFile(file)
    expect(result.records).toHaveLength(2)
    expect(result.warnings.join()).toContain('data')
  })

  it('JSON 对象：无数组字段时当作单条记录', async () => {
    const file = await writeFile('single.json', JSON.stringify({ a: 1, b: 2 }))
    const result = await readSourceFile(file)
    expect(result.records).toHaveLength(1)
  })

  it('JSONL 解析全部失败时回退到整体 JSON', async () => {
    const file = await writeFile('fallback.json', JSON.stringify([{ a: 1 }]))
    const result = await readSourceFile(file, 'jsonl')
    expect(result.records).toHaveLength(1)
  })

  it('CSV：表头作为字段名，缺失单元格补空串', async () => {
    const file = await writeFile('data.csv', 'instruction,input,output\n"翻译",hello,你好\n"总结",,\n')
    const result = await readSourceFile(file)
    expect(result.records).toHaveLength(2)
    expect(result.records[0].data).toEqual({ instruction: '翻译', input: 'hello', output: '你好' })
    expect(result.records[1].data.input).toBe('')
  })

  it('CSV：只有表头没有数据行时，表头仍要作为字段顺序', async () => {
    // 新建的 CSV 数据集刚打开就是这种状态。不给字段的话「新增一条」会退化成空白模板，
    // 用户建文件时选的那几列就白选了。
    const file = await writeFile('header-only.csv', 'instruction,output\n')
    const result = await readSourceFile(file)
    expect(result.records).toHaveLength(0)
    expect(result.fieldOrder).toEqual(['instruction', 'output'])
    expect(result.warnings.some((w) => w.includes('只有表头'))).toBe(true)
  })

  it('TSV：按制表符切分', async () => {
    const file = await writeFile('data.tsv', 'a\tb\n1\t2\n')
    const result = await readSourceFile(file)
    expect(result.records[0].data).toEqual({ a: '1', b: '2' })
  })

  it('YAML：数组文档', async () => {
    const file = await writeFile('data.yaml', '- a: 1\n  b: two\n- a: 3\n  b: four\n')
    const result = await readSourceFile(file)
    expect(result.records).toHaveLength(2)
    expect(result.records[0].data.b).toBe('two')
  })

  it('TXT：一行一条，字段名为 text', async () => {
    const file = await writeFile('data.txt', '第一行\n\n第二行\n')
    const result = await readSourceFile(file)
    expect(result.records).toHaveLength(2)
    expect(result.records[0].data.text).toBe('第一行')
    expect(result.warnings.join()).toContain('空行')
  })

  it('Parquet：读写往返', async () => {
    const buffer = Buffer.from(
      parquetWriteBuffer({
        columnData: [
          { name: 'instruction', data: ['翻译', '总结'], type: 'STRING' },
          { name: 'score', data: [1, 2], type: 'DOUBLE' }
        ],
        codec: 'UNCOMPRESSED'
      })
    )
    const file = await writeFile('data.parquet', buffer)
    const result = await readSourceFile(file)
    expect(result.records).toHaveLength(2)
    expect(result.records[0].data.instruction).toBe('翻译')
    expect(result.records[1].data.score).toBe(2)
  })

  it('空文件返回 0 条并给出提示', async () => {
    const file = await writeFile('empty.jsonl', '')
    const result = await readSourceFile(file)
    expect(result.records).toHaveLength(0)
    expect(result.warnings.join()).toContain('没有解析到')
  })

  it('带 BOM 的文件也能正确解析', async () => {
    const file = await writeFile('bom.jsonl', `﻿${JSON.stringify({ a: 1 })}\n`)
    const result = await readSourceFile(file)
    expect(result.records).toHaveLength(1)
  })

  it('传入目录时报错', async () => {
    const dir = await tmpDir()
    await expect(readSourceFile(dir)).rejects.toThrow('不是文件')
  })
})

/**
 * 损坏与空文件必须给出**能照着做的中文报错**，不能抛一句英文堆栈或者静默返回 0 条。
 * 静默返回 0 条最危险：用户会以为文件真是空的，然后新建一个覆盖掉它。
 */
describe('损坏与空文件', () => {
  it('JSON 语法错误 → 中文报错，而不是英文堆栈', async () => {
    const file = await writeFile('broken.json', '{"a": [1, 2,}')
    await expect(readSourceFile(file)).rejects.toThrow(/JSON 解析失败/)
  })

  it('空的 JSON 文件 → 报错，不能静默当成 0 条', async () => {
    const file = await writeFile('empty.json', '')
    await expect(readSourceFile(file)).rejects.toThrow(/JSON 解析失败/)
  })

  it('YAML 语法错误 → 中文报错', async () => {
    const file = await writeFile('broken.yaml', 'a: [1, 2\nb: 3')
    await expect(readSourceFile(file)).rejects.toThrow(/YAML 解析失败/)
  })

  it('空的 YAML 文件 → 明确说「文件为空」', async () => {
    const file = await writeFile('empty.yaml', '')
    await expect(readSourceFile(file)).rejects.toThrow(/YAML 文件为空/)
  })

  it('只有空行的 TXT → 0 条，并在提示里说清跳过了几行', async () => {
    // 三行：两个真空行 + 一个只有空格的行。末尾不加换行，
    // 免得 split 多切出一个空串让数字对不上
    const file = await writeFile('blank.txt', '\n\n   ')
    const result = await readSourceFile(file)
    expect(result.records).toHaveLength(0)
    expect(result.warnings.join()).toContain('跳过 3 个空行')
  })

  it('连表头都没有的 CSV → 0 条，不抛错', async () => {
    const file = await writeFile('empty.csv', '')
    const result = await readSourceFile(file)
    expect(result.records).toHaveLength(0)
    expect(result.warnings.join()).toContain('没有解析到')
  })
})

describe('源文件只读', () => {
  it('读取前后文件指纹与修改时间完全一致', async () => {
    const file = await writeFile(
      'readonly.jsonl',
      [JSON.stringify({ a: 1 }), JSON.stringify({ a: 2 })].join('\n')
    )
    const before = await fsp.stat(file)
    const beforeFp = await quickFingerprint(file, before.size)

    const result = await readSourceFile(file)

    const after = await fsp.stat(file)
    const afterFp = await quickFingerprint(file, after.size)

    expect(after.size).toBe(before.size)
    expect(after.mtimeMs).toBe(before.mtimeMs)
    expect(afterFp).toBe(beforeFp)
    expect(result.fingerprint).toBe(beforeFp)
  })

  it('指纹对内容变化敏感', async () => {
    const a = await writeFile('fp-a.txt', 'hello')
    const b = await writeFile('fp-b.txt', 'hello!')
    expect(fingerprintOf(Buffer.from('hello'))).not.toBe(fingerprintOf(Buffer.from('hello!')))
    expect(await quickFingerprint(a, 5)).not.toBe(await quickFingerprint(b, 6))
  })

  it('会话目录与源文件目录是分开的', async () => {
    const file = await writeFile('separate.jsonl', JSON.stringify({ a: 1 }))
    const dir = await tmpDir()
    expect(file.startsWith(dir)).toBe(true)
  })
})

describe('parseBuffer 直接调用', () => {
  it('可以脱离文件系统解析字节', async () => {
    const result = await parseBuffer('jsonl', Buffer.from(`${JSON.stringify({ q: 1 })}\n`))
    expect(result.records).toHaveLength(1)
  })
})
