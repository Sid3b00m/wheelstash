# Wheelstash setup guide

This is the full install and operations guide for Wheelstash, a self-hosted collection tracker for Hot Wheels collectors. This project is unofficial and is not affiliated with, endorsed by, or sponsored by Mattel. The [README](../README.md) covers features and a short quick start. This document covers prerequisites, every environment variable, data layout, the optional Ollama vision model, HTTPS for the phone camera, the weekly refresh, the 113-car rarity seed, backup and restore, and step-by-step installs on:

- TrueNAS SCALE (custom app via Docker Compose, with a dataset)
- Proxmox (an LXC container running Node 22, or Docker inside a VM)
- Standalone Ubuntu (Docker Compose, or plain Node with systemd)
- Other Linux variants: Debian, Fedora / RHEL, Arch, and Raspberry Pi (arm64)
- Windows 10/11 (Docker Desktop with WSL2, or native Node 22), plus a short note on Windows Server

The app has **no login or access control**. Run it only on a trusted LAN or a tailnet, or put it behind your own authentication proxy.

Throughout this guide, placeholders look like `/mnt/POOL/wheelstash`, `your-host`, and `your-tailnet.ts.net`. Replace them with your own names and paths.

## Prerequisites

Pick one runtime:

| Runtime | What you need |
| --- | --- |
| **Node** | [Node.js](https://nodejs.org/) **22 or newer** (24 is fine). The app uses the built-in `node:sqlite` module, so Node 20 and earlier will not start. `npm` is included with Node. |
| **Docker** | Docker Engine (or Docker Desktop) and the Compose v2 plugin (`docker compose`). The image is `node:22-bookworm-slim` and is published for both `amd64` and `arm64`. |

Optional:

- A local [Ollama](https://ollama.com) install with a vision model (see [Optional Ollama vision AI](#optional-ollama-vision-ai)) if you want **Identify with AI**.
- [Tailscale](https://tailscale.com) or another reverse proxy if you want HTTPS so the live camera preview works on phones (see [HTTPS for camera access](#https-for-camera-access)).
- About 1 GB of disk for the app, dependencies, and photo cache. A vision model such as `qwen2.5vl:7b` needs several additional gigabytes and a GPU (or a lot of patience on CPU).

Clone or copy the project, then work from the repo root:

```bash
cd wheelstash
cp .env.example .env   # optional; edit values described below
```

## Environment variables

The process reads these directly. With Docker Compose, values in `.env` are also substituted into `docker-compose.yml`. A systemd unit can load the same file with `EnvironmentFile=/etc/wheelstash.env`. On Windows, set the same variables in the PowerShell session (for example `$env:TZ = "UTC"`), in Task Scheduler, or with NSSM; the Node process does not auto-load `.env`. See [Windows](#windows).

| Variable | Default | Meaning |
| --- | --- | --- |
| `HOST` | `0.0.0.0` | Address the HTTP server binds to. `0.0.0.0` is reachable on your LAN. Use `127.0.0.1` if only a local reverse proxy should connect. |
| `PORT` | `3000` | Listen port. In the default Compose file this is the port *inside* the container; the host port is `${PORT:-3000}` on the left of the ports mapping. |
| `DATA_DIR` | `./storage` (image: `/app/storage`) | Directory for the SQLite database, rarity/hunt state, and uploads. Must be writable by the process user. |
| `TZ` | unset (Docker image / Compose: `UTC`) | Timezone for the weekly cron, as an IANA name such as `UTC`, `America/Chicago`, or `Europe/London`. If unset on a plain Node process, the job uses the host's local time. |
| `REFRESH_ENABLED` | `true` | Set `false` to disable the scheduled weekly job *and* the startup catch-up run. Manual Refresh in the UI still works. |
| `REFRESH_CRON` | `0 6 * * 1` | Standard 5-field cron. The default is Monday 06:00 in `TZ`. |
| `OLLAMA_URL` | *(empty)* | Base URL of an Ollama server, with no trailing slash. Examples: `http://127.0.0.1:11434`, `http://ollama:11434` (Compose service name), or `http://your-ollama-host:11434`. Leave empty to disable AI. Do not expose Ollama to the public internet. |
| `OLLAMA_VISION_MODEL` | `qwen2.5vl:7b` | Model name as shown by `ollama list`. It must have vision capability. Pull it with `ollama pull qwen2.5vl:7b`. |
| `AI_SCAN_ENABLED` | `true` | Set `false` to hide the Identify with AI button even if `OLLAMA_URL` is set. |
| `AI_SCAN_TIMEOUT_MS` | `90000` | How long to wait for a vision response, in milliseconds. The first request after the model has been evicted from VRAM is the slowest. |
| `DEFAULT_USER_NAME` | `Collector` | Name of the first collector tab when the database is created. Rename it later in the UI. Has no effect on an existing database. |
| `NODE_ENV` | unset (image: `production`) | Standard Node environment flag. |

Boolean flags accept `true` / `false`, `1` / `0`, `yes` / `no`, and `on` / `off`.

## Ports, volume mounts, and data persistence

### Ports

| Port | Role |
| --- | --- |
| `3000/tcp` | The tracker HTTP UI and API (default). Change with `PORT`. |
| `11434/tcp` | Default Ollama API, only if you run Ollama. The tracker talks to it; you do not have to publish this port to your LAN. |
| `8443/tcp` or `443/tcp` | Typical HTTPS front-ends (Tailscale Serve or a reverse proxy). Not opened by the app itself. |

If port 3000 is already taken on the host, map a different host port, for example `3030:3000`, and keep `PORT=3000` inside the container. For host-network mode (some TrueNAS setups), set `PORT` to a free host port instead.

### Volume mounts (Docker)

The default Compose file bind-mounts one host directory:

```yaml
volumes:
  - ${DATA_DIR:-./storage}:/app/storage
```

That host folder is the only state you need to back up. Do not mount over `/app` unless you know you are replacing the image contents (the TrueNAS release-tarball pattern in `deploy/` does this on purpose).

### Files created in `DATA_DIR`

| Path | Purpose |
| --- | --- |
| `collection.db` | SQLite collection, users, and learned UPC map. While the server is running you will also see `collection.db-wal` and `collection.db-shm`. |
| `rarity.json` | Editable rarity list. Created from the shipped seed on first launch. |
| `hunt-cache.json` | Cached hunt list for the current ISO week, per user. |
| `refresh-state.json` | Last auto-refresh time, trigger, and a short job log. |
| `seed-snapshot.json` | Snapshot used so the weekly merge can keep your edits. |
| `uploads/` | Photos uploaded in the UI. |

The shipped seed file `seed/rarity-seed.json` lives in the app directory, not in `DATA_DIR`, and is never overwritten by the app.

## Quick start reminders

### Docker Compose

```bash
cd wheelstash
cp .env.example .env
# edit TZ, OLLAMA_URL, and so on if you want
docker compose up -d --build
```

Open `http://localhost:3000` (or `http://your-host:3000` on the LAN). Logs: `docker compose logs -f`. Stop: `docker compose down` (this does not delete `./storage`).

### Plain Node

```bash
cd wheelstash
npm install
npm test          # optional
npm start         # or: npm run dev
```

Open `http://localhost:3000`. For a machine that should keep the app running after logout, use the systemd unit in [Standalone Ubuntu](#standalone-ubuntu), or Task Scheduler / NSSM in [Windows](#windows).

## The 113-car rarity dataset

The repo ships `seed/rarity-seed.json`: a curated list of **113** 2024–2026 mainline Treasure Hunts (TH), Super Treasure Hunts (STH), and Premium / Car Culture chase cars, plus one well-known historical example (the 1969 Rear-Loader Beach Bomb prototype, marked not hunt-eligible). Each entry can include name, category, year, color, toy number, collector number, series, a rough value estimate, notes, and whether it belongs on the weekly hunt list. Source credits are in the file's `source` object and in the README.

There is no live price API. Dollar figures are estimate ranges only and will go stale.

### How first run seeds the list

On the first start, if `DATA_DIR/rarity.json` does not exist, the app copies the shipped seed into that file and writes a seed snapshot. After that, your `rarity.json` is the live list.

The weekly job (and **Refresh** / `POST /api/refresh`) *merges* the current seed back in:

- New cars that appeared in a newer seed are added.
- Fields you have not edited can be updated from the seed.
- Your custom values, cars you added yourself, and seed entries you deleted are preserved (deletions are remembered so the merge will not put them back).

### Editing and reseeding

1. **In the UI** — open the **Rarity list** tab to add, edit, or delete entries. Changes go to `storage/rarity.json`. **Reset to seed** (or `POST /api/rarity/reset`) restores the shipped list and discards custom edits and remembered deletions.
2. **As a file** — stop the server, edit `storage/rarity.json`, then start it again.
3. **Replace the shipped seed** — edit `seed/rarity-seed.json` (or swap in your own file with the same shape), then use **Reset to seed** so `rarity.json` is rebuilt from it. Keep a backup of `storage/` first if you care about custom entries.

Hunt and rarity photos are not in the seed. Add your own upload or image URL if you want a picture; otherwise a placeholder is shown.

Word of the wise: pulling images or data from the Hot Wheels wikis is possible, but use at your own risk.

## Optional Ollama vision AI

When `OLLAMA_URL` is set and reachable, the Scan screen shows **Identify with AI**. You snap or pick a photo of the card (front or back) or the loose car; the server sends it to the vision model and prefills the add form. Nothing is saved until you confirm.

1. Install [Ollama](https://ollama.com) on the same machine or on another host the tracker can reach (LAN or tailnet).
2. Pull a vision model, for example:
   ```bash
   ollama pull qwen2.5vl:7b
   ```
   `qwen2.5vl:7b` is around 6 GB and is a reasonable default for an 8 GB GPU. Any Ollama model with vision capability works; set `OLLAMA_VISION_MODEL` to its name.
3. Point the tracker at it:
   ```bash
   export OLLAMA_URL=http://127.0.0.1:11434          # same machine
   # export OLLAMA_URL=http://ollama:11434            # Compose service name
   # export OLLAMA_URL=http://your-ollama-host:11434  # another host
   ```
4. Confirm `GET /api/scan/ai/status` returns `"reachable": true` and `"modelInstalled": true`.

If Ollama is down or the model is still loading, the UI says so. **Scan barcode / text** and **Add by car number** remain available.

Tips:

- Keep Ollama on your LAN or tailnet. Do not publish port 11434 to the internet.
- If the tracker and Ollama share a GPU, switching models can make the first request slower while weights load.
- `AI_SCAN_TIMEOUT_MS` defaults to 90 seconds to cover a cold model load.

## HTTPS for camera access

The live camera preview requires a [secure context](https://developer.mozilla.org/en-US/docs/Web/Security/Secure_Contexts): HTTPS, or `http://localhost` / `http://127.0.0.1`. A plain `http://192.168.x.x` (or other LAN) URL will usually be denied camera permission. **Take a photo** still works on HTTP because it uses the phone's regular camera app.

### Tailscale Serve (tailnet-only)

If the host is on a tailnet and `tailscale` is installed:

```bash
# Proxy the tracker, tailnet-only (this is not Tailscale Funnel; it is not public).
sudo tailscale serve --bg --https=8443 http://127.0.0.1:3000
```

Open `https://your-host.your-tailnet.ts.net:8443/` from a device signed into the same tailnet. Port 443 also works if it is free (`--https=443` and no port in the URL). On some NAS appliances port 443 is already used, so 8443 is a safe choice.

To persist Serve across reboots, use a post-init / startup script on the host, or enable it in the Tailscale admin console if you use that workflow. Check status with `tailscale serve status`.

Do **not** turn on Funnel unless you have added your own authentication. This app has no logins.

### Reverse proxy

Any TLS reverse proxy in front of `http://127.0.0.1:3000` works. Examples:

**Caddy** (automatic Let's Encrypt if the host has a public name and ports 80/443):

```caddy
tracker.example.com {
    reverse_proxy 127.0.0.1:3000
}
```

**nginx** (certificate paths are up to you — Let's Encrypt, a private CA, or a tailnet cert):

```nginx
server {
    listen 443 ssl;
    server_name tracker.example.com;
    ssl_certificate     /etc/ssl/certs/tracker.crt;
    ssl_certificate_key /etc/ssl/private/tracker.key;

    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        client_max_body_size 8m;
    }
}
```

Set `HOST=127.0.0.1` on the tracker if only the proxy should be able to reach it.

## Weekly refresh

A `node-cron` task inside the app rebuilds the hunt list and refreshes the rarity list on a schedule, without clicking Refresh. It also runs once at startup if the current ISO week has no recorded job yet (or the last run was a previous week).

The job does **not** pull current market prices. It:

1. Re-merges `seed/rarity-seed.json` into `storage/rarity.json`, as described above.
2. Regenerates the weekly hunt list from that rarity list and each collector's collection.
The header shows **Last auto-refresh** (timestamp, ISO week, and whether it was a startup, cron, or manual run).

You can also trigger the same job with `POST /api/refresh` and inspect the last run with `GET /api/refresh`. Disable scheduling with `REFRESH_ENABLED=false`.

## Backup and restore

### What to copy

Back up the entire `DATA_DIR` (by default `storage/`):

```bash
# Consistent copy: stop the app first so SQLite is quiet.
# Docker:
docker compose stop
tar czf wheelstash-storage-$(date +%F).tgz -C storage .
docker compose start

# systemd:
sudo systemctl stop wheelstash
sudo tar czf /var/backups/wheelstash-storage-$(date +%F).tgz -C /opt/wheelstash/storage .
sudo systemctl start wheelstash
```

If you cannot stop the app, copy `collection.db`, `collection.db-wal`, and `collection.db-shm` together, plus the JSON files and the `uploads/` directory. A snapshot-capable filesystem (ZFS, btrfs, LVM) is the most reliable way to capture a running SQLite database.

The seed file in the repo is not required for restore — a backup of `rarity.json` already contains your list. Keep a copy of the app release you were running as well, so you can roll back code and data together.

### Restore

```bash
# Docker example
docker compose stop
rm -rf storage
mkdir storage
tar xzf wheelstash-storage-YYYY-MM-DD.tgz -C storage
docker compose start
```

For systemd, stop the service, replace `/opt/wheelstash/storage`, fix ownership (`chown -R wheelstash:wheelstash ...`), and start the service. Opening the UI should show the same collectors and cars.

Export CSV / JSON from the header (or `/api/export.csv` and `/api/export.json`) is a good extra copy of the catalog, but it is not a full backup (it does not include all rarity edits, the photo cache, or learned barcodes).

Windows backup examples (PowerShell and Docker Desktop) are in [Windows](#updating-and-backup-on-windows).

Platform snapshots:

- **TrueNAS:** a periodic snapshot task on the `POOL/wheelstash` dataset (or at least the `storage` child).
- **Proxmox LXC:** `vzdump <CTID> --mode snapshot` (or `stop`) to the backup storage you use for other containers.
- **Proxmox VM running Docker:** a VM backup, plus the `storage/` bind mount if it lives on a host path.

## TrueNAS SCALE (custom app and a dataset)

These steps assume TrueNAS SCALE (or a current Community Edition) with the Apps feature enabled. Names like `POOL` are placeholders.

### 1. Create a dataset

In the UI: **Datasets**, pick your pool, **Add Dataset**, name it `wheelstash`. Recommended layout:

```
/mnt/POOL/wheelstash/app        # unpacked application (owned by the apps user)
/mnt/POOL/wheelstash/storage    # all persistent data
/mnt/POOL/wheelstash/release    # optional: a release tarball the container installs from
```

The Apps service typically runs containers as user `apps` (uid/gid **568**). Give that user ownership:

```bash
mkdir -p /mnt/POOL/wheelstash/{app,storage,release}
chown -R 568:568 /mnt/POOL/wheelstash
chmod 755 /mnt/POOL/wheelstash /mnt/POOL/wheelstash/{app,storage,release}
```

### 2. Put a release on the dataset (recommended)

On a machine with Node 22 and this repo:

```bash
npm ci --omit=dev
tar czf wheelstash-release.tgz \
  --exclude .git --exclude storage --exclude docs \
  server.js lib seed public package.json package-lock.json node_modules
```

Copy `wheelstash-release.tgz` to `/mnt/POOL/wheelstash/release/` (SMB, SCP, or the TrueNAS shell).

Alternatively, skip the tarball and `docker compose` build from the repo, mounting only `storage/`. The example files under `deploy/` follow the tarball-plus-official-Node-image pattern so you do not have to maintain a custom image on the NAS.

### 3. Install the custom app

**Apps → Discover → Custom App.** Paste the YAML from [`deploy/truenas-compose.yml`](../deploy/truenas-compose.yml), after you replace every `/mnt/POOL/wheelstash` path with your dataset. The same content is in [`deploy/truenas-app.json`](../deploy/truenas-app.json) if you use the TrueNAS API.

Review before saving:

- `user: "568:568"` matches the dataset owner.
- `PORT` is a **free host port** if you keep `network_mode: host` (TrueNAS may already use 80, 443, and sometimes 3000). If 3000 is taken, set `PORT` to something else and update the healthcheck URL to match.
- `OLLAMA_URL=http://127.0.0.1:11434` is correct when Ollama is another app on the *same* TrueNAS host using host networking. If Ollama is published on a different port, or runs on another machine, change this. Leave it empty to disable AI.
- `TZ` should be your local timezone.
- Host networking lets the port appear on the NAS LAN and Tailscale addresses. If you prefer a bridge network, drop `network_mode: host` and add a `ports:` mapping instead; then set `OLLAMA_URL` to a reachable address, not `127.0.0.1`.

Start the app and open `http://your-truenas-host:3000` (or whichever port you chose).

### 4. Updates and backups

To update the tarball pattern: copy a new `wheelstash-release.tgz` over the old one and **Restart** the app. The container compares a checksum, replaces `/app`, and leaves `/data` (your `storage` dataset) alone.

Back up by snapshotting `POOL/wheelstash` (or the `storage` child) under **Data Protection**, and/or by copying `/mnt/POOL/wheelstash/storage`.

For HTTPS and the camera, install or use the TrueNAS Tailscale app (typically with host networking) and run Serve as in [HTTPS for camera access](#https-for-camera-access), pointing at `http://127.0.0.1:3000` (or your chosen port). Use `https://your-host.your-tailnet.ts.net:8443/` from tailnet devices.

## Proxmox

Two supported shapes: an unprivileged LXC running Node 22, or a small VM running Docker. Do not put this guide's example IDs, bridges, or addresses onto a host that already uses them — choose free values in your datacenter.

### Option A — LXC with Node 22

1. **Create an unprivileged container** from a Debian 12 or Debian 13 (or Ubuntu 24.04) template. Give it a hostname such as `wheelstash`, 1–2 cores, 1 GB RAM, and a disk of 8 GB or more. Attach it to your LAN bridge with a **static** address you have confirmed is unused, for example `192.168.1.50/24` with your actual gateway and DNS. (DHCP is fine if you reserve the lease.) Nesting is useful but not required unless you also run Docker inside the CT.
2. **Install Node 22** inside the container. The Node 20 package in some Debian repos is not new enough. From the official tarball (check [nodejs.org](https://nodejs.org) for the current 22.x filename):

   ```bash
   apt-get update
   apt-get install -y ca-certificates curl xz-utils tar
   curl -fsSL -o /tmp/node.tar.xz \
     https://nodejs.org/dist/v22.21.1/node-v22.21.1-linux-x64.tar.xz
   tar -xJf /tmp/node.tar.xz -C /usr/local --strip-components=1
   node -v   # must be v22.x or newer
   ```

   On ARM guests, use the `linux-arm64` tarball instead.

3. **Create a service user and install the app:**

   ```bash
   useradd --system --home /opt/wheelstash --shell /usr/sbin/nologin wheelstash
   mkdir -p /opt/wheelstash
   # copy the project into /opt/wheelstash (git clone, scp, or a release tarball)
   chown -R wheelstash:wheelstash /opt/wheelstash
   sudo -u wheelstash npm ci --omit=dev --prefix /opt/wheelstash
   mkdir -p /opt/wheelstash/storage
   chown -R wheelstash:wheelstash /opt/wheelstash/storage
   ```

4. **Install the systemd unit.** Copy [`deploy/wheelstash.service`](../deploy/wheelstash.service) to `/etc/systemd/system/wheelstash.service`. If `node` is not on the default `PATH` for services, set `ExecStart=/usr/local/bin/node server.js`. Create `/etc/wheelstash.env` from [`.env.example`](../.env.example) (at least `TZ`, and `OLLAMA_URL` if you use AI). Then:

   ```bash
   systemctl daemon-reload
   systemctl enable --now wheelstash
   systemctl status wheelstash
   ```

5. Open `http://192.168.1.50:3000` (your address). For HTTPS, install Tailscale in the container (an unprivileged CT needs `/dev/net/tun` bound in the container config, then `pct reboot <CTID>`) or put a proxy on a neighboring VM. See [HTTPS for camera access](#https-for-camera-access).

Updates: unpack a new release into `/opt/wheelstash` while leaving `storage/` in place, run `npm ci --omit=dev` as `wheelstash`, and `systemctl restart wheelstash`. Back up with `vzdump <CTID>` and/or a tarball of `/opt/wheelstash/storage`.

### Option B — Docker inside a VM

Create a Debian or Ubuntu VM, install Docker Engine and Compose, clone this repo (or copy it) to a path such as `/opt/wheelstash`, and follow the Docker Compose quick start. Bind-mount `./storage` to a disk you back up with the VM, or to a virtiofs / NFS mount. HTTPS is the same: Tailscale on the VM, or a reverse proxy VM in front.

## Standalone Ubuntu

These steps fit Ubuntu 22.04 and 24.04 on a bare metal box or a VM. Use `sudo` as needed.

### Docker Compose

```bash
# Docker Engine + Compose v2 (official convenience script, or use Ubuntu's docker.io package)
curl -fsSL https://get.docker.com | sh
sudo usermod -aG docker "$USER"   # then log out and back in

sudo mkdir -p /opt/wheelstash
sudo chown "$USER":"$USER" /opt/wheelstash
# copy or clone the project into /opt/wheelstash
cd /opt/wheelstash
cp .env.example .env
# edit .env: TZ, maybe OLLAMA_URL
docker compose up -d --build
```

Enable Docker to start on boot (`systemctl enable docker`). Back up `/opt/wheelstash/storage`. Put Caddy, nginx, or Tailscale Serve in front if you need HTTPS.

### Plain Node with systemd

```bash
# Node 22 via NodeSource, or the official tarball as in the Proxmox section
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt-get install -y nodejs
node -v

sudo useradd --system --home /opt/wheelstash --shell /usr/sbin/nologin wheelstash
sudo mkdir -p /opt/wheelstash
# copy the project, then:
sudo npm ci --omit=dev --prefix /opt/wheelstash
sudo mkdir -p /opt/wheelstash/storage
sudo chown -R wheelstash:wheelstash /opt/wheelstash

sudo cp deploy/wheelstash.service /etc/systemd/system/wheelstash.service
sudo cp .env.example /etc/wheelstash.env
sudo ${EDITOR:-nano} /etc/wheelstash.env
sudo systemctl daemon-reload
sudo systemctl enable --now wheelstash
```

Open `http://your-ubuntu-host:3000`. Logs: `journalctl -u wheelstash -f`.

## Other Linux distributions

The app is a single Node process (or a Docker container). Package names differ; the layout above stays the same: install Node 22+, copy the project to `/opt/wheelstash`, use `deploy/wheelstash.service`, keep data in `storage/`.

### Debian

Same as Ubuntu. On Debian 12, `apt install nodejs` may give Node 18 or 20 — too old. Use the official Node 22 tarball or the NodeSource 22.x repo, or install Docker and run Compose. Debian 13 may ship a new enough Node; check with `apt-cache policy nodejs` before relying on it.

### Fedora / RHEL / Rocky / Alma

```bash
sudo dnf install -y nodejs npm
node -v    # Fedora often has Node 22+; on RHEL 9/10 check, and use the tarball or NodeSource if it is older
```

Install Docker from Fedora modules or the official Docker CE repo if you prefer Compose. The systemd unit works unchanged; `firewalld` may need `firewall-cmd --add-port=3000/tcp --permanent && firewall-cmd --reload` if you want LAN access. SELinux: keep `storage/` labeled so the process can write (`chcon -Rt container_file_t storage` if a container bind-mount is blocked).

### Arch Linux

```bash
sudo pacman -S nodejs npm
node -v    # current Arch Node is new enough
```

Or `pacman -S docker docker-compose` and enable `docker.service`. Copy the systemd unit as on Ubuntu. If you use `nftables` or `ufw`, allow port 3000 (or only your proxy port).

### Raspberry Pi (arm64)

Use a 64-bit Raspberry Pi OS (Bookworm or newer) or Ubuntu for Pi. The official `node:22-bookworm-slim` image and the `linux-arm64` Node tarball both work on Pi 4/5 (and other aarch64 boards).

```bash
# Docker is usually the easiest path on a Pi
curl -fsSL https://get.docker.com | sh
cd /opt/wheelstash
docker compose up -d --build
```

For AI recognition, a Pi is rarely a good place to run `qwen2.5vl:7b`. Point `OLLAMA_URL` at a more capable box on the LAN or tailnet, for example `http://your-ollama-host:11434`. The tracker itself is light and runs well on a Pi.

32-bit armhf is not a target; use a 64-bit OS.

## Windows

Windows 10 or 11 (64-bit) both work. Pick **Docker Desktop** with the WSL2 engine, or a **native Node 22** (or newer) process. The two paths are described separately. A short note at the end covers Windows Server.

The app has **no login or access control**. Run it only on a trusted LAN or a tailnet, or put it behind your own authentication proxy. Placeholders such as `C:\wheelstash`, `your-windows-host`, and `your-host.your-tailnet.ts.net` are examples — use your own paths and names.

### Docker Desktop (Windows 10/11 with WSL2)

1. Use a 64-bit Windows 10 (recent feature update) or Windows 11 PC, with virtualization enabled in firmware.
2. Install [Docker Desktop for Windows](https://docs.docker.com/desktop/setup/install/windows-install/) and choose the **WSL2** engine (the default). Allow Windows to install the WSL2 components if it asks, then sign in or skip according to your preference. Confirm with `docker version` and `docker compose version` in a new PowerShell window.
3. [Git for Windows](https://git-scm.com/download/win) is optional but useful for `git clone`. You can also unpack a [release zip](https://github.com/Sid3b00m/wheelstash/releases) instead.

From PowerShell, in a folder you control:

```powershell
git clone https://github.com/Sid3b00m/wheelstash.git
cd wheelstash
Copy-Item .env.example .env
# notepad .env   # set TZ (for example America/Chicago) and OLLAMA_URL if you use AI
docker compose up -d --build
```

Open `http://localhost:3000`. Logs: `docker compose logs -f`. Stop: `docker compose down` (this does not delete `.\storage`).

**Where the data lives.** The Compose file bind-mounts `${DATA_DIR:-./storage}` to `/app/storage` in the container. If you ran Compose from `C:\wheelstash`, the only folder you need to back up is `C:\wheelstash\storage` on the Windows volume. Keep the project on a normal Windows path, or inside a WSL distro's own filesystem. Bind-mounting a `/mnt/c/...` path from a WSL shell works but is slower; running `docker compose` from PowerShell on a Windows path is the straightforward option.

**Firewall and LAN access.** `http://localhost:3000` on the same PC does not need a firewall change. For a phone or another computer on your LAN, open `http://your-windows-host:3000`. If that connection is refused, add an inbound Windows Firewall rule for the published host port (Docker Desktop sometimes creates one for you):

```powershell
New-NetFirewallRule -DisplayName "Wheelstash" -Direction Inbound -Protocol TCP -LocalPort 3000 -Action Allow
```

If you published a different host port (for example `3030:3000`), use that host port in the rule instead.

### Native Node 22

Node **22 or newer** is required. The app uses the built-in `node:sqlite` module, so Node 20 and earlier will not start.

**Install Node.** Use the current [Node.js LTS Windows Installer (MSI)](https://nodejs.org/) (22 or newer), or winget:

```powershell
winget install --id OpenJS.NodeJS.LTS -e
```

Close and reopen PowerShell so `node` and `npm` are on `PATH`. Check with `node -v` — it must report v22 or newer. `npm` is included with Node.

**Get the code**, either by clone:

```powershell
git clone https://github.com/Sid3b00m/wheelstash.git
cd wheelstash
```

or by unpacking a release zip from the [Releases](https://github.com/Sid3b00m/wheelstash/releases) page and `cd` into the unpacked folder.

**Install, test, and run:**

```powershell
npm ci
npm test          # optional
$env:HOST = "0.0.0.0"
$env:PORT = "3000"
$env:DATA_DIR = "$PWD\storage"   # optional; the default is a storage folder next to server.js
$env:TZ = "UTC"                  # or America/Chicago, Europe/London, and so on
# $env:OLLAMA_URL = "http://127.0.0.1:11434"
npm start
```

The Node process does **not** auto-load `.env`. Set variables in that PowerShell session, or in Task Scheduler / NSSM as shown below. Open `http://localhost:3000`.

**Data folder.** By default this is `storage\` in the project directory (override with `DATA_DIR`). It holds `collection.db` (plus `-wal` and `-shm` while the server is running), `rarity.json`, hunt and refresh state, and `uploads\`. That folder is what you back up.

**Windows Firewall**, if other devices on the LAN should reach the app:

```powershell
New-NetFirewallRule -DisplayName "Wheelstash" -Direction Inbound -Protocol TCP -LocalPort 3000 -Action Allow
```

#### Start on boot with Task Scheduler

No extra software is required.

Create a small starter script so environment variables are set reliably. Save this as `C:\wheelstash\start-wheelstash.cmd`, adjusting the paths to match your install:

```bat
@echo off
cd /d C:\wheelstash
set HOST=0.0.0.0
set PORT=3000
set DATA_DIR=C:\wheelstash\storage
set TZ=UTC
rem set OLLAMA_URL=http://127.0.0.1:11434
"C:\Program Files\nodejs\node.exe" server.js
```

Confirm the Node path with `where.exe node`. Then:

1. Open **Task Scheduler** → **Create Task** (not Create Basic Task).
2. **General:** name it `Wheelstash`. On a shared or always-on machine, choose **Run whether user is logged on or not**. Turn on **Hidden** if you do not want a window.
3. **Triggers:** **At startup** (or **At log on** for a personal PC). Optionally enable **Start the task as soon as possible after a scheduled start is missed**.
4. **Actions:** **Start a program**. Program/script is `C:\wheelstash\start-wheelstash.cmd`. Start in (optional) is `C:\wheelstash`.
5. **Settings:** allow the task to run on demand, and do not stop it after a short time limit (the app should keep running).

Start the task once and open `http://localhost:3000`. To update later, stop the task, replace the app files, and start it again.

#### Start on boot with NSSM (Windows service)

[NSSM](https://nssm.cc/) can run the same process as a Windows service. Download it and call `nssm.exe` by full path, or put it on `PATH`. From an elevated PowerShell, after `C:\wheelstash` is in place and `npm ci` has been run:

```powershell
New-Item -ItemType Directory -Force -Path C:\wheelstash\logs | Out-Null
nssm install Wheelstash "C:\Program Files\nodejs\node.exe" server.js
nssm set Wheelstash AppDirectory C:\wheelstash
nssm set Wheelstash AppEnvironmentExtra HOST=0.0.0.0 PORT=3000 DATA_DIR=C:\wheelstash\storage TZ=UTC
nssm set Wheelstash AppStdout C:\wheelstash\logs\out.log
nssm set Wheelstash AppStderr C:\wheelstash\logs\err.log
nssm set Wheelstash Start SERVICE_AUTO_START
nssm start Wheelstash
```

If you use Ollama, append `OLLAMA_URL=http://127.0.0.1:11434` to `AppEnvironmentExtra` (space-separated `NAME=value` pairs). Manage the service with `nssm stop Wheelstash`, `nssm edit Wheelstash`, or `services.msc`. The data to back up is still `C:\wheelstash\storage`, not the log folder.

### Optional Ollama for Windows

Install [Ollama for Windows](https://ollama.com/download). It listens on `http://127.0.0.1:11434` by default and typically starts with your user session.

```powershell
ollama pull qwen2.5vl:7b
$env:OLLAMA_URL = "http://127.0.0.1:11434"
```

`qwen2.5vl:7b` is around 6 GB and is a reasonable default for an 8 GB GPU, same as on Linux. Set `OLLAMA_VISION_MODEL` if you use a different vision model.

If the tracker itself runs in Docker Desktop, `127.0.0.1` inside the container is not your Windows host. Set `OLLAMA_URL=http://host.docker.internal:11434` in `.env` instead. If Ollama runs on another machine, use `http://your-ollama-host:11434`. Do not publish port 11434 to the public internet.

Confirm with `GET /api/scan/ai/status` as described in [Optional Ollama vision AI](#optional-ollama-vision-ai). **Scan barcode / text** and **Add by car number** still work if Ollama is off.

### HTTPS for camera access

The live camera preview needs a secure context — HTTPS, or `http://localhost` / `http://127.0.0.1` — just as on Linux. A plain `http://your-windows-host:3000` URL will usually be denied camera permission on a phone. **Take a photo** still works on HTTP because it uses the phone's regular camera app. See also [HTTPS for camera access](#https-for-camera-access).

**Tailscale Serve on Windows.** Install [Tailscale for Windows](https://tailscale.com/download/windows), sign in, then in PowerShell:

```powershell
tailscale serve --bg --https=8443 http://127.0.0.1:3000
```

Open `https://your-host.your-tailnet.ts.net:8443/` from a device signed into the same tailnet. This is Serve, not Funnel: it stays tailnet-only. Port 443 also works if it is free (`--https=443` and no port in the URL). To keep Serve after a reboot, run the same command from a startup task, then check `tailscale serve status`. Do **not** turn on Funnel unless you have added your own authentication.

**Caddy** (or another reverse proxy) in front of `http://127.0.0.1:3000` is the other option. Install [Caddy for Windows](https://caddyserver.com/docs/install#windows) and use a Caddyfile:

```caddy
tracker.example.com {
    reverse_proxy 127.0.0.1:3000
}
```

Run `caddy run` from that file's directory, or install Caddy as a service. Caddy can obtain a Let's Encrypt certificate if the host has a public name and ports 80/443 are reachable; otherwise use your own certificates. Set `HOST=127.0.0.1` on the tracker if only the proxy should connect to it. nginx and other proxies follow the same pattern as in the Linux reverse-proxy examples.

### Updating and backup on Windows

**Update**

1. Back up `storage\` (below).
2. Stop the app: `docker compose stop`, or stop the Task Scheduler task / `nssm stop Wheelstash`, or Ctrl+C in the console.
3. Replace the application files and leave `storage\` untouched. Git: `git pull`. Or unpack a new release zip over the project folder.
4. If you run Node natively, run `npm ci` again in case dependencies changed. Skip this under Docker.
5. Start it again: `docker compose up -d --build`, or start the task/service, or `npm start`.
6. Open `/api/health` and click around the UI.

To roll back, restore the previous application files and, if the new version changed the database, restore the matching `storage\` backup.

**Backup**

Stop the app first so SQLite is quiet, then archive the data folder:

```powershell
# Native example; adjust the paths
$date = Get-Date -Format "yyyy-MM-dd"
New-Item -ItemType Directory -Force -Path C:\Backups | Out-Null
Compress-Archive -Path C:\wheelstash\storage\* -DestinationPath C:\Backups\wheelstash-storage-$date.zip
```

Under Docker Desktop, `docker compose stop`, archive `.\storage` the same way, then `docker compose start`. If you cannot stop the app, copy `collection.db`, `collection.db-wal`, and `collection.db-shm` together, plus the JSON files and `uploads\`.

Restore by stopping the app, replacing `storage\`, and starting it again. Opening the UI should show the same collectors and cars. Export CSV / JSON from the header is a useful extra copy of the catalog, but it is not a full backup.

### Windows Server

The same Docker Desktop (where it is supported on your SKU) or native Node 22 steps work on current 64-bit Windows Server releases, including Server 2022 and 2025. Prefer a dedicated folder such as `C:\wheelstash`, run the process as a service (NSSM, or Task Scheduler with a managed service account), and open the firewall only for the ports you need. Server Core is fine for the native Node path if you are comfortable working in PowerShell only.

Docker Desktop on Windows Server has licensing and SKU limits. If Desktop is not available, use native Node on the server, or run the Linux container on another host and point Windows clients at it.

## Updating the app

1. Back up `storage/` (and a release tarball, if you use that pattern).
2. Replace the application files. Leave `storage/` untouched.
   - Git: `git pull` (or unpack a new release).
   - Docker: `docker compose up -d --build`.
   - TrueNAS tarball: copy a new `wheelstash-release.tgz` and restart the app.
   - Windows: see [Windows](#updating-and-backup-on-windows) for Docker Desktop, Task Scheduler, and NSSM.
3. Run `npm ci --omit=dev` if you are not using Docker (in case dependencies changed).
4. Restart the service or container.
5. Open `/api/health` and click around the UI.

To roll back, restore the previous application files and, if the new version changed the database, restore the matching `storage/` backup.

## Security notes

- There is no authentication. Anyone who can reach the port can read and change the collection.
- Bind to `127.0.0.1` and use a proxy with access control if the host is on an untrusted network.
- Prefer a tailnet (Tailscale Serve, not Funnel) or a VPN over port-forwarding.
- Do not put secrets in Compose files you later share; use `.env` (gitignored) or your orchestrator's secret store. The examples in this repo use placeholders only.
