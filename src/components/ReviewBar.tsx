import { ArrowDown, ArrowUp, CheckCheck } from 'lucide-react'
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

const FILTER_LABEL: Record<string, string> = {
  all: '全部',
  pending: '待确认',
  confirmed: '已确认',
  unmodified: '未修改',
  deleted: '已删除'
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
      toast('已到队列末尾，这条也已确认', 'success')
      return
    }
    selectRecord(next)
  }

  const label = view.query.trim()
    ? `搜索「${view.query.trim()}」`
    : (FILTER_LABEL[view.filter] ?? '全部')

  return (
    <div className="reviewbar">
      <div className="reviewbar__nav">
        <button
          className="iconbtn"
          onClick={() => step(-1)}
          disabled={!inQueue || atStart}
          title="上一条（Alt+↑）"
          aria-label="上一条"
        >
          <ArrowUp size={14} />
        </button>
        <button
          className="iconbtn"
          onClick={() => step(1)}
          disabled={!inQueue || atEnd}
          title="下一条（Alt+↓）"
          aria-label="下一条"
        >
          <ArrowDown size={14} />
        </button>
      </div>

      <div className="reviewbar__pos">
        {inQueue ? (
          <>
            <b className="num">{position.toLocaleString('zh-CN')}</b>
            <span className="reviewbar__sep">/</span>
            <span className="num">{total.toLocaleString('zh-CN')}</span>
            <span className="reviewbar__queue">
              队列：{label}
              {atEnd && ' · 已到末尾'}
            </span>
          </>
        ) : (
          <span className="reviewbar__queue">这条不在当前队列里</span>
        )}
      </div>

      <div className="reviewbar__actions">
        <button
          className="btn btn--sm btn--ghost reviewbar__skip"
          onClick={() => step(1)}
          disabled={!inQueue || atEnd}
          title="只前进，不改状态"
        >
          跳过
        </button>
        <button
          className="btn btn--sm btn--primary"
          onClick={confirmAndNext}
          disabled={!inQueue}
          title={
            deleted
              ? '已删除的记录不需要确认 · 前进到下一条（Ctrl+Enter）'
              : locked
                ? '已确认 · 前进到下一条（Ctrl+Enter）'
                : '确认并前进到下一条（Ctrl+Enter）'
          }
        >
          <CheckCheck size={12} />
          {isConfirmed || deleted ? '下一条' : '确认并下一条'}
        </button>
      </div>
    </div>
  )
}
