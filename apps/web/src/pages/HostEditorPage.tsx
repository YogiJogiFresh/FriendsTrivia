import { useEffect, useRef, useState } from 'react'
import type { ChangeEvent } from 'react'
import { usePacks } from '../data/hooks'
import {
  ApiError,
  createPack,
  deleteMedia,
  deletePack,
  getMediaLibraryInfo,
  getGifProviders,
  getPack,
  importPack,
  listMedia,
  mediaStreamUrl,
  packExportUrl,
  savePack,
  uploadMedia,
} from '../lib/apiClient'
import type {
  PackInput,
  PackInputCategory,
  PackInputClue,
  ServerClueConfig,
  ServerClueType,
  ServerMediaAsset,
  ServerPackDetail,
  GifProviderStatus,
} from '../lib/apiClient'
import { Badge, Button, Card, GifPicker, TextareaField, TextField } from '../components'
import styles from './HostEditorPage.module.css'

const clueTypeOptions: Array<{ value: ServerClueType; label: string }> = [
  { value: 'music_multiple_choice', label: 'Music · Multiple choice' },
  { value: 'music_free_text', label: 'Music · Free text' },
  { value: 'price_slider', label: 'Price slider' },
]

const clueTypeLabels: Record<ServerClueType, string> = {
  music_multiple_choice: 'Music · Multiple choice',
  music_free_text: 'Music · Free text',
  price_slider: 'Price slider',
}

let localKeySeq = 0
function makeLocalKey(prefix: string): string {
  localKeySeq += 1
  return `${prefix}-local-${localKeySeq}`
}

interface EditableClue {
  /** Stable React key: the server id once saved, or a local placeholder before that. */
  key: string
  id?: string
  type: ServerClueType
  boardValue: number
  prompt: string
  timerSeconds: number
  mediaAssetId: string | null
  revealMediaAssetId: string | null
  finalQuestion: boolean
  config: ServerClueConfig
}

interface EditableCategory {
  key: string
  id?: string
  title: string
  clues: EditableClue[]
}

interface EditablePack {
  id: string
  title: string
  description: string
  status: ServerPackDetail['status']
  categories: EditableCategory[]
}

function defaultConfigForType(type: ServerClueType): ServerClueConfig {
  switch (type) {
    case 'music_multiple_choice':
      return { choices: ['', ''], correctAnswer: '' }
    case 'music_free_text':
      return { correctAnswer: '', acceptedAnswers: [] }
    case 'price_slider':
    default:
      return { min: 0, max: 100, step: 1, correctPrice: 50, prefix: '$' }
  }
}

function toEditablePack(detail: ServerPackDetail): EditablePack {
  return {
    id: detail.id,
    title: detail.title,
    description: detail.description,
    status: detail.status,
    categories: detail.categories.map((category) => ({
      key: category.id,
      id: category.id,
      title: category.title,
      clues: category.clues.map((clue) => ({
        key: clue.id,
        id: clue.id,
        type: clue.type,
        boardValue: clue.boardValue,
        prompt: clue.prompt,
        timerSeconds: clue.timerSeconds,
        mediaAssetId: clue.mediaAssetId,
        revealMediaAssetId: clue.revealMediaAssetId,
        finalQuestion: clue.finalQuestion,
        config: clue.config ?? {},
      })),
    })),
  }
}

function packInputFromState(pack: EditablePack): PackInput {
  const categories: PackInputCategory[] = pack.categories.map((category) => ({
    ...(category.id ? { id: category.id } : {}),
    title: category.title,
    clues: category.clues.map((clue): PackInputClue => ({
      ...(clue.id ? { id: clue.id } : {}),
      type: clue.type,
      boardValue: clue.boardValue,
      prompt: clue.prompt,
      timerSeconds: clue.timerSeconds,
      mediaAssetId: clue.mediaAssetId,
      revealMediaAssetId: clue.revealMediaAssetId,
      finalQuestion: clue.finalQuestion,
      config: clue.config,
    })),
  }))
  return {
    title: pack.title,
    description: pack.description,
    status: pack.status,
    categories,
  }
}

/**
 * Pack/category/clue editor. Everything here reads and writes the real pack
 * CRUD API (`lib/apiClient.ts`): the pack list on the left comes from
 * `GET /api/packs`, opening a pack loads its full detail, and "Save
 * changes" replaces the whole categories/clues tree with one `PUT`. Media
 * (songs) are uploaded once and then attached to one or more music clues by
 * id, matching the server's `mediaAssetId` model.
 */
export function HostEditorPage() {
  const { data: packs, loading: packsLoading, error: packsError, refetch: refetchPacks } = usePacks(true)
  const [selectedPackId, setSelectedPackId] = useState<string | null>(null)
  const [pack, setPack] = useState<EditablePack | null>(null)
  const [packLoading, setPackLoading] = useState(false)
  const [packLoadError, setPackLoadError] = useState<string | null>(null)
  const [selectedCategoryKey, setSelectedCategoryKey] = useState<string | null>(null)

  const [creatingPack, setCreatingPack] = useState(false)
  const [newPackTitle, setNewPackTitle] = useState('')
  const [newPackDescription, setNewPackDescription] = useState('')
  const [createError, setCreateError] = useState<string | null>(null)
  const [importError, setImportError] = useState<string | null>(null)
  const [importing, setImporting] = useState(false)
  const importInputRef = useRef<HTMLInputElement>(null)

  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState<string | null>(null)
  const [saveSuccess, setSaveSuccess] = useState(false)
  const [deletingPack, setDeletingPack] = useState(false)

  const [media, setMedia] = useState<ServerMediaAsset[] | null>(null)
  const [mediaError, setMediaError] = useState<string | null>(null)
  const [uploading, setUploading] = useState(false)
  const [deletingMediaId, setDeletingMediaId] = useState<string | null>(null)
  const [mediaDirectory, setMediaDirectory] = useState<string | null>(null)
  const [gifProviders, setGifProviders] = useState<GifProviderStatus>({
    giphy: false,
    tenor: false,
  })
  const mediaInputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (!selectedPackId) {
      setPack(null)
      return undefined
    }
    let cancelled = false
    setPackLoading(true)
    setPackLoadError(null)
    setSaveSuccess(false)
    setSaveError(null)
    getPack(selectedPackId)
      .then((detail) => {
        if (cancelled) return
        const editable = toEditablePack(detail)
        setPack(editable)
        setSelectedCategoryKey(editable.categories[0]?.key ?? null)
      })
      .catch((err: unknown) => {
        if (!cancelled) setPackLoadError(err instanceof Error ? err.message : 'Could not load this pack.')
      })
      .finally(() => {
        if (!cancelled) setPackLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [selectedPackId])

  useEffect(() => {
    if (!selectedPackId) return undefined
    let cancelled = false
    Promise.all([listMedia(), getMediaLibraryInfo(), getGifProviders()])
      .then(([assets, library, providers]) => {
        if (!cancelled) {
          setMedia(assets)
          setMediaDirectory(library.directory)
          setGifProviders(providers)
        }
      })
      .catch((err: unknown) => {
        if (!cancelled) setMediaError(err instanceof Error ? err.message : 'Could not load the media library.')
      })
    return () => {
      cancelled = true
    }
  }, [selectedPackId])

  async function handleCreatePack() {
    if (!newPackTitle.trim()) {
      setCreateError('Give your pack a title.')
      return
    }
    setCreateError(null)
    try {
      const created = await createPack({
        title: newPackTitle.trim(),
        description: newPackDescription.trim() || undefined,
      })
      setNewPackTitle('')
      setNewPackDescription('')
      setCreatingPack(false)
      refetchPacks()
      setSelectedPackId(created.id)
    } catch (err) {
      setCreateError(err instanceof ApiError ? err.message : 'Could not create the pack.')
    }
  }

  async function handleImportFile(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0]
    event.target.value = ''
    if (!file) return
    setImporting(true)
    setImportError(null)
    try {
      const text = await file.text()
      const manifest = JSON.parse(text) as unknown
      const created = await importPack(manifest)
      refetchPacks()
      setSelectedPackId(created.id)
    } catch (err) {
      setImportError(
        err instanceof ApiError
          ? err.message
          : err instanceof SyntaxError
            ? 'That file is not valid JSON.'
            : 'Could not import that pack.',
      )
    } finally {
      setImporting(false)
    }
  }

  async function handleSave() {
    if (!pack) return
    setSaving(true)
    setSaveError(null)
    setSaveSuccess(false)
    try {
      const updated = await savePack(pack.id, packInputFromState(pack))
      const editable = toEditablePack(updated)
      setPack(editable)
      setSelectedCategoryKey((current) => {
        if (current && editable.categories.some((category) => category.key === current)) return current
        return editable.categories[0]?.key ?? null
      })
      refetchPacks()
      setSaveSuccess(true)
      window.setTimeout(() => setSaveSuccess(false), 3000)
    } catch (err) {
      setSaveError(err instanceof ApiError ? err.message : 'Could not save this pack.')
    } finally {
      setSaving(false)
    }
  }

  async function handleDeletePack() {
    if (!pack) return
    if (
      !window.confirm(
        `Permanently delete "${pack.title}", all of its clues, and every live or completed game session using it? This cannot be undone.`,
      )
    ) {
      return
    }
    setDeletingPack(true)
    setSaveError(null)
    try {
      await deletePack(pack.id)
      refetchPacks()
      setSelectedPackId(null)
    } catch (err) {
      setSaveError(err instanceof ApiError ? err.message : 'Could not delete this pack.')
    } finally {
      setDeletingPack(false)
    }
  }

  async function handleUploadMedia(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0]
    event.target.value = ''
    if (!file) return
    setUploading(true)
    setMediaError(null)
    try {
      const asset = await uploadMedia(file)
      setMedia((prev) => [asset, ...(prev ?? [])])
    } catch (err) {
      setMediaError(err instanceof ApiError ? err.message : 'Could not upload that file.')
    } finally {
      setUploading(false)
    }
  }

  async function handleDeleteMedia(asset: ServerMediaAsset) {
    if (!window.confirm(`Remove "${asset.originalName}" from the media library?`)) return
    setDeletingMediaId(asset.id)
    setMediaError(null)
    try {
      await deleteMedia(asset.id)
      setMedia((current) => current?.filter((candidate) => candidate.id !== asset.id) ?? [])
      updateCategories((categories) =>
        categories.map((category) => ({
          ...category,
          clues: category.clues.map((clue) =>
            clue.mediaAssetId === asset.id || clue.revealMediaAssetId === asset.id
              ? {
                  ...clue,
                  mediaAssetId: clue.mediaAssetId === asset.id ? null : clue.mediaAssetId,
                  revealMediaAssetId:
                    clue.revealMediaAssetId === asset.id ? null : clue.revealMediaAssetId,
                }
              : clue,
          ),
        })),
      )
    } catch (err) {
      setMediaError(err instanceof ApiError ? err.message : 'Could not remove that song.')
    } finally {
      setDeletingMediaId(null)
    }
  }

  function updatePack(patch: Partial<Pick<EditablePack, 'title' | 'description' | 'status'>>) {
    setPack((prev) => (prev ? { ...prev, ...patch } : prev))
  }

  function updateCategories(mutate: (categories: EditableCategory[]) => EditableCategory[]) {
    setPack((prev) => (prev ? { ...prev, categories: mutate(prev.categories) } : prev))
  }

  function handleAddCategory() {
    const key = makeLocalKey('category')
    updateCategories((categories) => [...categories, { key, title: 'New category', clues: [] }])
    setSelectedCategoryKey(key)
  }

  function handleRenameCategory(categoryKey: string, title: string) {
    updateCategories((categories) =>
      categories.map((category) => (category.key === categoryKey ? { ...category, title } : category)),
    )
  }

  function handleDeleteCategory(categoryKey: string) {
    updateCategories((categories) => categories.filter((category) => category.key !== categoryKey))
    setSelectedCategoryKey((current) => (current === categoryKey ? null : current))
  }

  function handleAddClue(categoryKey: string) {
    updateCategories((categories) =>
      categories.map((category) => {
        if (category.key !== categoryKey) return category
        const lastValue = category.clues[category.clues.length - 1]?.boardValue ?? 0
        const type: ServerClueType = 'music_free_text'
        const newClue: EditableClue = {
          key: makeLocalKey('clue'),
          type,
          boardValue: lastValue + 100,
          prompt: '',
          timerSeconds: 30,
          mediaAssetId: null,
          revealMediaAssetId: null,
          finalQuestion: false,
          config: defaultConfigForType(type),
        }
        return { ...category, clues: [...category.clues, newClue] }
      }),
    )
  }

  function updateClue(categoryKey: string, clueKey: string, patch: Partial<EditableClue>) {
    updateCategories((categories) =>
      categories.map((category) => {
        if (category.key !== categoryKey) return category
        return {
          ...category,
          clues: category.clues.map((clue) => (clue.key === clueKey ? { ...clue, ...patch } : clue)),
        }
      }),
    )
  }

  function setFinalQuestion(clueKey: string, enabled: boolean) {
    updateCategories((categories) =>
      categories.map((category) => ({
        ...category,
        clues: category.clues.map((clue) => ({
          ...clue,
          finalQuestion: enabled ? clue.key === clueKey : clue.key === clueKey ? false : clue.finalQuestion,
        })),
      })),
    )
  }

  function handleClueTypeChange(categoryKey: string, clueKey: string, type: ServerClueType) {
    updateClue(categoryKey, clueKey, { type, config: defaultConfigForType(type), mediaAssetId: null })
  }

  function handleDeleteClue(categoryKey: string, clueKey: string) {
    updateCategories((categories) =>
      categories.map((category) =>
        category.key === categoryKey
          ? { ...category, clues: category.clues.filter((clue) => clue.key !== clueKey) }
          : category,
      ),
    )
  }

  // ---- Pack list view ----------------------------------------------------

  if (!selectedPackId) {
    const visiblePacks = packs ?? []
    return (
      <div>
        <div className={styles.panelHeader}>
          <div>
            <h1>Pack editor</h1>
            <p>Create, edit, and manage your trivia packs.</p>
          </div>
        </div>

        {packsLoading ? <p>Loading packs…</p> : null}
        {packsError ? <p role="alert">{packsError}</p> : null}

        {!packsLoading && visiblePacks.length === 0 ? (
          <Card className={styles.emptyState}>
            <h2>Build your first pack</h2>
            <p>A pack is a Jeopardy-style board: up to 12 categories, each with up to 20 clues.</p>
          </Card>
        ) : null}

        <div className={styles.packGrid}>
          {visiblePacks.map((summary) => (
            <button key={summary.id} type="button" className={styles.packCard} onClick={() => setSelectedPackId(summary.id)}>
              <span className={styles.packCardHeader}>
                <span className={styles.packTitle}>{summary.title}</span>
                <Badge tone={summary.status === 'ready' ? 'success' : summary.status === 'archived' ? 'neutral' : 'warning'}>
                  {summary.status}
                </Badge>
              </span>
              <span className={styles.packDescription}>{summary.description || 'No description yet.'}</span>
              <span className={styles.packMeta}>
                <span>{summary.categoryCount} categories</span>
                <span>{summary.clueCount} clues</span>
              </span>
            </button>
          ))}
        </div>

        <div className={styles.creatorRow}>
          {creatingPack ? (
            <Card className={styles.creatorCard}>
              <h2>New pack</h2>
              <TextField
                label="Title"
                value={newPackTitle}
                onChange={(event) => setNewPackTitle(event.target.value)}
                placeholder="e.g. 80s One-Hit Wonders"
                autoFocus
              />
              <TextareaField
                label="Description (optional)"
                value={newPackDescription}
                onChange={(event) => setNewPackDescription(event.target.value)}
                placeholder="A short blurb shown to the host when choosing a pack."
              />
              {createError ? (
                <p role="alert" className={styles.errorText}>
                  {createError}
                </p>
              ) : null}
              <div className={styles.creatorActions}>
                <Button variant="secondary" onClick={() => setCreatingPack(false)}>
                  Cancel
                </Button>
                <Button variant="primary" onClick={handleCreatePack}>
                  Create pack
                </Button>
              </div>
            </Card>
          ) : (
            <>
              <Button variant="primary" onClick={() => setCreatingPack(true)}>
                + New pack
              </Button>
              <Button variant="secondary" onClick={() => importInputRef.current?.click()} disabled={importing}>
                {importing ? 'Importing…' : 'Import pack (.json)'}
              </Button>
              <input
                ref={importInputRef}
                type="file"
                accept="application/json"
                className={styles.hiddenInput}
                onChange={handleImportFile}
              />
            </>
          )}
        </div>
        {importError ? (
          <p role="alert" className={styles.errorText}>
            {importError}
          </p>
        ) : null}
      </div>
    )
  }

  // ---- Pack detail / editor view -----------------------------------------

  if (packLoadError) {
    return (
      <Card>
        <p role="alert">{packLoadError}</p>
        <Button variant="secondary" onClick={() => setSelectedPackId(null)}>
          Back to packs
        </Button>
      </Card>
    )
  }

  if (packLoading || !pack) {
    return <p>Loading pack…</p>
  }

  const selectedCategory = pack.categories.find((category) => category.key === selectedCategoryKey) ?? null
  const musicMediaAssets = media ?? []

  return (
    <div>
      <div className={styles.panelHeader}>
        <Button variant="secondary" onClick={() => setSelectedPackId(null)}>
          ← Back to packs
        </Button>
        <div className={styles.headerActions}>
          {saveError ? (
            <span role="alert" className={styles.errorText}>
              {saveError}
            </span>
          ) : null}
          {saveSuccess ? <Badge tone="success">Saved</Badge> : null}
          <Button variant="secondary" href={packExportUrl(pack.id)} download>
            Export
          </Button>
          <Button variant="danger" onClick={handleDeletePack} disabled={deletingPack}>
            {deletingPack ? 'Deleting…' : 'Delete pack'}
          </Button>
          <Button variant="primary" onClick={handleSave} disabled={saving}>
            {saving ? 'Saving…' : 'Save changes'}
          </Button>
        </div>
      </div>

      <Card className={styles.metaCard}>
        <TextField
          label="Pack title"
          value={pack.title}
          onChange={(event) => updatePack({ title: event.target.value })}
        />
        <TextareaField
          label="Description"
          value={pack.description}
          onChange={(event) => updatePack({ description: event.target.value })}
        />
        <div className={styles.statusRow}>
          <label className={styles.statusLabel} htmlFor="pack-status">
            Status
          </label>
          <select
            id="pack-status"
            className={styles.statusSelect}
            value={pack.status}
            onChange={(event) => updatePack({ status: event.target.value as EditablePack['status'] })}
          >
            <option value="draft">Draft</option>
            <option value="ready">Ready (can be launched)</option>
            <option value="archived">Archived</option>
          </select>
          <span className={styles.statusHint}>
            Marking a pack &quot;ready&quot; requires every music clue to have a song and a correct answer, and every
            price clue to have valid min/max/target values.
          </span>
        </div>
      </Card>

      <div className={styles.layout}>
        <Card>
          <div className={styles.panelHeader}>
            <h2>Categories</h2>
          </div>
          <div className={styles.categoryList}>
            {pack.categories.map((category) => (
              <div
                key={category.key}
                className={[styles.categoryButton, category.key === selectedCategoryKey ? styles.categoryButtonActive : '']
                  .filter(Boolean)
                  .join(' ')}
              >
                <button
                  type="button"
                  className={styles.categoryButtonLabel}
                  onClick={() => setSelectedCategoryKey(category.key)}
                  aria-pressed={category.key === selectedCategoryKey}
                >
                  {category.title || 'Untitled category'}
                </button>
                <Badge tone="neutral">{category.clues.length}</Badge>
                <button
                  type="button"
                  className={styles.removeButton}
                  onClick={() => handleDeleteCategory(category.key)}
                  aria-label={`Delete category ${category.title}`}
                >
                  ✕
                </button>
              </div>
            ))}
            {pack.categories.length === 0 ? <p>No categories yet.</p> : null}
          </div>
          <Button variant="secondary" fullWidth onClick={handleAddCategory} disabled={pack.categories.length >= 12}>
            + Add category
          </Button>
        </Card>

        <Card>
          {selectedCategory ? (
            <details open className={styles.categoryEditor}>
              <summary className={styles.categorySummary}>
                <span>Category</span>
                <strong>{selectedCategory.title || 'Untitled category'}</strong>
                <Badge tone="neutral">{selectedCategory.clues.length} clues</Badge>
              </summary>
              <div className={styles.categoryContent}>
                <div className={styles.panelHeader}>
                <TextField
                  label="Category title"
                  value={selectedCategory.title}
                  onChange={(event) => handleRenameCategory(selectedCategory.key, event.target.value)}
                  className={styles.categoryTitleField}
                />
                <Button
                  variant="secondary"
                  onClick={() => handleAddClue(selectedCategory.key)}
                  disabled={selectedCategory.clues.length >= 20}
                >
                  + Add clue
                </Button>
              </div>
              <div className={styles.clueList}>
                {selectedCategory.clues.map((clue) => (
                  <details key={clue.key} open className={styles.clueCard}>
                    <summary className={styles.clueSummary}>
                      <span>
                        {clue.finalQuestion ? 'Final Question' : `${clue.boardValue} points`}
                      </span>
                      <strong>{clue.prompt.trim() || 'Untitled clue'}</strong>
                      <Badge tone="info">{clueTypeLabels[clue.type]}</Badge>
                    </summary>
                    <div className={styles.clueContent}>
                    <label className={styles.finalQuestionToggle}>
                      <input
                        type="checkbox"
                        checked={clue.finalQuestion}
                        onChange={(event) => setFinalQuestion(clue.key, event.target.checked)}
                      />
                      Use as Final Question
                    </label>
                    <div className={styles.clueHeaderRow}>
                      {!clue.finalQuestion ? (
                        <TextField
                          label="Board value"
                          type="number"
                          value={clue.boardValue}
                          onChange={(event) =>
                            updateClue(selectedCategory.key, clue.key, { boardValue: Number(event.target.value) })
                          }
                          className={styles.narrowField}
                        />
                      ) : null}
                      <div className={styles.field}>
                        <label className={styles.statusLabel} htmlFor={`clue-type-${clue.key}`}>
                          Clue type
                        </label>
                        <select
                          id={`clue-type-${clue.key}`}
                          className={styles.statusSelect}
                          value={clue.type}
                          onChange={(event) =>
                            handleClueTypeChange(selectedCategory.key, clue.key, event.target.value as ServerClueType)
                          }
                        >
                          {clueTypeOptions.map((option) => (
                            <option key={option.value} value={option.value}>
                              {option.label}
                            </option>
                          ))}
                        </select>
                      </div>
                      <TextField
                        label="Timer (seconds)"
                        type="number"
                        min={5}
                        max={300}
                        value={clue.timerSeconds}
                        onChange={(event) =>
                          updateClue(selectedCategory.key, clue.key, { timerSeconds: Number(event.target.value) })
                        }
                        className={styles.narrowField}
                      />
                      <button
                        type="button"
                        className={styles.removeButton}
                        onClick={() => handleDeleteClue(selectedCategory.key, clue.key)}
                        aria-label="Delete clue"
                      >
                        ✕
                      </button>
                    </div>

                    <TextareaField
                      label="Prompt"
                      value={clue.prompt}
                      onChange={(event) => updateClue(selectedCategory.key, clue.key, { prompt: event.target.value })}
                      placeholder="e.g. This 1985 anthem topped the charts for six weeks."
                    />

                    {clue.type !== 'price_slider' ? (
                      <div className={styles.field}>
                        <label className={styles.statusLabel} htmlFor={`clue-media-${clue.key}`}>
                          Song
                        </label>
                        <select
                          id={`clue-media-${clue.key}`}
                          className={styles.statusSelect}
                          value={clue.mediaAssetId ?? ''}
                          onChange={(event) =>
                            updateClue(selectedCategory.key, clue.key, { mediaAssetId: event.target.value || null })
                          }
                        >
                          <option value="">No song attached</option>
                          {musicMediaAssets.map((asset) => (
                            <option key={asset.id} value={asset.id}>
                              {asset.originalName}
                            </option>
                          ))}
                        </select>
                        {clue.mediaAssetId ? (
                          <audio controls src={mediaStreamUrl(clue.mediaAssetId)} className={styles.audioPreview} />
                        ) : null}
                      </div>
                    ) : null}

                    <div className={styles.field}>
                      <label className={styles.statusLabel} htmlFor={`clue-reveal-media-${clue.key}`}>
                        Answer reveal song (optional)
                      </label>
                      <select
                        id={`clue-reveal-media-${clue.key}`}
                        className={styles.statusSelect}
                        value={clue.revealMediaAssetId ?? ''}
                        onChange={(event) =>
                          updateClue(selectedCategory.key, clue.key, {
                            revealMediaAssetId: event.target.value || null,
                          })
                        }
                      >
                        <option value="">No reveal song</option>
                        {musicMediaAssets.map((asset) => (
                          <option key={asset.id} value={asset.id}>
                            {asset.originalName}
                          </option>
                        ))}
                      </select>
                      {clue.revealMediaAssetId ? (
                        <audio
                          controls
                          src={mediaStreamUrl(clue.revealMediaAssetId)}
                          className={styles.audioPreview}
                        />
                      ) : null}
                    </div>

                    <GifPicker
                      value={clue.config.revealGif}
                      providers={gifProviders}
                      onProvidersChange={setGifProviders}
                      onChange={(revealGif) => {
                        const { revealGif: _currentGif, ...configWithoutGif } = clue.config
                        updateClue(selectedCategory.key, clue.key, {
                          config: revealGif
                            ? { ...configWithoutGif, revealGif }
                            : configWithoutGif,
                        })
                      }}
                    />

                    {clue.type === 'music_multiple_choice' ? (
                      <div className={styles.field}>
                        <span className={styles.statusLabel}>Answer choices (need at least two)</span>
                        {(clue.config.choices ?? ['', '']).map((choice, index) => (
                          <div key={index} className={styles.choiceRow}>
                            <input
                              className={styles.choiceInput}
                              aria-label={`Choice ${index + 1}`}
                              value={choice}
                              onChange={(event) => {
                                const nextChoices = [...(clue.config.choices ?? [])]
                                nextChoices[index] = event.target.value
                                updateClue(selectedCategory.key, clue.key, {
                                  config: { ...clue.config, choices: nextChoices },
                                })
                              }}
                            />
                            <button
                              type="button"
                              className={styles.removeButton}
                              aria-label={`Remove choice ${index + 1}`}
                              onClick={() => {
                                const nextChoices = (clue.config.choices ?? []).filter((_, i) => i !== index)
                                updateClue(selectedCategory.key, clue.key, {
                                  config: { ...clue.config, choices: nextChoices },
                                })
                              }}
                              disabled={(clue.config.choices ?? []).length <= 2}
                            >
                              ✕
                            </button>
                          </div>
                        ))}
                        <Button
                          variant="ghost"
                          size="md"
                          onClick={() =>
                            updateClue(selectedCategory.key, clue.key, {
                              config: { ...clue.config, choices: [...(clue.config.choices ?? []), ''] },
                            })
                          }
                        >
                          + Add choice
                        </Button>
                        <TextField
                          label="Correct choice (must match one of the choices above exactly)"
                          value={clue.config.correctAnswer ?? ''}
                          onChange={(event) =>
                            updateClue(selectedCategory.key, clue.key, {
                              config: { ...clue.config, correctAnswer: event.target.value },
                            })
                          }
                        />
                      </div>
                    ) : null}

                    {clue.type === 'music_free_text' ? (
                      <div className={styles.field}>
                        <TextField
                          label="Correct answer"
                          value={clue.config.correctAnswer ?? ''}
                          onChange={(event) =>
                            updateClue(selectedCategory.key, clue.key, {
                              config: { ...clue.config, correctAnswer: event.target.value },
                            })
                          }
                        />
                        <TextareaField
                          label="Other accepted answers (one per line, optional)"
                          value={(clue.config.acceptedAnswers ?? []).join('\n')}
                          onChange={(event) =>
                            updateClue(selectedCategory.key, clue.key, {
                              config: {
                                ...clue.config,
                                acceptedAnswers: event.target.value
                                  .split('\n')
                                  .map((line) => line.trim())
                                  .filter(Boolean),
                              },
                            })
                          }
                        />
                      </div>
                    ) : null}

                    {clue.type === 'price_slider' ? (
                      <div className={styles.priceGrid}>
                        <TextField
                          label="Min"
                          type="number"
                          value={clue.config.min ?? 0}
                          onChange={(event) =>
                            updateClue(selectedCategory.key, clue.key, {
                              config: { ...clue.config, min: Number(event.target.value) },
                            })
                          }
                        />
                        <TextField
                          label="Max"
                          type="number"
                          value={clue.config.max ?? 100}
                          onChange={(event) =>
                            updateClue(selectedCategory.key, clue.key, {
                              config: { ...clue.config, max: Number(event.target.value) },
                            })
                          }
                        />
                        <TextField
                          label="Step"
                          type="number"
                          value={clue.config.step ?? 1}
                          onChange={(event) =>
                            updateClue(selectedCategory.key, clue.key, {
                              config: { ...clue.config, step: Number(event.target.value) },
                            })
                          }
                        />
                        <TextField
                          label="Correct price"
                          type="number"
                          value={clue.config.correctPrice ?? 0}
                          onChange={(event) =>
                            updateClue(selectedCategory.key, clue.key, {
                              config: { ...clue.config, correctPrice: Number(event.target.value) },
                            })
                          }
                        />
                        <TextField
                          label="Prefix"
                          value={clue.config.prefix ?? '$'}
                          onChange={(event) =>
                            updateClue(selectedCategory.key, clue.key, {
                              config: { ...clue.config, prefix: event.target.value },
                            })
                          }
                        />
                      </div>
                    ) : null}

                    <span className={styles.clueTypeBadgeRow}>
                      <Badge tone="info">{clueTypeLabels[clue.type]}</Badge>
                    </span>
                    </div>
                  </details>
                ))}
                {selectedCategory.clues.length === 0 ? <p>No clues yet in this category.</p> : null}
              </div>
              </div>
            </details>
          ) : (
            <p>Select or add a category to start adding clues.</p>
          )}
        </Card>
      </div>

      <Card className={styles.mediaCard}>
        <div className={styles.panelHeader}>
          <h2>Media library</h2>
          <Button variant="secondary" onClick={() => mediaInputRef.current?.click()} disabled={uploading}>
            {uploading ? 'Uploading…' : '+ Upload song'}
          </Button>
          <input
            ref={mediaInputRef}
            type="file"
            accept="audio/*"
            className={styles.hiddenInput}
            onChange={handleUploadMedia}
          />
        </div>
        {mediaDirectory ? (
          <p className={styles.mediaDirectory}>
            Song directory: <code>{mediaDirectory}</code>
          </p>
        ) : null}
        {mediaError ? (
          <p role="alert" className={styles.errorText}>
            {mediaError}
          </p>
        ) : null}
        <ul className={styles.mediaList}>
          {musicMediaAssets.map((asset) => (
            <li key={asset.id} className={styles.mediaRow}>
              <span className={styles.mediaName}>{asset.originalName}</span>
              <span className={styles.mediaActions}>
                <span className={styles.mediaMeta}>{Math.round(asset.sizeBytes / 1024)} KB</span>
                <Button
                  variant="danger"
                  size="md"
                  disabled={deletingMediaId === asset.id}
                  onClick={() => handleDeleteMedia(asset)}
                >
                  {deletingMediaId === asset.id ? 'Removing…' : 'Remove'}
                </Button>
              </span>
            </li>
          ))}
          {musicMediaAssets.length === 0 ? <p>No songs uploaded yet.</p> : null}
        </ul>
      </Card>
    </div>
  )
}
