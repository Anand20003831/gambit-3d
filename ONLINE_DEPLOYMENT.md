# Deploying online

Gambit3D is a single Node process that serves the built client **and** the
WebSocket. That is the simplest thing to deploy and the shape everything else in
this document assumes.

If you only want to play with people in your house, you do not need any of this —
see [LAN_SETUP.md](LAN_SETUP.md).

---

## What the host needs

- **Node.js 22.5 or newer.** The database uses the built-in `node:sqlite`, so
  there is nothing to compile and no native module to worry about.
- **WebSocket support.** Socket.IO will fall back to HTTP long-polling if
  WebSockets are blocked, but it will be noticeably worse. Most platforms support
  WebSockets; some require you to switch them on.
- **A persistent disk** *if* you want ratings and finished games to survive a
  restart. Without one, point `DATABASE_PATH` at `:memory:` and accept that
  everything resets on deploy.

Roughly 150 MB of RAM idle. The two 3D maps are downloaded by the browser, not
held by the server.

---

## Build and run

```bash
npm ci
npm run build
npm start
```

`npm run build` produces:

- `packages/shared/dist` — compiled shared code
- `packages/server/dist` — the server
- `packages/client/dist` — the static client

`npm start` runs the server, which serves `packages/client/dist` for any path
that is not `/api/*` or `/socket.io/*`, with an SPA fallback so deep links work.

---

## Environment

Copy `.env.example` and set at least these:

```bash
NODE_ENV=production
PORT=8787                 # or whatever the platform gives you
HOST=0.0.0.0              # required: the platform must be able to reach it
CORS_ORIGINS=https://chess.example.com
ALLOW_LAN_ORIGINS=false   # no reason to accept private-network origins in production
TRUST_PROXY=true          # only if you are actually behind a trusted proxy
SESSION_SECRET=<generated>
DATABASE_PATH=/data/gambit3d.db
```

Generate the secret:

```bash
node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))"
```

### The settings that actually matter

**`SESSION_SECRET`** — reconnection tokens are HMAC'd with this. If it is unset
the server generates a random one at boot and logs a warning; every player is
then logged out on each deploy. Set it.

**`CORS_ORIGINS`** — an explicit allowlist. `*` is fine for a LAN box and wrong
for anything public. Requests with no `Origin` header (health checks, curl) are
always allowed; this only governs browsers.

**`ALLOW_LAN_ORIGINS`** — leave `true` for home use, set `false` in production.
When true, private-network origins (`192.168.x.x` and friends) are accepted
without being listed, which is what makes LAN play work without configuration.

**`TRUST_PROXY`** — when true the server reads `X-Forwarded-For` for the client
IP, which the rate limiter uses. Only enable it behind a proxy you control; a
spoofable header would let a client dodge the per-IP limits.

**`DATABASE_PATH`** — an absolute path on a persistent volume, or `:memory:`.

**`LEVEL_EDITOR`** — off in production by default, and it should stay off. The
editor page still works for anyone who visits it; only the endpoint that writes
layouts to disk is disabled, and that endpoint has no place on a public host.
Dress your maps locally and deploy the resulting
`packages/client/public/layouts/*.json` with the rest of the build.

---

## Reverse proxy

WebSockets need the upgrade headers forwarded. nginx:

```nginx
server {
  listen 443 ssl http2;
  server_name chess.example.com;

  ssl_certificate     /etc/letsencrypt/live/chess.example.com/fullchain.pem;
  ssl_certificate_key /etc/letsencrypt/live/chess.example.com/privkey.pem;

  location / {
    proxy_pass http://127.0.0.1:8787;
    proxy_http_version 1.1;

    # Required for Socket.IO
    proxy_set_header Upgrade    $http_upgrade;
    proxy_set_header Connection "upgrade";

    proxy_set_header Host              $host;
    proxy_set_header X-Real-IP         $remote_addr;
    proxy_set_header X-Forwarded-For   $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;

    # A game can sit idle between moves; do not cut it off.
    proxy_read_timeout  3600s;
    proxy_send_timeout  3600s;
  }
}
```

Caddy needs no WebSocket configuration:

```
chess.example.com {
  reverse_proxy 127.0.0.1:8787
}
```

Set `TRUST_PROXY=true` whenever you put a proxy in front.

---

## systemd

```ini
[Unit]
Description=Gambit3D chess server
After=network.target

[Service]
Type=simple
User=gambit
WorkingDirectory=/srv/gambit3d
EnvironmentFile=/srv/gambit3d/.env
ExecStart=/usr/bin/node packages/server/dist/index.js
Restart=on-failure
RestartSec=5

NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ProtectHome=true
ReadWritePaths=/srv/gambit3d/data

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl enable --now gambit3d
sudo journalctl -u gambit3d -f
```

---

## Docker

```dockerfile
FROM node:24-alpine AS build
WORKDIR /app
COPY package*.json ./
COPY packages/shared/package.json packages/shared/
COPY packages/server/package.json packages/server/
COPY packages/client/package.json packages/client/
RUN npm ci
COPY . .
RUN npm run build

FROM node:24-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /app/package*.json ./
COPY --from=build /app/packages/shared/package.json packages/shared/
COPY --from=build /app/packages/server/package.json packages/server/
COPY --from=build /app/packages/shared/dist packages/shared/dist
COPY --from=build /app/packages/server/dist packages/server/dist
COPY --from=build /app/packages/client/dist packages/client/dist
RUN npm ci --omit=dev --workspace @gambit3d/server --include-workspace-root
EXPOSE 8787
CMD ["node", "packages/server/dist/index.js"]
```

```bash
docker build -t gambit3d .
docker run -d --name gambit3d -p 8787:8787 \
  -e HOST=0.0.0.0 \
  -e NODE_ENV=production \
  -e SESSION_SECRET="$(node -e 'console.log(require(\"crypto\").randomBytes(48).toString(\"base64url\"))')" \
  -e CORS_ORIGINS=https://chess.example.com \
  -e DATABASE_PATH=/data/gambit3d.db \
  -v gambit3d-data:/data \
  gambit3d
```

---

## Platform notes

**Any container platform** (Fly.io, Render, Railway, a VPS) works: one service,
one port, WebSockets on, a volume mounted where `DATABASE_PATH` points.

**Serverless and edge platforms will not work.** Rooms are long-lived in-memory
objects with timers and open sockets. Vercel and Netlify functions cannot host
this server. You can host the *client* there and point `VITE_SERVER_URL` at the
server elsewhere — see below.

### Split hosting

Only if you must. Build the client with the server's public URL baked in:

```bash
VITE_SERVER_URL=https://api.chess.example.com npm run build
```

Then on the server set `CORS_ORIGINS` to the client's origin. Both must be HTTPS —
a secure page cannot open an insecure WebSocket.

Single-origin is simpler and avoids CORS entirely. Prefer it.

---

## Health and monitoring

`GET /api/health` returns:

```json
{ "ok": true, "status": "healthy", "uptimeSeconds": 1234, "rooms": 3, "env": "production" }
```

Point your platform's health check at it. It touches no game state.

`GET /api/lan` reports the server's network interfaces — useful for LAN, not
something you want exposed publicly. Put it behind your proxy or drop the route
if that concerns you.

---

## Before you go live

- [ ] `SESSION_SECRET` set to a generated value, not the example
- [ ] `CORS_ORIGINS` set to your real origins, not `*`
- [ ] `ALLOW_LAN_ORIGINS=false`
- [ ] `LEVEL_EDITOR` unset or `false` (it writes files from a web request)
- [ ] `NODE_ENV=production` (this is what switches on the CSP headers)
- [ ] `DATABASE_PATH` on a persistent volume, or deliberately `:memory:`
- [ ] `TRUST_PROXY` true only if you are behind one
- [ ] HTTPS terminated, WebSocket upgrade forwarded
- [ ] `.env` not committed
- [ ] `npm run verify` passes
- [ ] `/api/health` reachable through the proxy

---

## Scaling

This runs as a single process, and rooms live in that process's memory. Running
two instances behind a load balancer **will not work** without changes — two
players could land on different instances and never see each other.

For a family game that is not a problem. If you ever needed it, the work is a
Socket.IO Redis adapter plus moving room state out of process; the room and
gateway layers are already separated for that.

---

## Backups

Everything durable is one SQLite file.

```bash
sqlite3 /data/gambit3d.db ".backup '/backups/gambit3d-$(date +%F).db'"
```

Copying the file while the server runs can catch it mid-write; use `.backup`, or
stop the server first. Losing it costs you ratings and finished-game history —
no in-progress game survives a restart anyway.
