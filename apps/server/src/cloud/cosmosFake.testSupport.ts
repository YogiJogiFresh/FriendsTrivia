import type { Page, PageRequest } from '../domain.js'
import { CosmosFailure, pageLimit, retry, validateBatch, validateDocument,
  type CosmosAccess, type Document, type Query, type Write } from './cosmosIo.js'

function field(doc: Document, name: string): unknown {
  return name.split('.').reduce<unknown>((value, key) =>
    typeof value === 'object' && value !== null ? Reflect.get(value, key) : undefined, doc)
}
// Offline SDK-seam fake only: no Azure requests and no claim of Cosmos service conformance.
export class FakeCosmos implements CosmosAccess {
  readonly documents = new Map<string, Document>()
  readonly batches: Array<{ pk: string; writes: Write[]; bytes: number }> = []
  revision = 0
  fail: { code: number; after?: boolean; when?: (writes: Write[]) => boolean } | undefined
  beforeBatch: ((writes: Write[]) => Promise<void>) | undefined
  private key(pk: string, id: string) { return JSON.stringify([pk, id]) }
  async read<T extends Document>(pk: string, id: string): Promise<T | undefined> {
    const doc = this.documents.get(this.key(pk, id))
    return doc ? validateDocument(structuredClone(doc) as T) : undefined
  }
  async query<T extends Document>(query: Query, request?: PageRequest): Promise<Page<T>> {
    const rows = [...this.documents.values()].filter((doc) => (!query.pk || doc.pk === query.pk) &&
      query.filters.every(({ field: name, op = '=', value }) => {
        const actual = field(doc, name)
        if (op === 'IN') return Array.isArray(value) && value.some((item) => item === actual)
        if (op === '=') return actual === value
        if (op === '!=') return actual !== value
        if (typeof actual !== 'number' || typeof value !== 'number') return false
        return op === '>' ? actual > value : actual <= value
      }))
    rows.sort((a, b) => {
      for (const sort of query.order ?? []) {
        const left = field(a, sort.field), right = field(b, sort.field)
        const comparison = typeof left === 'number' && typeof right === 'number' ? left - right : String(left).localeCompare(String(right))
        if (comparison) return sort.descending ? -comparison : comparison
      }
      return a.id.localeCompare(b.id)
    })
    // Keyset cursor keeps paging stable when recovery deletes already-seen documents.
    const lastId = request?.cursor ? Buffer.from(request.cursor, 'base64url').toString() : undefined
    const start = lastId ? rows.findIndex((row) => row.id === lastId) + 1 : 0
    const offset = lastId && start === 0 ? rows.findIndex((row) => row.id > lastId) : start
    const begin = offset < 0 ? rows.length : offset
    const limit = pageLimit(request), selected = rows.slice(begin, begin + limit)
    return { items: selected.map((doc) => validateDocument(structuredClone(doc) as T)),
      ...(begin + limit < rows.length && selected.length ? { cursor: Buffer.from(selected.at(-1)!.id).toString('base64url') } : {}) }
  }
  async batch(pk: string, writes: Write[]): Promise<void> {
    validateBatch(pk, writes)
    await retry(async () => {
      if (this.beforeBatch) await this.beforeBatch(writes)
      const failure = this.fail && (!this.fail.when || this.fail.when(writes)) ? this.fail : undefined
      if (failure) this.fail = undefined
      if (failure && !failure.after) throw new CosmosFailure(failure.code)
      const next = new Map(this.documents)
      for (const write of writes) {
        const id = write.type === 'delete' ? write.id : write.doc.id, key = this.key(pk, id), current = next.get(key)
        if (write.type === 'create' && current) throw new CosmosFailure(409)
        if (write.type !== 'create' && (!current || current._etag !== write.etag)) throw new CosmosFailure(current ? 412 : 404)
        if (write.type === 'delete') next.delete(key)
        else next.set(key, { ...structuredClone(write.doc), _etag: String(++this.revision) })
      }
      this.documents.clear()
      for (const [key, value] of next) this.documents.set(key, value)
      this.batches.push({ pk, writes: structuredClone(writes), bytes: Buffer.byteLength(JSON.stringify(writes)) })
      if (failure) throw new CosmosFailure(failure.code)
    })
  }
  seed(doc: Document): void { this.documents.set(this.key(doc.pk, doc.id), { ...structuredClone(doc), _etag: String(++this.revision) }) }
}
