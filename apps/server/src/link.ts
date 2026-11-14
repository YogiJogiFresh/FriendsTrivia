interface LinkConfig {
  mediaAssetIds: (string | null)[]
  hintDelaySeconds: number
  revealNotes?: string
}

export function getLinkConfig(clue: { type: string; config: unknown }): LinkConfig | undefined {
  if (!clue.config || typeof clue.config !== 'object' ||
    !Object.prototype.hasOwnProperty.call(clue.config, 'link')) return undefined
  const link = (clue.config as { link: unknown }).link
  const value = link && typeof link === 'object' ? link as Record<string, unknown> : {}
  const ids = value.mediaAssetIds
  const validIds = Array.isArray(ids) && ids.length === 4 &&
    ids.every((id) => id === null || (typeof id === 'string' && Boolean(id.trim()))) &&
    new Set(ids.filter((id) => id !== null)).size === ids.filter((id) => id !== null).length
  const validDelay = typeof value.hintDelaySeconds === 'number' &&
    Number.isInteger(value.hintDelaySeconds) && value.hintDelaySeconds >= 0 && value.hintDelaySeconds <= 300
  // Corrupt stored configuration must remain Link, never ordinary free text or a partial playlist.
  return {
    mediaAssetIds: validIds && validDelay ? [...ids] as (string | null)[] : [null, null, null, null],
    hintDelaySeconds: validDelay ? value.hintDelaySeconds as number : 10,
    ...(typeof value.revealNotes === 'string' && value.revealNotes.length <= 2000 && value.revealNotes.trim()
      ? { revealNotes: value.revealNotes.trim() } : {}),
  }
}

export function clueMediaIds(clue: {
  type: string; config: unknown; mediaAssetId?: string | null; revealMediaAssetId?: string | null
}): string[] {
  const config = clue.config && typeof clue.config === 'object' ? clue.config as Record<string, unknown> : {}
  const link = config.link && typeof config.link === 'object' ? config.link as Record<string, unknown> : {}
  return [...new Set([clue.mediaAssetId, clue.revealMediaAssetId, ...(Array.isArray(link.mediaAssetIds) ? link.mediaAssetIds : [])]
    .filter((id): id is string => typeof id === 'string' && Boolean(id)))]
}
