import { describe, expect, it } from 'vitest'

import { validateBlobTestTarget } from './blobTestTarget.js'

const approved: NodeJS.ProcessEnv = {
  FRIENDS_TRIVIA_BLOB_LIVE: 'approved-isolated-target',
  BLOB_TEST_TARGET_VERIFIED: 'approved-account-and-isolated-container',
  AZURE_STORAGE_ACCOUNT_URL: 'https://friendstriviatest.blob.core.windows.net',
  AZURE_STORAGE_TEST_EXPECTED_ENDPOINT: 'https://friendstriviatest.blob.core.windows.net',
  AZURE_STORAGE_TEST_ACCOUNT_RESOURCE_ID: '/subscriptions/299e641c-a5ad-4736-a74e-31ee5da9aef6/resourceGroups/friendsTrivia-app/providers/Microsoft.Storage/storageAccounts/friendstriviatest',
  AZURE_STORAGE_CONTAINER: 'songs-tests',
  FRIENDS_TRIVIA_TEST_RUN_ID: 'isolated-run-123',
}

describe('isolated Blob acceptance target', () => {
  it('accepts only the explicitly verified test account and container', () => {
    expect(validateBlobTestTarget(approved)).toEqual({
      endpoint: approved.AZURE_STORAGE_ACCOUNT_URL, container: 'songs-tests', runId: 'isolated-run-123',
    })
  })

  it.each([
    { FRIENDS_TRIVIA_BLOB_LIVE: undefined },
    { BLOB_TEST_TARGET_VERIFIED: undefined },
    { AZURE_STORAGE_CONTAINER: 'songs' },
    { AZURE_STORAGE_TEST_EXPECTED_ENDPOINT: 'https://other.blob.core.windows.net' },
    { AZURE_STORAGE_TEST_ACCOUNT_RESOURCE_ID: approved.AZURE_STORAGE_TEST_ACCOUNT_RESOURCE_ID?.replace('friendsTrivia-app', 'other-group') },
    { FRIENDS_TRIVIA_TEST_RUN_ID: '../outside' },
    { AZURE_STORAGE_ACCOUNT_URL: 'https://friendstriviatest.blob.core.windows.net/?sig=secret', AZURE_STORAGE_TEST_EXPECTED_ENDPOINT: 'https://friendstriviatest.blob.core.windows.net/?sig=secret' },
    { AZURE_STORAGE_ACCOUNT_URL: 'http://friendstriviatest.blob.core.windows.net', AZURE_STORAGE_TEST_EXPECTED_ENDPOINT: 'http://friendstriviatest.blob.core.windows.net' },
    { AZURE_STORAGE_ACCOUNT_URL: 'https://friendstriviatest.blob.core.windows.net:444', AZURE_STORAGE_TEST_EXPECTED_ENDPOINT: 'https://friendstriviatest.blob.core.windows.net:444' },
  ])('rejects unapproved, production, or malformed configuration %j', (override) => {
    expect(() => validateBlobTestTarget({ ...approved, ...override })).toThrow()
  })
})
