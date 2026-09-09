import { Link } from 'react-router-dom'
import { PageContainer } from '../components'
import styles from './NotFoundPage.module.css'

export function NotFoundPage() {
  return (
    <PageContainer>
      <div className={styles.wrapper}>
        <h1>Page not found</h1>
        <p>That link doesn&apos;t match any FriendsTrivia screen.</p>
        <Link to="/" className={styles.homeLink}>
          Back to home
        </Link>
      </div>
    </PageContainer>
  )
}
