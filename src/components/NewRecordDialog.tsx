import { useMemo, useState } from 'react'
import { ArrowDown, ArrowUp, Braces, Plus, Trash2, Wrench } from 'lucide-react'
import Modal from './Modal'
import { useStore } from '../state/store'
import { useT } from '../i18n'
import { blankValue, newTemplateId, templateGroups, templateToData } from '@shared/templates'
import { BUILTIN_TEMPLATES } from '@shared/types'
import type { Json, RecordTemplate, TemplateFieldKind } from '@shared/types'

/** 对话类字段的表单模式只给一个输入框（填第一轮的内容），进去再细化。 */
function formSeed(field: RecordTemplate['fields'][number], text: string): Json {
  if (field.kind === 'messages') {
    const contentKey = field.contentKey ?? 'content'
    const skeleton = blankValue(field) as Array<Record<string, Json>>
    if (skeleton.length > 0) skeleton[0][contentKey] = text
    return skeleton as Json
  }
  if (field.kind === 'json') {
    try {
      return JSON.parse(text || '{}') as Json
    } catch {
      return {} as Json
    }
  }
  return text
}

/**
 * 新增一条记录。
 * 三个入口共用：列表底部「新增到末尾」、编辑器头部「新建一条」、列表项 hover 的「+」。
 * 模板决定字段骨架，不决定数据内容 —— 新建的记录一律是空的，由用户填。
 */
export default function NewRecordDialog() {
  const t = useT()
  const close = useStore((s) => s.closeNewRecord)
  const at = useStore((s) => s.newRecordAt)
  const addRecord = useStore((s) => s.addRecord)
  const records = useStore((s) => s.records)
  const fields = useStore((s) => s.fields)
  const settings = useStore((s) => s.settings)
  const saveTemplates = useStore((s) => s.saveTemplates)
  const toast = useStore((s) => s.toast)

  const kindLabel: Record<TemplateFieldKind, string> = {
    text: t('template.kind.text'),
    messages: t('template.kind.messages'),
    json: t('template.kind.json')
  }

  const custom = settings?.recordTemplates ?? []

  const datasetFields: RecordTemplate['fields'] = fields.map((f) => ({
    name: f.name,
    kind: f.kind.type === 'messages' ? 'messages' : f.kind.type === 'json' ? 'json' : 'text',
    // 数据集里如果用的是 from / value 这类键名，新建的记录要跟着用，别写成 role / content
    ...(f.kind.type === 'messages' ? { roleKey: f.kind.roleKey, contentKey: f.kind.contentKey } : {})
  }))
  const datasetTemplate: RecordTemplate = { id: '__dataset__', name: t('newrecord.followDataset'), fields: datasetFields }

  const options = useMemo(
    () => (datasetFields.length > 0 ? [datasetTemplate, ...templateGroups(custom).flatMap((g) => g.items)] : templateGroups(custom).flatMap((g) => g.items)),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [custom, fields]
  )
  const [templateId, setTemplateId] = useState(options[0]?.id ?? 'blank')
  const template = options.find((t2) => t2.id === templateId) ?? options[0]

  const [jsonMode, setJsonMode] = useState(false)
  const [draft, setDraft] = useState(() => JSON.stringify(templateToData(template?.fields ?? []), null, 2))
  const [values, setValues] = useState<Record<string, string>>(() => ({}))
  // null 表示不在编辑模板；对象则是正在编辑的那份草稿（id 为空串 = 新建）
  const [editing, setEditing] = useState<RecordTemplate | null>(null)

  const pick = (id: string) => {
    setTemplateId(id)
    const next = options.find((t2) => t2.id === id)
    const data = templateToData(next?.fields ?? [])
    setDraft(JSON.stringify(data, null, 2))
    setValues({})
  }

  const saveEditing = () => {
    if (!editing) return
    const name = editing.name.trim()
    if (!name) {
      toast(t('newrecord.toast.nameRequired'), 'error')
      return
    }
    const cleaned: RecordTemplate = {
      ...editing,
      name,
      fields: editing.fields
        .map((f) => ({ ...f, name: f.name.trim() }))
        .filter((f) => f.name.length > 0)
    }
    if (cleaned.fields.length === 0) {
      toast(t('newrecord.toast.needField'), 'error')
      return
    }
    const rest = custom.filter((tpl) => tpl.id !== cleaned.id)
    // id 要保证唯一：裸 Date.now() 在同一毫秒内连建两个模板会撞车，
    // 下拉里就会出现两个看起来一样、删掉一个另一个也跟着没的模板。
    const stored: RecordTemplate = { ...cleaned, id: cleaned.id || newTemplateId(custom) }
    saveTemplates([...rest, stored])
    setEditing(null)
    setTemplateId(stored.id)
    setDraft(JSON.stringify(templateToData(stored.fields), null, 2))
    setValues({})
    toast(t('newrecord.toast.saved', { name: stored.name }), 'success')
  }

  const submit = () => {
    if (jsonMode) {
      let parsed: unknown
      try {
        parsed = JSON.parse(draft)
      } catch (err) {
        toast(t('newrecord.toast.jsonInvalid', { detail: (err as Error).message }), 'error')
        return
      }
      if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
        toast(t('newrecord.toast.mustBeObject'), 'error')
        return
      }
      addRecord(parsed as Record<string, Json>, at ?? records.length)
      close()
      return
    }

    const data: Record<string, Json> = templateToData(template?.fields ?? [])
    for (const [name, text] of Object.entries(values)) {
      if (!(name in data)) continue
      const field = template?.fields.find((f) => f.name === name)
      if (!field) continue
      if (field.kind === 'json' && text.trim() !== '') {
        try {
          JSON.parse(text)
        } catch {
          toast(t('newrecord.toast.fieldJsonInvalid', { name }), 'error')
          return
        }
      }
      data[name] = formSeed(field, text)
    }
    addRecord(data, at ?? records.length)
    close()
  }

  return (
    <Modal
      title={t('newrecord.title')}
      subtitle={at === null ? t('newrecord.subtitleEnd') : t('newrecord.subtitleAt', { n: at + 1 })}
      onClose={close}
      footer={
        <>
          <span className="muted" style={{ fontSize: 'var(--fs-caption)' }}>
            {t('newrecord.note')}
          </span>
          <span style={{ flex: 1 }} />
          <button className="btn" onClick={close}>
            {t('dialog.cancel')}
          </button>
          <button className="btn btn--primary" onClick={submit}>
            <Plus size={12} />
            {t('newrecord.add')}
          </button>
        </>
      }
    >
      <div className="form-grid">
        <span className="form-grid__label">{t('newrecord.template')}</span>
        <div className="form-row">
          <select className="select" value={templateId} onChange={(e) => pick(e.target.value)}>
            {datasetFields.length > 0 && (
              <option value="__dataset__">
                {datasetTemplate.name}
                {` · ${datasetFields.map((f) => f.name).join(' / ')}`}
              </option>
            )}
            {templateGroups(custom).map((group) => (
              <optgroup key={group.id} label={t(`template.group.${group.id}`)}>
                {group.items.map((tpl) => (
                  <option key={tpl.id} value={tpl.id}>
                    {tpl.name}
                    {tpl.fields.length > 0 ? ` · ${tpl.fields.map((f) => f.name).join(' / ')}` : ''}
                  </option>
                ))}
              </optgroup>
            ))}
          </select>
          <button
            className="btn btn--sm"
            onClick={() => {
              setJsonMode((v) => !v)
              if (!jsonMode) setDraft(JSON.stringify(templateToData(template?.fields ?? []), null, 2))
            }}
            title={t('newrecord.jsonMode')}
          >
            <Braces size={11} />
            {jsonMode ? t('newrecord.formMode') : t('newrecord.jsonMode')}
          </button>
          <span style={{ flex: 1 }} />
          {template && template.id !== '__dataset__' && !template.builtin && (
            <>
              <button
                className="btn btn--sm"
                onClick={() => setEditing({ ...template })}
                title={t('newrecord.editTemplate')}
              >
                <Wrench size={11} />
                {t('newrecord.editTemplate')}
              </button>
              <button
                className="btn btn--sm btn--danger"
                onClick={() => {
                  saveTemplates(custom.filter((tpl) => tpl.id !== template.id))
                  // 必须显式落到内置模板的第一项：options 是本次渲染的旧闭包，
                  // 里面还留着刚删掉的那个，pick(options[0]) 会选中一个已经不存在的 id，
                  // 重渲染后静默掉回「空白」。
                  const fallback = BUILTIN_TEMPLATES[0]
                  setTemplateId(fallback.id)
                  setDraft(JSON.stringify(templateToData(fallback.fields), null, 2))
                  setValues({})
                }}
                title={t('newrecord.deleteTemplate')}
              >
                <Trash2 size={11} />
                {t('newrecord.deleteTemplate')}
              </button>
            </>
          )}
          <button
            className="btn btn--sm"
            onClick={() =>
              setEditing({
                id: '',
                name: '我的模板',
                fields: [{ name: 'instruction', kind: 'text' }]
              })
            }
            title={t('newrecord.newTemplate')}
          >
            <Plus size={11} />
            {t('newrecord.newTemplate')}
          </button>
        </div>
      </div>

      {editing && (
        <div className="tpledit">
          <div className="tpledit__row">
            <input
              className="input"
              value={editing.name}
              placeholder={t('newrecord.templateName')}
              onChange={(e) => setEditing({ ...editing, name: e.target.value })}
              spellCheck={false}
            />
            <span style={{ flex: 1 }} />
            <button className="btn btn--sm" onClick={() => setEditing(null)}>
              {t('dialog.cancel')}
            </button>
            <button className="btn btn--sm btn--primary" onClick={saveEditing}>
              {t('newrecord.saveTemplate')}
            </button>
          </div>
          <div className="tpledit__list">
            {editing.fields.map((field, i) => (
              <div className="tpledit__field" key={`${i}-${field.name}`}>
                <input
                  className="input mono"
                  value={field.name}
                  placeholder={t('newrecord.fieldName')}
                  onChange={(e) =>
                    setEditing({
                      ...editing,
                      fields: editing.fields.map((f, j) => (j === i ? { ...f, name: e.target.value } : f))
                    })
                  }
                  spellCheck={false}
                />
                <select
                  className="select"
                  value={field.kind}
                  onChange={(e) =>
                    setEditing({
                      ...editing,
                      fields: editing.fields.map((f, j) =>
                        j === i ? { ...f, kind: e.target.value as TemplateFieldKind } : f
                      )
                    })
                  }
                >
                  <option value="text">{t('template.kind.text')}</option>
                  <option value="messages">{t('template.kind.messages')}</option>
                  <option value="json">{t('template.kind.json')}</option>
                </select>
                <input
                  className="input"
                  value={field.default === undefined ? '' : String(field.default)}
                  placeholder={t('newrecord.defaultValue')}
                  onChange={(e) =>
                    setEditing({
                      ...editing,
                      fields: editing.fields.map((f, j) =>
                        j === i ? { ...f, default: e.target.value === '' ? undefined : e.target.value } : f
                      )
                    })
                  }
                  spellCheck={false}
                />
                <button
                  className="iconbtn"
                  title={t('newrecord.moveUp')}
                  disabled={i === 0}
                  onClick={() => {
                    const next = [...editing.fields]
                    ;[next[i - 1], next[i]] = [next[i], next[i - 1]]
                    setEditing({ ...editing, fields: next })
                  }}
                >
                  <ArrowUp size={12} />
                </button>
                <button
                  className="iconbtn"
                  title={t('newrecord.moveDown')}
                  disabled={i === editing.fields.length - 1}
                  onClick={() => {
                    const next = [...editing.fields]
                    ;[next[i + 1], next[i]] = [next[i], next[i + 1]]
                    setEditing({ ...editing, fields: next })
                  }}
                >
                  <ArrowDown size={12} />
                </button>
                <button
                  className="iconbtn"
                  title={t('newrecord.delField')}
                  onClick={() => setEditing({ ...editing, fields: editing.fields.filter((_, j) => j !== i) })}
                >
                  <Trash2 size={12} />
                </button>
              </div>
            ))}
          </div>
          <button
            className="btn btn--sm"
            onClick={() =>
              setEditing({ ...editing, fields: [...editing.fields, { name: '', kind: 'text' }] })
            }
          >
            <Plus size={11} />
            {t('newrecord.addField')}
          </button>
        </div>
      )}

      {jsonMode ? (
        <div style={{ marginTop: 'var(--sp-4)' }}>
          <textarea
            className="textarea mono"
            rows={12}
            value={draft}
            spellCheck={false}
            onChange={(e) => setDraft(e.target.value)}
          />
        </div>
      ) : (
        <div className="newrec__fields">
          {(template?.fields ?? []).length === 0 ? (
            <p className="muted">{t('newrecord.blankNote')}</p>
          ) : (
            (template?.fields ?? []).map((field) => (
              <label className="newrec__field" key={field.name}>
                <span className="newrec__field-name">
                  {field.name}
                  <span className="newrec__field-kind">{kindLabel[field.kind]}</span>
                </span>
                <textarea
                  className="textarea"
                  rows={field.kind === 'text' ? 3 : 4}
                  placeholder={
                    field.kind === 'json'
                      ? t('newrecord.jsonPlaceholder')
                      : field.kind === 'messages'
                        ? t('newrecord.messagesPlaceholder')
                        : t('newrecord.emptyPlaceholder')
                  }
                  value={
                    values[field.name] ??
                    (field.default !== undefined
                      ? typeof field.default === 'string'
                        ? field.default
                        : JSON.stringify(field.default)
                      : '')
                  }
                  spellCheck={false}
                  onChange={(e) => setValues((prev) => ({ ...prev, [field.name]: e.target.value }))}
                />
              </label>
            ))
          )}
        </div>
      )}
    </Modal>
  )
}
