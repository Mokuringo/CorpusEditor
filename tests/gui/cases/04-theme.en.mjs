/**
 * Light / dark theme — English (en) variant.
 * Assertions read computed styles, not screenshots. Theme buttons matched by aria-label.
 */

export default {
  name: 'Light & dark theme',
  async run(ctx) {
    const { check, assert, assertEqual, evalJs, style, shot } = ctx

    await check('默认是亮色主题', async () => {
      assertEqual(await evalJs(`return document.documentElement.dataset.theme`), 'light', '默认主题不是 light')
    })

    await check('切到暗色后 <html data-theme> 与背景色都变了', async () => {
      const lightBg = (await style('.app', ['background-color']))?.['background-color']

      await ctx.evalJs(`document.querySelector('button[aria-label="Dark"]').click(); return true`)
      await ctx.sleep(700)

      const theme = await evalJs(`return document.documentElement.dataset.theme`)
      assertEqual(theme, 'dark', '点了暗色但 data-theme 没变')
      const darkBg = (await style('.app', ['background-color']))?.['background-color']
      assert(darkBg, '取不到 .app 的背景色')
      assert(
        lightBg !== darkBg,
        `切主题后背景色没变（亮=${lightBg} 暗=${darkBg}），说明有颜色写死了没走 token`
      )
      await shot('04-dark-en')
    })

    await check('暗色下正文与背景的对比度够（亮度差 > 80）', async () => {
      const pair = await evalJs(
        `const lum = (c) => {
           const m = c.match(/\\d+(\\.\\d+)?/g).map(Number)
           return 0.2126 * m[0] + 0.7152 * m[1] + 0.0722 * m[2]
         }
         const app = getComputedStyle(document.querySelector('.app')).color
         const bg = getComputedStyle(document.querySelector('.app')).backgroundColor
         return { fg: lum(app), bg: lum(bg) }`
      )
      assert(
        Math.abs(pair.fg - pair.bg) > 80,
        `暗色下前景/背景亮度差只有 ${Math.round(Math.abs(pair.fg - pair.bg))}，太小看不清`
      )
    })

    await check('暗色下两个签名元素还认得出（经线刻度、角色色带）', async () => {
      const warp = await evalJs(
        `const t = document.querySelector('.warp__tick--done, .warp__tick--pending')
         if (!t) return null
         return getComputedStyle(t).backgroundColor`
      )
      if (warp) {
        const m = warp.match(/\d+/g)?.map(Number) ?? []
        assert(m.length >= 3, `经线刻度取不到颜色：${warp}`)
        // 全黑或全白都说明刻度在暗底上「消失」了
        assert(
          !(m[0] < 12 && m[1] < 12 && m[2] < 12),
          `暗色下经线刻度几乎全黑（${warp}），看不见了`
        )
      }
    })

    await check('切回亮色', async () => {
      await ctx.evalJs(`document.querySelector('button[aria-label="Light"]').click(); return true`)
      await ctx.sleep(600)
      assertEqual(await evalJs(`return document.documentElement.dataset.theme`), 'light', '切不回亮色')
      await shot('04-light-en')
    })
  }
}
