import { useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { useHostRoom } from '../data/hooks'
import { useCountdown } from '../data/hooks/useCountdown'
import { SPECIAL_DETAILS } from '../data/types'
import { ApiError } from '../lib/apiClient'
import { clearHostToken } from '../lib/roomStorage'
import {
  Badge,
  Button,
  Card,
  CategoryBoard,
  ConnectionStatusPill,
  GameTimer,
  HostControlBar,
  Leaderboard,
  Podium,
  QrLobbyPanel,
  RosterList,
  TextField,
} from '../components'
import styles from './HostRoomPage.module.css'

/**
 * Live host-control shell. Every action here is a `host:command` sent
 * through `useHostRoom`; the resulting phase/timer/board/leaderboard state
 * always comes back from the server's `host:snapshot` broadcast (see
 * `lib/snapshot.ts`), never from local state, so this page can't drift out
 * of sync with what players and the display actually see.
 */
export function HostRoomPage() {
  const { roomCode = '----' } = useParams<{ roomCode: string }>()
  const navigate = useNavigate()
  const { game, loading, error, sendCommand } = useHostRoom(roomCode)
  const [notice, setNotice] = useState<string | null>(null)
  const [scoreFormOpen, setScoreFormOpen] = useState(false)
  const [scorePlayerId, setScorePlayerId] = useState('')
  const [scoreDelta, setScoreDelta] = useState('10')
  const [scoreReason, setScoreReason] = useState('')

  const currentClue = game?.clues.find((clue) => clue.id === game.currentClueId) ?? null
  const secondsRemaining = useCountdown(game?.room.deadline, currentClue?.timerSeconds ?? 0)

  function showNotice(message: string) {
    setNotice(message)
    window.setTimeout(() => setNotice((current) => (current === message ? null : current)), 4000)
  }

  function run(command: string, payload?: Record<string, unknown>) {
    sendCommand(command, payload).catch((err: unknown) => {
      showNotice(err instanceof ApiError || err instanceof Error ? err.message : 'That action failed.')
    })
  }

  if (error) {
    return (
      <Card>
        <h1>Can&apos;t manage this room</h1>
        <p role="alert">{error}</p>
      </Card>
    )
  }

  if (loading || !game) {
    return <p>Loading room {roomCode}…</p>
  }

  const { categories, clues, players, room } = game
  const phase = room.phase
  const remainingClues = clues.filter(
    (clue) => !clue.used && clue.id !== game.currentClueId,
  ).length
  const isPaused = phase === 'PAUSED'
  const wageredCount = game.wageredPlayerIds.length
  const allPlayersWagered = players.length > 0 && wageredCount === players.length

  function handleAdjustScoreSubmit() {
    const delta = Number(scoreDelta)
    if (!scorePlayerId || !Number.isFinite(delta) || delta === 0 || !scoreReason.trim()) {
      showNotice('Pick a player, a non-zero point change, and a reason.')
      return
    }
    run('adjustScore', { playerId: scorePlayerId, delta, reason: scoreReason.trim() })
    setScoreReason('')
    setScoreFormOpen(false)
  }

  function handleAdvance() {
    if (phase === 'REVEAL') {
      run('leaderboard')
      return
    }
    if (phase === 'LEADERBOARD') {
      run(remainingClues > 0 ? 'board' : 'finish')
    }
  }

  async function handleEndSession() {
    if (!window.confirm('End this live session? Players will be disconnected from the game and this cannot be resumed.')) return
    try {
      await sendCommand('end')
      clearHostToken(roomCode)
      navigate('/host')
    } catch (err) {
      showNotice(err instanceof ApiError || err instanceof Error ? err.message : 'Could not end this session.')
    }
  }

  return (
    <div>
      <div className={styles.headerRow}>
        <div className={styles.titleGroup}>
          <h1>Room {roomCode}</h1>
          <Badge tone="info">{phase.replace('_', ' ')}</Badge>
        </div>
        <div className={styles.headerActions}>
          {phase !== 'FINISHED' ? (
            <Button variant="danger" onClick={handleEndSession}>
              End session
            </Button>
          ) : null}
          <ConnectionStatusPill status={game.connection} />
        </div>
      </div>

      {notice ? (
        <Card className={styles.notice}>
          <p className={styles.noticeText}>{notice}</p>
        </Card>
      ) : null}

      <div className={styles.layout}>
        <div className={styles.stage}>
          {phase === 'LOBBY' ? (
            <Card>
              <RosterList players={players} onKickPlayer={(playerId) => run('kick', { playerId })} />
              <Button variant="primary" size="lg" fullWidth disabled={players.length === 0} onClick={() => run('start')}>
                Start game
              </Button>
            </Card>
          ) : null}

          {phase === 'BOARD' ? (
            <Card>
              <CategoryBoard
                categories={categories}
                clues={clues}
                interactive
                onSelectClue={(clueId) => run('selectClue', { clueId })}
              />
            </Card>
          ) : null}

          {phase === 'FINAL_WAGER' ? (
            <Card className={styles.cluePanel}>
              <h2>Final Question wagers</h2>
              <p>
                {wageredCount}/{players.length} players have locked their wager.
              </p>
              <Button
                variant="primary"
                size="lg"
                disabled={!allPlayersWagered}
                onClick={() => run('startFinalQuestion')}
              >
                Start Final Question
              </Button>
            </Card>
          ) : null}

          {(phase === 'CLUE_READY' || phase === 'ACCEPTING_ANSWERS' || phase === 'FINAL_QUESTION' || phase === 'ANSWERS_CLOSED' || (phase === 'PAUSED' && currentClue)) &&
          currentClue ? (
            <Card className={styles.cluePanel}>
              <span className={styles.clueMeta}>
                <Badge tone="neutral">
                  {room.finalRound
                    ? 'Final Question'
                    : categories.find((category) => category.id === currentClue.categoryId)?.title}
                </Badge>
                <Badge tone="warning">${currentClue.value}</Badge>
              </span>
              {currentClue.special ? (
                <div className={styles.specialBanner}>
                  <Badge tone="warning">{SPECIAL_DETAILS[currentClue.special].name}</Badge>
                  <span>{SPECIAL_DETAILS[currentClue.special].description}</span>
                </div>
              ) : null}
              <p>{currentClue.prompt}</p>
              {phase !== 'CLUE_READY' ? (
                <GameTimer
                  size="display"
                  secondsRemaining={secondsRemaining}
                  totalSeconds={currentClue.timerSeconds}
                  paused={isPaused}
                />
              ) : null}
              {phase === 'ACCEPTING_ANSWERS' || phase === 'FINAL_QUESTION' ? (
                <p className={styles.noticeText}>
                  {players.filter((player) => player.hasAnsweredCurrentClue).length}/{players.length} players answered
                </p>
              ) : null}
            </Card>
          ) : null}

          {phase === 'REVEAL' && currentClue ? (
            <Card className={styles.cluePanel}>
              <h2>Answer revealed</h2>
              {currentClue.special ? (
                <div className={styles.specialBanner}>
                  <Badge tone="warning">{SPECIAL_DETAILS[currentClue.special].name}</Badge>
                  <span>{SPECIAL_DETAILS[currentClue.special].description}</span>
                </div>
              ) : null}
              <p>{currentClue.prompt}</p>
              {currentClue.revealedAnswer ? <p>{currentClue.revealedAnswer}</p> : null}
              {currentClue.revealGif ? (
                <img className={styles.revealGif} src={currentClue.revealGif.url} alt={currentClue.revealGif.alt} />
              ) : null}
              <Leaderboard entries={game.leaderboard} />
            </Card>
          ) : null}

          {phase === 'LEADERBOARD' ? (
            <Card>
              <h2>Leaderboard</h2>
              <Leaderboard entries={game.leaderboard} />
            </Card>
          ) : null}

          {phase === 'FINISHED' ? (
            <Card className={styles.cluePanel}>
              <h2>Final results</h2>
              <Podium entries={game.leaderboard} />
            </Card>
          ) : null}

          {phase !== 'LOBBY' && phase !== 'FINISHED' ? (
            <HostControlBar
              phase={phase}
              hasCurrentClue={Boolean(currentClue)}
              onGoBack={() => run('goBack')}
              onResetClue={() => run('resetClue')}
              onCloseAnswers={() => run('closeAnswers')}
              onSkip={() => run('skip')}
              onReveal={() => run('reveal')}
              onAdjustScore={() => setScoreFormOpen((open) => !open)}
              onAdvance={handleAdvance}
              onStartFinal={() => run('startFinal')}
            />
          ) : null}

          {scoreFormOpen ? (
            <Card className={styles.scoreForm}>
              <h2>Adjust a player&apos;s score</h2>
              <div className={styles.scoreFormRow}>
                <label className={styles.scoreLabel} htmlFor="score-player">
                  Player
                </label>
                <select
                  id="score-player"
                  className={styles.scoreSelect}
                  value={scorePlayerId}
                  onChange={(event) => setScorePlayerId(event.target.value)}
                >
                  <option value="">Select a player…</option>
                  {players.map((player) => (
                    <option key={player.id} value={player.id}>
                      {player.nickname}
                    </option>
                  ))}
                </select>
              </div>
              <TextField
                label="Points (use a negative number to subtract)"
                type="number"
                value={scoreDelta}
                onChange={(event) => setScoreDelta(event.target.value)}
              />
              <TextField
                label="Reason"
                value={scoreReason}
                onChange={(event) => setScoreReason(event.target.value)}
                placeholder="e.g. Ruled correct on appeal"
              />
              <div className={styles.scoreFormActions}>
                <Button variant="secondary" onClick={() => setScoreFormOpen(false)}>
                  Cancel
                </Button>
                <Button variant="primary" onClick={handleAdjustScoreSubmit}>
                  Apply
                </Button>
              </div>
            </Card>
          ) : null}
        </div>

        <div className={styles.sidebar}>
          <Card>
            <Button
              variant="primary"
              fullWidth
              href={`/display/${roomCode}`}
              target="_blank"
              rel="noreferrer"
            >
              Open shared display
            </Button>
            <QrLobbyPanel
              roomCode={roomCode}
              joinUrl={room.joinUrl}
              locked={room.locked}
              onToggleLock={() => run('lock', { locked: !room.locked })}
              showHostControls
            />
          </Card>
          <Card>
            <h2>Players ({players.length})</h2>
            <RosterList players={players} onKickPlayer={(playerId) => run('kick', { playerId })} />
          </Card>
        </div>
      </div>
    </div>
  )
}
