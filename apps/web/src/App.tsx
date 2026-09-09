import { Navigate, Route, Routes } from 'react-router-dom'
import { AppShell } from './components'
import {
  DisplayPage,
  HistoryPage,
  HostEditorPage,
  HostHomePage,
  HostLayout,
  HostRoomPage,
  LandingPage,
  NotFoundPage,
  PlayPage,
} from './pages'

/**
 * Route map for the app shell. `/display/:roomCode` and `/play/:roomCode`
 * are deliberately outside `AppShell` — they are full-bleed kiosk/phone
 * experiences with their own minimal chrome, not the standard site layout.
 */
function App() {
  return (
    <Routes>
      <Route element={<AppShell />}>
        <Route path="/" element={<LandingPage />} />
        <Route path="/host" element={<HostLayout />}>
          <Route index element={<HostHomePage />} />
          <Route path="editor" element={<HostEditorPage />} />
          <Route path="room/:roomCode" element={<HostRoomPage />} />
        </Route>
        <Route path="/history" element={<HistoryPage />} />
        <Route path="*" element={<NotFoundPage />} />
      </Route>
      <Route path="/display/:roomCode" element={<DisplayPage />} />
      <Route path="/play/:roomCode" element={<PlayPage />} />
      <Route path="/play" element={<Navigate to="/" replace />} />
    </Routes>
  )
}

export default App
