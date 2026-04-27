# HomeMedia

Personal media browser and player for a single mixed-media folder. Designed
for a Mac Mini that mounts a Windows SMB share and serves the library to a
browser on `localhost`. Avoids native players (and the Catalina VLC
grey-screen bug) by streaming through `<video>` with byte-range and an
optional ffmpeg HLS path.

See [Brief.md](Brief.md) for the original design rationale and constraints.

## What it does

- Walks a media root, parses filenames with `parse-torrent-title`, and
  identifies movies and series via TMDB (with optional OMDb / TVDB
  corroboration).
- Caches identification, episode metadata, and ffprobe results in SQLite so
  browsing keeps working when the share is offline.
- Serves a Lit-based tile grid → detail → player UI. Resume position,
  auto-mark watched, next-episode autoplay, sibling `.srt`/`.vtt`
  subtitles.
- Streams browser-compatible files directly with byte-range; remuxes MKV
  (`-c copy`) on the fly; falls back to an HLS session (NVENC where
  available) for incompatible codecs.
- Surfaces share state (`/api/share/status`) and exposes a Reconnect action
  when the SMB mount goes stale.
- Provides a `npm run review` CLI for manually rescuing files the
  identifier couldn't pin down.

## Layout

- [src/](src/) — Fastify + TypeScript backend (Node 20+).
  - [src/server.ts](src/server.ts) — entry point.
  - [src/scan.ts](src/scan.ts), [src/identify/](src/identify/) — folder walk and identification pipeline.
  - [src/streaming/](src/streaming/), [src/routes/stream.ts](src/routes/stream.ts), [src/routes/hls.ts](src/routes/hls.ts) — byte-range, remux, HLS sessions.
  - [src/cli/](src/cli/) — `scan` and `review` CLIs.
- [web/](web/) — Lit frontend, built with Vite.
- [schema.sql](schema.sql) — SQLite schema (idempotent; applied on every open).
- [docs/specs/](docs/specs/) — phased implementation specs (0.1.1 → 0.1.7).
- [DEPLOY.md](DEPLOY.md) — runbook for the HLS cache, log tags, and quiet-console behavior.

## Setup

Requires Node 20+ and `ffmpeg` / `ffprobe` on `PATH`.

```bash
cp .env.example .env
# fill in TMDB_API_KEY and MEDIA_ROOT (absolute path to the share mount)

npm install
npm --prefix web install
```

`.env` keys (see [.env.example](.env.example) for the full list):

| Key            | Required | Notes                                         |
|----------------|----------|-----------------------------------------------|
| `TMDB_API_KEY` | yes      | v3 key, not the v4 JWT                        |
| `MEDIA_ROOT`   | yes      | e.g. `/Volumes/media` or `D:\TestMedia`       |
| `OMDB_API_KEY` | no       | enables OMDb in the multi-source rescue pass  |
| `TVDB_API_KEY` | no       | enables TVDB in the multi-source rescue pass  |
| `PORT`         | no       | defaults to 3000                              |
| `DB_PATH`      | no       | defaults to `data/media.db`                   |

## Running

```bash
npm run scan         # populate / refresh the DB from MEDIA_ROOT
npm run review       # CLI for manually identifying low-confidence files
npm run dev          # backend only, watching src/
npm run dev:all      # backend + Vite dev server (web on :5173, proxied to :3000)
npm start            # backend, no watch
npm run build        # build the web bundle into web/dist
npm test             # vitest
npm run typecheck
```

The Vite dev server proxies `/api` to `http://127.0.0.1:3000`, so run
`dev:all` for full-stack iteration.

## API surface

```
GET  /api/share/status              { online, mountPath, lastSeen }
POST /api/share/reconnect           remount; returns updated status

GET  /api/library                   tiles (cache-only)
GET  /api/series/:id                series + episode list (cache-only)
GET  /api/playback/:path            resume position, watched
POST /api/playback/:path            { position, duration }

POST /api/refresh                   incremental scan (mtime diff)
POST /api/refresh?full=true         re-query TMDB for everything

GET  /api/stream/:path              range-aware file stream
GET  /api/stream/:path?remux=true   ffmpeg -c copy → fMP4
GET  /api/hls/:sessionId/...        HLS segments (when HLS_PLAYER=true)
```

Endpoints that need the share return `503 { error: 'share_offline' }` when
the mount is stale; the UI uses this to drive the persistent share-status
banner.

## Deployment

Production runs as a service. The HLS cache, log tag reference, and quiet
console behavior are documented in [DEPLOY.md](DEPLOY.md). The Windows
deployment notes live in [docs/specs/0.1.5.3-windows-deployment.md](docs/specs/0.1.5.3-windows-deployment.md).

## Non-goals (v1)

Software on the Windows box beyond the SMB share, transcoding (remux only),
mobile / remote viewing, multi-user watched state, music, photos,
Sonarr/Radarr-style automation.
