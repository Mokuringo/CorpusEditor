import type { CorpusEditorApi } from '../../electron/preload/index'

/** 渲染进程访问主进程的唯一入口。 */
export const api: CorpusEditorApi = window.corpuseditor

export function isApiReady(): boolean {
  return typeof window !== 'undefined' && Boolean(window.corpuseditor)
}
