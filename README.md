# HomeMedia

**Watch your own movies and TV shows in any web browser — on your laptop, phone, tablet, or TV.**

HomeMedia looks at a folder of movie and TV files on your computer, figures
out what each one is (cover art, titles, episode names), and turns it into a
tidy, clickable library you can play from any device on your home Wi-Fi. No
subscriptions, no uploading anything to the internet — it all stays on your
own computer.

---

## Getting started (the easy way)

You only do steps 1–2 once.

### 1. Get the HomeMedia files

Click the green **Code** button near the top of this page → **Download ZIP**,
then unzip it somewhere easy to find (like your Desktop).

> Already comfortable with git? `git clone https://github.com/Jwho303/HomeMedia.git` instead.

### 2. Get a free movie-database key

HomeMedia uses **TMDB** (a free movie database) to find cover art and titles.

1. Make a free account at **https://www.themoviedb.org/signup**
2. Go to **https://www.themoviedb.org/settings/api** and request an API key
   (choose "Developer", accept the terms).
3. Copy the **API Key (v3 auth)** string — you'll paste it into HomeMedia in a
   moment. Keep it handy.

### 3. Start HomeMedia

Open the `scripts` folder and **double-click**:

- **Windows:** `start-homemedia.bat`
- **Mac:** `start-homemedia.command`
  *(First time, Mac may block it — right-click the file → **Open** → **Open**.)*

The very first time, it will spend a few minutes downloading what it needs and
setting itself up. **This is automatic** — you don't have to install anything
yourself. When it's ready, it shows you a web address like:

```
On THIS computer, open:   http://localhost:3000
On your phone/TV, open:   http://192.168.1.20:3000
```

Leave that window open while you're watching. Closing it stops HomeMedia.

### 4. Open it and finish setup

Open the address in your web browser. The first time, HomeMedia walks you
through a short setup:

- Paste in the **TMDB key** from step 2.
- Point it at your **media folder** (where your movie/TV files live).

Then it scans your folder and builds your library. Done — click a poster and
press play.

---

## Watching on your TV, phone, or tablet

As long as the other device is on the **same Wi-Fi**, just open the
`http://192.168.x.x:3000` address that the start window printed. Bookmark it
and you're set.

> If another device can't connect, your computer's firewall may be blocking
> it. On Windows, allow the app through when prompted (or allow inbound TCP
> port 3000). On Mac, allow incoming connections when asked.

---

## Everyday use

- **To watch:** double-click the start file, open the address, pick something.
- **Added new movies/TV?** Use the **Refresh** button in HomeMedia to pull in
  new files. (It only looks at what changed, so it's quick.)
- **Wrong cover or title?** Open the item and use **Identify** to fix it —
  paste a TMDB or IMDb link for the correct one.
- **To stop:** close the start window.

---

## What HomeMedia does and doesn't do

**It does:** browse and play one folder of movies and TV in the browser,
remember your place, auto-play the next episode, show subtitles, and keep
working even if the media drive briefly disconnects.

**It doesn't:** download or manage content for you, support multiple separate
user accounts, handle music or photos, or stream over the internet (it's for
your home network). It deliberately stays small and simple.

---

<details>
<summary><strong>For developers / advanced setup</strong> (click to expand)</summary>

### Requirements

The start scripts fetch a portable copy of **Node.js 20+** and **ffmpeg** into
a local `.runtime/` folder if they aren't already on your `PATH`, so no manual
install is needed. If you'd rather use your own:

- **Node 20+**
- **`ffmpeg` / `ffprobe`** on your `PATH`

### Manual run

```bash
npm install
npm run build        # build the web frontend
npm start            # serve on http://localhost:3000 (set HOST=0.0.0.0 for LAN)
```

Configure via the in-app wizard, or copy `.env.example` to `.env` and set
`TMDB_API_KEY` and `MEDIA_ROOT`. Full option list (player concurrency, encoder
pacing, idle timeouts, etc.) is documented in [`.env.example`](.env.example).

| Key            | Required | Notes                                          |
|----------------|----------|------------------------------------------------|
| `TMDB_API_KEY` | yes\*    | v3 key, not the v4 JWT (\*or set it in the UI) |
| `MEDIA_ROOT`   | yes\*    | absolute path to the media folder              |
| `OMDB_API_KEY` | no       | enables OMDb in the multi-source rescue pass   |
| `TVDB_API_KEY` | no       | enables TVDB in the multi-source rescue pass   |
| `PORT`         | no       | defaults to 3000                               |
| `DB_PATH`      | no       | defaults to `data/media.db`                    |

### Development

```bash
npm run dev:all      # backend (:3000) + Vite dev server (:5173), proxied
npm run dev          # backend only, watching src/
npm run scan         # populate / refresh the DB from MEDIA_ROOT
npm run review       # CLI to manually identify low-confidence files
npm test             # vitest (backend)
npm --prefix web test
npm run typecheck
```

### Project layout

- [`src/`](src/) — Fastify + TypeScript backend (Node 20+).
  - [`src/server.ts`](src/server.ts) — entry point and route registration.
  - [`src/scan.ts`](src/scan.ts), [`src/identify/`](src/identify/) — folder
    walk and the TMDB / OMDb / TVDB identification pipeline.
  - [`src/streaming/`](src/streaming/), [`src/player/`](src/player/),
    [`src/routes/playback.ts`](src/routes/playback.ts) — byte-range
    streaming, server-driven player instances, and HLS sessions.
  - [`src/cli/`](src/cli/) — `scan` and `review` CLIs.
- [`web/`](web/) — Lit frontend, built with Vite.
- [`scripts/`](scripts/) — one-click start launchers and helpers.
- [`schema.sql`](schema.sql) — SQLite schema (idempotent; applied on open).

### How streaming works

Browser-compatible files are served directly with HTTP byte-range. MKV is
remuxed on the fly; codecs the browser can't play fall back to an HLS session
(using NVENC hardware encoding where available). Identification, episode
metadata, and ffprobe results are cached in SQLite so browsing keeps working
when the media share is offline; endpoints that need the share return
`503 { error: 'share_offline' }`, which drives the UI's reconnect banner.

</details>

## License

MIT — see [`LICENSE`](LICENSE).
