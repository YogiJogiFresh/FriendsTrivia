import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { usePacks } from '../data/hooks'
import { Badge, Button, Card, TextareaField } from '../components'
import {
  ApiError,
  createRoom,
  endHostedRoom,
  getHostedRoom,
  type HostedRoomSummary,
  type SpecialType,
} from '../lib/apiClient'
import { clearHostToken, listHostSessions, saveHostToken } from '../lib/roomStorage'
import styles from './HostHomePage.module.css'

interface RecoverableRoom extends HostedRoomSummary {
  hostToken: string
}

export function HostHomePage() {
  const navigate = useNavigate()
  const { data: packs, loading, error } = usePacks()
  const [selectedPackId, setSelectedPackId] = useState<string | null>(null)
  const [launching, setLaunching] = useState(false)
  const [launchError, setLaunchError] = useState<string | null>(null)
  const [liveRooms, setLiveRooms] = useState<RecoverableRoom[]>([])
  const [liveRoomsLoading, setLiveRoomsLoading] = useState(true)
  const [liveRoomsError, setLiveRoomsError] = useState<string | null>(null)
  const [endingRoomCode, setEndingRoomCode] = useState<string | null>(null)
  const [teamsText, setTeamsText] = useState('')
  const [specials, setSpecials] = useState<SpecialType[]>([])

  const selectedPack = packs?.find((pack) => pack.id === selectedPackId) ?? null
  const visiblePacks = packs?.filter((pack) => pack.status !== 'archived') ?? []
  const teams = teamsText
    .split('\n')
    .map((team) => team.trim())
    .filter(Boolean)
  const teamsValid =
    teams.length !== 1 &&
    teams.length <= 8 &&
    new Set(teams.map((team) => team.toLocaleLowerCase())).size === teams.length &&
    teams.every((team) => team.length <= 30)
  const enoughCluesForSpecials = (selectedPack?.ordinaryClueCount ?? 0) >= specials.length
  const canLaunch =
    Boolean(selectedPack) &&
    selectedPack?.status === 'ready' &&
    !launching &&
    teamsValid &&
    enoughCluesForSpecials

  function toggleSpecial(special: SpecialType) {
    setSpecials((current) =>
      current.includes(special)
        ? current.filter((candidate) => candidate !== special)
        : [...current, special],
    )
  }

  useEffect(() => {
    let cancelled = false
    const sessions = listHostSessions()
    void Promise.all(
      sessions.map(async (session) => {
        try {
          const room = await getHostedRoom(session.roomCode, session.hostToken)
          if (room.status === 'finished' || room.status === 'abandoned') {
            clearHostToken(session.roomCode)
            return { room: null, error: null }
          }
          return { room: { ...room, hostToken: session.hostToken }, error: null }
        } catch (err) {
          if (err instanceof ApiError && (err.status === 401 || err.status === 404)) {
            clearHostToken(session.roomCode)
            return { room: null, error: null }
          }
          return {
            room: null,
            error: err instanceof Error ? err.message : 'Could not load live host sessions.',
          }
        }
      }),
    ).then((results) => {
      if (cancelled) return
      setLiveRooms(
        results
          .map((result) => result.room)
          .filter((room): room is RecoverableRoom => room !== null)
          .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt)),
      )
      setLiveRoomsError(results.find((result) => result.error)?.error ?? null)
      setLiveRoomsLoading(false)
    })
    return () => {
      cancelled = true
    }
  }, [])

  async function handleLaunch() {
    if (!selectedPack) return
    setLaunching(true)
    setLaunchError(null)
    try {
      const room = await createRoom(selectedPack.id, { teams, specials })
      saveHostToken(room.roomCode, room.hostToken)
      navigate(`/host/room/${room.roomCode}`)
    } catch (err) {
      setLaunchError(err instanceof ApiError ? err.message : 'Could not create a room for that pack.')
    } finally {
      setLaunching(false)
    }
  }

  async function handleEndRoom(room: RecoverableRoom) {
    if (!window.confirm(`End room ${room.code}? This live session cannot be resumed.`)) return
    setEndingRoomCode(room.code)
    setLiveRoomsError(null)
    try {
      await endHostedRoom(room.code, room.hostToken)
      clearHostToken(room.code)
      setLiveRooms((current) => current.filter((candidate) => candidate.code !== room.code))
    } catch (err) {
      setLiveRoomsError(err instanceof Error ? err.message : 'Could not end that session.')
    } finally {
      setEndingRoomCode(null)
    }
  }

  return (
    <div>
      <div className={styles.page}>
        <h1>Host a game</h1>
        <p className={styles.intro}>
          Pick a ready pack, then create a room to open the shared display and start play.
        </p>
      </div>

      {liveRoomsLoading || liveRooms.length > 0 || liveRoomsError ? (
        <section className={styles.liveSection} aria-labelledby="live-rooms-title">
          <div className={styles.sectionHeader}>
            <div>
              <h2 id="live-rooms-title">Live sessions</h2>
              <p>Rejoin a room previously hosted in this browser.</p>
            </div>
          </div>
          {liveRoomsLoading ? <p>Checking for live sessions…</p> : null}
          {liveRoomsError ? <p role="alert">{liveRoomsError}</p> : null}
          <div className={styles.liveGrid}>
            {liveRooms.map((room) => (
              <Card key={room.code} className={styles.liveCard}>
                <div>
                  <span className={styles.liveRoomCode}>Room {room.code}</span>
                  <span className={styles.liveMeta}>
                    {room.phase.replace('_', ' ')} · {room.playerCount}{' '}
                    {room.playerCount === 1 ? 'player' : 'players'}
                  </span>
                </div>
                <div className={styles.liveActions}>
                  <Button variant="danger" disabled={endingRoomCode === room.code} onClick={() => handleEndRoom(room)}>
                    {endingRoomCode === room.code ? 'Ending…' : 'End'}
                  </Button>
                  <Button variant="primary" onClick={() => navigate(`/host/room/${room.code}`)}>
                    Rejoin
                  </Button>
                </div>
              </Card>
            ))}
          </div>
        </section>
      ) : null}

      <div className={styles.grid}>
        {loading ? <p>Loading packs…</p> : null}
        {error ? <p role="alert">{error}</p> : null}
        {!loading && !error && visiblePacks.length === 0 ? (
          <p>
            You don&apos;t have any packs yet.{' '}
            <button type="button" className={styles.inlineLink} onClick={() => navigate('/host/editor')}>
              Create your first pack
            </button>
            .
          </p>
        ) : null}
        {visiblePacks.map((pack) => (
          <button
            key={pack.id}
            type="button"
            className={[styles.packCard, pack.id === selectedPackId ? styles.packCardSelected : ''].filter(Boolean).join(' ')}
            onClick={() => setSelectedPackId(pack.id)}
            aria-pressed={pack.id === selectedPackId}
          >
            <span className={styles.packHeader}>
              <span className={styles.packTitle}>{pack.title}</span>
              <Badge tone={pack.status === 'ready' ? 'success' : 'warning'}>{pack.status}</Badge>
            </span>
            <span className={styles.packDescription}>{pack.description}</span>
            <span className={styles.packMeta}>
              <span>{pack.categoryCount} categories</span>
              <span>{pack.clueCount} clues</span>
            </span>
          </button>
        ))}
      </div>

      <Card className={styles.teamSetup}>
        <TextareaField
          label="Teams (optional)"
          value={teamsText}
          onChange={(event) => setTeamsText(event.target.value)}
          placeholder={'Red Team\nBlue Team'}
          hint="Enter one team per line. Use either no teams or 2-8 unique teams."
          error={teamsValid ? undefined : 'Use 2-8 unique names, each no longer than 30 characters.'}
        />
      </Card>

      <Card className={styles.specialSetup}>
        <h2>Clue specials (optional)</h2>
        <p>Each enabled special is hidden on one random clue and revealed when that clue starts.</p>
        <div className={styles.specialOptions}>
          {([
            ['double_points', 'Double Points', 'Every positive award is doubled.'],
            [
              'double_or_nothing',
              'Double or Nothing',
              'Win double, or lose the clue value for an incorrect or missing answer.',
            ],
            ['speed_round', 'Speed Round', 'The answer timer is cut in half.'],
          ] as const).map(([id, name, description]) => (
            <label key={id} className={styles.specialOption}>
              <input
                type="checkbox"
                checked={specials.includes(id)}
                onChange={() => toggleSpecial(id)}
              />
              <span>
                <strong>{name}</strong>
                <small>{description}</small>
              </span>
            </label>
          ))}
        </div>
        {!enoughCluesForSpecials && selectedPack ? (
          <p role="alert" className={styles.specialError}>
            Select fewer specials or use a pack with at least {specials.length} ordinary clues.
          </p>
        ) : null}
      </Card>

      <div className={styles.launchBar}>
        <span className={styles.launchInfo}>
          {launchError
            ? launchError
            : selectedPack
              ? selectedPack.status === 'ready'
                ? `Selected: ${selectedPack.title}`
                : `"${selectedPack.title}" is still a draft — finish it in the editor before launching.`
              : 'Select a ready pack above to enable launch.'}
        </span>
        <Button variant="secondary" onClick={() => navigate('/host/editor')}>
          Edit packs
        </Button>
        <Button variant="primary" disabled={!canLaunch} onClick={handleLaunch}>
          {launching ? 'Creating room…' : 'Create room & launch'}
        </Button>
      </div>
    </div>
  )
}
