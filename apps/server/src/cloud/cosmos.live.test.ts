import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { CosmosClient } from '@azure/cosmos'
import { AzureCliCredential } from '@azure/identity'
import { createCosmosStore } from './cosmos.js'
import { document, pages, remove, replace, SdkCosmosAccess, type Document } from './cosmosIo.js'
import { OwnedTestAccess, validateCosmosTestTarget } from './cosmosTestTarget.js'
import { PackRepository } from '../repositories/packs.js'
import { RoomRepository } from '../repositories/rooms.js'
import { GameEngine } from '../game/engine.js'

const enabled = process.env.FRIENDS_TRIVIA_COSMOS_LIVE === 'approved-isolated-target'
describe('LIVE Cosmos SDK acceptance — separately approved isolated target only (no Blob acceptance)', () => {
  it.skipIf(!enabled)('persists a frozen 50-player room and cleans up only this uniquely owned run', async () => {
    const target = validateCosmosTestTarget(process.env)
    // Never construct a credential/client before the isolated-account approval gate.
    const client = new CosmosClient({ endpoint: target.endpoint, aadCredentials: new AzureCliCredential(),
      connectionPolicy: { retryOptions: { maxRetryAttemptCount: 0, maxWaitTimeInSeconds: 0 }, requestTimeout: 10_000 } })
    const database = client.database(target.database)
    const gamesContainer = database.container(target.gamesContainer), libraryContainer = database.container(target.libraryContainer)
    let ownedRun = false, passed = false, engine: GameEngine | undefined
    const gamesSdk = new SdkCosmosAccess(gamesContainer), librarySdk = new SdkCosmosAccess(libraryContainer)
    const fenceId = `test-run:${target.runId}`
    const started = Date.now()
    const progress = (stage: string) => console.info(`Live Cosmos ${Date.now() - started}ms: ${stage}`)
    try {
      progress('checking isolated database and containers')
      const response = await database.read()
      expect(response.resource?.id).toBe('friends-trivia-tests')
      for (const container of [gamesContainer, libraryContainer])
        expect((await container.read()).resource?.partitionKey?.paths).toEqual(['/pk'])
      await librarySdk.batch('test-runs', [{ type: 'create', doc: document('test-runs', fenceId, 'testRun', {
        testRunId: target.runId, nonce: randomUUID(), status: 'running',
      }) }])
      ownedRun = true
      progress('creating pack and frozen room')
      const games = new OwnedTestAccess(gamesSdk, target.runId), library = new OwnedTestAccess(librarySdk, target.runId)
      const store = await createCosmosStore(games, library)
      const packs = new PackRepository(store), rooms = new RoomRepository(store)
      const draft = await packs.create({ title: `Live ${target.runId}` })
      const pack = (await packs.replace(draft.id, { title: draft.title, status: 'ready', categories: [{
        title: 'Prices', clues: [{ type: 'price_slider', boardValue: 100, prompt: 'Target?', timerSeconds: 300,
          config: { correctPrice: 50, min: 0, max: 100 } }],
      }] }))!
      let room = (await rooms.create(pack.id, { timerSeconds: 300, speedBonusMax: 0, priceRankPercentages: [1], uniqueNicknames: true }, 8)).room
      const players = []
      for (let index = 0; index < 50; index++) {
        players.push((await rooms.join(room, `Player ${index}`)).player)
        if ((index + 1) % 10 === 0) progress(`joined ${index + 1}/50 players`)
      }
      progress('starting game and submitting 50 answers')
      engine = new GameEngine(store, rooms, 'http://localhost:3000')
      room = await engine.startGame(room)
      room = await engine.selectClue(room, pack.categories[0]!.clues[0]!.id)
      for (const player of players) await engine.submitAnswer(room, player.id, 50)
      room = await engine.closeAnswers(room)
      progress('checking scoring, frozen pack and history deletion')
      const scores = await rooms.scores(room.id)
      expect(scores).toHaveLength(50)
      expect(scores.every(({ score }) => score === 100)).toBe(true)
      await packs.replace(pack.id, { ...pack, title: 'Edited library', categories: [] , status: 'draft' })
      expect((await store.rooms.clue(room.ref, pack.categories[0]!.clues[0]!.id))?.prompt).toBe('Target?')
      room = await engine.endSession(room)
      expect(await store.history.removeCompleted(room.id)).toBe('deleted')
      await store.close()
      passed = true
    } finally {
      engine?.dispose()
      progress('cleaning run-owned documents')
      try { if (ownedRun) {
        for (const sdk of [gamesSdk, librarySdk]) {
          while (true) {
            const result = await sdk.query<Document>({ filters: [
              { field: 'testRunId', value: target.runId }, { field: 'kind', op: '!=', value: 'testRun' },
            ] }, { limit: 90 })
            if (!result.items.length) break
            for (const doc of result.items) {
              if (!doc.id.startsWith(`test:${target.runId}:`)) throw new Error('Refusing cleanup of an unowned live-test item')
              await sdk.batch(doc.pk, [remove(doc)])
            }
          }
        }
        const fence = await librarySdk.read('test-runs', fenceId)
        if (fence) await librarySdk.batch('test-runs', [replace({ ...fence, status: passed ? 'completed' : 'failed' })])
      } } finally { client.dispose() }
    }
  }, 360_000)
})
