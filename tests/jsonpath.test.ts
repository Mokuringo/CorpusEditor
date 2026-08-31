import { describe, expect, it } from 'vitest'
import {
  cloneJson,
  collectStringLeaves,
  deepEqual,
  deleteAtPath,
  formatPath,
  getAtPath,
  hasAtPath,
  parsePathKey,
  pathKey,
  setAtPath,
  toJsonSafe
} from '@shared/jsonpath'
import type { Path } from '@shared/types'

describe('路径键与格式化', () => {
  it('pathKey 与 parsePathKey 可逆', () => {
    const path: Path = ['messages', 2, 'content']
    const key = pathKey(path)
    expect(key).toBe('["messages",2,"content"]')
    expect(parsePathKey(key)).toEqual(path)
  })

  it('非法键返回空路径', () => {
    expect(parsePathKey('not json')).toEqual([])
  })

  it('formatPath 生成可读路径', () => {
    expect(formatPath(['messages', 2, 'content'])).toBe('messages[2].content')
    expect(formatPath(['instruction'])).toBe('instruction')
    expect(formatPath([])).toBe('')
  })
})

describe('读写路径', () => {
  const data = { a: { b: [{ c: 'x' }] }, d: 'plain' }

  it('读取存在的路径', () => {
    expect(getAtPath(data, ['a', 'b', 0, 'c'])).toBe('x')
    expect(getAtPath(data, ['d'])).toBe('plain')
  })

  it('读取不存在的路径返回 undefined', () => {
    expect(getAtPath(data, ['a', 'zzz'])).toBeUndefined()
    expect(getAtPath(data, ['a', 'b', 9, 'c'])).toBeUndefined()
    expect(hasAtPath(data, ['a', 'zzz'])).toBe(false)
    expect(hasAtPath(data, ['d'])).toBe(true)
  })

  it('写入已有路径', () => {
    const clone = cloneJson(data)
    expect(setAtPath(clone, ['a', 'b', 0, 'c'], 'y')).toBe(true)
    expect(getAtPath(clone, ['a', 'b', 0, 'c'])).toBe('y')
  })

  it('写入缺失的中间容器时自动创建', () => {
    const root: Record<string, unknown> = {}
    expect(setAtPath(root, ['list', 0, 'name'], 'n')).toBe(true)
    expect(root.list).toEqual([{ name: 'n' }])
  })

  it('父级不是容器时写入失败', () => {
    const root = { text: 'scalar' }
    expect(setAtPath(root, ['text', 'child'], 1)).toBe(false)
  })

  it('空路径写入失败', () => {
    expect(setAtPath({}, [], 1)).toBe(false)
  })

  it('删除数组项与对象键', () => {
    const list = { items: [{ a: 1 }, { a: 2 }] }
    expect(deleteAtPath(list, ['items', 0])).toBe(true)
    expect(list.items).toEqual([{ a: 2 }])
    expect(deleteAtPath(list, ['items', 5])).toBe(false)

    const obj = { a: 1, b: 2 }
    expect(deleteAtPath(obj, ['b'])).toBe(true)
    expect(obj).toEqual({ a: 1 })
    expect(deleteAtPath(obj, ['missing'])).toBe(false)
  })
})

describe('字符串叶子收集', () => {
  it('递归收集所有字符串值', () => {
    const data = {
      system: '你是助手',
      messages: [
        { role: 'user', content: '你好' },
        { role: 'assistant', content: '您好' }
      ],
      meta: { tags: ['a', 'b'], score: 1 }
    }
    const leaves = collectStringLeaves(data)
    const paths = leaves.map((l) => formatPath(l.path))
    expect(paths).toEqual([
      'system',
      'messages[0].role',
      'messages[0].content',
      'messages[1].role',
      'messages[1].content',
      'meta.tags[0]',
      'meta.tags[1]'
    ])
  })

  it('非对象输入不产生叶子', () => {
    expect(collectStringLeaves(42)).toEqual([])
    expect(collectStringLeaves(null)).toEqual([])
  })
})

describe('深比较与克隆', () => {
  it('键顺序不敏感', () => {
    expect(deepEqual({ a: 1, b: 2 }, { b: 2, a: 1 })).toBe(true)
  })

  it('数组长度与顺序敏感', () => {
    expect(deepEqual([1, 2], [2, 1])).toBe(false)
    expect(deepEqual([1, 2], [1, 2, 3])).toBe(false)
  })

  it('类型敏感', () => {
    expect(deepEqual('1', 1)).toBe(false)
    expect(deepEqual(null, undefined)).toBe(false)
    expect(deepEqual(null, null)).toBe(true)
  })

  it('嵌套结构比较', () => {
    expect(deepEqual({ a: [{ b: 1 }] }, { a: [{ b: 1 }] })).toBe(true)
    expect(deepEqual({ a: [{ b: 1 }] }, { a: [{ b: 2 }] })).toBe(false)
  })

  it('克隆是深拷贝', () => {
    const source = { a: { b: [1, 2] } }
    const copy = cloneJson(source)
    ;(copy.a.b as number[]).push(3)
    expect(source.a.b).toEqual([1, 2])
  })
})

describe('JSON 安全化', () => {
  it('bigint 转成 number', () => {
    expect(toJsonSafe(10n)).toBe(10)
  })

  it('NaN / Infinity 转成 null', () => {
    expect(toJsonSafe(Number.NaN)).toBeNull()
    expect(toJsonSafe(Number.POSITIVE_INFINITY)).toBeNull()
  })

  it('undefined 转成 null，Date 转成 ISO 字符串', () => {
    expect(toJsonSafe(undefined)).toBeNull()
    const date = new Date('2024-01-01T00:00:00.000Z')
    expect(toJsonSafe(date)).toBe('2024-01-01T00:00:00.000Z')
  })

  it('递归处理嵌套结构', () => {
    expect(toJsonSafe({ a: [1n, undefined, { b: Number.NaN }] })).toEqual({ a: [1, null, { b: null }] })
  })
})
