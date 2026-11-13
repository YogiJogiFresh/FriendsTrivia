# FriendsTrivia codebase

## Purpose and current capabilities

FriendsTrivia runs hosted party games with a host, player devices, and shared
displays. Clues include music multiple choice/free text and price sliders.
The project includes a React web app, Fastify/Socket.IO server, shared game
contracts/scoring, local and Azure storage modes, and an Electron desktop host.

The library has no per-user ownership. Cloud hosting and pack APIs use an admin
passphrase gate; media, GIF configuration, and history APIs remain public.
Local/desktop hosting remains password-free. Room host tokens and player reconnect
credentials remain separate capabilities from the cloud admin unlock.

## Repository layout

```text
apps\
  server\src\
    index.ts, app.ts       Server startup and composition
    config.ts             Local/cloud and path configuration
    adminAuth.ts          Cloud admin credentials, encrypted cookie, HTTP policy
    domain.ts             Storage-independent domain contracts
    domainStore.ts        Select local SQLite or cloud Cosmos store
    game\                 Authoritative game engine
    repositories\         Domain operations and room orchestration
    routes\               HTTP APIs for rooms/library/history/media/bundles
    socket.ts             Socket roles, commands, and publications
    database.ts           Local database initialization
    sqliteStore.ts        Local domain adapter
    statements.ts         Local SQL statements
    cloud\                Cosmos/Blob integration and supporting tests
    storage\              Media, bundle workers, and recovery operations
  web\src\
    main.tsx, App.tsx      React entry and routing
    pages\, components\   Host, player, display, and library UI
    data\hooks\           Room/session state hooks
    lib\                  REST/socket clients, snapshots, audio, diagnostics
  desktop\
    src\main.ts           Electron host and packaged local-server startup
    package.json          Separate desktop build/install configuration
packages\shared\src\      Clue contracts, socket types, game state, scoring
content\                  Local media content
data\                     Local database location
infra\                    Azure infrastructure source
scripts\                  Azure tooling and desktop release automation
.github\workflows\        Cloud deployment automation
```

The root npm workspaces include server, web, and shared packages. Desktop has a
separate dependency/lockfile installation and is not a root workspace.
Runtime databases, media, dependency trees, and built artifacts are not application
source to rewrite.

## Entry points and architecture

`apps\server\src\index.ts` starts the app composed by `app.ts`: configuration,
domain store, repositories, media storage/recovery, game engine, HTTP routes,
and Socket.IO. `apps\web\src\main.tsx` starts the React application.

HTTP and sockets have different jobs. `lib\apiClient.ts` handles library/room
REST requests; `lib\socketClient.ts` and room hooks handle live game commands,
acknowledgements, reconnects, and snapshots.

Representative host command:

1. `data\hooks\useHostRoom.ts` joins using the locally stored host capability.
2. The hook sends a command through the socket helper, with the expected room
   context and pending-command tracking.
3. `apps\server\src\socket.ts` checks the socket role/lifecycle and invokes domain
   operations through room orchestration and the game engine.
4. Repository/store changes commit before publication.
5. Command receipts and subsequent snapshots are reconciled through
   `lib\hostCommands.ts` and `lib\snapshot.ts`, then mapped into UI state.

Public/player snapshots and host snapshots have different information.
Client audio preparation and playback are presentation concerns; authoritative
phase/deadline/scoring decisions belong to the server.

## Important subsystems and contracts

`packages\shared\src` contains clue/configuration contracts, socket contracts,
game-state helpers, text handling, and scoring with adjacent tests. When adding a
clue or changing wire data, align shared types, server validation/scoring,
snapshots, web answer/display components, and relevant tests.

`apps\server\src\domain.ts` and `domainStore.ts` separate domain behavior from local
and cloud persistence. `repositories\rooms.ts` is a key room-mutation boundary;
`game\engine.ts` owns phase changes, timers, answer handling, and settlement.
Local `persistence.ts` supports SQL transaction orchestration, while application
code also has storage-independent domain adapters.

Media routes and storage modules handle streaming/ranges and storage-specific
operations. Pack bundle imports/exports use route admission, spooling, and worker
codec execution; recovery/cleanup has its own lifecycle in `storage\operations.ts`.
Web audio helpers separate levels, snippets/encoding, playback, and preparation.

## Storage, configuration, and integrations

`FRIENDS_TRIVIA_MODE` chooses local or cloud in server configuration.
`domainStore.ts` opens better-sqlite3 locally or the Cosmos store in cloud mode.
Media storage similarly selects filesystem or Azure Blob implementations.
Configuration includes `DATABASE_PATH`, `CONTENT_ROOT`, `WEB_DIST`, network/public
URL settings, cloud identity/storage settings, and optional GIF providers.
Read variable definitions in `config.ts`; keep credential values out of docs.
Cloud startup additionally validates admin password/session-key settings in
`adminAuth.ts` before opening storage. App Service resolves Key Vault references;
the server does not fetch vault secrets. `HostLayout.tsx` gates initial host page
mounting and preserves mounted drafts during reauthentication. Host sockets
separately enforce admin expiry/logout as well as existing room tokens.

The packaged desktop forces local mode, places data/content under Electron
user data, serves packaged web assets, and starts the HTTP server for local/LAN
players. In development it opens the Vite app. This is not FinPulse-style
renderer-to-database IPC.

`infra` and Azure scripts describe deployable resources and operational steps.
They are not proof of effective live permissions, quotas, or proxy policies.
`infra\azure\admin-access.bicep` is a separately approved, secret-scoped RBAC
template for the existing shared vault in `Common`; it creates no secrets.

## Development and validation

Run from the repository root:

| Command | Purpose |
|---|---|
| `npm run dev` | Shared package watcher, server, and web development |
| `npm run build` | Shared, web, and server builds |
| `npm run typecheck` | Shared build plus server/web/desktop typechecks |
| `npm run lint` | Run existing workspace lint scripts |
| `npm run test` | Shared build and shared/server/web Vitest suites |
| `npm run test -w @friends-trivia/server -- src/socket.test.ts` | Focused server socket suite |
| `npm run test -w @friends-trivia/web -- src/lib/audioPlayback.test.ts` | Focused audio suite |
| `npm run desktop:dev` | App development plus Electron host |

Shared imports may require its build before standalone workspace checks.
`npm run desktop:install` explicitly installs desktop dependencies.
`desktop:build` installs/builds/packages and can fetch native dependencies;
`desktop:release` publishes through PowerShell automation. Azure scripts and
live cloud tests need explicit environment authorization; none is a
documentation-validation shortcut.

## Where to make changes and related documentation

| Task | Start here |
|---|---|
| Host/player/display interactions | `apps\web\src\pages`, room hooks, socket/snapshot helpers |
| Rules, timers, scores | Shared scoring/contracts, server engine and repositories |
| Library and history APIs | Server routes/repositories and web REST client |
| Audio and uploads | Web audio modules, server media routes and storage |
| Local/cloud persistence | Domain contracts, SQLite adapter, and `cloud` adapters |
| Desktop/network startup | `apps\desktop\src\main.ts`, server network/configuration modules |
| Deployment or release | `infra`, Azure scripts, desktop manifest and release script |

Read [README](../README.md), [Copilot instructions](copilot-instructions.md),
and the [shared package manifest](../packages/shared/package.json) for related
context. Tests are adjacent to source in shared/server/web packages. Keep the
map current as contracts and lifecycle boundaries change; this document is not a
runtime or security audit.
