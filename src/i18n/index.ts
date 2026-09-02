import { useSyncExternalStore } from 'react'
import { interpolate, lookup, type Locale, type Vars } from '@shared/locales'

/**
 * 渲染进程侧的翻译入口。
 *
 * 这里刻意**不 import store**：store 里的 toast 文案也要用 t()，
 * 两边互相 import 会形成循环依赖。所以 locale 由 store 通过 setLocale() 单向写进来，
 * 组件用 useSyncExternalStore 订阅，切语言时只重渲真正用到文字的组件。
 */

let currentLocale: Locale = 'zh-CN'
const listeners = new Set<() => void>()

export function getLocale(): Locale {
  return currentLocale
}

export function setLocale(next: Locale): void {
  if (next === currentLocale) return
  currentLocale = next
  for (const listener of listeners) listener()
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function useLocale(): Locale {
  return useSyncExternalStore(subscribe, getLocale, getLocale)
}

/**
 * 查词。
 * ⚠️ 只有在**组件体内**调用才会跟着语言变。模块作用域里调 t() 只在 import 时求值一次，
 * 之后切语言组件重渲了、那个常量还是旧值 —— 模块级常量必须改成工厂函数或移进组件体。
 */
export function t(key: string, vars?: Vars, locale: Locale = currentLocale): string {
  return interpolate(lookup(locale, key), vars)
}

/** 组件里用这个：精确订阅，切语言时只重渲用到文字的组件。 */
export function useT(): (key: string, vars?: Vars) => string {
  const locale = useLocale()
  return (key: string, vars?: Vars) => t(key, vars, locale)
}
