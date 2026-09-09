import type { HTMLAttributes } from 'react'
import styles from './Card.module.css'

export interface CardProps extends HTMLAttributes<HTMLDivElement> {
  raised?: boolean
  interactive?: boolean
}

export function Card({ raised, interactive, className, children, ...rest }: CardProps) {
  const classes = [
    styles.card,
    raised ? styles.raised : '',
    interactive ? styles.interactive : '',
    className ?? '',
  ]
    .filter(Boolean)
    .join(' ')

  return (
    <div className={classes} {...rest}>
      {children}
    </div>
  )
}
