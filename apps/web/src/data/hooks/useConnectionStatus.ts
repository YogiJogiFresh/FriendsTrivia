import { useEffect, useState } from 'react'
import type { ConnectionState } from '../types'
import { subscribeConnectionState } from '../../lib/socketClient'

/** Tracks the shared Socket.IO connection's lifecycle for the connection pill/banner. */
export function useConnectionStatus(): ConnectionState {
  const [state, setState] = useState<ConnectionState>('connecting')

  useEffect(() => subscribeConnectionState(setState), [])

  return state
}
