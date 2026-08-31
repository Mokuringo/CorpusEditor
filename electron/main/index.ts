import fs from 'node:fs'
import path from 'node:path'
import { app, BrowserWindow, dialog, ipcMain, nativeTheme, shell } from 'electron'
import { loadSettings, saveSettings, deleteSession, listSessions, isSessionId } from './store'
import {
  createDataset,
  dropWorkspace,
  getOriginal,
  getOriginalValues,
  openSource,
  persist,
  refreshSourceState,
  runExport
} from './workspace'
import type { ExportConfig, ExportFormat, Settings } from '@shared/types'

const SOURCE_FILTERS = [
  {
    name: '所有支持的格式',
    extensions: ['jsonl', 'ndjson', 'jl', 'json', 'csv', 'tsv', 'tab', 'yaml', 'yml', 'parquet', 'txt']
  },
  { name: 'JSONL / NDJSON', extensions: ['jsonl', 'ndjson', 'jl'] },
  { name: 'JSON', extensions: ['json'] },
  { name: 'CSV / TSV', extensions: ['csv', 'tsv', 'tab'] },
  { name: 'YAML', extensions: ['yaml', 'yml'] },
  { name: 'Parquet', extensions: ['parquet'] },
  { name: '纯文本', extensions: ['txt'] },
  { name: '所有文件', extensions: ['*'] }
]

function exportFilters(format: ExportFormat) {
  const map: Record<ExportFormat, { name: string; extensions: string[] }> = {
    jsonl: { name: 'JSONL', extensions: ['jsonl'] },
    json: { name: 'JSON', extensions: ['json'] },
    csv: { name: 'CSV', extensions: ['csv'] },
    parquet: { name: 'Parquet', extensions: ['parquet'] }
  }
  return [map[format], { name: '所有文件', extensions: ['*'] }]
}

let mainWindow: BrowserWindow | null = null
let flushing = false

// 自绘标题栏：Windows / Linux 去掉原生边框后三个按钮全部由我们自己画；
// macOS 保留 hiddenInset，红绿灯、拖拽、双击最大化交给系统，我们只画右侧区域。
const USES_CUSTOM_FRAME = process.platform !== 'darwin'

// 亮 / 暗主题的窗口底色，避免内容加载完成前先闪一下相反的颜色
const WINDOW_BG: Record<string, string> = { light: '#faf9f5', dark: '#12140f' }

// 资源定位：开发态 __dirname = out/main，往上两级即项目根 resources/；
// 打包态 build.extraResources 把 resources/ 复制到 <app>/resources/resources/，
// process.resourcesPath 指向 <app>/resources。该值在开发/测试环境可能为 undefined，
// 且打包态下只有文件确实拷贝到位才采用，否则退回开发态布局。
function resolveResource(name: string): string {
  if (process.resourcesPath) {
    const packed = path.join(process.resourcesPath, 'resources', name)
    if (fs.existsSync(packed)) return packed
  }
  return path.join(__dirname, '..', '..', 'resources', name)
}
const ICON_PATH = resolveResource('icon.ico')
const DOCK_ICON_PATH = resolveResource('logo-256.png')

async function createWindow(): Promise<BrowserWindow> {
  const settings = await loadSettings()
  const resolved =
    settings.theme === 'system' ? (nativeTheme.shouldUseDarkColors ? 'dark' : 'light') : settings.theme

  const win = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1024,
    minHeight: 640,
    title: 'CorpusEditor · LLM 指令微调数据编辑器',
    icon: fs.existsSync(ICON_PATH) ? ICON_PATH : undefined,
    autoHideMenuBar: true,
    backgroundColor: WINDOW_BG[resolved] ?? WINDOW_BG.dark,
    frame: !USES_CUSTOM_FRAME,
    titleBarStyle: USES_CUSTOM_FRAME ? undefined : 'hiddenInset',
    titleBarOverlay: USES_CUSTOM_FRAME
      ? undefined
      : {
          color: resolved === 'dark' ? '#1a1d17' : '#ffffff',
          symbolColor: resolved === 'dark' ? '#e8eae3' : '#1c1f1a',
          height: 36
        },
    show: false,
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  })

  win.once('ready-to-show', () => win.show())

  // 最大化状态要画进标题栏的还原 / 最大化图标，所以变化时推给渲染进程。
  // 无边框窗口最大化后会比屏幕大出边框厚度，渲染进程据此去掉内边距避免内容被裁。
  const pushWindowState = () => {
    if (!win.isDestroyed()) win.webContents.send('window:state', { maximized: win.isMaximized() })
  }
  win.on('maximize', pushWindowState)
  win.on('unmaximize', pushWindowState)

  // 关闭窗口前先让渲染进程把未落盘的编辑刷出去，避免异常退出丢失进度。
  win.on('close', (event) => {
    if (flushing) return
    event.preventDefault()
    flushing = true
    let done = false
    const finish = () => {
      if (done) return
      done = true
      clearTimeout(timer)
      ipcMain.removeListener('app:flushed', finish)
      flushing = false
      if (!win.isDestroyed()) win.destroy()
    }
    const timer = setTimeout(finish, 2500)
    ipcMain.once('app:flushed', finish)
    win.webContents.send('app:flush')
  })

  // 开发者工具只在显式要求时打开：npm run dev 是打包前的最后检验，不该带调试面板；
  // 需要调 UI 时用 npm run dev:debug（设置 CORPUSEDITOR_DEVTOOLS=1）。
  if (process.env.CORPUSEDITOR_DEVTOOLS === '1') {
    win.webContents.openDevTools({ mode: 'detach' })
  }

  if (process.env.ELECTRON_RENDERER_URL) {
    void win.loadURL(process.env.ELECTRON_RENDERER_URL)
  } else {
    void win.loadFile(path.join(__dirname, '../renderer/index.html'))
  }

  return win
}

const gotLock = app.requestSingleInstanceLock()
if (!gotLock) {
  app.quit()
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore()
      mainWindow.focus()
    }
  })

  void app.whenReady().then(() => {
    registerIpc()
    // macOS 的 Dock 图标不跟 BrowserWindow 的 icon 走，要单独设。
    // Windows 上 app.dock 是 undefined，靠 ?. 守住。
    if (process.platform === 'darwin' && fs.existsSync(DOCK_ICON_PATH)) {
      app.dock?.setIcon(DOCK_ICON_PATH)
    }
    const spawn = () => {
      void createWindow().then((win) => {
        mainWindow = win
      })
    }
    spawn()

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) spawn()
    })
  })
}

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

function registerIpc(): void {
  ipcMain.handle('app:info', () => ({
    version: app.getVersion(),
    platform: process.platform,
    userData: app.getPath('userData')
  }))

  // 自绘标题栏的窗口控制。用 fromWebContents 取发起请求的窗口，而不是全局 mainWindow，
  // 这样多窗口时按钮永远不会作用到错误的窗口上。
  const fromSender = (event: Electron.IpcMainInvokeEvent) =>
    BrowserWindow.fromWebContents(event.sender)

  ipcMain.handle('window:minimize', (event) => {
    fromSender(event)?.minimize()
  })

  ipcMain.handle('window:maximize', (event) => {
    const win = fromSender(event)
    if (!win) return false
    if (win.isMaximized()) win.unmaximize()
    else win.maximize()
    return win.isMaximized()
  })

  // 走 win.close() 而不是 destroy()，否则会跳过 close 钩子里的 flush，未落盘的编辑就丢了
  ipcMain.handle('window:close', (event) => {
    fromSender(event)?.close()
  })

  ipcMain.handle('settings:get', () => loadSettings())
  ipcMain.handle('settings:set', (_e, settings: Settings) => saveSettings(settings))

  ipcMain.handle('dialog:saveNewDataset', async (_e, defaultPath: string) => {
    const win = BrowserWindow.getFocusedWindow() ?? mainWindow
    const options: Electron.SaveDialogOptions = {
      title: '新建数据集',
      defaultPath,
      filters: [
        { name: 'JSONL', extensions: ['jsonl'] },
        { name: 'JSON 数组', extensions: ['json'] },
        { name: 'CSV', extensions: ['csv'] },
        { name: 'TSV', extensions: ['tsv'] },
        { name: 'YAML', extensions: ['yaml', 'yml'] }
      ],
      properties: ['createDirectory', 'showOverwriteConfirmation']
    }
    const result = win ? await dialog.showSaveDialog(win, options) : await dialog.showSaveDialog(options)
    if (result.canceled || !result.filePath) return null
    return result.filePath
  })

  ipcMain.handle(
    'dataset:create',
    async (
      _e,
      args: { destPath: string; format: 'jsonl' | 'json' | 'csv' | 'tsv' | 'yaml'; columns: string[] }
    ) => createDataset(args)
  )

  ipcMain.handle('dialog:openSource', async (_e, startDir?: string | null) => {
    const win = BrowserWindow.getFocusedWindow() ?? mainWindow
    const options: Electron.OpenDialogOptions = {
      title: '选择微调数据文件',
      filters: SOURCE_FILTERS,
      properties: ['openFile'],
      defaultPath: startDir ?? undefined
    }
    const result = win ? await dialog.showOpenDialog(win, options) : await dialog.showOpenDialog(options)
    if (result.canceled || result.filePaths.length === 0) return null
    const filePath = result.filePaths[0]
    await saveSettings({ ...(await loadSettings()), lastOpenDir: path.dirname(filePath) })
    return filePath
  })

  ipcMain.handle('dialog:saveExport', async (_e, args: { defaultPath: string; format: ExportFormat }) => {
    const win = BrowserWindow.getFocusedWindow() ?? mainWindow
    const options: Electron.SaveDialogOptions = {
      title: '导出到',
      defaultPath: args.defaultPath,
      filters: exportFilters(args.format),
      properties: ['createDirectory', 'showOverwriteConfirmation']
    }
    const result = win ? await dialog.showSaveDialog(win, options) : await dialog.showSaveDialog(options)
    return result.canceled || !result.filePath ? null : result.filePath
  })

  ipcMain.handle('session:list', () => listSessions())

  // sessionId 会被拼进删除路径，必须先校验再动作
  ipcMain.handle('session:forget', async (_e, sessionId: string) => {
    if (!isSessionId(sessionId)) return false
    dropWorkspace(sessionId)
    return deleteSession(sessionId)
  })

  ipcMain.handle(
    'source:open',
    async (event, args: { filePath: string; fresh?: boolean }) => {
      return openSource({ filePath: args.filePath, sender: event.sender, fresh: args.fresh })
    }
  )

  ipcMain.handle('session:persist', (_e, input) => persist(input))

  ipcMain.handle('source:original', (_e, args: { sessionId: string; recordId: string }) =>
    getOriginal(args.sessionId, args.recordId)
  )

  ipcMain.handle(
    'source:originals',
    (_e, args: { sessionId: string; entries: Array<{ recordId: string; pathKey: string }> }) =>
      getOriginalValues(args.sessionId, args.entries)
  )

  ipcMain.handle('source:verify', (_e, sessionId: string) => refreshSourceState(sessionId))

  ipcMain.handle('export:run', (_e, input: { sessionId: string; config: ExportConfig; destPath: string; scope: string; ids: string[] }) =>
    runExport(input as never)
  )

  ipcMain.handle('shell:showItemInFolder', (_e, fullPath: string) => {
    shell.showItemInFolder(fullPath)
    return true
  })
}
