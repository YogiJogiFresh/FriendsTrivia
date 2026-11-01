# FriendsTrivia

FriendsTrivia is a LAN-hosted party game with a shared Jeopardy-style board, phone controllers, local music clips, and Price Is Right-style slider clues.

The Windows desktop/LAN setup below remains offline. Optional [Azure hosting](#azure-hosting)
provides one HTTPS website for players on different networks; cloud and local libraries are separate.

## Requirements

- Node.js 20.18 or newer
- A laptop and player phones on the same local network

## Development

```powershell
Copy-Item .env.example .env
npm install
npm run dev
```

The web app runs at `http://localhost:5173` during development and proxies API and Socket.IO traffic to the server at `http://localhost:3000`.

## Production

```powershell
npm run build
npm start
```

Open the URL printed by the server. Place local song clips in `content\songs`; song binaries are intentionally excluded from Git.

## Windows desktop app

Build a standalone Windows installer:

```powershell
npm install
npm run desktop:build
```

The installer is written to `apps\desktop\release\FriendsTrivia-Setup-X.Y.Z.exe`. Recipients do not
need Node.js: installing and opening FriendsTrivia starts the local game server and opens the host
interface. The desktop shortcut and Start menu entry are created by the installer.

Desktop data is stored per Windows user:

- Database: `%APPDATA%\FriendsTrivia\data\friends-trivia.db`
- Songs: `%APPDATA%\FriendsTrivia\content\songs`

Windows may ask the user to allow FriendsTrivia through the firewall. They must allow access on
private networks so phones can join over Wi-Fi.

If port 3000 is already occupied, set `FRIENDS_TRIVIA_PORT` before launching the app to use another
port.

### Automatic updates

The installed app checks `YogiJogiFresh/FriendsTrivia` GitHub Releases at launch. When an update is
available, the user can download it and restart immediately or install it when the app closes.

To publish a release, install and authenticate the GitHub CLI, then run:

```powershell
npm run desktop:release
```

The release script prompts for a semantic version bump, builds the NSIS installer, and uploads the
installer, `latest.yml`, and blockmap to a GitHub release. The repository must exist on GitHub and
the release must include all three artifacts for automatic updates to work.

## Running a game

1. Connect the host computer and player phones to the same Wi-Fi network.
2. Open the printed LAN URL on the host computer.
3. Use **Host a Game** to create or import a pack, arrange categories and clues, and select a pack. Optionally enter 2-8 team names and enable clue specials before creating the room.
4. Open the shared display on the TV/projector and confirm that its audio test plays through the room speakers.
5. Players scan the QR code or open the LAN URL, enter the four-character room code, and choose a team when teams are enabled.
6. Start the game, select clues from the host control, and use the reveal/leaderboard controls between clues.

### Casting the shared display

From the live host room, choose **Cast display**. FriendsTrivia provides the LAN audience-display
link, a QR code for handing it to another device, and instructions for the available casting
method. The audience link opens only `/display/:roomCode`; it does not include host credentials or
host controls.

- **Chrome or Edge:** open the audience display in its own tab, use the browser's Cast command, and
  cast that tab. The host-control tab remains usable and is not shown.
- **Windows wireless display:** press Windows+K and use Extend mode, then move the audience window
  to the TV. Mirroring the host monitor also mirrors the host controls.
- **Mobile host:** scan the handoff QR code from a cast-capable computer or copy the audience link
  to it. Mobile browsers cannot reliably open tab-casting controls.

On the audience screen, choose **Prepare display** before the game. This unlocks audio and requests
fullscreen where the browser permits it. Casting device selection remains a browser or operating
system action; a local web page cannot automatically open the Chrome Cast or Miracast picker.
Every participating device must be on the same local network and able to reach the advertised LAN
address.

In team games, every player's score contributes to their team total. Leaderboards rank teams and
show each member's individual contribution beneath the team.

Enabled clue specials are randomly assigned once when the game starts and remain hidden until their
clue is selected. **Double Points** doubles positive awards, **Double or Nothing** doubles positive
awards but deducts the clue value for incorrect or missing answers, and **Speed Round** halves the
answer timer. **Forced Player** lets everyone nominate another player as the sole answerer; that
player earns the full clue value for a correct answer, while every other player earns it if the
answer is wrong or missing. Each enabled special appears on one different ordinary clue; Final
Question is never eligible.

The host computer's firewall must allow inbound TCP traffic on port `3000`. Some guest Wi-Fi networks isolate devices from one another; use a normal private network or personal hotspot if phones cannot reach the printed LAN URL.

## Content

Supported local audio formats are MP3, M4A, OGG, and WAV, up to 50 MB per file. Files copied directly into `content\songs` are indexed at server startup. Files uploaded through the media library are stored there automatically.

Packs contain ordered categories and clues:

- `music_multiple_choice`: local audio, choices, correct answer, and optional accepted variants.
- `music_free_text`: local audio, a correct answer, and accepted variants.
- `price_slider`: target price, minimum, maximum, step, and display prefix.

Keep packs in draft status until every music clue has a playable media asset and every clue has a valid answer. Exported manifests contain metadata only, not audio files.

Use **Export pack + songs** to download a portable `.friendstrivia` bundle containing the pack and
every local song referenced by its clues or answer reveals. On another FriendsTrivia computer,
choose **Import pack** and select that bundle; its songs are copied into the local media library
and all clue references are restored. Only `.friendstrivia` bundles are accepted for pack imports.

## Data and backup

The SQLite database defaults to `data\friends-trivia.db`. To back up a setup, stop the server and copy both the database file and `content\songs`. Completed and abandoned sessions, submissions, and score adjustments are retained in game history.

Configuration can be changed in `.env`:

| Variable | Default | Purpose |
|---|---:|---|
| `HOST` | `0.0.0.0` | Interface on which the local server listens |
| `PORT` | `3000` | HTTP and Socket.IO port |
| `JOIN_PORT` | `5173` in development; otherwise `PORT` | Port used in generated player links |
| `PUBLIC_URL` | detected | Override the URL encoded in room QR codes |
| `DATABASE_PATH` | `./data/friends-trivia.db` | SQLite file location |
| `CONTENT_ROOT` | `./content` | Root containing songs and manifests |
| `ROOM_CODE_LENGTH` | `4` | Generated room-code length |
| `GIPHY_API_KEY` | unset | Optional preconfigured GIPHY search key |
| `TENOR_API_KEY` | unset | Optional preconfigured Tenor API v2 search key |

GIF provider keys can also be entered from the clue editor and are retained in the selected
database: SQLite locally or Cosmos DB in cloud mode. Search results use a moderate content
filter, and the selected hosted GIF is
loaded from GIPHY or Tenor when the answer is revealed.
The editor also accepts direct HTTPS links whose path ends in `.gif`; direct links do not require
a provider API key.

## Troubleshooting

- **Phones cannot connect:** confirm the phone and host are on the same private network, try the IP URL printed by the server, and allow Node.js through Windows Firewall on private networks.
- **Audio does not start:** click the audio readiness control on the shared display before starting. Browsers block autoplay until the page receives a user gesture.
- **A TV cannot open the display:** confirm it is on the same Wi-Fi as the host and that the
  advertised LAN URL opens on another device. Guest-network client isolation and Windows Firewall
  can block cast receivers even when internet access works.
- **Host controls appear on the TV:** cast only the audience display tab. For Miracast, use Extend
  rather than Duplicate mode, or open the handoff link on another computer.
- **The host page was refreshed:** reopen the room using its saved host token; the server remains authoritative and sends the current snapshot.
- **The server restarted mid-game:** active games are restored in a paused state. Reconnect the host and resume when all players are back.

## Azure hosting

**Live application:** https://friends-trivia-4gmpdw66gsmkw.azurewebsites.net

The approved Central US deployment uses Cosmos DB and private Blob Storage; local/desktop
hosting still uses independent SQLite/filesystem data. No local data was uploaded.
Public 50-player WebSocket gameplay, creator-token isolation, audio ranges, frozen packs and
paused restart recovery were verified using generated fixtures, which were removed afterward.

### Architecture and spending approval

Target subscription: `299e641c-a5ad-4736-a74e-31ee5da9aef6`; resource group:
`friendsTrivia-app`; region: **Central US**; named human owner: **YogiJogiFresh**.
The group's East US metadata does not constrain resource locations.
`infra\azure\main.bicep` defines one Cosmos DB for NoSQL **serverless** account, production
`friends-trivia` and isolated `friends-trivia-tests` databases, `games`/`library` containers
(partition key `/pk`), and private **LRS** Blob containers `songs`/`songs-tests`.
Both games containers include ordered composite indexes for submission elapsed-time/ID and
price/player-ID sorting; resource verification rejects missing or incorrectly ordered indexes.
`-IncludeApplication` adds one Linux App Service **B1**, **Node 22 LTS**, Always On, HTTPS,
WebSockets and `/api/health`, serving React/backend from the same origin. No Static Web Apps,
Redis, registry, CDN, autoscaling or additional worker is included.

**Provisioning requires explicit approval of the reviewed resource, cost and IAM preview.** Central US
retail quote (October 2026): Linux B1 `$0.018/hour × 730 = $13.14/month`;
Cosmos `$0.282/million RU` plus `$0.25/GB-month` data; Hot LRS Blob `$0.0184/GB-month`
(`5 GB = $0.092/month` live capacity). Include test traffic/data, indexes, backups, retained
Blob versions, storage operations, internet egress, logs and taxes. Serverless has no
provisioned RU/s or assumed free-tier allowance. Refresh prices with the
[Azure calculator](https://azure.microsoft.com/pricing/calculator/) and
[Retail Prices API](https://prices.azure.com/api/retail/prices).
The **US$40 monthly alert**, at 80%/100% actual and 100% forecast, is **not a spending cap**.
The approved deployment uses USD billing and subscription Owner notifications.
Public use can incur unbounded traffic charges.

### Guarded provisioning and identity bootstrap

Use Azure CLI and PowerShell 7 as your approved human administrator. No long-lived keys,
passwords, publish profiles or client secrets are used. Defaults are no-action dry runs:

```powershell
az account set --subscription 299e641c-a5ad-4736-a74e-31ee5da9aef6
pwsh -File scripts\AzureSetup.ps1
$env:AZURE_BUDGET_EMAIL = Read-Host 'Budget notification destination'
pwsh -File scripts\AzureSetup.ps1 -WhatIf
# Full architecture preview, still no provisioning:
pwsh -File scripts\AzureSetup.ps1 -WhatIf -IncludeApplication
# Alternatively, explicitly route notifications to subscription Owners (no email input):
pwsh -File scripts\AzureSetup.ps1 -WhatIf -NotifySubscriptionOwners
# ONLY after revised resource/cost, identity creation and what-if approval:
pwsh -File scripts\AzureSetup.ps1 -Provision -ResourceCostApproved -IdentitySetupApproved -WhatIfReviewed
# Add -IncludeApplication only when approved; data/test target can exist before app release.
```

Setup never recreates the existing group. It fails closed on restricted Central US **regular**
Cosmos access (no zone redundancy), unavailable Linux B1/Node22, or ARM provider validation
errors, including permissions/policy/quota errors. Read all proposed modifications before
applying. Later full-template updates can replace app settings: preserve additional provider
configuration and confirm the actual `PUBLIC_URL` is reapplied by setup.
Budget destination comes from the current shell, is a secure Bicep parameter, and is never
committed or printed by scripts. Azure budgets necessarily retain the destination.
Clear it afterwards: `Remove-Item Env:AZURE_BUDGET_EMAIL`.
`-NotifySubscriptionOwners` uses Azure budget `contactRoles=['Owner']` instead of a personal
address; selecting this in a preview does not authorize binding it or creating any resource.

Creation/federation and data grants are separate approval gates. Three named identities have
the named human owner tag. `infra\azure\access.bicep` gives:

| Identity | Allowed scope |
|---|---|
| `friends-trivia-runtime` | Cosmos Data Contributor on production database only; Blob Data Contributor on `songs` only |
| `friends-trivia-tester` | Cosmos Data Contributor on test database only; Blob Data Contributor on `songs-tests` only |
| `friends-trivia-deployer` | Website Contributor on the application only; no database, Blob, infrastructure-owner or role-assignment grants |

```powershell
pwsh -File scripts\AzureBootstrap.ps1 -WhatIf
# Optional approved human developer access is TEST ONLY:
pwsh -File scripts\AzureBootstrap.ps1 -WhatIf -DeveloperTestObjectId <approved-Entra-user-object-id>
# After separate IAM preview/grant approval (repeat DeveloperTestObjectId if approved):
pwsh -File scripts\AzureBootstrap.ps1 -Bootstrap -GrantApproved -WhatIfReviewed
pwsh -File scripts\AzureVerify.ps1
```

No grants are executed by default or by setup. Run bootstrap again after adding the app to
grant its deployer; allow RBAC propagation before live tests. The human bootstrap identity
needs resource/budget, federation and role-assignment permissions; routine identities do not.
Cosmos key authorization and Blob shared-key/public-container access are disabled.
Data endpoints remain network reachable but require scoped Entra authorization; this is
private **container access**, not a provisioned private endpoint/VNet architecture.

### Public application and configuration

**No sign-in, shared password or Easy Auth.** Anyone can create games and read/edit/delete
the shared library, media and history, including answers. This can disrupt games or erase
content. Creating a room automatically retains its creator control token; knowing the room
code does not authorize host commands or host-only snapshots. Rate/input/storage limits are
not authentication. Serve only media you have permission to share.

Browser mutations and WebSocket connections are checked against the application origin;
local hosting also accepts its actual local origin when `PUBLIC_URL` advertises a tunnel.
The Vite proxy preserves the browser Host header for development. Cloud HTTP rate limiting
trusts only internal proxy address ranges, not arbitrary forwarded headers; verify the
actual App Service proxy chain during hosted acceptance.

`friends-trivia` deployment outputs include actual endpoints, production/test configuration,
identity names/object IDs/client IDs and tenant ID. Setup reads the actual App Service hostname
and configures `PUBLIC_URL`; `AzureVerify.ps1` checks persisted resources/settings, not just
the template. In cloud mode configure:

| Setting | Value |
|---|---|
| `FRIENDS_TRIVIA_MODE` | `cloud` |
| `NODE_ENV`, `HOST`, `PORT` | `production`, `0.0.0.0`, `8080` |
| `PUBLIC_URL` | actual `https://<defaultHostName>` |
| `COSMOS_ENDPOINT` | account's actual document endpoint |
| `COSMOS_DATABASE` | `friends-trivia` |
| `COSMOS_GAMES_CONTAINER`, `COSMOS_LIBRARY_CONTAINER` | `games`, `library` |
| `AZURE_CLIENT_ID` | runtime managed identity client ID |
| `AZURE_STORAGE_ACCOUNT_URL`, `AZURE_STORAGE_CONTAINER` | actual Blob endpoint, `songs` |

Runtime uses managed identity and validates existing resources; it does not create them or
silently fall back to SQLite. Ordinary local/desktop mode keeps SQLite/filesystem storage,
existing data and offline startup; cloud SDK initialization remains lazy.
The initial cloud library is empty. No scripts upload local SQLite or song data.
Cloud rooms freeze a room-owned pack copy; subsequent library edits do not alter that room.
Cloud song deletion fails while a library pack or saved room references it.
The application manages a **5,000,000,000-byte live-song quota**; it is not an Azure account
limit and excludes billable backups/retained versions. Local storage remains uncapped.
Existing per-song/bundle limits remain. Cloud bundle processing uses Node's temporary
directory rather than writing into the deployed application directory; verify maximum-size
imports and writable scratch capacity on B1 before a live game.

### CI readiness and later deployment

`.github\workflows\azure-deploy.yml` performs **offline build and infrastructure readiness**:
SQLite/offline cloud tests, lint/types, Linux-native packaging, script guards and Bicep
compilation. It retains a uniquely named Linux ZIP in GitHub Actions for 14 days, preserving
earlier run artifacts for compatible rollback. It never provisions Azure resources.
`AzureArtifactSmoke.mjs` runs against an independently extracted ZIP, with Azure SDK imports
forbidden, checking native SQLite, local HTTP/deep links, WebSockets, bundle workers and
App Service's local-mode rejection. Its generated data is isolated and removed afterward.
Production delivery is **disabled by default**. After separate provisioning/IAM approval,
actual target verification and live acceptance, set repository variable
`AZURE_DEPLOYMENT_ENABLED=approved-after-live-acceptance` to enable delivery on `main` pushes.
Every enabled release must pass both real isolated SDK runners; offline/skipped tests cannot
authorize deployment. Manual `run_live_tests` dispatches never publish.
Manual isolated acceptance uses separate opt-in, fail-closed **Cosmos and Blob SDK** live runners.
Both have passed against the approved real isolated Azure targets; mocked tests alone do
**not** provide real cloud acceptance. The Cosmos case covers a frozen 50-player room,
price scoring, library edits, history deletion and owned cleanup. The Blob case covers private
full/ranged reads, rejected overwrites without deleting existing content, and conditional cleanup.
Temporary operator test-only grants were removed after acceptance; the scoped service identities remain.
It uses Linux Node22 and Azure login OIDC into protected `azure-tests`, exact subject
`repo:YogiJogiFresh@12243528/FriendsTrivia@1362058355:environment:azure-tests`.
GitHub uses immutable owner/repository IDs in this repository's OIDC subjects; Azure
federation must match that exact subject format, not the names-only format.
Set environment variables `AZURE_TENANT_ID`, `AZURE_TEST_CLIENT_ID`, `COSMOS_ENDPOINT`,
`COSMOS_TEST_EXPECTED_ENDPOINT`, `COSMOS_TEST_ACCOUNT_RESOURCE_ID`, and
`AZURE_STORAGE_ACCOUNT_URL` from verified outputs.
Restrict environment access to `main` and approved reviewers.
The current deployment's protected environments, scoped identities and release variables are
configured. The workflow changes remain uncommitted/unpushed; publishing them to `main` is
still required before GitHub Actions can perform OIDC delivery. No remote workflow run is
claimed by the local SDK acceptance or manual deployment.

`AzureTestTarget.ps1 -Run` requires the exact expected endpoint, the test database and test Blob
container, plus a unique bounded `FRIENDS_TRIVIA_TEST_RUN_ID`. Before credentials, it also
requires `FRIENDS_TRIVIA_COSMOS_LIVE=approved-isolated-target` and
`COSMOS_TEST_TARGET_VERIFIED=approved-account-and-isolated-database`, and an account resource ID
matching the exact subscription, group and endpoint account. Set these flags **only after**
separate approval and actual target verification; neither scripts nor workflow populate
approval/verification flags automatically. CI reads them from protected environment variables.
`AzureTestTarget.ps1 -ValidateTarget` checks supplied gates offline, not actual Azure resources.
The `apps\server\src\cloud\cosmos.live.test.ts` runner explicitly injects `AzureCliCredential`
(short-lived Azure login/OIDC), allows six minutes for sequential remote operations and cleanup,
reports stage timings and cleans up **only run-owned Cosmos documents**
in `finally`, retaining a unique run fence to prevent reuse. Never delete a database/account/container or allow
test credentials production access. Audit orphaned run-owned data after killed CI jobs.
Mocked tests are not live acceptance and a missing real runner is a failure, not a skip.
`AzureBlobTestTarget.ps1 -ValidateTarget` and `-Run` use the separately guarded
`apps\server\src\cloud\blob.live.test.ts` harness. Build shared/server first. Supply
`AZURE_STORAGE_TEST_EXPECTED_ENDPOINT`, `AZURE_STORAGE_TEST_ACCOUNT_RESOURCE_ID`,
`FRIENDS_TRIVIA_BLOB_LIVE=approved-isolated-target` and
`BLOB_TEST_TARGET_VERIFIED=approved-account-and-isolated-container` only after approval and
verification; the account must match the subscription/group and `songs-tests` is mandatory.
The runner checks private-container streaming, byte ranges and overwrite rejection using
small generated fixtures. Cleanup conditionally deletes only confirmed run-owned media,
retains a unique fence, and surfaces uncertain uploads for inspection rather than deleting
unconfirmed data. These are storage SDK checks, not complete hosted/load/restore acceptance.

The separate **azure-deployment** todo must complete SQLite/Cosmos/Blob acceptance, Linux packaging,
serialized release, prior-artifact retention and public smoke checks before production upload.
Its protected `azure-production` environment uses `AZURE_TENANT_ID`,
`AZURE_DEPLOY_CLIENT_ID`, `AZURE_APP_NAME`, and
`FRIENDS_TRIVIA_RELEASE_APPROVED=approved-after-live-acceptance`, with the exact environment-bound
OIDC subject. Configure approved reviewers and `main`-only access before enabling delivery;
none of those remote settings are created by this workflow. Production retrieves the
successful build's immutable artifact ID and verifies its SHA256 before Azure login, including
when retrying only failed jobs. Do not set approval flags from default/example settings.
There is no SQL migration service/job. `AzureMigrate.ps1 -Migrate` intentionally rejects obsolete
cloud migration usage; local SQLite migrations remain unchanged.
Linux Node22 packaging preserves workspace layout/native dependencies; never deploy Windows
`node_modules`. Keep both Linux and Windows native Rollup entries in the lockfile; Windows
dependency updates can otherwise leave a lockfile that fails a fresh Linux `npm ci`/Vite build.
`AzureChecks.ps1` checks those platform entries against the locked Rollup version.
`AzureDeploy.ps1` additionally requires `-Deploy -ReleaseApproved` after that
release gate. It waits for an uncached healthy response with a new application boot ID,
not an old worker's health or Azure's potentially stale cold-start tracker.
No commit or remote upload is performed by readiness checks:

```powershell
pwsh -File scripts\AzureChecks.ps1
az bicep build --file infra\azure\main.bicep --stdout
az bicep build --file infra\azure\access.bicep --stdout
```

### Recovery, rollback and monitoring

Cosmos uses **periodic backups every four hours, retained 24 hours, Local redundancy**.
This is not continuous point-in-time recovery. Deleted/corrupted data may require an Azure
support restore request to a **new account**; confirm eligibility, available restore points,
time and costs and rehearse the procedure before relying on it. A longer/continuous policy
needs separate compatibility and cost approval.
Blob/container soft deletion retains seven days; old versions/snapshots expire after 14 days
(soft deletion can retain expired data another seven days). Current versions are not expired.
This bounds retention time, not bytes/billing.
Restore Cosmos and matching Blob versions **together** into an isolated target; verify media
references before switching endpoints. Never overwrite local data or blindly rewind production.

One instance/Node worker is intentional: timers/broadcasts are process-local. Updates interrupt
games; interrupted rooms must recover paused. Basic B1 has no slot/zero-downtime promise.
Rollback only to code compatible with the current document versions; never automatically
rewind data. Monitor App CPU/memory/connections/5xx, Cosmos RU/429/latency/data/index growth
and Blob capacity/transactions/egress. HTTP logs retain three days/35 MB; no paid Log Analytics
workspace is created. Do not log tokens, provider secrets, unrevealed answers or songs.
Rehearse 50-player play, restart/redeployment and paired restore on the real target before
an event. Cloud hosting does not remove Chrome Cast/Miracast device-network restrictions.
