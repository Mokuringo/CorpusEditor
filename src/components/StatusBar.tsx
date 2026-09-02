import { AlertTriangle, HardDriveDownload, Lock, X } from 'lucide-react'
import { formatCount, formatTime } from '../lib/text'
import { useT, useLocale } from '../i18n'
import { useStore } from '../state/store'
import type { TFunc } from '@shared/locales'

const saveText = (t: TFunc): Record<string, string> => ({
  idle: t('status.idle'),
  saved: t('status.saved'),
  saving: t('status.saving'),
  error: t('status.error')
})

export default function StatusBar() {
  const t = useT()
  const locale = useLocale()
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
    if (result.missing) toast(t('statusbar.toast.missing'), 'error')
    else if (!result.intact) toast(t('statusbar.toast.changed'), 'warn')
    else toast(t('statusbar.toast.ok'), 'success')
  }

  return (
    <footer className="statusbar">
      <span className="statusbar__item" title={dataset.source.path}>
        <Lock size={11} />
        <span className="truncate" style={{ maxWidth: 380 }}>
          {dataset.source.path}
        </span>
      </span>
      <button
        className="statusbar__item"
        style={{ border: 'none', background: 'transparent', color: 'inherit', padding: 0 }}
        onClick={checkSource}
        title={t('statusbar.check.title')}
      >
        <AlertTriangle size={11} />
        {t('statusbar.check')}
      </button>

      <span className="statusbar__spacer" />

      <span className="statusbar__item">{formatCount(records.length, locale)} {t('statusbar.records')}</span>
      <span className="statusbar__item">
        {t('home.stat.confirmed')} <b className="num">{formatCount(confirmed.size, locale)}</b>
      </span>
      <span className="statusbar__item">
        {t('home.stat.modified')} <b className="num">{formatCount(Object.keys(edits).length, locale)}</b>
      </span>
      {added.length > 0 && (
        <span className="statusbar__item">
          {t('home.stat.added')} <b className="num">{formatCount(added.length, locale)}</b>
        </span>
      )}
      {deleted.size > 0 && (
        <span className="statusbar__item">
          {t('home.stat.deleted')} <b className="num">{formatCount(deleted.size, locale)}</b>
        </span>
      )}
      {dataset.lastExportPath && (
        <span className="statusbar__item" title={dataset.lastExportPath}>
          <HardDriveDownload size={11} />
          {t('statusbar.lastExport')} {dataset.lastExportPath.split(/[\\/]/).pop()}
        </span>
      )}
      <span className="statusbar__item">
        <span
          className={`dot dot--${saveState === 'saving' ? 'saving' : saveState === 'error' ? 'error' : 'saved'}`}
        />
        {saveText(t)[saveState]}
        {saveState === 'saved' && lastSavedAt ? ` · ${formatTime(lastSavedAt)}` : ''}
      </span>
      {saveState === 'error' && (
        <span className="statusbar__item" style={{ color: 'var(--danger)' }}>
          <X size={11} />
          {t('statusbar.saveError')}
        </span>
      )}
    </footer>
  )
}
