/**
 * 让当前焦点元素失焦，触发 onBlur 提交草稿。
 *
 * AutoTextarea / NumberInput 只在失焦或组件卸载时才把内部草稿提交到 store。
 * 程序化切记录、流水线「确认+下一条」、关窗时若焦点还在文本域里，
 * 草稿会留在内部 state、随组件切换丢失。这一行强制 blur 就能触发提交，
 * 顺带把焦点还给 button —— 否则回车会再激活文本域，破坏流水线节奏。
 */
export function flushDrafts(): void {
  const active = typeof document !== 'undefined' ? document.activeElement : null
  if (active instanceof HTMLElement && active !== document.body) {
    active.blur()
  }
}
