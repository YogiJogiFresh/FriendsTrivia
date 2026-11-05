import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { useParams } from 'react-router-dom'
import { useRoomWatch } from '../data/hooks'
import { useCountdown } from '../data/hooks/useCountdown'
import { getSocket } from '../lib/socketClient'
import { SPECIAL_DETAILS } from '../data/types'
import { createAudioPlayback, playbackSettings, playbackFailureMessages } from '../lib/audioPlayback'
import type { PlaybackState } from '../lib/audioPlayback'
import { diagnosticsEnabled, mediaIdentity, traceEvent } from '../lib/diagnostics'
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
  TutorialSlideshow,
} from '../components'
import styles from './DisplayPage.module.css'

const SILENT_AUDIO =
  'data:audio/wav;base64,UklGRigAAABXQVZFZm10IBAAAAABAAEAQB8AAEAfAAABAAgAZGF0YQQAAACAgICA'

function FittedClue({ zoom, children }: { zoom: number; children: ReactNode }) {
  const frameRef = useRef<HTMLDivElement>(null)
  const stageRef = useRef<HTMLDivElement>(null)
  const contentRef = useRef<HTMLDivElement>(null)

  useLayoutEffect(() => {
    const frame = frameRef.current!
    const stage = stageRef.current!
    const content = contentRef.current!
    let pendingFrame = 0
    function measure() {
      const width = frame.clientWidth
      const height = frame.clientHeight
      content.style.width = `${width}px`
      const naturalWidth = content.offsetWidth
      const naturalHeight = content.offsetHeight
      if (!width || !height || !naturalWidth || !naturalHeight) return
      const scale = Math.min(1, width / naturalWidth, height / naturalHeight) * zoom
      const scaledWidth = naturalWidth * scale
      const scaledHeight = naturalHeight * scale
      // Reserve scaled bounds, not the untransformed element's scroll footprint.
      stage.style.width = `${Math.max(width, scaledWidth)}px`
      stage.style.height = `${Math.max(height, scaledHeight)}px`
      content.style.left = `${Math.max(0, (width - scaledWidth) / 2)}px`
      content.style.top = `${Math.max(0, (height - scaledHeight) / 2)}px`
      content.style.transform = `scale(${scale})`
    }
    const observer = new ResizeObserver(() => {
      cancelAnimationFrame(pendingFrame)
      pendingFrame = requestAnimationFrame(measure)
    })
    observer.observe(frame)
    observer.observe(content)
    measure()
    return () => {
      observer.disconnect()
      cancelAnimationFrame(pendingFrame)
    }
  }, [zoom])

  return (
    <div className={styles.clueMain}>
      <div className={styles.fitFrame} ref={frameRef} tabIndex={0} role="region" aria-label="Clue content">
        <div className={styles.fitStage} ref={stageRef}>
          <div className={styles.fitContent} ref={contentRef}>{children}</div>
        </div>
      </div>
    </div>
  )
}

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
  const phaseRef = useRef(gamePhase)
  useLayoutEffect(() => { phaseRef.current = gamePhase }, [gamePhase])
  const activeMediaUrl = gamePhase === 'REVEAL' ? currentRevealMediaUrl : currentMediaUrl
  const secondsRemaining = useCountdown(gamePhase === 'ANSWERS_CLOSED' ? undefined : game?.room.deadline,
    gamePhase === 'ANSWERS_CLOSED' ? 0 : game?.room.pausedSeconds ?? currentClue?.timerSeconds ?? 0)
  const audioRef = useRef<HTMLAudioElement>(null)
  const playbackRef = useRef<{ key: string; player: ReturnType<typeof createAudioPlayback> } | null>(null)
  const audioOperation = useRef(0)
  const revealAudio = gamePhase === 'REVEAL'
  const { delaySeconds, playCount } = playbackSettings(revealAudio ? currentClue?.revealMediaPlayback : currentClue?.mediaPlayback, revealAudio)
  const [audioReady, setAudioReady] = useState(false)
  const [audioError, setAudioError] = useState<string | null>(null)
  const [audioStatus, setAudioStatus] = useState<PlaybackState | 'buffering'>('idle')
  const playbackState = useRef<PlaybackState>('idle')
  const [isFullscreen, setIsFullscreen] = useState(Boolean(document.fullscreenElement))
  const [presentationNotice, setPresentationNotice] = useState<string | null>(null)
  const [boardZoom, setBoardZoom] = useState({ roomCode, percent: 100 })
  if (boardZoom.roomCode !== roomCode) {
    setBoardZoom({ roomCode, percent: 100 })
  }
  const viewKey = JSON.stringify([roomCode, currentClueId, gamePhase === 'BOARD' ? 'board' : revealAudio ? 'reveal' : 'question'])
  const [clueZoom, setClueZoom] = useState({ viewKey, percent: 100 })
  if (gamePhase !== 'PAUSED' && clueZoom.viewKey !== viewKey) {
    setClueZoom({ viewKey, percent: 100 })
  }
  const zoomPercent = gamePhase === 'BOARD'
    ? boardZoom.roomCode === roomCode ? boardZoom.percent : 100
    : clueZoom.viewKey === viewKey ? clueZoom.percent : 100
  const setZoom = (percent: number) => gamePhase === 'BOARD'
    ? setBoardZoom({ roomCode, percent })
    : setClueZoom({ viewKey, percent })

  useEffect(() => {
    function updateFullscreenState() {
      setIsFullscreen(Boolean(document.fullscreenElement))
    }
    document.addEventListener('fullscreenchange', updateFullscreenState)
    return () => document.removeEventListener('fullscreenchange', updateFullscreenState)
  }, [])

  const getPlayback = useCallback(() => {
    const audio = audioRef.current
    if (!audio || !currentClueId || !activeMediaUrl) return null
    const key = JSON.stringify([currentClueId, revealAudio, activeMediaUrl, delaySeconds, playCount])
    if (playbackRef.current?.key !== key) {
      playbackRef.current?.player.dispose()
      if (audio.src !== new URL(activeMediaUrl, window.location.href).href || audio.error) {
        audio.src = activeMediaUrl
        audio.load()
      }
      setAudioError(null)
      audio.muted = false
      audio.volume = 1
      playbackRef.current = {
        key,
        player: createAudioPlayback(audio, { delaySeconds, playCount }, {
          onState: (state, plays) => {
            playbackState.current = state
            setAudioStatus(state)
            traceEvent('audio:state', { phase: phaseRef.current, clueId: currentClueId, mediaId: mediaIdentity(activeMediaUrl),
              plays, delaySeconds, playCount })
            if (state === 'playing') {
              setAudioReady(true)
              setAudioError(null)
            }
          },
          onError: (failure) => {
            if (failure === 'autoplay') setAudioReady(false)
            setAudioError(playbackFailureMessages[failure])
            traceEvent('audio:failure', { clueId: currentClueId, mediaId: mediaIdentity(activeMediaUrl), error: failure })
          },
        }),
      }
    }
    return playbackRef.current.player
  }, [currentClueId, revealAudio, activeMediaUrl, delaySeconds, playCount, setAudioReady, setAudioError, setAudioStatus])

  useEffect(() => {
    const audio = audioRef.current
    if (!audio) return
    const tracing = diagnosticsEnabled()
    const events = tracing
      ? ['loadedmetadata', 'canplay', 'waiting', 'stalled', 'playing', 'error', 'ended', 'progress', 'timeupdate']
      : ['waiting', 'stalled', 'playing']
    function changed(event: Event) {
      if (!audio) return
      if (tracing) traceEvent(`audio:${event.type}`, {
        phase: gamePhase, clueId: currentClueId, mediaId: activeMediaUrl ? mediaIdentity(activeMediaUrl) : 'none',
        actualMediaId: mediaIdentity(audio.currentSrc), position: audio.currentTime, duration: audio.duration,
        readyState: audio.readyState, networkState: audio.networkState,
        buffered: audio.buffered.length ? audio.buffered.end(audio.buffered.length - 1) : 0,
      })
      if (activeMediaUrl && mediaIdentity(audio.currentSrc) === mediaIdentity(activeMediaUrl) &&
        (playbackState.current === 'starting' || playbackState.current === 'playing')) {
        if (event.type === 'waiting' || event.type === 'stalled') setAudioStatus('buffering')
        else if (event.type === 'playing') setAudioStatus('playing')
      }
    }
    events.forEach(event => audio.addEventListener(event, changed))
    const observer = tracing && typeof PerformanceObserver !== 'undefined' ? new PerformanceObserver(list => {
      for (const entry of list.getEntries() as PerformanceResourceTiming[]) {
        const mediaId = mediaIdentity(entry.name)
        if (mediaId === 'other') continue
        traceEvent('audio:resource', { mediaId, ms: entry.duration,
          headerMs: entry.responseStart - entry.requestStart, transferBytes: entry.transferSize, decodedBytes: entry.decodedBodySize })
      }
    }) : null
    observer?.observe({ type: 'resource' })
    return () => {
      events.forEach(event => audio.removeEventListener(event, changed))
      observer?.disconnect()
    }
  }, [gamePhase, currentClueId, activeMediaUrl])

  useEffect(() => {
    audioOperation.current += 1
    if (gamePhase === 'PAUSED') {
      playbackRef.current?.player.pause()
      return
    }
    if (gamePhase === 'CLUE_READY' && activeMediaUrl) {
      getPlayback()
      return
    }
    if (
      gamePhase === 'ACCEPTING_ANSWERS' ||
      gamePhase === 'FINAL_QUESTION' ||
      gamePhase === 'REVEAL'
    ) {
      if (activeMediaUrl) {
        getPlayback()?.resume()
        return
      }
    }
    playbackRef.current?.player.dispose()
    playbackRef.current = null
    if (gamePhase === 'ANSWERS_CLOSED') return
    const audio = audioRef.current
    audio?.pause()
    audio?.removeAttribute('src')
    audio?.load()
  }, [getPlayback, gamePhase, activeMediaUrl])

  useEffect(() => {
    const audio = audioRef.current
    return () => {
      audioOperation.current += 1
      playbackRef.current?.player.dispose()
      playbackRef.current = null
      audio?.removeAttribute('src')
      audio?.load()
    }
  }, [])

  useEffect(() => {
    const socket = getSocket()
    function replay(payload: { clueId?: string }) {
      if (payload.clueId !== currentClueId ||
        !['ACCEPTING_ANSWERS', 'FINAL_QUESTION', 'REVEAL'].includes(gamePhase ?? '')) return
      getPlayback()?.start()
    }
    socket.on('media:replay', replay)
    return () => {
      socket.off('media:replay', replay)
    }
  }, [currentClueId, gamePhase, getPlayback])

  async function startAudio() {
    const audio = audioRef.current
    if (!audio) throw new Error('The audio player is unavailable.')
    const operation = ++audioOperation.current
    const playingAudio =
      (gamePhase === 'ACCEPTING_ANSWERS' ||
        gamePhase === 'FINAL_QUESTION' ||
        gamePhase === 'REVEAL') &&
      Boolean(activeMediaUrl)
    playbackRef.current?.player.dispose()
    playbackRef.current = null
    audio.src = SILENT_AUDIO
    audio.load()
    audio.volume = 0.01
    audio.muted = false
    try {
      await audio.play()
    } catch (error) {
      if (operation !== audioOperation.current) return
      throw error
    }
    if (operation !== audioOperation.current) return
    audio.pause()
    audio.currentTime = 0
    audio.volume = 1
    if (playingAudio) getPlayback()?.start()
    setAudioReady(true)
    setAudioError(null)
  }

  async function enableAudio() {
    try {
      await startAudio()
    } catch {
      setAudioReady(false)
      setAudioError('Your browser blocked audio. Check site permissions and try again.')
    }
  }

  async function prepareDisplay() {
    const shouldPrepareAudio = !audioReady && gamePhase !== 'PAUSED'
    const results = await Promise.allSettled([
      shouldPrepareAudio ? startAudio() : Promise.resolve(),
      document.fullscreenElement || !document.fullscreenEnabled
        ? Promise.resolve()
        : document.documentElement.requestFullscreen(),
    ])
    const audioPrepared = audioReady || (shouldPrepareAudio && results[0].status === 'fulfilled')
    const fullscreenPrepared = Boolean(document.fullscreenElement)
    setIsFullscreen(fullscreenPrepared)

    if (shouldPrepareAudio && !audioPrepared) {
      setAudioReady(false)
      setAudioError('Your browser blocked audio. Check site permissions and try again.')
    }

    if (audioPrepared && fullscreenPrepared) {
      setPresentationNotice('Audio permission is prepared and fullscreen is active. Songs may still need to load.')
    } else if (audioPrepared) {
      setPresentationNotice('Audio is ready. Use your browser controls if fullscreen is unavailable.')
    } else if (fullscreenPrepared) {
      setPresentationNotice('Fullscreen is ready, but audio still needs permission.')
    } else {
      setPresentationNotice('Use the audio and fullscreen controls in your browser, then try again.')
    }
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
  const isQuestion = Boolean(currentClue) && (
    gamePhase === 'CLUE_READY' || gamePhase === 'ACCEPTING_ANSWERS' ||
    gamePhase === 'FINAL_QUESTION' || gamePhase === 'ANSWERS_CLOSED')
  const fittedView = gamePhase === 'BOARD' || isQuestion || (gamePhase === 'REVEAL' && Boolean(currentClue))
  const allAnswered = game.connection === 'connected' &&
    (game.room.phase === 'ACCEPTING_ANSWERS' || game.room.phase === 'FINAL_QUESTION') &&
    Boolean(game.room.answerProgress && game.room.answerProgress.total > 0 &&
      game.room.answerProgress.answered === game.room.answerProgress.total)

  return (
    <div className={[styles.shell, fittedView ? styles.fittedShell : ''].join(' ')}>
      <audio ref={audioRef} preload="auto" aria-label="Trivia music clip" />
      <header className={styles.topBar}>
        <span className={styles.brand}>FriendsTrivia</span>
        <div className={styles.topBarRight}>
          {fittedView ? (
            <div className={styles.zoomControls} role="group" aria-label="Display zoom">
              <Button variant="ghost" aria-label="Zoom out" title="Zoom out" disabled={zoomPercent <= 50} onClick={() => setZoom(zoomPercent - 10)}>-</Button>
              <output aria-label="Display zoom level">{zoomPercent}%</output>
              <Button variant="ghost" aria-label="Zoom in" title="Zoom in" disabled={zoomPercent >= 200} onClick={() => setZoom(zoomPercent + 10)}>+</Button>
              <Button variant="ghost" aria-label="Fit to screen" title="Fit to screen" onClick={() => setZoom(100)}>Fit</Button>
            </div>
          ) : null}
          <ConnectionStatusPill status={game.connection} />
          {game.room.phase !== 'LOBBY' && !isFullscreen && !audioError ? (
            <Button variant="primary" onClick={() => void prepareDisplay()}>
              Prepare display
            </Button>
          ) : game.room.phase !== 'LOBBY' &&
            game.room.phase !== 'PAUSED' &&
            (!audioReady || audioError) ? (
            <Button variant="primary" onClick={() => void enableAudio()}>
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

      {activeMediaUrl && (gamePhase === 'ACCEPTING_ANSWERS' || gamePhase === 'FINAL_QUESTION' || gamePhase === 'REVEAL') ? (
        <div className={styles.audioStatus}>
          <span role="status">{audioError ? 'Song could not play' : audioStatus === 'waiting' ? `Audio delay (${delaySeconds}s configured)`
            : audioStatus === 'starting' || audioStatus === 'idle' ? 'Preparing song...'
              : audioStatus === 'buffering' ? 'Song buffering...'
                : audioStatus === 'playing' ? 'Song playing'
                  : audioStatus === 'finished' ? 'Song finished' : 'Song paused'}</span>
          {audioError ? <p role="alert">{audioError}</p> : null}
        </div>
      ) : null}

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
          <div className={styles.lobbyLayout}>
            <div className={styles.joinPanel}>
              <QrLobbyPanel
                roomCode={game.room.code}
                joinUrl={game.room.joinUrl}
                locked={game.room.locked}
              />
              <Button
                variant={audioReady ? 'secondary' : 'primary'}
                size="lg"
                onClick={() => void prepareDisplay()}
              >
                {audioReady && isFullscreen ? 'Display ready' : 'Prepare display'}
              </Button>
              {presentationNotice ? (
                <p className={styles.presentationNotice} role="status">
                  {presentationNotice}
                </p>
              ) : null}
              {audioError ? <p role="alert">{audioError}</p> : null}
            </div>
            <TutorialSlideshow />
          </div>
          <div className={styles.lobbyRoster}>
            <h2>Players ({game.players.length})</h2>
            <RosterList players={game.players} />
          </div>
        </div>
      ) : null}

      {game.room.phase === 'BOARD' ? (
        <div className={[styles.main, styles.boardMain].join(' ')}>
          <CategoryBoard categories={game.categories} clues={game.clues} fit zoom={zoomPercent / 100} />
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

      {game.room.phase === 'SPECIAL_VOTE' ? (
        <div className={styles.main}>
          <div className={styles.specialBanner}>
            <Badge tone="warning">Forced Player</Badge>
            <span>Players are choosing who must answer.</span>
          </div>
          <p className={styles.cluePrompt}>Vote for one player other than yourself.</p>
          <p>
            {game.room.specialVotedPlayerIds.length}/{game.players.length} votes received
          </p>
        </div>
      ) : null}

      {isQuestion && currentClue ? (
        <FittedClue key={clueZoom.viewKey} zoom={zoomPercent / 100}>
          {allAnswered ? <p className={styles.answersComplete} role="status">All answers received</p> : null}
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
          {currentClue.special === 'forced_player' && game.room.forcedPlayerId ? (
            <p className={styles.forcedPlayer}>
              {game.players.find(({ id }) => id === game.room.forcedPlayerId)?.nickname ??
                'Selected player'}{' '}
              must answer
            </p>
          ) : null}
          <p className={styles.cluePrompt}>{currentClue.prompt}</p>
          {game.room.finalRound ? (
            <span className={styles.clueValue}>Final Question</span>
          ) : (
            <span className={styles.clueValue}>${currentClue.value}</span>
          )}
          <GameTimer
            size="display"
            variant="line"
            secondsRemaining={secondsRemaining}
            totalSeconds={currentClue.timerSeconds}
            paused={isPaused}
          />
        </FittedClue>
      ) : null}

      {game.room.phase === 'REVEAL' && currentClue ? (
        <FittedClue key={clueZoom.viewKey} zoom={zoomPercent / 100}>
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
              {currentClue.revealGif.provider !== 'url' ? <figcaption>
                <a href={currentClue.revealGif.sourceUrl} target="_blank" rel="noreferrer">
                  {currentClue.revealGif.provider === 'giphy'
                    ? 'GIPHY'
                    : currentClue.revealGif.provider === 'tenor'
                      ? 'Tenor'
                      : ''}
                </a>
              </figcaption> : null}
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
        </FittedClue>
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
