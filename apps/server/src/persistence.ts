import { AsyncLocalStorage } from 'node:async_hooks'

import type Database from 'better-sqlite3'

import { statements, type StatementName } from './statements.js'

type Value = string | number | null
interface Result { rows: unknown[]; changes: number }
interface Context {
  database: Persistence
  roomId?: string
  afterCommit: Array<() => void>
}
const transactions = new AsyncLocalStorage<Context>()
const adapters = new WeakMap<Database.Database, Persistence>()

export class Persistence {
  private tail: Promise<unknown> = Promise.resolve()
  private readonly roomTails = new Map<string, Promise<unknown>>()
  private closing: Promise<void> | undefined

  constructor(
    readonly sqlite?: Database.Database,
  ) {
    if (!sqlite) throw new Error('A persistence backend is required')
  }

  statement(name: StatementName) {
    const query = (...values: Value[]) => this.query(name, values)
    return {
      all: async (...values: Value[]): Promise<unknown[]> => (await query(...values)).rows,
      get: async (...values: Value[]): Promise<unknown> => (await query(...values)).rows[0],
      run: async (...values: Value[]): Promise<{ changes: number }> => {
        const result = await query(...values)
        return { changes: result.changes }
      },
    }
  }

  private async query(name: StatementName, values: Value[]): Promise<Result> {
    const context = transactions.getStore()
    if (this.sqlite && context?.database !== this) {
      return this.exclusive(() => this.querySqlite(name, values))
    }
    if (this.sqlite) return this.querySqlite(name, values)
    throw new Error('SQLite backend is required')
  }

  private querySqlite(name: StatementName, values: Value[]): Result {
    const statement = this.sqlite!.prepare(statements[name].sqlite)
    if (statement.reader) return { rows: statement.all(...values), changes: 0 }
    return { rows: [], changes: statement.run(...values).changes }
  }

  private exclusive<T>(action: () => T | Promise<T>): Promise<T> {
    const result = this.tail.then(action)
    this.tail = result.catch(() => undefined)
    return result
  }

  async transaction<T>(action: () => Promise<T>, roomId?: string): Promise<T> {
    if (transactions.getStore()?.database === this) return action()
    const execute = async () => {
      const context: Context = { database: this, afterCommit: [], ...(roomId ? { roomId } : {}) }
      let committed = false
      try {
        this.sqlite!.exec('BEGIN IMMEDIATE')
        const result = await transactions.run(context, action)
        this.sqlite!.exec('COMMIT')
        committed = true
        for (const effect of context.afterCommit) effect()
        return result
      } catch (error) {
        if (!committed) {
          this.sqlite!.exec('ROLLBACK')
        }
        throw error
      }
    }
    // SQLite is synchronous internally; the async orchestration owns its connection until commit.
    return this.exclusive(execute)
  }

  afterCommit(effect: () => void): void {
    const context = transactions.getStore()
    if (context?.database === this) context.afterCommit.push(effect)
    else effect()
  }

  serializeRoom<T>(roomId: string, action: () => Promise<T>): Promise<T> {
    const context = transactions.getStore()
    if (context?.database === this) {
      if (context.roomId !== roomId) throw new Error('Cannot mutate a different room inside a transaction')
      return action()
    }
    const previous = this.roomTails.get(roomId) ?? Promise.resolve()
    const result = previous.then(() => this.transaction(action, roomId))
    const tail = result.catch(() => undefined)
    this.roomTails.set(roomId, tail)
    void tail.then(() => {
      if (this.roomTails.get(roomId) === tail) this.roomTails.delete(roomId)
    })
    return result
  }

  close(): Promise<void> {
    this.closing ??= (async () => {
      await Promise.all(this.roomTails.values())
      await this.tail
      this.sqlite?.close()
    })()
    return this.closing
  }
}

export type DatabaseSource = Database.Database | Persistence

export function asPersistence(database: DatabaseSource): Persistence {
  if (database instanceof Persistence) return database
  let adapter = adapters.get(database)
  if (!adapter) {
    adapter = new Persistence(database)
    adapters.set(database, adapter)
  }
  return adapter
}

export function isUniqueViolation(error: unknown, sqliteFragment?: string): boolean {
  if (!(error instanceof Error)) return false
  return error.message.includes(sqliteFragment ?? 'UNIQUE constraint failed')
}
