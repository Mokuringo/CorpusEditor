import { decodeError, type ErrorCode, type Vars, type Warning } from '@shared/errors'
import type { TFunc } from '@shared/locales'
import { formatCount } from './text'

/**
 * 把「错误码 / 警告码」翻成当前语言的文案。
 *
 * 主进程与 shared/ 只产出码，不产出中文 —— 翻译统一发生在渲染进程这一层，
 * 这样切语言时已经显示出来的错误也会跟着变，而且测试可以稳定地断言码而不是文案。
 */

/** 数字参数按当前语言加千分位，字符串原样透传。 */
function withCounts(params: Vars | undefined, locale: string): Vars | undefined {
  if (!params) return undefined
  const out: Vars = {}
  for (const [key, value] of Object.entries(params)) {
    out[key] = typeof value === 'number' ? formatCount(value, locale as 'zh-CN' | 'en') : value
  }
  return out
}

export function formatWarning(w: Warning, tr: TFunc, locale: string): string {
  return tr(`warn.${w.code}`, withCounts(w.params, locale))
}

/** 校验类的错误（导出配置、替换选项）只有码，由调用方直接翻译。 */
export function formatCode(code: ErrorCode, tr: TFunc, locale: string, params?: Vars): string {
  return tr(`error.${code}`, withCounts(params, locale))
}

/**
 * 把任意抛出的东西翻成人话。
 * 认得出错误码就翻译；认不出（系统错误、JSON.parse 的原生报错等）就原样显示 ——
 * 那些文案来自引擎或操作系统，我们管不到，也不该硬翻。
 */
export function formatError(err: unknown, tr: TFunc, locale: string): string {
  const payload = decodeError(err)
  if (payload) return formatCode(payload.code, tr, locale, payload.params)
  if (err instanceof Error) return err.message
  return String(err)
}
