/**
 * 产品名与品牌文案的唯一来源。
 *
 * 界面上任何地方要显示产品名都从这里取，避免改名时漏掉某一处。
 * 注意：`package.json` 与 `electron/main/index.ts` 拿不到这里的值
 * （主进程不引用 src/），那两处是手写的，改名时要一起改。
 */
export const PRODUCT_NAME = 'CorpusEditor'
export const PRODUCT_SLOGAN = 'LLM 指令微调数据编辑器'
export const PRODUCT_TITLE = `${PRODUCT_NAME} · ${PRODUCT_SLOGAN}`
