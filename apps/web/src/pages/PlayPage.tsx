import { useEffect, useRef, useState } from 'react'
import type { FormEvent } from 'react'
import { useLocation, useParams } from 'react-router-dom'
import { usePlayerRoom } from '../data/hooks'
import { useCountdown } from '../data/hooks/useCountdown'
import {
  AnswerPanel,
  Button,
  ConnectionStatusPill,
  GameTimer,
  Leaderboard,
  Podium,
  ReconnectBanner,
  RosterList,
  TextField,
} from '../components'
import type { AnswerSubmission } from '../components'
import styles from './PlayPage.module.css'

/**
 * Player phone controller shell. Designed for one-thumb use: the primary
 * action is always reachable near the bottom of the screen, touch targets
 * meet the 44px minimum, and there is no horizontal scrolling at any width.
 * State comes from the real server via `usePlayerRoom`, which transparently
 * reconnects into a stored seat (see `lib/roomStorage.ts`) or collects a
 * fresh nickname with `player:join`.
 */
export function PlayPage() {
  const { roomCode = '----' } = useParams<{ roomCode: string }>()
  const location = useLocation()
  const initialNickname = (location.state as { nickname?: string } | null)?.nickname ?? ''
  const attemptedAutoJoin = useRef(false)

  const {
    game,
    loading,
    needsNickname,
    fatalError,
    nickname,
    playerId,
    join,
    joining,
    joinError,
    submitAnswer,
    submitWager,
  } = usePlayerRoom(roomCode)

  const [nicknameDraft, setNicknameDraft] = useState(initialNickname)
  const [teamDraft, setTeamDraft] = useState('')
  const [teamError, setTeamError] = useState<string | null>(null)
  const [wagerDraft, setWagerDraft] = useState('0')
  const [wagerError, setWagerError] = useState<string | null>(null)

  useEffect(() => {
    if (
      needsNickname &&
      initialNickname &&
      game &&
      game.room.teams.length === 0 &&
      !attemptedAutoJoin.current
    ) {
      attemptedAutoJoin.current = true
      void join(initialNickname)
    }
  }, [needsNickname, initialNickname, join, game])

  const currentClue = game?.clues.find((clue) => clue.id === game.currentClueId) ?? null
  const secondsRemaining = useCountdown(game?.room.deadline, currentClue?.timerSeconds ?? 0)
  const ownScore = game?.players.find((player) => player.id === playerId)?.score ?? 0
  const maxWager = Math.max(0, ownScore)
  const wagerLocked = Boolean(playerId && game?.wageredPlayerIds.includes(playerId))

  if (fatalError) {
    return (
      <div className={styles.shell}>
        <div className={styles.centeredState}>
          <h1>Removed from room</h1>
          <p role="alert">{fatalError}</p>
        </div>
      </div>
    )
  }

  if (loading) {
    return (
      <div className={styles.shell}>
        <div className={styles.centeredState}>
          <p>Loading room {roomCode}…</p>
        </div>
      </div>
    )
  }

  if (needsNickname || !game) {
    function handleJoin(event: FormEvent) {
      event.preventDefault()
      if (nicknameDraft.trim().length === 0) return
      if (game?.room.teams.length && !teamDraft) {
        setTeamError('Choose your team before joining.')
        return
      }
      void join(nicknameDraft.trim(), teamDraft || undefined)
    }

    return (
      <div className={styles.shell}>
        <div className={styles.main}>
          <form className={styles.joinForm} onSubmit={handleJoin} noValidate>
            <h1>Join room {roomCode}</h1>
            <TextField
              label="Nickname"
              value={nicknameDraft}
              onChange={(event) => setNicknameDraft(event.target.value)}
              placeholder="e.g. Jamie"
              maxLength={20}
              autoFocus
              autoComplete="off"
              error={joinError ?? undefined}
            />
            {game?.room.teams.length ? (
              <label className={styles.teamSelectField}>
                <select
                  className={styles.teamSelect}
                  aria-label="Choose your team"
                  value={teamDraft}
                  onChange={(event) => {
                    setTeamDraft(event.target.value)
                    setTeamError(null)
                  }}
                  required
                >
                  <option value="">Choose your team</option>
                  {game.room.teams.map((team) => (
                    <option key={team} value={team}>
                      {team}
                    </option>
                  ))}
                </select>
                {teamError ? (
                  <span className={styles.teamError} role="alert">
                    {teamError}
                  </span>
                ) : null}
              </label>
            ) : null}
            <Button
              type="submit"
              variant="primary"
              size="lg"
              fullWidth
              disabled={joining || Boolean(game?.room.teams.length && !teamDraft)}
            >
              {joining ? 'Joining…' : 'Join'}
            </Button>
          </form>
        </div>
      </div>
    )
  }

  const connection = game.connection
  const isPaused = game.room.phase === 'PAUSED'

  function handleAnswerSubmit(submission: AnswerSubmission) {
    return submitAnswer(submission.answer)
  }

  async function handleWagerSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const amount = Number(wagerDraft)
    if (!Number.isSafeInteger(amount) || amount < 0 || amount > maxWager) {
      setWagerError(`Enter a whole number from 0 to ${maxWager}.`)
      return
    }
    setWagerError(null)
    try {
      await submitWager(amount)
    } catch (error) {
      setWagerError(error instanceof Error ? error.message : 'Could not submit your wager.')
    }
  }

  return (
    <div className={styles.shell}>
      <header className={styles.topBar}>
        <span className={styles.topBarLeft}>
          <span className={styles.roomCode}>{game.room.code}</span>
          <span className={styles.nickname}>
            Playing as {nickname}
            {game.players.find((player) => player.id === playerId)?.teamName
              ? ` · ${game.players.find((player) => player.id === playerId)?.teamName}`
              : ''}
          </span>
        </span>
        <ConnectionStatusPill status={connection} />
      </header>

      {connection !== 'connected' ? <ReconnectBanner status={connection} /> : null}

      {isPaused ? (
        <div className={styles.pausedOverlay} role="alert">
          <p>The host has paused the game. Hang tight!</p>
        </div>
      ) : null}

      <main className={styles.main}>
        {game.room.phase === 'LOBBY' ? (
          <div className={styles.centeredState}>
            <h1>You&apos;re in!</h1>
            <p>Waiting for the host to start the game…</p>
            <RosterList players={game.players} />
          </div>
        ) : null}

        {game.room.phase === 'BOARD' ? (
          <div className={styles.centeredState}>
            <h1>Board is open</h1>
            <p>Watch the shared screen — the host is picking the next clue.</p>
          </div>
        ) : null}

        {game.room.phase === 'CLUE_READY' ? (
          <div className={styles.centeredState}>
            <h1>Get ready!</h1>
            <p>The next clue is about to start on the shared screen.</p>
          </div>
        ) : null}

        {game.room.phase === 'FINAL_WAGER' ? (
          <div className={styles.centeredState}>
            <h1>Final Question</h1>
            {wagerLocked ? (
              <>
                <p className={styles.correct}>Wager locked!</p>
                <p>Waiting for the other players and host.</p>
              </>
            ) : (
              <form className={styles.wagerForm} onSubmit={handleWagerSubmit}>
                <p>You have {ownScore.toLocaleString()} points. How much will you wager?</p>
                <TextField
                  label={`Wager (0–${maxWager.toLocaleString()})`}
                  type="number"
                  min={0}
                  max={maxWager}
                  step={1}
                  value={wagerDraft}
                  onChange={(event) => setWagerDraft(event.target.value)}
                  error={wagerError ?? undefined}
                />
                <Button type="submit" variant="primary" size="lg" fullWidth>
                  Lock wager
                </Button>
              </form>
            )}
          </div>
        ) : null}

        {(game.room.phase === 'ACCEPTING_ANSWERS' || game.room.phase === 'FINAL_QUESTION') && currentClue ? (
          <>
            <div className={styles.timerRow}>
              <span className={styles.clueValue}>
                {game.room.finalRound ? 'Final Question' : `$${currentClue.value}`}
              </span>
              <GameTimer
                size="compact"
                secondsRemaining={secondsRemaining}
                totalSeconds={currentClue.timerSeconds}
                paused={isPaused}
              />
            </div>
            <AnswerPanel
              key={`${currentClue.id}:${game.room.deadline ?? ''}`}
              clue={currentClue}
              disabled={connection !== 'connected' || isPaused}
              onSubmit={handleAnswerSubmit}
            />
          </>
        ) : null}

        {game.room.phase === 'ANSWERS_CLOSED' ? (
          <div className={styles.centeredState}>
            <h1>Answers locked</h1>
            <p>Look at the shared screen for the reveal.</p>
          </div>
        ) : null}

        {game.room.phase === 'REVEAL' ? (
          <div className={styles.centeredState}>
            <h1>Answer revealed</h1>
            {currentClue?.revealedAnswer ? <p className={styles.revealedAnswer}>{currentClue.revealedAnswer}</p> : null}
            {currentClue?.revealGif ? (
              <img className={styles.revealGif} src={currentClue.revealGif.url} alt={currentClue.revealGif.alt} />
            ) : null}
            {game.ownResult ? (
              <p className={game.ownResult.correct ? styles.correct : styles.incorrect}>
                {game.ownResult.correct ? 'Correct!' : 'Not quite.'}{' '}
                {game.ownResult.pointsAwarded !== 0
                  ? `${game.ownResult.pointsAwarded > 0 ? '+' : ''}${game.ownResult.pointsAwarded} points`
                  : null}
              </p>
            ) : (
              <p>Check the shared screen, then get ready for the next clue.</p>
            )}
          </div>
        ) : null}

        {game.room.phase === 'LEADERBOARD' ? (
          <>
            <h1>Leaderboard</h1>
            <Leaderboard entries={game.leaderboard} />
          </>
        ) : null}

        {game.room.phase === 'FINISHED' ? (
          <>
            <h1>Final results</h1>
            <Podium entries={game.leaderboard} />
            <Leaderboard entries={game.leaderboard} />
          </>
        ) : null}
      </main>
    </div>
  )
}
