#!/usr/bin/env node
/**
 * 端到端冒烟 —— 启动真实的主进程产物（out/main/index.js），拦截文件对话框，
 * 走一遍「打开 → 编辑 → 替换 → 删除 → 确认 → 新增 → 导出 → 恢复」的完整流程。
 *
 *   npm run build && node tests/e2e/smoke.mjs
 *
 * 为什么不写进 vitest：单测跑在 node 环境、用 stub 替换模块，覆盖不到真实模块图。
 * 这里要的就是「把 out/ 真的跑起来、真的读写磁盘文件」，所以单独一个脚本。
 * 脚本只 mock 掉 electron 本身（窗口 / 对话框 / app），业务代码一行都不替换。
 */

import fsp from 'node:fs/promises'
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import os from 'node:os'
import { createRequire } from 'node:module'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(here, '../..')
const mainEntry = path.join(root, 'out/main/index.js')

import { createFakeElectron, chunksFor as chunksForPushed } from './fake-electron.mjs'

const require = createRequire(import.meta.url)

/* ------------------------------------------------------------------ *
 * 断言与计数
 * ------------------------------------------------------------------ */
let passed = 0
const failures = []

async function check(name, fn) {
  try {
    await fn()
    passed += 1
    console.log(`  ✓ ${name}`)
  } catch (err) {
    failures.push({ name, err })
    console.log(`  ✗ ${name}`)
    console.log(`      ${err.message.split('\n')[0]}`)
  }
}

function assert(cond, message) {
  if (!cond) throw new Error(message)
}

function assertEqual(actual, expected, message) {
  if (actual !== expected) {
    throw new Error(`${message} —— 期望 ${JSON.stringify(expected)}，实际 ${JSON.stringify(actual)}`)
  }
}

async function assertThrows(fn, matcher, message) {
  let threw = null
  try {
    await fn()
  } catch (err) {
    threw = err
  }
  if (!threw) throw new Error(`${message} —— 没有抛错`)
  if (matcher && !matcher.test(threw.message)) {
    throw new Error(`${message} —— 抛了别的错：${threw.message}`)
  }
}

/* ------------------------------------------------------------------ *
 * 假的 electron：只替换窗口 / 对话框 / app，业务代码原样运行
 * 与 tests/gui/seed.mjs 共用 tests/e2e/fake-electron.mjs
 * ------------------------------------------------------------------ */
const userData = await fsp.mkdtemp(path.join(os.tmpdir(), 'corpuseditor-smoke-userdata-'))
const sandbox = await fsp.mkdtemp(path.join(os.tmpdir(), 'corpuseditor-smoke-data-'))

const {
  handlers,
  pushed,
  dialogAnswers,
  install: installFakeElectron,
  call,
  settled
} = createFakeElectron({ userData, fallbackDir: sandbox, version: '0.0.0-smoke' })
installFakeElectron()

/** 取出某个 session 推给渲染进程的全部记录（dataset:chunk 是分批推的） */
function chunksFor(sessionId) {
  return chunksForPushed(pushed, sessionId)
}

function resetChunks() {
  pushed.length = 0
}

async function openFile(filePath, fresh = false) {
  resetChunks()
  const result = await call('source:open', { filePath, fresh })
  return { ...result, records: chunksFor(result.sessionId) }
}

/* ------------------------------------------------------------------ *
 * 测试数据
 * ------------------------------------------------------------------ */
const SOURCE_ROWS = [
  { instruction: '把下面这句话翻译成英文', input: '你好，世界', output: 'Hello, world' },
  { instruction: '把下面这句话翻译成英文', input: '今天天气不错', output: 'The weather is nice' },
  { instruction: '把下面这句话翻译成英文', input: '谢谢你的帮助', output: 'Thank you for your help' },
  { instruction: '把下面这句话翻译成英文', input: '我在学中文', output: 'I am learning Chinese' },
  { instruction: '把下面这句话翻译成英文', input: '这本书很有意思', output: 'This book is interesting' },
  { instruction: '把下面这句话翻译成英文', input: '明天见', output: 'See you tomorrow' }
]

const sourcePath = path.join(sandbox, 'sft-sample.jsonl')
await fsp.writeFile(
  sourcePath,
  SOURCE_ROWS.map((row) => JSON.stringify(row)).join('\n') + '\n',
  'utf8'
)

const sha256 = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')
const sourceHashBefore = sha256(sourcePath)

const readLines = async (file) =>
  (await fsp.readFile(file, 'utf8')).split('\n').filter((line) => line.trim().length > 0)

/** 模拟渲染进程的批量替换：对每条记录的 output 做字符串替换，产出补丁。 */
function replaceInOutputs(records, from, to) {
  const edits = {}
  for (const record of records) {
    const current = record.data?.output
    if (typeof current !== 'string' || !current.includes(from)) continue
    edits[record.id] = { [JSON.stringify(['output'])]: current.replaceAll(from, to) }
  }
  return edits
}

/**
 * 模拟渲染进程「插入一条记录」。
 * 下标平移是渲染进程的责任（store.ts 的 shiftRecordSequence）—— 主进程只负责原样持久化，
 * 所以这里要连 edits / deleted / confirmed 一起平移后再交给 persist，才等价于真实操作。
 */
async function simulateInsert(state, pos, data) {
  const edits = {}
  for (const [id, entry] of Object.entries(state.edits ?? {})) {
    const index = Number(id)
    if (index >= pos) {
      edits[id] = null // 旧位置清空
      edits[String(index + 1)] = entry
    } else {
      edits[id] = entry
    }
  }
  return call('session:persist', {
    sessionId: state.sessionId,
    edits,
    deleted: (state.deleted ?? []).map((i) => (i >= pos ? i + 1 : i)),
    confirmed: (state.confirmed ?? []).map((i) => (i >= pos ? i + 1 : i)),
    added: [{ pos, data }]
  })
}

/** 反向操作：撤销一次新增。 */
async function simulateRemoveAdded(state, pos) {
  const edits = {}
  for (const [id, entry] of Object.entries(state.edits ?? {})) {
    const index = Number(id)
    if (index === pos) continue
    edits[id] = null
    edits[String(index > pos ? index - 1 : index)] = entry
  }
  return call('session:persist', {
    sessionId: state.sessionId,
    edits,
    deleted: (state.deleted ?? [])
      .filter((i) => i !== pos)
      .map((i) => (i > pos ? i - 1 : i)),
    confirmed: (state.confirmed ?? [])
      .filter((i) => i !== pos)
      .map((i) => (i > pos ? i - 1 : i)),
    added: []
  })
}

/* ------------------------------------------------------------------ *
 * 开始
 * ------------------------------------------------------------------ */
console.log('\nCorpusEditor 端到端冒烟\n')

console.log('环境')
let info = null

await check('构建产物 out/main/index.js 存在', () => {
  assert(fs.existsSync(mainEntry), 'out/main/index.js 不存在，先跑 npm run build')
})

// 加载主进程产物：registerIpc 是在 app.whenReady() 的微任务里跑的，等两个 tick
require(mainEntry)
await new Promise((resolve) => setImmediate(resolve))
await new Promise((resolve) => setImmediate(resolve))

await check('主进程注册了 IPC 通道', () => {
  assert(handlers.size >= 18, `只注册了 ${handlers.size} 条通道`)
})

await check('app:info 返回版本与 userData', async () => {
  info = await call('app:info')
  assertEqual(info.version, '0.0.0-smoke', '版本号不对')
  assertEqual(info.userData, userData, 'userData 路径不对')
})

console.log('\n打开数据文件')

let opened = null

await check('打开 JSONL：记录数与字段顺序正确', async () => {
  opened = await openFile(sourcePath)
  assertEqual(opened.recordCount, 6, '记录数不对')
  assertEqual(opened.source.format, 'jsonl', '格式识别不对')
  assertEqual(opened.fieldOrder[0], 'instruction', '字段顺序不对')
  assertEqual(opened.fieldOrder.length, 3, '字段数量不对')
})

await check('分块推送把 6 条记录都送到了渲染进程', () => {
  assertEqual(opened.records.length, 6, '收到的记录数不对')
  assertEqual(opened.records[0].data.input, '你好，世界', '第一条内容不对')
})

await check('会话文件已落盘，id 是 32 位十六进制', async () => {
  assert(/^[a-f0-9]{32}$/.test(opened.sessionId), `sessionId 形状不对：${opened.sessionId}`)
  const listing = await fsp.readdir(path.join(userData, 'sessions'))
  assert(listing.includes(`${opened.sessionId}.json`), '会话文件没有落盘')
})

await check('源文件指纹完好（sourceIntact）', async () => {
  const state = await call('source:verify', opened.sessionId)
  assertEqual(state.intact, true, '源文件应判定为未改动')
  assertEqual(state.missing, false, '源文件不应判定为丢失')
})

await check('再次打开同一文件 → resumed 为真', async () => {
  const again = await openFile(sourcePath)
  assertEqual(again.sessionId, opened.sessionId, '同一个文件应映射到同一个会话')
  assertEqual(again.resumed, true, '应识别为进度恢复')
  assertEqual(again.sourceChanged, false, '不应判定源文件变化')
})

await check('dialog:openSource 走真实对话框返回路径', async () => {
  dialogAnswers.open = sourcePath
  const picked = await call('dialog:openSource', null)
  dialogAnswers.open = null
  assertEqual(picked, sourcePath, '打开的对话框应返回选中的路径')
})

console.log('\n编辑与进度恢复')

await check('persist 写入改动并返回 ok', async () => {
  const result = await call('session:persist', {
    sessionId: opened.sessionId,
    edits: { 0: { [JSON.stringify(['output'])]: 'Hello, WORLD' } }
  })
  assertEqual(result.ok, true, 'persist 应成功')
  assertEqual(result.cleared.length, 0, '新改动不应被剪掉')
})

await check('重新打开后改动仍在（进度恢复）', async () => {
  const again = await openFile(sourcePath)
  assertEqual(again.edits['0'][JSON.stringify(['output'])], 'Hello, WORLD', '改动没有恢复')
})

await check('值改回原样后补丁被剪掉', async () => {
  const result = await call('session:persist', {
    sessionId: opened.sessionId,
    edits: { 0: { [JSON.stringify(['output'])]: 'Hello, world' } }
  })
  assert(result.cleared.includes('0'), `应剪掉回到原值的补丁，实际 cleared=${result.cleared}`)
})

await check('红线一：源文件一个字节都没变', () => {
  assertEqual(sha256(sourcePath), sourceHashBefore, '源文件被写入了')
})

console.log('\n批量替换')

await check('替换命中 2 条并落盘', async () => {
  const current = await openFile(sourcePath)
  const edits = replaceInOutputs(current.records, ' is ', ' IS ')
  assertEqual(Object.keys(edits).length, 2, '应命中 2 条（weather / book 两句含 " is "）')
  await call('session:persist', { sessionId: opened.sessionId, edits })
  const after = await openFile(sourcePath)
  assertEqual(after.edits['1'][JSON.stringify(['output'])], 'The weather IS nice', '替换结果没有落盘')
  assertEqual(after.edits['4'][JSON.stringify(['output'])], 'This book IS interesting', '第二条替换没落盘')
})

await check('source:original 取到的是未改动的原值', async () => {
  const original = await call('source:original', { sessionId: opened.sessionId, recordId: '1' })
  assertEqual(original.output, 'The weather is nice', '原值应来自源文件')
})

console.log('\n删除标记')

await check('删除是打标记，记录仍在序列里', async () => {
  await call('session:persist', { sessionId: opened.sessionId, deleted: [5] })
  const after = await openFile(sourcePath)
  assertEqual(after.recordCount, 6, '打标记不应减少记录数')
  assertEqual(after.deleted.includes(5), true, '删除标记没有持久化')
})

console.log('\n导出')

const exportBase = opened.exportConfig

await check('导出到源文件本身 → 拒绝', async () => {
  await assertThrows(
    () =>
      call('export:run', {
        sessionId: opened.sessionId,
        config: { ...exportBase, scope: 'all' },
        destPath: sourcePath,
        scope: 'all',
        ids: []
      }),
    /EXPORT_TO_SOURCE/,
    '应拒绝覆盖源文件'
  )
})

await check('导出到应用进度目录 → 拒绝', async () => {
  await assertThrows(
    () =>
      call('export:run', {
        sessionId: opened.sessionId,
        config: { ...exportBase, scope: 'all' },
        destPath: path.join(userData, 'sessions', 'leak.jsonl'),
        scope: 'all',
        ids: []
      }),
    /EXPORT_TO_SESSIONS_DIR/,
    '应拒绝写入进度目录'
  )
})

let allExportPath = null

await check('正常导出：条数 = 总条数 - 已删除', async () => {
  allExportPath = path.join(sandbox, 'out-all.jsonl')
  const result = await call('export:run', {
    sessionId: opened.sessionId,
    config: { ...exportBase, scope: 'all' },
    destPath: allExportPath,
    scope: 'all',
    ids: []
  })
  assertEqual(result.recordCount, 5, '导出的条数不对（6 条里删了 1 条）')
  const lines = await readLines(allExportPath)
  assertEqual(lines.length, 5, '导出文件行数不对')
})

await check('导出内容套用了改动', async () => {
  const rows = (await readLines(allExportPath)).map((line) => JSON.parse(line))
  assertEqual(rows[1].output, 'The weather IS nice', '改动没有进入导出')
  assert(!rows.some((row) => row.input === '明天见'), '已删除的记录不该出现在导出里')
})

await check('scope=modified 只导出改动过的记录', async () => {
  const dest = path.join(sandbox, 'out-modified.jsonl')
  const result = await call('export:run', {
    sessionId: opened.sessionId,
    config: { ...exportBase, scope: 'modified' },
    destPath: dest,
    scope: 'modified',
    ids: []
  })
  assertEqual(result.recordCount, 2, '只应有 2 条改动过的记录被导出')
})

await check('导出 JSON 数组可被解析', async () => {
  const dest = path.join(sandbox, 'out-all.json')
  await call('export:run', {
    sessionId: opened.sessionId,
    config: { ...exportBase, format: 'json', scope: 'all' },
    destPath: dest,
    scope: 'all',
    ids: []
  })
  const parsed = JSON.parse(await fsp.readFile(dest, 'utf8'))
  assertEqual(parsed.length, 5, 'JSON 数组条数不对')
})

await check('导出 CSV 带表头', async () => {
  const dest = path.join(sandbox, 'out-all.csv')
  await call('export:run', {
    sessionId: opened.sessionId,
    config: { ...exportBase, format: 'csv', scope: 'all' },
    destPath: dest,
    scope: 'all',
    ids: []
  })
  const lines = await readLines(dest)
  assertEqual(lines.length, 6, 'CSV 应为 1 行表头 + 5 行数据')
  assert(lines[0].includes('instruction'), 'CSV 缺少表头')
})

await check('导出后记住了上次的输出路径', async () => {
  const after = await openFile(sourcePath)
  assert(Boolean(after.lastExportPath), 'lastExportPath 没有记录')
})

await check('dialog:saveExport 走真实保存对话框', async () => {
  dialogAnswers.save = path.join(sandbox, 'out-dialog.jsonl')
  const picked = await call('dialog:saveExport', {
    defaultPath: path.join(sandbox, 'suggested.jsonl'),
    format: 'jsonl'
  })
  dialogAnswers.save = null
  assertEqual(picked, path.join(sandbox, 'out-dialog.jsonl'), '保存对话框应返回选中的路径')
})

console.log('\n已确认状态')

await check('确认状态写入后出现在会话摘要里', async () => {
  await call('session:persist', { sessionId: opened.sessionId, confirmed: [1, 2] })
  const sessions = await call('session:list')
  const mine = sessions.find((s) => s.id === opened.sessionId)
  assertEqual(mine.confirmedCount, 2, '摘要里的已确认数不对')
})

await check('重新打开后已确认状态恢复', async () => {
  const after = await openFile(sourcePath)
  assertEqual(after.confirmed.length, 2, '确认状态没有恢复')
  assert(after.confirmed.includes(1) && after.confirmed.includes(2), '确认的下标不对')
})

await check('确认状态与改动正交：改过又确认过仍算已确认', async () => {
  const after = await openFile(sourcePath)
  assert(Boolean(after.edits['1']), '记录 1 应该既有改动')
  assert(after.confirmed.includes(1), '记录 1 也应该已确认')
})

await check('scope=confirmed 只导出已确认的记录', async () => {
  // 记录 5 已删除，确认的是 1、2 —— 其中 2 没有改动，导出的应是原始内容
  const dest = path.join(sandbox, 'out-confirmed.jsonl')
  const result = await call('export:run', {
    sessionId: opened.sessionId,
    config: { ...exportBase, scope: 'confirmed' },
    destPath: dest,
    scope: 'confirmed',
    ids: []
  })
  assertEqual(result.recordCount, 2, '只应导出 2 条已确认的记录')
  const rows = (await readLines(dest)).map((line) => JSON.parse(line))
  assertEqual(rows[1].input, '谢谢你的帮助', '未改动但已确认的记录应导出原值')
})

await check('已删除的记录即使确认过也不导出', async () => {
  await call('session:persist', { sessionId: opened.sessionId, confirmed: [1, 2, 5] })
  const dest = path.join(sandbox, 'out-confirmed2.jsonl')
  const result = await call('export:run', {
    sessionId: opened.sessionId,
    config: { ...exportBase, scope: 'confirmed' },
    destPath: dest,
    scope: 'confirmed',
    ids: []
  })
  assertEqual(result.recordCount, 2, '已删除的记录必须被排除')
  await call('session:persist', { sessionId: opened.sessionId, confirmed: [1, 2] })
})

console.log('\n新增记录')

await check('追加到末尾：记录数 +1', async () => {
  await call('session:persist', {
    sessionId: opened.sessionId,
    added: [{ pos: 6, data: { instruction: '新写的指令', input: '', output: '新写的回复' } }]
  })
  const after = await openFile(sourcePath)
  assertEqual(after.recordCount, 7, '新增后记录数不对')
  assertEqual(after.records[6].origin, 'new', '最后一条应标记为新建')
  assertEqual(after.records[6].data.instruction, '新写的指令', '新建记录的内容不对')
})

await check('新增记录被算进摘要的 addedCount', async () => {
  const sessions = await call('session:list')
  const mine = sessions.find((s) => s.id === opened.sessionId)
  assertEqual(mine.addedCount, 1, 'addedCount 不对')
})

await check('在中间插入：新增记录落在指定位置', async () => {
  const before = await openFile(sourcePath)
  await simulateInsert(before, 1, { instruction: '插在第二条', input: '', output: '' })
  const after = await openFile(sourcePath)
  assertEqual(after.recordCount, 7, '记录数不对')
  assertEqual(after.records[1].origin, 'new', '位置 1 应是新建记录')
  assertEqual(after.records[1].data.instruction, '插在第二条', '插入位置不对')
  assertEqual(after.records[0].data.input, '你好，世界', '原第一条应仍在位置 0')
  assertEqual(after.records[2].data.input, '今天天气不错', '原第二条应被挤到位置 2')
})

await check('中间插入后，已有改动的下标整体平移', async () => {
  const after = await openFile(sourcePath)
  // 改动原本记在下标 1（The weather IS nice），插入后应平移到 2
  assert(Boolean(after.edits['2']), `下标 1 的改动应平移到 2，实际 keys=${Object.keys(after.edits)}`)
  assert(!after.edits['1'], '下标 1 现在是新建记录，不该有旧改动')
  assertEqual(after.edits['2'][JSON.stringify(['output'])], 'The weather IS nice', '平移后补丁内容不对')
  assertEqual(after.records[2].data.output, 'The weather is nice', '平移后的原始内容对不上')
})

await check('中间插入后，确认与删除标记同样平移', async () => {
  const after = await openFile(sourcePath)
  assert(
    after.confirmed.includes(2) && after.confirmed.includes(3),
    `确认下标应平移（1→2、2→3），实际=${after.confirmed}`
  )
  assertEqual(after.deleted.join(','), '6', `删除标记应平移（5→6），实际=${after.deleted}`)
})

await check('撤销新增：下标整体平移回去', async () => {
  const before = await openFile(sourcePath)
  await simulateRemoveAdded(before, 1)
  const after = await openFile(sourcePath)
  assertEqual(after.recordCount, 6, '移除新增后应回到 6 条')
  assert(Boolean(after.edits['1']), `改动的下标应平移回 1，实际=${Object.keys(after.edits)}`)
  assertEqual(after.deleted.join(','), '5', '删除标记应平移回 5')
  assert(after.confirmed.includes(1) && after.confirmed.includes(2), '确认下标应平移回 1、2')
})

console.log('\n新建数据集')

await check('目标已存在 → 拒绝（绝不覆盖）', async () => {
  await assertThrows(
    () => call('dataset:create', { destPath: sourcePath, format: 'jsonl', columns: [] }),
    /FILE_EXISTS/,
    '应拒绝覆盖已有文件'
  )
})

await check('落在应用进度目录 → 拒绝', async () => {
  await assertThrows(
    () =>
      call('dataset:create', {
        destPath: path.join(userData, 'sessions', 'new.jsonl'),
        format: 'jsonl',
        columns: []
      }),
    /DEST_IN_SESSIONS_DIR/,
    '应拒绝建在进度目录里'
  )
})

await check('新建 JSONL → 空文件，随后能被打开', async () => {
  const dest = path.join(sandbox, 'fresh.jsonl')
  const created = await call('dataset:create', { destPath: dest, format: 'jsonl', columns: [] })
  assertEqual(created.path, dest, '返回路径不对')
  assertEqual((await fsp.readFile(dest, 'utf8')).length, 0, '新的 JSONL 应是空文件')
  const openedFresh = await openFile(dest)
  assertEqual(openedFresh.recordCount, 0, '空数据集应有 0 条记录')
})

await check('新建 JSON → "[]"', async () => {
  const dest = path.join(sandbox, 'fresh.json')
  await call('dataset:create', { destPath: dest, format: 'json', columns: [] })
  assertEqual((await fsp.readFile(dest, 'utf8')).trim(), '[]', '新的 JSON 应是空数组')
})

await check('新建 CSV → BOM + 表头，字段顺序可识别', async () => {
  const dest = path.join(sandbox, 'fresh.csv')
  await call('dataset:create', {
    destPath: dest,
    format: 'csv',
    columns: ['instruction', 'output']
  })
  const raw = await fsp.readFile(dest, 'utf8')
  assert(raw.charCodeAt(0) === 0xfeff, 'CSV 应带 BOM，否则 Excel 打开中文会乱码')
  assertEqual(raw.slice(1).trim(), 'instruction,output', '表头不对')
  const openedFresh = await openFile(dest)
  assertEqual(openedFresh.fieldOrder.join(','), 'instruction,output', '字段顺序应来自表头')
  assertEqual(openedFresh.recordCount, 0, '新 CSV 不该有任何记录')
})

await check('新建 YAML → "[]"', async () => {
  const dest = path.join(sandbox, 'fresh.yaml')
  await call('dataset:create', { destPath: dest, format: 'yaml', columns: [] })
  assertEqual((await fsp.readFile(dest, 'utf8')).trim(), '[]', '新的 YAML 应是空数组')
})

console.log('\n各源格式（JSONL 之外的五种）')

// 用同一份 3 条数据在各格式下各写一份，验证主进程真的读得进来
// —— 单测只覆盖 parseBuffer，走不到真实的 IPC 与分块推送
const MULTI_ROWS = [
  { instruction: '翻译', input: '甲', output: 'A' },
  { instruction: '翻译', input: '乙', output: 'B' },
  { instruction: '翻译', input: '丙', output: 'C' }
]

const multiFiles = {
  json: [path.join(sandbox, 'multi.json'), JSON.stringify(MULTI_ROWS, null, 2)],
  csv: [
    path.join(sandbox, 'multi.csv'),
    ['instruction,input,output', ...MULTI_ROWS.map((r) => `${r.instruction},${r.input},${r.output}`)].join('\n') +
      '\n'
  ],
  tsv: [
    path.join(sandbox, 'multi.tsv'),
    [
      'instruction\tinput\toutput',
      ...MULTI_ROWS.map((r) => `${r.instruction}\t${r.input}\t${r.output}`)
    ].join('\n') + '\n'
  ],
  yaml: [
    path.join(sandbox, 'multi.yaml'),
    MULTI_ROWS.map(
      (r) => `- instruction: ${r.instruction}\n  input: ${r.input}\n  output: ${r.output}`
    ).join('\n') + '\n'
  ],
  txt: [path.join(sandbox, 'multi.txt'), MULTI_ROWS.map((r) => r.instruction).join('\n') + '\n']
}

for (const [file, content] of Object.values(multiFiles)) {
  await fsp.writeFile(file, content, 'utf8')
}

for (const [format, [file]] of Object.entries(multiFiles)) {
  await check(`打开 ${format.toUpperCase()} 源文件：条数与字段顺序正确`, async () => {
    const result = await openFile(file)
    assertEqual(result.source.format, format, '格式识别不对')
    assertEqual(result.recordCount, 3, `${format} 的记录数不对`)
    // 纯文本按「一行一条」读入、字段名固定 text，这是设计不是 bug
    const expected = format === 'txt' ? ['text'] : ['instruction', 'input', 'output']
    assertEqual(result.fieldOrder.join(','), expected.join(','), `${format} 的字段顺序不对`)
  })
}

await check('打开 Parquet 源文件：条数与字段顺序正确', async () => {
  // 借应用自己的导出器产出 parquet，再当源文件读回来
  const dest = path.join(sandbox, 'multi.parquet')
  await call('export:run', {
    sessionId: opened.sessionId,
    config: { ...exportBase, format: 'parquet', scope: 'all' },
    destPath: dest,
    scope: 'all',
    ids: []
  })
  const result = await openFile(dest)
  assertEqual(result.source.format, 'parquet', '格式识别不对')
  assertEqual(result.recordCount, 5, 'parquet 读回来的条数不对')
  assertEqual(result.fieldOrder[0], 'instruction', 'parquet 的字段顺序不对')
})

await check('新建 TSV → BOM + 制表符表头，字段顺序可识别', async () => {
  const dest = path.join(sandbox, 'fresh.tsv')
  await call('dataset:create', { destPath: dest, format: 'tsv', columns: ['instruction', 'output'] })
  const raw = await fsp.readFile(dest, 'utf8')
  assert(raw.charCodeAt(0) === 0xfeff, 'TSV 应带 BOM')
  assertEqual(raw.slice(1).trim(), 'instruction\toutput', 'TSV 表头应只用制表符分隔')
  const openedFresh = await openFile(dest)
  assertEqual(openedFresh.fieldOrder.join(','), 'instruction,output', '字段顺序应来自表头')
})

await check('dialog:saveNewDataset 走真实保存对话框', async () => {
  dialogAnswers.save = path.join(sandbox, 'picked.jsonl')
  const picked = await call('dialog:saveNewDataset', path.join(sandbox, '数据集.jsonl'))
  dialogAnswers.save = null
  assertEqual(picked, path.join(sandbox, 'picked.jsonl'), '保存对话框应返回选中的路径')
})

console.log('\n安全与边界')

await check('非法 sessionId → session:forget 直接返回 false', async () => {
  const ok = await call('session:forget', '../evil')
  assertEqual(ok, false, '非法 id 必须被白名单拦下')
})

await check('空数据集的会话也能导出成空文件', async () => {
  const dest = path.join(sandbox, 'fresh.jsonl')
  const openedFresh = await openFile(dest)
  const out = path.join(sandbox, 'fresh-out.jsonl')
  const result = await call('export:run', {
    sessionId: openedFresh.sessionId,
    config: { ...openedFresh.exportConfig, scope: 'all' },
    destPath: out,
    scope: 'all',
    ids: []
  })
  assertEqual(result.recordCount, 0, '空数据集导出应是 0 条')
  assertEqual((await fsp.readFile(out, 'utf8')).length, 0, '空导出应是空文件')
})

console.log('\n源文件发生变化')

await check('源文件追加一行 → sourceChanged，删除标记整体作废', async () => {
  const growing = path.join(sandbox, 'growing.jsonl')
  await fsp.writeFile(growing, JSON.stringify(SOURCE_ROWS[0]) + '\n', 'utf8')
  const first = await openFile(growing)
  await call('session:persist', { sessionId: first.sessionId, deleted: [0] })
  await fsp.appendFile(growing, JSON.stringify(SOURCE_ROWS[1]) + '\n', 'utf8')

  const second = await openFile(growing)
  assertEqual(second.sourceChanged, true, '应判定源文件变化')
  assertEqual(second.deleted.length, 0, '删除标记应整体作废')
  assert(
    second.warnings.some((w) => w.code === 'SESSION_DELETES_CLEARED'),
    `应给出作废提示，实际 warnings=${JSON.stringify(second.warnings)}`
  )
  assertEqual(second.recordCount, 2, '新行数应被读到')
})

await check('fresh 打开：丢弃旧进度重来', async () => {
  const before = await openFile(sourcePath)
  assert(Boolean(before.edits['1']), '先确认有改动')
  const fresh = await openFile(sourcePath, true)
  assertEqual(Object.keys(fresh.edits).length, 0, 'fresh 打开应清空改动')
  assertEqual(fresh.confirmed.length, 0, 'fresh 打开应清空确认状态')
})

await check('session:forget 删除会话文件', async () => {
  const sessions = await call('session:list')
  const target = sessions.find((s) => s.sourcePath.includes('fresh.csv'))
  assert(Boolean(target), '应能找到 fresh.csv 的会话')
  const ok = await call('session:forget', target.id)
  assertEqual(ok, true, 'forget 应成功')
  const after = await call('session:list')
  assert(!after.some((s) => s.id === target.id), '会话应从列表里消失')
})

console.log('\n收尾')

await check('全程结束，源文件依然一个字节都没变', () => {
  assertEqual(sha256(sourcePath), sourceHashBefore, '源文件被写入了')
})

await check('会话文件只存补丁，不存数据副本', async () => {
  const sessions = await call('session:list')
  const mine = sessions.find((s) => s.id === opened.sessionId)
  const raw = await fsp.readFile(path.join(userData, 'sessions', `${mine.id}.json`), 'utf8')
  assert(raw.length < 8000, `会话文件不该这么大：${raw.length} 字节`)
  assert(!raw.includes('明天见'), '会话文件里不该有源数据内容')
})

/* ------------------------------------------------------------------ *
 * 汇总
 * ------------------------------------------------------------------ */
console.log(`\n${'─'.repeat(52)}`)
if (failures.length === 0) {
  console.log(`端到端冒烟全部通过：${passed} 项`)
} else {
  console.log(`通过 ${passed} 项，失败 ${failures.length} 项：\n`)
  for (const { name, err } of failures) {
    console.log(`  ✗ ${name}`)
    console.log(`    ${err.stack.split('\n').slice(0, 3).join('\n    ')}\n`)
  }
}
// 清理策略同 GUI 测试：跑过了就删，失败留现场，--keep 强制保留。
const keep = process.argv.includes('--keep')
if (failures.length === 0 && !keep) {
  const gone = []
  for (const [label, dir] of [['数据', sandbox], ['用户数据', userData]]) {
    // 主进程可能还握着会话文件的句柄，Windows 上一删不掉就重试几次
    let removed = false
    for (let i = 0; i < 5 && !removed; i += 1) {
      try {
        await fsp.rm(dir, { recursive: true, force: true })
        removed = !fs.existsSync(dir)
      } catch {
        /* 再试 */
      }
      if (!removed) await new Promise((r) => setTimeout(r, 400))
    }
    gone.push(removed ? `${label}目录已清理` : `${label}目录删不掉：${dir}`)
  }
  console.log(gone.join(' · '))
  console.log('')
} else {
  console.log(`临时目录已保留：${sandbox}`)
  console.log(`用户数据目录：${userData}\n`)
}

process.exit(failures.length === 0 ? 0 : 1)
