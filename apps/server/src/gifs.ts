export type GifProvider = 'giphy' | 'tenor'
export type RevealGifProvider = GifProvider | 'url'

export interface RevealGif {
  provider: RevealGifProvider
  url: string
  previewUrl: string
  alt: string
  sourceUrl: string
}

const allowedMediaHosts: Record<GifProvider, (host: string) => boolean> = {
  giphy: (host) => host === 'giphy.com' || host.endsWith('.giphy.com'),
  tenor: (host) => host === 'media.tenor.com',
}

function isDirectGifUrl(value: unknown): value is string {
  if (typeof value !== 'string' || value.length > 2_000) return false
  try {
    const parsed = new URL(value)
    return parsed.protocol === 'https:' && parsed.pathname.toLowerCase().endsWith('.gif')
  } catch {
    return false
  }
}

const allowedSourceHosts: Record<GifProvider, (host: string) => boolean> = {
  giphy: (host) => host === 'giphy.com' || host.endsWith('.giphy.com'),
  tenor: (host) => host === 'tenor.com' || host.endsWith('.tenor.com'),
}

function hasAllowedUrl(value: unknown, checkHost: (host: string) => boolean): value is string {
  if (typeof value !== 'string' || value.length > 2_000) return false
  try {
    const parsed = new URL(value)
    return parsed.protocol === 'https:' && checkHost(parsed.hostname.toLowerCase())
  } catch {
    return false
  }
}

export function isRevealGif(value: unknown): value is RevealGif {
  if (!value || typeof value !== 'object') return false
  const candidate = value as Record<string, unknown>
  const provider = candidate.provider
  if (provider === 'url') {
    return (
      isDirectGifUrl(candidate.url) &&
      candidate.previewUrl === candidate.url &&
      candidate.sourceUrl === candidate.url &&
      typeof candidate.alt === 'string' &&
      candidate.alt.length <= 300
    )
  }
  if (provider !== 'giphy' && provider !== 'tenor') return false
  return (
    hasAllowedUrl(candidate.url, allowedMediaHosts[provider]) &&
    hasAllowedUrl(candidate.previewUrl, allowedMediaHosts[provider]) &&
    typeof candidate.alt === 'string' &&
    candidate.alt.length <= 300 &&
    hasAllowedUrl(candidate.sourceUrl, allowedSourceHosts[provider])
  )
}
