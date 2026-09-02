import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'
import { loadStoredLocale } from './state/locale'
import './styles/tokens.css'
import './styles/app.css'

// 首屏就把 <html lang> 定下来，避免先闪一帧错误语言再被 store 改回来。
document.documentElement.setAttribute('lang', loadStoredLocale())

const container = document.getElementById('root')
if (!container) throw new Error('找不到 #root 容器')

createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>
)
