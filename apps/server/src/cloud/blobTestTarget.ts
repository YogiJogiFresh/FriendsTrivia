import { DomainError } from '../domain.js'

export function validateBlobTestTarget(environment: NodeJS.ProcessEnv) {
  const endpoint = environment.AZURE_STORAGE_ACCOUNT_URL
  const runId = environment.FRIENDS_TRIVIA_TEST_RUN_ID
  if (environment.FRIENDS_TRIVIA_BLOB_LIVE !== 'approved-isolated-target' ||
    environment.BLOB_TEST_TARGET_VERIFIED !== 'approved-account-and-isolated-container' ||
    !endpoint || endpoint !== environment.AZURE_STORAGE_TEST_EXPECTED_ENDPOINT ||
    environment.AZURE_STORAGE_CONTAINER !== 'songs-tests' ||
    !runId || !/^[a-zA-Z0-9][a-zA-Z0-9-]{7,79}$/.test(runId)) {
    throw new DomainError('conflict', 'Live Blob tests require an approved, verified isolated target and unique run ID')
  }
  const url = new URL(endpoint)
  if (url.protocol !== 'https:' || !/^[a-z0-9]{3,24}\.blob\.core\.windows\.net$/.test(url.hostname) ||
    url.username || url.password || url.pathname !== '/' || url.search || url.hash ||
    (url.port && url.port !== '443')) {
    throw new DomainError('conflict', 'Unsafe Blob test endpoint')
  }
  const account = url.hostname.split('.')[0]!
  const expectedResourceId = `/subscriptions/299e641c-a5ad-4736-a74e-31ee5da9aef6/resourceGroups/friendsTrivia-app/providers/Microsoft.Storage/storageAccounts/${account}`
  if (environment.AZURE_STORAGE_TEST_ACCOUNT_RESOURCE_ID?.toLowerCase() !== expectedResourceId.toLowerCase()) {
    throw new DomainError('conflict', 'Blob test account has not been explicitly verified')
  }
  return { endpoint, runId, container: 'songs-tests' }
}
