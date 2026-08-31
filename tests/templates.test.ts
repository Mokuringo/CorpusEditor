import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import fsp from 'node:fs/promises'
import os from 'node:os'
import nodePath from 'node:path'
import { BUILTIN_TEMPLATES, TEMPLATE_GROUP_ORDER } from '@shared/types'
import { allTemplates, blankValue, newTemplateId, templateGroups, templateToData } from '@shared/templates'
import type { RecordTemplate, Settings } from '@shared/types'

const mocks = vi.hoisted(() => ({ userData: '' as string }))

vi.mock('electron', () => ({
  app: {
    getPath: () => mocks.userData,
    getVersion: () => '0.0.0-test'
  }
}))

const { loadSettings, saveSettings } = await import('../electron/main/store')

beforeAll(async () => {
  mocks.userData = await fsp.mkdtemp(nodePath.join(os.tmpdir(), 'corpuseditor-templates-'))
})

afterAll(async () => {
  await fsp.rm(mocks.userData, { recursive: true, force: true }).catch(() => {})
})

function byId(id: string): RecordTemplate {
  const found = BUILTIN_TEMPLATES.find((t) => t.id === id)
  if (!found) throw new Error(`内置模板里没有 ${id}`)
  return found
}

describe('内置模板清单自检', () => {
  it('id 唯一', () => {
    const ids = BUILTIN_TEMPLATES.map((t) => t.id)
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('name 唯一', () => {
    const names = BUILTIN_TEMPLATES.map((t) => t.name)
    expect(new Set(names).size).toBe(names.length)
  })

  it('都标了内置、都落在 TEMPLATE_GROUP_ORDER 里', () => {
    for (const t of BUILTIN_TEMPLATES) {
      expect(t.builtin, `${t.id} 没标 builtin`).toBe(true)
      expect(TEMPLATE_GROUP_ORDER, `${t.id} 的分组没登记`).toContain(t.group)
    }
  })

  it('除「空白」外都至少有一个字段，且字段名不重复', () => {
    for (const t of BUILTIN_TEMPLATES) {
      if (t.id === 'blank') {
        expect(t.fields).toEqual([])
        continue
      }
      expect(t.fields.length, `${t.id} 没有字段`).toBeGreaterThan(0)
      const names = t.fields.map((f) => f.name)
      expect(new Set(names).size, `${t.id} 有重名字段`).toBe(names.length)
      for (const name of names) expect(name.trim(), `${t.id} 有空字段名`).not.toBe('')
    }
  })

  it('对话类模板都写清了 roleKey / contentKey', () => {
    for (const t of BUILTIN_TEMPLATES) {
      for (const f of t.fields) {
        if (f.kind !== 'messages') continue
        expect(f.roleKey, `${t.id}.${f.name} 缺 roleKey`).toBeTruthy()
        expect(f.contentKey, `${t.id}.${f.name} 缺 contentKey`).toBeTruthy()
      }
    }
  })

  it('覆盖了主流微调数据格式（Alpaca / ShareGPT / DPO）', () => {
    const fieldsOf = (id: string) => byId(id).fields.map((f) => f.name)
    expect(fieldsOf('alpaca')).toEqual(['instruction', 'input', 'output'])
    expect(fieldsOf('dpo')).toEqual(['prompt', 'chosen', 'rejected'])
    // ShareGPT 两种写法都要有：OpenAI 的 role/content 与 from/value
    expect(fieldsOf('chat')).toContain('messages')
    expect(fieldsOf('sharegpt')).toContain('conversations')
  })
})

describe('模板 → 记录骨架', () => {
  it('文本字段是空串、结构字段是空对象', () => {
    expect(blankValue({ name: 'a', kind: 'text' })).toBe('')
    expect(blankValue({ name: 'a', kind: 'json' })).toEqual({})
  })

  it('对话字段默认给 role / content 的 user + assistant 两轮', () => {
    expect(blankValue({ name: 'messages', kind: 'messages' })).toEqual([
      { role: 'user', content: '' },
      { role: 'assistant', content: '' }
    ])
  })

  it('from / value 风格给的是 human + gpt，不是 user + assistant', () => {
    // 这条是关键：数据集里如果用的 from/value，新建的记录必须跟着用同一套角色词，
    // 否则导出后会混进一个数据集里根本不存在的角色
    expect(blankValue({ name: 'conversations', kind: 'messages', roleKey: 'from', contentKey: 'value' })).toEqual([
      { from: 'human', value: '' },
      { from: 'gpt', value: '' }
    ])
  })

  it('字段顺序就是声明顺序', () => {
    expect(Object.keys(templateToData(byId('alpaca-system').fields))).toEqual([
      'system',
      'instruction',
      'input',
      'output'
    ])
  })

  it('自定义默认值覆盖空值骨架', () => {
    const fields = [
      { name: 'system', kind: 'text' as const, default: '你是一个助手' },
      { name: 'output', kind: 'text' as const }
    ]
    expect(templateToData(fields)).toEqual({ system: '你是一个助手', output: '' })
  })

  it('「空白」模板生成的是空对象', () => {
    expect(templateToData(byId('blank').fields)).toEqual({})
  })
})

describe('模板分组', () => {
  it('按 TEMPLATE_GROUP_ORDER 的顺序出组', () => {
    expect(templateGroups().map((g) => g.label)).toEqual(TEMPLATE_GROUP_ORDER)
  })

  it('自定义模板挂在最后的「我的模板」，不影响内置分组', () => {
    const custom: RecordTemplate[] = [{ id: 't1', name: '我的', fields: [{ name: 'x', kind: 'text' }] }]
    const groups = templateGroups(custom)
    expect(groups[groups.length - 1]).toEqual({ label: '我的模板', items: custom })
    // 自定义模板没有 group 字段也要能归组，不能凭空消失
    expect(new Set(groups.map((g) => g.label)).size).toBe(TEMPLATE_GROUP_ORDER.length + 1)
  })

  it('没有自定义模板时不出现空组', () => {
    expect(templateGroups().every((g) => g.items.length > 0)).toBe(true)
  })

  it('allTemplates 覆盖每一组的每一项，顺序与分组一致', () => {
    const custom: RecordTemplate[] = [{ id: 't1', name: '我的', fields: [{ name: 'x', kind: 'text' }] }]
    const all = allTemplates(custom)
    expect(all).toHaveLength(BUILTIN_TEMPLATES.length + 1)
    expect(all[all.length - 1].id).toBe('t1')
  })
})

describe('自定义模板的落盘', () => {
  function baseSettings(overrides: Partial<Settings> = {}): Settings {
    return {
      theme: 'system',
      locale: 'zh-CN',
      lastOpenDir: null,
      recentSessionIds: [],
      ...overrides
    }
  }

  it('保存后能原样读回来（含 roleKey / contentKey）', async () => {
    const custom: RecordTemplate[] = [
      {
        id: 't1',
        name: '我的 ShareGPT',
        fields: [{ name: 'conversations', kind: 'messages', roleKey: 'from', contentKey: 'value' }]
      }
    ]
    await saveSettings(baseSettings({ recordTemplates: custom }))
    const loaded = await loadSettings()
    expect(loaded.recordTemplates).toEqual(custom)
    // 键名是后面新建记录时对齐数据集结构的唯一依据，落盘不能丢
    expect(loaded.recordTemplates?.[0].fields[0].contentKey).toBe('value')
  })

  it('删掉一个模板后，settings 里真的没了', async () => {
    const two: RecordTemplate[] = [
      { id: 't1', name: '甲', fields: [{ name: 'a', kind: 'text' }] },
      { id: 't2', name: '乙', fields: [{ name: 'b', kind: 'text' }] }
    ]
    await saveSettings(baseSettings({ recordTemplates: two }))
    await saveSettings(baseSettings({ recordTemplates: two.filter((t) => t.id !== 't2') }))
    const loaded = await loadSettings()
    expect(loaded.recordTemplates?.map((t) => t.id)).toEqual(['t1'])
  })

  it('内置模板不落盘：读完仍是内置那几份，不会多出副本', async () => {
    await saveSettings(baseSettings())
    const loaded = await loadSettings()
    // 内置模板只存在代码里。写进 settings 会让升级后新旧两份打架
    expect(loaded.recordTemplates ?? []).toEqual([])
    expect(allTemplates(loaded.recordTemplates)).toHaveLength(BUILTIN_TEMPLATES.length)
  })

  it('没写过设置时给出完整默认值，recordTemplates 为 undefined 而不是崩', async () => {
    const loaded = await loadSettings()
    expect(loaded.theme).toBe('system')
    expect(loaded.locale).toBe('zh-CN')
    // 渲染进程用的是 settings?.recordTemplates ?? []，undefined 是合法的
    expect(templateGroups(loaded.recordTemplates)).toHaveLength(TEMPLATE_GROUP_ORDER.length)
  })
})

describe('新建模板的 id 生成', () => {
  it('同一次毫秒内连建两个也不会撞', () => {
    const existing: RecordTemplate[] = []
    const a = newTemplateId(existing)
    const b = newTemplateId([{ ...byId('blank'), id: a }])
    expect(a).not.toBe(b)
  })

  it('已有的 id 一定不会被重新生成', () => {
    const existing = [{ ...byId('blank'), id: 't1' }]
    expect(newTemplateId(existing)).not.toBe('t1')
  })
})
