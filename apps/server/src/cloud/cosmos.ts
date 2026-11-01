import type { DeploymentConfig } from '../config.js'
import { DomainError, type DomainStore } from '../domain.js'
import { CosmosClient } from '@azure/cosmos'
import { ManagedIdentityCredential } from '@azure/identity'
import cluster from 'node:cluster'
import { CosmosMedia } from './cosmosMedia.js'
import { CosmosPacks } from './cosmosPacks.js'
import { CosmosRooms } from './cosmosRooms.js'
import { CosmosHistory } from './cosmosHistory.js'
import { conflict, document, LIBRARY_PK, pages, replace, SdkCosmosAccess,
  unavailable, type CosmosAccess, type Document } from './cosmosIo.js'

interface Setting extends Document { value: string }
// Explicit test injection accepts storage operations, never ambient/test runtime credentials.
export async function createCosmosStore(games: CosmosAccess, library: CosmosAccess, roomCode?: (length: number) => string): Promise<DomainStore> {
  const media = new CosmosMedia(library), packs = new CosmosPacks(library, media), rooms = new CosmosRooms(games, packs, roomCode)
  await media.initialize()
  const store: DomainStore = {
    mode: 'cloud', media, packs, rooms, history: new CosmosHistory(rooms),
    settings: {
      async gifKey(provider) { return (await library.read<Setting>(LIBRARY_PK, `setting:${provider}`))?.value },
      async setGifKey(provider, value) {
        for (let attempt = 0; ; attempt++) {
          const id = `setting:${provider}`, current = await library.read<Setting>(LIBRARY_PK, id)
          try {
            await library.batch(LIBRARY_PK, [current ? replace({ ...current, value })
              : { type: 'create', doc: document(LIBRARY_PK, id, 'setting', { value }) }])
            return
          } catch (error) { if (!conflict(error) || attempt >= 4) throw error }
        }
      },
    },
    async recover() {
      await rooms.recover()
      await packs.recover()
      await media.verifyQuota()
      // Every encountered document must be versioned, including orphaned metadata.
      for await (const _doc of pages(library, { filters: [] })) { /* Point/query access validates schema versions. */ }
      for await (const _doc of pages(games, { filters: [] })) { /* Unknown document kinds must also be versioned. */ }
    },
    async close() {},
  }
  return store
}

export async function openCosmosStore(config: DeploymentConfig): Promise<DomainStore> {
  if (config.mode !== 'cloud') throw new DomainError('unavailable', 'Cosmos requires explicit cloud mode')
  if (!config.cosmosEndpoint || !config.cosmosDatabase || !config.cosmosGamesContainer || !config.cosmosLibraryContainer)
    throw new DomainError('unavailable', 'Cosmos configuration is incomplete')
  const endpoint = new URL(config.cosmosEndpoint)
  if (endpoint.protocol !== 'https:' || endpoint.username || endpoint.password || endpoint.search || endpoint.hash ||
    !endpoint.hostname.endsWith('.documents.azure.com') || endpoint.pathname !== '/')
    throw new DomainError('unavailable', 'Cosmos endpoint must be a credential-free Azure HTTPS origin')
  if (config.cosmosDatabase !== 'friends-trivia')
    throw new DomainError('unavailable', 'Runtime Cosmos database must be friends-trivia; tests require explicit isolated injection')
  if (cluster.isWorker || Number(process.env.WEB_CONCURRENCY ?? '1') !== 1 ||
    (process.env.NODE_APP_INSTANCE !== undefined && process.env.NODE_APP_INSTANCE !== '0'))
    throw new DomainError('unavailable', 'Cloud persistence requires one Node worker')
  const credential = config.azureClientId ? new ManagedIdentityCredential({ clientId: config.azureClientId }) : new ManagedIdentityCredential()
  const client = new CosmosClient({ endpoint: config.cosmosEndpoint, aadCredentials: credential,
    connectionPolicy: { requestTimeout: 10_000, retryOptions: { maxRetryAttemptCount: 0, maxWaitTimeInSeconds: 0 } } })
  try {
    const database = client.database(config.cosmosDatabase)
    await database.read()
    const games = database.container(config.cosmosGamesContainer), library = database.container(config.cosmosLibraryContainer)
    for (const container of [games, library]) {
      const { resource } = await container.read()
      if (resource?.partitionKey?.paths.length !== 1 || resource.partitionKey.paths[0] !== '/pk')
        throw new DomainError('unavailable', 'Cosmos containers must use /pk partitioning')
    }
    const store = await createCosmosStore(new SdkCosmosAccess(games), new SdkCosmosAccess(library))
    return { ...store, async close() { client.dispose() } }
  } catch (error) { client.dispose(); unavailable(error) }
}
