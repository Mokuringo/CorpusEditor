// 带开发者工具的 dev 启动器。
// npm run dev 要保持干净（它是打包前的最后检验），需要调 UI 时用 npm run dev:debug。
// 不引 cross-env：那样只为在 Windows 上设一个环境变量而多一个依赖，用 shell 起进程就够了。
import { spawn } from 'node:child_process'

const child = spawn('npx electron-vite dev', {
  stdio: 'inherit',
  shell: true,
  env: { ...process.env, CORPUSEDITOR_DEVTOOLS: '1' }
})

child.on('exit', (code, signal) => {
  if (signal) process.kill(process.pid, signal)
  else process.exit(code ?? 0)
})
