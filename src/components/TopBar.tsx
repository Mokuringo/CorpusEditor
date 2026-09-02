import { Download, Plus, Redo2, Replace, Undo2, X } from 'lucide-react'
import Warp from './Warp'
import { useT } from '../i18n'
import { useStore } from '../state/store'

/**
 * 工作区顶栏。品牌标识、文件信息和主题切换已经上移到 TitleBar，
 * 这里只留经线刻度（全局进度）和撤销 / 替换 / 导出这组操作。
 */
export default function TopBar() {
  const t = useT()
  const dataset = useStore((s) => s.dataset)
  const undoStack = useStore((s) => s.undoStack)
  const redoStack = useStore((s) => s.redoStack)
  const undo = useStore((s) => s.undo)
  const redo = useStore((s) => s.redo)
  const openReplace = useStore((s) => s.openReplace)
  const openExport = useStore((s) => s.openExport)
  const closeDataset = useStore((s) => s.closeDataset)
  const openNewRecord = useStore((s) => s.openNewRecord)
  const view = useStore((s) => s.view)

  if (!dataset) return null

  return (
    <header className="topbar">
      <Warp />

      <div className="topbar__actions">
        <button className="iconbtn" onClick={undo} disabled={undoStack.length === 0} title={t('topbar.undo')}>
          <Undo2 size={15} />
        </button>
        <button className="iconbtn" onClick={redo} disabled={redoStack.length === 0} title={t('topbar.redo')}>
          <Redo2 size={15} />
        </button>
        <button className="btn" onClick={() => openNewRecord(view.selectedIndex + 1)} title={t('topbar.newRecord.title')}>
          <Plus size={14} />
          {t('topbar.newRecord')}
        </button>
        <button className="btn" onClick={openReplace} title={t('topbar.replace.title')}>
          <Replace size={14} />
          {t('topbar.replace')}
        </button>
        <button className="btn btn--primary" onClick={openExport} title={t('topbar.export.title')}>
          <Download size={14} />
          {t('topbar.export')}
        </button>
        <button
          className="iconbtn"
          data-testid="close-file"
          onClick={() => void closeDataset()}
          title={t('topbar.close')}
        >
          <X size={15} />
        </button>
      </div>
    </header>
  )
}
