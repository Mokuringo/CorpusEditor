import { Monitor, Moon, Sun } from 'lucide-react'
import { useStore } from '../state/store'
import { useT } from '../i18n'
import type { ThemeMode } from '../state/theme'

export default function ThemeToggle() {
  const t = useT()
  const theme = useStore((s) => s.theme)
  const setTheme = useStore((s) => s.setTheme)
  const options: Array<{ mode: ThemeMode; icon: typeof Sun; label: string }> = [
    { mode: 'light', icon: Sun, label: t('theme.light') },
    { mode: 'dark', icon: Moon, label: t('theme.dark') },
    { mode: 'system', icon: Monitor, label: t('theme.system') }
  ]
  return (
    <div className="segmented" role="group" aria-label={t('theme.group')}>
      {options.map(({ mode, icon: Icon, label }) => (
        <button
          key={mode}
          type="button"
          title={label}
          aria-label={label}
          aria-pressed={theme === mode}
          className={`iconbtn${theme === mode ? ' iconbtn--on' : ''}`}
          onClick={() => setTheme(mode)}
        >
          <Icon size={14} />
        </button>
      ))}
    </div>
  )
}
