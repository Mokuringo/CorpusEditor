/**
 * 一次性脚本：resources/logo.svg → 7 张 PNG + icon.ico，并把 svg 同步到 src/public/。
 *
 * 用法：
 *   node scripts/render-icons.mjs
 *
 * 依赖：只调 Inkscape（你机器上已经有了：在 PATH 里）。
 * 不引任何 npm 包，不起 Electron 主进程——这俩在这个环境里要么起不来要么麻烦。
 *
 * 想换渲染器：把 rasterizeToPng() 里那一行 inkscape 替换成你喜欢的工具（rsvg-convert、
 *   resvg、Sharp 都能干这活），其它部分（ICO 拼装、尺寸列表）不用动。
 */

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const resources = path.join(root, 'resources')
const svgPath = path.join(resources, 'logo.svg')
const publicSvg = path.join(root, 'src', 'public', 'logo.svg')

const SIZES = [16, 24, 32, 48, 64, 128, 256, 1024]

function rasterizeToPng(svg, outPng, size) {
  // Inkscape 1.x 的导出语法。老的 -w -h -o 还能用，但 --export-* 更稳。
  const r = spawnSync(
    'inkscape',
    [
      svg,
      '--export-type=png',
      `--export-width=${size}`,
      `--export-height=${size}`,
      `--export-filename=${outPng}`
    ],
    { stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8' }
  )
  if (r.status !== 0) {
    throw new Error(`Inkscape 渲染 ${size}px 失败 (${r.status}):\n${r.stderr || r.stdout}`)
  }
}

/**
 * 手写 ICO 容器。ICO 从 Vista 起允许直接内嵌 PNG，所以不用转成 BMP。
 * 结构：6 字节 ICONDIR + n×16 字节 ICONDIRENTRY + 依次排开的图像数据。
 */
function buildIco(entries) {
  const header = Buffer.alloc(6)
  header.writeUInt16LE(0, 0) // reserved
  header.writeUInt16LE(1, 2) // type: 1 = icon
  header.writeUInt16LE(entries.length, 4)

  const dir = Buffer.alloc(entries.length * 16)
  let offset = header.length + dir.length

  entries.forEach(({ size, data }, i) => {
    const at = i * 16
    dir.writeUInt8(size >= 256 ? 0 : size, at) // 256 用 0 表示
    dir.writeUInt8(size >= 256 ? 0 : size, at + 1)
    dir.writeUInt8(0, at + 2) // colorCount
    dir.writeUInt8(0, at + 3) // reserved
    dir.writeUInt16LE(1, at + 4) // planes
    dir.writeUInt16LE(32, at + 6) // bitCount
    dir.writeUInt32LE(data.length, at + 8)
    dir.writeUInt32LE(offset, at + 12)
    offset += data.length
  })

  return Buffer.concat([header, dir, ...entries.map((e) => e.data)])
}

const entries = []
for (const size of SIZES) {
  const out = path.join(resources, `logo-${size}.png`)
  rasterizeToPng(svgPath, out, size)
  const data = fs.readFileSync(out)
  entries.push({ size, data })
  console.log(`logo-${size}.png  ${data.length} 字节`)
}

const ico = buildIco(entries)
fs.writeFileSync(path.join(resources, 'icon.ico'), ico)
console.log(`icon.ico  ${ico.length} 字节（${entries.length} 个尺寸）`)

// 渲染进程的 favicon 用的是另一份副本，保持同步
fs.copyFileSync(svgPath, publicSvg)
console.log('已同步 src/public/logo.svg')
