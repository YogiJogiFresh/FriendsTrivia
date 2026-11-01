import { createId } from '../ids.js'
import { MAX_AUDIO_BYTES } from '../content.js'
import { DomainError, type MediaAsset, type MediaCleanup, type MediaDeletion, type MediaInput,
  type MediaOwner, type MediaStore, type PageRequest, type UploadReservation } from '../domain.js'
import { conflict, digest, document, etag, LIBRARY_PK, now, pages, remove, replace,
  type CosmosAccess, type Document, type Write } from './cosmosIo.js'

export const SONG_QUOTA_BYTES = 5_000_000_000
interface Quota extends Document { liveBytes: number; reservedBytes: number }
interface AssetDoc extends Document { asset: MediaAsset; refCount: number; deletion: MediaDeletion | null }
interface UploadDoc extends Document { reservation: UploadReservation }
interface ClaimDoc extends Document { ownerKey: string; mediaId: string }
interface UploadReceipt extends Document { asset: MediaAsset; payload: string }
interface OperationHold extends Document { owner: { kind: 'operation'; id: string }; ownedKeys: string[]; published: boolean }
export const ownerKey = (owner: MediaOwner) => digest(owner)
const assetId = (id: string) => `media:${id}`
const uploadId = (id: string) => `upload:${digest(id)}`
const claimId = (owner: MediaOwner, id: string) => `claim:${ownerKey(owner)}:${id}`
const operationId = (owner: MediaOwner) => `operation:${ownerKey(owner)}`
function bytes(value: number): void {
  if (!Number.isSafeInteger(value) || value < 0) throw new DomainError('conflict', 'Invalid media byte size')
}
export class CosmosMedia implements MediaStore {
  constructor(readonly access: CosmosAccess) {}
  private async atomic<T>(action: () => Promise<T>): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      try { return await action() } catch (error) {
        if (!conflict(error) || attempt >= 4) throw error
        await new Promise((resolve) => setTimeout(resolve, 5 * (attempt + 1)))
      }
    }
  }
  async initialize(): Promise<void> {
    if (await this.access.read<Quota>(LIBRARY_PK, 'quota')) return
    const existing = await this.access.query<Document>({ pk: LIBRARY_PK, filters: [
      { field: 'kind', op: 'IN', value: ['media', 'upload'] },
    ] }, { limit: 1 })
    if (existing.items.length) throw new DomainError('unavailable', 'Media quota is missing from an existing cloud library')
    try { await this.access.batch(LIBRARY_PK, [{ type: 'create', doc: document(LIBRARY_PK, 'quota', 'quota', { liveBytes: 0, reservedBytes: 0 }) }]) }
    catch (error) { if (!conflict(error)) throw error }
  }
  private async quota(): Promise<Quota> {
    const quota = await this.access.read<Quota>(LIBRARY_PK, 'quota')
    if (!quota) throw new DomainError('unavailable', 'Cosmos media quota is missing')
    bytes(quota.liveBytes); bytes(quota.reservedBytes)
    return quota
  }
  async list(request?: PageRequest) {
    const result = await this.access.query<AssetDoc>({ pk: LIBRARY_PK, filters: [{ field: 'kind', value: 'media' }, { field: 'deletion', value: null }] }, request)
    return { ...result, items: result.items.map(({ asset }) => asset) }
  }
  async get(id: string) {
    const doc = await this.access.read<AssetDoc>(LIBRARY_PK, assetId(id))
    return doc && !doc.deletion ? doc.asset : undefined
  }
  async findByPath(path: string) {
    const result = await this.access.query<AssetDoc>({ pk: LIBRARY_PK, filters: [
      { field: 'kind', value: 'media' }, { field: 'asset.relativePath', value: path },
    ] }, { limit: 1 })
    return result.items[0]?.asset
  }
  async createIfMissing(_input: MediaInput): Promise<MediaAsset> {
    throw new DomainError('conflict', 'Cloud media must be uploaded through a quota reservation')
  }
  async reserveUpload(operationId: string, ownedKeys: string[]): Promise<UploadReservation> {
    if (!ownedKeys.length || new Set(ownedKeys).size !== ownedKeys.length ||
      ownedKeys.some((key) => !/^songs[\\/][a-zA-Z0-9._-]+$/.test(key)))
      throw new DomainError('conflict', 'Invalid upload ownership')
    return this.atomic(async () => {
      const id = uploadId(operationId)
      const existing = await this.access.read<UploadDoc>(LIBRARY_PK, id)
      if (existing) {
        if (digest(existing.reservation.ownedKeys) !== digest(ownedKeys)) throw new DomainError('conflict', 'Operation ID reused')
        return existing.reservation
      }
      if (await this.access.read(LIBRARY_PK, `uploaded:${digest(operationId)}`))
        throw new DomainError('conflict', 'Upload operation is already completed')
      const reservation = { id: operationId, operationId, ownedKeys: [...ownedKeys], reservedBytes: 0 }
      const quota = await this.quota()
      await this.access.batch(LIBRARY_PK, [
        replace(quota), { type: 'create', doc: document(LIBRARY_PK, id, 'upload', { reservation }) },
      ])
      return reservation
    })
  }
  async growReservation(reservation: UploadReservation, totalBytes: number): Promise<UploadReservation> {
    bytes(totalBytes)
    return this.atomic(async () => {
      const upload = await this.access.read<UploadDoc>(LIBRARY_PK, uploadId(reservation.id))
      if (!upload) throw new DomainError('not_found', 'Upload reservation not found')
      if (upload.reservation.operationId !== reservation.operationId || digest(upload.reservation.ownedKeys) !== digest(reservation.ownedKeys))
        throw new DomainError('conflict', 'Upload ownership changed')
      const delta = Math.max(upload.reservation.reservedBytes, totalBytes) - upload.reservation.reservedBytes
      const quota = await this.quota()
      if (quota.liveBytes + quota.reservedBytes + delta > SONG_QUOTA_BYTES)
        throw new DomainError('quota_exceeded', 'Cloud songs exceed the 5,000,000,000 byte quota')
      const next = { ...upload.reservation, reservedBytes: upload.reservation.reservedBytes + delta }
      await this.access.batch(LIBRARY_PK, [
        replace({ ...quota, reservedBytes: quota.reservedBytes + delta }), replace({ ...upload, reservation: next }),
      ])
      return next
    })
  }
  async commitUploaded(reservation: UploadReservation, input: MediaInput, actualBytes: number, owner?: MediaOwner): Promise<MediaAsset> {
    bytes(actualBytes)
    if (actualBytes > MAX_AUDIO_BYTES) throw new DomainError('conflict', 'Audio file exceeds the 50 MB limit')
    const receiptId = `uploaded:${digest(reservation.operationId)}`
    const payload = digest({ input, actualBytes, owner })
    const receipt = async () => {
      const committed = await this.access.read<UploadReceipt>(LIBRARY_PK, receiptId)
      if (committed && committed.payload !== payload) throw new DomainError('conflict', 'Operation ID reused')
      return committed?.asset
    }
    const prior = await receipt()
    if (prior) return prior
    try {
      return await this.atomic(async () => {
        const prior = await receipt()
        if (prior) return prior
        const upload = await this.access.read<UploadDoc>(LIBRARY_PK, uploadId(reservation.id))
        if (!upload) throw new DomainError('not_found', 'Upload reservation not found')
        // A reservation owns one committed object; multi-key reservations are cleanup journals.
        if (upload.reservation.ownedKeys.length !== 1 || !upload.reservation.ownedKeys.includes(input.relativePath) ||
          actualBytes > upload.reservation.reservedBytes || upload.reservation.operationId !== reservation.operationId)
          throw new DomainError('conflict', 'Upload does not match its reservation')
        const asset: MediaAsset = { ...input, id: createId(), sizeBytes: actualBytes, durationSeconds: null, createdAt: now() }
        const quota = await this.quota()
        const writes: Write[] = [
          replace({ ...quota, liveBytes: quota.liveBytes + actualBytes, reservedBytes: quota.reservedBytes - upload.reservation.reservedBytes }),
          remove(upload),
          { type: 'create', doc: document(LIBRARY_PK, assetId(asset.id), 'media', { asset, refCount: owner ? 1 : 0, deletion: null }) },
          { type: 'create', doc: document(LIBRARY_PK, receiptId, 'uploaded', { asset, payload }) },
        ]
        if (owner) {
          writes.push({ type: 'create', doc: document(LIBRARY_PK, claimId(owner, asset.id), 'claim', { ownerKey: ownerKey(owner), mediaId: asset.id }) })
          if (owner.kind === 'operation') {
            const existing = await this.access.read<OperationHold>(LIBRARY_PK, operationId(owner))
            if (existing?.published) throw new DomainError('conflict', 'Media operation is already completed')
            const hold = document(LIBRARY_PK, operationId(owner), 'operationHold', {
              owner, ownedKeys: [...(existing?.ownedKeys ?? []), asset.relativePath], published: false,
            })
            writes.push(existing ? { type: 'replace', doc: hold, etag: etag(existing) } : { type: 'create', doc: hold })
          }
        }
        await this.access.batch(LIBRARY_PK, writes)
        return asset
      })
    } catch (error) { const committed = await receipt(); if (committed) return committed; throw error }
  }
  async abortUpload(reservation: UploadReservation, deletedKeys: string[]): Promise<void> {
    await this.atomic(async () => {
      const upload = await this.access.read<UploadDoc>(LIBRARY_PK, uploadId(reservation.id))
      if (!upload) return
      if (upload.reservation.operationId !== reservation.operationId ||
        !upload.reservation.ownedKeys.every((key) => deletedKeys.includes(key)))
        throw new DomainError('conflict', 'Upload cleanup is incomplete')
      const quota = await this.quota()
      await this.access.batch(LIBRARY_PK, [
        replace({ ...quota, reservedBytes: quota.reservedBytes - upload.reservation.reservedBytes }), remove(upload),
      ])
    })
  }
  async claim(owner: MediaOwner, ids: string[]): Promise<void> {
    for (const id of new Set(ids)) await this.atomic(async () => {
      const claim = await this.access.read<ClaimDoc>(LIBRARY_PK, claimId(owner, id))
      if (claim) return
      const asset = await this.access.read<AssetDoc>(LIBRARY_PK, assetId(id))
      if (!asset || asset.deletion) throw new DomainError('media_referenced', 'Media is missing or being deleted')
      await this.access.batch(LIBRARY_PK, [
        replace({ ...asset, refCount: asset.refCount + 1 }),
        { type: 'create', doc: document(LIBRARY_PK, claimId(owner, id), 'claim', { ownerKey: ownerKey(owner), mediaId: id }) },
      ])
    })
  }
  async releaseClaims(owner: MediaOwner, request?: PageRequest): Promise<{ done: boolean }> {
    // Always consume the first page, because removing items invalidates offset continuations.
    const result = await this.access.query<ClaimDoc>({ pk: LIBRARY_PK, filters: [
      { field: 'kind', value: 'claim' }, { field: 'ownerKey', value: ownerKey(owner) },
    ] }, { limit: request?.limit ?? 100 })
    for (const item of result.items) await this.atomic(async () => {
      const claim = await this.access.read<ClaimDoc>(LIBRARY_PK, item.id)
      if (!claim) return
      const asset = await this.access.read<AssetDoc>(LIBRARY_PK, assetId(claim.mediaId))
      if (!asset || asset.refCount < 1) throw new DomainError('unavailable', 'Media reference count is inconsistent')
      await this.access.batch(LIBRARY_PK, [replace({ ...asset, refCount: asset.refCount - 1 }), remove(claim)])
    })
    const done = !(await this.access.query<ClaimDoc>({ pk: LIBRARY_PK, filters: [
      { field: 'kind', value: 'claim' }, { field: 'ownerKey', value: ownerKey(owner) },
    ] }, { limit: 1 })).items.length
    if (done && owner.kind === 'operation') {
      const hold = await this.access.read<OperationHold>(LIBRARY_PK, operationId(owner))
      // Failed imports retain this journal through the release-before-cleanup crash window.
      if (hold?.published) await this.access.batch(LIBRARY_PK, [remove(hold)])
    }
    return { done }
  }
  async completeOperation(owner: { kind: 'operation'; id: string }): Promise<void> {
    await this.atomic(async () => {
      const hold = await this.access.read<OperationHold>(LIBRARY_PK, operationId(owner))
      if (!hold) return
      const claims = await this.access.query<ClaimDoc>({ pk: LIBRARY_PK, filters: [
        { field: 'kind', value: 'claim' }, { field: 'ownerKey', value: ownerKey(owner) },
      ] }, { limit: 1 })
      await this.access.batch(LIBRARY_PK, [claims.items.length ? replace({ ...hold, published: true }) : remove(hold)])
    })
  }
  async publicationWrite(owner: { kind: 'operation'; id: string }): Promise<Write | undefined> {
    const hold = await this.access.read<OperationHold>(LIBRARY_PK, operationId(owner))
    return hold ? replace({ ...hold, published: true }) : undefined
  }
  async releaseAll(owner: MediaOwner): Promise<void> {
    while (!(await this.releaseClaims(owner)).done) { /* Each page releases durable claims. */ }
  }
  async beginDelete(id: string, operationId: string): Promise<MediaDeletion | undefined> {
    return this.atomic(async () => {
      const asset = await this.access.read<AssetDoc>(LIBRARY_PK, assetId(id))
      if (!asset) return undefined
      if (asset.deletion) return asset.deletion
      if (asset.refCount) throw new DomainError('media_referenced', 'This song is referenced by a pack or saved room')
      const ticket = { id, operationId, asset: asset.asset }
      await this.access.batch(LIBRARY_PK, [replace({ ...asset, deletion: ticket })])
      return ticket
    })
  }
  async finishDelete(ticket: MediaDeletion, confirmedAbsent: boolean): Promise<void> {
    if (!confirmedAbsent) throw new DomainError('conflict', 'Media object still exists')
    await this.atomic(async () => {
      const asset = await this.access.read<AssetDoc>(LIBRARY_PK, assetId(ticket.id))
      if (!asset) return
      if (!asset.deletion || digest(asset.deletion) !== digest(ticket)) throw new DomainError('conflict', 'Media deletion ownership changed')
      const quota = await this.quota()
      await this.access.batch(LIBRARY_PK, [replace({ ...quota, liveBytes: quota.liveBytes - asset.asset.sizeBytes }), remove(asset)])
    })
  }
  async pendingCleanup(request?: PageRequest) {
    const result = await this.access.query<UploadDoc | AssetDoc | OperationHold>({ pk: LIBRARY_PK, filters: [
      { field: 'kind', op: 'IN', value: ['upload', 'media', 'operationHold'] },
    ] }, request)
    const items: MediaCleanup[] = []
    for (const doc of result.items) {
      if ('reservation' in doc) items.push({ kind: 'upload', reservation: doc.reservation })
      else if ('owner' in doc) items.push({ kind: 'operation', owner: doc.owner, ownedKeys: doc.ownedKeys, published: doc.published })
      else if (doc.deletion) items.push({ kind: 'delete', ticket: doc.deletion })
    }
    return { ...result, items }
  }
  async verifyQuota(): Promise<void> {
    const quota = await this.quota()
    if (quota.liveBytes + quota.reservedBytes > SONG_QUOTA_BYTES)
      throw new DomainError('unavailable', 'Cosmos media quota is inconsistent')
    // Do not release reservations here: Blob absence must be confirmed by storage recovery.
    let liveBytes = 0, reservedBytes = 0
    for await (const doc of pages<AssetDoc>(this.access, { pk: LIBRARY_PK, filters: [{ field: 'kind', value: 'media' }] })) {
      if (!Number.isSafeInteger(doc.refCount) || doc.refCount < 0) throw new DomainError('unavailable', 'Cosmos media claims are inconsistent')
      bytes(doc.asset.sizeBytes)
      liveBytes += doc.asset.sizeBytes
    }
    for await (const doc of pages<UploadDoc>(this.access, { pk: LIBRARY_PK, filters: [{ field: 'kind', value: 'upload' }] })) {
      bytes(doc.reservation.reservedBytes)
      reservedBytes += doc.reservation.reservedBytes
    }
    if (quota.liveBytes !== liveBytes || quota.reservedBytes !== reservedBytes)
      throw new DomainError('unavailable', 'Cosmos media quota does not match durable ownership')
  }
}
