import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import type { WebContents } from 'electron'
import { pathKey } from '@shared/jsonpath'
import { quickFingerprint } from '@shared/parse'
import { templateToData } from '@shared/templates'
import { BUILTIN_TEMPLATES } from '@shared/types'
import type { FilterMode, RecordTemplate, ViewState } from '@shared/types'
import { cleanup, readText, writeFile } from './helpers'

function byTemplate(id: string): RecordTemplate {
  const found = BUILTIN_TEMPLATES.find((t) => t.id === id)
  if (!found) throw new Error(`内置模板里没有 ${id}`)
  return found
}

const mocks = vi.hoisted(() => ({ userData: '' as string }))

vi.mock('electron', () => ({
  app: {
    getPath: () => mocks.userData,
    getVersion: () => '0.0.0-test'
  }
}))

const { openSource, persist, runExport, dropWorkspace, getOriginal, getOriginalValues, refreshSourceState } =
  await import('../electron/main/workspace')
const {
  loadSession,
  saveSession,
  listSessions,
  deleteSession,
  makeSessionId,
  sessionsDir,
  isSessionId,
  sanitizeDeleted,
  patchSession
} = await import('../electron/main/store')

const sender = { send: () => undefined } as unknown as WebContents

const LINES = [
  JSON.stringify({ instruction: '翻译', output: '你好' }),
  JSON.stringify({ instruction: '总结', output: '摘要' }),
  JSON.stringify({ instruction: '改写', output: '新句子' })
]

function view(overrides: Partial<ViewState> = {}): ViewState {
  return { selectedIndex: 0, scrollTop: 0, filter: 'all', query: '', selectedIds: [], ...overrides }
}

beforeAll(async () => {
  mocks.userData = await fsp.mkdtemp(path.join(os.tmpdir(), 'corpuseditor-session-'))
})

// cleanup() 只清 helpers 建的 corpuseditor-test-*，这里自建的 userData 目录得自己收掉
afterAll(async () => {
  await cleanup()
  await fsp.rm(mocks.userData, { recursive: true, force: true }).catch(() => {})
})

describe('会话创建与恢复', () => {
  it('会话 id 只由文件路径决定，与内容变化无关', async () => {
    const file = await writeFile('id.jsonl', LINES.join('\n'))
    const first = makeSessionId(file)
    await fsp.writeFile(file, `${LINES.join('\n')}\n${JSON.stringify({ instruction: 'x', output: 'y' })}`)
    expect(makeSessionId(file)).toBe(first)
    expect(first).toMatch(/^[a-f0-9]{32}$/)
  })

  it('首次打开创建会话，没有编辑记录', async () => {
    const file = await writeFile('first.jsonl', LINES.join('\n'))
    const opened = await openSource({ filePath: file, sender })
    expect(opened.resumed).toBe(false)
    expect(opened.sourceChanged).toBe(false)
    expect(opened.recordCount).toBe(3)
    expect(Object.keys(opened.edits)).toHaveLength(0)
    expect(opened.fieldOrder).toEqual(['instruction', 'output'])
    const stored = await loadSession(opened.sessionId)
    expect(stored?.recordCount).toBe(3)
    expect(stored?.source.path).toBe(file)
  })

  it('编辑 → 保存 → 重新打开：改动、删除标记与视图状态都还在', async () => {
    const file = await writeFile('resume.jsonl', LINES.join('\n'))
    const first = await openSource({ filePath: file, sender })

    await persist({
      sessionId: first.sessionId,
      edits: { 1: { [pathKey(['output'])]: '改过的输出' } },
      deleted: [2],
      view: view({ selectedIndex: 1, scrollTop: 137, filter: 'pending', query: '翻译' })
    })

    dropWorkspace(first.sessionId) // 模拟进程退出，内存中的工作区消失

    const second = await openSource({ filePath: file, sender })
    expect(second.resumed).toBe(true)
    expect(second.sourceChanged).toBe(false)
    expect(second.edits['1'][pathKey(['output'])]).toBe('改过的输出')
    expect(second.deleted).toEqual([2])
    expect(second.view?.selectedIndex).toBe(1)
    expect(second.view?.scrollTop).toBe(137)
    expect(second.view?.filter).toBe('pending')
    expect(second.view?.query).toBe('翻译')
  })

  it('老会话里存的 filter: modified 会被迁到 pending', async () => {
    const file = await writeFile('legacy-filter.jsonl', LINES.join('\n'))
    const first = await openSource({ filePath: file, sender })

    await persist({
      sessionId: first.sessionId,
      // 老版本落盘的字符串，类型上已经不存在了，这里模拟读回旧数据
      view: view({ filter: 'modified' as FilterMode })
    })
    const stored = await patchSession(first.sessionId, {})
    expect(stored?.view.filter).toBe('pending')
  })

  it('新增记录与已确认下标会随会话一起恢复', async () => {
    const file = await writeFile('added.jsonl', LINES.join('\n'))
    const first = await openSource({ filePath: file, sender })

    await persist({
      sessionId: first.sessionId,
      added: [{ pos: 1, data: { instruction: '新建的', output: '' } }],
      confirmed: [0, 2]
    })
    dropWorkspace(first.sessionId)

    const second = await openSource({ filePath: file, sender })
    expect(second.recordCount).toBe(LINES.length + 1)
    expect(second.added).toEqual([{ pos: 1, data: { instruction: '新建的', output: '' } }])
    expect(second.confirmed).toEqual([0, 2])
    // 合并后的序列里，第 2 条（下标 1）应该是新建的那条
    expect(second.fieldOrder).toContain('instruction')
  })

  it('按字段模板新建的记录：字段骨架能落盘并重开恢复', async () => {
    const file = await writeFile('from-template.jsonl', LINES.join('\n'))
    const opened = await openSource({ filePath: file, sender })

    // ShareGPT from/value 模板：骨架里的键名是 from / value，角色是 human / gpt
    const data = templateToData(byTemplate('sharegpt').fields)
    expect(data.conversations).toEqual([
      { from: 'human', value: '' },
      { from: 'gpt', value: '' }
    ])

    await persist({ sessionId: opened.sessionId, added: [{ pos: 3, data }] })
    dropWorkspace(opened.sessionId)

    const reopened = await openSource({ filePath: file, sender })
    expect(reopened.recordCount).toBe(LINES.length + 1)
    expect(reopened.added).toHaveLength(1)
    // 键名必须是 from / value —— 若退化成 role / content，导出后会和数据集结构对不上
    expect(reopened.added?.[0].data.conversations).toEqual([
      { from: 'human', value: '' },
      { from: 'gpt', value: '' }
    ])
    // 新字段要被扫进字段顺序，否则界面上这一列不会显示
    expect(reopened.fieldOrder).toContain('conversations')
  })

  it('按 Alpaca 模板新建的记录：字段顺序与声明一致', async () => {
    const file = await writeFile('alpaca-template.jsonl', LINES.join('\n'))
    const opened = await openSource({ filePath: file, sender })
    const data = templateToData(byTemplate('alpaca').fields)
    expect(Object.keys(data)).toEqual(['instruction', 'input', 'output'])
    await persist({ sessionId: opened.sessionId, added: [{ pos: 0, data }] })
    dropWorkspace(opened.sessionId)

    const reopened = await openSource({ filePath: file, sender })
    expect(Object.keys(reopened.added?.[0].data ?? {})).toEqual(['instruction', 'input', 'output'])
  })

  it('多次增量保存会累积而不是互相覆盖', async () => {
    const file = await writeFile('incremental.jsonl', LINES.join('\n'))
    const opened = await openSource({ filePath: file, sender })
    await persist({ sessionId: opened.sessionId, edits: { 0: { [pathKey(['instruction'])]: 'A' } } })
    await persist({ sessionId: opened.sessionId, edits: { 0: { [pathKey(['output'])]: 'B' } } })
    const stored = await loadSession(opened.sessionId)
    expect(stored?.edits['0'][pathKey(['instruction'])]).toBe('A')
    expect(stored?.edits['0'][pathKey(['output'])]).toBe('B')
  })

  it('把值改回原样后，该条记录不再算作已修改', async () => {
    const file = await writeFile('revert.jsonl', LINES.join('\n'))
    const opened = await openSource({ filePath: file, sender })
    await persist({ sessionId: opened.sessionId, edits: { 0: { [pathKey(['output'])]: '改动' } } })
    expect((await loadSession(opened.sessionId))?.edits['0']).toBeDefined()

    const result = await persist({ sessionId: opened.sessionId, edits: { 0: { [pathKey(['output'])]: '你好' } } })
    expect(result.cleared).toContain('0')
    expect((await loadSession(opened.sessionId))?.edits['0']).toBeUndefined()
  })

  it('传 null 可以整条删除某记录的编辑', async () => {
    const file = await writeFile('clear.jsonl', LINES.join('\n'))
    const opened = await openSource({ filePath: file, sender })
    await persist({ sessionId: opened.sessionId, edits: { 1: { [pathKey(['output'])]: 'x' } } })
    await persist({ sessionId: opened.sessionId, edits: { 1: null } })
    expect((await loadSession(opened.sessionId))?.edits['1']).toBeUndefined()
  })

  it('fresh 重新打开会丢弃全部改动', async () => {
    const file = await writeFile('reset.jsonl', LINES.join('\n'))
    const opened = await openSource({ filePath: file, sender })
    await persist({ sessionId: opened.sessionId, edits: { 0: { [pathKey(['output'])]: 'x' } } })
    dropWorkspace(opened.sessionId)
    const fresh = await openSource({ filePath: file, sender, fresh: true })
    expect(fresh.resumed).toBe(false)
    expect(Object.keys(fresh.edits)).toHaveLength(0)
    expect(Object.keys((await loadSession(opened.sessionId))?.edits ?? {})).toHaveLength(0)
  })
})

describe('源文件变化后的恢复', () => {
  it('源文件被改动：仍恢复会话，但对不上位置的改动被丢弃并提示', async () => {
    const file = await writeFile('changed.jsonl', LINES.join('\n'))
    const first = await openSource({ filePath: file, sender })
    await persist({ sessionId: first.sessionId, edits: { 0: { [pathKey(['output'])]: '保持的改动' } } })
    dropWorkspace(first.sessionId)

    // 改动源文件：删掉 output 字段
    await fsp.writeFile(
      file,
      [JSON.stringify({ instruction: '翻译' }), JSON.stringify({ instruction: '总结' })].join('\n')
    )

    const second = await openSource({ filePath: file, sender })
    expect(second.sourceChanged).toBe(true)
    expect(second.warnings.some((w) => w.code === 'SESSION_EDITS_DROPPED')).toBe(true)
    expect(second.edits['0']).toBeUndefined()
  })

  it('refreshSourceState 能发现源文件被改动或删除', async () => {
    const file = await writeFile('verify.jsonl', LINES.join('\n'))
    const opened = await openSource({ filePath: file, sender })
    expect(await refreshSourceState(opened.sessionId)).toEqual({ intact: true, missing: false })

    await fsp.writeFile(file, `${LINES.join('\n')}\n`)
    expect((await refreshSourceState(opened.sessionId)).intact).toBe(false)

    await fsp.rm(file, { force: true })
    expect((await refreshSourceState(opened.sessionId)).missing).toBe(true)
  })

  it('源文件缺失时打开会直接报错', async () => {
    const file = await writeFile('gone.jsonl', LINES.join('\n'))
    await openSource({ filePath: file, sender })
    await fsp.rm(file, { force: true })
    await expect(openSource({ filePath: file, sender })).rejects.toBeTruthy()
  })
})

describe('原始值读取', () => {
  it('getOriginal 返回未受编辑影响的原始内容', async () => {
    const file = await writeFile('original.jsonl', LINES.join('\n'))
    const opened = await openSource({ filePath: file, sender })
    await persist({ sessionId: opened.sessionId, edits: { 0: { [pathKey(['output'])]: '改了' } } })
    const original = getOriginal(opened.sessionId, '0')
    expect(original?.output).toBe('你好')
  })

  it('getOriginalValues 支持批量取值', async () => {
    const file = await writeFile('originals.jsonl', LINES.join('\n'))
    const opened = await openSource({ filePath: file, sender })
    const values = await Promise.resolve(
      getOriginalValues(opened.sessionId, [
        { recordId: '0', pathKey: pathKey(['output']) },
        { recordId: '1', pathKey: pathKey(['output']) },
        { recordId: '99', pathKey: pathKey(['output']) }
      ])
    )
    expect(values).toEqual(['你好', '摘要', null])
  })
})

describe('导出', () => {
  it('拒绝导出到源文件路径', async () => {
    const file = await writeFile('export-src.jsonl', LINES.join('\n'))
    const opened = await openSource({ filePath: file, sender })
    await expect(
      runExport({
        sessionId: opened.sessionId,
        config: {
          format: 'jsonl',
          columns: [{ id: 'a', label: 'instruction', path: ['instruction'], enabled: true }],
          scope: 'all',
          indent: null,
          delimiter: ',',
          flattenIndent: null,
          includeIndex: false
        },
        destPath: file,
        scope: 'all',
        ids: []
      })
    ).rejects.toThrow('CE:EXPORT_TO_SOURCE')
  })

  it('导出会应用已保存的改动，并跳过被删除的记录', async () => {
    const file = await writeFile('export-run.jsonl', LINES.join('\n'))
    const opened = await openSource({ filePath: file, sender })
    await persist({
      sessionId: opened.sessionId,
      edits: {
        0: { [pathKey(['output'])]: '改过的输出' }
      },
      deleted: [1]
    })
    const dest = path.join(path.dirname(file), 'exported.jsonl')
    const result = await runExport({
      sessionId: opened.sessionId,
      config: {
        format: 'jsonl',
        columns: [
          { id: 'a', label: 'instruction', path: ['instruction'], enabled: true },
          { id: 'b', label: 'output', path: ['output'], enabled: true }
        ],
        scope: 'all',
        indent: null,
        delimiter: ',',
        flattenIndent: null,
        includeIndex: false
      },
      destPath: dest,
      scope: 'all',
      ids: []
    })
    expect(result.recordCount).toBe(2)
    const lines = (await readText(dest)).trim().split('\n')
    expect(JSON.parse(lines[0]).output).toBe('改过的输出')
    expect(JSON.parse(lines[0]).instruction).toBe('翻译')
    expect(JSON.parse(lines[1]).instruction).toBe('改写')
    // 源文件依旧是原样
    const sourceLines = (await readText(file)).trim().split('\n')
    expect(JSON.parse(sourceLines[0]).output).toBe('你好')
  })

  it('scope=modified 只导出改过的记录', async () => {
    const file = await writeFile('export-modified.jsonl', LINES.join('\n'))
    const opened = await openSource({ filePath: file, sender })
    await persist({ sessionId: opened.sessionId, edits: { 2: { [pathKey(['output'])]: '只改这条' } } })
    const dest = path.join(path.dirname(file), 'modified.jsonl')
    const result = await runExport({
      sessionId: opened.sessionId,
      config: {
        format: 'jsonl',
        columns: [{ id: 'a', label: 'output', path: ['output'], enabled: true }],
        scope: 'modified',
        indent: null,
        delimiter: ',',
        flattenIndent: null,
        includeIndex: false
      },
      destPath: dest,
      scope: 'modified',
      ids: []
    })
    expect(result.recordCount).toBe(1)
    expect(JSON.parse((await readText(dest)).trim()).output).toBe('只改这条')
  })

  it('scope=selected 只导出勾选的那几条（按 id 精确取）', async () => {
    const file = await writeFile('export-selected.jsonl', LINES.join('\n'))
    const opened = await openSource({ filePath: file, sender })
    await persist({ sessionId: opened.sessionId, deleted: [1] })
    const dest = path.join(path.dirname(file), 'selected.jsonl')
    const config = {
      format: 'jsonl' as const,
      columns: [{ id: 'a', label: 'instruction', path: ['instruction'], enabled: true }],
      scope: 'selected' as const,
      indent: null,
      delimiter: ',',
      flattenIndent: null,
      includeIndex: false
    }
    const result = await runExport({
      sessionId: opened.sessionId,
      config,
      destPath: dest,
      scope: 'selected',
      ids: ['0', '2']
    })
    expect(result.recordCount).toBe(2)
    // 勾选的和删除标记是两套过滤，都要生效：这里 1 既没勾又被删，2 只勾了
    const rows = (await readText(dest)).trim().split('\n').map((l) => JSON.parse(l).instruction)
    expect(rows).toEqual(['翻译', '改写'])
  })

  it('导出后记住上次导出路径与列配置', async () => {
    const file = await writeFile('export-remember.jsonl', LINES.join('\n'))
    const opened = await openSource({ filePath: file, sender })
    const dest = path.join(path.dirname(file), 'remember.jsonl')
    const config = {
      format: 'jsonl' as const,
      columns: [{ id: 'a', label: 'instruction', path: ['instruction'], enabled: true }],
      scope: 'all' as const,
      indent: null,
      delimiter: ',',
      flattenIndent: null,
      includeIndex: false
    }
    await runExport({ sessionId: opened.sessionId, config, destPath: dest, scope: 'all', ids: [] })
    const stored = await loadSession(opened.sessionId)
    expect(stored?.lastExportPath).toBe(dest)
    expect(stored?.exportConfig?.columns).toHaveLength(1)
  })
})

describe('会话列表管理', () => {
  it('列出会话摘要，含修改数与源文件完好状态', async () => {
    const file = await writeFile('list.jsonl', LINES.join('\n'))
    const opened = await openSource({ filePath: file, sender })
    await persist({ sessionId: opened.sessionId, edits: { 0: { [pathKey(['output'])]: 'x' } } })

    const sessions = await listSessions()
    const found = sessions.find((s) => s.id === opened.sessionId)
    expect(found).toBeDefined()
    expect(found?.modifiedCount).toBe(1)
    expect(found?.recordCount).toBe(3)
    expect(found?.sourceIntact).toBe(true)
    expect(found?.sourceMissing).toBe(false)
  })

  it('删除会话后从列表消失', async () => {
    const file = await writeFile('forget.jsonl', LINES.join('\n'))
    const opened = await openSource({ filePath: file, sender })
    await deleteSession(opened.sessionId)
    const sessions = await listSessions()
    expect(sessions.find((s) => s.id === opened.sessionId)).toBeUndefined()
  })

  it('会话文件存放在 userData/sessions 下，与源文件分离', async () => {
    const file = await writeFile('location.jsonl', LINES.join('\n'))
    const opened = await openSource({ filePath: file, sender })
    const target = path.join(sessionsDir(), `${opened.sessionId}.json`)
    expect(sessionsDir().startsWith(mocks.userData)).toBe(true)
    await expect(fsp.stat(target)).resolves.toBeTruthy()
    expect(path.dirname(file)).not.toBe(sessionsDir())
  })
})

describe('原文件保护', () => {
  it('整个打开—编辑—导出流程结束后源文件字节不变', async () => {
    const file = await writeFile('protected.jsonl', LINES.join('\n'))
    const before = await fsp.stat(file)
    const beforeFp = await quickFingerprint(file, before.size)

    const opened = await openSource({ filePath: file, sender })
    await persist({ sessionId: opened.sessionId, edits: { 0: { [pathKey(['output'])]: '改了' } } })
    await runExport({
      sessionId: opened.sessionId,
      config: {
        format: 'jsonl',
        columns: [{ id: 'a', label: 'output', path: ['output'], enabled: true }],
        scope: 'all',
        indent: null,
        delimiter: ',',
        flattenIndent: null,
        includeIndex: false
      },
      destPath: path.join(path.dirname(file), 'out.jsonl'),
      scope: 'all',
      ids: []
    })

    const after = await fsp.stat(file)
    expect(after.size).toBe(before.size)
    expect(after.mtimeMs).toBe(before.mtimeMs)
    expect(await quickFingerprint(file, after.size)).toBe(beforeFp)
  })
})

describe('删除安全性', () => {
  it('会话 id 有严格格式要求', () => {
    expect(isSessionId(makeSessionId('/some/file.jsonl'))).toBe(true)
    expect(isSessionId('../../settings')).toBe(false)
    expect(isSessionId('anything')).toBe(false)
    expect(isSessionId('')).toBe(false)
    expect(isSessionId(null)).toBe(false)
    expect(isSessionId(42)).toBe(false)
  })

  it('非法的会话 id 不会被拼成删除路径', async () => {
    const settingsFile = path.join(mocks.userData, 'settings.json')
    await fsp.writeFile(settingsFile, '{"probe":true}', 'utf8')
    const before = await fsp.readdir(sessionsDir()).catch(() => [])

    // 模拟被伪造的 IPC 入参
    expect(await deleteSession('../../settings')).toBe(false)
    expect(await deleteSession('../../settings.json')).toBe(false)
    expect(await deleteSession('anything')).toBe(false)
    expect(await deleteSession('')).toBe(false)

    await expect(fsp.stat(settingsFile)).resolves.toBeTruthy() // 没被删掉
    expect(await fsp.readdir(sessionsDir()).catch(() => [])).toEqual(before)
  })

  it('合法 id 的删除只作用在自己的会话文件上', async () => {
    const file = await writeFile('scoped.jsonl', LINES.join('\n'))
    const opened = await openSource({ filePath: file, sender })
    const target = path.join(sessionsDir(), `${opened.sessionId}.json`)
    await expect(fsp.stat(target)).resolves.toBeTruthy()

    expect(await deleteSession(opened.sessionId)).toBe(true)
    await expect(fsp.stat(target)).rejects.toBeTruthy()

    // 源文件与其它会话不受影响
    await expect(fsp.stat(file)).resolves.toBeTruthy()
    await expect(fsp.stat(path.join(mocks.userData, 'settings.json'))).resolves.toBeTruthy()
  })

  it('删除标记经过清洗，非法值不会落盘', () => {
    expect(sanitizeDeleted([1, 1, 0])).toEqual([0, 1])
    expect(sanitizeDeleted([5, -1, 2.5, Number.NaN, '2' as never, null as never])).toEqual([5])
    expect(sanitizeDeleted(undefined)).toEqual([])
    expect(sanitizeDeleted('nope')).toEqual([])
  })

  it('落盘的删除标记是清洗后的结果', async () => {
    const file = await writeFile('del-sanitize.jsonl', LINES.join('\n'))
    const opened = await openSource({ filePath: file, sender })
    await persist({
      sessionId: opened.sessionId,
      deleted: [1, 1, -3, 2.5, 0, '2' as never] as number[]
    })
    expect((await loadSession(opened.sessionId))?.deleted).toEqual([0, 1])
  })

  it('导出会跳过被标记删除的记录', async () => {
    const file = await writeFile('del-export.jsonl', LINES.join('\n'))
    const opened = await openSource({ filePath: file, sender })
    await persist({ sessionId: opened.sessionId, deleted: [1] })
    const dest = path.join(path.dirname(file), 'without-deleted.jsonl')
    const result = await runExport({
      sessionId: opened.sessionId,
      config: {
        format: 'jsonl',
        columns: [{ id: 'a', label: 'instruction', path: ['instruction'], enabled: true }],
        scope: 'all',
        indent: null,
        delimiter: ',',
        flattenIndent: null,
        includeIndex: false
      },
      destPath: dest,
      scope: 'all',
      ids: []
    })
    expect(result.recordCount).toBe(2)
    const lines = (await readText(dest)).trim().split('\n')
    expect(JSON.parse(lines[0]).instruction).toBe('翻译')
    expect(JSON.parse(lines[1]).instruction).toBe('改写') // 下标 1（总结）被排除
    // 源文件仍然完好
    expect((await readText(file)).trim().split('\n')).toHaveLength(3)
  })

  it('源文件变化后删除标记整体作废并给出提示', async () => {
    const file = await writeFile('del-shift.jsonl', LINES.join('\n'))
    const first = await openSource({ filePath: file, sender })
    await persist({ sessionId: first.sessionId, deleted: [1] })
    dropWorkspace(first.sessionId)

    // 在开头插入一条，所有下标都会平移
    await fsp.writeFile(file, [JSON.stringify({ instruction: '新增', output: 'x' }), ...LINES].join('\n'))

    const second = await openSource({ filePath: file, sender })
    expect(second.sourceChanged).toBe(true)
    expect(second.deleted).toEqual([])
    expect(second.warnings.some((w) => w.code === 'SESSION_DELETES_CLEARED')).toBe(true)
    // 磁盘上也确实是清空的
    expect((await loadSession(second.sessionId))?.deleted).toEqual([])
  })

  it('源文件没变时删除标记照常保留', async () => {
    const file = await writeFile('del-keep.jsonl', LINES.join('\n'))
    const first = await openSource({ filePath: file, sender })
    await persist({ sessionId: first.sessionId, deleted: [1] })
    dropWorkspace(first.sessionId)

    const second = await openSource({ filePath: file, sender })
    expect(second.sourceChanged).toBe(false)
    expect(second.deleted).toEqual([1])
  })

  it('源文件缩短时删除标记整体作废，而不是静默套用到别的记录上', async () => {
    const file = await writeFile('del-shrink.jsonl', LINES.join('\n'))
    const first = await openSource({ filePath: file, sender })
    await persist({ sessionId: first.sessionId, deleted: [0, 2] })
    dropWorkspace(first.sessionId)

    // 只凭行数无法区分「尾部截断」和「中间删掉一行」，下标都可能已经错位
    await fsp.writeFile(file, LINES.slice(0, 2).join('\n'))
    const second = await openSource({ filePath: file, sender })
    expect(second.recordCount).toBe(2)
    expect(second.sourceChanged).toBe(true)
    expect(second.deleted).toEqual([])
    expect(second.warnings.some((w) => w.code === 'SESSION_DELETES_CLEARED')).toBe(true)
  })

  it('内容未变时，越界的删除标记只是被裁掉而不是整体作废', async () => {
    const file = await writeFile('del-clamp.jsonl', LINES.join('\n'))
    const opened = await openSource({ filePath: file, sender })
    // 写盘模拟「会话里混进了一个越界下标」这种异常数据
    const state = await loadSession(opened.sessionId)
    expect(state).not.toBeNull()
    if (state) {
      state.deleted = [0, 99]
      await saveSession(state)
    }
    dropWorkspace(opened.sessionId)

    const reopened = await openSource({ filePath: file, sender })
    expect(reopened.sourceChanged).toBe(false)
    expect(reopened.deleted).toEqual([0])
  })

  it('不能导出到源文件本身', async () => {
    const file = await writeFile('no-self.jsonl', LINES.join('\n'))
    const opened = await openSource({ filePath: file, sender })
    await expect(
      runExport({
        sessionId: opened.sessionId,
        config: {
          format: 'jsonl',
          columns: [{ id: 'a', label: 'output', path: ['output'], enabled: true }],
          scope: 'all',
          indent: null,
          delimiter: ',',
          flattenIndent: null,
          includeIndex: false
        },
        destPath: file,
        scope: 'all',
        ids: []
      })
    ).rejects.toThrow('CE:EXPORT_TO_SOURCE')
    expect((await readText(file)).trim().split('\n')).toHaveLength(3)
  })

  it('不能导出到应用的进度目录', async () => {
    const file = await writeFile('no-sessions.jsonl', LINES.join('\n'))
    const opened = await openSource({ filePath: file, sender })
    const config = {
      format: 'jsonl' as const,
      columns: [{ id: 'a', label: 'output', path: ['output'], enabled: true }],
      scope: 'all' as const,
      indent: null,
      delimiter: ',',
      flattenIndent: null,
      includeIndex: false
    }
    await expect(
      runExport({
        sessionId: opened.sessionId,
        config,
        destPath: path.join(sessionsDir(), 'session.json'),
        scope: 'all',
        ids: []
      })
    ).rejects.toThrow('CE:EXPORT_TO_SESSIONS_DIR')

    // 会话文件仍然健在
    await expect(fsp.stat(path.join(sessionsDir(), `${opened.sessionId}.json`))).resolves.toBeTruthy()
  })

  it('列表会跳过不是本应用产生的文件', async () => {
    await fsp.writeFile(path.join(sessionsDir(), 'not-a-session.json'), '{"hello":1}', 'utf8')
    const sessions = await listSessions()
    expect(sessions.every((s) => isSessionId(s.id))).toBe(true)
  })
})
