import type { HTMLAttributes } from 'react'
import styles from './PageContainer.module.css'

export interface PageContainerProps extends HTMLAttributes<HTMLDivElement> {
  wide?: boolean
}

/** Centers content and guarantees horizontal padding respects safe-area insets. */
export function PageContainer({ wide, className, children, ...rest }: PageContainerProps) {
  const classes = [styles.container, wide ? styles.wide : '', className ?? ''].filter(Boolean).join(' ')
  return (
    <div className={classes} {...rest}>
      {children}
    </div>
  )
}
