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

When the board is complete, **Start Final Question** opens the existing wager stage if the pack
has a Final Question. It does not start automatically. After the Final leaderboard, choose
**Finish game** to show the winners.

Enter submits a free-text answer just like **Submit answer**, including Link and Final Question.
Host controls and Display show answered-player names in real time, without revealing their answers.
Status-only player IDs are public progress data; player screens do not display the live names.
On Display, answered names float across the clue area, including over the question, GIF and timer.
Bubbles bounce apart with a brief silent glow when they meet; controls remain clickable.
Measured crowding switches to a compact static layout, without a fixed player-count cutoff.
Bubbles freeze during pause/reconnection and remain until Reveal or leaving the clue.
A live all-answered transition gets one silent celebration; reduced motion uses static names.
Large rooms trade text size for keeping every name visible.

At the leaderboard stage, host, Display and player screens show multiple-choice counts and
percentages or each player's exact free-text response. Percentages include all currently eligible
players, including disconnected seats, with **No answer** shown separately; whole-number rounding
can make the total differ from 100%. Forced Player counts only the selected player. Team games
still show individual responses beside the team leaderboard. Long results scroll manually;
they sit beside the leaderboard on wide screens and stack on narrow screens.
Display presents multiple-choice results as colored bars, with percentages inside and player
counts to the right; **No answer** is neutral. Host/player statistics keep their table view.

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
answer is wrong or missing. Each enabled special appears on one different ordinary, non-Link clue;
Link clues and Final Question are never eligible. The pack needs at least as many eligible clues
as selected specials.

The host computer's firewall must allow inbound TCP traffic on port `3000`. Some guest Wi-Fi networks isolate devices from one another; use a normal private network or personal hotspot if phones cannot reach the printed LAN URL.

## Content

Supported local audio formats are MP3, M4A, OGG, and WAV, up to 50 MB per file. Files copied directly into `content\songs` are indexed at server startup. Files uploaded through the media library are stored there automatically.

Packs contain ordered categories and clues:

- `music_multiple_choice`: local audio, choices, correct answer, and optional accepted variants.
- `music_free_text`: local audio, a correct answer, and accepted variants.
- `price_slider`: target price, minimum, maximum, step, and display prefix.

The editor's **Link · Four songs** option uses free-text answers with four distinct Media Library
clips. Select the four songs in playback order and enter a delayed hint. The hint delay defaults
to 10 seconds (whole seconds from 0 to 300). Players can answer immediately; the text and optional
question GIF appear on Display/player screens when the delay expires. Link can also be the Final
Question, starting only after wagering.

For Link clues, **Answer reveal > Songs and artists** accepts optional multiline text
(up to 2000 characters). It appears beneath the correct answer on Display, player screens
and Board Preview only after reveal. It does not change accepted answers or scoring.

For price clues, **Answer reveal > Price and details** accepts optional multiline text
(up to 2000 characters), shown beneath the correct price on the same three screens only
after reveal, including Final Questions. The numeric **Correct price** still controls scoring;
the additional text does not replace it.

Price clues have an **Allow Overbid** checkbox, enabled by default, including for
existing clues without this setting. Guesses rank by distance above or below the
correct price; equally close guesses tie. Turn it off to restore closest without
going over. The existing distance-based points curve is unchanged; distant guesses
can earn zero, and a correct price equal to Min still gives points only for an exact
guess. Final Questions award wagers to all equally closest eligible guesses.
Forced Player always requires an exact price.

On the shared Display's answer reveal, a price number line shows every submitted
name and amount, with an amber correct-price marker and teal guess markers.
Crowded labels use connected rows and coincident prices share a label. It includes
Final Questions, stays hidden before reveal, and keeps the ordinary three closest
guesses and their points below it. Host, player and editor preview screens do not
show the number line. Large groups/long names can reduce fitted text size; use
Display zoom and panning to inspect details.

Display loops songs 1 through 4 until **Reveal**, including after answers close. Pause freezes
playback and the hint delay; Replay Link audio restarts song 1 without resetting either the hint
or answer clock. Reveal uses its separate song/GIF settings. Audio loading does not postpone the
game clock. Editor previews are manual and show the hint immediately with its configured delay.

Keep unfinished packs in draft status. Ordinary music attachments are optional; Link needs four
different songs, a hint and a valid free-text answer before saving. Exported manifests contain
metadata only, not audio files.

Use **Export pack + songs** to download a portable `.friendstrivia` bundle containing the pack and
every local song referenced by its clues or answer reveals. On another FriendsTrivia computer,
choose **Import pack** and select that bundle; its songs are copied into the local media library
and all clue references are restored. Only `.friendstrivia` bundles are accepted for pack imports.
Link-containing bundles require a Link-capable version of FriendsTrivia (bundle version 3);
older version-2 bundles remain importable.

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

**Cloud hosting and pack APIs require the shared admin passphrase; players and Display
remain password-free.** There are no accounts or Easy Auth. Local/desktop hosting retains
its password-free behavior. Creating a room also retains a separate creator control token;
the admin unlock does not replace that token or transfer an existing room to another device.

The cloud gate covers pack list/detail/create/edit/delete, bundle import/export, room
creation, host-session/end HTTP calls, host socket commands/recovery decisions, and private
host updates. **Media management/streaming, GIF provider configuration/search, and history
APIs remain public, including their existing mutation capabilities.** They can still expose
information or erase content; this is not whole-application authentication. Serve only
media you have permission to share.

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
| `FRIENDS_TRIVIA_ADMIN_PASSWORD` | resolved non-empty admin passphrase, at most 1024 UTF-8 bytes; use a Key Vault reference |
| `FRIENDS_TRIVIA_ADMIN_SESSION_KEY` | separate random 32-byte key encoded as 64 hexadecimal characters; use another Key Vault reference |

#### Account-free admin unlock and Key Vault

The operator-selected password reference is:

```text
@Microsoft.KeyVault(SecretUri=https://kai-home-apps-kv.vault.azure.net/secrets/friendTriviaAdminPassword/6141e7dbdda842eabb086dd8e03cfde9)
```

This URI is a reference, not the password. Do not fetch or paste the secret into chat,
source, URLs, scripts, command-line arguments, browser storage, or build logs. App Service
resolves it into the server setting; the application does not call Key Vault on requests.
The existing secret must contain the actual typeable passphrase, not a password hash or
hexadecimal key. Shorter passwords are accepted, but prefer a long memorable passphrase
because short passwords are easier to guess. The server uses bounded asynchronous scrypt
verification and limits unlock attempts before hashing.
Missing, malformed, or unresolved cloud credentials stop startup before opening storage.
There is no default password or public initial-setup endpoint.

Reuse `kai-home-apps-KV` in resource group `Common`, not a new vault. The App Service
user-assigned `friends-trivia-runtime` identity needs secret-read permission on **only**
`friendTriviaAdminPassword` and the separate session-key secret (suggested name
`friendTriviaAdminSessionKey`). Set the site's `keyVaultReferenceIdentity` to that identity's
full Azure resource ID; `AZURE_CLIENT_ID` alone does not configure reference resolution.
`infra\azure\admin-access.bicep` declares the two secret-scoped Key Vault Secrets User grants
for an **existing RBAC-enabled vault**. Review its what-if in `Common` and obtain explicit
IAM approval before deploying it. Never migrate the shared vault's access model, grant
resource-group/vault-wide access to unrelated secrets, or grant production-vault access to
the tester. Vault firewall/private-endpoint reachability must also be confirmed separately.

The owner provisions the separate key privately. On an approved operator workstation with
PowerShell 7 and `Az.KeyVault` already available, the following creates a new key version
without printing the key or passing it through process arguments. It **writes a vault
secret** and must only be run after explicit provisioning approval, with the intended Azure
context selected and diagnostic/transcript logging disabled:

```powershell
$key = [Convert]::ToHexString([Security.Cryptography.RandomNumberGenerator]::GetBytes(32))
$value = ConvertTo-SecureString $key -AsPlainText -Force
$secret = Set-AzKeyVaultSecret -VaultName 'kai-home-apps-KV' -Name 'friendTriviaAdminSessionKey' -SecretValue $value
$secret.Id # Version-pinned reference only; never output $key or the secret value.
Remove-Variable key, value, secret
```

Configure `FRIENDS_TRIVIA_ADMIN_SESSION_KEY` with
`@Microsoft.KeyVault(SecretUri=<the returned version-pinned URI>)`. Do not reuse the
passphrase as the session key. `AzureSetup.ps1 -IncludeApplication` accepts
`-AdminPasswordSecretUri` (defaulting to the selected reference) and requires
`-AdminSessionKeySecretUri`; pass those same URIs on future infrastructure deployments so
settings are not removed. The template does not create secrets or grant vault access.

The unlock form accepts paste and password managers. A host-only HttpOnly, Secure,
SameSite=Strict cookie unlocks a browser for **seven days from login**, without sliding
renewal. Auth/private pack responses are not cacheable. Host tools offer **Lock host tools**;
expiry or logout hides the still-mounted editor so unsaved drafts survive re-unlock.
Drafts remain in browser memory and are still lost on reload/navigation. Re-unlock obtains
fresh host state with the room token and never automatically replays mutations.

Logout clears this browser's cookie and stops its existing private host connections.
Same-browser host tabs coordinate access changes. This is a stateless cookie: a separately
copied cookie is a bearer credential and remains valid until expiry or global rotation;
there is no per-device registry/revocation. Rotating either the passphrase or session key
invalidates old unlocks **once the new configuration is active**. Version-pinned references
require an explicit approved reference update/restart; merely creating a new vault version
does not rotate the app. Versionless references can be cached by App Service for 24 hours.

Provision/confirm both references before deploying the auth-required build. Settings
updates and deployment can restart production, so confirm live games are closed first.
Preserve the existing exact-SHA checks and protected release approvals. Rolling back to a
pre-auth build removes this protection and does not undo unauthorized writes or disclosure.
See [App Service Key Vault references](https://learn.microsoft.com/en-us/azure/app-service/app-service-key-vault-references)
for reference resolution and managed-identity configuration.

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
