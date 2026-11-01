import { DomainError } from '../domain.js'
import { type CosmosAccess, type Document, type Query, type Write } from './cosmosIo.js'

export function validateCosmosTestTarget(environment: NodeJS.ProcessEnv) {
  const endpoint = environment.COSMOS_ENDPOINT, expected = environment.COSMOS_TEST_EXPECTED_ENDPOINT
  const database = environment.COSMOS_DATABASE, runId = environment.FRIENDS_TRIVIA_TEST_RUN_ID
  const resourceId = environment.COSMOS_TEST_ACCOUNT_RESOURCE_ID
  if (environment.FRIENDS_TRIVIA_COSMOS_LIVE !== 'approved-isolated-target' ||
    environment.COSMOS_TEST_TARGET_VERIFIED !== 'approved-account-and-isolated-database' ||
    !endpoint || endpoint !== expected || database !== 'friends-trivia-tests' ||
    environment.COSMOS_GAMES_CONTAINER !== 'games' || environment.COSMOS_LIBRARY_CONTAINER !== 'library' ||
    environment.AZURE_STORAGE_CONTAINER !== 'songs-tests' || !runId || !/^[a-zA-Z0-9][a-zA-Z0-9-]{7,79}$/.test(runId))
    throw new DomainError('conflict', 'Live Cosmos tests require an approved, verified isolated target and unique run ID')
  const url = new URL(endpoint)
  if (url.protocol !== 'https:' || !/^[a-z0-9-]+\.documents\.azure\.com$/.test(url.hostname) ||
    url.username || url.password || url.pathname !== '/' || url.search || url.hash ||
    (url.port && url.port !== '443'))
    throw new DomainError('conflict', 'Unsafe Cosmos test endpoint')
  const account = url.hostname.split('.')[0]!
  if (resourceId?.toLowerCase() !== `/subscriptions/299e641c-a5ad-4736-a74e-31ee5da9aef6/resourceGroups/friendsTrivia-app/providers/Microsoft.DocumentDB/databaseAccounts/${account}`.toLowerCase())
    throw new DomainError('conflict', 'Cosmos test account has not been explicitly verified')
  return { endpoint, database, runId, gamesContainer: 'games', libraryContainer: 'library' }
}

// Test item IDs/queries are namespaced; partition layout and SDK batches remain unchanged.
export class OwnedTestAccess implements CosmosAccess {
  private readonly prefix: string
  constructor(readonly underlying: CosmosAccess, readonly runId: string) { this.prefix = `test:${runId}:` }
  private restore<T extends Document>(doc: T): T {
    if (!doc.id.startsWith(this.prefix)) throw new DomainError('conflict', 'Live test touched an unowned document')
    return { ...doc, id: doc.id.slice(this.prefix.length) }
  }
  async read<T extends Document>(pk: string, id: string): Promise<T | undefined> {
    const doc = await this.underlying.read<T>(pk, this.prefix + id)
    return doc ? this.restore(doc) : undefined
  }
  async query<T extends Document>(query: Query, page?: Parameters<CosmosAccess['query']>[1]) {
    const result = await this.underlying.query<T>({
      ...query, filters: [...query.filters, { field: 'testRunId', value: this.runId }, { field: 'kind', op: '!=', value: 'testRun' }],
    }, page)
    return { ...result, items: result.items.map((doc) => this.restore(doc)) }
  }
  async batch(pk: string, writes: Write[]): Promise<void> {
    const owned = writes.map((write): Write => {
      if (write.type === 'delete') return { ...write, id: this.prefix + write.id }
      const doc: Document & { testRunId: string } = { ...write.doc, id: this.prefix + write.doc.id, testRunId: this.runId }
      return { ...write, doc }
    })
    await this.underlying.batch(pk, owned)
  }
}
