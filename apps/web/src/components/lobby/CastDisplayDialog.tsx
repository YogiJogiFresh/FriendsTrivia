import { useEffect, useRef, useState } from 'react'
import { QRCodeSVG } from 'qrcode.react'
import { Button } from '../common'
import styles from './CastDisplayDialog.module.css'

export interface CastDisplayDialogProps {
  displayUrl: string
  open: boolean
  roomCode: string
  onClose: () => void
}

function copyWithFallback(value: string): boolean {
  const textarea = document.createElement('textarea')
  textarea.value = value
  textarea.setAttribute('readonly', '')
  textarea.style.position = 'fixed'
  textarea.style.opacity = '0'
  document.body.appendChild(textarea)
  textarea.select()
  const copied = document.execCommand('copy')
  textarea.remove()
  return copied
}

export function CastDisplayDialog({
  displayUrl,
  open,
  roomCode,
  onClose,
}: CastDisplayDialogProps) {
  const dialogRef = useRef<HTMLDialogElement>(null)
  const [notice, setNotice] = useState<string | null>(null)

  useEffect(() => {
    const dialog = dialogRef.current
    if (!dialog) return
    if (open && !dialog.open) {
      setNotice(null)
      dialog.showModal()
    } else if (!open && dialog.open) {
      dialog.close()
    }
  }, [open])

  async function copyDisplayUrl() {
    let copied = false
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(displayUrl)
        copied = true
      }
    } catch {
      // Clipboard access often requires HTTPS; the local app also supports an HTTP fallback.
    }
    if (!copied) copied = copyWithFallback(displayUrl)

    if (copied) {
      setNotice('Display link copied.')
    } else {
      setNotice('Could not copy automatically. Select and copy the link below.')
    }
  }

  function openDisplay() {
    const displayWindow = window.open(displayUrl, '_blank')
    if (displayWindow) {
      displayWindow.opener = null
      setNotice('Shared display opened in a new window.')
    } else {
      setNotice('If no display opened, allow pop-ups for FriendsTrivia and try again.')
    }
  }

  return (
    <dialog
      ref={dialogRef}
      className={styles.dialog}
      aria-labelledby="cast-display-title"
      onCancel={(event) => {
        event.preventDefault()
        onClose()
      }}
      onClose={onClose}
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose()
      }}
    >
      <div className={styles.panel}>
        <div className={styles.header}>
          <div>
            <span className={styles.eyebrow}>Room {roomCode}</span>
            <h2 id="cast-display-title">Cast the shared display</h2>
          </div>
          <Button variant="ghost" onClick={onClose} aria-label="Close casting instructions">
            Close
          </Button>
        </div>

        <p className={styles.intro}>
          Open only the audience display, then use your browser or device&apos;s casting controls.
          Your host controls remain private on this screen.
        </p>

        <div className={styles.handoff}>
          <div className={styles.qrFrame}>
            <QRCodeSVG
              value={displayUrl}
              size={180}
              bgColor="#ffffff"
              fgColor="#0a0e1a"
              level="M"
              marginSize={0}
              title={`QR code for the shared display in room ${roomCode}`}
            />
          </div>
          <div className={styles.linkPanel}>
            <label htmlFor="cast-display-url">Audience display link</label>
            <input id="cast-display-url" value={displayUrl} readOnly onFocus={(event) => event.currentTarget.select()} />
            <div className={styles.actions}>
              <Button variant="primary" onClick={openDisplay}>
                Open display
              </Button>
              <Button variant="secondary" onClick={() => void copyDisplayUrl()}>
                Copy link
              </Button>
            </div>
            {notice ? (
              <p className={styles.notice} role="status">
                {notice}
              </p>
            ) : null}
          </div>
        </div>

        <div className={styles.instructions}>
          <section>
            <h3>Chrome or Edge</h3>
            <p>
              Open the display, select the browser&apos;s Cast option, and cast that display tab.
              Keep this host-control tab on your device.
            </p>
          </section>
          <section>
            <h3>Windows wireless display</h3>
            <p>
              Press Windows+K to connect. Use Extend mode and move the display window to the TV;
              mirroring the host monitor will also show your controls.
            </p>
          </section>
          <section>
            <h3>Hosting from a phone</h3>
            <p>
              Scan this QR code from a cast-capable computer, or copy the link to it. Mobile
              browsers cannot reliably start tab casting themselves.
            </p>
          </section>
        </div>

        <p className={styles.requirement}>
          The host, receiver, and handoff device must be on the same local network. After opening
          the audience view, select <strong>Prepare display</strong> to enable audio and fullscreen.
        </p>
      </div>
    </dialog>
  )
}
