import { useState } from 'react'
import {
  AlertTriangle,
  ArrowRight,
  ChevronRight,
  Download,
  FileStack,
  FolderOpen,
  History,
  Lock,
  PencilLine,
  Play,
  Plus,
  Replace,
  Trash2
} from 'lucide-react'
import BrandMark from './BrandMark'
import NewDatasetDialog from './NewDatasetDialog'
import { api } from '../lib/api'
import { productTitle } from '../lib/product'
import { formatCount, relativeTime } from '../lib/text'
import { useT } from '../i18n'
import { useStore } from '../state/store'
import type { SessionSummary } from '@shared/types'

const FORMATS = ['JSONL', 'JSON', 'CSV', 'TSV', 'YAML', 'Parquet', 'TXT']

type Capability = { icon: typeof Lock; key: string }

const CAPABILITY_KEYS: Capability[] = [
  { icon: Lock, key: 'readonly' },
  { icon: PencilLine, key: 'edit' },
  { icon: Replace, key: 'replace' },
  { icon: Plus, key: 'add' },
  { icon: History, key: 'history' },
  { icon: Download, key: 'export' }
]

export default function Home() {
  const t = useT()
  const sessions = useStore((s) => s.sessions)
  const openFile = useStore((s) => s.openFile)
  const forgetSession = useStore((s) => s.forgetSession)
  const toast = useStore((s) => s.toast)
  const [newOpen, setNewOpen] = useState(false)
  const [showAllRecent, setShowAllRecent] = useState(false)

  const pickFile = async () => {
    const filePath = await api.openSourceDialog(null)
    if (!filePath) return
    try {
      await openFile(filePath)
    } catch {
      // 错误已在 store 里以 toast 形式提示
    }
  }

  const resume = async (session: SessionSummary) => {
    if (session.sourceMissing) {
      toast(t('home.toast.sourceMissing'), 'error')
      const filePath = await api.openSourceDialog(null)
      if (filePath) await openFile(filePath).catch(() => undefined)
      return
    }
    await openFile(session.sourcePath).catch(() => undefined)
  }

  return (
    <div className="home">
      <div className="home__inner">
        <section className="home__grid">
          <div className="home__left">
            <div className="home__eyebrow">
              <BrandMark size={15} tone="accent" />
              <span className="label">{productTitle(t)}</span>
            </div>
            {/* 断点写死在结构里：靠 max-width 碰运气会在第 8 个字后断成「创建和修改指令微 / 调数据」 */}
            <h1 className="home__title">
              <span className="home__title-line">{t('home.title.line1')}</span>
              <span className="home__title-line">{t('home.title.line2')}</span>
            </h1>
            <p className="home__lede">{t('home.lede')}</p>
            <div className="home__actions">
              <button className="btn btn--lg" onClick={() => setNewOpen(true)}>
                <Plus size={15} />
                {t('home.btn.newDataset')}
              </button>
              <button className="btn btn--primary btn--lg" onClick={pickFile}>
                <FolderOpen size={15} />
                {t('home.btn.openFile')}
                <ArrowRight size={14} />
              </button>
            </div>
            <div className="home__formats">
              {FORMATS.map((f) => (
                <span key={f} className="badge badge--muted">
                  {f}
                </span>
              ))}
            </div>
          </div>

          <div className="home__right">
            {CAPABILITY_KEYS.map(({ icon: Icon, key }) => (
              <div key={key} className="capcard">
                <span className="capcard__icon">
                  <Icon size={18} strokeWidth={1.6} />
                </span>
                <div className="capcard__body">
                  <div className="capcard__title">{t(`home.cap.${key}.title`)}</div>
                  <div className="capcard__desc">{t(`home.cap.${key}.desc`)}</div>
                </div>
              </div>
            ))}
          </div>
        </section>

        {sessions.length > 0 && (
          <section className="home__recent">
            <div className="home__recent-head">
              <h2 className="section-title">{t('home.section.continue')}</h2>
              {sessions.length > 3 && (
                <button
                  className="btn btn--sm"
                  onClick={() => setShowAllRecent((v) => !v)}
                  aria-expanded={showAllRecent}
                >
                  {showAllRecent ? t('home.btn.collapse') : t('home.btn.showAll')}
                  <ChevronRight size={13} />
                </button>
              )}
            </div>
            <div className={`recent-row${showAllRecent ? ' recent-row--all' : ''}`}>
              {(showAllRecent ? sessions : sessions.slice(0, 3)).map((session) => (
                <div key={session.id} className="rcard">
                  <span
                    className={`rcard__icon${session.sourceMissing || !session.sourceIntact ? ' rcard__icon--warn' : ''}`}
                  >
                    {session.sourceMissing || !session.sourceIntact ? (
                      <AlertTriangle size={16} />
                    ) : (
                      <FileStack size={16} />
                    )}
                  </span>
                  <div className="rcard__main">
                    <div className="rcard__name truncate">{session.sourceName}</div>
                    <div className="rcard__path truncate" title={session.sourcePath}>
                      {session.sourcePath}
                    </div>
                  </div>
                  <div className="rcard__stats">
                    <div className="stat">
                      <span className="stat__value">{formatCount(session.recordCount)}</span>
                      <span className="stat__label">{t('home.stat.total')}</span>
                    </div>
                    <div className="stat">
                      <span className={`stat__value${session.confirmedCount ? ' stat__value--accent' : ''}`}>
                        {formatCount(session.confirmedCount)}
                      </span>
                      <span className="stat__label">{t('home.stat.confirmed')}</span>
                    </div>
                    <div className="stat">
                      <span className={`stat__value${session.modifiedCount ? ' stat__value--clay' : ''}`}>
                        {formatCount(session.modifiedCount)}
                      </span>
                      <span className="stat__label">{t('home.stat.modified')}</span>
                    </div>
                    {session.addedCount > 0 && (
                      <div className="stat">
                        <span className="stat__value stat__value--muted">
                          {formatCount(session.addedCount)}
                        </span>
                        <span className="stat__label">{t('home.stat.added')}</span>
                      </div>
                    )}
                    <div className="stat">
                      <span className="stat__value stat__value--muted">
                        {formatCount(session.deletedCount)}
                      </span>
                      <span className="stat__label">{t('home.stat.deleted')}</span>
                    </div>
                    <div className="stat">
                      <span className="stat__value stat__value--muted">
                        {relativeTime(session.updatedAt, t)}
                      </span>
                      <span className="stat__label">{t('home.stat.updated')}</span>
                    </div>
                  </div>
                  <div className="rcard__actions">
                    <button className="btn btn--sm" onClick={() => resume(session)}>
                      <Play size={12} />
                      {t('home.btn.resume')}
                    </button>
                    <button
                      className="iconbtn"
                      title={t('home.btn.forget')}
                      onClick={() => forgetSession(session.id)}
                      aria-label={t('home.btn.forget')}
                    >
                      <Trash2 size={14} />
                    </button>
                  </div>
                </div>
              ))}
            </div>
            {sessions.some((s) => s.sourceMissing || !s.sourceIntact) && (
              <p className="home__recent-warn">{t('home.recent.warn')}</p>
            )}
          </section>
        )}
      </div>

      {newOpen && <NewDatasetDialog onClose={() => setNewOpen(false)} />}
    </div>
  )
}
