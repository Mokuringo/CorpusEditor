/**
 * 界面导航的共享动作。
 *
 * 两个坑，都在这里集中处理：
 *  1. 首页「继续上次」默认只显示 3 张卡，第 4 张及以后要先点「查看全部」才出现
 *  2. 关数据集的按钮没有 aria-label，只能按 title="关闭文件" 找
 */

/**
 * 列表此刻的渲染状况。
 *
 * 出错时打全这一份，是为了一眼分清两种「一条都没有」：
 *   · 没有 .reclist__inner → 可见集合本身是空的（筛选/搜索筛没了，或数据没加载）
 *   · 有 .reclist__inner 但 items 为 0 → 集合有数据，是虚拟列表算出了一段空区间
 * 前者和后者要改的地方完全不同，只报一句「实际 0」会让人往错的方向查。
 */
async function listState(ctx) {
  return ctx.evalJs(
    `const list = document.querySelector('.reclist')
     const inner = document.querySelector('.reclist__inner')
     return {
       items: document.querySelectorAll('.recitem').length,
       innerHeight: inner ? inner.style.height : '(没有 .reclist__inner，可见集合是空的)',
       clientHeight: list ? list.clientHeight : -1,
       scrollTop: list ? list.scrollTop : -1,
       empty: document.querySelector('.reclist .empty')?.textContent?.trim() || '',
       meta: document.querySelector('.sidebar__meta')?.textContent?.replace(/\\s+/g, ' ').trim() || '',
       activeTab: document.querySelector('.filter-tab--on')?.textContent?.trim() || ''
     }`
  )
}

/** 等列表渲染到期望条数。等不到就把现场附上，别只留一句「实际 0」。 */
async function expectListCount(ctx, n, message) {
  try {
    await ctx.waitFor(`document.querySelectorAll('.recitem').length === ${n}`, {
      label: message,
      timeout: 8000
    })
  } catch {
    throw new Error(`${message}\n      ${JSON.stringify(await listState(ctx))}`)
  }
}

/** 等列表至少渲染出 n 条。同样是等不到就附现场。 */
export async function expectAtLeast(ctx, n, message) {
  try {
    await ctx.waitFor(`document.querySelectorAll('.recitem').length >= ${n}`, {
      label: message,
      timeout: 8000
    })
  } catch {
    throw new Error(`${message}\n      ${JSON.stringify(await listState(ctx))}`)
  }
}

/**
 * 切状态页签。用 class 精确点，不用文本匹配 ——
 * 「已确认」这三个字在页面上到处都是（页签、记录徽章、批量按钮），clickText 会点错。
 *
 * 两道等待一道都不能省，少一道就会偶发失败：
 *  1. 等页签真的变高亮。点完立刻读，React 可能还没提交这一帧。
 *  2. 给了 expectCount 就等条数到那个数。虚拟化列表在 count 骤减时
 *     （120 → 5）有几帧会算出空区间，固定 sleep 在慢机器上正好读到这一帧。
 */
export async function switchTab(ctx, label, { expectCount } = {}) {
  const { evalJs, waitFor, sleep } = ctx
  const ok = await evalJs(
    `const b = [...document.querySelectorAll('.filter-tab')]
       .find(e => e.textContent.trim() === ${JSON.stringify(label)})
     if (!b) return false
     b.click()
     return true`
  )
  if (!ok) throw new Error(`找不到状态页签「${label}」`)
  await waitFor(
    `(() => {
       const b = [...document.querySelectorAll('.filter-tab')]
         .find(e => e.textContent.trim() === ${JSON.stringify(label)})
       return !!b && b.classList.contains('filter-tab--on')
     })()`,
    { label: `页签「${label}」生效`, timeout: 5000 }
  )
  if (typeof expectCount === 'number') {
    await expectListCount(ctx, expectCount, `切到「${label}」后应剩 ${expectCount} 条`)
  }
  await sleep(250)
}

/** 确保处于亮色主题（角色色带的断言钉的是亮色令牌值）。
 *  主题分段控件顺序固定为 亮/暗/跟随系统，第一个按钮永远是对应的亮色档，
 *  所以按索引点、不依赖文案，中英文套件都通用。 */
export async function ensureLightTheme(ctx) {
  const { evalJs, sleep } = ctx
  const theme = await evalJs(`return document.documentElement.dataset.theme`)
  if (theme === 'light') return
  await evalJs(`document.querySelector('.segmented button').click(); return true`)
  await sleep(600)
}

/** 回到首页（如果正开着数据集就先关掉）。
 *  关文件按钮用稳定的 data-testid，不依赖「关闭文件」这类文案。 */
export async function goHome(ctx) {
  const { evalJs, waitFor, sleep } = ctx
  if (await evalJs(`return !!document.querySelector('.home')`)) return
  await evalJs(
    `[...document.querySelectorAll('button[data-testid="close-file"]')].pop()?.click()
     return true`
  )
  await waitFor(`!!document.querySelector('.home')`, { label: '回到首页' })
  await sleep(400)
}

/**
 * 展开「继续上次」（会话超过 3 份时才有这个按钮）。
 * 按状态判断：没有 .recent-row--all 就点一下切换按钮，不依赖「查看全部」文案。
 */
export async function expandRecent(ctx) {
  const { evalJs, waitFor, sleep } = ctx
  const need = await evalJs(`return !document.querySelector('.recent-row--all')
    && !!document.querySelector('.home__recent-head button')`)
  if (!need) return
  await evalJs(`document.querySelector('.home__recent-head button').click(); return true`)
  await waitFor(`!!document.querySelector('.recent-row--all')`, { label: '展开最近列表', timeout: 5000 })
  await sleep(400)
}

/** 收起「继续上次」：有 .recent-row--all 就点一下切换按钮。 */
export async function collapseRecent(ctx) {
  const { evalJs, waitFor, sleep } = ctx
  const need = await evalJs(`return !!document.querySelector('.recent-row--all')
    && !!document.querySelector('.home__recent-head button')`)
  if (!need) return
  await evalJs(`document.querySelector('.home__recent-head button').click(); return true`)
  await waitFor(`!document.querySelector('.recent-row--all')`, { label: '收起最近列表', timeout: 5000 })
  await sleep(400)
}

/**
 * 打开指定数据集。走首页「继续上次」的「继续」按钮 ——
 * 它直接调 openFile(session.sourcePath)，不经过系统对话框。
 * 继续按钮用 .rcard__actions 里非 iconbtn 的那个（Resume 主按钮），不依赖文案。
 */
export async function enterDataset(ctx, keyword) {
  const { evalJs, waitFor, sleep } = ctx
  await goHome(ctx)
  await expandRecent(ctx)
  const clicked = await evalJs(
    `const card = [...document.querySelectorAll('.rcard')]
       .find(c => new RegExp(${JSON.stringify(keyword)}).test(c.textContent || ''))
     if (!card) return false
     const btn = card.querySelector('.rcard__actions button:not(.iconbtn)')
     if (!btn) return false
     btn.click()
     return true`
  )
  if (!clicked) throw new Error(`首页找不到含「${keyword}」的会话卡片（可能要先展开「查看全部」）`)
  await waitFor(`!!document.querySelector('.reclist')`, { label: '核心页挂载' })
  // .reclist 在可见集合为空时也照样渲染（里面只有一句「没有符合条件的记录」），
  // 所以光等它出现会提前通过。要等到列表真的给出了结果 —— 有记录项，或明确地说没有。
  await waitFor(
    `(() => {
       if (document.querySelectorAll('.recitem').length > 0) return true
       return !!document.querySelector('.reclist .empty')
     })()`,
    { label: '记录列表出结果', timeout: 20000 }
  )
  // 会话文件会记住上次停留的页签。上一个用例若是中途报错留在「已确认」上，
  // 这边的筛选就被带过来了 —— 每个用例都从「全部」起步，失败才不会串场。
  // 「全部」永远是第一个状态页签，按索引点，不依赖文案。
  await evalJs(`const b = document.querySelector('.filter-tab'); if (b) b.click(); return true`)
  await sleep(400) // 等虚拟化列表与动画稳定
}
