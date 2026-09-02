import { useState } from 'react'
import { FolderOpen, Plus } from 'lucide-react'
import Modal from './Modal'
import { api } from '../lib/api'
import { useStore } from '../state/store'
import { useT } from '../i18n'
import { templateGroups } from '@shared/templates'
import { BUILTIN_TEMPLATES } from '@shared/types'
import type { RecordTemplate } from '@shared/types'

const EXT_BY_FORMAT = { jsonl: 'jsonl', json: 'json', csv: 'csv', tsv: 'tsv', yaml: 'yaml' } as const
type NewFormat = keyof typeof EXT_BY_FORMAT

/**
 * 新建一个空的数据集文件。
 * 和「新增记录」共用同一套字段模板，但这里模板只决定 CSV 表头 —— 新文件一律不含任何记录。
 */
export default function NewDatasetDialog({ onClose }: { onClose: () => void }) {
  const t = useT()
  const createDataset = useStore((s) => s.createDataset)
  const settings = useStore((s) => s.settings)
  const templates = [...BUILTIN_TEMPLATES, ...(settings?.recordTemplates ?? [])]

  const [name, setName] = useState(() => t('dataset.untitled'))
  const [format, setFormat] = useState<NewFormat>('jsonl')
  const [templateId, setTemplateId] = useState('alpaca')
  const [busy, setBusy] = useState(false)

  const groups = templateGroups(settings?.recordTemplates ?? [])
  const template: RecordTemplate =
    templates.find((tpl) => tpl.id === templateId) ?? BUILTIN_TEMPLATES[0]

  const fieldList =
    template.fields.length > 0
      ? template.fields.map((f) => f.name).join(t('dataset.fieldSep'))
      : t('dataset.emptyFields')

  const submit = async () => {
    const suggested = `${name.trim() || t('dataset.untitled')}.${EXT_BY_FORMAT[format]}`
    const destPath = await api.saveNewDatasetDialog(suggested)
    if (!destPath) return
    setBusy(true)
    try {
      await createDataset(destPath, template)
      onClose()
    } catch {
      // 失败原因已经在 store 里 toast 出来了
    } finally {
      setBusy(false)
    }
  }

  return (
    <Modal
      title={t('dataset.title')}
      subtitle={t('dataset.subtitle')}
      onClose={onClose}
      footer={
        <>
          <span className="muted" style={{ fontSize: 'var(--fs-caption)' }}>
            {t('dataset.footerNote')}
          </span>
          <span style={{ flex: 1 }} />
          <button className="btn" onClick={onClose}>
            {t('dialog.cancel')}
          </button>
          <button className="btn btn--primary" onClick={() => void submit()} disabled={busy}>
            <Plus size={12} />
            {busy ? t('dataset.creating') : t('dataset.create')}
          </button>
        </>
      }
    >
      <div className="form-grid">
        <label className="form-grid__label" htmlFor="nd-name">
          {t('dataset.name')}
        </label>
        <input
          id="nd-name"
          className="input"
          value={name}
          onChange={(e) => setName(e.target.value)}
          spellCheck={false}
        />

        <label className="form-grid__label" htmlFor="nd-format">
          {t('dataset.format')}
        </label>
        <div>
          <select
            id="nd-format"
            className="select"
            value={format}
            onChange={(e) => setFormat(e.target.value as NewFormat)}
          >
            <option value="jsonl">{t('dataset.format.jsonl')}</option>
            <option value="json">{t('dataset.format.json')}</option>
            <option value="csv">{t('dataset.format.csv')}</option>
            <option value="tsv">{t('dataset.format.tsv')}</option>
            <option value="yaml">{t('dataset.format.yaml')}</option>
          </select>
          <p className="muted" style={{ margin: 'var(--sp-2) 0 0', fontSize: 'var(--fs-caption)' }}>
            {t(`dataset.format.${format}.hint`)}
          </p>
        </div>

        <label className="form-grid__label" htmlFor="nd-template">
          {t('dataset.template')}
        </label>
        <div>
          <select
            id="nd-template"
            className="select"
            value={templateId}
            onChange={(e) => setTemplateId(e.target.value)}
          >
            {groups.map((group) => (
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
          <p className="muted" style={{ margin: 'var(--sp-2) 0 0', fontSize: 'var(--fs-caption)' }}>
            {format === 'csv' || format === 'tsv'
              ? t('dataset.headerNote', { fields: fieldList })
              : t('dataset.skeletonNote', { fields: fieldList })}
          </p>
        </div>
      </div>

      <div className="newds__preview">
        <span className="newds__preview-icon">
          <FolderOpen size={14} />
        </span>
        <span>
          {name.trim() || t('dataset.untitled')}.{EXT_BY_FORMAT[format]}
        </span>
      </div>
    </Modal>
  )
}
