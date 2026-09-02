import { useEffect, useRef, useState } from 'react'
import { RotateCcw } from 'lucide-react'
import AutoTextarea from './AutoTextarea'
import JsonEditor from './JsonEditor'
import MessagesEditor from './MessagesEditor'
import PairsEditor from './PairsEditor'
import { deepEqual, getAtPath, parsePathKey, pathKey } from '@shared/jsonpath'
import { useT } from '../i18n'
import { useStore } from '../state/store'
import type { FieldInfo } from '@shared/inspect'
import type { DataRecord, Json } from '@shared/types'
import type { TFunc } from '@shared/locales'

interface Props {
  record: DataRecord
  field: FieldInfo
  modifiedKeys: Set<string>
  original: Record<string, Json> | null
  /** 已确认的记录只读；想改要先点头部的「退回修改」。 */
  readOnly?: boolean
  /** 新建记录没有原始值，还原入口要禁用并说明原因。 */
  revertDisabledReason?: string | null
}

const fieldKind = (t: TFunc): Record<FieldInfo['kind']['type'], string> => ({
  messages: t('field.kind.messages'),
  pairs: t('field.kind.pairs'),
  text: t('field.kind.text'),
  number: t('field.kind.number'),
  boolean: t('field.kind.boolean'),
  json: t('field.kind.json'),
  empty: t('field.kind.empty')
})

export default function FieldCard({
  record,
  field,
  modifiedKeys,
  original,
  readOnly,
  revertDisabledReason
}: Props) {
  const t = useT()
  const revertField = useStore((s) => s.revertField)
  const editValue = useStore((s) => s.editValue)
  const { name, kind } = field

  const fieldKey = pathKey([name])
  const anyModified = [...modifiedKeys].some((key) => parsePathKey(key)[0] === name)
  const selfModified = modifiedKeys.has(fieldKey)
  const originalValue = original ? getAtPath(original, [name]) : undefined
  const revertTitle = revertDisabledReason ?? (readOnly ? t('field.revert.locked') : t('field.revert.title'))

  return (
    <section className={`field${anyModified ? ' field--modified' : ''}${readOnly ? ' field--locked' : ''}`}>
      <header className="field__head">
        <span className="field__name">{name}</span>
        <span className="field__kind">{fieldKind(t)[kind.type]}</span>
        <span className="field__spacer" />
        <div className="field__tools">
          {anyModified && (
            <button
              className="btn btn--sm"
              onClick={() => void revertField(record.id, [name])}
              disabled={readOnly || Boolean(revertDisabledReason)}
              title={revertTitle}
            >
              <RotateCcw size={11} />
              {t('field.revert')}
            </button>
          )}
        </div>
      </header>

      <div className="field__body">
        {kind.type === 'messages' && (
          <MessagesEditor
            record={record}
            field={{ name, kind }}
            modifiedKeys={modifiedKeys}
            original={original}
            readOnly={readOnly}
          />
        )}

        {kind.type === 'pairs' && (
          <PairsEditor
            record={record}
            field={{ name, kind }}
            modifiedKeys={modifiedKeys}
            original={original}
            readOnly={readOnly}
          />
        )}

        {kind.type === 'text' && (
          <AutoTextarea
            value={typeof record.data[name] === 'string' ? (record.data[name] as string) : ''}
            onCommit={(next) => editValue(record.id, [name], next)}
            placeholder={t('field.placeholder.empty')}
            readOnly={readOnly}
          />
        )}

        {kind.type === 'empty' && (
          <AutoTextarea
            value={typeof record.data[name] === 'string' ? (record.data[name] as string) : ''}
            onCommit={(next) => editValue(record.id, [name], next)}
            placeholder={t('field.placeholder.emptyField')}
            readOnly={readOnly}
          />
        )}

        {kind.type === 'number' && (
          <NumberInput
            value={typeof record.data[name] === 'number' ? (record.data[name] as number) : 0}
            onCommit={(next) => editValue(record.id, [name], next)}
            readOnly={readOnly}
          />
        )}

        {kind.type === 'boolean' && (
          <select
            className="select"
            style={{ maxWidth: 160 }}
            value={record.data[name] === true ? 'true' : 'false'}
            disabled={readOnly}
            onChange={(e) => editValue(record.id, [name], e.target.value === 'true')}
          >
            <option value="true">true</option>
            <option value="false">false</option>
          </select>
        )}

        {kind.type === 'json' && (
          <JsonEditor
            value={(record.data[name] ?? null) as Json}
            onCommit={(next) => editValue(record.id, [name], next)}
            readOnly={readOnly}
          />
        )}

        {/* messages / pairs 都会自己逐轮渲染「原值」，这里再整块比一次只会重复显示 */}
        {selfModified &&
          kind.type !== 'messages' &&
          kind.type !== 'pairs' &&
          originalValue !== undefined &&
          !deepEqual(originalValue, record.data[name]) && (
            <div className="field__orig">
              <span className="field__orig-label">{t('field.origLabel')}</span>
              {typeof originalValue === 'string' ? originalValue : JSON.stringify(originalValue, null, 2)}
            </div>
          )}
      </div>
    </section>
  )
}

function NumberInput({
  value,
  onCommit,
  readOnly
}: {
  value: number
  onCommit: (next: number) => void
  readOnly?: boolean
}) {
  const [draft, setDraft] = useState(String(value))
  const valueRef = useRef(value)
  const draftRef = useRef(draft)
  const commitRef = useRef(onCommit)

  valueRef.current = value
  draftRef.current = draft
  commitRef.current = onCommit

  useEffect(() => {
    setDraft(String(value))
  }, [value])

  useEffect(
    () => () => {
      flush(draftRef.current)
    },
    []
  )

  function flush(text: string) {
    const parsed = Number(text)
    if (Number.isFinite(parsed) && parsed !== valueRef.current) commitRef.current(parsed)
  }

  return (
    <input
      className="input mono"
      style={{ maxWidth: 220 }}
      value={draft}
      inputMode="decimal"
      readOnly={readOnly}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={() => flush(draft)}
    />
  )
}
