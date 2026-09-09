import { NavLink, Outlet } from 'react-router-dom'
import { PageContainer } from '../components'
import styles from './HostLayout.module.css'

const tabs = [
  { to: '/host', label: 'Overview', end: true },
  { to: '/host/editor', label: 'Pack editor', end: false },
]

/** Shared chrome for the host tools: overview, pack editor, and (contextually) a live room. */
export function HostLayout() {
  return (
    <PageContainer>
      <div className={styles.layout}>
        <nav className={styles.tabs} aria-label="Host tools">
          {tabs.map((tab) => (
            <NavLink
              key={tab.to}
              to={tab.to}
              end={tab.end}
              className={({ isActive }) => [styles.tab, isActive ? styles.tabActive : ''].filter(Boolean).join(' ')}
            >
              {tab.label}
            </NavLink>
          ))}
        </nav>
        <Outlet />
      </div>
    </PageContainer>
  )
}
