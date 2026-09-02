/**
 * 产品名与品牌文案的唯一来源。
 *
 * 界面上任何地方要显示产品名都从这里取，避免改名时漏掉某一处。
 * 注意：`package.json` 与 `electron/main/index.ts` 拿不到这里的值
 * （主进程不引用 src/），那两处是手写的，改名时要一起改。
 *
 * slogan / productTitle 是工厂函数而非常量：它们要跟着语言变，
 * 不能冻在模块加载时刻（见 plan B7）。调用方用 useT() 提供的 t 传入。
 */
import type { TFunc } from '@shared/locales'

export const PRODUCT_NAME = 'CorpusEditor'

export function slogan(t: TFunc): string {
  return t('product.slogan')
}

export function productTitle(t: TFunc): string {
  return `${PRODUCT_NAME} · ${slogan(t)}`
}
