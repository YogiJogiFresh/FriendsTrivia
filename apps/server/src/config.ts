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

function resolveFromRoot(value: string): string {
  return path.isAbsolute(value) ? value : path.resolve(workspaceRoot, value)
}

export const config = {
  workspaceRoot,
  host: process.env.HOST ?? '0.0.0.0',
  port: Number(process.env.PORT ?? 3000),
  publicUrl: process.env.PUBLIC_URL || undefined,
  databasePath: resolveFromRoot(process.env.DATABASE_PATH ?? './data/friends-trivia.db'),
  contentRoot: resolveFromRoot(process.env.CONTENT_ROOT ?? './content'),
  webDist: resolveFromRoot(process.env.WEB_DIST ?? './apps/web/dist'),
  roomCodeLength: Number(process.env.ROOM_CODE_LENGTH ?? 4),
  giphyApiKey: process.env.GIPHY_API_KEY || undefined,
  tenorApiKey: process.env.TENOR_API_KEY || undefined,
} as const
