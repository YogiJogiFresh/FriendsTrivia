import type { FastifyInstance } from 'fastify'
import type { SettingsStore } from '../domain.js'
import { domainFrom, type DomainSource } from '../sqliteStore.js'
import type { GifProvider, RevealGif } from '../gifs.js'
interface GiphyResponse {
  data?: Array<{
    id?: string
    title?: string
    url?: string
    images?: {
      fixed_width?: {
        url?: string
      }
      fixed_width_small?: {
        url?: string
      }
      original?: {
        url?: string
      }
    }
  }>
}
interface TenorResponse {
  results?: Array<{
    id?: string
    content_description?: string
    itemurl?: string
    media_formats?: {
      gif?: {
        url?: string
      }
      tinygif?: {
        url?: string
      }
    }
  }>
}
function isProvider(value: unknown): value is GifProvider {
  return value === 'giphy' || value === 'tenor'
}
export async function registerGifRoutes(app: FastifyInstance, source: DomainSource | SettingsStore, environmentKeys: Record<GifProvider, string | undefined>): Promise<void> {
  const settings = 'gifKey' in source ? source : domainFrom(source).settings
  async function apiKey(provider: GifProvider): Promise<string | undefined> {
    const environmentKey = environmentKeys[provider]?.trim()
    if (environmentKey)
      return environmentKey
    return settings.gifKey(provider)
  }
  app.get('/api/gifs/providers', async () => ({
    giphy: Boolean((await apiKey('giphy'))),
    tenor: Boolean((await apiKey('tenor'))),
  }))
  app.put<{
    Params: {
      provider: string
    }
  }>('/api/gifs/providers/:provider', async (request, reply) => {
    if (!isProvider(request.params.provider)) {
      return reply.code(404).send({ error: 'GIF provider not found' })
    }
    if (environmentKeys[request.params.provider]) {
      return reply.code(409).send({ error: 'This provider is configured by the application environment' })
    }
    const body = request.body as {
      apiKey?: unknown
    } | undefined
    if (!body ||
      typeof body.apiKey !== 'string' ||
      body.apiKey.trim().length < 8 ||
      body.apiKey.trim().length > 200) {
      return reply.code(400).send({ error: 'Enter a valid provider API key' })
    }
    await settings.setGifKey(request.params.provider, body.apiKey.trim())
    return reply.code(204).send()
  })
  app.get('/api/gifs/search', async (request, reply) => {
    const query = request.query as {
      provider?: unknown
      q?: unknown
    }
    if (!isProvider(query.provider)) {
      return reply.code(400).send({ error: 'Choose GIPHY or Tenor' })
    }
    if (typeof query.q !== 'string' || !query.q.trim() || query.q.trim().length > 50) {
      return reply.code(400).send({ error: 'Enter a search term up to 50 characters' })
    }
    const key = (await apiKey(query.provider))
    if (!key) {
      return reply.code(409).send({ error: `Configure ${query.provider.toUpperCase()} before searching` })
    }
    try {
      const results = query.provider === 'giphy'
        ? await searchGiphy(key, query.q.trim())
        : await searchTenor(key, query.q.trim())
      return { results }
    }
    catch (error) {
      request.log.error({ err: error, provider: query.provider }, 'GIF search failed')
      return reply.code(502).send({ error: `${query.provider.toUpperCase()} search failed` })
    }
  })
}
async function fetchJson<T>(url: URL): Promise<Promise<T>> {
  const response = await fetch(url, { signal: AbortSignal.timeout(8000) })
  if (!response.ok)
    throw new Error(`GIF provider returned ${response.status}`)
  return (response.json()) as T
}
async function searchGiphy(apiKey: string, query: string): Promise<Promise<Array<RevealGif & {
  id: string
}>>> {
  const url = new URL('https://api.giphy.com/v1/gifs/search')
  url.search = new URLSearchParams({
    api_key: apiKey,
    q: query,
    limit: '18',
    rating: 'pg',
    lang: 'en',
  }).toString()
  const response = await fetchJson<GiphyResponse>(url)
  return (response.data ?? []).flatMap((item) => {
    const mediaUrl = item.images?.fixed_width?.url ?? item.images?.original?.url
    const previewUrl = item.images?.fixed_width_small?.url ?? mediaUrl
    if (!item.id || !mediaUrl || !previewUrl || !item.url)
      return []
    return [{
      id: item.id,
      provider: 'giphy',
      url: mediaUrl,
      previewUrl,
      alt: item.title?.trim() || `${query} GIF`,
      sourceUrl: item.url,
    }]
  })
}
async function searchTenor(apiKey: string, query: string): Promise<Promise<Array<RevealGif & {
  id: string
}>>> {
  const url = new URL('https://tenor.googleapis.com/v2/search')
  url.search = new URLSearchParams({
    key: apiKey,
    q: query,
    limit: '18',
    contentfilter: 'medium',
    media_filter: 'gif,tinygif',
    locale: 'en_US',
    client_key: 'friends_trivia',
  }).toString()
  const response = await fetchJson<TenorResponse>(url)
  return (response.results ?? []).flatMap((item) => {
    const mediaUrl = item.media_formats?.gif?.url
    const previewUrl = item.media_formats?.tinygif?.url ?? mediaUrl
    if (!item.id || !mediaUrl || !previewUrl || !item.itemurl)
      return []
    return [{
      id: item.id,
      provider: 'tenor',
      url: mediaUrl,
      previewUrl,
      alt: item.content_description?.trim() || `${query} GIF`,
      sourceUrl: item.itemurl,
    }]
  })
}
