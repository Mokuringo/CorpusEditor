import { resolve } from 'node:path'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'

const shared = resolve(__dirname, 'shared')
const rendererRoot = resolve(__dirname, 'src')
// outDir 一律用绝对路径：renderer 的 root 是 src，相对路径会被解析到 src 下面去
const outMain = resolve(__dirname, 'out/main')
const outPreload = resolve(__dirname, 'out/preload')
const outRenderer = resolve(__dirname, 'out/renderer')

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    resolve: {
      alias: { '@shared': shared }
    },
    build: {
      outDir: outMain,
      rollupOptions: {
        input: { index: resolve(__dirname, 'electron/main/index.ts') }
      }
    }
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    resolve: {
      alias: { '@shared': shared }
    },
    build: {
      outDir: outPreload,
      rollupOptions: {
        input: { index: resolve(__dirname, 'electron/preload/index.ts') }
      }
    }
  },
  renderer: {
    root: rendererRoot,
    resolve: {
      alias: {
        '@shared': shared,
        '@': rendererRoot
      }
    },
    plugins: [react()],
    build: {
      outDir: outRenderer,
      rollupOptions: {
        input: { index: resolve(rendererRoot, 'index.html') }
      }
    }
  }
})
