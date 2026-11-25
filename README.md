# Wheelstash

Wheelstash is a self-hosted collection tracker for Hot Wheels collectors. It catalogs cars, flags rare or valuable finds, and generates a weekly in-store hunt list. It runs entirely on your machine. There are no paid services.

This project is unofficial and is not affiliated with, endorsed by, or sponsored by Mattel.

This app is intended for a local or trusted network (for example your LAN or a tailnet). It has no login or access control.

**Full install instructions** for Docker, Node, TrueNAS SCALE, Proxmox, Ubuntu, and other Linux distros are in [docs/SETUP.md](docs/SETUP.md).

## Features

- **Users / collectors** as tabs across the top (no logins). Each person has their own collection and hunt list. Add, rename, or delete people in the header; you cannot delete the last remaining user. The last selected tab is remembered in `localStorage`. Existing data is migrated to a default user named `Collector` (override with `DEFAULT_USER_NAME`).
- **Scan a car** from a phone camera (or a snapped photo). The app looks for a UPC/EAN barcode on the card back and runs on-device OCR to read the toy number (for example JJM15) and collector number (13/250). Matches are shown with rarity badges and used to prefill the Add car form. Nothing is saved until you confirm.
- **Identify with AI** (optional) sends a photo to a local [Ollama](https://ollama.com) vision model and prefills the form. Barcode, OCR, and add-by-number still work if Ollama is off.
- **Add by car number** next to Scan: type a toy number (JJM15, HKH21) or a series/collector number (13/250, or with a year).
- **Collection catalog** with name, series, year, color, condition, quantity, storage location, optional notes, toy number, UPC, and casting. Search, rarity filters, and sorting. By default the list is grouped by series and ordered by series number (for example 3/10 before 7/10).
- **Rarity flags.** Collection entries are auto-matched to a curated rarity list by toy number, or by name + year. Matches show badges (STH, TH, Chase, RLC, Error, High Value) and estimate ranges.
- **Weekly hunt list** of recent Super Treasure Hunts, Treasure Hunts, and Premium/Car Culture chases the selected user does not already own. Cached per ISO week, with a Refresh button and a scheduled weekly auto-refresh.
- **Photos** you upload or paste as a URL on a collection or rarity entry. Hunt and rarity rows show a placeholder unless you provide an image.
- **Dark / light theme** toggle, remembered in `localStorage`.
- **CSV and JSON export** of the collection (JSON also includes the rarity list).

## Requirements

- [Node.js](https://nodejs.org/) **22 or newer** (uses the built-in `node:sqlite` module). Node 24 works.
- Or [Docker](https://docs.docker.com/get-docker/) and Docker Compose, if you prefer not to install Node locally.

## Quick start (Node)

```bash
cd wheelstash
cp .env.example .env   # optional; edit as needed
npm install
npm start
```

Open [http://localhost:3000](http://localhost:3000).

- Default port is **3000**. Override with `PORT=3456 npm start`.
- Bind address defaults to `0.0.0.0` (reachable on your LAN). Override with `HOST=127.0.0.1`.
- Data directory defaults to `./storage`. Override with `DATA_DIR=/path/to/data`.
- Set `TZ` so the weekly cron uses your local timezone, for example `TZ=America/Chicago npm start` or `TZ=Europe/London npm start`. If `TZ` is unset, the schedule uses the process's local time.

`npm run dev` starts the same server with Node's `--watch` reload. `npm test` runs the unit tests.

## Quick start (Docker)

```bash
cd wheelstash
cp .env.example .env   # optional
docker compose up -d --build
```

Open [http://localhost:3000](http://localhost:3000). Stop with `docker compose down`. The `./storage` folder on the host is mounted into the container so the database and edited rarity list survive rebuilds.

The image includes `tzdata`. Compose defaults `TZ` to `UTC`; set `TZ` in `.env` or the environment to your local zone.

## Where data persists

All writable data lives in the `storage/` directory (or `DATA_DIR`):

| File | Purpose |
| --- | --- |
| `storage/collection.db` | SQLite collection database (plus `-wal` / `-shm` while the server is running) |
| `storage/rarity.json` | Your editable rarity list (copied from the seed on first launch) |
| `storage/hunt-cache.json` | Cached hunt list for the current ISO week |
| `storage/refresh-state.json` | Last auto-refresh time, trigger, and job log |
| `storage/seed-snapshot.json` | Seed snapshot used to preserve your rarity edits on the next merge |
| `storage/uploads/` | Photos you upload in the UI |

The original seed is never overwritten: `seed/rarity-seed.json` (113 Treasure Hunt / Super Treasure Hunt / premium chase entries for 2024–2026, plus source credits). See [docs/SETUP.md](docs/SETUP.md#the-113-car-rarity-dataset) for how first-run seeding, editing, and reset work.

## Configuration

Copy [`.env.example`](.env.example) to `.env` or export the variables in your service manager. The most used ones:

| Variable | Default | Meaning |
| --- | --- | --- |
| `HOST` | `0.0.0.0` | Bind address |
| `PORT` | `3000` | Listen port |
| `DATA_DIR` | `./storage` (Docker: `/app/storage`) | Runtime data directory |
| `TZ` | unset (Docker: `UTC`) | Timezone for the weekly cron |
| `REFRESH_ENABLED` | `true` | Weekly scheduler and startup run |
| `REFRESH_CRON` | `0 6 * * 1` | Cron expression (Monday 06:00 in `TZ`) |
| `OLLAMA_URL` | *(empty → AI off)* | Base URL of Ollama, e.g. `http://127.0.0.1:11434` or `http://ollama:11434` |
| `OLLAMA_VISION_MODEL` | `qwen2.5vl:7b` | Ollama vision model name |
| `AI_SCAN_ENABLED` | `true` | Set `false` to hide the AI button |
| `AI_SCAN_TIMEOUT_MS` | `90000` | How long to wait for the model |
| `DEFAULT_USER_NAME` | `Collector` | Name of the first collector tab on a new database |

The complete table, volume mounts, HTTPS for the camera, backups, and platform-specific installs are in [docs/SETUP.md](docs/SETUP.md).

## Camera access needs HTTPS

Browsers only allow the live camera preview in a [secure context](https://developer.mozilla.org/en-US/docs/Web/Security/Secure_Contexts) (HTTPS or `http://localhost`). A plain `http://` LAN address generally cannot open the camera; use **Take a photo** or put the app behind HTTPS (Tailscale Serve or a reverse proxy). See [docs/SETUP.md](docs/SETUP.md#https-for-camera-access).

## Photos and the rarity list

The shipped seed is **names and catalog facts only**. It does not include car photos. You can upload a JPEG, PNG, GIF, or WebP (saved under `storage/uploads/`, max 4 MB) or paste an image URL on a collection or rarity entry. Uploaded photos are kept. Hunt and rarity rows show a placeholder unless you add a photo yourself.

Word of the wise: pulling images or data from the Hot Wheels wikis is possible, but use at your own risk.

Community sites such as Vanto and Hunt64 are used only as *identity* sources for the seed; this app does not scrape their photos.


Dollar figures in the seed are **rough estimate ranges only**, not live market prices or appraisals. There is no free official live-price feed. Confirm with current sold listings before buying or selling.

Identities, toy numbers, series, and colors in the 2024–2026 hunt seed were compiled from these public lists:

- [Vanto — Treasure Hunts and Super Treasure Hunts by year](https://vanto.cards/cars/hot-wheels/treasure-hunts)
- [Hunt64 — 2026 Super Treasure Hunts](https://hunt64.app/cars/lists/sth-2026)
- [Hunt64 — 2024 Super Treasure Hunts](https://hunt64.app/cars/lists/sth-2024)
- [Hot Wheels Wiki (Fandom) — 2025 Treasure Hunts Series](https://hotwheels.fandom.com/wiki/2025_Treasure_Hunts_Series)
- [hotwheelstreasure.com — STH index](https://hotwheelstreasure.com/cars)

## Backup

Copy the whole `storage/` folder (stop the app first for a fully consistent SQLite copy, or include the `-wal` and `-shm` files). Restore by stopping the app, replacing `storage/`, and starting it again. Platform-specific snapshot tips are in [docs/SETUP.md](docs/SETUP.md#backup-and-restore). The UI also offers **Export CSV** and **Export JSON**.

## License

The application code is licensed under the [GNU General Public License v3.0 or later](LICENSE).

Hot Wheels and related marks are trademarks of Mattel, Inc. This project is unofficial and is not affiliated with Mattel.

## Project layout

```
wheelstash/
  server.js              API and static file server
  lib/                   Database, rarity, scan, AI, photos, hunt, refresh
  seed/rarity-seed.json  Shipped 113-car rarity seed (with source credits)
  public/                Vanilla HTML/CSS/JS UI
  public/vendor/         Local ZXing + tesseract.js assets (no CDN)
  test/                  Unit tests (`npm test`)
  storage/               Runtime data (created on first run; not shipped)
  deploy/                TrueNAS and systemd example units
  docs/SETUP.md          Full setup write-up
  Dockerfile
  docker-compose.yml
  .env.example
  LICENSE
  README.md
```
