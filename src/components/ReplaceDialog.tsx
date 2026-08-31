import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { Replace, Search, Wand2 } from 'lucide-react'
import Modal from './Modal'
import ConfirmDialog from './ConfirmDialog'
import { computeVisibleIndices } from '../state/search'
import { useStore } from '../state/store'
import { buildMatcher, planReplace } from '@shared/replace'
import { recordStatus } from '@shared/patch'
import { formatCount } from '../lib/text'
import type { ReplaceOptions, ReplacePlan, ReplaceTarget } from '@shared/types'

type ScopeValue = 'all' | 'filtered' | 'current'
/** 作用范围按「记录状态」选，和列表页签用的是同一套判定。 */
type StatusValue = 'unmodified' | 'pending' | 'confirmed' | 'deleted'

const AUTO_PREVIEW_LIMIT = 50_000

const STATUS_CHIPS: Array<{ value: StatusValue; label: string; hint: string }> = [
  { value: 'unmodified', label: '未修改', hint: '没动过的记录' },
  { value: 'pending', label: '待确认', hint: '改过但还没定' },
  { value: 'confirmed', label: '已确认', hint: '改完会退回待确认，需要重新过一遍' },
  { value: 'deleted', label: '已删除', hint: '只改补丁，不会把记录复活' }
]

export default function ReplaceDialog() {
  const open = useStore((s) => s.replaceOpen)
  const close = useStore((s) => s.closeReplace)
  const records = useStore((s) => s.records)
  const fields = useStore((s) => s.fields)
  const edits = useStore((s) => s.edits)
  const deleted = useStore((s) => s.deleted)
  const confirmed = useStore((s) => s.confirmed)
  const view = useStore((s) => s.view)
  const applyReplace = useStore((s) => s.applyReplace)
  const toast = useStore((s) => s.toast)

  const [find, setFind] = useState('')
  const [replaceWith, setReplaceWith] = useState('')
  const [caseSensitive, setCaseSensitive] = useState(true)
  const [wholeWord, setWholeWord] = useState(false)
  const [useRegex, setUseRegex] = useState(false)
  const [targetValue, setTargetValue] = useState('everything')
  const [scopeValue, setScopeValue] = useState<ScopeValue>('all')
  // 默认覆盖三种在用状态，不替用户做假设；已删除默认不选，避免语义混淆
  const [statuses, setStatuses] = useState<StatusValue[]>(['unmodified', 'pending', 'confirmed'])
  const [plan, setPlan] = useState<ReplacePlan | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [computing, setComputing] = useState(false)
  const [askConfirmed, setAskConfirmed] = useState(false)
  const requestId = useRef(0)

  const targetOptions = useMemo(() => {
    const list: Array<{ value: string; label: string; target: ReplaceTarget }> = [
      { value: 'everything', label: '全部字段（含嵌套文本）', target: { type: 'everything' } }
    ]
    for (const field of fields) {
      list.push({
        value: `field:${field.name}`,
        label: `字段 · ${field.name}`,
        target: { type: 'field', field: field.name }
      })
      // 两种对话形态都能按角色定向替换：标准对话取 roles，键即角色取 keys
      const roles =
        field.kind.type === 'messages'
          ? field.kind.roles
          : field.kind.type === 'pairs'
            ? field.kind.keys
            : null
      if (roles) {
        for (const role of roles) {
          list.push({
            value: `role:${field.name}:${role}`,
            label: `${field.name} › ${role}`,
            target: { type: 'role', field: field.name, role }
          })
        }
      }
    }
    return list
  }, [fields])

  const target = targetOptions.find((o) => o.value === targetValue)?.target ?? { type: 'everything' as const }

  const visibleIds = useMemo(
    () =>
      new Set(
        computeVisibleIndices({
          records,
          edits,
          deleted,
          confirmed,
          filter: view.filter,
          query: view.query
        }).map((i) => records[i].id)
      ),
    [records, edits, deleted, confirmed, view.filter, view.query]
  )

  const statusSet = useMemo(() => new Set(statuses), [statuses])

  const scopeIds = useMemo(() => {
    if (scopeValue === 'current') {
      const record = records[view.selectedIndex]
      return new Set(record ? [record.id] : [])
    }
    const out = new Set<string>()
    for (const record of records) {
      const status = recordStatus(
        record.index,
        record.origin === 'new',
        edits,
        deleted,
        confirmed
      )
      // 新建的记录归入「待确认」这一档：它是新内容，理应被默认覆盖到
      const bucket: StatusValue = status === 'new' ? 'pending' : (status as StatusValue)
      if (!statusSet.has(bucket)) continue
      if (scopeValue === 'filtered' && !visibleIds.has(record.id)) continue
      out.add(record.id)
    }
    return out
  }, [scopeValue, records, edits, deleted, confirmed, statusSet, visibleIds, view.selectedIndex])

  const scopeCount = scopeIds.size

  const options: ReplaceOptions = { find, replace: replaceWith, caseSensitive, wholeWord, useRegex }

  const runPreview = () => {
    const id = ++requestId.current
    if (!find) {
      setPlan(null)
      setError(null)
      return
    }
    setComputing(true)
    // 让出一帧，保证「计算中」能显示出来
    window.setTimeout(() => {
      if (id !== requestId.current) return
      const result = planReplace(records, target, options, { ids: scopeIds })
      if (id !== requestId.current) return
      setComputing(false)
      setError(result.error)
      setPlan(result.plan)
    }, 16)
  }

  useEffect(() => {
    if (!open) return
    if (!find) {
      setPlan(null)
      setError(null)
      return
    }
    if (records.length > AUTO_PREVIEW_LIMIT) return
    const timer = window.setTimeout(runPreview, 350)
    return () => window.clearTimeout(timer)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    open,
    find,
    replaceWith,
    caseSensitive,
    wholeWord,
    useRegex,
    targetValue,
    scopeValue,
    statuses,
    records,
    edits,
    deleted,
    confirmed,
    view.filter,
    view.query,
    view.selectedIndex
  ])

  if (!open) return null

  /** 这次替换会动到几条已确认的记录 —— 执行前必须让用户知道它们会退回待确认。 */
  const hitConfirmed = plan
    ? Object.keys(plan.patch).filter((id) => confirmed.has(Number(id))).length
    : 0

  const runApply = () => {
    applyReplace(plan as ReplacePlan, '批量替换')
    toast(
      `已替换 ${formatCount((plan as ReplacePlan).matchCount)} 处，影响 ${formatCount((plan as ReplacePlan).affectedRecords)} 条记录 · 可用 Ctrl+Z 撤销`,
      'success'
    )
    setPlan(null)
  }

  const apply = () => {
    if (!plan || plan.matchCount === 0) return
    if (hitConfirmed > 0) setAskConfirmed(true)
    else runApply()
  }

  return (
    <Modal
      title="查找与替换"
      subtitle={`作用于 ${formatCount(scopeCount)} 条记录`}
      onClose={close}
      footer={
        <>
          <span style={{ fontSize: 'var(--fs-caption)', color: 'var(--text-muted)' }}>
            替换会写入工作区，原文件不受影响；一次替换算作一步，可整体撤销。
          </span>
          <span style={{ flex: 1 }} />
          <button className="btn" onClick={close}>
            关闭
          </button>
          <button className="btn btn--primary" onClick={apply} disabled={!plan || plan.matchCount === 0}>
            <Wand2 size={13} />
            替换 {plan && plan.matchCount > 0 ? formatCount(plan.matchCount) : ''} 处
          </button>
        </>
      }
    >
      <div className="form-grid">
        <label className="form-grid__label" htmlFor="rp-find">
          查找
        </label>
        <input
          id="rp-find"
          className="input mono"
          value={find}
          autoFocus
          placeholder="要查找的文本或正则表达式"
          onChange={(e) => setFind(e.target.value)}
          spellCheck={false}
        />

        <label className="form-grid__label" htmlFor="rp-replace">
          替换为
        </label>
        <input
          id="rp-replace"
          className="input mono"
          value={replaceWith}
          placeholder="留空表示删除匹配到的内容"
          onChange={(e) => setReplaceWith(e.target.value)}
          spellCheck={false}
        />

        <label className="form-grid__label" htmlFor="rp-target">
          作用字段
        </label>
        <select
          id="rp-target"
          className="select"
          value={targetValue}
          onChange={(e) => setTargetValue(e.target.value)}
        >
          {targetOptions.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>

        <label className="form-grid__label" htmlFor="rp-scope">
          作用范围
        </label>
        <select
          id="rp-scope"
          className="select"
          value={scopeValue}
          onChange={(e) => setScopeValue(e.target.value as ScopeValue)}
        >
          <option value="all">全部记录（{formatCount(records.length)} 条）</option>
          <option value="filtered">当前筛选结果（{formatCount(visibleIds.size)} 条）</option>
          <option value="current">仅当前这条记录</option>
        </select>

        <span className="form-grid__label">记录状态</span>
        <div className="chip-row">
          {STATUS_CHIPS.map((chip) => {
            const on = statusSet.has(chip.value)
            return (
              <button
                key={chip.value}
                type="button"
                title={chip.hint}
                className={`chip${on ? ' chip--on' : ''}`}
                onClick={() =>
                  setStatuses((prev) =>
                    prev.includes(chip.value)
                      ? prev.filter((v) => v !== chip.value)
                      : [...prev, chip.value]
                  )
                }
              >
                {chip.label}
              </button>
            )
          })}
          <span className="chip-row__hint">
            命中 {formatCount(scopeCount)} 条
            {hitConfirmed > 0 && (
              <>
                {' · '}
                <b style={{ color: 'var(--clay)' }}>含 {formatCount(hitConfirmed)} 条已确认</b>
              </>
            )}
          </span>
        </div>
      </div>

      <div className="options-row">
        <label className="checkbox">
          <input type="checkbox" checked={caseSensitive} onChange={(e) => setCaseSensitive(e.target.checked)} />
          区分大小写
        </label>
        <label className="checkbox">
          <input type="checkbox" checked={wholeWord} onChange={(e) => setWholeWord(e.target.checked)} />
          全字匹配
        </label>
        <label className="checkbox">
          <input type="checkbox" checked={useRegex} onChange={(e) => setUseRegex(e.target.checked)} />
          正则表达式
        </label>
        <span style={{ flex: 1 }} />
        <button className="btn btn--sm" onClick={runPreview} disabled={!find || computing}>
          <Search size={11} />
          {computing ? '计算中…' : '预览'}
        </button>
      </div>

      {error && (
        <div className="result-box">
          <div className="result-box__head result-box__head--danger">无法执行</div>
          <div className="sample">
            <span style={{ fontSize: 'var(--fs-sm)', color: 'var(--danger)' }}>{error}</span>
          </div>
        </div>
      )}

      {!error && plan && (
        <div className="result-box">
          <div className={`result-box__head${plan.matchCount === 0 ? ' result-box__head--warn' : ''}`}>
            <Replace size={13} />
            {plan.matchCount === 0
              ? '没有匹配到任何内容'
              : `匹配 ${formatCount(plan.matchCount)} 处，涉及 ${formatCount(plan.affectedRecords)} 条记录`}
          </div>
          {plan.samples.length > 0 && (
            <div className="samples">
              {plan.samples.map((sample) => (
                <div className="sample" key={`${sample.recordId}-${sample.pathKey}`}>
                  <span className="sample__path">
                    #{sample.recordIndex + 1} · {sample.pathLabel}
                  </span>
                  <Highlight className="sample__line sample__line--before" text={sample.before} options={options} />
                  <Highlight className="sample__line sample__line--after" text={sample.after} options={options} />
                </div>
              ))}
              {plan.matchCount > plan.samples.length && (
                <div className="sample">
                  <span style={{ fontSize: 'var(--fs-caption)', color: 'var(--text-muted)' }}>
                    仅展示前 {plan.samples.length} 处示例
                  </span>
                </div>
              )}
            </div>
          )}
        </div>
      )}

      {!error && !plan && find && records.length > AUTO_PREVIEW_LIMIT && (
        <div className="result-box">
          <div className="result-box__head result-box__head--warn">
            数据量较大，点击「预览」查看匹配结果
          </div>
        </div>
      )}

      {askConfirmed && (
        <ConfirmDialog
          title="这次替换会改动已确认的记录"
          confirmLabel="仍然执行"
          danger
          onClose={() => setAskConfirmed(false)}
          onConfirm={() => {
            setAskConfirmed(false)
            runApply()
          }}
        >
          <p>
            这次替换会改动 <b className="num">{formatCount(hitConfirmed)}</b> 条<b>已确认</b>的记录。
          </p>
          <p className="muted">执行后它们会退回「待确认」，需要重新过一遍。可用 Ctrl+Z 撤销。</p>
        </ConfirmDialog>
      )}
    </Modal>
  )
}

function Highlight({ text, options, className }: { text: string; options: ReplaceOptions; className: string }) {
  const children = useMemo(() => highlightNodes(text, options), [text, options])
  return <div className={className}>{children}</div>
}

function highlightNodes(text: string, options: ReplaceOptions): ReactNode[] {
  const { regex } = buildMatcher(options)
  if (!regex) return [text]
  const source = new RegExp(regex.source, regex.flags.replace('g', '') + 'g')
  const nodes: ReactNode[] = []
  let last = 0
  let match: RegExpExecArray | null
  let guard = 0
  while ((match = source.exec(text)) !== null && guard++ < 500) {
    if (match.index > last) nodes.push(text.slice(last, match.index))
    nodes.push(
      <mark className="hit" key={`${match.index}-${guard}`}>
        {match[0]}
      </mark>
    )
    last = match.index + match[0].length
    if (match[0].length === 0) source.lastIndex += 1
  }
  if (last < text.length) nodes.push(text.slice(last))
  return nodes
}
