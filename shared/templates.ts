import { BUILTIN_TEMPLATES, TEMPLATE_GROUP_ORDER } from './types'
import type { Json, RecordTemplate, TemplateField } from './types'

/**
 * 对话字段的骨架角色。键名是 from 的按 ShareGPT 习惯写 human / gpt，
 * 其余（role / speaker 等）按 OpenAI 习惯写 user / assistant ——
 * 新建的记录要和数据集里已有的记录用同一套角色词，否则导出时会混进陌生角色。
 */
function skeletonRoles(roleKey: string): [string, string] {
  return roleKey === 'from' ? ['human', 'gpt'] : ['user', 'assistant']
}

/** 一个字段在「新建一条记录」时的初始内容。 */
export function blankValue(field: TemplateField): Json {
  if (field.kind === 'messages') {
    const roleKey = field.roleKey ?? 'role'
    const contentKey = field.contentKey ?? 'content'
    const [first, second] = skeletonRoles(roleKey)
    return [
      { [roleKey]: first, [contentKey]: '' },
      { [roleKey]: second, [contentKey]: '' }
    ] as Json
  }
  if (field.kind === 'json') return {} as Json
  return ''
}

/** 按模板字段的声明顺序拼出一条新记录。字段顺序就是导出时的列顺序，不能乱。 */
export function templateToData(fields: TemplateField[]): Record<string, Json> {
  const data: Record<string, Json> = {}
  for (const field of fields) data[field.name] = field.default ?? blankValue(field)
  return data
}

export interface TemplateGroup {
  label: string
  items: RecordTemplate[]
}

/**
 * 内置模板按声明的分组聚合，用户自定义模板统一挂在最后一组「我的模板」。
 * 自定义模板没有 group 字段（老数据也没有），所以不按它们的 group 归类。
 */
export function templateGroups(custom: RecordTemplate[] = []): TemplateGroup[] {
  const groups: TemplateGroup[] = []
  for (const label of TEMPLATE_GROUP_ORDER) {
    const items = BUILTIN_TEMPLATES.filter((t) => (t.group ?? '') === label)
    if (items.length > 0) groups.push({ label, items })
  }
  // 内置模板若漏标 group，兜底塞进「其它」，否则它们会从下拉里凭空消失
  const orphan = BUILTIN_TEMPLATES.filter((t) => !TEMPLATE_GROUP_ORDER.includes(t.group ?? ''))
  if (orphan.length > 0) groups.push({ label: '其它', items: orphan })
  if (custom.length > 0) groups.push({ label: '我的模板', items: custom })
  return groups
}

/** 界面上并列展示的全部模板，顺序与分组后的顺序一致。 */
export function allTemplates(custom: RecordTemplate[] = []): RecordTemplate[] {
  return templateGroups(custom).flatMap((g) => g.items)
}

/**
 * 给新模板生成一个 id。
 * 不用裸 Date.now()：同一毫秒内连建两个模板会撞 id，下拉里就会出现两个同名项。
 */
export function newTemplateId(existing: RecordTemplate[] = []): string {
  const taken = new Set(existing.map((t) => t.id))
  let n = 0
  let id = ''
  do {
    id = `t${Date.now().toString(36)}${n > 0 ? `-${n}` : ''}`
    n++
  } while (taken.has(id))
  return id
}
