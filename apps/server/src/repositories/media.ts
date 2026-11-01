import type { MediaDeletion, MediaInput, MediaOwner, MediaStore, PageRequest, UploadReservation } from '../domain.js'
import { domainFrom, type DomainSource } from '../sqliteStore.js'
import { createId } from '../ids.js'
export type { MediaAsset } from '../domain.js'

export class MediaRepository {
  private readonly store: MediaStore
  constructor(source: DomainSource | MediaStore) { this.store = 'reserveUpload' in source ? source : domainFrom(source).media }
  async list() { return (await this.store.list()).items }
  get(id: string) { return this.store.get(id) }
  findByPath(path: string) { return this.store.findByPath(path) }
  createIfMissing(input: MediaInput) { return this.store.createIfMissing(input) }
  async create(input: MediaInput) {
    const reservation = await this.reserveUpload(createId(), [input.relativePath])
    const grown = await this.growReservation(reservation, input.sizeBytes)
    return this.commitUploaded(grown, input, input.sizeBytes)
  }
  async remove(id: string) {
    const ticket = await this.beginDelete(id, createId())
    if (!ticket) return false
    await this.finishDelete(ticket, true)
    return true
  }
  reserveUpload(operationId: string, ownedKeys: string[]) { return this.store.reserveUpload(operationId, ownedKeys) }
  growReservation(reservation: UploadReservation, totalBytes: number) { return this.store.growReservation(reservation, totalBytes) }
  commitUploaded(reservation: UploadReservation, input: MediaInput, actualBytes: number, owner?: MediaOwner) { return this.store.commitUploaded(reservation, input, actualBytes, owner) }
  abortUpload(reservation: UploadReservation, deletedKeys: string[]) { return this.store.abortUpload(reservation, deletedKeys) }
  claim(owner: MediaOwner, ids: string[]) { return this.store.claim(owner, ids) }
  releaseClaims(owner: MediaOwner, page?: PageRequest) { return this.store.releaseClaims(owner, page) }
  completeOperation(owner: { kind: 'operation'; id: string }) { return this.store.completeOperation(owner) }
  beginDelete(id: string, operationId: string) { return this.store.beginDelete(id, operationId) }
  finishDelete(ticket: MediaDeletion, confirmedAbsent: boolean) { return this.store.finishDelete(ticket, confirmedAbsent) }
  pendingCleanup(page?: PageRequest) { return this.store.pendingCleanup(page) }
}
