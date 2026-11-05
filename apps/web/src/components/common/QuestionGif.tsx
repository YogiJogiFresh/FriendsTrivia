import { useState } from 'react'
import type { RevealGif } from '../../data/types'
import styles from './QuestionGif.module.css'

export function QuestionGif({ gif }: { gif: RevealGif }) {
  const [failed, setFailed] = useState(false)
  return (
    <figure className={styles.frame}>
      {failed ? <p role="status">The question GIF could not be loaded.</p> :
        <img src={gif.url} alt={gif.alt || 'Question GIF'} onError={() => setFailed(true)} />}
    </figure>
  )
}
