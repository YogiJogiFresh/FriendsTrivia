import fs from 'node:fs'
import path from 'node:path'

function findWorkspaceRoot(): string {
  if (process.env.APP_ROOT) return path.resolve(process.env.APP_ROOT)

  let candidate = path.resolve(process.env.INIT_CWD ?? process.cwd())
  while (path.dirname(candidate) !== candidate) {
    if (fs.existsSync(path.join(candidate, 'apps', 'server', 'package.json'))) return candidate
    candidate = path.dirname(candidate)
  }
  return path.resolve(process.cwd())
}

const workspaceRoot = findWorkspaceRoot()
const isDevelopment = process.env.npm_lifecycle_event === 'dev'
const port = Number(process.env.PORT ?? 3000)

export function cloudConfig(environment: NodeJS.ProcessEnv) {
  const mode = environment.FRIENDS_TRIVIA_MODE ?? 'local'
  if (mode !== 'local' && mode !== 'cloud') throw new Error('FRIENDS_TRIVIA_MODE must be local or cloud')
  if ((environment.WEBSITE_SITE_NAME || environment.WEBSITE_INSTANCE_ID) && environment.FRIENDS_TRIVIA_MODE !== 'cloud')
    throw new Error('App Service requires FRIENDS_TRIVIA_MODE=cloud')
  if (mode === 'local') return { mode } as const
  const required = (name: string) => {
    const value = environment[name]?.trim()
    if (!value) throw new Error(`${name} is required in cloud mode`)
    return value
  }
  const publicUrl = required('PUBLIC_URL')
  const url = new URL(publicUrl)
  if (url.protocol !== 'https:' || url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
    throw new Error('PUBLIC_URL must be an HTTPS origin in cloud mode')
  }
  const accountUrl = required('AZURE_STORAGE_ACCOUNT_URL')
  const storageUrl = new URL(accountUrl)
  if (storageUrl.protocol !== 'https:' || storageUrl.username || storageUrl.password || storageUrl.search || storageUrl.hash) {
    throw new Error('AZURE_STORAGE_ACCOUNT_URL must use HTTPS without credentials')
  }
  const cosmosEndpoint = required('COSMOS_ENDPOINT')
  const cosmosUrl = new URL(cosmosEndpoint)
  if (cosmosUrl.protocol !== 'https:' || cosmosUrl.username || cosmosUrl.password || cosmosUrl.search || cosmosUrl.hash)
    throw new Error('COSMOS_ENDPOINT must use HTTPS without credentials')
  return {
    mode,
    cosmosEndpoint,
    cosmosDatabase: required('COSMOS_DATABASE'),
    cosmosGamesContainer: required('COSMOS_GAMES_CONTAINER'),
    cosmosLibraryContainer: required('COSMOS_LIBRARY_CONTAINER'),
    azureStorageAccountUrl: accountUrl,
    azureStorageContainer: required('AZURE_STORAGE_CONTAINER'),
  } as const

}

function resolveFromRoot(value: string): string {
  return path.isAbsolute(value) ? value : path.resolve(workspaceRoot, value)
}

export const config = {
  ...cloudConfig(process.env),
  workspaceRoot,
  host: process.env.HOST ?? '0.0.0.0',
  port,
  joinPort: Number(process.env.JOIN_PORT ?? (isDevelopment ? 5173 : port)),
  publicUrl: process.env.PUBLIC_URL || undefined,
  databasePath: resolveFromRoot(process.env.DATABASE_PATH ?? './data/friends-trivia.db'),
  contentRoot: resolveFromRoot(process.env.CONTENT_ROOT ?? './content'),
  webDist: resolveFromRoot(process.env.WEB_DIST ?? './apps/web/dist'),
  roomCodeLength: Number(process.env.ROOM_CODE_LENGTH ?? 4),
  giphyApiKey: process.env.GIPHY_API_KEY || undefined,
  tenorApiKey: process.env.TENOR_API_KEY || undefined,
  azureClientId: process.env.AZURE_CLIENT_ID || undefined,
} as const

export type DeploymentConfig = typeof config
