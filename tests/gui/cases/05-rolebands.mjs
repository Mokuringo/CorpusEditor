/**
 * 角色色带 —— 需求 ⑦ 里点名「不要随意改动」的签名元素之一。
 * system 陶土 / user 苔绿 / assistant 石灰蓝，三条必须各不相同，否则等于没分角色。
 *
 * 这条用例单独占一个文件，因为它要切到另一份数据集（多轮对话）。
 */

import { enterDataset, ensureLightTheme } from '../nav.mjs'

export default {
  name: '角色色带',
  async run(ctx) {
    const { check, assert, assertEqual, evalJs, shot } = ctx

    // 04 用例动过主题，这里钉的是亮色令牌值，先确保回到亮色
    await ensureLightTheme(ctx)
    await enterDataset(ctx, 'chat')

    await check('一轮对话里能同时看到三种角色', async () => {
      const roles = await evalJs(
        `return [...document.querySelectorAll('.msg')]
           .map(e => (e.className.match(/msg--(system|user|assistant|tool)/) || [])[1])
           .filter(Boolean)`
      )
      const uniq = [...new Set(roles)]
      for (const r of ['system', 'user', 'assistant']) {
        assert(uniq.includes(r), `页面上看不到 ${r} 轮次：${JSON.stringify(uniq)}`)
      }
    })

    await check('每条轮次都有色带元素（不是靠 border 画的）', async () => {
      const missing = await evalJs(
        `return [...document.querySelectorAll('.msg')]
           .filter(e => !e.querySelector('.msg__band')).length`
      )
      assertEqual(missing, 0, `有 ${missing} 条轮次缺 .msg__band`)
    })

    await check('三种角色色带取到设计令牌值且互不相同', async () => {
      // .msg__band 是 4px 宽的子元素，颜色写在 background 上（见 app.css:1149-1166）
      const colors = await evalJs(
        `const pick = (role) => {
           const el = document.querySelector('.msg--' + role + ' .msg__band')
           if (!el) return null
           const cs = getComputedStyle(el)
           return { bg: cs.backgroundColor, w: cs.width }
         }
         return { system: pick('system'), user: pick('user'), assistant: pick('assistant') }`
      )
      assert(colors.system, '取不到 system 色带（.msg--system .msg__band 不存在）')
      assert(colors.user, '取不到 user 色带（.msg--user .msg__band 不存在）')
      assert(colors.assistant, '取不到 assistant 色带（.msg--assistant .msg__band 不存在）')

      const set = new Set([colors.system.bg, colors.user.bg, colors.assistant.bg])
      assertEqual(
        set.size,
        3,
        `三种角色色带应各不相同，实际：${JSON.stringify(colors)}`
      )

      // 亮色主题下的令牌值：陶土 / 苔绿 / 石灰蓝，钉死避免误改成同色
      assertEqual(colors.system.bg, 'rgb(180, 96, 60)', 'system 应为陶土色 --role-system')
      assertEqual(colors.user.bg, 'rgb(75, 127, 82)', 'user 应为苔绿 --role-user')
      assertEqual(colors.assistant.bg, 'rgb(74, 107, 138)', 'assistant 应为石灰蓝 --role-assistant')
      // 4px 是 rem 换算来的，别写成字符串相等，浮点会差一点点
      const w = parseFloat(colors.system.w)
      assert(w > 3.5 && w < 4.5, `色带宽度应约 4px，实际 ${colors.system.w}`)
    })

    await shot('05-role-bands')
  }
}
