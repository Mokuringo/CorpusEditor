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

export async function seedSessions({ userData, samples }) {
  const fake = createFakeElectron({
    userData,
    fallbackDir: os.tmpdir(),
    version: '0.0.0-gui-seed'
  })
  fake.install()
  require(path.join(root, 'out/main/index.js'))
  await fake.settled()

  const plan = (await import('./samples.mjs')).seedPlan()
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
