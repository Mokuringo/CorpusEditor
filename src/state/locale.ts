import { isLocale, type Locale } from '@shared/locales'

const STORAGE_KEY = 'corpuseditor.locale'

/**
 * 系统语言兜底。
 *
 * 注意这是「首次启动的初始值」，不是常驻的「跟随系统」档位 —— 用户选过语言之后就钉住，
 * 不会出现「系统是英文但用户想看中文」的反复横跳。
 * 用 navigator.language 而不是主进程的 app.getLocale()：Electron 里它已反映 OS 语言设置，
 * 够用且不需要为此新增 IPC 通道。
 */
export function detectSystemLocale(): Locale {
  const lang = typeof navigator !== 'undefined' ? navigator.language : ''
  return lang.toLowerCase().startsWith('zh') ? 'zh-CN' : 'en'
}

/** 首屏缓存：localStorage 有就用它，没有就退回系统语言。 */
export function loadStoredLocale(): Locale {
  try {
    const value = localStorage.getItem(STORAGE_KEY)
    if (isLocale(value)) return value
  } catch {
    // localStorage 不可用时忽略
  }
  return detectSystemLocale()
}

export function storeLocale(locale: Locale): void {
  try {
    localStorage.setItem(STORAGE_KEY, locale)
  } catch {
    // 忽略
  }
}

/**
 * init() 里决定用哪门语言。优先级从高到低：
 * 启动参数（GUI 测试用）> Settings（主进程读回来的真相）> localStorage 首屏缓存 > 系统语言。
 */
export function resolveInitialLocale(paramLocale: unknown, settingsLocale: unknown): Locale {
  if (isLocale(paramLocale)) return paramLocale
  if (isLocale(settingsLocale)) return settingsLocale
  return loadStoredLocale()
}

/** 同步 <html lang>，让读屏与拼写检查拿到正确的语言。 */
export function applyLocale(locale: Locale): void {
  document.documentElement.setAttribute('lang', locale)
}
