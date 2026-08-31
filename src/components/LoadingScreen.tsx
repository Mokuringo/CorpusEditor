import BrandMark from './BrandMark'
import { PRODUCT_NAME, PRODUCT_SLOGAN } from '../lib/product'

export default function LoadingScreen({ label, progress }: { label: string; progress: number | null }) {
  return (
    <div className="loading">
      <div className="loading__inner">
        <div className="brand">
          <span className="brand__mark">
            <BrandMark size={15} />
          </span>
          <span>
            <span className="brand__name">{PRODUCT_NAME}</span>
            <br />
            <span className="brand__sub">{PRODUCT_SLOGAN}</span>
          </span>
        </div>
        <div className="spinner" />
        <div style={{ fontSize: 'var(--fs-sm)', color: 'var(--text-secondary)' }}>{label}</div>
        {progress !== null && (
          <div className="progress">
            <div className="progress__fill" style={{ width: `${Math.round(progress * 100)}%` }} />
          </div>
        )}
      </div>
    </div>
  )
}
