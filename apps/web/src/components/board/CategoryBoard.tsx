import type { CSSProperties } from 'react'
import type { Category, Clue } from '../../data/types'
import styles from './CategoryBoard.module.css'

export interface CategoryBoardProps {
  categories: Category[]
  clues: Clue[]
  /** The clue currently in play, highlighted on the board. */
  activeClueId?: string | null
  /** Host mode: clue tiles become clickable buttons. */
  interactive?: boolean
  onSelectClue?: (clueId: string) => void
}

type TileStyle = CSSProperties & { '--accent-color'?: string; '--column-count'?: number }

/**
 * Jeopardy-style category board. Categories are rendered as columns and
 * clue values as rows via explicit CSS grid placement (rather than relying
 * on DOM order + grid auto-flow), so the same markup lays out correctly
 * both as a full-width grid on large displays and as a horizontally
 * scrollable strip on narrow phones — the board never forces the page
 * itself to overflow horizontally.
 */
export function CategoryBoard({
  categories,
  clues,
  activeClueId,
  interactive = false,
  onSelectClue,
}: CategoryBoardProps) {
  const cluesByCategory = new Map<string, Clue[]>()
  for (const category of categories) {
    const categoryClues = clues
      .filter((clue) => clue.categoryId === category.id)
      .sort((a, b) => a.value - b.value)
    cluesByCategory.set(category.id, categoryClues)
  }

  const boardStyle: TileStyle = { '--column-count': categories.length }

  return (
    <div className={styles.boardWrapper}>
      <div
        className={styles.board}
        style={boardStyle}
        role="group"
        aria-label="Trivia category board"
      >
        {categories.map((category, columnIndex) => (
          <div
            key={category.id}
            className={styles.categoryHeader}
            style={
              {
                gridColumn: columnIndex + 1,
                gridRow: 1,
                '--accent-color': `var(${category.accentToken})`,
              } as TileStyle
            }
          >
            {category.title}
          </div>
        ))}

        {categories.map((category, columnIndex) =>
          cluesByCategory.get(category.id)?.map((clue, rowIndex) => {
            const tileStyle: TileStyle = {
              gridColumn: columnIndex + 1,
              gridRow: rowIndex + 2,
              '--accent-color': `var(${category.accentToken})`,
            }
            const isActive = clue.id === activeClueId
            const label = `${category.title}, ${clue.used ? 'already played, ' : ''}value $${clue.value}`

            if (!interactive) {
              return (
                <div
                  key={clue.id}
                  aria-label={label}
                  className={[styles.clueTile, isActive ? styles.clueTileActive : ''].filter(Boolean).join(' ')}
                  style={tileStyle}
                >
                  {clue.used ? <span aria-hidden="true">·</span> : `$${clue.value}`}
                </div>
              )
            }

            return (
              <button
                key={clue.id}
                type="button"
                className={[styles.clueTile, isActive ? styles.clueTileActive : ''].filter(Boolean).join(' ')}
                style={tileStyle}
                disabled={clue.used}
                aria-label={label}
                aria-pressed={isActive}
                onClick={() => onSelectClue?.(clue.id)}
              >
                {clue.used ? <span aria-hidden="true">·</span> : `$${clue.value}`}
              </button>
            )
          }),
        )}
      </div>
    </div>
  )
}
