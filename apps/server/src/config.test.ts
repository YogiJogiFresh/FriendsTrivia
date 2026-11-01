import { describe, expect, it } from 'vitest'
import { cloudConfig } from './config.js'

const environment = {
  FRIENDS_TRIVIA_MODE: 'cloud', PUBLIC_URL: 'https://trivia.example',
  AZURE_STORAGE_ACCOUNT_URL: 'https://songs.blob.core.windows.net', AZURE_STORAGE_CONTAINER: 'songs',
  COSMOS_ENDPOINT: 'https://trivia.documents.azure.com', COSMOS_DATABASE: 'friends-trivia',
  COSMOS_GAMES_CONTAINER: 'games', COSMOS_LIBRARY_CONTAINER: 'library',
}
describe('runtime configuration', () => {
  it('defaults offline local mode without cloud credentials', () => {
    expect(cloudConfig({})).toEqual({ mode: 'local' })
  })
  it('rejects missing and local modes on App Service', () => {
    expect(() => cloudConfig({ WEBSITE_SITE_NAME: 'trivia' })).toThrow('App Service requires')
    expect(() => cloudConfig({ WEBSITE_INSTANCE_ID: 'instance', FRIENDS_TRIVIA_MODE: 'local' })).toThrow('App Service requires')
  })
  it('fails closed for partial/unsafe cloud settings and invalid modes', () => {
    expect(() => cloudConfig({ FRIENDS_TRIVIA_MODE: 'other' })).toThrow('must be local or cloud')
    expect(() => cloudConfig({ FRIENDS_TRIVIA_MODE: 'cloud' })).toThrow('PUBLIC_URL is required')
    expect(() => cloudConfig({ ...environment, PUBLIC_URL: 'http://example.com' })).toThrow('HTTPS')
    expect(cloudConfig(environment)).toMatchObject({
      mode: 'cloud', cosmosDatabase: 'friends-trivia', cosmosGamesContainer: 'games', cosmosLibraryContainer: 'library', azureStorageContainer: 'songs',
    })
    for (const name of ['COSMOS_ENDPOINT', 'COSMOS_DATABASE', 'COSMOS_GAMES_CONTAINER', 'COSMOS_LIBRARY_CONTAINER', 'AZURE_STORAGE_CONTAINER']) {
      expect(() => cloudConfig({ ...environment, [name]: '' })).toThrow(`${name} is required`)
    }
    expect(() => cloudConfig({ ...environment, COSMOS_ENDPOINT: 'https://user:secret@example.com' })).toThrow('without credentials')
  })
})
