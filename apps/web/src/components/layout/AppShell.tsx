import { Outlet } from 'react-router-dom'
import { SiteHeader } from './SiteHeader'
import styles from './AppShell.module.css'

/**
 * Root layout for standard (non-kiosk) routes: landing, host tools, and
 * history. The shared display (`/display/:roomCode`) and phone controller
 * (`/play/:roomCode`) intentionally render their own minimal, full-bleed
 * shells instead of this one.
 */
export function AppShell() {
  return (
    <div className={styles.shell}>
      <a href="#main-content" className="skip-link">
        Skip to content
      </a>
      <SiteHeader />
      <main id="main-content" className={styles.main}>
        <Outlet />
      </main>
    </div>
  )
}
