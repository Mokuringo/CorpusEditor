import { describe, expect, it } from 'vitest'
import { buildMatcher, commitPlan, planReplace } from '@shared/replace'
import { applyEdits } from '@shared/patch'
import { pathKey } from '@shared/jsonpath'
import type { DataRecord, ReplaceOptions } from '@shared/types'

function records(): DataRecord[] {
  return [
    {
      id: '0',
      index: 0,
      data: {
        system: '你是一个助手',
        messages: [
          { role: 'system', content: '你是助手 assistant' },
          { role: 'user', content: '请用 assistant 的口吻' },
          { role: 'assistant', content: '好的 assistant' }
        ]
      }
    },
    {
      id: '1',
      index: 1,
      data: {
        system: '你是翻译器',
        messages: [
          { role: 'system', content: '翻译 assistant' },
          { role: 'user', content: 'hello assistant' }
        ]
      }
    }
  ]
}

const baseOptions: ReplaceOptions = {
  find: 'assistant',
  replace: 'AI 助手',
  caseSensitive: true,
  wholeWord: false,
  useRegex: false
}

describe('匹配器构造', () => {
  it('空查找返回错误', () => {
    expect(buildMatcher({ ...baseOptions, find: '' }).error).toBe('查找内容不能为空')
  })

  it('非法正则返回错误', () => {
    expect(buildMatcher({ ...baseOptions, find: '([', useRegex: true }).error).toContain('正则表达式无效')
  })

  it('普通模式下特殊字符被转义', () => {
    const { regex } = buildMatcher({ ...baseOptions, find: 'a.b', useRegex: false })
    expect(regex?.test('a.b')).toBe(true)
    expect(regex?.test('axb')).toBe(false)
  })

  it('忽略大小写', () => {
    const { regex } = buildMatcher({ ...baseOptions, caseSensitive: false })
    expect(regex?.test('ASSISTANT')).toBe(true)
  })

  it('区分大小写', () => {
    const { regex } = buildMatcher({ ...baseOptions, caseSensitive: true })
    expect(regex?.test('ASSISTANT')).toBe(false)
  })

  it('全字匹配不会命中单词内部', () => {
    const { regex } = buildMatcher({ ...baseOptions, wholeWord: true })
    expect('assistants'.match(regex ?? /x/)).toBeNull()
    expect('an assistant here'.match(regex ?? /x/)).not.toBeNull()
  })

  it('全字匹配对中文同样生效', () => {
    const { regex } = buildMatcher({ ...baseOptions, find: '助手', wholeWord: true })
    expect('助手'.match(regex ?? /x/)).not.toBeNull()
    // 前后紧跟其它汉字时不算整词
    expect('小助手大'.match(regex ?? /x/)).toBeNull()
  })
})

describe('全局替换', () => {
  it('替换所有字段里的所有命中（含对话与嵌套）', () => {
    const { plan, error } = planReplace(records(), { type: 'everything' }, baseOptions)
    expect(error).toBeNull()
    expect(plan?.matchCount).toBe(5)
    expect(plan?.affectedRecords).toBe(2)
    const applied = applyEdits(records(), plan!.patch)
    expect(applied[0].data.system).toBe('你是一个助手')
    expect((applied[0].data.messages as Array<Record<string, string>>)[0].content).toBe('你是助手 AI 助手')
    expect((applied[1].data.messages as Array<Record<string, string>>)[1].content).toBe('hello AI 助手')
  })

  it('逆补丁可以完整还原', () => {
    const source = records()
    const before = JSON.stringify(source)
    const { plan } = planReplace(source, { type: 'everything' }, baseOptions)
    const applied = applyEdits(source, plan!.patch)
    expect(JSON.stringify(applied)).not.toBe(before)
    const restored = applyEdits(applied, plan!.inverse)
    expect(JSON.stringify(restored)).toBe(before)
  })

  it('commitPlan 把计划并入已有补丁并可反向撤销', () => {
    const source = records()
    const { plan } = planReplace(source, { type: 'everything' }, baseOptions)
    let edits = commitPlan({}, plan!, 'forward')
    expect(Object.keys(edits).length).toBe(2)
    edits = commitPlan(edits, plan!, 'backward')
    expect(JSON.stringify(applyEdits(source, edits))).toBe(JSON.stringify(source))
  })

  it('没有命中时返回 0', () => {
    const { plan } = planReplace(records(), { type: 'everything' }, { ...baseOptions, find: '不存在的词' })
    expect(plan?.matchCount).toBe(0)
    expect(plan?.affectedRecords).toBe(0)
  })

  it('替换为空串等于删除匹配内容', () => {
    const { plan } = planReplace(records(), { type: 'everything' }, { ...baseOptions, replace: '' })
    const applied = applyEdits(records(), plan!.patch)
    expect((applied[0].data.messages as Array<Record<string, string>>)[2].content).toBe('好的 ')
  })
})

describe('按字段替换', () => {
  it('只替换指定顶层字段，不影响其它字段', () => {
    const options: ReplaceOptions = { ...baseOptions, find: '助手', replace: 'AI 助理' }
    const { plan } = planReplace(records(), { type: 'field', field: 'system' }, options)
    expect(plan?.matchCount).toBe(1)
    expect(Object.keys(plan!.patch)).toEqual(['0'])
    const applied = applyEdits(records(), plan!.patch)
    expect(applied[0].data.system).toBe('你是一个AI 助理')
    // 对话里的「助手」属于 messages 字段，不受影响
    expect((applied[0].data.messages as Array<Record<string, string>>)[0].content).toBe('你是助手 assistant')
  })

  it('对话字段的替换不会误伤角色名', () => {
    const { plan } = planReplace(records(), { type: 'field', field: 'messages' }, baseOptions)
    const applied = applyEdits(records(), plan!.patch)
    const messages = applied[0].data.messages as Array<Record<string, string>>
    expect(messages[2].role).toBe('assistant')
    expect(messages[2].content).toBe('好的 AI 助手')
  })

  it('指定对话字段时替换其下所有轮次', () => {
    const { plan } = planReplace(records(), { type: 'field', field: 'messages' }, baseOptions)
    expect(plan?.matchCount).toBe(5)
    const applied = applyEdits(records(), plan!.patch)
    expect(applied[0].data.system).toBe('你是一个助手')
  })
})

describe('按角色替换', () => {
  it('只替换 system 轮次', () => {
    const { plan } = planReplace(records(), { type: 'role', field: 'messages', role: 'system' }, baseOptions)
    expect(plan?.matchCount).toBe(2)
    const applied = applyEdits(records(), plan!.patch)
    const messages = applied[0].data.messages as Array<Record<string, string>>
    expect(messages[0].content).toBe('你是助手 AI 助手')
    expect(messages[1].content).toBe('请用 assistant 的口吻')
    expect(messages[2].content).toBe('好的 assistant')
  })

  it('只替换 user 轮次', () => {
    const { plan } = planReplace(records(), { type: 'role', field: 'messages', role: 'user' }, baseOptions)
    expect(plan?.matchCount).toBe(2)
  })

  it('ShareGPT 风格的角色名（human/gpt）也能识别', () => {
    const sharegpt: DataRecord[] = [
      {
        id: '0',
        index: 0,
        data: {
          conversations: [
            { from: 'human', value: 'assistant 你好' },
            { from: 'gpt', value: 'assistant 回答' }
          ]
        }
      }
    ]
    const { plan } = planReplace(sharegpt, { type: 'role', field: 'conversations', role: 'user' }, baseOptions)
    expect(plan?.matchCount).toBe(1)
    const applied = applyEdits(sharegpt, plan!.patch)
    const turns = applied[0].data.conversations as Array<Record<string, string>>
    expect(turns[0].value).toBe('AI 助手 你好')
    expect(turns[1].value).toBe('assistant 回答')
  })

  it('键即角色的对话（{ human, assistant }）也能按角色定向替换', () => {
    const pairs: DataRecord[] = [
      {
        id: '0',
        index: 0,
        data: {
          conversation: [
            { human: 'assistant 你好', assistant: 'assistant 回答' },
            { human: '再问一次', assistant: 'assistant 再答' }
          ]
        }
      }
    ]
    const { plan } = planReplace(pairs, { type: 'role', field: 'conversation', role: 'human' }, baseOptions)
    expect(plan?.matchCount).toBe(1)
    const applied = applyEdits(pairs, plan!.patch)
    const turns = applied[0].data.conversation as Array<Record<string, string>>
    expect(turns[0].human).toBe('AI 助手 你好')
    // assistant 没被波及，human 与 assistant 归一化后是两个不同的角色
    expect(turns[0].assistant).toBe('assistant 回答')
    expect(turns[1].human).toBe('再问一次')
  })

  it('全库替换不会改掉 pairs 的键名（键名是结构，不是内容）', () => {
    const pairs: DataRecord[] = [
      {
        id: '0',
        index: 0,
        data: { conversation: [{ human: 'assistant 你好', assistant: 'assistant 回答' }] }
      }
    ]
    const { plan } = planReplace(pairs, { type: 'everything' }, baseOptions)
    expect(plan?.matchCount).toBe(2)
    const applied = applyEdits(pairs, plan!.patch)
    const turn = (applied[0].data.conversation as Array<Record<string, string>>)[0]
    // 值被替换了，键一个都没动 —— 键变了导出就和数据集中其它记录对不上了
    expect(turn.human).toBe('AI 助手 你好')
    expect(turn.assistant).toBe('AI 助手 回答')
    expect(Object.keys(turn)).toEqual(['human', 'assistant'])
  })

  it('不存在的角色命中 0 处', () => {
    const { plan } = planReplace(records(), { type: 'role', field: 'messages', role: 'tool' }, baseOptions)
    expect(plan?.matchCount).toBe(0)
  })
})

describe('作用范围', () => {
  it('限定的记录之外的不受影响', () => {
    const { plan } = planReplace(records(), { type: 'everything' }, baseOptions, { ids: new Set(['1']) })
    expect(plan?.affectedRecords).toBe(1)
    expect(Object.keys(plan!.patch)).toEqual(['1'])
  })
})

describe('正则替换', () => {
  it('支持捕获组引用', () => {
    const data: DataRecord[] = [{ id: '0', index: 0, data: { text: '2023-01-02 和 2024-05-06' } }]
    const { plan } = planReplace(
      data,
      { type: 'everything' },
      { find: '(\\d{4})-(\\d{2})-(\\d{2})', replace: '$1/$2/$3', caseSensitive: true, wholeWord: false, useRegex: true }
    )
    expect(plan?.matchCount).toBe(2)
    const applied = applyEdits(data, plan!.patch)
    expect(applied[0].data.text).toBe('2023/01/02 和 2024/05/06')
  })

  it('非正则模式下 $& 不会被当作特殊符号', () => {
    const data: DataRecord[] = [{ id: '0', index: 0, data: { text: 'abc' } }]
    const { plan } = planReplace(data, { type: 'everything' }, { ...baseOptions, find: 'b', replace: '$&' })
    const applied = applyEdits(data, plan!.patch)
    expect(applied[0].data.text).toBe('a$&c')
  })
})

describe('预览样本', () => {
  it('样本包含路径标签与改动前后文本', () => {
    const { plan } = planReplace(records(), { type: 'everything' }, baseOptions)
    expect(plan!.samples.length).toBeGreaterThan(0)
    expect(plan!.samples[0].pathLabel).toContain('content')
    expect(plan!.samples[0].after).toContain('AI 助手')
    expect(plan!.samples.length).toBeLessThanOrEqual(12)
  })

  it('长文本样本会被截断', () => {
    const long = 'x'.repeat(4000) + 'assistant' + 'y'.repeat(4000)
    const data: DataRecord[] = [{ id: '0', index: 0, data: { text: long } }]
    const { plan } = planReplace(data, { type: 'everything' }, baseOptions)
    expect(plan!.samples[0].before.length).toBeLessThan(400)
    expect(plan!.samples[0].before).toContain('…')
  })
})

describe('键路径一致性', () => {
  it('补丁键使用 pathKey 序列化', () => {
    const { plan } = planReplace(records(), { type: 'role', field: 'messages', role: 'system' }, baseOptions)
    expect(Object.keys(plan!.patch['0'])[0]).toBe(pathKey(['messages', 0, 'content']))
  })
})
