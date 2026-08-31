import type { CorpusEditorApi } from '../../electron/preload/index'

declare global {
  interface Window {
    corpuseditor: CorpusEditorApi
  }
}

export {}
