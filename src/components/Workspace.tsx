import { useEffect } from 'react'
import { AlertTriangle, FolderOpen, RefreshCw, X } from 'lucide-react'
import TopBar from './TopBar'
import RecordList from './RecordList'
import RecordEditor from './RecordEditor'
import StatusBar from './StatusBar'
import NewRecordDialog from './NewRecordDialog'
import { useStore } from '../state/store'
import { confirmAndAdvance, stepQueue } from '../state/visible'

export default function Workspace() {
  const dataset = useStore((s) => s.dataset)
  const undo = useStore((s) => s.undo)
  const redo = useStore((s) => s.redo)
  const openReplace = useStore((s) => s.openReplace)
  const openExport = useStore((s) => s.openExport)
  const openFile = useStore((s) => s.openFile)
  const warningsDismissed = useStore((s) => s.warningsDismissed)
  const replaceOpen = useStore((s) => s.replaceOpen)
  const exportOpen = useStore((s) => s.exportOpen)
  const newRecordOpen = useStore((s) => s.newRecordOpen)

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      // 中文输入法组词状态会把 Enter 先吃掉，不挡掉就会打字打到一半跳到下一条
      if (event.isComposing) return
      const blocked = replaceOpen || exportOpen || newRecordOpen
      if (blocked) return
      const key = event.key.toLowerCase()

      if (event.altKey && (event.key === 'ArrowDown' || event.key === 'ArrowUp')) {
        event.preventDefault()
        stepQueue(event.key === 'ArrowDown' ? 1 : -1)
        return
      }
      if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') {
        event.preventDefault()
        confirmAndAdvance()
        return
      }

      if (!(event.ctrlKey || event.metaKey)) return
      if (key === 'z' && !event.shiftKey) {
        event.preventDefault()
        undo()
      } else if ((key === 'z' && event.shiftKey) || key === 'y') {
        event.preventDefault()
        redo()
      } else if (key === 'f') {
        event.preventDefault()
        openReplace()
      } else if (key === 's') {
        event.preventDefault()
        openExport()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [undo, redo, openReplace, openExport, replaceOpen, exportOpen, newRecordOpen])

  if (!dataset) return null
  const showWarnings = dataset.warnings.length > 0 && !warningsDismissed

  return (
    <>
      <TopBar />

      {dataset.sourceChanged && (
        <div className="banner banner--danger">
          <AlertTriangle size={13} />
          <span className="banner__text">
            源文件在打开之后被改动过。已尽量套用保存的改动，位置对不上的部分会被忽略。
          </span>
          <button className="btn btn--sm" onClick={() => void openFile(dataset.source.path, true)}>
            <RefreshCw size={11} />
            丢弃改动重新开始
          </button>
        </div>
      )}

      {showWarnings && (
        <div className="banner">
          <AlertTriangle size={13} />
          <span className="banner__text">{dataset.warnings.join('　')}</span>
          <button
            className="iconbtn"
            onClick={() => useStore.setState({ warningsDismissed: true })}
            aria-label="忽略"
          >
            <X size={13} />
          </button>
        </div>
      )}

      <div className="app__body">
        <RecordList />
        <RecordEditor />
      </div>

      <StatusBar />

      {dataset.recordCount === 0 && (
        <div className="empty" style={{ padding: 'var(--sp-8)' }}>
          <FolderOpen size={18} />
          <span>这个文件里没有解析到任何记录</span>
        </div>
      )}

      {newRecordOpen && <NewRecordDialog />}
    </>
  )
}
