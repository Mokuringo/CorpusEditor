import { useEffect, type ReactNode } from 'react'
import { X } from 'lucide-react'

interface ModalProps {
  title: string
  subtitle?: string
  wide?: boolean
  onClose: () => void
  footer?: ReactNode
  children: ReactNode
}

export default function Modal({ title, subtitle, wide, onClose, footer, children }: ModalProps) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation()
        onClose()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  return (
    <div className="overlay" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className={`modal${wide ? ' modal--wide' : ''}`} role="dialog" aria-modal="true" aria-label={title}>
        <div className="modal__head">
          <div style={{ flex: 1, minWidth: 0 }}>
            <h2 className="modal__title">{title}</h2>
            {subtitle && <p className="modal__sub">{subtitle}</p>}
          </div>
          <button className="iconbtn" onClick={onClose} aria-label="关闭">
            <X size={15} />
          </button>
        </div>
        <div className="modal__body">{children}</div>
        {footer && <div className="modal__foot">{footer}</div>}
      </div>
    </div>
  )
}
