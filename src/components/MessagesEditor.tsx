import { Plus, Trash2 } from 'lucide-react'
import AutoTextarea from './AutoTextarea'
import JsonEditor from './JsonEditor'
import { deepEqual, pathKey } from '@shared/jsonpath'
import { normalizeRole } from '@shared/inspect'
import { useT } from '../i18n'
import { useStore } from '../state/store'
import type { FieldInfo } from '@shared/inspect'
import type { DataRecord, Json } from '@shared/types'

interface Props {
  record: DataRecord
  field: FieldInfo & { kind: Extract<FieldInfo['kind'], { type: 'messages' }> }
  modifiedKeys: Set<string>
  original: Record<string, Json> | null
  readOnly?: boolean
}

const STANDARD_ROLES = ['system', 'user', 'assistant', 'tool']

export default function MessagesEditor({ record, field, modifiedKeys, original, readOnly }: Props) {
  const t = useT()
  const editValue = useStore((s) => s.editValue)
  const setMessages = useStore((s) => s.setMessages)

  const { name, kind } = field
  const messages = Array.isArray(record.data[name]) ? (record.data[name] as Json[]) : []
  const originalMessages = Array.isArray(original?.[name]) ? (original?.[name] as Json[]) : null

  const roleOptions = Array.from(new Set([...kind.roles, ...STANDARD_ROLES])).filter(Boolean)
  // 新增一轮时默认用「这个数据集自己已在用的角色」，而不是硬编码 user ——
  // ShareGPT 风格的数据集里 from 的取值是 human / gpt，塞一个 user 进去会写出一个陌生角色。
  const defaultRole = kind.roles.find((r) => r && r !== 'system') ?? kind.roles[0] ?? 'user'

  const arrayReplaced = modifiedKeys.has(pathKey([name]))

  const replaceArray = (next: Json[], label: string) => setMessages(record.id, name, next, label)

  return (
    <div className="msgs">
      {messages.map((item, i) => {
        const obj = (item && typeof item === 'object' && !Array.isArray(item) ? item : {}) as Record<string, Json>
        const role = typeof obj[kind.roleKey] === 'string' ? String(obj[kind.roleKey]) : ''
        const content = obj[kind.contentKey]
        const originalItem = originalMessages?.[i]
        const modified = arrayReplaced
          ? !deepEqual(item, originalItem)
          : modifiedKeys.has(pathKey([name, i, kind.contentKey])) ||
            modifiedKeys.has(pathKey([name, i, kind.roleKey]))
        const originalContent =
          originalItem && typeof originalItem === 'object' && !Array.isArray(originalItem)
            ? (originalItem as Record<string, Json>)[kind.contentKey]
            : undefined

        return (
          <div
            key={`${record.id}-${name}-${i}`}
            className={`msg msg--${normalizeRole(role)}${modified ? ' msg--modified' : ''}`}
          >
            <span className="msg__band" />
            <div className="msg__body">
              <div className="msg__head">
                <select
                  className="select select--role"
                  value={role}
                  disabled={readOnly}
                  onChange={(e) => editValue(record.id, [name, i, kind.roleKey], e.target.value)}
                  aria-label={t('messages.role')}
                >
                  {!roleOptions.includes(role) && <option value={role}>{role || t('messages.emptyRole')}</option>}
                  {roleOptions.map((option) => (
                    <option key={option} value={option}>
                      {option}
                    </option>
                  ))}
                </select>
                <span className="msg__idx mono">#{i + 1}</span>
                <button
                  className="iconbtn"
                  title={readOnly ? t('messages.readOnly') : t('messages.deleteTurn')}
                  aria-label={t('messages.deleteTurn')}
                  disabled={readOnly}
                  onClick={() => replaceArray(messages.filter((_, j) => j !== i), t('messages.delTurn'))}
                >
                  <Trash2 size={13} />
                </button>
              </div>

              {typeof content === 'string' ? (
                <AutoTextarea
                  value={content}
                  placeholder={t('messages.contentPlaceholder')}
                  onCommit={(next) => editValue(record.id, [name, i, kind.contentKey], next)}
                  readOnly={readOnly}
                />
              ) : (
                <JsonEditor
                  value={content ?? null}
                  onCommit={(next) => editValue(record.id, [name, i, kind.contentKey], next)}
                  readOnly={readOnly}
                />
              )}

              {modified && originalContent !== undefined && originalContent !== content && (
                <div className="field__orig">
                  <span className="field__orig-label">{t('field.origLabel')}</span>
                  {typeof originalContent === 'string' ? originalContent : JSON.stringify(originalContent, null, 2)}
                </div>
              )}
            </div>
          </div>
        )
      })}

      <button
        className="btn btn--sm"
        style={{ alignSelf: 'flex-start' }}
        disabled={readOnly}
        title={readOnly ? t('messages.readOnly') : undefined}
        onClick={() => {
          const next = [
            ...messages,
            { [kind.roleKey]: defaultRole, [kind.contentKey]: '' } as unknown as Json
          ]
          replaceArray(next, t('messages.addTurnLabel'))
        }}
      >
        <Plus size={12} />
        {t('messages.addTurn')}
      </button>
    </div>
  )
}
