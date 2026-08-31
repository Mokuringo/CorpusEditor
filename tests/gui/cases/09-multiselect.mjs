/**
 * 多选模式 —— 守住「进出多选不许动到列表布局」。
 *
 * 起因：勾选框原来是行首的一个 flex 项，多选时它替掉 3px 的状态色带、自己占 16px，
 * 于是序号和标题整体右移 5px。现在它改成**常驻行首槽位 + visibility 显隐**：
 * 槽宽恒定（15px），进出多选只切可见性，序号和标题的横坐标一个像素都不动。
 *
 * 第 4 条断言是这套做法的**边界守卫**，不只是回归保护：
 * 序号是右对齐的，位数越多文字越往左长，而勾选框往右挪一寸就少一寸安全区。
 * 这里实测字体的真实宽度，钉死「不遮住 4 位序号」这条线 ——
 * 换个等宽字体或者改了字号，这条会先红。
 */

import { enterDataset, ensureLightTheme } from '../nav.mjs'

/** 相对行自身左边缘量取子元素几何，避开虚拟列表 translateY 的干扰 */
const GEO_EXPR = `(sel) => {
  const row = document.querySelector('.recitem')
  if (!row) return null
  const r = row.getBoundingClientRect()
  const e = row.querySelector(sel)
  if (!e) return null
  const b = e.getBoundingClientRect()
  return { left: b.left - r.left, right: b.right - r.left, width: b.width }
}`

async function geometry(ctx) {
  return ctx.evalJs(
    `const geo = ${GEO_EXPR}
     return {
       body: geo('.recitem__body'),
       idx: geo('.recitem__idx'),
       check: geo('.recitem__check'),
       bar: geo('.recitem__bar')
     }`
  )
}

async function setMultiSelect(ctx, on) {
  const { evalJs, waitFor, sleep } = ctx
  await evalJs(
    `const b = document.querySelector('.sidebar__head .iconbtn')
     if (!b) throw new Error('找不到多选开关')
     const isOn = b.classList.contains('iconbtn--on')
     if (isOn !== ${on}) b.click()
     return true`
  )
  // 等 React 提交：勾选框常驻在 DOM，切换只改 .recitem--picking 类，
  // 所以等这个类的出现 / 消失，而不是等元素进 DOM。
  await waitFor(
    `(() => {
       const row = document.querySelector('.recitem')
       if (!row) return false
       return ${on}
         ? row.classList.contains('recitem--picking')
         : !row.classList.contains('recitem--picking')
     })()`,
    { label: `多选${on ? '开' : '关'}`, timeout: 5000 }
  )
  await sleep(300)
}

export default {
  name: '多选模式',
  async run(ctx) {
    const { check, assert, assertEqual, evalJs, shot } = ctx

    await enterDataset(ctx, 'alpaca')
    await ensureLightTheme(ctx)

    let before = null

    await check('关闭多选时勾选框隐藏（不占流）、状态色带照常显示', async () => {
      await setMultiSelect(ctx, false)
      before = await geometry(ctx)
      assert(before.body, '量不到 .recitem__body')
      assert(before.idx, '量不到 .recitem__idx')
      // 勾选框常驻在 DOM，但非多选时必须 visibility: hidden
      // （既是隐藏也是退出命中测试——行整体可点，但别留隐形热区）
      const vis = await evalJs(
        `const c = document.querySelector('.recitem__check'); return c ? getComputedStyle(c).visibility : null`
      )
      assertEqual(vis, 'hidden', `关闭多选时勾选框应隐藏，实际：${vis}`)
      assert(before.bar !== null, '状态色带丢了')
    })

    await check('打开多选后，标题与序号的横坐标一个像素都不许动', async () => {
      await setMultiSelect(ctx, true)
      const after = await geometry(ctx)
      assert(after.body, '量不到 .recitem__body')
      assertEqual(
        after.body.left,
        before.body.left,
        `标题横线动了：${before.body.left} → ${after.body.left}`
      )
      assertEqual(
        after.body.width,
        before.body.width,
        `标题宽度变了：${before.body.width} → ${after.body.width}`
      )
      assertEqual(
        after.idx.left,
        before.idx.left,
        `序号列位置动了：${before.idx.left} → ${after.idx.left}`
      )
    })

    await check('勾选框落在行首槽内、不贴面板边，且与色带不重叠', async () => {
      const g = await geometry(ctx)
      assert(g.check, '多选模式下勾选框应在 DOM 里')
      const vis = await evalJs(
        `const c = document.querySelector('.recitem__check'); return getComputedStyle(c).visibility`
      )
      assertEqual(vis, 'visible', '打开多选勾选框应可见')
      assert(g.bar !== null, '多选时状态色带不该消失（它是记录状态的唯一表达）')
      // 勾选框离行左边应 ≥ 12px（等于行 padding 起点），不再贴着面板边 0px
      assert(
        g.check.left >= 12,
        `勾选框离行左边只有 ${g.check.left.toFixed(1)}px，又贴回面板边了`
      )
      // 勾选框在色带右侧，不压色带（色带宽 3px，留 1px 容差）
      assert(
        g.check.left >= g.bar.left + 2,
        `勾选框（${g.check.left.toFixed(1)}）压到色带左边（${g.bar.left.toFixed(1)}）上了`
      )
    })

    await check('标题与改动标签在行内垂直居中（上下留白相等）', async () => {
      // 不强制要求 meta 存在：测 body 内实际子元素块（title + 可选 meta）的整体居中，
      // 这样未修改的行（只有 title）也能验。
      const m = await evalJs(
        `return (() => {
           const rows = [...document.querySelectorAll('.recitem')]
           const row = rows.find(r => r.querySelector('.recitem__body')) || rows[0]
           const body = row.querySelector('.recitem__body')
           if (!body) return null
           const kids = [...body.children]
           if (kids.length === 0) return null
           const rb = body.getBoundingClientRect()
           const first = kids[0].getBoundingClientRect()
           const last = kids[kids.length - 1].getBoundingClientRect()
           return {
             above: +(first.top - rb.top).toFixed(2),
             below: +(rb.bottom - last.bottom).toFixed(2)
           }
         })()`
      )
      assert(m, '量不到 body 或其子元素')
      assert(
        Math.abs(m.above - m.below) <= 1.5,
        `标题没居中：上方留白 ${m.above}px，下方留白 ${m.below}px`
      )
    })

    await check('勾选框不遮住 4 位序号（1000～9999 条）', async () => {
      const g = await geometry(ctx)
      // 序号右对齐，文字右端贴着列右边缘；实测等宽字体的真实宽度再反推左端
      const widths = await evalJs(
        `const idx = document.querySelector('.recitem__idx')
         if (!idx) return null
         const s = getComputedStyle(idx)
         const probe = document.createElement('span')
         probe.style.cssText = 'position:absolute;visibility:hidden;white-space:pre'
         probe.style.fontFamily = s.fontFamily
         probe.style.fontSize = s.fontSize
         probe.style.fontWeight = s.fontWeight
         probe.style.letterSpacing = s.letterSpacing
         idx.parentElement.appendChild(probe)
         const m = (t) => { probe.textContent = t; return probe.getBoundingClientRect().width }
         const out = { w4: m('1,000'), w5: m('10,000'), w6: m('100,000') }
         probe.remove()
         return out`
      )
      assert(widths, '量不到序号列的字体，探针没建起来')
      const leftOf4 = g.idx.right - widths.w4
      const leftOf5 = g.idx.right - widths.w5
      assert(
        g.check.right <= leftOf4,
        `勾选框右边缘 ${g.check.right.toFixed(1)}px 越过了 4 位序号的左端 ${leftOf4.toFixed(1)}px` +
          `（实测字宽：4 位 ${widths.w4.toFixed(1)}px / 5 位 ${widths.w5.toFixed(1)}px / ` +
          `6 位 ${widths.w6.toFixed(1)}px，序号列右边缘 ${g.idx.right.toFixed(1)}px）`
      )
      // 5 位是已知接受边界（≥1 万条时数字会与方框相交），只记录不阻断。
      // 将来要挪 left 值，先看这一行还剩多少余量。
      console.log(
        `      序号边界：4 位左端 ${leftOf4.toFixed(1)}px（安全）· ` +
          `5 位左端 ${leftOf5.toFixed(1)}px · 勾选框右边缘 ${g.check.right.toFixed(1)}px`
      )
    })

    await check('多选开关的图标真实显示（不被 UA 默认 padding 压扁）', async () => {
      // 历史踩坑：button 元素继承 UA stylesheet 的 padding: 1px 6px，
      // 20px 宽的按钮内容区只剩 6px，比这大的 svg 都会被 flex 横向压成瘦长条
      // （高度不变，宽度被压到 ~6px），看起来「图标偏小」。
      // 修复后 .sidebar__head .iconbtn { padding: 0 }，svg 真实显示 15px 宽。
      const w = await evalJs(
        `const svg = document.querySelector('.sidebar__head .iconbtn svg')
         if (!svg) return null
         return svg.getBoundingClientRect().width`
      )
      assert(w !== null, '多选开关里没有 svg')
      assert(
        Math.abs(w - 15) < 0.5,
        `图标宽度 ${w.toFixed(3)}px ≠ 预期 15px（要么 UA padding 没清掉，要么 size 改了）`
      )
    })

    await check('勾选一行后，该行与勾选框都染上主色', async () => {
      const ok = await evalJs(
        `const row = document.querySelector('.recitem')
         if (!row) return false
         row.click()
         return true`
      )
      assert(ok, '列表里没有可点的行')
      await ctx.sleep(400)
      const picked = await evalJs(
        `const row = document.querySelector('.recitem--picked')
         if (!row) return null
         const check = row.querySelector('.recitem__check')
         return {
           row: getComputedStyle(row).backgroundColor,
           check: check ? getComputedStyle(check).color : null
         }`
      )
      assert(picked, '点了行却没进选中态（.recitem--picked 没出现）')
      // 亮色下 --accent = #4b7f52
      assertEqual(picked.check, 'rgb(75, 127, 82)', `勾选框没染成主色：${picked.check}`)
    })

    await shot('09-multiselect')

    // 暗色下再留一张。几何与主题无关（所以不重复断言），
    // 但勾选框在暗色底上的可见性只能靠眼睛确认，截图是唯一的证据。
    await evalJs(`document.querySelector('button[aria-label="暗色"]')?.click(); return true`)
    await ctx.sleep(600)
    await shot('09-multiselect-dark')
    await evalJs(`document.querySelector('button[aria-label="亮色"]')?.click(); return true`)
    await ctx.sleep(600)

    // 退出多选，别把状态留给后面的用例
    await setMultiSelect(ctx, false)
  }
}
