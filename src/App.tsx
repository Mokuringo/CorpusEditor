import { useEffect } from 'react'
import TitleBar from './components/TitleBar'
import Home from './components/Home'
import Workspace from './components/Workspace'
import LoadingScreen from './components/LoadingScreen'
import Toasts from './components/Toasts'
import ReplaceDialog from './components/ReplaceDialog'
import ExportDialog from './components/ExportDialog'
import { useStore } from './state/store'

export default function App() {
  const ready = useStore((s) => s.ready)
  const busy = useStore((s) => s.busy)
  const dataset = useStore((s) => s.dataset)
  const init = useStore((s) => s.init)

  useEffect(() => {
    void init()
  }, [init])

  return (
    <div className="app">
      <TitleBar />
      <div className="app__content">
        {!ready ? (
          <LoadingScreen label="正在启动…" progress={null} />
        ) : busy ? (
          <LoadingScreen label={busy.label} progress={busy.progress} />
        ) : dataset ? (
          <>
            <Workspace />
            <ReplaceDialog />
            <ExportDialog />
          </>
        ) : (
          <Home />
        )}
      </div>
      <Toasts />
    </div>
  )
}
