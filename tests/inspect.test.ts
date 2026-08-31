import { describe, expect, it } from 'vitest'
import {
  detectConversation,
  detectPairs,
  fieldContentSlots,
  fieldStringPaths,
  findListField,
  inspectField,
  inspectFields,
  normalizeRole,
  roleLabel
} from '@shared/inspect'
import type { DataRecord } from '@shared/types'

const openaiMessages = [
  [
    { role: 'system', content: '你是助手' },
    { role: 'user', content: '你好' },
    { role: 'assistant', content: '您好' }
  ]
]

const sharegpt = [
  [
    { from: 'human', value: '问题' },
    { from: 'gpt', value: '回答' }
  ]
]

describe('角色归一化', () => {
  it('OpenAI 风格', () => {
    expect(normalizeRole('system')).toBe('system')
    expect(normalizeRole('user')).toBe('user')
    expect(normalizeRole('assistant')).toBe('assistant')
    expect(normalizeRole('tool')).toBe('tool')
    expect(normalizeRole('function')).toBe('tool')
  })

  it('ShareGPT 风格映射到通用角色', () => {
    expect(normalizeRole('human')).toBe('user')
    expect(normalizeRole('gpt')).toBe('assistant')
    expect(normalizeRole('prompter')).toBe('user')
    expect(normalizeRole('observation')).toBe('tool')
  })

  it('大小写与空格不敏感', () => {
    expect(normalizeRole(' System ')).toBe('system')
    expect(normalizeRole('USER')).toBe('user')
  })

  it('未知角色归为 other', () => {
    expect(normalizeRole('critic')).toBe('other')
    expect(normalizeRole('')).toBe('other')
  })

  it('roleLabel 给出可读名称', () => {
    expect(roleLabel('system')).toBe('System')
    expect(roleLabel('human')).toBe('User')
    expect(roleLabel('critic')).toBe('critic')
  })
})

describe('对话结构识别', () => {
  it('识别 role + content', () => {
    const shape = detectConversation(openaiMessages)
    expect(shape).toEqual({ roleKey: 'role', contentKey: 'content', roles: ['system', 'user', 'assistant'] })
  })

  it('识别 from + value（ShareGPT）', () => {
    const shape = detectConversation(sharegpt)
    expect(shape).toEqual({ roleKey: 'from', contentKey: 'value', roles: ['human', 'gpt'] })
  })

  it('字符串数组不是对话', () => {
    expect(detectConversation([['a', 'b']])).toBeNull()
  })

  it('缺少角色字段的对象数组不是对话', () => {
    expect(detectConversation([[{ content: 'x' }]])).toBeNull()
  })

  it('空数组不算对话', () => {
    expect(detectConversation([[]])).toBeNull()
    expect(detectConversation([])).toBeNull()
  })

  it('多数表决：少量脏数据不影响识别', () => {
    const values = [...openaiMessages, 'not an array', null]
    expect(detectConversation(values)).not.toBeNull()
  })
})

describe('键即角色的对话识别（{ human, assistant }）', () => {
  const pairs = [[{ human: '问题一', assistant: '回答一' }], [{ human: '问题二', assistant: '回答二' }]]

  it('键名本身就是角色时识别为 pairs', () => {
    expect(detectPairs(pairs)).toEqual({ keys: ['human', 'assistant'] })
  })

  it('标准对话不会被误判成 pairs（content 不是角色名）', () => {
    expect(detectPairs(openaiMessages)).toBeNull()
    expect(detectPairs(sharegpt)).toBeNull()
  })

  it('值不全是字符串时不识别', () => {
    expect(detectPairs([[{ human: 'x', assistant: { text: 'y' } }]])).toBeNull()
    expect(detectPairs([[{ human: 123, assistant: 'y' }]])).toBeNull()
  })

  it('键名不是角色词时不识别（Alpaca 的 input/output 不该被当成对话）', () => {
    expect(detectPairs([[{ input: 'a', output: 'b' }]])).toBeNull()
    expect(detectPairs([[{ question: 'a', answer: 'b' }]])).toBeNull()
  })

  it('多数表决：少量脏数据不影响识别', () => {
    const values = [...pairs, [{ foo: 'bar' }], null]
    expect(detectPairs(values)).toEqual({ keys: ['human', 'assistant'] })
  })

  it('空数组与空值不算 pairs', () => {
    expect(detectPairs([[]])).toBeNull()
    expect(detectPairs([])).toBeNull()
  })

  it('inspectField 里 messages 优先于 pairs', () => {
    expect(inspectField(pairs)).toEqual({ type: 'pairs', keys: ['human', 'assistant'] })
    expect(inspectField(openaiMessages).type).toBe('messages')
  })

  it('键顺序按首次出现次序，不受后续记录影响', () => {
    const mixed = [[{ assistant: 'a', human: 'q' }], [{ human: 'q2', system: 's', assistant: 'a2' }]]
    expect(detectPairs(mixed)).toEqual({ keys: ['assistant', 'human', 'system'] })
  })
})

describe('字段类型推断', () => {
  it('长文本与短文本', () => {
    expect(inspectField(['短', '也很短'])).toEqual({ type: 'text', long: false })
    expect(inspectField(['很长的文本'.repeat(40)])).toEqual({ type: 'text', long: true })
    expect(inspectField(['第一行\n第二行'])).toEqual({ type: 'text', long: true })
  })

  it('数字与布尔', () => {
    expect(inspectField([1, 2.5])).toEqual({ type: 'number' })
    expect(inspectField([true, false])).toEqual({ type: 'boolean' })
  })

  it('混合或复杂结构归为 JSON', () => {
    expect(inspectField([{ a: 1 }])).toEqual({ type: 'json' })
    expect(inspectField(['a', 1])).toEqual({ type: 'json' })
  })

  it('全为空值时是 empty', () => {
    expect(inspectField([null, '', undefined])).toEqual({ type: 'empty' })
  })

  it('对话优先于其它判定', () => {
    expect(inspectField(openaiMessages).type).toBe('messages')
  })
})

describe('数据集字段扫描', () => {
  const records: DataRecord[] = [
    { id: '0', index: 0, data: { instruction: '翻译', output: '你好', messages: openaiMessages[0] } },
    { id: '1', index: 1, data: { instruction: '总结', output: '摘要' } }
  ]

  it('列出所有字段并推断类型', () => {
    const fields = inspectFields(records)
    const map = new Map(fields.map((f) => [f.name, f.kind.type]))
    expect(map.get('instruction')).toBe('text')
    expect(map.get('output')).toBe('text')
    expect(map.get('messages')).toBe('messages')
  })

  it('字段顺序按首次出现顺序', () => {
    expect(inspectFields(records).map((f) => f.name)).toEqual(['instruction', 'output', 'messages'])
  })
})

describe('字段内取值路径', () => {
  const record: DataRecord = {
    id: '0',
    index: 0,
    data: { messages: openaiMessages[0], note: '备注' }
  }

  it('对话字段逐条给出 content 路径', () => {
    const kind = inspectField(openaiMessages)
    if (kind.type !== 'messages') throw new Error('应识别为对话')
    const slots = fieldContentSlots(record.data, 'messages', kind)
    expect(slots.map((s) => s.path)).toEqual([
      ['messages', 0, 'content'],
      ['messages', 1, 'content'],
      ['messages', 2, 'content']
    ])
    expect(slots.map((s) => s.role)).toEqual(['system', 'user', 'assistant'])
  })

  it('普通字段给出自身路径', () => {
    const slots = fieldContentSlots(record.data, 'note', { type: 'text', long: false })
    expect(slots).toEqual([{ path: ['note'], messageIndex: -1, role: null }])
  })

  it('fieldStringPaths 覆盖嵌套字符串', () => {
    const paths = fieldStringPaths(record.data, 'messages')
    expect(paths).toContainEqual(['messages', 0, 'content'])
    expect(paths).toContainEqual(['messages', 1, 'role'])
    expect(fieldStringPaths(record.data, 'note')).toEqual([['note']])
    expect(fieldStringPaths(record.data, 'missing')).toEqual([])
  })
})

describe('顶层列表字段查找', () => {
  it('优先取约定俗成的字段名', () => {
    expect(findListField({ data: [1], other: 2 })).toBe('data')
    expect(findListField({ records: [] })).toBe('records')
  })

  it('回退到第一个对象数组', () => {
    expect(findListField({ foo: 'bar', items: [{ a: 1 }] })).toBe('items')
  })

  it('找不到时返回 null', () => {
    expect(findListField({ a: 1 })).toBeNull()
    expect(findListField([1, 2])).toBeNull()
  })
})
