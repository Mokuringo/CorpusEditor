import { interpolate, isLocale, lookup, type Locale, type Vars } from '../../shared/locales'
import { loadSettings } from './store'

/**
 * 主进程侧的翻译。
 *
 * 只服务于「只能由主进程设置的文字」—— 原生对话框标题、文件类型名、窗口标题。
 * 抛给渲染进程的错误走 shared/errors.ts 的错误码，由渲染进程翻译，不经过这里。
 */
export function tFor(locale: Locale, key: string, vars?: Vars): string {
  return interpolate(lookup(locale, key), vars)
}

/**
 * 取当前语言。
 * 每次都重新读 settings.json（几百字节，对话框是用户触发的，不是热路径）——
 * 不缓存才能保住「切完语言立刻开对话框就是新语言」。
 */
export async function currentLocale(): Promise<Locale> {
  const settings = await loadSettings()
  return settings.locale
}

export { isLocale }
export type { Locale }
