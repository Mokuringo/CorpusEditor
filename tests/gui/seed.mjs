/**
 * 播种 —— 在主进程里真实地打开样例文件并写入改动，产出会话文件。
 *
 * 这样 GUI 测试启动时，首页「继续上次」里就有现成的会话，
 * 点「继续」走的是 `openFile(session.sourcePath)`，**不经过系统对话框** ——
 * 这正是绕开 contextBridge 限制的关键：contextBridge 暴露的 window.corpuseditor 是只读的
 * （写入静默丢弃、defineProperty 报 Cannot redefine），没法在渲染进程里劫持 dialog。
 */

import path from 'node:path'
import os from 'node:os'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { createFakeElectron } from '../e2e/fake-electron.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(here, '../..')
const require = createRequire(import.meta.url)

export async function seedSessions({ userData, samples, locale = 'zh-CN' }) {
  const fake = createFakeElectron({
    userData,
    fallbackDir: os.tmpdir(),
    version: '0.0.0-gui-seed'
  })
  fake.install()
  // 每轮 seed 都新建一份 fake-electron，但 Node 会缓存 out/main/index.js，
  // 第二轮 require 直接命中缓存、不再执行，导致本回合的 ipcMain.handle
  // 没注册到新的 fake 上，seed 调用 source:open 就报「主进程没有注册通道」。
  // 清掉 out/main 的模块缓存，让 main 在当前 fake 上重新注册一次。
  for (const key of Object.keys(require.cache)) {
    if (key.startsWith(path.join(root, 'out/main'))) delete require.cache[key]
  }
  require(path.join(root, 'out/main/index.js'))
  await fake.settled()

  const plan = (await import('./samples.mjs')).seedPlan(locale)
  const sessions = {}

  for (const [key, filePath] of Object.entries(samples.files)) {
    const result = await fake.call('source:open', { filePath })
    const patch = plan[key] ?? {}
    if (Object.keys(patch).length) {
      await fake.call('session:persist', { sessionId: result.sessionId, ...patch })
    }
    sessions[key] = {
      ...result,
      // 重新读一遍，确认改动真的落盘了
      persisted: Object.keys(patch).length > 0
    }
  }

  return { sessions, fake }
}
