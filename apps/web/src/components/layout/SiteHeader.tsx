import { NavLink } from 'react-router-dom'
import styles from './SiteHeader.module.css'

const links = [
  { to: '/', label: 'Play', end: true },
  { to: '/host', label: 'Host' },
  { to: '/history', label: 'History' },
]

export function SiteHeader() {
  return (
    <header className={styles.header}>
      <NavLink to="/" className={styles.brand} aria-label="FriendsTrivia home">
        <span className={styles.brandMark} aria-hidden="true">
          ?
        </span>
        <span className={styles.brandLabel}>FriendsTrivia</span>
      </NavLink>
      <nav className={styles.nav} aria-label="Primary">
        {links.map((link) => (
          <NavLink
            key={link.to}
            to={link.to}
            end={link.end}
            className={({ isActive }) =>
              [styles.navLink, isActive ? styles.navLinkActive : ''].filter(Boolean).join(' ')
            }
          >
            {link.label}
          </NavLink>
        ))}
      </nav>
    </header>
  )
}
