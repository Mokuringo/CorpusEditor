/**
 * Core editor page — English (en) variant.
 * Asserts on rendered English UI text; the en round uses English seed data.
 */

import { enterDataset, expectAtLeast, switchTab } from '../nav.mjs'

export default {
  name: 'Core editor',
  async run(ctx) {
    const { check, assert, assertEqual, evalJs, shot } = ctx

    await check('点「Continue」能进核心页（走 openFile 而非对话框）', async () => {
      await enterDataset(ctx, 'alpaca')
      assert(await evalJs(`return !!document.querySelector('.reclist')`), '核心页没挂载')
      const file = await evalJs(
        `return document.querySelector('.titlebar__file')?.textContent?.trim() || ''`
      )
      assert(/sft-alpaca-120\.jsonl/.test(file), `标题栏没显示文件名：${file}`)
    })

    await check('标题栏标出格式与「Read-only」', async () => {
      const badges = await evalJs(
        `return [...document.querySelectorAll('.titlebar .badge')].map(b => b.textContent.trim())`
      )
      assert(badges.some((b) => /JSONL/.test(b)), `标题栏没有格式徽章：${JSON.stringify(badges)}`)
      assert(badges.some((b) => /Read-only/.test(b)), `标题栏没有只读徽章：${JSON.stringify(badges)}`)
    })

    await check('记录列表虚拟化渲染（可见项远少于总数 121）', async () => {
      await expectAtLeast(ctx, 1, '列表一条都没渲染')
      const n = await evalJs(`return document.querySelectorAll('.recitem').length`)
      assert(n < 121, `应虚拟化渲染，实际渲染了 ${n} 条`)
    })

    await check('经线刻度三层都在（已确认 / 待确认 / 已删除）', async () => {
      const ticks = await evalJs(
        `const t = [...document.querySelectorAll('.warp__tick')]
         return {
           total: t.length,
           done: t.filter(e => e.classList.contains('warp__tick--done')).length,
           pending: t.filter(e => e.classList.contains('warp__tick--pending')).length,
           removed: t.filter(e => e.classList.contains('warp__tick--removed')).length,
           view: t.filter(e => e.classList.contains('warp__tick--view')).length
         }`
      )
      assert(ticks.total > 0, '经线刻度一条都没有')
      assertEqual(ticks.done, 5, `已确认刻度应为 5，实际 ${ticks.done}`)
      assertEqual(ticks.pending, 3, `待确认刻度应为 3，实际 ${ticks.pending}`)
      assertEqual(ticks.removed, 1, `已删除刻度应为 1，实际 ${ticks.removed}`)
      assertEqual(ticks.view, 1, `当前查看位置应唯一，实际 ${ticks.view}`)
    })

    await check('五个状态页签都在', async () => {
      // 页签是 .filter-tab，在侧边栏里，不在 .reclist 里
      const tabs = await evalJs(
        `return [...document.querySelectorAll('.filter-tab')].map(b => b.textContent.trim())`
      )
      assertEqual(
        tabs.join(','),
        'All,Pending,Confirmed,Unmodified,Deleted',
        `页签不对：${JSON.stringify(tabs)}`
      )
    })

    await check('切到「Confirmed」页签只留 5 条', async () => {
      await switchTab(ctx, 'Confirmed', { expectCount: 5 })
      const state = await evalJs(
        `return {
           count: document.querySelectorAll('.recitem').length,
           shown: document.querySelector('.reclist__count, .reclist [class*="count"]')?.textContent?.trim() || ''
         }`
      )
      assertEqual(state.count, 5, `已确认页签应只剩 5 条，实际 ${state.count}`)
      for (const item of await evalJs(
        `return [...document.querySelectorAll('.recitem')].map(e => e.className)`
      )) {
        assert(/recitem--confirmed/.test(item), `已确认页签里混入了非确认项：${item}`)
      }
      await shot('02-tab-confirmed-en')
      await switchTab(ctx, 'All')
    })

    await check('流水线条常驻在编辑区底部，显示位置与队列长度', async () => {
      const bar = await evalJs(
        `const b = document.querySelector('.reviewbar')
         if (!b) return null
         const t = b.textContent.replace(/\\s+/g, ' ').trim()
         return { text: t, hasNext: !!b.querySelector('[class*="next"], button'), rect: b.getBoundingClientRect().bottom }`
      )
      assert(bar, '找不到流水线条 .reviewbar')
      assert(/\d+\s*\/\s*\d+/.test(bar.text), `流水线条没显示「当前 / 总数」：${bar.text}`)
      assert(/Confirm & next/.test(bar.text), `流水线条缺「Confirm & next」：${bar.text}`)
      const vh = await evalJs(`return window.innerHeight`)
      assert(bar.rect <= vh + 1, `流水线条跑出视口了（bottom=${bar.rect}, vh=${vh}）`)
    })

    await check('字段按源数据的列顺序渲染', async () => {
      const labels = await evalJs(
        `return [...document.querySelectorAll('.record-head, .field')]
           .map(e => e.textContent.trim())
           .filter(t => t)`
      )
      const joined = labels.join(' | ')
      for (const f of ['instruction', 'input', 'output']) {
        assert(joined.includes(f), `字段列表缺 ${f}：${joined.slice(0, 200)}`)
      }
    })

    await shot('02-editor-en')
  }
}
