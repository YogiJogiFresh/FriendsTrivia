import { createId } from '../ids.js'
import { DomainError, type MediaOwner, type PackDocument, type PackInput, type PackStore,
  type PackSummary, type PageRequest, type RoomRef } from '../domain.js'
import { CosmosMedia } from './cosmosMedia.js'
import { conflict, digest, document, etag, LIBRARY_PK, now, pages, remove, replace,
  status, writeChunks, type CosmosAccess, type Document } from './cosmosIo.js'

export interface PackHeader extends Document {
  packId: string; revision: string; metadata: Omit<PackDocument, 'categories'>
  summary: PackSummary; deleting: boolean
}
interface PackRevision extends Document {
  packId: string; revision: string; ready: boolean; metadata: Omit<PackDocument, 'categories'>
  categories: Array<{ id: string; title: string; position: number; clueIds: string[] }>
}
interface PackClue extends Document { packId: string; revision: string; categoryId: string; clue: PackDocument['categories'][number]['clues'][number] }
interface Publication extends Document { packId: string; revision: string; owner: MediaOwner }
interface PackReceipt extends Document { packId: string; revision: string; payload: string }
export interface PackPin extends Document { packId: string; revision: string; ref: RoomRef; owner: MediaOwner; ready: boolean }
const headerId = (id: string) => `pack:${id}`
const revisionId = (id: string, revision: string) => `revision:${id}:${revision}`
const clueId = (id: string, revision: string, clue: string) => `packclue:${id}:${revision}:${clue}`
export const pinId = (ref: RoomRef) => `pin:${ref.id}:${ref.generation}`
function mediaIds(pack: PackDocument): string[] {
  return [...new Set(pack.categories.flatMap((category) => category.clues.flatMap((clue) =>
    [clue.mediaAssetId, clue.revealMediaAssetId].filter((id): id is string => Boolean(id)))))]
}
function summary(pack: PackDocument): PackSummary {
  const clues = pack.categories.flatMap(({ clues }) => clues)
  return { id: pack.id, title: pack.title, description: pack.description, status: pack.status,
    categoryCount: pack.categories.length, clueCount: clues.length,
    ordinaryClueCount: clues.filter((clue) => !clue.finalQuestion).length,
    createdAt: pack.createdAt, updatedAt: pack.updatedAt }
}
export class CosmosPacks implements PackStore {
  private readonly writes = new Map<string, Promise<unknown>>()
  private serialize<T>(id: string, action: () => Promise<T>): Promise<T> {
    const result = (this.writes.get(id) ?? Promise.resolve()).then(action)
    const tail = result.catch(() => undefined)
    this.writes.set(id, tail)
    void tail.then(() => { if (this.writes.get(id) === tail) this.writes.delete(id) })
    return result
  }
  deleteRooms: (packId: string) => Promise<void> = async () => {
    throw new DomainError('unavailable', 'Room cleanup is not connected')
  }
  constructor(readonly access: CosmosAccess, readonly media: CosmosMedia) {}
  async header(id: string): Promise<PackHeader | undefined> {
    return this.access.read<PackHeader>(LIBRARY_PK, headerId(id))
  }
  async list(includeArchived = false, request?: PageRequest) {
    const result = await this.access.query<PackHeader>({ pk: LIBRARY_PK, filters: [
      { field: 'kind', value: 'pack' }, { field: 'deleting', value: false },
      ...(!includeArchived ? [{ field: 'summary.status', op: '!=' as const, value: 'archived' }] : []),
    ], order: [{ field: 'summary.updatedAt', descending: true }] }, request)
    return { ...result, items: result.items.map((doc) => doc.summary) }
  }
  async get(id: string): Promise<PackDocument | undefined> {
    const header = await this.header(id)
    return header && !header.deleting ? this.readRevision(id, header.revision) : undefined
  }
  async readRevision(id: string, revision: string): Promise<PackDocument> {
    const meta = await this.access.read<PackRevision>(LIBRARY_PK, revisionId(id, revision))
    if (!meta?.ready) throw new DomainError('unavailable', 'Pack revision is not fully published')
    const categories: PackDocument['categories'] = []
    for (const category of meta.categories) {
      const clues: PackDocument['categories'][number]['clues'] = []
      for (const id of category.clueIds) {
        const doc = await this.access.read<PackClue>(LIBRARY_PK, clueId(meta.packId, revision, id))
        if (!doc) throw new DomainError('unavailable', 'Published pack revision is incomplete')
        clues.push(doc.clue)
      }
      const { clueIds: _ids, ...fields } = category
      categories.push({ ...fields, clues })
    }
    return { ...meta.metadata, categories }
  }
  async create(input: { title: string; description?: string }, operationId: string): Promise<PackDocument> {
    const id = digest({ kind: 'pack', operationId })
    const receiptId = `packcreate:${digest(operationId)}`, payload = digest(input)
    const replay = async () => {
      const receipt = await this.access.read<PackReceipt>(LIBRARY_PK, receiptId)
      if (!receipt) return undefined
      if (receipt.payload !== payload) throw new DomainError('conflict', 'Operation ID reused')
      const pack = await this.get(receipt.packId)
      if (!pack) throw new DomainError('not_found', 'Created pack was deleted')
      return pack
    }
    const current = await replay()
    if (current) return current
    const at = now(), revision = createId()
    const pack: PackDocument = { id, revision, title: input.title, description: input.description ?? '',
      status: 'draft', defaultSettings: {}, createdAt: at, updatedAt: at, categories: [] }
    const { categories: _categories, ...metadata } = pack
    const header = document(LIBRARY_PK, headerId(id), 'pack', { packId: id, revision, metadata, summary: summary(pack), deleting: false })
    const meta = document(LIBRARY_PK, revisionId(id, revision), 'packRevision', { packId: id, revision, ready: true, metadata, categories: [] })
    try { await this.access.batch(LIBRARY_PK, [
      { type: 'create', doc: header }, { type: 'create', doc: meta },
      { type: 'create', doc: document(LIBRARY_PK, receiptId, 'packCreateReceipt', { packId: id, revision, payload }) },
    ]) }
    catch (error) { const stored = await replay(); if (stored) return stored; throw error }
    return pack
  }
  replace(id: string, input: PackInput, expectedRevision: string, operationId: string, importOwner?: { kind: 'operation'; id: string }): Promise<PackDocument | undefined> {
    return this.serialize(id, () => this.publish(id, input, expectedRevision, operationId, importOwner))
  }
  private async publish(id: string, input: PackInput, expectedRevision: string, operationId: string, importOwner?: { kind: 'operation'; id: string }): Promise<PackDocument | undefined> {
    const receiptId = `packreceipt:${digest(operationId)}`
    const payload = digest({ id, input, importOwner })
    const receipt = await this.access.read<PackReceipt>(LIBRARY_PK, receiptId)
    if (receipt) {
      if (receipt.payload !== payload) throw new DomainError('conflict', 'Operation ID reused')
      return this.get(receipt.packId)
    }
    const header = await this.header(id)
    if (!header || header.deleting) return undefined
    if (header.revision !== expectedRevision) throw new DomainError('conflict', 'Pack changed; refresh and try again')
    if (input.categories.length > 12 || input.categories.some((category) => category.clues.length > 20))
      throw new DomainError('conflict', 'Pack exceeds category or clue limits')
    const revision = createId(), owner: MediaOwner = { kind: 'pack', id, revision }
    const pack: PackDocument = {
      id, revision, title: input.title, description: input.description ?? '', status: input.status ?? 'draft',
      defaultSettings: input.defaultSettings ?? {}, createdAt: header.metadata.createdAt, updatedAt: now(),
      categories: input.categories.map((category, position) => ({
        id: category.id ?? createId(), title: category.title, position,
        clues: category.clues.map((clue, position) => ({ ...clue, id: clue.id ?? createId(), position,
          timerSeconds: clue.timerSeconds ?? 30, mediaAssetId: clue.mediaAssetId ?? null,
          revealMediaAssetId: clue.revealMediaAssetId ?? null, finalQuestion: clue.finalQuestion ?? false })),
      })),
    }
    const ids = pack.categories.flatMap((category) => [category.id, ...category.clues.map(({ id }) => id)])
    if (new Set(ids).size !== ids.length) throw new DomainError('conflict', 'Duplicate category or clue IDs')
    const publication = document(LIBRARY_PK, `publication:${id}:${revision}`, 'publication', { packId: id, revision, owner })
    const { categories, ...metadata } = pack
    const meta = document(LIBRARY_PK, revisionId(id, revision), 'packRevision', {
      packId: id, revision, ready: true, metadata,
      categories: categories.map(({ clues, ...category }) => ({ ...category, clueIds: clues.map(({ id }) => id) })),
    })
    await this.access.batch(LIBRARY_PK, [{ type: 'create', doc: publication }])
    try {
      await this.media.claim(owner, mediaIds(pack))
      await writeChunks(this.access, LIBRARY_PK, categories.flatMap((category) => category.clues.map((clue) =>
        document(LIBRARY_PK, clueId(id, revision, clue.id), 'packClue', { packId: id, revision, categoryId: category.id, clue }))))
      const adoption = importOwner ? await this.media.publicationWrite(importOwner) : undefined
      await this.access.batch(LIBRARY_PK, [
        replace({ ...header, revision, metadata, summary: summary(pack) }),
        { type: 'create', doc: meta },
        { type: 'create', doc: document(LIBRARY_PK, receiptId, 'packReceipt', { packId: id, revision, payload }) },
        ...(adoption ? [adoption] : []),
      ])
    } catch (error) {
      const committed = await this.access.read<PackReceipt>(LIBRARY_PK, receiptId)
      if (committed?.payload === payload) return this.readRevision(id, committed.revision)
      // The durable publication owns partial claims/clues until recovery succeeds.
      if (conflict(error)) throw new DomainError('conflict', 'Pack changed during publication')
      throw error
    }
    try { await this.cleanupPublications(id) }
    catch (error) {
      // Publication is already committed; the durable journal, not an import rollback, owns cleanup.
      console.error('Cosmos pack cleanup remains pending', { packId: id, revision, status: status(error) ?? 'unavailable' })
    }
    return pack
  }
  async archive(id: string): Promise<boolean> {
    const pack = await this.get(id)
    if (!pack) return false
    await this.replace(id, { ...pack, status: 'archived' }, pack.revision, createId())
    return true
  }
  pin(ref: RoomRef, packId: string): Promise<PackDocument> {
    return this.serialize(packId, () => this.pinRevision(ref, packId))
  }
  private async pinRevision(ref: RoomRef, packId: string): Promise<PackDocument> {
    const existing = await this.access.read<PackPin>(LIBRARY_PK, pinId(ref))
    if (existing?.ready) return this.readRevision(packId, existing.revision)
    const header = await this.header(packId)
    if (!header || header.deleting) throw new DomainError('not_found', 'Pack not found')
    const pack = await this.readRevision(packId, header.revision)
    if (pack.status !== 'ready' || !pack.categories.some(({ clues }) => clues.length))
      throw new DomainError('conflict', 'Pack must be marked ready and contain at least one clue')
    const owner: MediaOwner = { kind: 'room', id: ref.id, generation: ref.generation }
    const pin = existing ?? document(LIBRARY_PK, pinId(ref), 'packPin', { packId, revision: pack.revision, ref, owner, ready: false })
    if (!existing) await this.access.batch(LIBRARY_PK, [{ type: 'create', doc: pin }])
    await this.media.claim(owner, mediaIds(pack))
    const stored = (await this.access.read<PackPin>(LIBRARY_PK, pin.id))!
    await this.access.batch(LIBRARY_PK, [replace(header), replace({ ...stored, ready: true })])
    return pack
  }
  async releasePin(ref: RoomRef): Promise<void> {
    const initial = await this.access.read<PackPin>(LIBRARY_PK, pinId(ref))
    if (!initial) return
    await this.serialize(initial.packId, async () => {
      const pin = await this.access.read<PackPin>(LIBRARY_PK, pinId(ref))
      if (!pin) return
      await this.media.releaseAll(pin.owner)
      const header = await this.header(pin.packId)
      if (header?.revision !== pin.revision) {
        const remaining = await this.access.query<PackPin>({ pk: LIBRARY_PK, filters: [
          { field: 'kind', value: 'packPin' }, { field: 'packId', value: pin.packId }, { field: 'revision', value: pin.revision },
          { field: 'id', op: '!=', value: pin.id },
        ] }, { limit: 1 })
        if (!remaining.items.length) await this.removeRevision(pin.packId, pin.revision)
      }
      // Keep the pin as a durable cleanup journal until its obsolete revision/claims are gone.
      await this.access.batch(LIBRARY_PK, [remove(pin)])
    })
  }
  private async removeRevision(packId: string, revision: string): Promise<void> {
    while (true) {
      const result = await this.access.query<Document>({ pk: LIBRARY_PK, filters: [
        { field: 'packId', value: packId }, { field: 'revision', value: revision },
        { field: 'kind', op: 'IN', value: ['packClue', 'packRevision'] },
      ] }, { limit: 90 })
      if (!result.items.length) break
      await this.access.batch(LIBRARY_PK, result.items.map(remove))
    }
    await this.media.releaseAll({ kind: 'pack', id: packId, revision })
  }
  async cleanupPublications(packId?: string): Promise<void> {
    for await (const publication of pages<Publication>(this.access, { pk: LIBRARY_PK, filters: [
      { field: 'kind', value: 'publication' }, ...(packId ? [{ field: 'packId', value: packId }] : []),
    ] })) {
      const header = await this.header(publication.packId)
      if (header?.revision !== publication.revision) await this.removeRevision(publication.packId, publication.revision)
      if (header && !header.deleting) {
        for await (const revision of pages<PackRevision>(this.access, { pk: LIBRARY_PK, filters: [
          { field: 'kind', value: 'packRevision' }, { field: 'packId', value: header.packId },
          { field: 'revision', op: '!=', value: header.revision },
        ] })) {
          const pin = await this.access.query<PackPin>({ pk: LIBRARY_PK, filters: [
            { field: 'kind', value: 'packPin' }, { field: 'packId', value: header.packId }, { field: 'revision', value: revision.revision },
          ] }, { limit: 1 })
          if (!pin.items.length) await this.removeRevision(header.packId, revision.revision)
        }
      }
      await this.access.batch(LIBRARY_PK, [remove(publication)])
    }
  }
  async remove(id: string, _operationId: string): Promise<'deleted' | 'not_found'> {
    let header = await this.serialize(id, async () => {
      const current = await this.header(id)
      if (current && !current.deleting) await this.access.batch(LIBRARY_PK, [replace({ ...current, deleting: true })])
      return this.header(id)
    })
    if (!header) return 'not_found'
    await this.deleteRooms(id)
    for await (const revision of pages<PackRevision>(this.access, { pk: LIBRARY_PK, filters: [
      { field: 'kind', value: 'packRevision' }, { field: 'packId', value: id },
    ] })) await this.removeRevision(id, revision.revision)
    await this.cleanupPublications(id)
    header = await this.header(id)
    if (header) await this.access.batch(LIBRARY_PK, [remove(header)])
    return 'deleted'
  }
  async recover(): Promise<void> {
    for await (const header of pages<PackHeader>(this.access, { pk: LIBRARY_PK, filters: [
      { field: 'kind', value: 'pack' }, { field: 'deleting', value: true },
    ] })) await this.remove(header.packId, 'recovery')
    await this.cleanupPublications()
  }
}
