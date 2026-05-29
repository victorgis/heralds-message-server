# Heralds Audio Server

This server powers the teachings library and audio stream endpoints.

## What it does

- Reads teaching metadata from Supabase.
- Falls back to Telegram `getUpdates` when Supabase is empty.
- Streams audio through `/api/telegram-stream`.
- Supports large files by running Telegram's local Bot API server in the same container.

## Why the local Bot API matters

Telegram's hosted Bot API caps `getFile` downloads at 20 MB.  
The official `tdlib/telegram-bot-api` server in `--local` mode removes that limit and can return an absolute local `file_path` for `getFile`.

Official docs:

- [tdlib/telegram-bot-api README](https://github.com/tdlib/telegram-bot-api)
- [Telegram local Bot API docs](https://core.telegram.org/bots/api#using-a-local-bot-api-server)

## Deployment shape

Use one Docker container for both processes:

1. `telegram-bot-api` runs on `127.0.0.1:8081`
2. `node index.js` runs the Express API on `PORT=4000`

That shared filesystem is what makes large-file streaming work.
The entrypoint forces `TELEGRAM_BOT_API_BASE` to the local in-container address so an old hosted API value cannot override it.

## Required env vars

```sh
PORT=4000
PUBLIC_API_BASE_URL=https://heralds-message-server.onrender.com
ALLOWED_ORIGINS=https://your-frontend-domain.com,http://localhost:5173

TELEGRAM_BOT_TOKEN=your-bot-token
TELEGRAM_API_ID=your-telegram-api-id
TELEGRAM_API_HASH=your-telegram-api-hash

TELEGRAM_BOT_API_BASE=http://127.0.0.1:8081
TELEGRAM_BOT_API_PORT=8081
TELEGRAM_BOT_API_DIR=/var/lib/telegram-bot-api

VITE_SUPABASE_URL=https://your-project.supabase.co
SUPABASE_SERVICE_ROLE_KEY=your-service-role-key
TELEGRAM_TEACHINGS_TABLE=telegram_teachings
```

## Docker

Build and run the server image from this folder:

```sh
docker build -t heralds-audio-server .
docker run --rm -p 4000:4000 --env-file .env heralds-audio-server
```

The container will:

- start the local Telegram Bot API server
- wait for it to become ready
- start the Express app

## Render

If you use `render.yaml` at the repo root, Render will build the `server/` Dockerfile automatically.

Required Render env vars:

- `TELEGRAM_BOT_TOKEN`
- `TELEGRAM_API_ID`
- `TELEGRAM_API_HASH`
- `VITE_SUPABASE_URL`
- `SUPABASE_SERVICE_ROLE_KEY`
- `ALLOWED_ORIGINS`

Helpful defaults already set in the blueprint:

- `TELEGRAM_BOT_API_BASE=http://127.0.0.1:8081`
- `TELEGRAM_BOT_API_PORT=8081`
- `TELEGRAM_BOT_API_DIR=/var/lib/telegram-bot-api`
- `PUBLIC_API_BASE_URL=https://heralds-message-server.onrender.com`

Do not point `TELEGRAM_BOT_API_BASE` at `https://api.telegram.org` in production if you want large files to play.

## Railway

On Railway, deploy the `server/` folder as a Docker service with the same env vars listed above.
The important part is that `telegram-bot-api` and the Express app live in the same container so they can share the local filesystem.

## Migration note

If your bot was previously using `https://api.telegram.org`, call `logOut` once before switching to the local server so Telegram stops routing updates to the hosted API.

## Endpoints

- `GET /health`
- `GET /api/teachings`
- `GET /api/telegram-stream?file_id=...`

## How streaming works

1. `getFile` runs against the local Bot API server.
2. If Telegram returns a local absolute `file_path`, the Express app copies it into cache.
3. The player streams the cached file with HTTP range support.
4. Small files still work too, but the goal is to keep everything flowing through the same local Bot API setup.

## Cache

- Cached files live under `CACHE_DIR`.
- `CACHE_TTL_SECONDS` controls cleanup age.
- `CACHE_MAX_BYTES` controls total cache size.

## Frontend

Point the frontend at the deployed API:

```sh
VITE_TELEGRAM_TEACHINGS_ENDPOINT=https://heralds-message-server.onrender.com/api/teachings
```
