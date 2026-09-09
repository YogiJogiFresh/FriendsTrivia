import { useEffect, useRef, useState } from 'react'
import { useParams } from 'react-router-dom'
import { useRoomWatch } from '../data/hooks'
import { useCountdown } from '../data/hooks/useCountdown'
import { getSocket } from '../lib/socketClient'
import { SPECIAL_DETAILS } from '../data/types'
import {
  Button,
  Badge,
  CategoryBoard,
  ConnectionStatusPill,
  GameTimer,
  Leaderboard,
  Podium,
  QrLobbyPanel,
  ReconnectBanner,
  RosterList,
} from '../components'
import styles from './DisplayPage.module.css'

const SILENT_AUDIO =
  'data:audio/wav;base64,UklGRigAAABXQVZFZm10IBAAAAABAAEAQB8AAEAfAAABAAgAZGF0YQQAAACAgICA'

/**
 * Shared display shell: the big screen everyone in the room looks at. This
 * route intentionally does not use `AppShell`/`SiteHeader` — it is meant to
 * run full-bleed on a TV or projector. State comes entirely from the
 * public `room:snapshot` socket channel (`useRoomWatch`), so this page
 * never needs a host token.
 */
export function DisplayPage() {
  const { roomCode = '----' } = useParams<{ roomCode: string }>()
  const { game, loading, error } = useRoomWatch(roomCode)
  const currentClue = game?.clues.find((clue) => clue.id === game.currentClueId) ?? null
  const currentClueId = currentClue?.id
  const currentMediaUrl = currentClue?.mediaUrl
  const currentRevealMediaUrl = currentClue?.revealMediaUrl
  const gamePhase = game?.room.phase
  const activeMediaUrl = gamePhase === 'REVEAL' ? currentRevealMediaUrl : currentMediaUrl
  const secondsRemaining = useCountdown(game?.room.deadline, currentClue?.timerSeconds ?? 0)
  const audioRef = useRef<HTMLAudioElement>(null)
  const [audioReady, setAudioReady] = useState(false)
  const [audioError, setAudioError] = useState<string | null>(null)

  useEffect(() => {
    const audio = audioRef.current
    if (!audio) return
    if (!currentClueId || !activeMediaUrl) {
      audio.loop = false
      audio.pause()
      audio.currentTime = 0
      audio.removeAttribute('src')
      audio.load()
      return
    }
    const sourceChanged = audio.src !== new URL(activeMediaUrl, window.location.href).href
    if (sourceChanged) {
      audio.src = activeMediaUrl
      audio.load()
    }
    if (
      gamePhase === 'ACCEPTING_ANSWERS' ||
      gamePhase === 'FINAL_QUESTION' ||
      gamePhase === 'REVEAL'
    ) {
      audio.loop = gamePhase !== 'REVEAL'
      audio.muted = false
      audio.volume = 1
      if (sourceChanged) audio.currentTime = 0
      void audio
        .play()
        .then(() => {
          setAudioReady(true)
          setAudioError(null)
        })
        .catch(() => {
          setAudioReady(false)
          setAudioError('Playback was blocked. Select Play audio to start the linked song.')
        })
    } else {
      audio.loop = false
      audio.pause()
      if (gamePhase !== 'PAUSED') audio.currentTime = 0
    }
  }, [activeMediaUrl, currentClueId, gamePhase])

  useEffect(() => {
    const socket = getSocket()
    function replay(payload: { clueId?: string }) {
      const audio = audioRef.current
      if (!audio || payload.clueId !== currentClueId) return
      audio.loop = gamePhase === 'ACCEPTING_ANSWERS' || gamePhase === 'FINAL_QUESTION'
      audio.muted = false
      audio.volume = 1
      audio.currentTime = 0
      void audio
        .play()
        .then(() => {
          setAudioReady(true)
          setAudioError(null)
        })
        .catch(() => setAudioError('Playback was blocked. Select Play audio and try again.'))
    }
    socket.on('media:replay', replay)
    return () => {
      socket.off('media:replay', replay)
    }
  }, [currentClueId, gamePhase])

  function enableAudio() {
    const audio = audioRef.current
    if (!audio) return
    const playingAudio =
      (gamePhase === 'ACCEPTING_ANSWERS' ||
        gamePhase === 'FINAL_QUESTION' ||
        gamePhase === 'REVEAL') &&
      Boolean(activeMediaUrl)
    if (!playingAudio) {
      audio.src = SILENT_AUDIO
      audio.load()
      audio.volume = 0.01
    } else {
      audio.loop = gamePhase !== 'REVEAL'
      audio.volume = 1
    }
    audio.muted = false
    audio.currentTime = 0
    void audio
      .play()
      .then(() => {
        if (!playingAudio) {
          audio.pause()
          audio.currentTime = 0
          audio.volume = 1
        }
        setAudioReady(true)
        setAudioError(null)
      })
      .catch(() => setAudioError('Your browser blocked audio. Check site permissions and try again.'))
  }

  if (error) {
    return (
      <div className={styles.shell}>
        <div className={styles.main}>
          <p role="alert">{error}</p>
        </div>
      </div>
    )
  }

  if (loading || !game) {
    return (
      <div className={styles.shell}>
        <div className={styles.main}>
          <p>Loading room {roomCode}…</p>
        </div>
      </div>
    )
  }

  const isPaused = game.room.phase === 'PAUSED'

  return (
    <div className={styles.shell}>
      <audio ref={audioRef} src={SILENT_AUDIO} preload="auto" aria-label="Trivia music clip" />
      <header className={styles.topBar}>
        <span className={styles.brand}>FriendsTrivia</span>
        <div className={styles.topBarRight}>
          <ConnectionStatusPill status={game.connection} />
          {game.room.phase !== 'LOBBY' && (!audioReady || audioError) ? (
            <Button variant="primary" onClick={enableAudio}>
              Play audio
            </Button>
          ) : null}
          {game.room.phase !== 'LOBBY' ? (
            <span className={styles.headerRoomCode} aria-label={`Room code ${game.room.code}`}>
              Room <strong>{game.room.code}</strong>
            </span>
          ) : null}
        </div>
      </header>

      {game.connection !== 'connected' ? (
        <div className={styles.bannerWrapper}>
          <ReconnectBanner status={game.connection} />
        </div>
      ) : null}

      {isPaused ? (
        <div className={styles.pausedOverlay} role="alert">
          <div className={styles.pausedCard}>Game paused</div>
        </div>
      ) : null}

      {game.room.phase === 'LOBBY' ? (
        <div className={styles.main}>
          <QrLobbyPanel roomCode={game.room.code} joinUrl={game.room.joinUrl} locked={game.room.locked} />
          <Button variant={audioReady ? 'secondary' : 'primary'} size="lg" onClick={enableAudio}>
            {audioReady ? 'Audio ready' : 'Enable audio'}
          </Button>
          {audioError ? <p role="alert">{audioError}</p> : null}
          <RosterList players={game.players} />
        </div>
      ) : null}

      {game.room.phase === 'BOARD' ? (
        <div className={[styles.main, styles.boardMain].join(' ')}>
          <CategoryBoard categories={game.categories} clues={game.clues} />
        </div>
      ) : null}

      {game.room.phase === 'FINAL_WAGER' ? (
        <div className={styles.main}>
          <span className={styles.categoryLabel}>Final Question</span>
          <p className={styles.cluePrompt}>Players, lock in your wagers.</p>
          <p>
            {game.wageredPlayerIds.length}/{game.players.length} wagers received
          </p>
        </div>
      ) : null}

      {(game.room.phase === 'CLUE_READY' ||
        game.room.phase === 'ACCEPTING_ANSWERS' ||
        game.room.phase === 'FINAL_QUESTION' ||
        game.room.phase === 'ANSWERS_CLOSED') &&
      currentClue ? (
        <div className={styles.main}>
          <span className={styles.categoryLabel}>
            {game.room.finalRound
              ? 'Final Question'
              : game.categories.find((category) => category.id === currentClue.categoryId)?.title}
          </span>
          {currentClue.special ? (
            <div className={styles.specialBanner}>
              <Badge tone="warning">{SPECIAL_DETAILS[currentClue.special].name}</Badge>
              <span>{SPECIAL_DETAILS[currentClue.special].description}</span>
            </div>
          ) : null}
          <p className={styles.cluePrompt}>{currentClue.prompt}</p>
          {game.room.finalRound ? (
            <span className={styles.clueValue}>Final Question</span>
          ) : (
            <span className={styles.clueValue}>${currentClue.value}</span>
          )}
          <GameTimer
            size="display"
            secondsRemaining={secondsRemaining}
            totalSeconds={currentClue.timerSeconds}
            paused={isPaused}
          />
        </div>
      ) : null}

      {game.room.phase === 'REVEAL' && currentClue ? (
        <div className={styles.main}>
          <span className={styles.categoryLabel}>Answer revealed</span>
          {currentClue.special ? (
            <div className={styles.specialBanner}>
              <Badge tone="warning">{SPECIAL_DETAILS[currentClue.special].name}</Badge>
              <span>{SPECIAL_DETAILS[currentClue.special].description}</span>
            </div>
          ) : null}
          <p className={styles.cluePrompt}>{currentClue.prompt}</p>
          {currentClue.revealedAnswer ? (
            <p className={styles.revealedAnswer}>{currentClue.revealedAnswer}</p>
          ) : null}
          {currentClue.revealGif ? (
            <figure className={styles.revealGif}>
              <img src={currentClue.revealGif.url} alt={currentClue.revealGif.alt} />
              <figcaption>
                <a href={currentClue.revealGif.sourceUrl} target="_blank" rel="noreferrer">
                  {currentClue.revealGif.provider === 'giphy'
                    ? 'GIPHY'
                    : currentClue.revealGif.provider === 'tenor'
                      ? 'Tenor'
                      : 'Linked GIF'}
                </a>
              </figcaption>
            </figure>
          ) : null}
          {currentClue.type === 'price-slider' &&
          !game.room.finalRound &&
          game.priceResults?.length ? (
            <div className={styles.priceResults}>
              <h2>Closest guesses</h2>
              <ol>
                {game.priceResults.map((result) => (
                  <li key={result.playerId}>
                    <span>
                      <strong>{result.nickname}</strong>
                      <span className={result.overbid ? styles.overbid : undefined}>
                        {currentClue.unitPrefix ?? '$'}
                        {result.guess.toLocaleString()}
                        {result.overbid ? ' — over' : ''}
                      </span>
                    </span>
                    <strong>
                      {result.pointsAwarded > 0 ? '+' : ''}
                      {result.pointsAwarded}
                    </strong>
                  </li>
                ))}
              </ol>
            </div>
          ) : null}
          <Leaderboard entries={game.leaderboard} />
        </div>
      ) : null}

      {game.room.phase === 'LEADERBOARD' ? (
        <div className={styles.main}>
          <span className={styles.categoryLabel}>Leaderboard</span>
          <Leaderboard entries={game.leaderboard} />
        </div>
      ) : null}

      {game.room.phase === 'FINISHED' ? (
        <div className={styles.main}>
          <span className={styles.categoryLabel}>Final results</span>
          <Podium entries={game.leaderboard} />
          <Leaderboard entries={game.leaderboard} />
        </div>
      ) : null}
    </div>
  )
}
