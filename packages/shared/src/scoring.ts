import {
  EntityIdSchema,
  MusicScoreResultSchema,
  PriceScoreResultSchema,
  PriceScoringSettingsSchema,
  type MusicScoreResult,
  type PriceScoreResult,
  type PriceScoringSettings,
} from './contracts.js'
import { z } from 'zod'
export {
  isFreeTextAnswerMatch,
  matchFreeTextAnswer,
  normalizeFreeTextAnswer,
} from './text.js'
export type { FreeTextMatchResult } from './text.js'

export interface MusicScoreInput {
  readonly playerId: string
  readonly clueId: string
  readonly boardValue: number
  readonly correct: boolean
  readonly openedAtMs: number
  readonly deadlineMs: number
  readonly receivedAtMs: number
  readonly normalizedAnswer?: string
  readonly matchedAcceptedAnswer?: string
}

function roundPoints(points: number, increment: number): number {
  return Math.max(0, Math.round(points / increment) * increment)
}

export function scoreMusicAnswer(input: MusicScoreInput): MusicScoreResult {
  const playerId = EntityIdSchema.parse(input.playerId)
  const clueId = EntityIdSchema.parse(input.clueId)
  if (!Number.isInteger(input.boardValue) || input.boardValue <= 0) {
    throw new RangeError('boardValue must be a positive integer')
  }
  if (
    !Number.isFinite(input.openedAtMs) ||
    !Number.isFinite(input.deadlineMs) ||
    !Number.isFinite(input.receivedAtMs) ||
    input.deadlineMs <= input.openedAtMs
  ) {
    throw new RangeError('Music scoring requires a valid answer window and receive time')
  }

  const responseTimeMs = Math.max(0, Math.round(input.receivedAtMs - input.openedAtMs))
  const onTime = input.receivedAtMs <= input.deadlineMs
  const awardedCorrect = input.correct && onTime
  const duration = input.deadlineMs - input.openedAtMs
  const elapsed = Math.min(Math.max(input.receivedAtMs - input.openedAtMs, 0), duration)
  const remainingRatio = 1 - elapsed / duration
  const basePoints = awardedCorrect ? roundPoints(input.boardValue * remainingRatio, 1) : 0
  const speedBonusPoints = 0

  const result: MusicScoreResult = {
    kind: 'MUSIC',
    playerId,
    clueId,
    correct: awardedCorrect,
    onTime,
    responseTimeMs,
    basePoints,
    speedBonusPoints,
    totalPoints: basePoints,
  }
  if (input.normalizedAnswer !== undefined) {
    result.normalizedAnswer = input.normalizedAnswer
  }
  if (input.matchedAcceptedAnswer !== undefined) {
    result.matchedAcceptedAnswer = input.matchedAcceptedAnswer
  }
  return MusicScoreResultSchema.parse(result)
}

export const PriceAnswerForScoringSchema = z
  .object({
    playerId: EntityIdSchema,
    guess: z.number().finite().nonnegative(),
  })
  .strict()
export type PriceAnswerForScoring = z.infer<typeof PriceAnswerForScoringSchema>

export interface PriceScoreInput {
  readonly clueId: string
  readonly targetPrice: number
  readonly minimumPrice?: number
  readonly boardValue: number
  readonly answers: readonly PriceAnswerForScoring[]
  readonly settings?: PriceScoringSettings
}

interface RankedAnswer {
  readonly playerId: string
  readonly guess: number
  readonly distanceFromTarget: number
}

function comparePlayerIds(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0
}

export function scorePriceAnswers(input: PriceScoreInput): PriceScoreResult {
  const clueId = EntityIdSchema.parse(input.clueId)
  if (!Number.isFinite(input.targetPrice) || input.targetPrice < 0) {
    throw new RangeError('targetPrice must be a non-negative finite number')
  }
  const minimumPrice = input.minimumPrice ?? 0
  if (
    !Number.isFinite(minimumPrice) ||
    minimumPrice < 0 ||
    minimumPrice > input.targetPrice
  ) {
    throw new RangeError('minimumPrice must be between zero and targetPrice')
  }
  if (!Number.isInteger(input.boardValue) || input.boardValue <= 0) {
    throw new RangeError('boardValue must be a positive integer')
  }
  if (input.answers.length > 20) {
    throw new RangeError('At most 20 price answers can be scored')
  }

  const settings = PriceScoringSettingsSchema.parse(input.settings ?? {})
  const seenPlayerIds = new Set<string>()
  const eligible: RankedAnswer[] = []
  const overbids: RankedAnswer[] = []

  for (const rawAnswer of input.answers) {
    const answer = PriceAnswerForScoringSchema.parse(rawAnswer)
    if (seenPlayerIds.has(answer.playerId)) {
      throw new Error(`Duplicate price answer for player ${answer.playerId}`)
    }
    seenPlayerIds.add(answer.playerId)
    const rankedAnswer = {
      ...answer,
      distanceFromTarget: Math.abs(input.targetPrice - answer.guess),
    }
    if (answer.guess > input.targetPrice) {
      overbids.push(rankedAnswer)
    } else {
      eligible.push(rankedAnswer)
    }
  }

  eligible.sort(
    (left, right) =>
      left.distanceFromTarget - right.distanceFromTarget ||
      comparePlayerIds(left.playerId, right.playerId),
  )
  overbids.sort(
    (left, right) => left.guess - right.guess || comparePlayerIds(left.playerId, right.playerId),
  )

  let currentRank = 0
  let currentTieDistance: number | undefined
  const rankedResults = eligible.map((answer, index) => {
    if (
      currentTieDistance === undefined ||
      Math.abs(answer.distanceFromTarget - currentTieDistance) > settings.tieTolerance
    ) {
      currentRank = index + 1
      currentTieDistance = answer.distanceFromTarget
    }
    const scoringRange = input.targetPrice - minimumPrice
    const multiplier =
      scoringRange === 0
        ? answer.distanceFromTarget === 0
          ? 1
          : 0
        : Math.max(0, Math.min(1, 1 - answer.distanceFromTarget / scoringRange))
    return {
      playerId: answer.playerId,
      guess: answer.guess,
      overbid: false,
      distanceFromTarget: answer.distanceFromTarget,
      rank: currentRank,
      multiplier,
      points: roundPoints(input.boardValue * multiplier, settings.roundTo),
    }
  })

  const overbidResults = overbids.map((answer) => ({
    playerId: answer.playerId,
    guess: answer.guess,
    overbid: true,
    distanceFromTarget: answer.distanceFromTarget,
    rank: null,
    multiplier: 0,
    points: 0,
  }))

  return PriceScoreResultSchema.parse({
    kind: 'PRICE',
    clueId,
    targetPrice: input.targetPrice,
    boardValue: input.boardValue,
    results: [...rankedResults, ...overbidResults],
  })
}
