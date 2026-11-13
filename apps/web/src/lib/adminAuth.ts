export const ADMIN_LOCKED = 'friends-trivia:admin-locked'
export const ADMIN_UNLOCKED = 'friends-trivia:admin-unlocked'

export function notifyAdminLocked(): void {
  if (typeof window !== 'undefined') window.dispatchEvent(new Event(ADMIN_LOCKED))
}

export function notifyAdminUnlocked(): void {
  if (typeof window !== 'undefined') window.dispatchEvent(new Event(ADMIN_UNLOCKED))
}
