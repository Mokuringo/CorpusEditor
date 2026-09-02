/**
 * 两套词典的公共入口。放在 shared/ 而不是 src/：主进程的原生对话框标题、
 * 窗口标题、文件类型名只有主进程能设，字典必须两边都能 import。
 * 字典是纯对象常量，不引入 node:*，不违反分层规则。
 */
import zh from './zh-CN'
import en from './en'

export type Locale = 'zh-CN' | 'en'
export type Dict = Record<string, string>
export type Vars = Record<string, string | number>

/** 查词函数。组件里由 useT() 提供，主进程里由 tFor 提供。 */
export type TFunc = (key: string, vars?: Vars) => string

export const DICTS: Record<Locale, Dict> = { 'zh-CN': zh, en }

export const DEFAULT_LOCALE: Locale = 'zh-CN'

export function isLocale(value: unknown): value is Locale {
  return value === 'zh-CN' || value === 'en'
}

/** 查不到就退回中文，再查不到就返回 key 本身 —— 开发期一眼看出漏翻。 */
export function lookup(locale: Locale, key: string): string {
  return DICTS[locale]?.[key] ?? DICTS[DEFAULT_LOCALE][key] ?? key
}

export function interpolate(template: string, vars?: Vars): string {
  if (!vars) return template
  return template.replace(/\{(\w+)\}/g, (whole, name: string) =>
    name in vars ? String(vars[name]) : whole
  )
}

/**
 * 键一致性静态断言：两套字典的键集合必须完全相同，少翻一个 key 就编译不过。
 * 放在这里而不是 src/i18n/，好让主进程与渲染进程共用同一份保证，
 * 不会出现「渲染进程补了 key、主进程那份漏了」的偏差。
 */
type Equal<A, B> = keyof A extends keyof B ? (keyof B extends keyof A ? true : never) : never
export const _keysAligned: Equal<typeof zh, typeof en> = true
