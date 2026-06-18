# HomeMedia

A self-hosted media browser and player for a single mixed-media folder.
Point it at a directory of movies and TV files, and it identifies them
against TMDB, builds a poster-grid library, and streams them to any browser
on your network — no native player, no transcoding pipeline to babysit.

Built for the simplest possible home setup: one machine holds the media and
runs the server; everything else is just a web browser.

> **Why it exists:** to browse and play a messy download folder from the
> couch without installing a media-server stack, and without hitting the
> macOS VLC grey-screen bug. It streams through the browser's native
> `<video>` element, remuxing or transcoding on the fly only when a file's
> codec isn't browser-compatible.

## Features

- **Automatic identification** — walks your media root, parses filenames
  with [`parse-torrent-title`](https://github.com/clems4ever/parse-torrent-title),
  and matches movies and series against TMDB, with optional OMDb / TVDB
  corroboration for the tricky ones.
- **Works offline** — identification, episode metadata, and ffprobe results
  are cached in SQLite, so browsing keeps working even when the media share
  is unreachable.
- **Browser playback** — poster grid → detail → player, with resume
  position, auto-mark-watched, next-episode autoplay, and sibling
  `.srt` / `.vtt` / embedded subtitles.
- **Smart streaming** — plays browser-compatible files directly with HTTP
  byte-range; remuxes MKV on the fly; falls back to an HLS session (NVENC
  hardware encode where available) for incompatible codecs.
- **First-run setup wizard** — a fresh clone boots into a guided wizard;
  configure your TMDB key and media folder right in the UI (no manual
  `.env` editing required). Settings, including key rotation, stay editable
  in-app afterward. API keys are stored locally and never exposed back to
  the browser.
- **Manual rescue** — when the identifier picks the wrong title, fix it from
  the UI (paste a TMDB / IMDb link) or the `npm run review` CLI.

## How it's deployed

```
┌──────────────────────────┐         ┌──────────────────────┐
│  Server machine          │  LAN    │  Any browser         │
│  • holds the media       │ <─────> │  • laptop / TV / iPad│
│  • runs HomeMedia (:3000)│         │  • just opens the URL│
└──────────────────────────┘         └──────────────────────┘
```

The server runs on whichever machine has the media (locally or via a mounted
SMB share). Clients are ordinary browsers on the same network pointed at
`http://<server-ip>:3000`. If the media lives on a separate box behind an SMB
mount, HomeMedia surfaces a "share offline" state and a Reconnect action
rather than crashing when that mount goes stale.

## Requirements

- **Node 20+**
- **`ffmpeg` / `ffprobe`** on your `PATH` (used for probing, remux, and HLS)
- A **free TMDB v3 API key** — https://www.themoviedb.org/settings/api
  (use the v3 *API Key* string, not the v4 read-access JWT)

## Quick start

```bash
git clone https://github.com/Jwho303/HomeMedia.git
cd HomeMedia

npm install
npm run build        # builds the web frontend

npm start            # starts the server on http://localhost:3000
```

Open `http://localhost:3000` and the **setup wizard** walks you through
entering your TMDB key and pointing at your media folder. Then trigger the
first scan from the UI (or run `npm run scan`) and your library appears.

> Prefer config files? Copy `.env.example` to `.env` and fill in
> `TMDB_API_KEY` and `MEDIA_ROOT` instead — the wizard is skipped once both
> are set. See [`.env.example`](.env.example) for every available option
> (player concurrency, encoder pacing, idle timeouts, etc.).

| Key            | Required | Notes                                          |
|----------------|----------|------------------------------------------------|
| `TMDB_API_KEY` | yes\*    | v3 key, not the v4 JWT (\*or set it in the UI) |
| `MEDIA_ROOT`   | yes\*    | absolute path to the media folder              |
| `OMDB_API_KEY` | no       | enables OMDb in the multi-source rescue pass   |
| `TVDB_API_KEY` | no       | enables TVDB in the multi-source rescue pass   |
| `PORT`         | no       | defaults to 3000                               |
| `DB_PATH`      | no       | defaults to `data/media.db`                    |

## Development

```bash
npm run dev:all      # backend (:3000) + Vite dev server (:5173), proxied
npm run dev          # backend only, watching src/
npm run scan         # populate / refresh the DB from MEDIA_ROOT
npm run review       # CLI to manually identify low-confidence files
npm test             # vitest (backend)
npm --prefix web test
npm run typecheck
```

The Vite dev server (`:5173`) proxies `/api` to `http://127.0.0.1:3000`, so
`dev:all` gives you full-stack hot reload.

## Project layout

- [`src/`](src/) — Fastify + TypeScript backend (Node 20+).
  - [`src/server.ts`](src/server.ts) — entry point and route registration.
  - [`src/scan.ts`](src/scan.ts), [`src/identify/`](src/identify/) — folder
    walk and the TMDB / OMDb / TVDB identification pipeline.
  - [`src/streaming/`](src/streaming/), [`src/player/`](src/player/),
    [`src/routes/playback.ts`](src/routes/playback.ts) — byte-range
    streaming, server-driven player instances, and HLS sessions.
  - [`src/cli/`](src/cli/) — `scan` and `review` CLIs.
- [`web/`](web/) — Lit frontend, built with Vite.
- [`schema.sql`](schema.sql) — SQLite schema (idempotent; applied on open).

## API surface

A representative subset (see [`src/routes/`](src/routes/) for the full set):

```
GET  /api/setup-state               first-run wizard state
GET  /api/settings                  current config (secrets masked)
POST /api/settings                  update config

GET  /api/share/status              { online, mountPath, lastSeen }
POST /api/share/reconnect           remount; returns updated status

GET  /api/library                   library tiles (cache-only)
GET  /api/series/:id                series + episode list (cache-only)
GET  /api/playback/*                resume position, watched
POST /api/playback/*                { position, duration }

POST /api/refresh                   incremental scan (mtime diff)
POST /api/refresh?full=true         re-query TMDB for everything

POST /api/player/:playerId/open     open media in a server-driven player
POST /api/player/:playerId/state    client position heartbeat
GET  /api/hls/:sessionId/...        HLS playlist + segments

GET  /api/manual-identify/search    search candidates for a wrong match
POST /api/manual-identify/item/:id  apply a chosen identity
```

Endpoints that need the media share return `503 { error: 'share_offline' }`
when the mount is stale; the UI uses this to drive its share-status banner.

## Non-goals

Automation (Sonarr/Radarr-style), multi-user accounts or per-user watched
state, music / photo libraries, remote/internet viewing, and a full
transcoding farm. HomeMedia stays deliberately small: one folder, one
server, browser playback.

## License

MIT — see [`LICENSE`](LICENSE).
