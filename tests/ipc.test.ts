import { describe, expect, it } from 'vitest'
import fsp from 'node:fs/promises'
import path from 'node:path'

const PRELOAD = path.resolve(__dirname, '../electron/preload/index.ts')
const MAIN = path.resolve(__dirname, '../electron/main/index.ts')
const WORKSPACE = path.resolve(__dirname, '../electron/main/workspace.ts')

async function read(file: string): Promise<string> {
  return fsp.readFile(file, 'utf8')
}

function matchAll(text: string, pattern: RegExp): string[] {
  return [...text.matchAll(pattern)].map((m) => m[1])
}

/**
 * 主进程与预加载脚本之间的通道名是纯字符串约定，改一侧忘另一侧只会在运行时报错。
 * 这里用源码文本比对，把这类错误挡在编译之前。
 */
describe('IPC 通道约定', () => {
  it('渲染进程调用的每个通道都有对应的主进程处理', async () => {
    const preload = await read(PRELOAD)
    const main = await read(MAIN)

    const invoked = new Set(matchAll(preload, /ipcRenderer\.invoke\(\s*'([^']+)'/g))
    const handled = new Set(matchAll(main, /ipcMain\.handle\(\s*'([^']+)'/g))

    expect(invoked.size).toBeGreaterThan(10)
    for (const channel of invoked) {
      expect(handled, `预加载调用了 ${channel}，但主进程没有注册`).toContain(channel)
    }
  })

  it('主进程注册的每个 handle 都被渲染进程用到（没有死代码）', async () => {
    const preload = await read(PRELOAD)
    const main = await read(MAIN)

    const invoked = new Set(matchAll(preload, /ipcRenderer\.invoke\(\s*'([^']+)'/g))
    const handled = matchAll(main, /ipcMain\.handle\(\s*'([^']+)'/g)

    for (const channel of handled) {
      expect(invoked, `主进程注册了 ${channel}，但没有调用方`).toContain(channel)
    }
  })

  it('主进程推送的事件在预加载里有监听', async () => {
    const preload = await read(PRELOAD)
    const main = await read(MAIN)
    const workspace = await read(WORKSPACE)

    const pushed = new Set([
      ...matchAll(main, /\.send\(\s*'([^']+)'/g),
      ...matchAll(workspace, /sender\.send\(\s*'([^']+)'/g)
    ])
    const listened = new Set(matchAll(preload, /ipcRenderer\.on\(\s*'([^']+)'/g))

    for (const channel of pushed) {
      expect(listened, `主进程会推送 ${channel}，但预加载没有监听`).toContain(channel)
    }
  })

  it('渲染进程发送的事件在主进程里有接收', async () => {
    const preload = await read(PRELOAD)
    const main = await read(MAIN)

    const sent = matchAll(preload, /ipcRenderer\.send\(\s*'([^']+)'/g)
    const received = new Set(matchAll(main, /ipcMain\.(?:on|once)\(\s*'([^']+)'/g))

    expect(sent.length).toBeGreaterThan(0)
    for (const channel of sent) {
      expect(received, `预加载发送了 ${channel}，但主进程没有接收`).toContain(channel)
    }
  })

  it('预加载通过 contextBridge 暴露统一入口', async () => {
    const preload = await read(PRELOAD)
    expect(preload).toContain("contextBridge.exposeInMainWorld('corpuseditor'")
    // 只暴露一个全局，避免污染 window
    expect(matchAll(preload, /exposeInMainWorld\(\s*'([^']+)'/g)).toEqual(['corpuseditor'])
  })
})
