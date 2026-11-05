import { useEffect, useRef, useState } from 'react'
import type { RevealGif } from '../../data/types'
import { boardFromDraft, clueFromDraft } from '../../lib/packPreview'
import type { PreviewDraftCategory } from '../../lib/packPreview'
import { categoriesFromBoard, cluesFromSnapshot } from '../../lib/snapshot'
import { CategoryBoard } from '../board/CategoryBoard'
import { Button } from '../common'
import { AudioPreview } from './AudioPreview'
import { QuestionGif } from '../common/QuestionGif'
import styles from './PackBoardPreview.module.css'

interface PackBoardPreviewProps {
  categories: PreviewDraftCategory[]
  active: boolean
  onAddClues: () => void
}

function PreviewGif({ gif }: { gif: RevealGif }) {
  const [failed, setFailed] = useState(false)
  return (
    <figure className={styles.gif}>
      {failed ? (
        <p role="status">The reveal GIF could not be loaded.</p>
      ) : (
        <img src={gif.url} alt={gif.alt || 'Answer reveal GIF'} onError={() => setFailed(true)} />
      )}
      {gif.provider !== 'url' ? <figcaption>
        <a href={gif.sourceUrl} target="_blank" rel="noreferrer">
          {gif.provider === 'giphy' ? 'GIPHY' : 'Tenor'}
        </a>
      </figcaption> : null}
    </figure>
  )
}

export function PackBoardPreview({ active, ...props }: PackBoardPreviewProps) {
  const [usedClueIds, setUsedClueIds] = useState<string[]>([])

  return active ? (
    <PreviewWorkspace {...props} usedClueIds={usedClueIds}
      onReveal={(key) => setUsedClueIds((current) => current.includes(key) ? current : [...current, key])}
      onReset={() => setUsedClueIds([])} />
  ) : null
}

function PreviewWorkspace({ categories, usedClueIds, onReveal, onReset, onAddClues }: {
  categories: PreviewDraftCategory[]
  usedClueIds: string[]
  onReveal: (key: string) => void
  onReset: () => void
  onAddClues: () => void
}) {
  const [selectedKey, setSelectedKey] = useState<string | null>(null)
  const [revealed, setRevealed] = useState(false)
  const headingRef = useRef<HTMLHeadingElement>(null)
  const navigated = useRef(false)
  const board = boardFromDraft(categories)
  const selected = selectedKey ? clueFromDraft(categories, selectedKey, revealed) : null
  const finalQuestion = categories.flatMap((category) => category.clues).find((clue) => clue.finalQuestion)
  const remaining = board.filter((row) => !usedClueIds.includes(row.clueId)).length

  useEffect(() => {
    if (navigated.current) headingRef.current?.focus()
  }, [selectedKey, revealed])

  function openClue(key: string | null) {
    navigated.current = true
    setRevealed(false)
    setSelectedKey(key)
  }

  function reveal() {
    navigated.current = true
    setRevealed(true)
    if (selectedKey && !selected?.finalQuestion) onReveal(selectedKey)
  }

  const mediaUrl = revealed ? selected?.clue.revealMediaUrl : selected?.clue.mediaUrl

  return (
    <div className={styles.workspace}>
      <div className={styles.toolbar}>
        {selected ? <Button variant="secondary" onClick={() => openClue(null)}>Back to board</Button> : null}
        <Button variant="secondary" onClick={() => { openClue(null); onReset() }}>Reset preview</Button>
      </div>
      {selected ? (
        <div className={styles.stage}>
          <p className={styles.category}>{selected.finalQuestion ? 'Final Question' : selected.categoryTitle}</p>
          <h3 ref={headingRef} tabIndex={-1} className={styles.heading}>
            {revealed ? 'Answer revealed' : selected.finalQuestion ? 'Final Question preview' : `$${selected.clue.value}`}
          </h3>
          <p className={styles.prompt}>{selected.clue.prompt.trim() || 'No question prompt yet.'}</p>
          {!revealed && selected.clue.questionGif ?
            <QuestionGif key={`${selected.clue.id}-${selected.clue.questionGif.url}`} gif={selected.clue.questionGif} /> : null}
          {revealed ? (
            <p className={styles.answer}>{selected.clue.revealedAnswer || 'No correct answer selected or entered yet.'}</p>
          ) : null}
          {revealed && selected.clue.revealGif ? (
            <PreviewGif key={selected.clue.revealGif.url} gif={selected.clue.revealGif} />
          ) : null}
          {mediaUrl ? (
            <div className={styles.media}>
              <AudioPreview key={`${selected.clue.id}-${revealed}-${mediaUrl}`} src={mediaUrl}
                label={revealed ? 'Reveal audio' : 'Clue audio'} reveal={revealed}
                settings={revealed ? selected.clue.revealMediaPlayback : selected.clue.mediaPlayback} />
            </div>
          ) : <p className={styles.hint}>{revealed ? 'No reveal audio attached.' : 'No clue audio attached.'}</p>}
          {!revealed ? <Button onClick={reveal}>Reveal answer</Button> : null}
        </div>
      ) : (
        <>
          <h3 ref={headingRef} tabIndex={-1} className={styles.heading}>Preview board</h3>
          {board.length ? (
            <>
              <p className={styles.hint} role="status">
                {remaining ? `${remaining} of ${board.length} clues available. Select a tile to preview it.` : 'All board clues revealed. Reset preview to play them again.'}
              </p>
              <CategoryBoard categories={categoriesFromBoard(board)}
                clues={cluesFromSnapshot({ board, usedClueIds })} interactive onSelectClue={openClue} />
            </>
          ) : (
            <div className={styles.empty}>
              <h4>No board clues yet</h4>
              <p>Add a clue to a category to see it here. Final Questions are separate from the board.</p>
              <Button variant="secondary" onClick={onAddClues}>Add clues</Button>
            </div>
          )}
          {finalQuestion ? (
            <div className={styles.finalQuestion}>
              <p className={styles.hint}>The Final Question plays separately from the board.</p>
              <Button variant="secondary" onClick={() => openClue(finalQuestion.key)}>Preview Final Question</Button>
            </div>
          ) : null}
        </>
      )}
    </div>
  )
}
