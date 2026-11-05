import type { PackInput, PackStore, PackSummary } from '../domain.js'
import { domainFrom, type DomainSource } from '../sqliteStore.js'
import { createId } from '../ids.js'
import { isRevealGif } from '../gifs.js'
export type { PackSummary } from '../domain.js'

export class PackRepository {
  private readonly store: PackStore
  constructor(source: DomainSource | PackStore) { this.store = 'replace' in source ? source : domainFrom(source).packs }
  async list(includeArchived = false) { return (await this.store.list(includeArchived)).items }
  get(id: string) { return this.store.get(id) }
  create(input: { title: string; description?: string }) { return this.store.create(input, createId()) }
  async replace(id: string, input: PackInput, importOwner?: { kind: 'operation'; id: string }) {
    validatePack(input)
    const current = await this.store.get(id)
    return current ? this.store.replace(id, input, current.revision, createId(), importOwner) : undefined
  }
  archive(id: string) { return this.store.archive(id) }
  remove(id: string) { return this.store.remove(id, createId()) }
}

export function validatePack(input: {
  title: string
  status?: PackSummary['status']
  categories: Array<{
    title: string
    clues: Array<{
      type: string
      boardValue: number
      prompt: string
      timerSeconds?: number
      mediaAssetId?: string | null
      revealMediaAssetId?: string | null
      finalQuestion?: boolean
      config: unknown
    }>
  }>
}): void {
  if (!input.title.trim())
    throw new Error('Pack title is required')
  if (input.categories.length > 12)
    throw new Error('A pack can contain at most 12 categories')
  if (input.status === 'ready' && input.categories.length === 0) {
    throw new Error('A ready pack must contain at least one category')
  }
  const finalQuestionCount = input.categories
    .flatMap((category) => category.clues)
    .filter((clue) => clue.finalQuestion).length
  if (finalQuestionCount > 1)
    throw new Error('A pack can contain only one Final Question')
  for (const category of input.categories) {
    if (!category.title.trim())
      throw new Error('Every category needs a title')
    if (category.clues.length > 20)
      throw new Error('A category can contain at most 20 clues')
    for (const clue of category.clues) {
      if (!['music_multiple_choice', 'music_free_text', 'price_slider'].includes(clue.type)) {
        throw new Error('Unsupported clue type')
      }
      if (!clue.prompt.trim())
        throw new Error('Every clue needs a prompt')
      if (!Number.isSafeInteger(clue.boardValue) || clue.boardValue <= 0) {
        throw new Error('Clue values must be positive integers')
      }
      if (clue.timerSeconds !== undefined &&
        (!Number.isInteger(clue.timerSeconds) ||
          clue.timerSeconds < 5 ||
          clue.timerSeconds > 300)) {
        throw new Error('Clue timers must be between 5 and 300 seconds')
      }
      const config = clue.config && typeof clue.config === 'object'
        ? (clue.config as Record<string, unknown>)
        : {}
      for (const key of ['mediaPlayback', 'revealMediaPlayback']) {
        const playback = config[key]
        if (playback === undefined) continue
        if (!playback || typeof playback !== 'object' || Array.isArray(playback)) {
          throw new Error('Song playback settings are invalid')
        }
        const { delaySeconds, playCount } = playback as Record<string, unknown>
        if (typeof delaySeconds !== 'number' || !Number.isInteger(delaySeconds) || delaySeconds < 0 || delaySeconds > 300) {
          throw new Error('Song delay must be a whole number between 0 and 300 seconds')
        }
        if (typeof playCount !== 'number' || !Number.isInteger(playCount) || playCount < 0 || playCount > 100) {
          throw new Error('Song play count must be a whole number between 0 and 100 (0 loops)')
        }
      }
      if (config.revealGif !== undefined && !isRevealGif(config.revealGif)) {
        throw new Error('The answer reveal GIF is invalid')
      }
      if (config.questionGif !== undefined &&
        (!isRevealGif(config.questionGif) || config.questionGif.provider !== 'url')) {
        throw new Error('The question GIF must be a secure direct GIF link')
      }
      if (clue.type.startsWith('music_')) {
        if (input.status === 'ready' && !clue.mediaAssetId) {
          throw new Error('Every music clue in a ready pack needs an uploaded song')
        }
        if (clue.type === 'music_multiple_choice') {
          const choices = Array.isArray(config.choices)
            ? config.choices.filter((choice): choice is string => typeof choice === 'string' && Boolean(choice.trim()))
            : []
          const choiceCount = Array.isArray(config.choices) ? config.choices.length : 0
          if (choices.length < 2 || choices.length !== choiceCount) {
            throw new Error('Multiple-choice clues need at least two choices')
          }
          const correctAnswer = typeof config.correctAnswer === 'string' ? config.correctAnswer : ''
          if (correctAnswer &&
            !choices.some((choice) => choice.trim().toLocaleLowerCase() ===
              correctAnswer.trim().toLocaleLowerCase())) {
            throw new Error('The correct answer must be one of the choices')
          }
        }
        if (typeof config.correctAnswer !== 'string' ||
          !config.correctAnswer.trim()) {
          throw new Error('Every music clue needs a correct answer')
        }
      }
      else {
        const correctPrice = Number(config.correctPrice)
        const min = Number(config.min)
        const max = Number(config.max)
        if (!Number.isFinite(correctPrice) ||
          !Number.isFinite(min) ||
          !Number.isFinite(max) ||
          min >= max ||
          correctPrice < min ||
          correctPrice > max) {
          throw new Error('Price clues need valid bounds and a target inside the range')
        }
      }
    }
  }
}
