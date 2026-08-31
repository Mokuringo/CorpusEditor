import { useEffect, useRef, useState } from 'react'
import { Braces, CheckCheck, RotateCcw, Trash2, Undo2 } from 'lucide-react'
import FieldCard from './FieldCard'
import JsonEditor from './JsonEditor'
import ReviewBar from './ReviewBar'
import { getOriginalRecord, peekOriginalRecord } from '../state/originals'
import { useStore } from '../state/store'
import { useVisibleIndices } from '../state/visible'
import { recordStatus } from '@shared/patch'
import type { Json } from '@shared/types'

/** 新建记录的还原入口要禁用，并在 tooltip 里写清原因 —— 不给用户一个猜不出为什么点不动的灰按钮。 */
const NEW_RECORD_REVERT_HINT = '新建的记录没有原始值可以还原'

function useOriginalRecord(sessionId: string, recordId: string): Record<string, Json> | null {
  const [original, setOriginal] = useState<Record<string, Json> | null>(() =>
    sessionId && recordId ? peekOriginalRecord(sessionId, recordId) : null
  )
  useEffect(() => {
    if (!sessionId || !recordId) {
      setOriginal(null)
      return
    }
    let alive = true
    const cached = peekOriginalRecord(sessionId, recordId)
    setOriginal(cached)
    if (!cached) {
      void getOriginalRecord(sessionId, recordId).then((data) => {
        if (alive) setOriginal(data)
      })
    }
    return () => {
      alive = false
    }
  }, [sessionId, recordId])
  return original
}

export default function RecordEditor() {
  const dataset = useStore((s) => s.dataset)
  const records = useStore((s) => s.records)
  const fields = useStore((s) => s.fields)
  const view = useStore((s) => s.view)
  const edits = useStore((s) => s.edits)
  const deleted = useStore((s) => s.deleted)
  const confirmed = useStore((s) => s.confirmed)
  const revertRecord = useStore((s) => s.revertRecord)
  const deleteRecord = useStore((s) => s.deleteRecord)
  const restoreRecord = useStore((s) => s.restoreRecord)
  const confirmRecord = useStore((s) => s.confirmRecord)
  const unconfirmRecord = useStore((s) => s.unconfirmRecord)
  const scrollRef = useRef<HTMLDivElement>(null)
  const visible = useVisibleIndices()

  const index = Math.max(0, Math.min(view.selectedIndex, Math.max(0, records.length - 1)))
  const record = records[index] ?? null
  const original = useOriginalRecord(dataset?.id ?? '', record?.id ?? '')

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: 0 })
  }, [record?.id])

  if (!dataset) return null
  if (!record) {
    return (
      <div className="editor">
        <div className="empty">这条记录不存在</div>
      </div>
    )
  }

  const entry = edits[record.id]
  const modifiedKeys = new Set(Object.keys(entry ?? {}))
  const changeCount = modifiedKeys.size
  const isNew = record.origin === 'new'
  const status = recordStatus(record.index, isNew, edits, deleted, confirmed)
  const isDeleted = status === 'deleted'
  // 已确认 = 锁定：界面上不能改数据，要改先点「退回修改」
  const locked = status === 'confirmed'
  const queuePosition = visible.indexOf(record.index)

  return (
    <div className="editor">
      <div className="editor__scroll" ref={scrollRef}>
        <div className="editor__inner">
          <div className="record-head">
            <span className="record-head__index">#{record.index + 1}</span>
            <div className="record-head__badges">
              {isNew && <span className="badge badge--new">新建</span>}
              {status === 'confirmed' && <span className="badge badge--accent">已确认</span>}
              {status === 'pending' && <span className="badge badge--clay">{changeCount} 处改动 · 待确认</span>}
              {status === 'unmodified' && <span className="badge badge--muted">未修改</span>}
              {isDeleted && <span className="badge badge--danger">已删除 · 导出时排除</span>}
            </div>
            <span className="record-head__spacer" />
            <div className="record-head__actions">
              {/* 已删除的记录不参与确认：它连导出都进不去。这里只留「恢复」一条路。 */}
              {isDeleted ? null : locked ? (
                <button
                  className="btn btn--sm"
                  onClick={() => unconfirmRecord(record.index)}
                  title="退回待确认后就可以继续编辑"
                >
                  <RotateCcw size={11} />
                  退回修改
                </button>
              ) : (
                <button
                  className="btn btn--sm btn--primary"
                  onClick={() => confirmRecord(record.index)}
                  title="标记为已确认：看过并定稿，之后不能再改"
                >
                  <CheckCheck size={11} />
                  确认
                </button>
              )}
              {changeCount > 0 && !locked && (
                <button
                  className="btn btn--sm"
                  onClick={() => void revertRecord(record.id)}
                  disabled={isNew}
                  title={isNew ? NEW_RECORD_REVERT_HINT : '还原为原始内容'}
                >
                  <RotateCcw size={11} />
                  还原整条
                </button>
              )}
              {isDeleted ? (
                <button className="btn btn--sm" onClick={() => restoreRecord(record.index)}>
                  <Undo2 size={11} />
                  恢复
                </button>
              ) : (
                <button className="btn btn--sm btn--danger" onClick={() => deleteRecord(record.index)}>
                  <Trash2 size={11} />
                  删除这条
                </button>
              )}
            </div>
          </div>

          {locked && (
            <div className="locknote">
              <CheckCheck size={12} />
              这条已确认，内容已锁定。要改请先点「退回修改」，改动后需要重新确认。
            </div>
          )}

          {fields.map((field) => (
            <FieldCard
              key={field.name}
              record={record}
              field={field}
              modifiedKeys={modifiedKeys}
              original={original}
              readOnly={locked}
              revertDisabledReason={isNew ? NEW_RECORD_REVERT_HINT : null}
            />
          ))}

          <RawRecordEditor recordId={record.id} data={record.data} readOnly={locked} />
        </div>
      </div>

      <ReviewBar
        recordIndex={record.index}
        queue={visible}
        queuePosition={queuePosition}
        locked={locked}
        deleted={isDeleted}
      />
    </div>
  )
}

function RawRecordEditor({
  recordId,
  data,
  readOnly
}: {
  recordId: string
  data: Record<string, Json>
  readOnly?: boolean
}) {
  const setRecordData = useStore((s) => s.setRecordData)
  const toast = useStore((s) => s.toast)
  const [open, setOpen] = useState(false)

  return (
    <section className="field">
      <header className="field__head">
        <span className="field__name">整条记录 · JSON</span>
        <span className="field__kind">原始视图</span>
        <span className="field__spacer" />
        <button className="btn btn--sm" onClick={() => setOpen((v) => !v)}>
          <Braces size={11} />
          {open ? '收起' : '展开'}
        </button>
      </header>
      {open && (
        <div className="field__body">
          <JsonEditor
            value={data as Json}
            readOnly={readOnly}
            onCommit={(next) => {
              if (next === null || typeof next !== 'object' || Array.isArray(next)) {
                toast('整条记录必须是一个 JSON 对象', 'error')
                return
              }
              setRecordData(recordId, next as Record<string, Json>)
            }}
          />
        </div>
      )}
    </section>
  )
}
