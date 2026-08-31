import { useEffect, useState } from 'react'
import { Copy, Minus, Square, X } from 'lucide-react'
import BrandMark from './BrandMark'
import ThemeToggle from './ThemeToggle'
import { api } from '../lib/api'
import { PRODUCT_NAME, PRODUCT_SLOGAN } from '../lib/product'
import { useStore } from '../state/store'

/**
 * 自绘标题栏。挂在 App 最外层，首页和工作区共用。
 *
 * macOS 走 titleBarStyle: 'hiddenInset'，红绿灯、拖拽、双击最大化都由系统提供，
 * 这里只在左侧留出位置、不画按钮；Windows / Linux 去掉了原生边框，三个按钮自己画。
 */
export default function TitleBar() {
  const dataset = useStore((s) => s.dataset)
  const [maximized, setMaximized] = useState(false)
  const [nativeControls, setNativeControls] = useState(false)

  useEffect(() => {
    let alive = true
    void api.info().then((info) => {
      if (alive) setNativeControls(info.platform === 'darwin')
    })
    return () => {
      alive = false
    }
  }, [])

  useEffect(() => api.onWindowState((state) => setMaximized(state.maximized)), [])

  const toggleMaximize = () => {
    void api.windowMaximize()
  }

  return (
    <header
      className={`titlebar${nativeControls ? ' titlebar--native' : ''}`}
      onDoubleClick={nativeControls ? undefined : toggleMaximize}
    >
      <div className="titlebar__side">
        <span className="titlebar__mark">
          <BrandMark size={13} />
        </span>
        <span className="titlebar__name">{PRODUCT_NAME}</span>
      </div>

      <div className="titlebar__center">
        {dataset ? (
          <>
            <span className="titlebar__file truncate" title={dataset.source.path}>
              {dataset.source.name}
            </span>
            <span className="badge badge--muted">{dataset.source.format.toUpperCase()}</span>
            <span className="badge badge--readonly" title="源文件以只读方式打开，永远不会被写入">
              只读
            </span>
          </>
        ) : (
          <span className="titlebar__file titlebar__file--muted">{PRODUCT_SLOGAN}</span>
        )}
      </div>

      <div className="titlebar__side titlebar__side--right">
        <ThemeToggle />
        {!nativeControls && (
          <div className="winbtn">
            <button
              type="button"
              className="winbtn__btn"
              onClick={() => void api.windowMinimize()}
              title="最小化"
              aria-label="最小化"
            >
              <Minus size={13} />
            </button>
            <button
              type="button"
              className="winbtn__btn"
              onClick={toggleMaximize}
              title={maximized ? '向下还原' : '最大化'}
              aria-label={maximized ? '向下还原' : '最大化'}
            >
              {maximized ? <Copy size={11} /> : <Square size={11} />}
            </button>
            <button
              type="button"
              className="winbtn__btn winbtn__btn--close"
              onClick={() => void api.windowClose()}
              title="关闭"
              aria-label="关闭"
            >
              <X size={13} />
            </button>
          </div>
        )}
      </div>
    </header>
  )
}
