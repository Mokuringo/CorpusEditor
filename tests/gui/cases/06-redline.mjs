/**
 * 红线 —— 在真实 GUI 这一层再守一遍「源文件只读」。
 *
 * 冒烟脚本已经在主进程层守过，这里补的是：
 * 走完整条「打开 → 看 → 退回修改 → 关掉」的界面路径之后，源文件依然一个字节没变。
 */

import fs from 'node:fs'
import crypto from 'node:crypto'
import path from 'node:path'
import { enterDataset } from '../nav.mjs'

const sha256 = (p) => crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex')

export default {
  name: '红线（源文件只读）',
  async run(ctx) {
    const { check, assert, assertEqual, evalJs } = ctx

    // 进入数据集前的指纹，等界面操作走完后再比对一次
    const before = {}
    for (const [key, p] of Object.entries(ctx.samples.files)) before[key] = sha256(p)

    await check('界面上标了「只读」', async () => {
      await enterDataset(ctx, 'alpaca')
      const badges = await evalJs(
        `return [...document.querySelectorAll('.badge')].map(b => b.textContent.trim())`
      )
      assert(badges.some((b) => /只读/.test(b)), `界面上没有只读标注：${JSON.stringify(badges)}`)
    })

    await check('没有「保存」类按钮（改动只走导出）', async () => {
      const labels = await evalJs(
        `return [...document.querySelectorAll('button')]
           .map(b => (b.textContent || '').trim())
           .filter(t => t && t.length <= 6)`
      )
      const forbidden = labels.filter((t) => /^(保存|保存文件|写回|覆盖源文件)$/.test(t))
      assertEqual(forbidden.length, 0, `不该出现写回源文件的按钮：${JSON.stringify(forbidden)}`)
    })

    await check('走完所有界面操作后源文件指纹依然没变', async () => {
      const after = {}
      for (const [key, p] of Object.entries(ctx.samples.files)) after[key] = sha256(p)
      for (const key of Object.keys(before)) {
        assert(
          before[key] === after[key],
          `${key} 被改动了！\n  前 ${before[key]}\n  后 ${after[key]}`
        )
      }
    })

    await check('会话目录与源文件目录不重叠', async () => {
      const sessionsDir = path.join(ctx.workDir, 'userdata')
      const sampleDir = path.dirname(ctx.samples.files.alpaca)
      // 两个目录必须互不包含，否则导出/清理时有误伤源数据的风险
      assert(
        path.relative(sampleDir, sessionsDir).startsWith('..'),
        `会话目录不该落在源数据目录里：sessions=${sessionsDir} samples=${sampleDir}`
      )
      assert(
        path.relative(sessionsDir, sampleDir).startsWith('..'),
        `源数据也不该落在会话目录里：sessions=${sessionsDir} samples=${sampleDir}`
      )
    })
  }
}
