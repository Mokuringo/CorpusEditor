export type BrandMarkTone = 'default' | 'accent'

/**
 * 语料库意象：三张叠放的卡片代表数据集，抽出、向右错开并点亮的那张是当前正在校订的记录。
 *
 * 明暗靠不透明度而不是颜色，这样放在渐变底、亮底、暗底上都还能看。
 * tone="accent" 时被点亮的那张用 --accent，适合直接摆在页面底色上。
 *
 * 刻意只用三个块面、不用细线：这个图标最小要出现在 13px 的标题栏和 16px 的 favicon 上，
 * 线宽一旦低于一个像素就会糊成灰片（上一版五经一纬的织机图案就是栽在这里）。
 */
export default function BrandMark({
  size = 16,
  tone = 'default'
}: {
  size?: number
  tone?: BrandMarkTone
}) {
  const highlight = tone === 'accent' ? 'var(--accent)' : 'currentColor'
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden="true">
      {/* 底下两张：其余记录，越往下越淡 */}
      <rect x="3.8" y="14.2" width="14" height="4.9" rx="1.7" fill="currentColor" opacity="0.28" />
      <rect x="3.8" y="9" width="14" height="4.9" rx="1.7" fill="currentColor" opacity="0.55" />
      {/* 抽出并点亮的那张，向右错开 2 表示它正在被处理 */}
      <rect x="5.8" y="3.8" width="14" height="4.9" rx="1.7" fill={highlight} />
    </svg>
  )
}
