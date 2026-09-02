import { useEffect, useRef, useState } from 'react'
import { Braces, CheckCheck, RotateCcw, Trash2, Undo2 } from 'lucide-react'
import FieldCard from './FieldCard'
import JsonEditor from './JsonEditor'
import ReviewBar from './ReviewBar'
import { getOriginalRecord, peekOriginalRecord } from '../state/originals'
import { useStore } from '../state/store'
import { useVisibleIndices } from '../state/visible'
import { useT } from '../i18n'
import { recordStatus } from '@shared/patch'
import type { Json } from '@shared/types'

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
  const t = useT()
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
        <div className="empty">{t('record.notFound')}</div>
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
              {isNew && <span className="badge badge--new">{t('record.newTag')}</span>}
              {status === 'confirmed' && <span className="badge badge--accent">{t('record.confirmedTag')}</span>}
              {status === 'pending' && <span className="badge badge--clay">{t('record.pendingBadge', { n: changeCount })}</span>}
              {status === 'unmodified' && <span className="badge badge--muted">{t('record.unmodified')}</span>}
              {isDeleted && <span className="badge badge--danger">{t('record.deletedBadge')}</span>}
            </div>
            <span className="record-head__spacer" />
            <div className="record-head__actions">
              {/* 已删除的记录不参与确认：它连导出都进不去。这里只留「恢复」一条路。 */}
              {isDeleted ? null : locked ? (
                <button
                  className="btn btn--sm"
                  onClick={() => unconfirmRecord(record.index)}
                  title={t('record.unconfirmTitle')}
                >
                  <RotateCcw size={11} />
                  {t('record.unconfirmBtn')}
                </button>
              ) : (
                <button
                  className="btn btn--sm btn--primary"
                  onClick={() => confirmRecord(record.index)}
                  title={t('record.confirmTitle')}
                >
                  <CheckCheck size={11} />
                  {t('record.confirmBtn')}
                </button>
              )}
              {changeCount > 0 && !locked && (
                <button
                  className="btn btn--sm"
                  onClick={() => void revertRecord(record.id)}
                  disabled={isNew}
                  title={isNew ? t('record.newRevertHint') : t('record.revertOriginal')}
                >
                  <RotateCcw size={11} />
                  {t('record.revertAll')}
                </button>
              )}
              {isDeleted ? (
                <button className="btn btn--sm" onClick={() => restoreRecord(record.index)}>
                  <Undo2 size={11} />
                  {t('record.restore')}
                </button>
              ) : (
                <button className="btn btn--sm btn--danger" onClick={() => deleteRecord(record.index)}>
                  <Trash2 size={11} />
                  {t('record.deleteBtn')}
                </button>
              )}
            </div>
          </div>

          {locked && (
            <div className="locknote">
              <CheckCheck size={12} />
              {t('record.locked')}
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
              revertDisabledReason={isNew ? t('record.newRevertHint') : null}
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
  const t = useT()
  const setRecordData = useStore((s) => s.setRecordData)
  const toast = useStore((s) => s.toast)
  const [open, setOpen] = useState(false)

  return (
    <section className="field">
      <header className="field__head">
        <span className="field__name">{t('record.fullJson')}</span>
        <span className="field__kind">{t('record.rawView')}</span>
        <span className="field__spacer" />
        <button className="btn btn--sm" onClick={() => setOpen((v) => !v)}>
          <Braces size={11} />
          {open ? t('record.collapse') : t('record.expand')}
        </button>
      </header>
      {open && (
        <div className="field__body">
          <JsonEditor
            value={data as Json}
            readOnly={readOnly}
            onCommit={(next) => {
              if (next === null || typeof next !== 'object' || Array.isArray(next)) {
                toast(t('newrecord.toast.mustBeObject'), 'error')
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
