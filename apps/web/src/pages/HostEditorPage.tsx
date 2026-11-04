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
  importPackBundle,
  listMedia,
  mediaStreamUrl,
  packBundleExportUrl,
  savePack,
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
import { changeMultipleChoice, findCorrectChoice, hasCorrectChoice } from './multipleChoiceEditor'
import { AudioSnippetUploader } from '../components/host/AudioSnippetUploader'
import type { AudioSnippetUploaderHandle } from '../components/host/AudioSnippetUploader'
import { PackBoardPreview } from '../components/host/PackBoardPreview'
import { AudioPlaybackFields } from '../components/host/AudioPlaybackFields'
import { AudioPreview } from '../components/host/AudioPreview'
import { validPlayback } from '../lib/audioPlayback'
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
  selectedChoiceIndex: number | null
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
        selectedChoiceIndex: clue.type === 'music_multiple_choice' ? findCorrectChoice(clue.config ?? {}) : null,
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
      config: clue.type === 'music_multiple_choice'
        ? {
          ...clue.config,
          correctAnswer: clue.selectedChoiceIndex === null ? '' : clue.config.choices?.[clue.selectedChoiceIndex] ?? '',
        }
        : clue.config,
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
  const [selectedClueKey, setSelectedClueKey] = useState<string | null>(null)
  const [editorSection, setEditorSection] = useState<'details' | 'categories' | 'media' | 'preview'>('categories')

  const [creatingPack, setCreatingPack] = useState(false)
  const [newPackTitle, setNewPackTitle] = useState('')
  const [newPackDescription, setNewPackDescription] = useState('')
  const [createError, setCreateError] = useState<string | null>(null)
  const [importError, setImportError] = useState<string | null>(null)
  const [importing, setImporting] = useState(false)
  const importInputRef = useRef<HTMLInputElement>(null)

  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState<string | null>(null)
  const [showChoiceErrors, setShowChoiceErrors] = useState(false)
  const [saveSuccess, setSaveSuccess] = useState(false)
  const [deletingPack, setDeletingPack] = useState(false)
  const [optimizedExport, setOptimizedExport] = useState(false)

  const [media, setMedia] = useState<ServerMediaAsset[] | null>(null)
  const audioPreparationRef = useRef<AudioSnippetUploaderHandle>(null)
  const [mediaError, setMediaError] = useState<string | null>(null)
  const [deletingMediaId, setDeletingMediaId] = useState<string | null>(null)
  const [mediaDirectory, setMediaDirectory] = useState<string | null>(null)
  const [gifProviders, setGifProviders] = useState<GifProviderStatus>({
    giphy: false,
    tenor: false,
  })

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
    setShowChoiceErrors(false)
    getPack(selectedPackId)
      .then((detail) => {
        if (cancelled) return
        const editable = toEditablePack(detail)
        setPack(editable)
        setSelectedCategoryKey(editable.categories[0]?.key ?? null)
        setSelectedClueKey(null)
        setEditorSection('categories')
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
      const created = await importPackBundle(file)
      refetchPacks()
      setSelectedPackId(created.id)
    } catch (err) {
      setImportError(
        err instanceof ApiError
          ? err.message
          : 'Could not import that pack bundle.',
      )
    } finally {
      setImporting(false)
    }
  }

  async function handleSave() {
    if (!pack) return
    for (const category of pack.categories) {
      const clue = category.clues.find((entry) => [entry.config.mediaPlayback, entry.config.revealMediaPlayback]
        .some((settings) => settings !== undefined && !validPlayback(settings)))
      if (clue) {
        setSaveError('Fix the song delay or play count in this clue before saving.')
        setSaveSuccess(false)
        setEditorSection('categories')
        setSelectedCategoryKey(category.key)
        setSelectedClueKey(clue.key)
        return
      }
    }
    const invalidCategory = pack.categories.find((category) => category.clues.some((clue) =>
      clue.type === 'music_multiple_choice' && !hasCorrectChoice(clue.config, clue.selectedChoiceIndex),
    ))
    const invalidClue = invalidCategory?.clues.find((clue) =>
      clue.type === 'music_multiple_choice' && !hasCorrectChoice(clue.config, clue.selectedChoiceIndex),
    )
    if (invalidCategory && invalidClue) {
      setShowChoiceErrors(true)
      setSaveError(null)
      setSaveSuccess(false)
      setEditorSection('categories')
      setSelectedCategoryKey(invalidCategory.key)
      setSelectedClueKey(invalidClue.key)
      window.requestAnimationFrame(() => document.getElementById(`correct-choice-${invalidClue.key}-0`)?.focus())
      return
    }
    setShowChoiceErrors(false)
    setSaving(true)
    setSaveError(null)
    setSaveSuccess(false)
    try {
      const categoryIndex = pack.categories.findIndex((category) => category.key === selectedCategoryKey)
      const clueIndex = pack.categories[categoryIndex]?.clues.findIndex((clue) => clue.key === selectedClueKey) ?? -1
      const updated = await savePack(pack.id, packInputFromState(pack))
      const editable = toEditablePack(updated)
      setPack(editable)
      setSelectedCategoryKey(editable.categories[categoryIndex]?.key ?? editable.categories[0]?.key ?? null)
      setSelectedClueKey(editable.categories[categoryIndex]?.clues[clueIndex]?.key ?? null)
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
    setSelectedClueKey(null)
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
    const key = makeLocalKey('clue')
    updateCategories((categories) =>
      categories.map((category) => {
        if (category.key !== categoryKey) return category
        const lastValue = category.clues[category.clues.length - 1]?.boardValue ?? 0
        const type: ServerClueType = 'music_free_text'
        const newClue: EditableClue = {
          key,
          type,
          boardValue: lastValue + 100,
          prompt: '',
          timerSeconds: 30,
          mediaAssetId: null,
          revealMediaAssetId: null,
          finalQuestion: false,
          config: defaultConfigForType(type),
          selectedChoiceIndex: null,
        }
        return { ...category, clues: [...category.clues, newClue] }
      }),
    )
    setSelectedClueKey(key)
    window.requestAnimationFrame(() => document.getElementById(`clue-prompt-${key}`)?.focus())
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
    updateClue(categoryKey, clueKey, { type, config: defaultConfigForType(type), mediaAssetId: null, selectedChoiceIndex: null })
  }

  function handleDeleteClue(categoryKey: string, clueKey: string) {
    updateCategories((categories) =>
      categories.map((category) =>
        category.key === categoryKey
          ? { ...category, clues: category.clues.filter((clue) => clue.key !== clueKey) }
          : category,
      ),
    )
    setSelectedClueKey((current) => current === clueKey ? null : current)
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
                {importing ? 'Importing…' : 'Import pack'}
              </Button>
              <input
                ref={importInputRef}
                type="file"
                accept=".friendstrivia"
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
      <div className={styles.editorHeader}>
        <Button variant="secondary" onClick={() => setSelectedPackId(null)}>
          ← Back to packs
        </Button>
        <div className={styles.editorHeading}>
          <h1>{pack.title || 'Untitled pack'}</h1>
          <p>{pack.categories.length} categories / {pack.categories.reduce((count, category) => count + category.clues.length, 0)} clues</p>
        </div>
        <div className={styles.headerActions}>
          {saveError ? (
            <span role="alert" className={styles.errorText}>
              {saveError}
            </span>
          ) : null}
          {saveSuccess ? <span role="status"><Badge tone="success">Saved</Badge></span> : null}
          <Button variant="primary" onClick={handleSave} disabled={saving}>
            {saving ? 'Saving…' : 'Save changes'}
          </Button>
        </div>
      </div>

      <nav className={styles.sectionNav} aria-label="Pack editor sections">
        <button type="button" aria-pressed={editorSection === 'details'} aria-controls="pack-details" onClick={() => setEditorSection('details')}>
          Pack details
        </button>
        <button type="button" aria-pressed={editorSection === 'categories'} aria-controls="pack-categories" onClick={() => setEditorSection('categories')}>
          Categories &amp; clues
        </button>
        <button type="button" aria-pressed={editorSection === 'media'} aria-controls="pack-media" onClick={() => setEditorSection('media')}>
          Media library
        </button>
        <button type="button" aria-pressed={editorSection === 'preview'} aria-controls="pack-preview" onClick={() => setEditorSection('preview')}>
          Board preview
        </button>
      </nav>

      <section id="pack-details" hidden={editorSection !== 'details'} aria-labelledby="pack-details-heading">
        <Card className={styles.metaCard}>
          <div className={styles.sectionIntro}>
            <h2 id="pack-details-heading">Pack details</h2>
            <p>Name your pack and choose when it is ready to play.</p>
          </div>
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
              aria-describedby="pack-status-hint"
            >
              <option value="draft">Draft</option>
              <option value="ready">Ready (can be launched)</option>
              <option value="archived">Archived</option>
            </select>
            <span id="pack-status-hint" className={styles.statusHint}>
              Marking a pack &quot;ready&quot; requires every music clue to have a song and a correct answer, and every
              price clue to have valid min/max/target values.
            </span>
          </div>
          <div className={styles.packTools}>
            <h3>Export and manage</h3>
            <p>Exports include the last saved version of your pack. Save changes before downloading.</p>
            <div className={styles.headerActions}>
              <label
                className={styles.exportOption}
                title="Compresses the bundle and stores byte-identical songs only once. Original audio quality is preserved."
              >
                <input
                  type="checkbox"
                  checked={optimizedExport}
                  onChange={(event) => setOptimizedExport(event.target.checked)}
                />
                Optimized export <span aria-hidden="true">ⓘ</span>
              </label>
              <Button
                variant="secondary"
                href={packBundleExportUrl(pack.id, optimizedExport)}
                download
              >
                Export pack + songs
              </Button>
              <Button variant="danger" onClick={handleDeletePack} disabled={deletingPack}>
                {deletingPack ? 'Deleting…' : 'Delete pack'}
              </Button>
            </div>
          </div>
        </Card>
      </section>

      <section id="pack-categories" hidden={editorSection !== 'categories'} aria-labelledby="pack-categories-heading">
        <div className={styles.sectionIntro}>
          <h2 id="pack-categories-heading">Categories &amp; clues</h2>
          <p>Choose a category, then open a clue to work on its question and answer.</p>
        </div>
        <div className={styles.layout}>
          <Card className={styles.categoryPanel}>
            <div className={styles.panelHeader}>
              <h3>Categories</h3>
              <span className={styles.limitHint}>{pack.categories.length} / 12</span>
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
                    onClick={() => {
                      setSelectedCategoryKey(category.key)
                      setSelectedClueKey(null)
                    }}
                    aria-pressed={category.key === selectedCategoryKey}
                  >
                    {category.title || 'Untitled category'}
                  </button>
                  <span className={styles.categoryCount}>{category.clues.length} clues</span>
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
              {pack.categories.length === 0 ? <p className={styles.helperText}>Add a category to give your clues a home.</p> : null}
            </div>
            <Button variant="secondary" fullWidth onClick={handleAddCategory} disabled={pack.categories.length >= 12}>
              + Add category
            </Button>
          </Card>

          <Card className={styles.categoryEditor}>
            {selectedCategory ? (
              <div className={styles.categoryContent}>
                <div className={styles.panelHeader}>
                  <div className={styles.categoryTitleField}>
                    <TextField
                      key={selectedCategory.key}
                      label="Category title"
                      value={selectedCategory.title}
                      onChange={(event) => handleRenameCategory(selectedCategory.key, event.target.value)}
                      autoFocus={selectedCategory.key.startsWith('category-local-')}
                    />
                  </div>
                  <Button
                    variant="secondary"
                    onClick={() => handleAddClue(selectedCategory.key)}
                    disabled={selectedCategory.clues.length >= 20}
                  >
                    + Add clue
                  </Button>
                </div>
                <div className={styles.clueListHeading}>
                  <h3>Clues</h3>
                  <span className={styles.limitHint}>{selectedCategory.clues.length} / 20</span>
                </div>
                <div className={styles.clueList}>
                  {selectedCategory.clues.map((clue) => (
                    <details key={clue.key} open={selectedClueKey === clue.key} className={styles.clueCard}>
                      <summary id={`clue-summary-${clue.key}`} className={styles.clueSummary} onClick={(event) => {
                        event.preventDefault()
                        setSelectedClueKey((current) => current === clue.key ? null : clue.key)
                      }}>
                        <span className={styles.clueValue}>
                          {clue.finalQuestion ? 'Final Question' : `${clue.boardValue} points`}
                        </span>
                        <span className={styles.clueSummaryText}>
                          <strong>{clue.prompt.trim() || 'Untitled clue'}</strong>
                          <span>{clueTypeLabels[clue.type]}</span>
                        </span>
                      </summary>
                      <div className={styles.clueContent}>
                        <fieldset className={styles.clueSection}>
                          <legend>Question</legend>
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
                          </div>

                          <TextareaField
                            id={`clue-prompt-${clue.key}`}
                            label="Question prompt"
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
                              <Button variant="ghost" onClick={() => setEditorSection('media')}>
                                Upload or manage songs
                              </Button>
                              <AudioPlaybackFields value={clue.config.mediaPlayback}
                                onChange={(mediaPlayback) => updateClue(selectedCategory.key, clue.key, {
                                  config: { ...clue.config, mediaPlayback },
                                })} />
                              {clue.mediaAssetId ? (
                                <AudioPreview src={mediaStreamUrl(clue.mediaAssetId)} label="Clue audio"
                                  settings={clue.config.mediaPlayback}
                                  active={editorSection === 'categories' && selectedClueKey === clue.key} />
                              ) : null}
                            </div>
                          ) : null}
                          <label className={styles.finalQuestionToggle}>
                            <input
                              type="checkbox"
                              checked={clue.finalQuestion}
                              onChange={(event) => setFinalQuestion(clue.key, event.target.checked)}
                            />
                            Use as Final Question
                          </label>
                        </fieldset>

                        <fieldset className={styles.clueSection}>
                          <legend>Answer</legend>
                          <p className={styles.helperText}>Set the answer used to score this clue.</p>

                          {clue.type === 'music_multiple_choice' ? (
                            <fieldset
                              className={`${styles.field} ${styles.choiceGroup}`}
                              aria-describedby={`choice-help-${clue.key}${showChoiceErrors && !hasCorrectChoice(clue.config, clue.selectedChoiceIndex) ? ` choice-error-${clue.key}` : ''}`}
                              aria-invalid={showChoiceErrors && !hasCorrectChoice(clue.config, clue.selectedChoiceIndex)}
                            >
                              <legend className={styles.statusLabel}>Answer choices (need at least two)</legend>
                              <p id={`choice-help-${clue.key}`} className={styles.helperText}>Select the radio button beside the correct answer.</p>
                              {(clue.config.choices ?? ['', '']).map((choice, index) => (
                                <div key={index} className={styles.choiceRow}>
                                  <label className={styles.correctChoice}>
                                    <input
                                      id={`correct-choice-${clue.key}-${index}`}
                                      type="radio"
                                      name={`correct-choice-${clue.key}`}
                                      aria-label={`Correct answer: choice ${index + 1}`}
                                      checked={clue.selectedChoiceIndex === index}
                                      onChange={() => updateClue(selectedCategory.key, clue.key,
                                        changeMultipleChoice(clue.config, clue.selectedChoiceIndex, { kind: 'select', index }),
                                      )}
                                    />
                                    Correct
                                  </label>
                                  <input
                                    className={styles.choiceInput}
                                    aria-label={`Choice ${index + 1}`}
                                    value={choice}
                                    onChange={(event) => updateClue(selectedCategory.key, clue.key,
                                      changeMultipleChoice(clue.config, clue.selectedChoiceIndex, { kind: 'rename', index, value: event.target.value }),
                                    )}
                                  />
                                  <button
                                    type="button"
                                    className={styles.removeButton}
                                    aria-label={`Remove choice ${index + 1}`}
                                    onClick={() => updateClue(selectedCategory.key, clue.key,
                                      changeMultipleChoice(clue.config, clue.selectedChoiceIndex, { kind: 'remove', index }),
                                    )}
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
                              {showChoiceErrors && !hasCorrectChoice(clue.config, clue.selectedChoiceIndex) ? (
                                <p id={`choice-error-${clue.key}`} role="alert" className={styles.errorText}>
                                  Select a nonblank answer choice as correct before saving.
                                </p>
                              ) : null}
                            </fieldset>
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
                        </fieldset>

                        <details className={styles.revealSection}>
                          <summary>Answer reveal (optional)</summary>
                          <div className={styles.revealContent}>
                            <p className={styles.helperText}>Play a song or show a GIF when the answer is revealed.</p>
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
                              <AudioPlaybackFields value={clue.config.revealMediaPlayback} reveal
                                onChange={(revealMediaPlayback) => updateClue(selectedCategory.key, clue.key, {
                                  config: { ...clue.config, revealMediaPlayback },
                                })} />
                              {clue.revealMediaAssetId ? (
                                <AudioPreview
                                  src={mediaStreamUrl(clue.revealMediaAssetId)}
                                  label="Reveal audio" settings={clue.config.revealMediaPlayback} reveal
                                  active={editorSection === 'categories' && selectedClueKey === clue.key}
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

                          </div>
                        </details>
                        <div className={styles.clueFooter}>
                          <Button variant="danger" onClick={() => handleDeleteClue(selectedCategory.key, clue.key)}>
                            Delete clue
                          </Button>
                          <Button variant="secondary" onClick={() => {
                            setSelectedClueKey(null)
                            document.getElementById(`clue-summary-${clue.key}`)?.focus()
                          }}>
                            Close clue
                          </Button>
                        </div>
                      </div>
                    </details>
                  ))}
                  {selectedCategory.clues.length === 0 ? (
                    <div className={styles.clueEmptyState}>
                      <h3>Add the first clue</h3>
                      <p>Start with a question, then choose how players answer it.</p>
                      <Button variant="primary" onClick={() => handleAddClue(selectedCategory.key)}>+ Add clue</Button>
                    </div>
                  ) : null}
                </div>
              </div>
            ) : (
              <div className={styles.clueEmptyState}>
                <h3>{pack.categories.length ? 'Choose a category' : 'Start with a category'}</h3>
                <p>{pack.categories.length ? 'Select a category on the left to edit its clues.' : 'Group related clues under a topic, like 80s music or Guess the price.'}</p>
                {!pack.categories.length ? <Button variant="primary" onClick={handleAddCategory}>+ Add category</Button> : null}
              </div>
            )}
          </Card>
        </div>
      </section>

      <section id="pack-media" hidden={editorSection !== 'media'} aria-labelledby="pack-media-heading">
        <Card className={styles.mediaCard}>
          <div className={styles.panelHeader}>
            <div className={styles.sectionIntro}>
              <h2 id="pack-media-heading">Media library</h2>
              <p>Prepare song snippets here, then attach them from a clue&apos;s Question or Answer reveal section.</p>
            </div>
          </div>
          <AudioSnippetUploader ref={audioPreparationRef} key={pack.id} active={editorSection === 'media'} onUploaded={(asset, replaces) => {
            setMedia((current) => [asset, ...(current ?? [])])
            setMediaError(null)
            if (replaces) {
              updateCategories((categories) => categories.map((category) => ({
                ...category,
                clues: category.clues.map((clue) => ({
                  ...clue,
                  mediaAssetId: clue.mediaAssetId === replaces.id ? asset.id : clue.mediaAssetId,
                  revealMediaAssetId: clue.revealMediaAssetId === replaces.id ? asset.id : clue.revealMediaAssetId,
                })),
              })))
              setSaveSuccess(false)
            }
          }} />
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
                  <Button variant="secondary" disabled={deletingMediaId === asset.id} onClick={() => {
                    audioPreparationRef.current?.adjust(asset)
                    document.getElementById('pack-media-heading')?.scrollIntoView({ block: 'start' })
                  }}>Adjust volume</Button>
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
      </section>

      <section id="pack-preview" hidden={editorSection !== 'preview'} aria-labelledby="pack-preview-heading">
        <div className={styles.sectionIntro}>
          <h2 id="pack-preview-heading">Board preview</h2>
          <p>Click through clues and preview their audio and answer reveals. Unsaved edits are included; this preview does not start a game.</p>
        </div>
        <Card>
          <PackBoardPreview key={pack.id} categories={pack.categories} active={editorSection === 'preview'}
            onAddClues={() => setEditorSection('categories')} />
        </Card>
      </section>
    </div>
  )
}
