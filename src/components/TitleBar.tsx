import { useEffect, useState, type MouseEvent } from 'react'
import { Copy, Minus, Square, X } from 'lucide-react'
import BrandMark from './BrandMark'
import ThemeToggle from './ThemeToggle'
import LocaleToggle from './LocaleToggle'
import { api } from '../lib/api'
import { PRODUCT_NAME, slogan } from '../lib/product'
import { useT } from '../i18n'
import { useStore } from '../state/store'

/**
 * 自绘标题栏。挂在 App 最外层，首页和工作区共用。
 *
 * macOS 走 titleBarStyle: 'hiddenInset'，红绿灯、拖拽、双击最大化都由系统提供，
 * 这里只在左侧留出位置、不画按钮；Windows / Linux 去掉了原生边框，三个按钮自己画。
 */
export default function TitleBar() {
  const t = useT()
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

  // 标题栏整条挂了双击最大化（macOS 走系统，这里只在 Windows/Linux 生效）。
  // 但双击事件会冒泡：落在语言/主题切换、窗口按钮这些可交互子元素上时，
  // 也得拦下来，否则连点两下语言切换就把窗口最大化了。
  const onTitleDoubleClick = (e: MouseEvent<HTMLElement>) => {
    if (nativeControls) return
    if ((e.target as Element).closest('button, a, input, select, .iconbtn, .langtoggle, .segmented, .switch')) return
    toggleMaximize()
  }

  return (
    <header
      className={`titlebar${nativeControls ? ' titlebar--native' : ''}`}
      onDoubleClick={onTitleDoubleClick}
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
            <span className="badge badge--readonly" title={t('titlebar.readonly.title')}>
              {t('titlebar.readonly')}
            </span>
          </>
        ) : (
          <span className="titlebar__file titlebar__file--muted">{slogan(t)}</span>
        )}
      </div>

      <div className="titlebar__side titlebar__side--right">
        <LocaleToggle />
        <ThemeToggle />
        {!nativeControls && (
          <div className="winbtn">
            <button
              type="button"
              className="winbtn__btn"
              onClick={() => void api.windowMinimize()}
              title={t('titlebar.btn.minimize')}
              aria-label={t('titlebar.btn.minimize')}
            >
              <Minus size={13} />
            </button>
            <button
              type="button"
              className="winbtn__btn"
              onClick={toggleMaximize}
              title={maximized ? t('titlebar.btn.restore') : t('titlebar.btn.maximize')}
              aria-label={maximized ? t('titlebar.btn.restore') : t('titlebar.btn.maximize')}
            >
              {maximized ? <Copy size={11} /> : <Square size={11} />}
            </button>
            <button
              type="button"
              className="winbtn__btn winbtn__btn--close"
              onClick={() => void api.windowClose()}
              title={t('titlebar.btn.close')}
              aria-label={t('titlebar.btn.close')}
            >
              <X size={13} />
            </button>
          </div>
        )}
      </div>
    </header>
  )
}
