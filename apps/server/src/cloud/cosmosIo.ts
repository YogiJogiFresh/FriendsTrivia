import { createHash } from 'node:crypto'
import type { Container, OperationInput } from '@azure/cosmos'
import { DomainError, type Page, type PageRequest } from '../domain.js'
import { diagnosticStage, diagnosticTime } from '../diagnostics.js'

export interface Document {
  id: string
  pk: string
  kind: string
  schemaVersion: 1
  _etag?: string
}
export type Write =
  | { type: 'create'; doc: Document }
  | { type: 'replace'; doc: Document; etag: string }
  | { type: 'delete'; id: string; etag: string }
export interface Filter { field: string; op?: '=' | '!=' | '<=' | '>' | 'IN'; value: string | number | boolean | null | Array<string | number> }
export interface Query {
  pk?: string
  filters: Filter[]
  order?: Array<{ field: string; descending?: boolean }>
}
// This is the SDK seam used by offline tests, not an alternate persistence implementation.
export interface CosmosAccess {
  read<T extends Document>(pk: string, id: string): Promise<T | undefined>
  query<T extends Document>(query: Query, page?: PageRequest): Promise<Page<T>>
  batch(pk: string, writes: Write[]): Promise<void>
}
export const LIBRARY_PK = 'media-control'
export const MAX_BATCH_BYTES = 1_048_576
export const MAX_ITEM_BYTES = 900_000
export const now = () => new Date().toISOString()
export const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex')
export function document<T extends object>(pk: string, id: string, kind: string, fields: T): Document & T {
  return { ...fields, pk, id, kind, schemaVersion: 1 }
}
export function etag(doc: Document): string {
  if (!doc._etag) throw new DomainError('unavailable', 'Cosmos response has no revision')
  return doc._etag
}
export const replace = <T extends Document>(doc: T): Write => ({ type: 'replace', doc, etag: etag(doc) })
export const remove = (doc: Document): Write => ({ type: 'delete', id: doc.id, etag: etag(doc) })
export function validateDocument<T extends Document>(doc: T): T {
  if (doc.schemaVersion !== 1) throw new DomainError('unsupported_version', 'Unsupported Cosmos document version')
  return doc
}
export function validateBatch(pk: string, writes: Write[]): void {
  if (!writes.length || writes.length > 100) throw new DomainError('conflict', 'Cosmos batch must contain 1 to 100 operations')
  for (const write of writes) {
    if (write.type !== 'delete' && (write.doc.pk !== pk || Buffer.byteLength(JSON.stringify(write.doc)) > MAX_ITEM_BYTES))
      throw new DomainError('conflict', 'Cosmos item exceeds its partition or payload limit')
  }
  if (Buffer.byteLength(JSON.stringify(writes)) + writes.length * 256 > MAX_BATCH_BYTES)
    throw new DomainError('conflict', 'Cosmos batch payload is too large')
}
export function status(error: unknown): number | undefined {
  if (typeof error !== 'object' || error === null) return undefined
  const value = 'code' in error ? error.code : 'statusCode' in error ? error.statusCode : undefined
  return typeof value === 'number' ? value : typeof value === 'string' && /^\d+$/.test(value) ? Number(value) : undefined
}
export class CosmosFailure extends Error {
  constructor(readonly code: number, message = 'Cosmos request failed') { super(message) }
}
export function conflict(error: unknown): boolean { return [409, 412].includes(status(error) ?? 0) }
export function unavailable(error: unknown): never {
  if (error instanceof DomainError) throw error
  if (conflict(error)) throw new DomainError('conflict', 'Stored data changed; refresh and try again')
  throw new DomainError('unavailable', 'Cosmos request failed; no local fallback is available')
}
export async function retry<T>(action: () => Promise<T>): Promise<T> {
  const started = Date.now()
  for (let attempt = 0; ; attempt++) {
    try { return await action() } catch (error) {
      if (status(error) !== 429 || attempt >= 4 || Date.now() - started > 4_000) throw error
      const retryMs = typeof error === 'object' && error !== null && 'retryAfterInMs' in error && typeof error.retryAfterInMs === 'number'
        ? error.retryAfterInMs : 50 * 2 ** attempt
      if (retryMs > 1_000 || Date.now() - started + retryMs > 5_000) throw error
      await diagnosticTime('cosmos_retry_wait', () => new Promise((resolve) => setTimeout(resolve, Math.max(10, retryMs))))
    }
  }
}
export function pageLimit(request?: PageRequest): number {
  const limit = request?.limit ?? 100
  if (!Number.isSafeInteger(limit) || limit < 1) throw new DomainError('conflict', 'Invalid page limit')
  return Math.min(100, limit)
}
export async function* pages<T extends Document>(access: CosmosAccess, query: Query): AsyncGenerator<T> {
  let cursor: string | undefined
  do {
    const result = await access.query<T>(query, { limit: 100, ...(cursor ? { cursor } : {}) })
    for (const item of result.items) yield item
    cursor = result.cursor
  } while (cursor)
}
export async function writeChunks(access: CosmosAccess, pk: string, docs: Document[]): Promise<void> {
  let writes: Write[] = [], bytes = 0
  for (const doc of docs) {
    const size = Buffer.byteLength(JSON.stringify(doc)) + 512
    if (writes.length && (writes.length >= 90 || bytes + size > MAX_BATCH_BYTES - 1024)) {
      await access.batch(pk, writes); writes = []; bytes = 0
    }
    writes.push({ type: 'create', doc }); bytes += size
  }
  if (writes.length) await access.batch(pk, writes)
}
export class SdkCosmosAccess implements CosmosAccess {
  constructor(private readonly container: Container) {}
  async read<T extends Document>(pk: string, id: string): Promise<T | undefined> {
    try {
      const response = await retry(() => diagnosticTime('cosmos_read', () => this.container.item(id, pk).read<T>()))
      diagnosticStage('cosmos_ru', 0, response.requestCharge)
      return response.resource ? validateDocument(response.resource) : undefined
    } catch (error) { if (status(error) === 404) return undefined; throw error }
  }
  async query<T extends Document>(query: Query, request?: PageRequest): Promise<Page<T>> {
    const parameters = query.filters.map((filter, index) => ({ name: `@p${index}`, value: filter.value }))
    const field = (name: string) => {
      if (!/^[a-zA-Z][a-zA-Z0-9_]*(\.[a-zA-Z][a-zA-Z0-9_]*)*$/.test(name)) throw new Error('Invalid internal query field')
      return `c.${name}`
    }
    const where = query.filters.map((filter, index) => filter.op === 'IN'
      ? `ARRAY_CONTAINS(@p${index}, ${field(filter.field)})`
      : `${field(filter.field)} ${filter.op ?? '='} @p${index}`).join(' AND ')
    const order = query.order?.map((sort) => `${field(sort.field)} ${sort.descending ? 'DESC' : 'ASC'}`).join(', ')
    const iterator = this.container.items.query<T>({
      query: `SELECT * FROM c${where ? ` WHERE ${where}` : ''}${order ? ` ORDER BY ${order}` : ''}`, parameters,
    }, { enableQueryControl: true, maxItemCount: pageLimit(request), ...(query.pk ? { partitionKey: query.pk } : {}),
      ...(request?.cursor ? { continuationToken: request.cursor } : {}) })
    const fetchNext = async () => {
      const page = await diagnosticTime('cosmos_query', () => iterator.fetchNext())
      diagnosticStage('cosmos_ru', 0, page.requestCharge)
      return page
    }
    let response = await retry(fetchNext), emptyPages = 0
    while (response.resources?.length === 0 && response.hasMoreResults) {
      if (++emptyPages >= 100) throw new CosmosFailure(503, 'Cosmos query returned too many empty pages')
      response = await retry(fetchNext)
    }
    // Empty cross-partition ordered feeds can terminate without a resources array.
    if (response.resources === undefined) {
      if (response.hasMoreResults !== false || response.continuationToken)
        throw new CosmosFailure(503, 'Cosmos query returned an incomplete page')
      return { items: [] }
    }
    return { items: response.resources.map(validateDocument), ...(response.continuationToken ? { cursor: response.continuationToken } : {}) }
  }
  async batch(pk: string, writes: Write[]): Promise<void> {
    validateBatch(pk, writes)
    const operations: OperationInput[] = writes.map((write): OperationInput => {
      if (write.type === 'delete') {
        // The SDK serializes ifMatch, although its DeleteOperationInput declaration omits it.
        const operation: OperationInput & { ifMatch: string } = { operationType: 'Delete', id: write.id, ifMatch: write.etag }
        return operation
      }
      const { _etag: _revision, ...body } = write.doc
      return write.type === 'create' ? { operationType: 'Create', resourceBody: body }
        : { operationType: 'Replace', id: body.id, resourceBody: body, ifMatch: write.etag }
    })
    const response = await retry(() => diagnosticTime('cosmos_batch', () => this.container.items.batch(operations, pk)))
    const failed = response.result?.find((result) => result.statusCode >= 400 && result.statusCode !== 424) ??
      response.result?.find((result) => result.statusCode >= 400)
    if (failed) throw new CosmosFailure(failed.statusCode)
    const code = response.code ?? 503
    if (code >= 400 || !response.result || response.result.length !== operations.length)
      throw new CosmosFailure(code >= 400 ? code : 503)
  }
}
