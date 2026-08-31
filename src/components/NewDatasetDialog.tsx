import { useState } from 'react'
import { FolderOpen, Plus } from 'lucide-react'
import Modal from './Modal'
import { api } from '../lib/api'
import { useStore } from '../state/store'
import { templateGroups } from '@shared/templates'
import { BUILTIN_TEMPLATES } from '@shared/types'
import type { RecordTemplate } from '@shared/types'

const EXT_BY_FORMAT = { jsonl: 'jsonl', json: 'json', csv: 'csv', tsv: 'tsv', yaml: 'yaml' } as const
type NewFormat = keyof typeof EXT_BY_FORMAT

const FORMAT_HINT: Record<NewFormat, string> = {
  jsonl: '一行一条，训练脚本最常用。空文件即可。',
  json: '整体一个数组，初始内容写成 []。',
  csv: '表格格式，初始内容只写表头（含 BOM，Excel 打开不乱码）。',
  tsv: '制表符分隔，初始内容只写表头。',
  yaml: '初始内容写成 []。'
}

/**
 * 新建一个空的数据集文件。
 * 和「新增记录」共用同一套字段模板，但这里模板只决定 CSV 表头 —— 新文件一律不含任何记录。
 */
export default function NewDatasetDialog({ onClose }: { onClose: () => void }) {
  const createDataset = useStore((s) => s.createDataset)
  const settings = useStore((s) => s.settings)
  const templates = [...BUILTIN_TEMPLATES, ...(settings?.recordTemplates ?? [])]

  const [name, setName] = useState('未命名数据集')
  const [format, setFormat] = useState<NewFormat>('jsonl')
  const [templateId, setTemplateId] = useState('alpaca')
  const [busy, setBusy] = useState(false)

  const groups = templateGroups(settings?.recordTemplates ?? [])
  const template: RecordTemplate =
    templates.find((t) => t.id === templateId) ?? BUILTIN_TEMPLATES[0]

  const submit = async () => {
    const suggested = `${name.trim() || '未命名数据集'}.${EXT_BY_FORMAT[format]}`
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
      title="新建数据集"
      subtitle="先建一个空文件，进去之后用「新增记录」一条条填"
      onClose={onClose}
      footer={
        <>
          <span className="muted" style={{ fontSize: 'var(--fs-caption)' }}>
            已有同名文件时会被拒绝 —— CorpusEditor 从不覆盖已存在的文件。
          </span>
          <span style={{ flex: 1 }} />
          <button className="btn" onClick={onClose}>
            取消
          </button>
          <button className="btn btn--primary" onClick={() => void submit()} disabled={busy}>
            <Plus size={12} />
            {busy ? '创建中…' : '选择位置并创建'}
          </button>
        </>
      }
    >
      <div className="form-grid">
        <label className="form-grid__label" htmlFor="nd-name">
          名称
        </label>
        <input
          id="nd-name"
          className="input"
          value={name}
          onChange={(e) => setName(e.target.value)}
          spellCheck={false}
        />

        <label className="form-grid__label" htmlFor="nd-format">
          格式
        </label>
        <div>
          <select
            id="nd-format"
            className="select"
            value={format}
            onChange={(e) => setFormat(e.target.value as NewFormat)}
          >
            <option value="jsonl">JSONL</option>
            <option value="json">JSON 数组</option>
            <option value="csv">CSV</option>
            <option value="tsv">TSV</option>
            <option value="yaml">YAML</option>
          </select>
          <p className="muted" style={{ margin: 'var(--sp-2) 0 0', fontSize: 'var(--fs-caption)' }}>
            {FORMAT_HINT[format]}
          </p>
        </div>

        <label className="form-grid__label" htmlFor="nd-template">
          字段模板
        </label>
        <div>
          <select
            id="nd-template"
            className="select"
            value={templateId}
            onChange={(e) => setTemplateId(e.target.value)}
          >
            {groups.map((group) => (
              <optgroup key={group.label} label={group.label}>
                {group.items.map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.name}
                    {t.fields.length > 0 ? ` · ${t.fields.map((f) => f.name).join(' / ')}` : ''}
                  </option>
                ))}
              </optgroup>
            ))}
          </select>
          <p className="muted" style={{ margin: 'var(--sp-2) 0 0', fontSize: 'var(--fs-caption)' }}>
            {format === 'csv' || format === 'tsv'
              ? `表头将写为：${template.fields.map((f) => f.name).join('、') || '（空）'}`
              : `决定「新增记录」时出现的字段骨架（${template.fields.map((f) => f.name).join(' / ') || '空'}），不会往文件里预置任何记录。`}
          </p>
        </div>
      </div>

      <div className="newds__preview">
        <span className="newds__preview-icon">
          <FolderOpen size={14} />
        </span>
        <span>
          {name.trim() || '未命名数据集'}.{EXT_BY_FORMAT[format]}
        </span>
      </div>
    </Modal>
  )
}
