#!/usr/bin/env node
/**
 * README 截图脚本 —— 用 CDP 连真实 Electron，截一张 2880×1800（1440×900 CSS @ DPR=2）的编辑器图。
 *
 *   node scripts/shoot-docs.mjs --locale=zh   # docs/editor-zh.png
 *   node scripts/shoot-docs.mjs --locale=en   # docs/editor-en.png
 *
 * 和 tests/gui/run.mjs 同一套姿势：起真实 Electron → CDP 连进去 → 走「继续上次」打开种子数据
 * （不经过系统对话框）→ 切到第一条「待确认」记录 → 截一帧。
 *
 * ⚠️ 手动跑，不进 CI（截图是给人看的，CI 截错的图就红没意义）。
 * ⚠️ 需要先 build（npm run build）；没有 out/ 时脚本会自动 build 一次。
 */

import fsp from 'node:fs/promises'
import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

import { Cdp, evalJs, sleep, waitFor } from '../tests/gui/cdp.mjs'
import { writeSamples } from '../tests/gui/samples.mjs'
import { seedSessions } from '../tests/gui/seed.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(here, '..')
const docsDir = path.join(root, 'docs')

function parseLocaleArg() {
  const idx = process.argv.findIndex((a) => a.startsWith('--locale='))
  if (idx === -1) return 'zh-CN'
  const raw = process.argv[idx].slice('--locale='.length)
  if (raw === 'zh') return 'zh-CN'
  if (raw === 'en') return 'en'
  return 'zh-CN'
}

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

async function ensureBuilt() {
  if (fs.existsSync(path.join(root, 'out/main/index.js'))) return
  console.log('out/ 不存在，先 build（electron-vite build）…')
  await new Promise((res, rej) => {
    const child = spawn('npm', ['run', 'build'], { cwd: root, stdio: 'inherit', shell: true })
    child.on('exit', (code) => (code ? rej(new Error(`build 失败，退出码 ${code}`)) : res()))
  })
}

const locale = parseLocaleArg()
const localeTag = locale === 'en' ? 'en' : 'zh'
const outFile = path.join(docsDir, `editor-${localeTag}.png`)

async function main() {
  await ensureBuilt()
  if (!fs.existsSync(docsDir)) await fsp.mkdir(docsDir, { recursive: true })

  const workDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'corpuseditor-shoot-'))
  const samplesDir = path.join(workDir, 'samples')
  const userData = path.join(workDir, `userdata-${locale}`)
  await fsp.mkdir(samplesDir, { recursive: true })
  await fsp.mkdir(userData, { recursive: true })

  console.log(`生成样例数据 → ${samplesDir}（locale=${locale}）`)
  const samples = writeSamples(samplesDir, locale)

  console.log('播种会话（在真实主进程里打开样例并写入改动）')
  await seedSessions({ userData, samples, locale })

  console.log(`启动 Electron（${locale}）…`)
  const port = await freePort()
  const child = spawn(
    electronBinary(),
    [
      root,
      `--remote-debugging-port=${port}`,
      `--user-data-dir=${userData}`,
      `--locale=${locale}`,
      '--disable-gpu',
      '--disable-gpu-sandbox',
      '--no-sandbox',
      '--disable-dev-shm-usage'
    ],
    {
      cwd: root,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, ELECTRON_RUN_AS_NODE: undefined }
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
    await sleep(1200)

    // 会话列表是异步从 userData 读的，先等「继续上次」的卡片渲染出来
    await waitFor(cdp, `document.querySelectorAll('.rcard').length > 0`, {
      label: '会话卡片渲染',
      timeout: 15000
    })
    // 样例超过 3 份时会先折叠，展开「查看全部」才能看到 alpaca
    await evalJs(
      cdp,
      `if (!document.querySelector('.recent-row--all') &&
            document.querySelector('.home__recent-head button')) {
         document.querySelector('.home__recent-head button').click()
       }
       return true`
    )
    await sleep(500)

    // 走「继续上次」打开 alpaca（含 3 条待确认、5 条已确认、1 条新建、1 条删除，状态最全）
    console.log('打开 alpaca 数据集')
    const opened = await evalJs(
      cdp,
      `const card = [...document.querySelectorAll('.rcard')]
         .find(c => /alpaca/.test(c.textContent || ''))
       if (!card) return false
       const btn = card.querySelector('.rcard__actions button:not(.iconbtn)')
       if (!btn) return false
       btn.click()
       return true`
    )
    if (!opened) throw new Error('首页找不到 alpaca 会话卡片')
    await waitFor(cdp, `!!document.querySelector('.reclist')`, { label: '核心页挂载' })
    await waitFor(
      cdp,
      `(() => { if (document.querySelectorAll('.recitem').length > 0) return true
         return !!document.querySelector('.reclist .empty') })()`,
      { label: '记录列表出结果', timeout: 20000 }
    )
    await sleep(600)

    // 切到第一条「待确认」记录，最直观地展示改动样式 + 状态栏
    await evalJs(
      cdp,
      `const item = document.querySelector('.recitem--modified') || document.querySelector('.recitem')
       if (item) item.click()
       return true`
    )
    await waitFor(cdp, `!!document.querySelector('.field')`, { label: '记录编辑器渲染', timeout: 10000 })
    // 让光标失焦，截图里别留闪烁的输入框光标
    await evalJs(cdp, `if (document.activeElement) document.activeElement.blur(); return true`)
    await sleep(800)

    // 固定 1440×900 CSS @ DPR=2 → 实际 2880×1800
    await cdp.send('Emulation.setDeviceMetricsOverride', {
      width: 1440,
      height: 900,
      deviceScaleFactor: 2,
      mobile: false
    })
    await sleep(400)

    const r = await cdp.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false })
    fs.writeFileSync(outFile, Buffer.from(r.data, 'base64'))
    console.log(`✓ 截图已写出：${outFile}（${2880}×${1800}）`)

    // 旧图被 editor-zh / editor-en 取代，截完即删
    const legacy = path.join(docsDir, 'editor.png')
    if (fs.existsSync(legacy)) {
      await fsp.rm(legacy)
      console.log(`✓ 已删除旧图：${legacy}`)
    }
  } catch (err) {
    console.error(`\n✗ 截图失败：${err.message}`)
    if (stderrBuf.length) {
      console.error(`  Electron stderr：\n${stderrBuf.join('').split('\n').slice(-15).join('\n')}`)
    }
    throw err
  } finally {
    cdp?.close()
    try {
      child.kill()
    } catch {
      /* 已经退了 */
    }
    await sleep(500)
    await fsp.rm(workDir, { recursive: true, force: true }).catch(() => {})
  }
}

main().then(
  () => process.exit(0),
  (err) => {
    console.error(err)
    process.exit(1)
  }
)
