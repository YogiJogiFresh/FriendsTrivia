import { QRCodeSVG } from 'qrcode.react'
import { Badge, Button } from '../common'
import styles from './QrLobbyPanel.module.css'

export interface QrLobbyPanelProps {
  roomCode: string
  joinUrl: string
  locked?: boolean
  onToggleLock?: () => void
  /** Host controls (lock toggle) are only rendered when this is provided. */
  showHostControls?: boolean
}

/**
 * Room-joining panel: QR code, human-typeable room code, and (in host mode)
 * a lock toggle to stop new players joining mid-game. Shown on the shared
 * display and reused, in a smaller form, on the host control screen.
 */
export function QrLobbyPanel({ roomCode, joinUrl, locked = false, onToggleLock, showHostControls = false }: QrLobbyPanelProps) {
  return (
    <div className={styles.panel}>
      <div className={styles.qrFrame}>
        <QRCodeSVG
          value={joinUrl}
          size={196}
          bgColor="#ffffff"
          fgColor="#0a0e1a"
          level="M"
          marginSize={0}
          title={`QR code to join room ${roomCode}`}
        />
      </div>
      <div>
        <span className={styles.roomCodeLabel}>Room code</span>
        <div className={styles.roomCode}>{roomCode}</div>
      </div>
      <span className={styles.joinUrl}>{joinUrl}</span>
      {showHostControls ? (
        <div className={styles.lockRow}>
          <Badge tone={locked ? 'danger' : 'success'} dot>
            {locked ? 'Lobby locked' : 'Lobby open'}
          </Badge>
          <Button variant="secondary" onClick={onToggleLock}>
            {locked ? 'Unlock joining' : 'Lock joining'}
          </Button>
        </div>
      ) : null}
    </div>
  )
}
