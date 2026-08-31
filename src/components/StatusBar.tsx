import { AlertTriangle, HardDriveDownload, Lock, X } from 'lucide-react'
import { formatCount, formatTime } from '../lib/text'
import { useStore } from '../state/store'

const SAVE_TEXT: Record<string, string> = {
  idle: '尚未保存',
  saved: '进度已保存',
  saving: '正在保存…',
  error: '保存失败'
}

export default function StatusBar() {
  const dataset = useStore((s) => s.dataset)
  const saveState = useStore((s) => s.saveState)
  const lastSavedAt = useStore((s) => s.lastSavedAt)
  const records = useStore((s) => s.records)
  const edits = useStore((s) => s.edits)
  const deleted = useStore((s) => s.deleted)
  const confirmed = useStore((s) => s.confirmed)
  const added = useStore((s) => s.added)
  const verify = useStore((s) => s.verifySource)
  const toast = useStore((s) => s.toast)

  if (!dataset) return null

  const checkSource = async () => {
    const result = await verify(dataset.id)
    if (result.missing) toast('源文件已不在原位置，导出的内容仍以读入时的数据为准。', 'error')
    else if (!result.intact) toast('源文件在打开之后被改动过，建议重新打开以对齐。', 'warn')
    else toast('源文件完好，与读入时一致。', 'success')
  }

  return (
    <footer className="statusbar">
      <span className="statusbar__item" title={dataset.source.path}>
        <Lock size={11} />
        <span className="truncate" style={{ maxWidth: 380 }}>
          {dataset.source.path}
        </span>
      </span>
      <button className="statusbar__item" style={{ border: 'none', background: 'transparent', color: 'inherit', padding: 0 }} onClick={checkSource} title="检查源文件是否被改动">
        <AlertTriangle size={11} />
        校验源文件
      </button>

      <span className="statusbar__spacer" />

      <span className="statusbar__item">
        {formatCount(records.length)} 条
      </span>
      <span className="statusbar__item">
        已确认 <b className="num">{formatCount(confirmed.size)}</b>
      </span>
      <span className="statusbar__item">
        已改 <b className="num">{formatCount(Object.keys(edits).length)}</b>
      </span>
      {added.length > 0 && (
        <span className="statusbar__item">
          新建 <b className="num">{formatCount(added.length)}</b>
        </span>
      )}
      {deleted.size > 0 && (
        <span className="statusbar__item">
          已删 <b className="num">{formatCount(deleted.size)}</b>
        </span>
      )}
      {dataset.lastExportPath && (
        <span className="statusbar__item" title={dataset.lastExportPath}>
          <HardDriveDownload size={11} />
          上次导出 {dataset.lastExportPath.split(/[\\/]/).pop()}
        </span>
      )}
      <span className="statusbar__item">
        <span className={`dot dot--${saveState === 'saving' ? 'saving' : saveState === 'error' ? 'error' : 'saved'}`} />
        {SAVE_TEXT[saveState]}
        {saveState === 'saved' && lastSavedAt ? ` · ${formatTime(lastSavedAt)}` : ''}
      </span>
      {saveState === 'error' && (
        <span className="statusbar__item" style={{ color: 'var(--danger)' }}>
          <X size={11} />
          进度未能写入磁盘
        </span>
      )}
    </footer>
  )
}
