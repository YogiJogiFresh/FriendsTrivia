import { afterEach, describe, expect, it, vi } from 'vitest'

const client = vi.hoisted(() => ({
  emit: vi.fn(),
  timeout: vi.fn(),
}))

vi.mock('socket.io-client', () => ({
  io: () => client,
}))

import { emitWithAck } from './socketClient'

afterEach(() => {
  vi.unstubAllGlobals()
  vi.clearAllMocks()
})

function acknowledge() {
  client.timeout.mockReturnValue(client)
  client.emit.mockImplementation((_event, _payload, callback) => {
    callback(null, { ok: true, data: 'accepted' })
  })
}

describe('socket mutation request IDs', () => {
  it('sends an ID alongside authoritative context without changing the caller payload', async () => {
    acknowledge()
    const payload = { command: 'pause', expectedAttempt: 2 }
    await expect(emitWithAck('host:command', payload)).resolves.toBe('accepted')
    const request = client.emit.mock.calls[0][1]
    expect(request).toMatchObject(payload)
    expect(request.requestId).toMatch(/^[A-Za-z0-9_-]{8,100}$/)
    expect(payload).not.toHaveProperty('requestId')
  })

  it('preserves an explicit ID for retrying the same operation', async () => {
    acknowledge()
    const payload = { amount: 10, requestId: 'same-operation-id' }
    await emitWithAck('player:wager', payload)
    await emitWithAck('player:wager', payload)
    expect(client.emit.mock.calls.map((call) => call[1].requestId)).toEqual([
      'same-operation-id', 'same-operation-id',
    ])
  })

  it('works on HTTP LAN pages without secure-context randomUUID', async () => {
    acknowledge()
    vi.stubGlobal('crypto', {
      getRandomValues: (bytes: Uint8Array) => bytes.fill(0x12),
    })
    await emitWithAck('player:answer', { answer: 'A' })
    expect(client.emit.mock.calls[0][1].requestId).toBe('12'.repeat(16))
  })
})
