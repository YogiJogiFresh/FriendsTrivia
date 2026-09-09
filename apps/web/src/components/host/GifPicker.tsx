import { useState } from 'react'

import {
  ApiError,
  configureGifProvider,
  searchGifs,
} from '../../lib/apiClient'
import type {
  GifProvider,
  GifProviderStatus,
  GifSearchResult,
  ServerRevealGif,
} from '../../lib/apiClient'
import { Button } from '../common'
import styles from './GifPicker.module.css'

interface GifPickerProps {
  value?: ServerRevealGif
  providers: GifProviderStatus
  onProvidersChange: (providers: GifProviderStatus) => void
  onChange: (gif: ServerRevealGif | undefined) => void
}

const providerLabels: Record<GifProvider, string> = {
  giphy: 'GIPHY',
  tenor: 'Tenor',
}

type GifSource = GifProvider | 'url'

const providerSetupUrls: Record<GifProvider, string> = {
  giphy: 'https://developers.giphy.com/dashboard/',
  tenor: 'https://developers.google.com/tenor/guides/quickstart',
}

export function GifPicker({
  value,
  providers,
  onProvidersChange,
  onChange,
}: GifPickerProps) {
  const [provider, setProvider] = useState<GifSource>('giphy')
  const [apiKey, setApiKey] = useState('')
  const [directUrl, setDirectUrl] = useState('')
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<GifSearchResult[]>([])
  const [showKeySetup, setShowKeySetup] = useState(false)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function handleConfigure() {
    if (provider === 'url') return
    setLoading(true)
    setError(null)
    try {
      await configureGifProvider(provider, apiKey)
      onProvidersChange({ ...providers, [provider]: true })
      setApiKey('')
      setShowKeySetup(false)
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not save that API key.')
    } finally {
      setLoading(false)
    }
  }

  async function handleSearch() {
    if (provider === 'url') return
    if (!query.trim()) return
    setLoading(true)
    setError(null)
    try {
      const response = await searchGifs(provider, query.trim())
      setResults(response.results)
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not search for GIFs.')
    } finally {
      setLoading(false)
    }
  }

  function handleDirectUrl() {
    setError(null)
    try {
      const parsed = new URL(directUrl.trim())
      if (parsed.protocol !== 'https:' || !parsed.pathname.toLowerCase().endsWith('.gif')) {
        throw new Error()
      }
      onChange({
        provider: 'url',
        url: parsed.href,
        previewUrl: parsed.href,
        sourceUrl: parsed.href,
        alt: 'Answer reveal GIF',
      })
    } catch {
      setError('Enter a secure URL ending in .gif.')
    }
  }

  const providerLabel = provider === 'url' ? 'Direct URL' : providerLabels[provider]

  return (
    <div className={styles.picker}>
      <span className={styles.label}>Answer reveal GIF (optional)</span>

      {value ? (
        <div className={styles.selected}>
          <img src={value.previewUrl} alt={value.alt} />
          <div>
            <a href={value.sourceUrl} target="_blank" rel="noreferrer">
              {value.provider === 'url' ? 'View linked GIF' : `View on ${providerLabels[value.provider]}`}
            </a>
            <Button variant="danger" onClick={() => onChange(undefined)}>
              Remove GIF
            </Button>
          </div>
        </div>
      ) : null}

      <div className={styles.controls}>
        <select
          value={provider}
          onChange={(event) => {
            setProvider(event.target.value as GifSource)
            setResults([])
            setError(null)
            setShowKeySetup(false)
          }}
          aria-label="GIF provider"
        >
          <option value="giphy">GIPHY</option>
          <option value="tenor">Tenor</option>
          <option value="url">Direct URL</option>
        </select>

        {provider === 'url' ? (
          <>
            <input
              type="url"
              value={directUrl}
              placeholder="https://example.com/reaction.gif"
              aria-label="Direct GIF URL"
              onChange={(event) => setDirectUrl(event.target.value)}
            />
            <Button variant="secondary" disabled={!directUrl.trim()} onClick={handleDirectUrl}>
              Use GIF
            </Button>
          </>
        ) : providers[provider] && !showKeySetup ? (
          <>
            <input
              value={query}
              maxLength={50}
              placeholder={`Search ${providerLabels[provider]}`}
              aria-label={`Search ${providerLabels[provider]} GIFs`}
              onChange={(event) => setQuery(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') {
                  event.preventDefault()
                  void handleSearch()
                }
              }}
            />
            <Button variant="secondary" disabled={loading || !query.trim()} onClick={handleSearch}>
              {loading ? 'Searching…' : 'Search'}
            </Button>
            <Button variant="ghost" onClick={() => setShowKeySetup(true)}>
              Change key
            </Button>
          </>
        ) : (
          <>
            <input
              type="password"
              value={apiKey}
              placeholder={`${providerLabels[provider]} API key`}
              aria-label={`${providerLabels[provider]} API key`}
              onChange={(event) => setApiKey(event.target.value)}
            />
            <Button variant="secondary" disabled={loading || apiKey.trim().length < 8} onClick={handleConfigure}>
              Save key
            </Button>
            <a href={providerSetupUrls[provider]} target="_blank" rel="noreferrer">
              Get a key
            </a>
          </>
        )}
      </div>

      {error ? <p role="alert" className={styles.error}>{error}</p> : null}

      {results.length ? (
        <div className={styles.results} aria-label={`${providerLabel} search results`}>
          {results.map((result) => (
            <button key={`${result.provider}-${result.id}`} type="button" onClick={() => onChange(result)}>
              <img src={result.previewUrl} alt={result.alt} loading="lazy" />
            </button>
          ))}
        </div>
      ) : null}
      {results.length ? <small>Powered by {providerLabel}</small> : null}
    </div>
  )
}
