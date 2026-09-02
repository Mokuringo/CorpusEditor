import { useMemo } from 'react'
import { computeVisibleIndices } from './search'
import { t } from '../i18n'
import { useStore } from './store'
import type { Store } from './store'

/**
 * 当前可见记录的下标序列 —— 列表、替换范围、流水线队列共用这一份。
 * 之所以做成 hook 而不是让每个组件各算一遍：流水线要跟着筛选 / 搜索实时变，
 * 三处各算一次既浪费又容易算出不一样的结果。
 */
export function useVisibleIndices(): number[] {
  const records = useStore((s) => s.records)
  const edits = useStore((s) => s.edits)
  const deleted = useStore((s) => s.deleted)
  const confirmed = useStore((s) => s.confirmed)
  const filter = useStore((s) => s.view.filter)
  const query = useStore((s) => s.view.query)

  return useMemo(
    () => computeVisibleIndices({ records, edits, deleted, confirmed, filter, query }),
    [records, edits, deleted, confirmed, filter, query]
  )
}

function queueOf(state: Store): number[] {
  return computeVisibleIndices({
    records: state.records,
    edits: state.edits,
    deleted: state.deleted,
    confirmed: state.confirmed,
    filter: state.view.filter,
    query: state.view.query
  })
}

/** 快捷键用的一次性读取：不订阅、不触发重渲染，按下时才算一遍。 */
export function stepQueue(delta: number): void {
  const state = useStore.getState()
  const queue = queueOf(state)
  const at = queue.indexOf(state.view.selectedIndex)
  if (at < 0) return
  const next = queue[at + delta]
  if (next === undefined) return
  state.selectRecord(next)
}

/** 流水线的一步：确认当前条并前进。已经确认过就只前进。 */
export function confirmAndAdvance(): void {
  const state = useStore.getState()
  const queue = queueOf(state)
  const at = queue.indexOf(state.view.selectedIndex)
  if (at < 0) return
  if (!state.confirmed.has(state.view.selectedIndex)) state.confirmRecord(state.view.selectedIndex)
  const next = queue[at + 1]
  if (next === undefined) {
    state.toast(t('review.queueEnd'), 'success')
    return
  }
  state.selectRecord(next)
}
