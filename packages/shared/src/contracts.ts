import { z } from 'zod'
import { normalizeFreeTextAnswer } from './text.js'

const trimmedString = (min: number, max: number) => z.string().trim().min(min).max(max)

export const EntityIdSchema = trimmedString(1, 128)
export const StableKeySchema = z
  .string()
  .trim()
  .min(1)
  .max(64)
  .regex(/^[a-z0-9]+(?:[a-z0-9_-]*[a-z0-9])?$/i, 'Use letters, numbers, "_" or "-"')
export const RoomCodeSchema = z
  .string()
  .trim()
  .toUpperCase()
  .regex(/^[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{4,8}$/, 'Invalid room code')
export const RequestIdSchema = trimmedString(1, 128)
export const IsoDateTimeSchema = z.string().datetime({ offset: true })
export const EpochMillisecondsSchema = z.number().int().nonnegative().finite()

export const RelativeContentPathSchema = z
  .string()
  .trim()
  .min(1)
  .max(500)
  .refine((value) => !value.includes('\0'), 'Path cannot contain null bytes')
  .refine((value) => !/^(?:[a-z]:[\\/]|[\\/]{1,2})/i.test(value), 'Path must be relative')
  .refine(
    (value) => !value.split(/[\\/]+/u).some((segment) => segment === '..'),
    'Path cannot traverse outside the content root',
  )

export const ClueTypeSchema = z.enum([
  'MUSIC_MULTIPLE_CHOICE',
  'MUSIC_FREE_TEXT',
  'PRICE_SLIDER',
])
export type ClueType = z.infer<typeof ClueTypeSchema>

export const PackStatusSchema = z.enum(['DRAFT', 'READY', 'ARCHIVED'])
export type PackStatus = z.infer<typeof PackStatusSchema>

export const SpeedBonusCurveSchema = z.enum(['LINEAR', 'QUADRATIC', 'FLAT'])
export type SpeedBonusCurve = z.infer<typeof SpeedBonusCurveSchema>

export const SpeedBonusSettingsSchema = z
  .object({
    enabled: z.boolean().default(true),
    maxPoints: z.number().int().min(0).max(100_000).default(500),
    minPoints: z.number().int().min(0).max(100_000).default(0),
    curve: SpeedBonusCurveSchema.default('LINEAR'),
    roundTo: z.number().int().min(1).max(10_000).default(10),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.minPoints > value.maxPoints) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['minPoints'],
        message: 'minPoints cannot exceed maxPoints',
      })
    }
  })
export type SpeedBonusSettings = z.infer<typeof SpeedBonusSettingsSchema>

export const PriceScoringSettingsSchema = z
  .object({
    rankMultipliers: z
      .array(z.number().finite().min(0).max(1))
      .min(1)
      .max(20)
      .default([1, 0.75, 0.5, 0.25]),
    roundTo: z.number().int().min(1).max(10_000).default(10),
    tieTolerance: z.number().finite().min(0).max(1_000_000).default(0),
  })
  .strict()
  .superRefine((value, context) => {
    for (let index = 1; index < value.rankMultipliers.length; index += 1) {
      const previous = value.rankMultipliers[index - 1]
      const current = value.rankMultipliers[index]
      if (previous !== undefined && current !== undefined && current > previous) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['rankMultipliers', index],
          message: 'Rank multipliers must be in non-increasing order',
        })
      }
    }
  })
export type PriceScoringSettings = z.infer<typeof PriceScoringSettingsSchema>

export const BoardSettingsSchema = z
  .object({
    categoryOrder: z.array(EntityIdSchema).max(20).optional(),
    shuffleMultipleChoiceOptions: z.boolean().default(true),
  })
  .strict()
export type BoardSettings = z.infer<typeof BoardSettingsSchema>

const TeamNamesSchema = z
  .array(trimmedString(1, 30))
  .max(8)
  .superRefine((teams, context) => {
    if (teams.length === 1) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Team games require at least two teams',
      })
    }
    if (new Set(teams.map((team) => team.toLocaleLowerCase())).size !== teams.length) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Team names must be unique',
      })
    }
  })

export const GameSettingsSchema = z
  .object({
    answerDurationSeconds: z.number().int().min(5).max(300).default(30),
    countdownSeconds: z.number().int().min(0).max(15).default(3),
    maxPlayers: z.number().int().min(1).max(50).default(50),
    requireUniqueNicknames: z.boolean().default(true),
    musicBasePointsMultiplier: z.number().finite().min(0).max(10).default(1),
    speedBonus: SpeedBonusSettingsSchema.default({}),
    priceScoring: PriceScoringSettingsSchema.default({}),
    board: BoardSettingsSchema.default({}),
    teams: TeamNamesSchema.default([]),
  })
  .strict()
export type GameSettings = z.infer<typeof GameSettingsSchema>
export const DEFAULT_GAME_SETTINGS: GameSettings = GameSettingsSchema.parse({})

export const MusicMediaSchema = z
  .object({
    assetId: EntityIdSchema.optional(),
    path: RelativeContentPathSchema.optional(),
    title: trimmedString(1, 200).optional(),
    artist: trimmedString(1, 200).optional(),
    mimeType: trimmedString(1, 100).optional(),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.assetId === undefined && value.path === undefined) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Music media requires an assetId or relative path',
      })
    }
  })
export type MusicMedia = z.infer<typeof MusicMediaSchema>

export const ChoiceSchema = z
  .object({
    id: StableKeySchema,
    label: trimmedString(1, 200),
  })
  .strict()
export type Choice = z.infer<typeof ChoiceSchema>

const clueCommonShape = {
  id: EntityIdSchema,
  categoryId: EntityIdSchema,
  key: StableKeySchema,
  boardValue: z.number().int().positive().max(1_000_000),
  position: z.number().int().nonnegative().max(1000),
  prompt: trimmedString(1, 1000),
  context: trimmedString(1, 2000).optional(),
  imagePath: RelativeContentPathSchema.optional(),
  timerSeconds: z.number().int().min(5).max(300).optional(),
} as const

const manifestClueCommonShape = {
  key: StableKeySchema,
  boardValue: z.number().int().positive().max(1_000_000),
  position: z.number().int().nonnegative().max(1000),
  prompt: trimmedString(1, 1000),
  context: trimmedString(1, 2000).optional(),
  imagePath: RelativeContentPathSchema.optional(),
  timerSeconds: z.number().int().min(5).max(300).optional(),
} as const

const musicShape = {
  media: MusicMediaSchema,
  startOffsetSeconds: z.number().finite().min(0).max(86_400).default(0),
  playbackDurationSeconds: z.number().finite().min(1).max(300).default(30),
} as const

const multipleChoiceShape = {
  choices: z.array(ChoiceSchema).min(2).max(8),
  correctChoiceId: StableKeySchema,
} as const

const freeTextShape = {
  acceptedAnswers: z.array(trimmedString(1, 200)).min(1).max(30),
  displayAnswer: trimmedString(1, 200).optional(),
} as const

export const PriceSliderSchema = z
  .object({
    min: z.number().finite().min(0),
    max: z.number().finite().positive(),
    step: z.number().finite().positive(),
    prefix: z.string().max(20).default('$'),
    suffix: z.string().max(20).default(''),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.min >= value.max) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['min'],
        message: 'Slider minimum must be less than its maximum',
      })
    }
    if (value.step > value.max - value.min) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['step'],
        message: 'Slider step cannot exceed the slider range',
      })
    }
  })
export type PriceSlider = z.infer<typeof PriceSliderSchema>

const priceShape = {
  targetPrice: z.number().finite().min(0).max(1_000_000_000),
  slider: PriceSliderSchema,
} as const

const MusicMultipleChoiceClueObjectSchema = z
  .object({
    ...clueCommonShape,
    type: z.literal('MUSIC_MULTIPLE_CHOICE'),
    ...musicShape,
    ...multipleChoiceShape,
  })
  .strict()

const MusicFreeTextClueObjectSchema = z
  .object({
    ...clueCommonShape,
    type: z.literal('MUSIC_FREE_TEXT'),
    ...musicShape,
    ...freeTextShape,
  })
  .strict()

const PriceClueObjectSchema = z
  .object({
    ...clueCommonShape,
    type: z.literal('PRICE_SLIDER'),
    ...priceShape,
  })
  .strict()

const ManifestMusicMultipleChoiceClueObjectSchema = z
  .object({
    ...manifestClueCommonShape,
    type: z.literal('MUSIC_MULTIPLE_CHOICE'),
    ...musicShape,
    ...multipleChoiceShape,
  })
  .strict()

const ManifestMusicFreeTextClueObjectSchema = z
  .object({
    ...manifestClueCommonShape,
    type: z.literal('MUSIC_FREE_TEXT'),
    ...musicShape,
    ...freeTextShape,
  })
  .strict()

const ManifestPriceClueObjectSchema = z
  .object({
    ...manifestClueCommonShape,
    type: z.literal('PRICE_SLIDER'),
    ...priceShape,
  })
  .strict()

function validateClueDetails(
  clue:
    | z.infer<typeof MusicMultipleChoiceClueObjectSchema>
    | z.infer<typeof MusicFreeTextClueObjectSchema>
    | z.infer<typeof PriceClueObjectSchema>
    | z.infer<typeof ManifestMusicMultipleChoiceClueObjectSchema>
    | z.infer<typeof ManifestMusicFreeTextClueObjectSchema>
    | z.infer<typeof ManifestPriceClueObjectSchema>,
  context: z.RefinementCtx,
): void {
  if (clue.type === 'MUSIC_MULTIPLE_CHOICE') {
    const choiceIds = new Set<string>()
    const normalizedLabels = new Set<string>()
    for (let index = 0; index < clue.choices.length; index += 1) {
      const choice = clue.choices[index]
      if (choice === undefined) continue
      if (choiceIds.has(choice.id)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['choices', index, 'id'],
          message: 'Choice IDs must be unique',
        })
      }
      choiceIds.add(choice.id)
      const normalizedLabel = choice.label.trim().toLowerCase().replace(/\s+/gu, ' ')
      if (normalizedLabels.has(normalizedLabel)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['choices', index, 'label'],
          message: 'Choice labels must be unique',
        })
      }
      normalizedLabels.add(normalizedLabel)
    }
    if (!choiceIds.has(clue.correctChoiceId)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['correctChoiceId'],
        message: 'correctChoiceId must reference a choice',
      })
    }
  }

  if (clue.type === 'MUSIC_FREE_TEXT') {
    const normalizedAnswers = new Set<string>()
    for (let index = 0; index < clue.acceptedAnswers.length; index += 1) {
      const answer = clue.acceptedAnswers[index]
      if (answer === undefined) continue
      const normalized = normalizeFreeTextAnswer(answer)
      if (normalized.length === 0) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['acceptedAnswers', index],
          message: 'Accepted answers must contain letters or numbers after normalization',
        })
      } else if (normalizedAnswers.has(normalized)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['acceptedAnswers', index],
          message: 'Accepted answers must be unique after normalization',
        })
      }
      normalizedAnswers.add(normalized)
    }
  }

  if (
    clue.type === 'PRICE_SLIDER' &&
    (clue.targetPrice < clue.slider.min || clue.targetPrice > clue.slider.max)
  ) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['targetPrice'],
      message: 'Target price must be within the slider bounds',
    })
  }
}

export const ClueSchema = z
  .discriminatedUnion('type', [
    MusicMultipleChoiceClueObjectSchema,
    MusicFreeTextClueObjectSchema,
    PriceClueObjectSchema,
  ])
  .superRefine(validateClueDetails)
export type Clue = z.infer<typeof ClueSchema>
export type MusicMultipleChoiceClue = Extract<Clue, { type: 'MUSIC_MULTIPLE_CHOICE' }>
export type MusicFreeTextClue = Extract<Clue, { type: 'MUSIC_FREE_TEXT' }>
export type PriceClue = Extract<Clue, { type: 'PRICE_SLIDER' }>

export const ManifestClueSchema = z
  .discriminatedUnion('type', [
    ManifestMusicMultipleChoiceClueObjectSchema,
    ManifestMusicFreeTextClueObjectSchema,
    ManifestPriceClueObjectSchema,
  ])
  .superRefine(validateClueDetails)
export type ManifestClue = z.infer<typeof ManifestClueSchema>

export const CategorySchema = z
  .object({
    id: EntityIdSchema,
    packId: EntityIdSchema,
    key: StableKeySchema,
    title: trimmedString(1, 100),
    position: z.number().int().nonnegative().max(1000),
    clues: z.array(ClueSchema).max(20),
  })
  .strict()
  .superRefine((category, context) => {
    validateUniqueKeysAndPositions(category.clues, context, ['clues'])
    category.clues.forEach((clue, index) => {
      if (clue.categoryId !== category.id) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['clues', index, 'categoryId'],
          message: 'Clue categoryId must match its containing category',
        })
      }
    })
  })
export type Category = z.infer<typeof CategorySchema>

export const ManifestCategorySchema = z
  .object({
    key: StableKeySchema,
    title: trimmedString(1, 100),
    position: z.number().int().nonnegative().max(1000),
    clues: z.array(ManifestClueSchema).min(1).max(20),
  })
  .strict()
  .superRefine((category, context) => {
    validateUniqueKeysAndPositions(category.clues, context, ['clues'])
  })
export type ManifestCategory = z.infer<typeof ManifestCategorySchema>

function validateUniqueKeysAndPositions(
  entries: ReadonlyArray<{ key: string; position: number }>,
  context: z.RefinementCtx,
  pathPrefix: Array<string | number>,
): void {
  const keys = new Set<string>()
  const positions = new Set<number>()
  entries.forEach((entry, index) => {
    const key = entry.key.toLowerCase()
    if (keys.has(key)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: [...pathPrefix, index, 'key'],
        message: 'Keys must be unique',
      })
    }
    keys.add(key)
    if (positions.has(entry.position)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: [...pathPrefix, index, 'position'],
        message: 'Positions must be unique',
      })
    }
    positions.add(entry.position)
  })
}

export const PackSchema = z
  .object({
    id: EntityIdSchema,
    key: StableKeySchema,
    title: trimmedString(1, 150),
    description: z.string().trim().max(2000).default(''),
    status: PackStatusSchema.default('DRAFT'),
    defaultSettings: GameSettingsSchema.default({}),
    categories: z.array(CategorySchema).max(12),
    createdAt: IsoDateTimeSchema,
    updatedAt: IsoDateTimeSchema,
  })
  .strict()
  .superRefine((pack, context) => {
    validateUniqueKeysAndPositions(pack.categories, context, ['categories'])
    pack.categories.forEach((category, index) => {
      if (category.packId !== pack.id) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['categories', index, 'packId'],
          message: 'Category packId must match its containing pack',
        })
      }
    })
  })
export type Pack = z.infer<typeof PackSchema>

export const PackManifestSchema = z
  .object({
    schemaVersion: z.literal(1),
    pack: z
      .object({
        key: StableKeySchema,
        title: trimmedString(1, 150),
        description: z.string().trim().max(2000).default(''),
        defaultSettings: GameSettingsSchema.default({}),
        categories: z.array(ManifestCategorySchema).min(1).max(12),
      })
      .strict()
      .superRefine((pack, context) => {
        validateUniqueKeysAndPositions(pack.categories, context, ['categories'])
      }),
  })
  .strict()
export type PackManifest = z.infer<typeof PackManifestSchema>

export const GamePhaseSchema = z.enum([
  'LOBBY',
  'BOARD',
  'CLUE_READY',
  'ACCEPTING_ANSWERS',
  'ANSWERS_CLOSED',
  'REVEAL',
  'LEADERBOARD',
  'FINAL_WAGER',
  'FINAL_QUESTION',
  'FINISHED',
  'PAUSED',
])
export type GamePhase = z.infer<typeof GamePhaseSchema>

export const PlayerPublicSnapshotSchema = z
  .object({
    id: EntityIdSchema,
    nickname: trimmedString(1, 40),
    score: z.number().int().safe(),
    connected: z.boolean(),
    hasSubmitted: z.boolean(),
    joinedAt: IsoDateTimeSchema,
  })
  .strict()
export type PlayerPublicSnapshot = z.infer<typeof PlayerPublicSnapshotSchema>

export const BoardClueSnapshotSchema = z
  .object({
    id: EntityIdSchema,
    type: ClueTypeSchema,
    boardValue: z.number().int().positive(),
    position: z.number().int().nonnegative(),
    used: z.boolean(),
    voided: z.boolean().default(false),
  })
  .strict()
export type BoardClueSnapshot = z.infer<typeof BoardClueSnapshotSchema>

export const BoardCategorySnapshotSchema = z
  .object({
    id: EntityIdSchema,
    title: trimmedString(1, 100),
    position: z.number().int().nonnegative(),
    clues: z.array(BoardClueSnapshotSchema).max(20),
  })
  .strict()
export type BoardCategorySnapshot = z.infer<typeof BoardCategorySnapshotSchema>

const activeClueCommonShape = {
  id: EntityIdSchema,
  categoryId: EntityIdSchema,
  boardValue: z.number().int().positive(),
  prompt: trimmedString(1, 1000),
  context: trimmedString(1, 2000).optional(),
  imageUrl: z.string().url().optional(),
  timerSeconds: z.number().int().min(5).max(300),
  openedAtMs: EpochMillisecondsSchema.nullable(),
  deadlineMs: EpochMillisecondsSchema.nullable(),
  revealGif: z
    .object({
      provider: z.enum(['giphy', 'tenor', 'url']),
      url: z.string().url(),
      previewUrl: z.string().url(),
      alt: z.string().max(300),
      sourceUrl: z.string().url(),
    })
    .strict()
    .optional(),
} as const

export const ActivePublicClueSchema = z.discriminatedUnion('type', [
  z
    .object({
      ...activeClueCommonShape,
      type: z.literal('MUSIC_MULTIPLE_CHOICE'),
      choices: z.array(ChoiceSchema).min(2).max(8),
      mediaUrl: z.string().url(),
      revealMediaUrl: z.string().url().optional(),
      startOffsetSeconds: z.number().finite().nonnegative(),
      playbackDurationSeconds: z.number().finite().positive(),
    })
    .strict(),
  z
    .object({
      ...activeClueCommonShape,
      type: z.literal('MUSIC_FREE_TEXT'),
      mediaUrl: z.string().url(),
      revealMediaUrl: z.string().url().optional(),
      startOffsetSeconds: z.number().finite().nonnegative(),
      playbackDurationSeconds: z.number().finite().positive(),
    })
    .strict(),
  z
    .object({
      ...activeClueCommonShape,
      type: z.literal('PRICE_SLIDER'),
      slider: PriceSliderSchema,
      revealMediaUrl: z.string().url().optional(),
    })
    .strict(),
])
export type ActivePublicClue = z.infer<typeof ActivePublicClueSchema>

export const LeaderboardEntrySchema = z
  .object({
    playerId: EntityIdSchema,
    nickname: trimmedString(1, 40),
    score: z.number().int().safe(),
    rank: z.number().int().positive(),
  })
  .strict()
export type LeaderboardEntry = z.infer<typeof LeaderboardEntrySchema>

export const RoomPublicSnapshotSchema = z
  .object({
    roomCode: RoomCodeSchema,
    phase: GamePhaseSchema,
    pausedFromPhase: GamePhaseSchema.exclude(['PAUSED']).nullable(),
    stateVersion: z.number().int().nonnegative(),
    serverTimeMs: EpochMillisecondsSchema,
    locked: z.boolean(),
    pack: z
      .object({
        id: EntityIdSchema,
        title: trimmedString(1, 150),
      })
      .strict(),
    settings: GameSettingsSchema,
    players: z.array(PlayerPublicSnapshotSchema).max(50),
    board: z.array(BoardCategorySnapshotSchema).max(12),
    activeClue: ActivePublicClueSchema.nullable(),
    leaderboard: z.array(LeaderboardEntrySchema).max(50),
  })
  .strict()
  .superRefine((snapshot, context) => {
    if (snapshot.phase === 'PAUSED' && snapshot.pausedFromPhase === null) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['pausedFromPhase'],
        message: 'Paused snapshots must identify the phase being paused',
      })
    }
    if (snapshot.phase !== 'PAUSED' && snapshot.pausedFromPhase !== null) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['pausedFromPhase'],
        message: 'pausedFromPhase is only valid while paused',
      })
    }
  })
export type RoomPublicSnapshot = z.infer<typeof RoomPublicSnapshotSchema>

export const MultipleChoiceAnswerSchema = z
  .object({
    clueId: EntityIdSchema,
    type: z.literal('MUSIC_MULTIPLE_CHOICE'),
    choiceId: StableKeySchema,
  })
  .strict()
export const FreeTextAnswerSchema = z
  .object({
    clueId: EntityIdSchema,
    type: z.literal('MUSIC_FREE_TEXT'),
    text: z.string().trim().min(1).max(200),
  })
  .strict()
export const PriceAnswerSchema = z
  .object({
    clueId: EntityIdSchema,
    type: z.literal('PRICE_SLIDER'),
    guess: z.number().finite().min(0).max(1_000_000_000),
  })
  .strict()
export const AnswerPayloadSchema = z.discriminatedUnion('type', [
  MultipleChoiceAnswerSchema,
  FreeTextAnswerSchema,
  PriceAnswerSchema,
])
export type AnswerPayload = z.infer<typeof AnswerPayloadSchema>

export const AnswerRejectionCodeSchema = z.enum([
  'NOT_AUTHENTICATED',
  'WRONG_PHASE',
  'STALE_STATE',
  'CLUE_MISMATCH',
  'ANSWERS_CLOSED',
  'DUPLICATE',
  'INVALID_ANSWER',
  'PLAYER_REMOVED',
  'RATE_LIMITED',
])
export type AnswerRejectionCode = z.infer<typeof AnswerRejectionCodeSchema>

export const AnswerAcknowledgementSchema = z
  .object({
    requestId: RequestIdSchema,
    accepted: z.boolean(),
    status: z.enum(['ACCEPTED', 'DUPLICATE', 'REJECTED']),
    receivedAtMs: EpochMillisecondsSchema.optional(),
    code: AnswerRejectionCodeSchema.optional(),
    message: z.string().max(300).optional(),
  })
  .strict()
  .superRefine((acknowledgement, context) => {
    if (acknowledgement.accepted !== (acknowledgement.status === 'ACCEPTED')) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['accepted'],
        message: 'accepted must agree with status',
      })
    }
    if (acknowledgement.status === 'REJECTED' && acknowledgement.code === undefined) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['code'],
        message: 'Rejected answers require a rejection code',
      })
    }
  })
export type AnswerAcknowledgement = z.infer<typeof AnswerAcknowledgementSchema>

export const MusicScoreResultSchema = z
  .object({
    kind: z.literal('MUSIC'),
    playerId: EntityIdSchema,
    clueId: EntityIdSchema,
    correct: z.boolean(),
    onTime: z.boolean(),
    responseTimeMs: z.number().int().nonnegative(),
    basePoints: z.number().int().nonnegative(),
    speedBonusPoints: z.number().int().nonnegative(),
    totalPoints: z.number().int().nonnegative(),
    normalizedAnswer: z.string().optional(),
    matchedAcceptedAnswer: z.string().optional(),
  })
  .strict()
export type MusicScoreResult = z.infer<typeof MusicScoreResultSchema>

export const PriceScoreEntrySchema = z
  .object({
    playerId: EntityIdSchema,
    guess: z.number().finite().nonnegative(),
    overbid: z.boolean(),
    distanceFromTarget: z.number().finite().nonnegative(),
    rank: z.number().int().positive().nullable(),
    multiplier: z.number().finite().min(0).max(1),
    points: z.number().int().nonnegative(),
  })
  .strict()
export type PriceScoreEntry = z.infer<typeof PriceScoreEntrySchema>

export const PriceScoreResultSchema = z
  .object({
    kind: z.literal('PRICE'),
    clueId: EntityIdSchema,
    targetPrice: z.number().finite().nonnegative(),
    boardValue: z.number().int().positive(),
    results: z.array(PriceScoreEntrySchema).max(50),
  })
  .strict()
export type PriceScoreResult = z.infer<typeof PriceScoreResultSchema>

export const ScoringResultSchema = z.discriminatedUnion('kind', [
  MusicScoreResultSchema,
  PriceScoreResultSchema,
])
export type ScoringResult = z.infer<typeof ScoringResultSchema>

export const HostSubmissionSnapshotSchema = z
  .object({
    playerId: EntityIdSchema,
    answer: AnswerPayloadSchema,
    receivedAtMs: EpochMillisecondsSchema,
    score: ScoringResultSchema.optional(),
  })
  .strict()
export type HostSubmissionSnapshot = z.infer<typeof HostSubmissionSnapshotSchema>

export const HostRoomSnapshotSchema = z
  .object({
    publicSnapshot: RoomPublicSnapshotSchema,
    activeClueWithAnswer: ClueSchema.nullable(),
    submissions: z.array(HostSubmissionSnapshotSchema).max(50),
  })
  .strict()
export type HostRoomSnapshot = z.infer<typeof HostRoomSnapshotSchema>
