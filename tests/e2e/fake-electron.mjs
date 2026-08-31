/**
 * 主进程的 electron 替身 —— 让真实的 out/main/index.js 能在纯 node 里跑起来。
 *
 * 只替换窗口 / 对话框 / app 这些「外壳」，业务代码一行都不动。
 * tests/e2e/smoke.mjs 和 tests/gui/seed.mjs 共用这一份，避免两处各写一遍。
 *
 * 用法：
 *   const { handlers, pushed, dialogAnswers, install, sender } = createFakeElectron({ userData, fallbackDir })
 *   install()                       // 挂上 Module._load 拦截
 *   require(path.join(root, 'out/main/index.js'))
 *   await settled()                 // 等 registerIpc 注册完
 *   call('channel', ...args)        // 直接调 IPC handler
 */

import Module from 'node:module'

export function createFakeElectron({ userData, fallbackDir, version = '0.0.0-test' }) {
  const handlers = new Map()
  const pushed = []
  const dialogAnswers = { open: null, save: null }

  class FakeWebContents {
    constructor() {
      this.id = 1
    }
    send(channel, payload) {
      pushed.push({ channel, payload })
    }
    openDevTools() {}
    loadFile() {}
    loadURL() {}
    once() {}
    on() {}
  }

  class FakeBrowserWindow {
    static all = []
    static last = null

    constructor(options) {
      this.options = options
      this.webContents = new FakeWebContents()
      this.destroyed = false
      FakeBrowserWindow.all.push(this)
      FakeBrowserWindow.last = this
    }

    static getFocusedWindow() {
      return FakeBrowserWindow.last
    }
    static fromWebContents() {
      return FakeBrowserWindow.last
    }
    static getAllWindows() {
      return FakeBrowserWindow.all
    }

    once() {
      return this
    }
    on() {
      return this
    }
    show() {}
    focus() {}
    restore() {}
    minimize() {}
    maximize() {}
    unmaximize() {}
    close() {}
    destroy() {
      this.destroyed = true
    }
    isDestroyed() {
      return this.destroyed
    }
    isMaximized() {
      return false
    }
    isMinimized() {
      return false
    }
    loadFile() {}
    loadURL() {}
  }

  const ipcMain = {
    handle(channel, fn) {
      handlers.set(channel, fn)
      return ipcMain
    },
    on() {
      return ipcMain
    },
    once() {
      return ipcMain
    },
    removeListener() {
      return ipcMain
    },
    removeHandler() {
      return ipcMain
    }
  }

  const app = {
    name: 'CorpusEditor',
    getVersion: () => version,
    getPath: (name) => (name === 'userData' ? userData : fallbackDir),
    getAppPath: () => fallbackDir,
    getLocale: () => 'zh-CN',
    requestSingleInstanceLock: () => true,
    isReady: () => true,
    whenReady: () => Promise.resolve(),
    on: () => app,
    once: () => app,
    quit: () => {},
    setPath: () => {}
  }

  const fakeElectron = {
    app,
    BrowserWindow: FakeBrowserWindow,
    dialog: {
      showOpenDialog: async () =>
        dialogAnswers.open
          ? { canceled: false, filePaths: [dialogAnswers.open] }
          : { canceled: true, filePaths: [] },
      showSaveDialog: async () =>
        dialogAnswers.save
          ? { canceled: false, filePath: dialogAnswers.save }
          : { canceled: true, filePath: undefined },
      showMessageBox: async () => ({ response: 0 })
    },
    ipcMain,
    nativeTheme: { shouldUseDarkColors: false, on: () => {} },
    shell: { showItemInFolder: () => true, openPath: async () => '' },
    Menu: { setApplicationMenu: () => {}, buildFromTemplate: () => ({}) }
  }

  const originalLoad = Module._load
  function install() {
    Module._load = function (request, parent, isMain) {
      if (request === 'electron') return fakeElectron
      return originalLoad.call(this, request, parent, isMain)
    }
  }
  function uninstall() {
    Module._load = originalLoad
  }

  function sender() {
    return FakeBrowserWindow.last?.webContents ?? new FakeWebContents()
  }

  async function call(channel, ...args) {
    const fn = handlers.get(channel)
    if (!fn) throw new Error(`主进程没有注册通道 ${channel}`)
    return fn({ sender: sender() }, ...args)
  }

  /** registerIpc 通常写在 app.whenReady().then() 里，require 之后要放两个 tick */
  async function settled() {
    await new Promise((r) => setImmediate(r))
    await new Promise((r) => setImmediate(r))
  }

  return {
    handlers,
    pushed,
    dialogAnswers,
    install,
    uninstall,
    sender,
    call,
    settled,
    FakeBrowserWindow,
    FakeWebContents
  }
}

/** 取出某个 session 推给渲染进程的全部记录（dataset:chunk 是分批推的） */
export function chunksFor(pushed, sessionId) {
  const records = []
  for (const { channel, payload } of pushed) {
    if (channel === 'dataset:chunk' && payload.sessionId === sessionId) records.push(...payload.records)
  }
  return records
}
