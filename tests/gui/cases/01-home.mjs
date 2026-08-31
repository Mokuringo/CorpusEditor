/**
 * 首页 —— 验证需求 ①②③④（文案定位 / 图标 / 布局 / 自定义标题栏）
 * 以及「继续上次」的会话卡片与「查看全部」展开。
 */

import { expandRecent, collapseRecent } from '../nav.mjs'

export default {
  name: '首页',
  async run(ctx) {
    const { check, assert, assertEqual, evalJs, shot, samples } = ctx
    // 会话卡片数跟着样例文件数走：加一种样例格式时这里不用改，
    // 硬编码 4 会在新增样例后变成假失败
    const sampleNames = Object.values(samples.files).map((p) => p.split(/[\\/]/).pop())
    const sampleCount = sampleNames.length

    await check('React 挂载后是首页', async () => {
      assert(await evalJs(`return !!document.querySelector('.home')`), '没渲染出 .home')
    })

    await check('标题栏存在，且带自绘窗口控制三键', async () => {
      const bar = await evalJs(
        `const tb = document.querySelector('.titlebar')
         if (!tb) return null
         return {
           mark: !!tb.querySelector('.titlebar__mark svg'),
           name: tb.querySelector('.titlebar__name')?.textContent?.trim() || '',
           file: tb.querySelector('.titlebar__file')?.textContent?.trim() || '',
           controls: [...tb.querySelectorAll('button')].map(b => b.getAttribute('aria-label') || b.title || '')
         }`
      )
      assert(bar, '找不到 .titlebar')
      assert(bar.mark, '标题栏左上角没有 BrandMark 图标')
      assertEqual(bar.name, 'CorpusEditor', '标题栏应用名不对')
      assertEqual(
        bar.file,
        'LLM 指令微调数据编辑器',
        '无数据集时标题栏中间应显示产品副标题'
      )
      for (const label of ['最小化', '最大化', '关闭']) {
        assert(
          bar.controls.some((c) => c.includes(label)),
          `标题栏缺「${label}」按钮（实际：${JSON.stringify(bar.controls)}）`
        )
      }
    })

    await check('主题切换是三档（亮 / 暗 / 跟随系统）', async () => {
      const modes = await evalJs(
        `return [...document.querySelectorAll('.titlebar .segmented button')].map(b => b.getAttribute('aria-label'))`
      )
      assertEqual(modes.join(','), '亮色,暗色,跟随系统', `主题按钮不对：${JSON.stringify(modes)}`)
    })

    await check('H1 点明这是指令微调数据工具', async () => {
      const h1 = await evalJs(`return document.querySelector('.home__title')?.textContent?.trim() || ''`)
      assert(/指令微调/.test(h1), `标题没提到「指令微调」：${h1}`)
    })

    await check('H1 按语义断成两行：创建和修改 / 指令微调数据', async () => {
      // 断点必须写死在结构里。靠 max-width 碰运气的话，ch 单位是数字 0 的宽度，
      // 14ch 只够放 8 个汉字，会在第 8 个字后断成「创建和修改指令微 / 调数据」。
      const lines = await evalJs(
        `return [...document.querySelectorAll('.home__title-line')].map(e => e.textContent.trim())`
      )
      assertEqual(lines.length, 2, `标题应有两行结构：${JSON.stringify(lines)}`)
      assertEqual(lines[0], '创建和修改', `第一行不对：${JSON.stringify(lines)}`)
      assertEqual(lines[1], '指令微调数据', `第二行不对：${JSON.stringify(lines)}`)
      // 每行自己不能再折行，否则断点又失控了
      const heights = await evalJs(
        `return [...document.querySelectorAll('.home__title-line')]
           .map(e => Math.round(e.getBoundingClientRect().height / parseFloat(getComputedStyle(e).fontSize) / 1.18))`
      )
      for (const n of heights) {
        assert(n <= 1, `某一行自己折行了（约占 ${n} 行高）：${JSON.stringify(lines)}`)
      }
    })

    await check('副文是商务口吻，不再出现「读入」这类口语', async () => {
      const lede = await evalJs(`return document.querySelector('.home__lede')?.textContent?.trim() || ''`)
      assert(lede.length > 0, '副文是空的')
      for (const word of ['读入', '关掉再打开']) {
        assert(!lede.includes(word), `副文里还留着口语词「${word}」：${lede}`)
      }
      assert(lede.includes('支持'), `副文应以「支持」引出格式：${lede}`)
    })

    await check('六张能力卡齐全且动词开头', async () => {
      const cards = await evalJs(
        `return [...document.querySelectorAll('.capcard')].map(c => ({
           title: c.querySelector('.capcard__title')?.textContent?.trim() || '',
           desc: c.querySelector('.capcard__desc')?.textContent?.trim() || '',
           icon: !!c.querySelector('.capcard__icon svg')
         }))`
      )
      assertEqual(cards.length, 6, `能力卡数量不对：${cards.length}`)
      for (const c of cards) {
        assert(c.title.length > 0, '有卡片没有标题')
        assert(c.desc.length > 0, `「${c.title}」没有说明文字`)
        assert(c.icon, `「${c.title}」没有图标`)
      }
      const titles = cards.map((c) => c.title).join(',')
      assertEqual(
        titles,
        '只读打开,逐条编辑,全局替换,新增记录,进度恢复,安全导出',
        `能力卡标题变了：${titles}`
      )
    })

    await check('两个主操作按钮都在，且「新建数据集」在左、「打开数据文件」在右', async () => {
      const btns = await evalJs(
        `return [...document.querySelectorAll('.home__actions button')].map(b => b.textContent.trim())`
      )
      assert(btns.some((t) => /打开数据文件/.test(t)), `缺「打开数据文件」：${JSON.stringify(btns)}`)
      assert(btns.some((t) => /新建数据集/.test(t)), `缺「新建数据集」：${JSON.stringify(btns)}`)
      // 顺序是产品要求：次要动作在左、主动作在右
      assert(
        /新建数据集/.test(btns[0] ?? ''),
        `第一个按钮应是「新建数据集」：${JSON.stringify(btns)}`
      )
      assert(
        /打开数据文件/.test(btns[1] ?? ''),
        `第二个按钮应是「打开数据文件」：${JSON.stringify(btns)}`
      )
    })

    await check('字段模板按格式流派分组，且含两种 ShareGPT 写法', async () => {
      await ctx.clickText('新建数据集')
      await ctx.waitFor(`!!document.querySelector('#nd-template')`, { label: '新建数据集弹窗打开' })
      await ctx.sleep(300)

      const groups = await evalJs(
        `return [...document.querySelectorAll('#nd-template optgroup')].map(g => ({
           label: g.label,
           items: [...g.children].map(o => o.value)
         }))`
      )
      const labels = groups.map((g) => g.label)
      for (const label of ['通用', '指令微调 · SFT', '多轮对话', '偏好对比 · DPO', '问答']) {
        assert(labels.includes(label), `模板下拉缺分组「${label}」：${JSON.stringify(labels)}`)
      }
      // 分组顺序要和数据格式流派一致，不是随便排的
      assertEqual(
        labels.indexOf('多轮对话') < labels.indexOf('偏好对比 · DPO'),
        true,
        `分组顺序不对：${JSON.stringify(labels)}`
      )

      const chatGroup = groups.find((g) => g.label === '多轮对话')
      assert(
        chatGroup.items.includes('chat') && chatGroup.items.includes('sharegpt'),
        `多轮对话组应同时有 role/content 与 from/value 两种写法：${JSON.stringify(chatGroup)}`
      )
      await shot('01-home-template-groups')

      await ctx.clickText('取消')
      await ctx.sleep(300)
    })

    await check('7 种格式都列出来了', async () => {
      const formats = await evalJs(
        `return [...document.querySelectorAll('.home__formats .badge')].map(b => b.textContent.trim())`
      )
      for (const f of ['JSONL', 'JSON', 'CSV', 'TSV', 'YAML', 'Parquet', 'TXT']) {
        assert(formats.includes(f), `格式列表缺 ${f}：${JSON.stringify(formats)}`)
      }
    })

    await check('「继续上次」默认只显示最近 3 份', async () => {
      const n = await evalJs(`return document.querySelectorAll('.rcard').length`)
      // 首页刻意只铺 3 张，多的靠「查看全部」
      assertEqual(n, 3, `未展开时应只显示 3 张，实际 ${n} 张`)
    })

    await check('展开「查看全部」后每份样例都在', async () => {
      await expandRecent(ctx)
      const names = await evalJs(
        `return [...document.querySelectorAll('.rcard__name')].map(e => e.textContent.trim())`
      )
      for (const n of sampleNames) {
        assert(names.includes(n), `会话列表缺 ${n}：${JSON.stringify(names)}`)
      }
    })

    await check('会话卡片的统计数字与播种一致', async () => {
      const stats = await evalJs(
        `const card = [...document.querySelectorAll('.rcard')]
           .find(c => /alpaca/.test(c.textContent || ''))
         if (!card) return null
         const out = {}
         for (const s of card.querySelectorAll('.stat')) {
           out[s.querySelector('.stat__label').textContent.trim()] =
             s.querySelector('.stat__value').textContent.trim()
         }
         return out`
      )
      assert(stats, '找不到 alpaca 的会话卡片（需要先展开「查看全部」）')
      assertEqual(stats['总条数'], '120', '总条数不对')
      assertEqual(stats['已确认'], '5', '已确认数不对（播种了 5 条）')
      assertEqual(stats['已改'], '3', '已改数不对（播种改了 3 条）')
      assertEqual(stats['新建'], '1', '新建数不对（播种追加了 1 条）')
      assertEqual(stats['已删'], '1', '已删数不对（播种删了 1 条）')
    })

    // 这条专门守住之前修掉的 bug：「查看全部」按钮没绑 onClick
    await check('超过 3 份会话时「查看全部」能展开并收起', async () => {
      await collapseRecent(ctx)
      const before = await evalJs(`return document.querySelectorAll('.rcard').length`)
      assertEqual(before, 3, `未展开时应只显示 3 张，实际 ${before} 张`)

      await ctx.clickText('查看全部')
      await ctx.sleep(400)
      const expanded = await evalJs(
        `return {
           count: document.querySelectorAll('.rcard').length,
           single: !!document.querySelector('.recent-row--all'),
           label: [...document.querySelectorAll('.home__recent-head button')]
                    .map(b => b.textContent.trim())[0] || ''
         }`
      )
      assertEqual(expanded.count, sampleCount, `展开后应有 ${sampleCount} 张，实际 ${expanded.count} 张`)
      assert(expanded.single, '展开后应切到单列布局（.recent-row--all）')
      assertEqual(expanded.label, '收起', '展开后按钮文字应变「收起」')

      await shot('01-home-expanded')

      await ctx.clickText('收起')
      await ctx.sleep(400)
      const collapsed = await evalJs(`return document.querySelectorAll('.rcard').length`)
      assertEqual(collapsed, 3, `收起后应回到 3 张，实际 ${collapsed} 张`)
    })

    await shot('01-home')
  }
}
