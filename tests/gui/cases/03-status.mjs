/**
 * 记录状态 —— 验证需求 ⑧（已确认 = 锁定，可退回）与需求 ⑤（新建记录可辨）。
 *
 * 五种状态：unmodified / pending / confirmed / deleted / new
 * 界面上分别对应 .recitem--unmodified / --pending / --confirmed / --deleted / --new
 *
 * 一个容易写错断言的地方：「全部」页签**故意不显示已删除记录**（见 state/search.ts），
 * 已删除的只在「已删除」页签里。所以五态要分两个页签验。
 */

import { enterDataset, switchTab } from '../nav.mjs'

/** 点列表里第一条处于指定状态的记录 */
async function pickByStatus(ctx, status) {
  const ok = await ctx.evalJs(
    `const items = [...document.querySelectorAll('.recitem')]
     const hit = items.find(e => e.classList.contains('recitem--${status}'))
     if (!hit) return false
     hit.click()
     return true`
  )
  if (!ok) {
    const seen = await ctx.evalJs(
      `return [...document.querySelectorAll('.recitem')].map(e => e.className).slice(0, 20)`
    )
    throw new Error(
      `列表里找不到 ${status} 状态的记录，当前可见项：\n      ${JSON.stringify(seen)}`
    )
  }
  await ctx.sleep(500)
  return ok
}

/** 把列表滚到底，让新建的那条（在末尾）进入虚拟化渲染范围 */
async function scrollToEnd(ctx) {
  for (let i = 0; i < 6; i += 1) {
    const done = await ctx.evalJs(
      `const list = document.querySelector('.reclist')
       if (!list) return true
       list.scrollTop = list.scrollHeight
       return !!document.querySelector('.recitem--new')`
    )
    if (done) return true
    await ctx.sleep(350)
  }
  return false
}

export default {
  name: '记录状态',
  async run(ctx) {
    const { check, assert, assertEqual, evalJs, shot } = ctx

    // 每个用例文件都自己进核心页，不依赖前一个文件留下的界面状态
    await enterDataset(ctx, 'alpaca')

    await check('「全部」页签呈现未修改 / 待确认 / 已确认三态', async () => {
      const seen = await evalJs(
        `const set = new Set()
         for (const e of document.querySelectorAll('.recitem')) {
           for (const c of e.classList) if (c.startsWith('recitem--')) set.add(c.replace('recitem--', ''))
         }
         return [...set]`
      )
      assert(seen.includes('unmodified'), `缺未修改状态：${JSON.stringify(seen)}`)
      assert(seen.includes('pending'), `缺待确认状态：${JSON.stringify(seen)}`)
      assert(seen.includes('confirmed'), `缺已确认状态：${JSON.stringify(seen)}`)
      // 已删除在「全部」里刻意不出现，这条是设计不是 bug
      assert(!seen.includes('deleted'), `「全部」页签不该显示已删除记录：${JSON.stringify(seen)}`)
    })

    await check('已确认：字段锁死 + 锁定提示 + 只能「退回修改」', async () => {
      await pickByStatus(ctx, 'confirmed')

      const state = await evalJs(
        `const note = document.querySelector('.locknote')
         const buttons = [...document.querySelectorAll('.record-head button, .record-head ~ * button')]
           .map(b => b.textContent.trim())
         // 「只能查看不能修改」的本质：页面上没有可编辑的文本控件
         const editable = [...document.querySelectorAll('.field textarea, .field input')]
           .filter(e => !e.readOnly && !e.disabled).length
         return {
           hasLockNote: !!note,
           noteText: note?.textContent?.replace(/\\s+/g, ' ').trim() || '',
           lockedFields: document.querySelectorAll('.field--locked').length,
           editable,
           buttons
         }`
      )
      assert(state.hasLockNote, '已确认记录没有锁定提示条')
      assert(/已锁定/.test(state.noteText), `提示文案不对：${state.noteText}`)
      assert(state.lockedFields > 0, '已确认记录没有一个字段标成锁定')
      assertEqual(state.editable, 0, `已确认记录仍有 ${state.editable} 个可编辑控件`)
      assert(
        state.buttons.some((b) => /退回修改/.test(b)),
        `已确认状态缺「退回修改」：${JSON.stringify(state.buttons)}`
      )
      assert(
        !state.buttons.some((b) => /^确认并下一条$/.test(b)),
        `已确认状态不该再有「确认并下一条」：${JSON.stringify(state.buttons)}`
      )
      await shot('03-confirmed-locked')
    })

    await check('退回修改后字段解锁，可以再改', async () => {
      await ctx.clickText('退回修改')
      await ctx.sleep(600)
      const state = await evalJs(
        `return {
           hasLockNote: !!document.querySelector('.locknote'),
           lockedFields: document.querySelectorAll('.field--locked').length,
           editable: [...document.querySelectorAll('.field textarea, .field input')]
             .filter(e => !e.readOnly && !e.disabled).length
         }`
      )
      assert(!state.hasLockNote, '退回后锁定提示还在')
      assertEqual(state.lockedFields, 0, `退回后还有 ${state.lockedFields} 个字段锁着`)
      assert(state.editable > 0, '退回后应重新可以编辑')
    })

    await check('待确认：字段可编辑 + 显示改动数 + 有还原入口', async () => {
      await pickByStatus(ctx, 'pending')
      const state = await evalJs(
        `const head = document.querySelector('.record-head')
         return {
           modifiedFields: document.querySelectorAll('.field--modified').length,
           lockedFields: document.querySelectorAll('.field--locked').length,
           headText: head?.textContent?.replace(/\\s+/g, ' ').trim() || '',
           hasRevert: [...document.querySelectorAll('button')].some(b => /还原/.test(b.textContent))
         }`
      )
      assert(state.modifiedFields > 0, '待确认记录没有一个字段标成已修改')
      assertEqual(state.lockedFields, 0, '待确认记录不该有锁定的字段')
      assert(/处改动/.test(state.headText), `没显示改动数：${state.headText}`)
      assert(state.hasRevert, '待确认记录缺「还原」入口')
      await shot('03-pending')
    })

    await check('「已删除」页签里能找到删除项，编辑器给「恢复」', async () => {
      await switchTab(ctx, '已删除', { expectCount: 1 })
      const count = await evalJs(`return document.querySelectorAll('.recitem').length`)
      assertEqual(count, 1, `已删除页签应只有 1 条（播种删了 index 11），实际 ${count} 条`)

      await pickByStatus(ctx, 'deleted')
      const state = await evalJs(
        `return {
           hasRestore: [...document.querySelectorAll('button')].some(b => b.textContent.trim() === '恢复'),
           hasDelete: [...document.querySelectorAll('button')].some(b => /删除这条/.test(b.textContent))
         }`
      )
      assert(state.hasRestore, '已删除记录应给「恢复」按钮')
      assert(!state.hasDelete, '已删除记录不该再显示「删除这条」')
    })

    await check('新建记录带「新建」标签，且没改动时不显示还原入口', async () => {
      await switchTab(ctx, '全部')
      const found = await scrollToEnd(ctx)
      assert(found, '滚到列表末尾也没找到 .recitem--new（新建的那条追加在末尾）')

      const state = await evalJs(
        `const item = document.querySelector('.recitem--new')
         item.click()
         return { text: item.textContent.replace(/\\s+/g, ' ').trim().slice(0, 60) }`
      )
      await ctx.sleep(600)
      const head = await evalJs(
        `const h = document.querySelector('.record-head')
         return {
           hasNewBadge: !!document.querySelector('.badge--new'),
           index: h?.querySelector('.record-head__index')?.textContent || '',
           hasRevert: [...document.querySelectorAll('button')].some(b => /还原整条/.test(b.textContent))
         }`
      )
      assert(head.hasNewBadge, `编辑器里没有「新建」徽章（列表项：${state.text}）`)
      // 「还原整条」只在 changeCount > 0 时渲染，新建且没改过 → 不出现，这是对的
      assert(!head.hasRevert, '新建且未改动的记录不该显示「还原整条」')
      await shot('03-new-record')
    })

    await check('给新建记录改动一下，「还原整条」出现且被禁用并说明原因', async () => {
      // 这条守住需求里明确的那句：「如果是新建的记录，还原整条就禁用」
      await ctx.typeInto('.field textarea', '（已编辑）把下面这句话翻译成英文')
      await ctx.sleep(700)

      const state = await evalJs(
        `const btn = [...document.querySelectorAll('button')].find(b => /还原整条/.test(b.textContent))
         if (!btn) return null
         return {
           disabled: btn.disabled,
           title: btn.title || '',
           headText: document.querySelector('.record-head')?.textContent?.replace(/\\s+/g, ' ').trim() || ''
         }`
      )
      assert(state, '新建记录改动后应出现「还原整条」按钮')
      assertEqual(state.headText.includes('新建'), true, `改动后仍应带「新建」标记：${state.headText}`)
      assert(state.disabled, '新建记录的「还原整条」必须禁用（没有原始值可还原）')
      assert(state.title.length > 0, '禁用按钮必须在 title 里说明为什么禁用')
      await shot('03-new-record-edited')
    })
  }
}
