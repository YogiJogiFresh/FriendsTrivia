import { useEffect, useRef, useState } from 'react'
import type { KeyboardEvent, PointerEvent } from 'react'
import { ApiError, uploadMedia } from '../../lib/apiClient'
import type { ServerMediaAsset } from '../../lib/apiClient'
import {
  decodeSong, encodeSnippet, estimatedMp3Bytes, formatTimestamp, outputName,
  parseTimestamp, sourceType, validRange,
} from '../../lib/audioSnippets'
import type { DecodedSong } from '../../lib/audioSnippets'
import { Button, TextField } from '../common'
import styles from './AudioSnippetUploader.module.css'

type Status = 'idle' | 'encoding' | 'uploading' | 'uploaded' | 'failed' | 'uncertain'
interface Output {
  label: string
  enabled: boolean
  name: string
  start: string
  end: string
  blob?: Blob
  status: Status
  error?: string
}

const sizeLabel = (bytes: number) => `${(bytes / 1024 / 1024).toFixed(2)} MB`
const rangeFor = (output: Output) => ({ start: parseTimestamp(output.start), end: parseTimestamp(output.end) })
const locked = (output: Output) => output.status === 'uploaded' || output.status === 'uncertain'

export function AudioSnippetUploader({ active, onUploaded }: {
  active: boolean
  onUploaded: (asset: ServerMediaAsset) => void
}) {
  const [file, setFile] = useState<File | null>(null)
  const [song, setSong] = useState<DecodedSong | null>(null)
  const [outputs, setOutputs] = useState<Output[]>([])
  const [activeClip, setActiveClip] = useState(0)
  const [busy, setBusy] = useState<'loading' | 'encoding' | 'uploading' | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState('')
  const inputRef = useRef<HTMLInputElement>(null)
  const audioRef = useRef<HTMLAudioElement>(null)
  const playingAudio = useRef<HTMLAudioElement | null>(null)
  const activeRef = useRef(active)
  const waveformRef = useRef<HTMLDivElement>(null)
  const previewUrl = useRef<string | null>(null)
  const generation = useRef(0)
  const controller = useRef<AbortController | null>(null)
  const dragging = useRef<'start' | 'end' | null>(null)

  function stopPreview() {
    audioRef.current?.pause()
    audioRef.current?.removeAttribute('src')
    audioRef.current?.load()
    playingAudio.current?.pause()
    if (previewUrl.current) URL.revokeObjectURL(previewUrl.current)
    previewUrl.current = null
  }

  useEffect(() => {
    activeRef.current = active
    if (!active) stopPreview()
  }, [active])

  useEffect(() => () => {
    generation.current += 1
    controller.current?.abort()
    playingAudio.current?.pause()
    playingAudio.current?.removeAttribute('src')
    playingAudio.current?.load()
    if (previewUrl.current) URL.revokeObjectURL(previewUrl.current)
  }, [])

  function patch(index: number, change: Partial<Output>) {
    setOutputs((current) => current.map((output, i) => i === index ? { ...output, ...change } : output))
  }

  function cancel() {
    generation.current += 1
    controller.current?.abort()
    stopPreview()
    setFile(null)
    setSong(null)
    setOutputs([])
    setBusy(null)
    setError(null)
    setNotice('')
  }

  async function chooseFile(source: File) {
    cancel()
    try { sourceType(source) } catch (failure) {
      setError((failure as Error).message)
      return
    }
    const base = source.name.replace(/\.[^.]+$/, '')
    setFile(source)
    setActiveClip(0)
    setOutputs([
      { label: 'Question clip', enabled: true, name: `${base}-question`, start: '', end: '', status: 'idle' },
      { label: 'Answer reveal clip', enabled: true, name: `${base}-reveal`, start: '', end: '', status: 'idle' },
      { label: 'Original song', enabled: false, name: base, start: '', end: '', status: 'idle', blob: source },
    ])
    setBusy('loading')
    const version = generation.current
    const work = new AbortController()
    controller.current = work
    try {
      const decoded = await decodeSong(source, work.signal)
      if (version === generation.current) setSong(decoded)
    } catch (failure) {
      if (version === generation.current && !work.signal.aborted) {
        setError(`${(failure as Error).message} You can still explicitly choose to upload the original.`)
      }
    } finally {
      if (version === generation.current) setBusy(null)
    }
  }

  function editRange(index: number, field: 'start' | 'end', value: string) {
    stopPreview()
    setNotice('')
    patch(index, { [field]: value, blob: undefined, status: 'idle', error: undefined })
  }

  function clipError(output: Output, index: number): string | null {
    try { outputName(output.name, index === 2 ? `.${file!.name.split('.').pop()!.toLowerCase()}` : '.mp3') }
    catch (failure) { return (failure as Error).message }
    if (index !== 2 && (!song || !validRange(rangeFor(output), song.duration))) {
      return 'Set both start and end within the song, with the end after the start.'
    }
    return null
  }

  async function preview(index: number) {
    const output = outputs[index]
    const problem = clipError(output, index)
    if (problem) { patch(index, { error: problem }); return }
    stopPreview()
    setNotice('')
    setBusy('encoding')
    const version = generation.current
    const work = new AbortController()
    controller.current = work
    try {
      const blob = output.blob ?? await encodeSnippet(song!, rangeFor(output), work.signal)
      if (version !== generation.current || !activeRef.current) return
      patch(index, { blob, error: undefined })
      previewUrl.current = URL.createObjectURL(blob)
      const audio = audioRef.current!
      playingAudio.current = audio
      audio.src = previewUrl.current
      audio.load()
      setNotice(`Preview ready: ${output.label}. This is the file that will be uploaded.`)
      await audio.play().catch(() => {
        if (version === generation.current) setNotice(`Preview ready: ${output.label}. Press Play below to listen.`)
      })
    } catch (failure) {
      if (version === generation.current && !work.signal.aborted) patch(index, { error: (failure as Error).message })
    } finally {
      if (version === generation.current) setBusy(null)
    }
  }

  async function uploadSelected() {
    if (!file) return
    const selected = outputs.map((output, index) => ({ output, index })).filter(({ output }) => output.enabled && !locked(output))
    if (!selected.length) { setNotice('Select at least one file that has not already uploaded.'); return }
    const names = new Set<string>()
    let invalid = false
    for (const { output, index } of outputs.map((output, index) => ({ output, index })).filter(({ output }) => output.enabled)) {
      const problem = clipError(output, index)
      if (problem) { patch(index, { error: problem }); invalid = true; continue }
      const name = outputName(output.name, index === 2 ? `.${file.name.split('.').pop()!.toLowerCase()}` : '.mp3').toLocaleLowerCase()
      if (names.has(name)) { patch(index, { error: 'Give each selected file a different name.' }); invalid = true }
      names.add(name)
    }
    if (invalid) return
    stopPreview()
    setNotice('')
    const version = generation.current
    const work = new AbortController()
    controller.current = work
    setBusy('uploading')
    for (const { output, index } of selected) {
      let sending = false
      try {
        patch(index, { status: output.blob ? 'uploading' : 'encoding', error: undefined })
        const blob = output.blob ?? await encodeSnippet(song!, rangeFor(output), work.signal)
        if (version !== generation.current) return
        patch(index, { blob, status: 'uploading' })
        const extension = index === 2 ? `.${file.name.split('.').pop()!.toLowerCase()}` : '.mp3'
        const upload = new File([blob], outputName(output.name, extension), { type: index === 2 ? sourceType(file) : 'audio/mpeg' })
        sending = true
        const asset = await uploadMedia(upload)
        if (version !== generation.current) return
        patch(index, { status: 'uploaded' })
        onUploaded(asset)
      } catch (failure) {
        if (version !== generation.current) return
        const uncertain = sending && (!(failure instanceof ApiError) || failure.status === 0 || failure.status >= 500)
        patch(index, {
          status: uncertain ? 'uncertain' : 'failed',
          error: uncertain
            ? 'The upload may have reached the library. Reload and check before uploading another copy.'
            : (failure as Error).message,
        })
      }
    }
    if (version === generation.current) {
      setBusy(null)
      setNotice('Upload attempt finished. Uploaded files are already in the library; retry only failed files.')
    }
  }

  const selectedClip = outputs[activeClip]
  const range = selectedClip ? rangeFor(selectedClip) : { start: NaN, end: NaN }
  const start = Math.max(0, Math.min(song?.duration ?? 0, Number.isFinite(range.start) ? range.start : 0))
  const end = Math.max(start, Math.min(song?.duration ?? 0, Number.isFinite(range.end) ? range.end : song?.duration ?? 0))
  const waveformDisabled = Boolean(busy || selectedClip && locked(selectedClip))

  function moveHandle(field: 'start' | 'end', seconds: number) {
    if (!song || waveformDisabled) return
    const maximum = field === 'start' ? Math.max(0, end - 0.01) : song.duration
    const minimum = field === 'end' ? Math.min(song.duration, start + 0.01) : 0
    const centiseconds = Math.max(Math.ceil(minimum * 100 - 1e-7),
      Math.min(Math.floor(maximum * 100 + 1e-7), Math.round(seconds * 100)))
    editRange(activeClip, field, formatTimestamp(centiseconds / 100))
  }

  function drag(event: PointerEvent<HTMLButtonElement>) {
    if (!dragging.current || !song) return
    const bounds = waveformRef.current!.getBoundingClientRect()
    moveHandle(dragging.current, (event.clientX - bounds.left) / bounds.width * song.duration)
  }

  function handleKey(event: KeyboardEvent<HTMLButtonElement>, field: 'start' | 'end') {
    if (!song) return
    let value = field === 'start' ? start : end
    const step = event.shiftKey ? 1 : 0.1
    if (event.key === 'ArrowLeft' || event.key === 'ArrowDown') value -= step
    else if (event.key === 'ArrowRight' || event.key === 'ArrowUp') value += step
    else if (event.key === 'Home') value = 0
    else if (event.key === 'End') value = song.duration
    else return
    event.preventDefault()
    moveHandle(field, value)
  }

  const selectedBytes = outputs.reduce((total, output, index) => {
    if (!output.enabled) return total
    if (output.blob) return total + output.blob.size
    const clipRange = rangeFor(output)
    return total + (song && validRange(clipRange, song.duration) && index !== 2 ? estimatedMp3Bytes(clipRange) : 0)
  }, 0)

  return (
    <div className={styles.workspace}>
      <div className={styles.actions}>
        <Button variant="secondary" disabled={Boolean(busy)} onClick={() => inputRef.current?.click()}>
          {file ? 'Choose another song' : '+ Choose song'}
        </Button>
        <input ref={inputRef} type="file" accept=".mp3,.m4a,.ogg,.wav" hidden onChange={(event) => {
          const chosen = event.target.files?.[0]
          event.target.value = ''
          if (chosen) void chooseFile(chosen)
        }} />
      </div>
      {error ? <p role="alert" className={styles.error}>{error}</p> : null}
      {file ? (
        <>
          <div>
            <h3 className={styles.filename}>{file.name}</h3>
            <p>{sizeLabel(file.size)} original{song ? ` · ${formatTimestamp(song.duration)}` : ''}. Nothing uploads until you choose Upload selected files.</p>
          </div>
          {busy === 'loading' ? <p role="status">Reading song and preparing waveform…</p> : null}
          {song ? (
            <div className={styles.waveformPanel}>
              <div className={styles.actions} role="group" aria-label="Clip to edit on waveform">
                {outputs.slice(0, 2).map((output, index) => (
                  <Button key={output.label} variant={activeClip === index ? 'primary' : 'secondary'} disabled={Boolean(busy)}
                    aria-pressed={activeClip === index} onClick={() => { stopPreview(); setActiveClip(index) }}>
                    {output.label}
                  </Button>
                ))}
              </div>
              <p id="waveform-help">Drag Start and End, use arrow keys (Shift for one second), or enter timestamps below. Set both bounds for each selected clip.</p>
              <div className={styles.waveform} ref={waveformRef}>
                <svg viewBox="0 0 600 100" preserveAspectRatio="none" aria-hidden="true">
                  <rect x={start / song.duration * 600} width={Math.max(0, end - start) / song.duration * 600} height="100" className={styles.selection} />
                  <path d={song.peaks.map((peak, i) => `M${i / song.peaks.length * 600},${50 - peak * 46}v${Math.max(1, peak * 92)}`).join(' ')} className={styles.peaks} />
                </svg>
                {(['start', 'end'] as const).map((field) => (
                  <button key={field} type="button" role="slider" className={styles.handle}
                    data-bound={field}
                    style={{ left: `${(field === 'start' ? start : end) / song.duration * 100}%` }}
                    aria-label={`${selectedClip.label} ${field}`} aria-describedby="waveform-help"
                    aria-valuemin={field === 'start' ? 0 : start}
                    aria-valuemax={field === 'start' ? end : song.duration}
                    aria-valuenow={field === 'start' ? start : end}
                    aria-valuetext={formatTimestamp(field === 'start' ? start : end)}
                    disabled={waveformDisabled}
                    onKeyDown={(event) => handleKey(event, field)}
                    onPointerDown={(event) => { dragging.current = field; event.currentTarget.setPointerCapture(event.pointerId) }}
                    onPointerMove={drag}
                    onPointerUp={(event) => { drag(event); dragging.current = null; event.currentTarget.releasePointerCapture(event.pointerId) }}
                    onPointerCancel={() => { dragging.current = null }}>
                    {field === 'start' ? 'Start' : 'End'}
                  </button>
                ))}
              </div>
            </div>
          ) : null}
          {outputs.map((output, index) => (
            <fieldset key={output.label} className={styles.output}>
              <legend>{output.label}</legend>
              <label className={styles.include}>
                <input type="checkbox" checked={output.enabled} disabled={Boolean(busy) || locked(output)}
                  onChange={(event) => { stopPreview(); patch(index, { enabled: event.target.checked, error: undefined }) }} />
                {index === 2 ? 'Also upload original song' : `Include ${output.label.toLowerCase()}`}
              </label>
              {output.enabled ? (
                <>
                  <div className={styles.fields}>
                    {index !== 2 ? (
                      <>
                        <TextField label={`${output.label} start`} placeholder="0:00.00" value={output.start}
                          disabled={Boolean(busy) || locked(output)} onChange={(event) => editRange(index, 'start', event.target.value)} />
                        <TextField label={`${output.label} end`} placeholder={song ? formatTimestamp(song.duration) : '0:30.00'} value={output.end}
                          disabled={Boolean(busy) || locked(output)} onChange={(event) => editRange(index, 'end', event.target.value)} />
                      </>
                    ) : null}
                    <TextField label={`${output.label} filename`} value={output.name} maxLength={124}
                      hint={`Extension: ${index === 2 ? `.${file.name.split('.').pop()!.toLowerCase()}` : '.mp3'}`}
                      disabled={Boolean(busy) || locked(output)} onChange={(event) => patch(index, { name: event.target.value, error: undefined })} />
                  </div>
                  {index !== 2 && song && validRange(rangeFor(output), song.duration) ? (
                    <p>{formatTimestamp(rangeFor(output).end - rangeFor(output).start)} clip · {sizeLabel(output.blob?.size ?? estimatedMp3Bytes(rangeFor(output)))} {output.blob ? 'encoded' : 'estimated'} · MP3, 128 kbps</p>
                  ) : null}
                  <div className={styles.actions}>
                    <Button variant="ghost" disabled={Boolean(busy) || index !== 2 && !song} onClick={() => void preview(index)}>
                      Preview {output.label.toLowerCase()}
                    </Button>
                    <span role="status">{output.status === 'idle' ? '' : output.status === 'uploaded' ? 'Uploaded — available in the library' : `${output.status[0].toUpperCase()}${output.status.slice(1)}`}</span>
                  </div>
                  {output.error ? <p role="alert" className={styles.error}>{output.error}</p> : null}
                </>
              ) : null}
            </fieldset>
          ))}
          <audio ref={audioRef} controls className={styles.audio} aria-label="Prepared clip preview" />
          <Button variant="ghost" onClick={stopPreview}>Stop preview</Button>
          <p>Selected files: approximately {sizeLabel(selectedBytes)} versus {sizeLabel(file.size)} original.
            {selectedBytes >= file.size ? ' These selections will not save space compared with the original.' : ''}</p>
          <div className={styles.actions}>
            <Button disabled={Boolean(busy)} onClick={() => void uploadSelected()}>
              {busy === 'uploading' ? 'Preparing and uploading…' : 'Upload selected files'}
            </Button>
            <Button variant="ghost" disabled={busy === 'uploading'} onClick={cancel}>Cancel</Button>
          </div>
          <p role="status">{busy === 'encoding' ? 'Encoding preview MP3…' : notice}</p>
          <small>Clips stay on this device until upload. Drafts are lost on reload. <a href="/audio-encoder-notice.txt" target="_blank" rel="noreferrer">MP3 encoder license and source</a></small>
        </>
      ) : null}
    </div>
  )
}
