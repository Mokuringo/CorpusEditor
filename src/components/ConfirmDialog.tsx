import type { ReactNode } from 'react'
import Modal from './Modal'

export interface ConfirmDialogProps {
  title: string
  subtitle?: string
  /** 主按钮文案，默认「确定」。 */
  confirmLabel?: string
  cancelLabel?: string
  /** 危险操作时把主按钮染成 danger 色。 */
  danger?: boolean
  disabled?: boolean
  onConfirm: () => void
  onClose: () => void
  children?: ReactNode
}

/** 通用的二次确认弹窗。替换、批量确认、丢弃进度共用一套样式。 */
export default function ConfirmDialog({
  title,
  subtitle,
  confirmLabel = '确定',
  cancelLabel = '取消',
  danger,
  disabled,
  onConfirm,
  onClose,
  children
}: ConfirmDialogProps) {
  return (
    <Modal title={title} subtitle={subtitle} onClose={onClose}>
      <div className="confirm__body">{children}</div>
      <div className="confirm__foot">
        <button className="btn btn--ghost" onClick={onClose}>
          {cancelLabel}
        </button>
        <button
          className={`btn ${danger ? 'btn--danger' : 'btn--primary'}`}
          onClick={onConfirm}
          disabled={disabled}
          autoFocus
        >
          {confirmLabel}
        </button>
      </div>
    </Modal>
  )
}
