import type { DeploymentConfig } from './config.js'
import type { DomainStore } from './domain.js'

export async function openDomainStore(config: DeploymentConfig): Promise<DomainStore> {
  if (config.mode === 'local') {
    const [{ openDatabase }, { createSqliteStore }] = await Promise.all([
      import('./database.js'), import('./sqliteStore.js'),
    ])
    return createSqliteStore(openDatabase(config.databasePath))
  }
  const { openCosmosStore } = await import('./cloud/cosmos.js')
  return openCosmosStore(config)
}
