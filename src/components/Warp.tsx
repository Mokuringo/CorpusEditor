import { useMemo } from 'react'
import { useStore } from '../state/store'
import { formatCount } from '../lib/text'
import { useT, useLocale } from '../i18n'

const MAX_BUCKETS = 168

/**
 * 经线刻度：一排细竖线代表数据集，每一段的高度与颜色是它当前的状态。
 * 三层高度递减形成层次 —— 已确认最高（苔绿实心）、待确认居中（陶土）、已删除最低（danger），
 * 未动过的只有一条底线。这是本产品最独特的视觉元素，也是全局进度的状态地图。
 */
export default function Warp() {
  const t = useT()
  const locale = useLocale()
  const records = useStore((s) => s.records)
  const edits = useStore((s) => s.edits)
  const deleted = useStore((s) => s.deleted)
  const confirmed = useStore((s) => s.confirmed)
  const selectedIndex = useStore((s) => s.view.selectedIndex)

  const total = records.length

  const { buckets, peak, selectedBucket } = useMemo(() => {
    const n = Math.max(16, Math.min(MAX_BUCKETS, total || 16))
    const pending = new Float64Array(n)
    const done = new Float64Array(n)
    const removed = new Float64Array(n)
    let max = 0

    const bucketOf = (index: number) =>
      Math.min(n - 1, Math.floor((index / Math.max(1, total)) * n))

    for (const id of Object.keys(edits)) {
      const index = Number(id)
      if (!Number.isFinite(index)) continue
      if (confirmed.has(index)) continue // 已确认的改动不再算作「待处理」
      const bucket = bucketOf(index)
      pending[bucket] += 1
      if (pending[bucket] > max) max = pending[bucket]
    }
    for (const index of confirmed) {
      const bucket = bucketOf(index)
      done[bucket] += 1
      if (done[bucket] > max) max = done[bucket]
    }
    for (const index of deleted) removed[bucketOf(index)] += 1

    return {
      buckets: Array.from({ length: n }, (_, i) => ({
        pending: pending[i],
        done: done[i],
        removed: removed[i],
        weight: pending[i] + done[i]
      })),
      peak: Math.max(1, max),
      selectedBucket: Math.min(n - 1, Math.floor((selectedIndex / Math.max(1, total)) * n))
    }
  }, [total, edits, deleted, confirmed, selectedIndex])

  const modifiedCount = Object.keys(edits).length

  return (
    <div className="warp" title={t('warp.title')}>
      <div className="warp__bar">
        {buckets.map((bucket, i) => {
          const isSelected = i === selectedBucket
          const ratio = bucket.weight > 0 ? Math.min(1, bucket.weight / peak) : 0
          const height = bucket.weight > 0 ? 5 + Math.round(ratio * 15) : 3
          const tone = bucket.removed > 0
            ? 'removed'
            : bucket.done > 0
              ? 'done'
              : bucket.pending > 0
                ? 'pending'
                : ''
          return (
            <span
              key={i}
              className={`warp__tick${tone ? ` warp__tick--${tone}` : ''}${
                isSelected ? ' warp__tick--view' : ''
              }`}
              style={{ height: `${isSelected ? 20 : height}px` }}
            />
          )
        })}
      </div>
      <div className="warp__legend">
        {confirmed.size > 0 && (
          <span>
            {t('home.stat.confirmed')} <b className="num">{formatCount(confirmed.size, locale)}</b>
          </span>
        )}
        <span>
          {t('warp.pending')} <b className="num">{formatCount(modifiedCount, locale)}</b>
        </span>
        <span>
          {t('warp.total')} <b className="num">{formatCount(total, locale)}</b> {t('statusbar.records')}
        </span>
        {deleted.size > 0 && (
          <span>
            {t('home.stat.deleted')} <b className="num">{formatCount(deleted.size, locale)}</b>
          </span>
        )}
      </div>
    </div>
  )
}
