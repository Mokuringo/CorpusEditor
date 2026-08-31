import { Plus, Trash2 } from 'lucide-react'
import AutoTextarea from './AutoTextarea'
import { deepEqual, pathKey } from '@shared/jsonpath'
import { normalizeRole } from '@shared/inspect'
import { useStore } from '../state/store'
import type { FieldInfo } from '@shared/inspect'
import type { DataRecord, Json } from '@shared/types'

interface Props {
  record: DataRecord
  field: FieldInfo & { kind: Extract<FieldInfo['kind'], { type: 'pairs' }> }
  modifiedKeys: Set<string>
  original: Record<string, Json> | null
  readOnly?: boolean
}

/** 角色键的候选。比 messages 的场景宽一些，因为键名本身就是自由文本。 */
const ROLE_CHOICES = ['system', 'user', 'human', 'assistant', 'gpt', 'tool']

type Turn = Record<string, Json>

function asTurn(item: Json): Turn {
  return item && typeof item === 'object' && !Array.isArray(item) ? (item as Turn) : {}
}

/**
 * 「键即角色」的对话编辑器：一轮一个对象，对象的键是角色名、值是内容。
 *
 * 例：{ human: '问题', assistant: '回答' }
 *
 * 和 MessagesEditor 的区别是这里**键名也是可编辑的** —— 改键名、增删角色键都会
 * 改写结构，所以一律走整条替换（setMessages），单项编辑才走 editValue。
 */
export default function PairsEditor({ record, field, modifiedKeys, original, readOnly }: Props) {
  const editValue = useStore((s) => s.editValue)
  const setMessages = useStore((s) => s.setMessages)
  const toast = useStore((s) => s.toast)

  const { name, kind } = field
  const turns: Json[] = Array.isArray(record.data[name]) ? (record.data[name] as Json[]) : []
  const originalTurns: Json[] | null = Array.isArray(original?.[name])
    ? (original?.[name] as Json[])
    : null

  // 整条数组被替换过（增删轮次 / 改键名）时，单项的补丁键就不可信了，只能逐条比内容
  const arrayReplaced = modifiedKeys.has(pathKey([name]))

  const replaceArray = (next: Json[], label: string) => setMessages(record.id, name, next, label)

  /** 按原键序重写某一轮：保序很重要，对象键顺序就是导出的字段顺序。 */
  const rewriteTurn = (index: number, next: Turn, label: string) => {
    const nextTurns = turns.slice()
    nextTurns[index] = next as Json
    replaceArray(nextTurns, label)
  }

  const renameKey = (index: number, oldKey: string, newKey: string) => {
    if (oldKey === newKey) return
    const turn = asTurn(turns[index])
    if (newKey in turn) {
      toast(`这一轮里已经有「${newKey}」了`, 'error')
      return
    }
    const next: Turn = {}
    for (const [key, value] of Object.entries(turn)) next[key === oldKey ? newKey : key] = value
    rewriteTurn(index, next, `角色 ${oldKey} → ${newKey}`)
  }

  const removeKey = (index: number, key: string) => {
    const turn = asTurn(turns[index])
    const next: Turn = {}
    for (const [k, v] of Object.entries(turn)) if (k !== key) next[k] = v
    if (Object.keys(next).length === 0) {
      // 删掉最后一个键，这一轮就什么都不剩了 —— 连整轮一起删，别留下空对象
      replaceArray(turns.filter((_, i) => i !== index), '删除对话轮次')
      return
    }
    rewriteTurn(index, next, `删除角色 ${key}`)
  }

  const addKey = (index: number) => {
    const turn = asTurn(turns[index])
    const used = new Set(Object.keys(turn))
    const candidate = [...kind.keys, ...ROLE_CHOICES].find((k) => !used.has(k))
    if (!candidate) {
      toast('这一轮里已经没有可加的角色了', 'error')
      return
    }
    rewriteTurn(index, { ...turn, [candidate]: '' }, `新增角色 ${candidate}`)
  }

  const addTurn = () => {
    // 新的一轮按数据集已有的角色键铺开，空着让用户填
    const seed: Turn = {}
    for (const key of kind.keys.length > 0 ? kind.keys : [ROLE_CHOICES[1]]) seed[key] = ''
    replaceArray([...turns, seed as Json], '新增对话轮次')
  }

  return (
    <div className="pairs">
      {turns.map((item, i) => {
        const turn = asTurn(item)
        const originalTurn = originalTurns ? asTurn(originalTurns[i]) : null
        const entries = Object.entries(turn)

        return (
          <div key={`${record.id}-${name}-${i}`} className="pair">
            <span className="pair__band" />
            <div className="pair__body">
              <div className="pair__head">
                <span className="pair__idx mono">#{i + 1}</span>
                <span className="pair__spacer" />
                <button
                  className="iconbtn"
                  title={readOnly ? '已确认的记录不能修改' : '删除这一轮'}
                  aria-label="删除这一轮"
                  disabled={readOnly}
                  onClick={() => replaceArray(turns.filter((_, j) => j !== i), '删除对话轮次')}
                >
                  <Trash2 size={13} />
                </button>
              </div>

              {entries.map(([key, content]) => {
                const role = normalizeRole(key)
                const originalContent = originalTurn ? originalTurn[key] : undefined
                const modified = arrayReplaced
                  ? !deepEqual(turn, originalTurn)
                  : modifiedKeys.has(pathKey([name, i, key]))
                const label =
                  role === 'other' ? key : { system: 'System', user: 'User', assistant: 'Assistant', tool: 'Tool' }[role]

                return (
                  <div key={key} className={`pairrow pairrow--${role}${modified ? ' pairrow--modified' : ''}`}>
                    <div className="pairrow__head">
                      <select
                        className="select select--role"
                        value={key}
                        disabled={readOnly}
                        onChange={(e) => renameKey(i, key, e.target.value)}
                        aria-label="角色"
                        title="改这一行的角色名（会改写字段名）"
                      >
                        {!ROLE_CHOICES.includes(key) && <option value={key}>{key}</option>}
                        {ROLE_CHOICES.map((option) => (
                          <option key={option} value={option}>
                            {option}
                          </option>
                        ))}
                      </select>
                      <span className="pairrow__label">{label}</span>
                      <span className="pairrow__spacer" />
                      <button
                        className="iconbtn"
                        title={readOnly ? '已确认的记录不能修改' : `删除「${key}」这一行`}
                        aria-label={`删除角色 ${key}`}
                        disabled={readOnly}
                        onClick={() => removeKey(i, key)}
                      >
                        <Trash2 size={12} />
                      </button>
                    </div>

                    {typeof content === 'string' ? (
                      <AutoTextarea
                        value={content}
                        placeholder={`${key} 的内容`}
                        onCommit={(next) => editValue(record.id, [name, i, key], next)}
                        readOnly={readOnly}
                      />
                    ) : (
                      <AutoTextarea
                        value={content === null || content === undefined ? '' : String(content)}
                        placeholder={`${key} 的内容`}
                        onCommit={(next) => editValue(record.id, [name, i, key], next)}
                        readOnly={readOnly}
                      />
                    )}

                    {modified && originalContent !== undefined && originalContent !== content && (
                      <div className="field__orig">
                        <span className="field__orig-label">原值</span>
                        {typeof originalContent === 'string'
                          ? originalContent
                          : JSON.stringify(originalContent, null, 2)}
                      </div>
                    )}
                  </div>
                )
              })}

              <button
                className="btn btn--sm"
                disabled={readOnly}
                title={readOnly ? '已确认的记录不能修改' : '给这一轮再加一个角色'}
                onClick={() => addKey(i)}
              >
                <Plus size={11} />
                加一个角色
              </button>
            </div>
          </div>
        )
      })}

      <button
        className="btn btn--sm"
        style={{ alignSelf: 'flex-start' }}
        disabled={readOnly}
        title={readOnly ? '已确认的记录不能修改' : undefined}
        onClick={addTurn}
      >
        <Plus size={12} />
        新增一轮
      </button>
    </div>
  )
}
