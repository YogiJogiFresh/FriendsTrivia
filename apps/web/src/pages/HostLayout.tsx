import { useCallback, useEffect, useRef, useState } from 'react'
import { NavLink, Outlet } from 'react-router-dom'
import { Button, PageContainer, TextField } from '../components'
import { getAdminSession, lockAdmin, unlockAdmin, type AdminSessionStatus } from '../lib/apiClient'
import { ADMIN_LOCKED, notifyAdminLocked, notifyAdminUnlocked } from '../lib/adminAuth'
import styles from './HostLayout.module.css'

const tabs = [
  { to: '/host', label: 'Overview', end: true },
  { to: '/host/editor', label: 'Pack editor', end: false },
]

/** Shared chrome for the host tools: overview, pack editor, and (contextually) a live room. */
export function HostLayout() {
  const [session, setSession] = useState<AdminSessionStatus | null>(null)
  const [mounted, setMounted] = useState(false)
  const [password, setPassword] = useState('')
  const [visible, setVisible] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const current = useRef<AdminSessionStatus | null>(null)
  const working = useRef(false)
  const revision = useRef(0)
  const active = useRef(false)
  const form = useRef<HTMLFormElement>(null)
  const channel = useRef<BroadcastChannel | null>(null)
  const apply = useCallback((next: AdminSessionStatus) => {
    const previous = current.current
    current.current = next
    setSession(next)
    if (next.unlocked) setMounted(true)
    if (previous?.unlocked && !next.unlocked) notifyAdminLocked()
    if (next.unlocked && previous && !previous.unlocked) notifyAdminUnlocked()
  }, [])
  const check = useCallback(async () => {
    if (working.current) return
    const attempt = ++revision.current
    try {
      const next = await getAdminSession()
      if (active.current && attempt === revision.current) { setError(null); apply(next) }
    } catch (reason) {
      if (active.current && attempt === revision.current)
        setError(reason instanceof Error ? reason.message : 'Could not check host access. Try again.')
    }
  }, [apply])
  useEffect(() => {
    active.current = true
    function locked() {
      revision.current++
      const next = current.current
      if (next) {
        current.current = { ...next, unlocked: false, expiresAt: null }
        setSession(current.current)
      }
    }
    function focused() { if (document.visibilityState === 'visible') void check() }
    window.addEventListener(ADMIN_LOCKED, locked)
    window.addEventListener('focus', focused)
    document.addEventListener('visibilitychange', focused)
    if (typeof BroadcastChannel !== 'undefined') {
      channel.current = new BroadcastChannel('friends-trivia-admin')
      channel.current.onmessage = () => { void check() }
    }
    void check()
    return () => {
      active.current = false
      revision.current++
      window.removeEventListener(ADMIN_LOCKED, locked)
      window.removeEventListener('focus', focused)
      document.removeEventListener('visibilitychange', focused)
      channel.current?.close()
      channel.current = null
    }
  }, [check])
  useEffect(() => {
    if (!session?.enabled || !session.unlocked || !session.expiresAt) return
    const timer = setTimeout(() => {
      apply({ ...session, unlocked: false, expiresAt: null })
    }, Math.max(0, session.expiresAt - Date.now()))
    return () => clearTimeout(timer)
  }, [session, apply])
  useEffect(() => {
    if (session?.unlocked === false) form.current?.querySelector('input')?.focus()
  }, [session?.unlocked])

  async function changeAccess(lock: boolean) {
    if (working.current) return
    working.current = true
    const attempt = ++revision.current
    setBusy(true)
    setError(null)
    try {
      if (lock) {
        await lockAdmin()
        channel.current?.postMessage('changed')
        if (!active.current) return
        apply({ enabled: true, unlocked: false, expiresAt: null })
      } else {
        const next = await unlockAdmin(password)
        channel.current?.postMessage('changed')
        if (!active.current || attempt !== revision.current) return
        setPassword('')
        setVisible(false)
        apply(next)
      }
    } catch (reason) {
      if (active.current && attempt === revision.current)
        setError(reason instanceof Error ? reason.message : 'Could not change host access. Try again.')
    } finally {
      working.current = false
      if (active.current) setBusy(false)
    }
  }

  return (
    <PageContainer>
      <div className={styles.layout}>
        {!session && !error && <p role="status">Checking host access...</p>}
        {error && session?.unlocked && <p role="alert">{error}</p>}
        {!session && error && (
          <div role="alert">
            <p>{error}</p>
            <Button onClick={() => { void check() }}>Retry access check</Button>
          </div>
        )}
        {session && !session.unlocked && (
          <form ref={form} className={styles.unlock} onSubmit={(event) => {
            event.preventDefault()
            void changeAccess(false)
          }}>
            <h1>Unlock host tools</h1>
            <p>{mounted ? 'Your unsaved edits are still here. Unlock to continue.' :
              'Enter the admin passphrase to host games and manage packs. Players and Display do not need it.'}</p>
            <TextField label="Admin passphrase" name="password" type={visible ? 'text' : 'password'}
              autoComplete="current-password" required maxLength={1024} value={password}
              onChange={(event) => setPassword(event.target.value)} disabled={busy}
              error={error ?? undefined} hint="This browser stays unlocked for seven days." />
            <div className={styles.actions}>
              <Button variant="ghost" aria-pressed={visible} onClick={() => setVisible(!visible)}>
                {visible ? 'Hide passphrase' : 'Show passphrase'}
              </Button>
              <Button type="submit" disabled={busy}>{busy ? 'Unlocking...' : 'Unlock host tools'}</Button>
            </div>
          </form>
        )}
        {mounted && (
          <div className={styles.layout} hidden={!session?.unlocked} inert={!session?.unlocked}>
            <div className={styles.navigation}>
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
              {session?.enabled && <Button variant="ghost" disabled={busy} onClick={() => { void changeAccess(true) }}>
                {busy ? 'Locking...' : 'Lock host tools'}
              </Button>}
            </div>
            <Outlet />
          </div>
        )}
      </div>
    </PageContainer>
  )
}
