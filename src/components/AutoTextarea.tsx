import { useEffect, useLayoutEffect, useRef, useState } from 'react'

interface Props {
  value: string
  onCommit: (next: string) => void
  placeholder?: string
  minRows?: number
  autoFocus?: boolean
  /** 已确认的记录只能看不能改，用原生 readOnly 挡住输入而不是 disabled —— 内容仍可选中复制。 */
  readOnly?: boolean
}

/**
 * 自适应高度的文本域。
 * 输入过程只更新内部草稿，失焦或卸载时才提交一次，保证撤销栈和操作历史干净。
 */
export default function AutoTextarea({
  value,
  onCommit,
  placeholder,
  minRows = 2,
  autoFocus,
  readOnly
}: Props) {
  const ref = useRef<HTMLTextAreaElement | null>(null)
  const [draft, setDraft] = useState(value)
  const draftRef = useRef(value)
  const valueRef = useRef(value)
  const commitRef = useRef(onCommit)

  draftRef.current = draft
  valueRef.current = value
  commitRef.current = onCommit

  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${el.scrollHeight}px`
  }, [draft])

  useEffect(() => {
    setDraft(value)
  }, [value])

  useEffect(
    () => () => {
      if (draftRef.current !== valueRef.current) commitRef.current(draftRef.current)
    },
    []
  )

  return (
    <textarea
      ref={ref}
      rows={minRows}
      value={draft}
      placeholder={placeholder}
      autoFocus={autoFocus}
      spellCheck={false}
      readOnly={readOnly}
      className={`textarea${readOnly ? ' textarea--readonly' : ''}`}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={() => {
        if (draft !== value) onCommit(draft)
      }}
    />
  )
}
