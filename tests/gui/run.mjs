#!/usr/bin/env node
/**
 * GUI 测试入口 —— 起一份真实的 Electron（渲染进程是真的 React），
 * 用 CDP 连进去，跑完所有用例，截图存到临时目录，最后关掉。
 *
 *   npm run gui
 *
 * 和 tests/e2e/smoke.mjs 的分工：
 *   冒烟 = 真实主进程 + 替身 electron，守住业务逻辑与三条红线
 *   GUI  = 真实主进程 + 真实渲染进程，守住界面（布局 / 配色 / 状态样式 / 交互）
 * 两者零依赖，都不需要 npm install 额外包。
 */

import fsp from 'node:fs/promises'
import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { Cdp, evalJs, shot, sleep, waitFor, clickText, computedStyle, typeInto } from './cdp.mjs'
import { writeSamples } from './samples.mjs'
import { seedSessions } from './seed.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(here, '../..')
const casesDir = path.join(here, 'cases')

// CI 不截图：--no-shots 让截图永不致命（见 §4.5）；本地默认仍截图留档。
const noShots = process.argv.includes('--no-shots')

/* ------------------------------------------------------------------ *
 * 计数与断言
 * ------------------------------------------------------------------ */
let passed = 0
const failures = []
let currentCase = ''

async function check(name, fn) {
  try {
    await fn()
    passed += 1
    console.log(`  ✓ ${name}`)
  } catch (err) {
    failures.push({ case: currentCase, name, err })
    console.log(`  ✗ ${name}`)
    console.log(`      ${String(err.message).split('\n')[0]}`)
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

/* ------------------------------------------------------------------ *
 * 起应用
 * ------------------------------------------------------------------ */
function electronBinary() {
  const dist = path.join(root, 'node_modules/electron/dist')
  if (process.platform === 'win32') return path.join(dist, 'electron.exe')
  if (process.platform === 'darwin') return path.join(dist, 'Electron.app/Contents/MacOS/Electron')
  return path.join(dist, 'electron')
}

function freePort() {
  return new Promise((res, rej) => {
    const srv = net.createServer()
    srv.on('error', rej)
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address()
      srv.close(() => res(port))
    })
  })
}

/**
 * 删目录，带重试。
 * Electron 刚被 kill 时 userdata 里的文件可能还被占着（Windows 尤其明显），
 * 一次删不掉就等一下再试，别让测试因为清理失败而退出码不对。
 */
async function rmRetry(dir, { tries = 5, gap = 400 } = {}) {
  for (let i = 0; i < tries; i += 1) {
    try {
      await fsp.rm(dir, { recursive: true, force: true })
      if (!fs.existsSync(dir)) return true
    } catch {
      /* 再试 */
    }
    await sleep(gap)
  }
  return !fs.existsSync(dir)
}

async function waitForPort(port, timeoutMs = 60000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/json/version`)
      if (res.ok) return (await res.json()).Browser
    } catch {
      /* 还没起来 */
    }
    await sleep(400)
  }
  throw new Error(`调试端口 ${port} 在 ${timeoutMs}ms 内没起来`)
}

/* ------------------------------------------------------------------ *
 * 主流程
 * ------------------------------------------------------------------ */
const workDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'corpuseditor-gui-'))
const userData = path.join(workDir, 'userdata')
const samplesDir = path.join(workDir, 'samples')
const shotsDir = path.join(workDir, 'shots')
for (const d of [userData, samplesDir, shotsDir]) await fsp.mkdir(d, { recursive: true })

console.log('GUI 测试')
console.log(`工作目录：${workDir}\n`)

console.log('准备数据')
const samples = writeSamples(samplesDir)
console.log(`  样例数据：${samplesDir}`)
const { sessions } = await seedSessions({ userData, samples })
for (const [key, s] of Object.entries(sessions)) {
  const p = s.persisted ? '（已埋状态）' : ''
  console.log(`  ${key.padEnd(6)} ${s.recordCount} 条 ${p}`)
}

console.log('\n启动应用')
const port = await freePort()
const child = spawn(
  electronBinary(),
  [
    root,
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${userData}`,
    // 沙箱化的 CI 里 GPU 进程会崩，禁掉不影响渲染结果
    '--disable-gpu',
    '--disable-gpu-sandbox',
    '--no-sandbox',
    '--disable-dev-shm-usage'
  ],
  {
    cwd: root,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      // 这个变量会让 Electron 退化成纯 node，require('electron') 拿不到 app
      ELECTRON_RUN_AS_NODE: undefined
    }
  }
)
const stderrBuf = []
child.stderr.on('data', (b) => stderrBuf.push(b.toString()))
child.stdout.on('data', () => {})

let cdp = null
try {
  const browser = await waitForPort(port)
  console.log(`  调试端口 ${port}（${browser}）`)
  cdp = await Cdp.attach(port)
  await waitFor(cdp, `document.querySelector('.app') !== null`, { label: 'React 挂载' })
  await sleep(1200) // 等动画与首屏布局稳定
  console.log('  渲染进程已挂载\n')

  const ctx = {
    cdp,
    check,
    assert,
    assertEqual,
    evalJs: (expr) => evalJs(cdp, expr),
    // 截图解耦：CI 里 --no-shots 直接空转；否则也吞掉异常，最多丢一张图，
    // 绝不影响任何一条断言的通过与否（截图只是给人看的副产品，见 §4.5）。
    shot: async (name) => {
      if (noShots) return null
      try {
        return await shot(cdp, path.join(shotsDir, `${name}.png`))
      } catch (e) {
        console.warn(`  ⚠ 截图失败（已忽略）：${name} —— ${String(e.message).split('\n')[0]}`)
        return null
      }
    },
    sleep,
    waitFor: (expr, opts) => waitFor(cdp, expr, opts),
    clickText: (text, opts) => clickText(cdp, text, opts),
    typeInto: (selector, text, opts) => typeInto(cdp, selector, text, opts),
    style: (selector, props) => computedStyle(cdp, selector, props),
    samples,
    sessions,
    shotsDir,
    workDir
  }

  const files = (await fsp.readdir(casesDir)).filter((f) => f.endsWith('.mjs')).sort()
  for (const file of files) {
    // Windows 上动态 import 绝对路径必须是 file:// URL，否则报 "Received protocol 'f:'"
    const mod = await import(pathToFileURL(path.join(casesDir, file)).href)
    const suite = mod.default
    currentCase = suite.name
    console.log(`${suite.name}`)
    await suite.run(ctx)
    console.log('')
  }
} catch (err) {
  failures.push({ case: '运行器', name: '执行用例', err })
  console.log(`\n✗ 运行器出错：${err.message}`)
  if (stderrBuf.length) console.log(`  Electron stderr：\n${stderrBuf.join('').split('\n').slice(-15).join('\n')}`)
} finally {
  cdp?.close()
  try {
    child.kill()
  } catch {
    /* 已经退了 */
  }
  await sleep(800)
}

console.log('─'.repeat(60))
const ok = failures.length === 0
if (ok) {
  console.log(`GUI 测试全部通过：${passed} 项`)
} else {
  console.log(`通过 ${passed} 项，失败 ${failures.length} 项：\n`)
  for (const f of failures) {
    console.log(`  ✗ [${f.case}] ${f.name}`)
    console.log(`      ${String(f.err.message).split('\n')[0]}`)
  }
}

// 清理策略：跑过了就把临时目录删掉，失败则保留现场方便排查。
// --keep 可以强制保留。每轮 ~2.8MB（Electron userdata + 截图），不清理几十轮就上百 MB。
const keep = process.argv.includes('--keep')
if (ok && !keep) {
  if (!noShots) {
    // 截图先留档（覆盖式，也是幂等的），再删临时目录
    const archive = path.join(root, '.workbuddy-ai', 'gui-shots')
    try {
      await fsp.mkdir(archive, { recursive: true })
      for (const f of await fsp.readdir(shotsDir)) {
        await fsp.copyFile(path.join(shotsDir, f), path.join(archive, f))
      }
    } catch {
      /* 留档失败不影响测试结论 */
    }
  }
  const removed = await rmRetry(workDir)
  if (removed) {
    console.log(`已清理临时目录：${workDir}`)
    if (!noShots) console.log(`截图留档：${archive}`)
  } else {
    console.log(`临时目录删不掉（可能还被占用），请手动清理：${workDir}`)
  }
} else {
  console.log(`截图目录：${shotsDir}`)
  console.log(`临时目录已保留：${workDir}`)
}

process.exit(ok ? 0 : 1)
