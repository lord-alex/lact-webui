# LACT Web UI

Web interface for the [LACT](https://github.com/ilya-zlobintsev/LACT) GPU control daemon. Monitor GPUs and control fan curves, power limits, clocks and voltages from any browser.

Built for Linux + AMD GPUs (amdgpu). Tested with LACT daemon 0.10.1.

## Architecture

```
[Browser UI] --HTTP + WebSocket--> [Node.js bridge server] --JSON over Unix socket--> lactd
```

The LACT daemon exposes a newline-delimited JSON API on `/run/lactd.sock`. Browsers cannot talk to Unix sockets directly, so a small Node.js bridge translates the daemon protocol into a REST + WebSocket API and serves the built frontend.

- `server/` — Node.js (>= 20) bridge: Fastify, WebSocket stats streaming, static file serving
- `web/` — frontend: Vite + React + uPlot charts

## Requirements

- Node.js >= 20 (a self-contained install works fine)
- LACT daemon running: `sudo systemctl enable --now lactd`
- Socket access: the user running the server must be in the daemon's `admin_group`
  (see `/etc/lact/config.yaml`), or the socket group must match

## Setup

```bash
# bridge server
cd server
npm install

# frontend
cd ../web
npm install
npm run build       # outputs to web/dist
```

## Running

The script (backgrounds the server, logs to `/tmp/lact-web-server.log`):

```bash
~/run-server.sh              # start / restart
~/run-server.sh --restart    # stop only
```

Or manually:

```bash
cd server
HOST=0.0.0.0 PORT=5170 node src/index.js
```

Then open http://localhost:5170

Environment variables:

| Variable | Default | Description |
|---|---|---|
| `HOST` | `127.0.0.1` | Listen address |
| `PORT` | `5170` | Listen port |
| `LACTD_SOCKET` | `/run/lactd.sock` | Path to the daemon socket |
| `WEB_DIST` | `../web/dist` | Path to the built frontend |

## Development (frontend)

```bash
cd web
npm run dev          # dev server on :5171, proxies /api to the bridge on :5170
```

Changes hot-reload; no bridge restart needed. For production use, run `npm run build`.

## UI

- **Monitor page** — every GPU gets one card: live stat tiles (temperature, fan, GPU/VRAM clocks, VRAM usage, voltage, power, utilization) and four rolling time-series charts (temperatures, clocks & voltage, power, fan & utilization)
- **Fans button** — fan control modal: enable/disable, static speed or interactive curve editor (drag/add/remove points), temperature sensor select, update interval
- **Power button** — power limit slider (bounded by hardware min/max), performance level, power profile mode (read from sysfs), core & VRAM voltage/frequency curve editing

All configuration changes go through LACT's safety flow: after applying, the settings must be **confirmed within 5 seconds** or the daemon reverts them automatically. The UI shows a confirm dialog with a countdown and Confirm / Revert buttons.

## HTTP API (bridge)

| Method | Path | Purpose |
|---|---|---|
| GET | `/api/system` | Daemon/system info |
| GET | `/api/devices` | List GPUs |
| GET | `/api/devices/:id/info` | Static device info |
| GET | `/api/devices/:id/stats` | — (use stream instead) |
| GET | `/api/devices/:id/config` | Current GPU config |
| PUT | `/api/devices/:id/config` | Apply new config (pending until confirmed) |
| POST | `/api/devices/:id/confirm` | Confirm or revert pending config (`{command: "confirm" \| "revert"}`) |
| GET | `/api/devices/:id/clocks` | Clocks table (VF levels, ranges) |
| GET | `/api/devices/:id/pp-modes` | Power profile modes (parsed from sysfs) |
| WS | `/api/devices/:id/stream` | Live `device_stats` frames (~1/s) |

`:id` is the GPU id as returned by `/api/devices` (e.g. `1002:67DF-1043:04FB-0000:01:00.0`).

## Security notes

- The daemon socket has no authentication beyond file permissions — do not expose the bridge to untrusted networks without adding auth (e.g. a reverse proxy with TLS + basic auth)
- The daemon's TCP listener is disabled by default for a reason; the bridge keeps everything on the Unix socket

## TODO

- [ ] Throttling indicators (from `device_clocks_info` / `throttle_info`)
- [ ] Charts: configurable time windows, CSV export
- [ ] Power states editor (DPM level enable/disable, AMD)
- [ ] RDNA3+ firmware options (acoustic limit/target, zero RPM) — `pmfw_options`
- [ ] VF curve editor for other table kinds (RDNA od tables, Nvidia, Intel)
- [ ] Settings profiles management (list, create, activation rules)
- [ ] Detach / reattach GPUs
- [ ] Authentication for the bridge (basic auth or login page)
- [ ] Docker packaging + systemd unit file
- [ ] Historical data persistence across page reloads
- [ ] i18n
