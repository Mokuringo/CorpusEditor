import { useEffect, useMemo, useState } from 'react'
import { ArrowDown, ArrowUp, ExternalLink, GripVertical, Plus, RotateCcw, X } from 'lucide-react'
import Modal from './Modal'
import { api } from '../lib/api'
import { formatBytes, formatCount } from '../lib/text'
import { buildDefaultExportConfig, useStore } from '../state/store'
import {
  collectAvailablePaths,
  defaultPathLabel,
  makeColumnId,
  suggestedExtension,
  validateExportConfig,
  INDEX_COLUMN
} from '@shared/serialize'
import { pathKey } from '@shared/jsonpath'
import { recordStatus } from '@shared/patch'
import type { ExportColumn, ExportFormat, ExportScope, Path } from '@shared/types'

const FORMATS: Array<{ value: ExportFormat; label: string; hint: string }> = [
  { value: 'jsonl', label: 'JSONL', hint: '一行一条，训练脚本最常用' },
  { value: 'json', label: 'JSON 数组', hint: '整体一个数组' },
  { value: 'csv', label: 'CSV', hint: '表格，嵌套结构会转成字符串' },
  { value: 'parquet', label: 'Parquet', hint: '列式存储，嵌套结构会转成字符串' }
]

const SCOPES: Array<{ value: ExportScope; label: string }> = [
  { value: 'all', label: '全部记录' },
  { value: 'modified', label: '仅已修改' },
  { value: 'confirmed', label: '仅已确认' },
  { value: 'filtered', label: '当前筛选结果' }
]

export default function ExportDialog() {
  const open = useStore((s) => s.exportOpen)
  const close = useStore((s) => s.closeExport)
  const dataset = useStore((s) => s.dataset)
  const records = useStore((s) => s.records)
  const edits = useStore((s) => s.edits)
  const deleted = useStore((s) => s.deleted)
  const confirmed = useStore((s) => s.confirmed)
  const view = useStore((s) => s.view)
  const stored = useStore((s) => s.exportConfig)
  const saveExportConfig = useStore((s) => s.saveExportConfig)
  const runExport = useStore((s) => s.runExport)
  const toast = useStore((s) => s.toast)

  const [config, setConfig] = useState(() => stored ?? buildDefaultExportConfig(dataset?.fieldOrder ?? []))
  const [picking, setPicking] = useState<string | null>(null)
  const [dragId, setDragId] = useState<string | null>(null)
  const [overId, setOverId] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState<{ path: string; count: number; bytes: number } | null>(null)

  useEffect(() => {
    if (open) {
      setConfig(stored ?? buildDefaultExportConfig(dataset?.fieldOrder ?? []))
      setResult(null)
      setPicking(null)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])

  const pathOptions = useMemo(() => (open ? collectAvailablePaths(records) : []), [open, records])

  const confirmedCount = confirmed.size
  const modifiedCount = Object.keys(edits).length
  const filteredCount = useMemo(() => {
    const query = view.query.trim().toLowerCase()
    let n = 0
    for (const record of records) {
      if (deleted.has(record.index)) continue
      const status = recordStatus(record.index, false, edits, deleted, confirmed)
      if (view.filter === 'pending' && status !== 'pending') continue
      if (view.filter === 'confirmed' && status !== 'confirmed') continue
      if (view.filter === 'unmodified' && status !== 'unmodified') continue
      if (query && !JSON.stringify(record.data).toLowerCase().includes(query)) continue
      n++
    }
    return n
  }, [records, edits, deleted, confirmed, view.filter, view.query])

  const scopeCount =
    config.scope === 'modified'
      ? modifiedCount
      : config.scope === 'confirmed'
        ? confirmedCount
        : config.scope === 'filtered'
          ? filteredCount
          : records.length - deleted.size

  if (!open || !dataset) return null

  const patch = (next: Partial<typeof config>) => setConfig((prev) => ({ ...prev, ...next }))

  const validation = validateExportConfig(config)

  const setColumns = (columns: ExportColumn[]) => patch({ columns })

  const updateColumn = (id: string, next: Partial<ExportColumn>) =>
    setColumns(config.columns.map((c) => (c.id === id ? { ...c, ...next } : c)))

  const removeColumn = (id: string) => setColumns(config.columns.filter((c) => c.id !== id))

  const moveColumn = (id: string, delta: number) => {
    const index = config.columns.findIndex((c) => c.id === id)
    const target = index + delta
    if (index < 0 || target < 0 || target >= config.columns.length) return
    const next = [...config.columns]
    const [item] = next.splice(index, 1)
    next.splice(target, 0, item)
    setColumns(next)
  }

  const reorder = (fromId: string, toId: string) => {
    if (fromId === toId) return
    const next = [...config.columns]
    const from = next.findIndex((c) => c.id === fromId)
    if (from < 0) return
    const [item] = next.splice(from, 1)
    const to = next.findIndex((c) => c.id === toId)
    if (to < 0) next.push(item)
    else next.splice(to, 0, item)
    setColumns(next)
  }

  const addColumn = (path: Path | null = null) => {
    const column: ExportColumn = {
      id: makeColumnId(),
      label: path ? defaultPathLabel(path) : `新列 ${config.columns.length + 1}`,
      path,
      enabled: true
    }
    setColumns([...config.columns, column])
  }

  const resetColumns = () =>
    setColumns([
      ...(config.includeIndex
        ? [{ id: makeColumnId(), label: INDEX_COLUMN, path: null, enabled: true } as ExportColumn]
        : []),
      ...dataset.fieldOrder.map(
        (field) => ({ id: makeColumnId(), label: field, path: [field] as Path, enabled: true } as ExportColumn)
      )
    ])

  const toggleIndex = (enabled: boolean) => {
    const without = config.columns.filter((c) => c.label !== INDEX_COLUMN)
    patch({
      includeIndex: enabled,
      columns: enabled
        ? [{ id: makeColumnId(), label: INDEX_COLUMN, path: null, enabled: true }, ...without]
        : without
    })
  }

  const suggestPath = () => {
    const base = dataset.source.name.replace(/\.[^.]+$/, '')
    const ext = suggestedExtension(config.format)
    return `${dataset.source.path.replace(/[^\\/]+$/, '')}${base}.corpuseditor.${ext}`
  }

  const doExport = async () => {
    if (validation) {
      toast(validation, 'error')
      return
    }
    const destPath = await api.saveExportDialog(suggestPath(), config.format)
    if (!destPath) return
    setBusy(true)
    setResult(null)
    saveExportConfig(config)
    try {
      const outcome = await runExport(config, destPath, config.scope)
      if (outcome) {
        setResult({ path: outcome.destPath, count: outcome.recordCount, bytes: outcome.bytes })
        toast(`已导出 ${formatCount(outcome.recordCount)} 条到 ${outcome.destPath}`, 'success')
      }
    } finally {
      setBusy(false)
    }
  }

  const isFlat = config.format === 'csv' || config.format === 'parquet'

  return (
    <Modal
      wide
      title="导出数据"
      subtitle="改动会写入新文件，原文件保持只读不变"
      onClose={close}
      footer={
        <>
          <span style={{ fontSize: 'var(--fs-caption)', color: 'var(--text-muted)' }}>
            {validation ? validation : `将导出 ${formatCount(scopeCount)} 条记录、${config.columns.filter((c) => c.enabled).length} 列`}
          </span>
          <span style={{ flex: 1 }} />
          <button className="btn" onClick={close}>
            关闭
          </button>
          <button className="btn btn--primary" onClick={doExport} disabled={Boolean(validation) || busy}>
            {busy ? '正在导出…' : '选择路径并导出'}
          </button>
        </>
      }
    >
      <div className="form-grid">
        <span className="form-grid__label">格式</span>
        <div className="form-row">
          <div className="segmented">
            {FORMATS.map((f) => (
              <button
                key={f.value}
                className={`segmented__item${config.format === f.value ? ' segmented__item--on' : ''}`}
                onClick={() => patch({ format: f.value })}
                title={f.hint}
              >
                {f.label}
              </button>
            ))}
          </div>
          <span style={{ fontSize: 'var(--fs-caption)', color: 'var(--text-muted)' }}>
            {FORMATS.find((f) => f.value === config.format)?.hint}
          </span>
        </div>

        <span className="form-grid__label">范围</span>
        <div className="form-row">
          <div className="segmented">
            {SCOPES.map((s) => (
              <button
                key={s.value}
                className={`segmented__item${config.scope === s.value ? ' segmented__item--on' : ''}`}
                onClick={() => patch({ scope: s.value })}
              >
                {s.label}
                {s.value === 'modified' ? ` (${formatCount(modifiedCount)})` : ''}
                {s.value === 'confirmed' ? ` (${formatCount(confirmedCount)})` : ''}
                {s.value === 'filtered' ? ` (${formatCount(filteredCount)})` : ''}
              </button>
            ))}
          </div>
        </div>

        {config.format === 'json' && (
          <>
            <span className="form-grid__label">缩进</span>
            <div className="segmented">
              {[
                { value: null, label: '紧凑' },
                { value: 2, label: '2 空格' },
                { value: 4, label: '4 空格' }
              ].map((option) => (
                <button
                  key={String(option.value)}
                  className={`segmented__item${config.indent === option.value ? ' segmented__item--on' : ''}`}
                  onClick={() => patch({ indent: option.value as number | null })}
                >
                  {option.label}
                </button>
              ))}
            </div>
          </>
        )}

        {config.format === 'csv' && (
          <>
            <span className="form-grid__label">分隔符</span>
            <div className="segmented">
              {[
                { value: ',', label: '逗号 ,' },
                { value: ';', label: '分号 ;' },
                { value: '\t', label: '制表符' }
              ].map((option) => (
                <button
                  key={option.value}
                  className={`segmented__item${config.delimiter === option.value ? ' segmented__item--on' : ''}`}
                  onClick={() => patch({ delimiter: option.value })}
                >
                  {option.label}
                </button>
              ))}
            </div>
          </>
        )}

        {isFlat && (
          <>
            <span className="form-grid__label">嵌套结构</span>
            <div className="segmented">
              {[
                { value: null, label: '紧凑 JSON' },
                { value: 2, label: '缩进 2 空格' }
              ].map((option) => (
                <button
                  key={String(option.value)}
                  className={`segmented__item${config.flattenIndent === option.value ? ' segmented__item--on' : ''}`}
                  onClick={() => patch({ flattenIndent: option.value as number | null })}
                >
                  {option.label}
                </button>
              ))}
            </div>
          </>
        )}
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--sp-4)' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--sp-4)' }}>
          <h3 className="section-title" style={{ flex: 1 }}>
            字段映射
          </h3>
          <label className="checkbox">
            <input type="checkbox" checked={config.includeIndex} onChange={(e) => toggleIndex(e.target.checked)} />
            附带原始行号列
          </label>
          <button className="btn btn--sm" onClick={() => addColumn(null)}>
            <Plus size={11} />
            添加列
          </button>
          <button className="btn btn--sm" onClick={resetColumns}>
            <RotateCcw size={11} />
            重置
          </button>
        </div>

        <div className="collist">
          <div className="collist__head">
            <span />
            <span>输出列名</span>
            <span>数据来源</span>
            <span>排序</span>
            <span>启用</span>
          </div>
          {config.columns.map((column) => (
            <div
              key={column.id}
              className={[
                'colrow',
                column.enabled ? '' : ' colrow--off',
                dragId === column.id ? ' colrow--dragging' : '',
                overId === column.id && dragId !== column.id ? ' colrow--over' : ''
              ]
                .filter(Boolean)
                .join(' ')}
              draggable
              onDragStart={() => setDragId(column.id)}
              onDragEnd={() => {
                setDragId(null)
                setOverId(null)
              }}
              onDragOver={(e) => {
                e.preventDefault()
                setOverId(column.id)
              }}
              onDrop={(e) => {
                e.preventDefault()
                if (dragId) reorder(dragId, column.id)
                setDragId(null)
                setOverId(null)
              }}
            >
              <span className="colrow__handle" title="拖动排序">
                <GripVertical size={13} />
              </span>
              <input
                className="input"
                value={column.label}
                onChange={(e) => updateColumn(column.id, { label: e.target.value })}
                spellCheck={false}
              />
              <div className="pathcell">
                <span className={`pathcell__value${column.path ? '' : ' pathcell__value--empty'}`}>
                  {column.path ? defaultPathLabel(column.path) : '空列（导出为 null）'}
                </span>
                <button
                  className="iconbtn"
                  style={{ width: 22, height: 22 }}
                  title="选择取值路径"
                  onClick={() => setPicking(picking === column.id ? null : column.id)}
                >
                  <ExternalLink size={11} />
                </button>
                {column.path && (
                  <button
                    className="iconbtn"
                    style={{ width: 22, height: 22 }}
                    title="清空路径"
                    onClick={() => updateColumn(column.id, { path: null })}
                  >
                    <X size={11} />
                  </button>
                )}
              </div>
              <div style={{ display: 'flex', gap: 2 }}>
                <button
                  className="iconbtn"
                  style={{ width: 20, height: 20 }}
                  title="上移"
                  onClick={() => moveColumn(column.id, -1)}
                >
                  <ArrowUp size={11} />
                </button>
                <button
                  className="iconbtn"
                  style={{ width: 20, height: 20 }}
                  title="下移"
                  onClick={() => moveColumn(column.id, 1)}
                >
                  <ArrowDown size={11} />
                </button>
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--sp-3)' }}>
                <input
                  className="switch"
                  type="checkbox"
                  checked={column.enabled}
                  onChange={(e) => updateColumn(column.id, { enabled: e.target.checked })}
                  aria-label="启用这一列"
                />
                {column.label !== INDEX_COLUMN && (
                  <button
                    className="iconbtn"
                    style={{ width: 20, height: 20 }}
                    title="删除这一列"
                    onClick={() => removeColumn(column.id)}
                  >
                    <X size={11} />
                  </button>
                )}
              </div>
            </div>
          ))}
        </div>

        {picking && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--sp-3)' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--sp-3)' }}>
              <span className="label">选择取值路径</span>
              <span style={{ flex: 1 }} />
              <button className="btn btn--sm" onClick={() => setPicking(null)}>
                收起
              </button>
            </div>
            <div className="pathpicker">
              {pathOptions.map((option) => (
                <button
                  key={option.key}
                  className={`pathpicker__item${
                    config.columns.find((c) => c.id === picking)?.path
                      ? pathKey(config.columns.find((c) => c.id === picking)!.path!) === option.key
                        ? ' pathpicker__item--on'
                        : ''
                      : ''
                  }`}
                  onClick={() => {
                    updateColumn(picking, { path: option.path, label: defaultPathLabel(option.path) })
                    setPicking(null)
                  }}
                >
                  <span className="pathpicker__label">{option.label}</span>
                  <span className="pathpicker__sample">{option.sample}</span>
                </button>
              ))}
            </div>
          </div>
        )}
      </div>

      {result && (
        <div className="result-box">
          <div className="result-box__head">
            已导出 {formatCount(result.count)} 条 · {formatBytes(result.bytes)}
          </div>
          <div className="sample">
            <span className="sample__path">{result.path}</span>
            <button className="btn btn--sm" style={{ alignSelf: 'flex-start' }} onClick={() => void api.showItemInFolder(result.path)}>
              在文件夹中显示
            </button>
          </div>
        </div>
      )}
    </Modal>
  )
}
