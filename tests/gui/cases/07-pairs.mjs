/**
 * 键即角色的对话 —— ShareGPT 的 pair 变体：
 *   { system: '...', conversation: [{ human: '...', assistant: '...' }] }
 *
 * 识别不出来时，界面会把整个数组当成一段 JSON 原样铺出来（.json-edit）。
 * 这个用例守的就是「必须渲染成可逐轮编辑的对话卡片」。
 *
 * 顺带验证「已删除不需要确认」：切到已删除页签，头部不该出现「确认」按钮。
 */

import { enterDataset, ensureLightTheme, expectAtLeast, switchTab } from '../nav.mjs'

export default {
  name: '键即角色的对话',
  async run(ctx) {
    const { check, assert, assertEqual, evalJs, shot } = ctx

    await enterDataset(ctx, 'pairs')
    // 色带断言钉的是亮色令牌值，先确保主题一致
    await ensureLightTheme(ctx)

    await check('conversation 被识别成对话卡片，而不是整段 JSON', async () => {
      const turns = await evalJs(`return document.querySelectorAll('.pair').length`)
      assert(turns > 0, `没有渲染出 .pair 对话卡片（很可能退化成 JSON 编辑器了）`)
      const jsonEditors = await evalJs(
        `return document.querySelectorAll('.field .json-edit').length`
      )
      assert(jsonEditors === 0, `还留着 ${jsonEditors} 个 JSON 编辑器，说明字段没被识别成对话`)
      await shot('07-pairs-editor')
    })

    await check('一轮里有两张角色行，角色名就是键名 human / assistant', async () => {
      const rows = await evalJs(
        `const first = document.querySelector('.pair')
         if (!first) return null
         return [...first.querySelectorAll('.pairrow')].map(r => r.querySelector('select')?.value)`
      )
      assert(Array.isArray(rows), '第一轮里没有角色行')
      assert(rows.includes('human'), `缺 human 行：${JSON.stringify(rows)}`)
      assert(rows.includes('assistant'), `缺 assistant 行：${JSON.stringify(rows)}`)
    })

    await check('角色行按角色着色（human 走 user 色带、assistant 走 assistant 色带）', async () => {
      const bands = await evalJs(
        `const first = document.querySelector('.pair')
         return [...first.querySelectorAll('.pairrow')].map(r => ({
           // 只认角色那一个修饰类：class 里还可能有 pairrow--modified，
           // 用 .* 贪婪匹配会被它抢走
           role: (r.className.match(/pairrow--(system|user|assistant|tool|other)\\b/) || [])[1],
           border: getComputedStyle(r).borderLeftColor
         }))`
      )
      const human = bands.find((b) => b.role === 'user')
      const assistant = bands.find((b) => b.role === 'assistant')
      assert(human, `human 没有被归一化成 user 角色：${JSON.stringify(bands)}`)
      assert(assistant, `assistant 角色行缺失：${JSON.stringify(bands)}`)
      assert(human.border !== assistant.border, '两种角色的色带颜色一样，着色没生效')
      // 亮色主题下 human = 苔绿 #4b7f52，assistant = 石灰蓝 #4a6b8a
      assertEqual(human.border, 'rgb(75, 127, 82)', `human 色带不对：${human.border}`)
      assertEqual(assistant.border, 'rgb(74, 107, 138)', `assistant 色带不对：${assistant.border}`)
    })

    await check('system 是普通文本字段，不参与对话解析', async () => {
      const kinds = await evalJs(
        `return [...document.querySelectorAll('.field')].map(f => ({
           name: f.querySelector('.field__name')?.textContent?.trim(),
           kind: f.querySelector('.field__kind')?.textContent?.trim()
         }))`
      )
      const system = kinds.find((k) => k.name === 'system')
      const conversation = kinds.find((k) => k.name === 'conversation')
      assert(system, `没有 system 字段：${JSON.stringify(kinds)}`)
      assertEqual(system.kind, '文本', 'system 应是普通文本字段')
      assert(conversation?.kind?.includes('对话'), `conversation 应识别为对话：${JSON.stringify(kinds)}`)
    })

    await check('改动过的轮次有改动标记', async () => {
      const modified = await evalJs(`return document.querySelectorAll('.pairrow--modified').length`)
      assert(modified > 0, '播种改过第一轮 assistant 的内容，界面上应有改动标记')
    })

    await check('已删除的记录：头部没有「确认」按钮，但有「恢复」', async () => {
      await switchTab(ctx, '已删除', { expectCount: 0 })
      // 这个样例没埋删除，先删一条再造现场
      await switchTab(ctx, '全部')
      await expectAtLeast(ctx, 1, '回到「全部」页签应有记录')
      await ctx.evalJs(
        `const item = document.querySelector('.recitem')
         if (!item) return false
         item.click()
         return true`
      )
      await ctx.sleep(500)
      await ctx.clickText('删除这条')
      await ctx.sleep(400)
      await switchTab(ctx, '已删除', { expectCount: 1 })

      const buttons = await evalJs(
        `return [...document.querySelectorAll('.record-head__actions button')].map(b => b.textContent.trim())`
      )
      assert(
        !buttons.some((t) => t.includes('确认')),
        `已删除的记录不该出现「确认」按钮：${JSON.stringify(buttons)}`
      )
      assert(
        buttons.some((t) => t.includes('恢复')),
        `已删除的记录必须有「恢复」入口：${JSON.stringify(buttons)}`
      )
      await shot('07-pairs-deleted')

      // 列表项里的行内还原按钮也要在
      const restore = await evalJs(`return document.querySelectorAll('.recitem__restore').length`)
      assert(restore > 0, '已删除的列表项里应该有行内「还原」按钮')
    })

    await check('点行内「还原」能把记录恢复回去', async () => {
      await ctx.evalJs(
        `const b = document.querySelector('.recitem__restore')
         if (!b) return false
         b.click()
         return true`
      )
      await ctx.sleep(600)
      await switchTab(ctx, '已删除')
      const left = await evalJs(`return document.querySelectorAll('.recitem').length`)
      assertEqual(left, 0, '还原之后「已删除」页签应该空了')
    })
  }
}
