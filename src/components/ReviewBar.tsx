import { ArrowDown, ArrowUp, CheckCheck } from 'lucide-react'
import { useT, useLocale } from '../i18n'
import { formatCount } from '../lib/text'
import { useStore } from '../state/store'

interface Props {
  recordIndex: number
  /** 当前队列 = 左侧列表的可见记录。切筛选 / 搜索，队列就跟着变。 */
  queue: number[]
  /** 当前记录在队列里的位置，-1 表示不在队列中。 */
  queuePosition: number
  /** 队列来源页签名，让「走到哪了」有上下文。 */
  locked: boolean
  /** 当前记录是否被标记删除。已删除的不进确认流程，只能前进或恢复。 */
  deleted?: boolean
}

/**
 * 顺序流水线：常驻在编辑区底部，把「确认 + 下一条」合成一次操作。
 * 左栏负责随机访问，这里负责顺序推进 —— 校对本来就是一条条往下走的动作。
 */
export default function ReviewBar({
  recordIndex,
  queue,
  queuePosition,
  locked,
  deleted = false
}: Props) {
  const t = useT()
  const locale = useLocale()
  const selectRecord = useStore((s) => s.selectRecord)
  const confirmRecord = useStore((s) => s.confirmRecord)
  const confirmed = useStore((s) => s.confirmed)
  const view = useStore((s) => s.view)
  const toast = useStore((s) => s.toast)

  const inQueue = queuePosition >= 0
  const position = inQueue ? queuePosition + 1 : 0
  const total = queue.length
  const atEnd = inQueue && queuePosition >= total - 1
  const atStart = inQueue && queuePosition <= 0
  const isConfirmed = confirmed.has(recordIndex)

  const step = (delta: number) => {
    if (!inQueue) return
    const next = queue[queuePosition + delta]
    if (next === undefined) return
    selectRecord(next)
  }

  const confirmAndNext = () => {
    if (!inQueue) return
    if (isConfirmed || deleted) {
      step(1)
      return
    }
    confirmRecord(recordIndex)
    const next = queue[queuePosition + 1]
    if (next === undefined) {
      toast(t('review.endToast'), 'success')
      return
    }
    selectRecord(next)
  }

  const label = view.query.trim()
    ? t('review.searchLabel', { query: view.query.trim() })
    : t(`filter.${view.filter}`)

  const confirmTitle = deleted
    ? t('review.confirmTitle.deleted')
    : locked
      ? t('review.confirmTitle.locked')
      : t('review.confirmTitle.default')

  return (
    <div className="reviewbar">
      <div className="reviewbar__nav">
        <button
          className="iconbtn"
          onClick={() => step(-1)}
          disabled={!inQueue || atStart}
          title={t('review.prev')}
          aria-label={t('review.prev')}
        >
          <ArrowUp size={14} />
        </button>
        <button
          className="iconbtn"
          onClick={() => step(1)}
          disabled={!inQueue || atEnd}
          title={t('review.next')}
          aria-label={t('review.next')}
        >
          <ArrowDown size={14} />
        </button>
      </div>

      <div className="reviewbar__pos">
        {inQueue ? (
          <>
            <b className="num">{formatCount(position, locale)}</b>
            <span className="reviewbar__sep">/</span>
            <span className="num">{formatCount(total, locale)}</span>
            <span className="reviewbar__queue">
              {t('review.queue', { label })}
              {atEnd && ` · ${t('review.atEnd')}`}
            </span>
          </>
        ) : (
          <span className="reviewbar__queue">{t('review.endQueue')}</span>
        )}
      </div>

      <div className="reviewbar__actions">
        <button
          className="btn btn--sm btn--ghost reviewbar__skip"
          onClick={() => step(1)}
          disabled={!inQueue || atEnd}
          title={t('review.skip')}
        >
          {t('review.skip')}
        </button>
        <button className="btn btn--sm btn--primary" onClick={confirmAndNext} disabled={!inQueue} title={confirmTitle}>
          <CheckCheck size={12} />
          {isConfirmed || deleted ? t('review.next') : t('review.confirmNext')}
        </button>
      </div>
    </div>
  )
}
