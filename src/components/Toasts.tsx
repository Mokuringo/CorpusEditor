import { X } from 'lucide-react'
import { useStore } from '../state/store'
import { useT } from '../i18n'

export default function Toasts() {
  const t = useT()
  const toasts = useStore((s) => s.toasts)
  const dismiss = useStore((s) => s.dismissToast)
  if (toasts.length === 0) return null
  return (
    <div className="toasts">
      {toasts.map((toast) => (
        <div key={toast.id} className={`toast${toast.kind === 'info' ? '' : ` toast--${toast.kind}`}`}>
          <div className="toast__body">{toast.message}</div>
          <button className="toast__close" onClick={() => dismiss(toast.id)} aria-label={t('toast.close')}>
            <X size={13} />
          </button>
        </div>
      ))}
    </div>
  )
}
