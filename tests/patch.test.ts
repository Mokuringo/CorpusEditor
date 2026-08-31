import { describe, expect, it } from 'vitest'
import {
  applyIndexDelta,
  applyEdits,
  dropRecordEdits,
  filterValidEdits,
  getEditedPaths,
  invertEdits,
  mergeAddedIntoRecords,
  mergeEdits,
  newRecordIndexSet,
  patchSize,
  recordStatus,
  setPathValue,
  shiftAddedPos,
  shiftHistory,
  shiftIndexArray,
  shiftPatchIndices,
  sortEntryKeys,
  unsetPath
} from '@shared/patch'
import { pathKey } from '@shared/jsonpath'
import type { AddedRecord, DataRecord, HistoryEntry, PatchMap } from '@shared/types'

function makeRecords(): DataRecord[] {
  return [
    { id: '0', index: 0, data: { instruction: '翻译', messages: [{ role: 'user', content: 'hi' }] } },
    { id: '1', index: 1, data: { instruction: '总结', messages: [{ role: 'user', content: 'long' }] } }
  ]
}

describe('应用补丁', () => {
  it('空补丁直接复用原数组', () => {
    const records = makeRecords()
    expect(applyEdits(records, {})).toBe(records)
  })

  it('只改动目标记录，其它记录保持同一引用', () => {
    const records = makeRecords()
    const next = applyEdits(records, { 0: { [pathKey(['instruction'])]: '改写' } })
    expect(next[0].data.instruction).toBe('改写')
    expect(next[1]).toBe(records[1])
    expect(records[0].data.instruction).toBe('翻译')
  })

  it('先写父级再写子级，整体替换与单项修改可以共存', () => {
    const records = makeRecords()
    const edits: PatchMap = {
      0: {
        [pathKey(['messages', 0, 'content'])]: '子级改动',
        [pathKey(['messages'])]: [{ role: 'user', content: '父级覆盖' }]
      }
    }
    const next = applyEdits(records, edits)
    // 排序后父级先应用、子级后应用
    expect(next[0].data.messages).toEqual([{ role: 'user', content: '子级改动' }])
  })

  it('sortEntryKeys 按路径长度升序', () => {
    const keys = sortEntryKeys({
      [pathKey(['a', 0, 'b'])]: 1,
      [pathKey(['a'])]: 2,
      [pathKey(['a', 0])]: 3
    })
    expect(keys.map(([k]) => k)).toEqual([pathKey(['a']), pathKey(['a', 0]), pathKey(['a', 0, 'b'])])
  })
})

describe('反向补丁', () => {
  it('取出被覆盖前的旧值', () => {
    const records = makeRecords()
    const edits: PatchMap = { 0: { [pathKey(['instruction'])]: '新' } }
    expect(invertEdits(records, edits)).toEqual({ 0: { [pathKey(['instruction'])]: '翻译' } })
  })

  it('路径原本不存在时旧值为 null', () => {
    const records = makeRecords()
    const edits: PatchMap = { 0: { [pathKey(['nope'])]: 'x' } }
    expect(invertEdits(records, edits)).toEqual({ 0: { [pathKey(['nope'])]: null } })
  })

  it('应用反向补丁可以回到原样', () => {
    const records = makeRecords()
    const edits: PatchMap = { 0: { [pathKey(['instruction'])]: '新' } }
    const inverse = invertEdits(records, edits)
    const patched = applyEdits(records, edits)
    const restored = applyEdits(patched, inverse)
    expect(restored[0].data.instruction).toBe('翻译')
  })
})

describe('合并补丁', () => {
  it('后者覆盖前者', () => {
    const base: PatchMap = { 0: { [pathKey(['a'])]: 1 } }
    const merged = mergeEdits(base, { 0: { [pathKey(['a'])]: 2, [pathKey(['b'])]: 3 } })
    expect(merged[0][pathKey(['a'])]).toBe(2)
    expect(merged[0][pathKey(['b'])]).toBe(3)
  })

  it('replace 列表里的记录整体替换', () => {
    const base: PatchMap = { 0: { [pathKey(['a'])]: 1, [pathKey(['b'])]: 2 } }
    const merged = mergeEdits(base, { 0: { [pathKey(['a'])]: 9 } }, ['0'])
    expect(merged[0]).toEqual({ [pathKey(['a'])]: 9 })
  })

  it('不修改入参', () => {
    const base: PatchMap = { 0: { [pathKey(['a'])]: 1 } }
    mergeEdits(base, { 0: { [pathKey(['a'])]: 2 } })
    expect(base[0][pathKey(['a'])]).toBe(1)
  })
})

describe('增删补丁项', () => {
  it('setPathValue 与 unsetPath', () => {
    let edits: PatchMap = {}
    edits = setPathValue(edits, '0', ['a'], 1)
    expect(patchSize(edits)).toBe(1)
    edits = unsetPath(edits, '0', ['a'])
    expect(Object.keys(edits)).toHaveLength(0)
  })

  it('值相同时 setPathValue 返回原对象', () => {
    const edits: PatchMap = { 0: { [pathKey(['a'])]: 1 } }
    expect(setPathValue(edits, '0', ['a'], 1)).toBe(edits)
  })

  it('dropRecordEdits 移除整条记录', () => {
    const edits: PatchMap = { 0: { [pathKey(['a'])]: 1 }, 1: { [pathKey(['a'])]: 2 } }
    expect(Object.keys(dropRecordEdits(edits, ['0']))).toEqual(['1'])
  })

  it('getEditedPaths 列出记录内被改的路径', () => {
    const edits: PatchMap = { 0: { [pathKey(['a'])]: 1, [pathKey(['b'])]: 2 } }
    expect(getEditedPaths(edits, '0')).toHaveLength(2)
    expect(getEditedPaths(edits, '9')).toHaveLength(0)
  })
})

describe('删除标记的变更', () => {
  it('正向：加入要删的下标', () => {
    const next = applyIndexDelta(new Set([0]), { add: [3], remove: [] }, 'do')
    expect([...next].sort()).toEqual([0, 3])
  })

  it('正向：移除恢复的下标', () => {
    const next = applyIndexDelta(new Set([0, 3]), { add: [], remove: [3] }, 'do')
    expect([...next]).toEqual([0])
  })

  it('撤销时 add / remove 对调', () => {
    // 删除第 3 条后撤销
    const afterDelete = applyIndexDelta(new Set(), { add: [3], remove: [] }, 'do')
    const afterUndo = applyIndexDelta(afterDelete, { add: [3], remove: [] }, 'undo')
    expect([...afterUndo]).toEqual([])

    // 恢复第 3 条后撤销
    const afterRestore = applyIndexDelta(new Set([3]), { add: [], remove: [3] }, 'do')
    const afterUndoRestore = applyIndexDelta(afterRestore, { add: [], remove: [3] }, 'undo')
    expect([...afterUndoRestore]).toEqual([3])
  })

  it('重做时按正向重新应用', () => {
    const next = applyIndexDelta(new Set(), { add: [7], remove: [] }, 'do')
    const undone = applyIndexDelta(next, { add: [7], remove: [] }, 'undo')
    const redone = applyIndexDelta(undone, { add: [7], remove: [] }, 'do')
    expect([...redone]).toEqual([7])
  })

  it('没有变更时返回原集合（避免多余的重渲染）', () => {
    const original = new Set([1, 2])
    expect(applyIndexDelta(original, undefined)).toBe(original)
    expect(applyIndexDelta(original, { add: [], remove: [] })).toBe(original)
  })

  it('不修改入参', () => {
    const original = new Set([1])
    applyIndexDelta(original, { add: [2], remove: [1] }, 'do')
    expect([...original]).toEqual([1])
  })
})

describe('恢复会话时过滤失效补丁', () => {
  it('丢弃记录不存在的补丁', () => {
    const records = makeRecords()
    const { edits, dropped } = filterValidEdits(records, { 77: { [pathKey(['a'])]: 1 } })
    expect(edits).toEqual({})
    expect(dropped).toBe(1)
  })

  it('丢弃字段不存在的补丁', () => {
    const records = makeRecords()
    const { edits, dropped } = filterValidEdits(records, {
      0: { [pathKey(['missing'])]: 1, [pathKey(['instruction'])]: 'ok' }
    })
    expect(dropped).toBe(1)
    expect(Object.keys(edits['0'])).toEqual([pathKey(['instruction'])])
  })

  it('丢弃数组下标越界的补丁', () => {
    const records = makeRecords()
    const { edits, dropped } = filterValidEdits(records, { 0: { [pathKey(['messages', 5, 'content'])]: 'x' } })
    expect(dropped).toBe(1)
    expect(edits).toEqual({})
  })

  it('保留仍然有效的补丁', () => {
    const records = makeRecords()
    const { edits, dropped } = filterValidEdits(records, {
      0: { [pathKey(['messages', 0, 'content'])]: '改过' }
    })
    expect(dropped).toBe(0)
    expect(edits['0'][pathKey(['messages', 0, 'content'])]).toBe('改过')
  })

  it('记录被整体删除后补丁不会残留空条目', () => {
    const records = makeRecords()
    const { edits } = filterValidEdits(records, { 0: { [pathKey(['nope'])]: 1 } })
    expect(edits['0']).toBeUndefined()
  })
})

describe('下标平移（中间插入 / 撤销新增）', () => {
  it('insert: 所有键 >= fromIndex 整体后移 1', () => {
    const before: PatchMap = {
      '0': { [pathKey(['a'])]: 1 },
      '1': { [pathKey(['a'])]: 2 },
      '2': { [pathKey(['a'])]: 3 }
    }
    expect(shiftPatchIndices(before, 1, 1, 'insert')).toEqual({
      '0': { [pathKey(['a'])]: 1 },
      '2': { [pathKey(['a'])]: 2 },
      '3': { [pathKey(['a'])]: 3 }
    })
  })

  it('remove: 所有键 > fromIndex 整体前移 1（撤销时不要把插入点自身的键挪过来）', () => {
    const after: PatchMap = {
      '0': { [pathKey(['a'])]: 1 },
      '2': { [pathKey(['a'])]: 2 },
      '3': { [pathKey(['a'])]: 3 }
    }
    // undo the insert at pos 1
    expect(shiftPatchIndices(after, 1, -1, 'remove')).toEqual({
      '0': { [pathKey(['a'])]: 1 },
      '1': { [pathKey(['a'])]: 2 },
      '2': { [pathKey(['a'])]: 3 }
    })
  })

  it('insert + remove 互为严格逆操作', () => {
    const before: PatchMap = {
      '0': { [pathKey(['a'])]: 1 },
      '5': { [pathKey(['b'])]: 2 }
    }
    const inserted = shiftPatchIndices(before, 3, 1, 'insert')
    const removed = shiftPatchIndices(inserted, 3, -1, 'remove')
    expect(removed).toEqual(before)
  })

  it('无受影响项时返回原对象（保持引用，便于 React 渲染跳过）', () => {
    const before: PatchMap = { '0': { [pathKey(['a'])]: 1 } }
    expect(shiftPatchIndices(before, 5, 1, 'insert')).toBe(before)
  })

  it('shiftIndexArray 在删除标记集上的行为', () => {
    expect(shiftIndexArray([0, 2, 4, 6], 3, 1, 'insert')).toEqual([0, 2, 5, 7])
    expect(shiftIndexArray([0, 2, 5, 7], 3, -1, 'remove')).toEqual([0, 2, 4, 6])
  })

  it('shiftAddedPos 移动后数组次序保持稳定', () => {
    const added: AddedRecord[] = [
      { pos: 0, data: { a: 1 } },
      { pos: 5, data: { a: 2 } },
      { pos: 2, data: { a: 3 } }
    ]
    const shifted = shiftAddedPos(added, 3, 1, 'insert')
    expect(shifted).toEqual([
      { pos: 0, data: { a: 1 } },
      { pos: 6, data: { a: 2 } },
      { pos: 2, data: { a: 3 } }
    ])
  })

  it('shiftAddedPos 撤销时用 > pos 防止把插入点自身 pos 也前移', () => {
    const added: AddedRecord[] = [
      { pos: 0, data: { a: 1 } },
      { pos: 2, data: { a: 2 } },
      { pos: 5, data: { a: 3 } }
    ]
    const removed = shiftAddedPos(added, 2, -1, 'remove')
    expect(removed).toEqual([
      { pos: 0, data: { a: 1 } },
      { pos: 2, data: { a: 2 } },
      { pos: 4, data: { a: 3 } }
    ])
  })
})

describe('mergeAddedIntoRecords', () => {
  const src: DataRecord[] = [
    { id: '0', index: 0, data: { a: 1 } },
    { id: '1', index: 1, data: { a: 2 } },
    { id: '2', index: 2, data: { a: 3 } }
  ]

  it('空 added 时只刷新 id / index / origin', () => {
    const out = mergeAddedIntoRecords(src, [])
    expect(out.map((r) => ({ id: r.id, index: r.index, origin: r.origin }))).toEqual([
      { id: '0', index: 0, origin: 'source' },
      { id: '1', index: 1, origin: 'source' },
      { id: '2', index: 2, origin: 'source' }
    ])
  })

  it('追加（pos = 末尾）', () => {
    const out = mergeAddedIntoRecords(src, [{ pos: 3, data: { a: 99 } }])
    expect(out).toHaveLength(4)
    expect(out[3]).toMatchObject({ id: '3', index: 3, origin: 'new', data: { a: 99 } })
  })

  it('中间插入：源记录下标后移，新增记录占住原 pos', () => {
    const out = mergeAddedIntoRecords(src, [{ pos: 1, data: { a: 99 } }])
    expect(out).toHaveLength(4)
    expect(out[1]).toMatchObject({ id: '1', index: 1, origin: 'new', data: { a: 99 } })
    expect(out[2]).toMatchObject({ id: '2', index: 2, origin: 'source', data: { a: 2 } })
    expect(out[3]).toMatchObject({ id: '3', index: 3, origin: 'source', data: { a: 3 } })
  })

  it('pos 越界（>= 合并后长度）会被夹到末尾', () => {
    const out = mergeAddedIntoRecords(src, [{ pos: 99, data: { a: 99 } }])
    expect(out[3]).toMatchObject({ id: '3', index: 3, origin: 'new' })
  })

  it('多处插入按 pos 升序拼好', () => {
    const out = mergeAddedIntoRecords(src, [
      { pos: 0, data: { a: 10 } },
      { pos: 2, data: { a: 20 } }
    ])
    expect(out.map((r) => r.data.a)).toEqual([10, 1, 20, 2, 3])
    expect(out.map((r) => r.origin)).toEqual(['new', 'source', 'new', 'source', 'source'])
  })

  it('不修改入参', () => {
    const added = [{ pos: 1, data: { a: 99 } }]
    const srcClone = src.map((r) => ({ ...r, data: { ...r.data } }))
    mergeAddedIntoRecords(src, added)
    expect(src).toEqual(srcClone)
    expect(added[0].data).toEqual({ a: 99 })
  })
})

describe('recordStatus', () => {
  it('deleted 优先级最高', () => {
    expect(recordStatus(0, false, {}, new Set([0]), new Set())).toBe('deleted')
  })
  it('new 优先于 confirmed', () => {
    expect(recordStatus(0, true, {}, new Set(), new Set([0]))).toBe('new')
  })
  it('confirmed 优先于 pending', () => {
    expect(recordStatus(0, false, { '0': { [pathKey(['a'])]: 1 } }, new Set(), new Set([0]))).toBe('confirmed')
  })
  it('edits 非空才算 pending', () => {
    expect(recordStatus(0, false, { '0': {} }, new Set(), new Set())).toBe('unmodified')
  })
  it('改过但没确认 = pending', () => {
    expect(recordStatus(0, false, { '0': { [pathKey(['a'])]: 1 } }, new Set(), new Set())).toBe('pending')
  })
  it('空 edits / 未确认 / 未删除 = unmodified', () => {
    expect(recordStatus(0, false, {}, new Set(), new Set())).toBe('unmodified')
  })
})

describe('newRecordIndexSet', () => {
  it('返回 added 所有 pos 的集合', () => {
    expect(newRecordIndexSet([{ pos: 0, data: {} }, { pos: 5, data: {} }])).toEqual(new Set([0, 5]))
  })
  it('空 added 返回空集', () => {
    expect(newRecordIndexSet([]).size).toBe(0)
  })
})

describe('shiftHistory', () => {
  const entry = (over: Partial<HistoryEntry> = {}): HistoryEntry => ({
    label: '编辑字段',
    forward: { '3': { [pathKey(['a'])]: 'x' } },
    inverse: { '3': { [pathKey(['a'])]: 'y' } },
    ...over
  })

  it('插入点之前的补丁不动', () => {
    const out = shiftHistory([entry()], 4, 1, 'insert')
    expect(out[0].forward).toEqual({ '3': { [pathKey(['a'])]: 'x' } })
  })

  it('插入点及其之后的补丁 +1', () => {
    const out = shiftHistory([entry()], 3, 1, 'insert')
    expect(Object.keys(out[0].forward)).toEqual(['4'])
    expect(Object.keys(out[0].inverse)).toEqual(['4'])
  })

  it('insert 与 remove 互为严格逆操作', () => {
    const before = [entry(), entry({ forward: { '7': { a: 1 } }, inverse: { '7': { a: 0 } } })]
    const after = shiftHistory(before, 3, 1, 'insert')
    const back = shiftHistory(after, 3, -1, 'remove')
    expect(back).toEqual(before)
  })

  it('删除标记与确认标记一起平移', () => {
    const out = shiftHistory(
      [
        entry({
          deleted: { add: [5], remove: [1] },
          confirmed: { add: [3], remove: [] }
        })
      ],
      3,
      1,
      'insert'
    )
    expect(out[0].deleted).toEqual({ add: [6], remove: [1] })
    expect(out[0].confirmed).toEqual({ add: [4], remove: [] })
  })

  it('entry 自带的 added.pos 也会平移', () => {
    const out = shiftHistory([entry({ added: { pos: 4, data: {} } })], 3, 1, 'insert')
    expect(out[0].added).toEqual({ pos: 5, data: {} })
  })

  it('没有任何下标受影响时返回原数组引用', () => {
    const before = [entry({ forward: { '0': { a: 1 } }, inverse: {} })]
    expect(shiftHistory(before, 5, 1, 'insert')).toBe(before)
  })

  it('delta 为 0 时返回原数组引用', () => {
    const before = [entry()]
    expect(shiftHistory(before, 0, 0)).toBe(before)
  })
})
