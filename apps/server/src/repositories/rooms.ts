import { AsyncLocalStorage } from 'node:async_hooks'
import type { DomainStore, LoadedRoom, RoomChange, RoomRef, RoomStore } from '../domain.js'
import { DomainError } from '../domain.js'
import type { GameSettings, PlayerRecord, PlayerScore, RoomRecord, RoomState } from '../game/types.js'
import { createId, createToken, hashToken, tokenMatches } from '../ids.js'
import { domainFrom, type DomainSource } from '../sqliteStore.js'

interface Command {
  loaded: LoadedRoom
  initial: RoomRecord
  change: RoomChange
  effects: Array<() => void>
  operationId: string
}
export class RoomRepository {
  readonly store: RoomStore
  readonly mode: DomainStore['mode']
  private readonly commands = new AsyncLocalStorage<Command>()
  private readonly tails = new Map<string, Promise<unknown>>()
  private stopping = false
  onEffectError: (error: unknown) => void = () => {}
  constructor(source: DomainSource | RoomStore, mode: DomainStore['mode'] = 'local') {
    const domain = 'load' in source ? undefined : domainFrom(source)
    this.store = domain?.rooms ?? source as RoomStore
    this.mode = domain?.mode ?? mode
  }
  current(): LoadedRoom {
    const context = this.commands.getStore()
    if (!context) throw new Error('A room command is required')
    return context.loaded
  }
  pendingChange(): RoomChange | undefined { return this.commands.getStore()?.change }
  setChange(change: RoomChange): void {
    const context = this.commands.getStore()
    if (!context) throw new Error('A room command is required')
    if (context.change.kind !== 'none' && context.change !== change)
      throw new Error('A command may contain only one domain mutation')
    context.change = change
  }
  afterCommit(effect: () => void): void {
    const command = this.commands.getStore()
    if (command) command.effects.push(effect)
    else this.publish(effect)
  }
  private publish(effect: () => void): void {
    try { effect() } catch (error) { this.onEffectError(error) }
  }
  runRoom<T>(roomId: string, action: () => Promise<T>, operationId = createId()): Promise<T> {
    const nested = this.commands.getStore()
    if (nested) {
      if (nested.loaded.ref.id !== roomId) throw new Error('Cannot mutate another room inside a command')
      return action()
    }
    if (this.stopping) return Promise.reject(new Error('Server is shutting down'))
    const prior = this.tails.get(roomId) ?? Promise.resolve()
    const result = prior.then(async () => {
      const ref = await this.store.resolveId(roomId)
      if (!ref) throw new DomainError('not_found', 'Room not found')
      const loaded = await this.store.load(ref)
      const command: Command = { loaded, initial: structuredClone(loaded.room), change: { kind: 'none' }, effects: [], operationId }
      const output = await this.commands.run(command, action)
      const stateChanged = command.initial.stateVersion !== command.loaded.room.stateVersion ||
        command.initial.joiningLocked !== command.loaded.room.joiningLocked
      if (stateChanged || command.change.kind !== 'none') {
        const committed = await this.store.commit({
          ref, expectedRevision: loaded.revision, operationId, at: new Date().toISOString(), change: command.change,
          ...(stateChanged ? { state: {
            value: command.loaded.room.state, status: command.loaded.room.status,
            nextStateVersion: Math.max(command.loaded.room.stateVersion, command.initial.stateVersion + 1),
            joiningLocked: command.loaded.room.joiningLocked,
          } } : {}),
        })
        Object.assign(command.loaded.room, committed.room)
      }
      for (const effect of command.effects) this.publish(effect)
      return output
    })
    const tail = result.catch(() => undefined)
    this.tails.set(roomId, tail)
    void tail.then(() => { if (this.tails.get(roomId) === tail) this.tails.delete(roomId) })
    return result
  }
  async drain(): Promise<void> { this.stopping = true; await Promise.all(this.tails.values()) }
  async create(packId: string, settings: GameSettings, codeLength: number) {
    const hostToken = createToken()
    const loaded = await this.store.create(packId, settings, hashToken(hostToken), codeLength, createId())
    return { room: loaded.room, hostToken }
  }
  async getById(id: string): Promise<RoomRecord | undefined> {
    const context = this.commands.getStore()
    if (context?.loaded.ref.id === id) return context.loaded.room
    const ref = await this.store.resolveId(id)
    return ref ? (await this.store.load(ref)).room : undefined
  }
  async getByCode(code: string): Promise<RoomRecord | undefined> {
    const context = this.commands.getStore()
    if (context?.loaded.ref.code === code.trim().toUpperCase()) return context.loaded.room
    const ref = await this.store.resolveCode(code)
    return ref ? (await this.store.load(ref)).room : undefined
  }
  isHost(room: RoomRecord, token: string): boolean { return tokenMatches(token, room.hostTokenHash) }
  async join(room: RoomRecord, nickname: string, teamName?: string) {
    return this.runRoom(room.id, async () => {
      const current = this.current().room
      if (current.joiningLocked || current.status === 'finished' || current.status === 'abandoned')
        throw new Error('This room is not accepting players')
      const players = await this.scores(current.id)
      if (players.length >= 50) throw new Error('This room is full')
      const teams = current.settings.teams ?? []
      const canonicalTeam = teams.find((team) => team.toLocaleLowerCase() === teamName?.trim().toLocaleLowerCase())
      if (teams.length && !canonicalTeam) throw new Error('Choose a valid team')
      const reconnectToken = createToken(), now = new Date().toISOString()
      const player: PlayerRecord = { id: createId(), roomId: room.id, nickname, teamName: canonicalTeam ?? null,
        reconnectTokenHash: hashToken(reconnectToken), connected: true, kicked: false, joinedAt: now, lastSeenAt: now }
      this.setChange({ kind: 'join', player })
      return { player, reconnectToken }
    })
  }
  async reconnect(room: RoomRecord, playerId: string, token: string): Promise<PlayerRecord | undefined> {
    return this.runRoom(room.id, async () => {
      const current = this.current()
      if (current.room.status === 'finished' || current.room.status === 'abandoned')
        throw new DomainError('room_ended', 'This session has ended')
      const player = await this.store.loadPlayer(current.ref, playerId)
      if (!player || !tokenMatches(token, player.reconnectTokenHash)) return undefined
      if (player.kicked) throw new DomainError('player_kicked', 'You were removed from this room by the host.')
      this.setChange({ kind: 'connection', playerId, connected: true })
      return { ...player, connected: true }
    })
  }
  async getPlayer(id: string): Promise<PlayerRecord | undefined> {
    const context = this.commands.getStore()
    if (!context) return this.store.findPlayer(id)
    if (context.change.kind === 'join' && context.change.player.id === id) return context.change.player
    const player = await this.store.loadPlayer(context.loaded.ref, id)
    if (!player) return undefined
    if (context.change.kind === 'kick' && context.change.playerId === id) return { ...player, kicked: true, connected: false }
    return player
  }
  async recoverSeat(room: RoomRecord, playerId: string, reconnectToken: string): Promise<PlayerRecord> {
    return this.runRoom(room.id, async () => {
      const current = this.current()
      if (current.ref.generation !== room.ref.generation) throw new DomainError('not_found', 'Room has been replaced')
      if (current.room.status === 'finished' || current.room.status === 'abandoned')
        throw new DomainError('room_ended', 'This session has ended')
      const player = await this.store.loadPlayer(current.ref, playerId)
      if (!player || player.kicked) throw new DomainError('invalid_identity', 'This seat cannot be recovered')
      if (player.connected) {
        if (tokenMatches(reconnectToken, player.reconnectTokenHash)) return player
        throw new DomainError('seat_connected', 'This player is already connected')
      }
      const reconnectTokenHash = hashToken(reconnectToken)
      this.setChange({ kind: 'recover', playerId, reconnectTokenHash })
      return { ...player, connected: true, reconnectTokenHash }
    })
  }
  private async ref(roomId: string): Promise<RoomRef> {
    const context = this.commands.getStore()
    const ref = context?.loaded.ref.id === roomId ? context.loaded.ref : await this.store.resolveId(roomId)
    if (!ref) throw new Error('Room not found')
    return ref
  }
  async listPlayers(roomId: string): Promise<PlayerRecord[]> {
    const players = await this.store.listPlayers(await this.ref(roomId))
    const change = this.commands.getStore()?.change
    if (change?.kind === 'join') return [...players, change.player]
    if (change?.kind === 'kick') return players.filter(({ id }) => id !== change.playerId)
    return players
  }
  async scores(roomId: string): Promise<PlayerScore[]> {
    const context = this.commands.getStore()
    const scores = context?.loaded.ref.id === roomId ? context.loaded.activeScores : (await this.store.load(await this.ref(roomId))).activeScores
    const change = context?.change
    if (change?.kind === 'join') return [...scores, { playerId: change.player.id, nickname: change.player.nickname,
      teamName: change.player.teamName, connected: true, score: 0 }]
    if (change?.kind === 'kick') return scores.filter(({ playerId }) => playerId !== change.playerId)
    if (change?.kind === 'connection' || change?.kind === 'recover')
      return scores.map((score) => score.playerId === change.playerId
        ? { ...score, connected: change.kind === 'recover' || change.connected } : score)
    if (change?.kind === 'settle') return change.result.activeScores
    const awards = change?.kind === 'invalidate' ? change.awards : change?.kind === 'adjustment' ? [change.award] : []
    return scores.map((score) => ({ ...score, score: score.score + awards.filter(({ playerId }) => playerId === score.playerId).reduce((sum, award) => sum + award.delta, 0) }))
  }
  async setConnected(playerId: string, connected: boolean): Promise<void> {
    const player = await this.getPlayer(playerId)
    if (player) await this.runRoom(player.roomId, async () => this.setChange({ kind: 'connection', playerId, connected }))
  }
  async setJoiningLocked(roomId: string, locked: boolean): Promise<void> {
    await this.runRoom(roomId, async () => { this.current().room.joiningLocked = locked })
  }
  async kickPlayer(roomId: string, playerId: string): Promise<boolean> {
    return this.runRoom(roomId, async () => {
      const player = await this.getPlayer(playerId)
      if (!player) return false
      this.setChange({ kind: 'kick', playerId })
      return true
    })
  }
  async saveState(roomId: string, state: RoomState, status: RoomRecord['status'], expectedVersion: number): Promise<RoomRecord> {
    return this.runRoom(roomId, async () => {
      const current = this.current()
      if (current.room.stateVersion !== expectedVersion) throw new Error('Room state changed; refresh and try again')
      current.room = { ...current.room, state, status, stateVersion: expectedVersion + 1 }
      return current.room
    })
  }
  async pauseActiveRooms(): Promise<number> {
    await this.store.disconnectAll()
    let count = 0
    do {
      const page = await this.store.interrupted({ limit: 100 })
      if (!page.items.length) break
      for (const ref of page.items) await this.runRoom(ref.id, async () => {
        const room = this.current().room
        const deadline = room.state.deadline ? Date.parse(room.state.deadline) : undefined
        await this.saveState(room.id, { ...room.state, phase: 'PAUSED', previousPhase: room.state.phase,
          window: (room.state.window ?? 0) + 1, remainingMs: deadline === undefined ? undefined : Math.max(0, deadline - Date.now()),
          deadline: undefined }, 'paused', room.stateVersion)
        count++
      })
    } while (true)
    return count
  }
}
