import { EventEmitter } from 'node:events'
import { randomInt } from 'node:crypto'

import {
  matchFreeTextAnswer,
  scoreMusicAnswer,
  scorePriceAnswers,
} from '@friends-trivia/shared'
import type Database from 'better-sqlite3'

import { createId } from '../ids.js'
import { isRevealGif } from '../gifs.js'
import type { RoomRepository } from '../repositories/rooms.js'
import type { GamePhase, RoomRecord, RoomState, SpecialType } from './types.js'

interface ClueRow {
  id: string
  category_id: string
  type: 'music_multiple_choice' | 'music_free_text' | 'price_slider'
  board_value: number
  prompt: string
  timer_seconds: number
  config_json: string
  media_asset_id: string | null
  reveal_media_asset_id: string | null
  is_final: number
}

interface SubmissionRow {
  id: string
  player_id: string
  answer_json: string
  elapsed_ms: number
}

interface FinalWagerRow {
  player_id: string
  amount: number
}

const allowedTransitions: Record<GamePhase, readonly GamePhase[]> = {
  LOBBY: ['BOARD'],
  BOARD: ['CLUE_READY', 'FINAL_WAGER', 'FINISHED', 'PAUSED'],
  CLUE_READY: ['ACCEPTING_ANSWERS', 'BOARD', 'PAUSED'],
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
  private readonly timers = new Map<string, NodeJS.Timeout>()

  constructor(
    private readonly database: Database.Database,
    private readonly rooms: RoomRepository,
    private readonly joinBaseUrl: string,
  ) {
    super()
  }

  recoverInterruptedGames(): number {
    return this.rooms.pauseActiveRooms()
  }

  preparePackDeletion(packId: string): void {
    const roomIds = this.database
      .prepare('SELECT id FROM rooms WHERE pack_id = ?')
      .all(packId) as Array<{ id: string }>
    roomIds.forEach(({ id }) => this.clearTimer(id))
  }

  publicSnapshot(room: RoomRecord) {
    const board = this.database
      .prepare(
        `SELECT c.id AS categoryId, c.title AS categoryTitle, c.position AS categoryPosition,
                q.id AS clueId, q.board_value AS boardValue, q.position AS cluePosition,
                q.type AS clueType
         FROM categories c
         JOIN clues q ON q.category_id = c.id
         WHERE c.pack_id = ? AND c.archived = 0 AND q.archived = 0 AND q.is_final = 0
         ORDER BY c.position, q.position`,
      )
      .all(room.packId)
    const clue = room.state.activeClueId ? this.getClue(room.state.activeClueId) : undefined
    const visibleClue =
      room.state.phase === 'FINAL_WAGER' ||
      (room.state.phase === 'PAUSED' && room.state.previousPhase === 'FINAL_WAGER')
        ? undefined
        : clue
    const revealed = ['REVEAL', 'LEADERBOARD', 'FINISHED'].includes(room.state.phase)
    const clueConfig = clue
      ? (JSON.parse(clue.config_json) as Record<string, unknown>)
      : undefined
    return {
      code: room.code,
      joinUrl: `${this.joinBaseUrl}/play/${room.code}`,
      phase: room.state.phase,
      stateVersion: room.stateVersion,
      joiningLocked: room.joiningLocked,
      teams: room.settings.teams ?? [],
      deadline: room.state.deadline,
      activeClue: visibleClue
        ? {
            id: visibleClue.id,
            categoryId: visibleClue.category_id,
            type: visibleClue.type,
            boardValue: visibleClue.board_value,
            prompt: visibleClue.prompt,
            timerSeconds: this.effectiveTimerSeconds(room, visibleClue),
            special: room.state.specialAssignments?.[visibleClue.id],
            mediaUrl: visibleClue.media_asset_id ? `/api/media/${visibleClue.media_asset_id}/stream` : undefined,
            revealMediaUrl: visibleClue.reveal_media_asset_id
              ? `/api/media/${visibleClue.reveal_media_asset_id}/stream`
              : undefined,
            revealGif:
              revealed && isRevealGif(clueConfig?.revealGif)
                ? clueConfig.revealGif
                : undefined,
            choices:
              visibleClue.type === 'music_multiple_choice'
                ? this.safeChoices(clueConfig ?? {})
                : undefined,
            price:
              visibleClue.type === 'price_slider'
                ? this.safePriceConfig(clueConfig ?? {})
                : undefined,
            answer: revealed ? this.revealedAnswer(visibleClue, clueConfig ?? {}) : undefined,
          }
        : undefined,
      finalRound: Boolean(room.state.finalRound),
      hasFinalQuestion: this.hasFinalQuestion(room.packId),
      wageredPlayerIds:
        room.state.finalRound && clue
          ? (
              this.database
                .prepare(
                  `SELECT w.player_id AS playerId
                   FROM final_wagers w
                   JOIN players p ON p.id = w.player_id
                   WHERE w.room_id = ? AND w.clue_id = ? AND p.kicked = 0`,
                )
                .all(room.id, clue.id) as Array<{ playerId: string }>
            ).map(({ playerId }) => playerId)
          : [],
      usedClueIds: room.state.usedClueIds,
      board,
      players: this.rooms.scores(room.id),
      results:
        revealed && clue
          ? this.database
              .prepare(
                `SELECT player_id AS playerId, answer_json AS answer, correct, rank,
                        points_awarded AS pointsAwarded, evaluation_json AS evaluation
                 FROM submissions WHERE room_id = ? AND clue_id = ?`,
              )
              .all(room.id, clue.id)
          : undefined,
    }
  }

  hostSnapshot(room: RoomRecord) {
    const publicSnapshot = this.publicSnapshot(room)
    const clue = room.state.activeClueId ? this.getClue(room.state.activeClueId) : undefined
    return {
      ...publicSnapshot,
      activeClue: clue
        ? { ...publicSnapshot.activeClue, config: JSON.parse(clue.config_json) as unknown }
        : undefined,
      submissions: clue
        ? this.database
            .prepare(
              `SELECT player_id AS playerId, elapsed_ms AS elapsedMs, received_at AS receivedAt
               FROM submissions WHERE room_id = ? AND clue_id = ?`,
            )
            .all(room.id, clue.id)
        : [],
    }
  }

  startGame(room: RoomRecord): RoomRecord {
    if (this.rooms.listPlayers(room.id).length === 0) throw new Error('At least one player is required')
    const specials = room.settings.specials ?? []
    const clueIds = (
      this.database
        .prepare(
          `SELECT q.id
           FROM clues q
           JOIN categories c ON c.id = q.category_id
           WHERE c.pack_id = ? AND c.archived = 0 AND q.archived = 0 AND q.is_final = 0`,
        )
        .all(room.packId) as Array<{ id: string }>
    ).map(({ id }) => id)
    if (clueIds.length < specials.length) {
      throw new Error(`This pack needs at least ${specials.length} ordinary clues for the selected specials`)
    }
    for (let index = clueIds.length - 1; index > 0; index -= 1) {
      const swapIndex = randomInt(index + 1)
      ;[clueIds[index], clueIds[swapIndex]] = [clueIds[swapIndex]!, clueIds[index]!]
    }
    const specialAssignments = Object.fromEntries(
      specials.map((special, index) => [clueIds[index]!, special]),
    ) as Record<string, SpecialType>
    return this.transition(
      room,
      'BOARD',
      { startedAt: new Date().toISOString(), specialAssignments },
      'active',
    )
  }

  selectClue(room: RoomRecord, clueId: string): RoomRecord {
    if (room.state.usedClueIds.includes(clueId)) throw new Error('That clue has already been played')
    const clue = this.getClue(clueId)
    if (!clue || !this.clueBelongsToPack(clueId, room.packId)) throw new Error('Clue not found')
    if (clue.is_final) throw new Error('Use the Final Question control for that clue')
    const readyRoom = this.transition(room, 'CLUE_READY', { activeClueId: clueId }, 'active')
    return this.openAnswers(readyRoom)
  }

  startFinalRound(room: RoomRecord): RoomRecord {
    if (room.state.phase !== 'BOARD' && room.state.phase !== 'LEADERBOARD') {
      throw new Error('Return to the board or leaderboard before starting Final Question')
    }
    const completedClueId = room.state.phase === 'LEADERBOARD' ? room.state.activeClueId : undefined
    const finalClueId = this.finalQuestionId(room.packId)
    if (!finalClueId) throw new Error('This pack does not have a Final Question')
    this.rooms.setJoiningLocked(room.id, true)
    return this.transition(
      room,
      'FINAL_WAGER',
      {
        activeClueId: finalClueId,
        usedClueIds: completedClueId
          ? [...new Set([...room.state.usedClueIds, completedClueId])]
          : room.state.usedClueIds,
        finalRound: true,
        deadline: undefined,
        startedAt: undefined,
      },
      'active',
    )
  }

  submitFinalWager(room: RoomRecord, playerId: string, amount: number): void {
    if (room.state.phase !== 'FINAL_WAGER' || !room.state.activeClueId) {
      throw new Error('Final wagers are not open')
    }
    const player = this.rooms.getPlayer(playerId)
    if (!player || player.roomId !== room.id || player.kicked) throw new Error('Player not found')
    const score = this.rooms.scores(room.id).find((entry) => entry.playerId === playerId)?.score ?? 0
    const maximum = Math.max(0, score)
    if (!Number.isSafeInteger(amount) || amount < 0 || amount > maximum) {
      throw new Error(`Wager must be a whole number from 0 to ${maximum}`)
    }
    try {
      this.database
        .prepare(
          `INSERT INTO final_wagers (room_id, player_id, clue_id, amount)
           VALUES (?, ?, ?, ?)`,
        )
        .run(room.id, playerId, room.state.activeClueId, amount)
    } catch (error) {
      if (error instanceof Error && error.message.includes('UNIQUE constraint failed')) {
        throw new Error('Your final wager is already locked')
      }
      throw error
    }
    this.emitUpdate(room.id)
  }

  startFinalQuestion(room: RoomRecord): RoomRecord {
    if (room.state.phase !== 'FINAL_WAGER' || !room.state.activeClueId) {
      throw new Error('Final wagers are not open')
    }
    const playerCount = this.rooms.listPlayers(room.id).length
    const wagerCount = (
      this.database
        .prepare(
          `SELECT COUNT(*) AS count
           FROM final_wagers w
           JOIN players p ON p.id = w.player_id
           WHERE w.room_id = ? AND w.clue_id = ? AND p.kicked = 0`,
        )
        .get(room.id, room.state.activeClueId) as { count: number }
    ).count
    if (playerCount === 0 || wagerCount !== playerCount) {
      throw new Error('Every player must lock a wager before the final question')
    }
    const clue = this.getClue(room.state.activeClueId)
    if (!clue) throw new Error('Final clue not found')
    const timerSeconds = this.effectiveTimerSeconds(room, clue)
    const updated = this.transition(
      room,
      'FINAL_QUESTION',
      {
        deadline: new Date(Date.now() + timerSeconds * 1000).toISOString(),
        startedAt: new Date().toISOString(),
      },
      'active',
    )
    this.scheduleClose(updated, timerSeconds * 1000)
    return updated
  }

  openAnswers(room: RoomRecord): RoomRecord {
    const clue = room.state.activeClueId ? this.getClue(room.state.activeClueId) : undefined
    if (!clue) throw new Error('No clue is selected')
    const timerSeconds = this.effectiveTimerSeconds(room, clue)
    const roomAfter = this.transition(
      room,
      'ACCEPTING_ANSWERS',
      {
        deadline: new Date(Date.now() + timerSeconds * 1000).toISOString(),
        startedAt: new Date().toISOString(),
      },
      'active',
    )
    this.scheduleClose(roomAfter, timerSeconds * 1000)
    return roomAfter
  }

  submitAnswer(
    room: RoomRecord,
    playerId: string,
    answer: unknown,
  ): { submissionId: string; receivedAt: string } {
    if (
      (room.state.phase !== 'ACCEPTING_ANSWERS' && room.state.phase !== 'FINAL_QUESTION') ||
      !room.state.activeClueId
    ) {
      throw new Error('Answers are not open')
    }
    const player = this.rooms.getPlayer(playerId)
    if (!player || player.roomId !== room.id || player.kicked) throw new Error('Player not found')

    const clue = this.getClue(room.state.activeClueId)
    if (!clue) throw new Error('Clue not found')
    this.validateAnswer(clue, answer)
    const startedAt = room.state.startedAt ? Date.parse(room.state.startedAt) : Date.now()
    const elapsedMs = Math.max(0, Date.now() - startedAt)
    const submissionId = createId()

    try {
      this.database
        .prepare(
          `INSERT INTO submissions
           (id, room_id, player_id, clue_id, answer_json, elapsed_ms,
            clue_prompt, clue_type, category_title)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, (
             SELECT c.title FROM categories c WHERE c.id = ?
           ))`,
        )
        .run(
          submissionId,
          room.id,
          playerId,
          clue.id,
          JSON.stringify(answer),
          elapsedMs,
          clue.prompt,
          clue.type,
          clue.category_id,
        )
    } catch (error) {
      if (error instanceof Error && error.message.includes('submissions.room_id')) {
        throw new Error('You already answered this clue')
      }
      throw error
    }
    this.emitUpdate(room.id)
    return { submissionId, receivedAt: new Date().toISOString() }
  }

  closeAnswers(room: RoomRecord): RoomRecord {
    if (room.state.phase !== 'ACCEPTING_ANSWERS' && room.state.phase !== 'FINAL_QUESTION') {
      throw new Error('Answers are not open')
    }
    this.clearTimer(room.id)
    const updated = this.transition(room, 'ANSWERS_CLOSED', {}, 'active')
    this.evaluateClue(updated)
    return this.requireRoom(room.id)
  }

  reveal(room: RoomRecord): RoomRecord {
    return this.transition(room, 'REVEAL', { revealedAt: new Date().toISOString() }, 'active')
  }

  showLeaderboard(room: RoomRecord): RoomRecord {
    return this.transition(room, 'LEADERBOARD', {}, 'active')
  }

  returnToBoard(room: RoomRecord): RoomRecord {
    const activeClueId = room.state.activeClueId
    const usedClueIds = activeClueId
      ? [...new Set([...room.state.usedClueIds, activeClueId])]
      : room.state.usedClueIds
    return this.transition(
      room,
      'BOARD',
      { usedClueIds, activeClueId: undefined, deadline: undefined, startedAt: undefined },
      'active',
    )
  }

  goBack(room: RoomRecord): RoomRecord {
    if (!room.state.activeClueId) throw new Error('No clue is selected')
    this.clearTimer(room.id)
    this.clearClueAttempts(room, true)
    const updated = this.rooms.saveState(
      room.id,
      {
        ...room.state,
        phase: 'BOARD',
        activeClueId: undefined,
        deadline: undefined,
        startedAt: undefined,
        revealedAt: undefined,
        previousPhase: undefined,
        remainingMs: undefined,
        finalRound: false,
      },
      'active',
      room.stateVersion,
    )
    this.emitUpdate(room.id)
    return updated
  }

  resetClue(room: RoomRecord): RoomRecord {
    if (!room.state.activeClueId) throw new Error('No clue is selected')
    if (
      room.state.phase === 'FINAL_WAGER' ||
      (room.state.phase === 'PAUSED' && room.state.previousPhase === 'FINAL_WAGER')
    ) {
      throw new Error('Start the Final Question before resetting it')
    }
    const clue = this.getClue(room.state.activeClueId)
    if (!clue) throw new Error('Clue not found')
    this.clearTimer(room.id)
    this.clearClueAttempts(room, false)
    const timerSeconds = this.effectiveTimerSeconds(room, clue)
    const phase = room.state.finalRound ? 'FINAL_QUESTION' : 'ACCEPTING_ANSWERS'
    const updated = this.rooms.saveState(
      room.id,
      {
        ...room.state,
        phase,
        deadline: new Date(Date.now() + timerSeconds * 1000).toISOString(),
        startedAt: new Date().toISOString(),
        revealedAt: undefined,
        previousPhase: undefined,
        remainingMs: undefined,
      },
      'active',
      room.stateVersion,
    )
    this.scheduleClose(updated, timerSeconds * 1000)
    this.emitUpdate(room.id)
    return updated
  }

  skipClue(room: RoomRecord): RoomRecord {
    if (!room.state.activeClueId) throw new Error('No clue is selected')
    this.clearTimer(room.id)
    const awarded = this.database
      .prepare(
        `SELECT player_id AS playerId, COALESCE(points_awarded, 0) AS points
         FROM submissions WHERE room_id = ? AND clue_id = ? AND points_awarded != 0`,
      )
      .all(room.id, room.state.activeClueId) as Array<{ playerId: string; points: number }>
    this.database.transaction(() => {
      for (const score of awarded) {
        this.addScore(
          room.id,
          score.playerId,
          room.state.activeClueId,
          -score.points,
          'void',
          'Clue voided by host',
          'host',
        )
      }
      this.database
        .prepare(
          `UPDATE submissions SET points_awarded = 0,
           evaluation_json = json_object('voided', 1, 'special', ?)
           WHERE room_id = ? AND clue_id = ?`,
        )
        .run(this.activeSpecial(room) ?? null, room.id, room.state.activeClueId)
    })()
    if (room.state.finalRound) {
      const usedClueIds = [...new Set([...room.state.usedClueIds, room.state.activeClueId])]
      return this.transition(
        room,
        'FINISHED',
        { usedClueIds, activeClueId: undefined, deadline: undefined },
        'finished',
      )
    }
    const board = this.returnToBoard(room)
    return this.hasUnusedClues(board) || this.hasFinalQuestion(room.packId)
      ? board
      : this.finish(board)
  }

  pause(room: RoomRecord): RoomRecord {
    if (
      ![
        'ACCEPTING_ANSWERS',
        'CLUE_READY',
        'ANSWERS_CLOSED',
        'REVEAL',
        'LEADERBOARD',
        'BOARD',
        'FINAL_WAGER',
        'FINAL_QUESTION',
      ].includes(room.state.phase)
    ) {
      throw new Error('The game cannot be paused now')
    }
    this.clearTimer(room.id)
    const deadline = room.state.deadline ? Date.parse(room.state.deadline) : undefined
    return this.transition(
      room,
      'PAUSED',
      {
        previousPhase: room.state.phase,
        remainingMs: deadline ? Math.max(0, deadline - Date.now()) : undefined,
        deadline: undefined,
      },
      'paused',
    )
  }

  resume(room: RoomRecord): RoomRecord {
    if (room.state.phase !== 'PAUSED' || !room.state.previousPhase) {
      throw new Error('The game is not paused')
    }
    const target = room.state.previousPhase
    const remainingMs = room.state.remainingMs
    if (
      (target === 'ACCEPTING_ANSWERS' || target === 'FINAL_QUESTION') &&
      remainingMs !== undefined &&
      remainingMs <= 0
    ) {
      const closed = this.transition(
        room,
        'ANSWERS_CLOSED',
        {
          previousPhase: undefined,
          remainingMs: undefined,
          deadline: undefined,
        },
        'active',
      )
      this.evaluateClue(closed)
      return this.requireRoom(room.id)
    }
    const clue = room.state.activeClueId ? this.getClue(room.state.activeClueId) : undefined
    const durationMs = clue ? this.effectiveTimerSeconds(room, clue) * 1000 : room.settings.timerSeconds * 1000
    const elapsedBeforePause =
      (target === 'ACCEPTING_ANSWERS' || target === 'FINAL_QUESTION') &&
      remainingMs !== undefined
        ? Math.max(0, durationMs - remainingMs)
        : undefined
    const updated = this.transition(
      room,
      target,
      {
        previousPhase: undefined,
        remainingMs: undefined,
        deadline:
          (target === 'ACCEPTING_ANSWERS' || target === 'FINAL_QUESTION') && remainingMs
            ? new Date(Date.now() + remainingMs).toISOString()
            : undefined,
        startedAt:
          elapsedBeforePause !== undefined
            ? new Date(Date.now() - elapsedBeforePause).toISOString()
            : room.state.startedAt,
      },
      'active',
    )
    if ((target === 'ACCEPTING_ANSWERS' || target === 'FINAL_QUESTION') && remainingMs) {
      this.scheduleClose(updated, remainingMs)
    }
    return updated
  }

  finish(room: RoomRecord): RoomRecord {
    this.clearTimer(room.id)
    const finalClueId = room.state.finalRound ? room.state.activeClueId : undefined
    return this.transition(
      room,
      'FINISHED',
      finalClueId
        ? {
            usedClueIds: [...new Set([...room.state.usedClueIds, finalClueId])],
            activeClueId: undefined,
            deadline: undefined,
          }
        : {},
      'finished',
    )
  }

  endSession(room: RoomRecord): RoomRecord {
    this.clearTimer(room.id)
    if (room.status === 'finished' || room.status === 'abandoned') return room
    const updated = this.rooms.saveState(
      room.id,
      {
        ...room.state,
        phase: 'FINISHED',
        activeClueId: undefined,
        deadline: undefined,
        previousPhase: undefined,
        remainingMs: undefined,
      },
      'abandoned',
      room.stateVersion,
    )
    this.emitUpdate(room.id)
    return updated
  }

  adjustScore(
    room: RoomRecord,
    playerId: string,
    delta: number,
    reason: string,
  ): void {
    const player = this.rooms.getPlayer(playerId)
    if (!player || player.roomId !== room.id) throw new Error('Player not found')
    if (!Number.isSafeInteger(delta) || Math.abs(delta) > 100_000) throw new Error('Invalid score delta')
    if (!reason.trim()) throw new Error('A reason is required')
    this.addScore(room.id, playerId, room.state.activeClueId, delta, 'host_adjustment', reason, 'host')
    this.emitUpdate(room.id)
  }

  private transition(
    room: RoomRecord,
    phase: GamePhase,
    patch: Partial<RoomState>,
    status: RoomRecord['status'],
  ): RoomRecord {
    assertTransition(room.state.phase, phase)
    const state = { ...room.state, ...patch, phase }
    const updated = this.rooms.saveState(room.id, state, status, room.stateVersion)
    this.emitUpdate(room.id)
    return updated
  }

  private evaluateClue(room: RoomRecord): void {
    const clue = room.state.activeClueId ? this.getClue(room.state.activeClueId) : undefined
    if (!clue) throw new Error('No active clue')
    const config = JSON.parse(clue.config_json) as Record<string, unknown>
    const submissions = this.database
      .prepare('SELECT * FROM submissions WHERE room_id = ? AND clue_id = ? ORDER BY elapsed_ms')
      .all(room.id, clue.id) as SubmissionRow[]

    this.database.transaction(() => {
      if (room.state.finalRound) {
        this.evaluateFinalClue(room, clue, config, submissions)
      } else if (clue.type === 'price_slider') {
        this.evaluatePrice(room, clue, config, submissions)
      } else {
        this.evaluateMusic(room, clue, config, submissions)
      }
    })()
    this.emitUpdate(room.id)
  }

  private clearClueAttempts(room: RoomRecord, clearWagers: boolean): void {
    const clueId = room.state.activeClueId
    if (!clueId) return
    const appliedScores = this.database
      .prepare(
        `SELECT player_id AS playerId, SUM(delta) AS points
         FROM score_events
         WHERE room_id = ? AND clue_id = ? AND source IN ('music', 'price', 'void')
         GROUP BY player_id
         HAVING SUM(delta) != 0`,
      )
      .all(room.id, clueId) as Array<{ playerId: string; points: number }>
    this.database.transaction(() => {
      for (const score of appliedScores) {
        this.addScore(
          room.id,
          score.playerId,
          clueId,
          -score.points,
          'void',
          clearWagers ? 'Clue returned to board' : 'Clue reset',
          'host',
        )
      }
      this.database
        .prepare('DELETE FROM submissions WHERE room_id = ? AND clue_id = ?')
        .run(room.id, clueId)
      if (clearWagers) {
        this.database
          .prepare('DELETE FROM final_wagers WHERE room_id = ? AND clue_id = ?')
          .run(room.id, clueId)
      }
    })()
  }

  private evaluateFinalClue(
    room: RoomRecord,
    clue: ClueRow,
    config: Record<string, unknown>,
    submissions: SubmissionRow[],
  ): void {
        const wagers = this.database
          .prepare(
            `SELECT w.player_id, w.amount
             FROM final_wagers w
             JOIN players p ON p.id = w.player_id
             WHERE w.room_id = ? AND w.clue_id = ? AND p.kicked = 0`,
          )
          .all(room.id, clue.id) as FinalWagerRow[]
        const submissionsByPlayer = new Map(submissions.map((submission) => [submission.player_id, submission]))
        const winningPricePlayers = new Set<string>()

        if (clue.type === 'price_slider') {
          const target = Number(config.correctPrice)
          const eligible = submissions
            .map((submission) => ({
              playerId: submission.player_id,
              guess: Number(JSON.parse(submission.answer_json)),
            }))
            .filter(({ guess }) => Number.isFinite(guess) && guess <= target)
          const bestDistance = eligible.reduce(
            (best, { guess }) => Math.min(best, target - guess),
            Number.POSITIVE_INFINITY,
          )
          for (const answer of eligible) {
            if (target - answer.guess === bestDistance) winningPricePlayers.add(answer.playerId)
          }
        }

        const accepted =
          clue.type === 'price_slider'
            ? []
            : [
                ...(Array.isArray(config.acceptedAnswers)
                  ? config.acceptedAnswers.filter((answer): answer is string => typeof answer === 'string')
                  : []),
                ...(typeof config.correctAnswer === 'string' ? [config.correctAnswer] : []),
              ]

        for (const wager of wagers) {
          const submission = submissionsByPlayer.get(wager.player_id)
          const answer = submission ? (JSON.parse(submission.answer_json) as unknown) : null
          const match =
            clue.type === 'price_slider'
              ? { matched: winningPricePlayers.has(wager.player_id) }
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
            this.updateSubmission(submission.id, match.matched, undefined, delta, evaluation)
          } else {
            this.database
              .prepare(
                `INSERT INTO submissions
                 (id, room_id, player_id, clue_id, answer_json, elapsed_ms, correct,
                  points_awarded, evaluation_json, clue_prompt, clue_type, category_title)
                 VALUES (?, ?, ?, ?, 'null', ?, 0, ?, ?, ?, ?, (
                   SELECT title FROM categories WHERE id = ?
                 ))`,
              )
              .run(
                createId(),
                room.id,
                wager.player_id,
                clue.id,
                clue.timer_seconds * 1000,
                delta,
                JSON.stringify(evaluation),
                clue.prompt,
                clue.type,
                clue.category_id,
              )
          }
          if (delta !== 0) {
            this.addScore(
              room.id,
              wager.player_id,
              clue.id,
              delta,
              clue.type === 'price_slider' ? 'price' : 'music',
              match.matched ? 'Final wager won' : 'Final wager lost',
              'system',
            )
          }
        }
  }

  private evaluateMusic(
    room: RoomRecord,
    clue: ClueRow,
    config: Record<string, unknown>,
    submissions: SubmissionRow[],
  ): void {
    const accepted = Array.isArray(config.acceptedAnswers)
      ? config.acceptedAnswers.filter((answer): answer is string => typeof answer === 'string')
      : []
    if (typeof config.correctAnswer === 'string') accepted.push(config.correctAnswer)
    const maxDurationMs = this.effectiveTimerSeconds(room, clue) * 1000
    const special = this.activeSpecial(room)

    for (const submission of submissions) {
      const answer = JSON.parse(submission.answer_json) as unknown
      const match =
        typeof answer === 'string'
          ? matchFreeTextAnswer(answer, accepted)
          : { matched: false, normalizedSubmission: '' }
      const scoreInput = {
        playerId: submission.player_id,
        clueId: clue.id,
        boardValue: clue.board_value,
        correct: match.matched,
        openedAtMs: 0,
        deadlineMs: maxDurationMs,
        receivedAtMs: submission.elapsed_ms,
        normalizedAnswer: match.normalizedSubmission,
      }
      const score = scoreMusicAnswer(
        match.matchedAcceptedAnswer
          ? { ...scoreInput, matchedAcceptedAnswer: match.matchedAcceptedAnswer }
          : scoreInput,
      )
      const points = this.applySpecialPoints(special, score.totalPoints, clue.board_value)
      this.updateSubmission(submission.id, score.correct, undefined, points, {
        ...score,
        special,
        pointsBeforeSpecial: score.totalPoints,
      })
      if (points !== 0) {
        this.addScore(
          room.id,
          submission.player_id,
          clue.id,
          points,
          'music',
          this.specialScoreReason(special, score.correct),
          'system',
        )
      }
    }
    this.applyMissingDoubleOrNothingPenalties(room, clue, submissions, 'music')
  }

  private evaluatePrice(
    room: RoomRecord,
    clue: ClueRow,
    config: Record<string, unknown>,
    submissions: SubmissionRow[],
  ): void {
    const target = Number(config.correctPrice)
    if (!Number.isFinite(target)) throw new Error('Price clue has no valid target')
    const scored = scorePriceAnswers({
      clueId: clue.id,
      targetPrice: target,
      minimumPrice: Number(config.min ?? 0),
      boardValue: clue.board_value,
      answers: submissions.map((submission) => ({
        playerId: submission.player_id,
        guess: Number(JSON.parse(submission.answer_json)),
      })),
      settings: {
        rankMultipliers: room.settings.priceRankPercentages,
        roundTo: 1,
        tieTolerance: 0,
      },
    })
    const special = this.activeSpecial(room)

    for (const submission of submissions) {
      const result = scored.results.find((entry) => entry.playerId === submission.player_id)
      if (!result) throw new Error('Price score result is missing')
      const points = this.applySpecialPoints(special, result.points, clue.board_value)
      this.updateSubmission(
        submission.id,
        special === 'double_or_nothing' ? result.points > 0 : result.guess === target,
        result.rank ?? undefined,
        points,
        { ...result, special, pointsBeforeSpecial: result.points },
      )
      if (points !== 0) {
        this.addScore(
          room.id,
          submission.player_id,
          clue.id,
          points,
          'price',
          this.specialScoreReason(special, result.points > 0, `Price rank ${result.rank}`),
          'system',
        )
      }
    }
    this.applyMissingDoubleOrNothingPenalties(room, clue, submissions, 'price')
  }

  private activeSpecial(room: RoomRecord): SpecialType | undefined {
    return room.state.activeClueId
      ? room.state.specialAssignments?.[room.state.activeClueId]
      : undefined
  }

  private effectiveTimerSeconds(room: RoomRecord, clue: ClueRow): number {
    const timerSeconds = clue.timer_seconds || room.settings.timerSeconds
    return room.state.specialAssignments?.[clue.id] === 'speed_round'
      ? Math.max(5, Math.ceil(timerSeconds / 2))
      : timerSeconds
  }

  private applySpecialPoints(
    special: SpecialType | undefined,
    normalPoints: number,
    boardValue: number,
  ): number {
    if (special === 'double_points') return normalPoints > 0 ? normalPoints * 2 : 0
    if (special === 'double_or_nothing') return normalPoints > 0 ? normalPoints * 2 : -boardValue
    return normalPoints
  }

  private specialScoreReason(
    special: SpecialType | undefined,
    won: boolean,
    normalReason = 'Correct answer',
  ): string {
    if (special === 'double_points') return `Double Points: ${normalReason}`
    if (special === 'double_or_nothing') {
      return won ? `Double or Nothing won: ${normalReason}` : 'Double or Nothing lost'
    }
    return normalReason
  }

  private applyMissingDoubleOrNothingPenalties(
    room: RoomRecord,
    clue: ClueRow,
    submissions: SubmissionRow[],
    source: 'music' | 'price',
  ): void {
    if (this.activeSpecial(room) !== 'double_or_nothing') return
    const submittedPlayerIds = new Set(submissions.map(({ player_id }) => player_id))
    for (const player of this.rooms.listPlayers(room.id)) {
      if (submittedPlayerIds.has(player.id)) continue
      const evaluation = {
        special: 'double_or_nothing',
        answered: false,
        pointsBeforeSpecial: 0,
        points: -clue.board_value,
      }
      this.database
        .prepare(
          `INSERT INTO submissions
           (id, room_id, player_id, clue_id, answer_json, elapsed_ms, correct,
            points_awarded, evaluation_json, clue_prompt, clue_type, category_title)
           VALUES (?, ?, ?, ?, 'null', ?, 0, ?, ?, ?, ?, (
             SELECT title FROM categories WHERE id = ?
           ))`,
        )
        .run(
          createId(),
          room.id,
          player.id,
          clue.id,
          this.effectiveTimerSeconds(room, clue) * 1000,
          -clue.board_value,
          JSON.stringify(evaluation),
          clue.prompt,
          clue.type,
          clue.category_id,
        )
      this.addScore(
        room.id,
        player.id,
        clue.id,
        -clue.board_value,
        source,
        'Double or Nothing lost: no answer',
        'system',
      )
    }
  }

  private updateSubmission(
    id: string,
    correct: boolean,
    rank: number | undefined,
    points: number,
    evaluation: unknown,
  ): void {
    this.database
      .prepare(
        `UPDATE submissions SET correct = ?, rank = ?, points_awarded = ?, evaluation_json = ?
         WHERE id = ?`,
      )
      .run(correct ? 1 : 0, rank ?? null, points, JSON.stringify(evaluation), id)
  }

  private addScore(
    roomId: string,
    playerId: string,
    clueId: string | undefined,
    delta: number,
    source: string,
    reason: string,
    actor: string,
  ): void {
    this.database
      .prepare(
        `INSERT INTO score_events
         (id, room_id, player_id, clue_id, delta, source, reason, actor)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(createId(), roomId, playerId, clueId ?? null, delta, source, reason, actor)
  }

  private getClue(id: string): ClueRow | undefined {
    return this.database
      .prepare('SELECT * FROM clues WHERE id = ? AND archived = 0')
      .get(id) as
      | ClueRow
      | undefined
  }

  private clueBelongsToPack(clueId: string, packId: string): boolean {
    return Boolean(
      this.database
        .prepare(
          `SELECT q.id FROM clues q JOIN categories c ON c.id = q.category_id
           WHERE q.id = ? AND c.pack_id = ? AND q.archived = 0 AND c.archived = 0`,
        )
        .get(clueId, packId),
    )
  }

  private hasUnusedClues(room: RoomRecord): boolean {
    return this.unusedClueIds(room).length > 0
  }

  private unusedClueIds(room: RoomRecord): string[] {
    const clueIds = this.database
      .prepare(
        `SELECT q.id FROM clues q
         JOIN categories c ON c.id = q.category_id
         WHERE c.pack_id = ? AND q.archived = 0 AND c.archived = 0 AND q.is_final = 0`,
      )
      .all(room.packId) as Array<{ id: string }>
    const used = new Set(room.state.usedClueIds)
    return clueIds.map(({ id }) => id).filter((id) => !used.has(id))
  }

  private finalQuestionId(packId: string): string | undefined {
    return (
      this.database
        .prepare(
          `SELECT q.id FROM clues q
           JOIN categories c ON c.id = q.category_id
           WHERE c.pack_id = ? AND q.is_final = 1 AND q.archived = 0 AND c.archived = 0
           LIMIT 1`,
        )
        .get(packId) as { id: string } | undefined
    )?.id
  }

  private hasFinalQuestion(packId: string): boolean {
    return Boolean(this.finalQuestionId(packId))
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
    if (clue.type === 'price_slider') return config.correctPrice
    return config.correctAnswer ?? config.acceptedAnswers
  }

  private validateAnswer(clue: ClueRow, answer: unknown): void {
    if (clue.type === 'price_slider') {
      const config = JSON.parse(clue.config_json) as Record<string, unknown>
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
    this.clearTimer(room.id)
    this.timers.set(
      room.id,
      setTimeout(() => {
        const latest = this.rooms.getById(room.id)
        if (
          latest?.state.phase === 'ACCEPTING_ANSWERS' ||
          latest?.state.phase === 'FINAL_QUESTION'
        ) {
          this.closeAnswers(latest)
        }
      }, delayMs),
    )
  }

  private clearTimer(roomId: string): void {
    const timer = this.timers.get(roomId)
    if (timer) clearTimeout(timer)
    this.timers.delete(roomId)
  }

  private requireRoom(roomId: string): RoomRecord {
    const room = this.rooms.getById(roomId)
    if (!room) throw new Error('Room not found')
    return room
  }

  private emitUpdate(roomId: string): void {
    this.emit('roomUpdated', roomId)
  }
}
