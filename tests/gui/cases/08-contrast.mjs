/**
 * 侧栏控件的可读性 —— 防「白纸白字 / 黑板黑字」这类回归。
 *
 * 起因：列表头部那两个控件（多选开关、确认当前 N 条）曾用 var(--accent-text) 当文字色，
 * 而 --accent-text 的语义是「主色底上的文字」。头部底色是 --bg-sunken，于是
 * 亮色下白字压浅底（1.10:1）、暗色下黑字压深底（1.05:1），两档主题都看不见。
 *
 * 这种 bug 截图看不出来，只能靠算对比度守住。
 */

import { enterDataset } from '../nav.mjs'

/**
 * 在渲染进程里算 WCAG 相对亮度与对比度。返回 null 表示元素不存在。
 *
 * ⚠️ 开头的 return 不能省：evalJs 会把表达式包进 `(async () => { ... })()`，
 * 只取这个 async 函数的返回值。表达式本身算出了值但没 return，外层就永远是 undefined。
 * 更坑的是 evalJs 那个「忘了写 return」的护栏查的是表达式里有没有 return 字样 ——
 * 这段里面恰好有 `return null`，护栏不会报警，值就静默丢了。
 */
const CONTRAST_EXPR = (selector, bgSelector) => `
return (() => {
  const el = document.querySelector(${JSON.stringify(selector)})
  const bgEl = document.querySelector(${JSON.stringify(bgSelector)})
  if (!el || !bgEl) return null
  const parse = (c) => {
    const m = c.match(/rgba?\\(([^)]+)\\)/)
    if (!m) return null
    const p = m[1].split(',').map((s) => parseFloat(s.trim()))
    return { r: p[0], g: p[1], b: p[2], a: p.length > 3 ? p[3] : 1 }
  }
  const lum = ({ r, g, b }) => {
    const f = (v) => {
      const s = v / 255
      return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4)
    }
    return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b)
  }
  const fg = parse(getComputedStyle(el).color)
  const bg = parse(getComputedStyle(bgEl).backgroundColor)
  if (!fg || !bg) return null
  const a = lum(fg)
  const b = lum(bg)
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05)
})()`

async function setTheme(ctx, label) {
  const ok = await ctx.evalJs(
    `const b = document.querySelector('button[aria-label="${label}"]')
     if (!b) return false
     b.click()
     return true`
  )
  if (!ok) throw new Error(`找不到主题按钮「${label}」`)
  await ctx.waitFor(`document.documentElement.dataset.theme === ${JSON.stringify(themeOf(label))}`, {
    label: `切到${label}`,
    timeout: 5000
  })
  await ctx.sleep(400)
}

function themeOf(label) {
  return label === '暗色' ? 'dark' : 'light'
}

const TARGETS = [
  { name: '多选开关', selector: '.sidebar__head .iconbtn' },
  { name: '确认当前 N 条', selector: '.sidebar__head .linkbtn' }
]

export default {
  name: '侧栏控件对比度',
  async run(ctx) {
    const { check, assert, evalJs, shot } = ctx

    await enterDataset(ctx, 'alpaca')

    for (const theme of ['亮色', '暗色']) {
      await setTheme(ctx, theme)

      for (const { name, selector } of TARGETS) {
        await check(`${theme}主题下「${name}」的对比度 ≥ 4.5（WCAG AA）`, async () => {
          const ratio = await evalJs(CONTRAST_EXPR(selector, '.sidebar'))
          assert(ratio !== null, `取不到对比度，选择器失效了：${selector}`)
          assert(
            ratio >= 4.5,
            `对比度只有 ${ratio.toFixed(2)}:1，低于 4.5:1 —— 大概率又用错了 --accent-text`
          )
        })
      }

      // 多选「开」的状态是另一套配色（accent 压 accent-soft），最容易漏测
      await check(`${theme}主题下「多选开关（开启态）」的对比度 ≥ 4.5`, async () => {
        const on = await evalJs(
          `const b = document.querySelector('.sidebar__head .iconbtn')
           if (!b) return false
           if (!b.classList.contains('iconbtn--on')) b.click()
           return true`
        )
        assert(on, '找不到多选开关')
        await ctx.sleep(300)
        const ratio = await evalJs(CONTRAST_EXPR('.sidebar__head .iconbtn--on', '.sidebar'))
        assert(ratio !== null, '取不到开启态的对比度')
        assert(ratio >= 4.5, `开启态对比度只有 ${ratio.toFixed(2)}:1`)
      })

      await shot(`08-contrast-${themeOf(theme)}`)

      // 退出多选，别把状态留给后面的用例
      await evalJs(
        `const b = document.querySelector('.sidebar__head .iconbtn--on')
         if (b) b.click()
         return true`
      )
      await ctx.sleep(300)
    }

    // 收尾切回亮色，后面的用例钉的是亮色令牌值
    await setTheme(ctx, '亮色')
  }
}
