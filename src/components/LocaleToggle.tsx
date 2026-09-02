import { useStore } from '../state/store'
import { useT } from '../i18n'
import type { Locale } from '@shared/locales'

// 单按钮语言切换：只支持 中文 / English，点一下在两者间切换。
// 图标用经典的「文 / A」字形（文=中文，A=英文），当前语言高亮。
export default function LocaleToggle() {
  const t = useT()
  const locale = useStore((s) => s.locale)
  const setLocale = useStore((s) => s.setLocale)
  const next: Locale = locale === 'zh-CN' ? 'en' : 'zh-CN'
  return (
    <button
      type="button"
      className="iconbtn langtoggle"
      title={t('locale.toggle')}
      aria-label={t('locale.toggle')}
      aria-pressed={locale === 'en'}
      onClick={() => void setLocale(next)}
      // 双击会被标题栏的 onDoubleClick 冒泡捕获去最大化窗口，这里拦掉冒泡
      onDoubleClick={(e) => e.stopPropagation()}
    >
      <span className={locale === 'zh-CN' ? 'is-on' : 'is-off'}>文</span>
      <span className="langtoggle__sep">/</span>
      <span className={locale === 'en' ? 'is-on' : 'is-off'}>A</span>
    </button>
  )
}
