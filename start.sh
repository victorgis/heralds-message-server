#!/bin/sh
set -eu

BOT_API_PORT="${TELEGRAM_BOT_API_PORT:-8081}"
BOT_API_DIR="${TELEGRAM_BOT_API_DIR:-/var/lib/telegram-bot-api}"
export TELEGRAM_BOT_API_BASE="http://127.0.0.1:${BOT_API_PORT}"

if [ -z "${TELEGRAM_API_ID:-}" ] || [ -z "${TELEGRAM_API_HASH:-}" ]; then
  echo "TELEGRAM_API_ID and TELEGRAM_API_HASH are required for the local Bot API server." >&2
  exit 1
fi

mkdir -p "$BOT_API_DIR"

echo "Starting Telegram Bot API server on 127.0.0.1:${BOT_API_PORT}"
telegram-bot-api \
  --api-id="$TELEGRAM_API_ID" \
  --api-hash="$TELEGRAM_API_HASH" \
  --local \
  --http-port="$BOT_API_PORT" \
  --dir="$BOT_API_DIR" &
BOT_API_PID="$!"

cleanup() {
  kill "$BOT_API_PID" 2>/dev/null || true
}

trap cleanup INT TERM EXIT

echo "Waiting for Telegram Bot API to become ready..."
for _ in $(seq 1 60); do
  if curl -fsS "http://127.0.0.1:${BOT_API_PORT}/bot${TELEGRAM_BOT_TOKEN}/getMe" >/dev/null 2>&1; then
    echo "Telegram Bot API is ready."
    break
  fi
  sleep 1
done

if ! curl -fsS "http://127.0.0.1:${BOT_API_PORT}/bot${TELEGRAM_BOT_TOKEN}/getMe" >/dev/null 2>&1; then
  echo "Telegram Bot API did not become ready in time." >&2
  kill "$BOT_API_PID" 2>/dev/null || true
  exit 1
fi

echo "Starting Heralds audio server..."
node index.js
