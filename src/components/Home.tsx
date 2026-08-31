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
import { PRODUCT_TITLE } from '../lib/product'
import { formatCount, relativeTime } from '../lib/text'
import { useStore } from '../state/store'
import type { SessionSummary } from '@shared/types'

const FORMATS = ['JSONL', 'JSON', 'CSV', 'TSV', 'YAML', 'Parquet', 'TXT']

const CAPABILITIES = [
  { icon: Lock, title: '只读打开', desc: '支持 7 种格式，原文件全程只读，绝不写回' },
  { icon: PencilLine, title: '逐条编辑', desc: '字段、对话轮次、整条 JSON 都能改' },
  { icon: Replace, title: '全局替换', desc: '全库 / 按字段 / 按对话角色定向替换' },
  { icon: Plus, title: '新增记录', desc: '在任意位置插入新样本，或从空白建数据集' },
  { icon: History, title: '进度恢复', desc: '异常退出不丢，重开接着上次的那一屏' },
  { icon: Download, title: '安全导出', desc: '另存为 JSONL / JSON / CSV / Parquet，跳过废样本' }
] as const

export default function Home() {
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
      toast('源文件已不在原位置，请重新选择该文件以恢复进度。', 'error')
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
              <span className="label">{PRODUCT_TITLE}</span>
            </div>
            {/* 断点写死在结构里：靠 max-width 碰运气会在第 8 个字后断成「创建和修改指令微 / 调数据」 */}
            <h1 className="home__title">
              <span className="home__title-line">创建和修改</span>
              <span className="home__title-line">指令微调数据</span>
            </h1>
            <p className="home__lede">
              为指令微调（SFT / DPO）数据集提供逐条校订与批量替换能力，支持 JSONL、JSON、CSV、TSV、
              YAML、Parquet、TXT 七种格式。全部改动保存于独立工作区，源文件保持只读，进度可中断恢复。
            </p>
            <div className="home__actions">
              <button className="btn btn--lg" onClick={() => setNewOpen(true)}>
                <Plus size={15} />
                新建数据集
              </button>
              <button className="btn btn--primary btn--lg" onClick={pickFile}>
                <FolderOpen size={15} />
                打开数据文件
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
            {CAPABILITIES.map(({ icon: Icon, title, desc }) => (
              <div key={title} className="capcard">
                <span className="capcard__icon">
                  <Icon size={18} strokeWidth={1.6} />
                </span>
                <div className="capcard__body">
                  <div className="capcard__title">{title}</div>
                  <div className="capcard__desc">{desc}</div>
                </div>
              </div>
            ))}
          </div>
        </section>

        {sessions.length > 0 && (
          <section className="home__recent">
            <div className="home__recent-head">
              <h2 className="section-title">继续上次</h2>
              {sessions.length > 3 && (
                <button
                  className="btn btn--sm"
                  onClick={() => setShowAllRecent((v) => !v)}
                  aria-expanded={showAllRecent}
                >
                  {showAllRecent ? '收起' : '查看全部'}
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
                      <span className="stat__label">总条数</span>
                    </div>
                    <div className="stat">
                      <span className={`stat__value${session.confirmedCount ? ' stat__value--accent' : ''}`}>
                        {formatCount(session.confirmedCount)}
                      </span>
                      <span className="stat__label">已确认</span>
                    </div>
                    <div className="stat">
                      <span className={`stat__value${session.modifiedCount ? ' stat__value--clay' : ''}`}>
                        {formatCount(session.modifiedCount)}
                      </span>
                      <span className="stat__label">已改</span>
                    </div>
                    {session.addedCount > 0 && (
                      <div className="stat">
                        <span className="stat__value stat__value--muted">
                          {formatCount(session.addedCount)}
                        </span>
                        <span className="stat__label">新建</span>
                      </div>
                    )}
                    <div className="stat">
                      <span className="stat__value stat__value--muted">
                        {formatCount(session.deletedCount)}
                      </span>
                      <span className="stat__label">已删</span>
                    </div>
                    <div className="stat">
                      <span className="stat__value stat__value--muted">{relativeTime(session.updatedAt)}</span>
                      <span className="stat__label">更新</span>
                    </div>
                  </div>
                  <div className="rcard__actions">
                    <button className="btn btn--sm" onClick={() => resume(session)}>
                      <Play size={12} />
                      继续
                    </button>
                    <button
                      className="iconbtn"
                      title="丢弃这份进度"
                      onClick={() => forgetSession(session.id)}
                      aria-label="丢弃这份进度"
                    >
                      <Trash2 size={14} />
                    </button>
                  </div>
                </div>
              ))}
            </div>
            {sessions.some((s) => s.sourceMissing || !s.sourceIntact) && (
              <p className="home__recent-warn">
                带警示图标的条目表示源文件已被改动或移动，继续时会尽力套用已保存的改动。
              </p>
            )}
          </section>
        )}
      </div>

      {newOpen && <NewDatasetDialog onClose={() => setNewOpen(false)} />}
    </div>
  )
}
