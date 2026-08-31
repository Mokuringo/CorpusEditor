import { useEffect, useRef, useState } from 'react'
import type { Json } from '@shared/types'

interface Props {
  value: Json
  onCommit: (next: Json) => void
  readOnly?: boolean
}

/** JSON 字段编辑器：失焦时校验并写回，非法内容不会污染数据。 */
export default function JsonEditor({ value, onCommit, readOnly }: Props) {
  const [draft, setDraft] = useState(() => safeStringify(value))
  const [error, setError] = useState<string | null>(null)
  const valueRef = useRef(value)
  const draftRef = useRef(draft)
  const commitRef = useRef(onCommit)

  valueRef.current = value
  draftRef.current = draft
  commitRef.current = onCommit

  useEffect(() => {
    setDraft(safeStringify(value))
  }, [value])

  useEffect(
    () => () => {
      commitFrom(draftRef.current)
    },
    []
  )

  function commitFrom(text: string) {
    try {
      const parsed = JSON.parse(text) as Json
      setError(null)
      commitRef.current(parsed)
      return true
    } catch (err) {
      setError((err as Error).message)
      return false
    }
  }

  return (
    <div className="json-edit">
      <textarea
        className={`textarea${readOnly ? ' textarea--readonly' : ''}`}
        rows={Math.min(24, Math.max(3, draft.split('\n').length))}
        value={draft}
        spellCheck={false}
        readOnly={readOnly}
        onChange={(e) => {
          setDraft(e.target.value)
          if (error) setError(null)
        }}
        onBlur={() => commitFrom(draft)}
      />
      {error && <div className="json-edit__error">JSON 无效：{error}</div>}
    </div>
  )
}

function safeStringify(value: Json): string {
  try {
    return JSON.stringify(value, null, 2)
  } catch {
    return String(value)
  }
}
