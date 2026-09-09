import { useNavigate } from 'react-router-dom'
import { Button, Card, PageContainer } from '../components'
import styles from './LandingPage.module.css'

export function LandingPage() {
  const navigate = useNavigate()

  function handleHost() {
    navigate('/host')
  }

  return (
    <PageContainer>
      <section className={styles.hero}>
        <h1 className={styles.title}>FriendsTrivia</h1>
        <p className={styles.subtitle}>
          A living-room trivia night: one shared screen, phones for buzzers, and a Jeopardy-style
          board full of music and price rounds. No app to install, just a room code.
        </p>
      </section>

      <div className={styles.actions}>
        <Card className={styles.actionCard} aria-labelledby="host-heading">
          <h2 id="host-heading" className={styles.actionHeading}>
            <span className={[styles.actionIcon, styles.hostIcon].join(' ')} aria-hidden="true">
              ★
            </span>
            Host a game
          </h2>
          <p className={styles.actionDescription}>
            Running the show? Pick a pack, open the shared display, and start the board.
          </p>
          <Button variant="secondary" size="lg" fullWidth onClick={handleHost}>
            Go to host tools
          </Button>
        </Card>
      </div>
    </PageContainer>
  )
}
