import { Monitor, Moon, Sun } from 'lucide-react'
import { useStore } from '../state/store'
import type { ThemeMode } from '../state/theme'

const OPTIONS: Array<{ mode: ThemeMode; icon: typeof Sun; label: string }> = [
  { mode: 'light', icon: Sun, label: '亮色' },
  { mode: 'dark', icon: Moon, label: '暗色' },
  { mode: 'system', icon: Monitor, label: '跟随系统' }
]

export default function ThemeToggle() {
  const theme = useStore((s) => s.theme)
  const setTheme = useStore((s) => s.setTheme)
  return (
    <div className="segmented" role="group" aria-label="主题">
      {OPTIONS.map(({ mode, icon: Icon, label }) => (
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
