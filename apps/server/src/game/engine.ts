import { EventEmitter } from 'node:events'
import { randomInt } from 'node:crypto'
import { createPriceAnswerScorer, matchFreeTextAnswer, scoreMusicAnswer, } from '@friends-trivia/shared'
import type { AttemptRef, GameClue, RoundOutcome, RoundResult, ScoreAward, Submission } from '../domain.js'
import { domainFrom, type DomainSource } from '../sqliteStore.js'
import { createId } from '../ids.js'
import { isRevealGif } from '../gifs.js'
import type { RoomRepository } from '../repositories/rooms.js'
import type { GamePhase, RoomRecord, RoomState, SpecialType } from './types.js'
type ClueRow = GameClue
type SubmissionRow = Submission
const allowedTransitions: Record<GamePhase, readonly GamePhase[]> = {
  LOBBY: ['BOARD'],
  BOARD: ['CLUE_READY', 'FINAL_WAGER', 'FINISHED', 'PAUSED'],
  CLUE_READY: ['SPECIAL_VOTE', 'ACCEPTING_ANSWERS', 'BOARD', 'PAUSED'],
  SPECIAL_VOTE: ['ACCEPTING_ANSWERS', 'BOARD', 'PAUSED'],
  ACCEPTING_ANSWERS: ['ANSWERS_CLOSED', 'BOARD', 'PAUSED'],
  ANSWERS_CLOSED: ['REVEAL', 'BOARD', 'FINISHED', 'PAUSED'],
  REVEAL: ['LEADERBOARD', 'PAUSED'],
  LEADERBOARD: ['BOARD', 'FINAL_WAGER', 'FINISHED', 'PAUSED'],
  FINAL_WAGER: ['FINAL_QUESTION', 'PAUSED'],
  FINAL_QUESTION: ['ANSWERS_CLOSED', 'FINISHED', 'PAUSED'],
  FINISHED: [],
  PAUSED: [
    'ACCEPTING_ANSWERS',
    'CLUE_READY',
    'SPECIAL_VOTE',
    'ANSWERS_CLOSED',
    'REVEAL',
    'LEADERBOARD',
    'BOARD',
    'FINAL_WAGER',
    'FINAL_QUESTION',
  ],
}
function assertTransition(from: GamePhase, to: GamePhase): void {
  if (!allowedTransitions[from].includes(to)) {
    throw new Error(`Cannot transition from ${from} to ${to}`)
  }
}
export class GameEngine extends EventEmitter {
  private get result(): RoundResult | undefined {
    const change = this.rooms.pendingChange()
    return change?.kind === 'settle' ? change.result : undefined
  }
  private stopped = false
  private readonly timers = new Map<string, NodeJS.Timeout>();
  dispose(): void {
    this.stopped = true
    for (const timer of this.timers.values()) clearTimeout(timer)
    this.timers.clear()
  }
  runRoom<T>(roomId: string, action: () => Promise<T>, operationId?: string): Promise<T> {
    return this.rooms.runRoom(roomId, action, operationId)
  }
  afterCommit(effect: () => void): void {
    this.rooms.afterCommit(effect)
  }
  private mutate<T>(
    room: RoomRecord,
    action: (current: RoomRecord) => Promise<T>,
    checkVersion = true,
  ): Promise<T> {
    return this.rooms.runRoom(room.id, async () => {
      const current = await this.rooms.getById(room.id)
      if (!current) throw new Error('Room not found')
      if (checkVersion && current.stateVersion !== room.stateVersion) {
        throw new Error('Room state changed; refresh and try again')
      }
      return action(current)
    })
  }
  private readRoom<T>(roomId: string, action: (room: RoomRecord) => Promise<T>): Promise<T> {
    return this.rooms.runRoom(roomId, async () => action(await this.requireRoom(roomId)))
  }
  constructor(database: DomainSource, private readonly rooms: RoomRepository, private readonly joinBaseUrl: string, private readonly scopeMediaToRoom = false) {
    super()
    domainFrom(database)
    this.rooms.onEffectError = (error) => { this.emit('operationFailed', error) }
  }
  async recoverInterruptedGames(): Promise<number> {
    return (await this.rooms.pauseActiveRooms())
  }
  async preparePackDeletion(packId: string): Promise<void> {
    let cursor: string | undefined
    do {
      const page = await this.rooms.store.forPack(packId, { ...(cursor ? { cursor } : {}), limit: 100 })
      page.items.forEach(({ id }) => this.clearTimer(id))
      cursor = page.cursor
    } while (cursor)
  }
  async publicSnapshot(room: RoomRecord) {
    return (await this.snapshotPair(room, false)).public
  }
  async hostSnapshot(room: RoomRecord) {
    return (await this.snapshotPair(room)).host!
  }
  async snapshotPair(room: RoomRecord, includeHost = true) {
    return this.readRoom(room.id, async (room) => {

      const board = (await this.rooms.store.board(room.ref))
      const clue = room.state.activeClueId ? (await this.getClue(room.state.activeClueId)) : undefined
      const visibleClue = room.state.phase === 'FINAL_WAGER' ||
        (room.state.phase === 'PAUSED' && room.state.previousPhase === 'FINAL_WAGER')
        ? undefined
        : clue
      const revealed = ['REVEAL', 'LEADERBOARD', 'FINISHED'].includes(room.state.phase)
      const votingHidden = this.activeSpecial(room) === 'forced_player' && !room.state.forcedPlayerId
      const clueConfig = clue
        ? (clue.config)
        : undefined
      const publicSnapshot = {
        code: room.code,
        joinUrl: `${this.joinBaseUrl}/play/${room.code}`,
        phase: room.state.phase,
        stateVersion: room.stateVersion,
        roomGeneration: room.ref.generation,
        attempt: room.state.attempt ?? 0,
        window: room.state.window ?? 0,
        wagerGeneration: room.state.wagerGeneration ?? 0,
        joiningLocked: room.joiningLocked,
        teams: room.settings.teams ?? [],
        deadline: room.state.deadline,
        activeClue: visibleClue
          ? {
            id: visibleClue.id,
            categoryId: visibleClue.categoryId,
            type: visibleClue.type,
            boardValue: visibleClue.boardValue,
            prompt: votingHidden
              ? 'Vote for the player who must answer this clue.'
              : visibleClue.prompt,
            timerSeconds: this.effectiveTimerSeconds(room, visibleClue),
            special: room.state.specialAssignments?.[visibleClue.id],
            mediaUrl: !votingHidden && visibleClue.mediaAssetId
              ? `/api/media/${visibleClue.mediaAssetId}/stream${this.scopeMediaToRoom ? `?roomCode=${encodeURIComponent(room.code)}` : ''}`
              : undefined,
            revealMediaUrl: !votingHidden && visibleClue.revealMediaAssetId
              ? `/api/media/${visibleClue.revealMediaAssetId}/stream${this.scopeMediaToRoom ? `?roomCode=${encodeURIComponent(room.code)}` : ''}`
              : undefined,
            revealGif: revealed && isRevealGif(clueConfig?.revealGif)
              ? clueConfig.revealGif
              : undefined,
            choices: !votingHidden && visibleClue.type === 'music_multiple_choice'
              ? this.safeChoices(clueConfig ?? {})
              : undefined,
            price: !votingHidden && visibleClue.type === 'price_slider'
              ? this.safePriceConfig(clueConfig ?? {})
              : undefined,
            answer: revealed ? this.revealedAnswer(visibleClue, clueConfig ?? {}) : undefined,
          }
          : undefined,
        finalRound: Boolean(room.state.finalRound),
        hasFinalQuestion: (await this.hasFinalQuestion(room)),
        wageredPlayerIds: room.state.finalRound && clue
          ? (await this.rooms.store.wagers(room.ref, this.attempt(room))).map(({ playerId }) => playerId)
          : [],
        specialVotedPlayerIds: (await this.validSpecialVotes(room)).map(([voterId]) => voterId),
        forcedPlayerId: room.state.forcedPlayerId,
        usedClueIds: room.state.usedClueIds,
        board,
        players: (await this.rooms.scores(room.id)),
        results: revealed && clue
          ? (await this.resultView(room)) : undefined,
      }
      const host = includeHost ? {
        ...publicSnapshot,
        activeClue: clue
          ? { ...publicSnapshot.activeClue, config: clue.config }
          : undefined,
        submissions: clue
          ? (await this.submissions(room)).map(({ playerId, elapsedMs, receivedAt }) => ({ playerId, elapsedMs, receivedAt })) : [],
      } : undefined
      return { public: publicSnapshot, host }
    })
  }
  async startGame(room: RoomRecord): Promise<RoomRecord> {
    return this.mutate(room, async (room) => {

      const playerCount = (await this.rooms.listPlayers(room.id)).length
      if (playerCount === 0)
        throw new Error('At least one player is required')
      const specials = room.settings.specials ?? []
      if (specials.includes('forced_player') && playerCount < 2) {
        throw new Error('Forced Player requires at least two players')
      }
      const clueIds = (await this.rooms.store.board(room.ref)).map(({ clueId }) => clueId)
      if (clueIds.length < specials.length) {
        throw new Error(`This pack needs at least ${specials.length} ordinary clues for the selected specials`)
      }
      for (let index = clueIds.length - 1;index > 0;index -= 1) {
        const swapIndex = randomInt(index + 1);
        [clueIds[index], clueIds[swapIndex]] = [clueIds[swapIndex]!, clueIds[index]!]
      }
      const specialAssignments = Object.fromEntries(specials.map((special, index) => [clueIds[index]!, special])) as Record<string, SpecialType>
      return (await this.transition(room, 'BOARD', { startedAt: new Date().toISOString(), specialAssignments }, 'active'))

    })
  }
  async selectClue(room: RoomRecord, clueId: string): Promise<RoomRecord> {
    return this.mutate(room, async (room) => {

      if (room.state.usedClueIds.includes(clueId))
        throw new Error('That clue has already been played')
      const clue = (await this.getClue(clueId))
      if (!clue || !(await this.clueBelongsToPack(clueId, room.packId)))
        throw new Error('Clue not found')
      if (clue.finalQuestion)
        throw new Error('Use the Final Question control for that clue')
      const readyRoom = (await this.transition(room, 'CLUE_READY', {
        activeClueId: clueId,
        attempt: (room.state.attempt ?? 0) + 1,
        specialVotes: {},
        forcedPlayerId: undefined,
      }, 'active'))
      if (this.activeSpecial(readyRoom) === 'forced_player') {
        return (await this.transition(readyRoom, 'SPECIAL_VOTE', {}, 'active'))
      }
      return (await this.openAnswers(readyRoom))

    })
  }
  async submitSpecialVote(room: RoomRecord, voterId: string, targetPlayerId: string): Promise<RoomRecord> {
    return this.mutate(room, async (room) => {

      if (room.state.phase !== 'SPECIAL_VOTE' || this.activeSpecial(room) !== 'forced_player') {
        throw new Error('Forced Player voting is not open')
      }
      const players = (await this.rooms.listPlayers(room.id))
      if (!players.some(({ id }) => id === voterId))
        throw new Error('Player not found')
      if (!players.some(({ id }) => id === targetPlayerId))
        throw new Error('Choose an active player')
      if (voterId === targetPlayerId)
        throw new Error('You cannot vote for yourself')
      if ((await this.validSpecialVotes(room)).some(([validVoterId]) => validVoterId === voterId)) {
        throw new Error('Your vote is already locked')
      }
      const updated = (await this.rooms.saveState(room.id, {
        ...room.state,
        specialVotes: { ...room.state.specialVotes, [voterId]: targetPlayerId },
      }, 'active', room.stateVersion))
      this.emitUpdate(room.id)
      return (await this.validSpecialVotes(updated)).length === players.length
        ? (await this.resolveSpecialVote(updated)) : updated

    }, false)
  }
  async resolveSpecialVote(room: RoomRecord): Promise<RoomRecord> {
    return this.mutate(room, async (room) => {

      if (room.state.phase !== 'SPECIAL_VOTE' || this.activeSpecial(room) !== 'forced_player') {
        throw new Error('Forced Player voting is not open')
      }
      const players = (await this.rooms.listPlayers(room.id))
      if (players.length === 0)
        throw new Error('At least one player is required')
      const votes = (await this.validSpecialVotes(room)).map(([, targetPlayerId]) => targetPlayerId)
      let forcedPlayerId: string
      if (players.length === 1) {
        forcedPlayerId = players[0]!.id
      }
      else {
        if (votes.length === 0) {
          throw new Error('At least one player must vote before starting the question')
        }
        const counts = new Map<string, number>()
        for (const playerId of votes)
          counts.set(playerId, ((counts.get(playerId)) ?? 0) + 1)
        const highestCount = Math.max(...counts.values())
        const finalists = [...counts.entries()]
          .filter(([, count]) => count === highestCount)
          .map(([playerId]) => playerId)
        forcedPlayerId = finalists[randomInt(finalists.length)]!
      }
      const selected = (await this.rooms.saveState(room.id, { ...room.state, forcedPlayerId }, 'active', room.stateVersion))
      this.emitUpdate(room.id)
      return (await this.openAnswers(selected))

    })
  }
  private async validSpecialVotes(room: RoomRecord): Promise<Array<[
    string,
    string
  ]>> {
    return this.mutate(room, async (room) => {

      const activePlayerIds = new Set((await this.rooms.scores(room.id)).map(({ playerId }) => playerId))
      return Object.entries(room.state.specialVotes ?? {}).filter(([voterId, targetPlayerId]) => voterId !== targetPlayerId &&
        activePlayerIds.has(voterId) &&
        activePlayerIds.has(targetPlayerId))

    })
  }
  async startFinalRound(room: RoomRecord): Promise<RoomRecord> {
    return this.mutate(room, async (room) => {

      if (room.state.phase !== 'BOARD' && room.state.phase !== 'LEADERBOARD') {
        throw new Error('Return to the board or leaderboard before starting Final Question')
      }
      const completedClueId = room.state.phase === 'LEADERBOARD' ? room.state.activeClueId : undefined
      const finalClueId = (await this.finalQuestionId(room))
      if (!finalClueId)
        throw new Error('This pack does not have a Final Question')
      await this.rooms.setJoiningLocked(room.id, true)
      return (await this.transition(room, 'FINAL_WAGER', {
        activeClueId: finalClueId,
        attempt: (room.state.attempt ?? 0) + 1,
        wagerGeneration: (room.state.wagerGeneration ?? 0) + 1,
        usedClueIds: completedClueId
          ? [...new Set([...room.state.usedClueIds, completedClueId])]
          : room.state.usedClueIds,
        finalRound: true,
        deadline: undefined,
        startedAt: undefined,
      }, 'active'))

    })
  }
  async submitFinalWager(room: RoomRecord, playerId: string, amount: number): Promise<void> {
    return this.mutate(room, async (room) => {

      if (room.state.phase !== 'FINAL_WAGER' || !room.state.activeClueId) {
        throw new Error('Final wagers are not open')
      }
      const player = (await this.rooms.getPlayer(playerId))
      if (!player || player.roomId !== room.id || player.kicked)
        throw new Error('Player not found')
      const score = (await this.rooms.scores(room.id)).find((entry) => entry.playerId === playerId)?.score ?? 0
      const maximum = Math.max(0, score)
      if (!Number.isSafeInteger(amount) || amount < 0 || amount > maximum) {
        throw new Error(`Wager must be a whole number from 0 to ${maximum}`)
      }
      this.rooms.setChange({ kind: 'wager', attempt: this.attempt(room), generation: room.state.wagerGeneration ?? 0, wager: { playerId, amount } })
      this.emitUpdate(room.id)

    })
  }
  async startFinalQuestion(room: RoomRecord): Promise<RoomRecord> {
    return this.mutate(room, async (room) => {

      if (room.state.phase !== 'FINAL_WAGER' || !room.state.activeClueId) {
        throw new Error('Final wagers are not open')
      }
      const playerCount = (await this.rooms.listPlayers(room.id)).length
      const wagerCount = (await this.rooms.store.wagers(room.ref, this.attempt(room))).length
      if (playerCount === 0 || wagerCount !== playerCount) {
        throw new Error('Every player must lock a wager before the final question')
      }
      const clue = (await this.getClue(room.state.activeClueId))
      if (!clue)
        throw new Error('Final clue not found')
      const timerSeconds = this.effectiveTimerSeconds(room, clue)
      const openedAtMs = Date.now()
      const updated = (await this.transition(room, 'FINAL_QUESTION', {
        window: (room.state.window ?? 0) + 1,
        deadline: new Date(openedAtMs + timerSeconds * 1000).toISOString(),
        startedAt: new Date(openedAtMs).toISOString(),
      }, 'active'))
      this.scheduleClose(updated, timerSeconds * 1000)
      return updated

    })
  }
  async openAnswers(room: RoomRecord): Promise<RoomRecord> {
    return this.mutate(room, async (room) => {

      const clue = room.state.activeClueId ? (await this.getClue(room.state.activeClueId)) : undefined
      if (!clue)
        throw new Error('No clue is selected')
      if (this.activeSpecial(room) === 'forced_player' && !room.state.forcedPlayerId) {
        throw new Error('Complete Forced Player voting before opening answers')
      }
      const timerSeconds = this.effectiveTimerSeconds(room, clue)
      const openedAtMs = Date.now()
      const roomAfter = (await this.transition(room, 'ACCEPTING_ANSWERS', {
        window: (room.state.window ?? 0) + 1,
        deadline: new Date(openedAtMs + timerSeconds * 1000).toISOString(),
        startedAt: new Date(openedAtMs).toISOString(),
      }, 'active'))
      this.scheduleClose(roomAfter, timerSeconds * 1000)
      return roomAfter

    })
  }
  async submitAnswer(room: RoomRecord, playerId: string, answer: unknown, receivedAtMs = Date.now()): Promise<{
    submissionId: string
    receivedAt: string
  }> {
    return this.mutate(room, async (room) => {

      if ((room.state.phase !== 'ACCEPTING_ANSWERS' && room.state.phase !== 'FINAL_QUESTION') ||
        !room.state.activeClueId) {
        throw new Error('Answers are not open')
      }
      if (room.state.deadline && receivedAtMs > Date.parse(room.state.deadline)) {
        throw new Error('Answers are closed')
      }
      const player = (await this.rooms.getPlayer(playerId))
      if (!player || player.roomId !== room.id || player.kicked)
        throw new Error('Player not found')
      if (this.activeSpecial(room) === 'forced_player' &&
        room.state.forcedPlayerId !== playerId) {
        throw new Error('Only the selected player can answer this clue')
      }
      const clue = (await this.getClue(room.state.activeClueId))
      if (!clue)
        throw new Error('Clue not found')
      this.validateAnswer(clue, answer)
      const startedAt = room.state.startedAt ? Date.parse(room.state.startedAt) : receivedAtMs
      const elapsedMs = Math.max(0, receivedAtMs - startedAt)
      const receivedAt = new Date(receivedAtMs).toISOString()
      const submissionId = createId()
      this.rooms.setChange({ kind: 'submission', attempt: this.attempt(room), window: room.state.window ?? 0, clue,
        submission: { id: submissionId, playerId, answer, elapsedMs, receivedAt } })
      this.emitHostUpdate(room.id)
      return { submissionId, receivedAt }

    })
  }
  async closeAnswers(room: RoomRecord): Promise<RoomRecord> {
    return this.mutate(room, async (room) => {

      if (room.state.phase !== 'ACCEPTING_ANSWERS' && room.state.phase !== 'FINAL_QUESTION') {
        throw new Error('Answers are not open')
      }
      this.clearTimer(room.id)
      const updated = (await this.transition(room, 'ANSWERS_CLOSED', {}, 'active'))
      await this.evaluateClue(updated)
      return (await this.requireRoom(room.id))

    })
  }
  async reveal(room: RoomRecord): Promise<RoomRecord> {
    return this.mutate(room, async (room) => {

      return (await this.transition(room, 'REVEAL', { revealedAt: new Date().toISOString() }, 'active'))

    })
  }
  async showLeaderboard(room: RoomRecord): Promise<RoomRecord> {
    return this.mutate(room, async (room) => {

      return (await this.transition(room, 'LEADERBOARD', {}, 'active'))

    })
  }
  async returnToBoard(room: RoomRecord): Promise<RoomRecord> {
    return this.mutate(room, async (room) => {

      const activeClueId = room.state.activeClueId
      const usedClueIds = activeClueId
        ? [...new Set([...room.state.usedClueIds, activeClueId])]
        : room.state.usedClueIds
      return (await this.transition(room, 'BOARD', {
        usedClueIds,
        activeClueId: undefined,
        deadline: undefined,
        startedAt: undefined,
        specialVotes: undefined,
        forcedPlayerId: undefined,
      }, 'active'))

    })
  }
  async goBack(room: RoomRecord): Promise<RoomRecord> {
    return this.mutate(room, async (room) => {

      if (!room.state.activeClueId)
        throw new Error('No clue is selected')
      this.clearTimer(room.id)
      await this.clearClueAttempts(room, true)
      const updated = (await this.rooms.saveState(room.id, {
        ...room.state,
        phase: 'BOARD',
        activeClueId: undefined,
        deadline: undefined,
        startedAt: undefined,
        revealedAt: undefined,
        previousPhase: undefined,
        remainingMs: undefined,
        finalRound: false,
        specialVotes: undefined,
        forcedPlayerId: undefined,
      }, 'active', room.stateVersion))
      this.emitUpdate(room.id)
      return updated

    })
  }
  async resetClue(room: RoomRecord): Promise<RoomRecord> {
    return this.mutate(room, async (room) => {

      if (!room.state.activeClueId)
        throw new Error('No clue is selected')
      if (room.state.phase === 'FINAL_WAGER' ||
        (room.state.phase === 'PAUSED' && room.state.previousPhase === 'FINAL_WAGER')) {
        throw new Error('Start the Final Question before resetting it')
      }
      const clue = (await this.getClue(room.state.activeClueId))
      if (!clue)
        throw new Error('Clue not found')
      this.clearTimer(room.id)
      await this.clearClueAttempts(room, false)
      const timerSeconds = this.effectiveTimerSeconds(room, clue)
      const forcedPlayer = this.activeSpecial(room) === 'forced_player'
      const phase = room.state.finalRound
        ? 'FINAL_QUESTION'
        : forcedPlayer
          ? 'SPECIAL_VOTE'
          : 'ACCEPTING_ANSWERS'
      const openedAtMs = Date.now()
      const updated = (await this.rooms.saveState(room.id, {
        ...room.state,
        phase,
        attempt: (room.state.attempt ?? 0) + 1,
        window: (room.state.window ?? 0) + 1,
        deadline: forcedPlayer
          ? undefined
          : new Date(openedAtMs + timerSeconds * 1000).toISOString(),
        startedAt: forcedPlayer ? undefined : new Date(openedAtMs).toISOString(),
        specialVotes: forcedPlayer ? {} : room.state.specialVotes,
        forcedPlayerId: forcedPlayer ? undefined : room.state.forcedPlayerId,
        revealedAt: undefined,
        previousPhase: undefined,
        remainingMs: undefined,
      }, 'active', room.stateVersion))
      if (!forcedPlayer)
        this.scheduleClose(updated, timerSeconds * 1000)
      this.emitUpdate(room.id)
      return updated

    })
  }
  async skipClue(room: RoomRecord): Promise<RoomRecord> {
    return this.mutate(room, async (room) => {

      if (!room.state.activeClueId)
        throw new Error('No clue is selected')
      this.clearTimer(room.id)
      await this.invalidate(room, 'void')
      if (room.state.finalRound) {
        const usedClueIds = [...new Set([...room.state.usedClueIds, room.state.activeClueId])]
        return (await this.transition(room, 'FINISHED', { usedClueIds, activeClueId: undefined, deadline: undefined }, 'finished'))
      }
      const board = (await this.returnToBoard(room))
      return (await this.hasUnusedClues(board)) || (await this.hasFinalQuestion(room))
        ? board
        : (await this.finish(board))

    })
  }
  async pause(room: RoomRecord): Promise<RoomRecord> {
    return this.mutate(room, async (room) => {

      if (![
        'ACCEPTING_ANSWERS',
        'CLUE_READY',
        'SPECIAL_VOTE',
        'ANSWERS_CLOSED',
        'REVEAL',
        'LEADERBOARD',
        'BOARD',
        'FINAL_WAGER',
        'FINAL_QUESTION',
      ].includes(room.state.phase)) {
        throw new Error('The game cannot be paused now')
      }
      this.clearTimer(room.id)
      const deadline = room.state.deadline ? Date.parse(room.state.deadline) : undefined
      return (await this.transition(room, 'PAUSED', {
        previousPhase: room.state.phase,
        window: (room.state.window ?? 0) + 1,
        remainingMs: deadline ? Math.max(0, deadline - Date.now()) : undefined,
        deadline: undefined,
      }, 'paused'))

    })
  }
  async resume(room: RoomRecord): Promise<RoomRecord> {
    return this.mutate(room, async (room) => {

      if (room.state.phase !== 'PAUSED' || !room.state.previousPhase) {
        throw new Error('The game is not paused')
      }
      const target = room.state.previousPhase
      const remainingMs = room.state.remainingMs
      if ((target === 'ACCEPTING_ANSWERS' || target === 'FINAL_QUESTION') &&
        remainingMs !== undefined &&
        remainingMs <= 0) {
        const closed = (await this.transition(room, 'ANSWERS_CLOSED', {
          previousPhase: undefined,
          remainingMs: undefined,
          deadline: undefined,
        }, 'active'))
        await this.evaluateClue(closed)
        return (await this.requireRoom(room.id))
      }
      const clue = room.state.activeClueId ? (await this.getClue(room.state.activeClueId)) : undefined
      const durationMs = clue ? this.effectiveTimerSeconds(room, clue) * 1000 : room.settings.timerSeconds * 1000
      const elapsedBeforePause = (target === 'ACCEPTING_ANSWERS' || target === 'FINAL_QUESTION') &&
        remainingMs !== undefined
        ? Math.max(0, durationMs - remainingMs)
        : undefined
      const resumedAtMs = Date.now()
      const updated = (await this.transition(room, target, {
        window: (room.state.window ?? 0) + 1,
        previousPhase: undefined,
        remainingMs: undefined,
        deadline: (target === 'ACCEPTING_ANSWERS' || target === 'FINAL_QUESTION') && remainingMs
          ? new Date(resumedAtMs + remainingMs).toISOString()
          : undefined,
        startedAt: elapsedBeforePause !== undefined
          ? new Date(resumedAtMs - elapsedBeforePause).toISOString()
          : room.state.startedAt,
      }, 'active'))
      if ((target === 'ACCEPTING_ANSWERS' || target === 'FINAL_QUESTION') && remainingMs) {
        this.scheduleClose(updated, remainingMs)
      }
      return updated

    })
  }
  async finish(room: RoomRecord): Promise<RoomRecord> {
    return this.mutate(room, async (room) => {

      this.clearTimer(room.id)
      const finalClueId = room.state.finalRound ? room.state.activeClueId : undefined
      return (await this.transition(room, 'FINISHED', finalClueId
        ? {
          usedClueIds: [...new Set([...room.state.usedClueIds, finalClueId])],
          activeClueId: undefined,
          deadline: undefined,
        }
        : {}, 'finished'))

    })
  }
  async endSession(room: RoomRecord): Promise<RoomRecord> {
    return this.mutate(room, async (room) => {

      this.clearTimer(room.id)
      if (room.status === 'finished' || room.status === 'abandoned')
        return room
      const updated = (await this.rooms.saveState(room.id, {
        ...room.state,
        phase: 'FINISHED',
        activeClueId: undefined,
        deadline: undefined,
        previousPhase: undefined,
        remainingMs: undefined,
      }, 'abandoned', room.stateVersion))
      this.emitUpdate(room.id)
      return updated

    })
  }
  async adjustScore(room: RoomRecord, playerId: string, delta: number, reason: string): Promise<void> {
    return this.mutate(room, async (room) => {

      const player = (await this.rooms.getPlayer(playerId))
      if (!player || player.roomId !== room.id)
        throw new Error('Player not found')
      if (!Number.isSafeInteger(delta) || Math.abs(delta) > 100000)
        throw new Error('Invalid score delta')
      if (!reason.trim())
        throw new Error('A reason is required')
      await this.addScore(room.id, playerId, room.state.activeClueId, delta, 'host_adjustment', reason, 'host')
      this.emitUpdate(room.id)

    })
  }
  private async transition(room: RoomRecord, phase: GamePhase, patch: Partial<RoomState>, status: RoomRecord['status']): Promise<RoomRecord> {
    return this.mutate(room, async (room) => {

      assertTransition(room.state.phase, phase)
      const state = { ...room.state, ...patch, phase }
      const updated = (await this.rooms.saveState(room.id, state, status, room.stateVersion))
      this.emitUpdate(room.id)
      return updated

    })
  }
  private async evaluateClue(room: RoomRecord): Promise<void> {
    return this.mutate(room, async (room) => {

      const clue = room.state.activeClueId ? (await this.getClue(room.state.activeClueId)) : undefined
      if (!clue)
        throw new Error('No active clue')
      const config = clue.config
      const submissions = this.submissionPages(room)
      const result: RoundResult = { id: createId(), attempt: this.attempt(room), clue, entries: [], awards: [],
        activeScores: structuredClone(this.rooms.current().activeScores) }
      this.rooms.setChange({ kind: 'settle', result })
        if (room.state.finalRound) {
          await this.evaluateFinalClue(room, clue, config)
        }
        else if (this.activeSpecial(room) === 'forced_player') {
          await this.evaluateForcedPlayer(room, clue, config)
        }
        else if (clue.type === 'price_slider') {
          await this.evaluatePrice(room, clue, config, submissions)
        }
        else {
          await this.evaluateMusic(room, clue, config, submissions)
        }
      await this.flushResult(true)
      this.emitUpdate(room.id)

    })
  }
  private async clearClueAttempts(room: RoomRecord, clearWagers: boolean): Promise<void> {
    return this.mutate(room, async (room) => {

      const clueId = room.state.activeClueId
      if (!clueId)
        return
      await this.invalidate(room, clearWagers ? 'goBack' : 'reset')

    })
  }
  private async evaluateFinalClue(room: RoomRecord, clue: ClueRow, config: Record<string, unknown>): Promise<void> {
    return this.mutate(room, async (room) => {

      const wagers = await this.rooms.store.wagers(room.ref, this.attempt(room))
      const bestPrice = clue.type === 'price_slider'
        ? (await this.rooms.store.submissions(room.ref, this.attempt(room), { limit: 1 }, 'priceEligible')).items[0]?.answer
        : undefined
      const accepted = clue.type === 'price_slider'
        ? []
        : [
          ...(Array.isArray(config.acceptedAnswers)
            ? config.acceptedAnswers.filter((answer): answer is string => typeof answer === 'string')
            : []),
          ...(typeof config.correctAnswer === 'string' ? [config.correctAnswer] : []),
        ]
      for (const wager of wagers) {
        const submission = await this.rooms.store.submissionForPlayer(room.ref, this.attempt(room), wager.playerId)
        const answer = submission ? (submission.answer) : null
        const match = clue.type === 'price_slider'
          ? { matched: Boolean(submission && Number(submission.answer) === Number(bestPrice)) }
          : typeof answer === 'string'
            ? matchFreeTextAnswer(answer, accepted)
            : { matched: false }
        const delta = match.matched ? wager.amount : -wager.amount
        const evaluation = {
          kind: 'FINAL',
          wager: wager.amount,
          answered: Boolean(submission),
          correct: match.matched,
        }
        if (submission) {
          await this.updateSubmission(submission, match.matched, undefined, delta, evaluation)
        }
        else {
          await this.insertSpecialSubmission(room, clue, wager.playerId, match.matched, delta, evaluation)
        }
        if (delta !== 0) {
          await this.addScore(room.id, wager.playerId, clue.id, delta, clue.type === 'price_slider' ? 'price' : 'music', match.matched ? 'Final wager won' : 'Final wager lost', 'system')
        }
      }

    })
  }
  private async evaluateForcedPlayer(room: RoomRecord, clue: ClueRow, config: Record<string, unknown>): Promise<void> {
    return this.mutate(room, async (room) => {

      const forcedPlayerId = room.state.forcedPlayerId
      if (!forcedPlayerId)
        throw new Error('Forced Player has no selected player')
      const submission = await this.rooms.store.submissionForPlayer(room.ref, this.attempt(room), forcedPlayerId)
      const answer = submission ? (submission.answer) : null
      let correct = false
      if (clue.type === 'price_slider') {
        const guess = Number(answer)
        const target = Number(config.correctPrice)
        correct =
          answer !== null && Number.isFinite(guess) && Number.isFinite(target) && guess === target
      }
      else {
        const accepted = [
          ...(Array.isArray(config.acceptedAnswers)
            ? config.acceptedAnswers.filter((value): value is string => typeof value === 'string')
            : []),
          ...(typeof config.correctAnswer === 'string' ? [config.correctAnswer] : []),
        ]
        correct = typeof answer === 'string' && matchFreeTextAnswer(answer, accepted).matched
      }
      const evaluation = {
        kind: 'FORCED_PLAYER',
        special: 'forced_player',
        forcedPlayerId,
        answered: Boolean(submission),
        correct,
        points: correct ? clue.boardValue : 0,
      }
      if (submission) {
        await this.updateSubmission(submission, correct, undefined, correct ? clue.boardValue : 0, evaluation)
      }
      else {
        await this.insertSpecialSubmission(room, clue, forcedPlayerId, false, 0, evaluation)
      }
      const source = clue.type === 'price_slider' ? 'price' : 'music'
      if (correct) {
        await this.addScore(room.id, forcedPlayerId, clue.id, clue.boardValue, source, 'Forced Player answered correctly', 'system')
        return
      }
      for (const player of (await this.rooms.listPlayers(room.id))) {
        if (player.id === forcedPlayerId)
          continue
        const recipientEvaluation = {
          kind: 'FORCED_PLAYER',
          special: 'forced_player',
          forcedPlayerId,
          answered: false,
          correct: true,
          awardedBecauseForcedPlayerMissed: true,
          points: clue.boardValue,
        }
        await this.insertSpecialSubmission(room, clue, player.id, true, clue.boardValue, recipientEvaluation)
        await this.addScore(room.id, player.id, clue.id, clue.boardValue, source, 'Forced Player answered incorrectly', 'system')
      }

    })
  }
  private async insertSpecialSubmission(room: RoomRecord, clue: ClueRow, playerId: string, correct: boolean, points: number, evaluation: Record<string, unknown>): Promise<void> {
    return this.mutate(room, async (room) => {

      await this.flushResult()
      this.result!.entries.push({ submissionId: createId(), playerId, answer: null, elapsedMs: this.effectiveTimerSeconds(room, clue) * 1000,
        receivedAt: new Date().toISOString(), correct, points, evaluation, synthetic: true })

    })
  }
  private async evaluateMusic(room: RoomRecord, clue: ClueRow, config: Record<string, unknown>, submissions: AsyncIterable<SubmissionRow>): Promise<void> {
    return this.mutate(room, async (room) => {

      const accepted = Array.isArray(config.acceptedAnswers)
        ? config.acceptedAnswers.filter((answer): answer is string => typeof answer === 'string')
        : []
      if (typeof config.correctAnswer === 'string')
        accepted.push(config.correctAnswer)
      const maxDurationMs = this.effectiveTimerSeconds(room, clue) * 1000
      const special = this.activeSpecial(room)
      for await (const submission of submissions) {
        const answer = submission.answer
        const match = typeof answer === 'string'
          ? matchFreeTextAnswer(answer, accepted)
          : { matched: false, normalizedSubmission: '' }
        const scoreInput = {
          playerId: submission.playerId, clueId: clue.id, boardValue: clue.boardValue,
          correct: match.matched, openedAtMs: 0, deadlineMs: maxDurationMs,
          receivedAtMs: submission.elapsedMs, normalizedAnswer: match.normalizedSubmission,
        }
        const score = scoreMusicAnswer(match.matchedAcceptedAnswer
          ? { ...scoreInput, matchedAcceptedAnswer: match.matchedAcceptedAnswer } : scoreInput)
        const points = this.applySpecialPoints(special, score.totalPoints, clue.boardValue)
        await this.updateSubmission(submission, score.correct, undefined, points, {
          ...score, special, pointsBeforeSpecial: score.totalPoints,
        })
        if (points !== 0) await this.addScore(room.id, submission.playerId, clue.id, points,
          'music', this.specialScoreReason(special, score.correct), 'system')
      }
      await this.applyMissingDoubleOrNothingPenalties(room, clue, 'music')
    })
  }
  private async evaluatePrice(room: RoomRecord, clue: ClueRow, config: Record<string, unknown>, _submissions: AsyncIterable<SubmissionRow>): Promise<void> {
    return this.mutate(room, async (room) => {
      const target = Number(config.correctPrice)
      if (!Number.isFinite(target)) throw new Error('Price clue has no valid target')
      const scorer = createPriceAnswerScorer({
        clueId: clue.id, targetPrice: target, minimumPrice: Number(config.min ?? 0), boardValue: clue.boardValue,
        settings: { rankMultipliers: room.settings.priceRankPercentages, roundTo: 1, tieTolerance: 0 },
      })
      const special = this.activeSpecial(room)
      const answers = async function* (engine: GameEngine) {
        yield* engine.submissionPages(room, 'priceEligible')
        yield* engine.submissionPages(room, 'priceOverbid')
      }
      for await (const submission of answers(this)) {
        const result = scorer({ playerId: submission.playerId, guess: Number(submission.answer) })
        if (!result)
          throw new Error('Price score result is missing')
        const points = this.applySpecialPoints(special, result.points, clue.boardValue)
        await this.updateSubmission(submission, special === 'double_or_nothing' ? result.points > 0 : result.guess === target, result.rank ?? undefined, points, { ...result, special, pointsBeforeSpecial: result.points })
        if (points !== 0) {
          await this.addScore(room.id, submission.playerId, clue.id, points, 'price', this.specialScoreReason(special, result.points > 0, `Price rank ${result.rank}`), 'system')
        }
      }
      await this.applyMissingDoubleOrNothingPenalties(room, clue, 'price')

    })
  }
  private activeSpecial(room: RoomRecord): SpecialType | undefined {
    return room.state.activeClueId
      ? room.state.specialAssignments?.[room.state.activeClueId]
      : undefined
  }
  private effectiveTimerSeconds(room: RoomRecord, clue: ClueRow): number {
    const timerSeconds = clue.timerSeconds || room.settings.timerSeconds
    return room.state.specialAssignments?.[clue.id] === 'speed_round'
      ? Math.max(5, Math.ceil(timerSeconds / 2))
      : timerSeconds
  }
  private applySpecialPoints(special: SpecialType | undefined, normalPoints: number, boardValue: number): number {
    if (special === 'double_points')
      return normalPoints > 0 ? normalPoints * 2 : 0
    if (special === 'double_or_nothing')
      return normalPoints > 0 ? normalPoints * 2 : -boardValue
    return normalPoints
  }
  private specialScoreReason(special: SpecialType | undefined, won: boolean, normalReason = 'Correct answer'): string {
    if (special === 'double_points')
      return `Double Points: ${normalReason}`
    if (special === 'double_or_nothing') {
      return won ? `Double or Nothing won: ${normalReason}` : 'Double or Nothing lost'
    }
    return normalReason
  }
  private async applyMissingDoubleOrNothingPenalties(room: RoomRecord, clue: ClueRow, source: 'music' | 'price'): Promise<void> {
    return this.mutate(room, async (room) => {

      if (this.activeSpecial(room) !== 'double_or_nothing')
        return
      for (const player of (await this.rooms.listPlayers(room.id))) {
        if (await this.rooms.store.submissionForPlayer(room.ref, this.attempt(room), player.id))
          continue
        const evaluation = {
          special: 'double_or_nothing',
          answered: false,
          pointsBeforeSpecial: 0,
          points: -clue.boardValue,
        }
        await this.insertSpecialSubmission(room, clue, player.id, false, -clue.boardValue, evaluation)
        await this.addScore(room.id, player.id, clue.id, -clue.boardValue, source, 'Double or Nothing lost: no answer', 'system')
      }

    })
  }
  private async updateSubmission(submission: Submission, correct: boolean, rank: number | undefined, points: number, evaluation: unknown): Promise<void> {
    await this.flushResult()
    if (!this.result) throw new Error('A round result is required')
    this.result.entries.push({ ...submission, submissionId: submission.id, correct, ...(rank !== undefined ? { rank } : {}), points, evaluation, synthetic: false })
  }
  private async addScore(_roomId: string, playerId: string, clueId: string | undefined, delta: number, source: ScoreAward['source'], reason: string, actor: string): Promise<void> {
    const award: ScoreAward = { playerId, ...(clueId ? { clueId } : {}), delta, source, reason, actor }
    if (this.result) {
      this.result.awards.push(award)
      const score = this.result.activeScores.find((entry) => entry.playerId === playerId)
      if (score) {
        if (!Number.isSafeInteger(score.score + delta)) throw new Error('Score exceeds the safe integer range')
        score.score += delta
      }
    }
    else this.rooms.setChange({ kind: 'adjustment', award })
  }
  private getClue(id: string): Promise<ClueRow | undefined> {
    return this.rooms.store.clue(this.rooms.current().ref, id)
  }
  private async clueBelongsToPack(clueId: string, _packId: string): Promise<boolean> {
    return Boolean(await this.getClue(clueId))
  }
  private attempt(room: RoomRecord): AttemptRef {
    return { clueId: room.state.activeClueId ?? '', attempt: room.state.attempt ?? 0 }
  }
  private async *submissionPages(room: RoomRecord, order: 'receipt' | 'priceEligible' | 'priceOverbid' = 'receipt'): AsyncGenerator<Submission> {
    let cursor: string | undefined
    do {
      const page = await this.rooms.store.submissions(room.ref, this.attempt(room), { ...(cursor ? { cursor } : {}), limit: 50 }, order)
      yield* page.items
      cursor = page.cursor
    } while (cursor)
  }
  private async submissions(room: RoomRecord): Promise<Submission[]> {
    const rows: Submission[] = []
    for await (const submission of this.submissionPages(room)) rows.push(submission)
    return rows
  }
  private async flushResult(final = false): Promise<void> {
    const result = this.result
    if (!result || (!final && result.entries.length < 50 && result.awards.length < 50) || (final && !result.stagedChunks)) return
    if (!result.entries.length && !result.awards.length) return
    const loaded = this.rooms.current()
    await this.rooms.store.prepareResult(loaded.ref, loaded.revision, result.id, result.stagedChunks ?? 0, { entries: result.entries, awards: result.awards })
    result.stagedChunks = (result.stagedChunks ?? 0) + 1
    result.entries = []
    result.awards = []
  }
  private async resultView(room: RoomRecord) {
    const entries: RoundOutcome[] = this.result?.entries ?? []
    if (!this.result) {
      let cursor: string | undefined
      do {
        const page = await this.rooms.store.results(room.ref, this.attempt(room), { ...(cursor ? { cursor } : {}), limit: 100 })
        entries.push(...page.items)
        cursor = page.cursor
      } while (cursor)
    }
    return entries.map((entry) => ({ playerId: entry.playerId, answer: JSON.stringify(entry.answer), correct: entry.correct ? 1 : 0,
      rank: entry.rank ?? null, pointsAwarded: entry.points, evaluation: JSON.stringify(entry.evaluation) }))
  }
  private async invalidate(room: RoomRecord, reason: 'reset' | 'goBack' | 'void'): Promise<void> {
    const awards = (await this.rooms.store.appliedAwards(room.ref, this.attempt(room))).map((award) => ({ ...award,
      delta: -award.delta, reason: reason === 'reset' ? 'Clue reset' : reason === 'goBack' ? 'Clue returned to board' : 'Clue voided by host' }))
    this.rooms.setChange({ kind: 'invalidate', attempt: this.attempt(room), reason, awards,
      ...(this.activeSpecial(room) ? { special: this.activeSpecial(room)! } : {}) })
  }
  private async hasUnusedClues(room: RoomRecord): Promise<boolean> {
    return this.mutate(room, async (room) => {

      return (await this.unusedClueIds(room)).length > 0

    })
  }
  private async unusedClueIds(room: RoomRecord): Promise<string[]> {
    return this.mutate(room, async (room) => {

      const clueIds = (await this.rooms.store.board(room.ref)).map(({ clueId }) => ({ id: clueId }))
      const used = new Set(room.state.usedClueIds)
      return clueIds.map(({ id }) => id).filter((id) => !used.has(id))

    })
  }
  private finalQuestionId(room: RoomRecord): Promise<string | undefined> {
    return this.rooms.store.finalClueId(room.ref)
  }
  private async hasFinalQuestion(room: RoomRecord): Promise<boolean> {
    return Boolean(await this.finalQuestionId(room))
  }
  private safeChoices(config: Record<string, unknown>): string[] {
    return Array.isArray(config.choices)
      ? config.choices.filter((choice): choice is string => typeof choice === 'string')
      : []
  }
  private safePriceConfig(config: Record<string, unknown>) {
    return {
      min: Number(config.min ?? 0),
      max: Number(config.max ?? 100),
      step: Number(config.step ?? 1),
      prefix: typeof config.prefix === 'string' ? config.prefix : '$',
    }
  }
  private revealedAnswer(clue: ClueRow, config: Record<string, unknown>): unknown {
    if (clue.type === 'price_slider')
      return config.correctPrice
    return config.correctAnswer ?? config.acceptedAnswers
  }
  private validateAnswer(clue: ClueRow, answer: unknown): void {
    if (clue.type === 'price_slider') {
      const config = clue.config
      const numericAnswer = Number(answer)
      const min = Number(config.min ?? 0)
      const max = Number(config.max ?? Number.MAX_SAFE_INTEGER)
      if (!Number.isFinite(numericAnswer) || numericAnswer < min || numericAnswer > max) {
        throw new Error('Price guess is outside the allowed range')
      }
      return
    }
    if (typeof answer !== 'string' || !answer.trim() || answer.length > 200) {
      throw new Error('A valid answer is required')
    }
  }
  private scheduleClose(room: RoomRecord, delayMs: number): void {
    this.rooms.afterCommit(() => {
      if (this.stopped) return
      this.clearTimer(room.id)
      const remainingMs = room.state.deadline ? Math.max(0, Date.parse(room.state.deadline) - Date.now()) : delayMs
      const timer = setTimeout(() => {
        if (this.stopped) return
        void this.runRoom(room.id, async () => {
          const latest = await this.rooms.getById(room.id)
          if (latest && latest.ref.generation === room.ref.generation && latest.state.attempt === room.state.attempt &&
            latest.state.window === room.state.window && latest.state.deadline === room.state.deadline &&
            (latest.state.phase === 'ACCEPTING_ANSWERS' || latest.state.phase === 'FINAL_QUESTION')) {
            await this.closeAnswers(latest)
          }
        }, `timer:${room.ref.generation}:${room.state.attempt}:${room.state.window}:${room.state.deadline}`).catch((error: unknown) => this.emit('operationFailed', error))
      }, remainingMs)
      timer.unref()
      this.timers.set(room.id, timer)
    })
  }
  private clearTimer(roomId: string): void {
    this.rooms.afterCommit(() => {
      const timer = this.timers.get(roomId)
      if (timer) clearTimeout(timer)
      this.timers.delete(roomId)
    })
  }
  private async requireRoom(roomId: string): Promise<RoomRecord> {
    const room = (await this.rooms.getById(roomId))
    if (!room)
      throw new Error('Room not found')
    return room
  }
  private emitUpdate(roomId: string): void {
    this.rooms.afterCommit(() => this.emit('roomUpdated', roomId))
  }
  private emitHostUpdate(roomId: string): void {
    this.rooms.afterCommit(() => this.emit('hostUpdated', roomId))
  }
}
