import { useEffect, useMemo, useRef, useState } from 'react'
import { useVirtualizer } from '@tanstack/react-virtual'
import { CheckSquare, ListChecks, Plus, Search, Square, Undo2, X } from 'lucide-react'
import { pickSummary, formatCount } from '../lib/text'
import { useT, useLocale } from '../i18n'
import { useStore } from '../state/store'
import { useVisibleIndices } from '../state/visible'
import { recordStatus } from '@shared/patch'
import type { FilterMode } from '@shared/types'
import ConfirmDialog from './ConfirmDialog'

const ROW_HEIGHT = 68
const FILTER_MODES: FilterMode[] = ['all', 'pending', 'confirmed', 'unmodified', 'deleted']

export default function RecordList() {
  const t = useT()
  const locale = useLocale()
  const records = useStore((s) => s.records)
  const edits = useStore((s) => s.edits)
  const deleted = useStore((s) => s.deleted)
  const confirmed = useStore((s) => s.confirmed)
  const view = useStore((s) => s.view)
  const selectRecord = useStore((s) => s.selectRecord)
  const setQuery = useStore((s) => s.setQuery)
  const setFilter = useStore((s) => s.setFilter)
  const setScrollTop = useStore((s) => s.setScrollTop)
  const toggleMultiSelect = useStore((s) => s.toggleMultiSelect)
  const toggleSelected = useStore((s) => s.toggleSelected)
  const clearSelected = useStore((s) => s.clearSelected)
  const confirmMany = useStore((s) => s.confirmMany)
  const restoreRecord = useStore((s) => s.restoreRecord)
  const openNewRecord = useStore((s) => s.openNewRecord)

  const [askBatch, setAskBatch] = useState(false)
  const parentRef = useRef<HTMLDivElement>(null)
  const visible = useVisibleIndices()
  const multiSelect = view.multiSelect === true
  const selected = useMemo(() => new Set(view.selectedIds), [view.selectedIds])

  const virtualizer = useVirtualizer({
    count: visible.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => ROW_HEIGHT,
    overscan: 10
  })

  // 首次进入时恢复上次的滚动位置 / 选中项
  const restored = useRef(false)
  useEffect(() => {
    if (restored.current || visible.length === 0) return
    restored.current = true
    if (view.scrollTop > 0) {
      virtualizer.scrollToOffset(view.scrollTop)
      return
    }
    const position = visible.indexOf(view.selectedIndex)
    if (position >= 0) virtualizer.scrollToIndex(position, { align: 'center' })
  }, [visible, view.scrollTop, view.selectedIndex, virtualizer])

  // 已删除的要排除：confirmMany 内部就会跳过它们，数进去会让这个数字骗人
  // （在「已删除」页签下 N 等于全部条数，点了却一条都不会确认）
  const pendingInView = visible.filter((i) => !confirmed.has(i) && !deleted.has(i)).length

  return (
    <aside className="sidebar">
      <div className="sidebar__head">
        <div className="search">
          <span className="search__icon">
            <Search size={13} />
          </span>
          <input
            className="input"
            placeholder={t('recordlist.search')}
            value={view.query}
            onChange={(e) => setQuery(e.target.value)}
            spellCheck={false}
          />
          {view.query && (
            <button className="search__clear" onClick={() => setQuery('')} aria-label={t('recordlist.clear')}>
              <X size={12} />
            </button>
          )}
        </div>
        <div className="filters">
          {FILTER_MODES.map((mode) => (
            <button
              key={mode}
              className={`filter-tab${view.filter === mode ? ' filter-tab--on' : ''}`}
              onClick={() => setFilter(mode)}
            >
              {t(`filter.${mode}`)}
            </button>
          ))}
        </div>
        <div className="sidebar__meta">
          <span>
            {t('recordlist.shown')} <b className="num">{formatCount(visible.length, locale)}</b> /{' '}
            {formatCount(records.length, locale)} {t('statusbar.records')}
          </span>
          <span className="sidebar__meta-actions">
            <button
              className={`iconbtn${multiSelect ? ' iconbtn--on' : ''}`}
              onClick={toggleMultiSelect}
              title={multiSelect ? t('recordlist.multiSelect.on') : t('recordlist.multiSelect.off')}
              aria-label={multiSelect ? t('recordlist.multiSelect.on') : t('recordlist.multiSelect.off')}
            >
              {/* lucide 的 Square 在 24 viewBox 里只占 18/24，同 size 下空心方框的视觉体量
                  天生小于多笔画图标，所以要比同行的 ListChecks 大 2px 才显得一样大；
                  描边相应降到 1.75，放大但不加粗。 */}
              {multiSelect ? (
                <CheckSquare size={15} strokeWidth={1.75} />
              ) : (
                <Square size={15} strokeWidth={1.75} />
              )}
            </button>
            <button
              className="linkbtn"
              disabled={pendingInView === 0}
              onClick={() => setAskBatch(true)}
              title="把当前列表里未确认、且未被删除的记录一次性标记为已确认"
            >
              <ListChecks size={13} />
              {t('recordlist.confirmCurrent', { n: formatCount(pendingInView, locale) })}
            </button>
          </span>
        </div>
      </div>

      <div
        className="reclist"
        ref={parentRef}
        onScroll={(e) => setScrollTop((e.target as HTMLDivElement).scrollTop)}
      >
        {visible.length === 0 ? (
          <div className="empty" style={{ padding: 'var(--sp-8)' }}>
            <span>{t('recordlist.noMatch')}</span>
          </div>
        ) : (
          <div className="reclist__inner" style={{ height: `${virtualizer.getTotalSize()}px` }}>
            {virtualizer.getVirtualItems().map((item) => {
              const index = visible[item.index]
              const record = records[index]
              if (!record) return null
              const entry = edits[record.id]
              const changeCount = entry ? Object.keys(entry).length : 0
              const status = recordStatus(
                record.index,
                record.origin === 'new',
                edits,
                deleted,
                confirmed
              )
              const isSelected = selected.has(record.id)
              const isDeleted = status === 'deleted'
              return (
                // 用 div 而不是 button：已删除的行里要放一个「还原」按钮，
                // 而按钮不能嵌套按钮（浏览器会把内层的拆出去，DOM 结构直接烂掉）。
                // 代价是键盘可达性要自己补：role + tabIndex + Enter/Space。
                <div
                  key={record.id}
                  role="button"
                  tabIndex={0}
                  className={[
                    'recitem',
                    view.selectedIndex === index ? 'recitem--active' : '',
                    `recitem--${status}`,
                    multiSelect ? 'recitem--picking' : '',
                    multiSelect && isSelected ? 'recitem--picked' : ''
                  ]
                    .filter(Boolean)
                    .join(' ')}
                  style={{
                    height: `${item.size}px`,
                    transform: `translateY(${item.start}px)`
                  }}
                  onClick={() => (multiSelect ? toggleSelected(record.id) : selectRecord(index))}
                  onKeyDown={(e) => {
                    if (e.key !== 'Enter' && e.key !== ' ') return
                    e.preventDefault()
                    if (multiSelect) toggleSelected(record.id)
                    else selectRecord(index)
                  }}
                >
                  {/* 行首是一个宽度恒定的槽：色带贴行左边缘、勾选框常驻在槽内。
                      进出多选只切 visibility，槽宽不变 —— 序号和标题的横坐标一个像素都不会动。
                      ⚠️ 别改回条件渲染（{multiSelect && ...}），那会让槽宽在 3px / 15px 之间跳，
                      标题跟着左右抖。显隐靠 .recitem--picking 驱动，见 app.css。 */}
                  <span className="recitem__lead">
                    <span className="recitem__bar" />
                    <span className="recitem__check" aria-hidden>
                      {isSelected ? (
                        <CheckSquare size={12} strokeWidth={1.5} />
                      ) : (
                        <Square size={12} strokeWidth={1.5} />
                      )}
                    </span>
                  </span>
                  <span className="recitem__idx num">{formatCount(record.index + 1, locale)}</span>
                  <span className="recitem__body">
                    <span className="recitem__title">{pickSummary(record.data, t)}</span>
                    <span className="recitem__meta">
                      {status === 'new' && (
                        <span className="tag tag--new">
                          {t('record.newTag')}
                          {changeCount > 0 ? ` · ${t('record.changes', { n: changeCount })}` : ''}
                        </span>
                      )}
                      {status === 'confirmed' && (
                        <span className="tag tag--confirmed">
                          {t('record.confirmedTag')}
                          {changeCount > 0 ? ` · ${t('record.modified')}` : ''}
                        </span>
                      )}
                      {status === 'pending' && (
                        <span className="num">{t('record.changes', { n: changeCount })}</span>
                      )}
                      {isDeleted && <span style={{ color: 'var(--danger)' }}>{t('record.excluded')}</span>}
                      {status === 'unmodified' && <span>{t('record.unmodified')}</span>}
                    </span>
                  </span>
                  {isDeleted && !multiSelect && (
                    <button
                      className="recitem__restore"
                      title={t('record.restore.title')}
                      aria-label={t('record.restoreAria', { n: record.index + 1 })}
                      onClick={(e) => {
                        // 行本身是个大点击区，不拦住会顺带把选中项也切了
                        e.stopPropagation()
                        restoreRecord(record.index)
                      }}
                    >
                      <Undo2 size={12} />
                      {t('record.restore')}
                    </button>
                  )}
                </div>
              )
            })}
          </div>
        )}
      </div>

      {multiSelect ? (
        <div className="pickbar">
          <span>
            {t('recordlist.selected', { n: formatCount(selected.size, locale) })}
          </span>
          <span className="pickbar__actions">
            <button
              className="btn btn--ghost btn--sm"
              onClick={() =>
                confirmMany([...selected].map(Number).filter((n) => Number.isFinite(n)))
              }
              disabled={selected.size === 0}
            >
              {t('recordlist.confirmSelected')}
            </button>
            <button className="btn btn--ghost btn--sm" onClick={clearSelected} disabled={selected.size === 0}>
              {t('recordlist.clearSel')}
            </button>
            <button className="btn btn--ghost btn--sm" onClick={toggleMultiSelect}>
              {t('recordlist.exit')}
            </button>
          </span>
        </div>
      ) : (
        <button className="reclist__append" onClick={() => openNewRecord(null)}>
          <Plus size={13} />
          {t('recordlist.append')}
        </button>
      )}

      {askBatch && (
        <ConfirmDialog
          title={t('recordlist.batch.title')}
          confirmLabel={t('recordlist.batch.confirm')}
          onClose={() => setAskBatch(false)}
          onConfirm={() => {
            confirmMany(visible)
            setAskBatch(false)
          }}
        >
          <p>
            {t('recordlist.batch.desc', { n: formatCount(pendingInView, locale) })}
          </p>
          <p className="muted">{t('recordlist.batch.note')}</p>
        </ConfirmDialog>
      )}
    </aside>
  )
}
