/**
 * CDP 客户端 —— 连进真实的 Electron 渲染进程，执行 JS、截屏、点按钮。
 *
 * 零依赖：WebSocket 协议自己实现（CDP 只用文本帧，握手与分帧足够稳定），
 * 这样 `npm install` 的结果不会因为加了 GUI 测试而变化，与 tests/e2e/smoke.mjs 的取向一致。
 *
 * 为什么不用 Playwright / Spectron：它们要装浏览器驱动、要真的起窗口跑一整套协议；
 * 这里只要「连上一个已经跑起来的 Electron」，100 行就够。
 */

import net from 'node:net'
import crypto from 'node:crypto'
import fs from 'node:fs'
import { EventEmitter } from 'node:events'

const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11'

/* ------------------------------------------------------------------ *
 * 最小 WebSocket 客户端
 * ------------------------------------------------------------------ */

const OP = { CONT: 0x0, TEXT: 0x1, BIN: 0x2, CLOSE: 0x8, PING: 0x9, PONG: 0xa }

export class Ws extends EventEmitter {
  constructor(socket) {
    super()
    this.socket = socket
    this.buf = Buffer.alloc(0)
    this.frag = []
    this.closed = false
    socket.on('data', (chunk) => this.#onData(chunk))
    socket.on('close', () => {
      this.closed = true
      this.emit('close')
    })
    socket.on('error', (err) => this.emit('error', err))
  }

  static async connect(url) {
    const u = new URL(url)
    const key = crypto.randomBytes(16).toString('base64')
    const socket = net.connect({ host: u.hostname, port: Number(u.port || 80) })

    await new Promise((res, rej) => {
      socket.once('connect', res)
      socket.once('error', rej)
    })

    socket.write(
      [
        `GET ${u.pathname}${u.search} HTTP/1.1`,
        `Host: ${u.host}`,
        'Upgrade: websocket',
        'Connection: Upgrade',
        `Sec-WebSocket-Key: ${key}`,
        'Sec-WebSocket-Version: 13',
        '',
        ''
      ].join('\r\n')
    )

    await new Promise((res, rej) => {
      const onData = (chunk) => {
        const head = chunk.toString('latin1')
        if (!head.includes('\r\n\r\n')) return
        socket.removeListener('data', onData)
        const status = head.split('\r\n')[0]
        if (!/ 101 /.test(status)) rej(new Error(`WebSocket 握手失败：${status}`))
        else res()
      }
      socket.on('data', onData)
      socket.once('error', rej)
    })

    return new Ws(socket)
  }

  send(text) {
    const payload = Buffer.from(text, 'utf8')
    const mask = crypto.randomBytes(4)
    let header
    if (payload.length < 126) {
      header = Buffer.alloc(2)
      header[1] = 0x80 | payload.length
    } else if (payload.length < 65536) {
      header = Buffer.alloc(4)
      header[1] = 0x80 | 126
      header.writeUInt16BE(payload.length, 2)
    } else {
      header = Buffer.alloc(10)
      header[1] = 0x80 | 127
      header.writeBigUInt64BE(BigInt(payload.length), 2)
    }
    header[0] = 0x80 | OP.TEXT // FIN + 文本帧
    const masked = Buffer.allocUnsafe(payload.length)
    for (let i = 0; i < payload.length; i += 1) masked[i] = payload[i] ^ mask[i % 4]
    this.socket.write(Buffer.concat([header, mask, masked]))
  }

  close() {
    try {
      this.socket.destroy()
    } catch {
      /* 已经关了就算了 */
    }
  }

  #onData(chunk) {
    this.buf = this.buf.length ? Buffer.concat([this.buf, chunk]) : chunk
    // 截图响应会有好几 MB，分帧是常态，这里必须把续帧拼回去
    for (;;) {
      if (this.buf.length < 2) return
      const b0 = this.buf[0]
      const b1 = this.buf[1]
      const fin = (b0 & 0x80) !== 0
      const opcode = b0 & 0x0f
      const masked = (b1 & 0x80) !== 0
      let len = b1 & 0x7f
      let off = 2

      if (len === 126) {
        if (this.buf.length < 4) return
        len = this.buf.readUInt16BE(2)
        off = 4
      } else if (len === 127) {
        if (this.buf.length < 10) return
        len = Number(this.buf.readBigUInt64BE(2))
        off = 10
      }

      let mask = null
      if (masked) {
        if (this.buf.length < off + 4) return
        mask = this.buf.subarray(off, off + 4)
        off += 4
      }
      if (this.buf.length < off + len) return

      let payload = this.buf.subarray(off, off + len)
      if (mask) {
        payload = Buffer.from(payload)
        for (let i = 0; i < payload.length; i += 1) payload[i] ^= mask[i % 4]
      }
      this.buf = this.buf.subarray(off + len)
      this.#onFrame(fin, opcode, payload)
    }
  }

  #onFrame(fin, opcode, payload) {
    if (opcode === OP.PING) {
      this.socket.write(Buffer.from([0x80 | OP.PONG, 0x00]))
      return
    }
    if (opcode === OP.PONG || opcode === OP.CLOSE) return

    if (opcode === OP.CONT) this.frag.push(payload)
    else if (opcode === OP.TEXT || opcode === OP.BIN) this.frag = [payload]
    else return

    if (!fin) return
    const full = Buffer.concat(this.frag)
    this.frag = []
    this.emit('message', full.toString('utf8'))
  }
}

/* ------------------------------------------------------------------ *
 * CDP
 * ------------------------------------------------------------------ */

export class Cdp {
  constructor(ws) {
    this.ws = ws
    this.seq = 0
    this.pending = new Map()
    ws.on('message', (raw) => {
      let msg
      try {
        msg = JSON.parse(raw)
      } catch {
        return
      }
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id)
        this.pending.delete(msg.id)
        if (msg.error) reject(new Error(`${msg.error.message}${msg.error.data ? ` — ${msg.error.data}` : ''}`))
        else resolve(msg.result)
      }
    })
    ws.on('error', (err) => {
      for (const { reject } of this.pending.values()) reject(err)
      this.pending.clear()
    })
  }

  static async attach(port, timeoutMs = 30000) {
    const deadline = Date.now() + timeoutMs
    let list = null
    while (Date.now() < deadline) {
      try {
        const res = await fetch(`http://127.0.0.1:${port}/json/list`)
        list = await res.json()
        break
      } catch {
        await sleep(300)
      }
    }
    if (!list) throw new Error(`连不上 127.0.0.1:${port} 的调试端口`)
    const page = list.find((t) => t.type === 'page' && t.webSocketDebuggerUrl)
    if (!page) throw new Error(`调试端口上没有页面目标：${JSON.stringify(list)}`)
    const ws = await Ws.connect(page.webSocketDebuggerUrl)
    return new Cdp(ws)
  }

  send(method, params = {}, timeoutMs = 30000) {
    const id = (this.seq += 1)
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id)
          reject(new Error(`CDP 超时：${method}`))
        }
      }, timeoutMs)
      this.pending.set(id, {
        resolve: (v) => {
          clearTimeout(timer)
          resolve(v)
        },
        reject: (e) => {
          clearTimeout(timer)
          reject(e)
        }
      })
      this.ws.send(JSON.stringify({ id, method, params }))
    })
  }

  close() {
    this.ws.close()
  }
}

/* ------------------------------------------------------------------ *
 * 常用封装
 * ------------------------------------------------------------------ */

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** 在页面里跑一段 JS。表达式要用 return 返回值；内部可以直接 await。 */
export async function evalJs(cdp, expr) {
  const r = await cdp.send('Runtime.evaluate', {
    expression: `;(async () => { ${expr} })()`,
    returnByValue: true,
    awaitPromise: true
  })
  if (r.exceptionDetails) {
    throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text)
  }
  // 表达式被包进 async IIFE，漏写 return 会静默拿到 undefined，
  // 一路传到断言里变成「Cannot read properties of undefined」，很难查。这里直接说清楚。
  if (r.result.value === undefined && !/\breturn\b/.test(expr)) {
    const head = expr.trim().replace(/\s+/g, ' ').slice(0, 100)
    throw new Error(`表达式没有返回值，是不是忘了写 return？→ ${head}`)
  }
  return r.result.value
}

/** 截屏存成 PNG，返回写入的路径。截图是给人看的副产品，断言请用 DOM。 */
export async function shot(cdp, file) {
  const r = await cdp.send('Page.captureScreenshot', { format: 'png' })
  fs.writeFileSync(file, Buffer.from(r.data, 'base64'))
  return file
}

/** 轮询等一个条件成立 */
export async function waitFor(cdp, expr, { timeout = 15000, label = expr, step = 200 } = {}) {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    if (await evalJs(cdp, `return !!(${expr})`)) return true
    await sleep(step)
  }
  throw new Error(`等待超时（${label}）`)
}

/** 按可见文字点按钮。React 的合成事件靠原生 click 冒泡，el.click() 就够。 */
export async function clickText(cdp, text, { selector = 'button' } = {}) {
  const hit = await evalJs(
    cdp,
    `const el = [...document.querySelectorAll(${JSON.stringify(selector)})]
       .find(e => (e.textContent || '').includes(${JSON.stringify(text)}))
     if (!el) return false
     el.click()
     return true`
  )
  if (!hit) throw new Error(`页面上找不到含「${text}」的 ${selector}`)
  return true
}

/**
 * 真正地往输入框里打字。
 *
 * React 受控组件监听的是原生 input 事件，直接改 el.value 不会触发 onChange，
 * 必须借原型上的 setter 赋值再派发事件；AutoTextarea 在失焦时才提交一次，
 * 所以最后要 blur。
 */
export async function typeInto(cdp, selector, text, { index = 0 } = {}) {
  const ok = await evalJs(
    cdp,
    `const els = document.querySelectorAll(${JSON.stringify(selector)})
     const el = els[${index}]
     if (!el) return false
     const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement : HTMLInputElement
     const setter = Object.getOwnPropertyDescriptor(proto.prototype, 'value').set
     el.focus()
     setter.call(el, ${JSON.stringify(text)})
     el.dispatchEvent(new Event('input', { bubbles: true }))
     el.blur()
     return true`
  )
  if (!ok) throw new Error(`找不到可输入的 ${selector}[${index}]`)
  return true
}

/** 读一个元素的计算样式，用来断言配色真的生效了 */
export async function computedStyle(cdp, selector, props) {
  return evalJs(
    cdp,
    `const el = document.querySelector(${JSON.stringify(selector)})
     if (!el) return null
     const cs = getComputedStyle(el)
     const out = {}
     for (const p of ${JSON.stringify(props)}) out[p] = cs.getPropertyValue(p)
     return out`
  )
}
