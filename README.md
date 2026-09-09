# FriendsTrivia

FriendsTrivia is a LAN-hosted party game with a shared Jeopardy-style board, phone controllers, local music clips, and Price Is Right-style slider clues.

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
3. Use **Host a Game** to create or import a pack, arrange categories and clues, and select a pack. Optionally enter 2-8 team names before creating the room.
4. Open the shared display on the TV/projector and confirm that its audio test plays through the room speakers.
5. Players scan the QR code or open the LAN URL, enter the four-character room code, and choose a team when teams are enabled.
6. Start the game, select clues from the host control, and use the reveal/leaderboard controls between clues.

In team games, every player's score contributes to their team total. Leaderboards rank teams and
show each member's individual contribution beneath the team.

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
| `PUBLIC_URL` | detected | Override the URL encoded in room QR codes |
| `DATABASE_PATH` | `./data/friends-trivia.db` | SQLite file location |
| `CONTENT_ROOT` | `./content` | Root containing songs and manifests |
| `ROOM_CODE_LENGTH` | `4` | Generated room-code length |
| `GIPHY_API_KEY` | unset | Optional preconfigured GIPHY search key |
| `TENOR_API_KEY` | unset | Optional preconfigured Tenor API v2 search key |

GIF provider keys can also be entered from the clue editor and are retained only in the local
SQLite database. Search results use a moderate content filter, and the selected hosted GIF is
loaded from GIPHY or Tenor when the answer is revealed.
The editor also accepts direct HTTPS links whose path ends in `.gif`; direct links do not require
a provider API key.

## Troubleshooting

- **Phones cannot connect:** confirm the phone and host are on the same private network, try the IP URL printed by the server, and allow Node.js through Windows Firewall on private networks.
- **Audio does not start:** click the audio readiness control on the shared display before starting. Browsers block autoplay until the page receives a user gesture.
- **The host page was refreshed:** reopen the room using its saved host token; the server remains authoritative and sends the current snapshot.
- **The server restarted mid-game:** active games are restored in a paused state. Reconnect the host and resume when all players are back.
