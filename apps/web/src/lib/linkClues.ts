import type { ServerClueConfig } from './apiClient'

export function completeLinkPlaylist(sources: readonly (string | null)[] | undefined): string[] | undefined {
  if (!sources || sources.length !== 4 || !sources.every((source): source is string => Boolean(source?.trim())) ||
    new Set(sources).size !== 4) return undefined
  return [...sources] as string[]
}

export function validLinkConfig(link: ServerClueConfig['link']): boolean {
  return !link || Boolean(completeLinkPlaylist(link.mediaAssetIds) &&
    Number.isInteger(link.hintDelaySeconds) && link.hintDelaySeconds >= 0 && link.hintDelaySeconds <= 300)
}

export function replaceClueMedia<T extends {
  mediaAssetId: string | null
  revealMediaAssetId: string | null
  config: ServerClueConfig
}>(clue: T, previous: string, replacement: string | null): T {
  return {
    ...clue,
    mediaAssetId: clue.mediaAssetId === previous ? replacement : clue.mediaAssetId,
    revealMediaAssetId: clue.revealMediaAssetId === previous ? replacement : clue.revealMediaAssetId,
    config: clue.config.link ? {
      ...clue.config,
      link: { ...clue.config.link, mediaAssetIds: clue.config.link.mediaAssetIds.map((id) => id === previous ? replacement : id) },
    } : clue.config,
  }
}
