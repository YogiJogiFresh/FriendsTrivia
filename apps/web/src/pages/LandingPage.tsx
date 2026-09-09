import { useState } from 'react'
import type { FormEvent } from 'react'
import { useNavigate } from 'react-router-dom'
import { Button, Card, PageContainer, RoomCodeInput, TextField } from '../components'
import { ApiError, getRoomSnapshot } from '../lib/apiClient'
import styles from './LandingPage.module.css'

const ROOM_CODE_LENGTH = 4

export function LandingPage() {
  const navigate = useNavigate()
  const [roomCode, setRoomCode] = useState('')
  const [nickname, setNickname] = useState('')
  const [joinError, setJoinError] = useState<string | undefined>(undefined)
  const [checking, setChecking] = useState(false)

  async function handleJoin(event: FormEvent) {
    event.preventDefault()
    if (roomCode.length !== ROOM_CODE_LENGTH) {
      setJoinError(`Enter the ${ROOM_CODE_LENGTH}-character room code.`)
      return
    }
    if (nickname.trim().length === 0) {
      setJoinError('Enter a nickname so other players can see you.')
      return
    }
    setJoinError(undefined)
    setChecking(true)
    try {
      await getRoomSnapshot(roomCode)
      navigate(`/play/${roomCode}`, { state: { nickname: nickname.trim() } })
    } catch (error) {
      setJoinError(
        error instanceof ApiError && error.status === 404
          ? 'No room found with that code. Double-check it and try again.'
          : error instanceof Error
            ? error.message
            : 'Could not check that room code.',
      )
    } finally {
      setChecking(false)
    }
  }

  function handleHost() {
    navigate('/host')
  }

  return (
    <PageContainer>
      <section className={styles.hero}>
        <h1 className={styles.title}>FriendsTrivia</h1>
        <p className={styles.subtitle}>
          A living-room trivia night: one shared screen, phones for buzzers, and a Jeopardy-style
          board full of music and price rounds. No app to install, just a room code.
        </p>
      </section>

      <div className={styles.actions}>
        <Card className={styles.actionCard} aria-labelledby="join-heading">
          <h2 id="join-heading" className={styles.actionHeading}>
            <span className={[styles.actionIcon, styles.joinIcon].join(' ')} aria-hidden="true">
              ▶
            </span>
            Join a game
          </h2>
          <p className={styles.actionDescription}>
            Already at game night? Enter the room code shown on the shared screen.
          </p>
          <form className={styles.form} onSubmit={handleJoin} noValidate>
            <RoomCodeInput value={roomCode} onChange={setRoomCode} length={ROOM_CODE_LENGTH} error={joinError} />
            <TextField
              label="Nickname"
              value={nickname}
              onChange={(event) => setNickname(event.target.value)}
              placeholder="e.g. Jamie"
              maxLength={20}
              autoComplete="off"
            />
            <Button type="submit" variant="primary" size="lg" fullWidth disabled={checking}>
              {checking ? 'Checking…' : 'Join game'}
            </Button>
          </form>
        </Card>

        <Card className={styles.actionCard} aria-labelledby="host-heading">
          <h2 id="host-heading" className={styles.actionHeading}>
            <span className={[styles.actionIcon, styles.hostIcon].join(' ')} aria-hidden="true">
              ★
            </span>
            Host a game
          </h2>
          <p className={styles.actionDescription}>
            Running the show? Pick a pack, open the shared display, and start the board.
          </p>
          <Button variant="secondary" size="lg" fullWidth onClick={handleHost}>
            Go to host tools
          </Button>
        </Card>
      </div>
    </PageContainer>
  )
}
