/**
 * 渲染进程 store 的核心不变量。
 *
 * store.ts 是 1100+ 行的业务中枢，但它是渲染进程代码（顶层就读 window.corpuseditor），
 * 以前只能靠 GUI 测试间接覆盖 —— 而下标平移、确认状态回退这类东西，
 * GUI 上根本看不出来对错，只有断言状态才验得住。
 *
 * 这里只测**最容易静默出错的状态转移**；持久化归 session.test.ts，补丁数学归 patch.test.ts。
 */

import { beforeEach, describe, expect, it } from 'vitest'
import type { AddedRecord, DataRecord, Json, Path, ViewState } from '@shared/types'

/* ------------------------------------------------------------------ *
 * 假 window：必须在动态 import store 之前装好
 * ------------------------------------------------------------------ */

// lib/api.ts 在模块顶层就取 window.corpuseditor，晚一步就是 undefined
const persistCalls: unknown[] = []

const fakeWindow = {
  corpuseditor: {
    persist: async (payload: unknown) => {
      persistCalls.push(payload)
      return { ok: true, updatedAt: Date.now(), cleared: [] }
    },
    listSessions: async () => [],
    getSettings: async () => null,
    setSettings: async () => undefined,
    openSource: async () => {
      throw new Error('store 单测不碰 IPC')
    },
    onDatasetChunk: () => () => undefined,
    onFlushRequest: () => undefined,
    flushed: () => undefined
  },
  // 关键：不真的排定时器。scheduleSave 靠它触发 doFlush（会调 api.persist），
  // 我们只验状态转移，落盘不是这里的职责。
  setTimeout: () => 0,
  clearTimeout: () => undefined
}

globalThis.window = fakeWindow as unknown as Window & typeof globalThis

const { useStore } = await import('../src/state/store')

/* ------------------------------------------------------------------ *
 * 辅助
 * ------------------------------------------------------------------ */

function record(index: number, data: Record<string, Json>): DataRecord {
  return { id: String(index), index, data }
}

/** 直接播种状态。openFile 要过 IPC，这里用 setState 跳过，只测动作本身。 */
function seed(input: {
  count: number
  edits?: Record<string, Record<string, Json>>
  deleted?: number[]
  confirmed?: number[]
  added?: AddedRecord[]
}) {
  const records: DataRecord[] = []
  for (let i = 0; i < input.count; i += 1) {
    records.push(record(i, { instruction: `第 ${i} 条`, output: `out-${i}` }))
  }
  const view: ViewState = {
    selectedIndex: 0,
    scrollTop: 0,
    filter: 'all',
    query: '',
    selectedIds: [],
    multiSelect: false
  }
  useStore.setState({
    dataset: {
      id: 'a'.repeat(32),
      source: {
        path: '/tmp/x.jsonl',
        name: 'x.jsonl',
        ext: '.jsonl',
        size: 100,
        mtimeMs: 0,
        fingerprint: 'f'.repeat(64),
        format: 'jsonl'
      },
      fieldOrder: ['instruction', 'output'],
      warnings: [],
      recordCount: input.count,
      resumed: false,
      sourceChanged: false,
      lastExportPath: null
    },
    records,
    edits: input.edits ?? {},
    deleted: new Set(input.deleted ?? []),
    confirmed: new Set(input.confirmed ?? []),
    added: input.added ?? [],
    view,
    undoStack: [],
    redoStack: []
  })
}

const state = () => useStore.getState()
const editValue = (id: string, path: Path, value: Json) => state().editValue(id, path, value)

beforeEach(() => {
  persistCalls.length = 0
})

/* ------------------------------------------------------------------ */

/**
 * ⚠️ 这条不变量只在 `applyBatch` 里生效，而 `editValue` / `setMessages` / `setRecordData`
 * **不走** applyBatch —— 它们不会触发确认回退。
 *
 * 这不是漏写：已确认的记录在界面上是锁定的（`RecordEditor` 的 readOnly），
 * 用户根本改不动，必须先点「退回修改」。所以 editValue 拿不到已确认的记录。
 *
 * 真正能绕过锁定、改到已确认记录的是**全局替换**（替换默认覆盖所有状态），
 * 它走 applyBatch —— 所以下面用 applyReplace 来验，而不是 editValue。
 */
function planFor(patch: Record<string, Record<string, Json>>, inverse: Record<string, Record<string, Json>>) {
  return { matchCount: 1, affectedRecords: 1, samples: [], patch, inverse }
}

describe('确认状态的自动回退', () => {
  it('全局替换命中一条已确认的记录 → 它退回待确认', () => {
    seed({ count: 3, confirmed: [0, 1] })
    state().applyReplace(
      planFor({ '0': { '["output"]': '改过了' } }, { '0': { '["output"]': 'out-0' } }),
      '全局替换'
    )
    // 不能让用户在「已确认」的外衣下藏着未经复核的改动
    expect(state().confirmed.has(0)).toBe(false)
    expect(state().records[0].data.output).toBe('改过了')
    expect(state().confirmed.has(1)).toBe(true) // 没被替换到的不该受牵连
  })

  it('回退动作写进了历史，撤销能把确认状态一起恢复回来', () => {
    seed({ count: 3, confirmed: [0, 1] })
    state().applyReplace(
      planFor({ '0': { '["output"]': '改过了' } }, { '0': { '["output"]': 'out-0' } }),
      '全局替换'
    )
    const top = state().undoStack[state().undoStack.length - 1]
    expect(top.confirmed).toEqual({ add: [], remove: [0] })

    state().undo()
    // 值和确认状态要一起回来 —— 只恢复其中一个都会让状态自相矛盾
    expect(state().records[0].data.output).toBe('out-0')
    expect(state().confirmed.has(0)).toBe(true)
    expect(state().confirmed.has(1)).toBe(true)
  })

  it('没确认过的记录被替换，不会凭空产生确认状态', () => {
    seed({ count: 3 })
    state().applyReplace(
      planFor({ '1': { '["output"]': 'x' } }, { '1': { '["output"]': 'out-1' } }),
      '全局替换'
    )
    expect(state().confirmed.size).toBe(0)
  })
})

describe('已删除的记录不参与确认', () => {
  it('单条确认会被已删除标记挡下', () => {
    seed({ count: 3, deleted: [2] })
    state().confirmRecord(2)
    expect(state().confirmed.has(2)).toBe(false)
  })

  it('批量确认会跳过已删除，其余照常', () => {
    seed({ count: 3, deleted: [1] })
    state().confirmMany([0, 1, 2])
    expect([...state().confirmed].sort()).toEqual([0, 2])
  })

  it('删除标记撤掉后就能正常确认了', () => {
    seed({ count: 3, deleted: [2] })
    state().restoreRecord(2)
    state().confirmRecord(2)
    expect(state().confirmed.has(2)).toBe(true)
  })
})

describe('新增记录后的下标平移', () => {
  it('中间插入一条：改动 / 删除 / 确认的下标整体后移', () => {
    seed({
      count: 3,
      edits: { '2': { '["output"]': '改过' } },
      deleted: [2],
      confirmed: [1]
    })
    state().addRecord({ instruction: '新建', output: '' }, 1)

    expect(state().records).toHaveLength(4)
    expect(state().records[1].origin).toBe('new')
    // 原本下标 1、2 的记录现在在 2、3
    expect(state().edits['3']).toEqual({ '["output"]': '改过' })
    expect(state().edits['2']).toBeUndefined()
    expect(state().deleted.has(3)).toBe(true)
    expect(state().deleted.has(2)).toBe(false)
    expect(state().confirmed.has(2)).toBe(true)
    expect(state().confirmed.has(1)).toBe(false)
  })

  it('撤销新增：下标整体挪回去，改动挂回原记录', () => {
    seed({ count: 3, edits: { '2': { '["output"]': '改过' } }, deleted: [2] })
    state().addRecord({ instruction: '新建', output: '' }, 1)
    state().undo()

    expect(state().records).toHaveLength(3)
    expect(state().records.some((r) => r.origin === 'new')).toBe(false)
    expect(state().edits['2']).toEqual({ '["output"]': '改过' })
    expect(state().deleted.has(2)).toBe(true)
  })

  it('重做新增：平移再做一遍，落到同一个位置', () => {
    seed({ count: 3, edits: { '2': { '["output"]': '改过' } } })
    state().addRecord({ instruction: '新建', output: '' }, 1)
    state().undo()
    state().redo()

    expect(state().records).toHaveLength(4)
    expect(state().records[1].origin).toBe('new')
    expect(state().edits['3']).toEqual({ '["output"]': '改过' })
  })
})

describe('撤销栈的粒度', () => {
  it('一次批量确认在撤销栈里只占一格', () => {
    seed({ count: 5 })
    state().confirmMany([0, 1, 2, 3, 4])
    expect(state().confirmed.size).toBe(5)
    expect(state().undoStack).toHaveLength(1)

    state().undo()
    expect(state().confirmed.size).toBe(0)
  })

  it('一次编辑重做后回到改后的值', () => {
    seed({ count: 3 })
    editValue('0', ['output'], 'A')
    expect(state().records[0].data.output).toBe('A')

    state().undo()
    expect(state().records[0].data.output).toBe('out-0')

    state().redo()
    expect(state().records[0].data.output).toBe('A')
  })

  it('删除一条再撤销，删除标记消失', () => {
    seed({ count: 3 })
    state().deleteRecord(1)
    expect(state().deleted.has(1)).toBe(true)

    state().undo()
    expect(state().deleted.has(1)).toBe(false)
  })
})
