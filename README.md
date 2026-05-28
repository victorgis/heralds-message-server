# Heralds Audio Server

Express API for the teachings audio player. It can read sermon metadata from Supabase, stream
Telegram files through a server-side cache, and avoid keeping every large file permanently on disk.

## Why This Exists

Telegram's hosted Bot API cannot download files over 20MB. To stream larger Telegram files, deploy
this server on Render/Railway/Fly/DigitalOcean and point `TELEGRAM_BOT_API_BASE` to a self-hosted
Telegram Bot API server.

If `TELEGRAM_BOT_API_BASE=https://api.telegram.org`, files over 20MB will still fail.

## Local Setup

```sh
cd server
cp .env.example .env
npm install
npm run dev
```

Health check:

```sh
curl http://localhost:4000/health
```

Debug teaching metadata:

```sh
curl http://localhost:4000/api/teachings?debug=1
```

## Frontend Setup

In `frontend/.env`, point the teachings endpoint to this server:

```sh
VITE_TELEGRAM_TEACHINGS_ENDPOINT=http://localhost:4000/api/teachings
```

For production, use your Render/Railway URL:

```sh
VITE_TELEGRAM_TEACHINGS_ENDPOINT=https://your-audio-server.onrender.com/api/teachings
```

## Cache Strategy

`GET /api/telegram-stream?file_id=...` works like this:

1. Check if the file is already cached on disk.
2. If missing, resolve/download it from Telegram Bot API.
3. Save it in `CACHE_DIR`.
4. Stream it to the browser with `Range` support for seeking.
5. Periodically delete old files and prune total cache size.

This means you can keep disk usage controlled:

```sh
CACHE_DIR=./cache
CACHE_TTL_SECONDS=86400
CACHE_MAX_BYTES=2147483648
CACHE_CLEANUP_INTERVAL_SECONDS=900
```

Example: `CACHE_TTL_SECONDS=86400` deletes files not used for roughly one day. If a user requests
that audio again later, the server downloads it again.

## Series Names and Duplicates

The server infers a series name from common audio titles. For example:

```txt
Man In Prayer (Track 4)
Man In Prayer - Track 4
Man In Prayer Part 4
```

All become series `Man In Prayer`, with track part `4`.

Duplicate audio rows are removed before grouping. The server prefers these dedupe keys in order:

1. `file_unique_id`
2. `file_id`
3. `storage_url`
4. `series + title + part`

Use `GET /api/teachings?debug=1` and check `diagnostics.duplicateRows` to see what was removed.

## Large Files Over 20MB

The server can temporarily mirror large cached Telegram files into Supabase Storage. This is useful
when you want Supabase to carry playback traffic for a while without keeping every file forever.

For files over 20MB, choose one of these:

- **Recommended for Telegram-first:** run a self-hosted Telegram Bot API server and set
  `TELEGRAM_BOT_API_BASE=http://your-local-bot-api:8081`. The Express server can then download,
  cache, upload a temporary Supabase mirror, delete, and redownload large files on demand.
- **Recommended for CDN-like playback:** upload large files to Supabase Storage and add
  `storage_url`, or `storage_bucket` + `storage_path`, to your Supabase table.

Temporary mirror flow:

1. User requests a large Telegram audio.
2. Server downloads it through `TELEGRAM_BOT_API_BASE`.
3. Server saves a disk cache copy.
4. Server uploads it to `TEMP_SUPABASE_BUCKET/TEMP_SUPABASE_PREFIX`.
5. Server redirects playback to a signed Supabase URL.
6. After `TEMP_SUPABASE_TTL_SECONDS`, cleanup deletes the temporary Supabase object.

Environment variables:

```sh
TEMP_SUPABASE_MIRROR_ENABLED=true
TEMP_SUPABASE_BUCKET=audio-messages
TEMP_SUPABASE_PREFIX=temporary-telegram-cache
TEMP_SUPABASE_TTL_SECONDS=86400
TEMP_SUPABASE_MIRROR_MIN_BYTES=20971520
```

Important: the first download still requires a self-hosted Telegram Bot API server for files over
20MB. Hosted `https://api.telegram.org` cannot download the file, so there would be nothing to upload
to Supabase.

Temporary uploads and cleanup also require `SUPABASE_SERVICE_ROLE_KEY`; the anon key is not enough
for this job.

If you run the Telegram Bot API server in Docker, make sure the Node server can read the same
filesystem path returned by `getFile`. In other words, the absolute path from local mode must be on a
shared volume or mounted path that your Express process can access.

## Deployment Notes

Render/Railway filesystem storage may be ephemeral. That is fine for this cache: the server simply
redownloads files when the cache disappears.

For best results:

- Use a persistent disk if your host offers one.
- Set `CACHE_MAX_BYTES` below your plan's disk limit.
- Use a self-hosted Telegram Bot API server for files over 20MB.
- Keep Supabase Storage URLs for the most popular sermons if you want CDN-like performance.

## Required Environment Variables

```sh
PORT=4000
PUBLIC_API_BASE_URL=https://your-server.example.com
ALLOWED_ORIGINS=https://your-frontend.example.com,http://localhost:5173

TELEGRAM_BOT_TOKEN=
TELEGRAM_BOT_API_BASE=http://localhost:8081

VITE_SUPABASE_URL=
SUPABASE_SERVICE_ROLE_KEY=
TELEGRAM_TEACHINGS_TABLE=telegram_teachings
```

For Supabase Storage fallback:

```sh
SUPABASE_AUDIO_BUCKET=audio-messages
SUPABASE_STORAGE_PUBLIC=false
SUPABASE_STORAGE_SIGNED_URL_TTL=3600
```
