import Fastify from 'fastify'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { openDatabase } from '../database.js'
import { isRevealGif } from '../gifs.js'
import { registerGifRoutes } from './gifs.js'

const cleanups: Array<() => Promise<void> | void> = []

afterEach(async () => {
  vi.unstubAllGlobals()
  for (const cleanup of cleanups.splice(0)) await cleanup()
})

describe('GIF search routes', () => {
  it('accepts secure direct GIF URLs and rejects other links', () => {
    expect(
      isRevealGif({
        provider: 'url',
        url: 'https://example.com/reaction.gif?size=large',
        previewUrl: 'https://example.com/reaction.gif?size=large',
        sourceUrl: 'https://example.com/reaction.gif?size=large',
        alt: 'Answer reveal GIF',
      }),
    ).toBe(true)
    expect(
      isRevealGif({
        provider: 'url',
        url: 'http://example.com/reaction.gif',
        previewUrl: 'http://example.com/reaction.gif',
        sourceUrl: 'http://example.com/reaction.gif',
        alt: 'Unsafe GIF',
      }),
    ).toBe(false)
  })

  it('stores provider setup without exposing its key', async () => {
    const database = openDatabase(':memory:')
    const app = Fastify()
    await registerGifRoutes(app, database, { giphy: undefined, tenor: undefined })
    cleanups.push(async () => {
      await app.close()
      database.close()
    })

    expect((await app.inject({ method: 'GET', url: '/api/gifs/providers' })).json()).toEqual({
      giphy: false,
      tenor: false,
    })

    const configured = await app.inject({
      method: 'PUT',
      url: '/api/gifs/providers/giphy',
      payload: { apiKey: 'local-test-key' },
    })
    expect(configured.statusCode).toBe(204)
    expect((await app.inject({ method: 'GET', url: '/api/gifs/providers' })).json()).toEqual({
      giphy: true,
      tenor: false,
    })
  })

  it('normalizes GIPHY search results', async () => {
    const database = openDatabase(':memory:')
    const app = Fastify()
    await registerGifRoutes(app, database, { giphy: 'test-key', tenor: undefined })
    cleanups.push(async () => {
      await app.close()
      database.close()
    })
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        new Response(
          JSON.stringify({
            data: [
              {
                id: 'celebrate',
                title: 'Celebration',
                url: 'https://giphy.com/gifs/celebrate',
                images: {
                  fixed_width: { url: 'https://media.giphy.com/media/celebrate/giphy.gif' },
                  fixed_width_small: {
                    url: 'https://media.giphy.com/media/celebrate/100w.gif',
                  },
                },
              },
            ],
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        ),
      ),
    )

    const response = await app.inject({
      method: 'GET',
      url: '/api/gifs/search?provider=giphy&q=celebrate',
    })

    expect(response.statusCode).toBe(200)
    expect(response.json()).toEqual({
      results: [
        {
          id: 'celebrate',
          provider: 'giphy',
          url: 'https://media.giphy.com/media/celebrate/giphy.gif',
          previewUrl: 'https://media.giphy.com/media/celebrate/100w.gif',
          alt: 'Celebration',
          sourceUrl: 'https://giphy.com/gifs/celebrate',
        },
      ],
    })
  })
})
