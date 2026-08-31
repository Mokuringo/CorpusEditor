/**
 * 生成 GUI 测试用的样例数据集。
 *
 * 每次跑测试都重新生成到临时目录，保证可复现：
 * 不依赖用户磁盘上任何既有文件，也不会被上一次跑测试留下的进度污染。
 */

import fs from 'node:fs'
import path from 'node:path'

const TOPICS = [
  '今天下午三点的会议改到明天上午了。',
  '这份报告的数据口径和上周不一致。',
  '客户希望把交付时间提前一周。',
  '服务器在凌晨出现了三次超时。',
  '新版本的用户引导流程需要重做。'
]

const VERBS = ['翻译', '摘要', '改写', '扩写', '整理', '校对']

/** 故意埋的脏数据：拼写错误和未完成标记，方便顺手验证全局替换 */
const DIRT = [
  { bad: 'teh', good: 'the' },
  { bad: 'TODO:', good: '' }
]

function dirty(text, i) {
  if (i % 10 === 3) return text.replace(/the/gi, 'teh')
  if (i % 17 === 5) return `TODO: ${text}`
  return text
}

export function writeSamples(dir) {
  fs.mkdirSync(dir, { recursive: true })
  const files = {}

  // 1) Alpaca 风格 SFT
  const alpaca = []
  for (let i = 0; i < 120; i += 1) {
    const topic = TOPICS[i % TOPICS.length]
    const verb = VERBS[i % VERBS.length]
    alpaca.push({
      instruction: `把下面这句话${verb}`,
      input: topic,
      output: dirty(`（第 ${i} 条）${topic} —— 已${verb}处理。`, i),
      source: 'synthetic',
      score: Number((3 + ((i * 37) % 20) / 10).toFixed(2))
    })
  }
  files.alpaca = path.join(dir, 'sft-alpaca-120.jsonl')
  fs.writeFileSync(files.alpaca, alpaca.map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf8')

  // 2) 多轮对话（含 system 轮次，用来验证角色色带）
  const chats = []
  for (let i = 0; i < 40; i += 1) {
    chats.push({
      id: `chat-${String(i).padStart(3, '0')}`,
      messages: [
        { role: 'system', content: '你是一个严谨的中文助手，回答要简洁。' },
        { role: 'user', content: `第 ${i} 个问题：${TOPICS[i % TOPICS.length]}` },
        { role: 'assistant', content: dirty(`（第 ${i} 条回答）已收到，我的判断如下。`, i) },
        { role: 'user', content: '再详细说说。' }
      ],
      turns: 2
    })
  }
  files.chat = path.join(dir, 'chat-multiround-40.json')
  fs.writeFileSync(files.chat, JSON.stringify(chats, null, 2), 'utf8')

  // 3) DPO 偏好对
  const rows = ['prompt,chosen,rejected']
  for (let i = 0; i < 60; i += 1) {
    const topic = TOPICS[i % TOPICS.length]
    rows.push(`请${VERBS[i % VERBS.length]}：${topic},（第 ${i} 条）已${VERBS[i % VERBS.length]}完成。,我不知道。`)
  }
  files.dpo = path.join(dir, 'dpo-pairs-60.csv')
  fs.writeFileSync(files.dpo, rows.join('\n') + '\n', 'utf8')

  // 4) 只有表头的空白 CSV —— 专门用来试「新增一条」
  files.blank = path.join(dir, 'blank.csv')
  fs.writeFileSync(files.blank, '\uFEFFinstruction,input,output\n', 'utf8')

  // 5) 键即角色的多轮对话（ShareGPT 的 pair 变体）
  //    一轮写成 { human: '...', assistant: '...' }，键名本身就是角色。
  //    识别不出来的话界面会把整段 JSON 原样铺出来 —— 这条样例就是防那个回归的。
  const pairs = []
  for (let i = 0; i < 30; i += 1) {
    const topic = TOPICS[i % TOPICS.length]
    pairs.push({
      system: '你是一个名为沐雪的可爱AI女孩子',
      conversation: [
        { human: `<生成推文: ${VERBS[i % VERBS.length]}>`, assistant: dirty(topic, i) },
        { human: '再来一条', assistant: dirty(`（第 ${i} 条）${topic}`, i + 1) }
      ]
    })
  }
  files.pairs = path.join(dir, 'sharegpt-pairs-30.jsonl')
  fs.writeFileSync(files.pairs, pairs.map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf8')

  return { dir, files, dirt: DIRT }
}

/**
 * 每种样例要埋的状态。GUI 测试断言的不是「能不能打开」，
 * 而是「五种记录状态在界面上长得对不对」，所以播种必须把状态铺全。
 */
export function seedPlan() {
  return {
    alpaca: {
      // 改 3 条。注意：值若与原文相同会被 pruneEqualToOriginal 剪掉，
      // 所以每条都要是真的改动（第 0 条原文就是「已翻译处理」，别照抄）
      edits: {
        '0': { '["output"]': '（第 0 条，已校订）会议改到明天上午了。 —— 已翻译并润色。' },
        '3': {
          '["instruction"]': '把下面这句话翻译成英文',
          '["output"]': '（已校订）这份报告的数据口径和上周不一致。'
        },
        '7': { '["output"]': '（已校订）这条回复重写过，用来验证「待确认」样式。' }
      },
      confirmed: [1, 2, 5, 8, 13],
      deleted: [11],
      added: [
        {
          pos: 120,
          data: {
            instruction: '（新建）把下面这句话翻译成英文',
            input: '会议改到明天上午了。',
            output: 'The meeting has been moved to tomorrow morning.',
            source: 'new',
            score: 0
          }
        }
      ]
    },
    chat: {
      edits: {
        '0': { '["messages",1,"content"]': '（已校订）第 0 个问题：会议改到明天上午了，对吗？' },
        '2': { '["messages",2,"content"]': '（已校订）assistant 轮次也被改过，用来验证石灰蓝色带。' }
      },
      confirmed: [3, 4]
    },
    dpo: {},
    blank: {},
    pairs: {
      edits: {
        '0': { '["conversation",0,"assistant"]': '（已校订）今天下午三点的会议改到明天上午了。' }
      },
      confirmed: [2]
    }
  }
}
